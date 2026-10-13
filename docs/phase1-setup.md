# Phase 1 手順書: アプリ作成（FastAPI + Docker Compose）

> 死活監視ツールを手元で作り、Docker Compose で動かす。AWS はまだ使わない。

## ゴール

- API・監視ジョブ・DB の3つに分かれたアプリを、手元で動かせる
- Dockerfile と compose.yaml の各行の意味を説明できる

## 全体像

```
┌──────────── compose.yaml ────────────────────────┐
│  api（FastAPI）───┐                               │
│                   ├──▶ db（PostgreSQL）──▶ ボリューム │
│  worker（監視）───┘                               │
└───────────────────────────────────────────────────┘
```

- api と worker は **直接通信せず、DB を介してつながる**（疎結合）
- api と worker は **同じイメージ** を別のコマンドで起動する

| Phase | api | worker | db |
|---|---|---|---|
| 1 | コンテナ | コンテナ | コンテナ |
| 2 | EC2 上のサービス（systemd） | EC2 上の別のサービス | EC2 上 |
| 3 | 〃 | 〃 | RDS |
| 7 | ECS のサービス | ECS の別のタスク | RDS |
| 8 | Lambda + API Gateway | Lambda + EventBridge | RDS など |

## 別の PC で始めるとき

```powershell
git clone https://github.com/menbou404/StudyAWS.git
cd StudyAWS\app
uv sync          # .python-version を見て Python 3.13 も自動で用意される
uv run pytest
```

必要なもの：uv、Docker Desktop、VS Code。AWS CLI は Phase 2 から（[phase0-setup.md](phase0-setup.md) の手順5）。
学習ログ（`docs/log/`）は Git 管理外なので、必要なら手でコピーする。

---

## Step 1: アプリを手元で動かす（Docker なし）

```
app/
├─ pyproject.toml / uv.lock / .python-version
├─ statuspage/
│   ├─ config.py    設定（すべて環境変数から読む。既定はローカル用 SQLite）
│   ├─ db.py        DB の接続とテーブル定義（targets / checks）
│   ├─ checker.py   1つの URL を調べる（DB に依存しない純粋な関数）
│   ├─ worker.py    監視ジョブ（run_once = 1回分、main = 繰り返し）
│   ├─ api.py       Web API とステータスページ
│   └─ templates/index.html
└─ tests/
```

ターミナル1（API）：

```powershell
cd app
uv run uvicorn statuspage.api:app --reload
```

http://localhost:8000/docs →「POST /api/targets」→「Try it out」で監視対象を追加する。

```json
{"name": "Example", "url": "https://example.com"}
```

ターミナル2（監視ジョブ）：

```powershell
cd app
uv run python -m statuspage.worker
```

http://localhost:8000/ で UP / DOWN を確認する。テスト：`uv run pytest`

| エンドポイント | 用途 |
|---|---|
| `GET /` | ステータスページ |
| `GET /healthz` | 生存確認（Phase 4 で ALB が使う） |
| `GET/POST/DELETE /api/targets` | 監視対象の一覧・追加・削除 |
| `GET /api/targets/{id}/checks` | 監視結果の履歴 |
| `GET /docs` | 自動生成される API の説明書兼お試し画面 |

- [x] 完了

## Step 2: Dockerfile（app/Dockerfile）

```powershell
cd app
docker build -t statuspage .
docker run --rm -p 8000:8000 -e DATABASE_URL=sqlite:////tmp/dev.db statuspage
```

- ビルドコンテキスト（最後の `.`）の中に、Dockerfile と COPY するファイルがそろっている必要がある
- 一般ユーザー（appuser）で動かすので、root が作った `/app` には書き込めない → SQLite は `/tmp` を指定する
- レイヤーキャッシュ：ある行がやり直しになると、それより下の行はすべてやり直し → **変わりにくいものを上、変わりやすいものを下**
- コンテナの中に書いたデータは、コンテナを消すと消える → 状態はアプリの外に置く（ステートレス）

- [x] 完了（実験：キャッシュ、再ビルド、データが消えること）

## Step 3: Docker Compose（compose.yaml）

```powershell
cd <リポジトリ直下>
docker compose up --build
```

