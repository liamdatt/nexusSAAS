"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { motion, AnimatePresence } from "framer-motion";
import { api, apiBase, Tokens, wsUrl } from "@/lib/api";
import HudPanel from "./ui/HudPanel";
import Orb from "./ui/Orb";

type DashboardProps = {
    tokens: Tokens;
    onLogout: () => void;
};

type StatusResponse = {
    tenant_id: string;
    desired_state: string;
    actual_state: string;
    last_heartbeat?: string | null;
    last_error?: string | null;
    uptime?: number | null;
};

type ConfigResponse = {
    tenant_id: string;
    revision: number;
    env_json: Record<string, string>;
};

type GoogleStatusResponse = {
    tenant_id: string;
    connected: boolean;
    connected_at?: string | null;
    scopes?: string[];
    last_error?: string | null;
};

type Prompt = {
    name: string;
    revision: number;
    content: string;
};

type EventItem = {
    event_id?: number;
    tenant_id?: string;
    type: string;
    created_at?: string;
    payload?: Record<string, unknown>;
    source?: EventSource;
};

type EventSource = "ws" | "poll_incremental" | "poll_latest";
type WhatsAppLinkState = "unknown" | "connected" | "disconnected";
type QrState = "idle" | "waiting" | "ready" | "timeout";

type ConfigKey = {
    key: string;
    value: string;
    description: string;
    is_secret: boolean;
    category: string;
};

type ConfigManifest = {
    groups: {
        category: string;
        items: ConfigKey[];
    }[];
};

type LogEntry = {
    timestamp: string;
    level: "INFO" | "WARN" | "ERROR" | "DEBUG";
    message: string;
    source: string;
};

const SENSITIVE_KEY_RE = /(KEY|SECRET|TOKEN|PASSWORD)/i;

