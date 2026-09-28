"""Shared dependencies: docker service access and uniform error mapping."""
import logging
from contextlib import contextmanager

from docker.errors import DockerException
from fastapi import HTTPException

from .docker_service import DockerService, DockerUnavailable, get_service

log = logging.getLogger(__name__)


def svc() -> DockerService:
    try:
        return get_service()
    except DockerUnavailable:
        raise HTTPException(503, "Docker Engine is not available")


@contextmanager
def handle_errors():
    try:
        yield
    except HTTPException:
        raise
    except KeyError as exc:
        raise HTTPException(404, exc.args[0]) from exc
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except DockerUnavailable:
        raise HTTPException(503, "Docker Engine is not available")
    except DockerException as exc:
        log.error("Docker API error: %s", exc)
        raise HTTPException(502, "Docker Engine error") from exc
    except Exception:
        log.exception("Unexpected API error")
        raise HTTPException(500, "Internal server error") from None
