"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { api, apiBase, Tokens, wsUrl } from "@/lib/api";

type AuthResponse = {
  user: { id: number; email: string; created_at: string };
  tokens: Tokens;
};

type StatusResponse = {
  tenant_id: string;
  desired_state: string;
  actual_state: string;
  last_heartbeat?: string | null;
  last_error?: string | null;
};

type ConfigResponse = {
  tenant_id: string;
  revision: number;
  env_json: Record<string, string>;
};

type Prompt = { name: string; revision: number; content: string };
type Skill = { skill_id: string; revision: number; content: string };

type EventItem = {
  type: string;
  created_at?: string;
  payload?: Record<string, unknown>;
};

const TOKEN_KEY = "nexus_saas_tokens";

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export default function Home() {
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("supersecure123");
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [configText, setConfigText] = useState("{}");
  const [configEnv, setConfigEnv] = useState<Record<string, string>>({});
  const [promptName, setPromptName] = useState("system");
  const [promptContent, setPromptContent] = useState("You are Nexus.");
  const [skillId, setSkillId] = useState("default");
  const [skillContent, setSkillContent] = useState("# Skill\nDescribe behavior.");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [openrouterKeyInput, setOpenrouterKeyInput] = useState("");
  const [requiresOpenRouterKey, setRequiresOpenRouterKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tenantBootstrapAttemptedToken = useRef<string | null>(null);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setTokens(null);
    setTenantId("");
    setStatus(null);
    setConfigText("{}");
    setConfigEnv({});
    setPrompts([]);
    setSkills([]);
    setEvents([]);
    setOpenrouterKeyInput("");
    setRequiresOpenRouterKey(false);
    setError("");
    tenantBootstrapAttemptedToken.current = null;
  }

  useEffect(() => {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) {
      return;
    }
    const parsed = safeJsonParse<Tokens | null>(raw, null);
    if (parsed) {
      setTokens(parsed);
    }
  }, []);

  useEffect(() => {
    if (!tokens) {
      return;
    }
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  }, [tokens]);

  useEffect(() => {
    if (!tokens || tenantId) {
      return;
    }
    if (tenantBootstrapAttemptedToken.current === tokens.access_token) {
      return;
    }
    tenantBootstrapAttemptedToken.current = tokens.access_token;
    void loadTenant(tokens.access_token);
    // Tenant bootstrap is intentionally scoped to tenant/token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, tokens]);

  useEffect(() => {
    if (!tokens || !tenantId) {
      return;
    }

    const socket = new WebSocket(wsUrl(tokens.access_token));
    socket.onmessage = (ev) => {
      const parsed = safeJsonParse<EventItem>(ev.data, { type: "runtime.log" });
      setEvents((prev) => [parsed, ...prev].slice(0, 80));
      if (parsed.type === "runtime.status" && tenantId) {
        void fetchStatus(tenantId, tokens.access_token);
      }
    };

    return () => {
      socket.close();
    };
    // Websocket lifecycle is intentionally scoped to tenant/token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, tokens]);

  async function handleAuth(path: "/v1/auth/signup" | "/v1/auth/login") {
    setBusy(true);
    setError("");
    try {
      const data = await api<AuthResponse>(path, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setTokens(data.tokens);
      // Automatically load or create tenant after login
      if (tenantBootstrapAttemptedToken.current !== data.tokens.access_token) {
        tenantBootstrapAttemptedToken.current = data.tokens.access_token;
        await loadTenant(data.tokens.access_token);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadTenant(token: string, openrouterApiKey?: string) {
    try {
      const setupPayload = openrouterApiKey
        ? { initial_config: { NEXUS_OPENROUTER_API_KEY: openrouterApiKey } }
        : {};
      const data = await api<{ id: string }>(
        "/v1/tenants/setup",
        { method: "POST", body: JSON.stringify(setupPayload) },
        token,
      );
      setRequiresOpenRouterKey(false);
      setTenantId(data.id);
      await fetchStatus(data.id, token);
      await loadConfig(data.id, token);
      await loadPrompts(data.id, token);
      await loadSkills(data.id, token);
    } catch (err) {
      const msg = (err as Error).message;
      try {
        const detail = JSON.parse(msg);
        if (detail?.detail?.tenant_id) {
          const existingId = detail.detail.tenant_id;
          setRequiresOpenRouterKey(false);
          setTenantId(existingId);
          await fetchStatus(existingId, token);
          await loadConfig(existingId, token);
          await loadPrompts(existingId, token);
          await loadSkills(existingId, token);
          return;
        }
        if (detail?.detail?.error === "openrouter_api_key_required") {
          setRequiresOpenRouterKey(true);
          setError("");
          return;
        }
      } catch {
        // not JSON, fall through
      }
      setError(msg);
    }
  }

  async function setupTenant() {
    if (!tokens) return;
    setBusy(true);
    setError("");
    await loadTenant(tokens.access_token);
    setBusy(false);
  }

  async function setupTenantWithKey() {
    if (!tokens) return;
    const trimmed = openrouterKeyInput.trim();
    if (!trimmed) {
      setError("OpenRouter API key is required.");
      return;
    }
    setBusy(true);
    setError("");
    await loadTenant(tokens.access_token, trimmed);
    setBusy(false);
  }

  async function fetchStatus(id: string, token: string = tokens?.access_token ?? "") {
    if (!id || !token) return;
    try {
      const data = await api<StatusResponse>(`/v1/tenants/${id}/status`, {}, token);
      setTenantId(data.tenant_id);
      setStatus(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function loadConfig(id: string, token: string = tokens?.access_token ?? "") {
    if (!id || !token) return;
    try {
      const data = await api<ConfigResponse>(`/v1/tenants/${id}/config`, {}, token);
      setConfigEnv(data.env_json);
      setConfigText(JSON.stringify(data.env_json, null, 2));
    } catch {
      setConfigEnv({});
      setConfigText("{}");
    }
  }

  async function loadPrompts(id: string, token: string = tokens?.access_token ?? "") {
    if (!id || !token) return;
    const data = await api<Prompt[]>(`/v1/tenants/${id}/prompts`, {}, token);
    setPrompts(data);
  }

  async function loadSkills(id: string, token: string = tokens?.access_token ?? "") {
    if (!id || !token) return;
    const data = await api<Skill[]>(`/v1/tenants/${id}/skills`, {}, token);
    setSkills(data);
  }

  async function runOperation(op: "start" | "stop" | "restart" | "pair/start" | "whatsapp/disconnect") {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    try {
      let mapped = `/v1/tenants/${tenantId}/runtime/${op}`;
      if (op === "pair/start") {
        mapped = `/v1/tenants/${tenantId}/whatsapp/pair/start`;
      }
      if (op === "whatsapp/disconnect") {
        mapped = `/v1/tenants/${tenantId}/whatsapp/disconnect`;
      }
      await api(mapped, { method: "POST" }, tokens.access_token);
      await fetchStatus(tenantId, tokens.access_token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    try {
      const values = safeJsonParse<Record<string, string>>(configText, {});
      await api(
        `/v1/tenants/${tenantId}/config`,
        {
          method: "PATCH",
          body: JSON.stringify({ values }),
        },
        tokens.access_token,
      );
      await loadConfig(tenantId, tokens.access_token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function savePrompt() {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/v1/tenants/${tenantId}/prompts/${encodeURIComponent(promptName)}`,
        {
          method: "PUT",
          body: JSON.stringify({ content: promptContent }),
        },
        tokens.access_token,
      );
      await loadPrompts(tenantId, tokens.access_token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSkill() {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/v1/tenants/${tenantId}/skills/${encodeURIComponent(skillId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ content: skillContent }),
        },
        tokens.access_token,
      );
      await loadSkills(tenantId, tokens.access_token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusClass = useMemo(() => {
    if (!status) return "badge";
    if (status.actual_state === "error") return "badge err";
    if (status.actual_state === "pending_pairing") return "badge warn";
    return "badge";
  }, [status]);

  const hasOpenRouterKey = useMemo(() => {
    const value = configEnv.NEXUS_OPENROUTER_API_KEY;
    return Boolean(value && String(value).trim());
  }, [configEnv]);

  return (
    <main className="container">
      <section className="card" style={{ marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "2rem" }}>Nexus SaaS Control</h1>
          <p style={{ marginTop: "0.35rem", color: "var(--muted)" }}>
            Control API: <span className="mono">{apiBase()}</span>
          </p>
        </div>
        {tokens && (
          <button className="secondary" onClick={logout} style={{ whiteSpace: "nowrap" }}>
            Log Out
          </button>
        )}
      </section>

      {!tokens ? (
        <section className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0 }}>Account Access</h2>
          <form
            className="grid"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void handleAuth("/v1/auth/login");
            }}
          >
            <div>
              <label>Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="row">
              <button className="primary" disabled={busy} type="submit">
                Log In
              </button>
              <button className="secondary" disabled={busy} type="button" onClick={() => void handleAuth("/v1/auth/signup")}>
                Sign Up
              </button>
            </div>
          </form>
        </section>
      ) : (
        <section className="grid cols-2">
          <article className="card">
            <h2 style={{ marginTop: 0 }}>Tenant</h2>
            <div className="row" style={{ marginBottom: "0.75rem", alignItems: "center" }}>
              {tenantId ? (
                <>
                  <span className="mono" style={{ flex: 1 }}>ID: {tenantId}</span>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (tokens && tenantId) {
                        void fetchStatus(tenantId, tokens.access_token);
                        void loadConfig(tenantId, tokens.access_token);
                        void loadPrompts(tenantId, tokens.access_token);
                        void loadSkills(tenantId, tokens.access_token);
                      }
                    }}
                    disabled={busy}
                  >
                    Refresh
                  </button>
                </>
              ) : requiresOpenRouterKey ? (
                <div style={{ width: "100%" }}>
                  <label>OpenRouter API Key (required)</label>
                  <input
                    type="password"
                    value={openrouterKeyInput}
                    onChange={(e) => setOpenrouterKeyInput(e.target.value)}
                    placeholder="sk-or-v1-..."
                  />
                  <div className="row" style={{ marginTop: "0.65rem" }}>
                    <button className="primary" onClick={setupTenantWithKey} disabled={busy || !openrouterKeyInput.trim()}>
                      Create Bot
                    </button>
                  </div>
                </div>
              ) : (
                <button className="primary" onClick={setupTenant} disabled={busy}>
                  Create Bot
                </button>
              )}
            </div>

            <p>
              Runtime: <span className={statusClass}>{status?.actual_state ?? "unknown"}</span>
            </p>
            <div className="row" style={{ marginBottom: "1rem" }}>
              <button className="secondary" disabled={busy || !tenantId || !hasOpenRouterKey} onClick={() => void runOperation("start")}>Start</button>
              <button className="secondary" disabled={busy || !tenantId} onClick={() => void runOperation("stop")}>Stop</button>
              <button className="secondary" disabled={busy || !tenantId || !hasOpenRouterKey} onClick={() => void runOperation("restart")}>Restart</button>
              <button className="primary" disabled={busy || !tenantId || !hasOpenRouterKey} onClick={() => void runOperation("pair/start")}>Pair WhatsApp</button>
              <button className="warn" disabled={busy || !tenantId} onClick={() => void runOperation("whatsapp/disconnect")}>Disconnect WhatsApp</button>
            </div>
            {tenantId && !hasOpenRouterKey && (
              <p style={{ marginTop: "-0.35rem", color: "var(--danger)" }}>
                Set <span className="mono">NEXUS_OPENROUTER_API_KEY</span> in Runtime Config and save before Start, Restart, or Pair WhatsApp.
              </p>
            )}

            <h3>Live Events</h3>
            <div className="events mono">
              {events.length === 0 && <div>No events yet.</div>}
              {events.map((ev, idx) => (
                <div className="events-item" key={`${ev.type}-${idx}`}>
                  <strong>{ev.type}</strong>
                  <div>{JSON.stringify(ev.payload ?? {})}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <h2 style={{ marginTop: 0 }}>Runtime Config</h2>
            <label>Env JSON</label>
            <textarea className="mono" value={configText} onChange={(e) => setConfigText(e.target.value)} />
            <div className="row" style={{ marginTop: "0.65rem" }}>
              <button className="primary" disabled={busy || !tenantId} onClick={saveConfig}>
                Save Config
              </button>
            </div>

            <h3 style={{ marginTop: "1rem" }}>Prompt Editor</h3>
            <label>Prompt Name</label>
            <input value={promptName} onChange={(e) => setPromptName(e.target.value)} />
            <label style={{ marginTop: "0.5rem" }}>Prompt Content</label>
            <textarea className="mono" value={promptContent} onChange={(e) => setPromptContent(e.target.value)} />
            <div className="row" style={{ marginTop: "0.65rem" }}>
              <button className="secondary" disabled={busy || !tenantId} onClick={savePrompt}>
                Save Prompt
              </button>
            </div>
            <div className="mono" style={{ marginTop: "0.45rem", fontSize: "0.8rem" }}>
              Active prompts: {prompts.map((p) => `${p.name}@${p.revision}`).join(", ") || "none"}
            </div>

            <h3 style={{ marginTop: "1rem" }}>Skill Editor</h3>
            <label>Skill ID</label>
            <input value={skillId} onChange={(e) => setSkillId(e.target.value)} />
            <label style={{ marginTop: "0.5rem" }}>Skill Content</label>
            <textarea className="mono" value={skillContent} onChange={(e) => setSkillContent(e.target.value)} />
            <div className="row" style={{ marginTop: "0.65rem" }}>
              <button className="secondary" disabled={busy || !tenantId} onClick={saveSkill}>
                Save Skill
              </button>
            </div>
            <div className="mono" style={{ marginTop: "0.45rem", fontSize: "0.8rem" }}>
              Active skills: {skills.map((s) => `${s.skill_id}@${s.revision}`).join(", ") || "none"}
            </div>
          </article>
        </section>
      )}

      {error && (
        <section className="card" style={{ marginTop: "1rem", borderColor: "#f0bcbc", color: "var(--danger)" }}>
          <strong>Error:</strong> {error}
        </section>
      )}
    </main>
  );
}
