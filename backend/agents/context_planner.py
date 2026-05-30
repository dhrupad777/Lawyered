"""ContextPlannerAgent — multi-turn conversational planner with command authority.

Behaves like a real attorney inside the Add Context chat panel. The agent talks
to the user in plain English, asks ONE clarifying question at a time when needed,
and takes action by calling FunctionTool tools that emit structured signals over
the AG-UI SSE stream.

The tools are intentionally side-effect-free on the server side. Each tool just
returns a short confirmation string. The frontend listens for TOOL_CALL_START /
TOOL_CALL_END events (along with the parsed arguments) and executes the real
mutation against:

  - Google Calendar  → CalendarService (browser holds the OAuth token)
  - Google Docs      → DocsService     (browser holds the OAuth token)
  - Firestore        → CaseService     (browser-side Firebase Auth)
  - Orchestrator     → handleRegenerate({criticalMode}) on the case page

This signals-not-mutations pattern keeps every secret in the browser where it
already lives, matches the existing AG-UI streaming protocol that ChatService
already speaks, and lets the planner stay a pure decision-making agent.
"""

from google.adk.agents import LlmAgent
from google.adk.tools import FunctionTool

from prompts import CONTEXT_PLANNER_INSTRUCTION
from model_config import MODEL


# ─── Tool functions ────────────────────────────────────────────────────────
# Each function's docstring + type hints become the tool schema the model sees.
# The body is intentionally a no-op return — the work happens on the frontend
# when it receives the tool-call event over SSE.


def propose_calendar_op(
    op: str,
    match_title: str,
    title: str,
    description: str,
    date_iso: str,
    duration_minutes: int,
    type: str,
    urgency: str,
) -> str:
    """Schedule, reschedule, or cancel a Google Calendar event for the case.

    Args:
        op: One of "create", "update", or "delete".
        match_title: For update or delete, the exact title of the existing
            deadline as it appears in CASE CONTEXT. Empty string for create.
        title: Human-readable title for the event (e.g. "Small Claims Hearing").
            For update operations this MUST equal match_title so the calendar
            event stays mapped to the same Google Calendar entry.
        description: One-line description that appears in the event body.
        date_iso: Absolute ISO-8601 datetime with no timezone suffix
            (e.g. "2026-04-13T09:00:00"). The frontend appends the user's local
            timezone. Pass empty string for delete.
        duration_minutes: 60 for hearings, 30 for filings, 0 for delete.
        type: One of "hearing", "filing", "deadline", or "other".
        urgency: One of "low", "medium", or "high".

    Returns:
        Short confirmation string. The actual Google Calendar mutation runs on
        the frontend when it receives this tool call over SSE.
    """
    return f"calendar op queued: {op} {title or match_title}"


def propose_new_document(title: str, description: str, why: str) -> str:
    """Add a new document to the case's documents.needed list.

    Use this when the user needs a letter, motion, memo, or other document
    that isn't already tracked. Pair with propose_draft_now if the user wants
    it drafted immediately.

    Args:
        title: Short human-readable title (e.g. "Motion for Continuance",
            "Hearing Preparation Memo", "Settlement Demand Letter").
        description: One-line description of what the document does.
        why: One-line explanation of why the case needs this document — fed
            to the orchestrator on the next regenerate so the strategy
            reflects the new artifact.

    Returns:
        Short confirmation string.
    """
    return f"document queued: {title}"


def propose_draft_now(title: str) -> str:
    """Immediately draft a document that exists in the case's documents.needed.

    Use this AFTER propose_new_document when the user asked you to draft
    something, OR on its own when the user wants an existing card drafted now.
    The frontend will run the drafting agent and sync the result to Google Docs.

    Args:
        title: Exact title of the document to draft. Must match a card in
            documents.needed (either a pre-existing one or one you just added
            via propose_new_document earlier in this same turn).

    Returns:
        Short confirmation string.
    """
    return f"drafting started: {title}"


def propose_fact(kind: str, summary: str, criticality: str) -> str:
    """Record a structured fact extracted from the user's message.

    The fact is written to the case's additionalInfo map and surfaces in the
    next orchestrator regenerate so overview/analysis/strategy can incorporate
    it.

    Args:
        kind: One of "date", "evidence", "party", "amount", or "other".
        summary: One-line plain English summary of the fact.
        criticality: One of "low", "medium", or "high". High = changes a
            hearing date, adds new admissible evidence, changes a party, or
            otherwise materially shifts the legal posture of the case.

    Returns:
        Short confirmation string.
    """
    return f"fact recorded: {summary}"


def propose_critical_regenerate(affected_sections: list[str]) -> str:
    """Signal that the case needs an orchestrator regenerate after this turn.

    Call this whenever you take an action that materially shifts the case
    (date moved, new evidence, new party, etc.). The frontend buffers the
    signal and runs handleRegenerate({criticalMode}) once at the end of the
    conversation when you call mark_done.

    Args:
        affected_sections: Subset of ["overview", "analysis", "strategy",
            "documents", "deadlines"] listing the sections that need to be
            re-derived from scratch using the new facts. When in doubt,
            include all five.

    Returns:
        Short confirmation string.
    """
    return f"regenerate queued: {','.join(affected_sections)}"


def mark_done() -> str:
    """Signal that the conversation is complete.

    Call this LAST, after you've taken every action and have nothing more to
    ask. The frontend will close the Add Context panel and (if a critical
    regenerate was queued) kick off the orchestrator regenerate.

    Do NOT call this while still waiting on a user answer.

    Returns:
        Short confirmation string.
    """
    return "done"


# ─── Agent ────────────────────────────────────────────────────────────────

context_planner_agent = LlmAgent(
    model=MODEL,
    name="context_planner_agent",
    description=(
        "Multi-turn conversational planner agent that behaves like a real "
        "attorney inside the Add Context chat panel. Asks ONE clarifying "
        "question at a time when needed, and takes action by calling "
        "command tools that emit signals to the frontend (calendar ops, "
        "new documents, immediate drafting, structured facts, critical "
        "regenerates). The frontend executes the actual mutations against "
        "Google Calendar, Google Docs, Firestore, and the orchestrator."
    ),
    instruction=CONTEXT_PLANNER_INSTRUCTION,
    tools=[
        FunctionTool(func=propose_calendar_op),
        FunctionTool(func=propose_new_document),
        FunctionTool(func=propose_draft_now),
        FunctionTool(func=propose_fact),
        FunctionTool(func=propose_critical_regenerate),
        FunctionTool(func=mark_done),
    ],
)
