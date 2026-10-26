# Phase 4 手順書: ALB と Auto Scaling で冗長化する

> Phase 3 の「EC2 1台 + RDS」を、「ALB + 2つの AZ にまたがる複数台の EC2 + RDS」にする。EC2 は手で作らず、起動テンプレートと Auto Scaling に **自動で** 作らせる。
> アプリのコードは変えない。Phase 2 で手で行ったセットアップは、ユーザーデータ（`deploy/ec2/user-data.sh`）が起動時に自動で行う。
> 仕組みの解説は [phase4-study.md](phase4-study.md)、独自ドメインと HTTPS など、この Phase で使わなかった機能は [phase4-appendix.md](phase4-appendix.md)。

## ゴール

- ALB・リスナー・ターゲットグループ・ヘルスチェックの関係を説明できる
- 起動テンプレートとユーザーデータで、同じサーバーを何台でも自動で作れる
- Auto Scaling グループが、壊れたサーバーを自動で入れ替える（自己修復）様子を確かめられる
- 2つの AZ にまたがる構成にして、1台が止まってもサービスが続くことを確かめられる
- 「入口は ALB だけ」「DB にはアプリからだけ」を、セキュリティグループのつながりで作れる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| AZ | `ap-southeast-2a`、`ap-southeast-2b` |
| AMI（OS） | Amazon Linux 2023（64 ビット Arm） |
| インスタンスタイプ | `t4g.micro`（Arm、vCPU 2、メモリ 1GB）。DB が RDS に移ったので、Phase 2 より小さくてよい |
| DB | Phase 3 の RDS `statuspage-db`（停止していたら開始する） |
| 入口 | ALB（HTTP 80番）。独自ドメインと HTTPS は [付録 A](phase4-appendix.md#a-独自ドメインと-https) |
| サーバーへの入り方 | Session Manager |
| 設定ファイル | リポジトリの `deploy/ec2/`（`user-data.sh` が新しく加わる） |

### 作るもの

| リソース | 名前 | 主な設定 |
|---|---|---|
| サブネット | `statuspage-public-b` | `10.0.2.0/24`、`ap-southeast-2b`、`statuspage-public-rt` に関連付け |
| セキュリティグループ | `statuspage-alb-sg` | 受信：HTTP 80 を自分の IP アドレスからだけ |
| セキュリティグループ | `statuspage-worker-sg` | 受信ルールなし |
| セキュリティグループ（変更） | `statuspage-web-sg` | 受信：HTTP 80 を **`statuspage-alb-sg` からだけ** に変える |
| セキュリティグループ（変更） | `statuspage-db-sg` | 受信：PostgreSQL 5432 を `statuspage-worker-sg` からも許可する |
| IAM（変更） | `statuspage-read-db-secrets` | `rds:DescribeDBInstances` を追加 |
| ターゲットグループ | `statuspage-api-tg` | HTTP 80、ヘルスチェック `/healthz` |
| ALB | `statuspage-alb` | インターネット向け、`statuspage-public-a` と `statuspage-public-b` |
| 起動テンプレート | `statuspage-api-lt` / `statuspage-worker-lt` | `t4g.micro`、ユーザーデータ `deploy/ec2/user-data.sh`（`ROLE` だけ違う） |
| Auto Scaling グループ | `statuspage-api-asg` | 希望 2・最小 2・最大 4、`statuspage-api-tg` に登録、ELB ヘルスチェック |
| Auto Scaling グループ | `statuspage-worker-asg` | 希望 1・最小 1・最大 1、ALB には登録しない |

### 全体像

```
Internet
   │  HTTP 80 (from my IP only)
statuspage-alb                                   ← statuspage-alb-sg
   │  listener :80 → statuspage-api-tg (health check /healthz)
   ├──────────────────────────────┐
statuspage-public-a (2a)        statuspage-public-b (2b)
   └─ api EC2                     └─ api EC2       ← statuspage-api-asg (desired 2), statuspage-web-sg: 80 from alb-sg
   └─ worker EC2 (2a or 2b)                        ← statuspage-worker-asg (desired 1), statuspage-worker-sg
           │  TCP 5432 + password + TLS
statuspage-private-a (2a) / statuspage-private-b (2b)
   └─ statuspage-db (RDS)                          ← statuspage-db-sg: 5432 from web-sg and worker-sg
```

- api は ALB の後ろに2台。外からの入口は ALB だけになる
- worker は ALB の後ろに置かない（外から呼ばれないため）。2台にすると同じサイトを二重に監視してしまうので、1台に固定する（[study §8](phase4-study.md#8-複数台で動かすときの注意)）

### 費用（目安）

| リソース | 単価 | かかる期間 |
|---|---|---|
| ALB | 約 $0.025 / 時間 + LCU（このアプリの量なら 約 $0.008 / 時間） | **作ってから削除するまで（停止できない）** |
| ALB のパブリック IPv4 アドレス（AZ ごとに1つ × 2） | $0.005 / 時間 × 2 | 削除するまで |
| EC2 `t4g.micro` × 3（api 2 + worker 1） | 約 $0.011 / 時間 × 3 | 起動している間 |
| EC2 のパブリック IPv4 アドレス × 3 | $0.005 / 時間 × 3 | 起動している間 |
| EC2 の EBS 8GB × 3 | 約 $0.77 / 月 × 3 | インスタンスがある間（Auto Scaling が終了すると一緒に消える） |
| RDS（Phase 3 から） | 約 $0.025 / 時間 + ストレージ 約 $3 / 月 | |
| ターゲットグループ・起動テンプレート・Auto Scaling グループ・セキュリティグループ | 無料 | — |

全部動かすと **約 $0.12 / 時間**。1日3時間なら 約 $0.35。
学習を中断している間も、ALB だけは 約 $0.035 / 時間（1日 約 $0.85）かかる。**1日以上空けるときは ALB を削除する**（手順15）。

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 冗長化とスケーリング](phase4-study.md#1-冗長化とスケーリング)：全体
> - [study §9 費用](phase4-study.md#9-費用)：「このPhaseでかかるもの」「止め方」
>
> 読んだら考える：Phase 3 の構成で、止まるとサービス全体が止まってしまう部品（単一障害点）はどれか

1. リポジトリを `git pull` して、`deploy/ec2/user-data.sh` があることを確認する
2. RDS `statuspage-db` が停止していたら、「アクション」→「開始」→「利用可能」になるまで待つ
3. Budgets の月次コスト予算が有効か確認する
4. AWS Settings の請求画面で、クレジットの残高を確認する

- [x] 完了

## 1. 2つ目のパブリックサブネットを作る

> 📖 **先に読む**
> - [study §2 ロードバランサーと ALB](phase4-study.md#2-ロードバランサーと-alb)：「ALB 自身も複数の AZ に置かれる」
> - [phase2-study §3 VPC とサブネット](phase2-study.md#3-vpc-とサブネット)：「サブネット」（復習）
>
> 読んだら考える：ALB を作るのに、なぜ2つの AZ のパブリックサブネットが必要なのか

コンソールの検索バーで「VPC」を開く。

1. 「サブネット」→「サブネットを作成」→ VPC `statuspage-vpc`、名前 `statuspage-public-b`、アベイラビリティゾーン `ap-southeast-2b`、IPv4 CIDR `10.0.2.0/24`
2. 「ルートテーブル」→ `statuspage-public-rt` →「サブネットの関連付け」→ `statuspage-public-b` にもチェックを入れる（`statuspage-public-a` は外さない）
3. 「サブネット」→ `statuspage-public-a` を選ぶ →「アクション」→「サブネットの設定を編集」→ **「パブリック IPv4 アドレスの自動割り当てを有効化」** にチェック → 保存
4. `statuspage-public-b` にも、3と同じ設定をする

- Phase 2 ではインスタンスを起動する画面でパブリック IP を有効にしたが、Auto Scaling はその画面を使わないので、サブネットの設定で「ここに作るインスタンスには自動で付ける」と決めておく
- パブリック IP は、インスタンスがインターネットに出る（パッケージや GitHub、Session Manager、監視対象のサイト）ために使う。外からの受信は、手順2のセキュリティグループで ALB からだけにする

- [x] サブネット `statuspage-public-b`（パブリックのルートテーブルに関連付け）
- [x] 2つのパブリックサブネットで、パブリック IPv4 の自動割り当てを有効化

## 2. セキュリティグループを作る・変える

> 📖 **先に読む**
> - [study §7 セキュリティグループのつながり](phase4-study.md#7-セキュリティグループのつながり)：全体
> - [phase3-study §4 セキュリティグループの参照](phase3-study.md#4-セキュリティグループの参照)：全体（復習）
>
> 読んだら考える：api の EC2 に、自分の IP アドレスから直接 80番でつながらないようにするのはなぜか

「EC2」→「セキュリティグループ」で、次の4つを行う。

1. **作る** `statuspage-alb-sg`：説明 `statuspage alb`、VPC `statuspage-vpc`、インバウンド「HTTP」・ソース「マイ IP」・説明に場所の名前（例：`home`）
2. **作る** `statuspage-worker-sg`：説明 `statuspage worker`、VPC `statuspage-vpc`、**インバウンドルールなし**
3. **変える** `statuspage-web-sg`：インバウンドルールを編集し、「マイ IP」の HTTP ルールを **すべて削除** して、HTTP・ソース「カスタム」→ `statuspage-alb-sg`・説明 `from alb` を追加する
4. **変える** `statuspage-db-sg`：インバウンドルールを編集し、PostgreSQL・ソース `statuspage-worker-sg`・説明 `from worker` を追加する（`from web` のルールは残す）

- 別の場所から学習するときは、`statuspage-alb-sg` にその場所のルールを追加する（[phase2-setup.md](phase2-setup.md) の手順15と同じ考え方。対象が `statuspage-web-sg` から `statuspage-alb-sg` に変わる）

- [ ] `statuspage-alb-sg`
- [ ] `statuspage-worker-sg`
- [ ] `statuspage-web-sg` のソースを `statuspage-alb-sg` に変更
- [ ] `statuspage-db-sg` に `statuspage-worker-sg` からのルールを追加

## 3. EC2 のロールに、RDS の接続先を調べる権限を足す

> 📖 **先に読む**
> - [study §5 起動テンプレートとユーザーデータ](phase4-study.md#5-起動テンプレートとユーザーデータ)：「接続先とパスワードをどう渡すか」
>
> 読んだら考える：RDS のエンドポイントを、ユーザーデータやリポジトリに直接書かないのはなぜか

1. 「IAM」→「ロール」→ `statuspage-ec2-role` →「許可」タブ → `statuspage-read-db-secrets` →「編集」
2. JSON の `Statement` に、次のブロックを追加する（`<アカウントID>` は、既にある `statuspage/db-app` の行と同じ12桁）

```json
{
  "Sid": "DescribeStatuspageDb",
  "Effect": "Allow",
  "Action": "rds:DescribeDBInstances",
  "Resource": "arn:aws:rds:ap-southeast-2:<アカウントID>:db:statuspage-db"
}
```

3. 「次へ」→「変更を保存」

- `Statement` はリスト（`[ ... ]`）なので、既にある `{ ... }` の後ろに `,` を付けてから追加する
- `rds:DescribeDBInstances` は「DB の情報を見る」だけの権限。DB を変えたり消したりはできない

- [ ] 完了

## 4. ターゲットグループを作る

> 📖 **先に読む**
> - [study §2 ロードバランサーと ALB](phase4-study.md#2-ロードバランサーと-alb)：「部品」
> - [study §3 ヘルスチェック](phase4-study.md#3-ヘルスチェック)：全体
> - [study §4 登録解除の遅延](phase4-study.md#4-登録解除の遅延)：全体
>
> 読んだら考える：ヘルスチェックのパスに、`/` ではなく `/healthz` を使うのはなぜか

「EC2」→ 左のメニュー「ロードバランシング」→「ターゲットグループ」→「ターゲットグループの作成」。

| 項目 | 設定 |
|---|---|
| ターゲットタイプ | インスタンス |
| ターゲットグループ名 | `statuspage-api-tg` |
| プロトコル : ポート | HTTP : 80 |
| VPC | `statuspage-vpc` |
| プロトコルバージョン | HTTP1 |
| ヘルスチェックのパス | `/healthz` |
| ヘルスチェックの詳細設定 → 正常のしきい値 | 2 |
| 〃 → 非正常のしきい値 | 2 |
| 〃 → タイムアウト | 5 秒 |
| 〃 → 間隔 | 10 秒 |
| 〃 → 成功コード | 200 |

「次へ」→ ターゲットの登録画面では **何も選ばずに**「ターゲットグループの作成」（ターゲットは手順7で Auto Scaling が登録する）。

作成後、`statuspage-api-tg` を開き、「属性」タブ →「編集」→ **登録解除の遅延を `30` 秒** にして保存する。

- 間隔とタイムアウトを既定より短くしているのは、実験で変化をすぐ見るため
- 登録解除の遅延の既定は 300 秒。短くすると、手順11〜13の実験で待つ時間が減る

- [ ] 完了

## 5. ALB を作る

> 📖 **先に読む**
> - [study §2 ロードバランサーと ALB](phase4-study.md#2-ロードバランサーと-alb)：全体
>
> 読んだら考える：ALB には IP アドレスではなく DNS 名でアクセスするのはなぜか

**ここから ALB の課金が始まる。**

「ロードバランサー」→「ロードバランサーの作成」→「Application Load Balancer」の「作成」。

| 項目 | 設定 |
|---|---|
| ロードバランサー名 | `statuspage-alb` |
| スキーム | インターネット向け |
| ロードバランサーの IP アドレスタイプ | IPv4 |
| VPC | `statuspage-vpc` |
| マッピング | `ap-southeast-2a` → `statuspage-public-a`、`ap-southeast-2b` → `statuspage-public-b` |
| セキュリティグループ | `statuspage-alb-sg` だけ（`default` が入っていたら外す） |
| リスナー | HTTP : 80 → デフォルトアクション「ターゲットグループへ転送」→ `statuspage-api-tg` |

「ロードバランサーの作成」→ 状態が「アクティブ」になるまで待つ（数分）。

「詳細」の **DNS 名**（`statuspage-alb-xxxx.ap-southeast-2.elb.amazonaws.com`）を手元にメモする（リポジトリやチャットには貼らない）。

- 有料のオプション（AWS WAF、Global Accelerator など）が表示されても、有効にしない
- この時点ではターゲットがいないので、ブラウザで開くと **503** になる

- [ ] ALB が「アクティブ」
- [ ] DNS 名をメモした

## 6. 起動テンプレートを作る

> 📖 **先に読む**
> - [study §5 起動テンプレートとユーザーデータ](phase4-study.md#5-起動テンプレートとユーザーデータ)：全体
> - [phase2-appendix E ユーザーデータ](phase2-appendix.md#e-ユーザーデータ)：全体（復習）
>
> 読んだら考える：ユーザーデータに、パスワードを直接書かないのはなぜか

`deploy/ec2/user-data.sh` を読む。Phase 2 の手順6〜10で手で行ったことが、上から順に並んでいる（各段落のコメントに、どの手順に当たるかが書いてある）。

### 6-1. api 用

「EC2」→ 左のメニュー「インスタンス」→「起動テンプレート」→「起動テンプレートを作成」。

| 項目 | 設定 |
|---|---|
| 起動テンプレート名 | `statuspage-api-lt` |
| テンプレートバージョンの説明 | `api v1` |
| Auto Scaling のガイダンス | **チェックを入れる**（Auto Scaling で使うのに必要な項目を案内してくれる） |
| AMI | Amazon Linux 2023 AMI、アーキテクチャ **64 ビット (Arm)** |
| インスタンスタイプ | `t4g.micro` |
| キーペア | 「起動テンプレートに含めない」 |
| ネットワーク設定 → サブネット | 「起動テンプレートに含めない」（Auto Scaling グループで決める） |
| ネットワーク設定 → セキュリティグループ | `statuspage-web-sg` |
| ストレージ | 8 GiB、gp3（既定のまま） |
| 高度な詳細 → IAM インスタンスプロフィール | `statuspage-ec2-role` |
| 高度な詳細 → ユーザーデータ | `deploy/ec2/user-data.sh` の中身を **そのまま全部** 貼り付ける（`ROLE="api"` のまま） |

「起動テンプレートを作成」。

### 6-2. worker 用

1. 「起動テンプレート」の一覧で `statuspage-api-lt` を選ぶ →「アクション」→「テンプレートに基づいて作成」（または、6-1 と同じ手順で新しく作る）
2. 起動テンプレート名 `statuspage-worker-lt`、説明 `worker v1`
3. セキュリティグループを **`statuspage-worker-sg`** に変える
4. ユーザーデータの先頭近くの `ROLE="api"` を **`ROLE="worker"`** に変える
5. 「起動テンプレートを作成」

- 起動テンプレートを作っただけでは、インスタンスは起動しない（料金はかからない）
- ユーザーデータは、インスタンスの **初回起動時に1回だけ** 実行される

- [ ] `statuspage-api-lt`
- [ ] `statuspage-worker-lt`（セキュリティグループと `ROLE` を変えた）

## 7. api の Auto Scaling グループを作る

> 📖 **先に読む**
> - [study §6 Auto Scaling](phase4-study.md#6-auto-scaling)：「部品」「台数の3つの値」「ヘルスチェックの種類」
>
> 読んだら考える：ヘルスチェックの種類を「EC2」だけにすると、どんな故障を見逃すか

**ここから EC2 の課金が始まる。**

「EC2」→ 左のメニュー「Auto Scaling」→「Auto Scaling グループ」→「Auto Scaling グループを作成する」。

| 画面 | 項目 | 設定 |
|---|---|---|
| 1 | 名前 | `statuspage-api-asg` |
| 1 | 起動テンプレート | `statuspage-api-lt`、バージョン **Latest** |
| 2 | VPC | `statuspage-vpc` |
| 2 | アベイラビリティゾーンとサブネット | `statuspage-public-a` と `statuspage-public-b`（**プライベートは選ばない**） |
| 3 | ロードバランシング | 「既存のロードバランサーにアタッチ」→「ロードバランサーのターゲットグループから選択」→ `statuspage-api-tg` |
| 3 | ヘルスチェック | **「Elastic Load Balancing のヘルスチェックをオンにする」** にチェック |
| 3 | ヘルスチェックの猶予期間 | 300 秒 |
| 4 | 希望するキャパシティ / 最小 / 最大 | 2 / 2 / 4 |
| 4 | スケーリングポリシー | なし |
| 4 | インスタンスのメンテナンスポリシー | ポリシーなし（既定） |
| 5〜6 | 通知・タグ | なし |

「Auto Scaling グループを作成」。

- 作った直後から、Auto Scaling が `statuspage-api-lt` を使ってインスタンスを2台起動する。インスタンスの一覧に、名前のないインスタンスが2台現れる（2a と 2b に1台ずつ）
- ユーザーデータの実行（パッケージのインストール、`uv sync` など）に数分かかる。猶予期間の 300 秒は、その間にヘルスチェックで失敗と判断されないため

- [ ] 完了

## 8. worker の Auto Scaling グループを作る

> 📖 **先に読む**
> - [study §8 複数台で動かすときの注意](phase4-study.md#8-複数台で動かすときの注意)：全体
>
> 読んだら考える：worker を Auto Scaling グループにするのは、台数を増やすためではない。では何のためか

手順7と同じ画面で、次のように作る。

| 画面 | 項目 | 設定 |
|---|---|---|
| 1 | 名前 | `statuspage-worker-asg` |
| 1 | 起動テンプレート | `statuspage-worker-lt`、バージョン Latest |
| 2 | VPC / サブネット | `statuspage-vpc` / `statuspage-public-a` と `statuspage-public-b` |
| 3 | ロードバランシング | **「ロードバランサーなし」** |
| 3 | ヘルスチェック | EC2 だけ（ELB にはチェックを入れない） |
| 4 | 希望 / 最小 / 最大 | **1 / 1 / 1** |

- [ ] 完了

## 9. 動いていることを確かめる

> 📖 **先に読む**
> - [study §3 ヘルスチェック](phase4-study.md#3-ヘルスチェック)：「ターゲットの状態」
> - [study §5 起動テンプレートとユーザーデータ](phase4-study.md#5-起動テンプレートとユーザーデータ)：「うまくいかないときの確認」
>
> 読んだら考える：ブラウザで ALB の DNS 名を開いたとき、通信はどのセキュリティグループを順に通るか

1. 「ターゲットグループ」→ `statuspage-api-tg` →「ターゲット」タブで、2台が **Healthy** になるまで待つ（5分ほど）
2. ブラウザで `http://<ALB の DNS 名>/` を開き、Phase 3 で RDS に引っ越した監視対象が表示されることを確認する
3. インスタンスの一覧で、3台（api 2、worker 1）が「実行中」になっていることを確認する
4. worker のインスタンスに Session Manager で入り、ログを確認する

```bash
sudo tail -n 5 /var/log/cloud-init-output.log
sudo journalctl -u statuspage-worker -n 5 --no-pager
```

- `cloud-init-output.log` の最後に `statuspage user-data done: role=worker` と出ていれば、ユーザーデータが最後まで実行された
- ターゲットが Healthy にならないときは、api のインスタンスに入って `sudo tail -n 50 /var/log/cloud-init-output.log` でユーザーデータのエラーを探す

- [ ] 2台が Healthy
- [ ] ブラウザで表示された
- [ ] worker のログで監視が動いている

## 10. 実験A：ALB はどう振り分けるか

> 📖 **実験のあとに読む**
> - [study §2 ロードバランサーと ALB](phase4-study.md#2-ロードバランサーと-alb)：「振り分け方」

nginx の設定で、応答に `X-Served-By`（応答したサーバーの名前）を付けている。手元の PC から10回アクセスして、どのサーバーが応答したかを見る。予想してから実行する。

macOS：

```bash
for i in $(seq 1 10); do curl -s -D - -o /dev/null http://<ALB の DNS 名>/healthz | grep -i x-served-by; done
```

Windows（PowerShell）：

```powershell
1..10 | ForEach-Object { (Invoke-WebRequest -UseBasicParsing http://<ALB の DNS 名>/healthz).Headers['X-Served-By'] }
```

考えること：

- 何種類の名前が出たか。それはどのインスタンスか（インスタンスの一覧の「プライベート IP DNS 名」と見比べる）
- 毎回交互になるか、偏るか
- worker のインスタンスの名前は出てくるか。それはなぜか

- [ ] 完了

## 11. 実験B：api のインスタンスを1台終了する

> 📖 **実験のあとに読む**
> - [study §6 Auto Scaling](phase4-study.md#6-auto-scaling)：「自己修復」
> - [study §4 登録解除の遅延](phase4-study.md#4-登録解除の遅延)：全体

手元の PC で、1秒ごとにアクセスし続ける（Ctrl+C で止める）。

macOS：

```bash
while true; do echo "$(date +%T) $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://<ALB の DNS 名>/healthz)"; sleep 1; done
```

Windows（PowerShell）：

```powershell
while ($true) { try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://<ALB の DNS 名>/healthz; "$(Get-Date -Format T) $($r.StatusCode)" } catch { "$(Get-Date -Format T) ERR" }; Start-Sleep 1 }
```

アクセスし続けたまま、予想してから実行する。

1. インスタンスの一覧で、api のインスタンスを1台選ぶ（ターゲットグループの「ターゲット」タブでインスタンス ID を確認できる）→「インスタンスの状態」→「インスタンスを終了（削除）」
2. 手元のアクセスの結果と、ターゲットグループの「ターゲット」タブを見続ける
3. 「Auto Scaling グループ」→ `statuspage-api-asg` →「アクティビティ」タブを見る

考えること：

- 終了した瞬間、手元のアクセスはエラーになったか
- ターゲットの状態は、どう移り変わったか
- 何分後に、何が起きたか（アクティビティの記録）
- 人が何もしなくても、台数が2台に戻ったのはなぜか

- [ ] 完了

## 12. 実験C：ヘルスチェックを失敗させる

> 📖 **実験のあとに読む**
> - [study §3 ヘルスチェック](phase4-study.md#3-ヘルスチェック)：全体
> - [study §6 Auto Scaling](phase4-study.md#6-auto-scaling)：「ヘルスチェックの種類」

インスタンスは動いたまま、アプリだけを壊す。手順11のアクセスを続けたまま、予想してから実行する。

1. api のインスタンスを1台選び、Session Manager で入る
2. nginx を止める：`sudo systemctl stop nginx`
3. ターゲットグループの「ターゲット」タブ、手元のアクセスの結果、Auto Scaling グループの「アクティビティ」タブを見続ける

考えること：

- ALB はいつ、このインスタンスへの振り分けをやめたか。その間、手元のアクセスはどうだったか
- このインスタンスは最後にどうなったか。それはどの設定のおかげか
- もし手順7でヘルスチェックを「EC2」だけにしていたら、どうなっていたか

- [ ] 完了

## 13. 実験D：台数を変える

> 📖 **実験のあとに読む**
> - [study §6 Auto Scaling](phase4-study.md#6-auto-scaling)：「台数の3つの値」「減らすときに、どれを終了するか」

手順11のアクセスを続けたまま、予想してから実行する。

1. 「Auto Scaling グループ」→ `statuspage-api-asg` →「詳細」→「グループの詳細」の「編集」→ 希望するキャパシティを **3** にする
2. 3台目が Healthy になったら、手順10のコマンドで、応答するサーバーの名前を確かめる
3. 希望するキャパシティを **2** に戻す
4. 希望するキャパシティを **5** にしてみる

考えること：

- 3台目はどの AZ に作られたか
- 2に戻したとき、どのインスタンスが終了したか。終了する前に何が起きたか（手元のアクセスにエラーは出たか）
- 5にしようとすると、どうなったか

- [ ] 完了

## 14. 実験E：worker を終了する

> 📖 **実験のあとに読む**
> - [study §8 複数台で動かすときの注意](phase4-study.md#8-複数台で動かすときの注意)：全体

予想してから実行する。

1. worker のインスタンスを「インスタンスを終了（削除）」する
2. `statuspage-worker-asg` の「アクティビティ」タブを見る
3. 新しい worker が起動したら、ブラウザでステータスページを開き、最終チェックの時刻を見る

考えること：

- 監視が止まっていたのは、どのくらいの時間か。その間の記録はどうなったか
- worker の希望するキャパシティを 2 にしたら、何が困るか

- [ ] 完了

## 15. 毎回の終わりに

> 📖 **先に読む**
> - [study §9 費用](phase4-study.md#9-費用)：「止め方」
>
> 読んだら考える：Auto Scaling グループのインスタンスを「停止」しても、なぜ意味がないのか

### 学習を終えるとき

1. `statuspage-api-asg` と `statuspage-worker-asg` の **希望・最小を 0** にする（インスタンスが終了される）
2. RDS：「アクション」→「一時的に停止」
3. **1日以上空けるなら**、ALB `statuspage-alb` を削除する（ターゲットグループは残す）

### 学習を始めるとき

1. RDS を開始 →「利用可能」になるまで待つ
2. ALB を削除していたら、手順5をもう一度行う（ターゲットグループ `statuspage-api-tg` はそのまま使える。DNS 名は新しくなる）
3. `statuspage-api-asg` を 希望 2・最小 2、`statuspage-worker-asg` を 希望 1・最小 1 に戻す
4. 手順9のとおり、ターゲットが Healthy になるのを待つ

- ALB を作り直しても、Auto Scaling グループはターゲットグループに登録しているので、設定を変えなくてよい

- [ ] 理解した

## 16. Phase 4 の片付け

> 📖 **先に読む**
> - [study §11 ほかの Phase とのつながり](phase4-study.md#11-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：Phase 5 で、この Phase で手で作ったものを、なぜコードにするのか

Phase 4 を終えて Phase 5 に進むとき。

1. Auto Scaling グループ `statuspage-api-asg` と `statuspage-worker-asg` を **削除**（インスタンスも終了される）
2. ALB `statuspage-alb` を削除
3. ターゲットグループ `statuspage-api-tg` を削除
4. 「EC2」→「ボリューム」に、ボリュームが残っていないことを確認する
5. RDS：Phase 5 をすぐに始めるなら **停止**。1週間以上空くなら「最終スナップショットを作成して削除」
6. 起動テンプレート・セキュリティグループ・サブネット・IAM ロール・シークレットは **残す**（無料、またはシークレットは月額 $0.40）。Phase 5 で、コードで作り直すときに見比べる

- [ ] Auto Scaling グループを削除
- [ ] ALB とターゲットグループを削除
- [ ] 残っているボリュームがないことを確認
- [ ] RDS を停止、または最終スナップショットを作成して削除
