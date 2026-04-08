"""CourtListener REST API client.

Single source of truth for HTTP calls to CourtListener. Used by:
- mcp_servers/courtlistener_mcp.py (the MCP server exposed via stdio)
- agents/legacy_single.py (the kill-switch fallback agent)

Loads COURTLISTENER_API_TOKEN from the environment at import time.
"""

import os
import re
import requests
from dotenv import load_dotenv

# Same load order as the original agent.py
load_dotenv("../.env", override=False)
load_dotenv(".env", override=False)

COURTLISTENER_TOKEN = os.getenv("COURTLISTENER_API_TOKEN", "")
BASE_URL = "https://www.courtlistener.com/api/rest/v4"
HEADERS = {"Authorization": f"Token {COURTLISTENER_TOKEN}"}


def search_cases(query: str, court: str = "", page: int = 1) -> dict:
    """Search for US case law on CourtListener.

    Args:
        query: The search query (e.g. 'first amendment free speech').
        court: Optional court filter (e.g. 'scotus' for Supreme Court, 'ca9' for 9th Circuit).
        page: Page number for pagination (default 1).

    Returns:
        A dict with 'count' and 'results' containing matching cases.
    """
    try:
        params = {"q": query, "type": "o", "page": page}
        if court:
            params["court"] = court
        resp = requests.get(
            f"{BASE_URL}/search/", headers=HEADERS, params=params, timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        results = []
        for r in data.get("results", [])[:10]:
            results.append(
                {
                    "case_name": r.get("caseName", ""),
                    "court": r.get("court", ""),
                    "date_filed": r.get("dateFiled", ""),
                    "docket_number": r.get("docketNumber", ""),
                    "citation": r.get("citation", []),
                    "snippet": r.get("snippet", ""),
                    "absolute_url": r.get("absolute_url", ""),
                    "cluster_id": r.get("cluster_id", ""),
                }
            )
        return {"count": data.get("count", 0), "results": results}
    except requests.exceptions.Timeout:
        return {"error": "CourtListener search timed out. Try a simpler query.", "count": 0, "results": []}
    except requests.exceptions.ConnectionError:
        return {"error": "Could not connect to CourtListener. The service may be temporarily unavailable.", "count": 0, "results": []}
    except Exception as e:
        return {"error": f"Search failed: {str(e)}", "count": 0, "results": []}


def get_opinion(opinion_id: int) -> dict:
    """Retrieve a specific court opinion by its ID.

    Args:
        opinion_id: The CourtListener opinion ID.

    Returns:
        A dict with the opinion's details including text content.
    """
    try:
        resp = requests.get(
            f"{BASE_URL}/opinions/{opinion_id}/", headers=HEADERS, timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        text = (
            data.get("plain_text")
            or data.get("html_with_citations")
            or data.get("html")
            or ""
        )
        if len(text) > 5000:
            text = text[:5000] + "\n... [truncated]"
        return {
            "id": data.get("id"),
            "type": data.get("type"),
            "author_str": data.get("author_str", ""),
            "text": text,
            "download_url": data.get("download_url", ""),
        }
    except Exception as e:
        return {"error": f"Could not retrieve opinion: {str(e)}"}


def get_case_details(cluster_id: int) -> dict:
    """Get detailed information about a case cluster.

    Args:
        cluster_id: The CourtListener cluster ID.

    Returns:
        A dict with case details including name, court, date, citations, and sub-opinions.
    """
    try:
        resp = requests.get(
            f"{BASE_URL}/clusters/{cluster_id}/", headers=HEADERS, timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "id": data.get("id"),
            "case_name": data.get("case_name", ""),
            "date_filed": data.get("date_filed", ""),
            "court": data.get("court", ""),
            "judges": data.get("judges", ""),
            "citations": data.get("citations", []),
            "syllabus": data.get("syllabus", ""),
            "sub_opinions": data.get("sub_opinions", []),
            "absolute_url": data.get("absolute_url", ""),
        }
    except Exception as e:
        return {"error": f"Could not retrieve case details: {str(e)}"}


def get_docket(docket_id: int) -> dict:
    """Get docket information for a case.

    Args:
        docket_id: The CourtListener docket ID.

    Returns:
        A dict with docket details including case name, court, and parties.
    """
    try:
        resp = requests.get(
            f"{BASE_URL}/dockets/{docket_id}/", headers=HEADERS, timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "id": data.get("id"),
            "case_name": data.get("case_name", ""),
            "court": data.get("court", ""),
            "docket_number": data.get("docket_number", ""),
            "date_filed": data.get("date_filed", ""),
            "date_terminated": data.get("date_terminated", ""),
            "assigned_to_str": data.get("assigned_to_str", ""),
            "referred_to_str": data.get("referred_to_str", ""),
            "absolute_url": data.get("absolute_url", ""),
        }
    except Exception as e:
        return {"error": f"Could not retrieve docket: {str(e)}"}


def search_related_statutes(legal_topic: str, jurisdiction: str = "") -> dict:
    """Search for cases that interpret statutes related to a legal topic.

    Useful for finding what the law actually says about a situation.

    Args:
        legal_topic: The legal topic (e.g. 'security deposit return timeline').
        jurisdiction: Optional jurisdiction filter (e.g. 'scotus', 'ca9').

    Returns:
        Cases that reference relevant statutes, sorted by statutory relevance.
    """
    try:
        statute_query = f"{legal_topic} statute code section pursuant"
        params = {"q": statute_query, "type": "o", "page": 1}
        if jurisdiction:
            params["court"] = jurisdiction
        resp = requests.get(
            f"{BASE_URL}/search/", headers=HEADERS, params=params, timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return {"error": f"Statute search failed: {str(e)}", "count": 0, "results": []}

    statute_pattern = re.compile(
        r"(Section\s+\d+|§\s*\d+|\d+\s+U\.S\.C\.|Civ\.\s*Code|Rev\.\s*Stat|"
        r"Penal\s+Code|Labor\s+Code|Bus\.\s*&\s*Prof\.\s*Code)",
        re.IGNORECASE,
    )

    results = []
    for r in data.get("results", [])[:15]:
        snippet = r.get("snippet", "")
        has_statute = bool(statute_pattern.search(snippet))
        results.append(
            {
                "case_name": r.get("caseName", ""),
                "court": r.get("court", ""),
                "date_filed": r.get("dateFiled", ""),
                "snippet": snippet,
                "absolute_url": r.get("absolute_url", ""),
                "cluster_id": r.get("cluster_id", ""),
                "has_statute_reference": has_statute,
            }
        )

    results.sort(key=lambda x: (not x["has_statute_reference"],))
    return {"count": data.get("count", 0), "results": results[:10]}
