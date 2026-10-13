# Phase 1 付録: 使わなかったコンテナまわりの技術

> Phase 1 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase1-setup.md](phase1-setup.md) と知識まとめ [phase1-study.md](phase1-study.md) を読んだあとに。

この付録では次の5つをまとめる。

- **A. `init: true`（tini）**：PID 1 問題のもう1つの解決策
- **B. マルチステージビルド**：イメージを小さくする書き方
- **C. バインドマウントと compose watch**：コンテナで開発するときの書き方
- **D. マイグレーション（Alembic）**：データを残したままテーブルの形を変える
- **E. 秘密情報の渡し方**：`.env` ファイルと Compose の secrets

---

## A. `init: true`（tini）

### 何をするか

```yaml
  worker:
    build: ./app
    command: ["python", "-m", "statuspage.worker"]
    init: true
```

コンテナの PID 1 に **tini** という小さな init プログラムを置き、アプリをその子プロセスとして起動する。

| | PID 1 | その子 |
|---|---|---|
| init なし | python | — |
| `init: true` | tini（受け取ったシグナルを子に転送する） | python |

- tini は受け取った SIGTERM を python に転送する
- python は PID 1 ではないので、ハンドラがなくても SIGTERM の既定の動き（終了）が働き、すぐ止まる
- PID 1 のもう1つの仕事である「親を失った子プロセス（ゾンビ）の後始末」もしてくれる

### 本編で採用しなかった理由

| | `init: true` | SIGTERM ハンドラ（本編） |
|---|---|---|
| 止まる速さ | 速い | 速い |
| 止まり方 | **処理の途中でも即終了** | 今の回を終えてから終了 |
| コードの変更 | 不要 | 必要 |
| Compose 以外（systemd、Lambda） | 効かない | どこでも同じ |

アプリ自身が正しく止まれるのが本筋。`init: true` は、子プロセスをたくさん起動するアプリや、コードを変えられない場合に使う。
ECS のタスク定義にも同じ機能（`initProcessEnabled`）がある。

---

## B. マルチステージビルド

1つの Dockerfile の中で **ビルド用** と **実行用** のイメージを分け、実行に必要なものだけを最終イメージに残す書き方。

```dockerfile
# ステージ1：ビルド用（コンパイラなど、重い道具がそろっている）
FROM python:3.13 AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

# ステージ2：実行用（軽い土台に、出来上がった .venv だけ持ってくる）
FROM python:3.13-slim
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY statuspage ./statuspage
ENV PATH="/app/.venv/bin:$PATH"
CMD ["uvicorn", "statuspage.api:app", "--host", "0.0.0.0", "--port", "8000"]
```

- 最終イメージに uv やビルド用の道具が入らないので、**小さく、攻撃に使える道具も少なくなる**
- 本編の Dockerfile でも `COPY --from=ghcr.io/astral-sh/uv...` で「別のイメージからファイルだけ持ってくる」をしている。これがマルチステージの基本の動き
- このプロジェクトのライブラリはビルド済みのもの（`psycopg[binary]` など）だけなので、分けなくても大きな差は出ない。C 言語の拡張をコンパイルする場合や、TypeScript をビルドする場合（Phase 5 以降）に効く

---

## C. バインドマウントと compose watch

### ボリュームとバインドマウント

| | ボリューム（本編） | バインドマウント |
|---|---|---|
| 書き方 | `db-data:/var/lib/postgresql/data` | `./app/statuspage:/app/statuspage` |
| 実体 | Docker が管理する場所（VM の中） | **自分の PC のフォルダ** |
| 用途 | DB のデータなど、残したいもの | 開発中のコードをコンテナに見せる |

バインドマウントでコードを渡し、`uvicorn --reload` で動かすと、**PC でコードを保存した瞬間にコンテナ内のアプリが再起動する**（イメージを作り直さなくてよい）。

