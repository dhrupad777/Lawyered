"""Elastic MCP server (stdio transport) — local fallback / inspector demo.

Mirrors courtlistener_mcp.py. Exposes Lawyered's Elastic retrieval as MCP
tools backed by elastic_client.py (direct Elasticsearch access via the
elasticsearch Python client + ELSER semantic_text).

This is the OFFLINE / inspector path. In production the research agent prefers
Elastic Agent Builder's HOSTED MCP server (remote, streamable-HTTP) — see
agents/research.py. This local server is wired in when LAWYERED_ELASTIC_LOCAL=1
or when the remote endpoint env vars are unset, exactly like google_docs_mcp.py
exists alongside the browser-side Google Docs path.

Tool names (search_caselaw, find_similar_past_cases, search_user_documents)
match the custom tool IDs created in Elastic Agent Builder, so the research
agent's prompt and tool_filter work identically against either path.

Run standalone:
    python -m mcp_servers.elastic_mcp

Inspect with:
    npx @modelcontextprotocol/inspector python -m mcp_servers.elastic_mcp
"""

from mcp.server.fastmcp import FastMCP

from elastic_client import (
    hybrid_search_caselaw as _hybrid_search_caselaw,
    find_similar_cases as _find_similar_cases,
    search_user_docs as _search_user_docs,
)

mcp = FastMCP("elastic")


@mcp.tool()
def search_caselaw(query: str, jurisdiction: str = "", k: int = 8) -> dict:
    """Hybrid semantic + keyword search over Lawyered's curated case-law index.

    Uses ELSER sparse-vector embeddings, so it matches cases by legal MEANING,
    not just keywords (e.g. "my landlord kept my deposit" finds security-deposit
    precedents that share no exact terms). Prefer this for conceptual/"situation
    like mine" queries; CourtListener's search_cases is still better for breadth
    and the very latest filings.

    Args:
        query: Natural-language description of the legal situation or issue.
        jurisdiction: Optional court/jurisdiction keyword filter (e.g. 'cal', 'ca9').
        k: Number of results to return (default 8).

    Returns:
        {'count', 'results': [{case_name, court, jurisdiction, date_filed,
        cluster_id, opinion_id, absolute_url, snippet, score}]}.
    """
    return _hybrid_search_caselaw(query=query, jurisdiction=jurisdiction, k=k)


@mcp.tool()
def find_similar_past_cases(user_id: str, situation: str, k: int = 5) -> dict:
    """Retrieve THIS user's prior cases semantically similar to the situation.

    The Lawyered memory/context layer: past case summaries the user has worked
    on. Results are hard-filtered by user_id, so one user's matters are never
    returned to another.

    Args:
        user_id: The current user's id (scopes the search — required).
        situation: Description of the current legal situation.
        k: Number of past cases to return (default 5).

    Returns:
        {'count', 'results': [{case_id, issue, status, win_probability,
        summary, created_at, score}]}.
    """
    return _find_similar_cases(user_id=user_id, situation=situation, k=k)


@mcp.tool()
def search_user_documents(user_id: str, query: str, k: int = 5) -> dict:
    """Hybrid search over documents this user uploaded (leases, contracts, evidence).

    Lets the agent ground answers in the user's own files. Hard-filtered by
    user_id for data isolation.

    Args:
        user_id: The current user's id (scopes the search — required).
        query: Natural-language question or topic to find in the user's docs.
        k: Number of passages to return (default 5).

    Returns:
        {'count', 'results': [{doc_id, title, case_id, snippet, score}]}.
    """
    return _search_user_docs(user_id=user_id, query=query, k=k)


if __name__ == "__main__":
    mcp.run()
