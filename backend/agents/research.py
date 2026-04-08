"""ResearchAgent — owns CourtListener tool calls via an MCP toolset.

Spawns the courtlistener MCP server as a stdio subprocess on first use.
Tool names are passed through verbatim (tool_name_prefix omitted) so the
frontend's hardcoded label map for `search_cases`, `get_opinion`, etc.
keeps working without any frontend changes.
"""

import os
import sys

from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from mcp import StdioServerParameters

from prompts import RESEARCH_INSTRUCTION

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

courtlistener_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=["-m", "mcp_servers.courtlistener_mcp"],
            env={
                "COURTLISTENER_API_TOKEN": os.getenv("COURTLISTENER_API_TOKEN", ""),
                "PYTHONPATH": _BACKEND_DIR,
                # Pass through anything Google libs may need at import time
                "GOOGLE_API_KEY": os.getenv("GOOGLE_API_KEY", ""),
                "PATH": os.getenv("PATH", ""),
                "SYSTEMROOT": os.getenv("SYSTEMROOT", ""),
            },
        ),
        timeout=60.0,
    ),
    tool_filter=[
        "search_cases",
        "get_opinion",
        "get_case_details",
        "get_docket",
        "search_related_statutes",
    ],
    # tool_name_prefix intentionally omitted — names pass through verbatim,
    # which is what the frontend label map at Chat.tsx:87-93 expects.
)

research_agent = LlmAgent(
    model="gemini-2.5-flash",
    name="research_agent",
    description="Gathers US case law and statutes from CourtListener via MCP. Returns a markdown summary of cases found, then transfers control back to the orchestrator.",
    instruction=RESEARCH_INSTRUCTION,
    tools=[courtlistener_toolset],
)