- `@db:5432` の `db` はサービス名（compose のネットワーク内で名前解決される）。Phase 3 では RDS のエンドポイントに変わる
- `ports` は api だけ。DB は compose のネットワークの中からしか見えない
- `db-data` ボリュームに DB のデータを保存する（コンテナを消しても残る）
- ⚠️ `docker compose down -v` はボリュームまで消す

実験（別のターミナルで、リポジトリ直下から）：

- [x] `compose.yaml` を書いた
- [x] `docker compose up --build` で起動し、監視対象を追加して UP / DOWN を確認
- [x] 実験A：`docker compose down` → `docker compose up -d` → データが残っているか
- [x] 実験B：`docker compose stop db` → `docker compose logs -f worker` を1分見る → 別ターミナルで `docker compose start db` → さらに1分見る
- [x] 実験C：`docker compose stop api` と `docker compose stop worker` で、止まるまでの時間を比べる（違いがあれば、原因を探して直す）

### 実験A の結果：データは残る

- `down` で消えるのはコンテナとネットワークだけ。ボリューム `studyaws_db-data` は残る（`docker volume inspect studyaws_db-data` で確認できる）
- ボリュームの実体は Docker が動く Linux VM のディスクの中（macOS は `Docker.raw`、Windows は WSL2 の `.vhdx`）。Finder やエクスプローラーからは直接見えない
- AWS に移すのはイメージ（コード）だけで、ボリューム（データ）は付いていかない → 開発と本番のデータが分かれる（環境の分離）
- AWS での対応物：ボリューム ≒ EBS（Phase 2）、DB コンテナ＋ボリューム ≒ RDS（Phase 3）

### 実験B の結果：worker は止まらず、DB が戻ると自動で復帰する

```
04:35  ERROR AdminShutdown: terminating connection ...   ← プールに残っていた接続が切られていた
04:36  ERROR failed to resolve host 'db'                 ← db コンテナが止まると名前 `db` も消える
04:37  checked 2 target(s)                               ← DB 再開後、1回目から成功
```

- **接続プール**：SQLAlchemy は DB への接続を使い回す。切れた接続を検知するとプールを空にするので、DB が戻った後の最初の接続は新品になり、1回目から成功した
- DB が一瞬で再起動するとエラーが出ないまま切れた接続が残り、次の1回だけ失敗する → `create_engine(..., pool_pre_ping=True)` で防げる（RDS のメンテナンスで起きる。Phase 3 で対応）
- api は DB に届かないと 500 エラーを返す
- 設計の宿題（Phase 3〜4）：
  - worker は最初に DB から監視対象を読むので、DB が落ちるとサイトの監視自体が止まる → 一覧をメモリに持つ、古いデータを「最終更新 ◯分前」と出す、などの段階的な機能低下
  - `/healthz` は DB まで確認しない（浅いヘルスチェック）。DB まで見ると、DB 障害で ALB が全サーバーを切り離してしまう。DB 自体の冗長化は RDS マルチAZ で行う

### 実験C の結果：worker だけ 10秒かかり、強制終了されていた → 修正した

| | 止まるまで | 終了コード |
|---|---|---|
| api（uvicorn） | 0.5秒 | 0 |
| worker（修正前） | 10.1秒 | 137（= 128 + 9、SIGKILL） |
| worker（修正後） | 0.3秒 | 0 |

- `docker compose stop` は SIGTERM を送り、10秒（`stop_grace_period`）待っても止まらなければ SIGKILL で強制終了する
- 原因は `sleep` ではなく **PID 1**。コンテナで最初に起動したプロセス（PID 1）は、受け取り方（ハンドラ）を書いていないシグナルを無視する。Python は SIGINT（Ctrl+C）のハンドラは持つが SIGTERM は持たない。uvicorn は自前で持っている
- 修正（`app/statuspage/worker.py`）：SIGTERM を受けたら `threading.Event` を立て、今の回を終えてから終了する。待機は `time.sleep` ではなく `stop.wait(timeout=...)` にして、合図が来たらすぐ起きる
- 別案の `compose.yaml` の `init: true`（tini を PID 1 にする）でも速く止まるが、処理の途中でも即終了してしまう
- 同じ「SIGTERM → 猶予 → SIGKILL」は systemd（Phase 2）、Auto Scaling（Phase 4）、ECS（Phase 7）でも起きる

## 次にやること

- Phase 1 の知識まとめ（phase1-study.md）→ Phase 2（EC2）
