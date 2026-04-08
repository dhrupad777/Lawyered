import {
  type Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import type {
  LegalCase,
  CaseOverview,
  CaseAnalysis,
  CaseDocuments,
  CaseStrategy,
  CaseDeadline,
  CaseStatus,
} from "@/lib/models/case";
import { Timestamp } from "firebase/firestore";

/**
 * Stable identifier for a deadline across regenerations. Maps to a Firestore
 * field key (so it must be a-z0-9-_ only) and is used as the lookup key in
 * `calendarEventIds` and `calendarEventLinks`.
 *
 * Built from (title, type) — NOT including the date — so a rescheduled
 * deadline keeps the same id and the same Google Calendar event gets updated
 * in place instead of creating a duplicate.
 */
export function deadlineSlug(title: string, type: string): string {
  const raw = `${title}-${type}`.toLowerCase();
  return raw
    .replace(/[^a-z0-9_-]+/g, "-") // any non-slug char → hyphen
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, "") // trim leading/trailing hyphens
    .slice(0, 80); // Firestore field-key safety
}

/**
 * Collapse EXACT duplicate deadlines: same title, same type, same dateIso.
 * Anything else is left untouched.
 *
 * This function is intentionally NON-SEMANTIC. It does not merge "similar"
 * entries, it does not pick winners between dates, and it does not drop past
 * entries. All of those decisions are intent calls that the orchestrator owns
 * — the user knows what they meant when they typed their context, the
 * orchestrator interprets that intent, and the frontend trusts the result.
 *
 * The only role of this function is to be a safety net against literal
 * accidental duplicates (same write called twice, etc.). It never makes a
 * decision that would silently lose data.
 *
 * Returns `null` if nothing changed so callers can avoid unnecessary writes.
 */
