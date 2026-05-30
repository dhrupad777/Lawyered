"""ResearchAgent — owns case-law tool calls via MCP toolsets.

Tools, in priority order:
1. CourtListener (always on) — stdio MCP subprocess for live US-court search.
2. Elastic (optional) — hybrid semantic + keyword retrieval (ELSER) over
   Lawyered's curated case-law index, plus the per-user memory and uploaded-
   document indices. Reached via EITHER:
     • the hosted Elastic Agent Builder MCP server (remote, streamable-HTTP,
       ApiKey auth) when ELASTIC_MCP_URL + ELASTIC_API_KEY are set — the
       production / hackathon path; or
     • a local stdio MCP subprocess (mcp_servers.elastic_mcp) when
       LAWYERED_ELASTIC_LOCAL=1 — the offline / inspector fallback.
   If neither is configured the agent degrades gracefully to CourtListener-only.

Tool names are passed through verbatim (tool_name_prefix omitted) so the
frontend's label map keeps working without frontend changes. The Elastic tool
IDs (search_caselaw, find_similar_past_cases, search_user_documents) must match
the custom tool IDs created in Elastic Agent Builder.
"""

import os
import sys

from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from mcp import StdioServerParameters

from prompts import RESEARCH_INSTRUCTION
from model_config import MODEL as _MODEL

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Remote-MCP connection class. StreamableHTTPConnectionParams is the current
# (March-2025 spec) standard and what Elastic Agent Builder serves; fall back to
# the legacy SseConnectionParams if running on an older google-adk.
try:
    from google.adk.tools.mcp_tool.mcp_session_manager import (
        StreamableHTTPConnectionParams as _RemoteConnectionParams,
    )

    _REMOTE_PARAMS_KIND = "streamable_http"
except Exception:  # pragma: no cover
    try:
        from google.adk.tools.mcp_tool.mcp_session_manager import (
            SseConnectionParams as _RemoteConnectionParams,
        )

        _REMOTE_PARAMS_KIND = "sse"
    except Exception:
        _RemoteConnectionParams = None
        _REMOTE_PARAMS_KIND = None

_ELASTIC_MCP_URL = os.getenv("ELASTIC_MCP_URL", "")
_ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY", "")
_ELASTIC_TOOL_IDS = ["search_caselaw", "find_similar_past_cases", "search_user_documents"]

# --- 1. CourtListener (always on) -----------------------------------------
courtlistener_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=["-m", "mcp_servers.courtlistener_mcp"],
            env={
                "COURTLISTENER_API_TOKEN": os.getenv("COURTLISTENER_API_TOKEN", ""),
                # The cache hook in courtlistener_mcp needs ES creds too.
                "ELASTICSEARCH_URL": os.getenv("ELASTICSEARCH_URL", ""),
                "ELASTIC_API_KEY": _ELASTIC_API_KEY,
                "PYTHONPATH": _BACKEND_DIR,
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


def _build_elastic_remote_toolset():
    """Hosted Elastic Agent Builder MCP (remote, streamable-HTTP, ApiKey auth)."""
    if not (_RemoteConnectionParams and _ELASTIC_MCP_URL and _ELASTIC_API_KEY):
        return None
    try:
        return McpToolset(
            connection_params=_RemoteConnectionParams(
                url=_ELASTIC_MCP_URL,
                headers={
                    "Authorization": f"ApiKey {_ELASTIC_API_KEY}",
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                timeout=15.0,
                sse_read_timeout=120.0,
            ),
            tool_filter=_ELASTIC_TOOL_IDS,
        )
    except Exception:
        # Bad URL/params at import time must not crash the backend.
        return None


def _build_elastic_local_toolset():
    """Local stdio Elastic MCP subprocess (offline / inspector fallback)."""
    return McpToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command=sys.executable,
                args=["-m", "mcp_servers.elastic_mcp"],
                env={
                    "ELASTICSEARCH_URL": os.getenv("ELASTICSEARCH_URL", ""),
                    "ELASTIC_API_KEY": _ELASTIC_API_KEY,
                    "ELASTIC_INFERENCE_ID": os.getenv("ELASTIC_INFERENCE_ID", ""),
                    "PYTHONPATH": _BACKEND_DIR,
                    "GOOGLE_API_KEY": os.getenv("GOOGLE_API_KEY", ""),
                    "PATH": os.getenv("PATH", ""),
                    "SYSTEMROOT": os.getenv("SYSTEMROOT", ""),
                },
            ),
            timeout=60.0,
        ),
        tool_filter=_ELASTIC_TOOL_IDS,
    )


# --- 2. Elastic (optional) — choose remote, else local, else off ----------
_tools = [courtlistener_toolset]
ELASTIC_MODE = "disabled"

_elastic_remote = _build_elastic_remote_toolset()
if _elastic_remote is not None and os.getenv("LAWYERED_ELASTIC_LOCAL") != "1":
    _tools.append(_elastic_remote)
    ELASTIC_MODE = "remote"
elif os.getenv("LAWYERED_ELASTIC_LOCAL") == "1":
    _tools.append(_build_elastic_local_toolset())
    ELASTIC_MODE = "local"
elif _elastic_remote is not None:
    _tools.append(_elastic_remote)
    ELASTIC_MODE = "remote"

research_agent = LlmAgent(
    model=_MODEL,
    name="research_agent",
    description="Gathers US case law and statutes from CourtListener (live keyword search) and Elastic (hybrid semantic retrieval over a curated index, the user's memory, and uploaded docs) via MCP. Returns a markdown summary of cases found, then transfers control back to the orchestrator.",
    instruction=RESEARCH_INSTRUCTION,
    tools=_tools,
)
