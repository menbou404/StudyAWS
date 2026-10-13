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
api ─────┐
         ├──▶ db ──▶ volume (db-data)
worker ──┘
```

| サービス | 中身 | 役割 |
|---|---|---|
| api | FastAPI | Web API とステータスページ |
| worker | Python の監視ジョブ | 60秒ごとに全サイトを調べて記録する |
| db | PostgreSQL | 監視対象と結果を保存する（データはボリュームに置く） |

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

- [x] 完了

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
終わったら両方のターミナルで Ctrl+C。

- 設定を何も渡さないと、DB は `app/dev.db`（SQLite）になる（Git 管理外）
- `--reload` はコードを保存すると自動で再起動するオプション（開発用）

- [x] 完了

## 3. イメージを作って動かす（Dockerfile）

> 解説：[study §2 イメージ・コンテナ・レイヤー](phase1-study.md#2-イメージコンテナレイヤー)、[§3 Dockerfile](phase1-study.md#3-dockerfile)

`app/Dockerfile` を1行ずつ読む（各行に番号つきのコメントあり）。そのうえで：

```powershell
cd app
docker build -t statuspage .
docker run --rm -p 8000:8000 -e DATABASE_URL=sqlite:////tmp/dev.db statuspage
```

- `-t statuspage`：イメージに名前を付ける
- 最後の `.`：ビルドコンテキスト（Docker に送るフォルダ）。Dockerfile と COPY するファイルがこの中にそろっている必要がある
- `--rm`：止めたらコンテナを自動で削除する
- `-p 8000:8000`：PC の 8000番をコンテナの 8000番につなぐ
- `-e`：環境変数を渡す。一般ユーザー（appuser）で動くので、書き込める `/tmp` に SQLite を置く

実験（それぞれ、何が起きるか予想してから実行する）：

1. **キャッシュ**：何も変えずにもう一度 `docker build` する
2. **再ビルド**：`statuspage/` のコードを1行変えて `docker build` し、どの行からやり直しになるかを見る
3. **データの寿命**：監視対象を追加 → Ctrl+C でコンテナを止める → もう一度 `docker run` → 監視対象を確認する

- [x] 完了

## 4. Docker Compose で3つまとめて動かす

> 解説：[study §4 Docker Compose](phase1-study.md#4-docker-compose)

`compose.yaml` を読む（①db ②api ③worker のコメントあり）。そのうえで、リポジトリ直下で：

```powershell
docker compose up --build
```

このターミナルにはログが流れ続ける。以降の操作は **別のターミナル** で、リポジトリ直下から行う。

1. 手順2と同じように、監視対象を2つ追加する
2. 最大1分待って、http://localhost:8000/ で UP / DOWN を確認する
3. ログの `worker-1 |` の行に、監視結果が出ることを確認する

- 接続先 `@db:5432` の `db` はサービス名。Compose のネットワーク内で名前解決される
- `ports` があるのは api だけ。DB は Compose のネットワークの中からしか見えない
- api と worker は、DB のヘルスチェックが通ってから起動する（`depends_on`）

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

考えること：

- 手順3の「データの寿命」の実験と、何が違うか
- `Mountpoint` に表示されるパスは、PC のどこにあるか
- このデータは、AWS に移したときに付いていくか

- ⚠️ `docker compose down -v` はボリュームまで消す

- [x] 完了

## 6. 実験B：DB が止まったら、監視ジョブはどうなるか

> 解説：[study §7 DB との接続と障害への備え](phase1-study.md#7-db-との接続と障害への備え)

予想してから実行する。

```powershell
docker compose stop db
docker compose logs -f worker
```

1分ほどログを見る（http://localhost:8000/ と http://localhost:8000/healthz も開いてみる）→ 別のターミナルで DB を再開し、さらに1分見る。

```powershell
docker compose start db
```

エラーと要約の行だけを抜き出すと見やすい：

```powershell
docker compose logs worker | Select-String "ERROR|OperationalError|checked"   # Windows
docker compose logs worker | grep -E "ERROR|OperationalError|checked"         # macOS
```

考えること：

- DB が止まっている間、worker のコンテナは止まるか、動き続けるか
- エラーは何種類出たか。それぞれ何が原因か
- DB が戻ったあと、最初の1回目から記録できたか。それはなぜか
- `/` と `/healthz` で、返ってくる結果が違うのはなぜか

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

止まった後の終了コードを見る（0 は正常終了、128 + n はシグナル n で終了）。

```powershell
docker compose ps -a
```

### 7-1. 修正前の worker を再現する

GitHub 上の worker は、SIGTERM を受け取って正常に止まるよう修正済み。修正前の挙動を見るには、修正前のファイルを一時的に取り出してビルドし直す。

```powershell
git checkout 5be5992 -- app/statuspage/worker.py   # 修正前のファイルを取り出す
docker compose up -d --build worker
# → 上の方法で worker の停止時間と終了コードを測る
git checkout HEAD -- app/statuspage/worker.py      # 元に戻す
docker compose up -d --build worker
```

考えること：

- api と修正前の worker で、止まるまでの時間と終了コードに違いはあるか
- 違いがあるなら、その原因は何か（ヒント：`docker compose stop` は SIGTERM を送り、一定時間待っても止まらなければ SIGKILL を送る）
- 修正後の worker（`app/statuspage/worker.py` の `handle_signal` と `run_forever`）は、どうやって問題を解決しているか

- [x] 完了

## 8. 後片付け

```powershell
docker compose down        # コンテナとネットワークを消す（データは残る）
```

データも消してやり直したいときだけ：

```powershell
docker compose down -v     # ボリュームも消す
```

Phase 1 は手元だけなので課金はない。Phase 2 からは「作ったら消す」が費用に直結する。

- [x] 完了
