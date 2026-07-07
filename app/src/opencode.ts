// Shared OpenCode client + types.
//
// Both the main chat panel and the ephemeral selection popovers talk to the
// OpenCode server through this module so that session handling, forking and
// prompt-building stay consistent across every surface.

export type Agent = "plan" | "build";

export interface Session {
  id: string;
  title?: string;
  parentID?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
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
}

const BASE = "/api/opencode";

async function json<T>(res: Response, fallback: T): Promise<T> {
  return res.ok ? (res.json() as Promise<T>) : fallback;
}

export async function listSessions(): Promise<Session[]> {
  return json(await fetch(`${BASE}/sessions`), [] as Session[]);
}

export async function createSession(title?: string): Promise<Session | null> {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || "revuiw session" }),
  });
  return json<Session | null>(res, null);
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
