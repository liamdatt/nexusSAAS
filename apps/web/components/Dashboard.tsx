import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, Tokens, wsUrl } from "@/lib/api";
import SpotlightCard from "./ui/SpotlightCard";
import Orb from "./ui/Orb";
import { motion, AnimatePresence } from "framer-motion";

// --- Types ---
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

// --- Constants ---
const CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD)/i;

// --- Helpers ---
function makeConfigRow(key: string, value: string): ConfigRow {
    return { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, key, value };
}

function toConfigRows(env: Record<string, string>): ConfigRow[] {
    return Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => makeConfigRow(key, value));
}

function safeJsonParse<T>(
    value: string,
    fallback: T,
    Reviver?: (key: string, value: unknown) => unknown,
): T {
    try {
        return JSON.parse(value, Reviver) as T;
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

// --- Component ---
interface DashboardProps {
    tokens: Tokens;
    onLogout: () => void;
}

export default function Dashboard({ tokens, onLogout }: DashboardProps) {
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

    // Refs for polling/state logic
    const tenantBootstrapAttemptedToken = useRef<string | null>(null);
    const latestEventIdRef = useRef<number | null>(null);
    const qrPollGeneration = useRef(0);
    const pairStartMinEventIdRef = useRef<number>(-1);
    const latestQrEventIdRef = useRef<number>(-1);
    const qrPollAfterEventIdRef = useRef<number | null>(null);
    const latestQrTokenRef = useRef<string>("");
    const qrStateRef = useRef<"idle" | "waiting" | "ready" | "timeout">("idle");
    const qrRenderGenerationRef = useRef(0);

    // --- Logic Methods (Migrated from page.tsx) ---
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

            const eventId = typeof ev.event_id === "number" ? ev.event_id : null;
            const pairBaseline = pairStartMinEventIdRef.current;
            if (eventId !== null) {
                if (pairBaseline >= 0 && eventId <= pairBaseline) {
                    continue;
                }
                if (eventId <= latestQrEventIdRef.current) {
                    continue;
                }
                latestQrEventIdRef.current = eventId;
                qrPollAfterEventIdRef.current = Math.max(qrPollAfterEventIdRef.current ?? -1, eventId);
            } else if (qr === latestQrTokenRef.current) {
                continue;
            }

            setTrackedQr(qr);
            setTrackedQrState("ready");
            stopQrPolling();
        }
        setEvents((prev) => mergeEvents(prev, incoming));
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

    async function fetchStatus(id: string, token: string = tokens.access_token) {
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

    async function loadConfig(id: string, token: string = tokens.access_token) {
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

    async function loadPrompts(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        const data = await api<Prompt[]>(`/v1/tenants/${id}/prompts`, {}, token);
        setPrompts(data);
    }

    async function loadSkills(id: string, token: string = tokens.access_token) {
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

    async function runOperation(op: "start" | "stop" | "pair/start" | "whatsapp/disconnect") {
        if (!tokens || !tenantId) return;
        setBusy(true);
        setError("");
        if (op === "pair/start") {
            const baseline = latestEventIdRef.current ?? 0;
            pairStartMinEventIdRef.current = baseline;
            latestQrEventIdRef.current = baseline;
            qrPollAfterEventIdRef.current = baseline;
            stopQrPolling();
            setTrackedQrState("waiting");
        }
        if (op === "stop" || op === "whatsapp/disconnect") {
            stopQrPolling();
            pairStartMinEventIdRef.current = -1;
            latestQrEventIdRef.current = -1;
            qrPollAfterEventIdRef.current = null;
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

    async function pollForQr(id: string, token: string) {
        const generation = qrPollGeneration.current + 1;
        qrPollGeneration.current = generation;
        setTrackedQrState("waiting");
        const deadline = Date.now() + 90_000;

        while (qrPollGeneration.current === generation && Date.now() < deadline) {
            try {
                const previousQrEventId = latestQrEventIdRef.current;
                const rows = await loadRecentEvents(id, token, "poll_incremental", {
                    limit: 20,
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

                if (latestQrEventIdRef.current > previousQrEventId || qrStateRef.current === "ready") {
                    return;
                }
            } catch {
                // ignore
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (qrPollGeneration.current === generation) {
            setTrackedQrState("timeout");
        }
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
                if (!key) throw new Error("Config variable name is required.");
                if (!CONFIG_KEY_RE.test(key)) throw new Error(`Invalid config: ${key}`);
                if (seen.has(key)) throw new Error(`Duplicate config: ${key}`);
                seen.add(key);
                values[key] = row.value;
            }
            const removeKeys = Object.keys(originalConfig).filter((key) => !(key in values));
            await api(
                `/v1/tenants/${tenantId}/config`,
                { method: "PATCH", body: JSON.stringify({ values, remove_keys: removeKeys }) },
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

    function toggleRevealConfigRow(id: string) {
        setRevealedConfigRows((prev) => ({ ...prev, [id]: !prev[id] }));
    }

    // --- Effects ---

    // QR Rendering
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
            color: {
                dark: "#000000",
                light: "#FFD700" // Gold background for QR
            },
            errorCorrectionLevel: "M",
        })
            .then((dataUrl) => {
                if (qrRenderGenerationRef.current !== generation) return;
                setQrImageDataUrl(dataUrl);
            })
            .catch((err: unknown) => {
                if (qrRenderGenerationRef.current !== generation) return;
                setQrImageDataUrl("");
                const message = err instanceof Error ? err.message : "Unable to render QR image.";
                setQrRenderError(message);
            });
    }, [latestQr]);

    // Load Tenant on mount
    useEffect(() => {
        if (tenantBootstrapAttemptedToken.current === tokens.access_token) return;
        tenantBootstrapAttemptedToken.current = tokens.access_token;
        void loadTenant(tokens.access_token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokens]);

    // WebSocket
    useEffect(() => {
        if (!tenantId) return;

        const socket = new WebSocket(
            wsUrl(tokens.access_token, {
                tenantId,
                replay: 80,
                afterEventId: latestEventIdRef.current ?? undefined,
            }),
        );
        socket.onmessage = (ev) => {
            const parsed = safeJsonParse<EventItem>(ev.data, { type: "runtime.log", payload: {} });
            if (parsed.tenant_id && parsed.tenant_id !== tenantId) return;
            applyIncomingEvents([{ ...parsed, source: "ws" }]);
            if (parsed.type === "runtime.status" && tenantId) {
                void fetchStatus(tenantId, tokens.access_token);
            }
        };

        return () => socket.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId, tokens]);

    // QR Wait
    useEffect(() => {
        if (status?.actual_state === "pending_pairing" && !latestQr && qrStateRef.current === "idle") {
            setTrackedQrState("waiting");
        }
    }, [latestQr, status?.actual_state]);

    // Reset logic when tenantId changes
    useEffect(() => {
        stopQrPolling();
        latestEventIdRef.current = null;
        pairStartMinEventIdRef.current = -1;
        latestQrEventIdRef.current = -1;
        qrPollAfterEventIdRef.current = null;
        setEvents([]);
        setTrackedQr("");
        setTrackedQrState("idle");
        setWhatsappConnected(null);
        if (tenantId) {
            void loadRecentEvents(tenantId, tokens.access_token, "poll_latest", { limit: 20 });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    // --- Render Helpers ---

    const runtimeIsActive = useMemo(() => {
        const state = status?.actual_state;
        return state === "running" || state === "pending_pairing" || state === "provisioning";
    }, [status]);

    const whatsappIsConnected = useMemo(() => {
        if (whatsappConnected !== null) return whatsappConnected;
        return status?.actual_state === "running";
    }, [status, whatsappConnected]);


    // --- Render ---
    return (
        <div className="relative w-full max-w-6xl mx-auto px-4 py-8 space-y-8 pb-32">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
            >
                <SpotlightCard className="glass-panel rim-light p-6 flex flex-col md:flex-row justify-between items-center gap-4 rounded-2xl border border-[rgba(255,215,0,0.06)]">
                    <div className="flex items-center gap-5">
                        {/* Mini Orb status indicator */}
                        <div className="w-12 h-12 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-[rgba(255,215,0,0.15)]">
                            <Orb hue={40} hoverIntensity={0.1} rotateOnHover={false} forceHoverState={true} backgroundColor="#050505" />
                        </div>
                        <div>
                            <h1 className="text-2xl md:text-3xl font-display font-bold text-white tracking-widest text-shadow-glow">
                                NEXUS <span className="text-gradient-gold">COMMAND</span>
                            </h1>
                            <p className="text-[--text-muted] text-xs font-mono mt-1 tracking-[0.2em]">
                                SECURE CHANNEL · {tenantId ? tenantId.substring(0, 8).toUpperCase() : 'INITIALIZING'}
                            </p>
                        </div>
                    </div>
                    <div className="flex gap-4 items-center">
                        {/* Status badge */}
                        <div className={`px-3 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider border ${status?.actual_state === 'running'
                                ? 'border-[--status-success] text-[--status-success] bg-[rgba(0,255,148,0.05)]'
                                : status?.actual_state === 'error'
                                    ? 'border-[--status-error] text-[--status-error] bg-[rgba(255,50,50,0.05)]'
                                    : 'border-[--glass-border] text-[--text-muted] bg-transparent'
                            }`}>
                            {status?.actual_state || 'OFFLINE'}
                        </div>
                        <button
                            onClick={onLogout}
                            className="px-5 py-2 border border-[rgba(255,255,255,0.06)] rounded-lg bg-[rgba(255,255,255,0.03)] text-[--text-secondary] hover:text-[--status-error] hover:border-[--status-error] transition-all font-mono text-xs tracking-wider"
                        >
                            DISCONNECT
                        </button>
                    </div>
                </SpotlightCard>
            </motion.div>

            {/* Error display */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="glass-panel p-4 rounded-xl border border-[--status-error] text-[--status-error] text-sm font-mono text-center"
                        style={{ background: 'linear-gradient(135deg, rgba(255,50,50,0.08), rgba(255,50,50,0.02))' }}
                    >
                        ⚠ {error}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Main Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Left Column: Status & Runtime */}
                <div className="space-y-6 lg:col-span-2">

                    {/* Runtime Control */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: 0.15 }}
                    >
                        <SpotlightCard className="glass-panel rim-light p-8 rounded-2xl border border-[rgba(255,215,0,0.04)]">
                            <h2 className="text-lg font-display font-bold text-white mb-6 flex items-center gap-3">
                                <span className="w-1.5 h-7 bg-gradient-to-b from-[--accent-gold] to-[--accent-orange] rounded-full shadow-[0_0_8px_var(--accent-gold)]" />
                                RUNTIME STATUS
                            </h2>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-3">
                                    <p className="text-[--text-muted] text-[10px] font-mono uppercase tracking-[0.3em]">System State</p>
                                    <div className="flex items-center gap-3">
                                        <div className={`w-3 h-3 rounded-full transition-all ${status?.actual_state === 'running'
                                                ? 'bg-[--status-success] shadow-[0_0_12px_var(--status-success)]'
                                                : status?.actual_state === 'error'
                                                    ? 'bg-[--status-error] shadow-[0_0_12px_var(--status-error)]'
                                                    : 'bg-[--text-muted]'
                                            }`} />
                                        <span className="text-xl text-white font-mono uppercase tracking-wider">{status?.actual_state || 'UNKNOWN'}</span>
                                    </div>
                                    {status?.last_heartbeat && (
                                        <p className="text-[--text-muted] text-[9px] font-mono">
                                            LAST HEARTBEAT: {new Date(status.last_heartbeat).toLocaleTimeString()}
                                        </p>
                                    )}
                                </div>

                                <div className="flex gap-3 items-end">
                                    <button
                                        onClick={() => runOperation(runtimeIsActive ? "stop" : "start")}
                                        disabled={busy}
                                        className={`flex-1 py-3 px-4 rounded-lg font-mono font-bold text-sm uppercase tracking-wider transition-all disabled:opacity-30 ${runtimeIsActive
                                                ? 'bg-[rgba(255,50,50,0.06)] border border-[--status-error] text-[--status-error] hover:bg-[rgba(255,50,50,0.12)]'
                                                : 'bg-[rgba(0,255,148,0.06)] border border-[--status-success] text-[--status-success] hover:bg-[rgba(0,255,148,0.12)]'
                                            }`}
                                    >
                                        {runtimeIsActive ? "SHUTDOWN" : "BOOT SYSTEM"}
                                    </button>
                                </div>
                            </div>

                            {/* WhatsApp Integration */}
                            <div className="mt-8 pt-8 border-t border-[rgba(255,255,255,0.04)]">
                                <h3 className="text-sm font-display text-white mb-4 tracking-widest flex items-center gap-2">
                                    <span className="w-1 h-5 bg-[--accent-amber] rounded-full opacity-60" />
                                    UPLINK · WHATSAPP
                                </h3>
                                <div className="flex flex-col md:flex-row gap-6 items-start">
                                    <div className="flex-1 space-y-4">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-2 h-2 rounded-full transition-all ${whatsappIsConnected
                                                    ? 'bg-[--status-success] shadow-[0_0_8px_var(--status-success)]'
                                                    : 'bg-[--accent-orange] animate-pulse'
                                                }`} />
                                            <span className="text-[--text-secondary] font-mono text-xs tracking-wider">
                                                {whatsappIsConnected ? "DATA STREAM ACTIVE" : "SIGNAL LOSS · UNPAIRED"}
                                            </span>
                                        </div>
                                        <button
                                            onClick={() => runOperation(whatsappIsConnected ? "whatsapp/disconnect" : "pair/start")}
                                            disabled={busy}
                                            className={`w-full py-2.5 rounded-lg font-mono text-xs uppercase tracking-[0.2em] transition-all disabled:opacity-30 ${whatsappIsConnected
                                                    ? 'border border-[--status-error] text-[--status-error] bg-[rgba(255,50,50,0.04)] hover:bg-[rgba(255,50,50,0.1)]'
                                                    : 'border border-[--accent-gold] text-[--accent-gold] bg-[rgba(255,215,0,0.04)] hover:bg-[rgba(255,215,0,0.1)]'
                                                }`}
                                        >
                                            {whatsappIsConnected ? "Disconnect WhatsApp" : "Generate QR"}
                                        </button>
                                    </div>

                                    {/* QR Display — "Data Slate" Style */}
                                    <AnimatePresence>
                                        {(qrState === "waiting" || qrState === "ready") && !whatsappIsConnected && (
                                            <motion.div
                                                initial={{ opacity: 0, scale: 0.85, rotateY: 10 }}
                                                animate={{ opacity: 1, scale: 1, rotateY: 0 }}
                                                exit={{ opacity: 0, scale: 0.85 }}
                                                transition={{ type: "spring", damping: 20 }}
                                                className="glass-panel-deep rim-light rounded-xl p-4 relative overflow-hidden"
                                            >
                                                {/* Scan lines */}
                                                <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
                                                    style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,215,0,0.15) 2px, rgba(255,215,0,0.15) 4px)' }}
                                                />
                                                <p className="text-[--accent-gold] text-[8px] font-mono tracking-[0.3em] uppercase text-center mb-2">SCAN TO AUTHENTICATE</p>
                                                {qrImageDataUrl ? (
                                                    <img src={qrImageDataUrl} alt="QR Code" className="w-36 h-36 md:w-44 md:h-44 rounded-lg" />
                                                ) : (
                                                    <div className="w-36 h-36 md:w-44 md:h-44 flex items-center justify-center bg-[rgba(255,215,0,0.03)] rounded-lg text-[--text-muted] font-mono text-[10px] text-center p-3">
                                                        {qrState === "waiting" ? "ACQUIRING\nSIGNAL..." : "RENDERING..."}
                                                    </div>
                                                )}
                                                {/* Animated border pulse */}
                                                <div className="absolute inset-0 border border-[--accent-gold] opacity-20 animate-pulse pointer-events-none rounded-xl" />
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>
                        </SpotlightCard>
                    </motion.div>

                    {/* Live Logs */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: 0.3 }}
                    >
                        <SpotlightCard className="glass-panel rim-light p-6 rounded-2xl border border-[rgba(255,215,0,0.04)] h-[400px] flex flex-col carbon-fiber">
                            <h2 className="text-sm font-display font-bold text-white mb-4 flex justify-between items-center">
                                <span className="flex items-center gap-2">
                                    <span className="w-1.5 h-5 bg-gradient-to-b from-[--accent-amber] to-transparent rounded-full" />
                                    SYSTEM LOGS
                                </span>
                                <span className="text-[9px] font-mono text-[--accent-gold] opacity-60 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-[--status-success] animate-pulse" />
                                    LIVE FEED
                                </span>
                            </h2>
                            <div className="flex-1 overflow-auto font-mono text-[11px] space-y-1.5 pr-2">
                                {events.length === 0 && (
                                    <div className="text-[--text-muted] italic text-xs py-8 text-center">
                                        Awaiting telemetry data...
                                    </div>
                                )}
                                {events.map((ev, i) => (
                                    <div key={i} className="border-l-2 border-[rgba(255,255,255,0.03)] pl-3 py-1 hover:border-[--accent-gold] transition-colors group">
                                        <div className="flex justify-between text-[--text-muted] mb-0.5 text-[10px]">
                                            <span>{ev.created_at || '—'}</span>
                                            <span className="uppercase text-[--accent-gold] opacity-30 group-hover:opacity-80 transition-opacity">{ev.type}</span>
                                        </div>
                                        <div className="text-[--text-secondary] break-all text-[10px] opacity-70">
                                            {JSON.stringify(ev.payload || {})}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </SpotlightCard>
                    </motion.div>
                </div>

                {/* Right Column: Configuration */}
                <div className="space-y-6">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: 0.45 }}
                        className="h-full"
                    >
                        <SpotlightCard className="glass-panel rim-light p-6 rounded-2xl border border-[rgba(255,215,0,0.04)] min-h-[600px] flex flex-col">
                            <div className="flex justify-between items-center mb-6">
                                <h2 className="text-sm font-display font-bold text-white flex items-center gap-2">
                                    <span className="w-1.5 h-5 bg-gradient-to-b from-[--accent-orange] to-transparent rounded-full" />
                                    ENV CONFIG
                                </h2>
                                <button
                                    onClick={saveConfig}
                                    disabled={busy}
                                    className="text-[--accent-gold] hover:text-black text-[10px] font-mono uppercase tracking-[0.2em] border border-[--accent-gold] px-4 py-1.5 rounded-lg hover:bg-[--accent-gold] transition-all disabled:opacity-30"
                                >
                                    {busy ? "SYNCING..." : "COMMIT"}
                                </button>
                            </div>

                            <div className="flex-1 overflow-auto pr-2 space-y-3">
                                {configRows.map(row => (
                                    <div key={row.id} className="group relative bg-[rgba(255,255,255,0.015)] p-3 rounded-lg border border-transparent hover:border-[rgba(255,215,0,0.06)] transition-all">
                                        <input
                                            className="w-full bg-transparent text-[--accent-gold] font-mono text-[10px] mb-1 border-none focus:ring-0 p-0 tracking-wider"
                                            value={row.key}
                                            onChange={(e) => updateConfigRow(row.id, "key", e.target.value)}
                                            placeholder="VARIABLE_NAME"
                                        />
                                        <div className="flex gap-2 items-center">
                                            <input
                                                type={revealedConfigRows[row.id] || !SENSITIVE_KEY_RE.test(row.key) ? "text" : "password"}
                                                className="flex-1 bg-transparent text-[--text-secondary] font-mono text-xs border-b border-[rgba(255,255,255,0.04)] focus:border-[--accent-gold] focus:outline-none py-1 transition-colors"
                                                value={row.value}
                                                onChange={(e) => updateConfigRow(row.id, "value", e.target.value)}
                                                placeholder="value"
                                            />
                                            {SENSITIVE_KEY_RE.test(row.key) && (
                                                <button onClick={() => toggleRevealConfigRow(row.id)} className="text-[--text-muted] hover:text-[--accent-gold] text-[9px] font-mono transition-colors">
                                                    {revealedConfigRows[row.id] ? "HIDE" : "SHOW"}
                                                </button>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => removeConfigRow(row.id)}
                                            className="absolute top-2 right-2 text-[--status-error] opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity text-[9px] font-mono"
                                        >
                                            ✕
                                        </button>
                                    </div>
                                ))}

                                <button
                                    onClick={addConfigRow}
                                    className="w-full py-3 border border-dashed border-[rgba(255,255,255,0.04)] text-[--text-muted] hover:text-[--accent-gold] hover:border-[rgba(255,215,0,0.15)] rounded-lg text-[10px] font-mono uppercase tracking-[0.2em] transition-all"
                                >
                                    + ADD VARIABLE
                                </button>
                            </div>
                        </SpotlightCard>
                    </motion.div>
                </div>

            </div>
        </div>
    );
}
