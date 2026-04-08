const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8080";

/**
 * Proxy to the backend's /api/context-planner endpoint.
 *
 * Same SSE streaming pattern as /api/chat, /api/chat-draft, /api/context-helper,
 * and /api/context-extract. The backend's context_planner_agent is a multi-turn
 * conversational planner with FunctionTool tools — it asks the user clarifying
 * questions and emits structured tool-call signals (calendar ops, new documents,
 * immediate drafting, structured facts, critical regenerates) over the SSE
 * stream. The frontend executes the actual mutations against Google Calendar,
 * Google Docs, Firestore, and the orchestrator.
 *
 * Without this route the dev server returns 404 — every backend agent endpoint
 * needs its own Next.js proxy route under src/app/api/.
 */
export async function POST(req: Request) {
  const body = await req.json();

  const res = await fetch(`${BACKEND_URL}/api/context-planner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Backend error: ${res.status}` }), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
