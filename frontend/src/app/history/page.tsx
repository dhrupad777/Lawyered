"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { caseService } from "@/lib/services";
import type { LegalCase, CaseStatus } from "@/lib/models/case";

export default function HistoryPage() {
  const { user, loading: authLoading, signIn } = useAuth();
  const [cases, setCases] = useState<LegalCase[]>([]);
  const [loading, setLoading] = useState(true);
  /** Which row's kebab menu is open. Only one open at a time. */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!user) return;
    caseService.getUserCases(user.uid, 50).then(setCases).catch(console.error).finally(() => setLoading(false));
  }, [user]);

  // Close kebab menu on outside click. Only attached when a menu is open.
  useEffect(() => {
    if (!openMenuId) return;
    const onDocClick = (e: MouseEvent) => {
      const root = menuRootRef.current;
      if (!root) return setOpenMenuId(null);
      if (e.target instanceof Node && !root.contains(e.target)) setOpenMenuId(null);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [openMenuId]);

  const handleClearAll = async () => {
    if (!user || !confirm("Delete all your research history? This cannot be undone.")) return;
    await caseService.deleteUserCases(user.uid);
    setCases([]);
  };

  const handleDelete = async (id: string) => {
    await caseService.deleteCase(id);
    setCases((prev) => prev.filter((c) => c.id !== id));
  };

  const handleSetStatus = async (id: string, status: CaseStatus) => {
    setOpenMenuId(null);
    await caseService.markStatus(id, status);
    setCases((prev) => prev.map((c) => (c.id === id ? { ...c, status } : c)));
  };

  if (authLoading) return (
    <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa" }}>
      <div style={{ width: 28, height: 28, border: "3px solid #e5e7eb", borderTopColor: "#004ee7", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (!user) return (
    <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 360, width: "100%" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#94a3b8", marginBottom: 16, display: "block" }}>history</span>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "'Manrope', sans-serif", marginBottom: 8 }}>Sign in to view your research history</h1>
        <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, marginBottom: 28 }}>Your past case analyses and reports are saved to your account.</p>
        <button onClick={() => signIn().catch((e) => { const c = (e as { code?: string }).code; if (c !== "auth/popup-closed-by-user" && c !== "auth/cancelled-popup-request") console.error(e); })} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Sign in with Google
        </button>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>First time? Google sign-in creates your free account.</p>
        <a href="/" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#64748b", marginTop: 20, textDecoration: "none" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span> Back to home
        </a>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100dvh", background: "#f8f9fa" }}>
      {/* Header */}
      <header style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 clamp(16px, 3vw, 32px)", background: "#fff", borderBottom: "1px solid #e5e7eb", position: "sticky", top: 0, zIndex: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Link href="/" style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.04em", color: "#0f172a" }}>Lawyered</Link>
          <nav className="hidden md:flex" style={{ gap: 16, fontSize: 13, fontWeight: 600 }}>
            <Link href="/app" style={{ color: "#94a3b8" }}>Dashboard</Link>
            <span style={{ color: "#0f172a", borderBottom: "2px solid #004ee7", paddingBottom: 4 }}>History</span>
          </nav>
        </div>
        <Link href="/app" style={{ background: "#004ee7", color: "#fff", fontSize: 13, fontWeight: 700, padding: "8px 18px", borderRadius: 6 }}>
          New Research
        </Link>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px clamp(16px, 4vw, 32px)" }}>
        {/* Title row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, marginBottom: 4 }}>Research History</h1>
            <p style={{ fontSize: 14, color: "#64748b" }}>{cases.length} case{cases.length !== 1 ? "s" : ""} analyzed</p>
          </div>
          {cases.length > 0 && (
            <button onClick={handleClearAll} style={{ fontSize: 12, fontWeight: 600, color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 14px", cursor: "pointer" }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14, marginRight: 4, verticalAlign: "middle" }}>delete</span>
              Clear All
            </button>
          )}
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "#94a3b8" }}>
            <div style={{ width: 24, height: 24, border: "3px solid #e5e7eb", borderTopColor: "#004ee7", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
            Loading...
          </div>
        ) : cases.length === 0 ? (
          <div style={{ textAlign: "center", padding: "80px 20px", color: "#94a3b8" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, marginBottom: 16, display: "block", opacity: 0.3 }}>folder_open</span>
            <h3 style={{ fontSize: 18, color: "#64748b", marginBottom: 6 }}>No research yet</h3>
            <p style={{ fontSize: 14 }}>Start your first case from the <Link href="/app" style={{ color: "#004ee7", fontWeight: 600 }}>dashboard</Link>.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {cases.map((c) => {
              const statusMeta: Record<string, { icon: string; bg: string; fg: string; label: string }> = {
                gathering: { icon: "pending", bg: "#eff6ff", fg: "#004ee7", label: "Gathering" },
                ready: { icon: "check_circle", bg: "#f0fdf4", fg: "#16a34a", label: "Active" },
                error: { icon: "error", bg: "#fef2f2", fg: "#dc2626", label: "Error" },
                settled: { icon: "handshake", bg: "#fef3c7", fg: "#92400e", label: "Settled" },
                won: { icon: "trophy", bg: "#dcfce7", fg: "#15803d", label: "Won" },
                lost: { icon: "do_not_disturb_on", bg: "#fee2e2", fg: "#991b1b", label: "Lost" },
              };
              const m = statusMeta[c.status] ?? statusMeta.gathering;
              const viewable = c.status !== "gathering" && c.status !== "error";
              return (
                <div key={c.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "18px 20px", display: "flex", alignItems: "center", gap: 16 }}>
                  {/* Status icon */}
                  <div style={{ width: 40, height: 40, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: m.bg }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 20, color: m.fg }}>{m.icon}</span>
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{c.query}</span>
                      <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 999, background: m.bg, color: m.fg, textTransform: "uppercase", letterSpacing: "0.05em", flexShrink: 0 }}>{m.label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>
                      {c.createdAt?.seconds
                        ? new Date(c.createdAt.seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                        : ""}
                      {c.overview?.issueDetected && (
                        <span style={{ color: "#64748b" }}> · {c.overview.issueDetected.slice(0, 60)}...</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, position: "relative" }} ref={openMenuId === c.id ? menuRootRef : undefined}>
                    {viewable && (
                      <Link href={`/case/${c.id}`} style={{ fontSize: 12, fontWeight: 700, color: "#004ee7", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "7px 14px", display: "flex", alignItems: "center", gap: 4 }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                        View Report
                      </Link>
                    )}
                    {/* Kebab menu — opens a popover with status actions */}
                    <button
                      onClick={() => setOpenMenuId(openMenuId === c.id ? null : c.id)}
                      title="More actions"
                      style={{ fontSize: 12, color: "#64748b", background: "transparent", border: "1px solid #e5e7eb", borderRadius: 6, padding: "7px 10px", cursor: "pointer", display: "flex", alignItems: "center" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>more_vert</span>
                    </button>
                    {openMenuId === c.id && (
                      <div style={{
                        position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30,
                        minWidth: 160, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
                        boxShadow: "0 8px 24px rgba(15,23,42,0.12)", padding: 4,
                      }}>
                        {(["ready", "settled", "won", "lost"] as CaseStatus[]).map((s) => {
                          const labels: Record<CaseStatus, string> = { gathering: "Gathering", ready: "Mark Active", error: "Error", settled: "Mark Settled", won: "Mark Won", lost: "Mark Lost" };
                          const icons: Record<CaseStatus, string> = { gathering: "pending", ready: "play_circle", error: "error", settled: "handshake", won: "trophy", lost: "do_not_disturb_on" };
                          const isCurrent = c.status === s;
                          return (
                            <button
                              key={s}
                              onClick={() => handleSetStatus(c.id, s)}
                              disabled={isCurrent}
                              style={{
                                display: "flex", alignItems: "center", gap: 8, width: "100%",
                                padding: "8px 12px", fontSize: 12, fontWeight: 600,
                                background: isCurrent ? "#f1f5f9" : "transparent",
                                color: isCurrent ? "#94a3b8" : "#0f172a",
                                border: "none", borderRadius: 5, textAlign: "left",
                                cursor: isCurrent ? "default" : "pointer",
                              }}
                              onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "#f8fafc"; }}
                              onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{icons[s]}</span>
                              {labels[s]}
                              {isCurrent && <span style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8" }}>current</span>}
                            </button>
                          );
                        })}
                        <div style={{ height: 1, background: "#e2e8f0", margin: "4px 0" }} />
                        <button
                          onClick={() => { setOpenMenuId(null); handleDelete(c.id); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, width: "100%",
                            padding: "8px 12px", fontSize: 12, fontWeight: 600,
                            background: "transparent", color: "#dc2626",
                            border: "none", borderRadius: 5, textAlign: "left", cursor: "pointer",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#fef2f2")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                          Delete case
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
