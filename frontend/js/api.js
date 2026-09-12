/**
 * api.js — shared API helpers
 * Requires auth.js to be loaded first (provides Auth.getToken()).
 */

const API_BASE = (function () {
  const loc = window.location;
  if (loc.protocol === "http:" || loc.protocol === "https:")
    return loc.origin + "/api";
  return "http://localhost:8000/api";
})();

// ── Auth header helper ────────────────────────────────────────────────────────
function _authHeaders(extra = {}) {
  return {
    "Authorization": "Bearer " + Auth.getToken(),
    ...extra,
  };
}

/** Handle 401 globally — revoke local token and redirect to login */
function _handle401() {
  localStorage.clear();
  window.location.replace("login.html");
}

async function _checkOk(res) {
  if (res.status === 401) { _handle401(); throw new Error("401"); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: _authHeaders(),
  });
  await _checkOk(res);
  return res.json();
}

async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  "POST",
    headers: _authHeaders({ "Content-Type": "application/json" }),
    body:    JSON.stringify(body),
  });
  await _checkOk(res);
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  "DELETE",
    headers: _authHeaders(),
  });
  if (res.status === 401) { _handle401(); throw new Error("401"); }
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

async function apiPatch(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  "PATCH",
    headers: _authHeaders({ "Content-Type": "application/json" }),
    body:    JSON.stringify(body),
  });
  await _checkOk(res);
  return res.json();
}

/**
 * Fetch a protected file with Bearer auth and open it in the in-app viewer modal.
 * Falls back to download for unsupported types.
 */
async function apiOpenFile(path, filename = "file", { inline = true } = {}) {
  if (inline && typeof openFileViewer === "function") {
    return openFileViewer(path, filename);
  }
  return apiDownloadFile(path, filename);
}

