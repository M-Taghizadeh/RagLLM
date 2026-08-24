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
  temp$.addEventListener("input", () => { tempVal$.textContent = parseFloat(temp$.value).toFixed(2); });

  // ── Load Ollama models ──────────────────────────────────────────
  const refreshBtn$  = document.getElementById("refreshModels");
  const ollamaUrl$   = document.getElementById("ollamaUrl");
  const modelSelect$ = document.getElementById("modelSelect");

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
    const defaultModel = ollamaUrl$.dataset.defaultModel || "";
    try {
      const data = await apiPost("/chat/models", { ollama_url: ollamaUrl$.value.trim() });
      const models = data.models || [];
      modelSelect$.innerHTML = "";
      if (!models.length) {
        modelSelect$.innerHTML = `<option value="">مدلی پیدا نشد</option>`;
      } else {
        models.forEach(m => {
          const opt = document.createElement("option");
          opt.value = opt.textContent = m;
          // select the .env default model if present, otherwise first model
          if (defaultModel ? m === defaultModel : m.startsWith("qwen")) opt.selected = true;
          modelSelect$.appendChild(opt);
        });
      }
    } catch {
      const fallback = defaultModel || "qwen2.5:14b";
      modelSelect$.innerHTML = `<option value="${fallback}">${fallback} (پیش‌فرض)</option>`;
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
