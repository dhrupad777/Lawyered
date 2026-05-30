from agent import lawyered_agent
from agents.drafting import drafting_root_agent
from agents.context_helper import context_helper_agent
from agents.context_extractor import context_extractor_agent
from agents.context_planner import context_planner_agent
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from ag_ui.core.types import RunAgentInput
from fastapi import FastAPI, Header
from pydantic import BaseModel
import uvicorn

import elastic_client

# Which Elastic MCP path the research agent wired up (remote / local / disabled).
try:
    from agents.research import ELASTIC_MODE
except Exception:
    ELASTIC_MODE = "disabled"

app = FastAPI(title="Lawyered Backend")


@app.get("/api/health")
def health() -> dict:
    """Liveness + architecture snapshot for judges and observability."""
    mcp_servers = ["courtlistener", "google_docs"]
    if ELASTIC_MODE != "disabled" or elastic_client.is_configured():
        mcp_servers.append("elastic")
    return {
        "status": "ok",
        "agents": [
            "orchestrator",
            "research_agent",
            "analysis_agent",
            "drafting_agent",
            "drafting_root",
            "context_helper_agent",
            "context_extractor_agent",
            "context_planner_agent",
        ],
        "mcp_servers": mcp_servers,
        "elastic": {"mcp_mode": ELASTIC_MODE, **elastic_client.health_snapshot()},
        "endpoints": [
            "/api/chat",
            "/api/chat-draft",
            "/api/context-helper",
            "/api/context-extract",
            "/api/context-planner",
            "/api/case-memory",
            "/api/user-docs",
            "/api/health",
        ],
    }


# ---------------------------------------------------------------------------
# Elastic write endpoints (server-side so ELASTIC_API_KEY never reaches the
# browser). The frontend calls these with the user's x-user-id header; user_id
# is taken from the header (not the body) so a user can only write their own
# data — mirroring the Firestore ownership model.
# ---------------------------------------------------------------------------

class CaseMemoryIn(BaseModel):
    case_id: str
    summary: str
    issue: str = ""
    status: str = ""
    win_probability: int | None = None
    created_at: str = ""


class UserDocIn(BaseModel):
    doc_id: str
    title: str = ""
    text: str
    case_id: str = ""
    uploaded_at: str = ""


@app.post("/api/case-memory")
def write_case_memory(body: CaseMemoryIn, x_user_id: str = Header(default="anonymous", alias="x-user-id")) -> dict:
    """Index a finished-case summary into the per-user memory layer."""
    return elastic_client.upsert_case_memory(
        {
            "case_id": body.case_id,
            "user_id": x_user_id,
            "summary": body.summary,
            "issue": body.issue,
            "status": body.status,
            "win_probability": body.win_probability,
            "created_at": body.created_at,
        }
    )


@app.post("/api/user-docs")
def write_user_doc(body: UserDocIn, x_user_id: str = Header(default="anonymous", alias="x-user-id")) -> dict:
    """Index an uploaded document's extracted text into the user-docs index."""
    return elastic_client.upsert_user_doc(
        {
            "doc_id": body.doc_id,
            "user_id": x_user_id,
            "case_id": body.case_id,
            "title": body.title,
            "text": body.text,
            "uploaded_at": body.uploaded_at,
        }
    )


def extract_user_id(input_data: RunAgentInput) -> str:
    """Extract user ID from headers injected by extract_headers.

    The extract_headers middleware places x-user-id into
    state.headers.user_id (strips x- prefix, converts hyphens to underscores).
    """
    if isinstance(input_data.state, dict):
        headers = input_data.state.get("headers", {})
        uid = headers.get("user_id")
        if uid:
            return uid
    return "anonymous"


# Main chat endpoint — multi-agent orchestrator (research + analysis + drafting sub-agents).
# Used for the initial case research conversation AND for regeneration flows.
chat_wrapper = ADKAgent(
    adk_agent=lawyered_agent,
    app_name="lawyered",
    user_id_extractor=extract_user_id,
)
add_adk_fastapi_endpoint(
    app,
    chat_wrapper,
    path="/api/chat",
    extract_headers=["x-user-id"],
)

# Dedicated drafting endpoint — bypasses the orchestrator entirely. The frontend
# sends a self-contained "CASE CONTEXT + TASK" prompt. drafting_root_agent has
# no tools and is instructed to output ONLY the plain-text document. This is
# the fix for the "JSON leaking into drafts" bug: drafts no longer go through
# the orchestrator (which is instructed to always emit a ```json block).
draft_wrapper = ADKAgent(
    adk_agent=drafting_root_agent,
    app_name="lawyered-draft",
    user_id_extractor=extract_user_id,
)
add_adk_fastapi_endpoint(
    app,
    draft_wrapper,
    path="/api/chat-draft",
    extract_headers=["x-user-id"],
)

# Context helper endpoint — reads case context + a requested action and returns
# ONE focused question asking for the specific info that's missing. Used by the
# frontend's "missing context bridge": when the user clicks Update Calendar with
# no deadlines (or any other action that needs info not yet in case.md), the
# frontend calls this endpoint, gets back a question, shows it above the Add
# Context textarea, and after the user answers + regenerates, auto-fires the
# original action.
context_helper_wrapper = ADKAgent(
    adk_agent=context_helper_agent,
    app_name="lawyered-context-helper",
    user_id_extractor=extract_user_id,
)
add_adk_fastapi_endpoint(
    app,
    context_helper_wrapper,
    path="/api/context-helper",
    extract_headers=["x-user-id"],
)


# Context extractor endpoint — runs BEFORE the orchestrator on every Add Context.
# Reads case.md + the user's free-text update and emits a structured JSON block
# describing: (1) status (complete | needs_clarification with one question),
# (2) extracted facts with criticality flags, (3) deterministic Google Calendar
# create/update/delete ops with absolute ISO-8601 dates, (4) a criticalChange
# flag listing affected sections. The frontend executes calendar ops directly
# off this JSON instead of inferring them from a deadlines[] diff.
context_extract_wrapper = ADKAgent(
    adk_agent=context_extractor_agent,
    app_name="lawyered-context-extractor",
    user_id_extractor=extract_user_id,
)
add_adk_fastapi_endpoint(
    app,
    context_extract_wrapper,
    path="/api/context-extract",
    extract_headers=["x-user-id"],
)


# Context planner endpoint — multi-turn conversational planner with command
# authority. The agent talks to the user like a real attorney inside the Add
# Context chat panel and emits structured tool-call signals over SSE that the
# frontend executes against Google Calendar / Google Docs / Firestore /
# orchestrator. Same threadId-based session pattern as /api/chat — the
# frontend sends the entire message history on every turn.
context_planner_wrapper = ADKAgent(
    adk_agent=context_planner_agent,
    app_name="lawyered-context-planner",
    user_id_extractor=extract_user_id,
)
add_adk_fastapi_endpoint(
    app,
    context_planner_wrapper,
    path="/api/context-planner",
    extract_headers=["x-user-id"],
)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
