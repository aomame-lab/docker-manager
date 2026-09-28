"use strict";
/* Docker Manager frontend — vanilla JS, Bootstrap 5 */

const state = {
  containers: [], pollInterval: 5000, page: "dashboard",
  search: "", filter: "all", sort: "name",
  pageSize: 10, currentPage: 1,
  images: [], imagesSearch: "", imagesSort: "repo",
  imagesPageSize: 10, imagesCurrentPage: 1,
  volumes: [], volumesSearch: "", volumesSort: "name",
  volumesPageSize: 10, volumesCurrentPage: 1,
  networks: [], networksSearch: "", networksSort: "name",
  networksPageSize: 10, networksCurrentPage: 1,
  selected: new Set(), restoreFile: null, restoreBuffer: null,
  logSocket: null, logContainer: null, pendingConfirm: null,
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ---------------------------------------------------------------- helpers */
const fmtBytes = b => {
  if (!b && b !== 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(1)) + " " + u[i];
};
const fmtDate = d => d && !d.startsWith("0001") ? new Date(d).toLocaleString() : "–";
const fmtUptime = (started) => {
  if (!started || started.startsWith("0001")) return "–";
  let s = Math.max(0, (Date.now() - new Date(started)) / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&", "<": "<", ">": ">", '"': "\"", "'": "'" }[c]));

/* ---------------------------------------------------------------- pagination helper */
class Pagination {
  constructor(prefix) {
    this.prefix = prefix;
    // Containers uses unprefixed keys in state (pageSize, currentPage) for backward compatibility
    if (prefix === "containers") {
      this.pageSizeKey = "pageSize";
      this.currentPageKey = "currentPage";
      this.searchKey = "search";
      this.sortKey = "sort";
      this.filterKey = "filter";
    } else {
      this.pageSizeKey = `${prefix}PageSize`;
      this.currentPageKey = `${prefix}CurrentPage`;
      this.searchKey = `${prefix}Search`;
      this.sortKey = `${prefix}Sort`;
      this.filterKey = `${prefix}Filter`;
    }
    this.dataKey = prefix === "containers" ? "containers" : `${prefix}s`;
  }

  get pageSize() { return state[this.pageSizeKey]; }
  set pageSize(v) { state[this.pageSizeKey] = v; }
  get currentPage() { return state[this.currentPageKey]; }
  set currentPage(v) { state[this.currentPageKey] = v; }
  get search() { return state[this.searchKey]; }
  set search(v) { state[this.searchKey] = v; }
  get sort() { return state[this.sortKey]; }
  set sort(v) { state[this.sortKey] = v; }
  get filter() { return state[this.filterKey] ?? "all"; }
  set filter(v) { state[this.filterKey] = v; }
  get data() { return state[this.dataKey]; }
  set data(v) { state[this.dataKey] = v; }

  getTotalPages(filteredList) {
    if (this.pageSize === -1) return 1;
    return Math.max(1, Math.ceil(filteredList.length / this.pageSize));
  }

  getPaginatedList(filteredList) {
    if (this.pageSize === -1) return filteredList;
    const start = (this.currentPage - 1) * this.pageSize;
    return filteredList.slice(start, start + this.pageSize);
  }

  resetPage() { this.currentPage = 1; }

  adjustPage(totalPages) {
    if (this.currentPage > totalPages) this.currentPage = totalPages;
  }

  render(infoEl, controlsEl, prevBtn, nextBtn, indicator, itemName, filteredList) {
    const total = filteredList.length;
    const totalPages = this.getTotalPages(filteredList);
    const isAll = this.pageSize === -1;

    if (isAll || totalPages <= 1) {
      controlsEl.classList.add("d-none");
      if (isAll) {
        infoEl.textContent = `Showing all ${total} ${itemName}${total !== 1 ? "s" : ""}`;
      } else {
        infoEl.textContent = `${total} ${itemName}${total !== 1 ? "s" : ""}`;
      }
      return;
    }

    controlsEl.classList.remove("d-none");
    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, total);
    infoEl.textContent = `Showing ${start}–${end} of ${total} ${itemName}${total !== 1 ? "s" : ""}`;

    prevBtn.disabled = this.currentPage === 1;
    nextBtn.disabled = this.currentPage === totalPages;
    indicator.textContent = `Page ${this.currentPage} of ${totalPages}`;
  }
}

/* pagination instances */
const containersPagination = new Pagination("containers");
const imagesPagination = new Pagination("images");
const volumesPagination = new Pagination("volumes");
const networksPagination = new Pagination("networks");

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast text-bg-${ok ? "success" : "danger"}`;
  el.innerHTML = `<div class="toast-body"><i class="bi bi-${ok ? "check-circle" : "exclamation-triangle"}"></i> ${esc(msg)}</div>`;
  $("#toasts").appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 4000 }); t.show();
  el.addEventListener("hidden.bs.toast", () => el.remove());
}

/* ------- global non-blocking operation indicator (header progress bar) -- */
/* Global state lives in the header, independent of any page — operations
   keep running and the indicator stays visible while the user navigates. */
function showLoading(message) {
  const msg = message || "Working…";
  $("#global-progress-label").textContent = msg;
  $("#global-progress .progress-bar").setAttribute("aria-label", msg.replace(/…$/, ""));
  $("#global-progress").classList.remove("d-none");
  document.querySelector(".topbar").setAttribute("aria-busy", "true");
}
function hideLoading() {
  $("#global-progress").classList.add("d-none");
  document.querySelector(".topbar").removeAttribute("aria-busy");
}
/* Temporarily disable a button while running fn; always restored. */
async function withBusy(btn, fn) {
  if (btn && btn.disabled) return;               // no duplicate requests
  if (btn) btn.disabled = true;
  try { return await fn(); }
  finally { if (btn) btn.disabled = false; }
}
/* Show the header progress indicator around fn; ALWAYS hidden afterwards. */
async function withLoading(message, fn) {
  showLoading(message);
  try { return await fn(); }
  finally { hideLoading(); }
}

function confirmModal(title, body, okLabel, cb, danger = true) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = body;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel || "Confirm";
  ok.className = `btn btn-sm btn-${danger ? "danger" : "warning"}`;
  state.pendingConfirm = cb;
  bootstrap.Modal.getOrCreateInstance("#confirm-modal").show();
}
$("#confirm-ok").addEventListener("click", () => {
  bootstrap.Modal.getInstance("#confirm-modal").hide();
  if (state.pendingConfirm) { const cb = state.pendingConfirm; state.pendingConfirm = null; cb(); }
});

/* ------------------------------------------------------------------ nav */
$$("#main-tabs .nav-link").forEach(btn => btn.addEventListener("click", () => {
  $$("#main-tabs .nav-link").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.page = btn.dataset.page;
  $$(".page").forEach(p => p.classList.add("d-none"));
  $(`#page-${state.page}`).classList.remove("d-none");
  clearContainerSelection();   // selection never persists across page changes
  refreshPage();
}));

