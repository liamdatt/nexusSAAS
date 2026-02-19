"use client";

import React from 'react';
import AnimatedContent from './ui/AnimatedContent';
import GlareHover from './ui/GlareHover';

const steps = [
    {
        num: "01",
        title: "Sign Up",
        desc: "Create your FloPro Nexus account securely.",
        color: "#ffffff"
    },
    {
        num: "02",
        title: "Scan QR",
        desc: "Pair your smartphone instantly using the Nexus bridge.",
        color: "#FFD700"
    },
    {
        num: "03",
        title: "Integrate",
        desc: "Connect your Google accounts and start executing commands.",
        color: "#00FF94"
    }
];

export default function Onboarding() {
    return (
        <section className="relative w-full py-32 px-6 lg:px-20 z-10 border-t border-[rgba(255,215,0,0.1)] border-b">
            <div className="max-w-7xl mx-auto">
                <AnimatedContent
                    distance={100}
                    direction="horizontal"
                    reverse={false}
                    duration={1}
                    animateOpacity
                    scale={0.9}
                    threshold={0.2}
                    className="mb-20 text-center"
                >
                    <h2 className="text-4xl md:text-5xl font-display font-bold text-white uppercase tracking-tighter mb-4">
                        Deployment <span className="text-[--accent-gold]">Protocol</span>
                    </h2>
                    <p className="text-lg text-[--text-secondary]">
                        Three steps to initialize your cyber-concierge.
                    </p>
                </AnimatedContent>

                <div className="flex flex-col md:flex-row items-stretch justify-center gap-8 relative">
                    {/* Connector Line */}
                    <div className="hidden md:block absolute top-[60px] left-[10%] right-[10%] h-[1px] bg-gradient-to-r from-transparent via-[--accent-gold] to-transparent opacity-30 z-0" />

                    {steps.map((step, idx) => (
                        <AnimatedContent
                            key={idx}
                            distance={100}
                            direction="vertical"
                            reverse={false}
                            duration={0.8}
                            delay={idx * 0.2}
                            animateOpacity
                            scale={0.9}
                            className="flex-1 z-10 relative group"
                        >
                            <GlareHover
                                className="h-full bg-[--bg-card] border-[rgba(255,255,255,0.05)] rounded-2xl p-8 backdrop-blur-md transition-all duration-300 group-hover:-translate-y-2 border-t-[rgba(255,215,0,0.2)]"
                                glareColor={step.color}
                                glareOpacity={0.2}
                            >
                                <div className="flex flex-col items-center text-center">
                                    <div className="w-16 h-16 rounded-full bg-[rgba(255,255,255,0.03)] border-2 border-[rgba(255,215,0,0.5)] flex items-center justify-center mb-6 shadow-[0_0_20px_rgba(255,215,0,0.2)] relative">
                                        <span className="font-mono text-xl text-[--accent-gold] font-bold">{step.num}</span>
                                        <div className="absolute inset-[-4px] rounded-full border border-dashed border-[rgba(255,215,0,0.3)] animate-[spin_10s_linear_infinite]" />
                                    </div>
                                    <h3 className="text-2xl font-bold text-white mb-3 tracking-wide">{step.title}</h3>
                                    <p className="text-[--text-secondary]">{step.desc}</p>
                                </div>
                            </GlareHover>
                        </AnimatedContent>
                    ))}
                </div>
            </div>
        </section>
    );
}
