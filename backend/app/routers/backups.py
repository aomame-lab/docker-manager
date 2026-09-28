"""Backup creation, listing, restore preview and restore execution."""
import io
import logging

from fastapi import (APIRouter, Depends, File, Form, HTTPException, UploadFile)
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import backup as bk
from .. import restore as rs
from ..auth import require_auth
from ..config import settings
from ..deps import handle_errors, svc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["backups"],
                   dependencies=[Depends(require_auth)])


class BackupRequest(BaseModel):
    container_ids: list[str]
    include_volumes: bool = True


@router.post("/backups", status_code=201)
def create_backup(body: BackupRequest):
    try:
        path = bk.create_backup(svc(), body.container_ids, body.include_volumes)
    except bk.BackupError as exc:
        raise HTTPException(400, str(exc))
    except KeyError as exc:
        raise HTTPException(404, exc.args[0])
    return {"ok": True, "filename": path.name, "size": path.stat().st_size}


@router.get("/backups")
def list_backups():
    return bk.list_backups()


@router.get("/backups/{filename}/download")
def download_backup(filename: str):
    if "/" in filename or ".." in filename or not filename.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid filename")
    path = settings.backup_dir / filename
    if not path.exists():
        raise HTTPException(404, "Backup not found")
    return FileResponse(path, filename=filename, media_type="application/gzip")


@router.delete("/backups/{filename}")
def delete_backup(filename: str):
    if "/" in filename or ".." in filename or not filename.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid filename")
    path = settings.backup_dir / filename
    if not path.exists():
        raise HTTPException(404, "Backup not found")
    path.unlink()
    log.warning("Backup %s deleted", filename)
    return {"ok": True}


@router.get("/backups/{filename}/summary")
def summarize_stored_backup(filename: str):
    if "/" in filename or ".." in filename or not filename.endswith(".tar.gz"):
        raise HTTPException(400, "Invalid filename")
    path = settings.backup_dir / filename
    if not path.exists():
        raise HTTPException(404, "Backup not found")
    try:
        with open(path, "rb") as fh:
            return bk.backup_summary(svc(), fh)
    except bk.BackupError as exc:
        raise HTTPException(400, str(exc))


async def _read_upload(file: UploadFile) -> io.BytesIO:
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"Upload exceeds {settings.max_upload_mb} MB limit")
    if not data[:2] == b"\x1f\x8b" and not data.startswith(b"docker-manager-backup"):
        # tar.gz should start with gzip magic; plain tar accepted too
        if data[257:262] != b"ustar":
            raise HTTPException(400, "File is not a tar/tar.gz archive")
    return io.BytesIO(data)


@router.post("/restore/preview")
async def restore_preview(file: UploadFile = File(...)):
    buf = await _read_upload(file)
    try:
        return bk.backup_summary(svc(), buf)
    except bk.BackupError as exc:
        raise HTTPException(400, str(exc))


@router.post("/restore")
async def restore_backup(file: UploadFile = File(...),
                         renames: str = Form("{}"),
                         start: bool = Form(False),
                         restore_volumes: bool = Form(True)):
    import json
    buf = await _read_upload(file)
    try:
        ren = json.loads(renames)
        if not isinstance(ren, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "Invalid renames mapping")
    with handle_errors():
        return rs.restore_backup(svc(), buf, renames=ren, start=start,
                                 restore_volumes=restore_volumes)
