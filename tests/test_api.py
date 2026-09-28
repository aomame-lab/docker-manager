def test_list_containers(client, mock_docker):
    r = client.get("/api/containers")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    c = data[0]
    assert c["name"] == "web" and c["state"] == "running"
    assert c["stats"]["cpu_percent"] > 0


def test_system(client):
    r = client.get("/api/system")
    assert r.status_code == 200
    assert r.json()["engine"]["connected"] is True


def test_inspect_masks_env(client):
    d = client.get("/api/containers/web").json()
    env = {e["key"]: e for e in d["env"]}
    assert env["DB_PASSWORD"]["sensitive"] is True
    assert env["DB_PASSWORD"]["value"] == "••••••••"
    assert env["PATH"]["sensitive"] is False


def test_reveal_env(client):
    env = client.get("/api/containers/web/env").json()
    assert {e["key"]: e["value"] for e in env}["DB_PASSWORD"] == "secret"


def test_actions(client):
    for act in ["start", "stop", "restart", "pause", "unpause", "kill"]:
        r = client.post(f"/api/containers/web/{act}")
        assert r.status_code == 200, act


def test_invalid_action(client):
    assert client.post("/api/containers/web/nuke").status_code == 404


def test_invalid_id(client):
    assert client.post("/api/containers/bad;id/start").status_code == 400


def test_remove(client):
    assert client.delete("/api/containers/web").status_code == 200


def test_logs(client):
    r = client.get("/api/containers/web/logs?tail=10")
    assert r.status_code == 200 and "hello" in r.text


def test_container_not_found(client, mock_docker):
    from docker.errors import NotFound
    mock_docker.containers.get.side_effect = NotFound("nope")
    assert client.post("/api/containers/ghost/start").status_code == 404


def test_docker_unavailable(client, mock_docker):
    from docker.errors import DockerException
    mock_docker.containers.list.side_effect = DockerException("socket gone")
    assert client.get("/api/containers").status_code in (500, 502)
