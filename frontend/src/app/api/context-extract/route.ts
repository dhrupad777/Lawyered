const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8080";

/**
 * Proxy to the backend's /api/context-extract endpoint.
 *
 * Same SSE-streaming pattern as /api/chat, /api/chat-draft and
 * /api/context-helper. The backend's context_extractor_agent reads the user's
 * free-text update against the existing case.md and emits a single ```json
 * fenced block with the structured intent (status, facts, calendar_ops,
 * criticalChange + affectedSections). The frontend parses this JSON and
 * executes Google Calendar create/update/delete operations directly off it.
 *
 * This route MUST exist — without it the dev server returns 404 and the
 * "Add Context → Save & Regenerate" flow falls through to the legacy
 * free-text path. Demo-day reliability depends on it being here.
 */
export async function POST(req: Request) {
  const body = await req.json();

  const res = await fetch(`${BACKEND_URL}/api/context-extract`, {
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
