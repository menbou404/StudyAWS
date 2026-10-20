from statuspage.db import engine


def test_engine_has_pre_ping_enabled() -> None:
    # 設定の退行で DB 再起動後の復旧が気づかないうちに壊れるのを防ぐ。
    assert engine.pool._pre_ping is True
