"""Elasticsearch client — single source of truth for direct ES calls.

Mirrors the role of courtlistener_client.py: a thin, defensive wrapper that
every Elastic feature in Lawyered goes through. Used by:
- mcp_servers/elastic_mcp.py        (local stdio MCP fallback)
- mcp_servers/courtlistener_mcp.py  (index-on-read caching of opinions)
- scripts/create_elastic_indices.py (index bootstrap)
- scripts/seed_elastic.py           (one-shot corpus seed)
- server.py                         (/api/case-memory, /api/user-docs, /api/health)

Design rules (same as courtlistener_client.py):
- Reads ELASTICSEARCH_URL + ELASTIC_API_KEY from the environment at import.
- NEVER raises at import. If the `elasticsearch` package is missing or the env
  vars are unset, the module still imports and every call returns a
  `{"error": ...}` dict (or False), so the backend degrades gracefully to
  CourtListener-only instead of crashing.
- All network calls are wrapped in try/except returning {"error": ...}.

Hybrid retrieval uses ELSER via `semantic_text` fields (sparse vectors,
auto-embedded on ingest and query — no separate embedding pipeline).
"""

import os

from dotenv import load_dotenv

# Same load order as courtlistener_client.py / agent.py.
load_dotenv("../.env", override=False)
load_dotenv(".env", override=False)

ELASTICSEARCH_URL = os.getenv("ELASTICSEARCH_URL", "")
ELASTIC_API_KEY = os.getenv("ELASTIC_API_KEY", "")

# Index names — referenced by scripts, the MCP server, and /api/health.
CASELAW_INDEX = "lawyered-caselaw"
MEMORY_INDEX = "lawyered-case-memory"
USERDOCS_INDEX = "lawyered-user-docs"

# ELSER inference endpoint. On Elastic Cloud / Serverless this default is
# auto-managed by the Elastic Inference Service (no ML node setup required).
ELSER_INFERENCE_ID = os.getenv("ELASTIC_INFERENCE_ID", ".elser-2-elasticsearch")

# CourtListener opinions are already truncated to 5000 chars upstream; cap our
# own ingest text well under the ~1MB semantic_text limit just in case.
_MAX_TEXT_CHARS = 60_000

# Import the elasticsearch package lazily/defensively so a missing dependency
# never breaks `import elastic_client` (and therefore the whole backend).
try:
    from elasticsearch import Elasticsearch, helpers  # type: ignore

    _ES_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only when dep is absent
    Elasticsearch = None  # type: ignore
    helpers = None  # type: ignore
    _ES_AVAILABLE = False

_client = None  # cached singleton


def is_configured() -> bool:
    """True when we have both the package and the connection env vars."""
    return bool(_ES_AVAILABLE and ELASTICSEARCH_URL and ELASTIC_API_KEY)


def get_client():
    """Return a cached Elasticsearch client, or None if not configured.

    Never raises — callers treat None as "Elastic disabled".
    """
    global _client
    if not is_configured():
        return None
    if _client is None:
        try:
            _client = Elasticsearch(
                ELASTICSEARCH_URL,
                api_key=ELASTIC_API_KEY,
                request_timeout=30,
            )
        except Exception:
            _client = None
    return _client


# ---------------------------------------------------------------------------
# Index bootstrap
# ---------------------------------------------------------------------------

def _semantic_text_field():
    return {"type": "semantic_text", "inference_id": ELSER_INFERENCE_ID}


