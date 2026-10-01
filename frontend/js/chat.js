/**
 * chat.js — Plain chatbot module
 * Endpoint: POST /api/chat/stream  (SSE)
 * Supports: attachments (image/PDF/docx/code), stop button, abort on page unload
 */

(function () {
  let sessionId   = newSessionId("chat");
  let isStreaming  = false;
  let abortCtrl    = null;

  const window$ = document.getElementById("chatWindow");
  const input$  = document.getElementById("chatInput");
  const send$   = document.getElementById("chatSend");
  const clear$  = document.getElementById("clearChat");
  const attachBtn$ = document.getElementById("chatAttachBtn");
  const attachInput$ = document.getElementById("chatAttachInput");
  const attachPreview$ = document.getElementById("chatAttachPreview");

  const attachments = createAttachController({
    input$: attachInput$,
    preview$: attachPreview$,
    dropZone$: document.getElementById("chatComposer"),
  });

  attachBtn$?.addEventListener("click", () => attachInput$?.click());

  const stopBtn$ = document.createElement("button");
  stopBtn$.className = "btn-stop";
  stopBtn$.textContent = "توقف";
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

  window.addEventListener("beforeunload", () => { if (abortCtrl) abortCtrl.abort(); });

  function appendMessage(role, text = "") {
    const wrap   = document.createElement("div");
    wrap.className = `chat-message ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    if (role === "user") {
      bubble.textContent = text;
    } else {
      bubble.innerHTML = text ? renderMarkdown(text) : "";
    }
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = role === "user" ? "شما" : "چت بات";
    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    window$.appendChild(wrap);
    window$.scrollTop = window$.scrollHeight;
    return { wrap, bubble };
  }

  function sendMessage() {
    const text = input$.value.trim();
    const files = attachments.getFiles();
    if ((!text && !files.length) || isStreaming) return;

    appendUserBubble(window$, text, files);
    input$.value = "";
    input$.style.height = "auto";
    attachments.clear();

    const settings = getSettings();
    const { wrap, bubble } = appendMessage("assistant", "");
    bubble.classList.add("typing-cursor");

    isStreaming = true;
    send$.disabled = true;
    stopBtn$.style.display = "inline-flex";

    abortCtrl = new AbortController();
    let statusBubble = null;
    let rawText = "";

    const fields = {
      message: text,
      session_id: sessionId,
      ...llmRequestFields(settings),
    };

    let fetchOpts;
    if (files.length) {
      fetchOpts = {
        method: "POST",
        body: buildChatFormData(fields, files),
        signal: abortCtrl.signal,
      };
    } else {
      fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
        signal: abortCtrl.signal,
      };
    }

    fetch(`${API_BASE}/chat/stream`, fetchOpts)
    .then(res => {
      if (!res.ok) return res.json().then(e => {
        const detail = e.detail;
        const msg = typeof detail === "string" ? detail
          : Array.isArray(detail) ? detail.map(d => d.msg || d).join(" ")
          : (res.statusText || "خطا");
        throw new Error(msg);
      });
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
              if (p.error)       { bubble.innerHTML = `<span style="color:var(--danger)">⚠️ ${escHtml(p.error)}</span>`; finalize(); return; }
              if (p.status === "searching")  { statusBubble = createStatusBubble(window$, p.msg); }
              if (p.status === "search_done"){ updateStatusBubble(statusBubble, p.msg, true); statusBubble = null; }
              if (p.token)       { rawText += p.token; bubble.innerHTML = renderMarkdown(rawText); window$.scrollTop = window$.scrollHeight; }
              if (p.web_sources) { appendWebSources(wrap, p.web_sources); }
              if (p.done)        { finalize(); return; }
            } catch {}
          }
          read();
        }).catch(err => {
          if (err.name !== "AbortError") {
            bubble.innerHTML = `<span style="color:var(--danger)">⚠️ ${escHtml(err.message)}</span>`;
          }
          finalize();
        });
      }
      read();
    })
    .catch(err => {
      if (err.name !== "AbortError") {
        bubble.innerHTML = `<span style="color:var(--danger)">⚠️ ${escHtml(err.message)}</span>`;
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
    attachments.clear();
    sessionId = newSessionId("chat");
    try { await apiPost(`/chat/clear?session_id=${sessionId}`); } catch {}
  });
})();
