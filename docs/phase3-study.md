# Phase 3 知識まとめ: RDS・プライベートサブネット・Secrets Manager

> Phase 3 で出てきた知識を体系的にまとめたもの。手順は [phase3-setup.md](phase3-setup.md)。

## 目次

1. [RDS とは](#1-rds-とは)
2. [DB インスタンスの設定](#2-db-インスタンスの設定)
3. [プライベートサブネットと DB サブネットグループ](#3-プライベートサブネットと-db-サブネットグループ)
4. [セキュリティグループの参照](#4-セキュリティグループの参照)
5. [RDS のユーザーと権限](#5-rds-のユーザーと権限)
6. [Secrets Manager](#6-secrets-manager)
7. [接続の暗号化](#7-接続の暗号化)
8. [データの引っ越し](#8-データの引っ越し)
9. [systemd の依存と mask](#9-systemd-の依存と-mask)
10. [バックアップと停止](#10-バックアップと停止)
11. [DB につながらないときの切り分け](#11-db-につながらないときの切り分け)
12. [費用](#12-費用)
13. [ほかの Phase とのつながり](#13-ほかの-phase-とのつながり)
14. [理解度チェック](#14-理解度チェック)

---

## 1. RDS とは

**RDS（Relational Database Service）は、AWS が DB サーバーの運用を引き受けてくれる、マネージド（管理付き）の DB サービス。** PostgreSQL・MySQL・MariaDB・SQL Server・Oracle などを選べる。

### Phase 2 との比較

| 作業 | Phase 2（EC2 に自分で入れた PostgreSQL） | RDS |
|---|---|---|
| OS とパッケージの更新 | 自分（`dnf update`） | AWS |
| PostgreSQL のインストールと初期化 | 自分（`dnf install`、`postgresql-setup --initdb`） | AWS |
| PostgreSQL のマイナーバージョンの更新 | 自分 | AWS（メンテナンスウィンドウ＝決めた時間帯に自動） |
| バックアップ | 自分で仕組みを作る | 自動（毎日のスナップショット + 変更の記録） |
| 障害時の切り替え | 自分で仕組みを作る | Multi-AZ にすれば自動（[付録 A](phase3-appendix.md#a-multi-az-配置とリードレプリカ)） |
| 監視 | 自分で仕組みを作る | CloudWatch に指標が自動で出る |
| サーバーにログインする | できる（Session Manager） | **できない**（OS には触れない） |
| 本物の superuser | `postgres` は superuser | **なれない**（`rds_superuser` という、少し弱い管理者になる。[§5](#5-rds-のユーザーと権限)） |
| サーバーとの関係 | EC2 と運命を共にする（終了すると消える） | **EC2 とは別に存在する** |

### 責任共有モデル

AWS と利用者で、守る範囲を分担する考え方。マネージドなサービスほど、AWS の範囲が広い。

| | EC2 に自分で入れた DB | RDS |
|---|---|---|
| AWS の範囲 | 物理サーバー、ハイパーバイザー、ネットワーク | 左に加えて、OS、DB ソフトのインストール・更新、バックアップの仕組み |
| 利用者の範囲 | OS、DB ソフト、設定、データ、アクセス制御 | **DB の中のユーザーと権限、データ、ネットワークのアクセス制御**（セキュリティグループ、サブネット）、どの設定で作るか |

RDS でも、「誰が DB につながれるか」は利用者の責任のまま。

---

## 2. DB インスタンスの設定

RDS で作る DB サーバー1台を **DB インスタンス** と呼ぶ。

| 項目 | 意味 | このプロジェクト |
|---|---|---|
| エンジン・バージョン | DB の種類とバージョン | PostgreSQL 17（手元の Compose・Phase 2 とそろえる） |
| インスタンスクラス | CPU とメモリの大きさ（EC2 のインスタンスタイプに相当。`db.` が付く） | `db.t4g.micro`（Arm、vCPU 2、メモリ 1GB） |
| ストレージ | ディスクの種類と容量 | gp3 20GiB（PostgreSQL の gp3 の最小） |
| ストレージの自動スケーリング | 容量が足りなくなると自動で増やす | 無効（学習では、知らないうちに増えて料金が上がるのを避ける） |
| 配置 | Single-AZ（1台）か Multi-AZ（予備を別の AZ に置く） | Single-AZ（無料プランの対象。Multi-AZ は料金が約2倍） |
| エンドポイント | DB につなぐときのホスト名 | `statuspage-db.xxxx.ap-southeast-2.rds.amazonaws.com` の形 |
| ポート | 待ち受けるポート | 5432（PostgreSQL の既定） |
| パラメータグループ | DB の設定値（`postgresql.conf` に相当）をまとめたもの | 既定のもの（`default.postgres17`）。既定は編集できないので、変えたいときは自分のグループを作る |
| 削除保護 | 有効にすると、誤って削除できない | 学習では無効（片付けで削除するため）。本番では有効にする |

### エンドポイントを使う理由

RDS の DB インスタンスの IP アドレスは、再起動や障害時の切り替えで変わることがある。アプリは IP アドレスではなく **エンドポイント（DNS の名前）** でつなぐ。名前の指す先は AWS が書き換えてくれる。

---

## 3. プライベートサブネットと DB サブネットグループ

### プライベートサブネット

**`0.0.0.0/0` → インターネットゲートウェイ のルートを持たないサブネット。** インターネットとの出入口への道がないので、外から直接届かず、中からも外へ出られない。

| | パブリックサブネット | プライベートサブネット |
|---|---|---|
| ルートテーブル | `local` + `0.0.0.0/0` → IGW | `local` だけ |
| 置くもの | 外から入ってくる入口（Web サーバー、Phase 4 では ALB） | 外に見せたくないもの（DB、内部のサーバー） |
| VPC の中との通信 | できる（`local`） | できる（`local`） |

DB をプライベートサブネットに置くと、セキュリティグループの設定を間違えても、そもそもインターネットから届かない（多層防御）。

### このプロジェクトの番号の割り当て

| サブネット | CIDR | AZ | 用途 |
|---|---|---|---|
| `statuspage-public-a` | `10.0.1.0/24` | `ap-southeast-2a` | Web（Phase 2） |
| `statuspage-public-b` | `10.0.2.0/24` | `ap-southeast-2b` | Web の2台目（Phase 4） |
| `statuspage-private-a` | `10.0.11.0/24` | `ap-southeast-2a` | DB（Phase 3） |
| `statuspage-private-b` | `10.0.12.0/24` | `ap-southeast-2b` | DB（Phase 3。DB サブネットグループのため） |

パブリックは `10.0.1〜`、プライベートは `10.0.11〜` と番号の範囲を分けておくと、IP アドレスを見ただけでどちらか分かる。

### DB サブネットグループ

**RDS に「この中のどれかのサブネットに置いてよい」と教えるための、サブネットのまとまり。**

- **2つ以上の AZ のサブネットを含める必要がある**（Single-AZ でも）。Multi-AZ にしたときや、障害時に別の AZ に置き直すときのため
- DB インスタンスを作るときに、どの AZ に置くかを指定できる。EC2 と同じ AZ に置くと、EC2 と DB の間の通信料がかからない（AZ をまたぐ通信は少額の料金がかかる）

### パブリックアクセス

RDS には「パブリックアクセス」という設定がある。

| 設定 | エンドポイントの名前が指す先 | インターネットから |
|---|---|---|
| なし（このプロジェクト） | **プライベート IP**（`10.0.11.x` など） | 届かない |
| あり | パブリック IP | パブリックサブネットに置き、セキュリティグループで許可すれば届く |

パブリックアクセスが「なし」でも、エンドポイントの名前は **インターネット上の DNS で引ける**。ただし返ってくるのはプライベート IP なので、VPC の外からはその IP に届かない。

---

## 4. セキュリティグループの参照

セキュリティグループのルールのソースには、IP アドレスの範囲（CIDR）のほかに、**別のセキュリティグループ** を指定できる。

| ルールのソース | 意味 | 向いている場面 |
|---|---|---|
| `203.0.113.10/32`（CIDR） | この IP アドレスから | 人がアクセスする場所（自宅、大学） |
| `statuspage-web-sg`（セキュリティグループ） | **このセキュリティグループが付いたインスタンスから** | AWS の中のサーバー同士 |

### このプロジェクトのルール

| セキュリティグループ | 方向 | ポート | ソース |
|---|---|---|---|
| `statuspage-web-sg`（EC2） | インバウンド | 80 | 自宅などのグローバル IP（Phase 2） |
| `statuspage-db-sg`（RDS） | インバウンド | **5432** | **`statuspage-web-sg`** |

- EC2 を作り直して IP アドレスが変わっても、`statuspage-web-sg` が付いていれば DB につながる。ルールを書き換えなくてよい
- Phase 4 で EC2 を複数台にしても、全部に `statuspage-web-sg` を付ければ、ルールは1つのまま
- 「web から db へ」の向きだけを許可する。DB から web へ接続を始めることはないので、逆向きのルールはいらない（返事はステートフルで通る）

---

## 5. RDS のユーザーと権限

### マスターユーザーと rds_superuser

RDS を作るときに決める **マスターユーザー**（既定の名前は `postgres`）は、`rds_superuser` というロールのメンバーになる。

| | Phase 2 の `postgres` | RDS のマスターユーザー |
|---|---|---|
| 本物の superuser か | はい | **いいえ**（`rds_superuser`） |
| ロールや DB を作れるか | はい | はい |
| OS のファイルを読むなど、サーバー全体に影響する操作 | できる | できない（AWS が管理しているため） |
| ログインのしかた | ソケット + peer（パスワードなし） | **TCP + パスワード**（RDS にはソケットで入る手段がない） |

### アプリには専用のユーザーを作る

Phase 2 と同じく、アプリはマスターユーザーではなく、**自分の DB だけを持つ専用のユーザー** でつなぐ。

| ユーザー | 使う人 | 権限 | パスワードの保管 |
|---|---|---|---|
| `postgres`（マスター） | 管理作業をする人 | `rds_superuser`（ロールや DB を作る） | RDS が Secrets Manager で管理（自動で変わる） |
| `statuspage` | アプリ | DB `statuspage` の持ち主（その中だけで何でもできる） | 自分で作ったシークレット |

アプリが乗っ取られても、盗まれるのは `statuspage` の権限だけ。他の DB やロールには触れない（最小権限）。

### PostgreSQL 16 以降の「持ち主の指定」

PostgreSQL 16 から、**他のロールを持ち主にして DB を作る（`CREATE DATABASE ... OWNER x`）には、そのロール `x` に SET ROLE できる（なりかわれる）権限が必要** になった。

- superuser ではないマスターユーザーが `CREATE ROLE statuspage` しても、自動では `statuspage` になりかわれない
- そのため、先に `GRANT statuspage TO postgres;`（`postgres` を `statuspage` のメンバーにする）を実行してから、`CREATE DATABASE statuspage OWNER statuspage;` を実行する
- 付けないと `must be able to SET ROLE "statuspage"` というエラーになる

### PostgreSQL のロールと IAM ロール

名前は同じ「ロール」だが、まったく別のもの。

| | PostgreSQL のロール | IAM ロール |
|---|---|---|
| どこで通じるか | その DB サーバーの中だけ | AWS 全体 |
| 何を決めるか | DB の中で何をしてよいか | AWS の API で何をしてよいか |
| 例 | `postgres`、`statuspage` | `statuspage-ec2-role` |

---

## 6. Secrets Manager

**パスワードや API キーなどの秘密情報（シークレット）を、暗号化して預けておくサービス。** 取り出すには IAM の権限が必要。

### Phase 2 との比較

| | Phase 2（`/etc/statuspage.env` に直接書く） | Secrets Manager |
|---|---|---|
| 置き場所 | サーバーの中のファイル | AWS（暗号化して保管） |
| 誰が読めるか | サーバーの root | IAM で許可した人・ロールだけ |
| 誰がいつ読んだか | 分からない | CloudTrail に記録される |
| サーバーを作り直したとき | パスワードを手で入れ直す | サーバーが自分で取りに行ける |
| 変更 | 手で書き換える | 新しい版（バージョン）を作る。自動で変える（ローテーション）こともできる |

### 用語

| 用語 | 意味 |
|---|---|
| シークレット | 預けた秘密情報1つ。名前（例：`statuspage/db-app`）と ARN を持つ |
| シークレットの値 | 中身。文字列か、`{"username": "...", "password": "..."}` のような JSON |
| バージョン | 値を変えると新しいバージョンができる。古いものは `AWSPREVIOUS` として1つ残る |
| ローテーション | パスワードを定期的に自動で変えること |
| KMS | シークレットを暗号化する鍵を管理するサービス。既定では AWS が用意した鍵（`aws/secretsmanager`）を使い、追加の設定はいらない |

### シークレットの ARN

```
arn:aws:secretsmanager:ap-southeast-2:<アカウントID>:secret:statuspage/db-app-AbCdEf
```

- 名前の後ろに、AWS がランダムな6文字を付け足す
- IAM ポリシーで指定するときは、`statuspage/db-app-??????`（`?` は任意の1文字）のように書くと、このシークレットだけを指せる

### RDS が管理するマスターパスワード

RDS を作るときに「AWS Secrets Manager で管理」を選ぶと、RDS がマスターユーザーのパスワードを作り、`rds!db-xxxx` という名前のシークレットに保管する。

- 値は `{"username": "postgres", "password": "..."}` の JSON
- **既定で定期的に自動で変わる**（ローテーション）。人が覚えておく必要がない
- だから、アプリの設定ファイルにマスターパスワードを書き写すと、変わったときにアプリが動かなくなる。アプリには別のユーザーと別のシークレットを使う（[§5](#5-rds-のユーザーと権限)）
- DB インスタンスを削除すると、このシークレットも一緒に削除される

### 取り出すための IAM 権限

EC2 のロールに、取り出す権限（`secretsmanager:GetSecretValue`）を **必要なシークレットだけ** に付ける。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-southeast-2:<アカウントID>:secret:statuspage/db-app-??????"
    }
  ]
}
```

- `Resource` で範囲を絞る。`"*"` にすると、アカウントのすべてのシークレットを読めてしまう
- 管理作業のために、一時的に別のシークレットを読む権限を足し、作業が終わったら外す。権限は「付けっぱなし」にしない

### インラインポリシーと管理ポリシー

| | 管理ポリシー（`AmazonSSMManagedInstanceCore` など） | インラインポリシー |
|---|---|---|
| どこにあるか | 独立した部品。複数のロールに付けられる | 1つのロールの中に直接書く |
| 向いている場面 | よくある権限のまとまり | そのロールだけに必要な、細かい権限（特定のシークレットだけ、など） |

### 設定ファイルにパスワードを書き写す方法の限界

このプロジェクトの Phase 3 では、サーバーで1回シークレットを取り出して `/etc/statuspage.env` に書き込む。人がパスワードを見たり貼ったりしなくてよくなるが、次の限界がある。

- シークレットの値を変えても、設定ファイルを書き直してアプリを再起動するまで、古いパスワードのまま
- そのため、アプリ用のシークレットは自動ローテーションを使わない

アプリが起動のたびにシークレットを読む形や、ECS（Phase 7）がシークレットを環境変数として渡す形にすると、この限界はなくなる（[付録 E](phase3-appendix.md#e-シークレットを自動で変える)）。

---

## 7. 接続の暗号化

### rds.force_ssl

RDS for PostgreSQL 15 以降は、パラメータ `rds.force_ssl` が既定で `1`（有効）。**暗号化されていない接続は拒否される。** EC2 と RDS の間の通信も TLS（HTTPS と同じ暗号化の仕組み）で守られる。

### クライアントの sslmode

接続する側（psycopg、psql）は `sslmode` で、暗号化をどこまで求めるかを決める。

| sslmode | 暗号化 | 相手が本物の RDS か確かめる | 説明 |
|---|---|---|---|
| `disable` | しない | — | RDS では拒否される |
| `prefer`（既定） | できればする | しない | 相手が暗号化できなければ、暗号化なしでつなぐ |
| `require` | **必ずする** | しない | 暗号化できなければつながない |
| `verify-full` | 必ずする | **する**（証明書とホスト名を確かめる） | RDS の CA 証明書を手元に置く必要がある |

- このプロジェクトでは `DATABASE_URL` の最後に `?sslmode=require` を付ける。サーバー側（`rds.force_ssl`）とクライアント側の両方で暗号化を求める
- `verify-full` にすると、なりすましの DB につながる危険もなくなる（[付録 F](phase3-appendix.md#f-証明書まで確かめる接続)）

### 確かめ方

```sql
SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();
```

`ssl` が `t`（true）なら、今の接続は暗号化されている。

---

## 8. データの引っ越し

### 流れ

| 順番 | 作業 | 理由 |
|---|---|---|
| ① | アプリ（api・worker）を止める | 引っ越しの途中で新しいデータが書き込まれると、引っ越し先に入らない |
| ② | 引っ越し元から書き出す（`pg_dump`） | DB の中身を、SQL の文の並びとしてファイルにする |
| ③ | 引っ越し先に読み込む（`psql -f`） | ファイルの SQL を順に実行し、テーブルとデータを作り直す |
| ④ | 件数を比べる | 全部入ったか確かめる |
| ⑤ | アプリの接続先を変えて、起動する | |

①〜⑤の間、サービスは止まる。この時間を **ダウンタイム** と呼ぶ。データが少なければ数分で済む。止めずに引っ越す方法もあるが、仕組みが大がかりになる（AWS DMS など）。

### pg_dump のオプション

| オプション | 意味 | 理由 |
|---|---|---|
| `--no-owner` | 「テーブルの持ち主は誰か」を書き出さない | 引っ越し先では、読み込んだユーザー（`statuspage`）が持ち主になる |
| `--no-privileges` | 権限の設定（`GRANT`）を書き出さない | 引っ越し元のロールが、引っ越し先にあるとは限らない |

### バージョン

`pg_dump` は、引っ越し先と同じかそれより新しいバージョンを使う。手元・EC2・RDS を同じ 17 にそろえておくと、気にしなくてよい。

### 引っ越しのあとのファイル

書き出したファイルには、データがそのまま入っている。使い終わったら削除する。

---

## 9. systemd の依存と mask

### Wants と After

Phase 2 の `.service` には `After=postgresql.service` と `Wants=postgresql.service` が書いてある。

| 設定 | 意味 |
|---|---|
| `After=` | **順番**：両方を起動するなら、こちらを後にする。相手を起動させる力はない |
| `Wants=` | **引き連れる**：こちらを起動するとき、相手も **起動させる**（相手が失敗しても、こちらは起動する） |
| `Requires=` | 引き連れる。相手が起動に失敗したら、こちらも起動しない（このプロジェクトでは使っていない） |

`Wants=` は、相手が `disable`（自動起動しない設定）になっていても、相手を起動させる。`enable` は「サーバーの起動時に起動するか」だけを決める設定で、他のユニットから引き連れられるのは止められない。

### mask

| コマンド | 効果 |
|---|---|
| `systemctl disable` | サーバーの起動時に自動で起動しなくなる。手で `start` したり、`Wants=` で引き連れられたりすると起動する |
| `systemctl mask` | **どうやっても起動できなくする**（ユニットファイルを `/dev/null` へのリンクで上書きする） |
| `systemctl unmask` | `mask` を元に戻す |

`mask --now` は、止める + mask を一度に行う。もう使わないが、パッケージは消したくないサービスに使う。

---

## 10. バックアップと停止

### 自動バックアップ

| 項目 | 内容 |
|---|---|
| 何をするか | 毎日1回、DB のスナップショット（その時点の丸ごとの写し）を取り、その間の変更の記録も保存する |
| 戻せる範囲 | 保持期間（1〜35日）の中の、**任意の時刻**（ポイントインタイムリカバリ） |
| 料金 | 確保したストレージ（20GiB）と同じ量までは追加料金なし |
| 戻し方 | 元の DB を書き換えるのではなく、**新しい DB インスタンス** として作られる |

### 手動スナップショット

- 自分で好きなときに取るスナップショット。DB インスタンスを削除しても残る
- 保存している量に応じて料金がかかる
- DB インスタンスを削除するときに「最終スナップショットを作成」を選ぶと、削除の直前の状態を残せる。あとでそこから新しい DB インスタンスを作れる

### 停止

| | 停止中 |
|---|---|
| DB インスタンスの料金 | かからない |
| ストレージとスナップショットの料金 | **かかる** |
| 期間 | **最長7日。7日たつと自動で起動する**（AWS がメンテナンスを適用するため） |

- 7日以上使わないなら、停止ではなく「最終スナップショットを作成して削除」のほうが安く、自動起動の心配もない
- 停止中の DB にアプリがつなごうとすると、接続できずにエラーになる。次に使うときは、**RDS を先に起動** してから EC2 を起動する

### 停止・削除・スナップショットの使い分け

| 状況 | おすすめ |
|---|---|
| 今日の学習を終える（明日また使う） | 停止 |
| 1週間以上使わない | 最終スナップショットを作成して削除 |
| もう使わない | 削除（スナップショットも不要なら作らない） |

---

## 11. DB につながらないときの切り分け

アプリのログ（`sudo journalctl -u statuspage-api`）や `psql` のエラーの文言で、どこで止まったかが分かる。

| エラーの文言 | どこで止まったか | よくある原因 |
|---|---|---|
| `could not translate host name` | **名前が引けない**（DNS） | エンドポイントの打ち間違い、VPC の DNS の設定 |
| `Connection timed out`、または長く待たされる | **届いていない** | DB のセキュリティグループ（ソースが違う）、別の VPC、RDS が停止中・起動中 |
| `Connection refused` | 届いたが、誰も待ち受けていない | ポート番号の間違い、DB が再起動中 |
| `password authentication failed` | 届いたが、**認証** で拒否 | パスワードの間違い、ユーザー名の間違い |
| `no pg_hba.conf entry ... no encryption` | 届いたが、**暗号化なし** で拒否 | `sslmode=disable` でつないだ |
| `permission denied for ...` | 認証は通ったが、**認可** で拒否 | そのユーザーに権限がない |
| `database "xxx" does not exist` | 認証は通ったが、DB がない | DB の名前の間違い、DB をまだ作っていない |

Phase 2 の §11 と同じく、外側（名前、ネットワーク、セキュリティグループ）から内側（認証、認可）へ順に調べる。

### Phase 2 との違い

| | Phase 2 | Phase 3 |
|---|---|---|
| アプリから DB までの道 | 同じサーバーの中（`127.0.0.1`） | **VPC の中のネットワーク**（別のサブネット、セキュリティグループを通る） |
| DB にサーバーとして入れるか | 入れる（`systemctl status postgresql`） | 入れない。状態は RDS のコンソールで見る |

### DB の再起動と接続プール

RDS は、再起動、メンテナンス、マルチAZ のフェイルオーバーなどで、**アプリが動いたまま DB だけが一度切れる** ことがある。このとき、アプリ側の接続プール（[phase1-study §7](phase1-study.md#7-db-との接続と障害への備え)）がどうなっているかで、振る舞いが変わる。

| DB が切れている間に、アプリが DB を使おうとしたか | プールの状態 | DB が戻った後の最初のリクエスト |
|---|---|---|
| 使おうとした（エラーになった） | SQLAlchemy が切断に気づき、プールを空にしている | 新しく接続するので **成功** |
| 使わなかった（誰もアクセスしなかった） | 切れた接続が、気づかれないままプールに残っている | 切れた接続を使って **失敗**（500）。その失敗でプールが空になり、次からは成功 |

- 接続が切れたことは、その接続を **使おうとして初めて** 分かる。DB 側の再起動を、アプリは知らされない
- アクセスの少ないアプリほど、「戻った後の最初の1回だけ失敗する」が起きやすい

`pool_pre_ping=True` を付けると、SQLAlchemy はプールから接続を取り出すたびに、軽い確認（`SELECT 1` 相当）を送る。切れていればその場で捨てて新しく接続するので、利用者にエラーを見せずに済む。

| | `pool_pre_ping` なし | `pool_pre_ping=True` |
|---|---|---|
| 切れた接続が残っていたとき | 最初の1回が失敗する | 確認で気づき、つなぎ直して成功する |
| ふだんのコスト | なし | 接続を取り出すたびに、DB との往復が1回増える |

このプロジェクトでは、`app/statuspage/db.py` の `create_engine` に付けている。

---

## 12. 費用

### このPhaseでかかるもの

| リソース | 課金の単位 | 停止中 |
|---|---|---|
| RDS の DB インスタンス | 時間（秒単位） | かからない（最長7日） |
| RDS のストレージ（gp3） | 容量 × 時間 | **かかる** |
| 自動バックアップ | 確保した容量までは追加料金なし | — |
| 手動スナップショット | 保存量 × 時間 | **かかる**（削除するまで） |
| Secrets Manager | シークレット1つにつき月額 + 取り出しの回数 | **かかる**（削除するまで） |
| AZ をまたぐ通信（EC2 と RDS が別の AZ のとき） | 量 | — |
| プライベートサブネット・ルートテーブル・DB サブネットグループ・セキュリティグループ | 無料 | — |
| EC2（Phase 2 から） | [Phase 2 §12](phase2-study.md#12-費用) | |

- Multi-AZ にすると、DB インスタンスとストレージの料金がおおよそ2倍になる
- シークレットは削除してもすぐには消えず、復元できる期間（7〜30日）が設けられる。その間は料金がかからない

---

## 13. ほかの Phase とのつながり

### Phase 2 から何が置き換わったか

| Phase 2 | Phase 3 |
|---|---|
| EC2 の中の PostgreSQL | RDS for PostgreSQL（プライベートサブネット） |
| `127.0.0.1:5432` | RDS のエンドポイント |
| `pg_hba.conf` で `127.0.0.1` からのパスワード認証を許可 | セキュリティグループで `statuspage-web-sg` からの 5432番を許可 + パスワード認証 |
| `sudo -u postgres psql`（ソケット + peer） | マスターユーザー + パスワード（TCP） |
| パスワードを `openssl rand` で作り、画面の変数に入れる | Secrets Manager に預け、IAM ロールで取り出す |
| 暗号化なし（同じサーバーの中） | TLS（`rds.force_ssl`、`sslmode=require`） |
| EBS にデータ（インスタンスの終了で消える） | RDS にデータ（EC2 とは別に存在する） |

アプリのコードは変えていない。変えたのは環境変数 `DATABASE_URL` だけ。

### この構成の弱点と、解決する Phase

| 弱点 | 解決 | Phase |
|---|---|---|
| Web サーバーが1台。止まるとサービスも止まる | ALB + Auto Scaling で複数台、マルチAZ | 4 |
| DB も1台（Single-AZ）。AZ の障害で止まる | Multi-AZ（[付録 A](phase3-appendix.md#a-multi-az-配置とリードレプリカ)） | 必要になったら |
| サーバーの準備が手作業 | ユーザーデータ（起動時に自動でセットアップ） | 4 |
| 手で作ったので、同じ構成をもう一度作るのが大変 | AWS CDK でコード化 | 5 |
| シークレットを設定ファイルに書き写している | ECS がシークレットを環境変数として渡す | 7 |

---

## 14. 理解度チェック

答えは自分で考えてから開く。

<details>
<summary>Q1. RDS にすると、Phase 2 で自分でやっていた作業のうち、何を AWS がやってくれる？ 逆に、RDS でも自分の責任のままなのは何？</summary>

OS と PostgreSQL のインストール・更新、バックアップ、監視の指標、（Multi-AZ なら）障害時の切り替えは AWS がやる。DB の中のユーザーと権限、データ、誰が DB につながれるか（セキュリティグループ、サブネット、パブリックアクセス）、どの設定で作るかは自分の責任のまま。
</details>

<details>
<summary>Q2. プライベートサブネットとパブリックサブネットは何が違う？ DB をプライベートサブネットに置く利点は？</summary>

ルートテーブルに `0.0.0.0/0` → インターネットゲートウェイ のルートがあるかどうか。プライベートサブネットはインターネットとの道がないので、セキュリティグループの設定を間違えても、インターネットから DB に届かない（多層防御）。VPC の中（EC2）からは `local` のルートで届く。
</details>

<details>
<summary>Q3. Single-AZ で作るのに、DB サブネットグループに2つの AZ のサブネットが必要なのはなぜ？</summary>

RDS の決まりで、DB サブネットグループには2つ以上の AZ のサブネットが必要。Multi-AZ にしたときに予備を別の AZ に置くためや、障害のときに別の AZ に置き直せるようにするため。
</details>

<details>
<summary>Q4. DB のセキュリティグループのソースを、EC2 のパブリック IP やプライベート IP ではなく、statuspage-web-sg にするのはなぜ？</summary>

EC2 を作り直したり台数を増やしたりして IP アドレスが変わっても、`statuspage-web-sg` が付いたインスタンスからなら接続できるので、ルールを書き換えなくてよい。また、`statuspage-web-sg` が付いていないものからは接続できない。
</details>

<details>
<summary>Q5. パブリックアクセスを「なし」にした RDS のエンドポイントを、手元の PC で名前解決するとどうなる？ 接続はできる？</summary>

名前は引けて、プライベート IP（`10.0.11.x` など）が返ってくる。しかし、そのアドレスは VPC の中だけで通じるものなので、手元の PC からは届かない（つながらない）。
</details>

<details>
<summary>Q6. アプリを、RDS のマスターユーザーではなく専用の statuspage ユーザーでつなぐのはなぜ？ 理由を2つ挙げると？</summary>

1つは最小権限。アプリが乗っ取られても、`statuspage` の DB の中だけの被害で済み、他の DB やロールには触れない。もう1つは、マスターユーザーのパスワードは RDS が自動で変える（ローテーション）ので、設定ファイルに書き写すと、変わったときにアプリがつながらなくなるため。
</details>

<details>
<summary>Q7. RDS のマスターユーザーで CREATE DATABASE statuspage OWNER statuspage; を実行する前に、GRANT statuspage TO postgres; が必要なのはなぜ？</summary>

PostgreSQL 16 以降では、他のロールを持ち主にして DB を作るには、そのロールに SET ROLE できる権限が必要。RDS のマスターユーザーは本物の superuser ではないので、`statuspage` のメンバーになって、その権限を持つ必要がある。
</details>

<details>
<summary>Q8. Phase 2 のように /etc/statuspage.env にパスワードを手で書くのと比べて、Secrets Manager に預ける利点は？</summary>

IAM で読める人・ロールを絞れる、誰がいつ読んだかが CloudTrail に残る、サーバーを作り直しても自分で取りに行ける、人がパスワードを見たり貼ったりしなくてよい、値を変えるとバージョンが残る、など。
</details>

<details>
<summary>Q9. EC2 のロールに付ける secretsmanager:GetSecretValue の Resource を "*" にしてはいけないのはなぜ？ 管理用のシークレットを読む権限を、作業後に外すのはなぜ？</summary>

`"*"` にすると、アカウントのすべてのシークレットを EC2 から読めてしまい、EC2 が乗っ取られたときの被害が広がる。管理用（マスターユーザー）のシークレットは普段のアプリには不要なので、必要なときだけ付けて外す（最小権限）。
</details>

<details>
<summary>Q10. RDS for PostgreSQL 17 に、sslmode=disable でつなぐとどうなる？ sslmode=require と verify-full の違いは？</summary>

`rds.force_ssl` が既定で有効なので、暗号化なしの接続は拒否される。`require` は暗号化を必ず使うが、相手が本物の RDS かは確かめない。`verify-full` は RDS の CA 証明書で相手の証明書とホスト名も確かめるので、なりすましも防げる。
</details>

<details>
<summary>Q11. データを引っ越す前に、api と worker を止めるのはなぜ？</summary>

止めずに書き出すと、書き出したあとに worker が記録した監視結果が、引っ越し先に入らないから。引っ越しの間はサービスが止まる（ダウンタイム）。
</details>

<details>
<summary>Q12. postgresql を systemctl disable したのに、statuspage-api を再起動すると postgresql も起動してしまうのはなぜ？ 確実に起動しないようにするには？</summary>

`statuspage-api.service` に `Wants=postgresql.service` があり、api を起動するときに postgresql も引き連れて起動するから。`disable` は「サーバーの起動時に自動で起動しない」だけで、引き連れられるのは止められない。確実に止めるには `systemctl mask` する。
</details>

<details>
<summary>Q13. RDS を停止したまま、1週間以上置いておくとどうなる？ 長く使わないときはどうする？</summary>

停止は最長7日で、7日たつと自動で起動し、また料金がかかり始める。長く使わないときは、最終スナップショットを作成して削除し、次に使うときにスナップショットから作り直す。
</details>

<details>
<summary>Q14. Phase 3 の構成で EC2 インスタンスを終了すると、監視の記録はどうなる？</summary>

記録は RDS にあり、EC2 とは別に存在するので残る。新しい EC2 を作って、同じ `DATABASE_URL`（RDS のエンドポイント）でアプリを動かせば、続きから使える。
</details>

<details>
<summary>Q15. RDS を再起動している間に誰もアクセスしなかった。戻ったあとの最初のページ表示だけが 500 になるのはなぜ？ どう防ぐ？</summary>

接続プールに残っていた接続は、RDS の再起動で切れているが、アプリはその接続を使おうとするまで切れたことに気づかない。最初のリクエストで切れた接続を使って失敗し、そこで SQLAlchemy がプールを空にするので、2回目からは新しい接続で成功する。再起動中に誰かがアクセスしていれば、その時点でプールが空になるので、戻った後の最初の1回も成功する。create_engine に pool_pre_ping=True を付けると、接続を取り出すたびに軽い確認をして、切れていればつなぎ直すので防げる。
</details>

---

## 参考

- [What is Amazon RDS?](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Welcome.html)
- [Working with a DB instance in a VPC（DB サブネットグループ）](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html)
- [Password management with Amazon RDS and AWS Secrets Manager](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html)
- [Understanding the rds_superuser role](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html)
- [Using SSL with a PostgreSQL DB instance（rds.force_ssl）](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)
- [Stopping an Amazon RDS DB instance temporarily](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [Amazon RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/)
- [PostgreSQL: CREATE ROLE（SET ROLE の権限）](https://www.postgresql.org/docs/17/sql-createrole.html)
- [systemd.unit（Wants・After）](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)
