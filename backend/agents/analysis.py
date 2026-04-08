"""AnalysisAgent — pure reasoning sub-agent. No tools.

Reads the research findings already in conversation history and produces
strengths, weaknesses, win probability, strategy options, and any deadlines
that surfaced. Transfers back to the orchestrator with a markdown summary.
"""

from google.adk.agents import LlmAgent

from prompts import ANALYSIS_INSTRUCTION

analysis_agent = LlmAgent(
    model="gemini-2.5-flash",
    name="analysis_agent",
    description="Reasons over the research findings and produces strengths, weaknesses, win probability, and strategy options. Has no tools. Transfers control back to the orchestrator with a markdown analysis.",
    instruction=ANALYSIS_INSTRUCTION,
)
