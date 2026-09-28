"""Thin wrapper around the Docker SDK with safe, typed helpers.

All Docker Engine communication goes through this service so the client
can easily be mocked in tests.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Iterable

import docker
from docker.errors import APIError, DockerException, NotFound

from .config import settings

log = logging.getLogger(__name__)

SENSITIVE_HINTS = ("PASS", "SECRET", "TOKEN", "KEY", "PWD", "CREDENTIAL")


class DockerUnavailable(Exception):
    pass


class DockerService:
    def __init__(self, client: docker.DockerClient | None = None) -> None:
        if client is not None:
            self.client = client
        else:
            try:
                self.client = docker.DockerClient(base_url=settings.docker_socket)
                self.client.ping()
            except DockerException as exc:
                log.error("Cannot connect to Docker Engine: %s", exc)
                raise DockerUnavailable(str(exc)) from exc

    # ------------------------------------------------------------------ util
    def container(self, container_id: str):
        try:
            return self.client.containers.get(container_id)
        except NotFound:
            raise KeyError(f"Container '{container_id}' not found")

    # -------------------------------------------------------------- engine
    def info(self) -> dict[str, Any]:
        try:
            v = self.client.version()
            return {"connected": True, "version": v.get("Version", "?"),
                    "api": v.get("ApiVersion", "?"), "os": v.get("Os", "?")}
        except DockerException as exc:
            return {"connected": False, "error": str(exc)}

    # ---------------------------------------------------------- containers
    def _one_shot_stats(self, container) -> dict[str, Any]:
        """Fetch a single non-streaming stats snapshot (short timeout)."""
        try:
            s = container.stats(stream=False)
            cpu_delta = (s["cpu_stats"]["cpu_usage"]["total_usage"]
                         - s["precpu_stats"]["cpu_usage"]["total_usage"])
            sys_delta = (s["cpu_stats"].get("system_cpu_usage", 0)
                         - s["precpu_stats"].get("system_cpu_usage", 0))
            ncpu = s["cpu_stats"].get("online_cpus") or 1
            cpu_pct = (cpu_delta / sys_delta * ncpu * 100.0) if sys_delta > 0 else 0.0
            mem = s.get("memory_stats", {})
            nets = s.get("networks") or {}
            rx = sum(n.get("rx_bytes", 0) for n in nets.values())
            tx = sum(n.get("tx_bytes", 0) for n in nets.values())
            blk = s.get("blkio_stats", {}).get("io_service_bytes_recursive") or []
            brd = sum(e.get("value", 0) for e in blk if e.get("op", "").lower() == "read")
            bwr = sum(e.get("value", 0) for e in blk if e.get("op", "").lower() == "write")
            return {
                "cpu_percent": round(cpu_pct, 2),
                "mem_usage": mem.get("usage", 0),
                "mem_limit": mem.get("limit", 0),
                "mem_percent": round(mem.get("usage", 0) / mem.get("limit", 1) * 100, 2) if mem.get("limit") else 0.0,
                "net_rx": rx, "net_tx": tx, "block_read": brd, "block_write": bwr,
            }
        except Exception as exc:  # stats are best-effort
            log.debug("stats failed for %s: %s", container.name, exc)
            return {}

    def list_containers(self, with_stats: bool = True) -> list[dict[str, Any]]:
        containers = self.client.containers.list(all=True)
        stats_map: dict[str, dict] = {}
        if with_stats:
            running = [c for c in containers if c.status == "running"]
            if running:
                with ThreadPoolExecutor(max_workers=min(8, len(running))) as ex:
                    results = ex.map(self._one_shot_stats, running)
                    stats_map = {c.id: s for c, s in zip(running, results)}
        out = []
        for c in containers:
            a = c.attrs
            state = a.get("State", {})
            net = a.get("NetworkSettings", {}).get("Networks", {})
            out.append({
                "id": c.id,
                "short_id": c.short_id,
                "name": c.name,
                "image": (a.get("Config", {}).get("Image") or ""),
                "image_id": a.get("Image", "")[:19],
                "status": a.get("Status", c.status),
                "state": state.get("Status", c.status),
                "created": a.get("Created", ""),
                "started_at": state.get("StartedAt", ""),
                "finished_at": state.get("FinishedAt", ""),
                "restart_count": state.get("RestartCount", 0),
                "networks": {n: v.get("IPAddress", "") for n, v in net.items()},
                "ports": a.get("NetworkSettings", {}).get("Ports", {}) or {},
                "stats": stats_map.get(c.id, {}),
            })
        out.sort(key=lambda x: x["name"].lower())
        return out

    def inspect(self, container_id: str) -> dict[str, Any]:
        attrs = self.container(container_id).attrs
        cfg = attrs.get("Config", {})
        host = attrs.get("HostConfig", {})
        env = []
        for item in cfg.get("Env") or []:
            k, _, v = item.partition("=")
            sensitive = any(h in k.upper() for h in SENSITIVE_HINTS)
            env.append({"key": k, "value": "••••••••" if sensitive else v,
                        "sensitive": sensitive})
        return {
            "id": attrs.get("Id", ""), "name": attrs.get("Name", "").lstrip("/"),
            "image": cfg.get("Image", ""), "image_id": attrs.get("Image", ""),
            "state": attrs.get("State", {}), "created": attrs.get("Created", ""),
            "path": attrs.get("Path", ""), "args": attrs.get("Args", []),
            "env": env, "cmd": cfg.get("Cmd"), "entrypoint": cfg.get("Entrypoint"),
            "working_dir": cfg.get("WorkingDir", ""), "user": cfg.get("User", ""),
            "labels": cfg.get("Labels") or {},
            "restart_policy": host.get("RestartPolicy", {}),
            "networks": attrs.get("NetworkSettings", {}).get("Networks", {}) or {},
            "ports": attrs.get("NetworkSettings", {}).get("Ports", {}) or {},
            "mounts": attrs.get("Mounts", []) or [],
        }

    def reveal_env(self, container_id: str) -> list[dict[str, str]]:
        cfg = self.container(container_id).attrs.get("Config", {})
        return [{"key": k, "value": v}
                for item in cfg.get("Env") or []
                for k, _, v in [item.partition("=")]]

    def action(self, container_id: str, action: str) -> None:
        c = self.container(container_id)
        fn = {"start": c.start, "stop": c.stop, "restart": c.restart,
              "pause": c.pause, "unpause": c.unpause, "kill": c.kill}.get(action)
        if fn is None:
            raise ValueError(f"Unknown action '{action}'")
        try:
            fn()
            log.info("Container %s: %s OK", c.name, action)
        except APIError as exc:
            log.error("Container %s: %s failed: %s", c.name, action, exc)
            raise RuntimeError(exc.explanation or str(exc)) from exc

    def remove(self, container_id: str, force: bool = False, volumes: bool = False) -> None:
        c = self.container(container_id)
        name = c.name
        try:
            c.remove(force=force, v=volumes)
            log.warning("Container %s removed (force=%s, volumes=%s)", name, force, volumes)
        except APIError as exc:
            raise RuntimeError(exc.explanation or str(exc)) from exc

    def logs(self, container_id: str, tail: int = 500, timestamps: bool = True) -> bytes:
        c = self.container(container_id)
        return c.logs(stdout=True, stderr=True, tail=tail, timestamps=timestamps)

    def stream_logs(self, container_id: str, tail: int = 200) -> Iterable[bytes]:
        c = self.container(container_id)
        yield from c.logs(stdout=True, stderr=True, tail=tail,
                          timestamps=True, stream=True, follow=True)

    def stats(self, container_id: str) -> dict[str, Any]:
        return self._one_shot_stats(self.container(container_id))

    # -------------------------------------------------------------- images
    def list_images(self) -> list[dict[str, Any]]:
        containers = self.client.containers.list(all=True)
        used = {c.attrs.get("Image", "") for c in containers}
        used |= {c.image.id for c in containers}
        out = []
        for img in self.client.images.list():
            tags = img.tags or []
            tag_count = len(tags)
            if not tags:
                tags = ["<none>:<none>"]   # dangling / untagged image
            for tag in tags:
                repo, _, t = tag.rpartition(":")
                out.append({
                    "id": img.id, "short_id": img.short_id.replace("sha256:", ""),
                    "repo": repo or "<none>", "tag": t or "<none>",
                    "dangling": tag_count == 0, "tag_count": max(tag_count, 1),
                    "created": img.attrs.get("Created", ""),
                    "size": img.attrs.get("Size", 0),
                    "in_use": img.id in used,
                })
        out.sort(key=lambda x: (x["repo"], x["tag"]))
        return out

    def pull_image(self, reference: str) -> None:
        log.info("Pulling image %s", reference)
        self.client.images.pull(reference)

    def remove_image(self, image_id: str, force: bool = False) -> None:
        """Remove an image, always addressed by its image ID (never repo:tag,
        which is invalid for dangling '<none>:<none>' images)."""
        try:
            img = self.client.images.get(image_id)
        except NotFound:
            raise KeyError(f"Image '{image_id}' not found")
        except APIError as exc:
            raise RuntimeError(exc.explanation or str(exc)) from exc

        if not force:
            tag_count = len(img.tags or [])
            if tag_count > 1:
                raise RuntimeError(
                    "Image has multiple tags (" +
                    ", ".join(img.tags[:5]) +
                    ("…" if tag_count > 5 else "") +
                    "). Use force to remove all tags and the image.")
            consumers = [c for c in self.client.containers.list(all=True)
                         if c.attrs.get("Image") == img.id or
                         getattr(c.image, "id", None) == img.id]
            if consumers:
                names = ", ".join(sorted(f"'{c.name}' ({c.status})"
                                         for c in consumers[:5]))
                raise RuntimeError(
                    f"Image is currently used by container(s): {names}. "
                    "Remove them first or use force.")

        try:
            self.client.images.remove(img.id, force=force)
            log.warning("Image %s removed (force=%s)", img.id, force)
        except NotFound:
            raise KeyError(f"Image '{image_id}' not found")
        except APIError as exc:
            msg = exc.explanation or str(exc)
            log.error("Image remove failed for %s: %s", img.id, msg)
            if "is being used" in msg:
                raise RuntimeError(
                    "Image is currently used by a container. "
                    "Remove the container first or use force.") from exc
            if "invalid reference format" in msg:
                raise RuntimeError("Image could not be removed: invalid image reference.") from exc
            raise RuntimeError(msg) from exc

    def inspect_image(self, image_id: str) -> dict[str, Any]:
        try:
            return self.client.images.get(image_id).attrs
        except NotFound:
            raise KeyError(f"Image '{image_id}' not found")

    # ------------------------------------------------------------- volumes
    def list_volumes(self) -> list[dict[str, Any]]:
        usage: dict[str, list[str]] = {}
        for c in self.client.containers.list(all=True):
            for m in c.attrs.get("Mounts", []):
                if m.get("Type") == "volume" and m.get("Name"):
                    usage.setdefault(m["Name"], []).append(c.name)
        out = []
        for v in self.client.volumes.list():
            out.append({"name": v.name, "driver": v.attrs.get("Driver", ""),
                        "mountpoint": v.attrs.get("Mountpoint", ""),
                        "created": v.attrs.get("CreatedAt", ""),
                        "scope": v.attrs.get("Scope", ""),
                        "used_by": usage.get(v.name, [])})
        out.sort(key=lambda x: x["name"])
        return out

    def remove_volume(self, name: str, force: bool = False) -> None:
        try:
            v = self.client.volumes.get(name)
            v.remove(force=force)
            log.warning("Volume %s removed", name)
        except NotFound:
            raise KeyError(f"Volume '{name}' not found")
        except APIError as exc:
            raise RuntimeError(exc.explanation or str(exc)) from exc

    # ------------------------------------------------------------ networks
    def list_networks(self) -> list[dict[str, Any]]:
        out = []
        for n in self.client.networks.list():
            ipam = n.attrs.get("IPAM", {}).get("Config", []) or []
            containers = n.attrs.get("Containers", {}) or {}
            out.append({
                "id": n.short_id, "name": n.name, "driver": n.attrs.get("Driver", ""),
                "scope": n.attrs.get("Scope", ""),
                "subnet": ipam[0].get("Subnet", "") if ipam else "",
                "gateway": ipam[0].get("Gateway", "") if ipam else "",
                "internal": n.attrs.get("Internal", False),
                "containers": [c.get("Name", "") for c in containers.values()],
            })
        out.sort(key=lambda x: x["name"])
        return out

    def remove_network(self, name: str) -> None:
        try:
            n = self.client.networks.get(name)
            if n.attrs.get("Containers"):
                raise RuntimeError("Network still has connected containers")
            n.remove()
            log.warning("Network %s removed", name)
        except NotFound:
            raise KeyError(f"Network '{name}' not found")
        except APIError as exc:
            raise RuntimeError(exc.explanation or str(exc)) from exc


_service: DockerService | None = None
_init_error: str | None = None


def get_service() -> DockerService:
    global _service, _init_error
    if _service is None:
        try:
            _service = DockerService()
        except DockerUnavailable as exc:
            _init_error = str(exc)
            raise
    return _service


def reset_service() -> None:
    global _service, _init_error
    _service, _init_error = None, None
