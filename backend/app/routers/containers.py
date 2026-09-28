import asyncio
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse

from ..auth import require_auth, require_auth_ws
from ..deps import handle_errors, svc
from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/containers", tags=["containers"],
                   dependencies=[Depends(require_auth)])
# WebSocket routes cannot use HTTP bearer dependencies; auth handled manually.
ws_router = APIRouter(prefix="/api/containers", tags=["containers"])

_ID_RE = re.compile(r"^[a-f0-9]{4,64}$", re.I)


def valid_id(container_id: str) -> str:
    # Docker SDK also accepts names; allow them but reject weird chars.
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}", container_id):
        raise HTTPException(400, "Invalid container id/name")
    return container_id


@router.get("")
def list_containers(with_stats: bool = True):
    with handle_errors():
        return svc().list_containers(with_stats=with_stats)


@router.get("/{container_id}")
def get_container(container_id: str = Depends(valid_id)):
    with handle_errors():
        return svc().inspect(container_id)


@router.get("/{container_id}/env")
def reveal_env(container_id: str = Depends(valid_id)):
    with handle_errors():
        return svc().reveal_env(container_id)


@router.post("/{container_id}/{action}")
def container_action(action: str, container_id: str = Depends(valid_id)):
    if action not in {"start", "stop", "restart", "pause", "unpause", "kill"}:
        raise HTTPException(404, "Unknown action")
    with handle_errors():
        svc().action(container_id, action)
    return {"ok": True, "action": action, "id": container_id}


@router.delete("/{container_id}")
def remove_container(container_id: str = Depends(valid_id),
                     force: bool = False, volumes: bool = False):
    with handle_errors():
        svc().remove(container_id, force=force, volumes=volumes)
    return {"ok": True}


@router.get("/{container_id}/logs", response_class=PlainTextResponse)
def logs(container_id: str = Depends(valid_id),
         tail: int = Query(500, ge=1, le=100000), timestamps: bool = True):
    with handle_errors():
        data = svc().logs(container_id, tail=tail, timestamps=timestamps)
    return PlainTextResponse(data.decode("utf-8", errors="replace"))


@router.get("/{container_id}/logs/download")
def logs_download(container_id: str = Depends(valid_id),
                  tail: int = Query(5000, ge=1, le=100000)):
    with handle_errors():
        data = svc().logs(container_id, tail=tail, timestamps=True)
    name = container_id[:12]
    return StreamingResponse(
        iter([data]), media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="logs-{name}.txt"'})


@ws_router.websocket("/{container_id}/logs/stream")
async def logs_stream(ws: WebSocket, container_id: str, tail: int = 200):
    if not await require_auth_ws(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    gen_obj = None
    try:
        service = svc()
        loop = asyncio.get_running_loop()
        backlog = await loop.run_in_executor(None, service.logs, container_id,
                                             min(max(tail, 1), 10000), True)
        await ws.send_text(backlog.decode("utf-8", errors="replace"))
        gen_obj = service.stream_logs(container_id, tail=0)
        it = iter(gen_obj)
        # NOTE: `next(it, None)` avoids StopIteration being raised into the
        # executor future, which asyncio forbids.
        chunk_task = asyncio.ensure_future(loop.run_in_executor(None, next, it, None))
        recv_task = asyncio.ensure_future(ws.receive_text())
        try:
            while True:
                done, _ = await asyncio.wait({chunk_task, recv_task},
                                             return_when=asyncio.FIRST_COMPLETED)
                if recv_task in done:
                    recv_task.result()          # raises WebSocketDisconnect on close
                    recv_task = asyncio.ensure_future(ws.receive_text())
                if chunk_task in done:
                    chunk = chunk_task.result()
                    if chunk is None:           # stream ended (container stopped/removed)
                        recv_task.cancel()
                        break
                    await ws.send_text(chunk.decode("utf-8", errors="replace"))
                    chunk_task = asyncio.ensure_future(
                        loop.run_in_executor(None, next, it, None))
        finally:
            recv_task.cancel()
            chunk_task.cancel()
        try:
            await ws.send_text("\n[stream ended — container stopped or removed]\n")
            await ws.close(code=1000)
        except Exception:
            pass
    except WebSocketDisconnect:
        pass
    except KeyError:
        try:
            await ws.close(code=4404)
        except Exception:
            pass
    except Exception as exc:
        log.error("log stream error: %s", exc)
        try:
            await ws.send_text(f"\n[stream error: {exc}]\n")
            await ws.close(code=1011)
        except Exception:
            pass
    finally:
        if gen_obj is not None:   # stop the docker follow-stream, no leak
            try:
                gen_obj.close()
            except Exception:
                pass


@router.get("/{container_id}/stats")
def stats(container_id: str = Depends(valid_id)):
    with handle_errors():
        return svc().stats(container_id)
