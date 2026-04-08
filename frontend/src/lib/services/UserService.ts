import {
  type Firestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { type UserProfile, userConverter } from "@/lib/models";

export class UserService {
  constructor(private db: Firestore) {}

  /**
   * Creates a new user profile or updates lastLoginAt for returning users.
   * Uses a Firestore transaction for atomicity (ACID).
   */
  async createOrUpdateProfile(firebaseUser: User): Promise<UserProfile> {
    const rawRef = doc(this.db, "users", firebaseUser.uid);
    const typedRef = rawRef.withConverter(userConverter);

    return runTransaction(this.db, async (tx) => {
      const snapshot = await tx.get(typedRef);

      if (!snapshot.exists()) {
        // New user — create full profile (use raw ref to avoid converter type mismatch)
        tx.set(rawRef, {
          email: firebaseUser.email ?? "",
          displayName: firebaseUser.displayName ?? "",
          photoURL: firebaseUser.photoURL ?? null,
          createdAt: serverTimestamp(),
          lastLoginAt: serverTimestamp(),
        });

        return {
          uid: firebaseUser.uid,
          email: firebaseUser.email ?? "",
          displayName: firebaseUser.displayName ?? "",
          photoURL: firebaseUser.photoURL ?? null,
          createdAt: Timestamp.now(),
          lastLoginAt: Timestamp.now(),
        };
      }

      // Returning user — refresh photo + lastLoginAt only.
      // Never overwrite the stored displayName (user may have edited it).
      const update: Record<string, unknown> = { lastLoginAt: serverTimestamp() };
      if (firebaseUser.photoURL) update.photoURL = firebaseUser.photoURL;
      tx.update(rawRef, update);

      const existing = snapshot.data()!;
      return existing;
    });
  }

  /**
   * Retrieves a user profile by UID. Returns null if not found.
   */
  async getProfile(uid: string): Promise<UserProfile | null> {
    const ref = doc(this.db, "users", uid).withConverter(userConverter);
    const snapshot = await getDoc(ref);
    return snapshot.exists() ? snapshot.data() : null;
  }
}
