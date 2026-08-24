/**
 * api.js — shared API helpers
 * All modules import settings from DOM elements defined in index.html
 */

/**
 * API_BASE is resolved dynamically:
 * - If served by FastAPI (same origin) → use relative path "/api"
 * - If opened as file:// → fall back to http://localhost:8000/api
 */
const API_BASE = (function () {
  const loc = window.location;
  if (loc.protocol === "http:" || loc.protocol === "https:") {
    return loc.origin + "/api";
  }
  return "http://localhost:8000/api";
})();

// ── Status bubble (web search indicator) ──────────────────────────

/**
 * Show a transient status line inside a chat window.
 * Returns the element so caller can remove/update it later.
 */
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
    // Auto-remove after 2.5s
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2500);
  }
}

/** Read shared settings from sidebar */
function getSettings() {
  return {
    ollamaUrl:   document.getElementById("ollamaUrl").value.trim()   || "http://localhost:11434",
    model:       document.getElementById("modelSelect").value.trim() || document.getElementById("ollamaUrl").dataset.defaultModel || "qwen2.5:14b",
    temperature: parseFloat(document.getElementById("temperature").value) || 0.3,
    useWeb:      document.getElementById("useWeb").checked,
  };
}

/**
 * POST JSON and return parsed response.
 * Throws on HTTP error.
 */
async function apiPost(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

/** GET and return parsed response. */
async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

/** DELETE */
async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/**
 * Open an SSE stream to a POST endpoint.
 * @param {string}   path        - API path
 * @param {object}   body        - JSON body
 * @param {function} onToken     - called with each token string
 * @param {function} onDone      - called when stream ends (with optional extra data)
 * @param {function} onError     - called on error
 */
function ssePost(path, body, onToken, onDone, onError) {
  fetch(`${API_BASE}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  }).then(res => {
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

        // SSE lines: "data: {...}\n\n"
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // keep incomplete chunk

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const payload = JSON.parse(line.slice(5).trim());
            if (payload.error)  { onError(payload.error); return; }
            if (payload.token)  { onToken(payload.token, payload); }
            if (payload.done)   { onDone(payload); return; }
            if (payload.sources){ onDone(payload); return; }
          } catch {}
        }
        read();
      }).catch(err => onError(err.message));
    }
    read();
  }).catch(err => onError(err.message));
}

/** Generate a simple unique session id */
function newSessionId(prefix = "s") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Show / hide a status bar element */
function setStatus(el, message, type = "info") {
  if (!el) return;
  el.textContent = message;
  el.className   = `status-bar show ${type}`;
}
function clearStatus(el) {
  if (!el) return;
  el.className = "status-bar";
  el.textContent = "";
}

/** Escape HTML for safe insertion */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a date string to Farsi-friendly locale */
function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("fa-IR");
  } catch { return iso; }
}

/**
 * Append a web search results accordion below a message wrap element.
 * @param {HTMLElement} wrap   - parent .chat-message div
 * @param {Array}       results - [{title, body, link}, ...]
 */
function appendWebSources(wrap, results) {
  if (!results || !results.length) return;

  const acc    = document.createElement("div");
  acc.className = "sources-accordion web-sources-accordion";

  const toggle = document.createElement("button");
  toggle.className = "sources-toggle web-sources-toggle";
  toggle.innerHTML = `🌐 ${results.length} نتیجه جستجوی وب`;

  const body = document.createElement("div");
  body.className = "sources-body";

  results.forEach((r, i) => {
    const item = document.createElement("div");
    item.className = "source-item web-source-item";
    const title = r.title ? `<strong>${i+1}. ${escHtml(r.title)}</strong><br>` : `<strong>${i+1}.</strong> `;
    const snippet = r.body ? `<span class="web-snippet">${escHtml(r.body)}</span><br>` : "";
    const link = r.link
      ? `<a href="${escHtml(r.link)}" target="_blank" rel="noopener" class="web-link">🔗 ${escHtml(r.link.slice(0,60))}${r.link.length>60?"...":""}</a>`
      : "";
    item.innerHTML = title + snippet + link;
    body.appendChild(item);
  });

  toggle.addEventListener("click", () => body.classList.toggle("open"));
  acc.appendChild(toggle);
  acc.appendChild(body);
  wrap.appendChild(acc);
}
