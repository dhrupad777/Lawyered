"""CourtListener MCP server (stdio transport).

Wraps the 5 CourtListener REST tools as MCP tools so they can be consumed
through ADK's McpToolset. The tool names are kept verbatim
(search_cases, get_opinion, get_case_details, get_docket, search_related_statutes)
because the frontend has a hardcoded label map keyed on these names.

Run standalone:
    python -m mcp_servers.courtlistener_mcp

Inspect with:
    npx @modelcontextprotocol/inspector python -m mcp_servers.courtlistener_mcp
"""

from mcp.server.fastmcp import FastMCP

from courtlistener_client import (
    search_cases as _search_cases,
    get_opinion as _get_opinion,
    get_case_details as _get_case_details,
    get_docket as _get_docket,
    search_related_statutes as _search_related_statutes,
)

mcp = FastMCP("courtlistener")


@mcp.tool()
def search_cases(query: str, court: str = "", page: int = 1) -> dict:
    """Search for US case law on CourtListener.

    Args:
        query: The search query (e.g. 'first amendment free speech').
        court: Optional court filter (e.g. 'scotus' for Supreme Court, 'ca9' for 9th Circuit).
        page: Page number for pagination (default 1).

    Returns:
        A dict with 'count' and 'results' containing matching cases.
    """
    return _search_cases(query=query, court=court, page=page)


@mcp.tool()
def get_opinion(opinion_id: int) -> dict:
    """Retrieve a specific court opinion by its ID.

    Args:
        opinion_id: The CourtListener opinion ID.

    Returns:
        A dict with the opinion's details including text content.
    """
    return _get_opinion(opinion_id=opinion_id)


@mcp.tool()
def get_case_details(cluster_id: int) -> dict:
    """Get detailed information about a case cluster.

    Args:
        cluster_id: The CourtListener cluster ID.

    Returns:
        A dict with case details including name, court, date, citations, and sub-opinions.
    """
    return _get_case_details(cluster_id=cluster_id)


@mcp.tool()
def get_docket(docket_id: int) -> dict:
    """Get docket information for a case.

    Args:
        docket_id: The CourtListener docket ID.

    Returns:
        A dict with docket details including case name, court, and parties.
    """
    return _get_docket(docket_id=docket_id)


@mcp.tool()
def search_related_statutes(legal_topic: str, jurisdiction: str = "") -> dict:
    """Search for cases that interpret statutes related to a legal topic.

    Useful for finding what the law actually says about a situation.

    Args:
        legal_topic: The legal topic (e.g. 'security deposit return timeline').
        jurisdiction: Optional jurisdiction filter (e.g. 'scotus', 'ca9').

    Returns:
        Cases that reference relevant statutes, sorted by statutory relevance.
    """
    return _search_related_statutes(legal_topic=legal_topic, jurisdiction=jurisdiction)


if __name__ == "__main__":
    mcp.run()
