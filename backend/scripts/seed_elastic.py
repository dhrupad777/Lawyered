"""Seed the lawyered-caselaw index with a small, single-domain corpus.

Pulls real opinions from CourtListener (reusing courtlistener_client — the
same source the live research agent uses) and bulk-ingests them into
Elasticsearch, where ELSER auto-embeds the text via the semantic_text field.

Scope is intentionally tiny (default: landlord/tenant + security deposit, capped
at ~50 opinions) so a hackathon demo seeds in seconds and stays cheap on
inference. Idempotent: each doc is keyed by opinion_id (or cluster-<id>), so
re-running upserts rather than duplicating.

    cd backend
    python -m scripts.seed_elastic                 # default domain, cap 50
    python -m scripts.seed_elastic --max 30        # custom cap

Requires ELASTICSEARCH_URL + ELASTIC_API_KEY and COURTLISTENER_API_TOKEN.
"""

import argparse
import re
import sys

import elastic_client
import courtlistener_client as cl

# A scoped domain corpus. Edit these queries to seed a different practice area.
SEED_QUERIES = [
    "security deposit return tenant",
    "landlord wrongful eviction",
    "breach of residential lease",
    "warranty of habitability",
    "landlord failure to return deposit damages",
]


def _extract_opinion_id(sub_opinions) -> str:
    """Best-effort parse of an opinion id from a cluster's sub_opinions field.

    CourtListener returns sub_opinions as a list of API URLs (strings) or ids.
    """
    if not sub_opinions:
        return ""
    first = sub_opinions[0]
    if isinstance(first, int):
        return str(first)
    if isinstance(first, dict):
        first = first.get("id") or first.get("resource_uri") or ""
    if isinstance(first, str):
        m = re.search(r"/opinions/(\d+)/", first) or re.search(r"(\d+)/?$", first)
        if m:
            return m.group(1)
    return ""


def build_corpus(max_docs: int) -> list:
    seen_clusters = set()
    docs = []

    for query in SEED_QUERIES:
        if len(docs) >= max_docs:
            break
        print(f"  searching: {query!r}")
        res = cl.search_cases(query=query)
        if res.get("error"):
            print(f"    warning: {res['error']}")
            continue

        for hit in res.get("results", []):
            if len(docs) >= max_docs:
                break
            cluster_id = str(hit.get("cluster_id", "") or "")
            if not cluster_id or cluster_id in seen_clusters:
                continue
            seen_clusters.add(cluster_id)

            details = cl.get_case_details(int(cluster_id)) if cluster_id.isdigit() else {}
            syllabus = details.get("syllabus", "") if isinstance(details, dict) else ""
            opinion_id = _extract_opinion_id(details.get("sub_opinions")) if isinstance(details, dict) else ""

            opinion_text = ""
            if opinion_id.isdigit():
                op = cl.get_opinion(int(opinion_id))
                if isinstance(op, dict) and not op.get("error"):
                    opinion_text = op.get("text", "")

            text = "\n\n".join(
                p for p in [syllabus, opinion_text, hit.get("snippet", "")] if p
            ).strip()
            if not text:
                continue

            docs.append(
                {
                    "opinion_id": opinion_id or f"cluster-{cluster_id}",
                    "cluster_id": cluster_id,
                    "case_name": hit.get("case_name", ""),
                    "court": hit.get("court", ""),
                    "jurisdiction": hit.get("court", ""),
                    "date_filed": hit.get("date_filed", ""),
                    "absolute_url": hit.get("absolute_url", ""),
                    "text": text,
                }
            )
            print(f"    + {hit.get('case_name','(unnamed)')} ({len(text)} chars)")

    return docs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max", type=int, default=50, help="max opinions to ingest")
    args = parser.parse_args()

    if not elastic_client.is_configured():
        print("Elastic not configured (ELASTICSEARCH_URL + ELASTIC_API_KEY).")
        return 1
    if not cl.COURTLISTENER_TOKEN:
        print("COURTLISTENER_API_TOKEN not set — cannot fetch the corpus.")
        return 1

    print(f"Building corpus (cap {args.max}) ...")
    docs = build_corpus(args.max)
    print(f"Collected {len(docs)} documents. Bulk-ingesting (ELSER will embed) ...")

    result = elastic_client.bulk_index_opinions(docs)
    if result.get("error"):
        print(f"FAILED: {result['error']}")
        return 1
    print(f"Indexed: {result.get('indexed', 0)}")
    if result.get("errors"):
        print(f"Errors: {result['errors']}")
    print("Done. Tip: run a semantic query to confirm retrieval.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
