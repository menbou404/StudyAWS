# StudyAWS（Codex 向けの指示）

死活監視ツールを題材に、同じアプリを EC2 → ALB → コンテナ → サーバーレスと引っ越ししながら AWS を学ぶプロジェクト。全体像は [README.md](README.md)。

## 役割分担

- **Codex**：実装（アプリのコード、IaC、テスト）
- **Claude**：設計、レビュー、文書（`docs/`）、コミット
- 指示に書かれたファイルだけを変更する。範囲外の修正が必要だと思ったら、変更せずに報告する
- **コミット・push はしない**（Claude がレビューしてから行う）
- `docs/`、`README.md`、`CLAUDE.md`、`AGENTS.md` は、指示がない限り変更しない

## 構成

| 場所 | 中身 |
|---|---|
| `app/statuspage/` | FastAPI の API（`api.py`）、監視ジョブ（`worker.py`）、URL チェック（`checker.py`）、DB（`db.py`）、設定（`config.py`） |
| `app/tests/` | pytest のテスト。`conftest.py` がテストごとに SQLite を作り直す |
| `app/Dockerfile` | api と worker が共有するイメージ |
| `compose.yaml` | db（PostgreSQL）/ api / worker |

## コマンド

```bash
cd app
uv sync                 # 依存ライブラリ
uv run pytest           # テスト（変更後は必ず実行し、全件通ることを確認する）
uv add <パッケージ>      # 依存の追加（pyproject.toml と uv.lock を両方更新する）
docker compose up --build   # リポジトリ直下で、3つのコンテナを起動
```

## コードの書き方

- Python 3.13。型ヒントを付ける（`int | None` の形）
- **コメントと docstring は日本語**。既存のファイルと同じくらいの密度で、「何をするか」より「なぜそうするか」を書く（学習用のリポジトリなので、後の Phase とのつながりがあれば一言添える）
- SQLAlchemy は 2.x の書き方（`Mapped`、`mapped_column`、`select()`）
- **設定はすべて環境変数から読む**（`config.py` に集める）。ローカル用の既定値を持たせ、パスワードなどの秘密情報を既定値やコードに書かない
- 責務の分け方を崩さない
  - `checker.py` は DB にも時間にも依存しない純粋な処理
  - `worker.run_once()` は「1回分」、`run_forever()` は「繰り返し」（Phase 8 で Lambda から `run_once()` だけを呼ぶため）
  - `/healthz` は DB を確認しない（浅いヘルスチェック）
- worker は SIGTERM で今の回を終えてから正常終了する。長い待機は `time.sleep` ではなく `stop.wait(timeout=...)` を使う
- Dockerfile は exec 形式の `CMD`、一般ユーザー（`appuser`）で実行、変わりにくいものを上に書く
- uv のバージョンは `app/Dockerfile` と `deploy/ec2/user-data.sh` でそろえる（脆弱性への対応のため、新しいバージョンに追従する。上げるときは両方と `docs/phase2-setup.md` を一緒に変える）

## テストの書き方

- 本物のネットワークに出ない。`monkeypatch` で `check_url` などを差し替える
- 本物のシグナルや `sleep` を使わない。テストは速く終わるようにする
- DB を使うテストは `conftest.py` の fixture（`client` など）を使う

## IaC（Phase 5 以降）

- AWS CDK（TypeScript）で書く
- リージョンは `ap-southeast-2`。アカウントID はコードに書かず、環境から取る

## 禁止事項

- AWS のリソースを作成・変更・削除するコマンド（`aws ... create/delete`、`cdk deploy` など）を実行しない。必要なら手順として報告する
- 公開リポジトリなので、AWS アカウントID・メールアドレス・アクセスキー・パスワード・鍵・IP アドレス・リソースID を書かない（例は `xxxx` で伏せ字）
- `.env`、`*.pem`、`docs/log/` をコミット対象に含めない
