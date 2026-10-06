// Alerts (web push), Settings > Alerts: final scores for your teams, Bully of the Week, the Saturday Pick'em
// reminder and breaking news. Works in the browser on Android and computers, and on iPhone from the home-screen
// app (iOS 16.4+). No sign-in needed: turning alerts on saves this device's push address, your teams and your
// choices in Firestore at push/<id> (id = a hash of the address); src/push.py (GitHub Actions) reads them and sends.
// Turning alerts off deletes that document. sw.js shows the alerts and opens the page when one is tapped.
const Push = (() => {
  const KEY = "push-alerts"; // this device only (not synced to the account): {on, id, topics, sig}
  const VAPID = "BCoYCwq981pDksYrHkFcp_geF-yiXs1uJcDTgMOXtPmGf4ksXSrtq5Ay1RT__PWl-H750UWSgFfPaZXzf8V109s";
  const TOPICS = [["final", "Final scores for my teams"], ["bully", "Bully of the Week"], ["picks", "Pick'em reminder (Saturday night, before picks lock)"], ["news", "Breaking news (3 a day at most)"]];
  const DEFAULT = { final: true, bully: true, picks: true, news: false };
  let status = "", busy = false;

  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const iphone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  const get = () => ({ on: false, ...(store.get(KEY) || {}), topics: { ...DEFAULT, ...(store.get(KEY)?.topics || {}) } });
  const teams = () => (typeof Profile !== "undefined" ? Profile.favorites() : []).map((f) => `${f.lg}:${f.id}`);
  const key = (s) => Uint8Array.from(atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  async function idFor(endpoint) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
    return [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
  }
  const col = async () => (await Account.firestore()).collection("push");

  // save this device's address + teams + choices (only when something changed, to stay well inside the free plan)
  async function save(sub, force = false) {
    const s = get(), j = sub.toJSON(), id = await idFor(j.endpoint);
    const topics = Object.keys(s.topics).filter((k) => s.topics[k]), t = teams();
    const sig = JSON.stringify([id, t, topics]);
    if (!force && s.on && s.sig === sig) return;
    const c = await col();
    if (s.id && s.id !== id) c.doc(s.id).delete().catch(() => {}); // the browser gave us a new address: drop the old one
    await c.doc(id).set({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, teams: t, topics, updated: new Date().toISOString() });
    store.set(KEY, { ...s, on: true, id, sig });
  }

  async function turnOn() {
    if (busy) return;
    busy = true;
    setStatus("Turning on…");
    try {
      const perm = await Notification.requestPermission(); // first thing after the tap: iPhone insists
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "Alerts are blocked for this site. Allow them in your phone or browser settings, then try again." : "No alerts for now. Tap the button whenever you want them.");
        return;
      }
      const reg = await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key(VAPID) }));
      await save(sub, true);
      reg.showNotification("Alerts are on", { body: "We'll buzz you for the things you picked in Settings. 🧁", icon: "icon-192.png", tag: "welcome" });
      setStatus("Alerts are on for this device.");
    } catch (e) {
      console.warn(e);
      setStatus(e?.code === "permission-denied" ? "The alerts database refused the save (check the Firestore rules)." : `Couldn't turn on alerts (${e?.code || e?.message || e}). Try again in a minute.`);
    } finally { busy = false; rerender(); }
  }

  async function turnOff() {
    const s = get();
    setStatus("Turning off…");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      if (s.id) await (await col()).doc(s.id).delete();
      setStatus("Alerts are off. Nothing about this device is kept.");
    } catch (e) { console.warn(e); setStatus("Alerts are off on this device."); }
    store.set(KEY, { topics: s.topics, on: false });
    rerender();
  }

  // re-save when your teams or choices change, and on each visit (picks up a new address from the browser)
  let timer = null;
  function sync() {
    if (!get().on || !supported() || Notification.permission !== "granted") return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const reg = await navigator.serviceWorker.register("sw.js");
        const sub = await reg.pushManager.getSubscription();
        if (sub) await save(sub);
        else store.set(KEY, { ...get(), on: false }); // the browser dropped it (alerts turned off in phone settings)
      } catch (e) { console.warn(e); }
    }, 1500);
  }

  function setStatus(s) { status = s; const el = document.getElementById("push-status"); if (el) el.textContent = s; }
  function rerender() { if (!document.getElementById("view-settings").classList.contains("hidden")) Settings.render(); }

  // Settings page section
  function section() {
    if (typeof Account === "undefined" || !Account.enabled()) return "";
    const s = get(), on = s.on && supported() && Notification.permission === "granted";
    let body;
    if (!supported()) {
      body = iphone() && !standalone()
        ? `<p class="note">On iPhone, alerts work from the home-screen app: in Safari tap Share <b>⎙</b> &gt; <b>Add to Home Screen</b>, open <b>Cupcake</b> from your home screen, then come back here. (Needs iOS 16.4 or newer.)</p>`
        : `<p class="note">This browser can't show alerts. ${iphone() ? "Update your iPhone to iOS 16.4 or newer." : "Try Chrome, Edge, Firefox or Safari."}</p>`;
    } else if (Notification.permission === "denied") {
      body = `<p class="note">Alerts are blocked for this site. Allow notifications for cupcakeindex.com in your ${iphone() ? "iPhone's Settings &gt; Notifications &gt; Cupcake" : "browser's site settings"}, then come back here.</p>`;
    } else if (!on) {
      body = `<p class="note">Get a buzz on this device for final scores of your teams, the Bully of the Week and the Pick'em deadline. Free, no sign-in, and you can turn it off any time.</p>
        <button type="button" class="gbtn" id="push-on">🔔 Turn on alerts</button>`;
    } else {
      body = `<p class="note">Alerts are on for this device. Pick what you want:</p>
        <div class="push-topics">${TOPICS.map(([k, l]) => `<label class="pf-check"><input type="checkbox" data-topic="${k}" ${s.topics[k] ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
        ${s.topics.final && !teams().length ? `<p class="note">Pick your teams under <b>Your team</b> to get their final scores.</p>` : ""}
        <button type="button" class="boxbtn" id="push-off">Turn off alerts</button>`;
    }
    return `<h3>Alerts</h3>${body}<p class="note" id="push-status" role="status">${esc(status)}</p>`;
  }
  function wire(root) {
    const b = (id) => root.querySelector("#" + id);
    if (b("push-on")) b("push-on").onclick = turnOn;
    if (b("push-off")) b("push-off").onclick = turnOff;
    root.querySelectorAll("[data-topic]").forEach((x) => x.onchange = () => {
      const s = get();
      store.set(KEY, { ...s, topics: { ...s.topics, [x.dataset.topic]: x.checked } });
      setStatus("Saved.");
      sync();
    });
  }

  sync();
  return { section, wire, sync };
})();
