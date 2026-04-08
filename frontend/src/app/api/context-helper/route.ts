const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8080";

/**
 * Proxy to the backend's /api/context-helper endpoint.
 *
 * Same SSE-streaming pattern as /api/chat and /api/chat-draft. The backend's
 * context_helper_agent is a small no-tools LlmAgent that reads the case
 * context plus a requested action identifier and returns ONE focused question
 * asking the user for the specific info that's missing.
 */
export async function POST(req: Request) {
  const body = await req.json();

  const res = await fetch(`${BACKEND_URL}/api/context-helper`, {
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
