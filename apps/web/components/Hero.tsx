"use client";

import React, { useEffect, useState, useRef } from 'react';
import { motion, useScroll, useTransform, useMotionValue, useSpring } from 'framer-motion';
import Orb from './ui/Orb';

export default function Hero() {
    const containerRef = useRef<HTMLDivElement>(null);
    const { scrollY } = useScroll();

    // Parallax transforms
    const y1 = useTransform(scrollY, [0, 500], [0, 200]);
    const y2 = useTransform(scrollY, [0, 500], [0, -150]);
    const scale = useTransform(scrollY, [0, 500], [1, 1.5]);
    const opacity = useTransform(scrollY, [0, 300], [1, 0]);

    // Mouse movement parallax
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);
    const springX = useSpring(mouseX, { stiffness: 50, damping: 20 });
    const springY = useSpring(mouseY, { stiffness: 50, damping: 20 });

    function handleMouseMove(e: React.MouseEvent) {
        const { clientX, clientY } = e;
        const { innerWidth, innerHeight } = window;
        const x = (clientX / innerWidth - 0.5) * 40; // range -20 to 20
        const y = (clientY / innerHeight - 0.5) * 40;
        mouseX.set(x);
        mouseY.set(y);
    }

    // Hold-to-initialize Logic
    const [holding, setHolding] = useState(false);
    const [progress, setProgress] = useState(0);
    const [initialized, setInitialized] = useState(false);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    const startHold = () => {
        if (initialized) return;
        setHolding(true);
        intervalRef.current = setInterval(() => {
            setProgress(prev => {
                if (prev >= 100) {
                    if (intervalRef.current) clearInterval(intervalRef.current);
                    setInitialized(true);
                    // Trigger scroll after delay
                    setTimeout(() => {
                        document.getElementById('auth-terminal')?.scrollIntoView({ behavior: 'smooth' });
                    }, 800);
                    return 100;
                }
                return prev + 2; // Speed of fill
            });
        }, 30);
    };

    const stopHold = () => {
        if (initialized) return;
        setHolding(false);
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        setProgress(0);
    };

    return (
        <section
            ref={containerRef}
            onMouseMove={handleMouseMove}
            className="relative h-screen w-full flex items-center justify-center overflow-hidden perspective-1000"
        >
            {/* === BACKGROUND LAYERS === */}

            {/* Layer 0: The Orb (Massive Scale) */}
            <motion.div
                style={{ y: y1, x: springX, scale: scale }}
                className="absolute z-10 w-[80vw] h-[80vw] md:w-[60vh] md:h-[60vh] sphere-pulse pointer-events-none"
            >
                <div className="w-full h-full rounded-full overflow-hidden shadow-[0_0_100px_rgba(255,215,0,0.2)]">
                    <Orb
                        hue={40}
                        hoverIntensity={0.6}
                        rotateOnHover={true}
                        forceHoverState={true}
                        backgroundColor="transparent"
                    />
                </div>
                {/* Orbital Rings - SVG Overlay */}
                <svg className="absolute inset-[-50%] w-[200%] h-[200%] animate-spin-slow pointer-events-none opacity-40" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="#FFD700" strokeWidth="0.1" strokeDasharray="1 3" />
                    <circle cx="50" cy="50" r="35" fill="none" stroke="#FF4500" strokeWidth="0.2" strokeDasharray="10 20" opacity="0.5" />
                </svg>
            </motion.div>


            {/* === TYPOGRAPHY LAYERS === */}

            {/* Layer 1: "NEXUS" Outline (Behind Orb) */}
            <motion.div
                style={{ y: y2, x: useTransform(springX, val => val * -0.5), opacity }}
                className="absolute z-0 flex items-center justify-center w-full pointer-events-none"
            >
                <h1 className="text-massive text-stroke-gold opacity-20 select-none blur-sm">
                    NEXUS
                </h1>
            </motion.div>

            {/* Layer 2: "COMMAND" Solid (Front of Orb) */}
            <motion.div
                style={{ y: y2, x: useTransform(springX, val => val * 1.5), opacity }}
                className="absolute z-20 top-[60%] md:top-[55%] pointer-events-none mix-blend-overlay"
            >
                <h1 className="text-[12vw] leading-none font-black tracking-tighter text-white select-none text-glow uppercase">
                    COMMAND
                </h1>
            </motion.div>


            {/* === FLOATING SATELLITES (HUD ELEMENTS) === */}

            {/* Left Satellite: QR Code */}
            <motion.div
                initial={{ x: -100, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 1.5, delay: 0.5 }}
                style={{ x: useTransform(springX, val => val * 2), y: useTransform(springY, val => val * 2) }}
                className="hidden lg:block absolute left-[10%] top-[30%] z-20"
            >
                <div className="hud-panel p-4 w-48 backdrop-blur-md">
                    <div className="flex justify-between items-center mb-2 border-b border-[rgba(255,215,0,0.3)] pb-1">
                        <span className="text-[10px] font-mono text-[--accent-gold]">UPLINK_01</span>
                        <div className="w-2 h-2 bg-[--status-success] rounded-full animate-pulse" />
                    </div>
                    <div className="w-full aspect-square border-2 border-dashed border-[rgba(255,255,255,0.1)] flex items-center justify-center relative bg-black/50">
                        <div className="absolute inset-0 grid grid-cols-4 gap-0.5 opacity-30">
                            {[...Array(16)].map((_, i) => (
                                <div key={i} className="bg-[--accent-gold]" style={{ opacity: Math.random() }} />
                            ))}
                        </div>
                        <span className="text-[8px] font-mono text-center relative z-10 text-[--accent-gold] bg-black/80 px-1">
                            AWAITING LINK
                        </span>
                    </div>
                </div>
                {/* Connecting Line to Center */}
                <div className="absolute top-1/2 right-[-100px] w-[100px] h-[1px] bg-gradient-to-r from-[--accent-gold] to-transparent opacity-30" />
            </motion.div>

            {/* Right Satellite: Phone Mockup */}
            <motion.div
                initial={{ x: 100, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 1.5, delay: 0.8 }}
                style={{ x: useTransform(springX, val => val * 2), y: useTransform(springY, val => val * 2) }}
                className="hidden lg:block absolute right-[12%] bottom-[30%] z-20"
            >
                <div className="hud-panel p-4 w-56 backdrop-blur-md transform rotate-[-5deg]">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded-full bg-[--accent-gold] flex items-center justify-center text-black font-bold text-xs">N</div>
                        <div className="flex-1">
                            <div className="h-2 w-12 bg-white/20 rounded mb-1" />
                            <div className="h-1.5 w-20 bg-white/10 rounded" />
                        </div>
                    </div>
                    <div className="space-y-2 font-mono text-[9px] text-[--accent-gold]">
                        <div className="bg-white/5 p-2 border-l border-[--accent-gold]">
                            &gt; INITIALIZING PROTOCOLS...
                        </div>
                        <div className="bg-white/5 p-2 border-l border-[--accent-gold] opacity-60">
                            &gt; SYNCING NEURAL NET...
                        </div>
                    </div>
                </div>
                {/* Connecting Line */}
                <div className="absolute top-1/2 left-[-80px] w-[80px] h-[1px] bg-gradient-to-l from-[--accent-gold] to-transparent opacity-30" />
            </motion.div>


            {/* === INTERACTION LAYER (Hold to Initialize) === */}
            <motion.div
                className="absolute bottom-20 z-30 flex flex-col items-center gap-4"
                style={{ opacity }}
            >
                <div
                    className="relative group cursor-pointer"
                    onMouseDown={startHold}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={startHold}
                    onTouchEnd={stopHold}
                >
                    {/* The Trigger Button */}
                    <div className="relative overflow-hidden w-64 h-16 border border-[rgba(255,215,0,0.3)] bg-[rgba(0,0,0,0.6)] backdrop-blur-sm flex items-center justify-center transition-all duration-300 group-hover:border-[--accent-gold] group-hover:shadow-[0_0_30px_rgba(255,215,0,0.2)]">
                        {/* Progress Fill */}
                        <motion.div
                            className="absolute left-0 top-0 bottom-0 bg-[--accent-gold] z-0"
                            style={{ width: `${progress}%` }}
                        />

                        {/* Scan Line Animation inside button */}
                        <div className="absolute inset-0 bg-[url('/scan-texture.png')] opacity-10 mix-blend-overlay z-10" />

                        {/* Text Content */}
                        <span className={`relative z-20 font-display font-bold tracking-[0.2em] transition-colors duration-200 ${progress > 50 ? 'text-black' : 'text-[--accent-gold]'}`}>
                            {initialized ? "ACCESS GRANTED" : holding ? "HOLDING..." : "INITIALIZE"}
                        </span>

                        {/* Corner Accents */}
                        <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-[--status-success]" />
                        <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-[--status-success]" />
                    </div>

                    {/* Instructional Text */}
                    <motion.p
                        initial={{ opacity: 0.6 }}
                        animate={{ opacity: holding ? 1 : 0.6 }}
                        className="text-[10px] font-mono text-[--text-muted] text-center mt-2 tracking-widest uppercase"
                    >
                        {initialized ? "SYSTEMS ONLINE" : "HOLD TO DEPLOY AGENT"}
                    </motion.p>
                </div>
            </motion.div>

        </section>
    );
}
