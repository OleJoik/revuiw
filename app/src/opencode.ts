// Shared OpenCode client + types.
//
// The main chat panel talks to the OpenCode server through this module.
// Notes now handle their own persistence separately via the notes API.

export type Agent = "plan" | "build";

export interface Session {
  id: string;
  title?: string;
  parentID?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
}

export interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; title?: string };
}

export interface Message {
  info?: { role?: string };
  parts?: MessagePart[];
}

// A chunk visually selected in the Viewer, used as context for a prompt.
export interface SelectionContext {
  path: string;
  startLine: number; // 1-indexed for display
  endLine: number;
  text: string;
  lang?: string;
  note?: string; // optional human comment (when picked from a note)
}

const BASE = "/api/opencode";

async function json<T>(res: Response, fallback: T): Promise<T> {
  return res.ok ? (res.json() as Promise<T>) : fallback;
}

export async function listSessions(): Promise<Session[]> {
  return json(await fetch(`${BASE}/sessions`), [] as Session[]);
}

export interface OpenCodeConfig {
  model?: string;
  default_agent?: string;
  agent?: Record<string, { model?: string }>;
  mode?: Record<string, { model?: string }>;
}

export async function getConfig(): Promise<OpenCodeConfig> {
  return json(await fetch(`${BASE}/config`), {});
}

// Resolve the effective default model string from config
export function resolveDefaultModel(cfg: OpenCodeConfig): string | null {
  if (cfg.model) return cfg.model;
  const agents = cfg.agent;
  if (agents) {
    const defaultAgent = cfg.default_agent || "plan";
    if (agents[defaultAgent]?.model) return agents[defaultAgent].model!;
    // fallback: first agent with a model
    for (const a of Object.values(agents)) {
      if (a.model) return a.model;
    }
  }
  return cfg.mode?.plan?.model || null;
}

export async function getConfig(): Promise<OpenCodeConfig> {
  return json(await fetch(`${BASE}/config`), {});
}

// Returns { providers: [...], default: { "agent-name": "provider/model", ... } }
export async function getConfigProviders(): Promise<{ providers: unknown[]; default: Record<string, string> }> {
  return json(await fetch(`${BASE}/config/providers`), { providers: [], default: {} });
}

// Resolve the effective default model string from config
export function resolveDefaultModel(cfg: OpenCodeConfig): string | null {
  return cfg.model
    || cfg.agent?.plan?.model
    || cfg.agent?.build?.model
    || cfg.mode?.plan?.model
    || cfg.mode?.build?.model
    || null;
}

export interface AgentInfo {
  id: string;
  model?: { id: string; providerID: string; variant?: string };
}

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${BASE}/agents`);
  if (!res.ok) return [];
  const body = await res.json();
  const arr = Array.isArray(body) ? body : (body.data ?? []);
  return arr;
}

export async function createSession(title?: string): Promise<Session | null> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || "revuiw session" }),
  });
  return json<Session | null>(res, null);
}

export async function deleteSession(id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/sessions/${id}`, { method: "DELETE" });
  return res.ok;
}

export interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
}

export async function listModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE}/models`);
  if (!res.ok) return [];
  const body = await res.json();
  // Response is { data: [...] } or a plain array depending on passthrough
  const arr = Array.isArray(body) ? body : (body.data ?? []);
  return arr.map((m: any) => ({ id: m.id, providerID: m.providerID, name: m.name || m.id }));
}

export async function switchModel(sessionId: string, model: { id: string; providerID: string }): Promise<boolean> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/model`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return res.ok;
}

// Fork an existing session so a tangent inherits the full conversation context
// while keeping its own history. Optionally fork from a specific message.
export async function forkSession(id: string, messageID?: string): Promise<Session | null> {
  const res = await fetch(`${BASE}/sessions/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  return json<Session | null>(res, null);
}

export async function getMessages(id: string): Promise<Message[]> {
  return json(await fetch(`${BASE}/sessions/${id}/messages`), [] as Message[]);
}

export interface SendPromptArgs {
  sessionId: string;
  message: string;
  agent?: Agent;
  context?: SelectionContext | null;
}

// Send a prompt. `agent` selects plan (read-only discussion) vs build (can edit).
// `context` attaches the current visual selection as a labelled code block.
// Returns a streaming interface that yields text deltas.
export interface StreamCallbacks {
  onDelta?: (delta: string) => void;
  onPart?: (part: any) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

export async function sendPromptStreaming(
  { sessionId, message, agent, context }: SendPromptArgs,
  callbacks: StreamCallbacks,
): Promise<void> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, agent, context: context || undefined }),
  });
  if (!res.ok) throw new Error(`Prompt failed (${res.status})`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6);
      try {
        const event = JSON.parse(json);
        if (event.type === "text.delta") {
          callbacks.onDelta?.(event.delta);
        } else if (event.type === "part.updated") {
          callbacks.onPart?.(event.part);
        } else if (event.type === "done") {
          callbacks.onDone?.();
          return;
        } else if (event.type === "error") {
          callbacks.onError?.(event.error ?? "Unknown error");
          return;
        }
      } catch {}
    }
  }
  callbacks.onDone?.();
}

// Legacy non-streaming sendPrompt (kept for compatibility but uses streaming internally)
export async function sendPrompt({ sessionId, message, agent, context }: SendPromptArgs): Promise<Message> {
  let text = "";
  await sendPromptStreaming({ sessionId, message, agent, context }, {
    onDelta: (delta) => { text += delta; },
    onError: (err) => { throw new Error(err); },
  });
  return { info: { role: "assistant" }, parts: [{ type: "text", text }] };
}

// Human-readable label for a selection chip, e.g. "server.ts:10-24".
export function selectionLabel(ctx: SelectionContext): string {
  return ctx.startLine === ctx.endLine
    ? `${ctx.path}:${ctx.startLine}`
    : `${ctx.path}:${ctx.startLine}-${ctx.endLine}`;
}

// --- Provider management ---

export interface ProviderInfo {
  id: string;
  name: string;
  env?: string[];
  models?: Record<string, { id: string; name?: string }>;
}

export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: Array<{ type: string; key: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string }>; when?: unknown }>;
}

export interface ProvidersData {
  all: ProviderInfo[];
  connected: string[];
  default?: Record<string, string>;
}

export async function listProviders(): Promise<ProvidersData> {
  return json(await fetch(`${BASE}/providers`), { all: [], connected: [] });
}

export async function getProviderAuthMethods(): Promise<Record<string, ProviderAuthMethod[]>> {
  return json(await fetch(`${BASE}/providers/auth`), {});
}

export async function startOAuth(providerId: string, body: Record<string, unknown> = {}): Promise<{ url?: string; method?: string; instructions?: string }> {
  const res = await fetch(`${BASE}/providers/${providerId}/oauth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return json(res, {});
}

// Long-polls until the OAuth device code flow completes on the provider side.
export async function waitOAuthCallback(providerId: string, method: number): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/providers/${providerId}/oauth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method }),
    });
    return res.ok;
  } catch { return false; }
}

export async function setProviderCredentials(providerId: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/${providerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
