/**
 * docs.js — Document Management module
 * Manages collections: create / rename / delete / open
 * Inside a collection: view files, add files (SSE indexed), remove individual files
 * "چت روی این مجموعه" button navigates to the RAG chat section with that collection pre-selected.
 */

(function () {
  // ── State ──────────────────────────────────────────────────────────────────
  let collectionsCache = [];          // [{id, display_name}, ...]
  let activeCollection = null;        // {id, display_name} currently open in detail modal
  let detailFiles      = [];          // [{filename, file_type, chunk_count, page_count, preview}, ...]
  let addFilesList     = [];          // staged files for upload inside detail modal
  let addFilesAbort    = null;
  let addFilesJobId    = null;
  let isAddingFiles    = false;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const grid$         = document.getElementById("docsGrid");
  const empty$        = document.getElementById("docsEmpty");
  const loading$      = document.getElementById("docsLoading");
  const search$       = document.getElementById("docsSearchInput");
  const refreshBtn$   = document.getElementById("docsRefreshBtn");
  const newColBtn$    = document.getElementById("docsNewCollectionBtn");
  const emptyNewBtn$  = document.getElementById("docsEmptyNewBtn");

  // Collection modal (create / rename)
  const colModal$          = document.getElementById("docsColModalBackdrop");
  const colModalTitle$     = document.getElementById("docsColModalTitle");
  const colModalSub$       = document.getElementById("docsColModalSub");
  const colModalId$        = document.getElementById("docsColModalId");
  const colModalNameInput$ = document.getElementById("docsColNameInput");
  const colModalConfirm$   = document.getElementById("docsColModalConfirm");
  const colModalConfirmLbl$= document.getElementById("docsColModalConfirmLabel");
  const colModalCancel$    = document.getElementById("docsColModalCancel");
  const colModalClose$     = document.getElementById("docsColModalClose");
  const colModalStatus$    = document.getElementById("docsColModalStatus");

  // Detail modal
  const detailBackdrop$    = document.getElementById("docsDetailBackdrop");
  const detailTitle$       = document.getElementById("docsDetailTitle");
  const detailMeta$        = document.getElementById("docsDetailMeta");
  const detailBody$        = document.getElementById("docsDetailBody");
  const detailLoading$     = document.getElementById("docsDetailLoading");
  const detailClose$       = document.getElementById("docsDetailClose");
  const detailCloseFooter$ = document.getElementById("docsDetailCloseFooter");
  const detailRenameBtn$   = document.getElementById("docsDetailRenameBtn");
  const detailDeleteBtn$   = document.getElementById("docsDetailDeleteBtn");
  const detailChatBtn$     = document.getElementById("docsDetailChatBtn");

  // Upload inside detail
  const detailDrop$           = document.getElementById("docsDetailDrop");
  const detailFileInput$      = document.getElementById("docsDetailFileInput");
  const detailFileChips$      = document.getElementById("docsDetailFileChips");
  const detailUploadBtn$      = document.getElementById("docsDetailUploadBtn");
  const detailUploadStatus$   = document.getElementById("docsDetailUploadStatus");
  const detailProgressWrap$   = document.getElementById("docsDetailProgressWrap");
  const detailProgressFill$   = document.getElementById("docsDetailProgressFill");

  // ── Helpers ────────────────────────────────────────────────────────────────
  function setStatus(el, msg, type) {
    if (!el) return;
    el.textContent = msg;
    el.className = "status-bar show " + (type || "info");
    if (!msg) el.className = "status-bar";
  }

  function clearStatus(el) { if (el) { el.textContent = ""; el.className = "status-bar"; } }

  function setProgress(pct) {
    detailProgressWrap$.style.display = "block";
    detailProgressFill$.style.width   = pct + "%";
    if (pct >= 100) setTimeout(() => { detailProgressWrap$.style.display = "none"; }, 1400);
  }

  // ── Load collections ───────────────────────────────────────────────────────
  async function loadCollections() {
    loading$.style.display = "flex";
    grid$.style.display    = "none";
    empty$.hidden          = true;

    try {
      const data = await apiGet("/rag/collections");
      collectionsCache = data.collections || [];
      renderGrid(collectionsCache);
    } catch (err) {
      renderGrid([]);
      // show error in grid area instead of empty state
      grid$.style.display = "none";
      empty$.hidden = false;
      const msgEl = document.getElementById("docsEmptyMsg");
      if (msgEl) msgEl.textContent = "خطا در بارگذاری مجموعه‌ها: " + (err.message || err);
    } finally {
      loading$.style.display = "none";
    }
  }

  // ── Render grid ────────────────────────────────────────────────────────────
  function renderGrid(cols) {
    const q = search$.value.trim().toLowerCase();
    const filtered = q
      ? cols.filter(c => c.display_name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      : cols;

    grid$.innerHTML = "";

    // Reset empty message to default
    const msgEl = document.getElementById("docsEmptyMsg");
    if (msgEl) msgEl.textContent = "هنوز هیچ مجموعه‌ای ساخته نشده.";

    if (!filtered.length) {
      grid$.style.display = "none";
      empty$.hidden = false;
      return;
    }

    empty$.hidden        = true;
    grid$.style.display  = "grid";

    filtered.forEach(col => {
      const card = document.createElement("div");
      card.className = "docs-col-card";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", `باز کردن مجموعه ${escHtml(col.display_name)}`);

      card.innerHTML = `
        <div class="docs-col-card-body">
          <div class="docs-col-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6a2 2 0 012-2h3l2 2h9a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          </div>
          <div class="docs-col-info">
            <div class="docs-col-name">${escHtml(col.display_name)}</div>
            <div class="docs-col-id">${escHtml(col.id)}</div>
          </div>
        </div>
        <div class="docs-col-card-footer">
          <button class="docs-card-btn docs-card-open-btn" type="button" title="باز کردن">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h10v14H7"/><path d="M3 10h10M10 7l3 3-3 3"/></svg>
            باز کردن
          </button>
          <button class="docs-card-btn docs-card-rename-btn" type="button" title="تغییر نام">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 3l4 4-9 9H4v-4z"/></svg>
          </button>
          <button class="docs-card-btn docs-card-delete-btn" type="button" title="حذف">
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l.867 9.143A1 1 0 006.862 15h6.276a1 1 0 00.995-.857L15 5"/><path d="M3 5h14M8 5V3h4v2"/></svg>
          </button>
        </div>`;

      card.querySelector(".docs-card-open-btn").addEventListener("click",   e => { e.stopPropagation(); openDetailModal(col); });
      card.querySelector(".docs-card-rename-btn").addEventListener("click",  e => { e.stopPropagation(); openColModal("rename", col); });
      card.querySelector(".docs-card-delete-btn").addEventListener("click",  e => { e.stopPropagation(); confirmDeleteCollection(col, card); });
      card.addEventListener("click",   () => openDetailModal(col));
      card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetailModal(col); } });

      grid$.appendChild(card);
    });
  }

  // ── Search filter ──────────────────────────────────────────────────────────
  search$.addEventListener("input", () => renderGrid(collectionsCache));

  // ── Delete collection (with inline confirm on card) ────────────────────────
  function confirmDeleteCollection(col, card) {
    const originalHTML = card.innerHTML;
    card.innerHTML = `
      <div class="docs-col-card-delete-confirm">
        <span>حذف «${escHtml(col.display_name)}»؟</span>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn-danger docs-confirm-yes-btn" type="button" style="flex:1">بله، حذف شود</button>
          <button class="btn-secondary docs-confirm-no-btn" type="button" style="flex:1">انصراف</button>
        </div>
      </div>`;

    card.querySelector(".docs-confirm-no-btn").addEventListener("click", () => {
      card.innerHTML = originalHTML;
      reattachCardEvents(card, col);
    });

    card.querySelector(".docs-confirm-yes-btn").addEventListener("click", async () => {
      card.style.opacity        = "0.5";
      card.style.pointerEvents  = "none";
      try {
        await apiDelete(`/rag/collections/${encodeURIComponent(col.id)}`);
        card.classList.add("docs-col-card-removing");
        card.addEventListener("animationend", () => { card.remove(); });
        collectionsCache = collectionsCache.filter(c => c.id !== col.id);
        renderGrid(collectionsCache);
        // Also sync rag.js dropdown
        triggerRagCollectionsRefresh();
      } catch (err) {
        card.style.opacity       = "";
        card.style.pointerEvents = "";
        card.innerHTML = originalHTML;
        reattachCardEvents(card, col);
      }
    });
  }

  function reattachCardEvents(card, col) {
    card.querySelector(".docs-card-open-btn").addEventListener("click",   e => { e.stopPropagation(); openDetailModal(col); });
    card.querySelector(".docs-card-rename-btn").addEventListener("click",  e => { e.stopPropagation(); openColModal("rename", col); });
    card.querySelector(".docs-card-delete-btn").addEventListener("click",  e => { e.stopPropagation(); confirmDeleteCollection(col, card); });
    card.onclick   = () => openDetailModal(col);
    card.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetailModal(col); } };
  }

  // ── Collection Modal (create / rename) ────────────────────────────────────
  function openColModal(mode, col) {
    colModalId$.value          = mode === "rename" ? col.id   : "";
    colModalNameInput$.value   = mode === "rename" ? col.display_name : "";
    colModalTitle$.textContent = mode === "rename" ? "تغییر نام مجموعه"  : "مجموعه جدید";
    colModalSub$.textContent   = mode === "rename"
      ? `مجموعه: ${col.id}`
      : "یک نام برای مجموعه جدید وارد کنید";
    colModalConfirmLbl$.textContent = mode === "rename" ? "ذخیره" : "ایجاد";
    clearStatus(colModalStatus$);
    colModal$.classList.add("open");
    colModal$.removeAttribute("aria-hidden");
    setTimeout(() => colModalNameInput$.focus(), 60);
  }

  function closeColModal() {
    colModal$.classList.remove("open");
    colModal$.setAttribute("aria-hidden", "true");
  }

  colModalClose$.addEventListener("click",  closeColModal);
  colModalCancel$.addEventListener("click", closeColModal);
  colModal$.addEventListener("click", e => { if (e.target === colModal$) closeColModal(); });
  colModalNameInput$.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); colModalConfirm$.click(); } });

  colModalConfirm$.addEventListener("click", async () => {
    const name = colModalNameInput$.value.trim();
    if (!name) { setStatus(colModalStatus$, "نام نمی‌تواند خالی باشد.", "warn"); return; }

    const id   = colModalId$.value;
    const mode = id ? "rename" : "create";

    colModalConfirm$.disabled = true;
    clearStatus(colModalStatus$);

    try {
      if (mode === "rename") {
        await apiPatch(`/rag/collections/${encodeURIComponent(id)}/rename`, { display_name: name });
        // Update cache
        const c = collectionsCache.find(x => x.id === id);
        if (c) c.display_name = name;
        // If detail modal open for this same collection, update its title
        if (activeCollection && activeCollection.id === id) {
          activeCollection.display_name = name;
          detailTitle$.textContent = name;
        }
        renderGrid(collectionsCache);
        triggerRagCollectionsRefresh();
      } else {
        // "Create" = just name; we need a first file to actually build the index.
        // So we store a pending placeholder and open the detail modal immediately.
        const tempId = "new_" + Date.now();
        const pending = { id: tempId, display_name: name, _pending: true };
        collectionsCache.unshift(pending);
        renderGrid(collectionsCache);
        closeColModal();
        openDetailModal(pending);
        return;
      }
      closeColModal();
    } catch (err) {
      setStatus(colModalStatus$, "خطا: " + (err.message || err), "error");
    } finally {
      colModalConfirm$.disabled = false;
    }
  });

  // ── Detail Modal ───────────────────────────────────────────────────────────
  async function openDetailModal(col) {
    activeCollection = col;
    detailTitle$.textContent = col.display_name;
    detailMeta$.textContent  = col._pending ? "مجموعه جدید — هنوز فایلی ندارد" : "در حال بارگذاری...";

    // Reset upload state
    addFilesList   = [];
    isAddingFiles  = false;
    renderDetailFileChips();
    detailUploadBtn$.disabled = true;
    clearStatus(detailUploadStatus$);
    detailProgressWrap$.style.display = "none";

    detailBody$.innerHTML = "";
    if (!col._pending) {
      detailLoading$.style.display = "flex";
      detailBody$.appendChild(detailLoading$);
    }

    detailBackdrop$.classList.add("open");
    detailBackdrop$.removeAttribute("aria-hidden");

    if (!col._pending) {
      await refreshDetailFiles(col.id);
    }
  }

  async function refreshDetailFiles(colId) {
    detailLoading$.style.display = "flex";
    if (!detailBody$.contains(detailLoading$)) detailBody$.prepend(detailLoading$);

    try {
      const data = await apiGet(`/rag/collections/${encodeURIComponent(colId)}/documents`);
      detailFiles = data.documents || [];
      renderDetailFiles();
      // update meta pill
      const totalChunks = detailFiles.reduce((s, d) => s + d.chunk_count, 0);
      detailMeta$.textContent = `${detailFiles.length} سند · ${totalChunks.toLocaleString("fa")} قطعه`;
    } catch (err) {
      detailBody$.innerHTML = `<div class="docs-detail-error">❌ خطا در بارگذاری: ${escHtml(String(err.message || err))}</div>`;
    } finally {
      detailLoading$.style.display = "none";
    }
  }

  function renderDetailFiles() {
    detailBody$.innerHTML = "";

    if (!detailFiles.length) {
      detailBody$.innerHTML = `<div class="docs-detail-empty">هیچ فایلی در این مجموعه یافت نشد.<br><small>از بالا فایل اضافه کنید.</small></div>`;
      return;
    }

    const list = document.createElement("div");
    list.className = "docs-detail-file-list";

    detailFiles.forEach(doc => {
      const isPdf  = doc.file_type === "pdf";
      const isWord = doc.file_type === "word";
      const typeLabel = isPdf ? "PDF" : isWord ? "Word" : "فایل";
      const typeCls   = isPdf ? "badge-pdf" : isWord ? "badge-word" : "badge-other";

      const metaParts = [];
      if (doc.page_count != null) metaParts.push(`${doc.page_count} صفحه`);
      metaParts.push(`${doc.chunk_count} قطعه`);

      const row = document.createElement("div");
      row.className = "docs-detail-file-row";
      row.innerHTML = `
        <div class="docs-detail-file-icon ${isPdf ? "icon-pdf" : "icon-word"}">
          ${isPdf
            ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
            : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>`}
        </div>
        <div class="docs-detail-file-info">
          <div class="docs-detail-file-name" title="${escHtml(doc.filename)}">${escHtml(doc.filename)}</div>
          <div class="docs-detail-file-meta">
            <span class="doc-badge ${typeCls}">${typeLabel}</span>
            ${metaParts.map(p => `<span class="doc-meta-item">${p}</span>`).join("")}
          </div>
        </div>
        <button class="docs-detail-open-file-btn btn-secondary" data-filename="${escHtml(doc.filename)}" title="مشاهده فایل در سامانه" type="button">
          <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 4H4v12h12v-4"/><path d="M10 10l6-6M12 4h4v4"/></svg>
          مشاهده
        </button>
        <button class="docs-detail-delete-file-btn btn-danger" data-filename="${escHtml(doc.filename)}" title="حذف این فایل" type="button">
          <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5l.867 9.143A1 1 0 006.862 15h6.276a1 1 0 00.995-.857L15 5"/><path d="M3 5h14M8 5V3h4v2"/></svg>
          حذف
        </button>`;

      row.classList.add("docs-detail-file-row-clickable");
      row.title = "کلیک برای مشاهده";
      row.addEventListener("click", async () => {
        try {
          await apiOpenFile(
            `/rag/collections/${encodeURIComponent(activeCollection.id)}/files/${encodeURIComponent(doc.filename)}/download`,
            doc.filename,
            { inline: true },
          );
        } catch (err) {
          setStatus(detailUploadStatus$, "خطا در باز کردن فایل: " + (err.message || err), "error");
        }
      });

      row.querySelector(".docs-detail-open-file-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await apiOpenFile(
            `/rag/collections/${encodeURIComponent(activeCollection.id)}/files/${encodeURIComponent(doc.filename)}/download`,
            doc.filename,
            { inline: true },
          );
        } catch (err) {
          setStatus(detailUploadStatus$, "خطا در باز کردن فایل: " + (err.message || err), "error");
        }
      });

      row.querySelector(".docs-detail-delete-file-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        const btn      = e.currentTarget;
        const fname    = doc.filename;
        const original = btn.innerHTML;

        // inline confirm
        btn.innerHTML    = "تأیید حذف";
        btn.classList.add("confirming");
        btn.onclick = async () => {
          btn.disabled = true;
          row.style.opacity = "0.5";
          try {
            await apiDelete(`/rag/collections/${encodeURIComponent(activeCollection.id)}/files/${encodeURIComponent(fname)}`);
            row.classList.add("docs-row-removing");
            row.addEventListener("animationend", () => row.remove());
            detailFiles = detailFiles.filter(f => f.filename !== fname);
            const totalChunks = detailFiles.reduce((s, d) => s + d.chunk_count, 0);
            detailMeta$.textContent = `${detailFiles.length} سند · ${totalChunks.toLocaleString("fa")} قطعه`;
            if (!detailFiles.length) {
              detailBody$.innerHTML = `<div class="docs-detail-empty">هیچ فایلی در این مجموعه یافت نشد.<br><small>از بالا فایل اضافه کنید.</small></div>`;
              // Collection was deleted because it became empty
              collectionsCache = collectionsCache.filter(c => c.id !== activeCollection.id);
              renderGrid(collectionsCache);
              triggerRagCollectionsRefresh();
              closeDetailModal();
            }
          } catch (err) {
            row.style.opacity = "";
            btn.disabled      = false;
            btn.innerHTML     = original;
            btn.classList.remove("confirming");
            btn.onclick       = null;
            setStatus(detailUploadStatus$, "خطا در حذف: " + (err.message || err), "error");
          }
        };
        // cancel if clicked elsewhere
        const cancel = () => {
          btn.innerHTML = original;
          btn.classList.remove("confirming");
          btn.onclick = null;
          document.removeEventListener("click", cancel);
        };
        setTimeout(() => document.addEventListener("click", cancel, { once: true }), 50);
      });

      list.appendChild(row);
    });

    detailBody$.appendChild(list);
  }

  function closeDetailModal() {
    detailBackdrop$.classList.remove("open");
    detailBackdrop$.setAttribute("aria-hidden", "true");
    if (addFilesAbort) { addFilesAbort.abort(); addFilesAbort = null; }
    activeCollection = null;
    detailFiles      = [];
    addFilesList     = [];
  }

  detailClose$.addEventListener("click",        closeDetailModal);
  detailCloseFooter$.addEventListener("click",  closeDetailModal);
  detailBackdrop$.addEventListener("click", e  => { if (e.target === detailBackdrop$) closeDetailModal(); });

  // Rename from detail modal
  detailRenameBtn$.addEventListener("click", () => {
    if (!activeCollection) return;
    closeDetailModal();
    openColModal("rename", activeCollection);
  });

  // Delete collection from detail modal
  detailDeleteBtn$.addEventListener("click", async () => {
    if (!activeCollection) return;
    const col = activeCollection;

    // Change button to confirm state
    const original = detailDeleteBtn$.innerHTML;
    detailDeleteBtn$.innerHTML   = "تأیید حذف";
    detailDeleteBtn$.style.background = "var(--danger)";
    detailDeleteBtn$.style.color      = "#fff";

    const cancel = () => {
      detailDeleteBtn$.innerHTML         = original;
      detailDeleteBtn$.style.background  = "";
      detailDeleteBtn$.style.color       = "";
      document.removeEventListener("click", cancel);
    };

    detailDeleteBtn$.onclick = async () => {
      document.removeEventListener("click", cancel);
      detailDeleteBtn$.disabled = true;
      try {
        await apiDelete(`/rag/collections/${encodeURIComponent(col.id)}`);
        collectionsCache = collectionsCache.filter(c => c.id !== col.id);
        renderGrid(collectionsCache);
        triggerRagCollectionsRefresh();
        closeDetailModal();
      } catch (err) {
        cancel();
        setStatus(detailUploadStatus$, "خطا در حذف: " + (err.message || err), "error");
      }
    };

    setTimeout(() => document.addEventListener("click", cancel, { once: true }), 50);
  });

  // Chat button from detail modal
  detailChatBtn$.addEventListener("click", () => {
    if (!activeCollection || activeCollection._pending) return;
    const col = activeCollection;
    closeDetailModal();
    // Switch to RAG section and pre-select collection
    navigateToRagWithCollection(col.id, col.display_name);
  });

  // ── Upload files inside detail modal ──────────────────────────────────────
  const ALLOWED_TYPES = ["application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword"];
  const ALLOWED_EXT   = /\.(pdf|docx|doc)$/i;

  function isAllowed(file) {
    return ALLOWED_TYPES.includes(file.type) || ALLOWED_EXT.test(file.name);
  }

  function fileIcon(file) { return file.name.match(/\.(docx|doc)$/i) ? "📝" : "📄"; }

  detailDrop$.addEventListener("click", () => detailFileInput$.click());
  detailDrop$.addEventListener("dragover",  e => { e.preventDefault(); detailDrop$.classList.add("drag-over"); });
  detailDrop$.addEventListener("dragleave", ()  => detailDrop$.classList.remove("drag-over"));
  detailDrop$.addEventListener("drop", e => {
    e.preventDefault();
    detailDrop$.classList.remove("drag-over");
    addToStagedFiles([...e.dataTransfer.files]);
  });
  detailFileInput$.addEventListener("change", () => {
    addToStagedFiles([...detailFileInput$.files]);
    detailFileInput$.value = "";
  });

  function addToStagedFiles(files) {
    files.forEach(f => {
      if (isAllowed(f) && !addFilesList.find(x => x.name === f.name)) addFilesList.push(f);
    });
    renderDetailFileChips();
    detailUploadBtn$.disabled = !addFilesList.length || isAddingFiles;
  }

  function renderDetailFileChips() {
    detailFileChips$.innerHTML = "";
    addFilesList.forEach((f, i) => {
      const chip = document.createElement("div");
      chip.className = "file-tag";
      chip.innerHTML = `<span>${fileIcon(f)} ${escHtml(f.name)}</span><span class="remove-file" data-i="${i}">✕</span>`;
      detailFileChips$.appendChild(chip);
    });
    detailFileChips$.querySelectorAll(".remove-file").forEach(btn => {
      btn.addEventListener("click", () => {
        addFilesList.splice(parseInt(btn.dataset.i), 1);
        renderDetailFileChips();
        detailUploadBtn$.disabled = !addFilesList.length || isAddingFiles;
      });
    });
  }

  detailUploadBtn$.addEventListener("click", () => startAddFiles());

  function startAddFiles() {
    if (!activeCollection || !addFilesList.length) return;

    // Pending collection → need to create via index, not add-to-existing
    if (activeCollection._pending) {
      startCreateCollection();
      return;
    }

    isAddingFiles             = true;
    detailUploadBtn$.disabled = true;
    clearStatus(detailUploadStatus$);
    setProgress(2);
    setStatus(detailUploadStatus$, "⏳ در حال ایندکس کردن فایل‌ها...", "info");

    addFilesJobId = "docsjob_" + Date.now();
    addFilesAbort = new AbortController();

    const form = new FormData();
    addFilesList.forEach(f => form.append("files", f));
    form.append("job_id", addFilesJobId);

    fetch(`${API_BASE}/rag/collections/${encodeURIComponent(activeCollection.id)}/files/stream`, {
      method:  "POST",
      headers: _authHeaders(),
      body:    form,
      signal:  addFilesAbort.signal,
    })
    .then(res => {
      if (res.status === 401) { _handle401(); return; }
      if (!res.ok) return res.json().then(e => { throw new Error(e.detail || res.statusText); });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { finalizeAdd(); return; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());
              if (p.progress !== undefined) {
                setProgress(p.progress);
                setStatus(detailUploadStatus$, `⏳ ${p.detail || ""}`, "info");
              }
              if (p.done) {
                setProgress(100);
                setStatus(detailUploadStatus$, `✅ فایل‌ها اضافه شدند — مجموع ${p.total_chunks} قطعه`, "ok");
                addFilesList = [];
                renderDetailFileChips();
                finalizeAdd();
                refreshDetailFiles(activeCollection.id);
                triggerRagCollectionsRefresh();
                return;
              }
              if (p.cancelled) { setStatus(detailUploadStatus$, "⚠️ لغو شد.", "warn"); finalizeAdd(); return; }
              if (p.error)     { setStatus(detailUploadStatus$, `❌ ${p.error}`, "error"); finalizeAdd(); return; }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError") setStatus(detailUploadStatus$, `❌ ${err.message}`, "error");
          finalizeAdd();
        });
      }
      read();
    })
    .catch(err => {
      if (err.name !== "AbortError") setStatus(detailUploadStatus$, `❌ ${err.message}`, "error");
      finalizeAdd();
    });
  }

  function finalizeAdd() {
    isAddingFiles             = false;
    addFilesAbort             = null;
    detailUploadBtn$.disabled = !addFilesList.length;
  }

  // ── Create new collection (via first-time index) ───────────────────────────
  function startCreateCollection() {
    const name = activeCollection.display_name;
    if (!addFilesList.length) return;

    isAddingFiles             = true;
    detailUploadBtn$.disabled = true;
    clearStatus(detailUploadStatus$);
    setProgress(2);
    setStatus(detailUploadStatus$, "⏳ در حال ایجاد و ایندکس مجموعه...", "info");

    const jobId = "docsjob_" + Date.now();
    addFilesJobId = jobId;
    addFilesAbort = new AbortController();

    const form = new FormData();
    addFilesList.forEach(f => form.append("files", f));
    form.append("collection", name);
    form.append("job_id", jobId);

    fetch(`${API_BASE}/rag/index/stream`, {
      method:  "POST",
      headers: _authHeaders(),
      body:    form,
      signal:  addFilesAbort.signal,
    })
    .then(res => {
      if (res.status === 401) { _handle401(); return; }
      if (!res.ok) return res.json().then(e => { throw new Error(e.detail || res.statusText); });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = "";

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { finalizeAdd(); return; }
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n"); buf = parts.pop();
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());
              if (p.progress !== undefined) {
                setProgress(p.progress);
                setStatus(detailUploadStatus$, `⏳ ${p.detail || ""}`, "info");
              }
              if (p.done) {
                setProgress(100);
                const realId = p.collection || name;
                setStatus(detailUploadStatus$, `✅ مجموعه «${name}» ساخته شد — ${p.total_chunks} قطعه`, "ok");
                // Replace pending entry with real one
                const realCol = { id: realId, display_name: name };
                const idx = collectionsCache.findIndex(c => c._pending && c.display_name === name);
                if (idx !== -1) collectionsCache.splice(idx, 1, realCol);
                else            collectionsCache.unshift(realCol);
                activeCollection = realCol;
                detailTitle$.textContent = realCol.display_name;
                renderGrid(collectionsCache);
                triggerRagCollectionsRefresh();
                addFilesList = [];
                renderDetailFileChips();
                finalizeAdd();
                refreshDetailFiles(realCol.id);
                return;
              }
              if (p.cancelled) { setStatus(detailUploadStatus$, "⚠️ لغو شد.", "warn"); finalizeAdd(); return; }
              if (p.error)     { setStatus(detailUploadStatus$, `❌ ${p.error}`, "error"); finalizeAdd(); return; }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError") setStatus(detailUploadStatus$, `❌ ${err.message}`, "error");
          finalizeAdd();
        });
      }
      read();
    })
    .catch(err => {
      if (err.name !== "AbortError") setStatus(detailUploadStatus$, `❌ ${err.message}`, "error");
      finalizeAdd();
    });
  }

  // ── Navigate to RAG section with pre-selected collection ──────────────────
  function navigateToRagWithCollection(colId, displayName) {
    // Activate rag section via app.js nav system
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    const ragNav = document.querySelector('[data-section="rag"]');
    const ragSec = document.getElementById("section-rag");
    if (ragNav) ragNav.classList.add("active");
    if (ragSec) ragSec.classList.add("active");

    // Pre-select the collection in rag.js dropdown
    // rag.js stores the selected value in #ragCollection (hidden input) and #collectionDropdownLabel
    const ragColInput = document.getElementById("ragCollection");
    const ragColLabel = document.getElementById("collectionDropdownLabel");
    if (ragColInput) ragColInput.value = colId;
    if (ragColLabel) ragColLabel.textContent = displayName;
    // Update the hidden native select too
    const ragColSel = document.getElementById("ragCollectionSelect");
    if (ragColSel) {
      // find or create the option
      let opt = [...ragColSel.options].find(o => o.value === colId);
      if (!opt) {
        opt = document.createElement("option");
        opt.value = colId;
        opt.textContent = displayName;
        ragColSel.appendChild(opt);
      }
      ragColSel.value = colId;
    }
  }

  // ── Sync rag.js collections dropdown after any change ─────────────────────
  function triggerRagCollectionsRefresh() {
    // rag.js exposes loadCollections via a button click dispatch
    const btn = document.getElementById("ragRefreshCollections");
    if (btn) btn.click();
  }

  // ── Global keyboard close ──────────────────────────────────────────────────
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (detailBackdrop$.classList.contains("open")) { closeDetailModal(); return; }
    if (colModal$.classList.contains("open"))       { closeColModal();    return; }
  });

  // ── Toolbar button wiring ──────────────────────────────────────────────────
  refreshBtn$.addEventListener("click",  loadCollections);
  newColBtn$.addEventListener("click",   () => openColModal("create"));
  emptyNewBtn$.addEventListener("click", () => openColModal("create"));

  // ── Section activation hook ────────────────────────────────────────────────
  // Listen for the custom event dispatched by app.js on every nav click
  document.addEventListener("sectionActivated", (e) => {
    if (e.detail && e.detail.section === "docs") {
      loadCollections();
    }
  });

  // Initial load: if docs section is already active on page load, load immediately
  if (document.getElementById("section-docs")?.classList.contains("active")) {
    loadCollections();
  }

})();
