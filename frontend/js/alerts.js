/**
 * alerts.js — News alert rules & scanning module
 * Endpoints:
 *   GET    /api/alerts/rules
 *   POST   /api/alerts/rules
 *   PUT    /api/alerts/rules/:id
 *   DELETE /api/alerts/rules/:id
 *   POST   /api/alerts/scan
 *   GET    /api/alerts/results
 *   DELETE /api/alerts/results/:id
 */

(function () {
  let rules = [];       // current rules list
  let editingId = null; // id of rule being edited (null = new)

  // DOM refs
  const rulesList$        = document.getElementById("rulesList");
  const ruleForm$         = document.getElementById("ruleForm");
  const ruleId$           = document.getElementById("ruleId");
  const ruleName$         = document.getElementById("ruleName");
  const ruleCategory$     = document.getElementById("ruleCategory");
  const ruleKeywords$     = document.getElementById("ruleKeywords");
  const ruleDescription$  = document.getElementById("ruleDescription");
  const ruleSave$         = document.getElementById("ruleSave");
  const ruleCancel$       = document.getElementById("ruleCancel");

  const scanUrl$          = document.getElementById("scanUrl");
  const scanCheckboxes$   = document.getElementById("scanRuleCheckboxes");
  const scanBtn$          = document.getElementById("scanBtn");
  const scanStatus$       = document.getElementById("scanStatus");
  const scanResults$      = document.getElementById("scanResults");

  const refreshResults$   = document.getElementById("refreshResults");
  const alertHistory$     = document.getElementById("alertHistory");

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
        </div>
        <div class="rule-card-kw">🔑 ${escHtml(r.keywords)}</div>
        ${r.description ? `<div class="rule-card-kw" style="color:var(--text-muted)">${escHtml(r.description)}</div>` : ""}
        <div class="rule-card-actions">
          <button class="btn-edit edit-rule" data-id="${r.id}">✏️ ویرایش</button>
          <button class="btn-danger delete-rule" data-id="${r.id}">🗑️ حذف</button>
        </div>`;
      rulesList$.appendChild(card);
    });

    rulesList$.querySelectorAll(".edit-rule").forEach(btn =>
      btn.addEventListener("click", () => startEdit(parseInt(btn.dataset.id)))
    );
    rulesList$.querySelectorAll(".delete-rule").forEach(btn =>
      btn.addEventListener("click", () => deleteRule(parseInt(btn.dataset.id)))
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
        <span>${escHtml(r.name)} <small style="color:var(--text-muted)">(${escHtml(r.category)})</small></span>`;
      scanCheckboxes$.appendChild(label);
    });
  }

  function startEdit(id) {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    editingId = id;
    ruleId$.value          = id;
    ruleName$.value        = rule.name;
    ruleCategory$.value    = rule.category;
    ruleKeywords$.value    = rule.keywords;
    ruleDescription$.value = rule.description || "";
    ruleName$.focus();
  }

  ruleCancel$.addEventListener("click", () => {
    editingId = null;
    ruleId$.value = "";
    ruleName$.value = ruleCategory$.value = ruleKeywords$.value = ruleDescription$.value = "";
  });

  ruleSave$.addEventListener("click", async () => {
    const name     = ruleName$.value.trim();
    const category = ruleCategory$.value.trim();
    const keywords = ruleKeywords$.value.trim();
    if (!name || !category || !keywords) {
      alert("نام، دسته‌بندی و کلیدواژه‌ها الزامی است.");
      return;
    }
    const body = { name, category, keywords, description: ruleDescription$.value.trim() };
    try {
      if (editingId) {
        await apiPost(`/alerts/rules/${editingId}`, body);  // will use PUT via helper below
        await fetch(`${API_BASE}/alerts/rules/${editingId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await apiPost("/alerts/rules", body);
      }
      editingId = null;
      ruleId$.value = "";
      ruleName$.value = ruleCategory$.value = ruleKeywords$.value = ruleDescription$.value = "";
      loadRules();
    } catch (e) {
      alert(`خطا در ذخیره: ${e.message}`);
    }
  });

  // Override save to use PUT for edits
  async function saveRule() {
    const name     = ruleName$.value.trim();
    const category = ruleCategory$.value.trim();
    const keywords = ruleKeywords$.value.trim();
    if (!name || !category || !keywords) {
      alert("نام، دسته‌بندی و کلیدواژه‌ها الزامی است.");
      return;
    }
    const body = { name, category, keywords, description: ruleDescription$.value.trim() };
    const method = editingId ? "PUT" : "POST";
    const path   = editingId ? `/alerts/rules/${editingId}` : "/alerts/rules";

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail); }
      editingId = null;
      ruleId$.value = "";
      ruleName$.value = ruleCategory$.value = ruleKeywords$.value = ruleDescription$.value = "";
      loadRules();
    } catch (e) {
      alert(`خطا در ذخیره: ${e.message}`);
    }
  }

  // Rebind save button to correct function
  ruleSave$.removeEventListener("click", ruleSave$.onclick);
  ruleSave$.addEventListener("click", saveRule);

  async function deleteRule(id) {
    if (!confirm("این قانون حذف شود؟")) return;
    try {
      await apiDelete(`/alerts/rules/${id}`);
      loadRules();
    } catch (e) {
      alert(`خطا: ${e.message}`);
    }
  }

  // ── Scan ────────────────────────────────────────────────────────

  scanBtn$.addEventListener("click", async () => {
    const url = scanUrl$.value.trim();
    if (!url) { setStatus(scanStatus$, "لطفاً یک آدرس URL یا RSS وارد کنید.", "warn"); return; }

    const checkedIds = [...scanCheckboxes$.querySelectorAll("input:checked")].map(i => parseInt(i.value));
    if (!checkedIds.length) { setStatus(scanStatus$, "حداقل یک قانون انتخاب کنید.", "warn"); return; }

    const { ollamaUrl, model } = getSettings();
    setStatus(scanStatus$, "⏳ در حال اسکن محتوا با مدل زبانی...", "info");
    scanBtn$.disabled = true;
    scanResults$.innerHTML = "";

    try {
      const data = await apiPost("/alerts/scan", {
        url,
        rule_ids:   checkedIds,
        model,
        ollama_url: ollamaUrl,
      });

      const { articles_scanned, rules_checked, alerts_found, alerts } = data;
      setStatus(
        scanStatus$,
        `✅ اسکن تمام شد — ${articles_scanned} خبر، ${rules_checked} قانون، ${alerts_found} هشدار یافت شد`,
        alerts_found > 0 ? "warn" : "ok"
      );

      if (!alerts_found) {
        scanResults$.innerHTML = `<div class="empty-state">هیچ هشداری یافت نشد</div>`;
      } else {
        alerts.forEach(a => {
          const card = document.createElement("div");
          card.className = "alert-match-card";
          card.innerHTML = `
            <div class="match-rule">🔔 ${escHtml(a.rule_name)} <small>(${escHtml(a.category)})</small></div>
            <div class="match-reason">${escHtml(a.reason)}</div>
            ${a.excerpt ? `<div class="match-excerpt">${escHtml(a.excerpt)}</div>` : ""}
            <div class="match-url"><a href="${escHtml(a.url)}" target="_blank">🔗 ${escHtml(a.title || a.url)}</a></div>`;
          scanResults$.appendChild(card);
        });
        // Refresh history
        loadResults();
      }
    } catch (e) {
      setStatus(scanStatus$, `❌ خطا: ${e.message}`, "error");
    } finally {
      scanBtn$.disabled = false;
    }
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
            <span class="history-card-rule">🔔 ${escHtml(r.rule_name)}</span>
            <span class="history-card-cat">${escHtml(r.category)}</span>
          </div>
          ${r.title ? `<div class="history-card-title">${escHtml(r.title)}</div>` : ""}
          <div class="history-card-url"><a href="${escHtml(r.source_url)}" target="_blank">🔗 ${escHtml(r.source_url)}</a></div>
          ${r.excerpt ? `<div style="font-size:12px;color:var(--text-muted);border-right:3px solid var(--warning);padding-right:8px;margin-top:4px">${escHtml(r.excerpt)}</div>` : ""}
          <div class="history-card-date">📅 ${fmtDate(r.matched_at)}
            <button class="btn-danger" style="float:left;margin-top:-2px" data-id="${r.id}">🗑️</button>
          </div>`;
        card.querySelector(".btn-danger").addEventListener("click", async () => {
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