function refreshPage() {
  loadSystem();
  ({ dashboard: loadContainers, containers: loadContainers, images: loadImages,
     volumes: loadVolumes, networks: loadNetworks, backups: loadBackups,
     about: loadSystem }[state.page] || (() => {}))();
}

/* ---------------------------------------------------------------- system */
async function loadSystem() {
  try {
    const d = await api("/api/system");
    $("#app-name").textContent = d.settings.app_name;
    document.title = d.settings.app_name;
    state.settings = d.settings;
    const st = $("#engine-status");
    if (d.engine.connected) {
      st.className = "engine-status ok";
      st.innerHTML = `<i class="bi bi-circle-fill"></i> Engine ${esc(d.engine.version)}`;
      $("#engine-footer").innerHTML =
        `<i class="bi bi-motherboard"></i> Docker ${esc(d.engine.version)} · API ${esc(d.engine.api)} · ${esc(d.engine.os)}`;
    } else {
      st.className = "engine-status err";
      st.innerHTML = `<i class="bi bi-circle-fill"></i> disconnected`;
      $("#engine-footer").innerHTML = `<i class="bi bi-motherboard"></i> Docker Engine unavailable`;
    }
    $("#app-version").textContent = `V.${d.settings.app_version || "—"}`;
    $("#set-poll").value = Math.round(state.pollInterval / 1000);
    $("#settings-list").innerHTML = [
      ["Application name", d.settings.app_name],
      ["Backup directory", d.settings.backup_dir],
      ["Max upload (MB)", d.settings.max_upload_mb],
      ["Default log lines", d.settings.log_default_lines],
      ["Authentication", d.settings.auth_enabled
        ? '<span class="ok-chip">enabled</span>'
        : '<span class="warn-chip">disabled — restrict to trusted LAN</span>'],
    ].map(([k, v]) => `<dt class="col-sm-4 text-muted">${k}</dt><dd class="col-sm-8">${v}</dd>`).join("");
  } catch (e) { /* backend down */ }
}

