# 1 土台
FROM python:3.13-slim

# 2 uvの実行ファイルのコピー
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv

# 3 以降の作業場所(コンテナ内のフォルダ)
WORKDIR /app

# 4 rootではない一般ユーザを指定
RUN useradd --create-home appuser

# 5 ライブラリ一覧のコピー&インストール
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

# 6 アプリのコードのコピー
COPY statuspage ./statuspage

# 7 uv仮想環境のコマンドを使えるように環境設定
ENV PATH="/app/.venv/bin:$PATH"

# 8 ユーザ指定
USER appuser

# 9 コンテナポートのメモ
EXPOSE 8000

# 10 コンテナを起動する際に実行するコマンド
CMD ["uvicorn", "statuspage.api:app", "--host", "0.0.0.0", "--port", "8000"]