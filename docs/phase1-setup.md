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
- [ ] `docker compose up --build` で起動し、監視対象を追加して UP / DOWN を確認
- [ ] 実験A：`docker compose down` → `docker compose up -d` → データが残っているか
- [ ] 実験B：`docker compose stop db` → `docker compose logs -f worker` を1分見る → 別ターミナルで `docker compose start db` → さらに1分見る
- [ ] 実験C：`docker compose stop api` と `docker compose stop worker` で、止まるまでの時間を比べる（違いがあれば、原因を探して直す）

## 次にやること

- Step 3 の実験 → Phase 1 の知識まとめ（phase1-study.md）→ Phase 2（EC2）
