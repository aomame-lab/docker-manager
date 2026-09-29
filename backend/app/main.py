"""Docker Manager — FastAPI application entrypoint."""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .docker_service import get_service
from .routers import backups, containers, resources

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("docker-manager")

BASE_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = BASE_DIR / "frontend" / "static"

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting %s on %s:%s", settings.app_name, settings.host, settings.port)
    log.info("Backup directory: %s", settings.backup_dir)
    try:
        info = get_service().info()
        if info.get("connected"):
            log.info("Connected to Docker Engine %s", info.get("version"))
        else:
            log.error("Docker Engine NOT available: %s", info.get("error", "unknown"))
    except Exception as exc:
        log.error("Docker Engine NOT available: %s", exc)
    yield


app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan,
              description="Lightweight self-hosted Docker container manager")
app.include_router(containers.router)
app.include_router(containers.ws_router)
app.include_router(resources.router)
app.include_router(backups.router)


@app.get("/", include_in_schema=False)
def index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("{{APP_VERSION}}", settings.app_version)
    return HTMLResponse(html)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
