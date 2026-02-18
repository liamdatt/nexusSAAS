"use client";

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface LoginProps {
    onLogin: (route: "/v1/auth/signup" | "/v1/auth/login", e: string, p: string) => void;
    busy: boolean;
    error?: string;
}

export default function Login({ onLogin, busy, error }: LoginProps) {
    const [mode, setMode] = useState<"login" | "signup">("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");

    // Terminal Typing Effect for Header
    const [headerText, setHeaderText] = useState("");
    const fullText = "AUTHENTICATION // GATEKEEPER";

    useEffect(() => {
        let i = 0;
        const interval = setInterval(() => {
            setHeaderText(fullText.slice(0, i));
            i++;
            if (i > fullText.length) clearInterval(interval);
        }, 50);
        return () => clearInterval(interval);
    }, []);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const route = mode === "login" ? "/v1/auth/login" : "/v1/auth/signup";
        onLogin(route, email, password);
    };

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 50 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.8, ease: "circOut" }}
            className="relative z-10 w-full max-w-md mx-auto p-1"
        >
            {/* The Monolith Container */}
            <div className="relative bg-black/80 backdrop-blur-xl border-l-2 border-[--accent-gold] p-12 overflow-hidden shadow-[0_0_100px_rgba(0,0,0,0.8)]">

                {/* Cinematic Scanlines inside the container */}
                <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(rgba(18,16,10,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-[length:100%_2px,3px_100%]" />
                <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-[--accent-gold] to-transparent opacity-5 mix-blend-overlay" />

                {/* Decorative HUD Elements */}
                <div className="absolute top-0 right-0 p-4 opacity-50">
                    <div className="flex gap-1">
                        <div className="w-1 h-1 bg-[--accent-gold]" />
                        <div className="w-1 h-1 bg-[--accent-gold]" />
                        <div className="w-1 h-1 bg-[--accent-gold]" />
                    </div>
                </div>

                {/* Header */}
                <div className="mb-12 relative">
                    <h2 className="font-mono text-[--accent-gold] text-sm tracking-widest mb-2 opacity-80">
                        {headerText}<span className="animate-pulse">_</span>
                    </h2>
                    <div className="h-[1px] w-full bg-gradient-to-r from-[--accent-gold] to-transparent opacity-30" />
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-12 relative z-20">

                    {/* Identity Field */}
                    <div className="group relative">
                        <label className="absolute -top-6 left-0 font-mono text-[10px] text-[--text-muted] tracking-widest group-focus-within:text-[--accent-gold] transition-colors">
                            &gt; IDENTITY_PROTOCOL
                        </label>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="input-terminal w-full bg-transparent border-b border-[rgba(255,255,255,0.1)] py-2 font-mono text-xl text-white outline-none focus:border-[--accent-gold] transition-all placeholder-transparent"
                            placeholder="Identification"
                            required
                        />
                    </div>

                    {/* Passcode Field */}
                    <div className="group relative">
                        <label className="absolute -top-6 left-0 font-mono text-[10px] text-[--text-muted] tracking-widest group-focus-within:text-[--accent-gold] transition-colors">
                            &gt; SECURITY_KEY
                        </label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="input-terminal w-full bg-transparent border-b border-[rgba(255,255,255,0.1)] py-2 font-mono text-xl text-white outline-none focus:border-[--accent-gold] transition-all placeholder-transparent"
                            placeholder="Passcode"
                            required
                        />
                    </div>

                    {/* Submit Button - Cinematic "Slide" */}
                    <button
                        type="submit"
                        disabled={busy}
                        className="w-full group relative h-14 overflow-hidden bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.1)] hover:border-[--accent-gold] transition-all duration-300"
                    >
                        <div className="absolute inset-0 bg-[--accent-gold] translate-y-[100%] group-hover:translate-y-0 transition-transform duration-300 ease-out" />

                        <span className="relative z-10 font-display font-bold tracking-[0.2em] group-hover:text-black transition-colors flex items-center justify-center gap-2">
                            {busy ? "Decrypting..." : mode === "login" ? "INITIATE LINK" : "ESTABLISH ID"}
                        </span>

                        {/* Corner Accents */}
                        <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[--accent-gold] opacity-0 group-hover:opacity-100 transition-opacity" />
                        <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[--accent-gold] opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>

                    {/* Mode Switcher */}
                    <div className="text-center pt-4">
                        <button
                            type="button"
                            onClick={() => setMode(mode === "login" ? "signup" : "login")}
                            className="text-[10px] font-mono text-[--text-muted] hover:text-[--accent-gold] tracking-widest uppercase transition-colors"
                        >
                            [{mode === "login" ? "CREATE NEW IDENTITY" : "RETURN TO LOGIN"}]
                        </button>
                    </div>

                </form>

                {/* Error Message */}
                <AnimatePresence>
                    {error && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="absolute bottom-4 left-0 right-0 text-center"
                        >
                            <span className="text-[10px] font-mono text-[--status-error] bg-black/50 px-2 py-1 border border-[--status-error]">
                                ERROR: {error.toUpperCase()}
                            </span>
                        </motion.div>
                    )}
                </AnimatePresence>

            </div>
        </motion.div>
    );
}
