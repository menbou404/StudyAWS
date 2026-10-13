# Phase 1 手順書: アプリを手元で動かす（FastAPI + Docker Compose）

> 死活監視ツールのコードを読み、手元で動かして、Docker の挙動を実験で確かめる。AWS はまだ使わない。
> コード（`app/`、`compose.yaml`）はリポジトリに用意済み。この手順書は **書く** のではなく **読んで・動かして・壊してみる** ためのもの。
> 仕組みの解説は [phase1-study.md](phase1-study.md)、この Phase で使わなかった技術は [phase1-appendix.md](phase1-appendix.md)。

## ゴール

- API・監視ジョブ・DB の3つに分かれたアプリを、手元で動かせる
- Dockerfile と compose.yaml の各行の意味を説明できる
- 「データはどこに残るか」「依存先が落ちたらどうなるか」「コンテナはどう止まるか」を実験で説明できる

## 環境

| 項目 | 値 |
|---|---|
| OS | Windows（PowerShell）/ macOS（zsh）。コマンドが違うところは両方書く |
| Python | 3.13（`app/.python-version`。uv が自動で用意する） |
| パッケージ管理 | uv |
| コンテナ | Docker Desktop（Docker Compose v2 を含む） |
| 使うイメージ | `python:3.13-slim`、`postgres:17`、`ghcr.io/astral-sh/uv` |
| AWS | 使わない |

## 全体像

```
┌──────────── compose.yaml ─────────────────────────┐
│  api（FastAPI）───┐                                │
│                   ├──▶ db（PostgreSQL）──▶ ボリューム │
│  worker（監視）───┘                                │
└────────────────────────────────────────────────────┘
```

- api と worker は **直接通信せず、DB を介してつながる**（疎結合）
- api と worker は **同じイメージ** を別のコマンドで起動する

---

## 0. 準備

1. uv と Docker Desktop を入れる（エディタは VS Code）
2. リポジトリを取得して、依存ライブラリを入れる

```powershell
git clone https://github.com/menbou404/StudyAWS.git
cd StudyAWS\app
uv sync          # .python-version を見て Python 3.13 も自動で用意される
uv run pytest
```

すでに clone 済みの PC では `git pull` してから始める。

- AWS CLI は Phase 2 から使う（[phase0-setup.md](phase0-setup.md) の手順5）
- 学習ログ（`docs/log/`）は Git 管理外なので、PC 間では共有されない

- [x] 完了（Windows・macOS の両方で `uv run pytest` が成功）

## 1. コードの構成を把握する

