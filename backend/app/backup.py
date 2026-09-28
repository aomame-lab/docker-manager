"""Portable container backup & restore.

A backup is a .tar.gz archive::

    docker-manager-backup/
      manifest.json          structures, versions, container list
      containers/<name>/config.json
      images/<n>.tar         docker image(s) saved via engine API
      volumes/<name>.tar     volume data tar (optional)
      README.txt

Bind mounts are recorded in the manifest but their host data is NOT
included; this is flagged explicitly in the manifest and UI.
"""
from __future__ import annotations

import io
import json
import logging
import re
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from docker.errors import APIError, ImageNotFound

from .config import settings
from .docker_service import DockerService

log = logging.getLogger(__name__)

BACKUP_ROOT = "docker-manager-backup"
MANIFEST_VERSION = 1
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")


class BackupError(Exception):
    pass


# --------------------------------------------------------------------- utils
def _safe_member(name: str) -> None:
    """Reject absolute or traversing archive member names."""
    p = Path(name)
    if p.is_absolute() or ".." in p.parts:
        raise BackupError(f"Unsafe path in archive: {name!r}")


def safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    dest = dest.resolve()
    for m in tar.getmembers():
        _safe_member(m.name)
        target = (dest / m.name).resolve()
        if not str(target).startswith(str(dest) + "/") and target != dest:
            raise BackupError(f"Path traversal blocked: {m.name!r}")
    tar.extractall(dest, filter="data")


def _validate_name(name: str) -> str:
    if not _NAME_RE.match(name or ""):
        raise BackupError(f"Invalid container name: {name!r}")
    return name


# ------------------------------------------------------------------- create
def _container_config(svc: DockerService, container_id: str) -> dict[str, Any]:
    c = svc.container(container_id)
    a = c.attrs
    cfg, host, net = a.get("Config", {}), a.get("HostConfig", {}), a.get("NetworkSettings", {})
    mounts, binds, volumes = [], [], []
    for m in a.get("Mounts", []):
        source = m["Name"] if m.get("Type") == "volume" and m.get("Name") else m.get("Source")
        entry = {"type": m.get("Type"), "source": source,
                 "destination": m.get("Destination"), "rw": m.get("RW", True),
                 "mode": m.get("Mode", "")}
        mounts.append(entry)
        (volumes if m.get("Type") == "volume" else binds).append(entry)
    ports = []
    for container_port, bindings in (host.get("PortBindings") or {}).items():
        for b in bindings or []:
            ports.append({"container": container_port, "host_ip": b.get("HostIp", ""),
                          "host_port": b.get("HostPort", "")})
    return {
        "name": c.name, "image": cfg.get("Image", ""),
        "env": cfg.get("Env") or [], "cmd": cfg.get("Cmd"),
        "entrypoint": cfg.get("Entrypoint"), "working_dir": cfg.get("WorkingDir", ""),
        "user": cfg.get("User", ""), "labels": cfg.get("Labels") or {},
        "restart_policy": host.get("RestartPolicy", {}),
        "network_mode": host.get("NetworkMode", ""),
        "networks": list((net.get("Networks") or {}).keys()),
        "ports": ports, "exposed_ports": list((cfg.get("ExposedPorts") or {}).keys()),
        "mounts": mounts, "bind_mounts": binds, "volumes": volumes,
        "hostname": cfg.get("Hostname", ""), "created": a.get("Created", ""),
    }


