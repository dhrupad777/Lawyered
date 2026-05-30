const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8080";

// Proxy: write a finished-case summary into the Elastic per-user memory index.
// Forwards x-user-id so the backend scopes the write to the authenticated user.
export async function POST(req: Request) {
  const body = await req.json();
  const userId = req.headers.get("x-user-id") || "anonymous";

  const res = await fetch(`${BACKEND_URL}/api/case-memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": userId },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
