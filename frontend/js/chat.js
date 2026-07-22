/**
 * chat.js — Plain chatbot module
 * Endpoint: POST /api/chat/stream  (SSE)
 * Supports: stop button, abort on page unload
 */

(function () {
  let sessionId   = newSessionId("chat");
  let isStreaming  = false;
  let abortCtrl    = null;   // AbortController for current request

  const window$ = document.getElementById("chatWindow");
  const input$  = document.getElementById("chatInput");
  const send$   = document.getElementById("chatSend");
  const clear$  = document.getElementById("clearChat");

  // ── Inject stop button next to send ─────────────────────────────
  const stopBtn$ = document.createElement("button");
  stopBtn$.className = "btn-stop";
  stopBtn$.textContent = "⏹ توقف";
  stopBtn$.style.display = "none";
  send$.parentNode.insertBefore(stopBtn$, send$.nextSibling);

  stopBtn$.addEventListener("click", stopStreaming);

  function stopStreaming() {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    isStreaming = false;
    send$.disabled = false;
    stopBtn$.style.display = "none";
  }

  // Stop on page unload / refresh
  window.addEventListener("beforeunload", () => { if (abortCtrl) abortCtrl.abort(); });

  // ── Render helpers ───────────────────────────────────────────────

  function appendMessage(role, text = "") {
    const wrap   = document.createElement("div");
    wrap.className = `chat-message ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = role === "user" ? "شما" : "چت بات";
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    window$.appendChild(wrap);
    window$.scrollTop = window$.scrollHeight;
    return { wrap, bubble };
  }

  // ── Send logic ───────────────────────────────────────────────────

  function sendMessage() {
    const text = input$.value.trim();
    if (!text || isStreaming) return;

    appendMessage("user", text);
    input$.value = "";
    input$.style.height = "auto";

    const { ollamaUrl, model, temperature, useWeb } = getSettings();
    const { wrap, bubble } = appendMessage("assistant", "");
    bubble.classList.add("typing-cursor");

    isStreaming = true;
    send$.disabled = true;
    stopBtn$.style.display = "inline-flex";

    abortCtrl = new AbortController();
    let statusBubble = null;

    fetch(`${API_BASE}/chat/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        message: text, session_id: sessionId,
        model, ollama_url: ollamaUrl, temperature, use_web: useWeb,
      }),
      signal: abortCtrl.signal,
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
              if (p.error)       { bubble.textContent = `⚠️ ${p.error}`; bubble.style.color = "var(--danger)"; finalize(); return; }
              if (p.status === "searching")  { statusBubble = createStatusBubble(window$, p.msg); }
              if (p.status === "search_done"){ updateStatusBubble(statusBubble, p.msg, true); statusBubble = null; }
              if (p.token)       { bubble.textContent += p.token; window$.scrollTop = window$.scrollHeight; }
              if (p.web_sources) { appendWebSources(wrap, p.web_sources); }
              if (p.done)        { finalize(); return; }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError") {
            bubble.textContent = `⚠️ ${err.message}`;
            bubble.style.color = "var(--danger)";
          }
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
      isStreaming = false;
      send$.disabled = false;
      stopBtn$.style.display = "none";
      abortCtrl = null;
      input$.focus();
    }
  }

  // ── Events ───────────────────────────────────────────────────────

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
    window$.innerHTML = "";
    sessionId = newSessionId("chat");
    try { await apiPost(`/chat/clear?session_id=${sessionId}`); } catch {}
  });
})();
