"""Restore logic for Docker Manager backups."""
from __future__ import annotations

import io
import logging
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Any

from docker.errors import APIError, ImageNotFound

from .backup import BACKUP_ROOT, BackupError, _validate_name, read_manifest, safe_extract
from .config import settings
from .docker_service import DockerService

log = logging.getLogger(__name__)


def restore_backup(svc: DockerService, fileobj,
                   renames: dict[str, str] | None = None,
                   start: bool = False,
                   restore_volumes: bool = True) -> list[dict[str, Any]]:
    """Restore a backup archive. Returns per-container results."""
    renames = renames or {}
    tmpdir = Path(tempfile.mkdtemp(dir=settings.backup_dir))
    try:
        # ------------------------------------------------ validate & extract
        fileobj.seek(0)
        manifest = read_manifest(fileobj)
        fileobj.seek(0)
        with tarfile.open(fileobj=fileobj, mode="r:*") as tar:
            safe_extract(tar, tmpdir)
        root = tmpdir / BACKUP_ROOT

        # -------------------------------------------------------- load images
        images_dir = root / "images"
        if images_dir.is_dir():
            for img_tar in sorted(images_dir.glob("*.tar")):
                log.info("Loading image archive %s", img_tar.name)
                svc.client.images.load(img_tar.read_bytes())

        results: list[dict[str, Any]] = []

        # --------------------------------------------------- shared networks
        existing_nets = {n.name for n in svc.client.networks.list()}
        for net in manifest.get("shared_networks", []):
            _validate_name(net)
            if net not in existing_nets:
                try:
                    svc.client.networks.create(net, driver="bridge")
                    log.info("Created network %s", net)
                except APIError as exc:
                    raise BackupError(f"Failed to create network {net}: {exc.explanation}") from exc

        # ---------------------------------------------------- shared volumes
        if restore_volumes and manifest.get("volumes_included"):
            vols_dir = root / "volumes"
            for vol in manifest.get("shared_volumes", []):
                _validate_name(vol)
                arc = vols_dir / f"{vol}.tar.gz"
                if not arc.exists():
                    continue
                try:
                    svc.client.volumes.get(vol)
                    log.info("Volume %s already exists, leaving data intact", vol)
                except Exception:
                    svc.client.volumes.create(name=vol)
                    log.info("Created volume %s", vol)
                    svc.client.containers.run(
                        "alpine:latest",
                        command=["sh", "-c", f"tar -xzf /backup/{arc.name} -C /data"],
                        volumes={vol: {"bind": "/data", "mode": "rw"},
                                 str(arc.parent): {"bind": "/backup", "mode": "ro"}},
                        remove=True, detach=False)

        # --------------------------------------------------- create containers
        existing = {c.name for c in svc.client.containers.list(all=True)}
        for cfg in manifest["containers"]:
            name = renames.get(cfg["name"], cfg["name"])
            _validate_name(name)
            if name in existing:
                results.append({"name": name, "ok": False,
                                "error": "A container with this name already exists"})
                continue
            # Verify image availability
            try:
                svc.client.images.get(cfg["image"])
            except ImageNotFound:
                try:
                    log.info("Pulling missing image %s", cfg["image"])
                    svc.client.images.pull(cfg["image"])
                except APIError as exc:
                    results.append({"name": name, "ok": False,
                                    "error": f"Image '{cfg['image']}' unavailable: {exc.explanation}"})
                    continue

            port_bindings = {}
            for p in cfg.get("ports", []):
                if p.get("host_port"):
                    key = (p["host_ip"] or None, int(p["host_port"])) if p.get("host_ip") else int(p["host_port"])
                    port_bindings[p["container"]] = key

            volumes_spec: dict[str, dict[str, str]] = {}
            for m in cfg.get("mounts", []):
                src = m.get("source")
                if not src:
                    continue
                mode = "rw" if m.get("rw", True) else "ro"
                volumes_spec[src] = {"bind": m["destination"], "mode": mode}

            networks = [n for n in cfg.get("networks", []) if n not in ("bridge", "host", "none")]
            try:
                container = svc.client.containers.create(
                    cfg["image"], command=cfg.get("cmd"), entrypoint=cfg.get("entrypoint"),
                    name=name, environment=cfg.get("env") or [],
                    working_dir=cfg.get("working_dir") or None,
                    user=cfg.get("user") or None, labels=cfg.get("labels") or {},
                    restart_policy=cfg.get("restart_policy") or None,
                    network_mode=(cfg.get("network_mode")
                                  if cfg.get("network_mode") in ("host", "none", "bridge") else None),
                    ports=port_bindings or None, volumes=volumes_spec or None,
                    hostname=cfg.get("hostname") or None, detach=True,
                )
                for net in networks:
                    if net in {n.name for n in svc.client.networks.list()}:
                        svc.client.networks.get(net).connect(container)
                if start:
                    container.start()
                log.info("Restored container %s (start=%s)", name, start)
                results.append({"name": name, "ok": True, "id": container.short_id,
                                "started": bool(start)})
            except APIError as exc:
                log.error("Restore of %s failed: %s", name, exc)
                results.append({"name": name, "ok": False,
                                "error": exc.explanation or str(exc)})
        return results
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
