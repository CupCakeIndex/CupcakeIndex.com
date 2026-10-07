// Site analytics: our own, on the Firebase we already use (free plan, no cookies, no third party).
// Each visit adds to one small counter document per day (stats/<YYYY-MM-DD>, Eastern time): page views, visitors
// (once per browser per day), new visitors (first visit ever), charts made in Visualize, pictures downloaded.
// Counts are batched and sent at most every 2 minutes, together with a "still here" check-in (live/<browser id>)
// that the Analytics page uses for "on the site now". Nothing personal is stored: no names, no IP addresses.
// Only the site owner can read any of it (firestore.rules). The page: #/admin (admin.js).
// Test browsers (headless Chrome), localhost, and the owner's own browsers (signed in as the support account) don't count.
const Stats = (() => {
  const pending = {};
  let timer = null, beat = null;
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };
  const OWNER = "thecupcakeindex.support@gmail.com";
  const off = () => navigator.webdriver || !Account.enabled() || /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || ls("ci-owner") === "1";
  const day = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // 2026-10-06
  const browserId = () => ls("ci-live") || (ls("ci-live", Math.random().toString(36).slice(2, 12) + Date.now().toString(36)), ls("ci-live"));

  function count(field, n = 1) {
    if (off()) return;
    pending[field] = (pending[field] || 0) + n;
    clearTimeout(timer);
    timer = setTimeout(flush, 20000);
  }

  async function flush() {
    if (off() || document.visibilityState === "hidden" && !Object.keys(pending).length) return;
    try {
      const db = await Account.firestore(), F = firebase.firestore.FieldValue, b = db.batch();
      if ((Account.user()?.email || "").toLowerCase() === OWNER) { // the owner's browser: never counted, from now on
        ls("ci-owner", "1");
        Object.keys(pending).forEach((k) => delete pending[k]);
        return;
      }
      const todo = Object.entries(pending).filter(([, n]) => n > 0);
      todo.forEach(([k]) => delete pending[k]);
      if (todo.length) b.set(db.collection("stats").doc(day()), Object.fromEntries(todo.map(([k, n]) => [k, F.increment(Math.min(n, 50))])), { merge: true });
      const id = browserId();
      if (id) b.set(db.collection("live").doc(id), { t: F.serverTimestamp() });
      await b.commit();
    } catch (e) { /* rules not published yet, or offline: analytics never gets in the way */ }
  }

  function start() {
    if (off()) return;
    const today = day();
    // only browsers that can remember they were counted (private windows with storage blocked can't, and would count every load)
    if (ls("ci-seen") !== today) {
      ls("ci-seen", today);
      if (ls("ci-seen") === today) {
        count("visitors");
        if (!ls("ci-first")) { ls("ci-first", today); count("newVisitors"); }
      }
    }
    setTimeout(flush, 4000); // the first check-in soon after the page opens
    beat = setInterval(() => { if (document.visibilityState === "visible") flush(); }, 120000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  }

  return { start, count };
})();

Stats.start();
