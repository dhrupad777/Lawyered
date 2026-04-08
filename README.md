# Lawyered — Project Overview

> AI legal-intelligence platform that gives ordinary people legal clarity backed by **real US court cases**, drafts the documents they need, schedules the deadlines they have to meet, and lets them talk to a planner agent like they would talk to a lawyer.

This document is a self-contained brief intended to be referenced by other AI tools. It covers what Lawyered does, the multi-agent architecture, and exactly which Google technologies the project uses and where.

---

## 1. What Lawyered does

A user describes a legal situation in plain English ("my landlord won't return my $2000 security deposit"). Lawyered:

1. **Researches** the situation against real US case law via the CourtListener MCP server.
2. **Analyzes** strengths, weaknesses, win probability, and key factors.
3. **Drafts** the legal documents the user needs (demand letters, motions, hearing memos, cover letters, etc.) and syncs them to the user's Google Docs.
4. **Schedules** every hearing, filing, and deadline directly into the user's Google Calendar with smart reminders.
5. **Strategizes** — produces ranked options with pros/cons, cost estimates, timelines, and a recommended approach.
6. **Talks** to the user in a multi-turn chat as they add new context (new evidence, rescheduled hearings, new representation), and re-derives every affected section automatically.

The output is a single living **Case Report** at `/case/[id]` with four tabs (Overview, Analysis, Documents, Strategy) plus an Important Dates panel and a "Talk to Lawyered" planner chat.

Everything is grounded in either (a) opinions retrieved from the CourtListener public US-court database or (b) general legal principles clearly labeled as such — no fabricated case law.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser (Next.js 16, React 19, TypeScript, Tailwind v4)     │
│                                                              │
│  • /app           initial case-creation chat                 │
│  • /case/[id]     full case report + planner chat            │
│  • /history       past cases                                 │
│                                                              │
│  Firebase Auth (Google OAuth)  ──┐                           │
│  Firestore (cases collection)    │                           │
│  CalendarService (REST)          │── all browser-side,       │
│  DocsService (REST)              │   user's own OAuth token  │
└──────────────────────────────────┴───────────────────────────┘
                  │
                  │  HTTPS / SSE (AG-UI streaming protocol)
                  ▼
┌──────────────────────────────────────────────────────────────┐
│  FastAPI + Google ADK + ag-ui-adk on Cloud Run               │
│                                                              │
│  ┌─────────────────┐    ┌──────────────────┐                 │
│  │  orchestrator   │───▶│  research_agent  │── MCP ──▶ CL    │
│  │  (root)         │    │  (Gemini 2.5)    │                 │
│  │  Gemini 2.5     │    └──────────────────┘                 │
│  │                 │    ┌──────────────────┐                 │
│  │                 │───▶│  analysis_agent  │                 │
│  │                 │    └──────────────────┘                 │
│  │                 │    ┌──────────────────┐                 │
│  │                 │───▶│  drafting_agent  │                 │
│  └─────────────────┘    └──────────────────┘                 │
│                                                              │
│  ┌──────────────────────┐  ┌─────────────────────────┐       │
│  │ context_planner      │  │ context_extractor       │       │
│  │ (multi-turn chat,    │  │ (one-shot JSON)         │       │
│  │  FunctionTool tools) │  │                         │       │
│  └──────────────────────┘  └─────────────────────────┘       │
│  ┌──────────────────────┐  ┌─────────────────────────┐       │
│  │ context_helper       │  │ drafting_root           │       │
│  │ (one focused Q)      │  │ (standalone drafts)     │       │
│  └──────────────────────┘  └─────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
                  │
                  │  MCP / stdio
                  ▼
┌──────────────────────────────────────────────────────────────┐
│  CourtListener MCP server (real US court opinions, dockets,  │
│  statutes — operated by Free Law Project)                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Agent layer (Google ADK + Gemini)

All agents are built with **Google ADK** (`google.adk.agents.LlmAgent`) and run on **Gemini 2.5 Flash**. They are exposed to the browser via **`ag-ui-adk`**, which wraps each agent in a FastAPI route that streams events using the AG-UI Server-Sent-Events protocol.

