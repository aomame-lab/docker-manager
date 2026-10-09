# AGENTS.md — Docker Manager

Authoritative persistent context for coding agents working on this repository.

**This document describes the code that exists NOW.** Where a future direction is
agreed but not yet implemented, it is kept strictly in a separate, clearly labelled
section at the end. Never treat the future direction as a description of current
behaviour.

- Generated against Git baseline commit `b5bb64a` ("Fix frontend asset caching").
- Source of truth = the repository source code. If this file and the code
  disagree, the code is correct and this file must be updated.

---

## 1. Project Overview

Docker Manager is a small, self-hosted web interface for monitoring and managing
Docker containers, images, volumes and networks on a **single** Docker host.

Design intent, as stated in `README.md` and honoured by the code:

> "Lightweight web interface for managing Docker containers."

Constraints that follow from "lightweight":

- No database. No external services. No message queue. No cache server.
- No build step for the frontend (vanilla JS + Bootstrap 5 from CDN).
- Only 7 Python dependencies, all runtime deps except `pytest`/`httpx`.
- Single Docker Engine socket connection.
- The whole application is ~2,900 lines of application code (backend + frontend).

Current application version: `APP_VERSION` default `"1.0.0"` (`backend/app/config.py:11`),
exposed in the footer as `V.1.0.0`.

---

## 2. Current Architecture

### 2.1 High level

```
Browser (vanilla JS SPA)
   │  HTTP/JSON  +  1 WebSocket (log streaming only)
   ▼
Uvicorn → FastAPI (backend/app)
   │
   ▼
DockerService (single wrapper around the Docker Engine API via docker SDK)
   │
   ▼
Docker Engine socket (/var/run/docker.sock)
```

There is no ORM, no queue, no worker process, no background scheduler and no
persistent application state. All state lives in the browser's `state` object or
is re-derived from the Docker Engine on each request.

### 2.2 Backend

- **Framework**: FastAPI `0.115.6` (Starlette), served by Uvicorn `0.32.1`.
- **Entry point**: `backend/app/main.py`
  - `app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)`
  - `lifespan` logs startup info and probes the Docker Engine once
    (`main.py:22-34`). A missing Engine does **not** prevent startup; individual
    endpoints return `503`.
  - Mounts `StaticFiles` at `/static` serving `frontend/static` (`main.py:52`).
  - `GET /` reads `index.html` from disk on **every request** and substitutes
    `{{APP_VERSION}}` (`main.py:45-49`).
- **Routers** (`backend/app/routers/`), all registered in `main.py:39-42`:
  | Module | Router | Prefix | Tags |
  |---|---|---|---|
  | `containers.py` | `router` | `/api/containers` | containers |
  | `containers.py` | `ws_router` | `/api/containers` | containers (WebSocket) |
  | `resources.py` | `router` | `/api` | resources |
  | `backups.py` | `router` | `/api` | backups |
- **Services**: there is no separate service layer per domain. `docker_service.py`
  is the single Docker SDK wrapper; `backup.py` and `restore.py` are the
  "service" modules for archival. Routers call `deps.svc()` to obtain the
  Docker client wrapper.
- **Configuration**: `backend/app/config.py`, a `pydantic-settings.BaseSettings`
  instance reading env vars plus a `.env` file (`SettingsConfigDict(env_file=".env", extra="ignore")`).
  Import-time side effect creates `BACKUP_DIR`, falling back to `./backups` if
  the configured path is not writable (`config.py:24-28`).
- **Error handling**: `backend/app/deps.py`.
  - `svc()` → `503 "Docker Engine is not available"` when the client cannot be built.
  - `handle_errors()` context manager maps exceptions uniformly:
    `HTTPException` re-raised; `KeyError` → 404; `RuntimeError`/`ValueError` → 400;
    `DockerUnavailable` → 503; `DockerException` → 502; anything else → 500 with
    `log.exception`.
  - Container id/name validated by `valid_id` (`containers.py:21-25`) with
    regex `^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$` → 400 on failure.
    Note `_ID_RE` at `containers.py:18` is dead code (never referenced).
- **Logging**: `logging.basicConfig` in `main.py:14-16`, format
  `%(asctime)s %(levelname)-7s %(name)s: %(message)s`, level from
  `LOG_LEVEL`. Logger names: `docker-manager` (app), `__name__` per module.
  No file logging, no rotation, no third-party logging framework.
- **Auth**: `backend/app/auth.py`, optional bearer token.
- **Static hosting**: no templating engine, no SPA router — one HTML file, all
  pages are `<section>` elements toggled by `d-none`.

### 2.3 Frontend

- **HTML**: a single page, `frontend/static/index.html` (368 lines).
  - `<nav class="navbar topbar">` — brand, `#engine-status`, `#btn-refresh`,
    and the `#global-progress` operation indicator.
  - `ul#main-tabs.dm-tabs` — 7 pill buttons with `data-page`:
    `dashboard`, `containers`, `images`, `volumes`, `networks`, `backups`, `about`.
  - 7 `<section class="page">` blocks: `#page-dashboard`, `#page-containers`,
    `#page-images`, `#page-volumes`, `#page-networks`, `#page-backups`, `#page-about`.
    Exactly one is visible at a time.
  - 3 modals: `#confirm-modal` (generic confirm), `#details-modal`
    (`modal-xl`, container details), `#logs-modal` (`modal-xl`, logs + live stream).
    **There is no shell/terminal modal.**
  - `footer.app-footer` — `#app-version`, `#engine-footer`.
  - `#toasts` container.
  - CDN assets: Bootstrap 5.3.3 CSS + JS bundle, Bootstrap Icons 1.11.3.
    This is the only external network dependency at runtime.
- **JavaScript**: one file, `frontend/static/app.js` (1,036 lines), no modules,
  no bundler, no framework. `"use strict"` at the top.
  - A single module-level `state` object (`app.js:4-17`).
  - A `Pagination` class (`app.js:41-115`) generic over a key prefix, with a
    special-case branch for `containers` which uses unprefixed state keys
    (`pageSize`, `currentPage`, `search`, `sort`, `filter`) for historical
    reasons. Four instances: `containersPagination`, `imagesPagination`,
    `volumesPagination`, `networksPagination`.
  - Delegated event handling on `document` for container action buttons
    (`data-act`, `data-logs`, `data-details`, `data-remove`) —
    `app.js:884-917`.
  - Direct listeners for images/volumes/networks remove buttons, re-attached on
    each render.
- **CSS**: one file, `frontend/static/style.css` (158 lines).
  - CSS custom properties define the theme: `--dm-bg #0a0f1a`, `--dm-card #101828`,
    `--dm-border #1e2a3d`, `--dm-accent #38bdf8`, `--dm-accent-dim #0e7490`,
    `--dm-text #d7e1ec`.
  - Bootstrap 5 is themed via CSS variables and a few overrides
    (`--bs-table-bg`, `--bs-table-color`, `--bs-table-hover-bg`).
  - No preprocessor, no CSS framework beyond Bootstrap, no dark/light toggle.
  - `html[data-bs-theme="dark"]` is hard-coded in `index.html:2`.
- **API communication**: one helper, `api(path, opts)` (`app.js:123-131`).
  Plain `fetch`. On non-2xx it tries to read `detail` from a JSON body and
  throws `Error(message)`. No retries, no auth header injection, no
  cancellation, no request deduplication. **Note:** when `AUTH_TOKEN` is set the
  frontend does **not** send the token — see Known Limitations.
  The `api()` helper handles `204 No Content` by returning `null` instead of
  attempting to parse JSON. For endpoints that return `204 No Content` (e.g.,
  `DELETE /api/dashboard/apps/{appId}`), callers should use `authFetch` directly
  to avoid JSON parsing errors on empty responses.

### 2.4 Docker integration

- **Socket**: `settings.docker_socket`, default `unix:///var/run/docker.sock`.
  Bind-mounted read/write into the container by `docker-compose.yml:9`.
- **Client**: `docker.DockerClient(base_url=...)` + `ping()` in
  `DockerService.__init__`. Failure raises `DockerUnavailable`.
- **Singleton + mock seam**: module-level `_service` with `get_service()` and
  `reset_service()` (`docker_service.py:315-332`). This is exactly what the test
  suite patches, which is why the tests need no Docker daemon.
