// Firebase settings for accounts ("Sign in with Google", Settings page).
// null = accounts are switched OFF and the site works exactly as before (everything saved in the browser only).
// To switch them on, paste the config from the Firebase console (Project settings > Your apps > Web app > Config):
//   window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };
// These values are not secrets: every Firebase website ships them. The security rules (firestore.rules) protect the data.
window.FIREBASE_CONFIG = null;
