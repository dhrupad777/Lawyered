"use client";

import { useState } from "react";

/**
 * DocumentUpload — lets a user add a legal document (lease, contract, evidence,
 * letter) to their case. The extracted plain text is sent to /api/user-docs,
 * where the backend indexes it into the Elastic `lawyered-user-docs` index with
 * ELSER semantic embeddings. The research agent can then ground answers in the
 * user's own files via the `search_user_documents` tool.
 *
 * Text extraction is client-side:
 *   • .txt / .md            → read directly
 *   • .pdf                  → pdfjs-dist (dynamic import, best effort)
 *   • anything else / fail  → user pastes the text manually
 *
 * Self-contained: it does its own POST so it doesn't need a CaseService
 * instance threaded in. Scoped to the user via the x-user-id header.
 */
export default function DocumentUpload({
  userId,
  caseId,
}: {
  userId: string;
  caseId: string;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function extractPdf(file: File): Promise<string> {
    // Dynamic import keeps pdfjs out of the main bundle and off the SSR path.
    const pdfjs = await import("pdfjs-dist");
    // Worker version must match the library version.
    (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
      `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out +=
        content.items
          .map((it) => ("str" in it ? (it as { str: string }).str : ""))
          .join(" ") + "\n";
    }
    return out.trim();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    setStatus("Reading file…");
    try {
      let extracted = "";
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        extracted = await extractPdf(file);
      } else {
        extracted = await file.text();
      }
      if (!extracted.trim()) {
        setStatus("Couldn't extract text — please paste the document text below.");
      } else {
        setText(extracted);
        setStatus(`Loaded ${extracted.length.toLocaleString()} characters.`);
      }
    } catch {
      setStatus("Couldn't read that file — please paste the document text below.");
    }
  }

  async function submit() {
    if (!userId) {
      setStatus("Please sign in first.");
      return;
    }
    if (!text.trim()) {
      setStatus("Add some document text first.");
      return;
    }
    setBusy(true);
    setStatus("Indexing into your document library…");
    try {
      const docId =
        globalThis.crypto?.randomUUID?.() ?? `doc-${Date.now()}`;
      const res = await fetch("/api/user-docs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: JSON.stringify({
          doc_id: docId,
          title: title || "Untitled document",
          text,
          case_id: caseId,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (out?.ok) {
        setStatus("Indexed. The assistant can now reference this document.");
        setTitle("");
        setText("");
      } else {
        setStatus(out?.error || "Indexing is unavailable (Elastic not configured).");
      }
    } catch {
      setStatus("Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-start",
          padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer",
          background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8,
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>upload_file</span>
        Add a document (lease, contract, evidence)
      </button>
    );
  }

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#16a34a" }}>upload_file</span>
          Add a document
        </h3>
        <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", lineHeight: 0 }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
        Upload a .txt, .md or .pdf — or paste the text. It&apos;s indexed semantically so the assistant can cite it when researching your case. Only you can search your documents.
      </p>
      <input
        type="text"
        placeholder="Document title (e.g. Residential Lease 2024)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={{ padding: "10px 12px", fontSize: 13, border: "1px solid #e2e8f0", borderRadius: 8 }}
      />
      <input type="file" accept=".txt,.md,.text,.pdf,application/pdf,text/plain" onChange={onFile} style={{ fontSize: 13 }} />
      <textarea
        placeholder="…or paste the document text here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        style={{ padding: "10px 12px", fontSize: 13, border: "1px solid #e2e8f0", borderRadius: 8, resize: "vertical", fontFamily: "inherit" }}
      />
      {status && <p style={{ fontSize: 12, color: "#475569" }}>{status}</p>}
      <button
        onClick={submit}
        disabled={busy}
        style={{
          alignSelf: "flex-start", padding: "10px 20px", fontSize: 13, fontWeight: 700,
          border: "none", borderRadius: 8, cursor: busy ? "default" : "pointer",
          background: busy ? "#94a3b8" : "#16a34a", color: "#fff",
        }}
      >
        {busy ? "Indexing…" : "Add to my documents"}
      </button>
    </div>
  );
}
