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

export function wsUrl(token: string): string {
  const protocol = base.startsWith("https") ? "wss" : "ws";
  const stripped = base.replace(/^https?:\/\//, "");
  return `${protocol}://${stripped}/v1/events/ws?token=${encodeURIComponent(token)}`;
}
