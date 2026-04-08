import {
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
  Timestamp,
} from "firebase/firestore";

export type SessionMode = "consumer" | "professional";
export type SessionStatus = "active" | "completed" | "error";

export interface ResearchSession {
  id: string;
  userId: string;
  query: string;
  mode: SessionMode;
  status: SessionStatus;
  createdAt: Timestamp;
}

export const sessionConverter: FirestoreDataConverter<ResearchSession> = {
  toFirestore(session: ResearchSession): DocumentData {
    const { id: _id, ...data } = session;
    return data;
  },
  fromFirestore(
    snapshot: QueryDocumentSnapshot,
    options?: SnapshotOptions,
  ): ResearchSession {
    const data = snapshot.data(options);
    return {
      id: snapshot.id,
      userId: data.userId ?? "",
      query: data.query ?? "",
      mode: data.mode ?? "consumer",
      status: data.status ?? "active",
      createdAt: data.createdAt ?? Timestamp.now(),
    };
  },
};