_INDEX_MAPPINGS = {
    CASELAW_INDEX: {
        "properties": {
            "case_name": {"type": "text"},
            "court": {"type": "keyword"},
            "jurisdiction": {"type": "keyword"},
            "date_filed": {"type": "date", "ignore_malformed": True},
            "cluster_id": {"type": "keyword"},
            "opinion_id": {"type": "keyword"},
            "absolute_url": {"type": "keyword"},
            "text": {"type": "text", "copy_to": "text_semantic"},
            "text_semantic": None,  # filled in below with semantic_text
        }
    },
    MEMORY_INDEX: {
        "properties": {
            "case_id": {"type": "keyword"},
            "user_id": {"type": "keyword"},
            "status": {"type": "keyword"},
            "created_at": {"type": "date", "ignore_malformed": True},
            "issue": {"type": "text"},
            "win_probability": {"type": "integer"},
            "summary": {"type": "text", "copy_to": "summary_semantic"},
            "summary_semantic": None,
        }
    },
    USERDOCS_INDEX: {
        "properties": {
            "doc_id": {"type": "keyword"},
            "user_id": {"type": "keyword"},
            "case_id": {"type": "keyword"},
            "title": {"type": "text"},
            "uploaded_at": {"type": "date", "ignore_malformed": True},
            "text": {"type": "text", "copy_to": "text_semantic"},
            "text_semantic": None,
        }
    },
}


def create_indices() -> dict:
    """Create the three Lawyered indices with ELSER semantic_text mappings.

    Idempotent: indices that already exist are skipped. Returns a per-index
    status dict.
    """
    client = get_client()
    if client is None:
        return {"error": "Elasticsearch not configured (set ELASTICSEARCH_URL + ELASTIC_API_KEY)."}

    semantic_field_by_index = {
        CASELAW_INDEX: "text_semantic",
        MEMORY_INDEX: "summary_semantic",
        USERDOCS_INDEX: "text_semantic",
    }

    out = {}
    for index, mapping in _INDEX_MAPPINGS.items():
        props = {k: v for k, v in mapping["properties"].items()}
        props[semantic_field_by_index[index]] = _semantic_text_field()
        try:
            if client.indices.exists(index=index):
                out[index] = "exists"
                continue
            client.indices.create(index=index, mappings={"properties": props})
            out[index] = "created"
        except Exception as e:
            out[index] = f"error: {e}"
    return out


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

def _hybrid_search(index: str, semantic_field: str, query: str, k: int, filters: list):
    """Run a hybrid (BM25 + ELSER semantic) search.

    Tries an RRF retriever first (best ranking, available on Cloud/Serverless),
    and falls back to a pure semantic query if retrievers aren't supported on
    the target deployment/license. Returns the raw hits list or raises.
    """
    client = get_client()
    if client is None:
        raise RuntimeError("Elasticsearch not configured")

    semantic_clause = {"semantic": {"field": semantic_field, "query": query}}
    lexical_clause = {
        "multi_match": {"query": query, "fields": ["case_name^2", "title^2", "issue^2", "text"]}
    }

    def _wrap(inner):
        if filters:
            return {"bool": {"must": [inner], "filter": filters}}
        return inner

    try:
        resp = client.search(
            index=index,
            retriever={
                "rrf": {
                    "retrievers": [
                        {"standard": {"query": _wrap(semantic_clause)}},
                        {"standard": {"query": _wrap(lexical_clause)}},
                    ],
                    "rank_window_size": max(k * 5, 50),
                }
            },
            size=k,
        )
    except Exception:
        # Fallback: pure semantic query with optional filter.
        resp = client.search(index=index, query=_wrap(semantic_clause), size=k)
    return resp.get("hits", {}).get("hits", [])


def hybrid_search_caselaw(query: str, jurisdiction: str = "", k: int = 8) -> dict:
    """Hybrid semantic+keyword search of the curated Lawyered case-law index."""
    if not is_configured():
        return {"error": "Elastic disabled", "count": 0, "results": []}
    filters = [{"term": {"jurisdiction": jurisdiction}}] if jurisdiction else []
    try:
        hits = _hybrid_search(CASELAW_INDEX, "text_semantic", query, k, filters)
        results = []
        for h in hits:
            src = h.get("_source", {})
            text = src.get("text", "") or ""
            results.append(
                {
                    "case_name": src.get("case_name", ""),
                    "court": src.get("court", ""),
                    "jurisdiction": src.get("jurisdiction", ""),
                    "date_filed": src.get("date_filed", ""),
                    "cluster_id": src.get("cluster_id", ""),
                    "opinion_id": src.get("opinion_id", ""),
                    "absolute_url": src.get("absolute_url", ""),
                    "snippet": text[:600],
                    "score": h.get("_score"),
                }
            )
        return {"count": len(results), "results": results}
    except Exception as e:
        return {"error": f"Case-law search failed: {e}", "count": 0, "results": []}


