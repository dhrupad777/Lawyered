import { db } from "@/lib/firebase";
import { UserService } from "./UserService";
import { SessionService } from "./SessionService";
import { CaseService } from "./CaseService";
import { CalendarService } from "./CalendarService";
import { DocsService } from "./DocsService";

/** Singleton service instances — injected with Firestore client */
export const userService = new UserService(db);
export const sessionService = new SessionService(db);
export const caseService = new CaseService(db);
export const calendarService = new CalendarService();
export const docsService = new DocsService();

export { UserService } from "./UserService";
export { SessionService } from "./SessionService";
export { CaseService, deadlineSlug, applyDeadlineOps } from "./CaseService";
export type { CalendarOp, StructuredFact } from "./CaseService";
export { CalendarService, CalendarAuthExpiredError } from "./CalendarService";
export { DocsService, DocsAuthExpiredError } from "./DocsService";
