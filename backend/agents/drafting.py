"""DraftingAgent — produces legal documents on demand. No tools.

Two instances of the same agent are exported:

  drafting_agent        — used as a sub-agent of the orchestrator in the
                           main /api/chat flow (for on-demand drafting during
                           a research conversation)

  drafting_root_agent   — used as a root agent for the dedicated
                           /api/chat-draft endpoint. The frontend sends a
                           self-contained CASE CONTEXT + TASK prompt and
                           expects a plain-text document back (no JSON).

Both instances share the same instruction. The split exists so ADK doesn't
get confused about parent_agent linkage when the same logical agent is used
in two different root contexts.
"""

from google.adk.agents import LlmAgent

from prompts import DRAFTING_INSTRUCTION
from model_config import MODEL


def _make_drafting_agent(name: str) -> LlmAgent:
    return LlmAgent(
        model=MODEL,
        name=name,
        description="Drafts complete legal documents (demand letters, complaint outlines, response letters) using the provided case context. Has no tools. Outputs plain text only, never JSON.",
        instruction=DRAFTING_INSTRUCTION,
    )


drafting_agent = _make_drafting_agent("drafting_agent")
drafting_root_agent = _make_drafting_agent("drafting_root")