def create_backup(svc: DockerService, container_ids: list[str],
                  include_volumes: bool = True) -> Path:
    if not container_ids:
        raise BackupError("No containers selected")
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    out_path = (settings.backup_dir / f"docker-backup-{stamp}.tar.gz").resolve()
    if not str(out_path).startswith(str(settings.backup_dir.resolve())):
        raise BackupError("Invalid backup path")

    configs = [_container_config(svc, cid) for cid in container_ids]
    images: list[str] = sorted({c["image"] for c in configs if c["image"]})
    shared_volumes = sorted({v["source"] for c in configs for v in c["volumes"]})
    shared_nets = sorted({n for c in configs for n in c["networks"]
                          if n not in ("bridge", "host", "none")})
    # Export images to temp files first so we know what is missing.
    import tempfile
    exported_images: list[tuple[str, Path]] = []
    missing_images: list[str] = []
    tmp_files: list[Path] = []
    for i, ref in enumerate(images):
        try:
            try:
                img = svc.client.images.get(ref)
            except ImageNotFound:
                missing_images.append(ref)
                continue
            tmp = Path(tempfile.mkstemp(suffix=".tar", dir=settings.backup_dir)[1])
            with open(tmp, "wb") as fh:
                for chunk in img.save(named=True):
                    fh.write(chunk)
            exported_images.append((ref, tmp))
            tmp_files.append(tmp)
        except APIError as exc:
            raise BackupError(f"Failed to export image {ref}: {exc.explanation}") from exc

    manifest = {
        "version": MANIFEST_VERSION, "created": datetime.now(timezone.utc).isoformat(),
        "app": settings.app_name, "containers": configs,
        "images": images, "exported_images": [r for r, _ in exported_images],
        "missing_images": missing_images,
        "shared_volumes": shared_volumes,
        "shared_networks": shared_nets,
        "volumes_included": include_volumes,
        "bind_mounts_included": False,
        "warnings": [],
    }
    if any(c["bind_mounts"] for c in configs):
        names = [c["name"] for c in configs if c["bind_mounts"]]
        manifest["warnings"].append(
            f"Bind mounts detected for {names}; host data is NOT included "
            "and must be backed up separately.")
    if missing_images:
        manifest["warnings"].append(
            f"Images not found locally and NOT exported: {missing_images} "
            "(they must be pulled on the restore host)")

    readme = (
        "Docker Manager backup\n=====================\n"
        f"Created: {manifest['created']}\nContainers: {', '.join(c['name'] for c in configs)}\n\n"
        "Restore via Docker Manager (Backups > Restore) on any Docker host.\n"
        "Contents: manifest.json, container configs, image archives"
        + (", volume data archives.\n" if include_volumes else ".\n")
        + ("WARNING: bind-mount host data is NOT included.\n" if manifest["warnings"] else "")
    )

    # Write to a temporary file first; rename atomically on success so an
    # incomplete archive is never listed/downloadable as a finished backup.
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    log.info("Creating backup %s for %s", out_path.name, [c["name"] for c in configs])
    try:
        with tarfile.open(tmp_path, "w:gz") as tar:
            def add_bytes(data: bytes, arcname: str) -> None:
                ti = tarfile.TarInfo(arcname)
                ti.size = len(data)
                ti.mtime = int(datetime.now().timestamp())
                tar.addfile(ti, io.BytesIO(data))

            add_bytes(json.dumps(manifest, indent=2).encode(),
                      f"{BACKUP_ROOT}/manifest.json")
            add_bytes(readme.encode(), f"{BACKUP_ROOT}/README.txt")
            for cfg in configs:
                add_bytes(json.dumps(cfg, indent=2).encode(),
                          f"{BACKUP_ROOT}/containers/{_validate_name(cfg['name'])}/config.json")
            for i, (ref, tmp) in enumerate(exported_images):
                tar.add(tmp, arcname=f"{BACKUP_ROOT}/images/image_{i}.tar")

            if include_volumes:
                for vol in shared_volumes:
                    _validate_name(vol)
                    data_file = settings.backup_dir / f".vol-{vol}.tar.gz"
                    try:
                        svc.client.containers.run(
                            "alpine:latest",
                            command=["tar", "-czf", f"/backup/{data_file.name}",
                                     "-C", "/data", "."],
                            volumes={vol: {"bind": "/data", "mode": "ro"},
                                     str(settings.backup_dir): {"bind": "/backup", "mode": "rw"}},
                            remove=True, detach=False)
                        tar.add(data_file, arcname=f"{BACKUP_ROOT}/volumes/{vol}.tar.gz")
                    except APIError as exc:
                        raise BackupError(f"Failed to back up volume {vol}: "
                                          f"{exc.explanation or exc}") from exc
                    finally:
                        data_file.unlink(missing_ok=True)
    except BaseException:
        tmp_path.unlink(missing_ok=True)         # drop incomplete archive
        raise
    else:
        tmp_path.replace(out_path)               # atomic publish
    finally:
        for tmp in tmp_files:
            tmp.unlink(missing_ok=True)
    log.info("Backup created: %s", out_path)
    return out_path


