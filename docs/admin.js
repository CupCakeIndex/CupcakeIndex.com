// Analytics page (#/admin): only for thecupcakeindex.support@gmail.com, signed in with Google. The database rules
// (firestore.rules) enforce it too, so nobody else can read the numbers even from the browser console.
// Numbers come from stats.js: daily counters (stats/<day>), who checked in during the last 5 minutes (live/*),
// plus totals of accounts (users/*) and devices with alerts on (push/*).
const Admin = (() => {
  const OWNER = "thecupcakeindex.support@gmail.com";
  const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  let chart = null;
  const day = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const num = (n) => (n ?? 0).toLocaleString();

  // how many documents in a collection (optionally: whose field t is newer than `after`), signed in as the owner.
  // The Firebase version the site loads has no count() yet, so this uses Firestore's web API.
  async function count(coll, after) {
    const token = await firebase.auth().currentUser.getIdToken();
    const q = { from: [{ collectionId: coll }] };
    if (after) q.where = { fieldFilter: { field: { fieldPath: "t" }, op: "GREATER_THAN", value: { timestampValue: after.toISOString() } } };
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${window.FIREBASE_CONFIG.projectId}/databases/(default)/documents:runAggregationQuery`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: q, aggregations: [{ count: {}, alias: "n" }] } }) });
    if (!r.ok) throw new Error(`${coll}: ${r.status}`);
    return +((await r.json())[0]?.result?.aggregateFields?.n?.integerValue || 0);
  }

  async function render() {
    const el = $("#view-admin");
    if (!Account.enabled()) { el.innerHTML = `<div class="card">Accounts are off, so there's nothing to show.</div>`; return; }
    el.innerHTML = loadingHtml();
    const db = await Account.firestore();
    await Promise.race([new Promise((ok) => { const u = firebase.auth().onAuthStateChanged(() => { u(); ok(); }); }),
      new Promise((ok) => setTimeout(ok, 5000))]); // sign-in settled (or gave up)
    const me = Account.user();
    if (!me || (me.email || "").toLowerCase() !== OWNER || !me.emailVerified) {
      el.innerHTML = `<div class="card"><h2>Analytics</h2><p class="muted">This page is only for the site's owner account. ${me ? "You're signed in with a different account." : "Sign in from Settings."}</p></div>`;
      return;
    }
    const since = new Date(Date.now() - 59 * 864e5), days = []; // 60 days: the last 30 plus the 30 before, for the change
    for (let d = new Date(since); d <= new Date(); d = new Date(d.getTime() + 864e5)) days.push(day(d));
    let rows, live, accounts, devices;
    try {
      const FP = firebase.firestore.FieldPath;
      [rows, live, accounts, devices] = await Promise.all([
        db.collection("stats").where(FP.documentId(), ">=", days[0]).get(),
        count("live", new Date(Date.now() - 5 * 60000)),
        count("users"),
        count("push"),
      ]);
    } catch (e) {
      el.innerHTML = `<div class="card"><h2>Analytics</h2><p>Couldn't read the numbers (${esc(e.code || e.message)}). If this is new, the updated rules in firestore.rules still need to be pasted into Firebase console > Firestore Database > Rules > Publish.</p></div>`;
      return;
    }
    const by = Object.fromEntries(rows.docs.map((d) => [d.id, d.data()]));
    const series = (k) => days.map((d) => by[d]?.[k] || 0);
    // total of the last n days (back = 0), or of the n days before that (back = 1)
    const sum = (k, n, back = 0) => series(k).slice(days.length - n * (back + 1), days.length - n * back).reduce((a, b) => a + b, 0);
    // change vs the period before: "+12 · +15%" (no % when the period before was 0)
    const delta = (now, then) => {
      const d = now - then, cls = d > 0 ? "up" : d < 0 ? "down" : "";
      const pct = then ? ` · ${d >= 0 ? "+" : ""}${Math.round((100 * d) / then)}%` : "";
      return `<i class="ad-d ${cls}">${d >= 0 ? "+" : ""}${num(d)}${pct}</i>`;
    };
    const tile = (big, label, change = "") => `<div class="ad-tile"><b>${big}</b>${change}<small>${esc(label)}</small></div>`;
    const KEYS = [["visitors", "visitors"], ["newVisitors", "new visitors"], ["views", "page views"], ["charts", "charts made"], ["downloads", "charts downloaded"]];
    const row = (n) => KEYS.map(([k, l]) => tile(num(sum(k, n)), n === 30 && k === "visitors" ? "visits (one per person per day)" : l, delta(sum(k, n), sum(k, n, 1)))).join("");
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Analytics</h2><span class="muted">only you can see this · Eastern time</span></div>
      <h3>Right now</h3><div class="ad-tiles">${tile(num(live), "on the site now (last 5 min)")}${tile(num(accounts), "accounts")}${tile(num(devices), "devices with alerts on")}</div>
      <h3>Today <span class="muted">vs yesterday</span></h3><div class="ad-tiles">${row(1)}</div>
      <h3>Last 7 days <span class="muted">vs the 7 days before</span></h3><div class="ad-tiles">${row(7)}</div>
      <h3>Last 30 days <span class="muted">vs the 30 days before</span></h3><div class="ad-tiles">${row(30)}</div>
      <div class="ad-chart"><canvas id="ad-chart"></canvas></div>
      <p class="note">Counted since the Analytics launch (Oct 6, 2026), so until then the "days before" are short or empty. Today is still going, so it usually trails yesterday until evening. No cookies and nothing personal: each browser counts once a day as a visitor, and once ever as new. Test browsers don't count.</p></div>`;
    if (!window.Chart) await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = CHART_JS; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }).catch(() => {});
    if (!window.Chart) return;
    const css = getComputedStyle(document.body), C = (v) => css.getPropertyValue(v).trim();
    chart?.destroy();
    chart = new Chart($("#ad-chart"), { type: "line", data: { labels: days.slice(-30).map((d) => d.slice(5).replace("-", "/")),
      datasets: [["visitors", "Visitors", C("--accent")], ["newVisitors", "New visitors", "#4cc9f0"], ["charts", "Charts made", "#b5e48c"]]
        .map(([k, l, c]) => ({ label: l, data: series(k).slice(-30), borderColor: c, backgroundColor: c, tension: 0.25, pointRadius: 2 })) },
      options: { responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        plugins: { legend: { labels: { color: C("--ink") } } },
        scales: { x: { ticks: { color: C("--muted") }, grid: { color: C("--line") } }, y: { beginAtZero: true, ticks: { color: C("--muted"), precision: 0 }, grid: { color: C("--line") } } } } });
  }

  return { render };
})();
