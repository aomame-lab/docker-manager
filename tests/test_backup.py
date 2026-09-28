import io
import json
import sys
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.backup import (BACKUP_ROOT, BackupError, _safe_member, read_manifest,
                        safe_extract)

VALID_CONFIG = {"name": "web", "image": "nginx:latest", "env": ["A=1"],
                "cmd": None, "entrypoint": None, "working_dir": "", "user": "",
                "labels": {}, "restart_policy": {}, "network_mode": "bridge",
                "networks": [], "ports": [], "exposed_ports": [], "mounts": [],
                "bind_mounts": [], "volumes": [], "hostname": "", "created": ""}


def make_backup(manifest_override=None, members=None):
    manifest = {"version": 1, "created": "2024-01-01T00:00:00Z",
                "containers": [VALID_CONFIG], "images": ["nginx:latest"],
                "shared_volumes": [], "shared_networks": [],
                "volumes_included": True, "bind_mounts_included": False,
                "warnings": []}
    manifest.update(manifest_override or {})
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = json.dumps(manifest).encode()
        ti = tarfile.TarInfo(f"{BACKUP_ROOT}/manifest.json")
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))
        for name in members or []:
            ti = tarfile.TarInfo(name)
            ti.size = 0
            tar.addfile(ti, io.BytesIO(b""))
    buf.seek(0)
    return buf


def test_read_manifest_ok():
    m = read_manifest(make_backup())
    assert m["containers"][0]["name"] == "web"


def test_read_manifest_missing():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz"):
        pass
    buf.seek(0)
    with pytest.raises(BackupError, match="Invalid backup archive"):
        read_manifest(buf)


def test_read_manifest_not_tar():
    with pytest.raises(BackupError, match="Invalid backup"):
        read_manifest(io.BytesIO(b"not a tar at all"))


def test_manifest_no_containers():
    with pytest.raises(BackupError, match="no containers"):
        read_manifest(make_backup({"containers": []}))


def test_manifest_bad_name():
    bad = dict(VALID_CONFIG, name="../evil")
    with pytest.raises(BackupError, match="Invalid container name"):
        read_manifest(make_backup({"containers": [bad]}))


def test_manifest_bad_image():
    bad = dict(VALID_CONFIG, image="")
    with pytest.raises(BackupError, match="no image"):
        read_manifest(make_backup({"containers": [bad]}))


def test_future_version():
    with pytest.raises(BackupError, match="version"):
        read_manifest(make_backup({"version": 99}))


def test_safe_member_blocks_traversal():
    for bad in ["../x", "/etc/passwd", "a/../../b"]:
        with pytest.raises(BackupError):
            _safe_member(bad)
    _safe_member("docker-manager-backup/manifest.json")  # ok


def test_safe_extract_blocks_traversal(tmp_path):
    buf = make_backup(members=[f"{BACKUP_ROOT}/../../evil.txt"])
    with tarfile.open(fileobj=buf, mode="r:*") as tar:
        with pytest.raises(BackupError):
            safe_extract(tar, tmp_path)
    assert not (tmp_path.parent / "evil.txt").exists()


def test_safe_extract_ok(tmp_path):
    buf = make_backup(members=[f"{BACKUP_ROOT}/containers/web/config.json"])
    with tarfile.open(fileobj=buf, mode="r:*") as tar:
        safe_extract(tar, tmp_path)
    assert (tmp_path / BACKUP_ROOT / "containers/web/config.json").exists()
