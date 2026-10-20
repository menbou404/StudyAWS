# Phase 3 手順書: DB を RDS に分離する

> Phase 2 の EC2 の中で動かしていた PostgreSQL を、プライベートサブネットに置いた RDS に引っ越す。DB のパスワードは Secrets Manager に預ける。
> アプリのコードは変えない。変えるのは環境変数 `DATABASE_URL` だけ。
> 仕組みの解説は [phase3-study.md](phase3-study.md)、この Phase で使わなかった機能は [phase3-appendix.md](phase3-appendix.md)。

## ゴール

- プライベートサブネットを作り、パブリックサブネットとの違いを説明できる
- セキュリティグループのソースに別のセキュリティグループを指定し、「EC2 からだけ DB に届く」状態を作れる
- RDS を作り、マスターユーザーとアプリ用のユーザーを使い分けられる
- DB のパスワードを Secrets Manager に預け、IAM ロールで必要なものだけを取り出せる
- 動いているアプリのデータを、別の DB に引っ越せる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| DB エンジン | RDS for PostgreSQL 17 |
| DB インスタンスクラス | `db.t4g.micro`（Arm、vCPU 2、メモリ 1GB）。無料プランの対象 |
| ストレージ | gp3 20GiB |
| 配置 | Single-AZ、`ap-southeast-2a`（EC2 と同じ AZ） |
| マスターユーザー | `postgres`（パスワードは RDS が Secrets Manager で管理） |
| アプリ用のユーザー | `statuspage`（パスワードはシークレット `statuspage/db-app`） |
| アプリのサーバー | Phase 2 の `statuspage-ec2`（停止している場合は開始する） |

### 作るもの

| リソース | 名前 | 主な設定 |
|---|---|---|
| サブネット | `statuspage-private-a` | `10.0.11.0/24`、`ap-southeast-2a` |
| サブネット | `statuspage-private-b` | `10.0.12.0/24`、`ap-southeast-2b` |
| ルートテーブル | `statuspage-private-rt` | `local` だけ（インターネットへのルートなし） |
| セキュリティグループ | `statuspage-db-sg` | 受信：PostgreSQL 5432 を `statuspage-web-sg` からだけ |
| DB サブネットグループ | `statuspage-db-subnets` | `statuspage-private-a`、`statuspage-private-b` |
| RDS の DB インスタンス | `statuspage-db` | 上の「環境」のとおり |
| シークレット | `rds!db-xxxx` | マスターユーザーのパスワード（RDS が自動で作る） |
| シークレット | `statuspage/db-app` | アプリ用のユーザーのパスワード（自分で作る） |
| IAM のインラインポリシー | `statuspage-read-db-secrets` | `statuspage-ec2-role` に付ける。シークレットを読む権限 |

### 全体像

```
Internet
   │
statuspage-igw
   │
statuspage-vpc 10.0.0.0/16
├─ statuspage-public-a   10.0.1.0/24  (ap-southeast-2a)     ← パブリック（Phase 2）
│   └─ statuspage-ec2                                        ← statuspage-web-sg
│       ├─ nginx   :80
│       ├─ api     127.0.0.1:8000 ─┐
│       └─ worker ─────────────────┤ TCP 5432 + password + TLS
├─ statuspage-private-a  10.0.11.0/24 (ap-southeast-2a)     ← プライベート
│   └─ statuspage-db (RDS for PostgreSQL 17) ◀─┘             ← statuspage-db-sg: 5432 from statuspage-web-sg
└─ statuspage-private-b  10.0.12.0/24 (ap-southeast-2b)     ← プライベート（DB サブネットグループの2つ目）

Secrets Manager
├─ rds!db-xxxx         ← マスターユーザー（RDS が管理、自動で変わる）
└─ statuspage/db-app   ← アプリ用のユーザー
```

### 費用（目安）

| リソース | 単価 | かかる期間 |
|---|---|---|
| RDS `db.t4g.micro`（Single-AZ） | 約 $0.025 / 時間 | 起動している間 |
| RDS ストレージ gp3 20GiB | 約 $3 / 月 | **削除するまで（停止中もかかる）** |
| 自動バックアップ | 20GiB までは追加料金なし | — |
| Secrets Manager | $0.40 / 月（シークレット1つにつき）× 2 | 削除するまで |
| EC2（Phase 2 から） | 約 $0.026 / 時間 + EBS 約 $0.77 / 月 | |
| プライベートサブネット・ルートテーブル・DB サブネットグループ・セキュリティグループ | 無料 | — |