/* ------------------------------------------------------------- containers */
async function loadContainers() {
  // Show loading state immediately for dashboard
  if (state.page === "dashboard") showDashboardLoading(true);

  try {
    state.containers = await api("/api/containers");
  } catch (e) {
    if (state.page === "dashboard") showDashboardLoading(false);
    if ($("#container-tbody")) $("#container-tbody").innerHTML =
      `<tr><td colspan="9" class="text-center text-danger py-4">${esc(e.message)}</td></tr>`;
    return;
  }
  // Drop selections pointing at containers that no longer exist (stale state).
  const ids = new Set(state.containers.map(c => c.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  containersPagination.resetPage();
  if (state.page === "dashboard") {
    showDashboardLoading(false);
    renderSummary();
  } else {
    renderSummary(); renderContainers();
  }
  updateSelCount();
}

/* Single point to reset the container selection: IDs, checkboxes,
   counter and the "Backup selected" button. */
function clearContainerSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  $$(".sel").forEach(cb => { cb.checked = false; });
  const all = $("#sel-all"); if (all) all.checked = false;
  updateSelCount();
}

function filteredContainers() {
  let list = state.containers.filter(c =>
    (!state.search || c.name.toLowerCase().includes(state.search)
                     || c.image.toLowerCase().includes(state.search)) &&
    (state.filter === "all" ||
     (state.filter === "stopped" ? ["exited", "created", "dead"].includes(c.state)
                                 : c.state === state.filter)));
  const key = { name: c => c.name.toLowerCase(), state: c => c.state,
    cpu: c => -(c.stats?.cpu_percent || 0), mem: c => -(c.stats?.mem_usage || 0),
    created: c => -(Date.parse(c.created) || 0) }[state.sort];
  return [...list].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function filteredImages() {
  let list = state.images.filter(i =>
    !state.imagesSearch ||
    i.repo.toLowerCase().includes(state.imagesSearch) ||
    i.tag.toLowerCase().includes(state.imagesSearch) ||
    i.short_id.toLowerCase().includes(state.imagesSearch)
  );
  const key = { repo: i => i.repo.toLowerCase(), tag: i => i.tag.toLowerCase(),
    created: i => -(Date.parse(i.created) || 0), size: i => -(i.size || 0) }[state.imagesSort];
  return [...list].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function filteredVolumes() {
  let list = state.volumes.filter(v =>
    !state.volumesSearch ||
    v.name.toLowerCase().includes(state.volumesSearch) ||
    v.driver.toLowerCase().includes(state.volumesSearch) ||
    v.mountpoint.toLowerCase().includes(state.volumesSearch)
  );
  const key = { name: v => v.name.toLowerCase(), driver: v => v.driver.toLowerCase() }[state.volumesSort];
  return [...list].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function filteredNetworks() {
  let list = state.networks.filter(n =>
    !state.networksSearch ||
    n.name.toLowerCase().includes(state.networksSearch) ||
    n.driver.toLowerCase().includes(state.networksSearch) ||
    (n.subnet || "").toLowerCase().includes(state.networksSearch)
  );
  const key = { name: n => n.name.toLowerCase(), driver: n => n.driver.toLowerCase() }[state.networksSort];
  return [...list].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

const badge = st => `<span class="badge badge-state st-${esc(st)}">${esc(st.toUpperCase())}</span>`;

/* Published container ports. TCP ports are clickable and open the service on
   the same host address as this web app, never assuming localhost. */
function renderPorts(c) {
  const ports = c.ports || {};
  const out = [];
  for (const [cport, bindings] of Object.entries(ports)) {
    if (!bindings || !bindings.length) continue;             // unpublished
    const proto = (cport.split("/")[1] || "tcp").toLowerCase();
    for (const b of bindings) {
      if (!b.HostPort) continue;
      const label = `${b.HostPort}:${cport}`;
      const isHttp = proto === "tcp";
      const https = /443$/.test(cport.split("/")[0]) || ["443", "8443"].includes(b.HostPort);
      if (isHttp) {
        const url = `${https ? "https" : "http"}://${location.hostname}:${b.HostPort}`;
        out.push(`<a class="port-chip" href="${esc(url)}" target="_blank" rel="noopener"
                    title="Open ${esc(url)}">${esc(label)} <i class="bi bi-box-arrow-up-right"></i></a>`);
      } else {
        out.push(`<span class="port-chip">${esc(label)}</span>`);
      }
    }
  }
  return out.join("") || '<span class="text-muted small">–</span>';
}

function actionButtons(c) {
  const id = c.id, n = esc(c.name);
  const btn = (act, icon, title, cls = "btn-outline-accent") =>
    `<button class="btn btn-sm ${cls} action-btn" data-act="${act}" data-id="${id}" title="${title}"><i class="bi bi-${icon}"></i></button>`;
  let html = "";
  if (c.state === "running") {
    html += btn("restart", "arrow-repeat", "Restart") + btn("pause", "pause", "Pause") +
            btn("stop", "stop-fill", "Stop");
  } else if (c.state === "paused") {
    html += btn("unpause", "play-fill", "Unpause") + btn("stop", "stop-fill", "Stop");
  } else {
    html += btn("start", "play-fill", "Start");
  }
  html += `<button class="btn btn-sm btn-outline-accent action-btn" data-logs="${id}" data-name="${n}" title="Logs"><i class="bi bi-terminal"></i></button>`;
  html += `<button class="btn btn-sm btn-outline-accent action-btn" data-details="${id}" data-name="${n}" title="Details"><i class="bi bi-info-circle"></i></button>`;
  html += `<button class="btn btn-sm btn-outline-danger action-btn" data-remove="${id}" data-name="${n}" title="Remove"><i class="bi bi-trash"></i></button>`;
  return html;
}

function renderSummary() {
  const c = state.containers;
  const cnt = f => c.filter(f).length;
  const running = c.filter(x => x.state === "running");
  const cpu = running.reduce((s, x) => s + (x.stats?.cpu_percent || 0), 0);
  const mem = running.reduce((s, x) => s + (x.stats?.mem_usage || 0), 0);
  const cards = [
    ["Total", c.length, "boxes"], ["Running", running.length, "play-circle"],
    ["Stopped", cnt(x => ["exited", "created", "dead"].includes(x.state)), "stop-circle"],
    ["Restarting", cnt(x => x.state === "restarting"), "arrow-repeat"],
    ["CPU", cpu.toFixed(1) + "%", "cpu"], ["Memory", fmtBytes(mem), "memory"],
  ];
  $("#summary-cards").innerHTML = cards.map(([l, v, i]) => `
    <div class="col-6 col-md-4 col-lg-2"><div class="dm-card stat-card">
      <div class="value"><i class="bi bi-${i} text-accent"></i> ${v}</div>
      <div class="label">${l}</div></div></div>`).join("");

  // Dashboard containers overview — now paginated
  const filtered = filteredContainers();
  const paginated = containersPagination.getPaginatedList(filtered);
  containersPagination.adjustPage(containersPagination.getTotalPages(filtered));
  $("#dashboard-list").innerHTML = `<div class="card dm-card"><div class="table-responsive">
    <table class="table table-hover align-middle mb-0"><tbody>` +
    paginated.map(x => `<tr>
      <td><i class="bi bi-box-seam text-accent"></i> <b>${esc(x.name)}</b></td>
      <td class="text-muted">${esc(x.image)}</td><td>${badge(x.state)}</td>
      <td class="text-muted">${x.stats?.cpu_percent ?? "–"}%</td>
      <td class="text-muted">${fmtBytes(x.stats?.mem_usage)}</td>
    </tr>`).join("") + "</tbody></table></div></div>";

  renderDashboardPagination();
}

function renderContainers() {
  const filtered = filteredContainers();
  containersPagination.adjustPage(containersPagination.getTotalPages(filtered));
  const list = containersPagination.getPaginatedList(filtered);

  $("#container-tbody").innerHTML = list.map(c => `<tr>
    <td><input class="form-check-input sel" type="checkbox" data-id="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}></td>
    <td><a href="#" class="text-decoration-none text-accent fw-semibold" data-details="${c.id}" data-name="${esc(c.name)}">${esc(c.name)}</a>
        <div class="text-muted small">${esc(c.short_id)}</div></td>
    <td class="text-muted small">${esc(c.image)}</td>
    <td>${badge(c.state)}${c.restart_count ? ` <span class="text-muted small">↻${c.restart_count}</span>` : ""}</td>
    <td class="small text-muted">${c.state === "running" ? fmtUptime(c.started_at) : "–"}</td>
    <td class="small">${renderPorts(c)}</td>
    <td class="small">${c.state === "running" ? (c.stats?.cpu_percent ?? "–") + "%" : "–"}</td>
    <td class="small">${c.state === "running" ? fmtBytes(c.stats?.mem_usage) : "–"}</td>
    <td class="text-end text-nowrap">${actionButtons(c)}</td></tr>`).join("") ||
    `<tr><td colspan="9" class="text-center text-muted py-4">No containers found</td></tr>`;

  $("#container-cards").innerHTML = list.map(c => `
    <div class="col-12"><div class="container-card">
      <div class="d-flex align-items-center gap-2">
        <input class="form-check-input sel" type="checkbox" data-id="${c.id}" ${state.selected.has(c.id) ? "checked" : ""}>
        <a href="#" class="text-decoration-none text-accent fw-semibold" data-details="${c.id}" data-name="${esc(c.name)}">${esc(c.name)}</a>
        <span class="ms-auto">${badge(c.state)}</span></div>
      <div class="small text-muted mt-1">${esc(c.image)} · ${esc(c.short_id)}</div>
      <div class="mt-1">${renderPorts(c)}</div>
      <div class="d-flex justify-content-between align-items-center mt-2">
        <span class="small text-muted">${c.state === "running" ? `CPU ${c.stats?.cpu_percent ?? "–"}% · ${fmtBytes(c.stats?.mem_usage)}` : "offline"}</span>
        <span class="text-nowrap">${actionButtons(c)}</span></div>
    </div></div>`).join("");

  renderContainersPagination();
}

function renderContainersPagination() {
  const filtered = filteredContainers();
  containersPagination.render(
    $("#pagination-info"), $("#pagination-controls"),
    $("#btn-page-prev"), $("#btn-page-next"), $("#page-indicator"),
    "container", filtered
  );
}

function showDashboardLoading(show) {
  const listEl = $("#dashboard-list");
  if (!listEl) return;
  if (show) {
    listEl.innerHTML = `<div class="card dm-card"><div class="table-responsive">
      <table class="table table-hover align-middle mb-0"><tbody>
        <tr><td colspan="5" class="text-center py-4">
          <div class="d-flex flex-column align-items-center gap-2">
            <div class="spinner-border text-accent" role="status" aria-hidden="true"></div>
            <span class="text-muted small">Loading containers…</span>
          </div>
        </td></tr>
      </tbody></table></div></div>`;
    // Hide pagination while loading
    const controls = $("#dashboard-pagination-controls");
    if (controls) controls.classList.add("d-none");
  }
}

function renderDashboardPagination() {
  const filtered = filteredContainers();
  containersPagination.render(
    $("#dashboard-pagination-info"), $("#dashboard-pagination-controls"),
    $("#btn-dashboard-page-prev"), $("#btn-dashboard-page-next"), $("#dashboard-page-indicator"),
    "container", filtered
  );
}

function updateSelCount() {
  $("#sel-count").textContent = state.selected.size;
  $("#btn-backup-selected").disabled = !state.selected.size;
}

/* ---------------------------------------------------------------- images */
async function loadImages() {
  try {
    state.images = await api("/api/images");
  } catch (e) {
    if ($("#images-tbody")) $("#images-tbody").innerHTML =
      `<tr><td colspan="7" class="text-center text-danger py-4">${esc(e.message)}</td></tr>`;
    return;
  }
  imagesPagination.resetPage();
  renderImages();
}

function renderImages() {
  const filtered = filteredImages();
  imagesPagination.adjustPage(imagesPagination.getTotalPages(filtered));
  const list = imagesPagination.getPaginatedList(filtered);

  $("#images-tbody").innerHTML = list.map(i => `<tr>
    <td class="fw-semibold">${esc(i.repo)}${i.dangling ? ' <span class="warn-chip">dangling</span>' : ""}</td>
    <td>${esc(i.tag)}</td>
    <td><code class="small">${esc(i.short_id)}</code></td>
    <td class="small text-muted">${fmtDate(i.created)}</td>
    <td class="small">${fmtBytes(i.size)}</td>
    <td>${i.in_use ? '<span class="ok-chip">in use</span>' : "–"}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-danger action-btn"
        data-rmimgid="${esc(i.id)}" data-ref="${esc(i.repo + ":" + i.tag)}"
        data-inuse="${i.in_use}" data-ntags="${i.tag_count}">
      <i class="bi bi-trash"></i></button></td></tr>`).join("") ||
    `<tr><td colspan="7" class="text-center text-muted py-4">No images</td></tr>`;

  $$("[data-rmimgid]").forEach(b => b.addEventListener("click", () => {
    const warn = b.dataset.inuse === "true"
      ? `<div class="alert alert-warning py-2">A container depends on this image — force removal will be used.</div>`
      : +b.dataset.ntags > 1
        ? `<div class="alert alert-warning py-2">This image has ${b.dataset.ntags} tags; removing it by ID removes <b>all</b> of them.</div>` : "";
    confirmModal("Remove image", `${warn}Remove image <b>${esc(b.dataset.ref)}</b> (<code>${esc(b.dataset.rmimgid.slice(0, 19))}…</code>)?`,
      "Remove", async () => {
        try { await api(`/api/images/${encodeURIComponent(b.dataset.rmimgid)}?force=${b.dataset.inuse === "true" || +b.dataset.ntags > 1}`, { method: "DELETE" });
              toast("Image removed"); loadImages(); }
        catch (e) { toast("Remove failed: " + e.message, false); }
      });
  }));

  renderImagesPagination();
}

function renderImagesPagination() {
  const filtered = filteredImages();
  imagesPagination.render(
    $("#images-pagination-info"), $("#images-pagination-controls"),
    $("#btn-images-page-prev"), $("#btn-images-page-next"), $("#images-page-indicator"),
    "image", filtered
  );
}

/* ---------------------------------------------------------------- volumes */
async function loadVolumes() {
  try {
    state.volumes = await api("/api/volumes");
  } catch (e) {
    if ($("#volumes-tbody")) $("#volumes-tbody").innerHTML =
      `<tr><td colspan="5" class="text-center text-danger py-4">${esc(e.message)}</td></tr>`;
    return;
  }
  volumesPagination.resetPage();
  renderVolumes();
}

function renderVolumes() {
  const filtered = filteredVolumes();
  volumesPagination.adjustPage(volumesPagination.getTotalPages(filtered));
  const list = volumesPagination.getPaginatedList(filtered);

  $("#volumes-tbody").innerHTML = list.map(v => `<tr>
    <td class="fw-semibold">${esc(v.name)}</td><td>${esc(v.driver)}</td>
    <td><code class="small">${esc(v.mountpoint)}</code></td>
    <td class="small">${v.used_by.length ? esc(v.used_by.join(", ")) : '<span class="text-muted">unused</span>'}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-danger action-btn" data-rmvol="${esc(v.name)}" ${v.used_by.length ? "disabled title='In use'" : ""}>
      <i class="bi bi-trash"></i></button></td></tr>`).join("") ||
    `<tr><td colspan="5" class="text-center text-muted py-4">No volumes</td></tr>`;

  $$("[data-rmvol]").forEach(b => !b.disabled && b.addEventListener("click", () =>
    confirmModal("Remove volume", `Remove volume <b>${esc(b.dataset.rmvol)}</b>? Data will be lost.`,
      "Remove", async () => {
        try { await api(`/api/volumes/${encodeURIComponent(b.dataset.rmvol)}`, { method: "DELETE" });
              toast("Volume removed"); loadVolumes(); }
        catch (e) { toast("Remove failed: " + e.message, false); }
      })));

  renderVolumesPagination();
}

function renderVolumesPagination() {
  const filtered = filteredVolumes();
  volumesPagination.render(
    $("#volumes-pagination-info"), $("#volumes-pagination-controls"),
    $("#btn-volumes-page-prev"), $("#btn-volumes-page-next"), $("#volumes-page-indicator"),
    "volume", filtered
  );
}

/* ---------------------------------------------------------------- networks */
async function loadNetworks() {
  try {
    state.networks = await api("/api/networks");
  } catch (e) {
    if ($("#networks-tbody")) $("#networks-tbody").innerHTML =
      `<tr><td colspan="6" class="text-center text-danger py-4">${esc(e.message)}</td></tr>`;
    return;
  }
  networksPagination.resetPage();
  renderNetworks();
}

function renderNetworks() {
  const filtered = filteredNetworks();
  networksPagination.adjustPage(networksPagination.getTotalPages(filtered));
  const list = networksPagination.getPaginatedList(filtered);

  $("#networks-tbody").innerHTML = list.map(n => `<tr>
    <td class="fw-semibold">${esc(n.name)}</td><td>${esc(n.driver)}</td>
    <td class="small">${esc(n.subnet || "–")}</td><td class="small">${esc(n.gateway || "–")}</td>
    <td class="small">${esc(n.containers.join(", ") || "–")}</td>
    <td class="text-end">${["bridge","host","none"].includes(n.name) ? "" :
      `<button class="btn btn-sm btn-outline-danger action-btn" data-rmnet="${esc(n.name)}"><i class="bi bi-trash"></i></button>`}</td></tr>`).join("");

  $$("[data-rmnet]").forEach(b => b.addEventListener("click", () =>
    confirmModal("Remove network", `Remove network <b>${esc(b.dataset.rmnet)}</b>?`,
      "Remove", async () => {
        try { await api(`/api/networks/${encodeURIComponent(b.dataset.rmnet)}`, { method: "DELETE" });
              toast("Network removed"); loadNetworks(); }
        catch (e) { toast("Remove failed: " + e.message, false); }
      })));

  renderNetworksPagination();
}

function renderNetworksPagination() {
  const filtered = filteredNetworks();
  networksPagination.render(
    $("#networks-pagination-info"), $("#networks-pagination-controls"),
    $("#btn-networks-page-prev"), $("#btn-networks-page-next"), $("#networks-page-indicator"),
    "network", filtered
  );
}

/* ----------------------------------------------------------------- backup */
$("#btn-backup-selected").addEventListener("click", () => {
  const btn = $("#btn-backup-selected");
  if (btn.disabled) return;                       // prevent duplicate starts
  const names = state.containers.filter(c => state.selected.has(c.id)).map(c => c.name);
  confirmModal("Create backup",
    `Create a portable backup of <b>${names.length}</b> container(s)?<br>
     <span class="text-muted small">${esc(names.join(", "))}</span>
     <div class="form-check mt-2"><input class="form-check-input" type="checkbox" id="bk-vols" checked>
     <label class="form-check-label" for="bk-vols">Include volume data</label></div>
     <div class="text-warning small mt-2"><i class="bi bi-exclamation-triangle"></i>
     Bind-mount host data is NOT included automatically.</div>`,
    "Backup", async () => {
      btn.disabled = true;
      try {
        const r = await withLoading("Creating backup…", () => api("/api/backups",
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ container_ids: [...state.selected],
                                   include_volumes: $("#bk-vols").checked }) }));
        toast(`Backup created: ${r.filename}`);
        clearContainerSelection();                // reset selection on success
        loadBackups();
      } catch (e) { toast("Backup failed: " + e.message, false); }
      finally { updateSelCount(); }               // re-enable if selection remains
    }, false);
});

async function loadBackups() {
  try {
    const bks = await api("/api/backups");
    $("#backups-tbody").innerHTML = bks.map(b => `<tr>
      <td class="small">${esc(b.filename)}</td><td class="small">${fmtBytes(b.size)}</td>
      <td class="small text-muted">${fmtDate(b.created)}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-accent action-btn" href="/api/backups/${esc(b.filename)}/download"><i class="bi bi-download"></i></a>
        <button class="btn btn-sm btn-outline-accent action-btn" data-bkrestore="${esc(b.filename)}"><i class="bi bi-arrow-counterclockwise"></i></button>
        <button class="btn btn-sm btn-outline-danger action-btn" data-bkdel="${esc(b.filename)}"><i class="bi bi-trash"></i></button>
      </td></tr>`).join("") ||
      `<tr><td colspan="4" class="text-center text-muted py-4">No backups yet</td></tr>`;
    $$("[data-bkdel]").forEach(b => b.addEventListener("click", () =>
      confirmModal("Delete backup", `Delete <b>${esc(b.dataset.bkdel)}</b>?`, "Delete", async () => {
        try { await api(`/api/backups/${b.dataset.bkdel}`, { method: "DELETE" });
              toast("Backup deleted"); loadBackups(); }
        catch (e) { toast(e.message, false); }
      })));
    $$("[data-bkrestore]").forEach(b => b.addEventListener("click", async () => {
      if (b.disabled) return;                     // prevent duplicate summary requests
      const filename = b.dataset.bkrestore;
      // Immediately open the summary area with a loading state so the user
      // sees the request was received even for large backups.
      $("#restore-preview").innerHTML = `
        <div class="details-section">
          <h6>Restore Summary</h6>
          <div class="text-center text-muted py-4">
            <div class="spinner-border text-accent" role="status" aria-hidden="true"></div>
            <div class="mt-2">Analyzing backup&hellip;</div>
            <div class="small text-muted">Please wait, this can take a moment for large backups.</div>
          </div>
        </div>`;
      $("#restore-preview").scrollIntoView({ behavior: "smooth", block: "nearest" });
      b.disabled = true;                          // re-enabled after load/failure
      try {
        const s = await withLoading("Loading restore summary…",
          () => api(`/api/backups/${filename}/summary`));
        renderRestorePreview(s, `/api/backups/${filename}/download`, filename);
      } catch (e) {
        $("#restore-preview").innerHTML = `
          <div class="details-section">
            <h6>Restore Summary</h6>
            <div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle"></i>
              Failed to load restore summary: ${esc(e.message)}</div>
          </div>`;
        toast("Summary failed: " + e.message, false);
      } finally { b.disabled = false; }
    }));
  } catch (e) { toast("Backups: " + e.message, false); }
}

/* ---------------------------------------------------------------- restore */
$("#restore-file").addEventListener("change", e => {
  state.restoreFile = e.target.files[0] || null;
  $("#btn-preview-restore").disabled = !state.restoreFile;
});
$("#btn-preview-restore").addEventListener("click", async () => {
  const btn = $("#btn-preview-restore");
  if (!state.restoreFile || btn.disabled) return;
  const fd = new FormData(); fd.append("file", state.restoreFile);
  await withBusy(btn, () => withLoading("Inspecting backup…", async () => {
    try {
      const r = await fetch("/api/restore/preview", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json()).detail);
      renderRestorePreview(await r.json(), null, null, state.restoreFile);
    } catch (e) { toast("Invalid backup: " + e.message, false); }
  }));
});

function renderRestorePreview(s, downloadUrl, storedName, uploadFile) {
  const el = $("#restore-preview");
  const m = s.manifest;
  el.innerHTML = `
    <div class="details-section">
      <h6>Backup summary</h6>
      <div class="small text-muted mb-2">Created: ${fmtDate(m.created)} ·
        ${m.volumes_included ? '<span class="ok-chip">volumes included</span>' : '<span class="warn-chip">volume data NOT included</span>'}
        <span class="ok-chip">images: ${esc((m.images || []).join(", ") || "none")}</span></div>
      ${(m.warnings || []).map(w => `<div class="alert alert-warning py-1 small"><i class="bi bi-exclamation-triangle"></i> ${esc(w)}</div>`).join("")}
      ${s.containers.map((c, i) => `
        <div class="border rounded p-2 mb-2" style="border-color: var(--dm-border)!important">
          <b>${esc(c.name)}</b> <span class="text-muted small">(${esc(c.image)})</span>
          ${c.image_in_backup ? '<span class="ok-chip">image in backup</span>' : c.image_local ? '<span class="ok-chip">image local</span>' : '<span class="warn-chip">image will be pulled</span>'}
          ${c.volumes.length ? `<span class="ok-chip">volumes: ${esc(c.volumes.map(v => v.source).join(", "))}</span>` : ""}
          ${c.bind_mounts.length ? `<span class="warn-chip">bind mounts NOT included: ${esc(c.bind_mounts.map(b => b.source).join(", "))}</span>` : ""}
          ${c.ports.length ? `<div class="small text-muted">${esc(c.ports.map(p => `${p.host_port}→${p.container}`).join(", "))}</div>` : ""}
          ${c.conflicts.map(x => `<div class="text-warning small"><i class="bi bi-exclamation-triangle"></i> ${esc(x)}</div>`).join("")}
          ${c.conflicts.length ? `<div class="input-group input-group-sm mt-1" style="max-width:280px">
            <span class="input-group-text">rename to</span>
            <input class="form-control rename-in" data-orig="${esc(c.name)}" placeholder="${esc(c.name)}_restored"></div>` : ""}
        </div>`).join("")}
      <div class="form-check"><input class="form-check-input" type="checkbox" id="rs-start">
        <label class="form-check-label small" for="rs-start">Start containers after restore</label></div>
      <div class="form-check"><input class="form-check-input" type="checkbox" id="rs-vols" checked>
        <label class="form-check-label small" for="rs-vols">Restore volume data</label></div>
      <button class="btn btn-sm btn-accent mt-2" id="btn-do-restore"><i class="bi bi-arrow-counterclockwise"></i> Restore</button>
    </div>`;
  $("#btn-do-restore").addEventListener("click", async () => {
    const btn = $("#btn-do-restore");
    if (btn.disabled) return;                     // prevent duplicate restores
    btn.disabled = true;
    const renames = {};
    $$(".rename-in").forEach(i => { if (i.value.trim()) renames[i.dataset.orig] = i.value.trim(); });
    try {
      await withLoading("Restoring backup…", async () => {
        let fd = new FormData();
        fd.append("renames", JSON.stringify(renames));
        fd.append("start", $("#rs-start").checked);
        fd.append("restore_volumes", $("#rs-vols").checked);
        if (uploadFile) fd.append("file", uploadFile);
        else { const blob = await (await fetch(downloadUrl)).blob(); fd.append("file", blob, storedName); }
        const r = await fetch("/api/restore", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.json()).detail);
        const results = await r.json();
        results.forEach(x => x.ok ? toast(`Restored ${x.name}`) : toast(`Restore ${x.name} failed: ${x.error}`, false));
        loadContainers();
      });
    } catch (e) { toast("Restore failed: " + e.message, false); }
    finally { btn.disabled = false; }
  });
}

