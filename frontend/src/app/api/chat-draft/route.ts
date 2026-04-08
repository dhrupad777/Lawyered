const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8080";

/**
 * Proxy to the backend's /api/chat-draft endpoint.
 *
 * This is a separate endpoint from /api/chat because the backend's
 * drafting agent (drafting_root_agent) is wrapped as its own root agent
 * and instructed to output ONLY plain text — no JSON, no code fences.
 * The main /api/chat endpoint goes through the orchestrator which is
 * required to emit a ```json case report, which is the opposite of what
 * we want when the user is just asking for a demand letter.
 */
export async function POST(req: Request) {
  const body = await req.json();

  const res = await fetch(`${BACKEND_URL}/api/chat-draft`, {
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