def list_backups() -> list[dict[str, Any]]:
    out = []
    for p in sorted(settings.backup_dir.glob("docker-backup-*.tar.gz"), reverse=True):
        out.append({"filename": p.name, "size": p.stat().st_size,
                    "created": datetime.fromtimestamp(p.stat().st_mtime).isoformat()})
    return out


# ----------------------------------------------------------------- validate
def read_manifest(fileobj) -> dict[str, Any]:
    try:
        with tarfile.open(fileobj=fileobj, mode="r:*") as tar:
            for m in tar.getmembers():
                _safe_member(m.name)
            m = tar.extractfile(f"{BACKUP_ROOT}/manifest.json")
            if m is None:
                raise BackupError("manifest.json not found — not a Docker Manager backup")
            manifest = json.loads(m.read().decode())
    except (tarfile.TarError, KeyError, json.JSONDecodeError) as exc:
        raise BackupError(f"Invalid backup archive: {exc}") from exc
    if manifest.get("version", 0) > MANIFEST_VERSION:
        raise BackupError(f"Unsupported backup version {manifest.get('version')}")
    if not manifest.get("containers"):
        raise BackupError("Backup contains no containers")
    for c in manifest["containers"]:
        _validate_name(c.get("name", ""))
        if not c.get("image"):
            raise BackupError(f"Container '{c.get('name')}' has no image reference")
    return manifest


def backup_summary(svc: DockerService, fileobj) -> dict[str, Any]:
    manifest = read_manifest(fileobj)
    existing = {c.name for c in svc.client.containers.list(all=True)}
    existing_vols = {v.name for v in svc.client.volumes.list()}
    local_images = {t for img in svc.client.images.list() for t in img.tags}
    used_ports = {b["HostPort"]
                  for cnt in svc.client.containers.list(all=True)
                  for bl in (cnt.attrs.get("HostConfig", {}).get("PortBindings") or {}).values()
                  for b in (bl or []) if b.get("HostPort")}
    items = []
    for c in manifest["containers"]:
        conflicts = []
        if c["name"] in existing:
            conflicts.append("A container with this name already exists")
        port_conflicts = [p for p in c.get("ports", [])
                          if p.get("host_port") and p["host_port"] in used_ports]
        if port_conflicts:
            conflicts.append("Host ports already in use: "
                             + ", ".join(sorted({p["host_port"] for p in port_conflicts})))
        items.append({
            "name": c["name"], "image": c["image"],
            "image_local": c["image"] in local_images or any(
                c["image"] in m.get("images", []) for m in [manifest]),
            "image_in_backup": c["image"] in manifest.get("images", []),
            "ports": c.get("ports", []), "env": [e.split("=", 1)[0] for e in c.get("env", [])],
            "volumes": c.get("volumes", []), "bind_mounts": c.get("bind_mounts", []),
            "conflicts": conflicts,
        })
    return {"manifest": {k: manifest[k] for k in
                         ("version", "created", "images", "shared_volumes",
                          "shared_networks", "volumes_included", "warnings")
                         if k in manifest},
            "existing_volumes": sorted(existing_vols), "containers": items}
