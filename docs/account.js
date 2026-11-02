// Accounts: Sign in with Google, or an email and password for any other address (Firebase), so Pick'em, the daily game and your fantasy team follow you to any device.
// OFF until firebase-config.js has a config; then the Settings page shows an Account section.
// What syncs: the same browser storage the site already uses (SYNCED below). We never see a password (Google
// or Firebase handles sign-in) and keep only a user id, a first name and that game data, in Firestore at users/<uid>.
const Account = (() => {
  const CFG = window.FIREBASE_CONFIG;
  const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  const SYNCED = (k) => /^pickem-/.test(k) || k === "daily-nfl" || k === "daily-nfl-stats" || k === "hilo-stats" || k === "dynasty-stats" || k === "mock-gm" || k === "fantasy-team" || k === "cupcake-profile" || k === "viz-presets" || k === "lb-name";
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
        // signing out (or switching straight to another account): clear this device's copy; it's safe in the account
        if (was && (!u || u.uid !== was.uid)) { clearSynced(); CIT.apply(); Profile.header(); window.dispatchEvent(new HashChangeEvent("hashchange")); }
        user = u;
        badge();
        // Admin tab (analytics, admin.js) only for the support account; firestore.rules guard the data itself
        document.body.classList.toggle("is-owner", !!u && u.emailVerified && (u.email || "").toLowerCase() === "thecupcakeindex.support@gmail.com");
        rerender(); // show signed in/out right away; the first sync runs in the background
        window.dispatchEvent(new CustomEvent("account", { detail: u })); // the Analyst chat (bot.js) checks membership
        if (u) {
          if (!was) toast(`Signed in as ${u.displayName || u.email || "you"}`);
          syncDown(); // anything made while signed out joins this account, then the account's data loads
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
    if (k === "hilo-stats") return (A?.best || 0) > (B?.best || 0) || ((A?.best || 0) === (B?.best || 0) && (A?.played || 0) >= (B?.played || 0)) ? a : b;
    if (k === "dynasty-stats") return (A?.played || 0) >= (B?.played || 0) ? a : b; // the one with more seasons played
    if (k === "daily-nfl") return (A?.guesses?.length || 0) >= (B?.guesses?.length || 0) ? a : b;
    if (A && B && typeof A === "object" && typeof B === "object" && !Array.isArray(A)) {
      const m = { ...B, ...A }; // this device wins a tie
      return typeof JSON.parse(a) === "string" ? JSON.stringify(JSON.stringify(m)) : JSON.stringify(m);
    }
    return a;
  }

  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} };
  function clearSynced() { for (const k of Object.keys(localData())) lsSet(k, null); }
  // tidy up keys from the short-lived "main account / guest" version
  ["acct-owner", "acct-guest", "acct-stash"].forEach((k) => lsSet(k, null));

  async function syncDown() {
    setStatus("Syncing…");
    try {
      const snap = await doc().get();
      const remote = (snap.exists && snap.data().data) || {}, local = localData(), all = { ...remote };
      // what's on the device now is either this account's own copy or picks made while signed out: both belong here
      for (const [k, v] of Object.entries(local)) all[k] = k in remote ? merge(k, v, remote[k]) : v;
      for (const [k, v] of Object.entries(all)) { try { localStorage.setItem(k, v); } catch (e) {} }
      await doc().set({ name: (user.displayName || "").split(" ")[0], data: all, updated: new Date().toISOString() });
      setStatus("Saved to your account.");
      window.dispatchEvent(new HashChangeEvent("hashchange")); // redraw the page with the merged data
      CIT.apply(); Profile.header(); // your team's colors and header button come with the account
      if (!store.get(Profile.KEY)) { store.set("ci-setup", 2); Profile.open(true); } // first sign-in: name, what you watch, favorite team (+ alerts, leaderboard name)
      else if (typeof Push !== "undefined") Push.ask(); // everyone else: asked once per device whether they want alerts
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
    p.setCustomParameters({ prompt: "select_account" }); // always show Google's account picker
    // the home-screen app can't always open a popup, so it goes to Google's page and comes back instead
    const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
    try { await (standalone ? fb.auth().signInWithRedirect(p) : fb.auth().signInWithPopup(p)); }
    catch (e) {
      if (/popup-blocked|operation-not-supported/.test(e.code || "")) return fb.auth().signInWithRedirect(p);
      setStatus(friendly(e));
    }
  }
  // Email and password, for Hotmail, Yahoo and everyone else without a Google account. New accounts get a verification
  // email; paid features and the Analyst need a verified address, and the worker and firestore.rules check that too.
  const usesPassword = () => !!user?.providerData?.some((p) => p.providerId === "password");
  function formValues() {
    const email = document.getElementById("acct-email")?.value.trim() || "", pass = document.getElementById("acct-pass")?.value || "";
    if (!/^\S+@\S+\.\S+$/.test(email)) { setStatus("Enter your email address."); return null; }
    return { email, pass };
  }
  async function emailIn(e) {
    e?.preventDefault();
    const v = formValues();
    if (!v) return;
    if (!v.pass) return setStatus("Enter your password.");
    await start();
    setStatus("Signing in…");
    try { await fb.auth().signInWithEmailAndPassword(v.email, v.pass); } catch (err) { setStatus(friendly(err)); }
  }
  async function emailCreate() {
    const v = formValues();
    if (!v) return;
    if (v.pass.length < 6) return setStatus("Pick a password with at least 6 characters.");
    await start();
    setStatus("Creating your account…");
    try {
      const r = await fb.auth().createUserWithEmailAndPassword(v.email, v.pass);
      await r.user.sendEmailVerification();
      toast(`Verification email sent to ${v.email}`);
    } catch (err) { setStatus(friendly(err)); }
  }
  async function emailReset() {
    const v = formValues();
    if (!v) return;
    await start();
    try { await fb.auth().sendPasswordResetEmail(v.email); setStatus(`If ${v.email} has an account, a reset link is on its way. Check your junk folder too.`); }
    catch (err) { setStatus(friendly(err)); }
  }
  async function emailResend() {
    try { await user.sendEmailVerification(); setStatus(`Sent to ${user.email}. Check your junk folder too.`); }
    catch (err) { setStatus(friendly(err)); }
  }
  // back from the verification link: refresh so the site and the sign-in token both know
  async function emailRecheck() {
    if (!user || user.emailVerified) return;
    try { await user.reload(); if (fb.auth().currentUser?.emailVerified) { await fb.auth().currentUser.getIdToken(true); rerender(); } } catch (e) {}
  }
  async function signOut() {
    await fb.auth().signOut();
    toast("Signed out");
    setStatus("Signed out. Your picks are saved to your account and come back when you sign in.");
  }
  async function switchAccount() {
    const password = usesPassword();
    await fb.auth().signOut(); // clears this device's copy (it's safe in the account you're leaving)
    if (!password) signIn(); // a password account goes back to the sign-in form instead of Google's picker
  }
  async function deleteAccount() {
    try {
      // the Pick'em leaderboard name and rows go too (leaderboard.js)
      const fs = fb.firestore(), rows = await fs.collection("leaderboard").where("uid", "==", user.uid).get().catch(() => null);
      await Promise.all([...(rows?.docs || []).map((d) => d.ref.delete()),
        ...(store.get("lb-name")?.key ? [fs.collection("names").doc(store.get("lb-name").key).delete()] : [])]).catch(() => {});
      await doc().delete();
      await user.delete();
      setStatus("Account deleted. Everything we stored for you is gone.");
    } catch (e) {
      setStatus(e.code === "auth/requires-recent-login" ? "For safety, sign out, sign back in, then delete again." : friendly(e));
    }
  }
  const friendly = (e) => ({ "auth/popup-closed-by-user": "Sign-in window closed before finishing.", "auth/network-request-failed": "No connection. Try again.",
    "auth/invalid-credential": "That email and password don't match. If you normally use Google, tap Sign in with Google.", "auth/wrong-password": "That email and password don't match.", "auth/user-not-found": "That email and password don't match.",
    "auth/invalid-login-credentials": "That email and password don't match. If you normally use Google, tap Sign in with Google.",
    "auth/email-already-in-use": "That email already has an account. Sign in instead, or use Sign in with Google if that's how you joined.", "auth/invalid-email": "That doesn't look like an email address.",
    "auth/weak-password": "Pick a password with at least 6 characters.", "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.", "auth/operation-not-allowed": "Email sign-in isn't turned on yet.",
    "auth/unauthorized-domain": "This web address isn't allowed to sign in yet (Firebase > Authentication > Settings > Authorized domains).",
    "permission-denied": "The account database refused the save (check the Firestore rules)." }[e?.code] || `Something went wrong (${e?.code || e?.message || e}).`);
  // signed in: your Google photo (or initial) on the gear button, so it's obvious from every page
  const perfects = () => { // Perfect Pick'em weeks (pickem.js stores the list as a JSON string, like its season log)
    try { let v = JSON.parse(localStorage.getItem("pickem-badges") || "null"); if (typeof v === "string") v = JSON.parse(v); return Array.isArray(v) ? v.length : 0; } catch (e) { return 0; }
  };
  function badge() {
    const g = document.getElementById("gear");
    if (!g) return;
    g.classList.toggle("signed-in", !!user);
    g.querySelector(".gear-me")?.remove();
    const gold = perfects() ? " gold" : ""; // Perfect Pick'em badge (pickem.js)
    if (user) g.insertAdjacentHTML("beforeend", user.photoURL
      ? `<img class="gear-me${gold}" src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="gear-me${gold}">${esc((user.displayName || user.email || "?")[0].toUpperCase())}</span>`);
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
    const np = perfects();
    const pic = user?.photoURL ? `<img src="${esc(user.photoURL)}" alt="" width="40" height="40" referrerpolicy="no-referrer"${np ? ` class="gold" title="Perfect Pick'em"` : ""}>` : "";
    return `<h3>Account</h3>
      ${user ? `<div class="acct-me">${pic}<div><b>Signed in as ${esc(user.displayName || user.email || "you")}</b>${np ? `<span class="pk-badge acct-badge">🏅 Perfect Pick'em${np > 1 ? " ×" + np : ""}</span>` : ""}
          <small>Your Pick'em picks and record, the daily game and your fantasy team are saved to your account and show up on any device you sign in on.</small></div></div>
        ${usesPassword() && !user.emailVerified ? `<p class="note acct-verify">Check your email and tap the link to verify your address. Subscriptions and the Analyst need a verified email. <button type="button" class="boxbtn" id="acct-resend">Send it again</button></p>` : ""}
        <div class="acct-btns"><button type="button" class="boxbtn" id="acct-switch">Switch account</button><button type="button" class="boxbtn" id="acct-out">Sign out</button>
          <button type="button" class="boxbtn danger" id="acct-del">Delete my account</button></div>
        <div class="acct-confirm hidden" id="acct-confirm"><span>Delete your account and everything saved to it? This can't be undone.</span>
          <button type="button" class="boxbtn danger" id="acct-del-yes">Yes, delete it</button><button type="button" class="boxbtn" id="acct-del-no">Keep it</button></div>`
      : `<p class="note">Sign in to keep your Pick'em record, daily game streak and fantasy team on every device. Free. We never see your password, and you can delete everything any time.</p>
        <button type="button" class="gbtn" id="acct-in"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Sign in with Google</button>
        <form class="acct-form" id="acct-form" novalidate><p class="note">Hotmail, Yahoo or another email? Use it here.</p>
          <label>Email<input id="acct-email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" inputmode="email"></label>
          <label>Password<input id="acct-pass" type="password" autocomplete="current-password"></label>
          <div class="acct-btns"><button type="submit" class="boxbtn">Sign in</button><button type="button" class="boxbtn" id="acct-new">Create account</button><button type="button" class="acct-link" id="acct-reset">Forgot password?</button></div></form>`}
      <p class="note" id="acct-status" role="status">${esc(status)}</p>
      <p class="note"><a href="${link("privacy")}">Privacy: what we keep and why</a></p>`;
  }
  function wire(root) {
    const on = (id, fn) => { const b = root.querySelector("#" + id); if (b) b.onclick = fn; };
    on("acct-in", signIn);
    on("acct-new", emailCreate);
    on("acct-reset", emailReset);
    on("acct-resend", emailResend);
    const form = root.querySelector("#acct-form");
    if (form) form.onsubmit = emailIn;
    emailRecheck();
    on("acct-out", signOut);
    on("acct-switch", switchAccount);
    on("acct-del", () => root.querySelector("#acct-confirm").classList.remove("hidden"));
    on("acct-del-no", () => root.querySelector("#acct-confirm").classList.add("hidden"));
    on("acct-del-yes", deleteAccount);
  }

  if (enabled()) start(); // pick up a returning sign-in (or a finished redirect) on page load
  // Firestore for other features (alerts: push.js), signed in or not
  const firestore = async () => { await start(); return fb.firestore(); };

  return { enabled, section, wire, signIn, user: () => user, firestore };
})();
