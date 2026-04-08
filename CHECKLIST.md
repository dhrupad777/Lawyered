# Hackathon Requirements Checklist

Mapping Lawyered against the problem statement and core requirements from the hackathon organizers.

> **Problem Statement:** Build a multi-agent AI system that helps users manage tasks, schedules, and information by interacting with multiple tools and data sources.

**Verdict: ✅ Lawyered satisfies every core requirement, with multiple implementations of most.**

---

## Problem Statement Fit

| Requirement | Status | How Lawyered satisfies it |
|---|---|---|
| Multi-agent AI system | ✅ | 8 distinct ADK agents (orchestrator + 7 specialists), see [README §3](README.md#3-agent-layer-google-adk--gemini) |
| Helps users manage **tasks** | ✅ | Documents tab tracks per-case to-do documents (motions, demand letters, memos); each card has Draft / Regenerate / Open in Docs actions |
| Helps users manage **schedules** | ✅ | Important Dates panel + Google Calendar two-way sync (create / update / delete events with reminders) |
| Helps users manage **information** | ✅ | Case Reports persist Overview, Analysis, Strategy, Relevant Cases, structured facts, and additional context across sessions |
| Interacts with **multiple tools** | ✅ | CourtListener MCP, Google Calendar API, Google Docs API, Firestore, planner FunctionTools (6 distinct tools) |
| Interacts with **multiple data sources** | ✅ | CourtListener (real US case law), Firestore (case state), Google Calendar (events), Google Docs (documents) |

---

## Core Requirements Checklist

### ✅ 1. Implement a primary agent coordinating one or more sub-agents

**Lawyered has TWO independent multi-agent topologies, both built on Google ADK.**

**Topology A — Case Research Pipeline (orchestrator + 3 sub-agents):**
- **Primary agent**: [`orchestrator`](backend/agents/orchestrator.py) (`LlmAgent`, Gemini 2.5 Flash)
- Coordinates via `transfer_to_agent` calls into:
  - [`research_agent`](backend/agents/research.py) — gathers case law from CourtListener
  - [`analysis_agent`](backend/agents/analysis.py) — produces strengths/weaknesses/win probability/strategy
  - [`drafting_agent`](backend/agents/drafting.py) — drafts documents on demand
- Orchestrator owns the final user-facing JSON the frontend renders
- Prompt enforces strict role separation: orchestrator never calls CourtListener directly, research_agent never reasons, analysis_agent never drafts

**Topology B — Conversational Planner (planner agent commanding the rest):**
- **Primary agent**: [`context_planner_agent`](backend/agents/context_planner.py) — multi-turn chat with the user
- Commands the entire system via 6 FunctionTools that emit signals the browser executes against:
  - The orchestrator (`propose_critical_regenerate` → triggers a scoped re-derivation)
  - The drafting pipeline (`propose_draft_now` → invokes drafting_root_agent)
  - Google Calendar (`propose_calendar_op`)
  - Firestore (`propose_new_document`, `propose_fact`)
- Acts as a meta-orchestrator: a single "court hearing next Tuesday + draft a motion + remind me about evidence" prompt fans out to 8 tool calls in one agent turn

**Files:**
- `backend/agents/orchestrator.py`, `research.py`, `analysis.py`, `drafting.py`, `context_planner.py`, `context_extractor.py`, `context_helper.py`
- `backend/prompts.py` — every agent's system prompt
- `backend/server.py` — FastAPI registration of all agents

---

### ✅ 2. Store and retrieve structured data from a database

**Database: Cloud Firestore** (Google's serverless NoSQL DB).

- **Collection**: `cases`
- **Schema**: see [`frontend/src/lib/models/case.ts`](frontend/src/lib/models/case.ts) — fully typed `LegalCase` interface with nested `CaseOverview`, `CaseAnalysis`, `CaseDocuments`, `CaseStrategy`, `CaseDeadline[]`, `calendarEventIds`, `additionalInfo` (structured facts).
- **Service layer**: [`frontend/src/lib/services/CaseService.ts`](frontend/src/lib/services/CaseService.ts) — `createCase`, `getCase`, `getUserCases`, `updateResult`, `setDeadlines`, `addStructuredContext`, `addProposedDocument`, `saveCalendarEventId`, `clearAdditionalInfo`, etc.
- **Self-healing reads**: `hydrateCase()` migrates legacy numeric-key `calendarEventIds` to slug-keyed format, dedupes accidental duplicate deadlines, and writes the cleaned version back in the background.
- **Auth**: Firestore security rules deployed via `firebase deploy --only firestore:rules` from the manual deploy script. Per-user authorization via Firebase Auth UID.

**Structured data examples:**
- Case overviews with arrays of `RelevantCase` (name, court, year, URL, summary, relevance)
- `CaseDeadline[]` with `(title, type, dateIso, durationMinutes, urgency, description)`
- `additionalInfo` map storing structured facts: `{kind, summary, criticality}` from the planner / extractor
- `documents.needed[]` with `(title, description, drafted, content, docId, docUrl)` linking back to Google Docs IDs

---

### ✅ 3. Integrate multiple tools via MCP

**Lawyered uses MCP (Model Context Protocol) to give the research agent live access to real US case law.**

**MCP server**: [CourtListener MCP](https://www.courtlistener.com) (Free Law Project), connected via stdio.

**MCP tools available to `research_agent`** (registered in [`backend/agents/research.py`](backend/agents/research.py) using `google.adk.tools.mcp_tool.McpToolset` + `StdioConnectionParams`):
- `search_cases(query, court, page)` — full-text case search
- `search_related_statutes(legal_topic, jurisdiction)` — find cases interpreting statutes
- `get_case_details(cluster_id)` — full case cluster details
- `get_opinion(opinion_id)` — read a specific opinion's text
- `get_docket(docket_id)` — docket-level info

**Why this matters for the requirement:**
- Real, verifiable data source (not LLM hallucination)
- Standardized MCP integration via the official `google.adk.tools.mcp_tool` adapter
- The agent autonomously decides which MCP tool to call and with what parameters based on the user's situation
- Every case citation in the final report carries the real CourtListener opinion URL, making the legal advice auditable

**Beyond MCP — additional tool integrations (Calendar, Docs, Tasks):**

The hackathon requirement mentions "calendar, task manager, notes" as examples. Lawyered satisfies these with direct REST integrations (browser-side, using the user's own OAuth tokens):

| Tool category | Example given | Lawyered's implementation |
|---|---|---|
| **Calendar** | calendar | Google Calendar API v3 — `CalendarService.ts` (`createEventForDeadline`, `updateEventForDeadline`, `deleteEvent`, `listLawyeredEventsForCase` for orphan reconciliation) |
| **Task manager** | task manager | Documents tab in the case page = the user's task list of legal documents to produce. Each task has Draft / Regenerate / Open in Docs actions and persists state in Firestore. |
| **Notes** | notes | `additionalInfo` structured facts in Firestore + the planner's `propose_fact` tool let the user add and recall case notes through natural conversation |

---

### ✅ 4. Handle multi-step workflows and task execution

**Lawyered handles multi-step workflows in three distinct ways.**

**Workflow A — Initial case creation (sequential agent pipeline):**
1. User submits a free-text legal question on `/app`
2. Orchestrator receives it, asks 1-3 clarifying questions if needed
3. Orchestrator calls `transfer_to_agent("research_agent")` → research agent runs 2-3 CourtListener MCP queries
4. Research agent returns a markdown summary, transfers control back to orchestrator
5. Orchestrator calls `transfer_to_agent("analysis_agent")` → analysis agent reasons over the findings
6. Analysis agent returns markdown, transfers back
7. Orchestrator assembles the final structured JSON (overview, analysis, documents, strategy, deadlines)
8. Frontend parses, persists to Firestore, redirects to `/case/[id]`

**Workflow B — Document drafting with side-effects:**
1. User clicks "Draft Now" on a document card
2. `handleDraft` builds a prompt with the full case context + USER_NAME + CURRENT_DATE
3. Streams via `/api/chat-draft` to `drafting_root_agent`
4. As tokens stream, `setDraftContent` updates the live preview
5. On stream end, `caseService.saveDraftContent` persists the draft text to Firestore
6. `docsService.createDoc` (or `replaceDocContent` for re-drafts) creates/updates a Google Doc
7. The returned `docId + docUrl` are persisted back to Firestore so the "Open in Docs" button works
8. Case is refreshed so the UI reflects the new state

**Workflow C — Conversational planner with command authority (most complex):**

User input: *"There's a court hearing on next Tuesday — set a reminder, draft a motion for continuance, and remind me to submit evidence 3 days before the hearing with a cover letter."*

In a single agent turn, the planner:
1. Resolves "next Tuesday" against `CURRENT_DATE`
2. Calls `propose_calendar_op` → frontend creates Google Calendar event for the hearing
3. Calls `propose_calendar_op` → frontend creates Google Calendar event for the evidence deadline
4. Calls `propose_new_document("Motion for Continuance")` → frontend writes new card to Firestore
5. Calls `propose_draft_now("Motion for Continuance")` → frontend invokes `handleDraft` → drafting_root_agent streams the document → Google Docs sync
6. Calls `propose_new_document("Evidence Submission Cover Letter")` → frontend writes second new card
7. Calls `propose_draft_now("Evidence Submission Cover Letter")` → second drafting + Google Docs sync
8. Calls `propose_fact` → frontend writes structured fact to Firestore
9. Calls `propose_critical_regenerate(["deadlines","strategy","documents","analysis"])` → frontend buffers the regenerate
10. Calls `mark_done()` → frontend flushes the buffered regenerate → orchestrator runs critical-change mode regenerate → strategy/analysis/overview update to reflect the new hearing → case is refreshed

**Critical-change propagation:** When the planner takes a posture-shifting action, every downstream section is re-derived automatically. The frontend buffers `propose_critical_regenerate` calls so they coalesce into a single orchestrator regenerate at `mark_done()`, instead of firing N regenerates during the chat.

---

### ✅ 5. Deploy as an API-based system

**Lawyered is deployed as a two-service API system on Google Cloud Run.**

**Backend (FastAPI):**
- Service: `lawyered-backend` on Cloud Run
- Runtime: FastAPI + `ag-ui-adk` + Google ADK
- Endpoints (all SSE-streaming via the AG-UI protocol):
  - `POST /api/chat` → orchestrator
  - `POST /api/chat-draft` → drafting_root_agent
  - `POST /api/context-helper` → context_helper_agent
  - `POST /api/context-extract` → context_extractor_agent
  - `POST /api/context-planner` → context_planner_agent
  - `GET /api/health` → architecture snapshot
- Each endpoint registered via `add_adk_fastapi_endpoint(app, ADKAgent(...), path=..., extract_headers=["x-user-id"])` in [`backend/server.py`](backend/server.py)
- Multi-turn session state preserved per `threadId` in the AG-UI protocol

**Frontend (Next.js 16):**
- Service: `lawyered-frontend` on Cloud Run
- Every backend agent endpoint has a matching Next.js proxy route under `frontend/src/app/api/<name>/route.ts` so the browser calls a single origin
- `BACKEND_URL` env var wires the proxy to the backend Cloud Run service URL at deploy time

**Deployment:**
- Single command: `npm run deploy:manual` from `frontend/`
- Script: [`frontend/scripts/deploy-manual.ps1`](frontend/scripts/deploy-manual.ps1)
- Pipeline: pre-flight build → `gcloud run deploy lawyered-backend --source .` → capture backend URL → `gcloud run deploy lawyered-frontend --source . --set-env-vars BACKEND_URL=$BackendUrl` → `firebase deploy --only firestore:rules`
- Both services use Cloud Build + Artifact Registry under the hood

---

### ✅ 6. Demonstrate coordination between agents, tools, and data to complete real-world workflows

**The headline demo: a single chat message produces 8 coordinated side-effects across 4 systems.**

User opens an existing security-deposit dispute case and types in the planner chat:

> *"There's a court hearing on next Tuesday — set a reminder and draft a motion for continuance. Also remind me to submit evidence in court 3 days prior to my new hearing date and draft a cover letter for the same."*

What happens, in order:

| # | Actor | Action | System touched |
|---|---|---|---|
| 1 | `context_planner_agent` (Gemini 2.5) | Resolves "next Tuesday" against `CURRENT_DATE` (no clarifying question — date math is unambiguous) | — |
| 2 | Planner | Calls `propose_calendar_op(create, "Court Hearing", date_iso=2026-07-14T09:00:00)` | — (signal) |
| 3 | Frontend | Executes `CalendarService.createEventForDeadline` → Google Calendar event created with reminders | **Google Calendar API** |
| 4 | Frontend | Persists `eventId` + `htmlLink` to `calendarEventIds` map | **Firestore** |
| 5 | Planner | Calls `propose_calendar_op(create, "Evidence Submission Deadline", date_iso=2026-07-11T17:00:00)` | — (signal) |
| 6 | Frontend | Second Google Calendar event created | **Google Calendar API** |
| 7 | Planner | Calls `propose_new_document("Motion for Continuance")` | — (signal) |
| 8 | Frontend | Appends new card to `documents.needed` | **Firestore** |
| 9 | Planner | Calls `propose_draft_now("Motion for Continuance")` | — (signal) |
| 10 | Frontend | Invokes `handleDraft` → streams from `drafting_root_agent` (Gemini 2.5) | **Google ADK / Gemini** |
| 11 | Frontend | On stream end, `docsService.createDoc` → Google Doc created and ID persisted | **Google Docs API + Firestore** |
| 12-14 | Planner + Frontend | Same flow for "Evidence Submission Cover Letter" → second Google Doc created | **Google Docs API + Firestore** |
| 15 | Planner | Calls `propose_fact(kind="date", criticality="high")` | — (signal) |
| 16 | Frontend | `caseService.addStructuredContext` writes fact to `additionalInfo` | **Firestore** |
| 17 | Planner | Calls `propose_critical_regenerate(["deadlines","strategy","documents","analysis"])` | — (signal, buffered) |
| 18 | Planner | Calls `mark_done()` | — (signal) |
| 19 | Frontend | Flushes buffered critical regenerate → calls `/api/chat` → `orchestrator` | **Google ADK / Gemini** |
| 20 | Orchestrator (Gemini 2.5) | Reads `CRITICAL_CHANGE: true` block, calls `research_agent` for fresh continuance precedents | **CourtListener MCP** |
| 21 | Orchestrator | Calls `analysis_agent` to re-derive strategy with the new hearing in mind | — |
| 22 | Orchestrator | Emits new `CaseResultPayload` JSON with updated overview/analysis/strategy/documents | — |
| 23 | Frontend | `caseService.updateResult` with `skipDeadlines: true` (planner already wrote canonical deadlines) — drafts preserved by normalized-title matching | **Firestore** |
| 24 | Frontend | Refreshes the case page — user sees new dates on Google Calendar, new drafts in Documents tab with "Open in Docs" links, and refreshed Strategy/Analysis | — |

**Systems coordinated in this single workflow:** Gemini 2.5 (5 distinct agents), Google Calendar API, Google Docs API, Cloud Firestore, CourtListener MCP, Firebase Auth (for the OAuth token used by Calendar/Docs), Cloud Run (both services), Next.js SSE streaming.

This is the goal restated: **"coordination between agents, tools, and data to complete real-world workflows."** A real legal user, with one sentence, gets a calendar entry, two drafted Google Docs, and a re-derived legal strategy — backed by real court cases and persisted across sessions.

---

## Bonus / Beyond-Requirements Features

These weren't required by the hackathon but Lawyered ships them:

- **Two complementary agent topologies** (orchestrator pipeline + planner with command authority) — most submissions only have one
- **Real data source via MCP** (CourtListener) — not just synthetic / fake data
- **Browser-side OAuth pattern** so the user's own Google Calendar and Google Docs are mutated, not a service-account-owned namespace — production-grade pattern that respects user data ownership
- **Critical-change propagation** — adding evidence in chat re-derives strategy + analysis automatically, not just the field that changed
- **Self-healing data layer** — Firestore reads detect and clean up legacy data on the fly
- **Conversational two-way Add Context** — the planner asks clarifying questions like a real attorney instead of failing on ambiguous input
- **Cycling status messages** during the 30-60s orchestrator regenerate so the user always knows what's happening
- **Mobile-responsive** — every option is reachable on a 375px-wide phone (icon-collapse pattern for header buttons)
- **Single-command deploy** of both services + Firestore rules (`npm run deploy:manual`)
- **Architecture snapshot endpoint** (`/api/health`) listing every agent and endpoint for observability

---

## Quick Verification — How to test each requirement

| Requirement | Test |
|---|---|
| Multi-agent coordination | `curl https://<backend>/api/health` → returns `agents: [orchestrator, research_agent, analysis_agent, ...]` |
| Database read/write | Open `/history` after creating a case → it appears, persists across sessions, survives a full page reload |
| MCP tool use | Create a new case → watch the streaming "Searching court cases..." indicators in the Chat component → final JSON contains real CourtListener URLs |
| Multi-step workflow | Open the planner panel → run the "court hearing next Tuesday + motion for continuance" prompt → watch 8 tool-call chips fire in sequence |
| API-based deployment | Both services live on Cloud Run; check `gcloud run services list` |
| Real-world coordination | Same demo as multi-step workflow → verify Google Calendar event appears, Google Doc opens correctly, Strategy tab reflects the new hearing |

---

## Summary

**Every core requirement is met, most are implemented two or three different ways, and the headline planner workflow demonstrates exactly the kind of cross-system coordination the problem statement asks for — in a real product domain (US legal aid) with a real data source (CourtListener) and real user-owned side effects (the user's own Google Calendar and Google Docs).**
