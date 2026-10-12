def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_create_and_list_targets(client):
    response = client.post("/api/targets", json={"name": "Example", "url": "https://example.com"})
    assert response.status_code == 201
    created = response.json()
    assert created["name"] == "Example"
    assert created["latest"] is None  # まだ一度もチェックしていない

    targets = client.get("/api/targets").json()
    assert [t["id"] for t in targets] == [created["id"]]


def test_rejects_invalid_url(client):
    response = client.post("/api/targets", json={"name": "Bad", "url": "not-a-url"})
    assert response.status_code == 422


def test_delete_target(client):
    target_id = client.post("/api/targets", json={"name": "A", "url": "https://a.example"}).json()["id"]

    assert client.delete(f"/api/targets/{target_id}").status_code == 204
    assert client.get("/api/targets").json() == []
    assert client.delete(f"/api/targets/{target_id}").status_code == 404


def test_status_page_renders(client):
    client.post("/api/targets", json={"name": "Example", "url": "https://example.com"})
    response = client.get("/")
    assert response.status_code == 200
    assert "Example" in response.text
    assert "未チェック" in response.text
