"""Dashboard application configuration persistence.

Single JSON file under BACKUP_DIR with atomic writes and simple validation.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

log = logging.getLogger(__name__)

STORE_VERSION = 1
STORE_FILENAME = "dashboard-apps.json"
_APP_ID_RE = r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$"


def _store_path() -> Path:
    """Return the absolute path to the dashboard apps JSON file."""
    return (settings.backup_dir / STORE_FILENAME).resolve()


def _validate_app_id(app_id: str) -> str:
    import re
    if not re.match(_APP_ID_RE, app_id or ""):
        raise ValueError("appId must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
    return app_id


def _validate_str(value: str | None, max_len: int, field: str) -> str | None:
    if value is None:
        return None
    if len(value) > max_len:
        raise ValueError(f"{field} exceeds maximum length of {max_len}")
    return value


def _default_store() -> dict[str, Any]:
    return {
        "version": STORE_VERSION,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "applications": [],
    }


def _read_store() -> dict[str, Any]:
    path = _store_path()
    if not path.exists():
        return _default_store()
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        log.error("Corrupt dashboard apps file %s: %s", path, exc)
        # Keep a backup of the corrupt file
        corrupt_path = path.with_name(path.name + ".corrupt")
        try:
            path.rename(corrupt_path)
            log.warning("Corrupt store moved to %s", corrupt_path)
        except OSError:
            pass
        return _default_store()

    if data.get("version", 0) > STORE_VERSION:
        log.warning("Store version %s newer than supported %s", data.get("version"), STORE_VERSION)
    return data


def _write_store(data: dict[str, Any]) -> None:
    path = _store_path()
    tmp_path = path.with_name(path.name + ".tmp")
    data["updatedAt"] = datetime.now(timezone.utc).isoformat()
    try:
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        tmp_path.replace(path)
    except OSError as exc:
        log.error("Failed to write dashboard store: %s", exc)
        tmp_path.unlink(missing_ok=True)
        raise


def list_apps() -> list[dict[str, Any]]:
    """Return all persisted application configurations."""
    store = _read_store()
    return store.get("applications", [])


def get_app(app_id: str) -> dict[str, Any] | None:
    """Return a single application by appId, or None if not found."""
    _validate_app_id(app_id)
    for app in list_apps():
        if app["appId"] == app_id:
            return app
    return None


def create_app(data: dict[str, Any]) -> dict[str, Any]:
    """Create a new application configuration.

    Raises ValueError if appId already exists or validation fails.
    """
    _validate_app_id(data.get("appId", ""))
    apps = list_apps()
    if any(a["appId"] == data["appId"] for a in apps):
        raise ValueError(f"Application with appId '{data['appId']}' already exists")

    now = datetime.now(timezone.utc).isoformat()
    app = {
        "appId": data["appId"],
        "containerName": _validate_str(data.get("containerName"), 255, "containerName"),
        "imageDigest": _validate_str(data.get("imageDigest"), 255, "imageDigest"),
        "displayName": _validate_str(data.get("displayName"), 255, "displayName") or data["appId"],
        "url": _validate_str(data.get("url"), 2048, "url"),
        "description": _validate_str(data.get("description"), 1024, "description"),
        "icon": _validate_str(data.get("icon"), 128, "icon"),
        "group": _validate_str(data.get("group"), 128, "group"),
        "order": int(data.get("order", 0)),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    store = _read_store()
    store["applications"].append(app)
    _write_store(store)
    return app


def update_app(app_id: str, data: dict[str, Any]) -> dict[str, Any]:
    """Update an existing application configuration.

    Raises KeyError if appId not found.
    """
    _validate_app_id(app_id)
    apps = list_apps()
    idx = next((i for i, a in enumerate(apps) if a["appId"] == app_id), None)
    if idx is None:
        raise KeyError(f"Application '{app_id}' not found")

    existing = apps[idx]
    updated = {
        "appId": app_id,
        "containerName": _validate_str(data.get("containerName", existing.get("containerName")), 255, "containerName"),
        "imageDigest": _validate_str(data.get("imageDigest", existing.get("imageDigest")), 255, "imageDigest"),
        "displayName": _validate_str(data.get("displayName", existing["displayName"]), 255, "displayName"),
        "url": _validate_str(data.get("url", existing.get("url")), 2048, "url"),
        "description": _validate_str(data.get("description", existing.get("description")), 1024, "description"),
        "icon": _validate_str(data.get("icon", existing.get("icon")), 128, "icon"),
        "group": _validate_str(data.get("group", existing.get("group")), 128, "group"),
        "order": int(data.get("order", existing.get("order", 0))),
        "createdAt": existing["createdAt"],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    apps[idx] = updated
    store = _read_store()
    store["applications"] = apps
    _write_store(store)
    return updated


def delete_app(app_id: str) -> None:
    """Delete an application by appId.

    Raises KeyError if appId not found.
    """
    _validate_app_id(app_id)
    apps = list_apps()
    new_apps = [a for a in apps if a["appId"] != app_id]
    if len(new_apps) == len(apps):
        raise KeyError(f"Application '{app_id}' not found")

    store = _read_store()
    store["applications"] = new_apps
    _write_store(store)