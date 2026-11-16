"""設定はすべて環境変数から読む（ローカル・Docker・AWS で同じコードを使い回すため）。"""

import os
from collections.abc import Mapping

from sqlalchemy.engine import URL


def build_database_url(env: Mapping[str, str]) -> str:
    """ECS ではパスワードだけを secrets で受け取り、URL の記号を安全に扱う。"""
    if "DATABASE_URL" in env:
        return env["DATABASE_URL"]
    if host := env.get("DB_HOST"):
        password = env.get("DB_PASSWORD")
        if not password:
            raise ValueError("DB_HOST を指定した場合は DB_PASSWORD が必要です")
        return URL.create(
            drivername="postgresql+psycopg",
            username=env.get("DB_USER", "statuspage"),
            password=password,
            host=host,
            port=int(env.get("DB_PORT", "5432")),
            database=env.get("DB_NAME", "statuspage"),
            query={"sslmode": env.get("DB_SSLMODE", "require")},
        ).render_as_string(hide_password=False)
    return "sqlite:///./dev.db"


# Phase 6：どのコミットが動いているかを /healthz で確かめるため。
APP_VERSION = os.environ.get("APP_VERSION", "dev")

# Compose・EC2 の URL 指定を保ち、Phase 7 の ECS では接続先の部品を渡す。
DATABASE_URL = build_database_url(os.environ)

# 監視ジョブの間隔・タイムアウト・記録の保存期間
CHECK_INTERVAL_SECONDS = int(os.environ.get("CHECK_INTERVAL_SECONDS", "60"))
CHECK_TIMEOUT_SECONDS = float(os.environ.get("CHECK_TIMEOUT_SECONDS", "10"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "7"))
