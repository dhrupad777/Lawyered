"""Create the three Lawyered Elasticsearch indices with ELSER semantic_text.

Run once after creating your Elastic Cloud Serverless project and setting
ELASTICSEARCH_URL + ELASTIC_API_KEY:

    cd backend
    python -m scripts.create_elastic_indices

Idempotent — existing indices are reported as "exists" and left untouched.
To reset an index for a fresh demo, delete it in Kibana (or via the ES API)
and re-run this script, then re-run scripts.seed_elastic.
"""

import sys

import elastic_client


def main() -> int:
    if not elastic_client.is_configured():
        print(
            "Elastic is not configured. Set ELASTICSEARCH_URL and ELASTIC_API_KEY "
            "(and `pip install elasticsearch>=8.15.0`) first."
        )
        return 1

    print(f"Connecting to {elastic_client.ELASTICSEARCH_URL} ...")
    print(f"Using inference endpoint: {elastic_client.ELSER_INFERENCE_ID}")
    result = elastic_client.create_indices()
    if "error" in result:
        print(f"FAILED: {result['error']}")
        return 1

    for index, status in result.items():
        print(f"  {index}: {status}")

    if any(str(v).startswith("error") for v in result.values()):
        return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
