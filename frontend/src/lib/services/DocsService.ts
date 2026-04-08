/**
 * Browser-side Google Docs + Drive client.
 *
 * Why browser-side: the user's OAuth access token lives in the browser
 * (captured at sign-in via Firebase's GoogleAuthProvider). Calling Google's
 * REST APIs directly from here avoids server-side token plumbing and uses
 * the same CORS-enabled browser path as CalendarService.
 *
 * Two APIs cooperate:
 *
 *   - Drive API v3 (https://www.googleapis.com/drive/v3/files)
 *       Used to CREATE the Doc. Drive owns the "files" namespace; a Doc is
 *       just a Drive file with mimeType `application/vnd.google-apps.document`.
 *       We tag every created Doc with extendedProperties.private.lawyered_case_id
 *       so we can later list "all docs Lawyered created for this case".
 *
 *   - Docs API v1 (https://docs.googleapis.com/v1/documents/{id}:batchUpdate)
 *       Used to write CONTENT into the empty Doc that Drive returned, and to
 *       REPLACE content on regenerate.
 *
 * Token expiry: Google OAuth access tokens are ~1 hour. On 401, throw
 * DocsAuthExpiredError so the UI can prompt re-signin (same pattern as
 * CalendarService).
 *
 * Scope requirements (configured in AuthProvider):
 *   - https://www.googleapis.com/auth/documents      (read/write Docs we own)
 *   - https://www.googleapis.com/auth/drive.file     (per-file Drive access)
 */

const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";
const DOCS_BATCH_UPDATE = (docId: string) =>
  `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`;
const DOCS_GET = (docId: string) =>
  `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`;

export interface CreatedGoogleDoc {
  /** Drive/Docs file id */
  docId: string;
  /** Human URL the user can open in their browser */
  docUrl: string;
}

/** Distinct error class so callers can react to expired-token specifically. */
export class DocsAuthExpiredError extends Error {
  constructor() {
    super(
      "Google Docs access token expired. Please sign in again to refresh access.",
    );
    this.name = "DocsAuthExpiredError";
  }
}

function buildDocUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

/** Internal helper for any Drive/Docs request that returns JSON. */
async function googleApiFetch(
  url: string,
  accessToken: string,
  init: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new DocsAuthExpiredError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google API error ${res.status}: ${body.slice(0, 240)}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

export class DocsService {
  /**
   * Create a new Google Doc with the given title and body content. Tags the
   * Doc with extendedProperties.private.lawyered_case_id so it can be looked
   * up later. Two-step process:
   *
   *   1. POST drive.files  → creates an empty Doc, returns docId
   *   2. POST docs.documents:batchUpdate with insertText → fills in body
   */
  async createDoc(
    accessToken: string,
    caseId: string,
    title: string,
    content: string,
  ): Promise<CreatedGoogleDoc> {
    // ── Step 1: create the empty Doc via Drive ──
    const createRes = (await googleApiFetch(DRIVE_FILES_API, accessToken, {
      method: "POST",
      body: JSON.stringify({
        name: `[Lawyered] ${title}`,
        mimeType: "application/vnd.google-apps.document",
        appProperties: {
          // appProperties is the per-app private metadata namespace.
          // It's only visible to the app that wrote it.
          lawyered_case_id: caseId,
          lawyered_doc_title: title,
        },
      }),
    })) as { id?: string };

    const docId = createRes.id;
    if (!docId) throw new Error("Drive API did not return a file id");

    // ── Step 2: insert the content via Docs batchUpdate ──
    // The Doc starts empty; insertText at index 1 prepends from the very start.
    await googleApiFetch(DOCS_BATCH_UPDATE(docId), accessToken, {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: content,
            },
          },
        ],
      }),
    });

    return { docId, docUrl: buildDocUrl(docId) };
  }

  /**
   * Replace the entire content of an existing Doc with new content.
   *
   * The Docs API requires us to know the current end-of-body index before we
   * can delete and re-insert. We GET the doc to read its body, compute the
   * range, then issue a single batchUpdate with two requests:
   *   (a) deleteContentRange from index 1 to end-1
   *   (b) insertText at index 1 with the new content
   *
   * Note: index 1 is the start of the body (index 0 is reserved). The body's
   * endIndex points one past the trailing newline; we use endIndex - 1 so we
   * don't try to delete the implicit final newline (which Docs disallows).
   */
  async replaceDocContent(
    accessToken: string,
    docId: string,
    newContent: string,
  ): Promise<CreatedGoogleDoc> {
    // Read current doc to find the end-of-body index
    const docResp = (await googleApiFetch(DOCS_GET(docId), accessToken, {
      method: "GET",
    })) as { body?: { content?: Array<{ endIndex?: number }> } };

    const segments = docResp.body?.content ?? [];
    const lastEndIndex = segments.reduce((acc, seg) => {
      const e = seg.endIndex ?? 0;
      return e > acc ? e : acc;
    }, 1);

    // Body range to delete: [1, endIndex - 1). If the doc is already empty
    // (endIndex <= 2), skip the delete request entirely.
    const requests: Array<Record<string, unknown>> = [];
    if (lastEndIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: lastEndIndex - 1 },
        },
      });
    }
    requests.push({
      insertText: { location: { index: 1 }, text: newContent },
    });

    await googleApiFetch(DOCS_BATCH_UPDATE(docId), accessToken, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });

    return { docId, docUrl: buildDocUrl(docId) };
  }
}
