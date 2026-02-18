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

    const [leftPanelOpen, setLeftPanelOpen] = useState(true);
    const [rightPanelOpen, setRightPanelOpen] = useState(true);
    const [bottomPanelOpen, setBottomPanelOpen] = useState(false);

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

    return (
        <div className="relative h-screen w-full flex flex-col bg-black/40 overflow-hidden text-white font-sans text-sm perspective-1000">
            <header className="flex-none h-14 flex items-center justify-between px-6 border-b border-[rgba(255,255,255,0.08)] bg-black/60 backdrop-blur-md z-40 relative">
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 relative">
                        <Orb hue={40} hoverIntensity={0} />
                    </div>
                    <h1 className="font-display font-bold text-xl tracking-widest text-shadow-glow">
                        <span className="text-white">NEXUS</span>
                        <span className="text-[--accent-gold]">_COMMAND</span>
                    </h1>
                </div>

                <div className="flex-1 mx-8 overflow-hidden relative h-full flex items-center">
                    <div className="absolute inset-0 bg-gradient-to-r from-black via-transparent to-black z-10 pointer-events-none" />
                    <div className="whitespace-nowrap animate-marquee font-mono text-[10px] text-[--text-muted]">
                        SYSTEM_STATUS: ONLINE // UPLINK_STABLE // ENCRYPTION: AES-256 // AGENT_MODE: AUTONOMOUS // NEXUS_CORE_VERSION: 2.4.1 //
                        SYSTEM_STATUS: ONLINE // UPLINK_STABLE // ENCRYPTION: AES-256 // AGENT_MODE: AUTONOMOUS // NEXUS_CORE_VERSION: 2.4.1 //
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
                </div>
            </header>

            <main className="flex-1 relative flex overflow-hidden">
                <AnimatePresence mode="wait">
                    {leftPanelOpen && (
                        <motion.aside
                            initial={{ x: -300, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: -300, opacity: 0 }}
                            className="w-80 h-full p-4 flex flex-col gap-4 z-30"
                        >
                            <HudPanel title="VITALS_MONITOR" className="flex-none h-64">
                                <div className="relative w-full h-full flex items-center justify-center">
                                    <svg viewBox="0 0 100 100" className="w-40 h-40 animate-spin-slow-reverse opacity-80">
                                        <circle cx="50" cy="50" r="45" fill="none" stroke="#333" strokeWidth="2" strokeDasharray="4 2" />
                                        <circle cx="50" cy="50" r="40" fill="none" stroke="#444" strokeWidth="1" />
                                    </svg>
                                    <svg viewBox="0 0 100 100" className="w-32 h-32 absolute animate-spin-slow">
                                        <path d="M50 10 A40 40 0 0 1 90 50" fill="none" stroke="var(--accent-gold)" strokeWidth="4" />
                                        <path d="M50 90 A40 40 0 0 1 10 50" fill="none" stroke="var(--accent-gold)" strokeWidth="2" opacity="0.5" />
                                    </svg>
                                    <div className="absolute text-center">
                                        <div className="text-3xl font-display font-bold text-white">{runtimeIsActive ? "100" : "0"}%</div>
                                        <div className="text-[8px] font-mono text-[--text-muted]">SYS_LOAD</div>
                                    </div>
                                </div>
                                <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] font-mono">
                                    <div className="flex justify-between border-b border-white/10 pb-1">
                                        <span className="text-[--text-muted]">STATE</span>
                                        <span className="text-[--accent-gold] uppercase">{status?.actual_state ?? "--"}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-white/10 pb-1">
                                        <span className="text-[--text-muted]">H_BEAT</span>
                                        <span className="text-[--status-success]">{status?.last_heartbeat ? "OK" : "--"}</span>
                                    </div>
                                </div>
                            </HudPanel>

                            <HudPanel title="UPLINK_STATUS" className="flex-1">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-3 p-2 bg-white/5 border-l-2 border-[--status-success]">
                                        <div className="flex-1">
                                            <div className="text-xs font-bold text-white mb-1">RUNTIME</div>
                                            <div className="text-[9px] text-[--text-muted] uppercase">{status?.actual_state ?? "unknown"}</div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                void runOperation(runtimeIsActive ? "stop" : "start");
                                            }}
                                            disabled={runtimeBusy}
                                            className={`text-[9px] px-2 py-1 border transition-colors ${runtimeIsActive
                                                ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                                : "border-[--status-success] text-[--status-success] hover:bg-[--status-success] hover:text-black"}`}
                                        >
                                            {runtimeIsActive ? "STOP" : "START"}
                                        </button>
                                    </div>

                                    <div className="flex items-center gap-3 p-2 bg-white/5 border-l-2 border-[#25D366]">
                                        <div className="flex-1">
                                            <div className="text-xs font-bold text-white mb-1">WHATSAPP BRIDGE</div>
                                            <div className="text-[9px] text-[--text-muted]">STATUS: {whatsappStatusText}</div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                void runOperation(whatsappIsConnected ? "whatsapp/disconnect" : "pair/start");
                                            }}
                                            disabled={runtimeBusy}
                                            className={`text-[9px] px-2 py-1 border transition-colors ${whatsappIsConnected
                                                ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                                : "border-[--accent-gold] text-[--accent-gold] hover:bg-[--accent-gold] hover:text-black"}`}
                                        >
                                            {whatsappIsConnected ? "DISCONNECT" : "GENERATE QR"}
                                        </button>
                                    </div>

                                    {(qrState === "waiting" || qrState === "ready" || qrState === "timeout") && !whatsappIsConnected && (
                                        <div className="p-3 bg-white/5 border border-white/10 rounded-sm flex flex-col items-center gap-2">
                                            <div className="text-[9px] text-[--accent-gold] font-mono tracking-wider">SCAN TO AUTHENTICATE</div>
                                            {qrImageDataUrl ? (
                                                <img src={qrImageDataUrl} alt="WhatsApp QR" className="w-36 h-36 rounded" />
                                            ) : (
                                                <div className="w-36 h-36 flex items-center justify-center bg-black/40 border border-white/10 text-[10px] text-[--text-muted] font-mono text-center whitespace-pre-line px-3">
                                                    {qrState === "waiting"
                                                        ? isGeneratingQr
                                                            ? "GENERATING QR\nRESTARTING RUNTIME..."
                                                            : "WAITING FOR\nFRESH QR..."
                                                        : qrState === "timeout"
                                                            ? "QR TIMEOUT\nTRY AGAIN"
                                                            : "PREPARING..."}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div className="flex items-start gap-3 p-2 bg-white/5 border-l-2 border-[#4285F4]">
                                        <div className="flex-1">
                                            <div className="text-xs font-bold text-white mb-1">GOOGLE SERVICES</div>
                                            <div className="text-[9px] text-[--text-muted]">{googleStatusText}</div>
                                            {googleScopes.length > 0 && (
                                                <div className="text-[8px] text-[--text-muted] mt-1 break-all">
                                                    SCOPES: {googleScopes.join(", ")}
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            onClick={() => {
                                                if (googleConnected) {
                                                    void disconnectGoogle();
                                                } else {
                                                    void connectGoogle();
                                                }
                                            }}
                                            disabled={googleBusy || runtimeBusy}
                                            className={`text-[9px] px-2 py-1 border transition-colors ${googleConnected
                                                ? "border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black"
                                                : "border-[#4285F4] text-[#4285F4] hover:bg-[#4285F4] hover:text-white"}`}
                                        >
                                            {googleBusy ? "CONNECTING" : googleConnected ? "DISCONNECT" : "CONNECT"}
                                        </button>
                                    </div>
                                </div>
                            </HudPanel>
                        </motion.aside>
                    )}
                </AnimatePresence>

                <button
                    onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-50 w-4 h-12 bg-[--accent-gold] flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
                >
                    <span className="text-black text-[10px] transform -rotate-90">{leftPanelOpen ? "<" : ">"}</span>
                </button>

                <section className="flex-1 h-full p-4 relative z-20 flex flex-col gap-4">
                    <div className="flex-1 relative bg-black/80 border border-[rgba(255,255,255,0.1)] rounded-sm overflow-hidden flex flex-col shadow-2xl">
                        <div className="h-8 bg-[#1a1a1a] flex items-center px-4 border-b border-[rgba(255,255,255,0.05)]">
                            <div className="flex gap-2">
                                <div className="w-2 h-2 rounded-full bg-[--status-error] opacity-50" />
                                <div className="w-2 h-2 rounded-full bg-[--accent-amber] opacity-50" />
                                <div className="w-2 h-2 rounded-full bg-[--status-success] opacity-50" />
                            </div>
                            <span className="mx-auto text-[10px] font-mono text-[--text-muted]">root@nexus-core:~/logs --watch</span>
                        </div>

                        <div className="flex-1 p-4 font-mono text-xs overflow-auto custom-scrollbar space-y-1 relative">
                            <div className="absolute inset-0 pointer-events-none bg-[url('/scan-texture.png')] opacity-[0.05] mix-blend-overlay" />

                            {logRows.length === 0 && (
                                <div className="text-[--text-muted] italic opacity-50 text-center mt-20">Waiting for system events...</div>
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
                                    <span className="text-[--accent-gold] opacity-80 group-hover:text-white transition-colors">
                                        {log.message}
                                    </span>
                                </div>
                            ))}
                            <div ref={logEndRef} />
                        </div>
                    </div>

                    <AnimatePresence>
                        {bottomPanelOpen && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                className="bg-black/90 border-t border-[--accent-gold] p-6 relative overflow-hidden"
                            >
                                <div className="absolute inset-0 bg-gradient-to-t from-[--accent-gold] to-transparent opacity-5 pointer-events-none" />

                                <div className="flex justify-between items-start gap-8">
                                    <div className="w-1/3">
                                        <h3 className="text-xl font-display font-bold text-[--accent-gold] mb-2">AGENT&apos;S PERSONA</h3>
                                        <p className="text-xs text-[--text-muted] font-mono w-64">
                                            Modify SOUL behavior for this tenant. Updates apply immediately.
                                        </p>
                                        <div className="mt-4">
                                            <button
                                                onClick={() => {
                                                    void savePersona();
                                                }}
                                                disabled={personaBusy}
                                                className="px-6 py-2 bg-[--accent-gold] text-black font-bold font-display tracking-wider hover:bg-white transition-colors clip-path-button disabled:opacity-40"
                                                style={{ clipPath: "polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)" }}
                                            >
                                                {personaBusy ? "SAVING..." : "UPLOAD NEW MATRIX"}
                                            </button>
                                            {personaStatus && (
                                                <p className="mt-2 text-[10px] font-mono text-[--status-success]">{personaStatus}</p>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex-1 bg-black border border-[rgba(255,255,255,0.1)] p-1 relative">
                                        <textarea
                                            value={persona}
                                            onChange={(e) => setPersona(e.target.value)}
                                            className="w-full h-32 bg-transparent text-[--accent-gold] font-mono text-xs p-4 focus:outline-none resize-none"
                                            placeholder="// Enter system prompt..."
                                        />
                                        <div className="absolute bottom-2 right-2 flex gap-1">
                                            <div className="w-1 h-1 bg-[--accent-gold] animate-pulse" />
                                            <div className="w-1 h-1 bg-[--accent-gold] animate-pulse delay-75" />
                                            <div className="w-1 h-1 bg-[--accent-gold] animate-pulse delay-150" />
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </section>

                <AnimatePresence>
                    {rightPanelOpen && (
                        <motion.aside
                            initial={{ x: 300, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: 300, opacity: 0 }}
                            className="w-80 h-full bg-black/80 backdrop-blur-xl border-l border-[rgba(255,255,255,0.1)] z-30 flex flex-col"
                        >
                            <div className="p-4 border-b border-[rgba(255,255,255,0.05)]">
                                <h2 className="font-display font-bold text-[--accent-gold]">SYSTEM_CONFIG</h2>
                                <div className="h-[1px] w-full bg-gradient-to-r from-[--accent-gold] to-transparent opacity-50 mt-2" />
                            </div>

                            <div className="flex-1 overflow-auto p-4 space-y-6 custom-scrollbar">
                                {configManifest.groups.length === 0 && (
                                    <p className="text-[10px] font-mono text-[--text-muted]">No config loaded.</p>
                                )}
                                {configManifest.groups.map((group) => (
                                    <div key={group.category} className="space-y-3">
                                        <h3 className="font-mono text-xs text-[--text-secondary] uppercase tracking-widest pl-2 border-l border-[--accent-gold]">
                                            {group.category}
                                        </h3>
                                        <div className="space-y-2">
                                            {group.items.map((item) => {
                                                const isSaving = configBusyKey === item.key;
                                                return (
                                                    <div key={item.key} className="group/item relative">
                                                        <label className="block text-[10px] font-mono text-[--text-muted] mb-1">{item.key}</label>
                                                        <div className="relative">
                                                            <input
                                                                type={item.is_secret ? "password" : "text"}
                                                                value={configValues[item.key] ?? ""}
                                                                onChange={(e) => {
                                                                    const next = e.target.value;
                                                                    setConfigValues((prev) => ({ ...prev, [item.key]: next }));
                                                                }}
                                                                onBlur={() => {
                                                                    void saveConfigValue(item.key);
                                                                }}
                                                                disabled={isSaving}
                                                                className="w-full bg-white/5 border border-white/10 px-3 py-2 font-mono text-xs text-[--accent-gold] focus:border-[--accent-gold] focus:outline-none transition-colors group-hover/item:border-white/20 disabled:opacity-50"
                                                            />
                                                            {item.is_secret && (
                                                                <div className="absolute inset-0 bg-black/90 flex items-center px-3 opacity-100 group-hover/item:opacity-0 transition-opacity pointer-events-none border border-white/5">
                                                                    <span className="text-[10px] text-[--text-muted] tracking-widest">ENCRYPTED_VALUE</span>
                                                                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" />
                                                                </div>
                                                            )}
                                                            {isSaving && (
                                                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-[--text-muted] font-mono">
                                                                    SAVING
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>

                <button
                    onClick={() => setRightPanelOpen(!rightPanelOpen)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 z-50 w-4 h-12 bg-[--accent-gold] flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
                >
                    <span className="text-black text-[10px] transform -rotate-90">{rightPanelOpen ? ">" : "<"}</span>
                </button>
            </main>

            <footer className="h-8 bg-black border-t border-[rgba(255,255,255,0.1)] flex items-center justify-between px-4 z-40 relative">
                <div className="flex items-center gap-4 text-[10px] font-mono text-[--text-muted]">
                    <span>
                        STATE: <span className="text-[--status-success] uppercase">{status?.actual_state ?? "unknown"}</span>
                    </span>
                    <span>
                        LINK: <span className="text-[--accent-gold]">{whatsappLinkState.toUpperCase()}</span>
                    </span>
                    <span>
                        HEARTBEAT: <span className="text-[--status-success]">{status?.last_heartbeat ? "ACTIVE" : "--"}</span>
                    </span>
                </div>

                <button
                    onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
                    className={`h-full px-6 flex items-center gap-2 border-l border-r border-[rgba(255,255,255,0.1)] hover:bg-white/5 transition-colors ${bottomPanelOpen
                        ? "bg-[--accent-gold] text-black border-[--accent-gold]"
                        : "text-[--accent-gold]"
                        }`}
                >
                    <span className="text-[10px] font-display font-bold tracking-widest">
                        {bottomPanelOpen ? "CLOSE TUNING" : "PERSONA TUNING"}
                    </span>
                    <div
                        className={`w-2 h-2 border-t border-r border-current transform transition-transform ${bottomPanelOpen ? "rotate-[-45deg] mt-1" : "rotate-[135deg] mb-1"
                            }`}
                    />
                </button>
            </footer>

            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-12 left-1/2 -translate-x-1/2 z-50 px-4 py-2 border border-[--status-error] text-[--status-error] bg-black/90 font-mono text-xs max-w-[70%] text-center"
                    >
                        {error}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
