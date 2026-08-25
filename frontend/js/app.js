/**
 * app.js — global navigation, settings wiring, model loader
 */

(function () {

  // ── Section navigation ───────────────────────────────────────────
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
      // close sidebar on mobile
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
    // drive CSS custom property for the track fill
    temp$.style.setProperty("--pct", (val * 100) + "%");
  }

  temp$.addEventListener("input", updateTempSlider);
  updateTempSlider(); // init on load

  // ── Load Ollama models ──────────────────────────────────────────
  const refreshBtn$  = document.getElementById("refreshModels");
  const ollamaUrl$   = document.getElementById("ollamaUrl");
  const modelSelect$ = document.getElementById("modelSelect"); // hidden native

  // Custom dropdown elements
  const modelBtn$   = document.getElementById("modelSelectBtn");
  const modelLabel$ = document.getElementById("modelSelectLabel");
  const modelList$  = document.getElementById("modelSelectList");

  // ── Model dropdown logic ─────────────────────────────────────────

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
  function selectModel(value) {
    modelSelect$.value = value;
    modelLabel$.textContent = value || "انتخاب مدل";
    modelList$.querySelectorAll("li").forEach(li =>
      li.classList.toggle("selected", li.dataset.value === value)
    );
    closeModelDropdown();
  }

  function renderModelDropdown(models, defaultModel) {
    modelList$.innerHTML = "";
    modelSelect$.innerHTML = "";

    if (!models.length) {
      const empty = document.createElement("li");
      empty.className = "custom-select-empty";
      empty.textContent = "مدلی پیدا نشد";
      modelList$.appendChild(empty);
      modelLabel$.textContent = "مدلی پیدا نشد";
      return;
    }

    let selected = defaultModel || "";
    // auto-select logic: prefer defaultModel, else first model starting with qwen, else first
    if (!selected) selected = models.find(m => m.startsWith("qwen")) || models[0];

    models.forEach(m => {
      // native select
      const opt = document.createElement("option");
      opt.value = opt.textContent = m;
      if (m === selected) opt.selected = true;
      modelSelect$.appendChild(opt);

      // custom dropdown item
      const li = document.createElement("li");
      li.dataset.value = m;
      li.innerHTML = `
        <span class="col-icon">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="2" y="2" width="12" height="12" rx="2"/>
            <path d="M5 6h6M5 10h4"/>
          </svg>
        </span>
        <span>${escHtml(m)}</span>`;
      if (m === selected) li.classList.add("selected");
      li.addEventListener("click", () => selectModel(m));
      modelList$.appendChild(li);
    });

    modelLabel$.textContent = selected;
    modelSelect$.value = selected;
  }

  modelBtn$.addEventListener("click", (e) => { e.stopPropagation(); toggleModelDropdown(); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#modelSelectWrap")) closeModelDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModelDropdown();
  });

  // Fetch default model/url from backend .env config, then load models
  async function initFromConfig() {
    try {
      const cfg = await apiGet("/config");
      if (cfg.ollama_url)    ollamaUrl$.value = cfg.ollama_url;
      if (cfg.default_model) ollamaUrl$.dataset.defaultModel = cfg.default_model;
    } catch {
      // fallback: keep existing HTML default values
    }
    loadModels();
  }

  async function loadModels() {
    refreshBtn$.disabled = true;
    refreshBtn$.style.opacity = "0.5";
    modelLabel$.textContent = "بارگذاری...";
    const defaultModel = ollamaUrl$.dataset.defaultModel || "";
    try {
      const data = await apiPost("/chat/models", { ollama_url: ollamaUrl$.value.trim() });
      renderModelDropdown(data.models || [], defaultModel);
    } catch {
      const fallback = defaultModel || "qwen2.5:14b";
      renderModelDropdown([fallback], fallback);
    } finally {
      refreshBtn$.disabled = false;
      refreshBtn$.style.opacity = "1";
    }
  }

  refreshBtn$.addEventListener("click", loadModels);
  ollamaUrl$.addEventListener("change", loadModels);

  // Auto-load models on startup — read config from backend first
  initFromConfig();

})();
