"use strict";
/* Docker Manager frontend — vanilla JS, Bootstrap 5 */

const state = {
  containers: [], pollInterval: 5000, page: "dashboard",
  search: "", filter: "all", sort: "name",
  pageSize: 10, currentPage: 1,
  images: [], imagesSearch: "", imagesSort: "repo",
  imagesPageSize: 10, imagesCurrentPage: 1,
  imagesSelected: new Set(),
  volumes: [], volumesSearch: "", volumesSort: "name",
  volumesPageSize: 10, volumesCurrentPage: 1,
  networks: [], networksSearch: "", networksSort: "name",
  networksPageSize: 10, networksCurrentPage: 1,
  selected: new Set(), restoreFile: null, restoreBuffer: null,
  logSocket: null, logContainer: null, pendingConfirm: null,
  containersInitialLoadComplete: false,
  // Frontend-only application tile configuration (not persisted)
  appConfig: {},
  // selfh.st icon index cache
  iconIndex: null,
  iconIndexPromise: null,
  // Manual app creation draft state
  manualAppDraft: null,
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* Render an icon for an application card.
   iconValue can be:
   - Bootstrap Icon class (e.g., "bi-speedometer2")
   - selfh.st icon slug (e.g., "grafana")
   - Empty/undefined (use fallback, then try auto-match from containerName)
   containerName: optional, used for automatic icon matching when no explicit icon
   Returns HTML string for the icon element. */
function renderAppIcon(iconValue, containerName) {
  // Priority 1: explicitly saved icon
  if (iconValue) {
    if (iconValue.startsWith("bi-")) {
      return `<i class="bi ${esc(iconValue)} app-card-icon text-accent me-2"></i>`;
    }
    // selfh.st slug
    return `<img src="${esc(getIconSvgUrl(iconValue))}" alt="" class="app-card-icon-img" loading="lazy" onerror="this.src='${esc(getFallbackIconUrl())}';">`;
  }
  // Priority 2: automatic match from container name (if index loaded)
  if (containerName) {
    const autoIcon = findAutoIconMatch(containerName);
    if (autoIcon) {
      return `<img src="${esc(getIconSvgUrl(autoIcon))}" alt="" class="app-card-icon-img" loading="lazy" onerror="this.src='${esc(getFallbackIconUrl())}';">`;
    }
  }
  // Priority 3: fallback
  return `<img src="${esc(getFallbackIconUrl())}" alt="" class="app-card-icon-img" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cpath fill=%22%2338bdf8%22 d=%22M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z%22/%3E%3C/svg%3E';">`;
}

/* ---------------------------------------------------------------- selfh.st icon index */
/* The selfh.st icon index is loaded on-demand when the app config modal opens.
   It is cached in memory for the session to avoid duplicate requests.
   The index is fetched from the selfhst/icons GitHub repository via jsDelivr CDN. */
const ICON_INDEX_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons@main/index-consolidated.json";
const ICON_SVG_BASE_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/";

async function loadIconIndex() {
  if (state.iconIndex) return state.iconIndex;
  if (state.iconIndexPromise) return state.iconIndexPromise;

  state.iconIndexPromise = (async () => {
    try {
      const response = await fetch(ICON_INDEX_URL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      // data is an array of [displayName, slug, ...flags, category, tags, number]
      // We only need displayName and slug
      state.iconIndex = data.map(entry => ({
        name: entry[0],
        slug: entry[1],
        category: entry[7] || "",
        tags: entry[8] || "",
      }));
      return state.iconIndex;
    } catch (e) {
      console.warn("Failed to load selfh.st icon index:", e);
      state.iconIndex = [];
      state.iconIndexPromise = null; // allow retry
      return [];
    }
  })();

  return state.iconIndexPromise;
}

function searchIcons(query, limit = 50) {
  if (!state.iconIndex || !query.trim()) return [];
  const q = query.toLowerCase().trim();
  return state.iconIndex
    .filter(icon =>
      icon.name.toLowerCase().includes(q) ||
      icon.slug.toLowerCase().includes(q) ||
      (icon.tags && icon.tags.toLowerCase().includes(q))
    )
    .slice(0, limit);
}

function getIconSvgUrl(slug) {
  return `${ICON_SVG_BASE_URL}${slug}.svg`;
}

function getFallbackIconUrl() {
  return "/static/logo-2.svg";
}

/* Generate a unique appId for manual applications.
   Uses a prefix that won't collide with Docker container names (which follow ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$).
   The prefix "manual-" is safe since Docker names can't start with "manual-" followed by a UUID pattern. */
function generateManualAppId() {
  // Use crypto.randomUUID() when available (secure, standard)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "manual-" + crypto.randomUUID();
  }
  // Fallback: use crypto.getRandomValues() when available (secure, widely supported)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version (4) and variant (RFC 4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    return "manual-" + bytesToHex(bytes);
  }
  // Last resort: timestamp + random (not cryptographically secure, but unique enough for client-generated IDs)
  // Only used when no crypto API is available (very old browsers or non-secure contexts)
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 15);
  return "manual-" + timestamp + "-" + randomPart;
}

/* Convert Uint8Array to hex string */
function bytesToHex(bytes) {
  const hex = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    hex.push((byte >>> 4).toString(16));
    hex.push((byte & 0x0f).toString(16));
  }
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-");
}

/* Normalize a string for icon matching: lowercase, remove hyphens/underscores/spaces */
function normalizeForIconMatch(s) {
  return (s || "").toLowerCase().replace(/[-_\s]/g, "");
}

/* Find the best selfh.st icon slug for a container name.
   Returns the slug if a confident match exists, otherwise null. */
function findAutoIconMatch(containerName) {
  if (!state.iconIndex || !containerName) return null;
  const normalizedName = normalizeForIconMatch(containerName);
  // 1. Exact normalized match on slug
  let exactMatches = state.iconIndex.filter(icon =>
    normalizeForIconMatch(icon.slug) === normalizedName
  );
  if (exactMatches.length === 1) return exactMatches[0].slug;
  // 2. Exact normalized match on display name
  exactMatches = state.iconIndex.filter(icon =>
    normalizeForIconMatch(icon.name) === normalizedName
  );
  if (exactMatches.length === 1) return exactMatches[0].slug;
  // 3. Token-based match: container name tokens that uniquely identify an icon
  // Split container name into tokens (by common separators)
  const tokens = normalizedName.split(/[-_\s]+/).filter(t => t.length > 2);
  if (tokens.length === 0) return null;
  // Find icons where slug contains all tokens (unambiguous)
  const tokenMatches = state.iconIndex.filter(icon => {
    const normSlug = normalizeForIconMatch(icon.slug);
    return tokens.every(t => normSlug.includes(t));
  });
  if (tokenMatches.length === 1) return tokenMatches[0].slug;
  // No confident match
  return null;
}

/* ---------------------------------------------------------------- URL helpers */
/* Return the effective URL for an application card.
   Priority: saved URL > inferred URL from container ports > null.
   Does not persist inferred URLs. */
function getEffectiveUrl(appName, container) {
  const cfg = state.appConfig[appName] || {};
  if (cfg.url) return cfg.url;
  if (container) return inferContainerUrl(container);
  return null;
}

/* ---------------------------------------------------------------- localStorage persistence for UI preferences */
const PREF_KEY = "dm.ui.prefs.v1";

