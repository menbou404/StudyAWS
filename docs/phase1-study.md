# Phase 1 知識まとめ: コンテナ・Docker Compose・アプリの設計

> Phase 1 で出てきた知識を体系的にまとめたもの。手順は [phase1-setup.md](phase1-setup.md)。

## 目次

1. [コンテナとは何か](#1-コンテナとは何か)
2. [イメージ・コンテナ・レイヤー](#2-イメージコンテナレイヤー)
3. [Dockerfile](#3-dockerfile)
4. [Docker Compose](#4-docker-compose)
5. [アプリの構成と設計の考え方](#5-アプリの構成と設計の考え方)
6. [データの置き場所（ステートレスとステートフル）](#6-データの置き場所ステートレスとステートフル)
7. [DB との接続と障害への備え](#7-db-との接続と障害への備え)
8. [シグナルとプロセスの終了](#8-シグナルとプロセスの終了)
9. [AWS とのつながり](#9-aws-とのつながり)
10. [理解度チェック](#10-理解度チェック)

---

## 1. コンテナとは何か

**アプリと、それが動くのに必要なもの（ライブラリ、設定、OS のファイルの一部）をひとまとめにして、隔離して動かす仕組み。**
「自分の PC では動くのに、サーバーでは動かない」をなくすための道具。

### 仮想マシン（VM）との違い

1台の物理マシンの上に、アプリを2つ載せる場合を、下の層から比べる。

| 層 | 仮想マシン | コンテナ |
|---|---|---|
| アプリ | VM ごとに1つ | コンテナごとに1つ |
| ライブラリ | VM ごとに持つ | コンテナごとに持つ |
| **OS のカーネル** | **VM ごとに1つずつ持つ** | **ホストの1つを全員で共有する** |
| 仕切りを作る仕組み | ハイパーバイザー | コンテナランタイム（Docker など） |
| 土台 | 物理マシン | 物理マシン + ホストの OS（Linux） |

違いは「カーネルを自分で持つか、共有するか」の1点で、そこから次の性質の差が生まれる。

| | 仮想マシン | コンテナ |
|---|---|---|
| 起動時間 | 数十秒〜分（OS を起動するため） | 数秒以下（プロセスを起動するだけ） |
| サイズ | GB 単位 | MB〜数百MB |
| 隔離の強さ | 強い | VM よりは弱い（カーネルを共有するため） |
| 動かせる OS | 何でも（Linux の上で Windows も） | ホストと同じカーネルのもの |
| AWS での例 | EC2（Phase 2） | ECS / Fargate（Phase 7） |

### コンテナを作る Linux の機能

| 機能 | 役割 |
|---|---|
| namespace | 見える範囲を分ける（プロセス一覧、ネットワーク、ファイルシステム） |
| cgroup | 使える量を制限する（CPU、メモリ） |

コンテナの正体は「namespace と cgroup で仕切られた、普通の Linux のプロセス」。

### Mac / Windows で Docker が動く仕組み

Mac や Windows には Linux カーネルがないので、Docker Desktop は **裏で小さな Linux VM を動かし、その中でコンテナを動かす**。

```
Mac / Windows
└─ Docker Desktop
    └─ Linux VM            ← macOS は Apple の仮想化機能、Windows は WSL2
        ├─ api
        ├─ worker
        └─ db
```

- イメージやボリュームは、この VM のディスクの中に保存される（[§6](#6-データの置き場所ステートレスとステートフル)）
- AWS の EC2 は最初から Linux なので、この VM の層はない

---

## 2. イメージ・コンテナ・レイヤー

| 用語 | 意味 | たとえ |
|---|---|---|
| **Dockerfile** | イメージの作り方を書いたテキスト | レシピ |
| **イメージ** | コンテナの元になる、読み取り専用のファイル一式 | レシピどおりに作った冷凍食品 |
| **コンテナ** | イメージから起動した、動いている実体。1つのイメージからいくつでも作れる | 解凍して皿に盛った1食分 |
| **レジストリ** | イメージを置いておく場所 | 冷凍庫。Docker Hub、ghcr.io、**ECR**（Phase 7） |

- コンテナの中でファイルを書き換えても、イメージは変わらない
- コンテナを消すと、書き換えた分も消える

### レイヤー

イメージは、Dockerfile の命令（ファイルを変える `RUN`・`COPY` など）ごとの **差分の積み重ね** でできている。

```
COPY statuspage ./statuspage      ← 上ほど新しい
RUN uv sync --locked --no-dev
COPY pyproject.toml uv.lock ./
RUN useradd ...
python:3.13-slim                  ← 土台のイメージ
```

- 同じ土台のレイヤーは、複数のイメージで **共有** される（ディスクも転送量も節約になる）
- コンテナを起動すると、一番上に **書き込み用の薄いレイヤー** が1枚足される。コンテナを消すとこれも消える

### レイヤーキャッシュ

`docker build` は、前回と同じ命令・同じ入力のレイヤーを **作り直さずに使い回す**（`CACHED` と表示される）。

| 変えたもの | 作り直される範囲 |
|---|---|
| 何も変えていない | なし（すべて `CACHED`） |
| `statuspage/` のコード | `COPY statuspage` から下 |
| `uv.lock` | `COPY pyproject.toml uv.lock` から下（ライブラリの入れ直しを含む） |

- ある行がやり直しになると、**それより下の行はすべてやり直し**
- → **変わりにくいものを上、変わりやすいものを下** に書く
- ライブラリ一覧を先に COPY してインストールし、コードはその後に COPY する。こうすると、コードだけ変えたときに時間のかかるインストールが使い回される

---

## 3. Dockerfile

`app/Dockerfile` の各行。

| # | 命令 | 意味・理由 |
|---|---|---|
| 1 | `FROM python:3.13-slim` | 土台のイメージ。`slim` は不要なパッケージを削った軽量版（Debian ベース） |
| 2 | `COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv` | 別のイメージから uv の実行ファイルだけを持ってくる。バージョンを固定して、いつビルドしても同じ結果にする |
| 3 | `WORKDIR /app` | 以降の作業フォルダ（なければ作られる） |
| 4 | `RUN useradd --create-home appuser` | root ではない一般ユーザーを作る |
| 5 | `COPY pyproject.toml uv.lock ./` → `RUN uv sync --locked --no-dev` | ライブラリだけ先に入れる（キャッシュのため）。`--locked`：`uv.lock` と食い違っていたら失敗させる。`--no-dev`：pytest などテスト用は入れない |
| 6 | `COPY statuspage ./statuspage` | アプリのコード。一番変わりやすいので下の方に置く |
| 7 | `ENV PATH="/app/.venv/bin:$PATH"` | uv が作った仮想環境のコマンド（`uvicorn`、`python`）をそのまま呼べるようにする |
| 8 | `USER appuser` | 以降（＝コンテナの実行時）は一般ユーザーで動かす |
| 9 | `EXPOSE 8000` | 「8000番で待ち受ける」という **メモ**。これだけではポートは公開されない（公開は `docker run -p` や compose の `ports`） |
| 10 | `CMD ["uvicorn", ...]` | コンテナ起動時のコマンド。compose の `command:` で上書きできる |

### 一般ユーザーで動かす理由

- コンテナの中の root は、設定によってはホストに影響できる。アプリに脆弱性があったときの被害を小さくする（**最小権限の原則**。IAM と同じ考え方）
- そのかわり、root が作ったフォルダ（`/app` など）には書き込めない。書き込みが必要なら、書き込めるフォルダ（`/tmp`）を使うか、権限を付けたフォルダを用意する

### CMD の2つの書き方

| 書き方 | 例 | PID 1 になるもの |
|---|---|---|
| **exec 形式**（推奨） | `CMD ["uvicorn", "statuspage.api:app"]` | uvicorn そのもの |
| shell 形式 | `CMD uvicorn statuspage.api:app` | `/bin/sh`（その子として uvicorn が動く） |

shell 形式だと、シグナルを受け取るのがシェルになり、アプリに届かないことがある（[§8](#8-シグナルとプロセスの終了)）。

### .dockerignore

イメージに入れないファイルの一覧。このプロジェクトでは `.venv`、`__pycache__`、`*.db`、`tests` を除外している。

| 除外するもの | 理由 |
|---|---|
| `.venv` | 手元（Mac / Windows）用のライブラリが、Linux のイメージに紛れ込まないように |
| `*.db` | 手元のテスト用データが、本番のイメージに入らないように |
| `tests` | 実行には不要 |

あわせて、ビルドのたびに Docker に送るファイル（ビルドコンテキスト）が小さくなる。

---

## 4. Docker Compose

**複数のコンテナを、1つの YAML ファイルでまとめて定義・起動する道具。**
`docker run` を長いオプション付きで何回も打つ代わりに、`docker compose up` 一発で済む。

### compose.yaml の要素

| キー | 意味 | このプロジェクトでは |
|---|---|---|
| `services` | 動かすコンテナの一覧 | `db`、`api`、`worker` |
| `image` | 既存のイメージを使う | db は公式の `postgres:17` |
| `build` | Dockerfile からビルドする | api と worker は `./app` |
| `command` | イメージの `CMD` を上書きする | worker は `python -m statuspage.worker` |
| `environment` | 環境変数 | `DATABASE_URL`、PostgreSQL の初期設定 |
| `ports` | `ホスト:コンテナ` でポートを公開する | api だけ `8000:8000` |
| `volumes` | ボリュームをマウントする | db の `/var/lib/postgresql/data` |
| `healthcheck` | コンテナが使える状態かを定期的に確かめる | db は `pg_isready` |
| `depends_on` | 起動の順番 | api と worker は、db のヘルスチェックが通ってから起動 |
| `restart` | 落ちたときに再起動するか | `unless-stopped`（自分で止めたとき以外は再起動） |

### ネットワークと名前解決

- Compose はプロジェクトごとに専用のネットワーク（`<プロジェクト名>_default`）を作り、全サービスをつなぐ
- ネットワークの中では **サービス名がそのままホスト名** になる。Docker 内蔵の DNS が、名前を「今動いているコンテナ」の IP アドレスに変換する
  - `postgresql+psycopg://...@db:5432/...` の `db` がこれ
  - コンテナが止まると、その名前も引けなくなる
- `ports` を書かないサービスは、ネットワークの **外（自分の PC）からは見えない**

```
PC ──(localhost:8000)──▶ api ────┐
                                 ├──▶ db:5432
                         worker ─┘
```

| 通信 | できるか | 理由 |
|---|---|---|
| PC → api | できる | `ports: 8000:8000` で公開している |
| PC → db | できない | `ports` がない |
| api / worker → db | できる | 同じネットワークにいて、名前 `db` で引ける |

Phase 2 以降の VPC・セキュリティグループで、これと同じ「誰から誰へ通信してよいか」を AWS 上で設計する。

### depends_on と healthcheck の限界

- `condition: service_healthy` が効くのは **起動するときだけ**
- 起動したあとに db が落ちても、api や worker は止まりも再起動もしない
- → 依存先が途中で落ちることへの備えは、アプリ側で行う（[§7](#7-db-との接続と障害への備え)）

### よく使うコマンド

| コマンド | 動き | データ（ボリューム） |
|---|---|---|
| `docker compose up --build` | ビルドして起動（ログを表示し続ける） | 残る |
| `docker compose up -d` | バックグラウンドで起動 | 残る |
| `docker compose stop` / `start` | 停止 / 再開（コンテナは残る） | 残る |
| `docker compose down` | コンテナとネットワークを **削除** | 残る |
| `docker compose down -v` | ボリュームまで削除 | ⚠️ **消える** |
| `docker compose logs -f <サービス>` | ログを追いかけて表示 | — |
| `docker compose ps -a` | 状態と終了コードを表示 | — |

---

## 5. アプリの構成と設計の考え方

### 3つに分ける

| 部品 | 役割 | 状態（データ）を持つか |
|---|---|---|
| api | 人からのリクエストに答える | 持たない |
| worker | 定期的にサイトを調べて記録する | 持たない |
| db | 監視対象と結果を保存する | **持つ** |

- api と worker は **お互いを直接呼ばず、DB を介してつながる**（疎結合）
  - 片方を止めたり、台数を変えたりしても、もう片方に影響しない
  - たとえば api だけを2台に増やす（Phase 4）、worker だけを Lambda に変える（Phase 8）ができる
- 状態を持つのは db だけ → api と worker はいつ消して作り直してもよい（[§6](#6-データの置き場所ステートレスとステートフル)）

### 同じイメージを、別のコマンドで起動する

api と worker はコードの大部分（DB の定義など）を共有するので、イメージを1つにして `command` だけ変える。
ビルドが1回で済み、「api と worker でバージョンがずれる」事故も起きない。

### 設定はすべて環境変数から読む

`config.py` は `DATABASE_URL` などを **環境変数** から読み、なければローカル用の既定値を使う。

| 環境 | `DATABASE_URL` |
|---|---|
| 手元（Docker なし） | 既定値 `sqlite:///./dev.db` |
| Docker Compose | `postgresql+psycopg://...@db:5432/...` |
| AWS（Phase 3〜） | RDS のエンドポイント |

**コードは1つのまま、環境ごとの違いは外から渡す。** これは The Twelve-Factor App という設計指針の「設定」の考え方。
パスワードのような秘密情報も同じく外から渡す（Phase 3 では Secrets Manager を使う。[appendix E](phase1-appendix.md#e-秘密情報の渡し方)）。

### 将来の引っ越しを見越した分割

| 関数 | 中身 | 引っ越し先での使い方 |
|---|---|---|
| `checker.check_url()` | 1つの URL を調べるだけ。DB にも時間にも依存しない | どこからでもそのまま呼べる |
| `worker.run_once()` | 全ターゲットを1回ずつ調べて記録する | Phase 8 で EventBridge が1分ごとに Lambda を起動し、これを1回呼ぶ |
| `worker.run_forever()` | `run_once()` を繰り返す | Phase 2〜7 のサーバー・コンテナで使う |

「1回分」と「繰り返し」を分けておくと、**繰り返しの部分だけを AWS のサービスに任せる** ことができる。

---

## 6. データの置き場所（ステートレスとステートフル）

| | ステートレス | ステートフル |
|---|---|---|
| 意味 | 消して作り直しても困らない | 消すとデータが失われる |
| このプロジェクト | api、worker | db |
| 扱い | 気軽に台数を増減・入れ替えできる | データをコンテナの **外** に置き、慎重に扱う |

### データの置き場所と寿命

| 置き場所 | コンテナを消すと | 用途 |
|---|---|---|
| コンテナの書き込み用レイヤー | **消える** | 一時ファイル |
| ボリューム | 残る（`down -v` で消える） | DB のデータなど、残したいもの |
| バインドマウント（PC のフォルダ） | 残る | 開発中のコード（[appendix C](phase1-appendix.md#c-バインドマウントと-compose-watch)） |

### ボリュームの実体

Docker が管理する、コンテナとは別の保存場所。

```
Mac:     ~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw
Windows: WSL2 の仮想ディスク（.vhdx）
  └─ Linux VM のディスク
      └─ /var/lib/docker/volumes/<プロジェクト名>_<ボリューム名>/_data
```

- `docker volume inspect` の `Mountpoint` は **VM の中のパス** なので、Finder やエクスプローラーからは直接見えない
- `Docker.raw` は、使った分だけ容量を消費するファイル（スパースファイル）。見かけのサイズは実際の使用量よりずっと大きく表示される。他のイメージやボリュームもすべてここに入る
- ボリューム名の先頭には Compose のプロジェクト名（既定はフォルダ名）が付く。他のプロジェクトと名前がぶつからないようにするため

### 環境を移ってもデータは付いていかない

| | 手元 → AWS に持っていくか |
|---|---|
| イメージ（コード） | 持っていく |
| ボリューム（データ） | **持っていかない**。AWS 側の DB は空から始まる |

- 開発用と本番用でデータが分かれる（**環境の分離**）。手元のテストデータが本番に混ざらず、本番のデータを手元で壊すこともない
- データをわざと持っていきたいときは `pg_dump` → `pg_restore`（データ移行）
- `init_db()` は「テーブルがなければ作る」だけで、**既存のテーブルの形は変えない**。データを残したまま形を変えるには **マイグレーション** が必要（[appendix D](phase1-appendix.md#d-マイグレーションalembic)）

---

## 7. DB との接続と障害への備え

### 接続プール

DB への接続を作るのは時間がかかる（TCP 接続、認証など）。SQLAlchemy は一度作った接続を **手元に取っておいて使い回す**。これを接続プール（コネクションプール）と言う。

便利な反面、**プールの中の接続が、知らないうちに切れている** ことがある（DB の再起動、ネットワークの切断、一定時間使わなかった接続を DB 側が切る、など）。

### DB が止まって戻るまでに起きること

Compose 上で db コンテナを止めて、しばらくして再開した場合：

| 段階 | アプリから見た状況 | 起きるエラー | プールの状態 |
|---|---|---|---|
| ① DB が止まった直後 | プールの接続はすでに DB 側から切られている | `terminating connection due to administrator command` など | SQLAlchemy が切断を検知し、**プールを空にする** |
| ② DB が止まっている間 | 新しく接続しようとする | `failed to resolve host 'db'`（名前が引けない）、`connection refused` など | 空のまま |
| ③ DB が戻った後 | 新しく接続する | なし（成功） | 新しい接続が入る |

- ①で古い接続がすでに捨てられているので、DB が戻ったあとの最初の接続は必ず新品になり、成功する
- ②のエラーの種類は環境で変わる。Compose では名前ごと消えるので名前解決のエラー、RDS では名前は残るので接続拒否やタイムアウトになる

### pool_pre_ping

①が起きないまま（＝その間に一度も DB を使わないまま）DB が再起動すると、**切れた接続がプールに残り、次の1回だけ失敗する**。

```python
create_engine(DATABASE_URL, pool_pre_ping=True)
```

- 接続を使う直前に、軽い確認（ping）をして、切れていれば作り直す
- 毎回わずかに通信が増えるが、失敗が1回減る
- RDS のメンテナンスやフェイルオーバー（[§9](#9-aws-とのつながり)）で、まさにこれが起きる → Phase 3 で入れる

### 依存先が落ちたときの振る舞い

今のアプリが DB が落ちたときにどう振る舞うか：

| 部品 | 振る舞い | 問題点 |
|---|---|---|
| worker | エラーをログに出して、次の回にやり直す（コンテナは止まらない） | 最初に DB から監視対象を読むので、**サイトのチェック自体が止まる** |
| api（`/`、`/api/...`） | 500 エラー（Internal Server Error） | 利用者には何も見えなくなる |
| api（`/healthz`） | 200 のまま | 意図どおり（下の「浅いヘルスチェック」） |

依存先が落ちても、機能を落としながら動き続ける設計を **グレースフルデグラデーション**（段階的な機能低下）と言う。

| 場所 | 改善の例 |
|---|---|
| worker | 監視対象の一覧をメモリに持ち、DB が落ちていてもチェックは続ける。結果は一時的にメモリに貯め、DB が戻ったら書き込む |
| ステータスページ | 500 ではなく、前回のデータと「最終更新 ◯分前（更新できません）」を表示する |
| 表示 | 「サイトが落ちていた（DOWN）」と「記録がない（監視できなかった）」を区別する |

さらに、「**監視ツール自体が止まっていることに誰が気づくか**」も考える必要がある → Phase 9（CloudWatch のアラーム）。

### 浅いヘルスチェックと深いヘルスチェック

| | 浅い（shallow） | 深い（deep） |
|---|---|---|
| 確認するもの | そのプロセスが応答できるか | DB など依存先まで |
| DB が落ちたとき | 200（健康） | 503（不健康） |

Phase 4 で ALB（ロードバランサー）は `/healthz` を定期的に呼び、不健康なサーバーを振り分け先から外す。

- 深いヘルスチェックだと、DB が落ちた瞬間に **全サーバーが不健康** と判断される。サーバーを入れ替えても DB は直らないので、外しても意味がない
  - なお ALB は、全ターゲットが不健康になると全員に振り分ける（フェイルオープン）。それでも判定の意味はなくなる
- → **`/healthz` は浅くする**。DB の障害は別の方法（DB 自体の冗長化、アラーム）で扱う

---

## 8. シグナルとプロセスの終了

### シグナル

OS がプロセスに送る短い合図。

| シグナル | 番号 | 意味 | 無視できるか |
|---|---|---|---|
| SIGINT | 2 | 中断して（Ctrl+C） | できる |
| SIGTERM | 15 | 終了してください（お願い） | **できる** |
| SIGKILL | 9 | 強制終了 | **できない**（OS が即座に消す） |

プロセスは、シグナルごとに **ハンドラ**（受け取ったときに実行する処理）を登録できる。登録していなければ、OS の既定の動き（SIGTERM なら終了）になる。

### コンテナの止まり方

`docker compose stop` は次の順で止める。

| 順番 | Docker がすること |
|---|---|
| ① | SIGTERM を送る（後片付けして終わってね） |
| ② | 猶予期間を待つ（既定 10秒。compose では `stop_grace_period` で変更できる） |
| ③ | まだ動いていたら SIGKILL を送る（強制終了） |

### 終了コード

| 終了コード | 意味 |
|---|---|
| 0 | 正常終了 |
| 1 など | アプリが自分でエラー終了した |
| 128 + n | シグナル n で終了した |
| 137 | 128 + 9 → **SIGKILL で強制終了された** |
| 143 | 128 + 15 → SIGTERM の既定の動きで終了した |

`docker compose ps -a` で確認できる。137 が出ていたら「猶予期間内に止まれなかった」というサイン。

### PID 1 の特別ルール

- コンテナの中で最初に起動したプロセスは **PID 1** になる
- Linux は PID 1 を特別扱いし、**ハンドラを登録していないシグナルは無視する**（既定の動きをしない）
- Python は SIGINT のハンドラ（`KeyboardInterrupt` にする）は最初から持つが、**SIGTERM のハンドラは持たない**
- uvicorn は SIGTERM のハンドラを自分で登録している

| PID 1 のプロセス | SIGTERM のハンドラ | `docker compose stop` の結果 |
|---|---|---|
| uvicorn（api） | あり | すぐ止まる。終了コード 0 |
| 自作の Python（ハンドラなし） | なし → **無視される** | 猶予期間いっぱい待たされ、SIGKILL。終了コード 137 |
| 自作の Python（ハンドラあり） | あり | すぐ止まる。終了コード 0 |

`time.sleep` 中かどうかは関係ない。PID 1 でなければ、`sleep` 中でも SIGTERM の既定の動きで即座に終了する。

### 正しい止まり方（グレースフルシャットダウン）

SIGKILL は処理の途中でも容赦なく止めるので、DB への書き込み途中なら、その回の結果が失われる。
→ SIGTERM を受け取ったら **区切りのよいところまで終えてから、自分で終了する**。

worker の実装（`app/statuspage/worker.py`）：

```python
stop_event = threading.Event()

def handle_signal(signum, frame):
    stop_event.set()                       # 「止まる予定」の旗を立てるだけ

def run_forever(stop):
    while not stop.is_set():               # 旗が立っていたらループを抜ける
        run_once()                         # 実行中の1回は最後まで終える
        stop.wait(timeout=...)             # 待機中に旗が立ったら、すぐ起きる
    logger.info("worker stopped")

signal.signal(signal.SIGTERM, handle_signal)
```

- `time.sleep(60)` は途中で起こせないが、`Event.wait(timeout=60)` は旗が立った瞬間に戻る
- ハンドラの中では旗を立てるだけにして、重い処理はしない
- 別の解決策として、compose の `init: true` がある（[appendix A](phase1-appendix.md#a-init-truetini)）。速く止まるが、処理の途中でも即終了してしまう

### 同じ仕組みが出てくる場所

| Phase | 場面 | 止め方 |
|---|---|---|
| 2 | systemd でサービスを止める・再起動する | SIGTERM → 猶予（既定 90秒）→ SIGKILL |
| 4 | Auto Scaling でサーバーを減らす | サーバーを終了する前に、OS がサービスに SIGTERM を送る |
| 7 | ECS でタスクを入れ替える（デプロイ） | SIGTERM → 猶予（既定 30秒）→ SIGKILL |

止め方が正しくないと、**デプロイのたびに待たされ、処理の途中で強制終了される**。

---

## 9. AWS とのつながり

| ローカル（Phase 1） | AWS | Phase |
|---|---|---|
| Docker Desktop の Linux VM | EC2（最初から Linux） | 2 |
| `docker compose up` で常駐 | systemd でサービスとして常駐 | 2 |
| ボリューム | EBS（EC2 に付けるディスク） | 2 |
| db コンテナ + ボリューム | RDS（DB とディスクの管理を AWS に任せる） | 3 |
| Compose のネットワーク、`ports` | VPC、サブネット、セキュリティグループ | 2〜3 |
| サービス名 `db` での名前解決 | RDS のエンドポイント（DNS 名） | 3 |
| compose の `environment` | EC2 の環境変数、ECS のタスク定義、Secrets Manager | 2〜7 |
| `healthcheck` | ALB のヘルスチェック（`/healthz`） | 4 |
| `restart: unless-stopped` | systemd の `Restart=`、ECS のサービス、Auto Scaling | 2〜7 |
| Docker Hub / ghcr.io | ECR（AWS のレジストリ） | 7 |
| `docker compose stop` の SIGTERM | systemd、Auto Scaling、ECS の停止 | 2〜7 |
| `run_forever()` の繰り返し | EventBridge のスケジュール + Lambda | 8 |

### RDS マルチAZ

DB 自体の障害への備え。別の建物（アベイラビリティゾーン）に予備の DB を置き、本体が落ちたら自動で切り替える（フェイルオーバー）。
切り替えのとき接続が一度切れるので、[§7](#7-db-との接続と障害への備え) の `pool_pre_ping` やエラー時のやり直しが効いてくる。

---

## 10. 理解度チェック

答えは自分で考えてから開く。

<details>
<summary>Q1. コンテナと仮想マシンの一番大きな違いは？ Mac で Docker を動かすと裏で VM が動いているのはなぜ？</summary>

コンテナはホストの OS のカーネルを共有し、アプリとライブラリだけを隔離して動かす。仮想マシンは OS 全体（カーネルも）を持つ。コンテナは Linux カーネルの機能（namespace、cgroup）でできているので、Linux カーネルを持たない Mac や Windows では、Docker Desktop が裏で Linux VM を動かし、その中でコンテナを動かしている。
</details>

<details>
<summary>Q2. Dockerfile で、コードの COPY をライブラリのインストールより後に書くのはなぜ？</summary>

レイヤーキャッシュのため。ある行がやり直しになると、それより下はすべてやり直しになる。変わりやすいコードを下に置けば、コードだけ変えたときに時間のかかるライブラリのインストールが使い回される。
</details>

<details>
<summary>Q3. EXPOSE 8000 と書けば、PC から localhost:8000 でつながる？</summary>

つながらない。EXPOSE は「8000番で待ち受ける」というメモでしかない。実際にホストへ公開するのは `docker run -p 8000:8000` や compose の `ports`。
</details>

<details>
<summary>Q4. docker compose down と docker compose down -v の違いは？</summary>

`down` はコンテナとネットワークを削除するが、ボリュームは残すのでデータは残る。`down -v` はボリュームも削除するので、DB のデータが消える。
</details>

<details>
<summary>Q5. api の接続先が「localhost:5432」ではなく「db:5432」なのはなぜ？</summary>

コンテナの中の localhost はそのコンテナ自身を指すので、api コンテナの localhost に DB はいない。Compose のネットワークでは、サービス名がそのままホスト名になり、Docker 内蔵の DNS が db コンテナの IP アドレスに変換する。
</details>

<details>
<summary>Q6. depends_on で db のヘルスチェックを待つ設定にしているのに、起動後に db が落ちると worker がエラーを出すのはなぜ？</summary>

depends_on が効くのは起動するときだけ。起動したあとに db が落ちても、worker は止まりも再起動もしない。依存先が途中で落ちることへの備えは、アプリ側（やり直し、接続プールの扱いなど）で行う必要がある。
</details>

<details>
<summary>Q7. ステートレスとステートフルの違いは？ このプロジェクトのどれがどちら？ それぞれ AWS では何に載せる？</summary>

ステートレスは消して作り直しても困らないもの、ステートフルは消すとデータが失われるもの。api と worker がステートレスで、EC2（Phase 2）や ECS（Phase 7）に載せ、台数を気軽に増減できる。db がステートフルで、RDS（Phase 3）にデータの管理を任せる。
</details>

<details>
<summary>Q8. 手元の Compose で作った監視対象のデータは、Phase 2 で EC2 に移したら見える？</summary>

見えない。AWS に持っていくのはコード（イメージ）だけで、データ（ボリューム）は手元の PC に残る。AWS 側の DB は空から始まる。持っていきたい場合は pg_dump / pg_restore でデータ移行をする。
</details>

<details>
<summary>Q9. DB が止まって戻ったとき、戻った直後の1回目から接続に成功するのはなぜ？ 1回目が失敗するのはどんなとき？</summary>

DB が止まったあとに一度でも DB を使おうとすると、切られた古い接続で失敗し、SQLAlchemy がプールを空にする。そのため DB が戻ったあとは新品の接続が作られて成功する。一度も DB を使わないうちに DB が再起動すると、切れた接続がプールに残り、次の1回だけ失敗する。pool_pre_ping で防げる。
</details>

<details>
<summary>Q10. ALB のヘルスチェック用の /healthz で、DB まで確認しないのはなぜ？</summary>

DB まで確認すると、DB が落ちた瞬間に全サーバーが不健康と判断される。サーバーを入れ替えても DB は直らないので、外しても意味がない。/healthz はそのサーバー自身が応答できるかだけを確認し、DB の障害は DB の冗長化（RDS マルチAZ）やアラームで扱う。
</details>

<details>
<summary>Q11. SIGTERM のハンドラを持たない Python のプログラムをコンテナで動かすと、docker compose stop に時間がかかり、終了コードが 137 になるのはなぜ？</summary>

その Python がコンテナの PID 1 で、Linux は PID 1 についてハンドラのないシグナルを無視する。Python は SIGTERM のハンドラを持たないので、SIGTERM が無視され、猶予期間（既定 10秒）のあと SIGKILL で強制終了される。137 は 128 + 9（SIGKILL）。
</details>

<details>
<summary>Q12. Dockerfile の CMD を shell 形式（CMD uvicorn ...）で書くと、何が困る？</summary>

PID 1 が /bin/sh になり、uvicorn はその子プロセスになる。SIGTERM を受け取るのはシェルで、アプリに届かないことがあり、猶予期間のあと強制終了される。exec 形式（CMD ["uvicorn", ...]）で書けば、uvicorn 自身が PID 1 になり、SIGTERM を直接受け取れる。
</details>

---

## 参考

- [Docker Docs: Dockerfile reference](https://docs.docker.com/reference/dockerfile/)
- [Docker Docs: Build cache](https://docs.docker.com/build/cache/)
- [Docker Docs: Volumes](https://docs.docker.com/engine/storage/volumes/)
- [Docker Docs: Networking in Compose](https://docs.docker.com/compose/how-tos/networking/)
- [Docker Docs: docker compose stop](https://docs.docker.com/reference/cli/docker/compose/stop/)
- [Docker Docs: Control startup order（depends_on）](https://docs.docker.com/compose/how-tos/startup-order/)
- [uv: Using uv in Docker](https://docs.astral.sh/uv/guides/integration/docker/)
- [SQLAlchemy: Dealing with Disconnects（pool_pre_ping）](https://docs.sqlalchemy.org/en/20/core/pooling.html#dealing-with-disconnects)
- [The Twelve-Factor App: III. Config](https://12factor.net/config)
- [Elastic Load Balancing: Target group health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)
- [Amazon ECS: Task definition parameters（stopTimeout）](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
