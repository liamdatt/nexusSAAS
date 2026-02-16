"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

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
  event_id?: number;
  tenant_id?: string;
  type: string;
  created_at?: string;
  payload?: Record<string, unknown>;
  source?: EventSource;
};

type EventSource = "ws" | "poll_incremental" | "poll_latest";

type ConfigRow = {
  id: string;
  key: string;
  value: string;
};

const TOKEN_KEY = "nexus_saas_tokens";
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD)/i;

function makeConfigRow(key: string, value: string): ConfigRow {
  return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, key, value };
}

function toConfigRows(env: Record<string, string>): ConfigRow[] {
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => makeConfigRow(key, value));
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function eventKey(ev: EventItem): string {
  if (typeof ev.event_id === "number") {
    return `id:${ev.event_id}`;
  }
  return `sig:${ev.type}:${ev.created_at ?? ""}:${JSON.stringify(ev.payload ?? {})}`;
}

function mergeEvents(existing: EventItem[], incoming: EventItem[]): EventItem[] {
  const seen = new Set<string>();
  const merged: EventItem[] = [];
  for (const ev of [...incoming, ...existing]) {
    const key = eventKey(ev);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(ev);
  }
  return merged.slice(0, 80);
}

function extractQr(payload?: Record<string, unknown>): string {
  if (!payload) return "";
  const raw = payload.qr ?? payload.qr_code ?? payload.qrcode ?? payload.code;
  return typeof raw === "string" ? raw : "";
}

