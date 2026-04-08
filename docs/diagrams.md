# Lawyered — Diagrams

Visual reference for the Lawyered legal AI assistant: use-case flows, key screen wireframes, and system architecture.

---

## 1. Use-Case / Process-Flow Diagram

Lawyered has two primary user flows: **(A) New Legal Research** (a fresh case is created from a free-text query) and **(B) Add Context** (a conversational planner refines an existing case).

### Flow A — New Legal Research

```
┌──────────┐                        ┌─────────────────────────────────────────────┐
│          │                        │                LAWYERED SYSTEM              │
│   USER   │                        │                                             │
│          │                        │                                             │
└────┬─────┘                        │                                             │
     │                              │                                             │
     │ 1. Types legal question      │                                             │
     │    on / or /app?q=...        │                                             │
     ├─────────────────────────────►│ Next.js Chat (SSE)                          │
     │                              │      │                                      │
     │                              │      ▼                                      │
     │                              │ /api/chat (proxy) ──► FastAPI /api/chat     │
     │                              │                              │              │
     │                              │                              ▼              │
     │                              │                      Orchestrator Agent     │
     │                              │                      (Gemini 2.5 Flash)     │
     │                              │                              │              │
     │  2. Asks 1–3 clarifying Qs   │                              │              │
     │ ◄────────────────────────────┤◄─────────────────────────────┤              │
     │                              │                              │              │
     │  3. Answers                  │                              │              │
     ├─────────────────────────────►│─────────────────────────────►│              │
     │                              │                              │              │
     │                              │              transfer_to_agent("research")  │
     │                              │                              ▼              │
     │                              │                       Research Agent ──────►│──► CourtListener
     │                              │                              │              │     (via MCP)
     │  "Searching court cases..."  │                              │              │
     │ ◄────────────────────────────┤◄────── tool_call SSE ────────┤              │
     │                              │                              │              │
     │                              │              transfer_to_agent("analysis")  │
     │                              │                              ▼              │
     │                              │                      Analysis Agent         │
     │                              │                      (SWOT + win %)         │
     │                              │                              │              │
     │                              │                              ▼              │
     │                              │                Final JSON: overview,        │
     │                              │                analysis, strategy,          │
     │                              │                documents, deadlines         │
     │                              │                              │              │
     │                              │                              ▼              │
     │                              │              caseService.createCase() ─────►│──► Firestore
     │                              │                              │              │
     │  4. Redirect to /case/[id]   │                              │              │
     │ ◄────────────────────────────┤                              │              │
     │                              │                                             │
     └──────────────────────────────┴─────────────────────────────────────────────┘
```

### Flow B — Add Context (Conversational Planner)

```
USER                          PLANNER AGENT                 SIDE EFFECTS
 │                                  │                             │
 │ "Add a hearing on May 3rd"       │                             │
 ├─────────────────────────────────►│                             │
 │                                  │                             │
 │                                  │ propose_calendar_op ───────►│ Google Calendar API
 │ "Creating calendar event..."     │                             │ (browser OAuth)
 │ ◄────────────────────────────────┤                             │
 │                                  │                             │
 │ "Also draft a motion to dismiss" │                             │
 ├─────────────────────────────────►│                             │
 │                                  │ propose_new_document ──────►│ Firestore (add doc card)
 │                                  │                             │
 │                                  │ propose_draft_now ─────────►│ /api/chat-draft
 │ "Drafting motion..."             │                             │ → Drafting Agent
 │ ◄────────────────────────────────┤                             │ → Google Docs API
 │                                  │                             │
 │                                  │ propose_critical_regen ────►│ (buffered)
 │                                  │                             │
 │                                  │ mark_done ─────────────────►│ flush buffer →
 │                                  │                             │ /api/chat (orchestrator)
 │                                  │                             │ re-derives case
 │ Case page updates                │                             │
 │ ◄────────────────────────────────┴─────────────────────────────┘
```

### Use-Case Summary