/* delegated events */
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act],[data-logs],[data-details],[data-remove]");
  if (!t) return;
  e.preventDefault();
  if (t.dataset.act) {
    const act = t.dataset.act, id = t.dataset.id;
    const doIt = async () => {
      try { await api(`/api/containers/${id}/${act}`, { method: "POST" });
            toast(`Container ${act} OK`); setTimeout(loadContainers, 800); }
      catch (err) { toast(`${act} failed: ${err.message}`, false); }
    };
    if (["stop", "restart", "kill"].includes(act))
      confirmModal(`${act} container`, `Are you sure you want to <b>${act}</b> this container?`,
                   act, doIt, act === "kill");
    else doIt();
  } else if (t.dataset.remove) {
    const id = t.dataset.remove, name = t.dataset.name;
    confirmModal("Remove container",
      `<i class="bi bi-exclamation-triangle text-danger"></i>
       Are you sure you want to remove container <b>${esc(name)}</b>?<br>
       <div class="form-check mt-2"><input class="form-check-input" type="checkbox" id="rm-force">
       <label class="form-check-label" for="rm-force">Force (kill if running)</label></div>
       <div class="form-check"><input class="form-check-input" type="checkbox" id="rm-vol">
       <label class="form-check-label" for="rm-vol">Also remove anonymous volumes</label></div>`,
      "Remove", async () => {
        try {
          const f = $("#rm-force")?.checked, v = $("#rm-vol")?.checked;
          await api(`/api/containers/${id}?force=${!!f}&volumes=${!!v}`, { method: "DELETE" });
          toast(`Container ${name} removed`); loadContainers();
        } catch (err) { toast(`Remove failed: ${err.message}`, false); }
      });
  } else if (t.dataset.logs) openLogs(t.dataset.logs, t.dataset.name);
  else if (t.dataset.details) openDetails(t.dataset.details, t.dataset.name);
});
document.addEventListener("change", e => {
  if (e.target.classList?.contains("sel")) {
    e.target.checked ? state.selected.add(e.target.dataset.id)
                     : state.selected.delete(e.target.dataset.id);
    updateSelCount();
  }
});
$("#sel-all").addEventListener("change", e => {
  filteredContainers().forEach(c => e.target.checked ? state.selected.add(c.id) : state.selected.delete(c.id));
  renderContainers(); updateSelCount();
});