- **Container discovery**: `client.containers.list(all=True)`. No filtering, no
  labels, no compose-project parsing. Everything on the host appears.
- **Statistics**: `_one_shot_stats(container)` calls `container.stats(stream=False)`
  and computes `cpu_percent` from `cpu_stats` vs `precpu_stats` deltas
  (`docker_service.py:55-81`). Network RX/TX and block I/O are also computed and
  returned in the JSON, but the frontend never renders them.
  `list_containers()` fans these out over a `ThreadPoolExecutor(max_workers=min(8, len(running)))`
  for running containers only (`docker_service.py:86-91`).
  Stats are best-effort: any exception returns `{}`.
- **Logs**: `c.logs(stdout=True, stderr=True, tail=..., timestamps=True)` for
  the snapshot; `c.logs(..., stream=True, follow=True)` for the follow stream.
- **Volume data export/import**: uses an `alpine:latest` helper container via
  `containers.run(..., remove=True, detach=False)` mounting the named volume and
  the backup directory. No docker CLI is used inside the container.
  See `backup.py:184-201` and `restore.py:71-76`.
  This means `alpine:latest` must be present on the host.

---

## 3. Backend Structure

```
backend/app/
├── __init__.py            (empty)
├── main.py                FastAPI app, lifespan, static mount, index route
├── config.py              Settings (pydantic-settings), backup dir bootstrap
├── docker_service.py      DockerService — the ONLY Docker SDK caller
├── deps.py                svc() dependency + handle_errors() error mapping
├── auth.py                require_auth (HTTP) / require_auth_ws (WebSocket)
├── backup.py              portable backup create / list / validate / summarize
├── restore.py             restore execution from a validated archive
├── dashboard_store.py     dashboard application config persistence (JSON file)
└── routers/
    ├── __init__.py        (empty)
    ├── containers.py      container CRUD-ish ops, logs, log stream WS, stats
    ├── resources.py       /api/system, images, volumes, networks
    ├── backups.py         backup create/list/download/delete, restore preview/run
    └── dashboard.py       dashboard application config CRUD API
```

Dependency direction is strictly inward: `routers → deps → docker_service → config`.
`backup.py` / `restore.py` import `docker_service` only for the type hint and
call `svc.client` directly.