| Actor | Use Case | Endpoint |
|---|---|---|
| User | Submit a legal question and get a structured case report | `POST /api/chat` |
| User | View case overview, analysis, documents, strategy | Firestore read |
| User | Draft a legal document into a Google Doc | `POST /api/chat-draft` |
| User | Refine case with conversational planner | `POST /api/context-planner` |
| User | Sync deadlines to Google Calendar | (browser OAuth, client-side) |
| User | Browse / archive / delete prior cases | Firestore read/write |

---

## 2. Wireframes

### 2.1 Landing Page (`/`)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ⚖  Lawyered                              [ Login ]  [ Sign up ]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                  Your AI Legal Co-Counsel                           │
│         Ask any legal question. Get a real case strategy.           │
│                                                                     │
│   ┌─────────────────────────────────────────────────────┐  ┌────┐  │
│   │  Describe your legal situation...                    │  │ →  │  │
│   └─────────────────────────────────────────────────────┘  └────┘  │
│                                                                     │
│   Try a scenario:                                                   │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────┐ │
│   │  Security    │ │  Wrongful    │ │  Tenant      │ │  Contract │ │
│   │  Deposit     │ │  Termination │ │  Eviction    │ │  Dispute  │ │
│   └──────────────┘ └──────────────┘ └──────────────┘ └───────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Research Chat (`/app`)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ⚖  Lawyered    History    New Research               [ 👤 dhrup ] │
├──────────────┬──────────────────────────────────────────────────────┤
│              │                                                      │
│  + New       │   You: My landlord won't return my deposit...        │
│              │                                                      │
│  HISTORY     │   Lawyered: A few questions:                         │
│  ─────────   │     1. Which state are you in?                       │
│  • Deposit   │     2. How long ago did you move out?                │
│    case      │                                                      │
│  • Wrongful  │   You: California, 45 days ago                       │
│    term...   │                                                      │
│  • Contract  │   ⟳ Searching court cases...                         │
│    dispute   │   ⟳ Analyzing strengths & weaknesses...              │
│              │                                                      │
│              │   ✓ Case created. Redirecting to /case/abc123...     │
│              │                                                      │
│              │   ┌──────────────────────────────────────┐  ┌──────┐ │
│              │   │ Reply...                              │  │ Send │ │
│              │   └──────────────────────────────────────┘  └──────┘ │
└──────────────┴──────────────────────────────────────────────────────┘
```

### 2.3 Case Detail (`/case/[id]`)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ⚖  Lawyered     Security Deposit Dispute — California              │
├──────────────┬──────────────────────────────────────────────────────┤
│              │                                                      │
│  📋 Overview │   STRENGTHS                    WEAKNESSES            │
│  📊 Analysis │   • CA Civil Code §1950.5      • No itemized list    │
│  📄 Documents│   • 45-day window expired      • Verbal agreement    │
│  🎯 Strategy │                                                      │
│              │   Win Probability:  ████████░░  78%                  │
│              │                                                      │
│              │   RECOMMENDED ACTIONS                                │
│              │   1. Send certified demand letter                    │
│              │   2. File in small claims if no response in 14 days  │
│              │                                                      │
│              │   DOCUMENTS NEEDED                                   │
│              │   ┌────────────────────────────────────┐             │
│              │   │ 📄 Demand Letter                   │             │
│              │   │    [Draft Now]  [Open in Docs]     │             │
│              │   └────────────────────────────────────┘             │
│              │                                                      │
│              │                                       ┌────────────┐ │
│              │                                       │ + Add      │ │
│              │                                       │   Context  │ │
│              │                                       └────────────┘ │
└──────────────┴──────────────────────────────────────────────────────┘
```

