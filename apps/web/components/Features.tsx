"use client";

import React from 'react';
import { Mail, Calendar, FileText, Sheet, FileBox, Image as ImageIcon, MessageCircle } from 'lucide-react';
import GlareHover from './ui/GlareHover';
import AnimatedContent from './ui/AnimatedContent';

const features = [
    {
        title: "Email Integration",
        description: "Connect your inbox directly to Nexus. AI agents draft, sort, and prioritize your emails automatically.",
        icon: <Mail className="w-8 h-8 text-[--accent-gold] mb-4" />,
        colSpan: "col-span-1 md:col-span-2 lg:col-span-1"
    },
    {
        title: "Smart Calendar",
        description: "Seamless scheduling. Nexus will resolve conflicts and find the perfect time across multiple timezones.",
        icon: <Calendar className="w-8 h-8 text-[--accent-gold] mb-4" />,
        colSpan: "col-span-1"
    },
    {
        title: "Docs & Spreadsheets",
        description: "Draft reports, analyze data, and summarize long documents in seconds using the power of autonomous agents.",
        icon: (
            <div className="flex gap-2 mb-4 text-[--accent-gold]">
                <FileText className="w-8 h-8" />
                <Sheet className="w-8 h-8" />
            </div>
        ),
        colSpan: "col-span-1 md:col-span-2"
    },
    {
        title: "PDF Analysis",
        description: "Drop a 100-page PDF and ask anything. Nexus will act as an expert analyst on your documents.",
        icon: <FileBox className="w-8 h-8 text-[--accent-gold] mb-4" />,
        colSpan: "col-span-1"
    },
    {
        title: "Image Generation",
        description: "Generate high-quality assets directly inside your dashboard. Need a concept? Just ask.",
        icon: <ImageIcon className="w-8 h-8 text-[--accent-gold] mb-4" />,
        colSpan: "col-span-1 md:col-span-2 lg:col-span-1"
    },
    {
        title: "WhatsApp Connected",
        description: "Your agents are always available in your pocket. Command Nexus via WhatsApp text or voice notes.",
        icon: <MessageCircle className="w-8 h-8 text-[#25D366] mb-4" />,
        colSpan: "col-span-1 md:col-span-2 lg:col-span-2 border-[--accent-gold]"
    }
];

export default function Features() {
    return (
        <section className="relative w-full py-32 px-6 lg:px-20 z-10">
            <div className="max-w-7xl mx-auto">
                <AnimatedContent
                    distance={100}
                    direction="vertical"
                    reverse={false}
                    duration={1}
                    animateOpacity
                    scale={0.9}
                    threshold={0.2}
                    className="mb-16"
                >
                    <div className="flex items-center gap-4 mb-4">
                        <div className="h-[1px] w-12 bg-[--accent-gold]" />
                        <span className="text-[--accent-gold] font-mono tracking-widest uppercase text-sm">Capabilities</span>
                    </div>
                    <h2 className="text-4xl md:text-6xl font-display font-bold text-white uppercase tracking-tighter">
                        An Autonomous <span className="text-stroke-gold text-transparent">Arsenal</span>
                    </h2>
                    <p className="mt-6 text-xl text-[--text-secondary] max-w-2xl">
                        Nexus integrates seamlessly into your daily stack, empowering you with AI agents capable of specialized execution.
                    </p>
                </AnimatedContent>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {features.map((feature, index) => (
                        <AnimatedContent
                            key={index}
                            distance={50}
                            direction="vertical"
                            reverse={false}
                            duration={0.8}
                            delay={index * 0.1}
                            animateOpacity
                            scale={0.95}
                            threshold={0.1}
                            className={`h-full ${feature.colSpan}`}
                        >
                            <GlareHover
                                className={`h-full w-full bg-[--bg-card] border-[rgba(255,255,255,0.05)] rounded-2xl p-8 backdrop-blur-md transition-all duration-300 hover:border-[rgba(255,215,0,0.3)] ${feature.title === "WhatsApp Connected" ? "shadow-[0_0_30px_rgba(37,211,102,0.1)] hover:border-[#25D366]" : ""}`}
                                glareColor={feature.title === "WhatsApp Connected" ? "#25D366" : "#FFD700"}
                                glareOpacity={0.15}
                                glareSize={200}
                            >
                                <div className="flex flex-col h-full z-10 relative">
                                    {feature.icon}
                                    <h3 className="text-2xl font-bold text-white mb-2">{feature.title}</h3>
                                    <p className="text-[--text-secondary] flex-1">
                                        {feature.description}
                                    </p>
                                </div>
                            </GlareHover>
                        </AnimatedContent>
                    ))}
                </div>
            </div>
        </section>
    );
}
