// Calls to Edith's API. Errors carry the server's message, which is written for people to read.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const OFFLINE = "Edith can't be reached right now. Check your connection and try again.";

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(OFFLINE, 0);
  }
  return res;
}

async function json(method, path, body) {
  const res = await request(method, path, body);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? OFFLINE, res.status);
  return data;
}

// Streams NDJSON step events to onEvent and resolves with the last one.
async function stream(path, body, onEvent) {
  const res = await request("POST", path, body);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? OFFLINE, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new ApiError("The connection to Edith dropped. Check Activity to see where this request stands.", 0);
    }
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = chunk.done ? "" : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      last = JSON.parse(line);
      onEvent(last);
    }
    if (chunk.done) return last;
  }
}

export const api = {
  config: () => json("GET", "/api/config"),
  session: () => json("GET", "/api/session"),
  challenge: (address) => json("POST", "/api/session/challenge", { address }),
  signIn: (message, signature) => json("POST", "/api/session", { message, signature }),
  signOut: () => json("POST", "/api/session/end", {}),
  me: () => json("GET", "/api/me"),
  balance: () => json("GET", "/api/balance"),
  setLimits: (limits) => json("PUT", "/api/limits", limits),
  memory: (url) => json("GET", `/api/memory?url=${encodeURIComponent(url)}`),
  ask: (url, onEvent) => stream("/api/requests", { url }, onEvent),
  pay: (id, signed, onEvent) => stream(`/api/requests/${id}/pay`, signed, onEvent),
  cancel: (id) => json("POST", `/api/requests/${id}/cancel`, {}),
  recheck: (id) => json("POST", `/api/requests/${id}/recheck`, {}),
  requote: (id) => json("POST", `/api/requests/${id}/requote`, {}),
  createAgent: (name) => json("POST", "/api/agents", { name }),
  revokeAgent: (id) => json("POST", `/api/agents/${id}/revoke`, {}),
};