### 2.4 History (`/history`)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ⚖  Lawyered    History                       [ Clear All ]        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  STATUS    TITLE                          CREATED         ACTIONS   │
│  ───────   ──────────────────────────     ─────────       ───────   │
│  🟢 Active  Security Deposit Dispute       2026-04-08      ⋮        │
│  🟡 Pending Wrongful Termination           2026-04-07      ⋮        │
│  ⚫ Closed  NDA Review                     2026-04-02      ⋮        │
│  🟠 Archived Tenant Eviction Defense       2026-03-28      ⋮        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                           CLIENT (Browser)                             │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │              Next.js 15 Frontend (App Router)                    │ │
│  │                                                                  │ │
│  │   /  ─►  /app  ─►  /case/[id]  ─►  /history                      │ │
│  │                                                                  │ │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │ │
│  │   │ ChatSvc    │  │ CaseSvc    │  │ CalendarSvc│  │ DocsSvc    │ │ │
│  │   │ (SSE)      │  │ (Firestore)│  │ (OAuth)    │  │ (OAuth)    │ │ │
│  │   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │ │
│  │         │               │               │               │        │ │
│  │   /api/chat        Firebase Auth   Google Calendar  Google Docs  │ │
│  │   /api/chat-draft  + Firestore     API v3           API          │ │
│  │   /api/context-*   (Cloud)                                       │ │
│  └────┬─────────────────────────────────────────────────────────────┘ │
└───────┼────────────────────────────────────────────────────────────────┘
        │ HTTPS + SSE (AG-UI protocol)
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  CLOUD RUN — lawyered-backend (FastAPI)                │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐  │
│   │                       server.py (FastAPI)                      │  │
│   │   /api/chat   /api/chat-draft   /api/context-planner   /health │  │
│   └─────┬──────────────┬──────────────────┬──────────────────────┘  │
│         │              │                  │                          │
│         ▼              ▼                  ▼                          │
│   ┌──────────┐   ┌──────────┐      ┌────────────────┐                │
│   │Orchestr- │   │ Drafting │      │ Context        │                │
│   │ ator     │   │ Root     │      │ Planner        │                │
│   │ Agent    │   │ Agent    │      │ Agent          │                │
│   └────┬─────┘   └────┬─────┘      └───────┬────────┘                │
│        │              │                    │                         │
│        ▼              │              FunctionTools:                  │
│   ┌──────────┐        │              propose_calendar_op             │
│   │ Research │        │              propose_new_document            │
│   │ Agent    │        │              propose_draft_now               │
│   └────┬─────┘        │              propose_fact                    │
│        │              │              propose_critical_regenerate     │
│        ▼              │              mark_done                       │
│   ┌──────────┐        │                                              │
│   │ Analysis │        │     (signals stream as SSE tool calls)       │
│   │ Agent    │        │                                              │
│   └──────────┘        │                                              │
│                       │                                              │
│        All agents: Google ADK + Gemini 2.5 Flash                     │
└────────┬──────────────┴──────────────────────────────────────────────┘
         │                                  │
         ▼                                  ▼
┌──────────────────┐              ┌──────────────────────┐
│   MCP Server     │              │   Gemini 2.5 Flash   │
│   CourtListener  │              │   (Vertex AI)        │
│   (stdio)        │              │                      │
│                  │              └──────────────────────┘
│   • search_cases │
│   • get_opinion  │
│   • get_docket   │
└────────┬─────────┘
         │ HTTPS
         ▼
┌──────────────────┐
│  CourtListener   │
│  REST API        │
│  (US case law)   │
└──────────────────┘
```

### Component Reference

| Layer | Component | Tech | Source |
|---|---|---|---|
| Frontend | App Router pages | Next.js 15 + React | `frontend/src/app/` |
| Frontend | SSE chat client | AG-UI protocol | `frontend/src/lib/chat.ts` |
| Frontend | Browser-side Google APIs | OAuth 2.0 | `frontend/src/lib/services/` |
| Frontend | Auth + persistence | Firebase Auth + Firestore | `frontend/src/lib/services/CaseService.ts` |
| Backend | HTTP server | FastAPI on Cloud Run | `backend/server.py` |
| Backend | Multi-agent orchestration | Google ADK | `backend/agents/` |
| Backend | LLM | Gemini 2.5 Flash | (all agents) |
| Backend | Case law tools | MCP / CourtListener | `backend/mcp_servers/courtlistener_mcp.py` |
| Deployment | Containers | Docker → Cloud Run | `backend/Dockerfile`, `frontend/Dockerfile`, `deploy.ps1` |
| Deployment | GKE portability | Kubernetes manifests | `kubernetes/` |
