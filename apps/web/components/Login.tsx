import React, { FormEvent, useState } from 'react';
import SpotlightCard from './ui/SpotlightCard';
import { motion } from 'framer-motion';

interface LoginProps {
    onLogin: (path: "/v1/auth/signup" | "/v1/auth/login", email: string, pass: string) => Promise<void>;
    busy: boolean;
    error: string;
}

export default function Login({ onLogin, busy, error }: LoginProps) {
    const [email, setEmail] = useState("admin@example.com");
    const [password, setPassword] = useState("supersecure123");

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        void onLogin("/v1/auth/login", email, password);
    };

    return (
        <div id="login-form" className="flex items-center justify-center py-20">
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="w-full max-w-md px-4"
            >
                <SpotlightCard className="glass-panel p-8 md:p-10 rounded-2xl border border-[--glass-border]">
                    <div className="text-center mb-8">
                        <h2 className="text-2xl font-display font-bold text-white tracking-widest mb-2">AUTHENTICATION</h2>
                        <div className="h-0.5 w-16 bg-[--accent-gold] mx-auto rounded-full shadow-[0_0_10px_var(--accent-gold)]" />
                    </div>

                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-[--accent-gold] text-xs font-mono tracking-wider uppercase">Identity</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-[--bg-obsidian] border border-[--glass-border] rounded p-3 text-white font-mono focus:border-[--accent-gold] focus:outline-none focus:shadow-[0_0_10px_rgba(255,215,0,0.2)] transition-all"
                                placeholder="OPERATOR_ID"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-[--accent-gold] text-xs font-mono tracking-wider uppercase">Passcode</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-[--bg-obsidian] border border-[--glass-border] rounded p-3 text-white font-mono focus:border-[--accent-gold] focus:outline-none focus:shadow-[0_0_10px_rgba(255,215,0,0.2)] transition-all"
                                placeholder="********"
                            />
                        </div>

                        {error && (
                            <div className="p-3 bg-[rgba(255,50,50,0.1)] border border-[--status-error] rounded text-[--status-error] text-sm text-center font-mono">
                                Running into error: {error}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={busy}
                            className="w-full py-4 bg-[--accent-gold] text-black font-display font-bold tracking-widest hover:bg-[--accent-amber] transition-colors disabled:opacity-50 disabled:cursor-not-allowed clip-path-button"
                            style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
                        >
                            {busy ? "AUTHENTICATING..." : "ACCESS MAINFRAME"}
                        </button>
                    </form>
                </SpotlightCard>
            </motion.div>
        </div>
    );
}