const DEFAULT_PREFS = {
  dashboard: { search: "", filter: "all", sort: "name", pageSize: 10 },
  containers: { search: "", filter: "all", sort: "name", pageSize: 10 },
  images: { search: "", sort: "repo", pageSize: 10 },
  volumes: { search: "", sort: "name", pageSize: 10 },
  networks: { search: "", sort: "name", pageSize: 10 },
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle missing keys / new pages
    const merged = { ...DEFAULT_PREFS };
    for (const page of Object.keys(DEFAULT_PREFS)) {
      if (parsed[page]) {
        merged[page] = { ...DEFAULT_PREFS[page], ...parsed[page] };
        // Validate known values
        if (page === "dashboard" || page === "containers") {
          const validFilters = ["all", "running", "exited", "stopped", "restarting", "paused"];
          if (!validFilters.includes(merged[page].filter)) merged[page].filter = DEFAULT_PREFS[page].filter;
          const validSorts = ["name", "state", "cpu", "mem", "created"];
          if (!validSorts.includes(merged[page].sort)) merged[page].sort = DEFAULT_PREFS[page].sort;
        } else if (page === "images") {
          const validSorts = ["repo", "tag", "created", "size"];
          if (!validSorts.includes(merged[page].sort)) merged[page].sort = DEFAULT_PREFS[page].sort;
        } else if (page === "volumes" || page === "networks") {
          const validSorts = ["name", "driver"];
          if (!validSorts.includes(merged[page].sort)) merged[page].sort = DEFAULT_PREFS[page].sort;
        }
        // Validate pageSize
        const validPageSizes = [10, 25, 50, -1];
        if (!validPageSizes.includes(merged[page].pageSize)) merged[page].pageSize = DEFAULT_PREFS[page].pageSize;
      }
    }
    return merged;
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

function applyPrefsToState(prefs) {
  // Dashboard / Containers share the same pagination instance (containersPagination)
  // They use the same state keys (search, filter, sort, pageSize)
  // We apply the Dashboard prefs since they are the "primary" for this shared state
  const d = prefs.dashboard || DEFAULT_PREFS.dashboard;
  state.search = d.search;
  state.filter = d.filter;
  state.sort = d.sort;
  state.pageSize = d.pageSize;
  containersPagination.pageSize = d.pageSize === 10 || d.pageSize === 25 || d.pageSize === 50 ? d.pageSize : -1;

  // Images
  const i = prefs.images || DEFAULT_PREFS.images;
  state.imagesSearch = i.search;
  state.imagesSort = i.sort;
  state.imagesPageSize = i.pageSize;
  imagesPagination.pageSize = i.pageSize === 10 || i.pageSize === 25 || i.pageSize === 50 ? i.pageSize : -1;

  // Volumes
  const v = prefs.volumes || DEFAULT_PREFS.volumes;
  state.volumesSearch = v.search;
  state.volumesSort = v.sort;
  state.volumesPageSize = v.pageSize;
  volumesPagination.pageSize = v.pageSize === 10 || v.pageSize === 25 || v.pageSize === 50 ? v.pageSize : -1;

  // Networks
  const n = prefs.networks || DEFAULT_PREFS.networks;
  state.networksSearch = n.search;
  state.networksSort = n.sort;
  state.networksPageSize = n.pageSize;
  networksPagination.pageSize = n.pageSize === 10 || n.pageSize === 25 || n.pageSize === 50 ? n.pageSize : -1;
}

function updatePref(page, key, value) {
  const prefs = loadPrefs();
  if (!prefs[page]) prefs[page] = { ...DEFAULT_PREFS[page] };
  prefs[page][key] = value;
  savePrefs(prefs);
}

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
/* Centralised HTML escaping. Every value interpolated into an innerHTML
   template (text nodes and quoted attribute values alike) MUST go through
   this. Docker-supplied metadata — container/image/volume/network names,
   labels, env values, ports, filenames — is attacker-influenced whenever a
   user can create containers, so it is never trusted as markup. */
const ESC_MAP = { "&": "&", "<": "<", ">": ">", '"': "&", "'": "'", "`": "&#96;" };
const esc = s => String(s ?? "").replace(/[&<>"'`]/g, c => ESC_MAP[c]);

/* ---------------------------------------------------------------- progress bar utilities */
/* Horizontal progress bars for CPU/Memory */

/* CPU and Memory thresholds */
const CPU_THRESHOLDS = { green: 70, amber: 85 };
const MEM_THRESHOLDS = { green: 75, amber: 90 };

/* Get color class for CPU percentage */
const cpuColorClass = pct => {
  if (pct >= CPU_THRESHOLDS.amber) return "progress-red";
  if (pct >= CPU_THRESHOLDS.green) return "progress-amber";
  return "progress-green";
};

/* Get color class for memory percentage */
const memColorClass = pct => {
  if (pct >= MEM_THRESHOLDS.amber) return "progress-red";
  if (pct >= MEM_THRESHOLDS.green) return "progress-amber";
  return "progress-green";
};

/* Format bytes for display (no decimals for whole numbers) */
function fmtBytesCompact(bytes) {
  if (!bytes && bytes !== 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} ${units[i]}` : `${bytes.toFixed(bytes < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

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

/* Get color class for CPU percentage (for container stat tiles) */
const statCpuColorClass = pct => {
  if (pct === undefined || pct === null) return "stat-muted";
  if (pct >= CPU_THRESHOLDS.amber) return "stat-red";
  if (pct >= CPU_THRESHOLDS.green) return "stat-amber";
  return "stat-green";
};

/* Get color class for memory percentage (for container stat tiles) */
const statMemColorClass = (used, limit) => {
  if (!limit || limit <= 0 || used === undefined || used === null) return "stat-muted";
  const pct = (used / limit) * 100;
  if (pct >= MEM_THRESHOLDS.amber) return "stat-red";
  if (pct >= MEM_THRESHOLDS.green) return "stat-amber";
  return "stat-green";
};

/* Format CPU percentage for display */
const fmtCpuPct = pct => {
  if (pct === undefined || pct === null) return "–";
  return pct.toFixed(1) + "%";
}

/* Format memory usage as used only */
const fmtMemUsage = used => {
  if (!used && used !== 0) return "–";
  return fmtBytesCompact(used);
}

/* Compute memory percentage */
const memPercent = (used, limit) => {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

/* Render CPU stats for a tile - compact inline with icon and color */
function renderCpuStats(stats) {
  if (!stats || stats.cpu_percent === undefined || stats.cpu_percent === null) {
    return `<span class="stat-icon-only stat-muted"><i class="bi bi-cpu"></i></span>`;
  }
  const pct = stats.cpu_percent;
  const colorClass = statCpuColorClass(pct);
  return `<span class="stat-inline ${colorClass}"><i class="bi bi-cpu"></i> ${fmtCpuPct(pct)}</span>`;
}

/* Render memory stats for a tile - compact inline with icon and color */
function renderMemStats(stats) {
  if (!stats || stats.mem_usage === undefined || stats.mem_usage === null || !stats.mem_limit || stats.mem_limit <= 0) {
    return `<span class="stat-icon-only stat-text-muted"><i class="bi bi-memory"></i></span>`;
  }
  const used = stats.mem_usage || 0;
  const limit = stats.mem_limit || 0;
  const pct = memPercent(used, limit);
  const colorClass = statMemColorClass(used, limit).replace("stat-", "stat-text-");
  return `<span class="stat-inline ${colorClass}"><i class="bi bi-memory"></i> ${fmtCpuPct(pct)}</span>`;
}

/* Docker status to color mapping */
const DOCKER_STATUS_COLORS = {
  running: "status-green",
  stopped: "status-red",
  exited: "status-purple",
  paused: "status-yellow",
  restarting: "status-cyan",
};

/* Get status color class for Docker container state */
function getDockerStatusColor(state) {
  return DOCKER_STATUS_COLORS[state?.toLowerCase()] || "status-gray";
}

/* Get Docker status label for accessibility */
function getDockerStatusLabel(state) {
  const labels = {
    running: "Running",
    stopped: "Stopped",
    exited: "Exited",
    paused: "Paused",
    restarting: "Restarting",
  };
  return labels[state?.toLowerCase()] || state || "Unknown";
}

/* Render Docker status as a colored dot with accessibility */
function renderDockerStatusDot(state) {
  const colorClass = getDockerStatusColor(state);
  const label = getDockerStatusLabel(state);
  return `<span class="status-dot ${colorClass}" title="${esc(label)}" aria-label="Status: ${esc(label)}"></span>`;
}

/* Render manual app status dot */
function renderManualStatusDot(online, url) {
  if (!url) {
    return `<span class="status-dot status-gray" title="URL not configured" aria-label="Status: URL not configured"></span>`;
  }
  const isOnline = online === true;
  const label = isOnline ? "Online" : "Offline";
  return `<span class="status-dot ${isOnline ? 'status-green' : 'status-red'}" title="${esc(label)}" aria-label="Status: ${esc(label)}"></span>`;
}

/* ---------------------------------------------------------------- helpers */
/* The server-side AUTH_TOKEN is never transmitted to the browser: the backend
   only reports auth_enabled (boolean). The operator types the token once into
   the login modal; it is kept in localStorage and replayed as
   `Authorization: Bearer <token>`. The log WebSocket cannot carry custom
   headers from a browser, so it uses the `?token=` query parameter that
   require_auth_ws already accepts.

   When AUTH_TOKEN is unset no request ever returns 401, so none of this
   activates and behaviour is byte-for-byte identical to the unauthenticated
   baseline. Nothing here logs, embeds or otherwise exposes the token. */
const TOKEN_KEY = "dm.auth.token";
/* localStorage throws in some privacy modes, so fall back to a memory-only
   token for the lifetime of the page rather than breaking the UI. */
let tokenMemory = "";
const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || tokenMemory; } catch { return tokenMemory; }
};
const setToken = t => {
  tokenMemory = t || "";
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
};
/* Set once the backend has answered 401, i.e. auth is definitely required. */
let authRequired = false;
let loginOpen = false;

/* Attach the bearer token to any request. Never logs the value. */
function authHeaders(extra) {
  const h = { ...(extra || {}) };
  const t = getToken();
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

/* Single entry point for API traffic: injects the token and surfaces the
   login prompt on 401. Every raw fetch() call site must go through this. */
async function authFetch(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: authHeaders(opts.headers) });
  if (r.status === 401) {
    authRequired = true;
    promptLogin("Authentication required.");
    throw new Error("Unauthorized");
  }
  return r;
}

async function api(path, opts = {}) {
  const r = await authFetch(path, opts);
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const data = await r.json();
      if (Array.isArray(data.detail)) {
        msg = data.detail
          .map(d => d.msg || d.type || "validation error")
          .join(", ");
      } else {
        msg = data.detail || msg;
      }
    } catch {}
    throw new Error(msg);
  }
  // Handle 204 No Content responses (no body)
  if (r.status === 204) {
    return null;
  }
  return r.headers.get("content-type")?.includes("json") ? r.json() : r;
}

/* Latched so a burst of parallel 401s (a poll plus a page load) opens the
   prompt once instead of stacking modals. Cleared by hidden.bs.modal, so a
   later failure can prompt again. */
function promptLogin(message) {
  if (loginOpen) return;
  loginOpen = true;
  setLoginError(message || "");
  const inp = $("#login-token");
  if (inp) inp.value = "";
  bootstrap.Modal.getOrCreateInstance("#login-modal").show();
}

/* Show the inline alert only when there is something to say. */
function setLoginError(message) {
  const err = $("#login-error");
  if (!err) return;
  err.textContent = message || "";
  err.classList.toggle("d-none", !message);
}

function signOut() {
  setToken("");
  authRequired = false;
  location.reload();
}

function wireLogin() {
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const inp = $("#login-token");
    const token = inp.value.trim();
    if (!token) return;
    const btn = $("#login-submit");
    btn.disabled = true;
    setLoginError("");
    try {
      setToken(token);
      // Verify before dismissing, so a wrong token never looks like success.
      await api("/api/system");
      inp.value = "";
      bootstrap.Modal.getOrCreateInstance("#login-modal").hide();
      // Re-run the normal startup path now that requests will succeed.
      state.containersInitialLoadComplete = false;
      refreshPage();
    } catch {
      setToken("");
      inp.value = "";
      setLoginError("Invalid token. Please try again.");
    } finally {
      btn.disabled = false;
    }
  });
  $("#login-modal").addEventListener("hidden.bs.modal", () => { loginOpen = false; });
  $("#btn-logout").addEventListener("click", () => confirmModal(
    "Sign out", "Forget the stored access token on this browser?", "Sign out",
    signOut, false));
}