async function apiDownloadFile(path, filename = "file") {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API_BASE}${path}${sep}inline=0`, {
    headers: _authHeaders(),
  });
  if (res.status === 401) { _handle401(); throw new Error("401"); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
}

/** In-app PDF/Word viewer modal */
let _fileViewerObjectUrl = null;
let _fileViewerDownloadPath = null;
let _fileViewerFilename = null;

function _hideEl(el) {
  if (!el) return;
  el.hidden = true;
  el.style.display = "none";
}
function _showEl(el, display) {
  if (!el) return;
  el.hidden = false;
  el.style.display = display || "block";
}

function _resetFileViewer() {
  const frame$ = document.getElementById("fileViewerFrame");
  const embed$ = document.getElementById("fileViewerEmbed");
  const html$  = document.getElementById("fileViewerHtml");
  const err$   = document.getElementById("fileViewerError");
  const load$  = document.getElementById("fileViewerLoading");
  if (frame$) {
    _hideEl(frame$);
    frame$.removeAttribute("src");
    frame$.src = "about:blank";
  }
  if (embed$) {
    _hideEl(embed$);
    embed$.removeAttribute("src");
  }
  if (html$) {
    _hideEl(html$);
    html$.innerHTML = "";
  }
  if (err$) {
    _hideEl(err$);
    err$.textContent = "";
  }
  if (load$) _showEl(load$, "flex");
  if (_fileViewerObjectUrl) {
    URL.revokeObjectURL(_fileViewerObjectUrl);
    _fileViewerObjectUrl = null;
  }
}

function closeFileViewer() {
  const backdrop$ = document.getElementById("fileViewerBackdrop");
  if (backdrop$) {
    backdrop$.classList.remove("open");
    backdrop$.setAttribute("aria-hidden", "true");
  }
  _resetFileViewer();
  _fileViewerDownloadPath = null;
  _fileViewerFilename = null;
}

async function openFileViewer(downloadPath, filename = "file") {
  const backdrop$ = document.getElementById("fileViewerBackdrop");
  const title$    = document.getElementById("fileViewerTitle");
  const sub$      = document.getElementById("fileViewerSub");
  const frame$    = document.getElementById("fileViewerFrame");
  const embed$    = document.getElementById("fileViewerEmbed");
  const html$     = document.getElementById("fileViewerHtml");
  const err$      = document.getElementById("fileViewerError");
  const load$     = document.getElementById("fileViewerLoading");

  if (!backdrop$) {
    return apiDownloadFile(downloadPath, filename);
  }

  _resetFileViewer();
  _fileViewerDownloadPath = downloadPath;
  _fileViewerFilename = filename;
  if (title$) title$.textContent = filename;
  if (sub$) sub$.textContent = "در حال آماده‌سازی پیش‌نمایش...";
  backdrop$.classList.add("open");
  backdrop$.setAttribute("aria-hidden", "false");

  const lower = (filename || "").toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isWord = lower.endsWith(".doc") || lower.endsWith(".docx");

  try {
    if (isWord) {
      const previewPath = downloadPath.replace(/\/download(?:\?.*)?$/, "/preview");
      const data = await apiGet(previewPath.startsWith("/") ? previewPath : `/${previewPath}`);
      _hideEl(load$);
      if (sub$) sub$.textContent = "Word";
      if (html$) {
        html$.innerHTML = data.html || "<p>(محتوایی برای نمایش یافت نشد)</p>";
        _showEl(html$, "block");
      }
      return;
    }

    const sep = downloadPath.includes("?") ? "&" : "?";
    const res = await fetch(`${API_BASE}${downloadPath}${sep}inline=1`, {
      headers: _authHeaders(),
    });
    if (res.status === 401) { _handle401(); throw new Error("401"); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || res.statusText);
    }

    const rawBlob = await res.blob();
    const mime = (rawBlob.type || res.headers.get("content-type") || "").split(";")[0].trim();
    const looksPdf = isPdf || mime === "application/pdf";
    const typedBlob = looksPdf
      ? new Blob([await rawBlob.arrayBuffer()], { type: "application/pdf" })
      : rawBlob;

    _fileViewerObjectUrl = URL.createObjectURL(typedBlob);
    _hideEl(load$);

    if (looksPdf) {
      if (sub$) sub$.textContent = "PDF";
      // Prefer <embed> — more reliable than iframe for blob PDFs in Chromium
      if (embed$) {
        embed$.setAttribute("type", "application/pdf");
        embed$.setAttribute("src", _fileViewerObjectUrl);
        _showEl(embed$, "block");
      } else if (frame$) {
        frame$.src = _fileViewerObjectUrl;
        _showEl(frame$, "block");
      }
    } else {
      if (sub$) sub$.textContent = "دانلود";
      if (err$) {
        err$.textContent = "پیش‌نمایش این نوع فایل پشتیبانی نمی‌شود. از دکمه دانلود استفاده کنید.";
        _showEl(err$, "flex");
      }
    }
  } catch (e) {
    _hideEl(load$);
    if (err$) {
      err$.textContent = "خطا در باز کردن فایل: " + (e.message || e);
      _showEl(err$, "flex");
    }
    if (sub$) sub$.textContent = "خطا";
  }
}

// Wire viewer controls (scripts load at end of body — DOM is ready)
(function wireFileViewerControls() {
  const bind = () => {
    const closeBtn$ = document.getElementById("fileViewerClose");
    const dlBtn$    = document.getElementById("fileViewerDownload");
    const backdrop$ = document.getElementById("fileViewerBackdrop");
    if (closeBtn$) closeBtn$.addEventListener("click", closeFileViewer);
    if (backdrop$) {
      backdrop$.addEventListener("click", (e) => {
        if (e.target === backdrop$) closeFileViewer();
      });
    }
    if (dlBtn$) {
      dlBtn$.addEventListener("click", async () => {
        if (!_fileViewerDownloadPath) return;
        try {
          await apiDownloadFile(_fileViewerDownloadPath, _fileViewerFilename || "file");
        } catch (err) {
          const err$ = document.getElementById("fileViewerError");
          if (err$) {
            err$.textContent = "خطا در دانلود: " + (err.message || err);
            _showEl(err$, "flex");
          }
        }
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const b = document.getElementById("fileViewerBackdrop");
        if (b && b.classList.contains("open")) {
          e.stopImmediatePropagation();
          closeFileViewer();
        }
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();

// ── SSE POST helper ───────────────────────────────────────────────────────────
function ssePost(path, body, onToken, onDone, onError) {
  fetch(`${API_BASE}${path}`, {
    method:  "POST",
    headers: _authHeaders({ "Content-Type": "application/json" }),
    body:    JSON.stringify(body),
  }).then(res => {
    if (res.status === 401) { _handle401(); return; }
    if (!res.ok) {
      res.json().catch(() => ({ detail: `خطای سرور: ${res.status}` }))
        .then(e => onError((e && e.detail) || `خطای سرور: ${res.status}`));
      return;
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    function read() {
      reader.read().then(({ done, value }) => {
        if (done) { onDone({}); return; }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim());
            if (payload.error)   { onError(payload.error); return; }
            if (payload.token)   { onToken(payload.token, payload); }
            if (payload.done)    { onDone(payload); return; }
            if (payload.sources) { onDone(payload); return; }
          } catch {}
        }
        read();
      }).catch(err => onError(err.message));
    }
    read();
  }).catch(err => onError(err.message));
}

// ── Status bubble ─────────────────────────────────────────────────────────────
function createStatusBubble(chatWindow, message) {
  const el = document.createElement("div");
  el.className = "status-bubble";
  el.innerHTML = `<span class="status-spinner"></span><span class="status-text">${escHtml(message)}</span>`;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  return el;
}

function updateStatusBubble(el, message, done = false) {
  if (!el) return;
  const text = el.querySelector(".status-text");
  const spin = el.querySelector(".status-spinner");
  if (text) text.textContent = message;
  if (done) {
    if (spin) spin.style.display = "none";
    el.classList.add("done");
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2500);
  }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
function getSettings() {
  const provider = (document.getElementById("llmProvider")?.value || "ollama").trim().toLowerCase();
  const isApi = provider === "api";
  const ollamaUrl = document.getElementById("ollamaUrl")?.value.trim() || "http://localhost:11434";
  const apiBaseUrl = document.getElementById("apiBaseUrl")?.value.trim() || "";
  const apiToken = document.getElementById("apiToken")?.value.trim() || "";
  const ollamaModel = document.getElementById("modelSelect")?.value.trim()
    || document.getElementById("ollamaUrl")?.dataset.defaultModel
    || "qwen2.5:14b";
  const apiModel = document.getElementById("apiModelInput")?.value.trim()
    || document.getElementById("apiModelSelect")?.value.trim()
    || "";

  return {
    provider: isApi ? "api" : "ollama",
    ollamaUrl,
    apiBaseUrl,
    apiToken,
    model: isApi ? apiModel : ollamaModel,
    temperature: parseFloat(document.getElementById("temperature")?.value) || 0.3,
    useWeb: !!document.getElementById("useWeb")?.checked,
  };
}

function llmRequestFields(settings = getSettings()) {
  return {
    provider: settings.provider,
    model: settings.model,
    temperature: settings.temperature,
    use_web: settings.useWeb,
    ollama_url: settings.ollamaUrl,
    api_base_url: settings.apiBaseUrl,
    api_token: settings.apiToken,
  };
}

function newSessionId(prefix = "s") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function setStatus(el, message, type = "info") {
  if (!el) return;
  el.textContent = message;
  el.className   = `status-bar show ${type}`;
}
function clearStatus(el) {
  if (!el) return;
  el.className   = "status-bar";
  el.textContent = "";
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("fa-IR"); }
  catch { return iso; }
}

function appendWebSources(wrap, results) {
  if (!results || !results.length) return;
  const acc    = document.createElement("div");
  acc.className = "sources-accordion web-sources-accordion";
  const toggle  = document.createElement("button");
  toggle.className = "sources-toggle web-sources-toggle";
  toggle.innerHTML = `🌐 ${results.length} نتیجه جستجوی وب`;
  const body = document.createElement("div");
  body.className = "sources-body";
  results.forEach((r, i) => {
    const item = document.createElement("div");
    item.className = "source-item web-source-item";
    const title   = r.title   ? `<strong>${i+1}. ${escHtml(r.title)}</strong><br>` : `<strong>${i+1}.</strong> `;
    const snippet = r.body    ? `<span class="web-snippet">${escHtml(r.body)}</span><br>` : "";
    const link    = r.link    ? `<a href="${escHtml(r.link)}" target="_blank" rel="noopener" class="web-link">🔗 ${escHtml(r.link.slice(0,60))}${r.link.length>60?"...":""}</a>` : "";
    item.innerHTML = title + snippet + link;
    body.appendChild(item);
  });
  toggle.addEventListener("click", () => body.classList.toggle("open"));
  acc.appendChild(toggle);
  acc.appendChild(body);
  wrap.appendChild(acc);
}
