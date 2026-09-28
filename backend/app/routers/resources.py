"""Images, volumes, networks, system info."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import require_auth
from ..config import settings
from ..deps import handle_errors, svc

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["resources"],
                   dependencies=[Depends(require_auth)])


@router.get("/system")
def system_info():
    return {"engine": svc().info(), "settings": {
        "app_name": settings.app_name, "app_version": settings.app_version,
        "poll_interval": settings.poll_interval,
        "log_default_lines": settings.log_default_lines,
        "backup_dir": str(settings.backup_dir),
        "max_upload_mb": settings.max_upload_mb,
        "auth_enabled": bool(settings.auth_token),
    }}


# ------------------------------------------------------------------- images
class PullRequest(BaseModel):
    reference: str = Field(min_length=1, max_length=255)


@router.get("/images")
def list_images():
    with handle_errors():
        return svc().list_images()


@router.post("/images/pull", status_code=202)
def pull_image(body: PullRequest):
    with handle_errors():
        svc().pull_image(body.reference)
    return {"ok": True, "reference": body.reference}


@router.get("/images/{image_id}")
def inspect_image(image_id: str):
    with handle_errors():
        return svc().inspect_image(image_id)


@router.delete("/images/{image_id}")
def remove_image(image_id: str, force: bool = False):
    with handle_errors():
        svc().remove_image(image_id, force=force)
    return {"ok": True}


# ------------------------------------------------------------------ volumes
@router.get("/volumes")
def list_volumes():
    with handle_errors():
        return svc().list_volumes()


@router.delete("/volumes/{name}")
def remove_volume(name: str, force: bool = False):
    with handle_errors():
        svc().remove_volume(name, force=force)
    return {"ok": True}


# ----------------------------------------------------------------- networks
@router.get("/networks")
def list_networks():
    with handle_errors():
        return svc().list_networks()


@router.delete("/networks/{name}")
def remove_network(name: str):
    if name in ("bridge", "host", "none"):
        raise HTTPException(400, "Built-in networks cannot be removed")
    with handle_errors():
        svc().remove_network(name)
    return {"ok": True}
