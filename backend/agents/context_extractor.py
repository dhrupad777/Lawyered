"""ContextExtractorAgent — root agent for /api/context-extract.

Runs BEFORE the orchestrator on every "Add Context" submission. Reads the
existing case.md plus the user's free-text update, and emits a structured JSON
block describing:

  1. Whether the context is complete or needs ONE clarifying question
  2. The structured facts extracted (with criticality flags)
  3. Deterministic Google Calendar operations (create/update/delete)
  4. Whether this is a "critical change" that requires the orchestrator to
     re-derive downstream sections (strategy/analysis/etc.)

The frontend then:
  - Shows the clarifying question if needed (two-way add-context loop)
  - Executes calendar ops directly via the Google Calendar API (no agent involved)
  - Calls the orchestrator only when criticalChange is true, with a scoped
    re-derivation prompt
"""

from google.adk.agents import LlmAgent

from prompts import CONTEXT_EXTRACTOR_INSTRUCTION


context_extractor_agent = LlmAgent(
    model="gemini-2.5-flash",
    name="context_extractor_agent",
    description=(
        "Parses a user's free-text case update against the existing case.md and "
        "emits a structured JSON block: status (complete|needs_clarification), "
        "extracted facts, deterministic Google Calendar create/update/delete "
        "operations with absolute ISO-8601 dates, and a criticalChange flag "
        "listing downstream sections that need re-derivation. The frontend "
        "executes calendar ops directly off this JSON instead of relying on "
        "the orchestrator's deadlines[] diff."
    ),
    instruction=CONTEXT_EXTRACTOR_INSTRUCTION,
)