function dedupeDeadlines(deadlines: CaseDeadline[]): CaseDeadline[] | null {
  if (deadlines.length < 2) return null;
  const seen = new Set<string>();
  const out: CaseDeadline[] = [];
  for (const d of deadlines) {
    // Identity = title + type + dateIso. Two entries that match on all three
    // are literally identical and one is a write artifact.
    const id = `${d.title}\u0000${d.type}\u0000${d.dateIso}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  if (out.length === deadlines.length) return null;
  return out;
}

/**
 * Structured fact emitted by the context extractor agent. Stored in
 * `additionalInfo.{key}` as an object (not a string) so the orchestrator
 * sees a clean parsed view during regenerate, and the frontend can render
 * criticality tags.
 */
export interface StructuredFact {
  kind: "date" | "evidence" | "party" | "amount" | "other";
  summary: string;
  criticality: "low" | "medium" | "high";
}

/**
 * One deterministic Google Calendar operation emitted by the context extractor.
 * The frontend executes these directly via CalendarService — no agent diff
 * required. `matchTitle` is the prior deadline title used to look up the
 * existing event by slug for `update`/`delete`; null for `create`.
 */
export interface CalendarOp {
  op: "create" | "update" | "delete";
  matchTitle: string | null;
  deadline: CaseDeadline | null;
}

/**
 * Apply a list of CalendarOps to a deadlines array, returning the mutated
 * array. Pure function — no Firestore writes, no Calendar API calls. Used by
 * the case page's calendar sync flow to compute the new deadlines[] before
 * persisting.
 *
 * Semantics:
 *   - create → push the new deadline (no slug collision check; the extractor
 *     prompt is responsible for choosing a fresh title)
 *   - update → find by matchTitle, replace with the new deadline
 *   - delete → drop by matchTitle
 */
export function applyDeadlineOps(
  deadlines: CaseDeadline[],
  ops: CalendarOp[],
): CaseDeadline[] {
  let next = [...deadlines];
  for (const op of ops) {
    if (op.op === "create" && op.deadline) {
      next.push(op.deadline);
    } else if (op.op === "update" && op.matchTitle && op.deadline) {
      const idx = next.findIndex((d) => d.title === op.matchTitle);
      if (idx >= 0) next[idx] = op.deadline;
      else next.push(op.deadline); // fall through to create when no match
    } else if (op.op === "delete" && op.matchTitle) {
      next = next.filter((d) => d.title !== op.matchTitle);
    }
  }
  return next;
}

/** The shape the agent returns inside the ```json fenced block. */
export interface CaseResultPayload {
  overview: CaseOverview;
  analysis: CaseAnalysis;
  documents: CaseDocuments;
  strategy: CaseStrategy;
  /** Optional in older payloads — the orchestrator may emit `[]` if no dates known. */
  deadlines?: CaseDeadline[];
}

/**
 * Migrate legacy calendarEventIds keyed by numeric array index into the new
 * slug-keyed format. Pre-Phase-6, the case page rendered the link via
 * `calendarEventIds[String(i)]` where i was the deadline's array position;
 * if the array got reordered or had entries removed, mappings broke. We now
 * key by `deadlineSlug(title, type)` which is stable across regenerations.
 *
 * Returns the migrated maps. The actual Firestore document is NOT rewritten
 * here — the next saveCalendarEventId / sync will write the new keys, and
 * the orphan-reconciliation logic in handleUpdateCalendar will delete any
 * stale legacy events on the calendar side.
 */
function migrateCalendarMaps(
  rawIds: Record<string, string> | undefined,
  rawLinks: Record<string, string> | undefined,
  deadlines: CaseDeadline[],
): { ids: Record<string, string>; links: Record<string, string> } {
  const ids = rawIds ?? {};
  const links = rawLinks ?? {};
  // Check if any keys look like numeric indices (legacy format)
  const hasLegacyKeys = Object.keys(ids).some((k) => /^\d+$/.test(k));
  if (!hasLegacyKeys) return { ids, links };

  const newIds: Record<string, string> = {};
  const newLinks: Record<string, string> = {};
  for (const [key, eventId] of Object.entries(ids)) {
    if (/^\d+$/.test(key)) {
      const idx = parseInt(key, 10);
      const dl = deadlines[idx];
      if (dl) {
        const slug = deadlineSlug(dl.title, dl.type);
        newIds[slug] = eventId;
        if (links[key]) newLinks[slug] = links[key];
      }
      // If idx is out of bounds, drop the entry. Orphan-reconciliation
      // on the next sync will delete the stale calendar event.
    } else {
      // Already a slug key (mixed case during transition) — keep as-is.
      newIds[key] = eventId;
      if (links[key]) newLinks[key] = links[key];
    }
  }
  return { ids: newIds, links: newLinks };
}

/**
 * Hydrate a Firestore snapshot into a typed LegalCase, defaulting any missing
 * fields. Also self-heals legacy data:
 *   - Migrates calendarEventIds keyed by numeric index into slug-keyed format.
 *   - Dedupes deadlines that have the same (title, type), keeping the most
 *     recent FUTURE date (past-dated entries get dropped).
 *
 * Returns the hydrated case plus a `needsPersist` flag — when true, getCase
 * will write the cleaned version back to Firestore so the heal is permanent.
 */
function hydrateCase(
  id: string,
  d: Record<string, unknown>,
): { legalCase: LegalCase; needsPersist: boolean } {
  const rawDeadlines = (d.deadlines as CaseDeadline[]) ?? [];
  const deduped = dedupeDeadlines(rawDeadlines);
  const deadlines = deduped ?? rawDeadlines;
  const { ids: calendarEventIds, links: calendarEventLinks } = migrateCalendarMaps(
    d.calendarEventIds as Record<string, string> | undefined,
    d.calendarEventLinks as Record<string, string> | undefined,
    deadlines,
  );
  // needsPersist when dedupe actually changed anything. Migration of calendar
  // map keys is also a heal but it's idempotent on read so we don't need to
  // write it back unless dedupe also fired.
  const needsPersist = deduped !== null;
  const legalCase: LegalCase = {
    id,
    userId: (d.userId as string) ?? "",
    query: (d.query as string) ?? "",
    status: ((d.status as CaseStatus) ?? "gathering") as CaseStatus,
    createdAt: (d.createdAt as Timestamp) ?? Timestamp.now(),
    updatedAt: d.updatedAt as Timestamp | undefined,
    overview: (d.overview as CaseOverview) ?? null,
    analysis: (d.analysis as CaseAnalysis) ?? null,
    documents: (d.documents as CaseDocuments) ?? null,
    strategy: (d.strategy as CaseStrategy) ?? null,
    deadlines,
    calendarEventIds,
    calendarEventLinks,
    additionalInfo:
      (d.additionalInfo as LegalCase["additionalInfo"]) ?? {},
  };
  return { legalCase, needsPersist };
}

export class CaseService {
  constructor(private db: Firestore) {}

  /** Create a new case document with initial query. Returns the case ID. */
  async createCase(userId: string, userQuery: string): Promise<string> {
    const ref = doc(collection(this.db, "cases"));
    await setDoc(ref, {
      userId,
      query: userQuery,
      status: "gathering",
      createdAt: serverTimestamp(),
      overview: null,
      analysis: null,
      documents: null,
      strategy: null,
      deadlines: [],
      calendarEventIds: {},
      additionalInfo: {},
    });
    return ref.id;
  }

  /** Save the full structured result from the agent on a fresh case. */
  async saveResult(caseId: string, data: CaseResultPayload): Promise<void> {
    const ref = doc(this.db, "cases", caseId);
    await updateDoc(ref, {
      overview: data.overview,
      analysis: data.analysis,
      documents: data.documents,
      strategy: data.strategy,
      deadlines: data.deadlines ?? [],
      status: "ready",
    });
  }

  /**
   * Persist a fresh deadlines[] array directly. Used by the calendar sync flow
   * after the context extractor has computed the new list via applyDeadlineOps
   * — the frontend has already executed the corresponding Google Calendar
   * create/update/delete calls and we just need Firestore to mirror the result.
   */
  async setDeadlines(caseId: string, deadlines: CaseDeadline[]): Promise<void> {
    await updateDoc(doc(this.db, "cases", caseId), {
      deadlines,
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * REGENERATE-IN-PLACE: update a case with a new agent run after the user
   * added new context.
   *
   * **Replace semantics for deadlines:** the agent's `data.deadlines` IS the
   * new truth. We do NOT merge with the old list. The orchestrator's prompt
   * is responsible for preserving prior entries the user didn't contradict
   * AND for updating rescheduled entries in place (same title, new date).
   * The frontend trusts the agent's output verbatim. This is what makes the
   * "context should be concrete and changing" promise actually hold —
   * monotonic-add merges left stale entries on the calendar.
   *
   * **Preserve semantics for drafts:** documents the user has already drafted
   * keep their content (and the persisted Google Doc id/url). This is the
   * opposite policy because drafts are user-mutable artifacts — if the agent
   * regenerates a fresh "documents.needed" list, we layer prior drafts back
   * on top by title.
   */
  async updateResult(
    caseId: string,
    data: CaseResultPayload,
    options: { skipDeadlines?: boolean } = {},
  ): Promise<void> {
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error(`Case ${caseId} not found for update`);

    // Deadlines: REPLACE with the agent's new list verbatim. No merge.
    const newDeadlines: CaseDeadline[] = data.deadlines ?? [];

    // Documents: layer prior drafted content back onto the agent's new list.
    // We match by NORMALIZED title (lowercased, alphanumerics only) so trivial
    // wording drift between regenerates ("Demand Letter" → "Demand Letter to
    // Landlord") doesn't silently drop the user's existing draft + Google Doc.
    //
    // Drafts that don't match ANY entry in the agent's new list are still
    // preserved: we append them to the end of `needed` so the user never loses
    // a draft they explicitly created. They can re-draft with the new context
    // via the per-doc Regenerate button when ready.
    const normalize = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const draftLookup = new Map<
      string,
      {
        title: string;
        description: string;
        drafted: boolean;
        content: string | null;
        docId?: string;
        docUrl?: string;
      }
    >();
    for (const d of existing.documents?.needed ?? []) {
      if (d.drafted) {
        draftLookup.set(normalize(d.title), {
          title: d.title,
          description: d.description,
          drafted: true,
          content: d.content,
          docId: d.docId,
          docUrl: d.docUrl,
        });
      }
    }
    const usedDraftKeys = new Set<string>();
    const merged = data.documents.needed.map((d) => {
      const key = normalize(d.title);
      const prior = draftLookup.get(key);
      if (prior) {
        usedDraftKeys.add(key);
        // Keep the agent's fresh title/description but layer prior draft
        // content + Google Doc reference back on top.
        return {
          ...d,
          drafted: true,
          content: prior.content,
          ...(prior.docId ? { docId: prior.docId } : {}),
          ...(prior.docUrl ? { docUrl: prior.docUrl } : {}),
        };
      }
      return d;
    });
    // Append any orphaned prior drafts that the agent's new list didn't cover.
    // This is the "never silently lose a draft" guarantee.
    for (const [key, prior] of draftLookup.entries()) {
      if (usedDraftKeys.has(key)) continue;
      merged.push({
        title: prior.title,
        description: prior.description,
        drafted: true,
        content: prior.content,
        ...(prior.docId ? { docId: prior.docId } : {}),
        ...(prior.docUrl ? { docUrl: prior.docUrl } : {}),
      });
    }
    const mergedDocs: CaseDocuments = { needed: merged };

    // skipDeadlines: caller (the critical-change flow) has already written
    // canonical deadlines via the extractor's calendar ops. Don't let the
    // orchestrator overwrite them.
    const update: Record<string, unknown> = {
      overview: data.overview,
      analysis: data.analysis,
      documents: mergedDocs,
      strategy: data.strategy,
      status: "ready",
      updatedAt: serverTimestamp(),
    };
    if (!options.skipDeadlines) {
      update.deadlines = newDeadlines;
    }
    await updateDoc(doc(this.db, "cases", caseId), update);
  }

  /**
   * Get a case by ID. Self-heals legacy duplicate deadlines on read: if
   * `hydrateCase` deduplicated anything, the cleaned array is written back
   * to Firestore in the background (fire-and-forget) so the next read is
   * already clean. The UI never sees the dirty intermediate state.
   */
  async getCase(caseId: string): Promise<LegalCase | null> {
    const ref = doc(this.db, "cases", caseId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const { legalCase, needsPersist } = hydrateCase(snap.id, snap.data());
    if (needsPersist) {
      // Fire-and-forget — don't block the read on the write completing.
      // Worst case the next read repeats the same dedupe, idempotent.
      updateDoc(ref, { deadlines: legalCase.deadlines }).catch((e) => {
        console.error("Background dedupe persist failed:", e);
      });
    }
    return legalCase;
  }

  /** Get all cases for a user, sorted newest first. No composite index needed. */
  async getUserCases(userId: string, limitCount = 20): Promise<LegalCase[]> {
    const q = query(
      collection(this.db, "cases"),
      where("userId", "==", userId),
    );
    const snap = await getDocs(q);
    const cases = snap.docs.map((d) => {
      const { legalCase, needsPersist } = hydrateCase(d.id, d.data());
      if (needsPersist) {
        // Fire-and-forget background heal — same as getCase.
        updateDoc(doc(this.db, "cases", d.id), {
          deadlines: legalCase.deadlines,
        }).catch((e) => {
          console.error(`Background dedupe persist failed for case ${d.id}:`, e);
        });
      }
      return legalCase;
    });
    // Sort client-side: newest first
    cases.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
    return cases.slice(0, limitCount);
  }

  /** Mark a case as settled / won / lost / re-open to ready. */
  async markStatus(caseId: string, status: CaseStatus): Promise<void> {
    await updateDoc(doc(this.db, "cases", caseId), { status, updatedAt: serverTimestamp() });
  }

  /**
   * Persist the Google Calendar event ID + htmlLink returned after a
   * successful add. The key is a SLUG built from the deadline's (title, type)
   * — see `deadlineSlug` — so a rescheduled deadline updates the same entry
   * instead of creating a duplicate. Pre-Phase-6 cases used numeric-index
   * keys ("0", "1") which are migrated on read by `hydrateCase`.
   */
  async saveCalendarEventId(
    caseId: string,
    slug: string,
    eventId: string,
    htmlLink?: string,
  ): Promise<void> {
    const update: Record<string, string> = {
      [`calendarEventIds.${slug}`]: eventId,
    };
    if (htmlLink) {
      update[`calendarEventLinks.${slug}`] = htmlLink;
    }
    await updateDoc(doc(this.db, "cases", caseId), update);
  }

  /**
   * Remove a calendar event id+link mapping. Used when a deadline gets
   * dropped (cancelled, or no longer in the regenerated case state) so we
   * also clean up the local mapping after deleting the event from Calendar.
   */
  async removeCalendarEventId(caseId: string, slug: string): Promise<void> {
    // Firestore deleteField from the same package
    const { deleteField } = await import("firebase/firestore");
    await updateDoc(doc(this.db, "cases", caseId), {
      [`calendarEventIds.${slug}`]: deleteField(),
      [`calendarEventLinks.${slug}`]: deleteField(),
    });
  }

  /**
   * Update a specific document draft content. Optionally also persists the
   * Google Docs id + URL when the draft was synced to Drive (so the next
   * render can show "Open in Google Docs" instead of just "drafted").
   */
  async saveDraftContent(
    caseId: string,
    docIndex: number,
    content: string,
    googleDoc?: { docId: string; docUrl: string },
  ): Promise<void> {
    const legalCase = await this.getCase(caseId);
    if (!legalCase?.documents?.needed) return;
    const needed = [...legalCase.documents.needed];
    needed[docIndex] = {
      ...needed[docIndex],
      drafted: true,
      content,
      ...(googleDoc ? { docId: googleDoc.docId, docUrl: googleDoc.docUrl } : {}),
    };
    await updateDoc(doc(this.db, "cases", caseId), {
      "documents.needed": needed,
    });
  }

  /**
   * Append a new card to the case's `documents.needed` list. Used by the
   * conversational planner agent's `propose_new_document` tool — when the
   * user asks for a new letter/motion/memo, the planner queues this and
   * the frontend writes it directly to Firestore so it appears in the
   * Documents tab without waiting for an orchestrator regenerate.
   *
   * If a document with the same title already exists (case-insensitive,
   * normalized) the call is a no-op so the planner can be safely called
   * twice for the same title without creating duplicates.
   */
  async addProposedDocument(
    caseId: string,
    proposed: { title: string; description: string },
  ): Promise<void> {
    const existing = await this.getCase(caseId);
    if (!existing) throw new Error(`Case ${caseId} not found`);
    const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const key = normalize(proposed.title);
    const current = existing.documents?.needed ?? [];
    if (current.some((d) => normalize(d.title) === key)) {
      return; // already present — idempotent
    }
    const next: CaseDocuments = {
      needed: [
        ...current,
        {
          title: proposed.title,
          description: proposed.description,
          drafted: false,
          content: null,
        },
      ],
    };
    await updateDoc(doc(this.db, "cases", caseId), {
      "documents.needed": next.needed,
      updatedAt: serverTimestamp(),
    });
  }

  /** Add additional context to a case (legacy: free-text string). */
  async addContext(caseId: string, key: string, value: string): Promise<void> {
    await updateDoc(doc(this.db, "cases", caseId), {
      [`additionalInfo.${key}`]: value,
    });
  }

  /**
   * Add structured facts produced by the context extractor agent. Each fact
   * is stored as an object under a unique key so the orchestrator's
   * regenerate prompt sees the parsed view (kind + criticality + summary)
   * instead of an opaque blob. The legacy string format is still supported
   * by buildCaseContext for back-compat.
   */
  async addStructuredContext(
    caseId: string,
    facts: StructuredFact[],
  ): Promise<void> {
    if (!facts || facts.length === 0) return;
    const update: Record<string, StructuredFact> = {};
    const stamp = Date.now();
    facts.forEach((f, i) => {
      update[`additionalInfo.fact_${stamp}_${i}`] = f;
    });
    await updateDoc(doc(this.db, "cases", caseId), update);
  }

  /**
   * Wipe all additional context after a successful regenerate. The agent has
   * folded these facts into overview/analysis/strategy via the regeneration,
   * so they are no longer "pending context" that needs to ride forward into
   * the next prompt. Each round of (add context → regenerate) thus produces
   * a clean slate, preventing duplicate facts in the prompt across regens
   * and avoiding an unboundedly-growing additionalInfo map.
   */
  async clearAdditionalInfo(caseId: string): Promise<void> {
    await updateDoc(doc(this.db, "cases", caseId), {
      additionalInfo: {},
    });
  }


  /** Delete all cases for a user. */
  async deleteUserCases(userId: string): Promise<void> {
    const q = query(collection(this.db, "cases"), where("userId", "==", userId));
    const snap = await getDocs(q);
    const batch = writeBatch(this.db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  /** Delete a single case. */
  async deleteCase(caseId: string): Promise<void> {
    await deleteDoc(doc(this.db, "cases", caseId));
  }

  /**
   * Build a full context string for the agent from a case.
   * This is the "case.md" — everything the agent needs to know
   * when handling any request about this case (drafting, strategy, etc).
   */
  buildCaseContext(legalCase: LegalCase): string {
    const lines: string[] = [];
    lines.push(`# Case Context`);
    lines.push(`## Original Problem`);
    lines.push(legalCase.query);
    lines.push("");

    if (legalCase.overview) {
      const ov = legalCase.overview;
      lines.push(`## Issue Detected`);
      lines.push(ov.issueDetected);
      lines.push("");
      lines.push(`## User Rights`);
      ov.rights.forEach((r) => lines.push(`- ${r}`));
      lines.push("");
      lines.push(`## Relevant Cases Found`);
      ov.relevantCases.forEach((c) => {
        lines.push(`- ${c.name} (${c.court}, ${c.year}) — ${c.summary}`);
        lines.push(`  URL: ${c.url}`);
        lines.push(`  Relevance: ${c.relevance}`);
      });
      lines.push("");
      lines.push(`Urgency: ${ov.urgency}`);
      lines.push(`Confidence: ${ov.confidence} — ${ov.confidenceReason}`);
      lines.push("");
    }

    if (legalCase.analysis) {
      const an = legalCase.analysis;
      lines.push(`## Case Analysis`);
      lines.push(`Win Probability: ${an.winProbability}%`);
      lines.push(`Strengths: ${an.strengths.join("; ")}`);
      lines.push(`Weaknesses: ${an.weaknesses.join("; ")}`);
      lines.push(`Key Factors: ${an.keyFactors.join("; ")}`);
      lines.push("");
    }

    if (legalCase.strategy) {
      lines.push(`## Strategy`);
      lines.push(`Recommendation: ${legalCase.strategy.recommendation}`);
      legalCase.strategy.options.forEach((o) => {
        lines.push(`- ${o.title}: ${o.description} (Cost: ${o.estimatedCost}, Time: ${o.estimatedTime})`);
      });
      lines.push("");
    }

    if (legalCase.documents?.needed) {
      lines.push(`## Documents Needed`);
      legalCase.documents.needed.forEach((d) => {
        lines.push(`- ${d.title}: ${d.description} (Drafted: ${d.drafted ? "Yes" : "No"})`);
      });
      lines.push("");
    }

    if (legalCase.deadlines && legalCase.deadlines.length > 0) {
      lines.push(`## Deadlines / Important Dates`);
      legalCase.deadlines.forEach((d) => {
        lines.push(`- ${d.title} (${d.type}, urgency: ${d.urgency}) — ${d.dateIso} — ${d.description}`);
      });
      lines.push("");
    }

    const info = legalCase.additionalInfo;
    if (info && Object.keys(info).length > 0) {
      // Header phrasing matters: this is consumed by the orchestrator's
      // prompt during regeneration. "Additional Facts From The User" frames
      // these as case facts to be folded into the analysis, not as a separate
      // section to surface back to the UI.
      lines.push(`## Additional Facts From The User`);
      Object.entries(info).forEach(([, val]) => {
        if (typeof val === "string") {
          // Legacy free-text entry — pre-extractor "Add Context" path.
          lines.push(`- ${val}`);
        } else if (val && typeof val === "object") {
          // Structured fact from the context extractor agent.
          lines.push(
            `- [${val.kind}, criticality: ${val.criticality}] ${val.summary}`,
          );
        }
      });
      lines.push("");
    }

    lines.push(`## Status`);
    lines.push(`Current status: ${legalCase.status}`);

    return lines.join("\n");
  }
}