/* Application config form handler */
$("#app-config-form").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("#app-config-id").value;
  if (!id) return;
  const cfg = state.appConfig[id] || {};
  // An app is "new" if it's a manual draft, or a Docker app that hasn't been persisted yet
  // (Docker apps are persisted on first save; they have no containerName in state.appConfig until saved)
  const isNew = cfg.isDraft === true || (cfg.type !== "manual" && !cfg.containerName);
  const appType = $("#app-config-modal").dataset.appType || "docker";
  const isManual = appType === "manual";
  const groupValue = $("#app-config-group").value.trim();
  const payload = {
    appId: id,
    type: appType,
    displayName: $("#app-config-name").value.trim(),
    url: $("#app-config-url").value.trim() || null,
    description: $("#app-config-description").value.trim() || null,
    icon: $("#app-config-icon").value.trim() || null,
    group: groupValue === "" ? null : groupValue,
    order: parseInt($("#app-config-order").value || "0", 10) || 0,
  };
  // For Docker apps, include containerName; for manual apps, omit it
  if (!isManual) {
    payload.containerName = id;
  }
  // Preserve containerName and imageDigest if editing existing
  const existing = state.appConfig[id] || {};
  if (existing.containerName) payload.containerName = existing.containerName;
  if (existing.imageDigest) payload.imageDigest = existing.imageDigest;

  const btn = $("#app-config-form button[type=submit]");
  btn.disabled = true;
  try {
    const headers = {
      "Content-Type": "application/json",
      ...authHeaders()
    };
    if (isNew) {
      await api("/api/dashboard/apps", { method: "POST", headers, body: JSON.stringify(payload) });
    } else {
      await api(`/api/dashboard/apps/${encodeURIComponent(id)}`, { method: "PUT", headers, body: JSON.stringify(payload) });
    }
    // Reload config from server to ensure consistency
    await loadAppConfig();
    bootstrap.Modal.getOrCreateInstance("#app-config-modal").hide();
    if (state.page === "dashboard") renderSummary();
    toast("Application tile configuration saved", true);
  } catch (e) {
    toast("Save failed: " + e.message, false);
  } finally {
    btn.disabled = false;
  }
});

