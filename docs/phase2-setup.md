# Phase 2 手順書: EC2 に手で載せる

> 自分で作った VPC の中に EC2 を1台立て、Phase 1 のアプリ（api・worker・PostgreSQL）を **Docker を使わずに** 動かす。
> Docker が代わりにやってくれていたこと（ネットワーク、常駐、再起動、停止の合図）を、AWS と Linux の機能で自分の手で組み立てる。
> 仕組みの解説は [phase2-study.md](phase2-study.md)、この Phase で使わなかった方法は [phase2-appendix.md](phase2-appendix.md)。

## ゴール

- VPC・サブネット・インターネットゲートウェイ・ルートテーブルを自分で作り、パブリックサブネットの条件を説明できる
- セキュリティグループで「誰から、どのポートへの通信を許すか」を設定できる
- IAM ロールを付けた EC2 に、SSH を使わず Session Manager で入れる
- systemd と nginx でアプリを常駐させ、ブラウザから見られる
- 「つながらない」ときに、どこが原因かを切り分けられる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| AMI（OS） | Amazon Linux 2023（64 ビット Arm） |
| インスタンスタイプ | `t4g.small`（Arm、vCPU 2、メモリ 2GB）。無料プランの対象 |
| ディスク | EBS gp3 8GB |
| サーバーへの入り方 | Session Manager（SSH は使わない） |
| 設定ファイル | リポジトリの `deploy/ec2/` |

### 作るもの

| リソース | 名前 | 主な設定 |
|---|---|---|
| VPC | `statuspage-vpc` | `10.0.0.0/16` |
| サブネット | `statuspage-public-a` | `10.0.1.0/24`、`ap-southeast-2a` |
| インターネットゲートウェイ | `statuspage-igw` | VPC に取り付ける |
| ルートテーブル | `statuspage-public-rt` | `0.0.0.0/0` → インターネットゲートウェイ |
| IAM ロール | `statuspage-ec2-role` | `AmazonSSMManagedInstanceCore` |
| セキュリティグループ | `statuspage-web-sg` | 受信：HTTP 80 を自分の IP アドレスからだけ |
| EC2 インスタンス | `statuspage-ec2` | `t4g.small`、パブリック IP を自動で割り当て |

### 全体像

```
Internet
   │
statuspage-igw
   │
statuspage-vpc 10.0.0.0/16
└─ statuspage-public-a 10.0.1.0/24 (ap-southeast-2a)
    └─ statuspage-ec2 (t4g.small)       ← statuspage-web-sg: HTTP 80 from my IP only
        ├─ nginx       :80              ← 外からの入口
        ├─ api         127.0.0.1:8000
        ├─ worker
        └─ PostgreSQL  127.0.0.1:5432
```

### 費用（目安）

| リソース | 単価 | かかる期間 |
|---|---|---|
| EC2 `t4g.small` | 約 $0.021 / 時間 | 起動している間 |
| パブリック IPv4 アドレス | $0.005 / 時間 | 起動している間 |
| EBS gp3 8GB | 約 $0.77 / 月 | **削除するまで（停止中もかかる）** |
| VPC・サブネット・IGW・ルートテーブル・セキュリティグループ・IAM・Session Manager | 無料 | — |

