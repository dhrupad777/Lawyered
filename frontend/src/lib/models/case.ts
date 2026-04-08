import { Timestamp } from "firebase/firestore";

export interface CaseReference {
  name: string;
  court: string;
  year: string;
  url: string;
  summary: string;
  relevance: string;
}

export interface DocumentIdea {
  title: string;
  description: string;
  drafted: boolean;
  content: string | null;
  /** Google Docs document id, if a Doc has been created for this draft. */
  docId?: string;
  /** Public URL to open the Google Doc in a browser. */
  docUrl?: string;
}

export interface StrategyOption {
  title: string;
  description: string;
  pros: string[];
  cons: string[];
  estimatedCost: string;
  estimatedTime: string;
}

export interface CaseOverview {
  issueDetected: string;
  rights: string[];
  relevantCases: CaseReference[];
  urgency: "URGENT" | "MODERATE" | "LOW RISK";
  confidence: "High" | "Medium" | "Low";
  confidenceReason: string;
}

export interface CaseAnalysis {
  strengths: string[];
  weaknesses: string[];
  winProbability: number;
  keyFactors: string[];
}

export interface CaseDocuments {
  needed: DocumentIdea[];
}

export interface CaseStrategy {
  options: StrategyOption[];
  recommendation: string;
}

/**
 * A time-sensitive item the user can add to their Google Calendar.
 * Produced by the orchestrator (or manually entered by the user).
 */
export interface CaseDeadline {
  title: string;
  description: string;
  /** ISO-8601 datetime, e.g. "2026-04-22T09:00:00" */
  dateIso: string;
  durationMinutes: number;
  type: "hearing" | "deadline" | "filing" | "other";
  urgency: "high" | "medium" | "low";
}

/**
 * Lifecycle:
 *  - gathering : multi-agent run is in progress
 *  - ready     : initial case JSON has been written
 *  - error     : the run failed
 *  - settled   : user resolved the matter (paid out, agreed)
 *  - won       : user prevailed
 *  - lost      : user did not prevail
 *
 * The closed states (settled/won/lost) are labels — features remain
 * available, history page filters and badges them.
 */
export type CaseStatus = "gathering" | "ready" | "error" | "settled" | "won" | "lost";

export interface LegalCase {
  id: string;
  userId: string;
  query: string;
  status: CaseStatus;
  createdAt: Timestamp;
  /** Set whenever a regenerate-with-context run completes. */
  updatedAt?: Timestamp;
  overview: CaseOverview | null;
  analysis: CaseAnalysis | null;
  documents: CaseDocuments | null;
  strategy: CaseStrategy | null;
  /** New: time-sensitive items the agent extracted (or user added). */
  deadlines: CaseDeadline[];
  /**
   * Map from deadline-array-index to the Google Calendar event ID returned
   * after a successful "Add to Calendar" call. Indexed by stringified number
   * because Firestore doesn't allow numeric keys.
   */
  calendarEventIds: Record<string, string>;
  /**
   * Parallel map: deadline-array-index → the Google-issued `htmlLink` for the
   * created event. Used by the "View in Calendar" button. The htmlLink format
   * (like `www.google.com/calendar/event?eid=...`) opens a clean view; the old
   * `eventedit/{id}` URL opens the edit dialog which is jarring.
   */
  calendarEventLinks?: Record<string, string>;
  /**
   * Additional context the user has supplied since the last regenerate.
   * Values may be plain strings (legacy free-text "Add Context" path) OR
   * structured fact objects emitted by the context extractor agent
   * (`{ kind, summary, criticality }`). buildCaseContext renders both
   * shapes. Cleared on successful regenerate via clearAdditionalInfo.
   */
  additionalInfo: Record<string, string | { kind: string; summary: string; criticality: string }>;
}
