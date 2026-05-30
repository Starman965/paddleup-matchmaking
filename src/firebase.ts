import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as analyticsIsSupported } from "firebase/analytics";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDcYIHguD40ELnq0r-js2FiQcsPvcQP6JE",
  authDomain: "paddleup-match-maker.firebaseapp.com",
  projectId: "paddleup-match-maker",
  storageBucket: "paddleup-match-maker.firebasestorage.app",
  messagingSenderId: "888824877047",
  appId: "1:888824877047:web:3732869314e24fc006e8f2",
  measurementId: "G-WFWZ3NZWCF"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

export function initializeAnalytics() {
  if (typeof window === "undefined") return;

  analyticsIsSupported()
    .then((supported) => {
      if (supported) getAnalytics(app);
    })
    .catch(() => undefined);
}