def find_similar_cases(user_id: str, situation: str, k: int = 5) -> dict:
    """Retrieve THIS user's past cases semantically similar to `situation`.

    user_id is enforced as a hard filter, so one user's memory can never be
    returned to another (server-side data isolation).
    """
    if not is_configured():
        return {"error": "Elastic disabled", "count": 0, "results": []}
    if not user_id:
        return {"error": "user_id required", "count": 0, "results": []}
    filters = [{"term": {"user_id": user_id}}]
    try:
        hits = _hybrid_search(MEMORY_INDEX, "summary_semantic", situation, k, filters)
        results = []
        for h in hits:
            src = h.get("_source", {})
            results.append(
                {
                    "case_id": src.get("case_id", ""),
                    "issue": src.get("issue", ""),
                    "status": src.get("status", ""),
                    "win_probability": src.get("win_probability"),
                    "summary": (src.get("summary", "") or "")[:1200],
                    "created_at": src.get("created_at", ""),
                    "score": h.get("_score"),
                }
            )
        return {"count": len(results), "results": results}
    except Exception as e:
        return {"error": f"Similar-case search failed: {e}", "count": 0, "results": []}


def search_user_docs(user_id: str, query: str, k: int = 5) -> dict:
    """Hybrid search over a user's uploaded documents, scoped to user_id."""
    if not is_configured():
        return {"error": "Elastic disabled", "count": 0, "results": []}
    if not user_id:
        return {"error": "user_id required", "count": 0, "results": []}
    filters = [{"term": {"user_id": user_id}}]
    try:
        hits = _hybrid_search(USERDOCS_INDEX, "text_semantic", query, k, filters)
        results = []
        for h in hits:
            src = h.get("_source", {})
            text = src.get("text", "") or ""
            results.append(
                {
                    "doc_id": src.get("doc_id", ""),
                    "title": src.get("title", ""),
                    "case_id": src.get("case_id", ""),
                    "snippet": text[:800],
                    "score": h.get("_score"),
                }
            )
        return {"count": len(results), "results": results}
    except Exception as e:
        return {"error": f"User-doc search failed: {e}", "count": 0, "results": []}


# ---------------------------------------------------------------------------
# Ingest / upsert
# ---------------------------------------------------------------------------

def _clip(text: str) -> str:
    text = text or ""
    return text[:_MAX_TEXT_CHARS]


def upsert_opinion(doc: dict) -> bool:
    """Upsert one opinion into the case-law index (index-on-read cache).

    Fire-and-forget: returns True/False and never raises, so it can be called
    from the CourtListener tool path without risking the user-facing request.
    `doc` must include opinion_id (used as _id) and text.
    """
    client = get_client()
    if client is None:
        return False
    opinion_id = str(doc.get("opinion_id") or doc.get("id") or "").strip()
    if not opinion_id or not (doc.get("text") or "").strip():
        return False
    body = {
        "case_name": doc.get("case_name", ""),
        "court": doc.get("court", ""),
        "jurisdiction": doc.get("jurisdiction", "") or doc.get("court", ""),
        "date_filed": doc.get("date_filed", "") or None,
        "cluster_id": str(doc.get("cluster_id", "") or ""),
        "opinion_id": opinion_id,
        "absolute_url": doc.get("absolute_url", ""),
        "text": _clip(doc.get("text", "")),
    }
    body = {k: v for k, v in body.items() if v is not None}
    try:
        client.index(index=CASELAW_INDEX, id=opinion_id, document=body)
        return True
    except Exception:
        return False


