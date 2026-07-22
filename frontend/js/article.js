/**
 * article.js — Web article chat module
 * Stop button for streaming chat. Abort on page unload.
 */

(function () {
  let sessionId   = null;
  let isStreaming  = false;
  let chatAbort    = null;

  const chatWindow$ = document.getElementById("articleChatWindow");
  const input$      = document.getElementById("articleInput");
  const send$       = document.getElementById("articleSend");
  const clear$      = document.getElementById("clearArticle");
  const urlInput$   = document.getElementById("articleUrl");
  const fetchBtn$   = document.getElementById("articleFetch");
  const status$     = document.getElementById("articleStatus");
  const preview$    = document.getElementById("articlePreview");

  // ── Stop button ──────────────────────────────────────────────────
  const stopBtn$ = document.createElement("button");
  stopBtn$.className = "btn-stop";
  stopBtn$.textContent = "⏹ توقف";
  stopBtn$.style.display = "none";
  send$.parentNode.insertBefore(stopBtn$, send$.nextSibling);

  stopBtn$.addEventListener("click", stopStreaming);

  function stopStreaming() {
    if (chatAbort) { chatAbort.abort(); chatAbort = null; }
    isStreaming = false;
    send$.disabled = false;
    stopBtn$.style.display = "none";
  }

  window.addEventListener("beforeunload", () => { if (chatAbort) chatAbort.abort(); });

  // ── Fetch article ────────────────────────────────────────────────

  fetchBtn$.addEventListener("click", fetchArticle);
  urlInput$.addEventListener("keydown", e => { if (e.key === "Enter") fetchArticle(); });

  async function fetchArticle() {
    const url = urlInput$.value.trim();
    if (!url) { setStatus(status$, "لطفاً یک آدرس URL وارد کنید.", "warn"); return; }

    setStatus(status$, "⏳ در حال بارگذاری محتوا...", "info");
    fetchBtn$.disabled = true;

    if (sessionId) {
      try { await apiDelete(`/article/session/${sessionId}`); } catch {}
    }
    chatWindow$.innerHTML = "";
    sessionId = null;

    try {
      const data = await apiPost("/article/fetch", { url });
      sessionId = data.session_id;
      setStatus(status$, `✅ بارگذاری شد: «${escHtml(data.title || url)}» — ${data.length.toLocaleString("fa-IR")} کاراکتر`, "ok");
      preview$.textContent = data.preview + (data.length > 500 ? "\n\n[...]" : "");
      preview$.hidden = false;
      appendSystemMsg(`📄 مقاله بارگذاری شد: ${data.title || url}`);
      input$.focus();
    } catch (e) {
      setStatus(status$, `❌ خطا: ${e.message}`, "error");
    } finally {
      fetchBtn$.disabled = false;
    }
  }

  // ── Chat helpers ─────────────────────────────────────────────────

  function appendSystemMsg(text) {
    const div = document.createElement("div");
    div.style.cssText = "text-align:center;font-size:12px;color:var(--text-muted);padding:6px 0;";
    div.textContent = text;
    chatWindow$.appendChild(div);
    chatWindow$.scrollTop = chatWindow$.scrollHeight;
  }

  function appendMessage(role, text = "") {
    const wrap   = document.createElement("div"); wrap.className = `chat-message ${role}`;
    const bubble = document.createElement("div"); bubble.className = "chat-bubble"; bubble.textContent = text;
    const meta   = document.createElement("div"); meta.className  = "chat-meta";
    meta.textContent = role === "user" ? "شما" : "چت بات (مقاله)";
    wrap.appendChild(bubble); wrap.appendChild(meta);
    chatWindow$.appendChild(wrap);
    chatWindow$.scrollTop = chatWindow$.scrollHeight;
    return bubble;
  }

  // ── Send ─────────────────────────────────────────────────────────

  function sendMessage() {
    const text = input$.value.trim();
    if (!text || isStreaming) return;

    if (!sessionId) { setStatus(status$, "ابتدا یک لینک مقاله بارگذاری کنید.", "warn"); return; }

    appendMessage("user", text);
    input$.value = "";
    input$.style.height = "auto";

    const { ollamaUrl, model, temperature, useWeb } = getSettings();
    const bubble = appendMessage("assistant", "");
    bubble.classList.add("typing-cursor");
    isStreaming = true;
    send$.disabled = true;
    stopBtn$.style.display = "inline-flex";

    chatAbort = new AbortController();

    fetch(`${API_BASE}/article/chat/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text, session_id: sessionId,
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
              if (p.error) { bubble.textContent = `⚠️ ${p.error}`; bubble.style.color = "var(--danger)"; finalize(); return; }
              if (p.token) { bubble.textContent += p.token; chatWindow$.scrollTop = chatWindow$.scrollHeight; }
              if (p.done)  { finalize(); return; }
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
      if (err.name !== "AbortError") { bubble.textContent = `⚠️ ${err.message}`; bubble.style.color = "var(--danger)"; }
      finalize();
    });

    function finalize() {
      bubble.classList.remove("typing-cursor");
      isStreaming = false;
      send$.disabled = false;
      stopBtn$.style.display = "none";
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
    stopStreaming();
    if (sessionId) { try { await apiDelete(`/article/session/${sessionId}`); } catch {} sessionId = null; }
    chatWindow$.innerHTML = "";
    preview$.hidden = true;
    preview$.textContent = "";
    urlInput$.value = "";
    clearStatus(status$);
  });
})();