1日3時間学習して、終わったら EC2 と RDS を停止すれば、1日あたり約 $0.16 + 月額の固定分（約 $4.6）になる。RDS を1か月つけっぱなしにすると約 $18 かかる。
単価は目安。RDS を作る前に、最新の単価を確認する（手順4）。

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 RDS とは](phase3-study.md#1-rds-とは)：「Phase 2 との比較」「責任共有モデル」
> - [study §12 費用](phase3-study.md#12-費用)：「このPhaseでかかるもの」
>
> 読んだら考える：RDS にしても、自分の責任のまま残るものは何か

1. リポジトリを `git pull` する
2. EC2 の `statuspage-ec2` が停止していたら「インスタンスを開始」する
3. ブラウザで `http://<パブリック IP>/` が開けることを確認する（開けなければ [phase2-setup.md](phase2-setup.md) の手順15）
4. Budgets の月次コスト予算が有効か確認する

- [ ] 完了

## 1. プライベートサブネットを作る

コンソールの検索バーで「VPC」を開く。

### 1-1. サブネット

> 📖 **先に読む**
> - [study §3 プライベートサブネットと DB サブネットグループ](phase3-study.md#3-プライベートサブネットと-db-サブネットグループ)：「プライベートサブネット」「このプロジェクトの番号の割り当て」
>
> 読んだら考える：プライベートサブネットとパブリックサブネットは、作るときの設定の何が違うか

1. 「サブネット」→「サブネットを作成」→ VPC に `statuspage-vpc` を選ぶ
2. 1つ目：名前 `statuspage-private-a`、アベイラビリティゾーン `ap-southeast-2a`、IPv4 CIDR `10.0.11.0/24`
3. 「新しいサブネットを追加」→ 2つ目：名前 `statuspage-private-b`、アベイラビリティゾーン `ap-southeast-2b`、IPv4 CIDR `10.0.12.0/24`
4. 「サブネットを作成」

- サブネットを作る画面には「パブリック」「プライベート」を選ぶ項目がない。どちらになるかは、次の手順のルートテーブルで決まる

### 1-2. ルートテーブル

> 📖 **先に読む**
> - [study §3 プライベートサブネットと DB サブネットグループ](phase3-study.md#3-プライベートサブネットと-db-サブネットグループ)：「プライベートサブネット」
>
> 読んだら考える：このルートテーブルに IGW へのルートを入れないと、EC2 から RDS には届くか

1. 「ルートテーブル」→「ルートテーブルを作成」→ 名前 `statuspage-private-rt`、VPC `statuspage-vpc`
2. 「ルート」タブで、`10.0.0.0/16` → `local` の1行だけになっていることを確認する（**ルートを追加しない**）
3. 「サブネットの関連付け」タブ →「サブネットの関連付けを編集」→ `statuspage-private-a` と `statuspage-private-b` にチェック

- 関連付けなくても VPC のメインルートテーブル（`local` だけ）が使われるが、どのサブネットがどのルートテーブルを使うかを分かりやすくするため、明示的に関連付ける

- [ ] サブネット2つ
- [ ] ルートテーブル（ルートは `local` だけ、2つのサブネットに関連付け）

## 2. DB 用のセキュリティグループを作る

> 📖 **先に読む**
> - [study §4 セキュリティグループの参照](phase3-study.md#4-セキュリティグループの参照)：全体
> - [phase2-study §5 セキュリティグループ](phase2-study.md#5-セキュリティグループ)：「性質」（復習）
>
> 読んだら考える：ソースを EC2 の IP アドレスではなく `statuspage-web-sg` にすると、何がうれしいか

1. 「EC2」→「セキュリティグループ」→「セキュリティグループを作成」
2. 名前 `statuspage-db-sg`、説明 `statuspage db`、VPC `statuspage-vpc`
3. インバウンドルールを追加：タイプ「**PostgreSQL**」（ポート 5432 が自動で入る）、ソース「カスタム」→ 検索欄で **`statuspage-web-sg`** を選ぶ、説明 `from web`
4. アウトバウンドルールはそのまま

- ソースに `sg-xxxx`（セキュリティグループの ID）が入っていれば OK
- このセキュリティグループには、インターネットからの受信ルールを1つも書かない

- [ ] 完了

## 3. DB サブネットグループを作る

> 📖 **先に読む**
> - [study §3 プライベートサブネットと DB サブネットグループ](phase3-study.md#3-プライベートサブネットと-db-サブネットグループ)：「DB サブネットグループ」
>
> 読んだら考える：Single-AZ で作るのに、なぜ2つの AZ のサブネットが必要なのか

コンソールの検索バーで「RDS」を開く。

1. 左のメニュー「サブネットグループ」→「DB サブネットグループを作成」
2. 名前 `statuspage-db-subnets`、説明 `statuspage private subnets`、VPC `statuspage-vpc`
3. アベイラビリティーゾーン：`ap-southeast-2a` と `ap-southeast-2b`
4. サブネット：`10.0.11.0/24` と `10.0.12.0/24`（**パブリックの `10.0.1.0/24` は選ばない**）
5. 「作成」

- [ ] 完了

## 4. RDS を作る

> 📖 **先に読む**
> - [study §2 DB インスタンスの設定](phase3-study.md#2-db-インスタンスの設定)：全体
> - [study §3 プライベートサブネットと DB サブネットグループ](phase3-study.md#3-プライベートサブネットと-db-サブネットグループ)：「パブリックアクセス」
> - [study §6 Secrets Manager](phase3-study.md#6-secrets-manager)：「RDS が管理するマスターパスワード」
>
> 読んだら考える：パブリックアクセスを「なし」にすると、エンドポイントの名前は何を指すか

**ここから課金が始まる。** 作る前に、[RDS for PostgreSQL の料金](https://aws.amazon.com/rds/postgresql/pricing/) で、アジアパシフィック（シドニー）・Single-AZ・`db.t4g.micro` の単価を確認する。

「RDS」→「データベースを作成」→ **「標準作成」**。

| 項目 | 設定 |
|---|---|
| エンジンのタイプ | PostgreSQL |
| エンジンバージョン | PostgreSQL 17 の最新のマイナーバージョン |
| テンプレート | 「無料利用枠」（表示されれば）、なければ「開発/テスト」 |
| 可用性と耐久性 | **シングル AZ DB インスタンス** |
| DB インスタンス識別子 | `statuspage-db` |
| マスターユーザー名 | `postgres` |
| 認証情報の管理 | **「AWS Secrets Manager で管理」**、暗号化キーは `aws/secretsmanager` |
| インスタンスの設定 | バースト可能クラス → `db.t4g.micro` |
| ストレージタイプ | gp3、ストレージの割り当て 20GiB |
| ストレージの自動スケーリング | **無効**（チェックを外す） |
| コンピューティングリソース | **「EC2 コンピューティングリソースに接続しない」** |
| VPC | `statuspage-vpc` |
| DB サブネットグループ | `statuspage-db-subnets` |
| パブリックアクセス | **なし** |
| VPC セキュリティグループ | 「既存の選択」→ `statuspage-db-sg` だけ（`default` が入っていたら外す） |
| アベイラビリティーゾーン | `ap-southeast-2a`（EC2 と同じ） |
| RDS Proxy | 作成しない |
| データベース認証 | パスワード認証 |
| モニタリング | 追加料金のかかる項目（拡張モニタリングなど）は有効にしない |
| 追加設定 → 最初のデータベース名 | **空のまま**（手順8で作る） |
| 追加設定 → バックアップ保持期間 | 1日 |
| 追加設定 → 削除保護 | 無効 |

「データベースを作成」→ 状態が「**利用可能**」になるまで待つ（10分ほどかかる）。

利用可能になったら、`statuspage-db` を開いて次の2つを **手元にメモする**（リポジトリやチャットには貼らない）。

| メモするもの | 場所 |
|---|---|
| エンドポイント（`statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com`） | 「接続とセキュリティ」タブ |
| マスター認証情報の ARN（`arn:aws:secretsmanager:...:secret:rds!db-xxxx`） | 「設定」タブ |

- 「EC2 コンピューティングリソースに接続」を選ぶと、セキュリティグループを自動で作って付けてくれる。今回は仕組みを理解するために、手順2で自分で作ったものを使う
- 画面の項目名は変わることがある。迷ったら、上の表の「何を決めるか」を手がかりにする

- [ ] 単価を確認した
- [ ] `statuspage-db` が「利用可能」
- [ ] エンドポイントとマスター認証情報の ARN をメモした

## 5. アプリ用のシークレットを作る

> 📖 **先に読む**
> - [study §6 Secrets Manager](phase3-study.md#6-secrets-manager)：「Phase 2 との比較」「用語」
>
> 読んだら考える：このシークレットを、EC2 ではなく CloudShell で作るのはなぜか（EC2 のロールにどんな権限を付けたくないか）

コンソールの右上（または下）の **CloudShell** のアイコンを押す。ブラウザの中に、自分の権限で AWS CLI が使えるシェルが開く。

```bash
APP_PASSWORD=$(aws secretsmanager get-random-password --region ap-southeast-2 --exclude-punctuation --password-length 32 --query RandomPassword --output text)
aws secretsmanager create-secret --region ap-southeast-2 --name statuspage/db-app --description "statuspage app user password" --secret-string "$APP_PASSWORD" --query Name --output text
unset APP_PASSWORD
```

- 1行目：Secrets Manager にランダムなパスワードを作ってもらい、変数に入れる（画面には出さない）。`--exclude-punctuation` で英数字だけにすると、URL の中に書いても問題が起きない
- 2行目：シークレット `statuspage/db-app` を作る。`--query Name` で、表示を名前だけにする（ARN にはアカウントID が入るため）
- 3行目：変数を消す
- コンソールの「Secrets Manager」で、`statuspage/db-app` と `rds!db-xxxx` の2つがあることを確認する（「シークレットの値を取得する」は押さない）

- [ ] 完了

## 6. EC2 にシークレットを読む権限を付ける

> 📖 **先に読む**
> - [study §6 Secrets Manager](phase3-study.md#6-secrets-manager)：「シークレットの ARN」「取り出すための IAM 権限」「インラインポリシーと管理ポリシー」
> - [phase2-study §6 IAM ロールと EC2](phase2-study.md#6-iam-ロールと-ec2)：「仕組み」（復習）
>
> 読んだら考える：`Resource` を `"*"` にすると、何が困るか

1. 「IAM」→「ロール」→ `statuspage-ec2-role` →「許可を追加」→「インラインポリシーを作成」
2. 「JSON」を選び、次の内容にする。`<アカウントID>` と `<マスター認証情報の ARN>` は自分のものに置き換える

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadStatuspageDbSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:ap-southeast-2:<アカウントID>:secret:statuspage/db-app-??????",
        "<マスター認証情報の ARN>"
      ]
    }
  ]
}
```

3. ポリシー名 `statuspage-read-db-secrets` →「ポリシーの作成」

- アカウントID はコンソール右上のメニューで確認できる
- `??????` は、AWS がシークレットの名前の後ろに付けるランダムな6文字
- マスター認証情報（2つ目）は、手順7〜8の管理作業のためだけに一時的に付ける。手順12で外す
- 実際のアカウントID や ARN を書いたポリシーは、リポジトリには入れない

- [ ] 完了

## 7. EC2 から RDS に接続する

> 📖 **先に読む**
> - [study §5 RDS のユーザーと権限](phase3-study.md#5-rds-のユーザーと権限)：「マスターユーザーと rds_superuser」
> - [study §7 接続の暗号化](phase3-study.md#7-接続の暗号化)：「rds.force_ssl」「確かめ方」
>
> 読んだら考える：Phase 2 の `sudo -u postgres psql`（パスワードなし）と同じやり方で、RDS に入れないのはなぜか

Session Manager で `statuspage-ec2` に入る。**手順7〜10は、同じ画面のまま続ける**（変数は画面を閉じると消える）。

```bash
cd /tmp
DB_HOST=statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com
MASTER_SECRET_ARN='arn:aws:secretsmanager:ap-southeast-2:xxxxxxxxxxxx:secret:rds!db-xxxx'
```

- `DB_HOST` と `MASTER_SECRET_ARN` は、手順4でメモしたものに置き換える
- ARN は `'`（シングルクォート）で囲む（`!` がシェルに特別な意味で解釈されないように）

```bash
getent hosts "$DB_HOST"
MASTER_PASSWORD=$(aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id "$MASTER_SECRET_ARN" --query SecretString --output text | python3 -c 'import json, sys; print(json.load(sys.stdin)["password"])')
echo ${#MASTER_PASSWORD}
PGPASSWORD="$MASTER_PASSWORD" psql -h "$DB_HOST" -U postgres -d postgres -c "SELECT current_user, version();"
PGPASSWORD="$MASTER_PASSWORD" psql -h "$DB_HOST" -U postgres -d postgres -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
```

| 行 | 意味 |
|---|---|
| 1 | エンドポイントの名前が、どの IP アドレスを指すか調べる |
| 2 | EC2 のロールでマスターのシークレットを取り出し、JSON の中の `password` だけを変数に入れる（画面には出さない） |
| 3 | パスワードの **文字数だけ** を表示する（取り出せたかの確認。中身は出さない） |
| 4 | マスターユーザーで接続し、自分が誰か・DB のバージョンを表示する |
| 5 | 今の接続が暗号化されているか（`ssl` が `t` か）を表示する |

- 2行目で `AccessDeniedException` になったら、手順6のポリシーの ARN を確認する
- 4行目で長く待たされたら、手順2のセキュリティグループと、RDS に付けたセキュリティグループを確認する

- [ ] 完了

## 8. アプリ用のユーザーと DB を作る

> 📖 **先に読む**
> - [study §5 RDS のユーザーと権限](phase3-study.md#5-rds-のユーザーと権限)：「アプリには専用のユーザーを作る」「PostgreSQL 16 以降の持ち主の指定」
>
> 読んだら考える：アプリをマスターユーザーでつながないのはなぜか（理由を2つ）

```bash
APP_PASSWORD=$(aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id statuspage/db-app --query SecretString --output text)
echo ${#APP_PASSWORD}
PGPASSWORD="$MASTER_PASSWORD" psql -h "$DB_HOST" -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE statuspage WITH LOGIN PASSWORD '$APP_PASSWORD';" \
  -c "GRANT statuspage TO postgres;" \
  -c "CREATE DATABASE statuspage OWNER statuspage;"
PGPASSWORD="$APP_PASSWORD" psql -h "$DB_HOST" -U statuspage -d statuspage -c "SELECT current_user, current_database();"
```

| 行 | 意味 |
|---|---|
| 1〜2 | アプリ用のパスワードを取り出し、文字数だけを表示する |
| 3〜6 | マスターユーザーで、ロール `statuspage` を作る → `postgres` を `statuspage` のメンバーにする → 持ち主が `statuspage` の DB を作る |
| 7 | アプリ用のユーザーで接続できるか確かめる |

- `-v ON_ERROR_STOP=1` は「エラーが出たら、そこで止まる」
- `CREATE ROLE`、`GRANT ROLE`、`CREATE DATABASE` と表示されれば OK

- [ ] 完了

## 9. データを引っ越す

> 📖 **先に読む**
> - [study §8 データの引っ越し](phase3-study.md#8-データの引っ越し)：全体
>
> 読んだら考える：書き出す前に、api と worker を止めるのはなぜか

```bash
sudo systemctl stop statuspage-worker statuspage-api
cd /tmp
sudo -u postgres pg_dump --no-owner --no-privileges statuspage > /tmp/statuspage.sql
grep -E '^(CREATE TABLE|COPY)' /tmp/statuspage.sql
sudo -u postgres psql -d statuspage -c "SELECT (SELECT count(*) FROM targets) AS targets, (SELECT count(*) FROM checks) AS checks;"
```

| 行 | 意味 |
|---|---|
| 1 | アプリを止める（ここからサービスが止まる） |
| 3 | EC2 の PostgreSQL の DB `statuspage` を、SQL のファイルに書き出す |
| 4 | ファイルの中の、テーブルを作る文とデータを入れる文の行だけを表示する |
| 5 | 引っ越し元の件数を数える |

```bash
PGPASSWORD="$APP_PASSWORD" psql -h "$DB_HOST" -U statuspage -d statuspage -v ON_ERROR_STOP=1 -q -f /tmp/statuspage.sql
PGPASSWORD="$APP_PASSWORD" psql -h "$DB_HOST" -U statuspage -d statuspage -c "SELECT (SELECT count(*) FROM targets) AS targets, (SELECT count(*) FROM checks) AS checks;"
rm /tmp/statuspage.sql
```

| 行 | 意味 |
|---|---|
| 1 | ファイルの SQL を、アプリ用のユーザーで RDS に流し込む（`-q` は余計な表示を減らす） |
| 2 | 引っ越し先の件数を数える。**引っ越し元と同じ** になっていれば OK |
| 3 | 書き出したファイルを消す |

- [ ] 件数が一致した

## 10. アプリの接続先を RDS に切り替える

> 📖 **先に読む**
> - [study §7 接続の暗号化](phase3-study.md#7-接続の暗号化)：「クライアントの sslmode」
> - [study §6 Secrets Manager](phase3-study.md#6-secrets-manager)：「設定ファイルにパスワードを書き写す方法の限界」
>
> 読んだら考える：`?sslmode=require` を付けなくても RDS につながるのはなぜか。それでも付けるのはなぜか

```bash
sudo cp -p /etc/statuspage.env /etc/statuspage.env.phase2
sudo sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql+psycopg://statuspage:${APP_PASSWORD}@${DB_HOST}:5432/statuspage?sslmode=require#" /etc/statuspage.env
sudo grep '^DATABASE_URL=' /etc/statuspage.env | sed -E 's#(://[^:]+:)[^@]+@#\1****@#'
ls -l /etc/statuspage.env /etc/statuspage.env.phase2
```

| 行 | 意味 |
|---|---|
| 1 | 元のファイルを、権限（`600`）を保ったまま控えておく（`-p`）。戻したくなったときのため |
| 2 | `DATABASE_URL` の行を、RDS のエンドポイントとアプリ用のパスワードに書き換える |
| 3 | パスワードを伏せて確認する |
| 4 | 2つのファイルが、どちらも `-rw------- root root` か確認する |

```bash
sudo systemctl start statuspage-api statuspage-worker
systemctl status statuspage-api statuspage-worker --no-pager
sudo journalctl -u statuspage-worker -n 10 --no-pager
curl -s localhost/healthz
PGPASSWORD="$MASTER_PASSWORD" psql -h "$DB_HOST" -U postgres -d postgres -c "SELECT a.usename, a.client_addr, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid) WHERE a.usename = 'statuspage';"
```

- 最後の行は、RDS から見た「今つながっているアプリ」の一覧。どこから（`client_addr`）、暗号化して（`ssl`）つながっているかが分かる
- ブラウザで `http://<パブリック IP>/` を開き、引っ越す前の監視対象が表示され、最終チェックの時刻が新しくなっていくことを確認する

- [ ] 完了

## 11. 実験A：EC2 の PostgreSQL を止める

> 📖 **実験のあとに読む**
> - [study §9 systemd の依存と mask](phase3-study.md#9-systemd-の依存と-mask)：全体

アプリは RDS を使うようになったので、EC2 の PostgreSQL はもういらない。止めて、自動で起動しないようにする。予想してから1行ずつ実行する。

```bash
sudo systemctl disable --now postgresql
systemctl is-active postgresql
sudo systemctl restart statuspage-api
systemctl is-active postgresql
```

考えること：

- 2行目と4行目の結果は同じか。違うなら、なぜか（ヒント：`deploy/ec2/statuspage-api.service` の `[Unit]`）

結果を確かめたら、次を実行する。

```bash
sudo systemctl mask --now postgresql
sudo systemctl restart statuspage-api statuspage-worker
systemctl is-active postgresql
curl -s localhost/healthz
```

考えること：

- `disable` と `mask` は何が違うか
- EC2 の PostgreSQL が止まっていても、アプリが動くのはなぜか

- [ ] 完了

## 12. 管理用のシークレットを読む権限を外す

> 📖 **先に読む**
> - [study §6 Secrets Manager](phase3-study.md#6-secrets-manager)：「取り出すための IAM 権限」
>
> 読んだら考える：アプリが普段使わない権限を、EC2 のロールに残しておくと何が困るか

1. 「IAM」→「ロール」→ `statuspage-ec2-role` →「許可」タブ → `statuspage-read-db-secrets` →「編集」
2. `Resource` から `<マスター認証情報の ARN>` の行を消し、`statuspage/db-app-??????` の1行だけにする（`Resource` は文字列1つでもリストのままでもよい）
3. 「変更を保存」

Session Manager の画面に戻り、予想してから実行する。

```bash
aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id "$MASTER_SECRET_ARN" --query Name --output text
aws secretsmanager get-secret-value --region ap-southeast-2 --secret-id statuspage/db-app --query Name --output text
unset MASTER_PASSWORD APP_PASSWORD
```

- `--query Name` で、取り出せても名前だけを表示する
- IAM の変更が効くまで、数秒〜十数秒かかることがある
- 3行目で、画面の変数に残っているパスワードを消す
- このあとマスターユーザーで管理作業が必要になったら、手順6と同じように一時的に権限を足し、作業後に外す

- [ ] 完了

## 13. 実験B：手元の PC から RDS につながるか

> 📖 **実験のあとに読む**
> - [study §3 プライベートサブネットと DB サブネットグループ](phase3-study.md#3-プライベートサブネットと-db-サブネットグループ)：「パブリックアクセス」
> - [study §11 DB につながらないときの切り分け](phase3-study.md#11-db-につながらないときの切り分け)：全体

手元の PC で、RDS のエンドポイントの名前を引き、5432番に接続してみる。予想してから実行する。

Windows（PowerShell）：

```powershell
Resolve-DnsName statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com
Test-NetConnection statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com -Port 5432
```

macOS：

```bash
dig +short statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com
nc -vz -G 5 statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com 5432
```

考えること：

- 名前は引けるか。引けるなら、返ってきた IP アドレスはどんな種類のアドレスか
- 接続はできるか。できないなら、その理由はいくつ挙げられるか（手順1〜4で決めたことから）

- [ ] 完了

## 14. 実験C：RDS を再起動すると、アプリはどうなるか

> 📖 **実験のあとに読む**
> - [study §11 DB につながらないときの切り分け](phase3-study.md#11-db-につながらないときの切り分け)：全体（「DB の再起動と接続プール」を含む）
> - [phase2-study §11 つながらないときの切り分け](phase2-study.md#11-つながらないときの切り分け)：表（復習）
> - [phase1-study §7 DB との接続と障害への備え](phase1-study.md#7-db-との接続と障害への備え)：「接続プール」「pool_pre_ping」（復習）

RDS を3回再起動して、アプリの振る舞いを比べる。再起動は RDS のコンソールで `statuspage-db` を選び、「アクション」→「再起動」（フェイルオーバーはしない）。状態が「利用可能」に戻るまで数分かかる。

### 14-1. 再起動中もブラウザを開き続ける

予想してから実行する。

1. Session Manager で、worker のログを表示し続ける：`sudo journalctl -u statuspage-worker -f`
2. RDS を再起動する
3. 再起動中に、ブラウザで `http://<パブリック IP>/` を何度か開き直す
4. RDS が「利用可能」に戻ったら、もう一度ブラウザで開く

考えること：

- 再起動中、ブラウザには何が表示されるか（HTTP のステータスコードは何か）。それは Phase 2 の実験D のどれに近いか
- worker のログには何が出るか。worker は止まってしまうか
- RDS が戻ったあと、最初に開いたページは正常に表示されたか

### 14-2. 再起動中はブラウザを開かない

EC2 のコードは、Phase 2 で取得したまま（`pool_pre_ping` なし）で行う。次のコマンドで何も表示されないことを確認する（表示されたら、すでに修正版になっているので 14-3 だけ行う）。

```bash
grep -n "pool_pre_ping" /opt/statuspage/app/statuspage/db.py
```

予想してから実行する。

1. ブラウザで `http://<パブリック IP>/` を1回開いて、正常に表示されることを確認する
2. RDS を再起動する。**再起動中はブラウザを開かない**
3. RDS が「利用可能」に戻ったら、ブラウザで1回だけ開く → 表示を確認したら、もう1回開く
4. api のログを見る：`sudo journalctl -u statuspage-api -n 30 --no-pager`

考えること：

- 戻ったあとの1回目と2回目で、結果は同じか
- 14-1 と結果が違うなら、その違いはどこから来るか（ヒント：14-1 では、再起動中に api が DB を使おうとしている）

### 14-3. アプリを直して、もう一度

`app/statuspage/db.py` で、接続プールに `pool_pre_ping=True` を付けた版が GitHub にある。これを EC2 に反映する。

```bash
cd /opt/statuspage
sudo -u statuspage -H git pull
grep -n "pool_pre_ping" app/statuspage/db.py
sudo systemctl restart statuspage-api statuspage-worker
curl -s localhost/healthz
```

- コードは `statuspage` ユーザーのものなので、`git pull` もこのユーザーで行う
- Python のコードは起動時に読み込まれるので、サービスを再起動しないと変更が効かない

そのうえで、14-2 と同じ手順（1回開く → 再起動中は開かない → 戻ったら1回だけ開く）をもう一度行い、予想してから結果を確かめる。

考えること：

- 戻ったあとの1回目は、14-2 と比べてどうなったか
- `pool_pre_ping` は、何と引き換えに、何を防いでいるか

- [ ] 14-1
- [ ] 14-2
- [ ] 14-3

## 15. 毎回の終わりに

> 📖 **先に読む**
> - [study §10 バックアップと停止](phase3-study.md#10-バックアップと停止)：「停止」
>
> 読んだら考える：次に学習を始めるとき、EC2 と RDS のどちらを先に開始するとよいか

### 学習を終えるとき

1. EC2：「インスタンスの状態」→「インスタンスを停止」
2. RDS：`statuspage-db` を選び、「アクション」→「一時的に停止」（スナップショットは作らなくてよい）

- RDS の停止は **最長7日**。7日たつと自動で起動して、料金がかかり始める。1週間以上空くときは、手順16の「最終スナップショットを作成して削除」を使う
- 停止中も、RDS のストレージ・EC2 の EBS・シークレットの料金はかかる

### 学習を始めるとき

1. RDS：「アクション」→「開始」→「利用可能」になるまで待つ
2. EC2：「インスタンスを開始」
3. ブラウザで開けなければ、[phase2-setup.md](phase2-setup.md) の手順15（IP アドレスが変わったとき）

- [ ] 理解した

## 16. Phase 3 の片付け

> 📖 **先に読む**
> - [study §10 バックアップと停止](phase3-study.md#10-バックアップと停止)：「手動スナップショット」「停止・削除・スナップショットの使い分け」
> - [study §13 ほかの Phase とのつながり](phase3-study.md#13-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：EC2 を終了しても、監視の記録が残るのはなぜか

Phase 3 を終えて Phase 4 に進むとき。

1. ブラウザで、監視の記録が RDS に入っていることを最後に確認する
2. EC2：`statuspage-ec2` を選び、「インスタンスの状態」→ **「インスタンスを終了（削除）」**（Phase 4 では、新しい EC2 を自動で作る）
3. RDS：Phase 4 をすぐに始めるなら **停止**。1週間以上空くなら「アクション」→「削除」→ **「最終スナップショットを作成」にチェック**（名前 `statuspage-db-final`）→ 削除
4. シークレット `statuspage/db-app` は **残す**（Phase 4 で使う）。`rds!db-xxxx` は、RDS を削除すると一緒に削除される
5. VPC・サブネット・ルートテーブル・セキュリティグループ・DB サブネットグループ・IAM ロールは **残す**（無料。Phase 4 で使う）
6. 「EC2」→「ボリューム」に、`statuspage-ec2` のボリュームが残っていないことを確認する

- スナップショットから作り直した DB にも、ユーザー `statuspage` とそのパスワードは残っている。シークレット `statuspage/db-app` はそのまま使える

- [ ] EC2 を終了
- [ ] RDS を停止、または最終スナップショットを作成して削除
- [ ] 残っているボリュームがないことを確認
