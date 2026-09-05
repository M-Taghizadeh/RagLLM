/**
 * alerts.js — News alert rules & scanning module
 */

(function () {
  let rules     = [];
  let editingId = null;

  // DOM refs — rules
  const rulesList$       = document.getElementById("rulesList");
  const ruleId$          = document.getElementById("ruleId");
  const ruleName$        = document.getElementById("ruleName");
  const ruleCategory$    = document.getElementById("ruleCategory");
  const ruleKeywords$    = document.getElementById("ruleKeywords");
  const ruleDescription$ = document.getElementById("ruleDescription");
  const ruleSave$        = document.getElementById("ruleSave");
  const ruleCancel$      = document.getElementById("ruleCancel");

  // DOM refs — slide panel
  const addRuleBtn$      = document.getElementById("addRuleBtn");
  const formBackdrop$    = document.getElementById("ruleFormBackdrop");
  const formPanel$       = document.getElementById("ruleFormPanel");
  const formTitle$       = document.getElementById("ruleFormTitle");
  const formClose$       = document.getElementById("ruleFormClose");

  // DOM refs — scan
  const scanUrl$         = document.getElementById("scanUrl");
  const scanCheckboxes$  = document.getElementById("scanRuleCheckboxes");
  const scanBtn$         = document.getElementById("scanBtn");
  const scanStatus$      = document.getElementById("scanStatus");
  const scanResults$     = document.getElementById("scanResults");

  // DOM refs — history
  const refreshResults$  = document.getElementById("refreshResults");
  const alertHistory$    = document.getElementById("alertHistory");
  const historyBadge$    = document.getElementById("historyBadge");

  // DOM refs — tabs
  const tabScan$         = document.getElementById("tabScan");
  const tabHistory$      = document.getElementById("tabHistory");
  const panelScan$       = document.getElementById("tabpanelScan");
  const panelHistory$    = document.getElementById("tabpanelHistory");

  // ── Tabs ────────────────────────────────────────────────────────

  function switchTab(tab) {
    const isScan = tab === "scan";
    tabScan$.classList.toggle("active", isScan);
    tabHistory$.classList.toggle("active", !isScan);
    tabScan$.setAttribute("aria-selected", isScan);
    tabHistory$.setAttribute("aria-selected", !isScan);
    panelScan$.hidden  = !isScan;
    panelHistory$.hidden = isScan;
    if (!isScan) { historyBadge$.hidden = true; historyBadge$.textContent = ""; }
  }

  tabScan$.addEventListener("click",    () => switchTab("scan"));
  tabHistory$.addEventListener("click", () => switchTab("history"));

  // ── Slide panel ─────────────────────────────────────────────────

  function openForm(title) {
    formTitle$.textContent = title;
    formBackdrop$.classList.add("open");
    formBackdrop$.removeAttribute("aria-hidden");
    setTimeout(() => ruleName$.focus(), 60);
  }

  function closeForm() {
    formBackdrop$.classList.remove("open");
    formBackdrop$.setAttribute("aria-hidden", "true");
    editingId = null;
    ruleId$.value = "";
    ruleName$.value = ruleCategory$.value = ruleKeywords$.value = ruleDescription$.value = "";
  }

  addRuleBtn$.addEventListener("click", () => { editingId = null; openForm("قانون جدید"); });
  formClose$.addEventListener("click", closeForm);
  ruleCancel$.addEventListener("click", closeForm);
  formBackdrop$.addEventListener("click", e => { if (e.target === formBackdrop$) closeForm(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && formBackdrop$.classList.contains("open")) closeForm();
  });

  // ── Rules CRUD ──────────────────────────────────────────────────

  async function loadRules() {
    try {
      const data = await apiGet("/alerts/rules");
      rules = data.rules || [];
      renderRules();
      renderScanCheckboxes();
    } catch (e) {
      console.error("loadRules:", e);
    }
  }

  function renderRules() {
    rulesList$.innerHTML = "";
    if (!rules.length) {
      rulesList$.innerHTML = `<div class="empty-state">هنوز قانونی تعریف نشده</div>`;
      return;
    }
    rules.forEach(r => {
      const card = document.createElement("div");
      card.className = "rule-card";
      card.innerHTML = `
        <div class="rule-card-header">
          <span class="rule-card-name">${escHtml(r.name)}</span>
          <span class="rule-card-cat">${escHtml(r.category)}</span>
          <span class="rule-card-actions">
            <button class="rule-action-btn edit-rule" data-id="${r.id}" title="ویرایش">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 11V14h3l7-7-3-3-7 7zM13.5 4.5l-2-2"/></svg>
            </button>
            <button class="rule-action-btn rule-delete-btn" data-id="${r.id}" title="حذف">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4l.7 8.1A1 1 0 004.7 13h6.6a1 1 0 001-.9L13 4"/><path d="M1 4h14M6 4V2h4v2"/></svg>
            </button>
          </span>
        </div>
        <div class="rule-card-kw">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" style="vertical-align:-1px;opacity:.5;flex-shrink:0" aria-hidden="true"><circle cx="6" cy="6" r="4"/><path d="M10 10l3 3"/></svg>
          ${escHtml(r.keywords)}
        </div>
        ${r.description ? `<div class="rule-card-desc">${escHtml(r.description)}</div>` : ""}`;
      rulesList$.appendChild(card);
    });

    rulesList$.querySelectorAll(".edit-rule").forEach(btn =>
      btn.addEventListener("click", () => startEdit(parseInt(btn.dataset.id)))
    );
    rulesList$.querySelectorAll(".rule-delete-btn").forEach(btn =>
      btn.addEventListener("click", () => deleteRule(parseInt(btn.dataset.id), btn))
    );
  }

  function renderScanCheckboxes() {
    scanCheckboxes$.innerHTML = "";
    if (!rules.length) {
      scanCheckboxes$.innerHTML = `<div class="empty-state" style="font-size:12px">ابتدا قانون هشدار تعریف کنید</div>`;
      return;
    }
    rules.forEach(r => {
      const label = document.createElement("label");
      label.className = "checkbox-item";
      label.innerHTML = `
        <input type="checkbox" value="${r.id}" checked />
        <span>${escHtml(r.name)} <small style="color:var(--ink-muted)">(${escHtml(r.category)})</small></span>`;
      scanCheckboxes$.appendChild(label);
    });
  }

  function startEdit(id) {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    editingId          = id;
    ruleId$.value      = id;
    ruleName$.value        = rule.name;
    ruleCategory$.value    = rule.category;
    ruleKeywords$.value    = rule.keywords;
    ruleDescription$.value = rule.description || "";
    openForm("ویرایش قانون");
  }

  ruleSave$.addEventListener("click", async () => {
    const name     = ruleName$.value.trim();
    const category = ruleCategory$.value.trim();
    const keywords = ruleKeywords$.value.trim();
    if (!name || !category || !keywords) {
      setStatus(scanStatus$, "نام، دسته‌بندی و کلیدواژه‌ها الزامی است.", "warn");
      return;
    }
    const body   = { name, category, keywords, description: ruleDescription$.value.trim() };
    const method = editingId ? "PUT" : "POST";
    const path   = editingId ? `/alerts/rules/${editingId}` : "/alerts/rules";
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
      closeForm();
      loadRules();
    } catch (e) {
      setStatus(scanStatus$, `❌ خطا در ذخیره: ${e.message}`, "error");
    }
  });

  async function deleteRule(id, btn) {
    const actionsEl = btn.closest(".rule-card-actions");
    const original  = actionsEl.innerHTML;

    actionsEl.innerHTML = `
      <button class="rule-action-btn rule-confirm-yes" title="تأیید حذف">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M2 8l4 4 8-8"/></svg>
      </button>
      <button class="rule-action-btn rule-confirm-no" title="انصراف">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>
      </button>`;

    actionsEl.querySelector(".rule-confirm-no").addEventListener("click", () => {
      actionsEl.innerHTML = original;
      reattachActionEvents(actionsEl, id);
    });

    actionsEl.querySelector(".rule-confirm-yes").addEventListener("click", async () => {
      try {
        await apiDelete(`/alerts/rules/${id}`);
        loadRules();
      } catch (e) {
        setStatus(scanStatus$, `❌ خطا: ${e.message}`, "error");
        actionsEl.innerHTML = original;
        reattachActionEvents(actionsEl, id);
      }
    });
  }

  function reattachActionEvents(actionsEl, id) {
    actionsEl.querySelector(".edit-rule")?.addEventListener("click", () => startEdit(id));
    actionsEl.querySelector(".rule-delete-btn")?.addEventListener("click", (e) => deleteRule(id, e.currentTarget));
  }

  // ── Scan ────────────────────────────────────────────────────────

  // ── Scan ────────────────────────────────────────────────────────

  function appendAlertCard(a) {
    const card = document.createElement("div");
    card.className = "alert-match-card";
    card.innerHTML = `
      <div class="match-rule">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 2a5 5 0 010 10M8 2v10M5 5H2M14 5h-3M5 9H2M14 9h-3"/></svg>
        ${escHtml(a.rule_name)} <small>(${escHtml(a.category)})</small>
      </div>
      <div class="match-reason">${escHtml(a.reason)}</div>
      ${a.excerpt ? `<div class="match-excerpt">${escHtml(a.excerpt)}</div>` : ""}
      <a class="match-url" href="${escHtml(a.url)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9"/><path d="M10 2h4v4M14 2L8 8"/></svg>
        ${escHtml(a.title || a.url)}
      </a>`;
    scanResults$.appendChild(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  scanBtn$.addEventListener("click", () => {
    const url = scanUrl$.value.trim();
    if (!url) { setStatus(scanStatus$, "لطفاً یک آدرس URL یا RSS وارد کنید.", "warn"); return; }

    const checkedIds = [...scanCheckboxes$.querySelectorAll("input:checked")].map(i => parseInt(i.value));
    if (!checkedIds.length) { setStatus(scanStatus$, "حداقل یک قانون انتخاب کنید.", "warn"); return; }

    const { ollamaUrl, model } = getSettings();
    setStatus(scanStatus$, "در حال اتصال...", "info");
    scanBtn$.disabled = true;
    scanResults$.innerHTML = "";

    let alertsFound = 0;
    let buf = "";

    fetch(`${API_BASE}/alerts/scan/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, rule_ids: checkedIds, model, ollama_url: ollamaUrl }),
    })
    .then(res => {
      if (!res.ok) return res.json().then(e => { throw new Error(e.detail || res.statusText); });

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { scanBtn$.disabled = false; return; }

          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop();

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            try {
              const p = JSON.parse(line.slice(5).trim());

              if (p.error) {
                setStatus(scanStatus$, `❌ ${p.error}`, "error");
                scanBtn$.disabled = false;
                return;
              }
              if (p.status === "fetching") {
                setStatus(scanStatus$, p.msg, "info");
              }
              if (p.status === "fetched") {
                setStatus(scanStatus$, `${p.msg} — شروع تحلیل...`, "info");
              }
              if (p.status === "scanning") {
                const pct = p.total ? Math.round(((p.article_index + 1) / p.total) * 100) : 0;
                setStatus(scanStatus$, `${pct}٪ — ${p.msg}`, "info");
              }
              if (p.status === "alert") {
                alertsFound++;
                if (scanResults$.querySelector(".empty-state")) scanResults$.innerHTML = "";
                appendAlertCard(p.alert);
                // badge روی تب تاریخچه
                historyBadge$.textContent = String(alertsFound);
                historyBadge$.hidden = false;
              }
              if (p.status === "done") {
                const { articles_scanned, rules_checked, alerts_found } = p;
                setStatus(
                  scanStatus$,
                  `✅ ${articles_scanned} خبر · ${rules_checked} قانون · ${alerts_found} هشدار`,
                  alerts_found > 0 ? "warn" : "ok"
                );
                if (!alerts_found) {
                  scanResults$.innerHTML = `<div class="empty-state">هیچ هشداری یافت نشد</div>`;
                } else {
                  loadResults();
                }
                scanBtn$.disabled = false;
              }
            } catch {}
          }
          read();
        }).catch(err => {
          setStatus(scanStatus$, `❌ ${err.message}`, "error");
          scanBtn$.disabled = false;
        });
      }
      read();
    })
    .catch(err => {
      setStatus(scanStatus$, `❌ ${err.message}`, "error");
      scanBtn$.disabled = false;
    });
  });

  // ── Alert history ────────────────────────────────────────────────

  async function loadResults() {
    try {
      const data = await apiGet("/alerts/results");
      const results = data.results || [];
      alertHistory$.innerHTML = "";
      if (!results.length) {
        alertHistory$.innerHTML = `<div class="empty-state">تاریخچه‌ای وجود ندارد</div>`;
        return;
      }
      results.forEach(r => {
        const card = document.createElement("div");
        card.className = "history-card";
        card.innerHTML = `
          <div class="history-card-header">
            <span class="history-card-rule">${escHtml(r.rule_name)}</span>
            <span class="history-card-cat">${escHtml(r.category)}</span>
          </div>
          ${r.title ? `<div class="history-card-title">${escHtml(r.title)}</div>` : ""}
          <a class="history-card-url" href="${escHtml(r.source_url)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M7 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9"/><path d="M10 2h4v4M14 2L8 8"/></svg>
            ${escHtml(r.source_url)}
          </a>
          ${r.excerpt ? `<div class="history-card-excerpt">${escHtml(r.excerpt)}</div>` : ""}
          <div class="history-card-footer">
            <span class="history-card-date">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" style="vertical-align:-1px;opacity:.5" aria-hidden="true"><rect x="1" y="3" width="14" height="12" rx="1"/><path d="M1 7h14M5 1v4M11 1v4"/></svg>
              ${fmtDate(r.matched_at)}
            </span>
            <button class="btn-danger history-delete" data-id="${r.id}" title="حذف">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4l.7 8.1A1 1 0 004.7 13h6.6a1 1 0 001-.9L13 4"/><path d="M1 4h14M6 4V2h4v2"/></svg>
            </button>
          </div>`;
        card.querySelector(".history-delete").addEventListener("click", async (e) => {
          try { await apiDelete(`/alerts/results/${r.id}`); loadResults(); } catch {}
        });
        alertHistory$.appendChild(card);
      });
    } catch {}
  }

  refreshResults$.addEventListener("click", loadResults);

  // Init
  loadRules();
  loadResults();
})();
