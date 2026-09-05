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
    collectionSel$.innerHTML = "";

    if (!collections.length) {
      const empty = document.createElement("li");
      empty.className = "custom-select-empty";
      empty.textContent = "هیچ مجموعه‌ای یافت نشد";
      dropList$.appendChild(empty);
      return;
    }

    collections.forEach(col => {
      // Support both old string format and new {id, display_name} object
      const id          = (typeof col === "object") ? col.id          : col;
      const displayName = (typeof col === "object") ? col.display_name : col;

      const li = document.createElement("li");
      li.dataset.value = id;
      li.innerHTML = `
        <span class="col-icon">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M3 3h4l1 2h5v8H3z"/>
          </svg>
        </span>
        <span class="col-name">${escHtml(displayName)}</span>
        <span class="col-actions">
          <button class="col-action-btn col-preview-btn" title="مشاهده اسناد" type="button" aria-label="مشاهده اسناد ${escHtml(displayName)}">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <ellipse cx="10" cy="10" rx="8" ry="5"/>
              <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none"/>
            </svg>
          </button>
          <button class="col-action-btn col-delete-btn" title="حذف مجموعه" type="button" aria-label="حذف ${escHtml(displayName)}">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M5 5l.867 9.143A1 1 0 006.862 15h6.276a1 1 0 00.995-.857L15 5"/>
              <path d="M3 5h14M8 5V3h4v2"/>
            </svg>
          </button>
        </span>`;
      if (collectionIn$.value === id) li.classList.add("selected");
      li.addEventListener("click", (e) => {
        if (e.target.closest(".col-actions")) return;
        selectCollection(id, displayName);
      });
      li.querySelector(".col-preview-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        closeDropdown();
        openDocsModal(id, displayName);
      });
      li.querySelector(".col-delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDeleteCollection(id, displayName, li);
      });
      dropList$.appendChild(li);

      // keep native select in sync
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = displayName;
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

  async function confirmDeleteCollection(collection, displayName, liEl) {
    // Swap the li content for an inline confirm row
    const original = liEl.innerHTML;
    liEl.innerHTML = `
      <span class="col-delete-confirm-text">حذف «${escHtml(displayName || collection)}»؟</span>
      <span class="col-actions">
        <button class="col-action-btn col-confirm-yes" type="button" title="بله، حذف شود">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 10l5 5 7-7"/></svg>
        </button>
        <button class="col-action-btn col-confirm-no" type="button" title="انصراف">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>
        </button>
      </span>`;

    liEl.querySelector(".col-confirm-no").addEventListener("click", (e) => {
      e.stopPropagation();
      liEl.innerHTML = original;
      reattachLiEvents(liEl, collection, displayName);
    });

    liEl.querySelector(".col-confirm-yes").addEventListener("click", async (e) => {
      e.stopPropagation();
      liEl.style.opacity = "0.5";
      liEl.style.pointerEvents = "none";
      try {
        await apiDelete(`/rag/collections/${encodeURIComponent(collection)}`);
        // If deleted collection was selected, reset
        if (collectionIn$.value === collection) {
          collectionIn$.value = "";
          dropLabel$.textContent = "انتخاب مجموعه";
        }
        liEl.remove();
        // Refresh full list to keep collectionsData in sync
        await loadCollections();
        setStatus(status$, `✅ مجموعه «${displayName || collection}» حذف شد.`, "ok");
      } catch (err) {
        liEl.style.opacity = "";
        liEl.style.pointerEvents = "";
        liEl.innerHTML = original;
        reattachLiEvents(liEl, collection, displayName);
        setStatus(status$, `❌ خطا در حذف: ${err.message || err}`, "error");
      }
    });
  }

  function reattachLiEvents(li, id, displayName) {
    li.addEventListener("click", (e) => {
      if (e.target.closest(".col-actions")) return;
      selectCollection(id, displayName);
    });
    li.querySelector(".col-preview-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      closeDropdown();
      openDocsModal(id, displayName);
    });
    li.querySelector(".col-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteCollection(id, displayName, li);
    });
  }

  // ── Docs Preview Modal ───────────────────────────────────────────

  const docsModalBackdrop$ = document.getElementById("docsModalBackdrop");
  const docsModalClose$    = document.getElementById("docsModalClose");
  const docsModalTitle$    = document.getElementById("docsModalTitle");
  const docsModalBody$     = document.getElementById("docsModalBody");

  function openDocsModal(collection, displayName) {
    docsModalTitle$.textContent = displayName || collection;
    docsModalBody$.innerHTML = `<div class="docs-modal-loading"><span class="docs-spinner"></span>در حال بارگذاری...</div>`;
    docsModalBackdrop$.classList.add("open");
    docsModalBackdrop$.removeAttribute("aria-hidden");

    apiGet(`/rag/collections/${encodeURIComponent(collection)}/documents`)
      .then(data => renderDocsModal(data))
      .catch(err => {
        docsModalBody$.innerHTML = `<div class="docs-modal-error">❌ خطا در بارگذاری: ${escHtml(String(err.message || err))}</div>`;
      });
  }

  function closeDocsModal() {
    docsModalBackdrop$.classList.remove("open");
    docsModalBackdrop$.setAttribute("aria-hidden", "true");
  }

  function renderDocsModal(data) {
    const docs = data.documents || [];
    if (!docs.length) {
      docsModalBody$.innerHTML = `<div class="docs-modal-empty">هیچ سندی در این مجموعه یافت نشد.</div>`;
      return;
    }

    docsModalBody$.innerHTML = "";

    // Summary bar
    const summary = document.createElement("div");
    summary.className = "docs-summary";
    summary.innerHTML = `
      <span class="docs-summary-badge">${docs.length} سند</span>
      <span class="docs-summary-badge secondary">${docs.reduce((s, d) => s + d.chunk_count, 0).toLocaleString("fa")} قطعه</span>`;
    docsModalBody$.appendChild(summary);

    docs.forEach(doc => {
      const card = document.createElement("div");
      card.className = "doc-card";

      const isPdf  = doc.file_type === "pdf";
      const isWord = doc.file_type === "word";
      const typeIcon = isPdf
        ? `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>`
        : `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`;

      const typeBadge = isPdf ? "PDF" : isWord ? "Word" : "فایل";
      const typeCls   = isPdf ? "badge-pdf" : isWord ? "badge-word" : "badge-other";

      const metaParts = [];
      if (doc.page_count != null) metaParts.push(`${doc.page_count} صفحه`);
      metaParts.push(`${doc.chunk_count} قطعه`);

      const preview = doc.preview
        ? `<div class="doc-preview-text">${escHtml(doc.preview)}${doc.preview.length >= 300 ? "…" : ""}</div>`
        : "";

      card.innerHTML = `
        <div class="doc-card-header">
          <span class="doc-icon ${isPdf ? "doc-icon-pdf" : "doc-icon-word"}">${typeIcon}</span>
          <div class="doc-card-info">
            <div class="doc-filename" title="${escHtml(doc.filename)}">${escHtml(doc.filename)}</div>
            <div class="doc-meta">
              <span class="doc-badge ${typeCls}">${typeBadge}</span>
              ${metaParts.map(p => `<span class="doc-meta-item">${p}</span>`).join("")}
            </div>
          </div>
        </div>
        ${preview}`;

      docsModalBody$.appendChild(card);
    });
  }

  docsModalClose$.addEventListener("click", closeDocsModal);
  docsModalBackdrop$.addEventListener("click", e => {
    if (e.target === docsModalBackdrop$) closeDocsModal();
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && docsModalBackdrop$.classList.contains("open")) closeDocsModal();
  });

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
                loadCollections().then(() => {
                  const match = collectionsData.find(col => (typeof col === "object" ? col.id : col) === realName);
                  dropLabel$.textContent = match ? (match.display_name || match.id || realName) : realName;
                });
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
