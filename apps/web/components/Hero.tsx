"use client";

import React from 'react';
import { motion } from 'framer-motion';
import Orb from './ui/Orb';

export default function Hero() {
    return (
        <section className="relative z-10 flex flex-col items-center justify-center min-h-screen text-center px-4 py-20 overflow-hidden">

            {/* === MAIN HERO LAYOUT === */}
            <div className="relative flex flex-col lg:flex-row items-center justify-center gap-8 lg:gap-0 w-full max-w-7xl">

                {/* --- LEFT FLOATING ELEMENT: QR Data Slate --- */}
                <motion.div
                    initial={{ opacity: 0, x: -60, rotateY: 15 }}
                    animate={{ opacity: 1, x: 0, rotateY: 0 }}
                    transition={{ duration: 1.2, delay: 0.6, ease: "easeOut" }}
                    className="hidden lg:block flex-shrink-0 w-64"
                    style={{ animation: 'float-gentle 6s ease-in-out infinite' }}
                >
                    <div className="glass-panel-deep rim-light rounded-2xl p-6 border border-[rgba(255,215,0,0.1)] relative overflow-hidden">
                        {/* Scan lines overlay */}
                        <div className="absolute inset-0 opacity-5 pointer-events-none"
                            style={{
                                backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,215,0,0.1) 2px, rgba(255,215,0,0.1) 4px)',
                                backgroundSize: '100% 4px'
                            }}
                        />
                        <p className="text-[--accent-gold] text-[10px] font-mono tracking-[0.3em] uppercase mb-4 text-center">
                            STEP 1: SCAN TO AUTHENTICATE
                        </p>
                        {/* Decorative QR Placeholder */}
                        <div className="relative mx-auto w-36 h-36 flex items-center justify-center">
                            <div className="absolute inset-0 bg-gradient-to-br from-[--accent-gold] to-[--accent-orange] opacity-10 rounded-lg" />
                            <div className="relative w-32 h-32 grid grid-cols-8 grid-rows-8 gap-[2px] p-2">
                                {Array.from({ length: 64 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="rounded-[1px]"
                                        style={{
                                            backgroundColor: Math.random() > 0.4
                                                ? `rgba(255, 215, 0, ${0.4 + Math.random() * 0.6})`
                                                : 'transparent',
                                        }}
                                    />
                                ))}
                            </div>
                            {/* Glow rays */}
                            <div className="absolute inset-0 rounded-lg shadow-[0_0_40px_rgba(255,215,0,0.15)] pointer-events-none" />
                        </div>
                        <p className="text-[--text-muted] text-[9px] font-mono text-center mt-4 tracking-wider">
                            QUANTUM-ENCRYPTED LINK
                        </p>
                    </div>
                </motion.div>

                {/* --- CENTER: Reactor Core + Typography --- */}
                <div className="flex-1 flex flex-col items-center max-w-2xl lg:px-8">
                    {/* Reactor Core — Orb + Sacred Geometry Rings */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 1.5, ease: "easeOut" }}
                        className="relative w-56 h-56 md:w-72 md:h-72 mb-10"
                    >
                        {/* Ambient glow behind orb */}
                        <div className="absolute inset-[-30%] rounded-full bg-gradient-to-r from-[--accent-gold] to-[--accent-orange] opacity-[0.06] blur-3xl" />

                        {/* Sacred geometry ring 1 — outer */}
                        <div
                            className="absolute inset-[-15%] border border-[rgba(255,215,0,0.12)] rounded-full"
                            style={{ animation: 'ring-rotate 30s linear infinite' }}
                        >
                            {/* Nodes on ring */}
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-[--accent-gold] rounded-full opacity-60 shadow-[0_0_8px_var(--accent-gold)]" />
                            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-1.5 h-1.5 bg-[--accent-orange] rounded-full opacity-40 shadow-[0_0_6px_var(--accent-orange)]" />
                        </div>

                        {/* Sacred geometry ring 2 — mid */}
                        <div
                            className="absolute inset-[-5%] border border-[rgba(255,215,0,0.08)] rounded-full"
                            style={{ animation: 'ring-rotate-reverse 20s linear infinite' }}
                        >
                            <div className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-[--accent-amber] rounded-full opacity-50 shadow-[0_0_6px_var(--accent-amber)]" />
                        </div>

                        {/* The Orb itself */}
                        <div className="absolute inset-[5%] rounded-full overflow-hidden">
                            <Orb
                                hue={40}
                                hoverIntensity={0.3}
                                rotateOnHover={true}
                                forceHoverState={false}
                                backgroundColor="#050505"
                            />
                        </div>
                    </motion.div>

                    {/* Headline */}
                    <motion.h1
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, delay: 0.3, ease: "easeOut" }}
                        className="text-5xl md:text-7xl lg:text-8xl font-bold tracking-wider mb-5 font-display leading-none"
                    >
                        <span className="text-white text-shadow-glow">COMMAND</span>
                        <br />
                        <span className="text-white text-shadow-glow">YOUR </span>
                        <span className="text-gradient-gold">NEXUS</span>
                    </motion.h1>

                    {/* Sub-headline */}
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.6, duration: 0.8 }}
                        className="text-[--text-secondary] text-sm md:text-base font-mono tracking-[0.15em] max-w-xl leading-relaxed"
                    >
                        INTELLIGENT AGENTIC ASSISTANCE<br />
                        DEPLOYED VIA WHATSAPP · POWERED BY FLOPRO
                    </motion.p>

                    {/* CTA Button — Ignition Switch */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 1.0, duration: 0.5 }}
                        className="mt-10"
                    >
                        <button
                            onClick={() => document.getElementById('login-form')?.scrollIntoView({ behavior: 'smooth' })}
                            className="group relative px-10 py-5 overflow-hidden border-0 cursor-pointer"
                            style={{
                                clipPath: 'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)',
                                background: 'linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,69,0,0.1))',
                            }}
                        >
                            {/* Glow behind button */}
                            <div className="absolute inset-0 bg-gradient-to-r from-[--accent-gold] to-[--accent-orange] opacity-0 group-hover:opacity-20 transition-opacity duration-500" />
                            {/* Border line */}
                            <div className="absolute inset-0 border border-[--accent-gold] opacity-60 group-hover:opacity-100 transition-opacity"
                                style={{ clipPath: 'polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px)' }}
                            />
                            {/* Shimmer sweep */}
                            <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-[rgba(255,215,0,0.1)] to-transparent" />
                            <span className="relative text-[--accent-gold] font-display font-bold tracking-[0.25em] text-sm md:text-base group-hover:text-white transition-colors duration-300">
                                INITIALIZE SEQUENCE
                            </span>
                        </button>
                    </motion.div>
                </div>

                {/* --- RIGHT FLOATING ELEMENT: WhatsApp Phone Mockup --- */}
                <motion.div
                    initial={{ opacity: 0, x: 60, rotateY: -15 }}
                    animate={{ opacity: 1, x: 0, rotateY: 0 }}
                    transition={{ duration: 1.2, delay: 0.8, ease: "easeOut" }}
                    className="hidden lg:block flex-shrink-0 w-56"
                    style={{ animation: 'float-gentle-alt 7s ease-in-out infinite' }}
                >
                    <div className="glass-panel-deep rim-light rounded-[28px] p-2 border border-[rgba(255,255,255,0.06)] relative overflow-hidden">
                        {/* Phone bezel/notch */}
                        <div className="relative rounded-[22px] overflow-hidden carbon-fiber" style={{ background: 'linear-gradient(to bottom, #0a0a0a, #080808)' }}>
                            {/* Status bar */}
                            <div className="flex justify-between items-center px-4 py-2 text-[8px] font-mono text-[--text-muted]">
                                <span>12:42</span>
                                <div className="w-16 h-4 bg-black rounded-full mx-auto" />
                                <span>5G ▓▓▓</span>
                            </div>
                            {/* WhatsApp Header */}
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-[rgba(255,255,255,0.04)]">
                                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[--accent-gold] to-[--accent-orange] flex items-center justify-center text-black text-[8px] font-bold">N</div>
                                <div>
                                    <div className="flex items-center gap-1">
                                        <span className="text-white text-[10px] font-medium">Nexus Agent</span>
                                        <span className="text-[--accent-gold] text-[8px]">✓</span>
                                    </div>
                                    <span className="text-[--status-success] text-[7px] font-mono">ONLINE</span>
                                </div>
                            </div>
                            {/* Chat messages */}
                            <div className="p-3 space-y-2 min-h-[180px]">
                                {/* User message */}
                                <div className="flex justify-end">
                                    <div className="bg-[rgba(255,255,255,0.06)] rounded-lg rounded-tr-sm px-3 py-2 max-w-[85%]">
                                        <p className="text-[9px] text-[--text-secondary] leading-relaxed">Initialize systems</p>
                                        <p className="text-[7px] text-[--text-muted] text-right mt-1">12:41</p>
                                    </div>
                                </div>
                                {/* Agent message — glowing golden */}
                                <div className="flex justify-start">
                                    <div className="rounded-lg rounded-tl-sm px-3 py-2 max-w-[90%] border border-[rgba(255,215,0,0.15)]"
                                        style={{ background: 'linear-gradient(135deg, rgba(255,215,0,0.08), rgba(255,69,0,0.04))' }}
                                    >
                                        <p className="text-[9px] text-[--accent-gold] leading-relaxed font-mono">
                                            Nexus Online. Systems synchronized. What is your first directive?
                                        </p>
                                        <p className="text-[7px] text-[--accent-amber] text-right mt-1 opacity-60">12:42</p>
                                    </div>
                                </div>
                                {/* Typing indicator */}
                                <div className="flex items-center gap-1 px-2 py-1">
                                    <div className="w-1 h-1 rounded-full bg-[--accent-gold] opacity-60 animate-pulse" />
                                    <div className="w-1 h-1 rounded-full bg-[--accent-gold] opacity-40 animate-pulse" style={{ animationDelay: '0.2s' }} />
                                    <div className="w-1 h-1 rounded-full bg-[--accent-gold] opacity-20 animate-pulse" style={{ animationDelay: '0.4s' }} />
                                </div>
                            </div>
                            {/* Input bar */}
                            <div className="flex items-center gap-2 px-3 py-2 border-t border-[rgba(255,255,255,0.04)]">
                                <div className="flex-1 bg-[rgba(255,255,255,0.03)] rounded-full px-3 py-1.5">
                                    <span className="text-[8px] text-[--text-muted] font-mono">Enter directive...</span>
                                </div>
                                <div className="w-6 h-6 rounded-full bg-[--accent-gold] flex items-center justify-center opacity-80">
                                    <span className="text-black text-[10px]">▸</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </motion.div>

            </div>

            {/* Scroll indicator */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.4 }}
                transition={{ delay: 2 }}
                className="absolute bottom-8 left-1/2 -translate-x-1/2"
            >
                <div className="flex flex-col items-center gap-2">
                    <span className="text-[--text-muted] text-[8px] font-mono tracking-[0.3em] uppercase">SCROLL</span>
                    <div className="w-px h-8 bg-gradient-to-b from-[--accent-gold] to-transparent opacity-40" />
                </div>
            </motion.div>

        </section>
    );
}
