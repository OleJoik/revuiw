// --- OpenCode panel logic ---

const ocPanel = document.getElementById("opencode-panel");
const ocToggle = document.getElementById("opencode-toggle");
const ocSessionList = document.getElementById("opencode-session-list");
const ocNewSession = document.getElementById("opencode-new-session");
const ocMessages = document.getElementById("opencode-messages");
const ocInput = document.getElementById("opencode-input");
const ocSend = document.getElementById("opencode-send");

let ocSessions = [];
let ocCurrentSession = null;
let ocLoading = false;

// Toggle panel collapse
ocToggle.addEventListener("click", () => {
  ocPanel.classList.toggle("collapsed");
});

// Load sessions from server
async function ocLoadSessions() {
  try {
    const res = await fetch("/api/opencode/sessions");
    if (!res.ok) throw new Error("Failed to load sessions");
    ocSessions = await res.json();
    ocRenderSessions();
  } catch (err) {
    ocSessionList.innerHTML = `<div class="opencode-msg error">${err.message}</div>`;
  }
}

// Render session list
function ocRenderSessions() {
  ocSessionList.innerHTML = "";
  if (!ocSessions || ocSessions.length === 0) {
    ocSessionList.innerHTML = '<div style="padding:8px;color:var(--fg-muted);font-size:11px">No sessions yet</div>';
    return;
  }

  // Sort by most recent first
  const sorted = [...ocSessions].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });

  for (const session of sorted.slice(0, 20)) {
    const item = document.createElement("div");
    item.className = "opencode-session-item";
    if (ocCurrentSession && ocCurrentSession.id === session.id) {
      item.classList.add("active");
    }
    item.textContent = session.title || `Session ${session.id.slice(0, 8)}`;
    item.title = session.id;
    item.addEventListener("click", () => ocSelectSession(session));
    ocSessionList.appendChild(item);
  }
}

// Select a session and load its messages
async function ocSelectSession(session) {
  ocCurrentSession = session;
  ocRenderSessions();
  ocMessages.innerHTML = '<div class="opencode-msg status">Loading messages...</div>';

  try {
    const res = await fetch(`/api/opencode/sessions/${session.id}/messages`);
    if (!res.ok) throw new Error("Failed to load messages");
    const messages = await res.json();
    ocRenderMessages(messages);
  } catch (err) {
    ocMessages.innerHTML = `<div class="opencode-msg error">${err.message}</div>`;
  }
}

// Render messages in chat area
function ocRenderMessages(messages) {
  ocMessages.innerHTML = "";

  if (!messages || messages.length === 0) {
    ocMessages.innerHTML = '<div class="opencode-msg status">No messages in this session</div>';
    return;
  }

  for (const msg of messages) {
    const role = msg.info?.role || "unknown";
    const parts = msg.parts || [];

    // Extract text content from parts
    let text = "";
    for (const part of parts) {
      if (part.type === "text") {
        text += part.text || "";
      } else if (part.type === "tool-invocation") {
        text += `[tool: ${part.toolName || "unknown"}]\n`;
      }
    }

    if (!text.trim()) continue;

    const el = document.createElement("div");
    el.className = `opencode-msg ${role === "user" ? "user" : "assistant"}`;
    el.textContent = text.trim();
    ocMessages.appendChild(el);
  }

  ocMessages.scrollTop = ocMessages.scrollHeight;
}

// Create a new session
ocNewSession.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/opencode/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "revuiw session" }),
    });
    if (!res.ok) throw new Error("Failed to create session");
    const session = await res.json();
    ocSessions.unshift(session);
    ocSelectSession(session);
  } catch (err) {
    ocMessages.innerHTML = `<div class="opencode-msg error">${err.message}</div>`;
  }
});

// Send a prompt
async function ocSendPrompt() {
  const text = ocInput.value.trim();
  if (!text || ocLoading) return;

  if (!ocCurrentSession) {
    // Auto-create a session if none selected
    try {
      const res = await fetch("/api/opencode/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: text.slice(0, 50) }),
      });
      if (!res.ok) throw new Error("Failed to create session");
      ocCurrentSession = await res.json();
      ocSessions.unshift(ocCurrentSession);
      ocRenderSessions();
    } catch (err) {
      ocMessages.innerHTML = `<div class="opencode-msg error">${err.message}</div>`;
      return;
    }
  }

  // Show user message
  const userEl = document.createElement("div");
  userEl.className = "opencode-msg user";
  userEl.textContent = text;
  ocMessages.appendChild(userEl);
  ocMessages.scrollTop = ocMessages.scrollHeight;

  ocInput.value = "";
  ocLoading = true;
  ocSend.disabled = true;

  // Show loading indicator
  const loadingEl = document.createElement("div");
  loadingEl.className = "opencode-msg status";
  loadingEl.textContent = "Thinking...";
  ocMessages.appendChild(loadingEl);
  ocMessages.scrollTop = ocMessages.scrollHeight;

  try {
    const res = await fetch(`/api/opencode/sessions/${ocCurrentSession.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error("Failed to get response");
    const data = await res.json();

    // Remove loading indicator
    loadingEl.remove();

    // Extract assistant response text
    let responseText = "";
    const parts = data.parts || [];
    for (const part of parts) {
      if (part.type === "text") {
        responseText += part.text || "";
      }
    }

    if (responseText.trim()) {
      const assistantEl = document.createElement("div");
      assistantEl.className = "opencode-msg assistant";
      assistantEl.textContent = responseText.trim();
      ocMessages.appendChild(assistantEl);
    }
  } catch (err) {
    loadingEl.remove();
    const errEl = document.createElement("div");
    errEl.className = "opencode-msg error";
    errEl.textContent = err.message;
    ocMessages.appendChild(errEl);
  }

  ocLoading = false;
  ocSend.disabled = false;
  ocMessages.scrollTop = ocMessages.scrollHeight;
}

ocSend.addEventListener("click", ocSendPrompt);
ocInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ocSendPrompt();
  }
});

// Initial load
ocLoadSessions();
