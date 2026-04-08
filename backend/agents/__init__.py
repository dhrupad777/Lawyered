"""Lawyered multi-agent package.

Exports `root_agent`, the primary Orchestrator with three sub-agents wired in.
This is what `agent.py` re-exports as `lawyered_agent` for the ag-ui-adk wrapper.
"""

from agents.orchestrator import root_agent

__all__ = ["root_agent"]