> 解説：[study §5 アプリの構成と設計の考え方](phase1-study.md#5-アプリの構成と設計の考え方)

```
StudyAWS/
├─ compose.yaml          3つのコンテナ（db / api / worker）の定義
└─ app/
   ├─ Dockerfile         api と worker が共有するイメージの作り方
   ├─ .dockerignore      イメージに入れないファイル
   ├─ pyproject.toml / uv.lock / .python-version
   ├─ statuspage/
   │   ├─ config.py      設定（すべて環境変数から読む。既定はローカル用 SQLite）
   │   ├─ db.py          DB の接続とテーブル定義（targets / checks）
   │   ├─ checker.py     1つの URL を調べる（DB に依存しない純粋な関数）
   │   ├─ worker.py      監視ジョブ（run_once = 1回分、run_forever = 繰り返し、main = 起動）
   │   ├─ api.py         Web API とステータスページ
   │   └─ templates/index.html
   └─ tests/
```

| エンドポイント | 用途 |
|---|---|
| `GET /` | ステータスページ |
| `GET /healthz` | 生存確認（Phase 4 で ALB が使う。DB は見ない） |
| `GET/POST/DELETE /api/targets` | 監視対象の一覧・追加・削除 |
| `GET /api/targets/{id}/checks` | 監視結果の履歴 |
| `GET /docs` | 自動生成される API の説明書兼お試し画面 |

各ファイルの先頭の docstring と、`config.py` → `db.py` → `checker.py` → `worker.py` → `api.py` の順に読む。

- [x] 完了

## 2. Docker なしで動かす

ターミナル1（API）：

```powershell
cd app
uv run uvicorn statuspage.api:app --reload
```

http://localhost:8000/docs →「POST /api/targets」→「Try it out」で監視対象を2つ追加する。

```json
{"name": "Example", "url": "https://example.com"}
```

```json
{"name": "Broken", "url": "https://this-does-not-exist.invalid"}
```

ターミナル2（監視ジョブ）：

```powershell
cd app
uv run python -m statuspage.worker
```

http://localhost:8000/ で Example が UP、Broken が DOWN になることを確認する（監視は60秒ごと）。
終わったら両方のターミナルで Ctrl+C。データは `app/dev.db`（SQLite）に残る（Git 管理外）。

- [x] 完了

## 3. イメージを作って動かす（Dockerfile）

> 解説：[study §2 イメージ・コンテナ・レイヤー](phase1-study.md#2-イメージコンテナレイヤー)、[§3 Dockerfile](phase1-study.md#3-dockerfile)

`app/Dockerfile` を1行ずつ読む（各行に番号つきのコメントあり）。そのうえで：

```powershell
cd app
docker build -t statuspage .
docker run --rm -p 8000:8000 -e DATABASE_URL=sqlite:////tmp/dev.db statuspage
```

実験：

1. **キャッシュ**：もう一度 `docker build` する → ほぼ全行が `CACHED` になり一瞬で終わる
2. **再ビルド**：`statuspage/` のコードを1行変えて `docker build` → `COPY statuspage` から下だけがやり直しになる
3. **データが消える**：監視対象を追加 → Ctrl+C でコンテナを止める（`--rm` なので削除される）→ もう一度 `docker run` → 監視対象が消えている

確認結果：

- ビルドコンテキスト（最後の `.`）の中に、Dockerfile と COPY するファイルがそろっている必要がある
- 一般ユーザー（appuser）で動かすので、root が作った `/app` には書き込めない → SQLite は `/tmp` を指定する
- ある行がやり直しになると、それより下の行はすべてやり直し → **変わりにくいものを上、変わりやすいものを下**
- コンテナの中に書いたデータは、コンテナを消すと消える → 状態はアプリの外に置く（ステートレス）

- [x] 完了（キャッシュ、再ビルド、データが消えること）

## 4. Docker Compose で3つまとめて動かす

> 解説：[study §4 Docker Compose](phase1-study.md#4-docker-compose)

`compose.yaml` を読む（①db ②api ③worker のコメントあり）。そのうえで、リポジトリ直下で：

```powershell
docker compose up --build
```

このターミナルにはログが流れ続ける。以降の操作は **別のターミナル** で、リポジトリ直下から行う。

1. 手順2と同じように、監視対象を2つ追加する
2. 最大1分待って、http://localhost:8000/ で UP / DOWN を確認する
3. ログの `worker-1 |` の行に `UP` / `DOWN` / `checked 2 target(s)` が出ることを確認する

確認結果：

- `@db:5432` の `db` はサービス名。Compose のネットワーク内で名前解決される（Phase 3 では RDS のエンドポイントに変わる）
- `ports` があるのは api だけ。DB は Compose のネットワークの中からしか見えない
- api と worker は `depends_on: condition: service_healthy` で、DB のヘルスチェックが通ってから起動する

- [x] 完了

## 5. 実験A：コンテナを消しても、データは残るか

> 解説：[study §6 データの置き場所](phase1-study.md#6-データの置き場所ステートレスとステートフル)

予想してから実行する。

```powershell
docker compose down      # コンテナとネットワークを「削除」する（停止ではない）
docker compose up -d     # バックグラウンドで起動し直す
```

http://localhost:8000/ を開き、監視対象が残っているか確認する。続けて、ボリュームの場所を調べる。

```powershell
docker volume ls
docker volume inspect studyaws_db-data
```

確認結果：

- **残っていた**。`down` で消えるのはコンテナとネットワークだけで、ボリューム `studyaws_db-data` は残る
- `Mountpoint` は `/var/lib/docker/volumes/studyaws_db-data/_data`。これは Docker が動く **Linux VM の中** のパスで、Finder やエクスプローラーからは見えない
  - macOS：`~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` が VM のディスクの実体（見かけ 1TB、実使用 59GB だった）
  - Windows：WSL2 の仮想ディスク（`.vhdx`）
- 名前の `studyaws_` は Compose のプロジェクト名（フォルダ名）
- ⚠️ `docker compose down -v` はボリュームまで消す

- [x] 完了

## 6. 実験B：DB が止まったら、監視ジョブはどうなるか

> 解説：[study §7 DB との接続と障害への備え](phase1-study.md#7-db-との接続と障害への備え)

予想してから実行する。

```powershell
docker compose stop db
docker compose logs -f worker
```

1分ほどログを見る（http://localhost:8000/ も開いてみる）→ 別のターミナルで DB を再開し、さらに1分見る。

```powershell
docker compose start db
```

エラーと要約の行だけを抜き出すと見やすい：

```powershell
docker compose logs worker | Select-String "ERROR|OperationalError|checked"   # Windows
docker compose logs worker | grep -E "ERROR|OperationalError|checked"         # macOS
```

確認結果（2026-10-13）：

```
04:34:02  checked 2 target(s)                                       ← 正常
04:35:02  ERROR AdminShutdown: terminating connection due to administrator command
04:36:02  ERROR failed to resolve host 'db': Name or service not known
          （ここで docker compose start db）
04:37:03  checked 2 target(s)                                       ← 1回目から成功
```

- worker のコンテナは **止まらない**。`try / except` でエラーをログに出し、次の回でやり直す
- エラーは2種類：①接続プールに残っていた接続が切られていた ②`db` という名前自体が消えていた
- DB が戻ったあと **1回目から成功** した（接続プールがすでに空になっていたため）
- api（`/`）は DB に届かず **500 エラー**（Internal Server Error）を返した。`/healthz` は DB を見ないので 200 のまま
- DB が止まっていた2分間は、サイトのチェック自体が行われていない（最初に DB から監視対象の一覧を読むため）
- 再開後の `DOWN https://this-does-not-exist.invalid/` はエラーではなく、Broken を正しく DOWN と記録したもの

- [x] 完了

## 7. 実験C：コンテナの止まり方を比べる

> 解説：[study §8 シグナルとプロセスの終了](phase1-study.md#8-シグナルとプロセスの終了)

止まるまでの時間を測る。

```powershell
Measure-Command { docker compose stop api }       # Windows
Measure-Command { docker compose stop worker }
```

```bash
time docker compose stop api       # macOS
time docker compose stop worker
```

止まった後の終了コードを見る。

```powershell
docker compose ps -a
```

### 7-1. 修正前の worker を再現する

**GitHub 上の worker はすでに修正済み**（2026-10-13）。修正前の挙動を見るには、修正前のファイルを一時的に取り出してビルドし直す。

```powershell
git checkout 5be5992 -- app/statuspage/worker.py   # 修正前のファイルを取り出す
docker compose up -d --build worker
# → 上の方法で worker の停止時間と終了コードを測る
git checkout HEAD -- app/statuspage/worker.py      # 元に戻す
docker compose up -d --build worker
```

確認結果：

| | 止まるまで | 終了コード |
|---|---|---|
| api（uvicorn） | 0.5秒 | 0 |
| worker（修正前） | 10.1秒 | 137（= 128 + 9、SIGKILL） |
| worker（修正後） | 0.3秒 | 0 |

- `docker compose stop` は SIGTERM を送り、10秒待っても止まらなければ SIGKILL で強制終了する
- 原因は `sleep` ではなく **PID 1**。PID 1 は、受け取り方（ハンドラ）を書いていないシグナルを無視する。Python は SIGTERM のハンドラを持たない。uvicorn は自前で持っている
- 修正：SIGTERM を受けたら `threading.Event` を立て、今の回を終えてから終了する。待機は `time.sleep` ではなく `stop.wait(timeout=...)` にして、合図が来たらすぐ起きる
- 修正後の worker のログ：

```
05:02:31  received SIGTERM, stopping after current run
05:02:31  worker stopped
```

- [x] 完了（修正は Codex が実装し、テスト3件を追加）

## 8. 後片付け

```powershell
docker compose down        # コンテナとネットワークを消す（データは残る）
```

データも消してやり直したいときだけ：

```powershell
docker compose down -v     # ボリュームも消す
```

Phase 1 は手元だけなので課金はない。Phase 2 からは「作ったら消す」が費用に直結する。

- [ ] 完了
