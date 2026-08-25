/**
 * rag.js — PDF & Word RAG module
 * Stop button for both indexing and chat.
 * AbortController cancels fetch on page unload / stop click.
 * Cancel indexing via DELETE /api/rag/index/:job_id
 */

(function () {
  let sessionId     = newSessionId("rag");
  let isStreaming   = false;
  let isIndexing    = false;
  let chatAbort     = null;
  let indexAbort    = null;
  let currentJobId  = null;

  const chatWindow$    = document.getElementById("ragChatWindow");
  const input$         = document.getElementById("ragInput");
  const send$          = document.getElementById("ragSend");
  const clear$         = document.getElementById("clearRag");
  const pdfDrop$       = document.getElementById("pdfDrop");
  const pdfInput$      = document.getElementById("pdfInput");
  const fileList$      = document.getElementById("pdfFileList");
  const collectionIn$  = document.getElementById("ragCollection");
  const collectionSel$ = document.getElementById("ragCollectionSelect"); // hidden native
  const refreshCols$   = document.getElementById("ragRefreshCollections");
  const indexBtn$      = document.getElementById("ragIndex");
  const status$        = document.getElementById("ragStatus");

  // Custom dropdown elements
  const dropBtn$    = document.getElementById("collectionDropdownBtn");
  const dropLabel$  = document.getElementById("collectionDropdownLabel");
  const dropList$   = document.getElementById("collectionDropdownList");

  // Modal elements
  const modalBackdrop$   = document.getElementById("indexModalBackdrop");
  const modalClose$      = document.getElementById("indexModalClose");
  const modalCancel$     = document.getElementById("indexModalCancel");
  const modalConfirm$    = document.getElementById("indexModalConfirm");
  const modalSub$        = document.getElementById("indexModalSub");
  const modalFileChips$  = document.getElementById("indexModalFileChips");
  const modalInput$      = document.getElementById("indexCollectionInput");

  // ── Modal logic ──────────────────────────────────────────────────

  function openIndexModal() {
    // populate file chips in modal
    modalFileChips$.innerHTML = "";
    selectedFiles.forEach(f => {
      const chip = document.createElement("div");
      chip.className = "file-tag";
      chip.innerHTML = `<span>${fileIcon(f)} ${escHtml(f.name)}</span>`;
      modalFileChips$.appendChild(chip);
    });
    // subtitle
    modalSub$.textContent = `${selectedFiles.length} فایل انتخاب‌شده`;
    // pre-fill input with current collection value
    modalInput$.value = collectionIn$.value || "default_pdf";
    // open
    modalBackdrop$.classList.add("open");
    modalBackdrop$.removeAttribute("aria-hidden");
    setTimeout(() => modalInput$.focus(), 60);
  }

  function closeIndexModal() {
    modalBackdrop$.classList.remove("open");
    modalBackdrop$.setAttribute("aria-hidden", "true");
  }

  modalClose$.addEventListener("click", closeIndexModal);
  modalCancel$.addEventListener("click", closeIndexModal);
  modalBackdrop$.addEventListener("click", e => {
    if (e.target === modalBackdrop$) closeIndexModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modalBackdrop$.classList.contains("open")) closeIndexModal();
  });
  modalInput$.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); modalConfirm$.click(); }
  });

  let selectedFiles = [];
  let collectionsData = []; // cached list

  // ── Custom Dropdown logic ────────────────────────────────────────

  function openDropdown() {
    dropList$.classList.add("open");
    dropBtn$.setAttribute("aria-expanded", "true");
  }

  function closeDropdown() {
    dropList$.classList.remove("open");
    dropBtn$.setAttribute("aria-expanded", "false");
  }

  function toggleDropdown() {
    dropList$.classList.contains("open") ? closeDropdown() : openDropdown();
  }

  function selectCollection(value, label) {
    dropLabel$.textContent = label || value;
    collectionSel$.value = value;
    if (value) collectionIn$.value = value;
    // update selected state
    dropList$.querySelectorAll("li").forEach(li => {
      li.classList.toggle("selected", li.dataset.value === value);
    });
    closeDropdown();
  }

  function renderDropdown(collections) {
    collectionsData = collections;
    dropList$.innerHTML = "";

    if (!collections.length) {
      const empty = document.createElement("li");
      empty.className = "custom-select-empty";
      empty.textContent = "هیچ مجموعه‌ای یافت نشد";
      dropList$.appendChild(empty);
      return;
    }

    collections.forEach(c => {
      const li = document.createElement("li");
      li.dataset.value = c;
      li.innerHTML = `
        <span class="col-icon">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 3h4l1 2h5v8H3z"/>
          </svg>
        </span>
        <span>${escHtml(c)}</span>`;
      if (collectionIn$.value === c) li.classList.add("selected");
      li.addEventListener("click", () => selectCollection(c, c));
      dropList$.appendChild(li);

      // keep native select in sync for rag.js references
      const opt = document.createElement("option");
      opt.value = opt.textContent = c;
      collectionSel$.appendChild(opt);
    });
  }

  dropBtn$.addEventListener("click", (e) => { e.stopPropagation(); toggleDropdown(); });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#collectionDropdownWrap")) closeDropdown();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDropdown();
  });

  // ── Stop buttons ─────────────────────────────────────────────────

  const stopChat$ = document.createElement("button");
  stopChat$.className = "btn-stop";
  stopChat$.textContent = "⏹ توقف";
  stopChat$.style.display = "none";
  send$.parentNode.insertBefore(stopChat$, send$.nextSibling);

  const stopIndex$ = document.createElement("button");
  stopIndex$.className = "btn-stop";
  stopIndex$.textContent = "⏹ لغو ایندکس";
  stopIndex$.style.display = "none";
  indexBtn$.parentNode.insertBefore(stopIndex$, indexBtn$.nextSibling);

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

  window.addEventListener("beforeunload", () => {
    if (chatAbort)  chatAbort.abort();
    if (indexAbort) indexAbort.abort();
    if (currentJobId) navigator.sendBeacon(`${API_BASE}/rag/index/${currentJobId}`, "");
  });

  // ── File picker / drop zone ──────────────────────────────────────

  const ALLOWED_TYPES = ["application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword"];
  const ALLOWED_EXT   = /\.(pdf|docx|doc)$/i;

  function isAllowed(file) {
    return ALLOWED_TYPES.includes(file.type) || ALLOWED_EXT.test(file.name);
  }

  function fileIcon(file) {
    if (file.name.match(/\.(docx|doc)$/i)) return "📝";
    return "📄";
  }

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
      if (isAllowed(f) && !selectedFiles.find(x => x.name === f.name))
        selectedFiles.push(f);
    });
    renderFileList();
  }

  function renderFileList() {
    fileList$.innerHTML = "";
    selectedFiles.forEach((f, i) => {
      const tag = document.createElement("div");
      tag.className = "file-tag";
      tag.innerHTML = `<span>${fileIcon(f)} ${escHtml(f.name)}</span><span class="remove-file" data-i="${i}">✕</span>`;
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
      collectionSel$.innerHTML = "";
      renderDropdown(data.collections || []);
    } catch {
      renderDropdown([]);
    }
  }

  refreshCols$.addEventListener("click", loadCollections);

  // ── Index PDFs ───────────────────────────────────────────────────

  // Index button → open modal (or warn if no files)
  indexBtn$.addEventListener("click", () => {
    if (!selectedFiles.length) { setStatus(status$, "ابتدا فایل PDF یا Word انتخاب کنید.", "warn"); return; }
    openIndexModal();
  });

  // Modal confirm → start indexing
  modalConfirm$.addEventListener("click", () => {
    const collection = (modalInput$.value.trim() || collectionIn$.value.trim() || "default_pdf");
    collectionIn$.value = collection;
    closeIndexModal();

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
                dropLabel$.textContent = realName;
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
        model, ollama_url: ollamaUrl, temperature, use_web: useWeb,
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
              if (p.status === "retrieving")     { statusBubble = createStatusBubble(chatWindow$, p.msg); }
              if (p.status === "retrieval_done") { updateStatusBubble(statusBubble, p.msg, true); statusBubble = null; }
              if (p.status === "searching")      { statusBubble = createStatusBubble(chatWindow$, p.msg); }
              if (p.status === "search_done")    { updateStatusBubble(statusBubble, p.msg, true); statusBubble = null; }
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
