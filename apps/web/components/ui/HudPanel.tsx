"use client";

import React from "react";
import { cn } from "../../lib/utils";

interface HudPanelProps extends React.HTMLAttributes<HTMLDivElement> {
    title?: string;
    variant?: "default" | "warning" | "error";
    collapsible?: boolean;
    collapsed?: boolean;
    onToggle?: () => void;
    children?: React.ReactNode;
}

export default function HudPanel({
    className,
    title,
    variant = "default",
    collapsible,
    collapsed,
    onToggle,
    children,
    ...props
}: HudPanelProps) {

    const borderColor = variant === "warning" ? "border-[--accent-amber]" : variant === "error" ? "border-[--status-error]" : "border-[rgba(255,255,255,0.1)]";
    const headerColor = variant === "warning" ? "text-[--accent-amber]" : "text-[--accent-gold]";

    return (
        <div className={cn("relative group transition-all duration-300", className)} {...props}>

            {/* Main Container */}
            <div className={cn(
                "relative bg-black/60 backdrop-blur-md border border-t-0 border-b-0 transition-all duration-500 overflow-hidden",
                borderColor,
                collapsed ? "h-10" : "h-full"
            )}>

                {/* Header Strip */}
                <div
                    onClick={collapsible ? onToggle : undefined}
                    className={cn(
                        "flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.02)] select-none",
                        collapsible && "cursor-pointer hover:bg-[rgba(255,255,255,0.05)]"
                    )}
                >
                    <div className="flex items-center gap-2">
                        <div className={cn("w-1.5 h-1.5 rounded-full", variant === "error" ? "bg-[--status-error] animate-pulse" : "bg-[--accent-gold]")} />
                        <span className={cn("font-mono text-[10px] tracking-widest uppercase", headerColor)}>
                            {title || "UNKNOWN_MODULE"}
                        </span>
                    </div>
                    {collapsible && (
                        <span className="font-mono text-[10px] text-[--text-muted]">
                            {collapsed ? "[+]" : "[-]"}
                        </span>
                    )}
                </div>

                {/* Content Area */}
                <div className={cn("relative p-4 h-[calc(100%-2.25rem)] overflow-y-auto", collapsed && "opacity-0 pointer-events-none")}>
                    {children}

                    {/* Corner Accents inside content */}
                    <div className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-[rgba(255,255,255,0.2)]" />
                </div>

                {/* Scanline Overlay */}
                <div className="absolute inset-0 pointer-events-none bg-[url('/scan-texture.png')] opacity-[0.03] mix-blend-overlay" />

            </div>

            {/* Top and Bottom Brackets */}
            <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[--accent-gold] to-transparent opacity-20" />
            <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[--accent-gold] to-transparent opacity-20" />

            {/* Corner Markers */}
            <div className="absolute top-0 left-0 w-1 h-1 bg-[--accent-gold]" />
            <div className="absolute top-0 right-0 w-1 h-1 bg-[--accent-gold]" />
            <div className="absolute bottom-0 left-0 w-1 h-1 bg-[--accent-gold]" />
            <div className="absolute bottom-0 right-0 w-1 h-1 bg-[--accent-gold]" />

        </div>
    );
}
