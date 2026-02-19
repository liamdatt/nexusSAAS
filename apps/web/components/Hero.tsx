"use client";

import React, { useState, useRef } from 'react';
import { motion, useScroll, useTransform, useMotionValue, useSpring } from 'framer-motion';
import { Canvas } from '@react-three/fiber';
import { Environment } from '@react-three/drei';
import NexusCore from './ui/NexusCore';
import AnimatedContent from './ui/AnimatedContent';
import StarBorder from './ui/StarBorder';

export default function Hero() {
    const containerRef = useRef<HTMLDivElement>(null);
    const { scrollY } = useScroll();

    // Parallax transforms
    const y2 = useTransform(scrollY, [0, 500], [0, -150]);
    const opacity = useTransform(scrollY, [0, 300], [1, 0]);

    // Mouse movement parallax for UI
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);
    const springX = useSpring(mouseX, { stiffness: 50, damping: 20 });
    const springY = useSpring(mouseY, { stiffness: 50, damping: 20 });

    function handleMouseMove(e: React.MouseEvent) {
        const { clientX, clientY } = e;
        const { innerWidth, innerHeight } = window;
        const x = (clientX / innerWidth - 0.5) * 40;
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
                    setTimeout(() => {
                        document.getElementById('auth-terminal')?.scrollIntoView({ behavior: 'smooth' });
                    }, 800);
                    return 100;
                }
                return prev + 2;
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
            {/* === 3D BACKGROUND LAYER === */}
            <div className="absolute inset-0 z-0 pointer-events-none">
                <Canvas camera={{ position: [0, 0, 8], fov: 45 }}>
                    <Environment preset="city" />
                    <NexusCore />
                </Canvas>
            </div>

            {/* Fog overlay to blend 3D canvas with the page bottom */}
            <div className="absolute inset-0 bg-gradient-to-t from-[--bg-obsidian] via-transparent to-transparent z-[1] pointer-events-none opacity-80" />

            {/* === TYPOGRAPHY LAYERS === */}
            <motion.div
                style={{ y: y2, opacity }}
                className="absolute z-20 top-[15%] md:top-[12%] flex flex-col items-center justify-center w-full pointer-events-none mix-blend-screen"
            >
                <AnimatedContent distance={40} direction="vertical" reverse={false} duration={1.2} animateOpacity scale={0.9} className="flex flex-col items-center">
                    <h2 className="text-sm md:text-lg font-mono text-[--accent-gold] tracking-[0.6em] mb-4 z-30 uppercase drop-shadow-[0_0_15px_rgba(255,215,0,0.5)]">
                        Nexus by FloPro
                    </h2>
                    <h1 className="text-[10vw] md:text-[8vw] leading-none font-black tracking-[0.1em] text-white select-none text-glow uppercase">
                        NEXUS
                    </h1>
                </AnimatedContent>
            </motion.div>

            {/* === FLOATING SATELLITES (HUD ELEMENTS) === */}
            <motion.div
                initial={{ x: -100, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 1.5, delay: 0.5 }}
                style={{ x: useTransform(springX, val => val * 2), y: useTransform(springY, val => val * 2) }}
                className="hidden lg:block absolute left-[10%] top-[30%] z-20 pointer-events-none"
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
            </motion.div>

            <motion.div
                initial={{ x: 100, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 1.5, delay: 0.8 }}
                style={{ x: useTransform(springX, val => val * 1.5), y: useTransform(springY, val => val * 1.5) }}
                className="hidden lg:block absolute right-[12%] bottom-[30%] z-20 pointer-events-none"
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
                    <StarBorder as="div" color="#FFD700" speed="5s" thickness={2}>
                        <div className="relative overflow-hidden w-64 h-16 bg-[rgba(0,0,0,0.6)] backdrop-blur-sm flex items-center justify-center transition-all duration-300 group-hover:shadow-[0_0_30px_rgba(255,215,0,0.2)] rounded-[18px]">
                            {/* Progress Fill */}
                            <motion.div
                                className="absolute left-0 top-0 bottom-0 bg-[--accent-gold] z-0"
                                style={{ width: `${progress}%` }}
                            />

                            <div className="absolute inset-0 bg-[url('/scan-texture.png')] opacity-10 mix-blend-overlay z-10" />

                            <span className={`relative z-20 font-display font-bold tracking-[0.2em] transition-colors duration-200 ${progress > 50 ? 'text-black' : 'text-[--accent-gold]'}`}>
                                {initialized ? "ACCESS GRANTED" : holding ? "HOLDING..." : "INITIALIZE"}
                            </span>
                        </div>
                    </StarBorder>

                    <motion.p
                        initial={{ opacity: 0.6 }}
                        animate={{ opacity: holding ? 1 : 0.6 }}
                        className="text-[10px] font-mono text-[--text-muted] text-center mt-2 tracking-widest uppercase pointer-events-none"
                    >
                        {initialized ? "SYSTEMS ONLINE" : "HOLD TO DEPLOY AGENT"}
                    </motion.p>
                </div>
            </motion.div>
        </section>
    );
}
