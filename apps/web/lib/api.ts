export type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_in_seconds: number;
  token_type: string;
};

const base = process.env.NEXT_PUBLIC_CONTROL_API_BASE ?? "http://127.0.0.1:9000";

export function apiBase(): string {
  return base;
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const resp = await fetch(`${base}${path}`, {
    ...options,
    headers,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Request failed with ${resp.status}`);
  }

  if (resp.status === 204) {
    return {} as T;
  }
  return (await resp.json()) as T;
}

type WsUrlOptions = {
  tenantId?: string;
  replay?: number;
  afterEventId?: number;
};

export const WS_URL = base.replace(/^http/, "ws");

export function wsUrl(token: string, options: WsUrlOptions = {}): string {
  const protocol = base.startsWith("https") ? "wss" : "ws";
  const stripped = base.replace(/^https?:\/\//, "");
  const params = new URLSearchParams({ token });
  if (options.tenantId) {
    params.set("tenant_id", options.tenantId);
  }
  if (typeof options.replay === "number") {
    params.set("replay", String(options.replay));
  }
  if (typeof options.afterEventId === "number") {
    params.set("after_event_id", String(options.afterEventId));
  }
  return `${protocol}://${stripped}/v1/events/ws?${params.toString()}`;
}
