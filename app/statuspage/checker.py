"""1つの URL に HTTP でアクセスして、生きているかを調べる。

DB にも時間にも依存しない純粋な処理にしておく（Phase 8 で Lambda から呼ぶときもそのまま使える）。
"""

import time
from dataclasses import dataclass

import httpx


@dataclass
class CheckResult:
    ok: bool
    status_code: int | None
    response_ms: int | None
    error: str | None


def check_url(url: str, timeout: float) -> CheckResult:
    start = time.perf_counter()
    try:
        response = httpx.get(url, timeout=timeout, follow_redirects=True)
    except (httpx.HTTPError, httpx.InvalidURL) as e:
        # タイムアウト・DNS エラー・接続拒否など、応答そのものが得られなかった
        return CheckResult(ok=False, status_code=None, response_ms=None, error=f"{type(e).__name__}: {e}")

    elapsed_ms = round((time.perf_counter() - start) * 1000)
    return CheckResult(
        ok=response.status_code < 400,
        status_code=response.status_code,
        response_ms=elapsed_ms,
        error=None,
    )
