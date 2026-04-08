"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";

export default function LandingPage() {
  const [query, setQuery] = useState("");
  const { user, loading, signIn, signOut } = useAuth();

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", color: "#1e293b", fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ── Nav ── */}
      <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 clamp(16px, 4vw, 32px)", background: "rgba(255,255,255,0.85)", backdropFilter: "blur(12px)", borderBottom: "1px solid #e5e7eb" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 32, minWidth: 0, overflow: "hidden" }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "'Manrope', sans-serif", flexShrink: 0 }}>Lawyered</span>
          <div className="hidden md:flex" style={{ gap: 24, fontSize: 13, fontWeight: 500, fontFamily: "'Manrope', sans-serif" }}>
            <a href="#" style={{ color: "#0f172a", borderBottom: "2px solid #004ee7", paddingBottom: 2 }}>Dashboard</a>
            <a href="/history" style={{ color: "#94a3b8" }}>History</a>
            <a href="#" style={{ color: "#94a3b8" }}>Library</a>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {!loading && (user ? (
            <>
              <Link href="/app" style={{ background: "#004ee7", color: "#fff", fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 4, textDecoration: "none" }}>New Research</Link>
              <button onClick={signOut} style={{ width: 32, height: 32, borderRadius: "50%", overflow: "hidden", border: "none", cursor: "pointer", padding: 0 }}>
                {user.photoURL ? <img src={user.photoURL} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} referrerPolicy="no-referrer" /> : <div style={{ width: "100%", height: "100%", background: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}><span className="material-symbols-outlined" style={{ fontSize: 16, color: "#94a3b8" }}>person</span></div>}
              </button>
            </>
          ) : (
            <button onClick={signIn} style={{ background: "#004ee7", color: "#fff", fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 4, border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>login</span> Sign In / Sign Up
            </button>
          ))}
        </div>
      </nav>

      {/* ── Hero ── */}
      <section style={{ paddingTop: "clamp(100px, 15vh, 180px)", paddingBottom: "clamp(40px, 8vh, 100px)", textAlign: "center", maxWidth: 900, margin: "0 auto", padding: "clamp(100px, 15vh, 180px) clamp(16px, 5vw, 32px) clamp(40px, 8vh, 100px)" }}>
        <h1 style={{ fontSize: "clamp(2rem, 6vw, 5.5rem)", fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, color: "#000", fontFamily: "'Manrope', sans-serif", margin: 0 }}>
          Got screwed legally?<br />Type what happened.
        </h1>
        <p style={{ marginTop: "clamp(12px, 2vw, 24px)", fontSize: "clamp(14px, 2vw, 20px)", color: "#64748b", maxWidth: 520, margin: "clamp(12px, 2vw, 24px) auto 0", lineHeight: 1.6 }}>
          Deterministic AI + real case citations. <span style={{ color: "#000", fontWeight: 600 }}>No hallucinations.</span> Just the law.
        </p>

        {/* Search */}
        <div style={{ marginTop: "clamp(24px, 4vw, 56px)", maxWidth: 640, margin: "clamp(24px, 4vw, 56px) auto 0" }}>
          <div style={{ display: "flex", flexDirection: "var(--search-dir, column)" as never, gap: 12, background: "#fff", padding: 12, borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", border: "1px solid #e5e7eb" }} className="search-bar">
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "#f8fafc", borderRadius: 4 }}>
              <span className="material-symbols-outlined" style={{ color: "#94a3b8", fontSize: 20 }}>gavel</span>
              <input
                style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: "clamp(14px, 1.5vw, 18px)", color: "#1e293b" }}
                placeholder="Explain my situation..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && query.trim() && (window.location.href = `/app?q=${encodeURIComponent(query)}`)}
              />
            </div>
            <button onClick={() => window.location.href = `/app${query ? `?q=${encodeURIComponent(query)}` : ""}`} style={{ background: "#000", color: "#fff", padding: "14px 28px", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, borderRadius: 4, border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
              Start Analysis
            </button>
          </div>
          {!user && (
            <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 12, textAlign: "center" }}>
              No account? Signing in with Google creates one automatically.
            </p>
          )}
          {/* Scenario Cards */}
          <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, textAlign: "left" }}>
            {[
              { icon: "home", title: "Security Deposit", query: "My landlord is refusing to return my security deposit after I moved out 60 days ago" },
              { icon: "work", title: "Wrongful Termination", query: "I was fired without warning after reporting safety violations at work" },
              { icon: "gavel", title: "Contract Breach", query: "The contractor I hired took my deposit and never completed the work" },
              { icon: "shield", title: "Consumer Rights", query: "I purchased a product that was falsely advertised and the company refuses a refund" },
            ].map((s) => (
              <button key={s.title} onClick={() => window.location.href = `/app?q=${encodeURIComponent(s.query)}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, textDecoration: "none", color: "inherit", cursor: "pointer", transition: "border-color 0.15s", textAlign: "left" }}>
                <div style={{ width: 36, height: 36, background: "#f1f5f9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#004ee7" }}>{s.icon}</span>
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "'Manrope', sans-serif", color: "#1e293b" }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.4, marginTop: 2 }}>{s.query.slice(0, 60)}...</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section style={{ background: "#f1f5f9", padding: "clamp(48px, 8vw, 128px) clamp(16px, 5vw, 32px)" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "clamp(32px, 4vw, 64px)" }}>
          {[
            { icon: "library_books", title: "Case Citations", desc: "Every claim backed by real-world precedent from millions of court records." },
            { icon: "verified", title: "Verified Sources", desc: "Data pulled directly from CourtListener. No secondary interpretations." },
            { icon: "api", title: "Real-time APIs", desc: "Connected to the legal system in real-time. New filings update instantly." },
          ].map((f) => (
            <div key={f.title} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ width: 44, height: 44, background: "#000", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 20 }}>{f.icon}</span>
              </div>
              <h3 style={{ fontSize: "clamp(16px, 1.5vw, 22px)", fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "'Manrope', sans-serif" }}>{f.title}</h3>
              <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ background: "#000", padding: "clamp(48px, 10vw, 128px) clamp(16px, 5vw, 32px)", textAlign: "center" }}>
        <h2 style={{ color: "#fff", fontSize: "clamp(1.5rem, 5vw, 4rem)", fontWeight: 700, letterSpacing: "-0.03em", fontFamily: "'Manrope', sans-serif", marginBottom: "clamp(20px, 3vw, 48px)" }}>
          Ready to defend your rights?
        </h2>
        <Link href="/app" style={{ display: "inline-block", background: "#fff", color: "#000", padding: "14px clamp(24px, 4vw, 48px)", fontSize: "clamp(14px, 1.2vw, 18px)", fontWeight: 700, borderRadius: 4, textDecoration: "none" }}>
          Try it now
        </Link>
        <p style={{ color: "#64748b", marginTop: 16, fontSize: 13 }}>Free basic assessment. No credit card required.</p>
      </section>

      {/* ── Footer ── */}
      <footer style={{ background: "#fff", borderTop: "1px solid #e5e7eb", padding: "clamp(24px, 4vw, 48px) clamp(16px, 5vw, 32px)" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <div>
            <span style={{ fontWeight: 700, fontFamily: "'Manrope', sans-serif" }}>Lawyered</span>
            <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>&copy; 2024 Lawyered Intelligence.</p>
          </div>
          <div style={{ display: "flex", gap: 20, fontSize: 11, color: "#94a3b8" }}>
            {[
              { label: "Terms", href: "#" },
              { label: "Privacy", href: "/privacy" },
              { label: "Compliance", href: "#" },
              { label: "Security", href: "#" },
            ].map((l) => (
              <a key={l.label} href={l.href} style={{ color: "inherit", textDecoration: "none" }}>{l.label}</a>
            ))}
          </div>
        </div>
      </footer>

      <style>{`
        @media (min-width: 640px) {
          .search-bar { flex-direction: row !important; }
        }
      `}</style>
    </div>
  );
}