/* Containers page controls */
$("#search").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); containersPagination.resetPage(); renderContainers(); });
$("#filter-state").addEventListener("change", e => { state.filter = e.target.value; containersPagination.resetPage(); renderContainers(); });
$("#sort-by").addEventListener("change", e => { state.sort = e.target.value; containersPagination.resetPage(); renderContainers(); });
$("#page-size").addEventListener("change", e => {
  const val = e.target.value;
  containersPagination.pageSize = val === "all" ? -1 : +val;
  containersPagination.resetPage();
  renderContainers();
});
$("#btn-page-prev").addEventListener("click", () => {
  if (containersPagination.currentPage > 1) { containersPagination.currentPage--; renderContainers(); }
});
$("#btn-page-next").addEventListener("click", () => {
  const totalPages = containersPagination.getTotalPages(filteredContainers());
  if (containersPagination.currentPage < totalPages) { containersPagination.currentPage++; renderContainers(); }
});

/* Dashboard containers overview controls */
$("#dashboard-search").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); containersPagination.resetPage(); renderSummary(); });
$("#dashboard-filter-state").addEventListener("change", e => { state.filter = e.target.value; containersPagination.resetPage(); renderSummary(); });
$("#dashboard-sort-by").addEventListener("change", e => { state.sort = e.target.value; containersPagination.resetPage(); renderSummary(); });
$("#dashboard-page-size").addEventListener("change", e => {
  const val = e.target.value;
  containersPagination.pageSize = val === "all" ? -1 : +val;
  containersPagination.resetPage();
  renderSummary();
});
$("#btn-dashboard-page-prev").addEventListener("click", () => {
  if (containersPagination.currentPage > 1) { containersPagination.currentPage--; renderSummary(); }
});
$("#btn-dashboard-page-next").addEventListener("click", () => {
  const totalPages = containersPagination.getTotalPages(filteredContainers());
  if (containersPagination.currentPage < totalPages) { containersPagination.currentPage++; renderSummary(); }
});

