"""Dashboard application configuration REST API."""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, HttpUrl

from ..auth import require_auth
from ..dashboard_store import (
    create_app, delete_app, get_app, list_apps, update_app,
)
from ..deps import handle_errors

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"],
                   dependencies=[Depends(require_auth)])


class AppBase(BaseModel):
    appId: str = Field(min_length=1, max_length=128,
                       pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
    containerName: str | None = Field(default=None, max_length=255)
    imageDigest: str | None = Field(default=None, max_length=255)
    displayName: str | None = Field(default=None, max_length=255)
    url: HttpUrl | None = Field(default=None, max_length=2048)
    description: str | None = Field(default=None, max_length=1024)
    icon: str | None = Field(default=None, max_length=128)
    group: str | None = Field(default=None, max_length=128)
    order: int = 0


class AppCreate(AppBase):
    pass


class AppUpdate(BaseModel):
    containerName: str | None = Field(default=None, max_length=255)
    imageDigest: str | None = Field(default=None, max_length=255)
    displayName: str | None = Field(default=None, max_length=255)
    url: HttpUrl | None = Field(default=None, max_length=2048)
    description: str | None = Field(default=None, max_length=1024)
    icon: str | None = Field(default=None, max_length=128)
    group: str | None = Field(default=None, max_length=128)
    order: int | None = None


class AppResponse(AppBase):
    createdAt: str
    updatedAt: str


def _app_to_response(app: dict) -> dict:
    """Convert stored app dict to response format."""
    return {
        "appId": app["appId"],
        "containerName": app.get("containerName"),
        "imageDigest": app.get("imageDigest"),
        "displayName": app.get("displayName", app["appId"]),
        "url": app.get("url"),
        "description": app.get("description"),
        "icon": app.get("icon"),
        "group": app.get("group"),
        "order": app.get("order", 0),
        "createdAt": app["createdAt"],
        "updatedAt": app["updatedAt"],
    }


@router.get("/apps", response_model=list[AppResponse])
def list_dashboard_apps():
    """List all persisted dashboard application configurations."""
    with handle_errors():
        apps = list_apps()
        return [_app_to_response(a) for a in apps]


@router.post("/apps", response_model=AppResponse, status_code=status.HTTP_201_CREATED)
def create_dashboard_app(app: AppCreate):
    """Create a new dashboard application configuration."""
    with handle_errors():
        try:
            created = create_app(app.model_dump(mode="json"))
            return _app_to_response(created)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/apps/{app_id}", response_model=AppResponse)
def get_dashboard_app(app_id: str):
    """Get a single dashboard application configuration by appId."""
    with handle_errors():
        app = get_app(app_id)
        if app is None:
            raise HTTPException(status_code=404, detail="Application not found")
        return _app_to_response(app)


@router.put("/apps/{app_id}", response_model=AppResponse)
def update_dashboard_app(app_id: str, app: AppUpdate):
    """Update an existing dashboard application configuration."""
    with handle_errors():
        try:
            updated = update_app(app_id, app.model_dump(mode="json", exclude_unset=True))
            return _app_to_response(updated)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/apps/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard_app(app_id: str):
    """Delete a dashboard application configuration."""
    with handle_errors():
        try:
            delete_app(app_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc