"""Optional bearer-token authentication (disabled when AUTH_TOKEN is empty)."""
from fastapi import Depends, HTTPException, Request, WebSocket
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

_bearer = HTTPBearer(auto_error=False)


async def require_auth(request: Request,
                       cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    if not settings.auth_token:
        return
    if cred and cred.credentials == settings.auth_token:
        return
    if request.query_params.get("token") == settings.auth_token:  # SSE convenience
        return
    raise HTTPException(status_code=401, detail="Unauthorized")


async def require_auth_ws(ws: WebSocket) -> bool:
    if not settings.auth_token:
        return True
    if ws.query_params.get("token") == settings.auth_token:
        return True
    auth = ws.headers.get("authorization", "")
    return auth == f"Bearer {settings.auth_token}"
