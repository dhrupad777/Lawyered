"""ContextHelperAgent — root agent for the /api/context-helper endpoint.

When the user tries to do an action that needs information not yet in case.md
(e.g., clicks "Update Calendar" with no deadlines tracked, or asks to draft a
letter when the recipient is unknown), the frontend calls this agent with:

  ACTION: calendar_sync
  USER_NAME: Dhrupad
  CASE CONTEXT: <full case.md>

The agent reads the case context, sees what's missing for the requested action,
and returns ONE focused question pre-filled into the Add Context panel. The user
answers the question, the answer is saved to additionalInfo, the case is
regenerated, and the original action auto-fires.

Same architectural pattern as drafting_root_agent: a small LlmAgent with no
tools, exposed via its own /api/context-helper endpoint, called directly by
the frontend through the AG-UI streaming protocol.
"""

from google.adk.agents import LlmAgent

from prompts import CONTEXT_HELPER_INSTRUCTION


context_helper_agent = LlmAgent(
    model="gemini-2.5-flash",
    name="context_helper_agent",
    description="Reads the existing case context plus a requested action identifier, and returns ONE focused question asking the user for the specific information that's missing to complete that action. Outputs plain text only — no JSON, no code fences.",
    instruction=CONTEXT_HELPER_INSTRUCTION,
)
