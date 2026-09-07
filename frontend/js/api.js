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
 * Fetch a protected file with Bearer auth and open/download it.
 * PDFs open in a new tab; other types trigger download.
 */
async function apiOpenFile(path, filename = "file", { inline = true } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API_BASE}${path}${sep}inline=${inline ? "1" : "0"}`, {
    headers: _authHeaders(),
  });
  if (res.status === 401) { _handle401(); throw new Error("401"); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const lower = (filename || "").toLowerCase();
  const isPdf = lower.endsWith(".pdf") || blob.type === "application/pdf";

  if (inline && isPdf) {
    window.open(objectUrl, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
  } else {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 15000);
  }
}


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
  return {
    ollamaUrl:   document.getElementById("ollamaUrl").value.trim()   || "http://localhost:11434",
    model:       document.getElementById("modelSelect").value.trim() || document.getElementById("ollamaUrl").dataset.defaultModel || "qwen2.5:14b",
    temperature: parseFloat(document.getElementById("temperature").value) || 0.3,
    useWeb:      document.getElementById("useWeb").checked,
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