def upsert_case_memory(doc: dict) -> dict:
    """Write a finished-case summary into the memory index (keyed by case_id)."""
    client = get_client()
    if client is None:
        return {"error": "Elastic disabled"}
    case_id = str(doc.get("case_id", "") or "").strip()
    user_id = str(doc.get("user_id", "") or "").strip()
    if not case_id or not user_id:
        return {"error": "case_id and user_id required"}
    body = {
        "case_id": case_id,
        "user_id": user_id,
        "status": doc.get("status", ""),
        "created_at": doc.get("created_at", "") or None,
        "issue": doc.get("issue", ""),
        "win_probability": doc.get("win_probability"),
        "summary": _clip(doc.get("summary", "")),
    }
    body = {k: v for k, v in body.items() if v is not None}
    try:
        client.index(index=MEMORY_INDEX, id=case_id, document=body)
        return {"ok": True, "case_id": case_id}
    except Exception as e:
        return {"error": f"Memory upsert failed: {e}"}


def upsert_user_doc(doc: dict) -> dict:
    """Index one user-uploaded document (keyed by doc_id, scoped by user_id)."""
    client = get_client()
    if client is None:
        return {"error": "Elastic disabled"}
    doc_id = str(doc.get("doc_id", "") or "").strip()
    user_id = str(doc.get("user_id", "") or "").strip()
    if not doc_id or not user_id or not (doc.get("text") or "").strip():
        return {"error": "doc_id, user_id and text required"}
    body = {
        "doc_id": doc_id,
        "user_id": user_id,
        "case_id": doc.get("case_id", ""),
        "title": doc.get("title", ""),
        "uploaded_at": doc.get("uploaded_at", "") or None,
        "text": _clip(doc.get("text", "")),
    }
    body = {k: v for k, v in body.items() if v is not None}
    try:
        client.index(index=USERDOCS_INDEX, id=doc_id, document=body)
        return {"ok": True, "doc_id": doc_id}
    except Exception as e:
        return {"error": f"User-doc upsert failed: {e}"}


def bulk_index_opinions(docs: list) -> dict:
    """Bulk-ingest opinions for the seed script. Idempotent on opinion_id."""
    client = get_client()
    if client is None:
        return {"error": "Elastic disabled", "indexed": 0}
    actions = []
    for d in docs:
        opinion_id = str(d.get("opinion_id") or d.get("id") or "").strip()
        if not opinion_id or not (d.get("text") or "").strip():
            continue
        actions.append(
            {
                "_index": CASELAW_INDEX,
                "_id": opinion_id,
                "_op_type": "index",
                "_source": {
                    "case_name": d.get("case_name", ""),
                    "court": d.get("court", ""),
                    "jurisdiction": d.get("jurisdiction", "") or d.get("court", ""),
                    "date_filed": d.get("date_filed", "") or None,
                    "cluster_id": str(d.get("cluster_id", "") or ""),
                    "opinion_id": opinion_id,
                    "absolute_url": d.get("absolute_url", ""),
                    "text": _clip(d.get("text", "")),
                },
            }
        )
    if not actions:
        return {"indexed": 0, "note": "no valid docs"}
    try:
        success, errors = helpers.bulk(client, actions, raise_on_error=False)
        return {"indexed": success, "errors": errors}
    except Exception as e:
        return {"error": f"Bulk index failed: {e}", "indexed": 0}


# ---------------------------------------------------------------------------
# Ops helpers
# ---------------------------------------------------------------------------

def warm_elser() -> dict:
    """Trivial semantic query to wake the EIS inference endpoint (cold start).

    Run this just before a demo so the first real query isn't slow.
    """
    if not is_configured():
        return {"error": "Elastic disabled"}
    try:
        hybrid_search_caselaw("warm up the inference endpoint", k=1)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


def health_snapshot() -> dict:
    """Compact status for /api/health (never leaks credentials)."""
    if not _ES_AVAILABLE:
        return {"configured": False, "reason": "elasticsearch package not installed"}
    if not (ELASTICSEARCH_URL and ELASTIC_API_KEY):
        return {"configured": False, "reason": "ELASTICSEARCH_URL / ELASTIC_API_KEY not set"}
    snapshot = {
        "configured": True,
        "indices": [CASELAW_INDEX, MEMORY_INDEX, USERDOCS_INDEX],
        "inference_id": ELSER_INFERENCE_ID,
    }
    client = get_client()
    if client is not None:
        try:
            snapshot["reachable"] = bool(client.ping())
        except Exception:
            snapshot["reachable"] = False
    return snapshot
