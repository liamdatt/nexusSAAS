"use client";

import { useEffect, useState } from "react";
import { api, Tokens } from "@/lib/api";
import Hero from "@/components/Hero";
import Login from "@/components/Login";
import Dashboard from "@/components/Dashboard";
import Particles from "@/components/ui/Particles";
import Aurora from "@/components/ui/Aurora";
import SplashCursor from "@/components/ui/SplashCursor";
import Features from "@/components/Features";
import Onboarding from "@/components/Onboarding";

type AuthResponse = {
  user: { id: number; email: string; created_at: string };
  tokens: Tokens;
};

const TOKEN_KEY = "nexus_saas_tokens";

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export default function Home() {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return;
    const parsed = safeJsonParse<Tokens | null>(raw, null);
    if (parsed) setTokens(parsed);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    if (tokens) {
      localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }, [tokens, isClient]);

  async function handleAuth(path: "/v1/auth/signup" | "/v1/auth/login", email: string, pass: string) {
    setBusy(true);
    setError("");
    try {
      const data = await api<AuthResponse>(path, {
        method: "POST",
        body: JSON.stringify({ email, password: pass }),
      });
      setTokens(data.tokens);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    setTokens(null);
    setError("");
    setBusy(false);
  }

  if (!isClient) return null;

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[--bg-obsidian] selection:bg-[--accent-gold] selection:text-black">

      {/* === LAYER 0: The Void (Deep Background) === */}
      <div className="fixed inset-0 z-0 bg-gradient-to-b from-[#000] via-[#050505] to-[#0a0a0a]" />

      {/* === LAYER 1: Deep Particles and Aurora === */}
      <div className="fixed inset-0 z-[1] opacity-30">
        <Particles
          particleCount={150}
          particleSpread={20}
          speed={0.08}
          particleColors={["#FFD700", "#FF4500", "#ffffff"]}
          moveParticlesOnHover={true}
          particleHoverFactor={0.8}
          alphaParticles={true}
          particleBaseSize={80}
          sizeRandomness={1.5}
          cameraDistance={30}
          disableRotation={false}
        />
      </div>
      <div className="fixed inset-0 z-[1] opacity-20 pointer-events-none mix-blend-screen">
        <Aurora
          colorStops={["#FFD700", "#FF4500", "#000000"]}
          amplitude={1.5}
          blend={0.5}
          speed={0.3}
        />
      </div>

      {/* === LAYER 2: Atmos — Fog and Noise === */}
      <div className="fog-layer z-[2]" />
      <div className="fixed inset-0 z-[2] opacity-[0.03] pointer-events-none"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noiseFilter\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.65\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noiseFilter)\'/%3E%3C/svg%3E")' }}
      />

      {/* === LAYER 3: Perspective Grid === */}
      <div className="fixed inset-0 z-[2] pointer-events-none perspective-1000">
        <div className="absolute inset-x-0 bottom-0 h-[40vh] bg-gradient-to-t from-[rgba(255,215,0,0.03)] to-transparent"
          style={{
            transform: 'rotateX(60deg) scale(2)',
            backgroundImage: 'linear-gradient(0deg, transparent 24%, rgba(255, 215, 0, .1) 25%, rgba(255, 215, 0, .1) 26%, transparent 27%, transparent 74%, rgba(255, 215, 0, .1) 75%, rgba(255, 215, 0, .1) 76%, transparent 77%, transparent), linear-gradient(90deg, transparent 24%, rgba(255, 215, 0, .1) 25%, rgba(255, 215, 0, .1) 26%, transparent 27%, transparent 74%, rgba(255, 215, 0, .1) 75%, rgba(255, 215, 0, .1) 76%, transparent 77%, transparent)',
            backgroundSize: '100px 100px'
          }}
        />
      </div>

      {/* === CONTENT === */}
      <div className="relative z-10 w-full min-h-screen flex flex-col">
        {!tokens && (
          <SplashCursor
            SIM_RESOLUTION={128}
            DYE_RESOLUTION={512}
            COLOR_UPDATE_SPEED={10}
            BACK_COLOR={{ r: 0.0, g: 0.0, b: 0.0 }}
            TRANSPARENT={true}
          />
        )}
        {!tokens ? (
          <>
            <Hero />
            <Features />
            <Onboarding />
            <div id="auth-terminal" className="min-h-screen flex items-center justify-center relative">
              {/* Transition Zone — Fog gets denser here */}
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black pointer-events-none" />
              <Login onLogin={handleAuth} busy={busy} error={error} />
            </div>
          </>
        ) : (
          <Dashboard tokens={tokens} onLogout={logout} />
        )}
      </div>

    </main>
  );
}
