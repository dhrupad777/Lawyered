"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatService, type ChatMessage } from "@/lib/chat";
import { caseService } from "@/lib/services";

interface ChatProps {
  initialQuery: string | null;
  userId: string;
}

function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

export function Chat({ initialQuery, userId }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [toolSteps, setToolSteps] = useState<string[]>([]);
  const chatServiceRef = useRef(new ChatService());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasSentInitial = useRef(false);
  const caseIdRef = useRef<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  const handleCaseResult = useCallback(async (fullText: string) => {
    const data = extractJson(fullText);
    if (!data || !data.overview) return;
    setRedirecting(true);
    if (!caseIdRef.current) {
      caseIdRef.current = await caseService.createCase(userId, initialQuery || messages[0]?.content || "");
    }
    await caseService.saveResult(caseIdRef.current, data as unknown as Parameters<typeof caseService.saveResult>[1]);
    window.location.href = `/case/${caseIdRef.current}`;
  }, [userId, initialQuery, messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text.trim() };
    const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);
    setToolSteps([]);
    let fullResponse = "";
    // Inject CURRENT_DATE so the orchestrator can resolve relative dates the
    // user might mention ("my hearing is in 20 days", "next Tuesday", etc.).
    // Only the API copy is augmented — the message rendered in chat stays
    // exactly as the user typed it.
    const today = new Date().toISOString().slice(0, 10);
    const augmentedUserMsg: ChatMessage = {
      ...userMsg,
      content: `CURRENT_DATE: ${today}\n\n${userMsg.content}`,
    };
    await chatServiceRef.current.sendMessage(
      [...messages, augmentedUserMsg],
      (token) => {
        fullResponse += token;
        setToolSteps([]); // Clear steps once text starts streaming
        setMessages((prev) => {
          const u = [...prev];
          const last = u[u.length - 1];
          if (last?.role === "assistant") u[u.length - 1] = { ...last, content: last.content + token };
          return u;
        });
      },
      () => { setIsLoading(false); setToolSteps([]); handleCaseResult(fullResponse); },
      (err) => {
        setMessages((prev) => {
          const u = [...prev];
          const last = u[u.length - 1];
          if (last?.role === "assistant") u[u.length - 1] = { ...last, content: `Error: ${err}` };
          return u;
        });
        setIsLoading(false);
        setToolSteps([]);
      },
      // onToolCall — show what the agent is doing
      (name, status) => {
        const labels: Record<string, string> = {
          search_cases: "Searching court cases",
          search_related_statutes: "Searching statutes",
          get_case_details: "Retrieving case details",
          get_opinion: "Reading court opinion",
          get_docket: "Fetching docket info",
        };
        const label = labels[name] || `Running ${name}`;
        if (status === "start") {
          setToolSteps((prev) => [...prev, label]);
        }
      },
    );
  }, [isLoading, messages, handleCaseResult]);

  useEffect(() => {
    if (!initialQuery || hasSentInitial.current) return;
    hasSentInitial.current = true;
    sendMessage(initialQuery);
  }, [initialQuery, sendMessage]);

  if (redirecting) return (
    <div style={S.center}>
      <div style={S.spinner} />
      <p style={{ fontSize: 14, color: "#64748b", fontWeight: 500 }}>Building your case report...</p>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={S.container}>
      {/* Messages */}
      <div style={S.messageArea}>
        {messages.length === 0 && !isLoading && (
          <div style={S.welcome}>
            <div style={S.welcomeIcon}>
              <span className="material-symbols-outlined" style={{ fontSize: 32, color: "#004ee7" }}>gavel</span>
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Manrope', sans-serif", color: "#1e293b" }}>Welcome to Lawyered</h2>
            <p style={{ fontSize: 14, color: "#64748b", maxWidth: 360, lineHeight: 1.6 }}>
              Describe your legal situation and I&apos;ll search real court cases to build a full case report with analysis, documents, and strategy.
            </p>
            <p style={{ fontSize: 11, color: "#94a3b8", maxWidth: 360, lineHeight: 1.5, marginTop: 4 }}>
              Your data is processed securely. This does not create an attorney-client relationship. <a href="/privacy" style={{ color: "#004ee7", textDecoration: "underline" }}>Privacy Policy</a>
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", marginBottom: 16 }}>
            {msg.role === "assistant" && (
              <div style={S.avatar}>
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#004ee7" }}>gavel</span>
              </div>
            )}
            <div style={{
              ...S.bubble,
              ...(msg.role === "user" ? S.userBubble : S.assistantBubble),
            }}>
              {msg.role === "assistant" ? (
                <div
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(
                      (msg.content || (isLoading ? "Searching court cases..." : ""))
                        .replace(/```json[\s\S]*?```/g, "\n\n*Building your case report...*\n")
                    ),
                  }}
                  style={{ wordBreak: "break-word" }}
                />
              ) : (
                <span>{msg.content}</span>
              )}
            </div>
          </div>
        ))}
        {/* Tool-call step indicators */}
        {toolSteps.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12, padding: "0 4px" }}>
            {toolSteps.map((step, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#64748b" }}>
                <div style={{ width: 16, height: 16, border: "2px solid #e2e8f0", borderTopColor: "#004ee7", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                {step}...
              </div>
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={S.inputArea}>
        <div style={S.inputBox}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(input); } }}
            placeholder={messages.length === 0 ? "Describe your legal situation..." : "Type your reply..."}
            disabled={isLoading}
            rows={1}
            style={S.textarea}
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
            style={{
              ...S.sendBtn,
              background: isLoading || !input.trim() ? "#e2e8f0" : "#004ee7",
              cursor: isLoading || !input.trim() ? "default" : "pointer",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#fff" }}>
              {isLoading ? "hourglass_top" : "arrow_upward"}
            </span>
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", marginTop: 8 }}>
          Powered by CourtListener &middot; Not legal advice
        </p>
      </div>
    </div>
  );
}

/* ── Styles ── */
const S: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
  messageArea: { flex: 1, overflowY: "auto", padding: "24px 16px", maxWidth: 720, width: "100%", margin: "0 auto" },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 },
  spinner: { width: 32, height: 32, border: "3px solid #e5e7eb", borderTopColor: "#004ee7", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  welcome: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 12, padding: "60px 20px" },
  welcomeIcon: { width: 56, height: 56, borderRadius: 16, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center" },
  avatar: { width: 28, height: 28, borderRadius: 8, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginRight: 10, marginTop: 2 },
  bubble: { maxWidth: "80%", padding: "12px 16px", borderRadius: 12, fontSize: 14, lineHeight: 1.7, overflowWrap: "break-word" as const },
  userBubble: { background: "#004ee7", color: "#fff", borderBottomRightRadius: 4 },
  assistantBubble: { background: "#fff", color: "#1e293b", border: "1px solid #e5e7eb", borderBottomLeftRadius: 4 },
  inputArea: { padding: "12px 16px 16px", borderTop: "1px solid #f1f5f9", background: "#fafbfc" },
  inputBox: {
    display: "flex", alignItems: "flex-end", gap: 8,
    background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
    padding: "8px 8px 8px 16px",
    maxWidth: 720, margin: "0 auto",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  },
  textarea: {
    flex: 1, resize: "none", border: "none", outline: "none",
    padding: "8px 0", fontSize: 15, fontFamily: "inherit",
    color: "#1e293b", background: "transparent",
    minHeight: 24, maxHeight: 120, lineHeight: 1.5,
  },
  sendBtn: {
    width: 36, height: 36, border: "none", borderRadius: 10,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
};

function renderMarkdown(text: string): string {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#004ee7;text-decoration:underline;text-underline-offset:3px">$1</a>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:700;margin:16px 0 6px;font-family:Manrope,sans-serif">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:17px;font-weight:700;margin:20px 0 8px;font-family:Manrope,sans-serif">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:700;margin:24px 0 10px;font-family:Manrope,sans-serif">$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote style="border-left:3px solid #004ee7;padding-left:12px;color:#64748b;margin:8px 0;font-style:italic">$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;list-style-type:decimal">$2</li>')
    .replace(/\n\n/g, '<div style="height:12px"></div>')
    .replace(/\n/g, "<br>");
}
