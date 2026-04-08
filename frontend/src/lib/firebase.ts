import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBYBjSJk1a4Ba2oblumDqQOICbcr_0I1cM",
  authDomain: "lawyered-b0971.firebaseapp.com",
  projectId: "lawyered-b0971",
  storageBucket: "lawyered-b0971.firebasestorage.app",
  messagingSenderId: "201079023050",
  appId: "1:201079023050:web:35ad64afa75d2c4636db33",
  measurementId: "G-J411PKG7DC",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app, "lawyered");
export const googleProvider = new GoogleAuthProvider();
