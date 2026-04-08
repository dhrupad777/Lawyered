"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { caseService, calendarService, docsService, deadlineSlug, applyDeadlineOps, CalendarAuthExpiredError, DocsAuthExpiredError } from "@/lib/services";
import type { CaseResultPayload, CalendarOp, StructuredFact } from "@/lib/services/CaseService";
import { ChatService, type ChatMessage } from "@/lib/chat";
import type { LegalCase } from "@/lib/models/case";

type Tab = "overview" | "analysis" | "documents" | "strategy";


/** Pull a ```json fenced block from a streaming text and parse it. */
function extractCaseJson(text: string): CaseResultPayload | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && "overview" in parsed) {
      return parsed as CaseResultPayload;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Force a Google Calendar `htmlLink` to open in a SPECIFIC account.
 *
 * The htmlLink Google returns from events.insert (e.g.
 *   https://www.google.com/calendar/event?eid=ABC123
 * ) carries no account context. When the user has multiple Google accounts
 * signed in, clicking the link opens whichever account is "active" — which
 * may not be the account that owns the event, leading to "event not found"
 * or just landing on the wrong calendar's home page.
 *
 * Google's documented fix is to append `&authuser=<email>` to force the
 * correct account context. We do this at render time so the saved data
 * remains canonical (just the htmlLink Google handed back) and we can pull
 * the email from the live auth state.
 */
/**
 * Friendly status messages cycled in the regenerate overlay so the user has
 * something to read during the 30-60s orchestrator round-trip. Order roughly
 * mirrors the actual pipeline (research → analysis → strategy → finalize).
 */
const REGEN_STATUS_MESSAGES = [
  "Building your case...",
  "Searching real US court cases...",
  "Reading the most relevant opinions...",
  "Analyzing strengths and weaknesses...",
  "Estimating your win probability...",
  "Crafting a strategy...",
  "Mapping out your next steps...",
  "Finalizing deadlines and documents...",
  "Almost there...",
];

function withAuthUser(htmlLink: string, email: string | null | undefined): string {
  if (!email) return htmlLink;
  if (htmlLink.includes("authuser=")) return htmlLink;
  const sep = htmlLink.includes("?") ? "&" : "?";
  return `${htmlLink}${sep}authuser=${encodeURIComponent(email)}`;
}

/** Parse markdown bold/links in draft text to HTML */
function renderDraft(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#004ee7;text-decoration:underline">$1</a>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">')
    .replace(/\n\n/g, '</p><p style="margin:0 0 12px;line-height:1.8">')
    .replace(/\n/g, "<br>");
}

export default function CasePage() {
  const params = useParams();
  const caseId = params.id as string;
  const { user, loading: authLoading, signIn, googleAccessToken } = useAuth();
  const [legalCase, setLegalCase] = useState<LegalCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [draftingIndex, setDraftingIndex] = useState<number | null>(null);
  const [draftContent, setDraftContent] = useState<Record<number, string>>({});
  const [draftError, setDraftError] = useState<string | null>(null);
  const [showContextPanel, setShowContextPanel] = useState(false);
  // contextInput / savingContext were the legacy single-textarea Add Context
  // state. They are no longer used — the conversational planner panel uses
  // plannerInput / plannerBusy below. The legacy state is kept removed to
  // simplify the page, and the legacy extractor flow (handleSaveContext,
  // runExtractor) is unreachable after the FAB rewire.
  // ── Conversational planner state ──────────────────────────────────────
  // The Add Context panel is now a chat-style transcript driven by the
  // context_planner_agent. The thread is the back-and-forth between user
  // and agent. The agent emits tool-call signals over SSE which the
  // frontend executes against Calendar / Docs / Firestore / orchestrator.
  // toolChips render as small inline status messages between bubbles.
  // pendingCriticalRegen buffers a critical-change request until mark_done
  // so we run the orchestrator regenerate once at the end of the chat.
  const [plannerThread, setPlannerThread] = useState<ChatMessage[]>([]);
  const [plannerInput, setPlannerInput] = useState("");
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [plannerToolChips, setPlannerToolChips] = useState<string[]>([]);
  const pendingCriticalRegenRef = useRef<{ affected: string[]; facts: string[] } | null>(null);
  const plannerServiceRef = useRef<ChatService | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  // Calendar state
  const [calendarError, setCalendarError] = useState<string | null>(null);
  // Bulk-sync state for the "Update Calendar" button
  const [calendarSyncing, setCalendarSyncing] = useState(false);
  const [calendarSyncSummary, setCalendarSyncSummary] = useState<string | null>(null);
  // Regenerate state
  const [regenerating, setRegenerating] = useState(false);
  const [regenStreamText, setRegenStreamText] = useState("");
  const [regenError, setRegenError] = useState<string | null>(null);
  // Cycles through friendly status messages while the orchestrator runs so the
  // user has something to read during the 30-60s round-trip instead of staring
  // at a static spinner.
  const [regenStatusIdx, setRegenStatusIdx] = useState(0);
  // The legacy single-shot extractor state (extractorQuestion / extractorRound)
  // was removed when the conversational planner became the only Add Context
  // entry point. The /api/context-extract endpoint and the runExtractor /
  // handleSaveContext functions are gone with it.

  useEffect(() => {
    if (!caseId) return;
    caseService.getCase(caseId).then((c) => { setLegalCase(c); setLoading(false); }).catch(() => setLoading(false));
  }, [caseId]);

  // Rotate the regenerate status text every ~3.5s while the orchestrator runs.
  useEffect(() => {
    if (!regenerating) {
      setRegenStatusIdx(0);
      return;
    }
    const id = setInterval(() => {
      setRegenStatusIdx((i) => i + 1);
    }, 3500);
    return () => clearInterval(id);
  }, [regenerating]);

  /**
   * Call the context extractor agent with the user's free-text update plus
   * the current case.md. Returns the parsed JSON intent: status (complete or
   * needs_clarification), structured facts, calendar ops, criticalChange flag.
   *
   * This is the single entry point for ANY user-supplied context — both the
   * "Add Context" panel and the calendar-sync flow funnel through here. The
   * extractor is deterministic-by-design: ambiguous input → clarification
   * question, concrete input → ops the frontend can execute directly.
   */
  // The legacy runExtractor (one-shot context_extractor_agent caller) was
  // removed when the conversational planner became the primary flow. The
  // /api/context-extract endpoint still exists on the backend for any future
  // automation use, but the case page no longer calls it.

  /**
   * Execute a list of CalendarOps from the extractor against Google Calendar
   * AND mirror them into Firestore (deadlines[] + calendarEventIds map). Pure
   * helper used by the Save & Regenerate flow — no UI side effects.
   *
   * For `update`: looks up the existing event id by `deadlineSlug(matchTitle, type)`.
   * If no mapping exists (orphaned, or first time we're tracking this event),
   * falls through to `create`. For `delete`: removes the event from Calendar
   * AND clears the Firestore mapping.
   *
   * Returns counts so the UI can show a sync summary.
   */
  const executeCalendarOps = useCallback(
    async (
      ops: CalendarOp[],
      latestCase: LegalCase,
    ): Promise<{ created: number; updated: number; deleted: number; failed: number }> => {
      if (!googleAccessToken) throw new CalendarAuthExpiredError();
      const docLinks: Array<{ title: string; url: string }> = [];
      for (const d of latestCase.documents?.needed ?? []) {
        if (d.drafted && d.docUrl) docLinks.push({ title: d.title, url: d.docUrl });
      }
      let created = 0;
      let updated = 0;
      let deleted = 0;
      let failed = 0;

      for (const op of ops) {
        try {
          if (op.op === "create" && op.deadline) {
            const event = await calendarService.createEventForDeadline(
              googleAccessToken,
              caseId,
              op.deadline,
              docLinks,
            );
            const slug = deadlineSlug(op.deadline.title, op.deadline.type);
            await caseService.saveCalendarEventId(caseId, slug, event.id, event.htmlLink);
            created++;
          } else if (op.op === "update" && op.matchTitle && op.deadline) {
            const slug = deadlineSlug(op.matchTitle, op.deadline.type);
            const existingId = latestCase.calendarEventIds?.[slug];
            if (existingId) {
              const event = await calendarService.updateEventForDeadline(
                googleAccessToken,
                existingId,
                caseId,
                op.deadline,
                docLinks,
              );
              const newSlug = deadlineSlug(op.deadline.title, op.deadline.type);
              if (newSlug !== slug) {
                // Title changed (rare in update, but possible) — re-key the mapping.
                await caseService.removeCalendarEventId(caseId, slug);
              }
              await caseService.saveCalendarEventId(caseId, newSlug, event.id, event.htmlLink);
              updated++;
            } else {
              // No existing mapping — fall through to create.
              const event = await calendarService.createEventForDeadline(
                googleAccessToken,
                caseId,
                op.deadline,
                docLinks,
              );
              const newSlug = deadlineSlug(op.deadline.title, op.deadline.type);
              await caseService.saveCalendarEventId(caseId, newSlug, event.id, event.htmlLink);
              created++;
            }
          } else if (op.op === "delete" && op.matchTitle) {
            // We don't know the type when deleting (op.deadline is null), so
            // scan the existing calendarEventIds for any slug starting with
            // the slugified matchTitle. The slug format is `${title}-${type}`
            // post-normalization, so we match by prefix.
            const existing = latestCase.calendarEventIds ?? {};
            const matchPrefix = deadlineSlug(op.matchTitle, ""); // type empty → just title slug
            for (const [slug, eventId] of Object.entries(existing)) {
              if (slug.startsWith(matchPrefix)) {
                try {
                  await calendarService.deleteEvent(googleAccessToken, eventId);
                } catch (e) {
                  console.error(`Failed to delete event ${eventId}:`, e);
                }
                await caseService.removeCalendarEventId(caseId, slug);
                deleted++;
              }
            }
          }
        } catch (e) {
          if (e instanceof CalendarAuthExpiredError) throw e;
          console.error(`Calendar op failed:`, op, e);
          failed++;
        }
      }
      return { created, updated, deleted, failed };
    },
    [googleAccessToken, caseId],
  );

  /**
   * "Update Calendar" button. With the extractor-driven flow, calendar sync
   * is no longer a passive diff over deadlines[] — every change goes through
   * the Add Context panel, which calls the extractor and executes deterministic
   * Calendar ops. So this button just opens the Add Context panel.
   *
   * Pre-extractor, this handler did a three-phase bulk sync (create/update,
   * orphan-delete, reconcile-stray). The bulk sync was the source of the
   * "calendar tool glitching" symptoms because it depended on the orchestrator
   * emitting EXACT same titles across regenerates. The new flow makes every
   * calendar change explicit: the user types what changed, the extractor
   * decides create vs update vs delete, and the frontend just executes.
   */
  const handleUpdateCalendar = useCallback(async () => {
    if (!googleAccessToken) {
      setCalendarError("Calendar access not available. Please sign out and sign in again to grant Calendar permission.");
      return;
    }
    setCalendarError(null);
    setCalendarSyncSummary(null);
    // Open the conversational planner panel — it's the single Add Context
    // entry point and handles calendar ops via the planner agent's tools.
    // We inline the panel-open instead of calling openPlannerPanel to avoid
    // a use-before-declaration cycle (openPlannerPanel is declared later).
    setShowContextPanel(true);
    setPlannerThread([]);
    setPlannerInput("");
    setPlannerToolChips([]);
    pendingCriticalRegenRef.current = null;
    plannerServiceRef.current = null;
  }, [googleAccessToken]);

  /**
   * Regenerate the case in place. CRITICAL: always reads the latest case from
   * Firestore at the start instead of trusting `legalCase` from React state.
   * Reason: this callback is often invoked immediately after `setLegalCase`,
   * but React state updates are async, so the closure captures a stale case.
   * The previous version of this function read stale state and silently dropped
   * any context the user had just added — the agent never saw the new facts.
   * Re-fetching from Firestore makes the regeneration self-correcting.
   *
   * On success, also wipe `additionalInfo` — the agent has now folded those
   * facts into overview/analysis/strategy via the regeneration, so they are
   * no longer "pending context" to be carried forward.
   */
  const handleRegenerate = useCallback(async (
    criticalMode?: { affectedSections: string[]; factsSummary: string },
  ): Promise<void> => {
    setRegenerating(true);
    setRegenError(null);
    setRegenStreamText("");

    // Read the latest from Firestore — the React closure may be stale.
    const latest = await caseService.getCase(caseId);
    if (!latest) {
      setRegenError("Case not found.");
      setRegenerating(false);
      return;
    }

    const ctx = caseService.buildCaseContext(latest);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const userName = user?.displayName ?? "";
    const criticalBlock = criticalMode
      ? `\nCRITICAL_CHANGE: true\nAFFECTED_SECTIONS: ${JSON.stringify(criticalMode.affectedSections)}\nNEW_FACTS_SUMMARY:\n${criticalMode.factsSummary}\n\nThe deadlines[] in CASE CONTEXT are CANONICAL — they were just written by the context extractor's calendar ops. Mirror them in your output verbatim. Re-derive the AFFECTED_SECTIONS from scratch using the new facts.\n`
      : "";
    const prompt = `REGENERATION REQUEST — DO NOT ask any clarifying questions, you already have all the information below. Re-run the full research → analysis → JSON pipeline using the existing case context PLUS any new additional facts.
${criticalBlock}

CURRENT_DATE: ${today}
USER_NAME: ${userName}

--- EXISTING CASE CONTEXT (case.md) ---
${ctx}
--- END CASE CONTEXT ---

TASK: Regenerate the full case JSON. Update overview, analysis, strategy, documents, and deadlines to reflect EVERYTHING in the case context above. The "Additional Facts From The User" section (if present) contains new information the user has provided since the last analysis — fold these facts into the appropriate sections of your output.

CRITICAL — date resolution:
- Use CURRENT_DATE above as "today" to resolve ANY relative date the user mentioned ("in 20 days", "next Tuesday", "within two weeks", "30 days from now"). Compute the absolute ISO 8601 date and include it in the deadlines array.
- Example: if the user says "the hearing is in 20 days" and CURRENT_DATE is ${today}, the deadline dateIso must be the day that is 20 days after ${today}.
- NEVER drop dates from the previous case state unless the user has explicitly said they changed.
- The case must move from less concrete to more concrete — never sideways.

Output the standard ${"```json"} block exactly as the system prompt specifies.`;

    let fullResponse = "";
    const chatSvc = new ChatService();
    await chatSvc.sendMessage(
      [{ id: crypto.randomUUID(), role: "user", content: prompt }],
      (token) => {
        fullResponse += token;
        setRegenStreamText(fullResponse);
      },
      async () => {
        // Done streaming — parse the JSON, update case in place.
        const parsed = extractCaseJson(fullResponse);
        if (!parsed) {
          setRegenError("The agent did not return a parseable case JSON. Please try again.");
          setRegenerating(false);
          return;
        }
        try {
          // In critical-change mode the extractor already wrote the canonical
          // deadlines[] before this regenerate kicked off — pass skipDeadlines
          // so the orchestrator can't overwrite them.
          await caseService.updateResult(caseId, parsed, {
            skipDeadlines: !!criticalMode,
          });
          // Wipe the transient additional-facts buffer — they are now folded
          // into the regenerated overview/analysis/strategy.
          await caseService.clearAdditionalInfo(caseId);
          const fresh = await caseService.getCase(caseId);
          if (fresh) setLegalCase(fresh);
          setRegenerating(false);
          setRegenStreamText("");
        } catch (e) {
          setRegenError(e instanceof Error ? e.message : "Failed to update case.");
          setRegenerating(false);
        }
      },
      (err) => {
        setRegenError(err);
        setRegenerating(false);
      },
      undefined,
      "chat", // multi-agent orchestrator endpoint
    );
  }, [caseId, user]);

  /**
   * Save & Regenerate handler. This is the SINGLE entry point for any user-
   * supplied context update. Pipeline:
   *
   *   1. Re-fetch the case (avoid stale React state).
   *   2. Call the context extractor agent with the raw text + case.md.
   *   3. If the extractor returns `needs_clarification`, render the question
   *      above the textarea and wait for the user to refine + resubmit. Cap
   *      at 3 rounds — after that, accept whatever we have and proceed.
   *   4. Persist the structured facts to Firestore (additionalInfo).
   *   5. Execute calendar ops directly via Google Calendar API + mirror them
   *      into deadlines[] in Firestore.
   *   6. If `criticalChange` is true, kick off a scoped regenerate so the
   *      orchestrator re-derives the affected sections (strategy, analysis,
   *      etc.) using the new facts. The regenerate is told NOT to overwrite
   *      deadlines[] because the extractor already wrote the canonical list.
   *   7. If criticalChange is false, skip the regenerate entirely — just
   *      refresh the case from Firestore so the UI shows the new deadlines.
   *      (Massive UX win: pure data updates no longer wait 30-60s for the
   *      orchestrator to round-trip.)
   */
  // handleSaveContext (the legacy single-shot extractor flow) was removed
  // when the conversational planner became the only Add Context entry point.
  // The planner replaces it via handlePlannerSend below.

  // Status (settled / won / lost) is now changed via the kebab menu on the
  // History page, not here. caseService.markStatus is the API; this page
  // doesn't expose any controls for it.

  const handleDraft = useCallback(async (index: number, title: string) => {
    if (!legalCase) return;
    setDraftingIndex(index);
    setDraftError(null);

    // If a Doc already exists for this draft (regenerate-in-place), reuse it.
    const existingDocId = legalCase.documents?.needed?.[index]?.docId;

    const chatSvc = new ChatService();
    let draft = "";
    const ctx = caseService.buildCaseContext(legalCase);
    const userName = user?.displayName ?? "";
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `IMPORTANT: DO NOT ask any clarifying questions. You already have ALL the information below. Draft the document immediately.

USER_NAME: ${userName}
CURRENT_DATE: ${today}

--- FULL CASE CONTEXT ---
${ctx}
--- END CASE CONTEXT ---

TASK: Draft a complete, professional "${title}" using ONLY the case context above.

REQUIREMENTS:
- Use the actual USER_NAME above (not the [YOUR NAME] placeholder) wherever the user's name appears, including the signature block.
- Use CURRENT_DATE above as the document date (instead of [DATE] placeholder) so the response deadline math is correct.
- Use placeholders for the rest: [YOUR ADDRESS], [RECIPIENT NAME], [RECIPIENT ADDRESS]
- Cite the specific cases listed in the case context (use their exact names and URLs)
- Include a 14-day response deadline (compute from CURRENT_DATE) and signature block
- The jurisdiction, issue, and relevant cases are ALL in the context above — use them directly
- DO NOT ask for more information. Draft NOW.`;

    await chatSvc.sendMessage(
      [{ id: crypto.randomUUID(), role: "user", content: prompt }],
      (token) => {
        draft += token;
        setDraftContent((prev) => ({ ...prev, [index]: draft }));
      },
      async () => {
        // Stream complete. Persist content first so a Drive failure doesn't
        // lose the draft. Then create-or-update the Google Doc and persist
        // the docId/docUrl alongside.
        try {
          await caseService.saveDraftContent(caseId, index, draft);
        } catch (e) {
          console.error("Failed to save draft content:", e);
        }

        if (googleAccessToken) {
          try {
            const docResult = existingDocId
              ? await docsService.replaceDocContent(googleAccessToken, existingDocId, draft)
              : await docsService.createDoc(googleAccessToken, caseId, title, draft);
            await caseService.saveDraftContent(caseId, index, draft, docResult);
            // Refresh case so the UI shows the docUrl button.
            const fresh = await caseService.getCase(caseId);
            if (fresh) setLegalCase(fresh);
          } catch (e) {
            if (e instanceof DocsAuthExpiredError) {
              setDraftError("Google Docs session expired. Sign in again to enable Open in Docs.");
            } else {
              console.error("Google Docs sync failed:", e);
              setDraftError(
                e instanceof Error
                  ? `Couldn't sync to Google Docs: ${e.message}`
                  : "Couldn't sync to Google Docs.",
              );
            }
          }
        }
        setDraftingIndex(null);
      },
      () => setDraftingIndex(null),
      undefined,         // no tool-call callback for drafts (drafting agent has no tools)
      "chat-draft",      // route to /api/chat-draft, NOT the orchestrator — fixes JSON-in-drafts bug
    );
  }, [legalCase, caseId, googleAccessToken, user]);

  /**
   * Execute one tool-call signal emitted by the context_planner_agent over
   * SSE. The agent is purely advisory — every actual mutation happens here:
   *
   *   propose_calendar_op       → Google Calendar create/update/delete + Firestore
   *   propose_new_document      → Firestore: append a card to documents.needed
   *   propose_draft_now         → invoke handleDraft for the (possibly just-added) doc
   *   propose_fact              → Firestore: addStructuredContext
   *   propose_critical_regenerate → buffer until mark_done so the orchestrator
   *                                 regenerate runs once at the end
   *   mark_done                 → flush buffered regenerate, refresh case, close panel
   *
   * Returns a short human-readable chip string the chat UI shows inline so
   * the user can see what just happened.
   */
  const executePlannerTool = useCallback(
    async (name: string, args: Record<string, unknown> | undefined): Promise<string> => {
      // Always re-read the case so subsequent tools in the same turn see fresh state.
      const latest = await caseService.getCase(caseId);
      if (!latest) return "case not found";

      try {
        if (name === "propose_calendar_op") {
          const op: CalendarOp = {
            op: (args?.op as CalendarOp["op"]) ?? "create",
            matchTitle: (args?.match_title as string) || null,
            deadline:
              (args?.op as string) === "delete"
                ? null
                : {
                    title: (args?.title as string) ?? "",
                    description: (args?.description as string) ?? "",
                    dateIso: (args?.date_iso as string) ?? "",
                    durationMinutes: (args?.duration_minutes as number) ?? 60,
                    type: (args?.type as "hearing" | "filing" | "deadline" | "other") ?? "other",
                    urgency: (args?.urgency as "low" | "medium" | "high") ?? "medium",
                  },
          };
          await executeCalendarOps([op], latest);
          const newDeadlines = applyDeadlineOps(latest.deadlines ?? [], [op]);
          await caseService.setDeadlines(caseId, newDeadlines);
          if (op.op === "delete") return `✓ Removed “${op.matchTitle}” from calendar`;
          if (op.op === "update") return `✓ Updated “${op.deadline?.title}” in calendar`;
          return `✓ Added “${op.deadline?.title}” to your Google Calendar`;
        }

        if (name === "propose_new_document") {
          const title = (args?.title as string) ?? "";
          const description = (args?.description as string) ?? "";
          if (!title) return "missing title";
          await caseService.addProposedDocument(caseId, { title, description });
          return `✓ Added “${title}” to your Documents tab`;
        }

        if (name === "propose_draft_now") {
          const title = (args?.title as string) ?? "";
          if (!title) return "missing title";
          // Re-read AGAIN — propose_new_document may have just appended.
          const fresh = await caseService.getCase(caseId);
          const idx = fresh?.documents?.needed?.findIndex((d) => d.title === title) ?? -1;
          if (idx < 0) return `couldn't find “${title}” to draft`;
          // Fire-and-forget — drafting is long-running, we don't want to block
          // the planner stream waiting on it. The Documents tab will update
          // when the draft completes.
          void handleDraft(idx, title);
          return `✓ Drafting “${title}” — check the Documents tab`;
        }

        if (name === "propose_fact") {
          const fact: StructuredFact = {
            kind: (args?.kind as StructuredFact["kind"]) ?? "other",
            summary: (args?.summary as string) ?? "",
            criticality: (args?.criticality as StructuredFact["criticality"]) ?? "medium",
          };
          if (!fact.summary) return "missing fact summary";
          await caseService.addStructuredContext(caseId, [fact]);
          return `✓ Recorded: ${fact.summary}`;
        }

        if (name === "propose_critical_regenerate") {
          const affected = (args?.affected_sections as string[]) ?? [];
          const prior = pendingCriticalRegenRef.current ?? { affected: [], facts: [] };
          // Merge affected sections (union) — multiple tool calls in one turn
          // should accumulate into a single regenerate at mark_done.
          const merged = Array.from(new Set([...prior.affected, ...affected]));
          pendingCriticalRegenRef.current = { affected: merged, facts: prior.facts };
          return `✓ Will refresh ${merged.join(", ")} when done`;
        }

        if (name === "mark_done") {
          // Flush the buffered critical regenerate (if any) BEFORE closing.
          const pending = pendingCriticalRegenRef.current;
          pendingCriticalRegenRef.current = null;
          // Refresh the case once more so the UI reflects everything.
          const refreshed = await caseService.getCase(caseId);
          if (refreshed) setLegalCase(refreshed);
          if (pending && pending.affected.length > 0) {
            const factsSummary = pending.facts.join("\n") || "(see additional facts in case context)";
            // Don't await — let the chat panel close immediately and the
            // orchestrator overlay take over.
            void handleRegenerate({
              affectedSections: pending.affected,
              factsSummary,
            });
          }
          return "✓ All set";
        }

        return `(unknown tool: ${name})`;
      } catch (e) {
        if (e instanceof CalendarAuthExpiredError) {
          return "⚠ Calendar session expired — please sign in again";
        }
        console.error(`Planner tool ${name} failed:`, e);
        return `⚠ ${name} failed`;
      }
    },
    [caseId, executeCalendarOps, handleDraft, handleRegenerate],
  );

  /**
   * Send a message in the conversational planner thread. The first turn
   * prepends a hidden setup block (CURRENT_DATE, USER_NAME, full case.md);
   * subsequent turns are pure user replies. The agent's text streams into
   * the in-flight assistant bubble, and tool calls are dispatched as they
   * arrive via executePlannerTool.
   */
  const handlePlannerSend = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || plannerBusy) return;
      setPlannerBusy(true);
      setPlannerInput("");

      // First-turn setup block (hidden from the visible bubble — we render
      // the user's plain text but send the augmented one to the agent).
      const isFirstTurn = plannerThread.length === 0;
      let augmentedContent = trimmed;
      if (isFirstTurn) {
        const latest = await caseService.getCase(caseId);
        const ctx = latest ? caseService.buildCaseContext(latest) : "";
        const today = new Date().toISOString().slice(0, 10);
        const firstName = (user?.displayName ?? "").split(" ")[0];
        augmentedContent = `CURRENT_DATE: ${today}
USER_NAME: ${firstName}

CASE CONTEXT:
${ctx}

USER MESSAGE:
${trimmed}`;
      }

      const visibleUserMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
      };
      const sentUserMsg: ChatMessage = {
        ...visibleUserMsg,
        content: augmentedContent,
      };
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      setPlannerThread((prev) => [...prev, visibleUserMsg, assistantMsg]);

      // Lazily create a ChatService — one threadId per chat session.
      if (!plannerServiceRef.current) {
        plannerServiceRef.current = new ChatService();
      }
      const svc = plannerServiceRef.current;

      // Send the FULL thread (with the augmented first message) to the planner.
      const threadForSend: ChatMessage[] = isFirstTurn
        ? [sentUserMsg]
        : [
            // For non-first turns, replace the first visible user message with
            // its augmented version so the agent always sees the case context.
            // We rebuild the thread by walking plannerThread and replacing the
            // first user message with the augmented copy of itself.
            ...plannerThread.map((m, i) =>
              i === 0 && m.role === "user" ? { ...m, content: m.content } : m,
            ),
            sentUserMsg,
          ];

      await new Promise<void>((resolve) => {
        svc.sendMessage(
          threadForSend,
          (token) => {
            setPlannerThread((prev) => {
              const u = [...prev];
              const last = u[u.length - 1];
              if (last?.role === "assistant") {
                u[u.length - 1] = { ...last, content: last.content + token };
              }
              return u;
            });
          },
          () => resolve(),
          (err) => {
            setPlannerThread((prev) => {
              const u = [...prev];
              const last = u[u.length - 1];
              if (last?.role === "assistant") {
                u[u.length - 1] = { ...last, content: `Error: ${err}` };
              }
              return u;
            });
            resolve();
          },
          (toolName, status, args) => {
            if (status === "start") {
              setPlannerToolChips((prev) => [...prev, `Running ${toolName}...`]);
              return;
            }
            // status === "end" → execute the tool and replace the running chip
            // with the result chip.
            void executePlannerTool(toolName, args).then((chip) => {
              setPlannerToolChips((prev) => {
                const next = [...prev];
                // Replace the matching "Running X..." chip if present, else append.
                const idx = next.findIndex((c) => c === `Running ${toolName}...`);
                if (idx >= 0) next[idx] = chip;
                else next.push(chip);
                return next;
              });
            });
          },
          "context-planner",
        );
      });

      setPlannerBusy(false);
    },
    [plannerBusy, plannerThread, caseId, user, executePlannerTool],
  );

  const openPlannerPanel = useCallback(() => {
    setShowContextPanel(true);
    // Reset thread when opening fresh — every Add Context session is a new
    // conversation so the planner doesn't get confused by stale history.
    setPlannerThread([]);
    setPlannerInput("");
    setPlannerToolChips([]);
    pendingCriticalRegenRef.current = null;
    plannerServiceRef.current = null;
  }, []);

  const handleCopy = (index: number) => {
    navigator.clipboard.writeText(draftContent[index] || "");
    setCopied(index);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDownload = (index: number, title: string) => {
    const blob = new Blob([draftContent[index] || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/\s+/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Loading — skeleton instead of spinner
  if (authLoading || loading) return (
    <div style={{ minHeight: "100dvh", background: "#f8f9fa" }}>
      <div style={{ height: 56, background: "#fff", borderBottom: "1px solid #e5e7eb" }} />
      <div style={{ height: 50, background: "#fff", borderBottom: "1px solid #e5e7eb" }} />
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 24px" }}>
        <div className="skeleton" style={{ height: 20, width: 120, marginBottom: 20 }} />
        <div className="skeleton" style={{ height: 120, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 160, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 100 }} />
      </div>
    </div>
  );
  if (!user) return (
    <div style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8f9fa", padding: 16 }}>
      <div style={{ textAlign: "center", maxWidth: 360, width: "100%" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#94a3b8", marginBottom: 16, display: "block" }}>gavel</span>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: "'Manrope', sans-serif", marginBottom: 8 }}>Sign in to view this case report</h1>
        <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, marginBottom: 28 }}>Case reports are tied to your account for privacy and security.</p>
        <button onClick={() => signIn().catch((e) => { const c = (e as { code?: string }).code; if (c !== "auth/popup-closed-by-user" && c !== "auth/cancelled-popup-request") console.error(e); })} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Sign in with Google
        </button>
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>First time? Google sign-in creates your free account.</p>
        <a href="/" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "#64748b", marginTop: 20, textDecoration: "none" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_back</span> Back to home
        </a>
      </div>
    </div>
  );
  if (!legalCase) return <div style={{ padding: 60, textAlign: "center", color: "#94a3b8", fontSize: 15 }}>Case not found.</div>;

  const ov = legalCase.overview;
  const an = legalCase.analysis;
  const docs = legalCase.documents;
  const strat = legalCase.strategy;

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "visibility" },
    { id: "analysis", label: "Analysis", icon: "analytics" },
    { id: "documents", label: "Documents", icon: "description" },
    { id: "strategy", label: "Strategy", icon: "tactic" },
  ];

  return (
    <div style={{ minHeight: "100dvh", background: "#f8f9fa" }}>
      {/* ── Header ── */}
      <header style={{ height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 clamp(16px, 3vw, 32px)", background: "#fff", borderBottom: "1px solid #e5e7eb", position: "sticky", top: 0, zIndex: 40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <Link href="/" style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.04em", color: "#0f172a", flexShrink: 0 }}>Lawyered</Link>
          <span style={{ color: "#e2e8f0", flexShrink: 0 }}>/</span>
          <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{legalCase.query}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
          <button
            disabled={regenerating}
            onClick={() => { void handleRegenerate(); }}
            title="Re-run the multi-agent pipeline using the existing case context plus any added context. Drafts and existing calendar links are preserved."
            aria-label="Regenerate case"
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 12px", fontSize: 12, fontWeight: 700,
              background: regenerating ? "#e2e8f0" : "#fff",
              border: "1px solid #cbd5e1", borderRadius: 6,
              cursor: regenerating ? "wait" : "pointer",
              color: regenerating ? "#94a3b8" : "#1e40af",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16, animation: regenerating ? "spin 1s linear infinite" : undefined }}>autorenew</span>
            {/* Label always visible — on mobile we previously hid it which made
                the icon's purpose ambiguous. Now we collapse to a shorter
                label on very small screens via the `responsive-label` class. */}
            <span className="responsive-label-full">{regenerating ? "Regenerating..." : "Regenerate"}</span>
          </button>
          {/* History — always reachable from a case page. On mobile we render
              an icon-only button to save horizontal space; on >=sm screens
              the text label is shown. */}
          <Link
            href="/history"
            title="History"
            aria-label="History"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 12, fontWeight: 600, color: "#64748b",
              padding: "8px 12px", borderRadius: 6, border: "1px solid #e2e8f0",
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>history</span>
            <span className="responsive-label-full">History</span>
          </Link>
          <Link
            href="/app"
            title="New Research"
            aria-label="New Research"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              fontSize: 12, fontWeight: 700, color: "#fff",
              background: "#004ee7", padding: "8px 14px", borderRadius: 6,
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
            <span className="responsive-label-full">New Research</span>
          </Link>
        </div>
      </header>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #e5e7eb", background: "#fff", overflowX: "auto", padding: "0 clamp(16px, 3vw, 32px)" }}>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "14px 18px",
            fontSize: 13, fontWeight: 700, border: "none", background: "transparent", cursor: "pointer",
            color: activeTab === t.id ? "#004ee7" : "#94a3b8",
            borderBottom: activeTab === t.id ? "2.5px solid #004ee7" : "2.5px solid transparent",
            whiteSpace: "nowrap",
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Status pills moved to per-row kebab menu on /history.
          Regenerate button is now inline in the page header above. */}

      {/* ── Content ── */}
      <main style={{ maxWidth: 900, margin: "0 auto", padding: "28px clamp(16px, 3vw, 32px) 80px" }}>

        {/* ══ OVERVIEW ══ */}
        {activeTab === "overview" && ov && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="center-pill-row">
              <span style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", background: ov.urgency === "URGENT" ? "#fef2f2" : ov.urgency === "MODERATE" ? "#fffbeb" : "#f0fdf4", color: ov.urgency === "URGENT" ? "#dc2626" : ov.urgency === "MODERATE" ? "#d97706" : "#16a34a" }}>{ov.urgency}</span>
              <span style={{ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 800, background: "#f1f5f9", color: "#475569" }}>Confidence: {ov.confidence}</span>
            </div>

            <div className="center-card" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "24px 24px" }}>
              <h2 style={{ fontSize: 18, marginBottom: 10 }}>Issue Detected</h2>
              <p style={{ fontSize: 15, color: "#475569", lineHeight: 1.8 }}>{ov.issueDetected}</p>
            </div>

            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "24px 24px" }}>
              <h2 style={{ fontSize: 18, marginBottom: 14 }}>Your Rights</h2>
              {ov.rights.map((r, i) => (
                <div key={i} style={{ fontSize: 14, color: "#475569", lineHeight: 1.8, marginBottom: 10, paddingLeft: 24, position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, top: 2, width: 16, height: 16, background: "#eff6ff", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#004ee7", fontWeight: 800 }}>{i + 1}</span>
                  <span dangerouslySetInnerHTML={{ __html: r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#004ee7;text-decoration:underline;font-weight:600">$1</a>') }} />
                </div>
              ))}
            </div>

            {/* ── Important Dates (always rendered, with empty state) ── */}
            {(() => {
              const hasDeadlines = (legalCase.deadlines?.length ?? 0) > 0;
              return (
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "24px 24px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
                  <h2 style={{ fontSize: 18 }}>Important Dates</h2>
                  <button
                    disabled={calendarSyncing || plannerBusy || !googleAccessToken}
                    onClick={handleUpdateCalendar}
                    title="Add or update court dates, hearings, and deadlines. Talk to Lawyered in plain English and it'll handle the calendar sync for you."
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px", fontSize: 12, fontWeight: 700,
                      background: calendarSyncing || plannerBusy || !googleAccessToken ? "#e2e8f0" : "#004ee7",
                      color: calendarSyncing || plannerBusy || !googleAccessToken ? "#94a3b8" : "#fff",
                      border: "none", borderRadius: 6,
                      cursor: calendarSyncing || plannerBusy || !googleAccessToken ? "default" : "pointer",
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16, animation: calendarSyncing || plannerBusy ? "spin 1s linear infinite" : undefined }}>
                      {calendarSyncing || plannerBusy ? "progress_activity" : "calendar_month"}
                    </span>
                    {plannerBusy ? "Talking..." : calendarSyncing ? "Syncing..." : "Update Calendar"}
                  </button>
                </div>

                {/* Empty-state when no deadlines yet — the Update Calendar
                    button above will trigger the targeted Add Context flow. */}
                {!hasDeadlines && (
                  <div style={{
                    padding: "20px 16px",
                    background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 8,
                    textAlign: "center",
                  }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 32, color: "#94a3b8", marginBottom: 6, display: "block" }}>event_note</span>
                    <p style={{ fontSize: 13, color: "#475569", lineHeight: 1.6, marginBottom: 4 }}>
                      <strong>No deadlines tracked yet.</strong>
                    </p>
                    <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6, maxWidth: 460, margin: "0 auto" }}>
                      Click <strong>Update Calendar</strong> and tell Lawyered the dates you want to track. We&apos;ll add them to your Google Calendar with smart reminders.
                    </p>
                  </div>
                )}
                {!googleAccessToken && (
                  <p style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                    Calendar access not granted yet. <button onClick={() => signIn().catch(() => {})} style={{ background: "none", border: "none", color: "#004ee7", textDecoration: "underline", cursor: "pointer", fontSize: 12, fontWeight: 700, padding: 0 }}>Sign in again</button> to enable calendar sync.
                  </p>
                )}
                {/* Hint when no drafts exist yet — calendar reminders will be richer if drafts exist first. */}
                {googleAccessToken && (legalCase.documents?.needed?.every((d) => !d.docUrl) ?? true) && (
                  <p style={{ fontSize: 12, color: "#475569", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                    💡 Tip: <strong>draft your documents first</strong> (Documents tab) before syncing to Calendar. The reminders will then include direct links to your prepared materials.
                  </p>
                )}
                {calendarSyncSummary && (
                  <p style={{ fontSize: 12, color: "#15803d", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                    ✓ Calendar sync complete — {calendarSyncSummary}
                  </p>
                )}
                {hasDeadlines && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(legalCase.deadlines ?? []).map((d, i) => {
                    // Look up by SLUG (stable across reschedules) instead of
                    // array index (breaks when deadlines reorder). Migrated
                    // legacy index keys are converted to slugs in hydrateCase.
                    const slug = deadlineSlug(d.title, d.type);
                    const eventId = legalCase.calendarEventIds?.[slug];
                    const synced = Boolean(eventId);
                    const date = new Date(d.dateIso);
                    const dateValid = !isNaN(date.getTime());
                    const dateLabel = dateValid
                      ? date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                      : d.dateIso;
                    const urgencyColor = d.urgency === "high" ? "#dc2626" : d.urgency === "medium" ? "#d97706" : "#16a34a";
                    const urgencyBg = d.urgency === "high" ? "#fef2f2" : d.urgency === "medium" ? "#fffbeb" : "#f0fdf4";
                    // Prefer the Google-issued htmlLink (clean view URL). If we don't
                    // have one yet (legacy event), the next "Update Calendar" click
                    // will heal it via events.update returning a fresh htmlLink.
                    // Append `authuser=<email>` so multi-account users land on the
                    // event in the right account context (not on the wrong calendar's
                    // home page).
                    const rawLink = synced ? legalCase.calendarEventLinks?.[slug] : null;
                    const eventLink = rawLink ? withAuthUser(rawLink, user?.email) : null;
                    return (
                      <div key={i} style={{
                        display: "flex", alignItems: "flex-start", gap: 14,
                        padding: "14px 16px",
                        background: synced ? "#f0fdf4" : "#f8fafc",
                        border: `1px solid ${synced ? "#bbf7d0" : "#e5e7eb"}`,
                        borderRadius: 8,
                      }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 8,
                          background: urgencyBg, color: urgencyColor,
                          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 22 }}>
                            {d.type === "hearing" ? "gavel" : d.type === "filing" ? "description" : "event"}
                          </span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                            <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>{d.title}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: urgencyBg, color: urgencyColor, textTransform: "uppercase", letterSpacing: "0.05em" }}>{d.urgency}</span>
                            {synced && (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "#dcfce7", color: "#15803d", textTransform: "uppercase", letterSpacing: "0.05em", display: "inline-flex", alignItems: "center", gap: 3 }}>
                                <span className="material-symbols-outlined" style={{ fontSize: 11 }}>check</span>
                                Synced
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>{dateLabel}</div>
                          <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.5, marginBottom: synced && eventLink ? 8 : 0 }}>{d.description}</div>
                          {synced && eventLink && (
                            <a
                              href={eventLink}
                              target="_blank"
                              rel="noopener"
                              title="Open this event in Google Calendar"
                              style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                fontSize: 12, fontWeight: 700,
                                color: "#15803d", textDecoration: "none",
                              }}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>event_available</span>
                              View in Calendar →
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
                {calendarError && (
                  <p style={{ fontSize: 12, color: "#dc2626", marginTop: 12 }}>{calendarError}</p>
                )}
              </div>
              );
            })()}

            <div>
              <h2 style={{ fontSize: 18, marginBottom: 14 }}>Relevant Cases</h2>
              <div className="grid-cards">
                {ov.relevantCases.map((c, i) => (
                  <a key={i} href={c.url} target="_blank" rel="noopener" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 20, color: "inherit", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", flex: 1 }}>{c.name}</div>
                      <span className="badge-verified"><span className="material-symbols-outlined" style={{ fontSize: 10 }}>verified</span>Court Record</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>{c.court} · {c.year}</div>
                    <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, flex: 1 }}>{c.summary}</div>
                    <div style={{ fontSize: 12, color: "#004ee7", fontWeight: 700, marginTop: 4 }}>View on CourtListener →</div>
                  </a>
                ))}
              </div>
            </div>

            <Disclaimer reason={ov.confidenceReason} />
          </div>
        )}

        {/* ══ ANALYSIS ══ */}
        {activeTab === "analysis" && an && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 28 }}>
              <h2 style={{ fontSize: 18, marginBottom: 20 }}>Estimated Success Probability</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                <div style={{ flex: 1, height: 16, background: "#f1f5f9", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${an.winProbability}%`, background: an.winProbability >= 60 ? "#16a34a" : an.winProbability >= 40 ? "#d97706" : "#dc2626", borderRadius: 8, transition: "width 1s ease" }} />
                </div>
                <span style={{ fontSize: 28, fontWeight: 800, color: an.winProbability >= 60 ? "#16a34a" : an.winProbability >= 40 ? "#d97706" : "#dc2626", minWidth: 60, textAlign: "right" }}>{an.winProbability}%</span>
              </div>
            </div>

            <div className="grid-2-to-1">
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontSize: 15, color: "#16a34a", marginBottom: 12 }}>Strengths</h3>
                {an.strengths.map((s, i) => (
                  <div key={i} style={{ fontSize: 14, color: "#166534", lineHeight: 1.7, marginBottom: 8, paddingLeft: 20, position: "relative" }}>
                    <span style={{ position: "absolute", left: 0, color: "#16a34a" }}>✓</span>{s}
                  </div>
                ))}
              </div>
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 20 }}>
                <h3 style={{ fontSize: 15, color: "#dc2626", marginBottom: 12 }}>Weaknesses</h3>
                {an.weaknesses.map((w, i) => (
                  <div key={i} style={{ fontSize: 14, color: "#991b1b", lineHeight: 1.7, marginBottom: 8, paddingLeft: 20, position: "relative" }}>
                    <span style={{ position: "absolute", left: 0, color: "#dc2626" }}>✗</span>{w}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 20 }}>
              <h3 style={{ fontSize: 15, marginBottom: 12 }}>Key Factors</h3>
              {an.keyFactors.map((f, i) => (
                <div key={i} style={{ fontSize: 14, color: "#475569", lineHeight: 1.7, marginBottom: 8, paddingLeft: 24, position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, color: "#004ee7", fontWeight: 800 }}>{i + 1}.</span>{f}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <span className="badge-ai"><span className="material-symbols-outlined" style={{ fontSize: 10 }}>psychology</span>AI Analysis</span>
            </div>
            <Disclaimer />
          </div>
        )}

        {/* ══ DOCUMENTS ══ */}
        {activeTab === "documents" && docs && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {draftError && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                padding: "12px 16px",
                background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8,
              }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#dc2626", flexShrink: 0, marginTop: 1 }}>warning</span>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 13, color: "#991b1b", lineHeight: 1.5 }}>{draftError}</p>
                </div>
                <button onClick={() => setDraftError(null)} style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", padding: 2, lineHeight: 0 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                </button>
              </div>
            )}
            <h2 style={{ fontSize: 18 }}>Documents You Need</h2>
            {docs.needed.map((d, i) => (
              <div key={i} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
                {/* Document header — wraps on narrow screens so the Draft
                    button drops below the title instead of squashing it. */}
                <div style={{ padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "1 1 220px", minWidth: 0 }}>
                    <div style={{ width: 40, height: 40, background: draftContent[i] ? "#f0fdf4" : "#eff6ff", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 20, color: draftContent[i] ? "#16a34a" : "#004ee7" }}>
                        {draftContent[i] ? "check_circle" : "description"}
                      </span>
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <h3 style={{ fontSize: 15, marginBottom: 2, overflowWrap: "break-word" }}>{d.title}</h3>
                      <p style={{ fontSize: 13, color: "#64748b", overflowWrap: "break-word" }}>{d.description}</p>
                    </div>
                  </div>
                  {!draftContent[i] && (
                    <button onClick={() => handleDraft(i, d.title)} disabled={draftingIndex === i} style={{
                      padding: "10px 20px", fontSize: 13, fontWeight: 700, border: "none", borderRadius: 8, cursor: "pointer",
                      background: "#004ee7", color: "#fff", whiteSpace: "nowrap", flexShrink: 0,
                    }}>
                      {draftingIndex === i ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 16, animation: "spin 1s linear infinite" }}>progress_activity</span>
                          Drafting...
                        </span>
                      ) : (
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit_document</span>
                          Draft Now
                        </span>
                      )}
                    </button>
                  )}
                </div>

                {/* Rendered document */}
                {draftContent[i] && (
                  <>
                    {/* Toolbar */}
                    <div style={{ display: "flex", gap: 6, padding: "8px 24px", background: "#f8fafc", borderTop: "1px solid #f1f5f9", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap" }}>
                      {d.docUrl && (
                        <a
                          href={d.docUrl}
                          target="_blank"
                          rel="noopener"
                          style={{
                            display: "flex", alignItems: "center", gap: 4,
                            padding: "5px 12px", fontSize: 11, fontWeight: 700,
                            background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6,
                            color: "#004ee7", textDecoration: "none",
                          }}
                          title="Open this draft in Google Docs"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>description</span>
                          Open in Google Docs
                        </a>
                      )}
                      <button onClick={() => handleCopy(i)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", fontSize: 11, fontWeight: 700, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", color: copied === i ? "#16a34a" : "#64748b" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{copied === i ? "check" : "content_copy"}</span>
                        {copied === i ? "Copied!" : "Copy"}
                      </button>
                      <button onClick={() => handleDownload(i, d.title)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", fontSize: 11, fontWeight: 700, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", color: "#64748b" }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>download</span>
                        Download
                      </button>
                      <button
                        onClick={() => handleDraft(i, d.title)}
                        disabled={draftingIndex === i}
                        style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", fontSize: 11, fontWeight: 700, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, cursor: draftingIndex === i ? "wait" : "pointer", color: "#64748b" }}
                        title={d.docUrl ? "Re-draft and update the same Google Doc" : "Re-draft this document"}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14, animation: draftingIndex === i ? "spin 1s linear infinite" : undefined }}>refresh</span>
                        {draftingIndex === i ? "Regenerating..." : d.docUrl ? "Regenerate (updates Doc)" : "Regenerate"}
                      </button>
                    </div>
                    {/* Document body — styled like a real legal document */}
                    <div style={{
                      padding: "32px clamp(24px, 5vw, 48px)", maxHeight: 600, overflowY: "auto",
                      background: "#fff", fontSize: 14, lineHeight: 1.9, color: "#1e293b",
                    }}>
                      <p style={{ margin: "0 0 12px", lineHeight: 1.8 }} dangerouslySetInnerHTML={{ __html: renderDraft(draftContent[i]) }} />
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ══ STRATEGY ══ */}
        {activeTab === "strategy" && strat && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="center-card" style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
                <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#004ee7" }}>star</span>
                <h3 style={{ fontSize: 15, color: "#1e40af" }}>Recommended Approach</h3>
              </div>
              <p style={{ fontSize: 14, color: "#1e3a5f", lineHeight: 1.7 }}>{strat.recommendation}</p>
            </div>

            {strat.options.map((opt, i) => (
              <div key={i} className="center-card" style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 24 }}>
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>{opt.title}</h3>
                <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6, marginBottom: 16 }}>{opt.description}</p>

                <div className="grid-2-to-1" style={{ marginBottom: 16 }}>
                  <div style={{ background: "#f0fdf4", borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: "#16a34a", marginBottom: 8 }}>Pros</div>
                    {opt.pros.map((p, j) => <div key={j} style={{ fontSize: 13, color: "#166534", marginBottom: 4, lineHeight: 1.5 }}>+ {p}</div>)}
                  </div>
                  <div style={{ background: "#fef2f2", borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: "#dc2626", marginBottom: 8 }}>Cons</div>
                    {opt.cons.map((c, j) => <div key={j} style={{ fontSize: 13, color: "#991b1b", marginBottom: 4, lineHeight: 1.5 }}>- {c}</div>)}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 24, padding: "12px 16px", background: "#f8fafc", borderRadius: 8, fontSize: 13, justifyContent: "center", flexWrap: "wrap" }}>
                  <div><span style={{ color: "#94a3b8", fontWeight: 600 }}>Est. Cost</span> <strong style={{ color: "#0f172a", marginLeft: 4 }}>{opt.estimatedCost}</strong></div>
                  <div><span style={{ color: "#94a3b8", fontWeight: 600 }}>Timeline</span> <strong style={{ color: "#0f172a", marginLeft: 4 }}>{opt.estimatedTime}</strong></div>
                </div>
              </div>
            ))}
            <Disclaimer />
          </div>
        )}

        {/* No data fallback */}
        {activeTab === "overview" && !ov && <EmptyState icon="visibility" text="Overview data not available yet." />}
        {activeTab === "analysis" && !an && <EmptyState icon="analytics" text="Analysis data not available yet." />}
        {activeTab === "documents" && !docs && <EmptyState icon="description" text="Document suggestions not available yet." />}
        {activeTab === "strategy" && !strat && <EmptyState icon="tactic" text="Strategy not available yet." />}

        {/* Additional facts the user has provided are folded silently into the
            case during regeneration (see handleRegenerate). They are NOT shown
            here as a separate "Additional Context Provided" card, because once
            the agent has woven them into overview/analysis/strategy they are
            no longer "additional" — they are part of the main case understanding. */}
      </main>

      {/* ── Regenerate streaming overlay ── */}
      {regenerating && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 100,
          background: "rgba(15, 23, 42, 0.6)", backdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div style={{
            background: "#fff", borderRadius: 14, padding: "28px 28px 24px",
            maxWidth: 560, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <span className="material-symbols-outlined" style={{ fontSize: 28, color: "#004ee7", animation: "spin 1.2s linear infinite" }}>autorenew</span>
              <div>
                <h3 style={{ fontSize: 17, fontWeight: 800, color: "#0f172a", marginBottom: 2 }}>
                  {REGEN_STATUS_MESSAGES[regenStatusIdx % REGEN_STATUS_MESSAGES.length]}
                </h3>
                <p style={{ fontSize: 12, color: "#64748b" }}>Re-running research, analysis, and strategy with your latest context. This usually takes 30-60 seconds.</p>
              </div>
            </div>
            <div style={{
              flex: 1, overflowY: "auto",
              background: "#f8fafc", borderRadius: 8, padding: 14,
              fontSize: 12, lineHeight: 1.6, color: "#475569", fontFamily: "ui-monospace, SFMono-Regular, monospace",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              minHeight: 120,
            }}>
              {regenStreamText
                .replace(/```json[\s\S]*?```/g, "\n[building case JSON…]\n")
                .slice(-2000) || "Starting orchestrator…"}
            </div>
            {regenError && (
              <p style={{ fontSize: 12, color: "#dc2626", marginTop: 12 }}>{regenError}</p>
            )}
          </div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {/* ── Add Context FAB ── opens the conversational planner */}
      {!showContextPanel && (
        <button onClick={openPlannerPanel} style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 50,
          display: "flex", alignItems: "center", gap: 8,
          background: "#004ee7", color: "#fff", border: "none", borderRadius: 14,
          padding: "14px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer",
          boxShadow: "0 4px 24px rgba(0,78,231,0.25)",
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>chat</span>
          Talk to Lawyered
        </button>
      )}

      {/* ── Conversational Planner Panel ── */}
      {showContextPanel && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50,
          background: "#fff", borderTop: "1px solid #e5e7eb",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.08)",
          maxHeight: "min(70vh, 640px)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ maxWidth: 760, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: "20px clamp(16px,4vw,32px) 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 10, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 18, color: "#004ee7" }}>gavel</span>
                </div>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>Talk to Lawyered</h3>
                  <p style={{ fontSize: 11, color: "#64748b" }}>Describe what changed — dates, evidence, new documents — and Lawyered will handle the rest.</p>
                </div>
              </div>
              <button
                onClick={() => setShowContextPanel(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8", padding: 4 }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>close</span>
              </button>
            </div>

            {/* Transcript */}
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 4px", minHeight: 120 }}>
              {plannerThread.length === 0 && (
                <div style={{ padding: "16px 12px", background: "#f8fafc", border: "1px dashed #e2e8f0", borderRadius: 10, fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>
                  Try: <em>“There&apos;s a court hearing on next Monday — set a reminder and draft a motion for continuance.”</em>
                </div>
              )}
              {plannerThread.map((msg) => (
                <div key={msg.id} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start", marginBottom: 12 }}>
                  {msg.role === "assistant" && (
                    <div style={{ width: 26, height: 26, borderRadius: 8, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginRight: 8, marginTop: 2 }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#004ee7" }}>gavel</span>
                    </div>
                  )}
                  <div style={{
                    maxWidth: "82%", padding: "10px 14px", borderRadius: 12, fontSize: 14, lineHeight: 1.6,
                    overflowWrap: "break-word",
                    background: msg.role === "user" ? "#004ee7" : "#fff",
                    color: msg.role === "user" ? "#fff" : "#1e293b",
                    border: msg.role === "user" ? "none" : "1px solid #e5e7eb",
                    borderBottomRightRadius: msg.role === "user" ? 4 : 12,
                    borderBottomLeftRadius: msg.role === "assistant" ? 4 : 12,
                  }}>
                    {msg.content || (plannerBusy && msg.role === "assistant" ? "Thinking..." : "")}
                  </div>
                </div>
              ))}
              {/* Tool-call status chips */}
              {plannerToolChips.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8, marginLeft: 34 }}>
                  {plannerToolChips.map((chip, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "4px 10px", alignSelf: "flex-start" }}>
                      {chip}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Input row */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "8px 8px 8px 14px", marginTop: 8, flexShrink: 0 }}>
              <textarea
                value={plannerInput}
                onChange={(e) => setPlannerInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handlePlannerSend(plannerInput);
                  }
                }}
                placeholder={plannerThread.length === 0 ? "Tell Lawyered what changed..." : "Type your reply..."}
                disabled={plannerBusy}
                rows={1}
                style={{
                  flex: 1, resize: "none", border: "none", outline: "none",
                  padding: "6px 0", fontSize: 14, fontFamily: "inherit",
                  color: "#1e293b", background: "transparent",
                  minHeight: 22, maxHeight: 100, lineHeight: 1.5,
                }}
              />
              <button
                onClick={() => void handlePlannerSend(plannerInput)}
                disabled={plannerBusy || !plannerInput.trim()}
                style={{
                  width: 34, height: 34, border: "none", borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  background: plannerBusy || !plannerInput.trim() ? "#e2e8f0" : "#004ee7",
                  cursor: plannerBusy || !plannerInput.trim() ? "default" : "pointer",
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 17, color: "#fff" }}>
                  {plannerBusy ? "hourglass_top" : "arrow_upward"}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Disclaimer({ reason }: { reason?: string }) {
  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 14, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#94a3b8", marginTop: 1 }}>info</span>
        <div>
          <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
            This is <strong>legal information</strong> based on real court cases, not legal advice. For guidance specific to your situation, consult a licensed attorney.
          </p>
          {reason && <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Confidence note: {reason}</p>}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: "#94a3b8" }}>
      <span className="material-symbols-outlined" style={{ fontSize: 40, marginBottom: 12, display: "block", opacity: 0.3 }}>{icon}</span>
      <p style={{ fontSize: 14 }}>{text}</p>
    </div>
  );
}
