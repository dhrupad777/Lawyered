import type { CaseDeadline } from "@/lib/models/case";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Returned when an event is successfully created or updated. */
export interface CreatedCalendarEvent {
  id: string;
  htmlLink: string;
}

/** Distinct error class so callers can react to expired-token specifically. */
export class CalendarAuthExpiredError extends Error {
  constructor() {
    super("Calendar access token expired. Please sign in again to refresh access.");
    this.name = "CalendarAuthExpiredError";
  }
}

/** Internal: shared error handling for any Calendar API call. */
async function calendarFetch(
  url: string,
  accessToken: string,
  init: RequestInit,
  contextLabel: string,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new CalendarAuthExpiredError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Calendar API error [${contextLabel}]`, res.status, body);
    if (init.body) {
      console.error(`Calendar API request body was:`, init.body);
    }
    throw new Error(`Calendar API error ${res.status}: ${body.slice(0, 240)}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

/**
 * Browser-side Google Calendar client.
 *
 * We call the Calendar API directly from the browser using the user's OAuth
 * access token (captured at signin via Firebase's GoogleAuthProvider). This
 * avoids server-side token plumbing and uses Google's CORS-enabled REST API
 * the way it was designed to be used from a SPA.
 *
 * For every event we create, we set extendedProperties.private.lawyered_case_id
 * so we can later look up "all events Lawyered created for this case." This
 * is the official Google-recommended pattern for app-namespaced metadata.
 */
export class CalendarService {
  /**
   * Build the request body for an events.insert / events.update call.
   * Shared between create and update so both paths produce identical events.
   */
  private buildEventBody(
    caseId: string,
    deadline: CaseDeadline,
    docLinks: Array<{ title: string; url: string }>,
  ): Record<string, unknown> {
    const start = new Date(deadline.dateIso);
    if (isNaN(start.getTime())) {
      throw new Error(`Invalid deadline date: ${deadline.dateIso}`);
    }
    const durationMs =
      (deadline.durationMinutes && deadline.durationMinutes > 0
        ? deadline.durationMinutes
        : deadline.type === "hearing"
        ? 60
        : 30) * 60 * 1000;
    const end = new Date(start.getTime() + durationMs);

    const docsSection =
      docLinks.length > 0
        ? `\n📄 Your prepared documents:\n${docLinks
            .map((d) => `• ${d.title} — ${d.url}`)
            .join("\n")}\n`
        : "";

    // Resolve the user's IANA timezone (e.g. "America/Los_Angeles") so we can
    // send it alongside the dateTime. Without `timeZone`, Calendar's events.insert
    // sometimes responds with a 500 instead of a saner error — providing the
    // explicit timezone is the documented best practice.
    const userTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    return {
      summary: `[Lawyered] ${deadline.title}`,
      description:
        `${deadline.description}\n\n` +
        `Type: ${deadline.type}\n` +
        `Urgency: ${deadline.urgency}\n` +
        docsSection +
        `\nCreated by Lawyered — your AI legal intelligence assistant.`,
      start: { dateTime: start.toISOString(), timeZone: userTimeZone },
      end: { dateTime: end.toISOString(), timeZone: userTimeZone },
      reminders: {
        useDefault: false,
        overrides:
          deadline.urgency === "high"
            ? [
                { method: "popup", minutes: 60 * 24 * 7 }, // 1 week before
                { method: "popup", minutes: 60 * 24 }, // 1 day before
                { method: "popup", minutes: 60 }, // 1 hour before
              ]
            : [
                { method: "popup", minutes: 60 * 24 * 3 }, // 3 days before
                { method: "popup", minutes: 60 * 24 }, // 1 day before
              ],
      },
      extendedProperties: {
        private: {
          lawyered_case_id: caseId,
          lawyered_deadline_type: deadline.type,
          lawyered_urgency: deadline.urgency,
        },
      },
    };
  }

  /**
   * Create a new Calendar event for a deadline. Use when no eventId exists yet.
   * Throws CalendarAuthExpiredError on 401 so the UI can prompt re-signin.
   */
  async createEventForDeadline(
    accessToken: string,
    caseId: string,
    deadline: CaseDeadline,
    docLinks: Array<{ title: string; url: string }> = [],
  ): Promise<CreatedCalendarEvent> {
    const body = this.buildEventBody(caseId, deadline, docLinks);
    const data = (await calendarFetch(
      CALENDAR_BASE,
      accessToken,
      { method: "POST", body: JSON.stringify(body) },
      "events.insert",
    )) as { id: string; htmlLink: string };
    return { id: data.id, htmlLink: data.htmlLink };
  }

  /**
   * Update an existing Calendar event in place. Used by the bulk "Update Calendar"
   * sync to push fresh deadline metadata + new doc links into events that were
   * previously created. Returns the same event id (and a fresh htmlLink in case
   * the user's primary calendar has changed).
   */
  async updateEventForDeadline(
    accessToken: string,
    eventId: string,
    caseId: string,
    deadline: CaseDeadline,
    docLinks: Array<{ title: string; url: string }> = [],
  ): Promise<CreatedCalendarEvent> {
    const body = this.buildEventBody(caseId, deadline, docLinks);
    const url = `${CALENDAR_BASE}/${encodeURIComponent(eventId)}`;
    const data = (await calendarFetch(
      url,
      accessToken,
      { method: "PUT", body: JSON.stringify(body) },
      "events.update",
    )) as { id: string; htmlLink: string };
    return { id: data.id, htmlLink: data.htmlLink };
  }

  /**
   * Self-healing helper: fetch an existing event by id to recover its `htmlLink`.
   * Used during the bulk sync for events created in earlier versions of Lawyered
   * (before we started saving htmlLink alongside the event id). Returns null if
   * the event no longer exists in the user's calendar (404).
   */
  async getEventHtmlLink(accessToken: string, eventId: string): Promise<string | null> {
    const url = `${CALENDAR_BASE}/${encodeURIComponent(eventId)}`;
    try {
      const data = (await calendarFetch(
        url,
        accessToken,
        { method: "GET" },
        "events.get",
      )) as { htmlLink?: string };
      return data.htmlLink ?? null;
    } catch (e) {
      // 404 = event was deleted from Calendar by the user; treat as orphaned.
      if (e instanceof Error && /404/.test(e.message)) return null;
      throw e;
    }
  }

  /**
   * Delete an event from the user's primary calendar. Used when a deadline
   * gets dropped (cancelled or rescheduled-into-a-different-event) so the
   * old calendar entry doesn't sit there as an orphan. 404 is treated as
   * success — the event is already gone, which is what we wanted.
   */
  async deleteEvent(accessToken: string, eventId: string): Promise<void> {
    const url = `${CALENDAR_BASE}/${encodeURIComponent(eventId)}`;
    try {
      await calendarFetch(
        url,
        accessToken,
        { method: "DELETE" },
        "events.delete",
      );
    } catch (e) {
      if (e instanceof Error && /404/.test(e.message)) return; // already gone
      throw e;
    }
  }

  /**
   * List ALL events Lawyered has ever created for a given case, regardless
   * of whether Firestore still has the mapping. Used by the orphan-reconciliation
   * pass during Update Calendar — when a deadline gets dropped from the case
   * (cancelled, rescheduled with a different title, etc.) we need a way to
   * find and delete the corresponding Calendar event even if our Firestore
   * `calendarEventIds` map no longer references it.
   *
   * Filters via `privateExtendedProperty=lawyered_case_id=<caseId>` — this
   * is the official Drive/Calendar pattern for app-namespaced metadata, set
   * by `createEventForDeadline` on every event we create.
   *
   * Returns an array of `{ id, summary, htmlLink }`. Returns [] on failure
   * because reconciliation failure shouldn't break the main sync.
   */
  async listLawyeredEventsForCase(
    accessToken: string,
    caseId: string,
  ): Promise<Array<{ id: string; summary: string; htmlLink: string }>> {
    // Calendar events.list supports `privateExtendedProperty=KEY=VALUE` as a query string filter.
    const params = new URLSearchParams();
    params.set("privateExtendedProperty", `lawyered_case_id=${caseId}`);
    params.set("maxResults", "100");
    params.set("singleEvents", "true");
    const url = `${CALENDAR_BASE}?${params.toString()}`;
    try {
      const data = (await calendarFetch(
        url,
        accessToken,
        { method: "GET" },
        "events.list",
      )) as { items?: Array<{ id: string; summary?: string; htmlLink?: string }> };
      return (data.items ?? []).map((it) => ({
        id: it.id,
        summary: it.summary ?? "",
        htmlLink: it.htmlLink ?? "",
      }));
    } catch (e) {
      console.error("Calendar events.list failed during reconciliation:", e);
      return [];
    }
  }
}
