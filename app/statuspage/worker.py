"""監視ジョブ。一定間隔で全ターゲットをチェックし、結果を DB に記録する。

起動方法: python -m statuspage.worker
"""

import logging
import signal
import threading
import time
from datetime import timedelta
from types import FrameType

from sqlalchemy import delete, select

from statuspage.checker import check_url
from statuspage.config import CHECK_INTERVAL_SECONDS, CHECK_TIMEOUT_SECONDS, RETENTION_DAYS
from statuspage.db import Check, SessionLocal, Target, init_db, utcnow

logger = logging.getLogger("statuspage.worker")
stop_event = threading.Event()


def run_once() -> int:
    """全ターゲットを1回ずつチェックする。チェックした件数を返す。

    「1回分」をここに切り出しておくと、Phase 8 で EventBridge から1分ごとに
    Lambda を起動する形に変えるとき、この関数を呼ぶだけで済む。
    """
    with SessionLocal() as session:
        targets = session.scalars(select(Target)).all()
        for target in targets:
            result = check_url(target.url, CHECK_TIMEOUT_SECONDS)
            session.add(
                Check(
                    target_id=target.id,
                    ok=result.ok,
                    status_code=result.status_code,
                    response_ms=result.response_ms,
                    error=result.error,
                )
            )
            logger.info(
                "%s %s status=%s time=%s %s",
                "UP  " if result.ok else "DOWN",
                target.url,
                result.status_code or "-",
                f"{result.response_ms}ms" if result.response_ms is not None else "-",
                result.error or "",
            )

        # 古い記録を消す（放っておくと 1ターゲットあたり 1日 1440 行ずつ増え続ける）
        session.execute(delete(Check).where(Check.checked_at < utcnow() - timedelta(days=RETENTION_DAYS)))
        session.commit()
    return len(targets)


def handle_signal(signum: int, frame: FrameType | None) -> None:
    stop_event.set()
    logger.info("received %s, stopping after current run", signal.Signals(signum).name)


def run_forever(stop: threading.Event) -> None:
    while not stop.is_set():
        started = time.monotonic()
        try:
            count = run_once()
            logger.info("checked %d target(s)", count)
        except Exception:
            # DB が一時的に落ちていても、ジョブ自体は止めずに次の回でやり直す
            logger.exception("check run failed")
        elapsed = time.monotonic() - started
        stop.wait(timeout=max(0.0, CHECK_INTERVAL_SECONDS - elapsed))
    logger.info("worker stopped")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # 自前のログと重複するので抑える
    # PID 1 はハンドラなしだと SIGTERM を無視する。ECS/systemd は SIGTERM の後に SIGKILL を送る。
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    init_db()
    logger.info("worker started (interval=%ss, timeout=%ss)", CHECK_INTERVAL_SECONDS, CHECK_TIMEOUT_SECONDS)
    run_forever(stop_event)


if __name__ == "__main__":
    main()