function safeJsonParse<T>(
    value: string,
    fallback: T,
    reviver?: (key: string, value: unknown) => unknown,
): T {
    try {
        return JSON.parse(value, reviver) as T;
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
    return merged.slice(0, 100);
}

function extractQr(payload?: Record<string, unknown>): string {
    if (!payload) return "";
    const raw = payload.qr ?? payload.qr_code ?? payload.qrcode ?? payload.code;
    return typeof raw === "string" ? raw : "";
}

function toCategory(key: string): string {
    if (SENSITIVE_KEY_RE.test(key)) return "SECRETS";
    if (key.startsWith("NEXUS_")) return "NEXUS";
    const prefix = key.split("_")[0]?.trim();
    if (prefix && prefix.length > 1 && prefix !== key) {
        return prefix.toUpperCase();
    }
    return "GENERAL";
}

function toConfigManifest(env: Record<string, string>): ConfigManifest {
    const grouped = new Map<string, ConfigKey[]>();

    for (const [key, value] of Object.entries(env)) {
        const category = toCategory(key);
        const row: ConfigKey = {
            key,
            value,
            description: "",
            is_secret: SENSITIVE_KEY_RE.test(key),
            category,
        };
        const bucket = grouped.get(category) ?? [];
        bucket.push(row);
        grouped.set(category, bucket);
    }

    const categoryOrder = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
    return {
        groups: categoryOrder.map((category) => ({
            category,
            items: (grouped.get(category) ?? []).sort((a, b) => a.key.localeCompare(b.key)),
        })),
    };
}

function compactPayload(payload?: Record<string, unknown>): string {
    if (!payload || Object.keys(payload).length === 0) return "";
    const raw = JSON.stringify(payload);
    if (raw.length <= 180) return raw;
    return `${raw.slice(0, 177)}...`;
}

function inferLogLevel(type: string): LogEntry["level"] {
    if (type === "runtime.error" || type === "google.error") return "ERROR";
    if (type.includes("disconnect") || type.includes("timeout")) return "WARN";
    return "INFO";
}

function toLogEntry(event: EventItem): LogEntry {
    const payloadText = compactPayload(event.payload);
    return {
        timestamp: event.created_at ?? new Date().toISOString(),
        level: inferLogLevel(event.type),
        message: payloadText ? `${event.type} ${payloadText}` : event.type,
        source: event.type,
    };
}

export default function Dashboard({ tokens, onLogout }: DashboardProps) {
    const [tenantId, setTenantId] = useState("");
    const [status, setStatus] = useState<StatusResponse | null>(null);
    const [events, setEvents] = useState<EventItem[]>([]);
    const [configValues, setConfigValues] = useState<Record<string, string>>({});
    const [originalConfig, setOriginalConfig] = useState<Record<string, string>>({});
    const [persona, setPersona] = useState("");

    const [latestQr, setLatestQr] = useState("");
    const [qrImageDataUrl, setQrImageDataUrl] = useState("");
    const [qrState, setQrState] = useState<QrState>("idle");
    const [whatsappLinkState, setWhatsappLinkState] = useState<WhatsAppLinkState>("unknown");
    const [isGeneratingQr, setIsGeneratingQr] = useState(false);

    const [googleConnected, setGoogleConnected] = useState(false);
    const [googleScopes, setGoogleScopes] = useState<string[]>([]);
    const [googleBusy, setGoogleBusy] = useState(false);

    const [runtimeBusy, setRuntimeBusy] = useState(false);
    const [configBusyKey, setConfigBusyKey] = useState<string | null>(null);
    const [personaBusy, setPersonaBusy] = useState(false);
    const [personaStatus, setPersonaStatus] = useState("");
    const [error, setError] = useState("");

    const [leftPanelOpen, setLeftPanelOpen] = useState(false); // Kept for legacy/mobile menu if needed, or removed
    const [rightPanelOpen, setRightPanelOpen] = useState(true);
    const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"config" | "soul">("config");

    const logEndRef = useRef<HTMLDivElement>(null);
    const tenantBootstrapAttemptedToken = useRef<string | null>(null);
    const assistantBootstrapTenantRef = useRef<string | null>(null);
    const latestEventIdRef = useRef<number | null>(null);

    const qrPollGeneration = useRef(0);
    const pairStartMinEventIdRef = useRef<number>(-1);
    const pairStartBoundaryEventIdRef = useRef<number | null>(null);
    const latestQrEventIdRef = useRef<number>(-1);
    const qrPollAfterEventIdRef = useRef<number | null>(null);
    const whatsappLinkEventIdRef = useRef<number>(-1);
    const latestQrTokenRef = useRef<string>("");
    const qrStateRef = useRef<QrState>("idle");
    const qrRenderGenerationRef = useRef(0);

    const googlePopupRef = useRef<Window | null>(null);
    const googlePollIntervalRef = useRef<number | null>(null);
    const googleMessageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
    const layoutInitializedRef = useRef(false);

    const runtimeIsActive = useMemo(() => {
        const state = status?.actual_state;
        return state === "running" || state === "pending_pairing" || state === "provisioning";
    }, [status?.actual_state]);

    const whatsappIsConnected = useMemo(() => whatsappLinkState === "connected", [whatsappLinkState]);

    const whatsappStatusText = useMemo(() => {
        if (whatsappLinkState === "connected") return "DATA STREAM ACTIVE";
        if (whatsappLinkState === "unknown") return "LINK STATUS CHECKING...";
        return "SIGNAL LOSS · UNPAIRED";
    }, [whatsappLinkState]);

    const googleStatusText = useMemo(() => {
        if (googleConnected) return "GOOGLE SERVICES CONNECTED";
        if (googleBusy) return "CONNECTING...";
        return "GOOGLE SERVICES DISCONNECTED";
    }, [googleBusy, googleConnected]);

    const configManifest = useMemo(() => toConfigManifest(configValues), [configValues]);
    const logRows = useMemo(() => events.map((event) => toLogEntry(event)), [events]);

    function stopQrPolling() {
        qrPollGeneration.current += 1;
    }

    function setTrackedQr(value: string) {
        latestQrTokenRef.current = value;
        setLatestQr(value);
    }

    function setTrackedQrState(value: QrState) {
        qrStateRef.current = value;
        setQrState(value);
    }

    function setTrackedWhatsappLinkState(value: WhatsAppLinkState) {
        setWhatsappLinkState(value);
    }

    function applyWhatsappLinkTransition(nextState: Exclude<WhatsAppLinkState, "unknown">, eventId: number | null) {
        if (eventId !== null) {
            if (eventId < whatsappLinkEventIdRef.current) {
                return;
            }
            whatsappLinkEventIdRef.current = eventId;
        } else if (whatsappLinkEventIdRef.current >= 0) {
            return;
        }
        setTrackedWhatsappLinkState(nextState);
    }

    function stopGoogleStatusPolling() {
        if (googlePollIntervalRef.current !== null) {
            window.clearInterval(googlePollIntervalRef.current);
            googlePollIntervalRef.current = null;
        }
    }

    function clearGoogleMessageHandler() {
        if (googleMessageHandlerRef.current) {
            window.removeEventListener("message", googleMessageHandlerRef.current);
            googleMessageHandlerRef.current = null;
        }
    }

    function applyIncomingEvents(incoming: EventItem[]) {
        if (incoming.length === 0) return;
        const orderedForState = [...incoming].sort((a, b) => {
            const aId = typeof a.event_id === "number" ? a.event_id : Number.MAX_SAFE_INTEGER;
            const bId = typeof b.event_id === "number" ? b.event_id : Number.MAX_SAFE_INTEGER;
            return aId - bId;
        });

        for (const ev of orderedForState) {
            const eventId = typeof ev.event_id === "number" ? ev.event_id : null;
            if (typeof ev.event_id === "number") {
                latestEventIdRef.current = Math.max(latestEventIdRef.current ?? 0, ev.event_id);
            }

            const projected =
                ev.type === "runtime.status" && typeof ev.payload?.state === "string" ? String(ev.payload.state) : "";

            if (ev.type === "whatsapp.connected") {
                applyWhatsappLinkTransition("connected", eventId);
            } else if (ev.type === "whatsapp.disconnected") {
                applyWhatsappLinkTransition("disconnected", eventId);
            } else if (ev.type === "whatsapp.qr") {
                applyWhatsappLinkTransition("disconnected", eventId);
            } else if (ev.type === "runtime.status" && (projected === "pending_pairing" || projected === "paused")) {
                applyWhatsappLinkTransition("disconnected", eventId);
            } else if (ev.type === "google.connected") {
                setGoogleConnected(true);
                const scopes = ev.payload?.scopes;
                if (Array.isArray(scopes)) {
                    setGoogleScopes(scopes.filter((item): item is string => typeof item === "string"));
                }
            } else if (ev.type === "google.disconnected") {
                setGoogleConnected(false);
                setGoogleScopes([]);
            } else if (ev.type === "google.error") {
                setGoogleConnected(false);
                const message = ev.payload?.message;
                if (typeof message === "string" && message.trim()) {
                    setError(message);
                }
            }

            const pairBaseline = pairStartMinEventIdRef.current;
            if (pairBaseline >= 0 && eventId !== null && eventId > pairBaseline) {
                if (ev.type === "whatsapp.disconnected") {
                    pairStartBoundaryEventIdRef.current = Math.max(pairStartBoundaryEventIdRef.current ?? -1, eventId);
                } else if (ev.type === "runtime.status" && projected === "pending_pairing") {
                    pairStartBoundaryEventIdRef.current = Math.max(pairStartBoundaryEventIdRef.current ?? -1, eventId);
                }
            }

            const qr = ev.type === "whatsapp.qr" ? extractQr(ev.payload) : "";
            if (!qr) continue;

            if (pairBaseline >= 0) {
                if (eventId === null) continue;
                if (eventId <= pairBaseline) continue;

                const pairBoundary = pairStartBoundaryEventIdRef.current;
                if (pairBoundary === null || eventId <= pairBoundary) {
                    continue;
                }
            }

            if (eventId !== null) {
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
            setIsGeneratingQr(false);
            pairStartMinEventIdRef.current = -1;
            pairStartBoundaryEventIdRef.current = null;
            stopQrPolling();
        }

        setEvents((prev) => mergeEvents(prev, incoming));
    }

    async function fetchStatus(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        try {
            const data = await api<StatusResponse>(`/v1/tenants/${id}/status`, {}, token);
            setTenantId(data.tenant_id);
            setStatus(data);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function loadConfig(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        try {
            const data = await api<ConfigResponse>(`/v1/tenants/${id}/config`, {}, token);
            setOriginalConfig(data.env_json);
            setConfigValues(data.env_json);
        } catch {
            setOriginalConfig({});
            setConfigValues({});
        }
    }

    async function loadPrompts(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        try {
            const data = await api<Prompt[]>(`/v1/tenants/${id}/prompts`, {}, token);
            const soulPrompt = data.find((item) => item.name === "SOUL");
            if (soulPrompt) {
                setPersona(soulPrompt.content);
            }
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function bootstrapAssistant(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        try {
            const data = await api<{
                tenant_id: string;
                applied: boolean;
                version: string;
                restarted_runtime: boolean;
                reason: string;
            }>(`/v1/tenants/${id}/assistant/bootstrap`, { method: "POST" }, token);

            if (!data.applied) return;

            setPersonaStatus(
                data.restarted_runtime ? "Applied defaults and restarted runtime." : "Applied defaults.",
            );
            await loadPrompts(id, token);
            await fetchStatus(id, token);
        } catch (err) {
            setError((err as Error).message);
        }
    }

    async function loadGoogleStatus(id: string, token: string = tokens.access_token) {
        if (!id || !token) return;
        try {
            const data = await api<GoogleStatusResponse>(`/v1/tenants/${id}/google/status`, {}, token);
            setGoogleConnected(Boolean(data.connected));
            setGoogleScopes(Array.isArray(data.scopes) ? data.scopes : []);
            if (data.last_error) {
                setError(data.last_error);
            }
        } catch (err) {
            setGoogleConnected(false);
            setGoogleScopes([]);
            const message = (err as Error).message;
            if (!message.includes("google_oauth_not_configured")) {
                setError(message);
            }
        }
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
            setTenantId(data.id);
            await fetchStatus(data.id, token);
            await loadConfig(data.id, token);
            await loadPrompts(data.id, token);
            await loadGoogleStatus(data.id, token);
        } catch (err) {
            const message = (err as Error).message;
            try {
                const detail = JSON.parse(message) as {
                    detail?: { tenant_id?: string; error?: string };
                };
                if (detail?.detail?.tenant_id) {
                    const existingId = detail.detail.tenant_id;
                    setTenantId(existingId);
                    await fetchStatus(existingId, token);
                    await loadConfig(existingId, token);
                    await loadPrompts(existingId, token);
                    await loadGoogleStatus(existingId, token);
                    return;
                }
                if (detail?.detail?.error === "openrouter_api_key_required") {
                    setError("NEXUS_OPENROUTER_API_KEY is required in ENV CONFIG before runtime start or pairing.");
                    return;
                }
            } catch {
                // fall through
            }
            setError(message);
        }
    }

    async function runOperation(op: "start" | "stop" | "pair/start" | "whatsapp/disconnect") {
        if (!tokens || !tenantId) return;

        setRuntimeBusy(true);
        setError("");

        if (op === "pair/start") {
            const baseline = latestEventIdRef.current ?? 0;
            pairStartMinEventIdRef.current = baseline;
            pairStartBoundaryEventIdRef.current = null;
            latestQrEventIdRef.current = baseline;
            qrPollAfterEventIdRef.current = baseline;
            stopQrPolling();
            setTrackedQr("");
            setTrackedQrState("waiting");
            setIsGeneratingQr(true);
            setTrackedWhatsappLinkState("disconnected");
        }

        if (op === "stop") {
            stopQrPolling();
            pairStartMinEventIdRef.current = -1;
            pairStartBoundaryEventIdRef.current = null;
            latestQrEventIdRef.current = -1;
            qrPollAfterEventIdRef.current = null;
            setTrackedQr("");
            setTrackedQrState("idle");
            setTrackedWhatsappLinkState("disconnected");
            setIsGeneratingQr(false);
        }

        if (op === "whatsapp/disconnect") {
            const baseline = latestEventIdRef.current ?? 0;
            stopQrPolling();
            pairStartMinEventIdRef.current = -1;
            pairStartBoundaryEventIdRef.current = null;
            latestQrEventIdRef.current = baseline;
            qrPollAfterEventIdRef.current = baseline;
            setTrackedQr("");
            setTrackedQrState("waiting");
            setTrackedWhatsappLinkState("disconnected");
            setIsGeneratingQr(false);
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

            if (op === "pair/start" || op === "whatsapp/disconnect") {
                if (qrStateRef.current !== "ready") {
                    void pollForQr(tenantId, tokens.access_token);
                }
            }
        } catch (err) {
            setError((err as Error).message);
            if (op === "pair/start") {
                setTrackedQrState("timeout");
                setIsGeneratingQr(false);
                pairStartMinEventIdRef.current = -1;
                pairStartBoundaryEventIdRef.current = null;
            }
            if (op === "whatsapp/disconnect") {
                setTrackedQrState("idle");
            }
        } finally {
            setRuntimeBusy(false);
        }
    }

    async function pollForQr(id: string, token: string) {
        if (qrStateRef.current === "ready") {
            return;
        }

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
                    types: ["runtime.status", "whatsapp.disconnected", "whatsapp.qr"],
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

                if (latestQrEventIdRef.current > previousQrEventId) {
                    return;
                }
            } catch {
                // poll fallback should be non-fatal
            }

            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (qrPollGeneration.current === generation) {
            setTrackedQrState("timeout");
            setIsGeneratingQr(false);
            pairStartMinEventIdRef.current = -1;
            pairStartBoundaryEventIdRef.current = null;
        }
    }

    async function saveConfigValue(key: string) {
        if (!tenantId) return;
        const current = configValues[key] ?? "";
        const original = originalConfig[key] ?? "";
        if (current === original) return;

        setConfigBusyKey(key);
        setError("");
        try {
            const values = { ...configValues };
            const removeKeys = Object.keys(originalConfig).filter((existing) => !(existing in values));
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
            setConfigBusyKey(null);
        }
    }

    async function savePersona() {
        if (!tenantId) return;
        setPersonaBusy(true);
        setError("");
        setPersonaStatus("");

        try {
            await api(
                `/v1/tenants/${tenantId}/prompts/SOUL`,
                { method: "PUT", body: JSON.stringify({ content: persona }) },
                tokens.access_token,
            );
            setPersonaStatus("Assistant profile updated.");
            await loadPrompts(tenantId, tokens.access_token);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setPersonaBusy(false);
        }
    }

    async function connectGoogle() {
        if (!tenantId) return;

        setGoogleBusy(true);
        setError("");

        try {
            const data = await api<{ tenant_id: string; auth_url: string }>(
                `/v1/tenants/${tenantId}/google/connect/start`,
                { method: "POST" },
                tokens.access_token,
            );

            const popup = window.open(data.auth_url, "nexus_google_oauth", "popup=yes,width=520,height=700");
            if (!popup) {
                throw new Error("Popup blocked. Please allow popups and try again.");
            }
            googlePopupRef.current = popup;

            const controlOrigin = new URL(apiBase()).origin;
            stopGoogleStatusPolling();
            clearGoogleMessageHandler();

            googlePollIntervalRef.current = window.setInterval(() => {
                if (tenantId) {
                    void loadGoogleStatus(tenantId, tokens.access_token);
                }
                const popupClosed = !googlePopupRef.current || googlePopupRef.current.closed;
                if (popupClosed) {
                    stopGoogleStatusPolling();
                    clearGoogleMessageHandler();
                    setGoogleBusy(false);
                }
            }, 1500);

            const listener = (event: MessageEvent) => {
                if (event.origin !== controlOrigin) {
                    return;
                }
                const payload = event.data as { type?: string; status?: string; error?: string };
                if (payload?.type !== "google.oauth.result") {
                    return;
                }
                if (payload.status === "error" && payload.error) {
                    setError(payload.error);
                }
                stopGoogleStatusPolling();
                if (googlePopupRef.current && !googlePopupRef.current.closed) {
                    googlePopupRef.current.close();
                }
                googlePopupRef.current = null;
                setGoogleBusy(false);
                if (tenantId) {
                    void loadGoogleStatus(tenantId, tokens.access_token);
                }
                clearGoogleMessageHandler();
            };

            googleMessageHandlerRef.current = listener;
            window.addEventListener("message", listener);
        } catch (err) {
            setGoogleBusy(false);
            stopGoogleStatusPolling();
            clearGoogleMessageHandler();
            setError((err as Error).message);
        }
    }

    async function disconnectGoogle() {
        if (!tenantId) return;

        setGoogleBusy(true);
        setError("");

        try {
            await api(`/v1/tenants/${tenantId}/google/disconnect`, { method: "POST" }, tokens.access_token);
            await loadGoogleStatus(tenantId, tokens.access_token);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setGoogleBusy(false);
        }
    }

    useEffect(() => {
        const generation = qrRenderGenerationRef.current + 1;
        qrRenderGenerationRef.current = generation;

        if (!latestQr) {
            setQrImageDataUrl("");
            return;
        }

        void QRCode.toDataURL(latestQr, {
            width: 320,
            margin: 1,
            color: {
                dark: "#000000",
                light: "#FFD700",
            },
            errorCorrectionLevel: "M",
        })
            .then((dataUrl) => {
                if (qrRenderGenerationRef.current !== generation) return;
                setQrImageDataUrl(dataUrl);
            })
            .catch(() => {
                if (qrRenderGenerationRef.current !== generation) return;
                setQrImageDataUrl("");
            });
    }, [latestQr]);

    useEffect(() => {
        if (tenantBootstrapAttemptedToken.current === tokens.access_token) return;
        tenantBootstrapAttemptedToken.current = tokens.access_token;
        void loadTenant(tokens.access_token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokens]);

    useEffect(() => {
        if (!tenantId) return;
        if (assistantBootstrapTenantRef.current === tenantId) return;
        assistantBootstrapTenantRef.current = tenantId;
        void bootstrapAssistant(tenantId, tokens.access_token);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId, tokens.access_token]);

    useEffect(() => {
        return () => {
            stopGoogleStatusPolling();
            clearGoogleMessageHandler();
            if (googlePopupRef.current && !googlePopupRef.current.closed) {
                googlePopupRef.current.close();
            }
            googlePopupRef.current = null;
        };
    }, []);

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
            if (parsed.type === "runtime.status") {
                void fetchStatus(tenantId, tokens.access_token);
            }
        };

        return () => socket.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId, tokens]);

    useEffect(() => {
        if (status?.actual_state === "pending_pairing" && !latestQr && qrStateRef.current === "idle") {
            setTrackedQrState("waiting");
        }
    }, [latestQr, status?.actual_state]);

    useEffect(() => {
        stopQrPolling();
        stopGoogleStatusPolling();
        clearGoogleMessageHandler();
        if (googlePopupRef.current && !googlePopupRef.current.closed) {
            googlePopupRef.current.close();
        }
        googlePopupRef.current = null;

        latestEventIdRef.current = null;
        pairStartMinEventIdRef.current = -1;
        pairStartBoundaryEventIdRef.current = null;
        latestQrEventIdRef.current = -1;
        qrPollAfterEventIdRef.current = null;
        whatsappLinkEventIdRef.current = -1;

        setEvents([]);
        setTrackedQr("");
        setTrackedQrState("idle");
        setTrackedWhatsappLinkState("unknown");
        setIsGeneratingQr(false);

        setGoogleConnected(false);
        setGoogleScopes([]);
        setGoogleBusy(false);

        setPersonaStatus("");

        if (tenantId) {
            void loadRecentEvents(tenantId, tokens.access_token, "poll_latest", { limit: 20 });
            void loadGoogleStatus(tenantId, tokens.access_token);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logRows]);

    useEffect(() => {
        if (layoutInitializedRef.current) return;
        layoutInitializedRef.current = true;
        const desktop = window.matchMedia("(min-width: 1280px)").matches;
        // Default to OPEN right/bottom on desktop
        if (desktop) {
            setRightPanelOpen(true);
            setBottomPanelOpen(true);
            return;
        }
        setRightPanelOpen(false);
        setBottomPanelOpen(false);
    }, []);

    return (
        <div
            className="relative h-[100dvh] min-h-[100dvh] w-full flex flex-col bg-black/40 overflow-x-hidden overflow-y-auto text-white font-sans text-sm perspective-1000"
            style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
        >
            <header className="flex-none h-14 flex items-center justify-between px-6 border-b border-[rgba(255,255,255,0.08)] bg-black/60 backdrop-blur-md z-40 relative">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 relative">
                        <div className="absolute inset-0 bg-[--accent-gold] rounded-full opacity-20 animate-pulse" />
                        <div className="absolute inset-2 bg-[--accent-gold] rounded-full animate-ping" />
                    </div>
                    <h1 className="text-xl font-display font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-white to-[--text-secondary]">
                        NEXUS <span className="text-[--accent-gold]">COMMAND</span>
                    </h1>
                </div>

                <div className="flex-1 mx-8 overflow-hidden relative h-full flex items-center">
                    <div className="absolute inset-0 bg-gradient-to-r from-black via-transparent to-black z-10 pointer-events-none" />
                    <div className="whitespace-nowrap animate-marquee font-mono text-[10px] text-[--text-muted]">
                        :: SYSTEM_READY :: AWAITING_DIRECTIVE :: ENCRYPTION_Key_ROTATION_ACTIVE :: UPLINK_STABLE ::
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <span className="font-mono text-[10px] text-[--text-secondary]">
                        SESSION: {tenantId ? tenantId.substring(0, 8) : "INIT..."}
                    </span>
                    <button
                        onClick={onLogout}
                        className="px-4 py-1 border border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black font-mono text-xs transition-colors uppercase"
                    >
                        Disconnect
                    </button>
                    <button
                        onClick={() => setRightPanelOpen(!rightPanelOpen)}
                        className={`px-3 py-1 border font-mono text-xs transition-colors uppercase ${rightPanelOpen ? "bg-[--accent-gold] text-black border-[--accent-gold]" : "border-[--text-muted] text-[--text-muted]"}`}
                    >
                        MENU
                    </button>
                </div>
            </header>

            <main className="flex-1 relative flex min-h-0 overflow-hidden">

                {/* --- CENTER STAGE: OPS GRID --- */}
                <section className="flex-1 h-full overflow-y-auto p-4 lg:p-8 custom-scrollbar relative z-20">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 max-w-7xl mx-auto">

                        {/* 1. RUNTIME STATUS */}
                        <HudPanel title="RUNTIME_STATUS" className="h-64">
                            <div className="flex flex-col h-full justify-between">
                                <div className="flex items-center gap-4">
                                    <div className="relative w-24 h-24 flex items-center justify-center">
                                        <svg viewBox="0 0 100 100" className="w-full h-full animate-spin-slow-reverse opacity-80">
                                            <circle cx="50" cy="50" r="45" fill="none" stroke="#333" strokeWidth="2" strokeDasharray="4 2" />
                                            <circle cx="50" cy="50" r="40" fill="none" stroke="#444" strokeWidth="1" />
                                            <path d="M50 10 A40 40 0 0 1 90 50" fill="none" stroke="var(--accent-gold)" strokeWidth="2" />
                                        </svg>
                                        <div className="absolute text-center">
                                            <div className="text-xl font-display font-bold text-white">{runtimeIsActive ? "ON" : "OFF"}</div>
                                        </div>
                                    </div>
                                    <div className="flex-1 space-y-2">
                                        <div className="flex justify-between border-b border-white/10 pb-1">
                                            <span className="text-[--text-muted] text-[10px]">STATE</span>
                                            <span className="text-[--accent-gold] text-xs uppercase">{status?.actual_state ?? "--"}</span>
                                        </div>
                                        <div className="flex justify-between border-b border-white/10 pb-1">
                                            <span className="text-[--text-muted] text-[10px]">UPTIME</span>
                                            <span className="text-white text-xs">{status?.uptime ? Math.floor(status.uptime / 60) + "m" : "--"}</span>
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={() => void runOperation(runtimeIsActive ? "stop" : "start")}
                                    disabled={runtimeBusy}
                                    className={`w-full py-2 border transition-colors font-mono text-xs uppercase tracking-widest ${runtimeIsActive
                                        ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                        : "border-[--status-success] text-[--status-success] hover:bg-[--status-success] hover:text-black"}`}
                                >
                                    {runtimeIsActive ? "TERMINATE RUNTIME" : "INITIALIZE RUNTIME"}
                                </button>
                            </div>
                        </HudPanel>

                        {/* 2. UPLINK / WHATSAPP */}
                        <HudPanel title="UPLINK_BRIDGE" className="h-64 md:col-span-1 xl:col-span-1">
                            <div className="flex flex-col h-full justify-between">
                                <div>
                                    <div className="flex items-center gap-2 mb-4">
                                        <div className={`w-3 h-3 rounded-full ${whatsappIsConnected ? "bg-[#25D366] shadow-[0_0_10px_#25D366]" : "bg-[--status-error]"}`} />
                                        <span className="font-mono text-xs text-white">{whatsappStatusText}</span>
                                    </div>
                                    {!whatsappIsConnected && (
                                        <div className="p-3 bg-white/5 border border-white/10 rounded-sm mb-4">
                                            <p className="text-[10px] text-[--text-muted] mb-2">
                                                Scan the QR code to link your WhatsApp account.
                                            </p>
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => void runOperation(whatsappIsConnected ? "whatsapp/disconnect" : "pair/start")}
                                    disabled={runtimeBusy}
                                    className={`w-full py-2 border transition-colors font-mono text-xs uppercase tracking-widest ${whatsappIsConnected
                                        ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                        : "border-[#25D366] text-[#25D366] hover:bg-[#25D366] hover:text-black"}`}
                                >
                                    {whatsappIsConnected ? "SEVER CONNECTION" : "GENERATE QR LINK"}
                                </button>
                            </div>
                        </HudPanel>

                        {/* 3. QR MATRIX (Shows only when needed) */}
                        <AnimatePresence>
                            {(qrState === "waiting" || qrState === "ready" || qrState === "timeout") && !whatsappIsConnected && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    className="h-64 md:col-span-2 xl:col-span-1"
                                >
                                    <HudPanel title="QR_MATRIX" variant="warning" className="h-full">
                                        <div className="flex flex-col items-center justify-center h-full gap-4">
                                            {qrImageDataUrl ? (
                                                <div className="relative group cursor-none">
                                                    <img src={qrImageDataUrl} alt="WhatsApp QR" className="w-40 h-40 rounded-sm border border-[--accent-gold] p-1 bg-white" />
                                                    <div className="absolute inset-0 bg-[--accent-gold] opacity-0 group-hover:opacity-10 transition-opacity mix-blend-overlay" />
                                                </div>
                                            ) : (
                                                <div className="w-40 h-40 flex items-center justify-center bg-black/40 border border-white/10 text-[10px] text-[--text-muted] font-mono text-center whitespace-pre-line px-3 animate-pulse">
                                                    {qrState === "waiting"
                                                        ? isGeneratingQr
                                                            ? "GENERATING QR\nRESTARTING RUNTIME..."
                                                            : "WAITING FOR\nFRESH QR..."
                                                        : qrState === "timeout"
                                                            ? "QR TIMEOUT\nTRY AGAIN"
                                                            : "PREPARING..."}
                                                </div>
                                            )}
                                            <p className="text-[10px] font-mono text-[--accent-gold] animate-pulse">
                                                SCAN WITH WHATSAPP (LINKED DEVICES)
                                            </p>
                                        </div>
                                    </HudPanel>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* 4. GOOGLE SERVICES */}
                        <HudPanel title="EXTERNAL_SERVICES" className="h-64">
                            <div className="flex flex-col h-full justify-between">
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between p-3 bg-white/5 border-l-2 border-[#4285F4]">
                                        <div>
                                            <div className="text-xs font-bold text-white mb-1">GOOGLE</div>
                                            <div className="text-[9px] text-[--text-muted]">{googleStatusText}</div>
                                        </div>
                                        <div className={`w-2 h-2 rounded-full ${googleConnected ? "bg-[#4285F4]" : "bg-[--text-muted]"}`} />
                                    </div>
                                    {googleScopes.length > 0 && (
                                        <div className="p-2 border border-white/10 bg-black/40 text-[9px] font-mono text-[--text-muted] break-all h-24 overflow-y-auto custom-scrollbar">
                                            <span className="text-[#4285F4]">SCOPES_GRANTED:</span> {googleScopes.join(", ")}
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => {
                                        if (googleConnected) void disconnectGoogle();
                                        else void connectGoogle();
                                    }}
                                    disabled={googleBusy || runtimeBusy}
                                    className={`w-full py-2 border transition-colors font-mono text-xs uppercase tracking-widest ${googleConnected
                                        ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                        : "border-[#4285F4] text-[#4285F4] hover:bg-[#4285F4] hover:text-white"}`}
                                >
                                    {googleBusy ? "NEGOTIATING..." : googleConnected ? "REVOKE ACCESS" : "CONNECT GOOGLE"}
                                </button>
                            </div>
                        </HudPanel>

                    </div>

                    {/* Placeholder for future widgets */}
                    <div className="h-32"></div>

                </section>

                {/* --- RIGHT PANEL: CONFIG & SOUL (Retractable) --- */}
                <AnimatePresence>
                    {rightPanelOpen && (
                        <motion.aside
                            initial={{ x: 320, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: 320, opacity: 0 }}
                            className="absolute right-0 top-0 h-full w-[min(24rem,90vw)] lg:relative lg:w-96 bg-black/90 backdrop-blur-xl border-l border-[rgba(255,255,255,0.1)] z-40 flex flex-col shadow-2xl"
                        >
                            {/* Tabs */}
                            <div className="flex border-b border-[rgba(255,255,255,0.1)]">
                                <button
                                    onClick={() => setActiveTab("config")}
                                    className={`flex-1 py-3 text-xs font-mono tracking-widest transition-colors ${activeTab === "config" ? "bg-[--accent-gold] text-black font-bold" : "text-[--text-muted] hover:text-white"}`}
                                >
                                    [SYSTEM_CONFIG]
                                </button>
                                <button
                                    onClick={() => setActiveTab("soul")}
                                    className={`flex-1 py-3 text-xs font-mono tracking-widest transition-colors ${activeTab === "soul" ? "bg-[--accent-gold] text-black font-bold" : "text-[--text-muted] hover:text-white"}`}
                                >
                                    [AGENT_SOUL]
                                </button>
                            </div>

                            {/* Content Window */}
                            <div className="flex-1 overflow-hidden relative">
                                <AnimatePresence mode="wait">
                                    {activeTab === "config" ? (
                                        <motion.div
                                            key="config"
                                            initial={{ opacity: 0, x: 20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -20 }}
                                            transition={{ duration: 0.2 }}
                                            className="absolute inset-0 overflow-y-auto p-4 space-y-6 custom-scrollbar"
                                        >
                                            <div className="p-4 border border-[--accent-gold] bg-[--accent-gold]/5 mb-4">
                                                <h3 className="text-[--accent-gold] text-xs font-bold mb-1">ENVIRONMENT VARIABLES</h3>
                                                <p className="text-[10px] text-[--text-muted]">Manage sensitive keys and runtime flags.</p>
                                            </div>

                                            {configManifest.groups.length === 0 && (
                                                <p className="text-[10px] font-mono text-[--text-muted]">No config loaded.</p>
                                            )}
                                            {configManifest.groups.map((group) => (
                                                <div key={group.category} className="space-y-3">
                                                    <h3 className="font-mono text-[10px] text-[--text-secondary] uppercase tracking-widest pl-2 border-l border-[--accent-gold]">
                                                        {group.category}
                                                    </h3>
                                                    <div className="space-y-2">
                                                        {group.items.map((item) => {
                                                            const isSaving = configBusyKey === item.key;
                                                            return (
                                                                <div key={item.key} className="group/item relative">
                                                                    <label className="block text-[9px] font-mono text-[--text-muted] mb-1 truncate">{item.key}</label>
                                                                    <div className="relative">
                                                                        <input
                                                                            type={item.is_secret ? "password" : "text"}
                                                                            value={configValues[item.key] ?? ""}
                                                                            onChange={(e) => {
                                                                                const next = e.target.value;
                                                                                setConfigValues((prev) => ({ ...prev, [item.key]: next }));
                                                                            }}
                                                                            onBlur={() => void saveConfigValue(item.key)}
                                                                            disabled={isSaving}
                                                                            className="w-full bg-white/5 border border-white/10 px-2 py-1.5 font-mono text-[10px] text-[--accent-gold] focus:border-[--accent-gold] focus:outline-none transition-colors group-hover/item:border-white/20 disabled:opacity-50"
                                                                        />
                                                                        {item.is_secret && (
                                                                            <div className="absolute inset-0 bg-black/90 flex items-center px-3 opacity-100 group-hover/item:opacity-0 transition-opacity pointer-events-none border border-white/5">
                                                                                <span className="text-[9px] text-[--text-muted] tracking-widest">ENCRYPTED_VALUE</span>
                                                                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" />
                                                                            </div>
                                                                        )}
                                                                        {isSaving && (
                                                                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] text-[--text-muted] font-mono">SAVING</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            ))}
                                        </motion.div>
                                    ) : (
                                        <motion.div
                                            key="soul"
                                            initial={{ opacity: 0, x: 20 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -20 }}
                                            transition={{ duration: 0.2 }}
                                            className="absolute inset-0 overflow-y-auto p-4 custom-scrollbar flex flex-col"
                                        >
                                            <div className="p-4 border border-white/10 bg-white/5 mb-4">
                                                <h3 className="text-white text-xs font-bold mb-1">PERSONA TUNING</h3>
                                                <p className="text-[10px] text-[--text-muted]">Modify behavioral parameters.</p>
                                            </div>

                                            <div className="flex-1 relative border border-white/10 bg-black">
                                                <textarea
                                                    value={persona}
                                                    onChange={(e) => setPersona(e.target.value)}
                                                    className="w-full h-full bg-transparent p-3 font-mono text-[10px] text-[--text-primary] resize-none focus:outline-none custom-scrollbar"
                                                    placeholder="// Define Agent persona..."
                                                />
                                                {/* Decorative Waveform */}
                                                <div className="absolute bottom-2 right-2 pointer-events-none opacity-50">
                                                    <svg width="40" height="20" viewBox="0 0 40 20" className="stroke-[--accent-gold] fill-none">
                                                        <path d="M0 10 Q 5 0, 10 10 T 20 10 T 30 10 T 40 10" className="animate-pulse" />
                                                    </svg>
                                                </div>
                                            </div>

                                            <button
                                                onClick={() => void savePersona()}
                                                disabled={personaBusy}
                                                className="mt-4 w-full py-2 bg-[--accent-gold] text-black font-bold font-display tracking-wider hover:bg-white transition-colors disabled:opacity-50 text-xs"
                                            >
                                                {personaBusy ? "UPLOADING..." : "UPLOAD NEW MATRIX"}
                                            </button>
                                            {personaStatus && (
                                                <p className="mt-2 text-[9px] font-mono text-[--status-success] text-center">{personaStatus}</p>
                                            )}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>

            </main>

            {/* === BOTTOM DRAWER: LOGS === */}
            <AnimatePresence>
                {bottomPanelOpen && (
                    <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: "16rem" }}
                        exit={{ height: 0 }}
                        className="flex-none bg-black/95 border-t border-[rgba(255,255,255,0.1)] relative z-50 flex flex-col"
                    >
                        {/* Drawer Handle */}
                        <div
                            onClick={() => setBottomPanelOpen(false)}
                            className="h-6 bg-[#1a1a1a] flex items-center justify-between px-4 cursor-pointer hover:bg-[#222]"
                        >
                            <span className="text-[10px] font-mono text-[--text-muted]">SYSTEM_EVENT_LOGS --tail -f</span>
                            <span className="text-[10px] text-[--accent-gold]">▼ CLOSE</span>
                        </div>

                        {/* Logs Content */}
                        <div className="flex-1 p-4 font-mono text-xs overflow-auto custom-scrollbar space-y-1 relative">
                            <div className="absolute inset-0 pointer-events-none bg-[url('/scan-texture.png')] opacity-[0.05] mix-blend-overlay" />
                            {logRows.length === 0 && (
                                <div className="text-[--text-muted] italic opacity-50 text-center mt-10">Waiting for system events...</div>
                            )}
                            {logRows.map((log, i) => (
                                <div key={`${log.source}-${i}`} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                                    <span className="text-[--text-muted] shrink-0 font-light text-[10px] w-24">
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </span>
                                    <span
                                        className={`shrink-0 font-bold w-12 ${log.level === "ERROR"
                                            ? "text-[--status-error]"
                                            : log.level === "WARN"
                                                ? "text-[--status-warning]"
                                                : "text-[--status-success]"
                                            }`}
                                    >
                                        {log.level}
                                    </span>
                                    <span className="text-[--accent-gold] opacity-80 group-hover:text-white transition-colors break-all">
                                        {log.message}
                                    </span>
                                </div>
                            ))}
                            <div ref={logEndRef} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Collapse Toggle for Bottom Drawer (Status Bar) */}
            {!bottomPanelOpen && (
                <footer
                    onClick={() => setBottomPanelOpen(true)}
                    className="h-8 bg-black border-t border-[rgba(255,255,255,0.1)] flex items-center justify-between px-4 z-40 relative cursor-pointer hover:bg-white/5 transition-colors"
                >
                    <div className="flex items-center gap-4 text-[10px] font-mono text-[--text-muted]">
                        <span>
                            STATE: <span className="text-[--status-success] uppercase">{status?.actual_state ?? "unknown"}</span>
                        </span>
                        <span>
                            LOGS: <span className="text-[--accent-gold]">{events.length} EVENTS</span>
                        </span>
                    </div>
                    <span className="text-[10px] font-display font-bold tracking-widest text-[--accent-gold]">▲ OPEN CONSOLE</span>
                </footer>
            )}

            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[60] px-4 py-2 border border-[--status-error] text-[--status-error] bg-black/90 font-mono text-xs max-w-[70%] text-center shadow-lg backdrop-blur-md"
                    >
                        {error}
                        <button onClick={() => setError("")} className="ml-4 underline opacity-50 hover:opacity-100">DISMISS</button>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
