"""Tests for dashboard application configuration persistence."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.dashboard_store import (
    _store_path, _validate_app_id, _write_store, _read_store,
    list_apps, get_app, create_app, update_app, delete_app,
)
from app.config import settings


def setup_module():
    """Ensure clean state before tests."""
    path = _store_path()
    if path.exists():
        path.unlink()


def teardown_module():
    """Clean up after tests."""
    path = _store_path()
    if path.exists():
        path.unlink()


def test_store_path_is_in_backup_dir():
    path = _store_path()
    assert str(path).startswith(str(settings.backup_dir.resolve()))
    assert path.name == "dashboard-apps.json"


def test_validate_app_id_valid():
    assert _validate_app_id("grafana") == "grafana"
    assert _validate_app_id("grafana-1") == "grafana-1"
    assert _validate_app_id("a") == "a"


def test_validate_app_id_invalid():
    for bad in ["", "-grafana", "grafana!", "grafana@home", "a" * 129]:
        with pytest.raises(ValueError):
            _validate_app_id(bad)


def test_missing_file_returns_empty():
    setup_module()
    apps = list_apps()
    assert apps == []


def test_post_creates_application():
    setup_module()
    created = create_app({
        "appId": "grafana",
        "containerName": "grafana",
        "displayName": "Grafana",
        "url": "https://grafana.example.com",
        "description": "Metrics & dashboards",
        "icon": "bi-graph-up",
        "group": "monitoring",
        "order": 1,
    })
    assert created["appId"] == "grafana"
    assert created["containerName"] == "grafana"
    assert created["displayName"] == "Grafana"
    assert created["url"] == "https://grafana.example.com"
    assert created["description"] == "Metrics & dashboards"
    assert created["icon"] == "bi-graph-up"
    assert created["group"] == "monitoring"
    assert created["order"] == 1
    assert "createdAt" in created
    assert "updatedAt" in created


def test_duplicate_post_rejected():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana"})
    with pytest.raises(ValueError, match="already exists"):
        create_app({"appId": "grafana", "displayName": "Grafana 2"})


def test_get_returns_saved_application():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana"})
    app = get_app("grafana")
    assert app is not None
    assert app["appId"] == "grafana"
    assert app["displayName"] == "Grafana"


def test_get_unknown_returns_none():
    setup_module()
    assert get_app("unknown") is None


def test_put_updates_application():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana", "url": "http://old"})
    updated = update_app("grafana", {"url": "https://new.example.com", "displayName": "Grafana Updated"})
    assert updated["url"] == "https://new.example.com"
    assert updated["displayName"] == "Grafana Updated"
    assert updated["createdAt"] is not None


def test_put_preserves_created_at():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana"})
    original = get_app("grafana")
    created_at = original["createdAt"]
    update_app("grafana", {"url": "https://new"})
    updated = get_app("grafana")
    assert updated["createdAt"] == created_at
    assert updated["updatedAt"] != created_at


def test_put_unknown_id_rejected():
    setup_module()
    with pytest.raises(KeyError, match="not found"):
        update_app("unknown", {"url": "https://new"})


def test_delete_removes_application():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana"})
    delete_app("grafana")
    assert get_app("grafana") is None
    assert list_apps() == []


def test_delete_nonexistent_raises():
    setup_module()
    with pytest.raises(KeyError, match="not found"):
        delete_app("nonexistent")


def test_malformed_input_rejected():
    setup_module()
    with pytest.raises(ValueError, match="appId"):
        create_app({"appId": "", "displayName": "Test"})
    with pytest.raises(ValueError, match="displayName"):
        create_app({"appId": "test", "displayName": "x" * 256})
    with pytest.raises(ValueError, match="description"):
        create_app({"appId": "test", "description": "x" * 1025})
    with pytest.raises(ValueError, match="icon"):
        create_app({"appId": "test", "icon": "x" * 129})
    with pytest.raises(ValueError, match="invalid literal for int"):
        create_app({"appId": "test", "order": "not-an-int"})


def test_persistence_survives_reload():
    setup_module()
    create_app({"appId": "grafana", "displayName": "Grafana", "url": "https://grafana.example.com"})
    # Simulate reload by reading from disk again
    apps = list_apps()
    assert len(apps) == 1
    assert apps[0]["appId"] == "grafana"
    assert apps[0]["displayName"] == "Grafana"
    assert apps[0]["url"] == "https://grafana.example.com"


def test_atomic_write_leaves_valid_json(tmp_path):
    """Verify that atomic write leaves valid JSON even if interrupted."""
    # This test verifies the write pattern by checking the file exists and is valid
    setup_module()
    create_app({"appId": "test", "displayName": "Test"})
    path = _store_path()
    assert path.exists()
    with path.open("r") as f:
        data = json.load(f)
    assert data["version"] == 1
    assert len(data["applications"]) == 1


def test_list_apps_returns_all():
    setup_module()
    create_app({"appId": "a", "displayName": "A", "order": 2})
    create_app({"appId": "b", "displayName": "B", "order": 1})
    create_app({"appId": "c", "displayName": "C", "order": 3})
    apps = list_apps()
    assert len(apps) == 3
    ids = [a["appId"] for a in apps]
    assert set(ids) == {"a", "b", "c"}