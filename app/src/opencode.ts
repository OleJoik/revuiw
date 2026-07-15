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
export async function sendPrompt({ sessionId, message, agent, context }: SendPromptArgs): Promise<Message> {
  const res = await fetch(`${BASE}/sessions/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, agent, context: context || undefined }),
  });
  if (!res.ok) throw new Error(`Prompt failed (${res.status})`);
  const data = await res.json();
  return { info: { role: "assistant" }, parts: data.parts || [] };
}

// Human-readable label for a selection chip, e.g. "server.ts:10-24".
export function selectionLabel(ctx: SelectionContext): string {
  const name = ctx.path.split("/").pop() || ctx.path;
  return ctx.startLine === ctx.endLine
    ? `${name}:${ctx.startLine}`
    : `${name}:${ctx.startLine}-${ctx.endLine}`;
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

export async function setProviderCredentials(providerId: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/${providerId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}
