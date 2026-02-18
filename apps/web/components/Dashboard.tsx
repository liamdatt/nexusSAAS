"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, Tokens, WS_URL } from "@/lib/api";
import HudPanel from "./ui/HudPanel";
import Orb from "./ui/Orb";

type DashboardProps = {
    tokens: Tokens;
    onLogout: () => void;
};

// ... Types (same as before) ...
type TenantStatus = {
    active: boolean;
    instance_id: string;
    uptime: number;
    last_heartbeat: string;
};

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

export default function Dashboard({ tokens, onLogout }: DashboardProps) {
    // State
    const [status, setStatus] = useState<TenantStatus | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [config, setConfig] = useState<ConfigManifest | null>(null);
    const [persona, setPersona] = useState<string>("");
    const [qrCode, setQrCode] = useState<string | null>(null);
    const [googleAuthUrl, setGoogleAuthUrl] = useState<string | null>(null);

    // UI State - Tactical HUD
    const [leftPanelOpen, setLeftPanelOpen] = useState(true);
    const [rightPanelOpen, setRightPanelOpen] = useState(true);
    const [bottomPanelOpen, setBottomPanelOpen] = useState(false);

    const logEndRef = useRef<HTMLDivElement>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // ... Logic (same as before, concise for brevity) ...
    const fetchStatus = useCallback(async () => {
        try {
            const data = await api<TenantStatus>("/v1/system/status", {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            setStatus(data);
        } catch (e) { console.error(e); }
    }, [tokens]);

    const fetchConfig = useCallback(async () => {
        try {
            const data = await api<ConfigManifest>("/v1/config/manifest", {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            setConfig(data);
        } catch (e) { console.error(e); }
    }, [tokens]);

    const fetchPersona = useCallback(async () => {
        try {
            const data = await api<{ prompt: string }>("/v1/agent/persona", {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            setPersona(data.prompt);
        } catch (e) {
            if ((e as Error).message.includes("404")) setPersona("");
            else console.error(e);
        }
    }, [tokens]);

    const fetchQr = useCallback(async () => {
        try {
            // In a real app, this endpoint would return the QR code data or image URL
            // Using a placeholder for now as per previous implementation logic
            setQrCode("placeholder_qr");
        } catch (e) { console.error(e); }
    }, []);

    const saveConfig = async (key: string, value: string) => {
        try {
            await api("/v1/config", {
                method: "PUT",
                headers: { Authorization: `Bearer ${tokens.access_token}` },
                body: JSON.stringify({ key, value }),
            });
            await fetchConfig();
        } catch (e) { console.error(e); alert("Failed to save config"); }
    };

    const savePersona = async () => {
        try {
            await api("/v1/agent/persona", {
                method: "PUT",
                headers: { Authorization: `Bearer ${tokens.access_token}` },
                body: JSON.stringify({ prompt: persona }),
            });
            alert("Persona updated.");
        } catch (e) { console.error(e); alert("Failed to update persona"); }
    };

    useEffect(() => {
        fetchStatus();
        fetchConfig();
        fetchPersona();
        fetchQr();

        // WebSocket
        const wsUrl = `${WS_URL}/v1/ws/logs?token=${tokens.access_token}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                setLogs((prev) => [...prev.slice(-99), data]); // Keep last 100
            } catch (e) { console.error("WS Parse Error", e); }
        };

        return () => {
            ws.close();
        };
    }, [tokens, fetchStatus, fetchConfig, fetchPersona, fetchQr]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [logs]);


    // --- RENDER ---

    return (
        <div className="relative h-screen w-full flex flex-col bg-black/40 overflow-hidden text-white font-sans text-sm perspective-1000">

            {/* === TOP HUD STRIP === */}
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

                {/* Scrolling Ticker */}
                <div className="flex-1 mx-8 overflow-hidden relative h-full flex items-center">
                    <div className="absolute inset-0 bg-gradient-to-r from-black via-transparent to-black z-10 pointer-events-none" />
                    <div className="whitespace-nowrap animate-marquee font-mono text-[10px] text-[--text-muted]">
                        SYSTEM_STATUS: ONLINE // UPLINK_STABLE // ENCRYPTION: AES-256 // AGENT_MODE: AUTONOMOUS // NEXUS_CORE_VERSION: 2.4.1 //
                        SYSTEM_STATUS: ONLINE // UPLINK_STABLE // ENCRYPTION: AES-256 // AGENT_MODE: AUTONOMOUS // NEXUS_CORE_VERSION: 2.4.1 //
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <span className="font-mono text-[10px] text-[--text-secondary]">SESSION: {status?.instance_id?.substring(0, 8) || "INIT..."}</span>
                    <button
                        onClick={onLogout}
                        className="px-4 py-1 border border-[--status-error] text-[--status-error] hover:bg-[--status-error] hover:text-black font-mono text-xs transition-colors uppercase"
                    >
                        Disconnect
                    </button>
                </div>
            </header>


            {/* === MAIN VIEWPORT === */}
            <main className="flex-1 relative flex overflow-hidden">

                {/* --- LEFT PANEL: STATUS & VITALS (Retractable) --- */}
                <AnimatePresence mode="wait">
                    {leftPanelOpen && (
                        <motion.aside
                            initial={{ x: -300, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: -300, opacity: 0 }}
                            className="w-80 h-full p-4 flex flex-col gap-4 z-30"
                        >
                            {/* Vitals Widget */}
                            <HudPanel title="VITALS_MONITOR" className="flex-none h-64">
                                <div className="relative w-full h-full flex items-center justify-center">
                                    {/* SVG Gauge */}
                                    <svg viewBox="0 0 100 100" className="w-40 h-40 animate-spin-slow-reverse opacity-80">
                                        <circle cx="50" cy="50" r="45" fill="none" stroke="#333" strokeWidth="2" strokeDasharray="4 2" />
                                        <circle cx="50" cy="50" r="40" fill="none" stroke="#444" strokeWidth="1" />
                                    </svg>
                                    <svg viewBox="0 0 100 100" className="w-32 h-32 absolute animate-spin-slow">
                                        <path d="M50 10 A40 40 0 0 1 90 50" fill="none" stroke="var(--accent-gold)" strokeWidth="4" />
                                        <path d="M50 90 A40 40 0 0 1 10 50" fill="none" stroke="var(--accent-gold)" strokeWidth="2" opacity="0.5" />
                                    </svg>
                                    <div className="absolute text-center">
                                        <div className="text-3xl font-display font-bold text-white">{status?.active ? "100" : "0"}%</div>
                                        <div className="text-[8px] font-mono text-[--text-muted]">SYS_LOAD</div>
                                    </div>
                                </div>
                                <div className="mt-4 grid grid-cols-2 gap-2 text-[10px] font-mono">
                                    <div className="flex justify-between border-b border-white/10 pb-1">
                                        <span className="text-[--text-muted]">UPTIME</span>
                                        <span className="text-[--accent-gold]">{status?.uptime ? Math.floor(status.uptime / 60) + "m" : "--"}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-white/10 pb-1">
                                        <span className="text-[--text-muted]">H_BEAT</span>
                                        <span className="text-[--status-success]">OK</span>
                                    </div>
                                </div>
                            </HudPanel>

                            {/* Uplink Status */}
                            <HudPanel title="UPLINK_STATUS" className="flex-1">
                                <div className="space-y-4">
                                    <div className="flex items-center gap-3 p-2 bg-white/5 border-l-2 border-[#25D366]">
                                        <div className="flex-1">
                                            <div className="text-xs font-bold text-white mb-1">WHATSAPP BRIDGE</div>
                                            <div className="text-[9px] text-[--text-muted]">STATUS: {qrCode ? "READY_TO_SCAN" : "CONNECTED"}</div>
                                        </div>
                                        <div className={`w-2 h-2 rounded-full ${qrCode ? "bg-[--accent-amber] animate-pulse" : "bg-[--status-success]"}`} />
                                    </div>
                                    <div className="flex items-center gap-3 p-2 bg-white/5 border-l-2 border-[#4285F4]">
                                        <div className="flex-1">
                                            <div className="text-xs font-bold text-white mb-1">GOOGLE SERVICES</div>
                                            <div className="text-[9px] text-[--text-muted]">
                                                {googleAuthUrl ? "AUTH_REQUIRED" : "LINKED"}
                                            </div>
                                        </div>
                                        {googleAuthUrl ? (
                                            <a href={googleAuthUrl} className="text-[9px] px-2 py-1 border border-[#4285F4] text-[#4285F4] hover:bg-[#4285F4] hover:text-white transition-colors">LINK</a>
                                        ) : (
                                            <div className="w-2 h-2 rounded-full bg-[--status-success]" />
                                        )}
                                    </div>
                                </div>
                            </HudPanel>
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Toggle Button Left */}
                <button
                    onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-50 w-4 h-12 bg-[--accent-gold] flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
                >
                    <span className="text-black text-[10px] transform -rotate-90">{leftPanelOpen ? "<" : ">"}</span>
                </button>


                {/* --- CENTER VIEWPORT: TERMINAL (The Focus) --- */}
                <section className="flex-1 h-full p-4 relative z-20 flex flex-col gap-4">

                    {/* Terminal Window */}
                    <div className="flex-1 relative bg-black/80 border border-[rgba(255,255,255,0.1)] rounded-sm overflow-hidden flex flex-col shadow-2xl">
                        {/* Terminal Header */}
                        <div className="h-8 bg-[#1a1a1a] flex items-center px-4 border-b border-[rgba(255,255,255,0.05)]">
                            <div className="flex gap-2">
                                <div className="w-2 h-2 rounded-full bg-[--status-error] opacity-50" />
                                <div className="w-2 h-2 rounded-full bg-[--accent-amber] opacity-50" />
                                <div className="w-2 h-2 rounded-full bg-[--status-success] opacity-50" />
                            </div>
                            <span className="mx-auto text-[10px] font-mono text-[--text-muted]">root@nexus-core:~/logs --watch</span>
                        </div>

                        {/* Logs Content */}
                        <div className="flex-1 p-4 font-mono text-xs overflow-auto custom-scrollbar space-y-1 relative">
                            <div className="absolute inset-0 pointer-events-none bg-[url('/scan-texture.png')] opacity-[0.05] mix-blend-overlay" />

                            {logs.length === 0 && (
                                <div className="text-[--text-muted] italic opacity-50 text-center mt-20">Waiting for system events...</div>
                            )}

                            {logs.map((log, i) => (
                                <div key={i} className="flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors group">
                                    <span className="text-[--text-muted] shrink-0 font-light text-[10px] w-24">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    <span className={`shrink-0 font-bold w-12 ${log.level === 'ERROR' ? 'text-[--status-error]' :
                                        log.level === 'WARN' ? 'text-[--status-warning]' :
                                            'text-[--status-success]'
                                        }`}>
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


                    {/* Bottom Panel: Persona Tuning (Collapsible Drawer) */}
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
                                        <h3 className="text-xl font-display font-bold text-[--accent-gold] mb-2">PERSONA TUNING</h3>
                                        <p className="text-xs text-[--text-muted] font-mono w-64">
                                            Modify the core behavioral parameters of the Nexus agent. Changes propagate immediately.
                                        </p>
                                        <div className="mt-4">
                                            <button
                                                onClick={savePersona}
                                                className="px-6 py-2 bg-[--accent-gold] text-black font-bold font-display tracking-wider hover:bg-white transition-colors clip-path-button"
                                                style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                                            >
                                                UPLOAD NEW MATRIX
                                            </button>
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


                {/* --- RIGHT PANEL: CONFIGURATION (Retractable) --- */}
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
                                {config?.groups.map((group, idx) => (
                                    <div key={idx} className="space-y-3">
                                        <h3 className="font-mono text-xs text-[--text-secondary] uppercase tracking-widest pl-2 border-l border-[--accent-gold]">
                                            {group.category}
                                        </h3>
                                        <div className="space-y-2">
                                            {group.items.map((item) => (
                                                <div key={item.key} className="group/item relative">
                                                    <label className="block text-[10px] font-mono text-[--text-muted] mb-1">{item.key}</label>
                                                    <div className="relative">
                                                        <input
                                                            type={item.is_secret ? "password" : "text"}
                                                            defaultValue={item.value}
                                                            onBlur={(e) => {
                                                                if (e.target.value !== item.value) {
                                                                    saveConfig(item.key, e.target.value);
                                                                }
                                                            }}
                                                            className="w-full bg-white/5 border border-white/10 px-3 py-2 font-mono text-xs text-[--accent-gold] focus:border-[--accent-gold] focus:outline-none transition-colors group-hover/item:border-white/20"
                                                        />
                                                        {/* Encrypted Shimmer Overlay for Secrets */}
                                                        {item.is_secret && (
                                                            <div className="absolute inset-0 bg-black/90 flex items-center px-3 opacity-100 group-hover/item:opacity-0 transition-opacity pointer-events-none border border-white/5">
                                                                <span className="text-[10px] text-[--text-muted] tracking-widest">ENCRYPTED_VALUE</span>
                                                                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Toggle Button Right */}
                <button
                    onClick={() => setRightPanelOpen(!rightPanelOpen)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 z-50 w-4 h-12 bg-[--accent-gold] flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
                >
                    <span className="text-black text-[10px] transform -rotate-90">{rightPanelOpen ? ">" : "<"}</span>
                </button>

            </main>

            {/* === BOTTOM STATUS BAR (Toggle Persona Panel) === */}
            <footer className="h-8 bg-black border-t border-[rgba(255,255,255,0.1)] flex items-center justify-between px-4 z-40 relative">
                <div className="flex items-center gap-4 text-[10px] font-mono text-[--text-muted]">
                    <span>CPU: <span className="text-[--status-success]">12%</span></span>
                    <span>MEM: <span className="text-[--status-success]">4.2GB</span></span>
                    <span>NET: <span className="text-[--accent-gold]">ACTIVE</span></span>
                </div>

                <button
                    onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
                    className={`h-full px-6 flex items-center gap-2 border-l border-r border-[rgba(255,255,255,0.1)] hover:bg-white/5 transition-colors ${bottomPanelOpen ? 'bg-[--accent-gold] text-black border-[--accent-gold]' : 'text-[--accent-gold]'}`}
                >
                    <span className="text-[10px] font-display font-bold tracking-widest">
                        {bottomPanelOpen ? "CLOSE TUNING" : "PERSONA TUNING"}
                    </span>
                    <div className={`w-2 h-2 border-t border-r border-current transform transition-transform ${bottomPanelOpen ? "rotate-[-45deg] mt-1" : "rotate-[135deg] mb-1"}`} />
                </button>
            </footer>

        </div>
    );
}
