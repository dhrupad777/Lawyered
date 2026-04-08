"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { Chat } from "@/components/Chat";

const SIDEBAR_ITEMS = [
  { icon: "gavel", label: "New Research", href: "/app" },
  { icon: "history", label: "History", href: "/history" },
];

const MOBILE_ITEMS = [
  { icon: "gavel", label: "Research", href: "/app" },
  { icon: "history", label: "History", href: "/history" },
];

function Workspace() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q");
  const { user, loading, signIn, signOut } = useAuth();
  const [signInError, setSignInError] = useState<string | null>(null);

  const handleSignIn = async () => {
    try {
      setSignInError(null);
      await signIn();
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      setSignInError("Sign-in failed. Please try again.");
      console.error("Sign-in error:", e);
    }
  };

  if (loading) return (
    <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa" }}>
      <div style={{ width: 28, height: 28, border: "2px solid #e5e7eb", borderTopColor: "#004ee7", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!user) return (
    <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 360, width: "100%" }}>
        <h1 style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "'Manrope', sans-serif" }}>Lawyered</h1>
        <p style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.15em", marginTop: 4, marginBottom: 16 }}>Intelligence for Legal Strategy</p>
        <p style={{ fontSize: 14, color: "#64748b", marginBottom: initialQuery ? 16 : 32, lineHeight: 1.5 }}>Sign in to start your legal research</p>
        {initialQuery && (
          <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 12, marginBottom: 24, textAlign: "left" }}>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#004ee7", marginBottom: 4 }}>Your query is saved</p>
            <p style={{ fontSize: 13, color: "#1e3a5f", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>&ldquo;{initialQuery}&rdquo;</p>
            <p style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>We&apos;ll run your analysis right after sign-in.</p>
          </div>
        )}

        <button onClick={handleSignIn} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Sign in with Google
        </button>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 14 }}>First time? Google sign-in creates your free account.</p>

        {signInError && <p style={{ color: "#dc2626", fontSize: 13, marginTop: 12 }}>{signInError}</p>}
        <a href="/" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#64748b", marginTop: 24, textDecoration: "none" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span> Back to home
        </a>
        <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 24 }}>&copy; 2024 Lawyered Intelligence.</p>
      </div>
    </div>
  );

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "#f8f9fa", overflow: "hidden" }}>
      {/* Header */}
      <header style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 clamp(12px, 2vw, 24px)", background: "#fff", borderBottom: "1px solid #e5e7eb", flexShrink: 0, zIndex: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "clamp(12px, 2vw, 24px)" }}>
          <Link href="/" style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.03em", color: "#0f172a", textDecoration: "none", fontFamily: "'Manrope', sans-serif" }}>Lawyered</Link>
          <nav className="hidden md:flex" style={{ gap: 16, fontSize: 12, fontWeight: 500, fontFamily: "'Manrope', sans-serif" }}>
            <a href="#" style={{ color: "#0f172a", borderBottom: "2px solid #004ee7", paddingBottom: 2 }}>Dashboard</a>
            <a href="/history" style={{ color: "#94a3b8", textDecoration: "none" }}>History</a>
            <a href="#" style={{ color: "#94a3b8", textDecoration: "none" }}>Library</a>
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="hidden md:block" style={{ background: "#004ee7", color: "#fff", fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 4, border: "none", cursor: "pointer" }}>New Research</button>
          <button onClick={signOut} style={{ width: 30, height: 30, borderRadius: "50%", overflow: "hidden", border: "2px solid transparent", cursor: "pointer", padding: 0, flexShrink: 0 }} title="Sign out">
            {user.photoURL
              ? <img src={user.photoURL} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} referrerPolicy="no-referrer" />
              : <div style={{ width: "100%", height: "100%", background: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}><span className="material-symbols-outlined" style={{ fontSize: 14, color: "#94a3b8" }}>person</span></div>}
          </button>
        </div>
      </header>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {/* Sidebar */}
        <aside className="hidden lg:flex" style={{ flexDirection: "column", width: 220, background: "#fafafa", borderRight: "1px solid #e5e7eb", padding: "20px 12px", flexShrink: 0 }}>
          <div style={{ padding: "0 8px", marginBottom: 24 }}>
            <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8", marginBottom: 2 }}>Intelligence</p>
            <p style={{ fontSize: 13, fontWeight: 500, color: "#64748b" }}>Deterministic AI</p>
          </div>
          <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
            {SIDEBAR_ITEMS.map((it, idx) => (
              <a
                key={it.label}
                href={it.href}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 4, fontSize: 13, fontWeight: 600, fontFamily: "'Manrope', sans-serif", textDecoration: "none", color: idx === 0 ? "#004ee7" : "#64748b", background: idx === 0 ? "#fff" : "transparent", boxShadow: idx === 0 ? "0 1px 2px rgba(0,0,0,0.05)" : "none" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{it.icon}</span>
                {it.label}
              </a>
            ))}
          </nav>
        </aside>

        {/* Chat */}
        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, background: "#fff", paddingBottom: 56 }} className="lg:!pb-0">
          <Chat initialQuery={initialQuery} userId={user.uid} />
        </main>
      </div>

      {/* Mobile bottom bar */}
      <nav className="lg:hidden" style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, display: "flex", justifyContent: "space-around", background: "#fff", borderTop: "1px solid #e5e7eb", padding: "6px 0", paddingBottom: "max(6px, env(safe-area-inset-bottom))" }}>
        {MOBILE_ITEMS.map((it, idx) => (
          <a
            key={it.label}
            href={it.href}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 8px", color: idx === 0 ? "#004ee7" : "#94a3b8", textDecoration: "none" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{it.icon}</span>
            <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{it.label}</span>
          </a>
        ))}
      </nav>

      <style>{`
        .lg\\:!pb-0 { padding-bottom: 56px; }
        @media (min-width: 1024px) { .lg\\:!pb-0 { padding-bottom: 0 !important; } }
      `}</style>
    </div>
  );
}

export default function AppPage() {
  return <Suspense><Workspace /></Suspense>;
}
