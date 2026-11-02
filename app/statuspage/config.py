"""設定はすべて環境変数から読む（ローカル・Docker・AWS で同じコードを使い回すため）。"""

import os

# Phase 6：どのコミットが動いているかを /healthz で確かめるため。
APP_VERSION = os.environ.get("APP_VERSION", "dev")

# 既定はローカル開発用の SQLite。Docker Compose / AWS では PostgreSQL の URL を渡す
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./dev.db")

# 監視ジョブの間隔・タイムアウト・記録の保存期間
CHECK_INTERVAL_SECONDS = int(os.environ.get("CHECK_INTERVAL_SECONDS", "60"))
CHECK_TIMEOUT_SECONDS = float(os.environ.get("CHECK_TIMEOUT_SECONDS", "10"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "7"))
