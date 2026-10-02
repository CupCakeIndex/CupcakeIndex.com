// Accounts: "Sign in with Google" (Firebase), so Pick'em, the daily game and your fantasy team follow you to any device.
// OFF until firebase-config.js has a config; then the Settings page shows an Account section.
// What syncs: the same browser storage the site already uses (SYNCED below). We never see a password (Google
// handles sign-in) and keep only a user id, a first name and that game data, in Firestore at users/<uid>.
const Account = (() => {
  const CFG = window.FIREBASE_CONFIG;
  const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  const SYNCED = (k) => /^pickem-/.test(k) || k === "daily-nfl" || k === "daily-nfl-stats" || k === "fantasy-team";
  let fb = null, user = null, status = "", timer = null, ready = null;

  const enabled = () => !!(CFG && CFG.apiKey && CFG.projectId);
  const load = (src) => new Promise((ok, bad) => { const s = document.createElement("script"); s.src = SDK + src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });

  function start() {
    if (!enabled() || ready) return ready;
    ready = (async () => {
      await load("firebase-app-compat.js");
      await Promise.all([load("firebase-auth-compat.js"), load("firebase-firestore-compat.js")]);
      fb = firebase.initializeApp(CFG);
      fb.auth().getRedirectResult().catch((e) => setStatus(friendly(e)));
      fb.auth().onAuthStateChanged((u) => {
        const was = user;
        // leaving a guest account (signed out, or switched): put the device's main account's data back
        if (was && (!u || u.uid !== was.uid) && guestId() === was.uid) restoreOwner();
        user = u;
        badge();
        rerender(); // show signed in/out right away; the first sync runs in the background
        if (u) {
          if (!was) toast(`Signed in as ${u.displayName || u.email || "you"}`);
          const owner = ownerId();
          if (!owner || owner === u.uid) { setOwner(u.uid); syncDown(); } // the device's main account: merge
          else { if (guestId() !== u.uid) becomeGuest(u.uid); syncDown(); } // another account: only its own data
        }
      });
      // save to the account a few seconds after any synced change (picks, daily game, fantasy team)
      const orig = store.set;
      store.set = (k, v) => { orig(k, v); if (user && SYNCED(k)) { clearTimeout(timer); timer = setTimeout(syncUp, 2500); } };
    })().catch((e) => { setStatus("Accounts couldn't load. Check your connection and refresh."); console.warn(e); });
    return ready;
  }

  const doc = () => fb.firestore().collection("users").doc(user.uid);
  function localData() {
    const out = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (SYNCED(k)) out[k] = localStorage.getItem(k); } } catch (e) {}
    return out;
  }
  const parse = (s) => { try { let v = JSON.parse(s); if (typeof v === "string") v = JSON.parse(v); return v; } catch (e) { return null; } };
  // Two copies of the same item (this device vs the account): keep everything from both.
  function merge(k, a, b) {
    const A = parse(a), B = parse(b);
    if (k === "daily-nfl-stats") return (A?.played || 0) >= (B?.played || 0) ? a : b; // the one with more games played
    if (k === "daily-nfl") return (A?.guesses?.length || 0) >= (B?.guesses?.length || 0) ? a : b;
    if (A && B && typeof A === "object" && typeof B === "object" && !Array.isArray(A)) {
      const m = { ...B, ...A }; // this device wins a tie
      return typeof JSON.parse(a) === "string" ? JSON.stringify(JSON.stringify(m)) : JSON.stringify(m);
    }
    return a;
  }

  // Which account this device's own data belongs to: the first one to sign in here. Anyone else is a guest:
  // the main account's data is set aside while they're signed in and comes back when they sign out.
  const OWNER = "acct-owner", GUEST = "acct-guest", STASH = "acct-stash";
  const ls = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  const ownerId = () => ls(OWNER), guestId = () => ls(GUEST), setOwner = (id) => lsSet(OWNER, id);
  function clearSynced() { for (const k of Object.keys(localData())) lsSet(k, null); }
  function becomeGuest(uid) {
    if (!ls(STASH)) lsSet(STASH, JSON.stringify(localData())); // set the main account's data aside
    clearSynced();
    lsSet(GUEST, uid);
  }
  function restoreOwner() {
    clearSynced(); // the guest's data is safe in their account
    let saved = {};
    try { saved = JSON.parse(ls(STASH) || "{}"); } catch (e) {}
    for (const [k, v] of Object.entries(saved)) lsSet(k, v);
    lsSet(STASH, null); lsSet(GUEST, null);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  async function syncDown() {
    setStatus("Syncing…");
    try {
      const snap = await doc().get();
      const remote = (snap.exists && snap.data().data) || {}, local = localData(), all = { ...remote };
      // main account: this device's picks merge in. A guest's device copy was cleared first, so only their own data is here.
      for (const [k, v] of Object.entries(local)) all[k] = k in remote ? merge(k, v, remote[k]) : v;
      for (const [k, v] of Object.entries(all)) { try { localStorage.setItem(k, v); } catch (e) {} }
      await doc().set({ name: (user.displayName || "").split(" ")[0], data: all, updated: new Date().toISOString() });
      setStatus("Saved to your account.");
      window.dispatchEvent(new HashChangeEvent("hashchange")); // redraw the page with the merged data
    } catch (e) { setStatus(friendly(e)); }
  }
  async function syncUp() {
    if (!user) return;
    try { await doc().set({ name: (user.displayName || "").split(" ")[0], data: localData(), updated: new Date().toISOString() }); setStatus("Saved to your account."); }
    catch (e) { setStatus(friendly(e)); }
  }

  async function signIn() {
    await start();
    const p = new firebase.auth.GoogleAuthProvider();
    // the home-screen app can't always open a popup, so it goes to Google's page and comes back instead
    const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
    try { await (standalone ? fb.auth().signInWithRedirect(p) : fb.auth().signInWithPopup(p)); }
    catch (e) {
      if (/popup-blocked|operation-not-supported/.test(e.code || "")) return fb.auth().signInWithRedirect(p);
      setStatus(friendly(e));
    }
  }
  async function signOut() {
    const guest = guestId() === user?.uid;
    await fb.auth().signOut();
    toast("Signed out");
    setStatus(guest ? "Signed out. This device is back to its main account's picks." : "Signed out. Your picks stay on this device too.");
  }
  async function deleteAccount() {
    try {
      await doc().delete();
      const uid = user.uid;
      await user.delete();
      if (ownerId() === uid) setOwner(null); // this device's data is no longer tied to an account
      setStatus("Account deleted. Everything we stored for you is gone (this device keeps its own copy).");
    } catch (e) {
      setStatus(e.code === "auth/requires-recent-login" ? "For safety, sign out, sign back in, then delete again." : friendly(e));
    }
  }
  const friendly = (e) => ({ "auth/popup-closed-by-user": "Sign-in window closed before finishing.", "auth/network-request-failed": "No connection. Try again.",
    "auth/unauthorized-domain": "This web address isn't allowed to sign in yet (Firebase > Authentication > Settings > Authorized domains).",
    "permission-denied": "The account database refused the save (check the Firestore rules)." }[e?.code] || `Something went wrong (${e?.code || e?.message || e}).`);
  // signed in: your Google photo (or initial) on the gear button, so it's obvious from every page
  function badge() {
    const g = document.getElementById("gear");
    if (!g) return;
    g.classList.toggle("signed-in", !!user);
    g.querySelector(".gear-me")?.remove();
    if (user) g.insertAdjacentHTML("beforeend", user.photoURL
      ? `<img class="gear-me" src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="gear-me">${esc((user.displayName || "?")[0])}</span>`);
    g.title = user ? `Settings · signed in as ${user.displayName || user.email || "you"}` : "Settings: dark/light mode and theme";
  }
  function toast(msg) {
    let t = document.getElementById("acct-toast");
    if (!t) { t = document.createElement("div"); t.id = "acct-toast"; t.className = "acct-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 3500);
  }
  function setStatus(s) { status = s; const el = document.getElementById("acct-status"); if (el) el.textContent = s; }
  function rerender() { if (!document.getElementById("view-settings").classList.contains("hidden")) Settings.render(); }

  // Settings page section
  function section() {
    if (!enabled()) return "";
    start();
    const pic = user?.photoURL ? `<img src="${esc(user.photoURL)}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : "";
    return `<h3>Account</h3>
      ${user ? `<div class="acct-me">${pic}<div><b>Signed in as ${esc(user.displayName || user.email || "you")}</b>
          <small>Your Pick'em picks and record, the daily game and your fantasy team are saved to your account and show up on any device you sign in on.</small></div></div>
        <div class="acct-btns"><button type="button" class="boxbtn" id="acct-out">Sign out</button>
          <button type="button" class="boxbtn danger" id="acct-del">Delete my account</button></div>
        <div class="acct-confirm hidden" id="acct-confirm"><span>Delete your account and everything saved to it? This can't be undone.</span>
          <button type="button" class="boxbtn danger" id="acct-del-yes">Yes, delete it</button><button type="button" class="boxbtn" id="acct-del-no">Keep it</button></div>`
      : `<p class="note">Sign in to keep your Pick'em record, daily game streak and fantasy team on every device. Free. We never see your password, and you can delete everything any time.</p>
        <button type="button" class="gbtn" id="acct-in"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</button>`}
      <p class="note" id="acct-status" role="status">${esc(status)}</p>
      <p class="note"><a href="${link("privacy")}">Privacy: what we keep and why</a></p>`;
  }
  function wire(root) {
    const on = (id, fn) => { const b = root.querySelector("#" + id); if (b) b.onclick = fn; };
    on("acct-in", signIn);
    on("acct-out", signOut);
    on("acct-del", () => root.querySelector("#acct-confirm").classList.remove("hidden"));
    on("acct-del-no", () => root.querySelector("#acct-confirm").classList.add("hidden"));
    on("acct-del-yes", deleteAccount);
  }

  if (enabled()) start(); // pick up a returning sign-in (or a finished redirect) on page load
  return { enabled, section, wire };
})();
