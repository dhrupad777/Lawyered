"""Lawyered agent entrypoint — kill-switch shim.

`server.py` does `from agent import lawyered_agent`. This module re-exports
either the new multi-agent root_agent (default) or the legacy single-agent
build (when LAWYERED_SINGLE_AGENT=1). The kill-switch lets us roll back to
the pre-refactor behavior in seconds without touching code:

    gcloud run services update lawyered-backend \\
        --update-env-vars LAWYERED_SINGLE_AGENT=1
"""

import os
from dotenv import load_dotenv

# Load .env BEFORE any agent module imports — ADK reads GOOGLE_API_KEY from
# os.environ at execution time, and the multi-agent path doesn't otherwise
# import courtlistener_client (which is the only other module that calls
# load_dotenv). On Cloud Run these env vars come from --set-env-vars instead;
# load_dotenv with a missing file is a silent no-op so this is safe.
load_dotenv("../.env", override=False)
load_dotenv(".env", override=False)

if os.getenv("LAWYERED_SINGLE_AGENT") == "1":
    # Bypass the multi-agent + MCP path entirely. Same code as before refactor.
    from agents.legacy_single import lawyered_agent
else:
    # Multi-agent: Orchestrator with research/analysis/drafting sub-agents
    # and CourtListener tools wrapped as an MCP server.
    from agents import root_agent as lawyered_agent

__all__ = ["lawyered_agent"]