export default function Home() {
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("supersecure123");
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [configRows, setConfigRows] = useState<ConfigRow[]>([]);
  const [originalConfig, setOriginalConfig] = useState<Record<string, string>>({});
  const [revealedConfigRows, setRevealedConfigRows] = useState<Record<string, boolean>>({});
  const [promptName, setPromptName] = useState("system");
  const [promptContent, setPromptContent] = useState("You are Nexus.");
  const [skillId, setSkillId] = useState("default");
  const [skillContent, setSkillContent] = useState("# Skill\nDescribe behavior.");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [latestQr, setLatestQr] = useState("");
  const [qrImageDataUrl, setQrImageDataUrl] = useState("");
  const [qrRenderError, setQrRenderError] = useState("");
  const [showRawQrDebug, setShowRawQrDebug] = useState(false);
  const [qrState, setQrState] = useState<"idle" | "waiting" | "ready" | "timeout">("idle");
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);
  const [openrouterKeyInput, setOpenrouterKeyInput] = useState("");
  const [requiresOpenRouterKey, setRequiresOpenRouterKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tenantBootstrapAttemptedToken = useRef<string | null>(null);
  const latestEventIdRef = useRef<number | null>(null);
  const qrPollGeneration = useRef(0);
  const pairStartMinEventIdRef = useRef<number>(-1);
  const latestQrEventIdRef = useRef<number>(-1);
  const qrPollAfterEventIdRef = useRef<number | null>(null);
  const pairStartQrTokenRef = useRef<string>("");
  const pairCompatAcceptedRef = useRef<boolean>(false);
  const latestQrTokenRef = useRef<string>("");
  const qrStateRef = useRef<"idle" | "waiting" | "ready" | "timeout">("idle");
  const qrRenderGenerationRef = useRef(0);

  function stopQrPolling() {
    qrPollGeneration.current += 1;
  }

  function setTrackedQr(value: string) {
    latestQrTokenRef.current = value;
    setLatestQr(value);
  }

  function setTrackedQrState(value: "idle" | "waiting" | "ready" | "timeout") {
    qrStateRef.current = value;
    setQrState(value);
  }

  function toggleRawQrDebug() {
    setShowRawQrDebug((prev) => !prev);
  }

  function applyIncomingEvents(incoming: EventItem[]) {
    if (incoming.length === 0) return;
    for (const ev of incoming) {
      if (typeof ev.event_id === "number") {
        latestEventIdRef.current = Math.max(latestEventIdRef.current ?? 0, ev.event_id);
      }
      if (ev.type === "whatsapp.connected") {
        setWhatsappConnected(true);
      } else if (ev.type === "whatsapp.disconnected") {
        setWhatsappConnected(false);
      } else if (ev.type === "runtime.status") {
        const projected = typeof ev.payload?.state === "string" ? ev.payload.state : "";
        if (projected === "running") {
          setWhatsappConnected(true);
        } else if (projected === "pending_pairing" || projected === "paused") {
          setWhatsappConnected(false);
        }
      }

      const qr = ev.type === "whatsapp.qr" ? extractQr(ev.payload) : "";
      if (!qr) {
        continue;
      }

      const eventId = ev.event_id;
      const pairBaseline = pairStartMinEventIdRef.current;
      const inPairFlow = pairBaseline >= 0;
      if (inPairFlow && typeof eventId === "number") {
        // During an active pair session, only accept strictly newer QR events with an event id.
        if (eventId <= pairBaseline || eventId <= latestQrEventIdRef.current) {
          continue;
        }
      } else if (inPairFlow && typeof eventId !== "number") {
        // Compatibility path for mixed deployments where websocket events may lack event_id.
        if (qrStateRef.current !== "waiting") {
          continue;
        }
        if (pairCompatAcceptedRef.current) {
          continue;
        }
        if (qr === pairStartQrTokenRef.current) {
          continue;
        }
        if (qr === latestQrTokenRef.current) {
          continue;
        }
        pairCompatAcceptedRef.current = true;
      } else if (!inPairFlow && qr === latestQrTokenRef.current) {
        // Outside pair flow, keep permissive updates while suppressing duplicate token churn.
        continue;
      }

      if (typeof eventId === "number") {
        latestQrEventIdRef.current = eventId;
      }
      setTrackedQr(qr);
      setTrackedQrState("ready");
      stopQrPolling();

      if (typeof eventId === "number") {
        qrPollAfterEventIdRef.current = Math.max(qrPollAfterEventIdRef.current ?? 0, eventId);
      }
    }
    setEvents((prev) => mergeEvents(prev, incoming));
  }

  function logout() {
    stopQrPolling();
    localStorage.removeItem(TOKEN_KEY);
    setTokens(null);
    setTenantId("");
    setStatus(null);
    setConfigRows([]);
    setOriginalConfig({});
    setRevealedConfigRows({});
    setPrompts([]);
    setSkills([]);
    setEvents([]);
    setTrackedQr("");
    setTrackedQrState("idle");
    setOpenrouterKeyInput("");
    setRequiresOpenRouterKey(false);
    setWhatsappConnected(null);
    setError("");
    tenantBootstrapAttemptedToken.current = null;
    latestEventIdRef.current = null;
    pairStartMinEventIdRef.current = -1;
    latestQrEventIdRef.current = -1;
    qrPollAfterEventIdRef.current = null;
    pairStartQrTokenRef.current = "";
    pairCompatAcceptedRef.current = false;
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
    const generation = qrRenderGenerationRef.current + 1;
    qrRenderGenerationRef.current = generation;

    if (!latestQr) {
      setQrImageDataUrl("");
      setQrRenderError("");
      setShowRawQrDebug(false);
      return;
    }

    setQrRenderError("");
    void QRCode.toDataURL(latestQr, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (qrRenderGenerationRef.current !== generation) {
          return;
        }
        setQrImageDataUrl(dataUrl);
      })
      .catch((err: unknown) => {
        if (qrRenderGenerationRef.current !== generation) {
          return;
        }
        setQrImageDataUrl("");
        const message = err instanceof Error ? err.message : "Unable to render QR image.";
        setQrRenderError(message);
      });
  }, [latestQr]);

  useEffect(() => {
    return () => {
      stopQrPolling();
    };
  }, []);

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

    const socket = new WebSocket(
      wsUrl(tokens.access_token, {
        tenantId,
        replay: 80,
        afterEventId: latestEventIdRef.current ?? undefined,
      }),
    );
    socket.onmessage = (ev) => {
      const parsed = safeJsonParse<EventItem>(ev.data, { type: "runtime.log", payload: {} });
      if (parsed.tenant_id && parsed.tenant_id !== tenantId) {
        return;
      }
      applyIncomingEvents([{ ...parsed, source: "ws" }]);
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

  useEffect(() => {
    if (status?.actual_state === "pending_pairing" && !latestQr && qrStateRef.current === "idle") {
      setTrackedQrState("waiting");
    }
  }, [latestQr, status?.actual_state]);

  useEffect(() => {
    stopQrPolling();
    latestEventIdRef.current = null;
    pairStartMinEventIdRef.current = -1;
    latestQrEventIdRef.current = -1;
    qrPollAfterEventIdRef.current = null;
    pairStartQrTokenRef.current = "";
    pairCompatAcceptedRef.current = false;
    setEvents([]);
    setTrackedQr("");
    setTrackedQrState("idle");
    setWhatsappConnected(null);
    if (tenantId && tokens) {
      void loadRecentEvents(tenantId, tokens.access_token, "poll_latest", { limit: 20 });
    }
    // Tenant changes should reset stream state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

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
      if (data.actual_state === "running") {
        setWhatsappConnected(true);
      } else if (data.actual_state === "pending_pairing" || data.actual_state === "paused") {
        setWhatsappConnected(false);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function loadConfig(id: string, token: string = tokens?.access_token ?? "") {
    if (!id || !token) return;
    try {
      const data = await api<ConfigResponse>(`/v1/tenants/${id}/config`, {}, token);
      setOriginalConfig(data.env_json);
      setConfigRows(toConfigRows(data.env_json));
      setRevealedConfigRows({});
    } catch {
      setOriginalConfig({});
      setConfigRows([]);
      setRevealedConfigRows({});
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

  async function loadRecentEvents(
    id: string,
    token: string,
    source: EventSource,
    options: { limit?: number; afterEventId?: number | null; types?: string[] } = {},
  ) {
    const params = new URLSearchParams();
    params.set("limit", String(options.limit ?? 50));
    if (typeof options.afterEventId === "number") {
      params.set("after_event_id", String(options.afterEventId));
    }
    if (options.types && options.types.length > 0) {
      params.set("types", options.types.join(","));
    }
    const query = params.toString();
    const path = `/v1/tenants/${id}/events/recent${query ? `?${query}` : ""}`;
    const rows = await api<EventItem[]>(path, {}, token);
    applyIncomingEvents(rows.map((row) => ({ ...row, source })));
    return rows;
  }

  async function pollForQr(id: string, token: string) {
    const generation = qrPollGeneration.current + 1;
    qrPollGeneration.current = generation;
    setTrackedQrState("waiting");
    const deadline = Date.now() + 90_000;
    let idleCycles = 0;

    while (qrPollGeneration.current === generation && Date.now() < deadline) {
      try {
        const previousQrEventId = latestQrEventIdRef.current;
        const previousQrToken = latestQrTokenRef.current;
        const rows = await loadRecentEvents(id, token, "poll_incremental", {
          limit: 50,
          afterEventId: qrPollAfterEventIdRef.current,
          types: ["whatsapp.qr"],
        });
        if (qrPollGeneration.current !== generation) {
          return;
        }
        const maxSeenEventId = rows.reduce<number>(
          (maxId, ev) => (typeof ev.event_id === "number" ? Math.max(maxId, ev.event_id) : maxId),
          qrPollAfterEventIdRef.current ?? -1,
        );
        if (maxSeenEventId >= 0) {
          qrPollAfterEventIdRef.current = maxSeenEventId;
        }

        if (latestQrEventIdRef.current > previousQrEventId || latestQrTokenRef.current !== previousQrToken) {
          return;
        }

        idleCycles += 1;
        if (idleCycles >= 3) {
          idleCycles = 0;
          const fallbackRows = await loadRecentEvents(id, token, "poll_latest", {
            limit: 1,
            types: ["whatsapp.qr"],
          });
          if (qrPollGeneration.current !== generation) {
            return;
          }
          const newestFallbackEventId = fallbackRows.reduce<number>(
            (maxId, ev) => (typeof ev.event_id === "number" ? Math.max(maxId, ev.event_id) : maxId),
            qrPollAfterEventIdRef.current ?? -1,
          );
          if (newestFallbackEventId >= 0) {
            qrPollAfterEventIdRef.current = Math.max(
              qrPollAfterEventIdRef.current ?? -1,
              newestFallbackEventId,
            );
          }
          if (latestQrEventIdRef.current > previousQrEventId || latestQrTokenRef.current !== previousQrToken) {
            return;
          }
        }
      } catch {
        // ignore transient fallback polling errors
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (qrPollGeneration.current === generation) {
      setTrackedQrState("timeout");
    }
  }

  async function runOperation(op: "start" | "stop" | "pair/start" | "whatsapp/disconnect") {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    if (op === "pair/start") {
      const baseline = latestEventIdRef.current ?? 0;
      pairStartMinEventIdRef.current = baseline;
      latestQrEventIdRef.current = baseline;
      qrPollAfterEventIdRef.current = baseline;
      pairStartQrTokenRef.current = latestQrTokenRef.current;
      pairCompatAcceptedRef.current = false;
      stopQrPolling();
      setTrackedQrState("waiting");
    }
    if (op === "stop" || op === "whatsapp/disconnect") {
      stopQrPolling();
      pairStartMinEventIdRef.current = -1;
      latestQrEventIdRef.current = -1;
      qrPollAfterEventIdRef.current = null;
      pairStartQrTokenRef.current = "";
      pairCompatAcceptedRef.current = false;
      setTrackedQrState("idle");
      setWhatsappConnected(false);
    }
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
      if (op === "pair/start") {
        setWhatsappConnected(false);
        void pollForQr(tenantId, tokens.access_token);
      }
    } catch (err) {
      setError((err as Error).message);
      if (op === "pair/start") {
        setTrackedQrState("timeout");
      }
    } finally {
      setBusy(false);
    }
  }

  function updateConfigRow(id: string, field: "key" | "value", next: string) {
    setConfigRows((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: next } : row)));
  }

  function removeConfigRow(id: string) {
    setConfigRows((prev) => prev.filter((row) => row.id !== id));
    setRevealedConfigRows((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }

  function addConfigRow() {
    setConfigRows((prev) => [...prev, makeConfigRow("", "")]);
  }

  function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_RE.test(key);
  }

  function toggleRevealConfigRow(id: string) {
    setRevealedConfigRows((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function saveConfig() {
    if (!tokens || !tenantId) return;
    setBusy(true);
    setError("");
    try {
      const values: Record<string, string> = {};
      const seen = new Set<string>();
      for (const row of configRows) {
        const key = row.key.trim();
        if (!key) {
          throw new Error("Config variable name is required.");
        }
        if (!CONFIG_KEY_RE.test(key)) {
          throw new Error(`Invalid config variable name: ${key}`);
        }
        if (seen.has(key)) {
          throw new Error(`Duplicate config variable name: ${key}`);
        }
        seen.add(key);
        values[key] = row.value;
      }
      const removeKeys = Object.keys(originalConfig).filter((key) => !(key in values));
      await api(
        `/v1/tenants/${tenantId}/config`,
        {
          method: "PATCH",
          body: JSON.stringify({ values, remove_keys: removeKeys }),
        },
        tokens.access_token,
      );
      await loadConfig(tenantId, tokens.access_token);
      await fetchStatus(tenantId, tokens.access_token);
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
    const value = originalConfig.NEXUS_OPENROUTER_API_KEY;
    return Boolean(value && String(value).trim());
  }, [originalConfig]);

  const runtimeIsActive = useMemo(() => {
    const state = status?.actual_state;
    return state === "running" || state === "pending_pairing" || state === "provisioning";
  }, [status]);

  const runtimeOp: "start" | "stop" = runtimeIsActive ? "stop" : "start";
  const runtimeLabel = runtimeIsActive ? "Stop" : "Start";
  const runtimeClass = runtimeIsActive ? "warn" : "secondary";

  const whatsappIsConnected = useMemo(() => {
    if (whatsappConnected !== null) {
      return whatsappConnected;
    }
    return status?.actual_state === "running";
  }, [status, whatsappConnected]);

  const whatsappOp: "pair/start" | "whatsapp/disconnect" = whatsappIsConnected ? "whatsapp/disconnect" : "pair/start";
  const whatsappLabel = whatsappIsConnected ? "Disconnect WhatsApp" : "Generate QR";
  const whatsappClass = whatsappIsConnected ? "warn" : "primary";

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
              <button
                className={runtimeClass}
                disabled={busy || !tenantId || (runtimeOp === "start" && !hasOpenRouterKey)}
                onClick={() => void runOperation(runtimeOp)}
              >
                {runtimeLabel}
              </button>
              <button
                className={whatsappClass}
                disabled={busy || !tenantId || (whatsappOp === "pair/start" && !hasOpenRouterKey)}
                onClick={() => void runOperation(whatsappOp)}
              >
                {whatsappLabel}
              </button>
            </div>
            {tenantId && !hasOpenRouterKey && (
              <p style={{ marginTop: "-0.35rem", color: "var(--danger)" }}>
                Set <span className="mono">NEXUS_OPENROUTER_API_KEY</span> in Runtime Config and save before Start or Generate QR.
              </p>
            )}

            <h3>WhatsApp QR</h3>
            {qrState === "waiting" && <p style={{ marginTop: 0, color: "var(--muted)" }}>Waiting for newer QR...</p>}
            {qrState === "timeout" && (
              <p style={{ marginTop: 0, color: "var(--danger)" }}>
                QR was not received in time. Click <strong>Generate QR</strong> again.
              </p>
            )}
            {!latestQr ? (
              <div className="mono" style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                No QR received yet.
              </div>
            ) : (
              <div>
                {qrImageDataUrl ? (
                  <img
                    src={qrImageDataUrl}
                    alt="WhatsApp pairing QR"
                    style={{
                      width: "100%",
                      maxWidth: 320,
                      height: "auto",
                      border: "1px solid var(--line)",
                      borderRadius: "0.75rem",
                      background: "#fff",
                      padding: "0.35rem",
                    }}
                  />
                ) : (
                  <div className="mono" style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                    {qrRenderError ? "Unable to render QR image." : "Rendering QR image..."}
                  </div>
                )}
                <p style={{ marginTop: "0.5rem", color: "var(--muted)" }}>
                  Scan this code in WhatsApp Linked Devices.
                </p>
                {qrRenderError && (
                  <p style={{ marginTop: "0.35rem", color: "var(--danger)" }}>
                    QR render error: {qrRenderError}
                  </p>
                )}
                <div className="row" style={{ marginTop: "0.35rem" }}>
                  <button className="secondary" type="button" onClick={toggleRawQrDebug} style={{ padding: "0.35rem 0.55rem" }}>
                    {showRawQrDebug ? "Hide Raw QR" : "Show Raw QR"}
                  </button>
                </div>
                {showRawQrDebug && (
                  <textarea className="mono" readOnly value={latestQr} rows={5} style={{ marginTop: "0.45rem" }} />
                )}
              </div>
            )}

            <h3>Live Events</h3>
            <div className="events mono">
              {events.length === 0 && <div>No events yet.</div>}
              {events.map((ev) => (
                <div className="events-item" key={eventKey(ev)}>
                  <strong>{ev.type}</strong>
                  <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                    id={typeof ev.event_id === "number" ? ev.event_id : "none"} | source={ev.source ?? "ws"}
                  </div>
                  <div>{JSON.stringify(ev.payload ?? {})}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="card">
            <h2 style={{ marginTop: 0 }}>Runtime Config</h2>
            <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                <thead>
                  <tr style={{ background: "#fbfdf8" }}>
                    <th style={{ textAlign: "left", padding: "0.55rem", borderBottom: "1px solid var(--line)" }}>Variable</th>
                    <th style={{ textAlign: "left", padding: "0.55rem", borderBottom: "1px solid var(--line)" }}>Value</th>
                    <th style={{ textAlign: "left", padding: "0.55rem", borderBottom: "1px solid var(--line)", width: 140 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {configRows.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: "0.65rem", color: "var(--muted)" }}>
                        No variables yet. Add one below.
                      </td>
                    </tr>
                  )}
                  {configRows.map((row) => {
                    const sensitive = isSensitiveKey(row.key);
                    const revealed = Boolean(revealedConfigRows[row.id]);
                    return (
                      <tr key={row.id}>
                        <td style={{ padding: "0.45rem", borderTop: "1px solid var(--line)" }}>
                          <input
                            className="mono"
                            value={row.key}
                            onChange={(e) => updateConfigRow(row.id, "key", e.target.value)}
                            placeholder="NEXUS_OPENROUTER_API_KEY"
                          />
                        </td>
                        <td style={{ padding: "0.45rem", borderTop: "1px solid var(--line)" }}>
                          <input
                            className="mono"
                            type={sensitive && !revealed ? "password" : "text"}
                            value={row.value}
                            onChange={(e) => updateConfigRow(row.id, "value", e.target.value)}
                            placeholder="value"
                          />
                        </td>
                        <td style={{ padding: "0.45rem", borderTop: "1px solid var(--line)" }}>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            {sensitive && (
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => toggleRevealConfigRow(row.id)}
                                style={{ padding: "0.35rem 0.55rem" }}
                              >
                                {revealed ? "Hide" : "Show"}
                              </button>
                            )}
                            <button
                              className="warn"
                              type="button"
                              onClick={() => removeConfigRow(row.id)}
                              style={{ padding: "0.35rem 0.55rem" }}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: "0.65rem", justifyContent: "space-between" }}>
              <button className="secondary" type="button" onClick={addConfigRow} disabled={busy || !tenantId}>
                Add Variable
              </button>
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