/* Images page controls */
$("#images-search").addEventListener("input", e => { state.imagesSearch = e.target.value.toLowerCase(); imagesPagination.resetPage(); renderImages(); });
$("#images-sort-by").addEventListener("change", e => { state.imagesSort = e.target.value; imagesPagination.resetPage(); renderImages(); });
$("#images-page-size").addEventListener("change", e => {
  const val = e.target.value;
  imagesPagination.pageSize = val === "all" ? -1 : +val;
  imagesPagination.resetPage();
  renderImages();
});
$("#btn-images-page-prev").addEventListener("click", () => {
  if (imagesPagination.currentPage > 1) { imagesPagination.currentPage--; renderImages(); }
});
$("#btn-images-page-next").addEventListener("click", () => {
  const totalPages = imagesPagination.getTotalPages(filteredImages());
  if (imagesPagination.currentPage < totalPages) { imagesPagination.currentPage++; renderImages(); }
});

/* Volumes page controls */
$("#volumes-search").addEventListener("input", e => { state.volumesSearch = e.target.value.toLowerCase(); volumesPagination.resetPage(); renderVolumes(); });
$("#volumes-sort-by").addEventListener("change", e => { state.volumesSort = e.target.value; volumesPagination.resetPage(); renderVolumes(); });
$("#volumes-page-size").addEventListener("change", e => {
  const val = e.target.value;
  volumesPagination.pageSize = val === "all" ? -1 : +val;
  volumesPagination.resetPage();
  renderVolumes();
});
$("#btn-volumes-page-prev").addEventListener("click", () => {
  if (volumesPagination.currentPage > 1) { volumesPagination.currentPage--; renderVolumes(); }
});
$("#btn-volumes-page-next").addEventListener("click", () => {
  const totalPages = volumesPagination.getTotalPages(filteredVolumes());
  if (volumesPagination.currentPage < totalPages) { volumesPagination.currentPage++; renderVolumes(); }
});

