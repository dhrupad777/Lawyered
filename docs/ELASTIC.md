# Lawyered × Elastic — Semantic Case-Law RAG, Memory & Document Search

This document covers Lawyered's Elastic integration: what it adds, how it's
wired, the one-time Elastic Cloud setup, and end-to-end verification.

> **Naming note:** *Elastic* Agent Builder (the MCP server we integrate) is a
> different product from *Google Cloud* Agent Builder (the tooling used to build
> the agent). Lawyered uses both. Elastic Agent Builder went **GA on 2026-01-22**.

---

## 1. What it adds

Lawyered previously had **no** semantic search — case law was keyword-only via
CourtListener, fetched fresh every time. Elastic adds three layers:

1. **Semantic case-law RAG (headline).** `research_agent` gains a hybrid
   semantic + keyword search (`search_caselaw`) over a curated case-law index.
   ELSER embeddings match cases by *legal meaning*, surfacing precedents that
   keyword search misses.
2. **Cross-case memory.** Finished cases are summarized into a per-user index;
   `find_similar_past_cases` retrieves "matters like this you've handled before."
3. **User-document RAG.** Users upload leases/contracts/evidence; ELSER indexes
   them; `search_user_documents` lets the agent answer grounded in the user's
   own files. All user-scoped reads are hard-filtered by `user_id`.

Everything **degrades gracefully**: with no Elastic env vars set, the backend
runs exactly as before (CourtListener-only).

---

## 2. How it's wired (mirrors the existing CourtListener MCP pattern)

```
research_agent (Gemini 3, ADK LlmAgent)  ── backend/agents/research.py
  tools:
    • courtlistener_toolset   stdio MCP  (unchanged)
    • elastic toolset:
        – REMOTE  → Elastic Agent Builder hosted MCP   (StreamableHTTPConnectionParams, ApiKey auth)   [primary]
        – LOCAL   → mcp_servers/elastic_mcp.py (stdio)  via elastic_client.py                            [fallback]
        – else    → omitted (CourtListener-only)                                                         [degrade]
        tool_filter = [search_caselaw, find_similar_past_cases, search_user_documents]

Elasticsearch (Elastic Cloud Serverless, ELSER via semantic_text):
  • lawyered-caselaw      ← scripts/seed_elastic.py  +  index-on-read cache (courtlistener_mcp.py)
  • lawyered-case-memory  ← POST /api/case-memory   (CaseService.indexCaseMemory, fire-and-forget)
  • lawyered-user-docs    ← POST /api/user-docs      (DocumentUpload component)
```

Path selection (`backend/agents/research.py`):

| Env | Result | `ELASTIC_MODE` |
|---|---|---|
| `ELASTIC_MCP_URL` + `ELASTIC_API_KEY` set (and not forcing local) | hosted Agent Builder MCP | `remote` |
| `LAWYERED_ELASTIC_LOCAL=1` (+ `ELASTICSEARCH_URL`, `ELASTIC_API_KEY`) | local stdio MCP | `local` |
| neither | CourtListener-only | `disabled` |

Writes go through the backend (`/api/case-memory`, `/api/user-docs`) so the
`ELASTIC_API_KEY` never reaches the browser; `user_id` is taken from the
`x-user-id` header (not the request body), mirroring the Firestore ownership
model.

### Key files
- `backend/elastic_client.py` — thin ES client (search, upsert, index bootstrap, warm-up, health).
- `backend/mcp_servers/elastic_mcp.py` — local stdio MCP server.
- `backend/agents/research.py` — toolset wiring + graceful degrade.
- `backend/prompts.py` — `RESEARCH_INSTRUCTION` teaches the agent the new tools.
- `backend/mcp_servers/courtlistener_mcp.py` — fire-and-forget index-on-read cache.
- `backend/server.py` — `/api/health`, `/api/case-memory`, `/api/user-docs`.
- `backend/scripts/create_elastic_indices.py`, `backend/scripts/seed_elastic.py`.
- `backend/model_config.py` — single Gemini 3 model default (`LAWYERED_MODEL` override).
- Frontend: `CaseService.indexCaseMemory` / `indexUserDocument`, `components/DocumentUpload.tsx`,
  `app/api/case-memory/route.ts`, `app/api/user-docs/route.ts`, `Chat.tsx` labels.

---

## 3. One-time Elastic Cloud setup

