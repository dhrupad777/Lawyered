import {
  type Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  limit as firestoreLimit,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import {
  type ResearchSession,
  type SessionMode,
  type SessionStatus,
  sessionConverter,
} from "@/lib/models";

export class SessionService {
  constructor(private db: Firestore) {}

  /**
   * Creates a new research session. Uses a transaction to verify
   * the user exists before creating (referential integrity).
   */
  async createSession(
    userId: string,
    userQuery: string,
    mode: SessionMode,
  ): Promise<ResearchSession> {
    const userRef = doc(this.db, "users", userId);
    const sessionsCol = collection(this.db, "sessions");

    return runTransaction(this.db, async (tx) => {
      // Verify user exists (referential integrity)
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists()) {
        throw new Error(`User ${userId} does not exist`);
      }

      // Create session document
      const sessionData = {
        userId,
        query: userQuery,
        mode,
        status: "active" as SessionStatus,
        createdAt: serverTimestamp(),
      };

      // addDoc can't be used inside transactions, so create a doc ref first
      const newRef = doc(sessionsCol);
      tx.set(newRef, sessionData);

      return {
        id: newRef.id,
        ...sessionData,
        createdAt: { seconds: Date.now() / 1000, nanoseconds: 0 },
      } as unknown as ResearchSession;
    });
  }

  /**
   * Gets all sessions for a user, ordered by most recent first.
   */
  async getUserSessions(
    userId: string,
    limitCount: number = 20,
  ): Promise<ResearchSession[]> {
    const q = query(
      collection(this.db, "sessions").withConverter(sessionConverter),
      where("userId", "==", userId),
    );
    const snapshot = await getDocs(q);
    const results = snapshot.docs.map((d) => d.data());
    results.sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));
    return results.slice(0, limitCount);
  }

  /**
   * Updates the status of a session (e.g., active → completed).
   */
  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    const ref = doc(this.db, "sessions", sessionId);
    await updateDoc(ref, { status });
  }
}
