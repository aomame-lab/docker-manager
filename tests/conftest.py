import os
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("BACKUP_DIR", str(Path(__file__).resolve().parent.parent / "backups"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import deps  # noqa: E402
from app.docker_service import DockerService  # noqa: E402
from app.main import app  # noqa: E402


def make_container(cid="abc123456789def0", name="web", status="running"):
    c = MagicMock()
    c.id, c.short_id, c.name, c.status = cid + "0" * 40, cid[:12], name, status
    c.attrs = {
        "Id": c.id, "Name": "/" + name, "Created": "2024-01-01T00:00:00Z",
        "Image": "sha256:img" + cid,
        "Config": {"Image": "nginx:latest", "Env": ["PATH=/bin", "DB_PASSWORD=secret"],
                   "Cmd": ["nginx"], "Entrypoint": None, "WorkingDir": "/",
                   "User": "", "Labels": {}},
        "HostConfig": {"RestartPolicy": {"Name": "always"}, "PortBindings": {},
                       "NetworkMode": "bridge"},
        "State": {"Status": status, "StartedAt": "2024-01-01T00:00:00Z",
                  "FinishedAt": "", "RestartCount": 0},
        "NetworkSettings": {"Networks": {"bridge": {"IPAddress": "172.17.0.2"}},
                            "Ports": {}},
        "Mounts": [],
    }
    c.stats.return_value = {
        "cpu_stats": {"cpu_usage": {"total_usage": 200}, "online_cpus": 1,
                      "system_cpu_usage": 2000},
        "precpu_stats": {"cpu_usage": {"total_usage": 100}, "system_cpu_usage": 1000},
        "memory_stats": {"usage": 1024 * 1024, "limit": 1024 * 1024 * 100},
        "networks": {"eth0": {"rx_bytes": 10, "tx_bytes": 20}},
        "blkio_stats": {"io_service_bytes_recursive": []},
    }
    c.logs.return_value = b"2024-01-01T00:00:00Z hello\n"
    return c


@pytest.fixture()
def mock_docker():
    client = MagicMock()
    c = make_container()
    client.containers.list.return_value = [c]
    client.containers.get.return_value = c
    client.images.list.return_value = []
    client.volumes.list.return_value = []
    client.networks.list.return_value = []
    client.ping.return_value = True
    client.version.return_value = {"Version": "25.0.0", "ApiVersion": "1.45", "Os": "linux"}
    return client


@pytest.fixture()
def client(mock_docker):
    service = DockerService(client=mock_docker)
    deps.get_service = lambda: service  # type: ignore
    import app.deps as d
    d.svc.__wrapped__ if hasattr(d.svc, "__wrapped__") else None
    yield TestClient(app, raise_server_exceptions=False)
    deps.get_service = __import__("app.docker_service", fromlist=["get_service"]).get_service
