"use client";

import { useEffect, useState } from "react";
import { api, Tokens } from "@/lib/api";
import Hero from "@/components/Hero";
import Login from "@/components/Login";
import Dashboard from "@/components/Dashboard";
import Particles from "@/components/ui/Particles";
import Aurora from "@/components/ui/Aurora";

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
    <main className="relative min-h-screen w-full overflow-hidden bg-[--bg-obsidian] text-[--text-primary] selection:bg-[--accent-gold] selection:text-black">

      {/* === LAYER 0: Deep Background — Particles (subtle, distant) === */}
      <div className="fixed inset-0 z-0">
        <Particles
          particleCount={200}
          particleSpread={12}
          speed={0.05}
          particleColors={["#FFD700", "#FF4500", "#ffffff"]}
          moveParticlesOnHover={true}
          particleHoverFactor={0.5}
          alphaParticles={true}
          particleBaseSize={60}
          sizeRandomness={1.2}
          cameraDistance={25}
          disableRotation={false}
        />
      </div>

      {/* === LAYER 1: Aurora atmospheric glow === */}
      <div className="fixed inset-0 z-[1] opacity-30 pointer-events-none">
        <Aurora
          colorStops={["#FFD700", "#FF4500", "#FFD700"]}
          amplitude={1.2}
          blend={0.6}
          speed={0.5}
        />
      </div>

      {/* === LAYER 2: Hex mesh texture overlay === */}
      <div className="fixed inset-0 z-[2] hex-mesh pointer-events-none" />

      {/* === LAYER 3: Depth-of-field bokeh vignette === */}
      <div className="pointer-events-none fixed inset-0 z-[3] vignette-heavy" />

      {/* === LAYER 4: Subtle top rim light === */}
      <div className="pointer-events-none fixed top-0 left-0 right-0 h-px z-[4] bg-gradient-to-r from-transparent via-[rgba(255,215,0,0.15)] to-transparent" />

      {/* === CONTENT === */}
      <div className="relative z-10 w-full min-h-screen flex flex-col">
        {!tokens ? (
          <>
            <Hero />
            <Login onLogin={handleAuth} busy={busy} error={error} />
          </>
        ) : (
          <Dashboard tokens={tokens} onLogout={logout} />
        )}
      </div>

    </main>
  );
}