| Agent | File | Tools | Role |
|---|---|---|---|
| `orchestrator` (root) | `backend/agents/orchestrator.py` | sub-agent transfers | Coordinates the research → analysis → JSON-assembly pipeline. Owns the final ` ```json ` block the frontend parses into a `CaseResultPayload`. |
| `research_agent` | `backend/agents/research.py` | **MCP toolset → CourtListener** (`search_cases`, `search_related_statutes`, `get_case_details`, `get_opinion`, `get_docket`) | Gathers real cases. Never reasons — just summarizes findings and transfers back. |
| `analysis_agent` | `backend/agents/analysis.py` | none | Pure reasoning over the research findings — strengths, weaknesses, win probability, key factors, strategy options. |
| `drafting_agent` | `backend/agents/drafting.py` | none | Sub-agent that drafts documents on demand (used inside the orchestrator). |
| `drafting_root_agent` | `backend/agents/drafting.py` | none | **Standalone** drafting agent exposed at its own endpoint (`/api/chat-draft`) so document drafts never get contaminated with the orchestrator's mandatory JSON output. |
| `context_helper_agent` | `backend/agents/context_helper.py` | none | Returns ONE focused clarifying question when an action needs missing info. |
| `context_extractor_agent` | `backend/agents/context_extractor.py` | none | One-shot agent that parses a free-text user update into a structured JSON intent (facts + calendar ops + critical-change flag). |
| `context_planner_agent` ⭐ | `backend/agents/context_planner.py` | **6 FunctionTools** | Multi-turn conversational planner. Behaves like a real attorney — asks one clarifying question at a time, then takes action by calling tools. The browser executes the tool signals against Google Calendar / Docs / Firestore / orchestrator. |

### Planner FunctionTools

The planner is the only agent with Python FunctionTools. Each tool is intentionally a **signal**, not a server-side mutation — it returns a short confirmation string and the **browser performs the real side effect** (Calendar API call, Firestore write, orchestrator regenerate). This keeps the user's OAuth tokens and Firestore credentials in the browser where they already live.

| Tool | What it signals |
|---|---|
| `propose_calendar_op(op, match_title, title, description, date_iso, duration_minutes, type, urgency)` | create / update / delete a Google Calendar event |
| `propose_new_document(title, description, why)` | append a new card to `documents.needed` |
| `propose_draft_now(title)` | invoke the drafting agent immediately and sync to Google Docs |
| `propose_fact(kind, summary, criticality)` | record a structured fact in `additionalInfo` |
| `propose_critical_regenerate(affected_sections)` | buffer a scoped orchestrator regenerate (fired at `mark_done`) |
| `mark_done()` | end the conversation, flush buffered regenerate, close the panel |

### FastAPI endpoints

| Path | Agent | Purpose |
|---|---|---|
| `POST /api/chat` | `orchestrator` | Initial case creation + full regenerates |
| `POST /api/chat-draft` | `drafting_root_agent` | Document drafting (no JSON contamination) |
| `POST /api/context-helper` | `context_helper_agent` | Missing-info bridge |
| `POST /api/context-extract` | `context_extractor_agent` | Fast deterministic context parse |
| `POST /api/context-planner` | `context_planner_agent` | Conversational planner with command authority |
| `GET  /api/health` | — | Architecture snapshot |

Every endpoint is registered via `add_adk_fastapi_endpoint` from `ag-ui-adk` and streams AG-UI events (`TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`) over SSE.

### Critical-change propagation

When the planner takes an action that materially shifts the case (new evidence, hearing date moved, new party), it calls `propose_critical_regenerate` with a list of affected sections. The browser buffers this and at `mark_done()` fires the orchestrator regenerate with a `CRITICAL_CHANGE: true` block telling it to **re-derive only the affected sections from scratch** while preserving the deadlines the planner already wrote deterministically. This means strategy / analysis / overview stay consistent with new facts without the planner having to think about them.

---

## 4. Frontend layer (Next.js)

- **Framework**: Next.js 16 (Turbopack) on the App Router, React 19, TypeScript, Tailwind v4.
- **Auth**: Firebase Auth with `GoogleAuthProvider`. The Google sign-in popup also captures the user's OAuth access token for Calendar + Docs scopes — those tokens stay in the browser and are passed directly to Google REST APIs as `Authorization: Bearer ...`.
- **Data**: Firestore SDK on the browser, indexed by user ID. Cases live in the `cases` collection.
- **Streaming**: `ChatService` (`frontend/src/lib/chat.ts`) handles the AG-UI SSE protocol — token streaming, tool-call buffering by `tool_call_id`, JSON args reassembly.
- **Critical files**:
  - `src/app/case/[id]/page.tsx` — the case report page, planner chat panel, calendar/docs orchestration
  - `src/lib/services/CaseService.ts` — Firestore mutations + `buildCaseContext` (the case.md serializer the agents read)
  - `src/lib/services/CalendarService.ts` — Google Calendar REST client
  - `src/lib/services/DocsService.ts` — Google Docs REST client
  - `src/components/Chat.tsx` — initial case-creation chat
- **Proxy routes**: every backend agent endpoint has a matching Next.js route under `src/app/api/<name>/route.ts` that forwards requests to the FastAPI backend (`BACKEND_URL` env var).

---

## 5. Google technologies — exhaustive list

This section is the answer to "how does Lawyered use Google technologies." Every Google product the project depends on is listed below with the file/function that uses it.

### 5.1 AI / Agents
- **Gemini 2.5 Flash** (`gemini-2.5-flash`) — model used by every LlmAgent in `backend/agents/`. Fast, cheap, supports function calling and long context.
- **Google Agent Development Kit (ADK)** — `google.adk.agents.LlmAgent`, `google.adk.tools.FunctionTool`, `google.adk.tools.mcp_tool.McpToolset`. Defines every agent, the sub-agent transfer system, and the tool-calling layer.
- **AG-UI ADK adapter** (`ag-ui-adk`) — `add_adk_fastapi_endpoint`, `ADKAgent`. Streams ADK runs as Server-Sent Events the frontend can consume in real time.

### 5.2 Identity & data
- **Firebase Authentication** — `firebase/auth` `GoogleAuthProvider` + `signInWithPopup`. Sole auth method. Token capture also yields the Calendar/Docs OAuth scopes.
- **Cloud Firestore** — `firebase/firestore`. Single `cases` collection. Schema lives in `frontend/src/lib/models/case.ts` (`LegalCase` interface). Drafts, deadlines, calendar event IDs, structured facts, and per-doc Google Doc IDs all live on the case document.
- **Firestore Security Rules** — deployed via `firebase deploy --only firestore:rules` from `deploy:manual`.

### 5.3 Productivity APIs
- **Google Calendar API v3** — direct REST calls from the browser in [`CalendarService.ts`](frontend/src/lib/services/CalendarService.ts):
  - `events.insert` → `createEventForDeadline`
  - `events.update` → `updateEventForDeadline`
  - `events.delete` → `deleteEvent`
  - `events.list` (with `privateExtendedProperty=lawyered_case_id=<id>`) → `listLawyeredEventsForCase` for orphan reconciliation
  - Smart reminders (1 week / 1 day / 1 hour for high-urgency, 3 days / 1 day for medium)
  - Per-deadline `extendedProperties.private.lawyered_case_id` so Lawyered-created events are app-namespaced and reconcilable
  - `authuser=<email>` appended to `htmlLink` at render time so multi-account users open events on the right Google account
- **Google Docs API** — `DocsService` creates, replaces, and links to Google Docs for every drafted document. The `docId` and `docUrl` are persisted alongside the draft in Firestore so the "Open in Google Docs" button always works.
- **Google Drive API** — implicit, used by Google Docs to host the documents the drafting agent produces.

### 5.4 Hosting & infra
- **Google Cloud Run** — both the Next.js frontend and the FastAPI backend deploy as separate Cloud Run services via `gcloud run deploy --source .`. The `deploy:manual` script in `frontend/scripts/deploy-manual.ps1` deploys both with a single command and wires the backend URL into the frontend at deploy time.
- **Cloud Build** — used implicitly by `gcloud run deploy --source .` to build and push container images.
- **Artifact Registry** — implicit container image storage for Cloud Run.
- **Cloud Logging** — automatic for both Cloud Run services.

### 5.5 Optional / referenced
- **Google AI Studio API key** (`GOOGLE_API_KEY`) — used by the ADK agents to call Gemini.
- **Firebase App Hosting** — alternative deploy target supported by the project's deploy reference doc; current `deploy:manual` uses Cloud Run directly.

### 5.6 Non-Google components (for completeness)
- **CourtListener** (Free Law Project) — the only data source for case law. Accessed via the **CourtListener MCP server**, which `research_agent` connects to with `McpToolset` over stdio. Token: `COURTLISTENER_API_TOKEN` env var.

---

## 6. Demo flow (1-minute version)

1. User signs in with Google → Firebase Auth captures token with Calendar + Docs scopes.
2. User types "My landlord refuses to return my $2000 security deposit in California."
3. `/api/chat` streams the orchestrator → research_agent runs CourtListener MCP queries → analysis_agent reasons → orchestrator emits `CaseResultPayload` JSON.
4. Frontend parses the JSON, persists to Firestore, redirects to `/case/[id]`.
5. User sees Overview / Analysis / Documents / Strategy tabs populated with real cited cases. Important Dates is empty.
6. User clicks "Talk to Lawyered" and types: *"There's a court hearing on next Tuesday — set a reminder, draft a motion for continuance, and remind me to submit evidence 3 days before the hearing with a cover letter."*
7. `context_planner_agent` resolves "next Tuesday" against `CURRENT_DATE`, then in a single turn fires 8 FunctionTool calls — calendar create × 2, new document × 2, draft now × 2, fact, critical regenerate.
8. The browser executes each signal: 2 Google Calendar events are created, 2 Google Docs are drafted by `drafting_root_agent` and synced to Drive, structured facts are written to Firestore, then the orchestrator runs a scoped regenerate that updates Strategy / Analysis / Overview to reflect the new hearing.
9. User sees inline confirmation chips ("✓ Added Court Hearing to your Google Calendar", "✓ Drafting Motion for Continuance...") in the chat, the panel closes, and the case page shows the new deadlines + new draft cards with "Open in Docs" buttons within ~30 seconds.

---

## 7. Repository layout

```
Lawyered/
├── backend/
│   ├── agent.py                    # root export
│   ├── server.py                   # FastAPI app, all /api routes registered
│   ├── prompts.py                  # all agent system prompts
│   └── agents/
│       ├── orchestrator.py
│       ├── research.py             # MCP → CourtListener
│       ├── analysis.py
│       ├── drafting.py             # drafting_agent + drafting_root_agent
│       ├── context_helper.py
│       ├── context_extractor.py
│       └── context_planner.py      # multi-turn planner with FunctionTools
└── frontend/
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx            # landing
    │   │   ├── app/page.tsx        # initial chat
    │   │   ├── case/[id]/page.tsx  # case report + planner chat panel
    │   │   ├── history/page.tsx
    │   │   └── api/                # Next.js proxy routes for every backend endpoint
    │   │       ├── chat/route.ts
    │   │       ├── chat-draft/route.ts
    │   │       ├── context-helper/route.ts
    │   │       ├── context-extract/route.ts
    │   │       └── context-planner/route.ts
    │   ├── components/
    │   │   ├── Chat.tsx            # initial-case chat (visual pattern reused by planner panel)
    │   │   └── AuthProvider.tsx
    │   └── lib/
    │       ├── chat.ts             # ChatService — AG-UI SSE client
    │       ├── firebase.ts
    │       ├── models/case.ts      # LegalCase + nested types
    │       └── services/
    │           ├── CaseService.ts      # Firestore + buildCaseContext (case.md serializer)
    │           ├── CalendarService.ts  # Google Calendar REST
    │           ├── DocsService.ts      # Google Docs REST
    │           ├── UserService.ts
    │           └── SessionService.ts
    └── scripts/
        └── deploy-manual.ps1       # one-command deploy of backend + frontend + rules