### 3.1 Complete API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | no | `index.html` with `{{APP_VERSION}}` substituted |
| GET | `/static/*` | no | StaticFiles mount |
| GET | `/api/system` | yes | Engine info + effective settings |
| GET | `/api/containers` | yes | List all containers (`?with_stats=true` default) |
| GET | `/api/containers/{id}` | yes | Full inspect (env masked) |
| GET | `/api/containers/{id}/env` | yes | Reveal unmasked env |
| POST | `/api/containers/{id}/{action}` | yes | `start\|stop\|restart\|pause\|unpause\|kill` |
| DELETE | `/api/containers/{id}` | yes | Remove (`?force=&volumes=`) |
| GET | `/api/containers/{id}/logs` | yes | Log snapshot, `PlainTextResponse` (`?tail=`) |
| GET | `/api/containers/{id}/logs/download` | yes | Log attachment (`?tail=`, default 5000) |
| **WS** | `/api/containers/{id}/logs/stream` | query/header token | Follow log stream |
| GET | `/api/containers/{id}/stats` | yes | One-shot stats |
| GET | `/api/images` | yes | List images (one row per tag) |
| POST | `/api/images/pull` | yes | Pull, `202` |
| GET | `/api/images/{image_id}` | yes | Raw image attrs |
| DELETE | `/api/images/{image_id}` | yes | Remove by **ID** (`?force=`) |
| GET | `/api/volumes` | yes | List + `used_by` |
| DELETE | `/api/volumes/{name}` | yes | Remove (`?force=`) |
| GET | `/api/networks` | yes | List + connected containers |
| DELETE | `/api/networks/{name}` | yes | Remove; 400 for `bridge`/`host`/`none` |
| POST | `/api/backups` | yes | Create backup, `201` |
| GET | `/api/backups` | yes | List stored backups |
| GET | `/api/backups/{filename}/download` | yes | Download tarball |
| DELETE | `/api/backups/{filename}` | yes | Delete tarball |
| GET | `/api/backups/{filename}/summary` | yes | Restore summary for stored backup |
| POST | `/api/restore/preview` | yes | Upload + summarize |
| POST | `/api/restore` | yes | Upload + restore (`renames`, `start`, `restore_volumes`) |
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/dashboard/apps` | yes | List persisted dashboard app configs |
| POST | `/api/dashboard/apps` | yes | Create dashboard app config, `201` |
| GET | `/api/dashboard/apps/{app_id}` | yes | Get single dashboard app config |
| PUT | `/api/dashboard/apps/{app_id}` | yes | Update dashboard app config |
| DELETE | `/api/dashboard/apps/{app_id}` | yes | Delete dashboard app config, returns `204 No Content` |
| POST | `/api/restore/preview` | yes | Upload + summarize |
| POST | `/api/restore` | yes | Upload + restore (`renames`, `start`, `restore_volumes`) |

Notes:
- Every `/api/*` HTTP route carries `Depends(require_auth)`.
- The WebSocket route is registered on a **separate** `ws_router` without the
  HTTP dependency, because HTTP bearer dependencies do not apply to WebSockets;
  `require_auth_ws` is called manually (`containers.py:82-86`).
- Path-traversal protection on backup filenames is a repeated inline check
  (`"/" in filename or ".." in filename or not filename.endswith(".tar.gz")`)
  in three handlers — `backups.py:43,53,65`.
- Interactive OpenAPI docs at `/docs` (FastAPI default, always exposed).

### 3.2 WebSocket log stream design

`containers.py:82-143`. Notable details:

- Manual auth, then `ws.accept()`.
- A backlog is fetched first via `run_in_executor` and sent as one message.
- Then `service.stream_logs(container_id, tail=0)` yields chunks, each pulled
  with `run_in_executor(None, next, it, None)`.
  `next(it, None)` is used deliberately: raising `StopIteration` into an
  executor future is forbidden by asyncio (see the comment at
  `containers.py:97-98`).
- Two concurrent tasks — `chunk_task` and `recv_task` — raced with
  `asyncio.wait(..., FIRST_COMPLETED)`. The `recv_task` exists only so that a
  client disconnect is observed promptly; closing it raises
  `WebSocketDisconnect`.
- Close codes: `4401` unauthorized, `4404` container not found, `1000`
  normal/stream-ended, `1011` stream error.
- `gen_obj.close()` in `finally` closes the Docker follow generator so the
  HTTP connection to the Engine is not leaked.
- No heartbeat/keepalive and no per-connection limit.

---

## 4. Frontend Structure

```
frontend/static/
├── index.html    single page, 7 sections, 3 modals
├── app.js        all application logic (1694 lines)
├── style.css     theme + component styles (278 lines)
├── logo-2.svg    app logo (navbar + favicon)
├── logo-1.png    alternate logo
└── aomame-lab-1.png  footer logo
```

### 4.1 `state` object (`app.js:4-22`)

```js
state = {
  containers, pollInterval: 5000, page: "dashboard",
  search: "", filter: "all", sort: "name",
  pageSize: 10, currentPage: 1,
  images: [], imagesSearch: "", imagesSort: "repo",
  imagesPageSize: 10, imagesCurrentPage: 1,
  volumes: [], volumesSearch: "", volumesSort: "name",
  volumesPageSize: 10, volumesCurrentPage: 1,
  networks: [], networksSearch: "", networksSort: "name",
  networksPageSize: 10, networksCurrentPage: 1,
  selected: Set(), restoreFile: null, restoreBuffer: null,
  logSocket: null, logContainer: null, pendingConfirm: null,
  containersInitialLoadComplete: false,
  // Frontend-only application tile configuration (not persisted)
  appConfig: {},
  // selfh.st icon index cache
  iconIndex: null,
  iconIndexPromise: null,
};
```

`state.settings` is assigned in `loadSystem()` but is **not** declared in the
object literal.

### 4.2 Rendering functions

| Function | Target | Notes |
|---|---|---|
| `loadSystem()` | navbar, footer, `#settings-list`, `#set-poll` | Called on every `refreshPage()` **and** at startup |
| `loadContainers()` | `state.containers` | Called by Dashboard *and* Containers |
| `renderSummary()` | `#summary-cards`, `#system-resources`, `#dashboard-apps`, dashboard pagination | **Dashboard renderer** (summary cards + application cards) |
| `renderContainers()` | `#container-tbody`, `#container-cards`, pagination | **Containers renderer** |
| `loadImages()` / `renderImages()` | `#images-tbody` | |
| `loadVolumes()` / `renderVolumes()` | `#volumes-tbody` | |
| `loadNetworks()` / `renderNetworks()` | `#networks-tbody` | |
| `loadBackups()` | `#backups-tbody` | |
| `renderRestorePreview(...)` | `#restore-preview` | Shared by upload + stored backup paths |
| `openDetails(id,name)` | `#details-modal` | |
| `openLogs(id,name)` / `renderLogs` / `loadLogText` | `#logs-modal` | |
| `showDashboardLoading(show)` | `#dashboard-apps` | Spinner only |
| `renderSystemResources()` | `#system-resources` | System resources cards (Dashboard only) |
| `renderDashboardPagination()` | `#dashboard-pagination` | Dashboard pagination controls |

### 4.3 Loading / progress states

Two distinct mechanisms:

1. **Per-area spinner** — `showDashboardLoading(true)` renders a spinner row
   into `#dashboard-apps`. Controlled by `state.containersInitialLoadComplete`:
   it shows only on the **first** Dashboard load of the session
   (`app.js:235-239, 246, 262-264`).
2. **Global non-blocking indicator** — `showLoading(msg)` / `hideLoading()` /
   `withLoading(msg, fn)` / `withBusy(btn, fn)` (`app.js:145-168`).
   Lives inside the sticky topbar (`#global-progress`), so it stays visible
   while the user navigates. Used for backup creation, restore summary,
   restore execution and inspect.
   All long operations are **synchronous** HTTP requests on the backend, so the
   indicator is indeterminate — there is no percentage and no server-sent
   progress.

`filteredImages/Volumes/Networks` return `[]` on API error but do **not** show a
loader; the restore/backup panels have their own inline spinners.

### 4.4 Navigation

`$$("#main-tabs .nav-link")` click handler (`app.js:185-193`):
toggles `active`, sets `state.page`, hides all `.page`, shows `#page-<page>`,
calls `clearContainerSelection()`, then `refreshPage()`.
`refreshPage()` always calls `loadSystem()` and then the page-specific loader
via an inline lookup map (`app.js:195-200`).
There is **no** deep-linking, no URL hash routing, no scroll restoration.

### 4.5 Polling

`app.js:1860-1867`:

```js
let pollTimer = null;
function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (["dashboard", "containers"].includes(state.page)) loadContainers();
  }, state.pollInterval);
}
```

- One single timer. It only calls `loadContainers()` and only on the Dashboard
  or Containers page.
- It **does not** poll `/api/system`, so the navbar engine badge and the footer
  can go stale indefinitely until a page change or `#btn-refresh`.
- `state.pollInterval` is initialised to the hard-coded `5000`, *not* from
  `settings.poll_interval`; it is only overwritten by the About page input
  `#set-poll` (`app.js:1021-1023`). Changing it restarts the timer.

### 4.6 Search / filter / sort / pagination

Shared pattern per resource:

- `filteredX()` filters the in-memory array and returns a sorted **copy**.
- Search matches a lowercase substring across several fields.
- Sort keys are a map of accessor lambdas; numeric/date sorts negate the value
  to get a descending sort.
- Filter (containers only) maps `stopped` → `["exited","created","dead"]`.
- Every control change calls `resetPage()` then the renderer.
- `Pagination.getPaginatedList` slices; `pageSize === -1` means "all".
- `Pagination.render` writes "Showing X–Y of Z" and hides the controls when
  there is a single page or size is "all".

Container filter/sort state is **shared** between the Dashboard and the
Containers page (same `state.search` / `state.filter` / `state.sort` /
`pageSize` / `currentPage`), because both use `containersPagination`. Editing the
Dashboard search therefore changes the Containers page search box and vice
versa; the two search inputs are also never synchronised to each other's
current value.

### 4.7 Modals

- `#confirm-modal` — generic. `confirmModal(title, bodyHtml, okLabel, cb, danger)`
  stores `cb` in `state.pendingConfirm`; `#confirm-ok` hides the modal and
  invokes it. `danger` switches the button between `btn-danger` and
  `btn-warning`. The HTML body is trusted and injected with `innerHTML`
  (call sites escape dynamic values with `esc()`).
- `#details-modal` — container details, `modal-xl modal-dialog-scrollable`.
- `#logs-modal` — logs, `modal-xl modal-dialog-scrollable`.
- Bootstrap modals are instantiated with `getOrCreateInstance`; teardown is
  handled by Bootstrap's own `hidden.bs.modal` events.

### 4.8 Escape helper

`app.js:37-38`:

```js
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&", "<": "<", ">": ">", '"': "\"", "'": "'" }[c]));
```

**This is a latent bug.** The replacement map maps each character to itself, so
`esc()` is effectively a no-op apart from the `?? ""` normalisation. Every call
site believes it is escaping HTML. Any change to a container name, image name,
label, env value, volume name, network name or backup filename is currently
rendered as raw HTML through `innerHTML`. Do not "fix" this casually — either
fix `esc` properly (and re-test every rendering path) or switch the affected
renderers to `textContent`.

### 4.9 Asset caching / cache busting

Implemented as of baseline commit `b5bb64a`:

- `main.py` reads `index.html` **per request** (not cached at import time), so
  `{{APP_VERSION}}` is always current.
- `index.html` appends `?v={{APP_VERSION}}` to both local assets:
  `style.css?v={{APP_VERSION}}` (line 10) and `app.js?v={{APP_VERSION}}`
  (line 366).
- Consequence: busting keys off `APP_VERSION`, so **bumping `APP_VERSION` is
  required for a frontend change to reach a cached browser.**

---

## 5. Docker Integration Reference

| Capability | Backend implementation | Endpoint |
|---|---|---|
| Client construction / ping | `DockerService.__init__`, `docker_service.py:31-36` | — |
| Engine version/OS | `DockerService.info()`, `docker_service.py:46-52` | `GET /api/system` |
| Container discovery (all states) | `list_containers()`, `docker_service.py:83-114` | `GET /api/containers` |
| CPU/RAM/network/block stats | `_one_shot_stats()`, `docker_service.py:55-81`, threaded in `list_containers` | `GET /api/containers/{id}/stats` |
| Single-container inspect | `inspect()`, `docker_service.py:116-138` | `GET /api/containers/{id}` |
| Unmasked env | `reveal_env()`, `docker_service.py:140-144` | `GET /api/containers/{id}/env` |
| start/stop/restart/pause/unpause/kill | `action()`, `docker_service.py:146-157` | `POST /api/containers/{id}/{action}` |
| Remove | `remove()`, `docker_service.py:159-166` | `DELETE /api/containers/{id}` |
| Logs (snapshot) | `logs()`, `docker_service.py:168-170` | `GET .../logs` |
| Logs (follow stream) | `stream_logs()`, `docker_service.py:172-175` | `WS .../logs/stream` |
| Images list (per tag, `in_use`) | `list_images()`, `docker_service.py:181-202` | `GET /api/images` |
| Image pull | `pull_image()`, `docker_service.py:204-206` | `POST /api/images/pull` |
| Image remove by ID | `remove_image()`, `docker_service.py:208-250` | `DELETE /api/images/{id}` |
| Image inspect | `inspect_image()`, `docker_service.py:252-256` | `GET /api/images/{id}` |
| Volumes list + `used_by` | `list_volumes()`, `docker_service.py:259-273` | `GET /api/volumes` |
| Volume remove | `remove_volume()`, `docker_service.py:275-283` | `DELETE /api/volumes/{name}` |
| Networks list (IPAM, members) | `list_networks()`, `docker_service.py:286-300` | `GET /api/networks` |
| Network remove | `remove_network()`, `docker_service.py:302-312` | `DELETE /api/networks/{name}` |
| Image save / load | `backup.create_backup`, `restore.restore_backup` | via `/api/backups`, `/api/restore` |
| Volume tar via `alpine` helper | `backup.py:184-201`, `restore.py:71-76` | via `/api/backups`, `/api/restore` |

Not present: no Docker Compose project discovery, no multi-host support, no
image build, no image tag/retag, no network create from the UI, no volume
create from the UI, no healthcheck inspection, no health-based alerting, no
resource limits editing, no log search, no `docker system df`, no host-level
CPU/memory/cgroup metrics.

---

## 6. Current Implemented Features

Status is verified against the code cited, not against `README.md` claims.

| # | Feature | Status | Evidence / Notes |
|---|---|---|---|
| 1 | Dashboard page | **Implemented** | `#page-dashboard`; `renderSummary()` `app.js:370-401` |
| 2 | Summary cards (6) | **Implemented** | Total / Running / Stopped / Restarting / CPU / Memory — `app.js:376-381` |
| 3 | Container list w/ auto-discovery | **Implemented** | `containers.list(all=True)`; sorted by name server-side `docker_service.py:113` |
| 4 | Containers page | **Implemented** | `#page-containers`; `renderContainers()` `app.js:403-435` |
| 5 | Responsive containers (table ≥md, cards <md) | **Implemented** | `#container-tbody` / `#container-cards`, `app.js:421-432` |
| 6 | Start / Stop / Restart | **Implemented** | `actionButtons()` `app.js:351-368`; `POST .../{action}` |
| 7 | Pause / Unpause | **Implemented** | Same, state-dependent button set |
| 8 | Kill | **Partially implemented** | Backend + API fully support `kill`; **no Kill button in the UI** (`app.js:351-368` never emits `act="kill"`). Reachable only via API. |
| 9 | Remove container | **Implemented** | `data-remove`; modal with force + anonymous-volumes checkboxes `app.js:899-914` |
| 10 | Confirmation modals | **Implemented** | `confirmModal()`; applied to stop/restart/kill, remove, image/volume/network/backup delete, backup create |
| 11 | Logs (snapshot) | **Implemented** | `GET .../logs`; tail selector 100/500/1000/5000 `index.html:330-332` |
| 12 | Logs download | **Implemented** | `GET .../logs/download`, anchor in `index.html:343-344` |
| 13 | Live Logs (WebSocket) | **Implemented** | `WS .../logs/stream` + `startStream()` `app.js:858-874`; Live/Disconnected indicator |
| 14 | Auto-scroll toggle | **Implemented** | `#logs-autoscroll` `app.js:841` |
| 15 | Timestamp highlighting in logs | **Implemented** | `renderLogs()` `app.js:836-842` (regex `<span class="ts">`) |
| 16 | Container Details modal | **Implemented** | `openDetails()` `app.js:776-817`; General / Configuration / Environment / Network / Mounts |
| 17 | Sensitive env masking | **Implemented** | `SENSITIVE_HINTS` `docker_service.py:19`; values → `••••••••` |
| 18 | Env reveal (opt-in) | **Implemented** | `#reveal-env` + `confirm()` warning; `GET .../env` |
| 19 | Published port visualization | **Implemented** | `renderPorts()` `app.js:328-349` |
| 20 | Clickable HTTP(S) ports | **Implemented** | Uses `location.hostname`, never assumes `localhost`; https for 443/8443 |
| 21 | Search | **Implemented** | Containers (name+image), images (repo/tag/id), volumes (name/driver/mountpoint), networks (name/driver/subnet) |
| 22 | Filter by state | **Implemented** | Containers only: all/running/exited/stopped/restarting/paused. Shared Dashboard↔Containers state. |
| 23 | Sort | **Implemented** | Containers: name/state/cpu/mem/created. Images: repo/tag/created/size. Volumes/Networks: name/driver. |
| 24 | Pagination | **Implemented** | `Pagination` class; 10/25/50/All; Dashboard + Containers + Images + Volumes + Networks |
| 25 | Multi-select + "Backup selected" | **Implemented** | `#sel-all`, `.sel` checkboxes, `#btn-backup-selected` |
| 26 | Images page | **Implemented** | `#page-images`; `renderImages()` `app.js:492-524` |
| 27 | Image pull | **Implemented** | `POST /api/images/pull` (`202`). **UI button `#btn-pull` exists in HTML (`index.html:162`) but has no JS listener — pull is API-only.** |
| 28 | Image remove (dangling-safe) | **Implemented** | Always by image ID; `in_use`/`tag_count` warnings; force for multi-tag/in-use |
| 29 | Volumes page | **Implemented** | `#page-volumes`; `renderVolumes()` `app.js:548-570` |
| 30 | Volume remove (in-use blocked) | **Implemented** | Button disabled when `used_by.length` |
| 31 | Networks page | **Implemented** | `#page-networks`; `renderNetworks()` `app.js:594-615` |
| 32 | Network remove | **Implemented** | Built-ins `bridge`/`host`/`none` get no button; backend also rejects with 400 |
| 33 | Backup creation | **Implemented** | Multi-select → `POST /api/backups`; optional volume data |
| 34 | Backup listing / download / delete | **Implemented** | `#page-backups`; `loadBackups()` `app.js:653-702` |
| 35 | Restore preview (upload) | **Implemented** | `POST /api/restore/preview`; `renderRestorePreview()` |
| 36 | Restore summary (stored backup) | **Implemented** | `GET /api/backups/{file}/summary` with inline spinner + scroll-into-view |
| 37 | Restore execution | **Implemented** | `POST /api/restore` with `renames`, `start`, `restore_volumes` |
| 38 | Rename on conflict | **Implemented** | Per-conflict `rename-in` inputs → `renames` JSON map; never overwrites silently |
| 39 | Conflict detection | **Implemented** | Name conflicts + host-port conflicts (`backup.py:254-272`) |
| 40 | Path-traversal protection (archive) | **Implemented** | `_safe_member()` `backup.py:43-47`; `safe_extract()` `backup.py:50-57` uses `tar.extractall(filter="data")` |
| 41 | Path-traversal protection (filenames) | **Implemented** | Inline checks in `backups.py:43,53,65` |
| 42 | Atomic backup publish | **Implemented** | Writes `.tmp` then `replace()`; incomplete archive never listed |
| 43 | Upload size limit | **Implemented** | `MAX_UPLOAD_MB`, `backups.py:77-80` → 413 |
| 44 | Global progress indicator | **Implemented** | `withLoading()` + `#global-progress` in topbar |
| 45 | Button double-submit guard | **Implemented** | `withBusy()`, plus explicit `btn.disabled` checks |
| 46 | Toasts | **Implemented** | `toast(msg, ok)` `app.js:133-140` |
| 47 | Authentication (bearer token) | **Partially implemented** | Backend enforcement is complete (`require_auth`, `require_auth_ws`). **The frontend never sends the token** — no header, no login form, no token storage. Setting `AUTH_TOKEN` therefore locks out the UI while the API remains reachable with a hand-crafted header. See Known Limitations. |
| 48 | About / System information | **Implemented** | `#page-about`; app name, backup dir, max upload, default log lines, auth status; polling interval editable 2–60s |
| 49 | Footer version + live engine info | **Implemented** | `V.{app_version}`, `Docker {version} · API {api} · {os}` — only refreshed on `loadSystem()` |
| 50 | Engine connection badge | **Implemented** | `#engine-status` ok/err |
| 51 | Dashboard application cards | **Implemented** | `#page-dashboard`; `renderSummary()` `app.js:785-860`; cards with name, status, icon, image; clickable name when URL available |
| 52 | Dashboard application configuration | **Implemented** | Edit modal (`#app-config-modal`), persist to `BACKUP_DIR/dashboard-apps.json`; fields: display name (defaults to container name), URL, description, icon, group, order |
| 53 | Dashboard application persistence | **Implemented** | Server-side JSON (`BACKUP_DIR/dashboard-apps.json`); survives browser refresh & restart; atomic writes; `model_dump(mode="json")` for HttpUrl serialization |
| 54 | Dashboard application API | **Implemented** | `GET/POST/PUT/DELETE /api/dashboard/apps`; authenticated; `appId` = container name (stable) |
| 55 | Manual application creation | **Implemented** | "Add application" button (`#btn-add-app`) creates manual apps with `type: "manual"`; unique `appId` via `generateManualAppId()` (`app.js:115-119`); no container required; reuses same modal and persistence; manual apps persist across reloads/restarts |
| 56 | Inferred container URLs | **Implemented** | `getEffectiveUrl()` `app.js:104-109` returns saved URL > inferred URL > null; `inferContainerUrl()` `app.js:1483-1499` derives HTTP(S) URL from published TCP ports; card name clickable immediately without modal save; inferred URLs never persisted; **not applied to manual apps** |
| 57 | Selfh.st icon search & automatic matching | **Implemented** | `loadIconIndex()` `app.js:51-78` fetches from jsDelivr CDN; cached in memory; `searchIcons()` `app.js:80-90`; `renderAppIcon()` `app.js:33-58` priority: explicit icon > auto-match > fallback; `findAutoIconMatch()` `app.js:115-138` exact normalized match on slug/name, then token-based unambiguous match; network/index failure never blocks Dashboard; fallback `/static/logo-2.svg`; **auto-match skipped for manual apps** |
| 58 | Group autocomplete | **Implemented** | `setupGroupAutocomplete()` `app.js:1623-1728`; suggestions from `state.appConfig`; case-insensitive dedup; prefix matches before substring; Arrow Up/Down/Enter/Escape; click selects exact group; users may type new group; empty group / "Other" preserved |
| 59 | Tile deletion from edit modal | **Implemented** | Delete button in `#app-config-modal`; native `confirm()` dialog; calls `DELETE /api/dashboard/apps/{appId}`; on success reloads config, hides modal, re-renders dashboard; never stops/removes underlying Docker container |
| 60 | Duplicate display-name prevention | **Implemented** | Backend validation in `dashboard_store.py` (`_check_duplicate_display_name`); case-insensitive, trimmed comparison; rejects empty/whitespace; excludes current app on update; applies to both manual and Docker-backed apps |
| 61 | Footer version + live engine info | **Implemented** | `V.{app_version}`, `Docker {version} · API {api} · {os}` — only refreshed on `loadSystem()` |
| 62 | Engine connection badge | **Implemented** | `#engine-status` ok/err |
| 51 | Frontend asset cache busting | **Implemented** | `?v={{APP_VERSION}}` on `app.js` + `style.css`; `index.html` read per request |
| 52 | Responsive layout | **Implemented** | Bootstrap grid + `.d-md-none` / `.d-none d-md-block` swap |
| 53 | Dark/cyan theme | **Implemented** | CSS custom properties in `style.css:1-8` |
| 54 | Health checks / alerting | **Not implemented** | — |
| 55 | Charts / time-series graphs | **Not implemented** | Only instantaneous one-shot stats exist; no history is kept anywhere |
| 56 | Host-level system metrics (CPU/RAM/disk of the host itself) | **Not implemented** | `/api/system` returns Engine version only |
| 57 | Compose project management | **Not implemented** | — |
| 58 | Multi-host support | **Not implemented** | — |
| 59 | Scheduled backups / retention | **Not implemented** | — |
| 60 | Notifications | **Not implemented** | — |
| 61 | Container creation / editing from UI | **Not implemented** | Restore can create containers; the UI cannot otherwise |
| 62 | Real user accounts / roles | **Not implemented** | Single shared bearer token only |

---

## 7. Current Dashboard Behaviour

This section is a precise description of the Dashboard **as it exists today**.

### 7.1 Layout (DOM order in `#page-dashboard`)

1. `<div class="row g-3" id="summary-cards">` — populated by `renderSummary()`.
2. `<div class="row g-3 mt-4" id="system-resources">` — Docker Engine / resource summary cards.
3. `<h6 class="mt-4 mb-2 text-muted">Applications</h6>` — static label.
4. Toolbar `<div class="d-flex flex-wrap gap-2 mb-3 align-items-center">`:
   - `#dashboard-search` (`form-control-sm`, max-width 300px)
   - `#dashboard-filter-state` — `all | running | exited | stopped | restarting | paused`
   - `#dashboard-sort-by` — `name | state | cpu | mem | created`
   - `#dashboard-page-size` — `10 | 25 | 50 | all` (default 10)
5. `<div class="row g-3" id="dashboard-apps">` — application card grid (grouped).
6. `<nav id="dashboard-pagination">` — pagination info, prev/next, page indicator.

### 7.2 Summary cards

`renderSummary()` `app.js:370-385`. Exactly **six** `.dm-card.stat-card`
elements in a `.row.g-3`, each `col-6 col-md-4 col-lg-2`:

| Label | Value | Icon | Source |
|---|---|---|---|
| Total | `state.containers.length` | `boxes` | all states |
| Running | count `state === "running"` | `play-circle` | |
| Stopped | count `["exited","created","dead"]` | `stop-circle` | |
| Restarting | count `state === "restarting"` | `arrow-repeat` | |
| CPU | `sum(cpu_percent)` of running + `"%"`, 1 decimal | `cpu` | unnormalised sum — **not** divided by host CPU count, so it can exceed 100% |
| Memory | `sum(mem_usage)` of running, `fmtBytes` | `memory` | no percentage, no host total, no limit |

There are **no** charts, sparklines, history, host metrics, images/volumes/
networks counts, error counts, or uptime aggregates on the Dashboard.

### 7.3 Application cards (grouped, paginated)

Rendered by `renderSummary()` `app.js:785-860`. Cards are grouped by the
`group` field from `state.appConfig` (empty group → "Other"). Within each
group, cards are sorted by `order` then name. The flat list is paginated
via `containersPagination` (shared with Containers page).

Two types of applications exist:
- **Docker-backed apps** (`type: "docker"`): correspond to discovered Docker containers; `appId` = container name.
- **Manual apps** (`type: "manual"`): user-created entries with no container; `appId` = generated unique ID (e.g., `manual-<uuid>`).

Each card (`app-card`) shows:

- **Icon**: via `renderAppIcon(cfg.icon, containerName)` `app.js:33-58`.
  Priority: explicit saved icon (Bootstrap `bi-*` or selfh.st slug) →
  automatic selfh.st match (exact normalized slug/name, then token-based
  unambiguous match) → `/static/logo-2.svg` fallback.
  **Auto-match is skipped for manual apps.**
- **Name**: `cfg.name` (saved display name) or container name (Docker apps) / manual app ID (manual apps). If a URL is
  available (saved or inferred for Docker apps), the name is an `<a>` link opening in a new
  tab; otherwise plain text.
- **Status badge + indicator dot**: Docker apps show container state (`badge(x.state)` + colored dot). Manual apps show a neutral "Manual" badge.
- **Description**: `cfg.description` if set.
- **Image name**: `x.image` in muted small text (Docker apps only; hidden for manual apps).
- **Edit button** (hover/focus): opens `#app-config-modal` for that application.

### 7.4 URL behaviour (clickable names)

`getEffectiveUrl(appName, container)` `app.js:104-109` returns the effective
URL with priority:

1. **Saved URL** (`cfg.url`) — highest priority.
2. **Inferred URL** from `inferContainerUrl(container)` `app.js:1483-1499`:
   scans `container.ports` for published TCP ports, returns
   `http(s)://hostname:hostPort` (https for 443/8443). Uses `location.hostname`,
   never assumes `localhost`. **Only for Docker-backed apps.**
3. **Null** — no link rendered.

**Inferred URLs make the card name clickable immediately on Dashboard load
without opening or saving the modal.** Inferred URLs are **never persisted**;
only an explicit save writes `cfg.url`. **Manual apps never receive inferred URLs.**

### 7.5 System Resources cards

`renderSystemResources()` `app.js:883-916` shows four cards:
- Docker Engine (app name, version, poll interval)
- CPU (containers): aggregate CPU % with progress bar (clamped to 100%)
- Memory (containers): aggregate memory usage + running count
- Resources: image/volume/network counts + total containers

### 7.6 Polling

- Shared timer calls `loadContainers()` on Dashboard or Containers page
  (`app.js:1877-1886`).
- Interval `state.pollInterval`, default **5000 ms** (not from backend
  `poll_interval`; About page `#set-poll` overrides).
- Every tick re-fetches full container list including per-container stats
  (one `stats(stream=False)` per running container, fanned over ≤8 threads).
- Poll does **not** call `/api/system`.

### 7.7 Loading behaviour

`showDashboardLoading(true)` `app.js:874-890` renders a spinner in
`#dashboard-apps` and hides pagination controls. Shown only on first
Dashboard load of the session (`state.containersInitialLoadComplete`).
Summary cards have no loading state. API errors on Dashboard are visible
in `#dashboard-apps`.

### 7.8 API endpoints used by the Dashboard

| Endpoint | When | Used for |
|---|---|---|
| `GET /api/system` | every `refreshPage()` | navbar engine badge, footer, `#settings-list`, `#set-poll` |
| `GET /api/containers` | page load, every poll tick, `#btn-refresh` | summary cards + application cards |
| `GET /api/images` | Dashboard load | image count for System Resources |
| `GET /api/volumes` | Dashboard load | volume count for System Resources |
| `GET /api/networks` | Dashboard load | network count for System Resources |

### 7.9 Tile deletion from Dashboard

Each application card has an edit button (pencil icon) that opens the `#app-config-modal`. The modal now includes a **Delete** button (red, destructive style) separate from the Save button.

- Clicking Delete shows a native `confirm()` dialog with the application's current display name.
- On confirmation, the frontend calls `DELETE /api/dashboard/apps/{appId}` using `authFetch` (not the generic `api()` helper) to correctly handle the `204 No Content` response.
- On success: the modal closes, `loadAppConfig()` reloads the persisted configuration, the Dashboard re-renders, and a success toast appears.
- On failure: an error toast is shown, the modal remains open, and the tile is not removed.
- **Deleting a dashboard tile/configuration never stops or removes the underlying Docker container or image.** It only removes the persisted dashboard configuration from `BACKUP_DIR/dashboard-apps.json`.

### 7.10 State coupling with the Containers page

Because both pages read `state.containers` and `containersPagination`
(shared `search`/`filter`/`sort`/`pageSize`/`currentPage`):

- Search typed on the Dashboard changes what the Containers page shows,
  and vice versa. Neither input mirrors the other's current value.
- Filter, sort and page size are shared in the same way.
- `loadContainers()` renders only the active page
  (`app.js:1377-1382`), so the inactive page's DOM is stale until shown —
  `refreshPage()` always re-fetches on tab switch, so this self-corrects.

---

## 8. Backup / Restore Architecture

### 8.1 Archive layout

Root directory inside the tarball: `docker-manager-backup` (`BACKUP_ROOT`).

```
docker-manager-backup/
├── manifest.json                          # BACKUP_ROOT + /manifest.json
├── README.txt                             # human-readable
├── containers/<name>/config.json          # _container_config()
├── images/image_<i>.tar                   # docker image save, one per image
└── volumes/<name>.tar.gz                  # optional, via alpine helper
```

Filenames on disk: `docker-backup-YYYY-MM-DD-HHMMSS.tar.gz` (`backup.py:102-103`).

### 8.2 Manifest

`MANIFEST_VERSION = 1` (`backup.py:34`). Written by `create_backup()`
(`backup.py:133-152`):

`version`, `created` (UTC ISO), `app`, `containers` (list of full configs),
`images`, `exported_images`, `missing_images`, `shared_volumes`,
`shared_networks`, `volumes_included`, `bind_mounts_included` (always `False`),
`warnings` (list of strings).

A warning is added when bind mounts are present (host data is not portable) and
when an image could not be exported locally (must be pulled on the restore host).

### 8.3 Creation flow (`backup.create_backup`, `backup.py:98-211`)

1. Reject an empty `container_ids` list.
2. Resolve the output path and assert it stays inside `backup_dir`.
3. Build one `_container_config()` per container (env, cmd, entrypoint,
   working dir, user, labels, restart policy, network mode, networks, ports,
   exposed ports, mounts split into `bind_mounts` / `volumes`, hostname).
4. Deduplicate image references and volume/network names.
5. Export each image with `img.save(named=True)` into a temp file; record
   `ImageNotFound` as a missing image instead of failing.
6. Compose the manifest and warnings.
7. Write the tarball to `<name>.tar.gz.tmp`.
8. Optionally, for each shared volume, run
   `alpine:latest tar -czf /backup/.vol-<name>.tar.gz -C /data .` with the
   volume mounted read-only at `/data` and `backup_dir` read-write at
   `/backup`.
9. `tmp_path.replace(out_path)` — atomic publish. On any exception the `.tmp`
   file is unlinked, so a partial archive is never listed or downloadable.
10. Always clean up temp image tars and volume tars.

Synchronous and blocking: the HTTP request does not return until the whole
archive is written. The frontend shows only an indeterminate spinner.

### 8.4 Validation (`read_manifest`, `backup.py:223-242`)

- Every archive member name passes `_safe_member()`.
- `manifest.json` must exist at the expected path.
- Version must not exceed `MANIFEST_VERSION`.
- `containers` must be non-empty.
- Every container name must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`.
- Every container must have a non-empty `image`.
All failures raise `BackupError`, surfaced as HTTP 400.

### 8.5 Summary / preview (`backup_summary`, `backup.py:245-277`)

Cross-references the manifest against the live Engine: existing container names,
existing volumes, locally available image tags, and **currently bound host
ports**. Per container it reports `image_local`, `image_in_backup`, `ports`,
env **key names only** (values are never returned by the summary), `volumes`,
`bind_mounts`, and a `conflicts` list (name conflict, host port conflict).

Frontend consumption: `renderRestorePreview()` `app.js:722-773` renders chips
(`image in backup` / `image local` / `image will be pulled`), volume and bind-mount
warnings, the port mapping list, conflict warnings, and one "rename to" input per
conflicted container.

### 8.6 Restore (`restore.restore_backup`, `restore.py:21-140`)

1. Extract to a temp dir **inside `backup_dir`**; `safe_extract()` validates
   every member and uses `tar.extractall(dest, filter="data")`.
2. Load all `images/*.tar` via `images.load()`.
3. Create missing shared networks (built-ins excluded), `driver="bridge"`.
4. If `restore_volumes` and `volumes_included`: for each shared volume, skip if
   it already exists (log "leaving data intact" — existing data is **not**
   overwritten), otherwise create it and untar with the `alpine` helper.
5. Per container: apply `renames`, validate the name, **skip with an error
   result if the name is already taken**, pull the image if missing, then
   `containers.create(...)` with ports/mounts/env/labels/restart policy, connect
   to shared networks, and optionally `start()`.
6. Return a per-container result list; the operation is **partial-failure
   tolerant** — one container failing does not abort the others.
7. `shutil.rmtree(tmpdir)` in `finally`.

Renames are supplied by the client as a `renames: {origName: newName}` JSON
form field; the restore router rejects a non-dict payload with 400.

---

## 9. Testing

- Framework: `pytest` `8.3.4`, run as `pytest tests -q`.
- No `pytest.ini` / `pyproject.toml` / `setup.cfg`; configuration is default,
  rootdir is the repository root.
- Three test modules, **46 tests total**, all passing at baseline.
- `tests/conftest.py`
  - Sets `BACKUP_DIR` to the repo's `backups/` before importing the app.
  - Inserts `backend/` on `sys.path`, so modules are imported as `app.*`
    (not `backend.app.*`) — note the asymmetry with the production run command,
    which uses `backend.app.main:app`.
  - `mock_docker` fixture: a `MagicMock` Docker client with one container
    (`web`, running) and a realistic stats payload.
  - `client` fixture: builds a `DockerService` around the mock, monkey-patches
    `app.deps.get_service`, and yields
    `TestClient(app, raise_server_exceptions=False)`; restores afterwards.
- `tests/test_api.py` (11 tests): container list + stats, `/api/system`, env
  masking, env reveal, all six actions, unknown action → 404, invalid id → 400,
  remove, logs, container-not-found → 404, Engine-down → 500/502.
- `tests/test_backup.py` (10 tests): manifest read success, missing manifest,
  non-tar input, empty containers, invalid name, missing image, future version,
  and the path-traversal defences (`_safe_member`, `safe_extract` blocked and
  allowed cases).
- `tests/test_dashboard.py` (25 tests): dashboard store path resolution, appId
  validation, missing file returns empty list, POST creates application, duplicate
  POST rejected, GET returns saved application, PUT updates application, PUT
  preserves createdAt, PUT unknown ID rejected, DELETE removes application, DELETE
  non-existent raises, malformed input rejected, persistence survives store reload,
  atomic write leaves valid JSON, list_apps returns all, duplicate display name
  validation on create/update, case-insensitive comparison, whitespace trimming,
  empty name rejection, unchanged name allowed on update.

Gaps in coverage (all current, none are failures):

- No tests for `restore.restore_backup` end-to-end.
- No tests for `create_backup`.
- No tests for `backup_summary` conflict detection.
- No tests for the images / volumes / networks routers.
- No tests for `backup_summary` / stored-backup summary endpoint.
- No tests for auth (`AUTH_TOKEN` set / unset), despite it being a security
  feature.
- No tests for the WebSocket log stream.
- No tests for the tile deletion endpoint or duplicate name validation on the frontend.
- No tests for the upload size limit or filename traversal on
  `/api/backups/{filename}`.
- No frontend tests of any kind — the JS is entirely untested.

Baseline result: **46 passed**.

---

## 10. Docker / Development Commands

### Run with Docker (recommended)

```bash
docker compose up -d --build
# then open http://SERVER_IP:8080
```

`docker-compose.yml` publishes `8080:8080`, bind-mounts
`/var/run/docker.sock` and `./backups`, and sets `AUTH_TOKEN`, `POLL_INTERVAL=5`,
`LOG_LEVEL=INFO`, `restart: unless-stopped`.

Prerequisite for volume data in backups: `docker pull alpine` on the host.

### Run locally for development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
BACKUP_DIR=./backups uvicorn backend.app.main:app --reload --port 8080
```

### Tests

```bash
pytest tests -q          # or: python3 -m pytest tests -v
```

No Docker daemon is required: the suite is fully mocked.

### Container image

`Dockerfile`: `python:3.12-slim`, `pip install --no-cache-dir`, copies
`backend/` and `frontend/`, exposes `8080`, has a `HEALTHCHECK` hitting
`/api/system` every 30s, and runs
`python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8080`.
No multi-stage build, no non-root `USER`, no version pinning of the base image
digest.

### Configuration reference (`.env.example` / `config.py`)

| Variable | Default | Effect |
|---|---|---|
| `APP_NAME` | `Docker Manager` | Navbar brand, document title |
| `APP_VERSION` | `1.0.0` | Footer, OpenAPI version, **asset cache-bust key** |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Bind address |
| `DOCKER_SOCKET` | `unix:///var/run/docker.sock` | Engine socket |
| `BACKUP_DIR` | `/app/backups` | Backup storage; falls back to `./backups` if unwritable |
| `POLL_INTERVAL` | `5` | Exposed via `/api/system`; **frontend ignores it** (hard-codes 5000 ms) |
| `LOG_DEFAULT_LINES` | `500` | Exposed via `/api/system`; **frontend hard-codes the log tail options** |
| `MAX_UPLOAD_MB` | `4096` | Restore upload cap → 413 |
| `AUTH_TOKEN` | *(empty = disabled)* | Bearer token for API + WebSocket |
| `LOG_LEVEL` | `INFO` | Root log level |

`HOST` and `PORT` are read by the settings object but are **not used** by
`main.py` — the bind address is only taken from the uvicorn CLI arguments in
the Dockerfile and the dev command.

---

## 11. Git Workflow

**Known-good baseline: `b5bb64a` — "Fix frontend asset caching"** (branch `main`,
clean working tree).

History, newest first:

| Commit | Message | What it did |
|---|---|---|
| `b5bb64a` | Fix frontend asset caching | `main.py` reads `index.html` per request; `?v={{APP_VERSION}}` on `app.js` and `style.css` |
| `023348b` | Fix container logs and details actions | Log stream + details wiring |
| `d6de07c` | Minor bugs fixed | — |
| `5ec41b4` | Minor bugs fixed | — |
| `4f99f75` | Add pagination to dashboard and resource views | Extended `Pagination` to Images/Volumes/Networks + Dashboard |
| `580338d` | Add container pagination and page size selector | `Pagination` class introduced |
| `0672965` | Initial release v1.0.0 | Full application |

Working rules for agents:

- **Do not commit or push unless explicitly asked.** Do not create branches,
  amend, force-push, or bypass hooks.
- Before committing: `git status`, `git diff`, `git log --oneline -10`.
- Match the existing commit style: short imperative subject line, no body in
  the current history.
- Never commit `.env` or `AUTH_TOKEN` (both gitignored).

---

## 12. Important Technical Decisions

1. **Docker Manager must remain lightweight.** Every added runtime dependency,
   background process, or stateful subsystem works against the project's core
   value proposition. Prefer solving things in the existing single-process
   FastAPI + vanilla-JS structure.
2. **Avoid unnecessary dependencies.** The runtime set is 5 packages
   (`fastapi`, `uvicorn`, `docker`, `pydantic-settings`, `python-multipart`).
   Adding one is a decision, not a default. No CSS framework beyond the
   Bootstrap CDN, no JS framework, no chart library, no icon library beyond
   Bootstrap Icons.
3. **Preserve existing working functionality.** The feature set in section 6
   is the baseline contract. A change that silently regresses logs, live
   streaming, pagination, restore renames or image removal is not acceptable.
4. **Do not introduce privileged sidecars for monitoring.** No
   `cadvisor`/`node_exporter`/agent container, no `--privileged`, no host
   namespace sharing. Metrics come from the Docker Engine API that is already
   being used. Do not add `SYS_ADMIN`, `pid: host`, or a second socket mount
   "just to see metrics".
5. **Do not duplicate container-management controls inside the Dashboard.**
   Start/Stop/Restart/Pause/Kill/Remove/Logs/Details belong to the Containers
   page. The Dashboard is a read-only overview.
6. **The Containers page remains the management interface.** It is stable and
   complete; do not gut it while redesigning the Dashboard.
7. **The Dashboard should eventually become the application/home page** — an
   entry point that answers "what do I run and where do I go", not a second
   management console.
8. **Maintain a responsive UI.** Bootstrap breakpoints; the existing
   table→cards swap at `md` is the established pattern.
9. **Preserve the existing dark/cyan visual style** unless a change is
   explicitly agreed. The palette is defined entirely by the six CSS custom
   properties in `style.css:1-8`.
10. **No secrets in the repository.** `AUTH_TOKEN` arrives via environment.
    The app itself must never log `settings.auth_token`; `/api/system`
    deliberately exposes only `auth_enabled: bool`.
11. **Assume Docker socket access is root-equivalent.** Never add a feature
    that widens exposure; prefer explicit confirmation dialogs for destructive
    operations (the existing pattern).
12. **Bump `APP_VERSION` when shipping frontend changes** — it is the only
    cache-busting mechanism.

---

## 13. Known Limitations

Current, verified. Not a to-do list for this phase.

1. **`esc()` does not escape anything** (`app.js:37-38`) — the replacement map
   maps characters to themselves. Everything is injected via `innerHTML`, so
   container names, image names, labels, env values and filenames are an HTML
   injection surface. Any input that reaches `innerHTML` unescaped is a
   potential stored-XSS via container metadata.
2. **Authentication is backend-only.** The frontend never sends
   `Authorization: Bearer`. With `AUTH_TOKEN` set, the UI returns 401 for every
   `/api/*` call and there is no login form, no token prompt and no token
   storage. Only the WebSocket and the documented `?token=` query parameter are
   reachable from the browser.
3. **`POLL_INTERVAL` is ignored by the frontend.** Hard-coded to 5000 ms;
   the About page input only changes the local value.
4. **`LOG_DEFAULT_LINES` is ignored by the frontend.** Log tail options are
   hard-coded to 100/500/1000/5000.
5. **`HOST`/`PORT` settings are unused** by the application.
6. **Kill is not exposed in the UI** although fully supported by the API.
7. **Image pull is not wired to the `#btn-pull` button** — the button renders
   but does nothing.
8. **Dashboard fetch errors are invisible** — the error message is written to
   the hidden `#container-tbody`.
9. **Dashboard and Containers share search/filter/sort/page state**, and the two
   search inputs never mirror each other.
10. **Every poll resets the container list to page 1** (`resetPage()` inside
    `loadContainers()`).
11. **CPU card is an unnormalised sum** across running containers, so it can
    exceed 100% and is not comparable across hosts.
12. **No charts or history anywhere.** Stats are instantaneous one-shot values;
    the backend keeps no time series.
13. **No host-level metrics** (host CPU/RAM/disk/uptime/load).
14. **Backup and restore are synchronous and blocking.** A multi-gigabyte
    backup holds a request open with no server-side progress reporting.
15. **Backups require the `alpine:latest` image on the host** for volume data.
16. **Volume data is not overwritten on restore** when the volume already
    exists — it is silently left intact.
17. **Bind-mount host data is never included in backups**, only flagged in the
    manifest and UI.
18. **No frontend tests, no CI configuration** in the repository.
19. **Single bearer token, no user accounts, no roles, no rate limiting.**
20. **The container runs as root** (no `USER` directive in the `Dockerfile`).
21. **Backup filename validation is duplicated** inline in three handlers
    instead of being centralised.
22. **Dead code**: `_ID_RE` (`containers.py:18`) is defined but never used;
    `state.restoreBuffer` (`app.js:14`) is never read or written meaningfully;
    `state.settings` is assigned but never read; `reset_service()` is never
    called outside tests.
23. **`GET /` reads the HTML file from disk on every request**, which is fine
    for a small file but is per-request I/O.
24. **OpenAPI docs at `/docs` are always exposed**, even when `AUTH_TOKEN` is set.
25. **No request rate limiting or request-size limit** on `POST /api/backups`
    (the container list is unbounded).
26. **`static.esc` in `app.js` and the `esc()` helper duplicate the same
    intent**; log rendering uses a hand-rolled escape chain
    (`app.js:838-839`) rather than `esc()`.

---

## 14. DO NOT REINTRODUCE

### 14.1 Web Terminal / browser shell

> **Web Terminal / browser shell was intentionally removed and must not be
> reintroduced.**

There must never be:

- a shell / exec / interactive-terminal HTTP or WebSocket endpoint
  (`POST .../exec`, `WS .../exec`, or any equivalent),
- any use of the Docker Engine `exec_create` / `exec_start` / `exec_inspect`
  / `exec_resize` API family,
- any `dockerpty`, `ptyprocess`, `pty.fork`, `paramiko`, or shell-spawning code,
- any `xterm.js` / `xterm-addon-fit` / terminal-emulator library,
- a shell modal in `index.html`, or any shell-related CSS,
- frontend handlers that open a terminal, allocate a pty, or resize a pty,
- backend helpers that exec into a container, write to a pty, or proxy stdio,
- a dependency in `requirements.txt` that exists only to serve a shell.

**Verification performed at baseline `b5bb64a`:**

| Check | Result |
|---|---|
| Shell/exec WebSocket endpoint | **None.** The only `@ws_router.websocket` route is `/{container_id}/logs/stream` (`containers.py:82`) |
| `exec_create` / `exec_start` / `exec_inspect` / `exec_resize` | **None** anywhere in the repo |
| `dockerpty` / `pty` / `paramiko` / `pty.fork` | **None** anywhere in the repo |
| `xterm.js` or any terminal-emulator library | **None.** Frontend libs are Bootstrap 5.3.3 CSS/JS + Bootstrap Icons 1.11.3 only |
| Shell modal in `index.html` | **None.** Modals are `#confirm-modal`, `#details-modal`, `#logs-modal` only |
| Shell frontend handlers | **None.** No terminal-opening code in `app.js` |
| Shell backend helpers | **None** in `docker_service.py`, `backup.py`, `restore.py`, `routers/` |
| Shell-related dependency | **None.** `requirements.txt` has 7 packages, none shell/terminal related |

Note: `bi bi-terminal` appears in `index.html` and `app.js` purely as a
**Bootstrap Icons glyph for the Logs modal and Logs button**. It is not a
terminal feature. The `WS .../logs/stream` endpoint streams container stdout/stderr
only. Neither may be mistaken for, or replaced with, a shell.

Rationale for the removal (retain this reasoning): giving the browser an
interactive shell over the Docker socket means every authenticated web session
is effectively root on the host, with a session-persistence and audit problem
that no amount of UI polish solves. Docker Manager's scope is monitoring and
container lifecycle management, and the log viewer covers the legitimate
"what is this container printing" need.

### 14.2 Other things not to reintroduce

- Privileged/host-namespace sidecars for monitoring (see decision 12.4).
- Docker-management controls duplicated onto the Dashboard (decision 12.5).
- A database, message queue, cache or background worker, to "scale up".
- A JS bundler / framework / npm `package.json`, unless explicitly agreed.
- Any rendering of Docker-supplied metadata through `innerHTML` without
  actually fixing `esc()` first.
- Any logging of `AUTH_TOKEN`, or secrets in committed files.

---

## 15. Planned Dashboard Redesign

**This section is direction only. Nothing here is implemented. Do not start
implementing from this section without a fresh, explicit instruction.**

### 15.1 Purpose

The redesign turns the Dashboard into a professional **application / home page**.

- **Dashboard** answers: *"What applications/services do I have, and where can
  I go?"*
- **Containers page** answers: *"How do I manage my Docker containers?"*

These are two different questions and must stay separated.

### 15.2 Agreed direction

Retain:

- Docker summary counts: **total containers, running, stopped, restarting**.
- Useful CPU / memory information (in whatever form is technically reliable).

Add:

- Useful **system information**, and **charts where technically reliable**.
  Reliability is the constraint: today's stats are instantaneous one-shot
  samples and the backend keeps no history, so any chart requires new
  time-series collection. Charts must not be built on data that cannot be
  gathered without new privileged components.

Replace:

- The current **Containers Overview table** with **application tiles / cards**.

Tile capabilities:

- Tiles **link to the application / service**.
- Support **Docker-container-backed applications**.
- Support **manually created external applications** (services that are not
  Docker containers at all).
- Tiles can be **edited**.
- Tiles can be **created manually**.
- Tiles **show application / container status**.
- Support **application groups**.
- **Automatically suggest or find suitable icons**, including
  **selfh.st icons**.
- Provide a **sensible fallback icon** when nothing better is found.

Constraints:

- Actual container management **stays on the Containers page**.
- **No Start/Stop/Restart/etc. controls in the Dashboard.**
- The dark/cyan visual style is preserved.
- The result remains lightweight: no heavy chart library unless justified, no
  new runtime services, no privileged sidecars.

### 15.3 Open questions to resolve before implementation

- Persistence for manual tiles and groups: the project currently has **no
  database**. Tiles need storage. Options and their cost: a JSON file under
  `BACKUP_DIR` (lightest, consistent with "no database"), vs. a real store
  (contradicts decision 12.1). Recommend the JSON file, but this needs an
  explicit decision.
- Icon sourcing: `selfh.st` is an external HTTP service. Using it adds an
  outbound network dependency per lookup. Needs caching and a hard fallback.
- Time-series collection for charts: sampling cost versus value, and where the
  history is kept (memory only? file? both are new state).
- Whether the summary counts remain cards or become part of the tile grid.

None of the above may be resolved by guessing. Ask first.

---

## Appendix: Quick file map

| Path | Lines | Role |
|---|---|---|
| `backend/app/main.py` | 52 | App, lifespan, static mount, index route |
| `backend/app/config.py` | 28 | Settings, backup dir bootstrap |
| `backend/app/docker_service.py` | 332 | All Docker SDK access |
| `backend/app/deps.py` | 37 | `svc()` + `handle_errors()` |
| `backend/app/auth.py` | 27 | Bearer token (HTTP + WS) |
| `backend/app/backup.py` | 277 | Backup create / list / validate / summarize |
| `backend/app/restore.py` | 140 | Restore execution |
| `backend/app/dashboard_store.py` | 166 | Dashboard application config persistence (JSON file) |
| `backend/app/routers/dashboard.py` | 107 | Dashboard application config REST API |
| `backend/app/routers/containers.py` | 149 | Container routes + log stream WS |
| `backend/app/routers/resources.py` | 87 | `/api/system`, images, volumes, networks |
| `backend/app/routers/backups.py` | 112 | Backups + restore preview/run |
| `frontend/static/index.html` | 455 | Single page, 7 sections, 3 modals |
| `frontend/static/app.js` | 1694 | All frontend logic |
| `frontend/static/style.css` | 278 | Theme + components |
| `tests/conftest.py` | 67 | Mock Docker fixtures |
| `tests/test_api.py` | 62 | 11 API tests |
| `tests/test_backup.py` | 102 | 10 backup validation tests |
| `tests/test_dashboard.py` | 135 | 17 dashboard app config tests |
| `README.md` | 298 | User-facing docs, roadmap |
| `Dockerfile` | 23 | Runtime image |
| `docker-compose.yml` | 15 | Deployment |
| `requirements.txt` | 7 | Dependencies |
