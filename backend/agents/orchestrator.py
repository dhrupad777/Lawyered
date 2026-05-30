"""Orchestrator — primary agent. Coordinates the three sub-agents.

This is the root agent passed to ag-ui-adk's ADKAgent wrapper in server.py.
The Orchestrator owns clarification (Phase 1), routing to sub-agents (Phase 2),
and the final user-facing message including the ```json fenced block (Phase 3).
"""

from google.adk.agents import LlmAgent

from prompts import ORCHESTRATOR_INSTRUCTION
from model_config import MODEL
from agents.research import research_agent
from agents.analysis import analysis_agent
from agents.drafting import drafting_agent

root_agent = LlmAgent(
    model=MODEL,
    name="orchestrator",
    description="Primary Lawyered agent. Coordinates research_agent, analysis_agent, and drafting_agent to produce a structured legal case report.",
    instruction=ORCHESTRATOR_INSTRUCTION,
    sub_agents=[research_agent, analysis_agent, drafting_agent],
)