```

---

## 8. Key invariants for AI tools editing this codebase

- **Never fabricate case names.** Only cite cases that came back from CourtListener via `research_agent`. The orchestrator prompt and every drafting prompt enforce this.
- **Drafts are user-mutable artifacts.** When the orchestrator regenerates, the frontend layers prior `drafted` content + Google Doc IDs back onto the new `documents.needed` list using **normalized title matching** (lowercased, alphanumerics only). Orphan drafts that don't match anything are appended to the end of the list — never silently dropped.
- **Deadlines are agent-owned (single-source-of-truth)** — except in critical-change mode, where the planner's calendar ops are canonical and the orchestrator is told `skipDeadlines: true` for that regenerate.
- **Calendar event slugs** are built from `(title, type)` only (not the date) so a rescheduled deadline keeps the same slug and updates the same Google Calendar event in place. See `deadlineSlug()` in `CaseService.ts`.
- **OAuth tokens never go server-side.** Calendar and Docs writes happen in the browser. Backend agents emit signals; the browser executes them.
- **Every backend agent endpoint requires a matching Next.js proxy route** under `src/app/api/<name>/route.ts`. Forgetting this is the #1 demo-day failure mode.
- **All dates flow through CURRENT_DATE.** Every agent prompt receives `CURRENT_DATE: YYYY-MM-DD` and is responsible for resolving relative date phrases ("next Tuesday", "in 20 days") against it. Weekday and day-count phrases are explicitly never ambiguous.

---

## 9. One-line summary

**Lawyered is a multi-agent legal-intelligence platform built on Gemini 2.5 + Google ADK that researches real US case law via CourtListener, drafts legal documents into the user's Google Docs, schedules every deadline into the user's Google Calendar, and lets the user converse with an attorney-like planner agent — all auth'd through Firebase, persisted in Firestore, and deployed as two Cloud Run services.**