無料プランでは、これらはクレジットから引かれる。**学習を終えたら、その日のうちにインスタンスを停止する**（手順15）。

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §12 費用](phase2-study.md#12-費用)：「このPhaseでかかるもの」「停止と終了の使い分け」
> 
> 読んだら考える：停止中のインスタンスで、料金がかかり続けるものは何か

1. リポジトリを `git pull` して、`deploy/ec2/` があることを確認する
2. コンソール右上のリージョンが「アジアパシフィック (シドニー)」になっているか確認する（新方式では固定）
3. Budgets の月次コスト予算（Phase 0 で作成）が有効か確認する

- [x] 完了

## 1. ネットワークを作る

コンソールの検索バーで「VPC」を開く。

### 1-1. VPC

> 📖 **先に読む**
> - [study §3 VPC とサブネット](phase2-study.md#3-vpc-とサブネット)：「VPC」「CIDR 表記」
> 
> 読んだら考える：`10.0.0.0/16` と `10.0.1.0/24` は、それぞれいくつのアドレスを表すか

1. 「VPC を作成」→ **「VPC のみ」** を選ぶ（「VPC など」は全部自動で作ってしまうので、今回は使わない）
2. 名前 `statuspage-vpc`、IPv4 CIDR `10.0.0.0/16`、IPv6 なし、テナンシーはデフォルト
   - **VPC 暗号化コントロールは「なし」**（有料の機能。中身のある VPC 1つにつき時間課金で、月に約 $100 かかる）
3. 作成後、「アクション」→「VPC の設定を編集」→ **DNS ホスト名を有効化** にチェック

- `10.0.0.0/16` は、この VPC の中で使えるプライベート IP アドレスの範囲（約6万5千個）
- DNS ホスト名を有効にすると、インスタンスに名前（`ip-10-0-1-xx...`）が付く。Phase 3 の RDS などで必要になる

### 1-2. サブネット

> 📖 **先に読む**
> - [study §3 VPC とサブネット](phase2-study.md#3-vpc-とサブネット)：「サブネット」「パブリックサブネットとプライベートサブネット」「このプロジェクトの番号の割り当て」
> 
> 読んだら考える：サブネットを作るとき、なぜアベイラビリティゾーンを選ぶ必要があるのか

1. 「サブネット」→「サブネットを作成」→ VPC に `statuspage-vpc` を選ぶ
2. 名前 `statuspage-public-a`、アベイラビリティゾーン `ap-southeast-2a`、IPv4 CIDR `10.0.1.0/24`

- サブネットは VPC の中の区画。1つのサブネットは1つのアベイラビリティゾーン（AZ）に属する
- 番号の割り当て予定：`10.0.1.0/24`・`10.0.2.0/24` はパブリック用（2つ目は Phase 4）、`10.0.11.0/24`・`10.0.12.0/24` はプライベート用（Phase 3）

### 1-3. インターネットゲートウェイ

> 📖 **先に読む**
> - [study §4 ルーティングとインターネットゲートウェイ](phase2-study.md#4-ルーティングとインターネットゲートウェイ)：「インターネットゲートウェイ（IGW）」
> 
> 読んだら考える：インスタンスがインターネットとやり取りするのに必要な4つの条件のうち、この手順で満たすのはどれか

1. 「インターネットゲートウェイ」→「作成」→ 名前 `statuspage-igw`
2. 「アクション」→「VPC にアタッチ」→ `statuspage-vpc`

- VPC とインターネットの出入口。VPC 1つにつき1つ

### 1-4. ルートテーブル

> 📖 **先に読む**
> - [study §4 ルーティングとインターネットゲートウェイ](phase2-study.md#4-ルーティングとインターネットゲートウェイ)：「ルートテーブル」
> 
> 読んだら考える：このルートテーブルをサブネットに関連付けると、なぜそのサブネットが「パブリック」になるのか

1. 「ルートテーブル」→「ルートテーブルを作成」→ 名前 `statuspage-public-rt`、VPC `statuspage-vpc`
2. 「ルート」タブ →「ルートを編集」→「ルートを追加」：送信先 `0.0.0.0/0`、ターゲット「インターネットゲートウェイ」→ `statuspage-igw`
3. 「サブネットの関連付け」タブ →「サブネットの関連付けを編集」→ `statuspage-public-a` にチェック

- ルートテーブルは「宛先ごとの道案内」。`10.0.0.0/16` 宛て（VPC の中）は最初から `local` になっている
- 「`0.0.0.0/0` をインターネットゲートウェイへ向けるルートを持つサブネット」が **パブリックサブネット**

- [x] VPC（DNS ホスト名を有効化）
- [x] サブネット
- [x] インターネットゲートウェイ（VPC にアタッチ）
- [x] ルートテーブル（ルート追加、サブネットに関連付け）

## 2. IAM ロールを作る

> 📖 **先に読む**
> - [study §6 IAM ロールと EC2](phase2-study.md#6-iam-ロールと-ec2)：全体
> - [phase0-study §4 IAM](phase0-study.md#4-iam)：「2種類のポリシー」（復習）
> 
> 読んだら考える：信頼ポリシーと許可ポリシーは、それぞれ何を決めるか。今回の `Principal` は誰か

1. コンソールで「IAM」→「ロール」→「ロールを作成」
2. 信頼されたエンティティタイプ「AWS のサービス」、ユースケース「EC2」
3. 許可ポリシーで `AmazonSSMManagedInstanceCore` を検索してチェック
4. ロール名 `statuspage-ec2-role` →「ロールを作成」
5. 作成したロールの「信頼関係」タブで、信頼ポリシーの JSON を読む

- Phase 0 では AWS が作ったロール（AccountFullAccessRole）を見ただけ。今回は自分で作る
- 信頼ポリシーの `Principal` は `ec2.amazonaws.com`（EC2 がこのロールを借りられる）
- 許可ポリシーは「Session Manager で接続されるために必要な権限」だけ。S3 などには触れない（最小権限）

- [x] 完了

## 3. セキュリティグループを作る

> 📖 **先に読む**
> - [study §5 セキュリティグループ](phase2-study.md#5-セキュリティグループ)：「性質」「ルールの例」
> - [study §4 ルーティングとインターネットゲートウェイ](phase2-study.md#4-ルーティングとインターネットゲートウェイ)：「自宅のネットワークと『マイ IP』」
> 
> 読んだら考える：受信ルールを HTTP だけにしても、サーバーからパッケージをダウンロードできるのはなぜか

1. 「EC2」→「セキュリティグループ」→「セキュリティグループを作成」
2. 名前 `statuspage-web-sg`、説明 `statuspage web`、VPC `statuspage-vpc`
3. インバウンドルールを追加：タイプ「HTTP」、ソース **「マイ IP」**、説明 `home`
4. アウトバウンドルールはそのまま（すべて許可）

- 「マイ IP」を選ぶと、今使っているネットワークのグローバル IP アドレスが `xx.xx.xx.xx/32` の形で入る（`/32` は「この1つのアドレスだけ」）
- 同じ Wi-Fi なら、PC が2台でもグローバル IP アドレスは同じ。**別の場所で使うときは、その場所でルールを追加する**（説明に場所の名前を付ける。例：`lab`）
- SSH（22番）は開けない。サーバーには Session Manager で入る
- アウトバウンド（外向き）を許可しておくのは、パッケージのダウンロード、GitHub、監視対象のサイト、Session Manager との通信のため

- [x] 完了

## 4. EC2 インスタンスを起動する

> 📖 **先に読む**
> - [study §1 EC2](phase2-study.md#1-ec2)：「インスタンスを作るときに決めること」「インスタンスタイプの読み方」「Arm（Graviton）と x86」
> - [study §2 EBS](phase2-study.md#2-ebs)：表と「Phase 1 との対応」
> 
> 読んだら考える：起動画面の各項目は、Phase 1 の Docker の何に相当するか

「EC2」→「インスタンス」→「インスタンスを起動」。

| 項目 | 設定 |
|---|---|
| 名前 | `statuspage-ec2` |
| AMI | Amazon Linux 2023 AMI、アーキテクチャ **64 ビット (Arm)** |
| インスタンスタイプ | `t4g.small` |
| キーペア | **「キーペアなしで続行」**（SSH を使わないため） |
| ネットワーク設定 →「編集」 | VPC `statuspage-vpc`、サブネット `statuspage-public-a`、**パブリック IP の自動割り当て：有効化** |
| ファイアウォール | 「既存のセキュリティグループを選択する」→ `statuspage-web-sg` |
| ストレージ | 8 GiB、gp3（既定のまま） |
| 高度な詳細 → IAM インスタンスプロフィール | `statuspage-ec2-role` |

「インスタンスを起動」→ インスタンス一覧で「インスタンスの状態」が「実行中」になるまで待つ。

- AMI はサーバーの元になるイメージ（Phase 1 の Docker イメージに相当）
- `t4g` の `g` は AWS が設計した Arm の CPU（Graviton）。同じ性能の x86 より安い
- パブリック IP を割り当てないと、パブリックサブネットにいてもインターネットとやり取りできない
- ストレージの「終了時に削除」は既定で「はい」。インスタンスを削除するとディスクも消える

- [x] 完了

## 5. Session Manager でサーバーに入る

> 📖 **先に読む**
> - [study §7 Session Manager](phase2-study.md#7-session-manager)：全体
> - [study §6 IAM ロールと EC2](phase2-study.md#6-iam-ロールと-ec2)：「仕組み」（IMDS）
> 
> 読んだら考える：22番を開けていないのに入れるのはなぜか。何が欠けると入れなくなるか

1. インスタンスを選択 →「接続」→「Session Manager」タブ →「接続」
2. ブラウザの中に黒い画面（シェル）が開く

```bash
whoami                  # ssm-user
cat /etc/os-release     # Amazon Linux 2023
uname -m                # aarch64（Arm）
```

- 「接続」ボタンが押せないときは、数分待ってから再読み込みする（サーバーの中のエージェントが AWS に登録されるまで時間がかかる）。それでもだめなら、IAM ロールが付いているか（手順4）、ルートテーブル（手順1-4）を確認する
- 入ったユーザーは `ssm-user`。管理者の操作は `sudo` を付ける
- 22番を開けていないのに入れるのは、サーバー側から AWS に向けて通信しているから

- [x] 完了

## 6. サーバーの準備

> 📖 **先に読む**
> - [study §8 Linux サーバーの基本](phase2-study.md#8-linux-サーバーの基本ユーザー権限パッケージ)：「ユーザー」「よく使う場所」「パッケージ管理」
> 
> 読んだら考える：アプリを `root` ではなく `statuspage` ユーザーで動かすのはなぜか

以降のコマンドはすべて Session Manager の画面で実行する。

### 6-1. パッケージを入れる

```bash
sudo dnf install -y git nginx
dnf list available 'postgresql*-server'     # 入れられる PostgreSQL のバージョンを確認
sudo dnf install -y postgresql17-server     # 手元の Compose（postgres:17）と同じ 17 を選ぶ
ls /usr/bin/postgresql-setup                # 手順7で使う初期化コマンドがあるか
systemctl list-unit-files 'postgresql*'     # サービス名が postgresql.service か
```

- `dnf` は Amazon Linux のパッケージ管理（Mac の Homebrew、Windows の winget に相当）
- 手元（Compose）・EC2・RDS（Phase 3）でバージョンをそろえておくと、違いを気にしなくてよい。一覧に 17 がなければ、一番近いものを選ぶ（このアプリの使い方なら違いは問題にならない）
- 入れた直後のサービスは `disabled`（サーバー起動時に自動で起動しない）。手順7で有効にする

### 6-2. アプリ用のユーザーと uv を用意する

```bash
sudo useradd --system --create-home --home-dir /var/lib/statuspage --shell /sbin/nologin statuspage
curl -LsSf https://astral.sh/uv/0.11.21/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
/usr/local/bin/uv --version
```

- `statuspage` はアプリを動かす専用のユーザー。ログインはできない（`/sbin/nologin`）。Phase 1 の Dockerfile の `appuser` に相当
- uv は Dockerfile と同じバージョンを、全ユーザーが使える `/usr/local/bin` に入れる
- `sudo` で動かすコマンドからは `/usr/local/bin` が見えないことがあるので、以降は `/usr/local/bin/uv` と書く

- [x] 完了

## 7. PostgreSQL を準備する

> 📖 **先に読む**
> - [study §8 Linux サーバーの基本](phase2-study.md#8-linux-サーバーの基本ユーザー権限パッケージ)：「PostgreSQL の認証（pg_hba.conf）」
> 
> 読んだら考える：`sudo -u postgres psql` はパスワードなしで入れるのに、アプリはパスワードが必要なのはなぜか

### 7-1. 初期化して、パスワード認証に切り替える

```bash
sudo postgresql-setup --initdb
sudo sed -i -E 's#^(host\s+all\s+all\s+(127\.0\.0\.1/32|::1/128)\s+)ident#\1scram-sha-256#' /var/lib/pgsql/data/pg_hba.conf
sudo grep -E '^host' /var/lib/pgsql/data/pg_hba.conf
sudo systemctl enable --now postgresql
```

- `pg_hba.conf` は「どこから来た接続を、どの方法で認証するか」の設定
- 最初は `127.0.0.1`（自分自身）からの接続が `ident`（OS のユーザー名で判断する方式）になっている。アプリはパスワードで接続するので、`scram-sha-256`（パスワード認証）に書き換える
- `grep` の結果で、`127.0.0.1/32` と `::1/128` の行の最後が `scram-sha-256` になっていれば OK
- `enable --now` は「今すぐ起動」＋「サーバーの起動時にも自動で起動」

### 7-2. アプリ用の DB とユーザーを作る

```bash
cd /tmp
DB_PASSWORD=$(openssl rand -hex 16)
sudo -u postgres psql -c "CREATE USER statuspage WITH PASSWORD '$DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE statuspage OWNER statuspage;"
```

- パスワードはランダムに作り、変数 `DB_PASSWORD` に入れておく（手順8-3で使うので、**同じ画面のまま続ける**）
- Session Manager の画面を閉じてしまったら、`sudo -u postgres psql -c "ALTER USER statuspage WITH PASSWORD '...';"` で作り直す
- PostgreSQL の「ユーザー」と「ロール」は同じもの（`CREATE USER` は「ログインできるロールを作る」の省略形）。IAM ロールとは別物

確かめる：

```bash
sudo -u postgres psql -c "\du"
PGPASSWORD="$DB_PASSWORD" psql -h 127.0.0.1 -U statuspage -d statuspage -c "SELECT current_user;"
psql -h 127.0.0.1 -U statuspage -d statuspage -c "SELECT current_user;"
```

- 1行目：`postgres` と `statuspage` の属性（Attributes）を比べる
- 2行目：アプリと同じ方法（TCP + パスワード）で接続する
- 3行目：パスワードなしで接続するとどうなるか（パスワードを聞かれたら、何も入れずに Enter）

- [x] 完了

## 8. アプリを配置する

> 📖 **先に読む**
> - [study §8 Linux サーバーの基本](phase2-study.md#8-linux-サーバーの基本ユーザー権限パッケージ)：「ファイルの権限」「よく使う場所」
> 
> 読んだら考える：`/etc/statuspage.env` の権限を `600` にしても、アプリが環境変数を受け取れるのはなぜか

### 8-1. コードを取得する

```bash
sudo git clone https://github.com/menbou404/StudyAWS.git /opt/statuspage
sudo chown -R statuspage:statuspage /opt/statuspage
```

### 8-2. ライブラリを入れる

```bash
cd /opt/statuspage/app
sudo -u statuspage -H /usr/local/bin/uv sync --locked --no-dev
```

- Dockerfile の `RUN uv sync --locked --no-dev` と同じ。Python 3.13 も uv が自動で用意する
- `statuspage` ユーザーとして実行するので、`.venv` もこのユーザーのものになる

### 8-3. 環境変数のファイルを作る

```bash
sudo install -m 600 -o root -g root /opt/statuspage/deploy/ec2/statuspage.env.example /etc/statuspage.env
sudo sed -i "/^DATABASE_URL=/s/CHANGE_ME/$DB_PASSWORD/" /etc/statuspage.env
sudo grep '^DATABASE_URL=' /etc/statuspage.env | sed -E 's#(://[^:]+:)[^@]+@#\1****@#'   # パスワードを伏せて確認する
ls -l /etc/statuspage.env
cat /etc/statuspage.env                                            # 一般ユーザー（ssm-user）では読めないことを確認する
```

- `install -m 600 -o root` は「コピーして、所有者を root、権限を root だけが読み書きできる状態にする」
- `sed` の先頭の `/^DATABASE_URL=/` は「`DATABASE_URL=` で始まる行だけ」という意味。見本ファイルのコメントにも `CHANGE_ME` があるので、付けないとコメントの中までパスワードに置き換わる
- 確認の行で、パスワードの部分が `****` になっていれば OK。**`sudo cat` などでファイル全体を表示しない**（パスワードが画面に出る）
- パスワードを画面に出したり、どこかに貼ったりしてしまったら、`DB_PASSWORD=$(openssl rand -hex 16)` → `sudo -u postgres psql -c "ALTER USER statuspage WITH PASSWORD '$DB_PASSWORD';"` で作り直し、このファイルも作り直す
- パスワードが入ったこのファイルは、サーバーの中にだけ置く（リポジトリには入れない）

- [x] 完了

## 9. systemd でサービスにする

> 📖 **先に読む**
> - [study §9 systemd](phase2-study.md#9-systemd)：「Phase 1 との対応」「よく使うコマンド」「起動の順番と依存」
> 
> 読んだら考える：`deploy/ec2/*.service` の各行は、`compose.yaml` のどの行に相当するか

`deploy/ec2/statuspage-api.service` と `statuspage-worker.service` を読む（各行の意味と、Phase 1 の `compose.yaml` との対応がコメントにある）。そのうえで：

```bash
sudo cp /opt/statuspage/deploy/ec2/statuspage-api.service /opt/statuspage/deploy/ec2/statuspage-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now statuspage-api statuspage-worker
systemctl status statuspage-api statuspage-worker --no-pager
curl -s localhost:8000/healthz
```

ログを見る（Ctrl+C で抜ける）：

```bash
sudo journalctl -u statuspage-worker -f
```

- `daemon-reload`：systemd に「設定ファイルを読み直して」と伝える
- `status` の `Active: active (running)` が動いている状態
- `journalctl` は systemd が集めたログを見るコマンド（Phase 1 の `docker compose logs` に相当）。サービスのログはシステムのログなので、`ssm-user` では `sudo` が必要（付けないと `You are currently not seeing messages from other users and the system` と出て何も表示されない）

- [x] 完了

## 10. nginx を設定して、ブラウザで確認する

> 📖 **先に読む**
> - [study §10 nginx とリバースプロキシ](phase2-study.md#10-nginx-とリバースプロキシ)：「なぜアプリの前に置くのか」「転送するときのヘッダー」
> - [study §8 Linux サーバーの基本](phase2-study.md#8-linux-サーバーの基本ユーザー権限パッケージ)：「1024番未満のポート」
> 
> 読んだら考える：api を `127.0.0.1:8000` で待ち受けさせるのはなぜか

```bash
sudo cp /opt/statuspage/deploy/ec2/statuspage.nginx.conf /etc/nginx/conf.d/statuspage.conf
sudo nginx -t
sudo systemctl enable --now nginx
curl -s localhost/healthz
```

- `nginx -t` は設定の文法チェック。`syntax is ok` と `test is successful` が出れば OK（`conflicting server name "_"` という warn は出てもよい。`nginx.conf` に最初からある設定とぶつかっているが、先に読み込まれる `statuspage.conf` が使われる）
- `curl -s localhost/healthz` で `{"status":"ok"}` が返れば、nginx → api の転送ができている
  - nginx の HTML のページ（404 やウェルカムページ）が返ってきたら、`nginx.conf` に最初からある設定が応答している。`sudo nginx -T 2>/dev/null | grep -nE 'listen|server_name|include .*conf.d'` で、どの設定がどのアドレスで待ち受けているかを調べる
  - `curl -s 127.0.0.1/healthz`（IPv4）と `curl -s "http://[::1]/healthz"`（IPv6）を比べると、どちらで行き先が違うか分かる
- `systemctl reload` は、今の通信を切らずに設定だけ読み直す（`restart` は止めて起動し直す）

ブラウザで確認する：

1. コンソールでインスタンスの「パブリック IPv4 アドレス」をコピーする
2. `http://<パブリック IP>/docs` を開き、Phase 1 と同じように監視対象を2つ追加する（**`https://` ではなく `http://`**）
3. 1分ほど待って `http://<パブリック IP>/` を開き、UP / DOWN を確認する

- [x] 完了

## 11. 実験A：停止と起動で、何が変わって何が残るか

> 📖 **実験のあとに読む**
> - [study §1 EC2](phase2-study.md#1-ec2)：「インスタンスの状態と課金」
> - [study §2 EBS](phase2-study.md#2-ebs)：「性質」

予想してから実行する。

1. コンソールで「インスタンスの状態」→「インスタンスを停止」→「停止済み」になるまで待つ
2. 「インスタンスを開始」→「実行中」になるまで待つ
3. パブリック IPv4 アドレスを確認し、ブラウザで開く

考えること：

- パブリック IP アドレスは、停止前と同じか
- 監視対象のデータは残っているか。それはどこに保存されていたからか
- api・worker・PostgreSQL・nginx は、自分で起動しなくても動いているか
- 停止中に課金されるもの、されないものは何か

- [ ] 完了

## 12. 実験B：プロセスの止め方と systemd の動き

> 📖 **実験のあとに読む**
> - [study §9 systemd](phase2-study.md#9-systemd)：「Restart= の種類」「止め方」

Session Manager で、worker のプロセスを3通りの方法で止める。それぞれ予想してから実行し、`systemctl status` と `journalctl` で結果を見る。

```bash
systemctl show -p MainPID statuspage-worker     # worker のプロセス番号（PID）
```

| # | 止め方 | コマンド |
|---|---|---|
| 1 | systemd に止めてもらう | `sudo systemctl stop statuspage-worker` → 確認したら `sudo systemctl start statuspage-worker` |
| 2 | 外から強制終了する | `sudo kill -9 <PID>` |
| 3 | 外から SIGTERM を送る | `sudo kill -TERM <PID>` |

確認に使うコマンド：

```bash
systemctl status statuspage-worker --no-pager
sudo journalctl -u statuspage-worker -n 20 --no-pager
```

考えること：

- 3つのうち、systemd が自動で起動し直したのはどれか。それはなぜか（ヒント：`Restart=on-failure` と、終了コード）
- Phase 1 の Compose の `restart: unless-stopped` だったら、結果は変わるか
- 終わったら、worker が動いている状態に戻しておく（`sudo systemctl start statuspage-worker`）

- [ ] 完了

## 13. 実験C：サーバーを再起動する

> 📖 **実験のあとに読む**
> - [study §9 systemd](phase2-study.md#9-systemd)：「よく使うコマンド」（`start` と `enable` の違い）
> - [study §1 EC2](phase2-study.md#1-ec2)：「インスタンスの状態と課金」の2つ目の表

予想してから実行する。

```bash
sudo reboot
```

Session Manager の画面は切れる。1〜2分待ってから接続し直す。

```bash
systemctl status postgresql nginx statuspage-api statuspage-worker --no-pager
uptime
```

考えること：

- 4つのサービスは、自分で起動しなくても動いているか。それはどの設定のおかげか
- 実験A（停止と起動）と比べて、パブリック IP アドレスは変わったか

- [ ] 完了

## 14. 実験D：つながらない原因を見分ける

> 📖 **実験のあとに読む**
> - [study §11 つながらないときの切り分け](phase2-study.md#11-つながらないときの切り分け)：全体
> - [study §10 nginx とリバースプロキシ](phase2-study.md#10-nginx-とリバースプロキシ)：「nginx が返すエラー」

3つの壊し方を1つずつ試し、ブラウザと手元の PC の `curl` で、エラーの出方を比べる。**1つ試したら元に戻してから次へ。**

手元の PC で（Windows は PowerShell で `curl.exe`）：

```bash
curl -m 10 -v http://<パブリック IP>/healthz
```

| # | 壊し方 | 元に戻し方 |
|---|---|---|
| 1 | セキュリティグループのインバウンドルール（HTTP）を削除する | 「マイ IP」で同じルールを追加し直す |
| 2 | `sudo systemctl stop nginx` | `sudo systemctl start nginx` |
| 3 | `sudo systemctl stop statuspage-api` | `sudo systemctl start statuspage-api` |

考えること：

- 3つのエラーは、それぞれどう違うか（すぐ失敗するか、待たされるか。エラーの文言、HTTP のステータスコード）
- エラーの違いから、「通信がどこまで届いたか」をどう判断できるか

- [ ] 完了

## 15. 毎回の終わりに・IP アドレスが変わったとき

> 📖 **先に読む**
> - [study §12 費用](phase2-study.md#12-費用)：「停止と終了の使い分け」
> - [study §4 ルーティングとインターネットゲートウェイ](phase2-study.md#4-ルーティングとインターネットゲートウェイ)：「自宅のネットワークと『マイ IP』」

### 学習を終えるとき

コンソールで「インスタンスの状態」→ **「インスタンスを停止」**（「終了」ではない）。

- 停止中は EC2 とパブリック IP の料金がかからない（EBS の料金はかかる）
- 次に開始すると、パブリック IP アドレスは変わる

### ページが開けなくなったとき（IP アドレスが変わった・別の場所にいる）

1. 「セキュリティグループ」→ `statuspage-web-sg` →「インバウンドルールを編集」
2. その場所のルールのソースを「マイ IP」で選び直す。新しい場所なら、ルールを追加して説明に場所の名前を付ける
3. 使わなくなった場所のルールは削除する

- Session Manager は IP アドレスの制限を受けないので、どの PC・どの場所からでも入れる

- [ ] 理解した

## 16. Phase 2 の片付け

> 📖 **先に読む**
> - [study §13 ほかの Phase とのつながり](phase2-study.md#13-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」

Phase 2 を終えて Phase 3 に進むとき。

1. EC2 インスタンスを選択 →「インスタンスの状態」→ **「インスタンスを終了（削除）」**
2. 「Elastic Block Store」→「ボリューム」に、`statuspage-ec2` のボリュームが残っていないか確認する
3. 「Elastic IP」に何もないことを確認する
4. VPC・サブネット・インターネットゲートウェイ・ルートテーブル・セキュリティグループ・IAM ロールは **残す**（無料。Phase 3 で使う）
5. 数日後、Budgets と請求の画面で、実際に使った金額を確認する（Phase 0 の手順4で保留していた確認）

- [ ] インスタンスを終了
- [ ] 残っているボリューム・Elastic IP がないことを確認
- [ ] 数日後に Budgets を確認