```yaml
  api:
    build: ./app
    command: ["uvicorn", "statuspage.api:app", "--host", "0.0.0.0", "--reload"]
    volumes:
      - ./app/statuspage:/app/statuspage
```

注意点：

- Mac / Windows では PC と VM の間でファイルを同期するので、ファイル数が多いと遅くなることがある
- 本番（AWS）ではバインドマウントは使わない。コードはイメージに入れる

### compose watch

Compose の機能で、ファイルの変更を監視して、コンテナへの同期やイメージの再ビルドを自動で行う。

```yaml
  api:
    build: ./app
    develop:
      watch:
        - action: sync           # コードはコンテナに同期するだけ
          path: ./app/statuspage
          target: /app/statuspage
        - action: rebuild        # ライブラリが変わったらイメージを作り直す
          path: ./app/uv.lock
```

```powershell
docker compose watch
```

本編では、Docker なしで `uv run uvicorn --reload` を使えば十分だったので使っていない。

---

## D. マイグレーション（Alembic）

### 問題

`init_db()`（`Base.metadata.create_all`）は「テーブルが **なければ** 作る」だけ。

- `Target` に `interval_seconds` カラムを足しても、すでにある `targets` テーブルには **追加されない**
- 手元なら `docker compose down -v` でやり直せるが、本番の RDS ではデータを消せない

### マイグレーションとは

テーブルの形の変更を **順番つきの手順書（スクリプト）** として記録し、DB に「どこまで適用したか」を覚えさせて、差分だけを適用する仕組み。
SQLAlchemy と組み合わせるなら **Alembic** が定番。

```
migrations/versions/
  0001_create_targets_and_checks.py
  0002_add_interval_seconds.py      ← 追加したカラムの分だけ
```

```powershell
uv run alembic revision --autogenerate -m "add interval_seconds"   # モデルとの差分からスクリプトを作る
uv run alembic upgrade head                                        # まだ適用していない分を適用する
```

- DB には `alembic_version` テーブルが作られ、「今どこまで適用済みか」が記録される
- デプロイの流れに「`alembic upgrade head` を1回だけ実行する」を組み込む（api を2台にしたとき、両方が同時に実行しないようにする）
- Phase 3（RDS）や Phase 6（CI/CD）で、テーブルの形を変える必要が出てきたら導入する

---

## E. 秘密情報の渡し方

本編の `compose.yaml` は、DB のパスワードを直接書いている（手元専用なので許容している）。

### `.env` ファイル

Compose は、`compose.yaml` と同じフォルダの `.env` を自動で読み、`${変数名}` を置き換える。

```dotenv
# .env（Git 管理外。.gitignore 済み）
POSTGRES_PASSWORD=手元用の長いパスワード
```

```yaml
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
```

- パスワードがリポジトリに残らない
- 代わりに「どんな変数が必要か」を `.env.example`（値は空やダミー）としてコミットしておく（`.gitignore` で `!.env.example` を許可済み）

### Compose の secrets

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password
secrets:
  db_password:
    file: ./db_password.txt
```

- 環境変数ではなく、コンテナ内のファイル（`/run/secrets/...`）として渡す
- 環境変数は `docker inspect` やログ、子プロセスから見えてしまうことがあるが、ファイルなら見える範囲を絞れる
- 公式の postgres イメージは `_FILE` で終わる変数に対応している

### AWS では

| ローカル | AWS |
|---|---|
| `.env`、Compose の secrets | **Secrets Manager**、Systems Manager **Parameter Store** |

アプリ（または ECS）が、起動時に IAM ロールの権限で秘密情報を取りに行く。パスワードをどこにも書かずに済む → Phase 3。

---

## 参考

- [Docker Docs: Compose file reference（init）](https://docs.docker.com/reference/compose-file/services/#init)
- [tini](https://github.com/krallin/tini)
- [Docker Docs: Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker Docs: Bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker Docs: Use Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)
- [Alembic Tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html)
- [Docker Docs: Secrets in Compose](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Docker Docs: Set environment variables（.env）](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
