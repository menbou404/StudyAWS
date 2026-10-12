from datetime import timedelta

import httpx

from statuspage import checker, worker
from statuspage.checker import CheckResult, check_url
from statuspage.db import Check, SessionLocal, utcnow


def test_run_once_records_results(client, monkeypatch):
    # 本物のネットワークには出ず、結果を差し替える
    def fake_check_url(url, timeout):
        if "down" in url:
            return CheckResult(ok=False, status_code=None, response_ms=None, error="ConnectError: refused")
        return CheckResult(ok=True, status_code=200, response_ms=42, error=None)

    monkeypatch.setattr(worker, "check_url", fake_check_url)
    client.post("/api/targets", json={"name": "Up", "url": "https://up.example"})
    client.post("/api/targets", json={"name": "Down", "url": "https://down.example"})

    assert worker.run_once() == 2

    latest = {t["name"]: t["latest"] for t in client.get("/api/targets").json()}
    assert latest["Up"]["ok"] is True
    assert latest["Up"]["response_ms"] == 42
    assert latest["Down"]["ok"] is False
    assert latest["Down"]["error"] == "ConnectError: refused"


def test_run_once_deletes_old_checks(client, monkeypatch):
    monkeypatch.setattr(worker, "check_url", lambda url, timeout: CheckResult(True, 200, 1, None))
    target_id = client.post("/api/targets", json={"name": "A", "url": "https://a.example"}).json()["id"]
    with SessionLocal() as session:
        session.add(Check(target_id=target_id, ok=True, checked_at=utcnow() - timedelta(days=30)))
        session.commit()

    worker.run_once()

    checks = client.get(f"/api/targets/{target_id}/checks").json()
    assert len(checks) == 1  # 30日前の記録は消え、今回の1件だけ残る


def test_check_url_handles_connection_error(monkeypatch):
    def raise_connect_error(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(checker.httpx, "get", raise_connect_error)
    result = check_url("https://unreachable.example", timeout=1)
    assert result.ok is False
    assert result.status_code is None
    assert result.error.startswith("ConnectError")