1. **Create an Elastic Cloud Serverless Elasticsearch project** at
   [cloud.elastic.co](https://cloud.elastic.co) (free trial), Google Cloud region.
   Serverless auto-manages ELSER via the Elastic Inference Service (no ML nodes).
2. **Enable Agent Builder** in Kibana.
3. **Create the indices** — set env vars (below) and run:
   ```bash
   cd backend
   python -m scripts.create_elastic_indices
   python -m scripts.seed_elastic          # seeds ~50 landlord/tenant opinions
   ```
4. **Create custom tools in Kibana** → *Manage components → Tools → New tool*
   (these IDs must match `tool_filter` in `research.py`):
   - **`search_caselaw`** — *Index search* tool, index pattern `lawyered-caselaw`,
     hybrid + semantic rerank. Params: `query` (required), `jurisdiction` (optional).
   - **`find_similar_past_cases`** — *ES|QL* or *Index search* tool over
     `lawyered-case-memory`, with a required `user_id` filter and a `situation` query.
   - **`search_user_documents`** — *ES|QL* or *Index search* tool over
     `lawyered-user-docs`, with a required `user_id` filter and a `query`.
   - Avoid reserved tool-ID prefixes (`security.*`, `observability.*`); add a
     `LIMIT` to ES|QL tools so results don't overflow the agent context.
5. **Create an Elasticsearch API key** with:
   - cluster privilege `monitor_inference`,
   - Kibana app privileges `feature_agentBuilder.read` + `feature_actions.read`,
   - read/metadata on the three `lawyered-*` indices.
   *(Missing `feature_agentBuilder.read` → 403.)*
6. **Copy the MCP Server URL** — Tools page → *Manage MCP → Copy MCP Server URL*:
   `https://{kibana}/api/agent_builder/mcp` (add `/s/{space}` for a non-default space).

### Environment variables (see `.env.example`)
```
ELASTICSEARCH_URL=https://<project>.es.<region>.gcp.elastic.cloud:443   # direct ES
ELASTIC_API_KEY=<elasticsearch api key>                                 # ES + MCP ApiKey header
ELASTIC_MCP_URL=https://<kibana>/api/agent_builder/mcp                   # hosted MCP (remote path)
# LAWYERED_ELASTIC_LOCAL=1     # force the local stdio MCP instead of remote
# ELASTIC_INFERENCE_ID=.elser-2-elasticsearch   # override only if your endpoint differs
# LAWYERED_MODEL=gemini-2.5-flash               # override the Gemini 3 default
```

---

## 4. Verification (end-to-end)

```bash
cd backend

# 1. Indices created with semantic_text/ELSER
python -m scripts.create_elastic_indices            # → created / exists

# 2. Seed + a semantic query that beats keywords
python -m scripts.seed_elastic
python -c "import elastic_client as e; print(e.hybrid_search_caselaw('my landlord kept my deposit'))"

# 3. Auth on the hosted MCP (expect 200 + your tool IDs, NOT 403)
curl -s -X POST "$ELASTIC_MCP_URL" \
  -H "Authorization: ApiKey $ELASTIC_API_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 4. Local MCP via inspector
npx @modelcontextprotocol/inspector python -m mcp_servers.elastic_mcp

# 5. Health snapshot
curl -s http://127.0.0.1:8080/api/health      # → "elastic": {"mcp_mode": "...", ...}
```

- **Agent (offline):** `LAWYERED_ELASTIC_LOCAL=1 python server.py`, run a query
  through `/api/chat`, confirm `search_caselaw` is called and Elastic-sourced
  cases appear in the orchestrator's JSON `relevantCases`.
- **Agent (remote):** set `ELASTIC_MCP_URL` + `ELASTIC_API_KEY` (unset local),
  repeat — confirm the hosted Agent Builder tool is invoked.
- **Index-on-read:** trigger a CourtListener `get_opinion`, then re-query ES and
  confirm the new `opinion_id` exists in `lawyered-caselaw`.
- **Memory isolation:** create case A for user 1, create a similar case B for
  user 1 → `find_similar_past_cases` returns A; confirm it returns **nothing**
  for a different `user_id`.
- **User docs:** upload a lease in the Documents tab → confirm `/api/user-docs`
  indexed it and the agent grounds an answer in it (scoped to that user).
- **Graceful degrade:** unset all Elastic env vars, restart → backend still
  imports and CourtListener-only research still works.

---

## 5. Demo-day checklist (avoid the common failures)

- ✅ ADK exposes `StreamableHTTPConnectionParams` (verified on `google-adk` 1.28).
- ✅ Kibana custom tools `search_caselaw` / `find_similar_past_cases` /
  `search_user_documents` exist (they are user-created, **not** built-in).
- ✅ API key has `feature_agentBuilder.read` (else 403). Verify with the curl above.
- ✅ **Warm ELSER** right before judging (EIS scales to 0 after ~15 min idle):
  `python -c "import elastic_client; print(elastic_client.warm_elser())"`.
- ✅ Seed corpus kept small (~50 opinions) so it indexes in seconds.
- ✅ The killer demo moment: a semantic query that finds a relevant case keyword
  search would miss.