/* Delete application handler */
$("#app-config-delete").addEventListener("click", async () => {
  const id = $("#app-config-id").value;
  if (!id) return;

  const cfg = state.appConfig[id] || {};
  const displayName = cfg.name || id;

  // Use native confirm() instead of confirmModal to avoid Bootstrap modal stacking issues
  if (!confirm(`Delete "${displayName}"? This removes the dashboard tile and its configuration. The underlying Docker container (if any) is NOT affected.`)) {
    return;
  }

  const btn = $("#app-config-delete");
  btn.disabled = true;
  try {
    // Use authFetch directly to handle 204 No Content response correctly
    const r = await authFetch(`/api/dashboard/apps/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) {
      let msg = `${r.status}`;
      try {
        const data = await r.json();
        msg = data.detail || msg;
      } catch {}
      throw new Error(msg);
    }
    await loadAppConfig();
    bootstrap.Modal.getOrCreateInstance("#app-config-modal").hide();
    if (state.page === "dashboard") renderSummary();
    toast("Application deleted", true);
  } catch (e) {
    toast("Delete failed: " + e.message, false);
  } finally {
    btn.disabled = false;
  }
});

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
  clearContainerSelection();
  clearImagesSelection();   // selection never persists across page changes
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
    state.hostMemory = d.engine.host_memory || 0;
    state.pollInterval = (d.settings.poll_interval || 5) * 1000;
    $("#app-version").textContent = `V.${d.settings.app_version || "—"}`;
    // Only offer sign-out once a token is actually stored in this browser.
    if ($("#logout-wrap")) $("#logout-wrap").classList.toggle("d-none", !getToken());
    $("#settings-list").innerHTML = [
      ["Application name", esc(d.settings.app_name)],
      ["Backup directory", esc(d.settings.backup_dir)],
      ["Max upload (MB)", esc(d.settings.max_upload_mb)],
      ["Default log lines", esc(d.settings.log_default_lines)],
      ["Authentication", d.settings.auth_enabled
        ? '<span class="ok-chip">enabled</span>'
        : '<span class="warn-chip">disabled — restrict to trusted LAN</span>'],
    ].map(([k, v]) => `<dt class="col-sm-4 text-muted">${k}</dt><dd class="col-sm-8">${v}</dd>`).join("");
  } catch (e) { /* backend down */ }

  // Load persisted application configurations (Dashboard only)
  if (state.page === "dashboard") {
    await loadAppConfig();
  }
}

/* Load persisted application configurations from the API. */
async function loadAppConfig() {
  try {
    const apps = await api("/api/dashboard/apps");
    state.appConfig = {};
    for (const app of apps) {
      state.appConfig[app.appId] = {
        name: app.displayName,
        url: app.url || "",
        description: app.description || "",
        icon: app.icon || "",
        group: app.group || "",
        order: app.order || 0,
        containerName: app.containerName,
        imageDigest: app.imageDigest,
        type: app.type || "docker",
      };
    }
  } catch (e) {
    // Fallback gracefully — the Dashboard will still work with generated cards
    console.warn("Failed to load dashboard app config:", e);
  }
}

/* ------------------------------------------------------------- containers */
/* Transient container-fetch failures must not wipe a good render, and must not
   re-toast on every 5s poll tick. Kept module-level so the documented `state`
   object shape is unchanged. */
let containerErrorActive = false;
let lastContainerErrorToast = 0;
const CONTAINER_ERROR_TOAST_MS = 30000;

/* Announce a containers-fetch failure at most once per quiet period, and only
   when entering the error state (reset on the next success). */
function notifyContainerError(message) {
  const now = Date.now();
  if (containerErrorActive && now - lastContainerErrorToast < CONTAINER_ERROR_TOAST_MS) return;
  containerErrorActive = true;
  lastContainerErrorToast = now;
  toast("Containers unavailable: " + message, false);
}

async function loadContainers() {
  const isInitialLoad = !state.containersInitialLoadComplete;
  // Only show the Dashboard spinner when there is genuinely nothing on screen
  // yet; otherwise a failed first load followed by a failed poll would replace
  // existing rows with a spinner that the error branch then leaves behind.
  const showDashboardLoader =
    state.page === "dashboard" && isInitialLoad && !state.containers.length;

  if (showDashboardLoader) showDashboardLoading(true);

  try {
    state.containers = await api("/api/containers");
  } catch (e) {
    const msg = e.message || "Request failed";
    // Already-rendered data stays on screen; only an empty view is replaced.
    const hasData = state.containers.length > 0;
    if (state.page === "dashboard") {
      if (!hasData) {
        // Visible in the Dashboard itself — the old code wrote to the hidden
        // Containers tbody, so a Dashboard failure was invisible and left the
        // first-load spinner spinning forever.
        $("#dashboard-list").innerHTML = `<div class="card dm-card"><div class="table-responsive">
          <table class="table mb-0"><tbody><tr>
            <td class="text-center text-danger py-4">
              <i class="bi bi-exclamation-triangle"></i> ${esc(msg)}
            </td></tr></tbody></table></div></div>`;
        const ctl = $("#dashboard-pagination-controls");
        if (ctl) ctl.classList.remove("d-none");   // spinner had hidden these
      }
      notifyContainerError(msg);
      return;
    }
    if (!hasData && $("#container-tbody")) {
      $("#container-tbody").innerHTML =
        `<tr><td colspan="9" class="text-center text-danger py-4">${esc(msg)}</td></tr>`;
    }
    notifyContainerError(msg);
    return;
  }
  containerErrorActive = false;
  // Drop selections pointing at containers that no longer exist (stale state).
  const ids = new Set(state.containers.map(c => c.id));
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  // NOTE: no resetPage() here. A poll refresh must keep the reader on the page
  // they chose; the renderers clamp with adjustPage() when the result set
  // shrinks, and every explicit control change still calls resetPage() itself.
  if (state.page === "dashboard") {
    if (showDashboardLoader) showDashboardLoading(false);
    renderSummary();
  } else {
    renderSummary(); renderContainers();
  }
  updateSelCount();

  // Mark initial load as complete after first successful load
  if (isInitialLoad) {
    state.containersInitialLoadComplete = true;
  }
}

/* Single point to reset the container selection: IDs, checkboxes,
   counter and the "Backup selected" button. */
function clearImagesSelection() {
  if (!state.imagesSelected.size) return;
  state.imagesSelected.clear();
  $$("#images-tbody .sel").forEach(cb => { cb.checked = false; });
  const all = $("#images-sel-all"); if (all) all.checked = false;
  updateImagesSelCount();
}

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

/* Build unified list of Dashboard applications: Docker containers + manual apps.
   Manual apps are those in state.appConfig with type "manual" that don't have a matching Docker container.
   Returns a sorted, filtered list supporting search, filter, and sort controls. */
function getDashboardApplications() {
  // Start with Docker containers
  const dockerApps = filteredContainers();

  // Find manual apps that don't have a matching Docker container
  const manualApps = [];
  for (const [appId, cfg] of Object.entries(state.appConfig)) {
    if (cfg.type === "manual") {
      // Check if there's a Docker container with the same name
      const hasContainer = state.containers.some(c => c.name === appId);
      if (!hasContainer) {
        // Create a pseudo-container object for manual apps
        manualApps.push({
          id: appId,
          name: appId,
          short_id: "",
          image: "",
          state: "manual",
          created: "",
          stats: {},
          ports: {},
          // Add config fields for easy access
          _cfg: state.appConfig[appId],
        });
      }
    }
  }

  // Combine and apply search filter
  const allApps = [...dockerApps, ...manualApps];

  // Apply search filter
  let list = allApps.filter(app => {
    if (!state.search) return true;
    const search = state.search.toLowerCase();
    // Search by name for both Docker and manual apps
    const nameMatch = app.name.toLowerCase().includes(search);
    // For Docker apps, also search by image
    const imageMatch = app.image && app.image.toLowerCase().includes(search);
    return nameMatch || imageMatch;
  });

  // Apply state filter
  // For Docker apps: filter by state (running, exited, stopped, restarting, paused)
  // For manual apps: they only appear in "all" filter (or we could add a "manual" filter)
  list = list.filter(app => {
    if (state.filter === "all") return true;
    if (state.filter === "manual") return app.state === "manual";
    // Docker-specific states
    return app.state === state.filter;
  });

  // Apply sorting
  const sortKey = state.sort;
  list = [...list].sort((a, b) => {
    switch (sortKey) {
      case "name":
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      case "state":
        return a.state.localeCompare(b.state);
      case "cpu":
        return (b.stats?.cpu_percent || 0) - (a.stats?.cpu_percent || 0);
      case "mem":
        return (b.stats?.mem_usage || 0) - (a.stats?.mem_usage || 0);
      case "created":
        return (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0);
      default:
        return 0;
    }
  });

  return list;
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
  const id = esc(c.id), n = esc(c.name);
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
  const memLimit = running.reduce((s, x) => s + (x.stats?.mem_limit || 0), 0);
  const hostMem = state.hostMemory || 0;

  // Calculate percentages for CPU and Memory
  const cpuPct = Math.min(100, Math.max(0, Number(cpu) || 0));
  const memPct = hostMem > 0 ? Math.min(100, Math.max(0, (mem / hostMem) * 100)) : (memLimit > 0 ? Math.min(100, Math.max(0, (mem / memLimit) * 100)) : 0);

  // All 6 tiles with unified data structure
  const allTiles = [
    { type: "counter", label: "Total", value: c.length, icon: "boxes", colorClass: "" },
    { type: "counter", label: "Running", value: running.length, icon: "play-circle", colorClass: "" },
    { type: "counter", label: "Stopped", value: cnt(x => ["exited", "created", "dead"].includes(x.state)), icon: "stop-circle", colorClass: "" },
    { type: "counter", label: "Restarting", value: cnt(x => x.state === "restarting"), icon: "arrow-repeat", colorClass: "" },
    { type: "progress", label: "CPU", value: cpuPct.toFixed(1) + "%", icon: "cpu-fill", pct: cpuPct, thresholds: CPU_THRESHOLDS, unit: "%" },
    { type: "progress", label: "Memory", value: hostMem > 0 ? memPct.toFixed(1) + "%" : (memLimit > 0 ? memPct.toFixed(1) + "%" : "N/D"), icon: "memory", pct: memPct, thresholds: MEM_THRESHOLDS, unit: "", hasLimit: hostMem > 0 || memLimit > 0, pctStr: hostMem > 0 ? memPct.toFixed(1) + "%" : (memLimit > 0 ? memPct.toFixed(1) + "%" : "N/A") },
  ];

  $("#summary-cards").innerHTML = `
    <div class="row g-1 summary-row stats-row">
      ${allTiles.map(t => `
        <div class="col-6 col-md-4 col-lg-2"><div class="dm-card stat-card stat-tile">
          <div class="stat-tile-content">
            <div class="stat-tile-main">
              <i class="bi bi-${t.icon} text-accent"></i>
              <div class="stat-tile-text">
                <div class="stat-tile-label">${esc(t.label)}</div>
                <div class="stat-tile-value ${t.colorClass || (t.type === "progress" ? (t.pct >= t.thresholds.amber ? "progress-red" : t.pct >= t.thresholds.green ? "progress-amber" : "progress-green") : "")}">${esc(t.value)}</div>
                ${t.type === "progress" && t.pctStr && t.label !== "Memory"
  ? `<div class="stat-tile-pct ${t.pct >= t.thresholds.amber ? "progress-red" : t.pct >= t.thresholds.green ? "progress-amber" : "progress-green"}">${esc(t.pctStr)}</div>`
  : ""}
              </div>
            </div>
            ${t.type === "progress" ? `
              <div class="stat-tile-bar-wrap" role="progressbar" aria-valuenow="${t.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(t.label + " " + t.pct.toFixed(1) + "%")}">
                <div class="stat-tile-bar ${t.pct >= t.thresholds.amber ? "progress-red" : t.pct >= t.thresholds.green ? "progress-amber" : "progress-green"}" style="height: ${t.pct}%"></div>
              </div>
            ` : ""}
          </div>
        </div></div>`).join("")}
    </div>`;

  // Dashboard applications — grouped and paginated card grid.
  // Clamp BEFORE slicing so a poll that shrinks the result set lands on the last valid page.
  // Build unified list of applications: Docker containers + manual apps (from appConfig without matching container)
  const filtered = getDashboardApplications();

  let flatForPagination;
  let sortedPaginatedGroups;
  let ungroupedItems = [];

  if (state.sort === "name") {
    // Default behavior: group by configured group, sort within groups by order then name
    const appsByGroup = new Map();
    ungroupedItems = [];
    for (const x of filtered) {
      const cfg = state.appConfig[x.name] || {};
      const group = (cfg.group || "").trim();
      if (group) {
        if (!appsByGroup.has(group)) {
          appsByGroup.set(group, { label: group, items: [] });
        }
        appsByGroup.get(group).items.push(x);
      } else {
        ungroupedItems.push(x);
      }
    }

    for (const group of appsByGroup.values()) {
      group.items.sort((a, b) => {
        const cfgA = state.appConfig[a.name] || {};
        const cfgB = state.appConfig[b.name] || {};
        const orderA = cfgA.order || 0;
        const orderB = cfgB.order || 0;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
    }

    const sortedGroups = [...appsByGroup.entries()].sort(([keyA], [keyB]) =>
      appsByGroup.get(keyA).label.localeCompare(appsByGroup.get(keyB).label)
    );

    // Sort ungrouped items by order then name
    ungroupedItems.sort((a, b) => {
      const cfgA = state.appConfig[a.name] || {};
      const cfgB = state.appConfig[b.name] || {};
      const orderA = cfgA.order || 0;
      const orderB = cfgB.order || 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

    flatForPagination = [];
    for (const [, group] of sortedGroups) {
      flatForPagination.push(...group.items);
    }
    flatForPagination.push(...ungroupedItems);

    containersPagination.adjustPage(containersPagination.getTotalPages(flatForPagination));
    const paginated = containersPagination.getPaginatedList(flatForPagination);

    const paginatedByGroup = new Map();
    const paginatedUngrouped = [];
    for (const x of paginated) {
      const cfg = state.appConfig[x.name] || {};
      const group = (cfg.group || "").trim();
      if (group) {
        if (!paginatedByGroup.has(group)) {
          paginatedByGroup.set(group, { label: group, items: [] });
        }
        paginatedByGroup.get(group).items.push(x);
      } else {
        paginatedUngrouped.push(x);
      }
    }

    sortedPaginatedGroups = [...paginatedByGroup.entries()].sort(([keyA], [keyB]) =>
      paginatedByGroup.get(keyA).label.localeCompare(paginatedByGroup.get(keyB).label)
    );
    ungroupedItems = paginatedUngrouped;
  } else {
    // User selected a specific sort (state, cpu, mem, created): respect the sort order
    // Use the flat sorted list from getDashboardApplications() directly for pagination
    flatForPagination = filtered;
    containersPagination.adjustPage(containersPagination.getTotalPages(flatForPagination));
    const paginated = containersPagination.getPaginatedList(flatForPagination);

    // Separate grouped and ungrouped items, preserving sort order
    const paginatedByGroup = new Map();
    ungroupedItems = [];
    const groupOrder = new Map();
    let orderIndex = 0;
    for (const x of paginated) {
      const cfg = state.appConfig[x.name] || {};
      const group = (cfg.group || "").trim();
      if (group) {
        if (!paginatedByGroup.has(group)) {
          paginatedByGroup.set(group, { label: group, items: [] });
          groupOrder.set(group, orderIndex++);
        }
        paginatedByGroup.get(group).items.push(x);
      } else {
        ungroupedItems.push(x);
      }
    }
    sortedPaginatedGroups = [...paginatedByGroup.entries()].sort(([keyA], [keyB]) => {
      const orderA = groupOrder.get(keyA) ?? Infinity;
      const orderB = groupOrder.get(keyB) ?? Infinity;
      return orderA - orderB;
    });
  }

  // Render cards: ungrouped items first (no group header), then each group with header
  let cardsHtml = "";

  // Render ungrouped items first
  if (ungroupedItems.length > 0) {
    cardsHtml += `
      <div class="col-12 mb-3">
        <div class="row g-3">
          ${ungroupedItems.map(x => {
            const cfg = state.appConfig[x.name] || {};
            const isManual = cfg.type === "manual";
            const container = isManual ? {} : (state.containers.find(c => c.name === x.name) || {});
            const hasContainer = !isManual && !!container.id;
            const displayName = cfg.name || x.name;
            const displayUrl = getEffectiveUrl(x.name, container);
            const displayDesc = cfg.description || "";
            const nameHtml = displayUrl
              ? `<a href="${esc(displayUrl)}" target="_blank" rel="noopener" class="app-card-link text-decoration-none" data-app-url="${esc(displayUrl)}"><span class="app-card-name-text">${esc(displayName)}</span></a>`
              : `<span class="app-card-name"><span class="app-card-name-text">${esc(displayName)}</span></span>`;
            const iconHtml = renderAppIcon(cfg.icon, isManual ? null : x.name);
            const descHtml = displayDesc ? `<div class="app-card-description text-muted small">${esc(displayDesc)}</div>` : "";
            const statusHtml = isManual
              ? renderManualStatusDot(container?.online ?? false, cfg.url)
              : renderDockerStatusDot(container.state);
            const statsHtml = isManual ? "" : (renderCpuStats(container.stats) + " " + renderMemStats(container.stats));
            const urlHtml = displayUrl ? `<div class="app-card-url text-truncate"><span class="text-muted small">${esc(new URL(displayUrl).host)}</span></div>` : `<div class="app-card-url-placeholder"></div>`;
            const cardTabIndex = hasContainer ? '0' : '-1';
            const cardRole = hasContainer ? 'button' : '';
            const cardAriaLabel = hasContainer ? `aria-label="View ${esc(displayName)} details"` : '';
            return `
            <div class="col-12 col-sm-6 col-lg-4 col-xl-3">
              <div class="app-card" data-id="${esc(x.id)}" data-name="${esc(x.name)}" data-has-container="${hasContainer}" ${cardRole} tabindex="${cardTabIndex}" ${cardAriaLabel}>
                <div class="app-card-header">
                  <div class="app-card-title-row">
                    ${iconHtml}${nameHtml}
                    ${statusHtml}
                  </div>
                </div>
                ${urlHtml}
                ${descHtml}
                <div class="app-card-stats d-flex align-items-center justify-content-between">
                  <span>${statsHtml}</span>
                  <div class="app-card-actions">
                    <button class="btn btn-sm btn-outline-secondary app-edit-btn" data-edit-name="${esc(x.name)}" title="Configure tile" aria-label="Configure ${esc(displayName)}">
                      <i class="bi bi-pencil-square"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  // Render grouped items
  for (const [, group] of sortedPaginatedGroups) {
    if (group.items.length === 0) continue;
    cardsHtml += `
      <div class="col-12 mb-3">
        <h6 class="text-muted small text-uppercase fw-semibold mb-2 border-bottom pb-1">
          ${esc(group.label)}
        </h6>
        <div class="row g-3">
          ${group.items.map(x => {
            const cfg = state.appConfig[x.name] || {};
            const isManual = cfg.type === "manual";
            const container = isManual ? {} : (state.containers.find(c => c.name === x.name) || {});
            const hasContainer = !isManual && !!container.id;
            const displayName = cfg.name || x.name;
            const displayUrl = getEffectiveUrl(x.name, container);
            const displayDesc = cfg.description || "";
            const nameHtml = displayUrl
              ? `<a href="${esc(displayUrl)}" target="_blank" rel="noopener" class="app-card-link text-decoration-none" data-app-url="${esc(displayUrl)}"><span class="app-card-name-text">${esc(displayName)}</span></a>`
              : `<span class="app-card-name"><span class="app-card-name-text">${esc(displayName)}</span></span>`;
            const iconHtml = renderAppIcon(cfg.icon, isManual ? null : x.name);
            const descHtml = displayDesc ? `<div class="app-card-description text-muted small">${esc(displayDesc)}</div>` : "";
            const statusHtml = isManual
              ? renderManualStatusDot(container?.online ?? false, cfg.url)
              : renderDockerStatusDot(container.state);
            const statsHtml = isManual ? "" : (renderCpuStats(container.stats) + " " + renderMemStats(container.stats));
            const urlHtml = displayUrl ? `<div class="app-card-url text-truncate"><span class="text-muted small">${esc(new URL(displayUrl).host)}</span></div>` : `<div class="app-card-url-placeholder"></div>`;
            const cardTabIndex = hasContainer ? '0' : '-1';
            const cardRole = hasContainer ? 'button' : '';
            const cardAriaLabel = hasContainer ? `aria-label="View ${esc(displayName)} details"` : '';
            return `
            <div class="col-12 col-sm-6 col-lg-4 col-xl-3">
              <div class="app-card" data-id="${esc(x.id)}" data-name="${esc(x.name)}" data-has-container="${hasContainer}" ${cardRole} tabindex="${cardTabIndex}" ${cardAriaLabel}>
                <div class="app-card-header">
                  <div class="app-card-title-row">
                    ${iconHtml}${nameHtml}
                    ${statusHtml}
                  </div>
                </div>
                ${urlHtml}
                ${descHtml}
                <div class="app-card-stats d-flex align-items-center justify-content-between">
                  <span>${statsHtml}</span>
                  <div class="app-card-actions">
                    <button class="btn btn-sm btn-outline-secondary app-edit-btn" data-edit-name="${esc(x.name)}" title="Configure tile" aria-label="Configure ${esc(displayName)}">
                      <i class="bi bi-pencil-square"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  cardsHtml = cardsHtml || `<div class="col-12"><div class="text-center text-muted py-4">No applications found</div></div>`;
  $("#dashboard-apps").innerHTML = cardsHtml;

  renderDashboardPagination();

  // Attach click/keyboard handlers to application cards
  $$("#dashboard-apps .app-card").forEach(card => {
    const hasContainer = card.dataset.hasContainer === "true";
    if (hasContainer) {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".app-edit-btn") || e.target.closest(".app-card-link")) return;
        openDetails(card.dataset.id, card.dataset.id);
      });
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetails(card.dataset.id, card.dataset.id);
        }
      });
    } else {
      // Remove button role/tabindex for non-clickable cards (already set in HTML)
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.removeAttribute("aria-label");
    }
  });

  // Attach edit button handlers
  $$("#dashboard-apps .app-edit-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAppConfig(btn.dataset.editName);
    });
  });
}

function renderContainers() {
  const filtered = filteredContainers();
  containersPagination.adjustPage(containersPagination.getTotalPages(filtered));
  const list = containersPagination.getPaginatedList(filtered);

  $("#container-tbody").innerHTML = list.map(c => `<tr>
    <td><input class="form-check-input sel" type="checkbox" data-id="${esc(c.id)}" ${state.selected.has(c.id) ? "checked" : ""}></td>
    <td><a href="#" class="text-decoration-none text-accent fw-semibold" data-details="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}</a>
        <div class="text-muted small">${esc(c.short_id)}</div></td>
    <td class="text-muted small">${esc(c.image)}</td>
    <td>${badge(c.state)}${c.restart_count ? ` <span class="text-muted small">↻${esc(c.restart_count)}</span>` : ""}</td>
    <td class="small text-muted">${c.state === "running" ? esc(fmtUptime(c.started_at)) : "–"}</td>
    <td class="small">${renderPorts(c)}</td>
    <td class="small">${c.state === "running" ? esc(c.stats?.cpu_percent ?? "–") + "%" : "–"}</td>
    <td class="small">${c.state === "running" ? esc(fmtBytes(c.stats?.mem_usage)) : "–"}</td>
    <td class="text-end text-nowrap">${actionButtons(c)}</td></tr>`).join("") ||
    `<tr><td colspan="9" class="text-center text-muted py-4">No containers found</td></tr>`;

  $("#container-cards").innerHTML = list.map(c => `
    <div class="col-12"><div class="container-card">
      <div class="d-flex align-items-center gap-2">
        <input class="form-check-input sel" type="checkbox" data-id="${esc(c.id)}" ${state.selected.has(c.id) ? "checked" : ""}>
        <a href="#" class="text-decoration-none text-accent fw-semibold" data-details="${esc(c.id)}" data-name="${esc(c.name)}">${esc(c.name)}</a>
        <span class="ms-auto">${badge(c.state)}</span></div>
      <div class="small text-muted mt-1">${esc(c.image)} · ${esc(c.short_id)}</div>
      <div class="mt-1">${renderPorts(c)}</div>
      <div class="d-flex justify-content-between align-items-center mt-2">
        <span class="small text-muted">${c.state === "running" ? `CPU ${esc(c.stats?.cpu_percent ?? "–")}% · ${esc(fmtBytes(c.stats?.mem_usage))}` : "offline"}</span>
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
  const listEl = $("#dashboard-apps");
  if (!listEl) return;
  if (show) {
    listEl.innerHTML = `<div class="col-12"><div class="card dm-card"><div class="table-responsive">
      <table class="table table-hover align-middle mb-0"><tbody>
        <tr><td colspan="5" class="text-center py-4">
          <div class="d-flex flex-column align-items-center gap-2">
            <div class="spinner-border text-accent" role="status" aria-hidden="true"></div>
            <span class="text-muted small">Loading applications…</span>
          </div>
        </td></tr>
      </tbody></table></div></div></div>`;
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
      `<tr><td colspan="8" class="text-center text-danger py-4">${esc(e.message)}</td></tr>`;
    return;
  }
  imagesPagination.resetPage();
  renderImages();
}

function updateImagesSelCount() {
  const count = state.imagesSelected.size;
  $("#images-sel-count").textContent = count;
  $("#btn-images-delete-selected").disabled = count === 0;
}

function renderImages() {
  const filtered = filteredImages();
  imagesPagination.adjustPage(imagesPagination.getTotalPages(filtered));
  const list = imagesPagination.getPaginatedList(filtered);

  $("#images-tbody").innerHTML = list.map(i => `<tr>
    <td><input class="form-check-input sel" type="checkbox" data-id="${esc(i.id)}" ${state.imagesSelected.has(i.id) ? "checked" : ""}></td>
    <td class="fw-semibold">${esc(i.repo)}${i.dangling ? ' <span class="warn-chip">dangling</span>' : ""}</td>
    <td>${esc(i.tag)}</td>
    <td><code class="small">${esc(i.short_id)}</code></td>
    <td class="small text-muted">${esc(fmtDate(i.created))}</td>
    <td class="small">${esc(fmtBytes(i.size))}</td>
    <td>${i.in_use ? '<span class="ok-chip">in use</span>' : "–"}</td>
    <td class="text-end"><button class="btn btn-sm btn-outline-danger action-btn"
        data-rmimgid="${esc(i.id)}" data-ref="${esc(i.repo + ":" + i.tag)}"
        data-inuse="${esc(i.in_use)}" data-ntags="${esc(i.tag_count)}">
      <i class="bi bi-trash"></i></button></td></tr>`).join("") ||
    `<tr><td colspan="8" class="text-center text-muted py-4">No images</td></tr>`;

  // Single image delete buttons
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

  // Checkbox selection handlers
  $$("#images-tbody .sel").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      e.target.checked ? state.imagesSelected.add(id) : state.imagesSelected.delete(id);
      updateImagesSelCount();
      updateImagesSelAllState();
    });
  });

  // Select all checkbox
  const selAll = $("#images-sel-all");
  if (selAll) {
    const allSelected = list.length > 0 && list.every(i => state.imagesSelected.has(i.id));
    const someSelected = list.some(i => state.imagesSelected.has(i.id));
    selAll.checked = allSelected;
    selAll.indeterminate = someSelected && !allSelected;
  }

  updateImagesSelCount();
  renderImagesPagination();
}

function updateImagesSelAllState() {
  const selAll = $("#images-sel-all");
  if (!selAll) return;
  const filtered = filteredImages();
  const list = imagesPagination.getPaginatedList(filtered);
  const allSelected = list.length > 0 && list.every(i => state.imagesSelected.has(i.id));
  const someSelected = list.some(i => state.imagesSelected.has(i.id));
  selAll.checked = allSelected;
  selAll.indeterminate = someSelected && !allSelected;
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
      <td class="small">${esc(b.filename)}</td><td class="small">${esc(fmtBytes(b.size))}</td>
      <td class="small text-muted">${esc(fmtDate(b.created))}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-accent action-btn" href="/api/backups/${encodeURIComponent(esc(b.filename))}/download"><i class="bi bi-download"></i></a>
        <button class="btn btn-sm btn-outline-accent action-btn" data-bkrestore="${esc(b.filename)}"><i class="bi bi-arrow-counterclockwise"></i></button>
        <button class="btn btn-sm btn-outline-danger action-btn" data-bkdel="${esc(b.filename)}"><i class="bi bi-trash"></i></button>
      </td></tr>`).join("") ||
      `<tr><td colspan="4" class="text-center text-muted py-4">No backups yet</td></tr>`;
    $$("[data-bkdel]").forEach(b => b.addEventListener("click", () =>
      confirmModal("Delete backup", `Delete <b>${esc(b.dataset.bkdel)}</b>?`, "Delete", async () => {
        try { await api(`/api/backups/${encodeURIComponent(b.dataset.bkdel)}`, { method: "DELETE" });
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
          () => api(`/api/backups/${encodeURIComponent(filename)}/summary`));
        renderRestorePreview(s, `/api/backups/${encodeURIComponent(filename)}/download`, filename);
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
      const r = await authFetch("/api/restore/preview", { method: "POST", body: fd });
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
      <div class="small text-muted mb-2">Created: ${esc(fmtDate(m.created))} ·
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
        else { const blob = await (await authFetch(downloadUrl)).blob(); fd.append("file", blob, storedName); }
        const r = await authFetch("/api/restore", { method: "POST", body: fd });
        if (!r.ok) throw new Error((await r.json()).detail);
        const results = await r.json();
        results.forEach(x => x.ok ? toast(`Restored ${x.name}`) : toast(`Restore ${x.name} failed: ${x.error}`, false));
        loadContainers();
      });
    } catch (e) { toast("Restore failed: " + e.message, false); }
    finally { btn.disabled = false; }
  });
}

/* ------------------------------------------------------------------- logs */
async function openDetails(id, name) {
  $("#details-name").textContent = name;
  const body = $("#details-body");
  body.innerHTML = '<div class="text-center text-muted py-5"><div class="spinner-border spinner-border-sm"></div></div>';
  bootstrap.Modal.getOrCreateInstance("#details-modal").show();
  try {
    const d = await api(`/api/containers/${id}`);
    const kv = (k, v) => `<tr><td class="k text-muted" style="width:220px">${esc(k)}</td><td class="kv">${v}</td></tr>`;
    const sec = (title, rows) => `<div class="details-section"><h6>${esc(title)}</h6>
      <table class="table table-sm mb-0">${rows}</table></div>`;
    const labels = Object.entries(d.labels || {}).map(([k, v]) => `${k}=${v}`).join("  ");
    const envMasked = d.env.map(e => kv(e.key, esc(e.value)));
    body.innerHTML =
      sec("General",
        kv("Name", esc(d.name)) + kv("ID", `<code>${esc(d.id.slice(0, 12))}</code>`) +
        kv("Image", esc(d.image)) + kv("State", badge(d.state.Status || "")) +
        kv("Status", esc(d.state.Status)) + kv("Created", esc(fmtDate(d.created))) +
        kv("Started", esc(fmtDate(d.state.StartedAt))) + kv("Finished", esc(fmtDate(d.state.FinishedAt)))) +
      sec("Configuration",
        kv("Command", esc((d.cmd || []).join(" ") || "–")) +
        kv("Entrypoint", esc((d.entrypoint || []).join(" ") || "–")) +
        kv("Working dir", esc(d.working_dir || "–")) + kv("User", esc(d.user || "root")) +
        kv("Restart policy", esc(`${d.restart_policy.Name || "no"} ${d.restart_policy.MaximumRetryCount ? `(max ${d.restart_policy.MaximumRetryCount})` : ""}`)) +
        kv("Env (" + d.env.length + ")",
           `<button class="btn btn-sm btn-outline-accent" id="reveal-env">show values</button>`) +
        kv("Labels", esc(labels || "none"))) +
      `<div class="details-section" id="env-section"><h6>Environment</h6>
        <table class="table table-sm mb-0" id="env-table">${envMasked.join("") || '<tr><td class="text-muted">none</td></tr>'}</table></div>` +
      sec("Network",
        Object.entries(d.networks).map(([n, v]) =>
          kv(n, esc(`${v.IPAddress || "–"}  ${v.MacAddress || ""}`))).join("") +
        kv("Ports", Object.entries(d.ports).map(([p, b]) =>
          esc(p + " → " + (b ? b.map(x => `${x.HostIp || ""}:${x.HostPort}`).join(", ") : "–"))).join("<br>") || "–")) +
      sec("Mounts",
        d.mounts.map(m => kv(`${m.Type}: ${m.Name || m.Source}`,
          esc(`${m.Destination} (${m.RW ? "rw" : "ro"})`))).join("") || '<tr><td class="text-muted">none</td></tr>');
    $("#reveal-env").addEventListener("click", async () => {
      if (!confirm("Reveal environment values? They may contain secrets.")) return;
      const env = await api(`/api/containers/${id}/env`);
      $("#env-table").innerHTML = env.map(e => kv(e.key, esc(e.value))).join("");
    });
  } catch (e) { body.innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
}

// Open application configuration modal
function openAppConfig(id) {
  const cfg = state.appConfig[id] || {};
  const isManual = cfg.type === "manual";
  const container = isManual ? {} : (state.containers.find(c => c.name === id) || {});
  const inferredUrl = isManual ? null : inferContainerUrl(container);
  const iconValue = cfg.icon || "";

  // For selfh.st icons (non-bootstrap), show the slug in the search field
  const isBootstrapIcon = iconValue.startsWith("bi-");
  const searchDisplayValue = isBootstrapIcon ? "" : iconValue;

  $("#app-config-id").value = id;
  $("#app-config-name").value = cfg.name || (isManual ? "" : container.name) || "";
  $("#app-config-url").value = cfg.url || inferredUrl || "";
  $("#app-config-description").value = cfg.description || "";
  $("#app-config-icon").value = iconValue;
  $("#app-config-icon-search").value = searchDisplayValue;
  $("#app-config-icon-results").innerHTML = "";
  $("#app-config-icon-results").classList.add("d-none");
  $("#app-config-group").value = cfg.group || "";
  $("#app-config-order").value = cfg.order || 0;

  // Store the app type in a data attribute for the form submit handler
  $("#app-config-modal").dataset.appType = cfg.type || "docker";

  // Pre-load icon index in background (non-blocking)
  loadIconIndex().catch(() => {});

  bootstrap.Modal.getOrCreateInstance("#app-config-modal").show();
}

/* selfh.st icon search UI for app config modal */
let iconSearchDebounceTimer = null;
let iconSearchSelectedSlug = null;

function setupIconSearch() {
  const searchInput = $("#app-config-icon-search");
  const resultsContainer = $("#app-config-icon-results");
  const hiddenInput = $("#app-config-icon");

  if (!searchInput || !resultsContainer || !hiddenInput) return;

  // Clear any existing listeners by cloning and replacing
  const newSearchInput = searchInput.cloneNode(true);
  searchInput.parentNode.replaceChild(newSearchInput, searchInput);

  newSearchInput.addEventListener("input", () => {
    clearTimeout(iconSearchDebounceTimer);
    iconSearchDebounceTimer = setTimeout(() => {
      performIconSearch(newSearchInput.value, resultsContainer, hiddenInput);
    }, 150);
  });

  // Close results when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#app-config-icon-search") &&
        !e.target.closest("#app-config-icon-results")) {
      resultsContainer.classList.add("d-none");
    }
  });

  // Handle modal hide to clean up
  const modalEl = $("#app-config-modal");
  if (modalEl) {
    modalEl.addEventListener("hidden.bs.modal", () => {
      clearTimeout(iconSearchDebounceTimer);
      resultsContainer.classList.add("d-none");
      resultsContainer.innerHTML = "";
      iconSearchSelectedSlug = null;
      // Clean up manual app draft if it was not saved
      if (state.manualAppDraft) {
        const draftId = state.manualAppDraft;
        const draftCfg = state.appConfig[draftId] || {};
        // Only remove if it's a manual app that was just created (still a draft)
        if (draftCfg.isDraft === true) {
          delete state.appConfig[draftId];
        }
        state.manualAppDraft = null;
      }
    });
  }
}

/* Group autocomplete suggestions */
let groupSuggestionsActiveIndex = -1;

function getUniqueGroups() {
  const groups = new Map();
  for (const cfg of Object.values(state.appConfig)) {
    const group = (cfg.group || "").trim();
    if (!group) continue;
    const lower = group.toLowerCase();
    if (!groups.has(lower)) {
      groups.set(lower, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.localeCompare(b));
}

function filterGroups(query, groups) {
  if (!query.trim()) return groups;
  const q = query.toLowerCase().trim();
  const prefixMatches = [];
  const substringMatches = [];
  for (const group of groups) {
    const lower = group.toLowerCase();
    if (lower.startsWith(q)) {
      prefixMatches.push(group);
    } else if (lower.includes(q)) {
      substringMatches.push(group);
    }
  }
  return [...prefixMatches, ...substringMatches];
}

function renderGroupSuggestions(groups, inputEl, suggestionsEl) {
  if (groups.length === 0) {
    suggestionsEl.classList.add("d-none");
    suggestionsEl.innerHTML = "";
    groupSuggestionsActiveIndex = -1;
    return;
  }
  suggestionsEl.innerHTML = groups.map((group, idx) => `
    <div class="group-suggestion${idx === 0 ? " active" : ""}"
         data-group="${esc(group)}"
         role="option"
         tabindex="-1"
         aria-selected="${idx === 0}">${esc(group)}</div>`).join("");
  suggestionsEl.classList.remove("d-none");
  groupSuggestionsActiveIndex = 0;
}

function selectGroupSuggestion(group, inputEl, suggestionsEl) {
  inputEl.value = group;
  suggestionsEl.classList.add("d-none");
  suggestionsEl.innerHTML = "";
  groupSuggestionsActiveIndex = -1;
  inputEl.focus();
}

function setupGroupAutocomplete() {
  const inputEl = $("#app-config-group");
  const suggestionsEl = $("#app-config-group-suggestions");

  if (!inputEl || !suggestionsEl) return;

  // Clear existing listeners by cloning and replacing
  const newInputEl = inputEl.cloneNode(true);
  inputEl.parentNode.replaceChild(newInputEl, inputEl);

  newInputEl.addEventListener("focus", () => {
    const groups = filterGroups(newInputEl.value, getUniqueGroups());
    renderGroupSuggestions(groups, newInputEl, suggestionsEl);
  });

  newInputEl.addEventListener("input", () => {
    const groups = filterGroups(newInputEl.value, getUniqueGroups());
    renderGroupSuggestions(groups, newInputEl, suggestionsEl);
  });

  newInputEl.addEventListener("keydown", (e) => {
    const items = suggestionsEl.querySelectorAll(".group-suggestion");
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      groupSuggestionsActiveIndex = Math.min(groupSuggestionsActiveIndex + 1, items.length - 1);
      updateGroupSuggestionSelection(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      groupSuggestionsActiveIndex = Math.max(groupSuggestionsActiveIndex - 1, 0);
      updateGroupSuggestionSelection(items);
    } else if (e.key === "Enter" && groupSuggestionsActiveIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      selectGroupSuggestion(items[groupSuggestionsActiveIndex].dataset.group, newInputEl, suggestionsEl);
    } else if (e.key === "Escape") {
      suggestionsEl.classList.add("d-none");
      suggestionsEl.innerHTML = "";
      groupSuggestionsActiveIndex = -1;
    }
  });

  // Click on suggestion
  suggestionsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".group-suggestion");
    if (item) {
      selectGroupSuggestion(item.dataset.group, newInputEl, suggestionsEl);
    }
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#app-config-group") &&
        !e.target.closest("#app-config-group-suggestions")) {
      suggestionsEl.classList.add("d-none");
      suggestionsEl.innerHTML = "";
      groupSuggestionsActiveIndex = -1;
    }
  });

  // Handle modal hide to clean up
  const modalEl = $("#app-config-modal");
  if (modalEl) {
    modalEl.addEventListener("hidden.bs.modal", () => {
      suggestionsEl.classList.add("d-none");
      suggestionsEl.innerHTML = "";
      groupSuggestionsActiveIndex = -1;
      // Clean up manual app draft if it was not saved
      if (state.manualAppDraft) {
        const draftId = state.manualAppDraft;
        const draftCfg = state.appConfig[draftId] || {};
        // Only remove if it's a manual app that was just created (no displayName set)
        if (draftCfg.type === "manual" && !draftCfg.name) {
          delete state.appConfig[draftId];
        }
        state.manualAppDraft = null;
      }
    });
  }
}

function updateGroupSuggestionSelection(items) {
  items.forEach((item, idx) => {
    const isActive = idx === groupSuggestionsActiveIndex;
    item.classList.toggle("active", isActive);
    item.setAttribute("aria-selected", isActive);
  });
  // Scroll active item into view
  const activeItem = items[groupSuggestionsActiveIndex];
  if (activeItem) {
    activeItem.scrollIntoView({ block: "nearest" });
  }
}

async function performIconSearch(query, resultsContainer, hiddenInput) {
  if (!query.trim()) {
    resultsContainer.classList.add("d-none");
    resultsContainer.innerHTML = "";
    return;
  }

  resultsContainer.innerHTML = '<div class="icon-search-loading"><div class="spinner-border spinner-border-sm" role="status"></div> <span class="ms-2">Loading icons…</span></div>';
  resultsContainer.classList.remove("d-none");

  try {
    const index = await loadIconIndex();
    const matches = searchIcons(query, 50);

    if (matches.length === 0) {
      resultsContainer.innerHTML = '<div class="icon-search-empty">No icons found for "' + esc(query) + '"</div>';
      return;
    }

    const currentValue = hiddenInput.value || "";
    const isBootstrapIcon = currentValue.startsWith("bi-");

    let html = "";
    for (const icon of matches) {
      const slug = icon.slug;
      const isSelected = (hiddenInput.value === slug) || (iconSearchSelectedSlug === slug);
      html += `
        <div class="icon-search-result${isSelected ? " selected" : ""}" data-slug="${esc(slug)}" role="button" tabindex="0" aria-label="Select ${esc(icon.name)}" aria-pressed="${isSelected}">
          <img src="${esc(getIconSvgUrl(slug))}" alt="" class="icon-search-thumb" loading="lazy">
          <div class="icon-name">${esc(icon.name)}</div>
          <div class="icon-slug">${esc(slug)}</div>
        </div>`;
    }
    resultsContainer.innerHTML = html;

    // Attach click/keyboard handlers to results
    resultsContainer.querySelectorAll(".icon-search-result").forEach(el => {
      el.addEventListener("click", () => selectIcon(el, hiddenInput, resultsContainer));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectIcon(el, hiddenInput, resultsContainer);
        }
      });
    });
  } catch (e) {
    resultsContainer.innerHTML = '<div class="icon-search-empty text-danger">Failed to load icons: ' + esc(e.message) + '</div>';
  }
}

function selectIcon(el, hiddenInput, resultsContainer) {
  const slug = el.dataset.slug;
  hiddenInput.value = slug;
  iconSearchSelectedSlug = slug;
  // Update search field to show the selected slug
  const searchInput = $("#app-config-icon-search");
  if (searchInput) searchInput.value = slug;
  // Close results panel
  resultsContainer.classList.add("d-none");
  resultsContainer.innerHTML = "";
}

/* Infer a likely web URL from a container's published ports.
   Returns a URL string like "http://hostname:port" or "https://hostname:port",
   or null if no suitable port can be determined. */
function inferContainerUrl(container) {
  const ports = container.ports || {};
  const hostname = location.hostname;
  for (const [cport, bindings] of Object.entries(ports)) {
    if (!bindings || !bindings.length) continue;
    const proto = (cport.split("/")[1] || "tcp").toLowerCase();
    if (proto !== "tcp") continue;
    for (const b of bindings) {
      if (!b.HostPort) continue;
      const hostPort = b.HostPort;
      const isHttps = ["443", "8443"].includes(hostPort) ||
                      cport.split("/")[0] === "443";
      return `${isHttps ? "https" : "http"}://${hostname}:${hostPort}`;
    }
  }
  return null;
}

function openLogs(id, name) {
  state.logContainer = id;
  $("#logs-name").textContent = name;
  $("#logs-download").href = `/api/containers/${id}/logs/download?tail=${$("#logs-tail").value}`;
  bootstrap.Modal.getOrCreateInstance("#logs-modal").show();
  loadLogText();
}
async function loadLogText() {
  stopStream();
  const tail = $("#logs-tail").value;
  const view = $("#logs-view");
  view.textContent = "loading…";
  try {
    const txt = await (await authFetch(`/api/containers/${encodeURIComponent(state.logContainer)}/logs?tail=${tail}`)).text();
    renderLogs(txt);
  } catch (e) { view.textContent = "Failed to load logs: " + e.message; }
}
function renderLogs(txt, append = false) {
  const view = $("#logs-view");
  // Escape the whole payload with the centralised helper first, then wrap the
  // (already inert) timestamps in a span — so log output can never inject markup.
  const html = esc(txt).replace(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s?/g, '<span class="ts">$1</span> ');
  if (append) view.innerHTML += html; else view.innerHTML = html;
  if ($("#logs-autoscroll").checked) view.scrollTop = view.scrollHeight;
}
function liveStatus(mode) {
  const el = $("#logs-live-status");
  if (!mode) { el.className = "live-status d-none"; return; }
  el.className = `live-status ${mode === "live" ? "on" : "off"}`;
  el.innerHTML = `<i class="bi bi-circle-fill"></i> ${mode === "live" ? "Live" : "Disconnected"}`;
}
function stopStream(keepToggle = false) {
  if (state.logSocket) {
    const ws = state.logSocket; state.logSocket = null;
    ws.onclose = null; ws.onerror = null;
    try { ws.close(); } catch {}
  }
  if (!keepToggle) $("#logs-live").checked = false;
  liveStatus(null);
}
function startStream() {
  stopStream(true);
  liveStatus(null);
  const id = state.logContainer;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // A browser WebSocket cannot set an Authorization header, so require_auth_ws
  // is satisfied via its documented ?token= query parameter (empty when auth
  // is disabled, keeping the URL identical to the unauthenticated baseline).
  const token = getToken();
  const qs = `tail=0${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  const ws = new WebSocket(`${proto}://${location.host}/api/containers/${encodeURIComponent(id)}/logs/stream?${qs}`);
  state.logSocket = ws;
  ws.onopen = () => liveStatus("live");
  ws.onmessage = e => renderLogs(e.data, true);
  ws.onerror = () => {};
  ws.onclose = () => {
    if (state.logSocket !== ws) return;
    state.logSocket = null;
    $("#logs-live").checked = false;
    liveStatus("off");
  };
}
$("#logs-live").addEventListener("change", e => e.target.checked ? startStream() : stopStream());
$("#logs-refresh").addEventListener("click", loadLogText);
$("#logs-tail").addEventListener("change", () => {
  $("#logs-download").href = `/api/containers/${state.logContainer}/logs/download?tail=${$("#logs-tail").value}`;
  if (!$("#logs-live").checked) loadLogText();
});
$("#logs-modal").addEventListener("hidden.bs.modal", stopStream);

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
$("#search").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); containersPagination.resetPage(); updatePref("containers", "search", state.search); renderContainers(); });
$("#filter-state").addEventListener("change", e => { state.filter = e.target.value; containersPagination.resetPage(); updatePref("containers", "filter", state.filter); renderContainers(); });
$("#sort-by").addEventListener("change", e => { state.sort = e.target.value; containersPagination.resetPage(); updatePref("containers", "sort", state.sort); renderContainers(); });
$("#page-size").addEventListener("change", e => {
  const val = e.target.value;
  containersPagination.pageSize = val === "all" ? -1 : +val;
  containersPagination.resetPage();
  updatePref("containers", "pageSize", containersPagination.pageSize);
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
$("#dashboard-search").addEventListener("input", e => { state.search = e.target.value.toLowerCase(); containersPagination.resetPage(); updatePref("dashboard", "search", state.search); renderSummary(); });
$("#dashboard-filter-state").addEventListener("change", e => { state.filter = e.target.value; containersPagination.resetPage(); updatePref("dashboard", "filter", state.filter); renderSummary(); });
$("#dashboard-sort-by").addEventListener("change", e => { state.sort = e.target.value; containersPagination.resetPage(); updatePref("dashboard", "sort", state.sort); renderSummary(); });
$("#dashboard-page-size").addEventListener("change", e => {
  const val = e.target.value;
  containersPagination.pageSize = val === "all" ? -1 : +val;
  containersPagination.resetPage();
  updatePref("dashboard", "pageSize", containersPagination.pageSize);
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
$("#images-search").addEventListener("input", e => { state.imagesSearch = e.target.value.toLowerCase(); imagesPagination.resetPage(); updatePref("images", "search", state.imagesSearch); renderImages(); });
$("#images-sort-by").addEventListener("change", e => { state.imagesSort = e.target.value; imagesPagination.resetPage(); updatePref("images", "sort", state.imagesSort); renderImages(); });
$("#images-page-size").addEventListener("change", e => {
  const val = e.target.value;
  imagesPagination.pageSize = val === "all" ? -1 : +val;
  imagesPagination.resetPage();
  updatePref("images", "pageSize", imagesPagination.pageSize);
  renderImages();
});
$("#btn-images-page-prev").addEventListener("click", () => {
  if (imagesPagination.currentPage > 1) { imagesPagination.currentPage--; renderImages(); }
});
$("#btn-images-page-next").addEventListener("click", () => {
  const totalPages = imagesPagination.getTotalPages(filteredImages());
  if (imagesPagination.currentPage < totalPages) { imagesPagination.currentPage++; renderImages(); }
});

/* Images multi-select */
$("#images-sel-all").addEventListener("change", (e) => {
  const filtered = filteredImages();
  const list = imagesPagination.getPaginatedList(filtered);
  if (e.target.checked) {
    list.forEach(i => state.imagesSelected.add(i.id));
  } else {
    list.forEach(i => state.imagesSelected.delete(i.id));
  }
  renderImages();
});

$("#btn-images-delete-selected").addEventListener("click", async () => {
  const btn = $("#btn-images-delete-selected");
  if (btn.disabled || state.imagesSelected.size === 0) return;

  const selectedIds = [...state.imagesSelected];
  const selectedImages = state.images.filter(i => selectedIds.includes(i.id));
  const names = selectedImages.map(i => `${i.repo}:${i.tag} (${i.short_id})`).join(", ");

  const warn = selectedImages.some(i => i.in_use)
    ? `<div class="alert alert-warning py-2">Some images are used by containers — force removal will be used for those.</div>`
    : selectedImages.some(i => i.tag_count > 1)
      ? `<div class="alert alert-warning py-2">Some images have multiple tags; removing them by ID removes <b>all</b> tags.</div>`
      : "";

  confirmModal("Delete selected images",
    `${warn}Delete <b>${selectedImages.length}</b> image(s)?<br><span class="text-muted small">${esc(names)}</span>`,
    "Delete", async () => {
      btn.disabled = true;
      const results = { success: [], failed: [] };
      for (const imageId of selectedIds) {
        const img = state.images.find(i => i.id === imageId);
        const force = img && (img.in_use || img.tag_count > 1);
        try {
          await api(`/api/images/${encodeURIComponent(imageId)}?force=${force}`, { method: "DELETE" });
          results.success.push(imageId);
        } catch (e) {
          results.failed.push({ id: imageId, error: e.message });
        }
      }

      // Clear selection for successfully deleted images
      results.success.forEach(id => state.imagesSelected.delete(id));

      if (results.success.length > 0) {
        toast(`Deleted ${results.success.length} image(s)`, true);
      }
      if (results.failed.length > 0) {
        const errors = results.failed.map(f => `${f.id.slice(0, 12)}: ${f.error}`).join("; ");
        toast(`Failed to delete ${results.failed.length} image(s): ${errors}`, false);
      }

      await loadImages();
      btn.disabled = false;
    }, true);
});

/* Volumes page controls */
$("#volumes-search").addEventListener("input", e => { state.volumesSearch = e.target.value.toLowerCase(); volumesPagination.resetPage(); updatePref("volumes", "search", state.volumesSearch); renderVolumes(); });
$("#volumes-sort-by").addEventListener("change", e => { state.volumesSort = e.target.value; volumesPagination.resetPage(); updatePref("volumes", "sort", state.volumesSort); renderVolumes(); });
$("#volumes-page-size").addEventListener("change", e => {
  const val = e.target.value;
  volumesPagination.pageSize = val === "all" ? -1 : +val;
  volumesPagination.resetPage();
  updatePref("volumes", "pageSize", volumesPagination.pageSize);
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
$("#networks-search").addEventListener("input", e => { state.networksSearch = e.target.value.toLowerCase(); networksPagination.resetPage(); updatePref("networks", "search", state.networksSearch); renderNetworks(); });
$("#networks-sort-by").addEventListener("change", e => { state.networksSort = e.target.value; networksPagination.resetPage(); updatePref("networks", "sort", state.networksSort); renderNetworks(); });
$("#networks-page-size").addEventListener("change", e => {
  const val = e.target.value;
  networksPagination.pageSize = val === "all" ? -1 : +val;
  networksPagination.resetPage();
  updatePref("networks", "pageSize", networksPagination.pageSize);
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

/* --------------------------------------------------------------- polling */
let pollTimer = null;
function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (["dashboard", "containers"].includes(state.page)) loadContainers();
  }, state.pollInterval);
}

/* Create a new manual application draft and open the config modal */
function createManualApp() {
  const newId = generateManualAppId();
  // Create a minimal draft config in state.appConfig so openAppConfig can use it
  // Mark as draft with isDraft: true so the form submit handler knows it's a new app
  state.appConfig[newId] = {
    type: "manual",
    name: "",
    url: "",
    description: "",
    icon: "",
    group: "",
    order: 0,
    isDraft: true,
  };
  state.manualAppDraft = newId;
  openAppConfig(newId);
}

wireLogin();
setupIconSearch();
setupGroupAutocomplete();
// Add application button handler
$("#btn-add-app").addEventListener("click", createManualApp);

// Load and apply saved UI preferences
const savedPrefs = loadPrefs();
applyPrefsToState(savedPrefs);

// Sync UI controls with loaded preferences
$("#dashboard-search").value = savedPrefs.dashboard.search;
$("#dashboard-filter-state").value = savedPrefs.dashboard.filter;
$("#dashboard-sort-by").value = savedPrefs.dashboard.sort;
$("#dashboard-page-size").value = savedPrefs.dashboard.pageSize === -1 ? "all" : String(savedPrefs.dashboard.pageSize);
$("#search").value = savedPrefs.containers.search;
$("#filter-state").value = savedPrefs.containers.filter;
$("#sort-by").value = savedPrefs.containers.sort;
$("#page-size").value = savedPrefs.containers.pageSize === -1 ? "all" : String(savedPrefs.containers.pageSize);
$("#images-search").value = savedPrefs.images.search;
$("#images-sort-by").value = savedPrefs.images.sort;
$("#images-page-size").value = savedPrefs.images.pageSize === -1 ? "all" : String(savedPrefs.images.pageSize);
$("#volumes-search").value = savedPrefs.volumes.search;
$("#volumes-sort-by").value = savedPrefs.volumes.sort;
$("#volumes-page-size").value = savedPrefs.volumes.pageSize === -1 ? "all" : String(savedPrefs.volumes.pageSize);
$("#networks-search").value = savedPrefs.networks.search;
$("#networks-sort-by").value = savedPrefs.networks.sort;
$("#networks-page-size").value = savedPrefs.networks.pageSize === -1 ? "all" : String(savedPrefs.networks.pageSize);

loadSystem().then(() => {
  // Pre-load icon index in background for automatic matching (non-blocking)
  loadIconIndex().catch(() => {});
});
refreshPage();
restartPolling();