/* Networks page controls */
$("#networks-search").addEventListener("input", e => { state.networksSearch = e.target.value.toLowerCase(); networksPagination.resetPage(); renderNetworks(); });
$("#networks-sort-by").addEventListener("change", e => { state.networksSort = e.target.value; networksPagination.resetPage(); renderNetworks(); });
$("#networks-page-size").addEventListener("change", e => {
  const val = e.target.value;
  networksPagination.pageSize = val === "all" ? -1 : +val;
  networksPagination.resetPage();
  renderNetworks();
});
$("#btn-networks-page-prev").addEventListener("click", () => {
  if (networksPagination.currentPage > 1) { networksPagination.currentPage--; renderNetworks(); }
});
$("#btn-networks-page-next").addEventListener("click", () => {
  const totalPages = networksPagination.getTotalPages(filteredNetworks());
  if (networksPagination.currentPage < totalPages) { networksPagination.currentPage++; renderNetworks(); }
});

$("#btn-refresh").addEventListener("click", () => {
  clearContainerSelection();   // explicit refresh resets stale selections
  refreshPage();
});
$("#set-poll").addEventListener("change", e => {
  state.pollInterval = Math.max(2, +e.target.value || 5) * 1000; restartPolling();
});

/* --------------------------------------------------------------- polling */
let pollTimer = null;
function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (["dashboard", "containers"].includes(state.page)) loadContainers();
  }, state.pollInterval);
}

loadSystem().then(() => $("#set-poll").value = Math.round(state.pollInterval / 1000));
refreshPage();
restartPolling();