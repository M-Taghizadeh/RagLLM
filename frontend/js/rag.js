/**
 * rag.js — PDF RAG module
 * Stop button for both indexing and chat.
 * AbortController cancels fetch on page unload / stop click.
 * Cancel indexing via DELETE /api/rag/index/:job_id
 */

(function () {
  let sessionId     = newSessionId("rag");
  let isStreaming   = false;
  let isIndexing    = false;
  let chatAbort     = null;   // AbortController for chat stream
  let indexAbort    = null;   // AbortController for index stream
  let currentJobId  = null;   // job_id sent to backend for cancel

  const chatWindow$    = document.getElementById("ragChatWindow");
  const input$         = document.getElementById("ragInput");
  const send$          = document.getElementById("ragSend");
  const clear$         = document.getElementById("clearRag");
  const pdfDrop$       = document.getElementById("pdfDrop");
  const pdfInput$      = document.getElementById("pdfInput");
  const fileList$      = document.getElementById("pdfFileList");
  const collectionIn$  = document.getElementById("ragCollection");
  const collectionSel$ = document.getElementById("ragCollectionSelect");
  const refreshCols$   = document.getElementById("ragRefreshCollections");
  const indexBtn$      = document.getElementById("ragIndex");
  const status$        = document.getElementById("ragStatus");

  let selectedFiles = [];

  // ── Stop buttons ─────────────────────────────────────────────────

  // Stop chat button (inject after send button)
  const stopChat$ = document.createElement("button");
  stopChat$.className = "btn-stop";
  stopChat$.textContent = "⏹ توقف";
  stopChat$.style.display = "none";
  send$.parentNode.insertBefore(stopChat$, send$.nextSibling);

  // Stop index button (inject after index button)
  const stopIndex$ = document.createElement("button");
  stopIndex$.className = "btn-stop";
  stopIndex$.textContent = "⏹ لغو ایندکس";
  stopIndex$.style.display = "none";
  indexBtn$.parentNode.insertBefore(stopIndex$, indexBtn$.nextSibling);

  // Progress bar (inject after status bar)
  const progressWrap$ = document.createElement("div");
  progressWrap$.className = "index-progress-wrap";
  progressWrap$.style.display = "none";
  const progressFill$ = document.createElement("div");
  progressFill$.className = "index-progress-fill";
  progressWrap$.appendChild(progressFill$);
  status$.parentNode.insertBefore(progressWrap$, status$.nextSibling);

  function setProgress(pct) {
    progressWrap$.style.display = "block";
    progressFill$.style.width = pct + "%";
    if (pct >= 100) setTimeout(() => { progressWrap$.style.display = "none"; }, 1500);
  }

  // ── Stop handlers ────────────────────────────────────────────────

  function stopChat() {
    if (chatAbort) { chatAbort.abort(); chatAbort = null; }
    isStreaming = false;
    send$.disabled = false;
    stopChat$.style.display = "none";
  }

  async function stopIndex() {
    if (currentJobId) {
      try { await apiDelete(`/rag/index/${currentJobId}`); } catch {}
      currentJobId = null;
    }
    if (indexAbort) { indexAbort.abort(); indexAbort = null; }
    isIndexing = false;
    indexBtn$.disabled = false;
    stopIndex$.style.display = "none";
    setStatus(status$, "⚠️ ایندکس لغو شد.", "warn");
    setProgress(0);
    progressWrap$.style.display = "none";
  }

  stopChat$.addEventListener("click", stopChat);
  stopIndex$.addEventListener("click", stopIndex);

  // Abort on page unload / refresh
  window.addEventListener("beforeunload", () => {
    if (chatAbort)  chatAbort.abort();
    if (indexAbort) indexAbort.abort();
    // Fire-and-forget cancel request (best effort)
    if (currentJobId) {
      navigator.sendBeacon(`${API_BASE}/rag/index/${currentJobId}`, "");
    }
  });

  // ── File picker / drop zone ──────────────────────────────────────

  pdfDrop$.addEventListener("click", () => pdfInput$.click());
  pdfDrop$.addEventListener("dragover",  e => { e.preventDefault(); pdfDrop$.classList.add("drag-over"); });
  pdfDrop$.addEventListener("dragleave", () => pdfDrop$.classList.remove("drag-over"));
  pdfDrop$.addEventListener("drop", e => {
    e.preventDefault();
    pdfDrop$.classList.remove("drag-over");
    addFiles([...e.dataTransfer.files]);
  });
  pdfInput$.addEventListener("change", () => { addFiles([...pdfInput$.files]); pdfInput$.value = ""; });

  function addFiles(files) {
    files.forEach(f => {
      if (f.type === "application/pdf" && !selectedFiles.find(x => x.name === f.name))
        selectedFiles.push(f);
    });
    renderFileList();
  }

  function renderFileList() {
    fileList$.innerHTML = "";
    selectedFiles.forEach((f, i) => {
      const tag = document.createElement("div");
      tag.className = "file-tag";
      tag.innerHTML = `<span>📄 ${escHtml(f.name)}</span><span class="remove-file" data-i="${i}">✕</span>`;
      fileList$.appendChild(tag);
    });
    fileList$.querySelectorAll(".remove-file").forEach(btn => {
      btn.addEventListener("click", () => { selectedFiles.splice(parseInt(btn.dataset.i), 1); renderFileList(); });
    });
  }

  // ── Collections list ─────────────────────────────────────────────

  async function loadCollections() {
    try {
      const data = await apiGet("/rag/collections");
      collectionSel$.innerHTML = `<option value="">— انتخاب مجموعه موجود —</option>`;
      (data.collections || []).forEach(c => {
        const opt = document.createElement("option");
        opt.value = opt.textContent = c;
        collectionSel$.appendChild(opt);
      });
    } catch {}
  }

  refreshCols$.addEventListener("click", loadCollections);
  collectionSel$.addEventListener("change", () => { if (collectionSel$.value) collectionIn$.value = collectionSel$.value; });

  // ── Index PDFs ───────────────────────────────────────────────────

  indexBtn$.addEventListener("click", () => {
    if (!selectedFiles.length) { setStatus(status$, "ابتدا فایل PDF انتخاب کنید.", "warn"); return; }
    const collection = collectionIn$.value.trim() || "default_pdf";

    setStatus(status$, "⏳ شروع ایندکس...", "info");
    setProgress(2);
    indexBtn$.disabled = true;
    isIndexing = true;
    stopIndex$.style.display = "inline-flex";

    currentJobId = newSessionId("idx");
    indexAbort   = new AbortController();

    const form = new FormData();
    selectedFiles.forEach(f => form.append("files", f));
    form.append("collection", collection);
    form.append("job_id", currentJobId);

    fetch(`${API_BASE}/rag/index/stream`, {
      method: "POST",
      body:   form,
      signal: indexAbort.signal,
    })
    .then(res => {
      if (!res.ok) return res.json().then(e => { throw new Error(e.detail || res.statusText); });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { finalizeIndex(); return; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop();

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());
              if (p.progress !== undefined) {
                setProgress(p.progress);
                setStatus(status$, `⏳ ${p.detail || ""}`, "info");
              }
              if (p.done) {
                setProgress(100);
                const realName = p.collection || collection;
                const msg = (realName !== collection)
                  ? `✅ ایندکس شد: ${p.total_chunks} قطعه از ${p.files} فایل | مجموعه: «${realName}»`
                  : `✅ ایندکس شد: ${p.total_chunks} قطعه از ${p.files} فایل — مجموعه «${realName}»`;
                setStatus(status$, msg, "ok");
                selectedFiles = []; renderFileList();
                collectionIn$.value = realName;
                loadCollections();
                finalizeIndex(); return;
              }
              if (p.cancelled) {
                setStatus(status$, "⚠️ ایندکس لغو شد.", "warn");
                setProgress(0); progressWrap$.style.display = "none";
                finalizeIndex(); return;
              }
              if (p.error) {
                setStatus(status$, `❌ خطا: ${p.error}`, "error");
                setProgress(0); progressWrap$.style.display = "none";
                finalizeIndex(); return;
              }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError")
            setStatus(status$, `❌ ${err.message}`, "error");
          finalizeIndex();
        });
      }
      read();
    })
    .catch(err => {
      if (err.name !== "AbortError")
        setStatus(status$, `❌ ${err.message}`, "error");
      finalizeIndex();
    });

    function finalizeIndex() {
      isIndexing = false;
      indexBtn$.disabled = false;
      stopIndex$.style.display = "none";
      indexAbort   = null;
      currentJobId = null;
    }
  });

  // ── Chat ─────────────────────────────────────────────────────────

  function appendMessage(role, text = "") {
    const wrap   = document.createElement("div");
    wrap.className = `chat-message ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = role === "user" ? "شما" : "چت بات (RAG)";
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    chatWindow$.appendChild(wrap);
    chatWindow$.scrollTop = chatWindow$.scrollHeight;
    return { wrap, bubble };
  }

  function appendSources(wrap, sources) {
    if (!sources || !sources.length) return;
    const acc    = document.createElement("div");   acc.className = "sources-accordion";
    const toggle = document.createElement("button"); toggle.className = "sources-toggle";
    toggle.textContent = `📚 ${sources.length} منبع بازیابی‌شده`;
    const body   = document.createElement("div");   body.className = "sources-body";

    sources.forEach((s, i) => {
      const item = document.createElement("div"); item.className = "source-item";
      const page = (s.page !== "" && s.page !== undefined) ? ` — صفحه ${parseInt(s.page) + 1}` : "";
      item.innerHTML = `<strong>${i + 1}. ${escHtml(s.file)}${page}</strong>${escHtml(s.preview)}...`;
      body.appendChild(item);
    });

    toggle.addEventListener("click", () => body.classList.toggle("open"));
    acc.appendChild(toggle); acc.appendChild(body);
    wrap.appendChild(acc);
  }

  function sendMessage() {
    const text = input$.value.trim();
    if (!text || isStreaming) return;

    const collection = collectionIn$.value.trim() || "default_pdf";
    appendMessage("user", text);
    input$.value = "";
    input$.style.height = "auto";

    const { ollamaUrl, model, temperature, useWeb } = getSettings();
    const { wrap, bubble } = appendMessage("assistant", "");
    bubble.classList.add("typing-cursor");
    isStreaming = true;
    send$.disabled = true;
    stopChat$.style.display = "inline-flex";

    chatAbort = new AbortController();
    let sourcesData  = null;
    let statusBubble = null;

    fetch(`${API_BASE}/rag/chat/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text, collection, session_id: sessionId,
        model, ollama_url: ollamaUrl, temperature, use_web: useWeb, top_k: 20,
      }),
      signal: chatAbort.signal,
    })
    .then(res => {
      if (!res.ok) return res.json().then(e => { throw new Error(e.detail || res.statusText); });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { finalize(); return; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());
              if (p.error)   { bubble.textContent = `⚠️ ${p.error}`; bubble.style.color = "var(--danger)"; finalize(); return; }
              if (p.status === "searching")   { statusBubble = createStatusBubble(chatWindow$, p.msg); }
              if (p.status === "search_done") { updateStatusBubble(statusBubble, p.msg, true); statusBubble = null; }
              if (p.token)   { bubble.textContent += p.token; chatWindow$.scrollTop = chatWindow$.scrollHeight; }
              if (p.sources)     { sourcesData = p.sources; }
              if (p.web_sources) { appendWebSources(wrap, p.web_sources); }
              if (p.sources || p.done) { finalize(); return; }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError") { bubble.textContent += " [توقف]"; }
          finalize();
        });
      }
      read();
    })
    .catch(err => {
      if (err.name !== "AbortError") {
        bubble.textContent = `⚠️ ${err.message}`;
        bubble.style.color = "var(--danger)";
      }
      finalize();
    });

    function finalize() {
      bubble.classList.remove("typing-cursor");
      if (sourcesData) appendSources(wrap, sourcesData);
      isStreaming = false;
      send$.disabled = false;
      stopChat$.style.display = "none";
      chatAbort = null;
      input$.focus();
    }
  }

  send$.addEventListener("click", sendMessage);
  input$.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input$.addEventListener("input", () => {
    input$.style.height = "auto";
    input$.style.height = Math.min(input$.scrollHeight, 140) + "px";
  });

  clear$.addEventListener("click", async () => {
    stopChat();
    chatWindow$.innerHTML = "";
    sessionId = newSessionId("rag");
    try { await apiPost(`/rag/clear?session_id=${sessionId}`); } catch {}
  });

  loadCollections();
})();
