/**
 * app.js — global navigation, settings page, model loaders, user bar
 */

(function () {

  const SETTINGS_KEY = "ragbot_llm_settings";

  // ── User bar ────────────────────────────────────────────────────────────────
  const userAvatar$      = document.getElementById("userAvatar");
  const userDisplayName$ = document.getElementById("userDisplayName");
  const userRoleBadge$   = document.getElementById("userRoleBadge");
  const logoutBtn$       = document.getElementById("logoutBtn");
  const navUsers$        = document.getElementById("navUsers");

  (function initUserBar() {
    const name = Auth.getDisplayName() || Auth.getUsername();
    userDisplayName$.textContent = name;
    userAvatar$.textContent      = name.charAt(0).toUpperCase() || "U";
    userRoleBadge$.textContent   = Auth.isAdmin() ? "مدیر سیستم" : "کاربر";
    if (Auth.isAdmin() && navUsers$) navUsers$.style.display = "flex";
  })();

  logoutBtn$.addEventListener("click", () => Auth.logout());

  // ── Section navigation ─────────────────────────────────────────────────────
  const navItems  = document.querySelectorAll(".nav-item");
  const sections  = document.querySelectorAll(".section");
  const sidebar$  = document.getElementById("sidebar");
  const toggle$   = document.getElementById("sidebarToggle");

  navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.section;
      navItems.forEach(b => b.classList.remove("active"));
      sections.forEach(s => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`section-${target}`).classList.add("active");
      document.dispatchEvent(new CustomEvent("sectionActivated", { detail: { section: target } }));
      if (window.innerWidth <= 768) sidebar$.classList.remove("open");
    });
  });

  toggle$.addEventListener("click", () => sidebar$.classList.toggle("open"));

  // ── Temperature display ─────────────────────────────────────────
  const temp$    = document.getElementById("temperature");
  const tempVal$ = document.getElementById("tempVal");

  function updateTempSlider() {
    const val = parseFloat(temp$.value);
    tempVal$.textContent = val.toFixed(2);
    temp$.style.setProperty("--pct", (val * 100) + "%");
  }

  temp$.addEventListener("input", updateTempSlider);
  updateTempSlider();

  // ── Provider tabs (draft vs active) ─────────────────────────────
  const providerInput$      = document.getElementById("llmProvider");
  const providerDraft$      = document.getElementById("llmProviderDraft");
  const panelOllama$        = document.getElementById("settingsPanelOllama");
  const panelApi$           = document.getElementById("settingsPanelApi");
  const providerTabs        = document.querySelectorAll(".settings-provider-tab");
  const activeProviderLbl$  = document.getElementById("settingsActiveProvider");
  const activateBtn$        = document.getElementById("settingsActivateBtn");

  function providerLabel(p) {
    return p === "api" ? "API" : "Ollama";
  }

  function updateActiveBadge() {
    const active = providerInput$.value === "api" ? "api" : "ollama";
    if (activeProviderLbl$) activeProviderLbl$.textContent = providerLabel(active);
    if (activateBtn$) {
      const draft = providerDraft$.value === "api" ? "api" : "ollama";
      const same = draft === active;
      activateBtn$.textContent = same
        ? `فعال است: ${providerLabel(active)}`
        : `فعال‌سازی حالت ${providerLabel(draft)}`;
      activateBtn$.disabled = same;
      activateBtn$.classList.toggle("btn-secondary", same);
      activateBtn$.classList.toggle("btn-primary", !same);
    }
  }

  function showDraftPanel(provider) {
    const p = provider === "api" ? "api" : "ollama";
    providerDraft$.value = p;
    providerTabs.forEach(tab => {
      tab.classList.toggle("active", tab.dataset.provider === p);
    });
    panelOllama$.hidden = p !== "ollama";
    panelApi$.hidden = p !== "api";
    updateActiveBadge();
  }

  function activateProvider(provider, { persist = true, toast = true } = {}) {
    const p = provider === "api" ? "api" : "ollama";
    if (p === "api") {
      const url = apiBaseUrl$.value.trim();
      const token = apiToken$.value.trim();
      const model = apiModelInput$.value.trim();
      if (!url) {
        setStatus(settingsStatus$, "آدرس API را وارد کنید.", "warn");
        return false;
      }
      if (!token) {
        setStatus(settingsStatus$, "توکن API را وارد کنید.", "warn");
        return false;
      }
      if (!model) {
        setStatus(settingsStatus$, "شناسه مدل API را وارد کنید.", "warn");
        return false;
      }
    }
    providerInput$.value = p;
    showDraftPanel(p);
    if (persist) saveSettings(false);
    if (toast) setStatus(settingsStatus$, `حالت فعال: ${providerLabel(p)}`, "success");
    updateActiveBadge();
    return true;
  }

  providerTabs.forEach(tab => {
    tab.addEventListener("click", () => showDraftPanel(tab.dataset.provider));
  });
  activateBtn$?.addEventListener("click", () => {
    activateProvider(providerDraft$.value, { persist: true, toast: true });
  });

  // ── Ollama model dropdown ───────────────────────────────────────
  const refreshBtn$  = document.getElementById("refreshModels");
  const ollamaUrl$   = document.getElementById("ollamaUrl");
  const modelSelect$ = document.getElementById("modelSelect");
  const modelBtn$    = document.getElementById("modelSelectBtn");
  const modelLabel$  = document.getElementById("modelSelectLabel");
  const modelList$   = document.getElementById("modelSelectList");

  function openModelDropdown() {
    modelList$.classList.add("open");
    modelBtn$.setAttribute("aria-expanded", "true");
  }
  function closeModelDropdown() {
    modelList$.classList.remove("open");
    modelBtn$.setAttribute("aria-expanded", "false");
  }
  function toggleModelDropdown() {
    modelList$.classList.contains("open") ? closeModelDropdown() : openModelDropdown();
  }
  function selectModel(value, label) {
    modelSelect$.value = value;
    modelLabel$.textContent = label || value || "انتخاب مدل";
    modelList$.querySelectorAll("li").forEach(li =>
      li.classList.toggle("selected", li.dataset.value === value)
    );
    closeModelDropdown();
  }

  function renderModelDropdown(models, defaultModel) {
    modelList$.innerHTML = "";
    modelSelect$.innerHTML = "";

    const items = (models || []).map(m =>
      typeof m === "string" ? { id: m, label: m } : m
    );

    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "custom-select-empty";
      empty.textContent = "مدلی پیدا نشد";
      modelList$.appendChild(empty);
      modelLabel$.textContent = "مدلی پیدا نشد";
      return;
    }

    let selected = defaultModel || "";
    if (!selected) selected = items.find(m => m.id.startsWith("qwen"))?.id || items[0].id;

    items.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (m.id === selected) opt.selected = true;
      modelSelect$.appendChild(opt);

      const li = document.createElement("li");
      li.dataset.value = m.id;
      li.innerHTML = `
        <span class="col-icon">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="2" y="2" width="12" height="12" rx="2"/>
            <path d="M5 6h6M5 10h4"/>
          </svg>
        </span>
        <span>${escHtml(m.label || m.id)}</span>`;
      if (m.id === selected) li.classList.add("selected");
      li.addEventListener("click", () => selectModel(m.id, m.label || m.id));
      modelList$.appendChild(li);
    });

    selectModel(selected, items.find(i => i.id === selected)?.label || selected);
  }

  modelBtn$.addEventListener("click", (e) => { e.stopPropagation(); toggleModelDropdown(); });

  // ── API fields ──────────────────────────────────────────────────
  const apiBaseUrl$      = document.getElementById("apiBaseUrl");
  const apiToken$        = document.getElementById("apiToken");
  const apiModelInput$   = document.getElementById("apiModelInput");
  const apiModelSelect$  = document.getElementById("apiModelSelect");
  const apiModelBtn$     = document.getElementById("apiModelSelectBtn");
  const apiModelLabel$   = document.getElementById("apiModelSelectLabel");
  const apiModelList$    = document.getElementById("apiModelSelectList");
  const apiModelWrap$    = document.getElementById("apiModelSelectWrap");
  const refreshApiBtn$   = document.getElementById("refreshApiModels");
  const settingsStatus$  = document.getElementById("settingsStatus");
  const settingsSaveBtn$ = document.getElementById("settingsSaveBtn");

  function openApiModelDropdown() {
    apiModelList$.classList.add("open");
    apiModelBtn$.setAttribute("aria-expanded", "true");
  }
  function closeApiModelDropdown() {
    apiModelList$.classList.remove("open");
    apiModelBtn$.setAttribute("aria-expanded", "false");
  }
  function selectApiModel(value, label) {
    if (apiModelSelect$) apiModelSelect$.value = value;
    if (apiModelInput$) apiModelInput$.value = value;
    if (apiModelLabel$) apiModelLabel$.textContent = label || value || "انتخاب از لیست";
    apiModelList$?.querySelectorAll("li").forEach(li =>
      li.classList.toggle("selected", li.dataset.value === value)
    );
    closeApiModelDropdown();
  }

  function renderApiModelDropdown(models, defaultModel) {
    if (!apiModelList$ || !apiModelSelect$ || !apiModelWrap$) return;
    apiModelList$.innerHTML = "";
    apiModelSelect$.innerHTML = "";
    const items = models || [];
    if (!items.length) {
      apiModelWrap$.style.display = "none";
      return;
    }
    apiModelWrap$.style.display = "block";
    let selected = defaultModel || apiModelInput$?.value.trim() || items[0]?.id || "";

    items.forEach(m => {
      const id = m.id || m;
      const label = m.label || m.id || m;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      if (id === selected) opt.selected = true;
      apiModelSelect$.appendChild(opt);

      const li = document.createElement("li");
      li.dataset.value = id;
      li.innerHTML = `<span>${escHtml(label)}</span>`;
      if (id === selected) li.classList.add("selected");
      li.addEventListener("click", () => selectApiModel(id, label));
      apiModelList$.appendChild(li);
    });

    selectApiModel(selected, items.find(i => (i.id || i) === selected)?.label || selected);
  }

  apiModelBtn$?.addEventListener("click", (e) => { e.stopPropagation(); openApiModelDropdown(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#modelSelectWrap")) closeModelDropdown();
    if (!e.target.closest("#apiModelSelectWrap")) closeApiModelDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelDropdown();
      closeApiModelDropdown();
    }
  });

  // ── Persist / restore ───────────────────────────────────────────
  function collectSettings() {
    return {
      provider: providerInput$.value === "api" ? "api" : "ollama",
      ollamaUrl: ollamaUrl$.value.trim(),
      model: modelSelect$.value.trim(),
      apiBaseUrl: apiBaseUrl$.value.trim(),
      apiToken: apiToken$.value.trim(),
      apiModel: apiModelInput$.value.trim() || apiModelSelect$?.value.trim() || "",
      temperature: parseFloat(temp$.value) || 0.3,
      useWeb: document.getElementById("useWeb").checked,
    };
  }

  function saveSettings(showToast = true) {
    const data = collectSettings();
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
      if (showToast) setStatus(settingsStatus$, "تنظیمات ذخیره شد", "success");
    } catch {
      if (showToast) setStatus(settingsStatus$, "خطا در ذخیره تنظیمات", "error");
    }
  }

  function applyStoredSettings(cfg) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch {}

    if (cfg?.ollama_url && !(stored && stored.ollamaUrl)) ollamaUrl$.value = cfg.ollama_url;
    if (cfg?.api_base_url && !(stored && stored.apiBaseUrl)) {
      apiBaseUrl$.value = cfg.api_base_url;
    }
    if (cfg?.default_model) ollamaUrl$.dataset.defaultModel = cfg.default_model;

    if (stored) {
      if (stored.ollamaUrl) ollamaUrl$.value = stored.ollamaUrl;
      if (stored.apiBaseUrl) apiBaseUrl$.value = stored.apiBaseUrl;
      if (stored.apiToken) apiToken$.value = stored.apiToken;
      if (stored.apiModel && apiModelInput$) apiModelInput$.value = stored.apiModel;
      if (typeof stored.temperature === "number") {
        temp$.value = stored.temperature;
        updateTempSlider();
      }
      if (typeof stored.useWeb === "boolean") {
        document.getElementById("useWeb").checked = stored.useWeb;
      }
      const active = stored.provider === "api" ? "api" : "ollama";
      providerInput$.value = active;
      showDraftPanel(active);
      if (stored.model) modelSelect$.dataset.preferred = stored.model;
    } else {
      providerInput$.value = "ollama";
      showDraftPanel("ollama");
    }
    updateActiveBadge();
  }

  async function loadModels() {
    refreshBtn$.disabled = true;
    refreshBtn$.style.opacity = "0.5";
    modelLabel$.textContent = "بارگذاری...";
    const preferred = modelSelect$.dataset.preferred || ollamaUrl$.dataset.defaultModel || "";
    try {
      const data = await apiPost("/chat/models", {
        provider: "ollama",
        ollama_url: ollamaUrl$.value.trim(),
      });
      const items = data.model_items || (data.models || []).map(m => ({ id: m, label: m }));
      renderModelDropdown(items, preferred);
    } catch {
      const fallback = preferred || "qwen2.5:14b";
      renderModelDropdown([{ id: fallback, label: fallback }], fallback);
    } finally {
      refreshBtn$.disabled = false;
      refreshBtn$.style.opacity = "1";
    }
  }

  async function loadApiModels() {
    if (!apiBaseUrl$.value.trim()) {
      setStatus(settingsStatus$, "ابتدا آدرس API را وارد کنید.", "warn");
      return;
    }
    refreshApiBtn$.disabled = true;
    refreshApiBtn$.style.opacity = "0.5";
    try {
      const data = await apiPost("/chat/models", {
        provider: "api",
        api_base_url: apiBaseUrl$.value.trim(),
        api_token: apiToken$.value.trim(),
      });
      const items = data.model_items || [];
      if (!items.length) {
        setStatus(settingsStatus$, "لیستی از API برنگشت؛ شناسه مدل را دستی وارد کنید.", "warn");
        renderApiModelDropdown([]);
      } else {
        renderApiModelDropdown(items, apiModelInput$.value.trim());
        setStatus(settingsStatus$, `${items.length} مدل از API دریافت شد`, "success");
      }
    } catch {
      renderApiModelDropdown([]);
      setStatus(settingsStatus$, "بارگذاری مدل‌ها ناموفق بود؛ شناسه را دستی وارد کنید.", "warn");
    } finally {
      refreshApiBtn$.disabled = false;
      refreshApiBtn$.style.opacity = "1";
    }
  }

  async function initFromConfig() {
    let cfg = null;
    try { cfg = await apiGet("/config"); } catch {}
    applyStoredSettings(cfg);
    await loadModels();
  }

  refreshBtn$.addEventListener("click", loadModels);
  refreshApiBtn$.addEventListener("click", loadApiModels);
  ollamaUrl$.addEventListener("change", loadModels);
  settingsSaveBtn$.addEventListener("click", () => {
    // Saving also activates the currently viewed (draft) provider after validation
    if (!activateProvider(providerDraft$.value, { persist: false, toast: false })) return;
    saveSettings(true);
  });

  ["change", "input"].forEach(evt => {
    temp$.addEventListener(evt, () => saveSettings(false));
    document.getElementById("useWeb").addEventListener(evt, () => saveSettings(false));
  });

  initFromConfig();

})();
