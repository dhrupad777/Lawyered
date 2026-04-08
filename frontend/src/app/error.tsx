"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa", padding: 24 }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#dc2626", marginBottom: 16, display: "block" }}>error</span>
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, marginBottom: 24 }}>
          {error.message || "An unexpected error occurred. Please try again."}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button onClick={reset} style={{ padding: "10px 20px", fontSize: 13, fontWeight: 700, background: "#004ee7", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}>
            Try Again
          </button>
          <a href="/" style={{ padding: "10px 20px", fontSize: 13, fontWeight: 600, background: "#f1f5f9", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 8 }}>
            Go Home
          </a>
        </div>
      </div>
    </div>
  );
}
