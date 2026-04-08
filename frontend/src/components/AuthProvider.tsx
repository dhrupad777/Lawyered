"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { type UserProfile } from "@/lib/models";
import { userService } from "@/lib/services";

/**
 * Google OAuth scopes — kept narrow on purpose so the consent screen reads
 * cleanly and the user understands exactly what Lawyered will touch.
 *
 * - calendar.events  : create & update events on the user's primary calendar
 * - documents        : create & update Google Docs we own
 * - drive.file       : per-file Drive scope. Lets us CREATE files in the
 *                      user's Drive and read/update only files we created.
 *                      Critically, this does NOT grant access to the user's
 *                      existing Drive content. This is the principle-of-least-
 *                      privilege answer for "create a file in your Drive."
 *
 * https://developers.google.com/identity/protocols/oauth2/scopes
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
];

/** sessionStorage key — ephemeral on purpose. Bearer tokens never go in localStorage. */
const TOKEN_STORAGE_KEY = "lawyered_google_access_token";

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  /** OAuth access token with calendar.events scope. ~1 hour TTL. May be null. */
  googleAccessToken: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  profile: null,
  loading: true,
  googleAccessToken: null,
  signIn: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  // Lazy initializer: rehydrate the token from sessionStorage exactly once on
  // first render. SSR-safe (returns null on the server). Avoids the
  // setState-in-effect anti-pattern that React's strict mode warns about.
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  });

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          setProfile(await userService.createOrUpdateProfile(u));
        } catch (e) {
          console.error("Profile sync failed:", e);
        }
      } else {
        setProfile(null);
        setGoogleAccessToken(null);
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        }
      }
      setLoading(false);
    });
  }, []);

  const signIn = async () => {
    const provider = new GoogleAuthProvider();
    SCOPES.forEach((scope) => provider.addScope(scope));
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await signInWithPopup(auth, provider);
    // GoogleAuthProvider.credentialFromResult returns the OAuth credential
    // which contains the short-lived access token we need for Calendar API.
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken ?? null;
    if (token) {
      setGoogleAccessToken(token);
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
    }
  };

  const signOut = async () => {
    setGoogleAccessToken(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
    await fbSignOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, googleAccessToken, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
