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

/** Allowed chat attachment extensions (client-side filter; server re-validates). */
const CHAT_ATTACH_ACCEPT = new Set([
  "png","jpg","jpeg","webp","gif","pdf","docx",
  "py","js","ts","tsx","jsx","json","md","txt","csv",
  "html","htm","css","xml","yaml","yml","sql","sh",
  "java","c","cpp","h","hpp","go","rs","php","rb","cs","bat","ps1","toml","ini","kt","swift",
]);
// Overwritten from /api/config (values come from .env on the server).
const UPLOAD_LIMITS = { kb_file_mb: 500, chat_doc_mb: 15, chat_image_mb: 8, chat_max_files: 5 };

function applyUploadLimits(cfg) {
  const src = cfg && cfg.upload_limits;
  if (!src) return;
  for (const k of Object.keys(UPLOAD_LIMITS)) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v > 0) UPLOAD_LIMITS[k] = v;
  }
}

/** Returns files within the knowledge-base size limit; alerts for the rest. */
function filterKbFilesBySize(list) {
  const max = UPLOAD_LIMITS.kb_file_mb * 1024 * 1024;
  const tooBig = list.filter(f => f.size > max);
  if (tooBig.length) {
    alert(`حجم این فایل‌ها بیش از ${UPLOAD_LIMITS.kb_file_mb} مگابایت است:\n` + tooBig.map(f => f.name).join("\n"));
  }
  return list.filter(f => f.size <= max);
}

function isImageFile(file) {
  return /\.(png|jpe?g|webp|gif)$/i.test(file.name) || (file.type || "").startsWith("image/");
}

function createAttachController({ input$, preview$, dropZone$, maxFiles }) {
  let files = [];

  function render() {
    preview$.innerHTML = "";
    if (!files.length) {
      preview$.hidden = true;
      return;
    }
    preview$.hidden = false;
    files.forEach((file, idx) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      if (isImageFile(file)) {
        const img = document.createElement("img");
        img.alt = file.name;
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        chip.appendChild(img);
      }
      const name = document.createElement("span");
      name.className = "attach-name";
      name.textContent = file.name;
      chip.appendChild(name);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "attach-remove";
      rm.textContent = "×";
      rm.title = "حذف";
      rm.addEventListener("click", () => {
        files.splice(idx, 1);
        render();
      });
      chip.appendChild(rm);
      preview$.appendChild(chip);
    });
  }

  function addFiles(list) {
    for (const f of list) {
      if (files.length >= (maxFiles || UPLOAD_LIMITS.chat_max_files)) break;
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!CHAT_ATTACH_ACCEPT.has(ext)) {
        alert(`پسوند .${ext} مجاز نیست.`);
        continue;
      }
      const maxMb = isImageFile(f) ? UPLOAD_LIMITS.chat_image_mb : UPLOAD_LIMITS.chat_doc_mb;
      if (f.size > maxMb * 1024 * 1024) {
        alert(`فایل «${f.name}» بزرگ‌تر از ${maxMb}MB است.`);
        continue;
      }
      files.push(f);
    }
    render();
  }

  input$?.addEventListener("change", () => {
    if (input$.files?.length) addFiles(Array.from(input$.files));
    input$.value = "";
  });

  // Drag & drop onto composer / input area
  if (dropZone$) {
    let dragDepth = 0;
    const onDragEnter = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      dropZone$.classList.add("drag-over");
    };
    const onDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropZone$.classList.remove("drag-over");
    };
    const onDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      dropZone$.classList.remove("drag-over");
      const dropped = e.dataTransfer?.files;
      if (dropped?.length) addFiles(Array.from(dropped));
    };
    dropZone$.addEventListener("dragenter", onDragEnter);
    dropZone$.addEventListener("dragover", onDragOver);
    dropZone$.addEventListener("dragleave", onDragLeave);
    dropZone$.addEventListener("drop", onDrop);
  }

  return {
    getFiles: () => files.slice(),
    clear: () => { files = []; render(); },
    hasFiles: () => files.length > 0,
    addFiles,
  };
}

/** File card header: extension badge + name (LTR-isolated so "1.docx" is not shown as "docx.1") + hint. */
function fillFileHead(el, name, hint) {
  const ext = ((name || "").split(".").pop() || "").toLowerCase();
  const kind = ext === "pdf" ? "pdf"
    : (ext === "docx" || ext === "doc") ? "word"
    : "code";
  el.dataset.kind = kind;
  el.innerHTML =
    `<span class="hist-file-icon">${escHtml((ext || "file").slice(0, 4).toUpperCase())}</span>` +
    `<span class="hist-file-meta">` +
      `<bdi class="hist-file-name" dir="ltr" title="${escHtml(name || "")}">${escHtml(name || "فایل")}</bdi>` +
      `<span class="hist-file-hint">${escHtml(hint)}</span>` +
    `</span>`;
}

function appendUserBubble(window$, text, files = []) {
  const wrap = document.createElement("div");
  wrap.className = "chat-message user";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (text) bubble.textContent = text;
  if (files.length) {
    const row = document.createElement("div");
    row.className = "user-attach-row";
    files.forEach((f) => {
      if (isImageFile(f)) {
        const img = document.createElement("img");
        img.alt = f.name;
        img.src = URL.createObjectURL(f);
        row.appendChild(img);
      } else {
        const card = document.createElement("div");
        card.className = "hist-file";
        const head = document.createElement("div");
        head.className = "hist-file-toggle static";
        fillFileHead(head, f.name, "پیوست شد");
        card.appendChild(head);
        row.appendChild(card);
      }
    });
    bubble.appendChild(row);
  }
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  meta.textContent = "شما";
  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  window$.appendChild(wrap);
  window$.scrollTop = window$.scrollHeight;
  return { wrap, bubble };
}

function buildChatFormData(fields, files) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    fd.append(k, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
  });
  (files || []).forEach((f) => fd.append("files", f, f.name));
  return fd;
}

/** Render stored history user content (<<<FILE>>> / <<<IMG>>> → chips + images). */
function renderUserContent(bubble, content) {
  const raw = content || "";
  if (!/<<<FILE name=|<<<IMG name=/.test(raw)) {
    bubble.textContent = raw;
    return;
  }

  bubble.textContent = "";
  const tokens = [];
  let cursor = 0;
  const combined = /<<<FILE name="([^"]*)">>>\n?([\s\S]*?)<<<ENDFILE>>>|<<<IMG name="([^"]*)" src="([^"]*)">>>/g;
  let m;
  while ((m = combined.exec(raw)) !== null) {
    if (m.index > cursor) {
      tokens.push({ type: "text", value: raw.slice(cursor, m.index) });
    }
    if (m[0].startsWith("<<<FILE")) {
      tokens.push({ type: "file", name: m[1], text: m[2] });
    } else {
      tokens.push({ type: "img", name: m[3], src: m[4] });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < raw.length) tokens.push({ type: "text", value: raw.slice(cursor) });

  tokens.forEach((t) => {
    if (t.type === "text") {
      const piece = (t.value || "").trim();
      if (!piece) return;
      const p = document.createElement("div");
      p.className = "user-text";
      p.textContent = piece;
      bubble.appendChild(p);
    } else if (t.type === "file") {
      const wrap = document.createElement("div");
      wrap.className = "hist-file";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hist-file-toggle";
      fillFileHead(btn, t.name, "مشاهده متن");
      btn.insertAdjacentHTML(
        "beforeend",
        `<svg class="hist-file-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`
      );
      const body = document.createElement("pre");
      body.className = "hist-file-body";
      body.hidden = true;
      body.textContent = t.text || "";
      btn.addEventListener("click", () => {
        const open = body.hidden;
        body.hidden = !open;
        btn.classList.toggle("open", open);
        btn.querySelector(".hist-file-hint").textContent = open ? "بستن" : "مشاهده متن";
      });
      wrap.appendChild(btn);
      wrap.appendChild(body);
      bubble.appendChild(wrap);
    } else if (t.type === "img") {
      const wrap = document.createElement("div");
      wrap.className = "hist-img";
      const img = document.createElement("img");
      img.alt = t.name || "تصویر";
      img.loading = "lazy";
      const src = t.src.startsWith("/") ? t.src : `/${t.src}`;
      fetch(src, { headers: _authHeaders() })
        .then((r) => {
          if (!r.ok) throw new Error("img");
          return r.blob();
        })
        .then((blob) => {
          img.src = URL.createObjectURL(blob);
        })
        .catch(() => {
          wrap.classList.add("broken");
          wrap.textContent = t.name || "تصویر";
        });
      wrap.appendChild(img);
      if (t.name) {
        const cap = document.createElement("div");
        cap.className = "hist-img-cap";
        cap.textContent = t.name;
        wrap.appendChild(cap);
      }
      bubble.appendChild(wrap);
    }
  });
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
