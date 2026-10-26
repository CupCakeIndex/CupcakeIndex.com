// Admin page (#/admin): only for thecupcakeindex.support@gmail.com, signed in with Google. The database rules
// (firestore.rules) enforce it too, so nobody else can read anything here even from the browser console, and none of
// it is in the public repo or the site's files: this week's posts (admin_brief, src/social/brief.py), the cost log and
// quality checks (admin_ledger, src/social/ledger.py + check_post.py), and the visitor analytics below.
// Numbers come from stats.js: daily counters (stats/<day>), who checked in during the last 5 minutes (live/*),
// plus totals of accounts (users/*) and devices with alerts on (push/*).
const Admin = (() => {
  const OWNER = "thecupcakeindex.support@gmail.com";
  const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
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

  const rulesNote = (e) => `Couldn't read it (${esc(e.code || e.message)}). If this is new, the updated rules in firestore.rules still need to be pasted into Firebase console > Firestore Database > Rules > Publish.`;
  const money = (n) => "$" + (n >= 0.1 || n === 0 ? n.toFixed(2) : n.toFixed(3));
  const KINDS = { daily: "Daily post", stat: "Stat / hot take", cup: "Cupcake stat", night: "Game night", tip: "Home screen tip", game: "Big game / records / news" };

  // admin_ledger rows from `from` on (an ISO date), without the pictures: Firestore's web API, signed in as the owner
  async function ledger(from) {
    const token = await firebase.auth().currentUser.getIdToken();
    const F = ["at", "kind", "what", "usd", "ok", "problem", "reason", "text", "tweet", "timed", "model"];
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${window.FIREBASE_CONFIG.projectId}/databases/(default)/documents:runQuery`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "admin_ledger" }], select: { fields: F.map((f) => ({ fieldPath: f })) },
        where: { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: from } } } } }) });
    if (!r.ok) throw Object.assign(new Error(`cost log: ${r.status}`), { code: r.status === 403 ? "permission-denied" : r.status });
    const val = (v) => v.integerValue != null ? +v.integerValue : v.doubleValue ?? v.booleanValue ?? v.stringValue ?? null;
    return (await r.json()).filter((x) => x.document).map((x) => ({ id: x.document.name.split("/").pop(),
      ...Object.fromEntries(Object.entries(x.document.fields || {}).map(([k, v]) => [k, val(v)])) }));
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
      el.innerHTML = `<div class="card"><h2>Admin</h2><p class="muted">This page is only for the site's owner account. ${me ? "You're signed in with a different account." : "Sign in from Settings."}</p></div>`;
      return;
    }
    el.innerHTML = `<div id="ad-posts">${loadingHtml()}</div><div id="ad-costs"></div><div id="ad-analytics"></div>`;
    const today = day(new Date()), t = new Date(today + "T12:00:00");
    const mon = day(new Date(t.getTime() - ((t.getDay() + 6) % 7) * 864e5));
    const from = [today.slice(0, 8) + "01", mon].sort()[0]; // the month so far, or this week if it began last month
    let rows = null, err = null;
    try { rows = await ledger(from); } catch (e) { err = e; }
    posts(db, $("#ad-posts"), mon, today, rows, err);
    costs($("#ad-costs"), today, mon, rows, err);
    analytics(db, $("#ad-analytics"));
  }

  // what a logged post was (its posting-log stat) -> the calendar slot family (brief.py ids) and a title
  const family = (w) => /^(mon|tue|wed|thu|fri|sat|sun)$/.test(w) ? "daily" : w === "bully_cfb" ? "bully" : w.startsWith("primetime-") ? "prime"
    : w.startsWith("tonight") ? "tonight" : /^(biggame|numbered)/.test(w) ? "big" : w.startsWith("pace_") ? "pace" : /^(app_tip|tip)/.test(w) ? "tip"
    : w === "weekly_frauds" ? "frauds" : w === "weekly_overachievers" ? "overach" : w === "nfl_injuries" ? "injuries"
    : /drought|series|cupcake|primetime_record/.test(w) ? "cup" : /^(hot_|deep_|nfl_|cfb_|take)/.test(w) ? "stat" : "";
  const TITLES = [["news-", "Breaking news"], ["thread:", "Thread"], ["biggame", "Big game"], ["pace_", "Historic pace"]];

  // ---------- this week's posts: the calendar (src/social/brief.py) with what actually went out (ledger) ----------
  async function posts(db, el, mon, today, rows, err) {
    const days = [...Array(7)].map((_, i) => day(new Date(new Date(mon + "T12:00:00").getTime() + i * 864e5)));
    let brief = {};
    try {
      const FP = firebase.firestore.FieldPath;
      const got = await db.collection("admin_brief").where(FP.documentId(), ">=", days[0]).where(FP.documentId(), "<=", days[6]).get();
      brief = Object.fromEntries(got.docs.map((d) => [d.id, d.data()]));
    } catch (e) { err = err || e; }
    if (err) { el.innerHTML = `<div class="card"><h2>Posts this week</h2><p>${rulesNote(err)}</p></div>`; return; }
    const mins = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
    const hm = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
    const items = {}; // day -> entries
    for (const d of days) items[d] = (brief[d]?.slots || []).map((s) => ({ ...s, day: d }));
    const checks = (rows || []).filter((r) => r.kind === "check"), sent = (rows || []).filter((r) => r.kind === "x");
    // each check and each post goes on the scheduled slot nearest its time (within 90 minutes), else its own entry
    const place = (r, fill) => {
      const d = day(new Date(r.at));
      if (!items[d]) return;
      const at = mins(hm(r.at)), what = String(r.what || ""), fam = family(what);
      // its own kind of slot first (a prime-time post run by hand at 1:39 still belongs to the 4 PM slot), else the nearest
      const open = items[d].filter((s) => !s.done && s.t && r.timed !== false);
      const near = (list, max) => list.sort((a, b) => Math.abs(mins(a.t) - at) - Math.abs(mins(b.t) - at)).find((s) => Math.abs(mins(s.t) - at) <= max);
      const best = (fam && near(open.filter((s) => s.id.startsWith(fam)), 1440)) || (!fam || fam === "stat" ? near(open, 90) : null);
      if (best) { fill(best); best.done = true; return; }
      const title = TITLES.find(([k]) => what.startsWith(k))?.[1] || "Post";
      const e = { t: r.timed === false ? "" : hm(r.at), kind: /^(news-|biggame|pace_)/.test(what) ? "game" : "stat", title, sub: "", day: d, done: true };
      fill(e);
      items[d].push(e);
    };
    for (const c of checks) {
      const x = sent.find((s) => !s.used && s.text === c.text);
      if (x) x.used = true;
      place(x || c, (e) => Object.assign(e, { status: c.ok ? "posted" : "blocked", text: c.text, reason: c.reason, checkId: c.id, tweet: x?.tweet, img: null }));
    }
    // posts from before the quality check: the Takes page's copy (docs/data/takes.json, public anyway) has the picture,
    // the wording that went out and the link; matched by time (within 5 minutes)
    let takes = [];
    try { takes = (await (await fetch("data/takes.json", { cache: "no-store" })).json()).items || []; } catch (x) { takes = []; }
    const takeFor = (x) => takes.find((k) => (x.tweet && k.id === x.tweet) || (x.timed !== false && Math.abs(new Date(k.time) - new Date(x.at)) < 5 * 60000));
    for (const x of sent.filter((s) => !s.used)) {
      const k = takeFor(x);
      place(x, (e) => Object.assign(e, { status: "posted", text: k?.text || x.text, tweet: x.tweet || k?.id, src: k?.image || null, img: null }));
    }
    const nowM = mins(hm(new Date().toISOString()));
    for (const d of days) for (const e of items[d]) {
      if ((e.status === "scheduled" || e.status === "planned") && (d < today || (d === today && e.t && mins(e.t) + 45 < nowM))) {
        e.status = e.maybe ? "none" : "missed";
      }
    }
    const LABEL = { scheduled: "", planned: "Preview ready", skip: "Won't post", posted: "Posted", blocked: "Stopped by the check",
      error: "Preview failed", none: "Nothing to post", missed: "Didn't post" };
    const time12 = (x) => { if (!x) return ""; const h = +x.slice(0, 2); return `${h % 12 || 12}:${x.slice(3)} ${h < 12 ? "AM" : "PM"}`; };
    const all = [];
    const cell = (e) => {
      all.push(e);
      return `<button type="button" class="ad-p k-${esc(e.kind)} s-${esc(e.status)}${e.maybe ? " maybe" : ""}" data-i="${all.length - 1}">
        <time>${time12(e.t) || "&nbsp;"}</time><b>${esc(e.title)}</b>${LABEL[e.status] ? `<span class="st">${LABEL[e.status]}</span>` : `<span>${esc(e.sub || "")}</span>`}</button>`;
    };
    const name = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Posts this week</h2><span class="muted">only you can see this · Eastern time · tap a post to preview it</span></div>
      <div class="ad-legend">${Object.entries(KINDS).map(([k, l]) => `<span class="k-${k}"><i></i>${l}</span>`).join("")}<span>Dashed = only if there's something to post</span></div>
      <div class="ad-week"><div class="ad-grid">${days.map((d) => `<div class="ad-day${d === today ? " today" : ""}">
        <h3>${name(d)}${d === today ? " <em>today</em>" : ""}</h3>
        ${items[d].sort((a, b) => ((a.t || "99") < (b.t || "99") ? -1 : 1)).map(cell).join("") || `<p class="muted">${d < today ? "Before the calendar started" : "Nothing scheduled"}</p>`}</div>`).join("")}</div></div>
      <p class="note">Previews are made each morning at 7 AM the same way the posts are, so a post can still change before it goes out (new games, news, or the quality check). Claude checks every post right before it goes out; a post the check stops shows here with the reason.</p>
      <dialog class="ad-dlg"><div class="ad-dlg-in"></div></dialog></div>`;
    const dlg = el.querySelector(".ad-dlg"), inner = el.querySelector(".ad-dlg-in");
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg || ev.target.closest("[data-close]")) dlg.close(); });
    const wk = el.querySelector(".ad-week"), col = wk.querySelector(".ad-day.today");
    if (col) wk.scrollLeft = Math.max(0, col.getBoundingClientRect().left - wk.getBoundingClientRect().left);
    const pic = (b64) => `<img alt="The post's picture" src="data:image/jpeg;base64,${b64}">`;
    el.querySelectorAll(".ad-p").forEach((b) => b.addEventListener("click", async () => {
      const e = all[+b.dataset.i];
      const status = LABEL[e.status] || (e.maybe ? "Only if there's something to post" : "Scheduled");
      const why = e.reason ? `<p class="ad-why${e.status === "blocked" ? " bad" : ""}">${e.status === "blocked" ? "Why: " : e.status === "posted" ? "Check: " : ""}${esc(e.reason)}</p>` : "";
      inner.innerHTML = `<div class="sc-bar"><h3>${esc(e.title)}</h3><span class="muted">${esc(name(e.day))}${e.t ? " · " + time12(e.t) : ""}</span>
          <button type="button" class="ad-x" data-close aria-label="Close">✕</button></div>
        <p class="ad-pill s-${esc(e.status)}">${esc(status)}</p>${why}
        <div class="ad-img">${e.img ? pic(e.img) : e.src ? `<img alt="The post's picture" src="${esc(e.src)}">` : e.checkId ? loadingHtml("Loading the picture…") : ""}</div>
        ${e.text ? `<p class="ad-text">${esc(e.text)}</p>` : `<p class="muted">${esc(e.sub || "")}${e.status === "scheduled" ? " The preview is made that morning." : ""}</p>`}
        ${e.tweet ? `<p><a href="https://x.com/i/web/status/${encodeURIComponent(e.tweet)}" target="_blank" rel="noopener">Open on X ↗</a></p>` : ""}`;
      dlg.showModal();
      if (!e.img && e.checkId) {
        let img = null;
        try { img = (await db.collection("admin_ledger").doc(e.checkId).get()).data()?.img || null; } catch (x) { img = null; }
        e.img = img;
        const box = inner.querySelector(".ad-img");
        if (box) box.innerHTML = img ? pic(img) : `<p class="muted">No picture saved for this one.</p>`;
      }
    }));
  }

  // ---------- what it all costs (src/social/ledger.py), plus the fixed costs ----------
  const FIXED = [ // dollars a month; null = not known yet
    ["X Premium (@CupcakeIndex)", null, "your X subscription"],
    ["cupcakeindex.com domain", null, "yearly renewal, shown per month"],
    ["Firebase (accounts, alerts, analytics)", 0, "free Spark plan"],
    ["GitHub (site + all the automatic jobs)", 0, "free for a public repo"],
    ["CollegeFootballData", 0, "free plan"],
  ];
  function costs(el, today, mon, rows, err) {
    if (err) { el.innerHTML = `<div class="card"><h2>Costs</h2><p>${rulesNote(err)}</p></div>`; return; }
    const month = today.slice(0, 7), r = rows.filter((x) => x.usd);
    const dayOf = (x) => day(new Date(x.at));
    const sum = (f) => r.filter(f).reduce((a, x) => a + x.usd, 0);
    const inMonth = (x) => dayOf(x).startsWith(month);
    const t = new Date(today + "T12:00:00"), dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(), done = t.getDate();
    const mtd = sum(inMonth), wk = sum((x) => dayOf(x) >= mon), td = sum((x) => dayOf(x) === today);
    const yd = sum((x) => dayOf(x) === day(new Date(t.getTime() - 864e5)));
    const fixed = FIXED.reduce((a, f) => a + (f[1] || 0), 0), unknown = FIXED.some((f) => f[1] == null);
    const tile = (big, label) => `<div class="ad-tile"><b>${big}</b><small>${esc(label)}</small></div>`;
    const CATS = [
      ["Posts on X", (x) => x.kind === "x", "posts", "$0.015 a post (X's API price, no links)"],
      ["Quality checks (Claude)", (x) => x.what === "check", "checks", "about 2 cents each; a cheaper model past $4.50 a month"],
      ["Post punch-ups (Claude)", (x) => x.what === "punch_up", "rewrites", "Claude rewrites each post before it goes out"],
      ["News takes (Claude)", (x) => x.what === "take", "tries", "the 1 PM take on the day's NFL news"],
    ];
    const checkM = sum((x) => inMonth(x) && x.what === "check");
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Costs</h2><span class="muted">only you can see this · Eastern days</span></div>
      <div class="ad-tiles">${tile(money(td), "today so far")}${tile(money(yd), "yesterday")}${tile(money(wk), "this week (since Monday)")}${tile(money(mtd), "this month so far")}${tile(money(mtd / done), "per day, this month")}${tile(money((mtd / done) * dim), "month at this pace")}</div>
      <h3>By what it's for</h3>
      <div class="table-wrap"><table class="ad-cost"><thead><tr><th>What</th><th class="n">This month</th><th class="n">This week</th><th class="n">Cost this month</th></tr></thead><tbody>
        ${CATS.map(([l, f, unit, note]) => `<tr><td>${esc(l)}<small>${esc(note)}</small></td><td class="n">${r.filter((x) => inMonth(x) && f(x)).length} ${unit}</td>
          <td class="n">${money(sum((x) => dayOf(x) >= mon && f(x)))}</td><td class="n">${money(sum((x) => inMonth(x) && f(x)))}</td></tr>`).join("")}
        ${FIXED.map(([l, v, note]) => `<tr><td>${esc(l)}<small>${esc(note)}</small></td><td class="n">fixed</td><td class="n"></td><td class="n">${v == null ? "?" : money(v)}</td></tr>`).join("")}
      </tbody><tfoot><tr><td>Total</td><td></td><td class="n">${money(wk)}</td><td class="n"><b>${money(mtd + fixed)}${unknown ? " + ?" : ""}</b></td></tr></tfoot></table></div>
      <p class="note">Quality checks this month: ${money(checkM)} of the $4.50 budget${checkM >= 4.5 ? " (on the cheaper model until the 1st)" : ""}.
        Claude calls are counted from Oct 26, 2026; X posts from Oct 1 (from the posting log). These are estimates from list prices; the real bills are at console.anthropic.com (Usage) and the X developer console (Billing). For the "?" rows, tell Claude what you pay and they'll be filled in.</p>
      <div class="ad-chart"><canvas id="ad-cost-chart"></canvas></div></div>`;
    const days = [...Array(done)].map((_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
    drawLater("ad-cost-chart", (C) => ({ type: "bar", data: { labels: days.map((d) => d.slice(5).replace("-", "/")),
      datasets: [["Posts on X", (x) => x.kind === "x", C("--accent")], ["Claude", (x) => x.kind === "claude", "#4cc9f0"]]
        .map(([l, f, c]) => ({ label: l, data: days.map((d) => +sum((x) => dayOf(x) === d && f(x)).toFixed(3)), backgroundColor: c, stack: "s" })) },
      options: { responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        plugins: { legend: { labels: { color: C("--ink") } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: $${c.raw.toFixed(3)}` } } },
        scales: { x: { stacked: true, ticks: { color: C("--muted") }, grid: { color: C("--line") } },
          y: { stacked: true, beginAtZero: true, ticks: { color: C("--muted"), callback: (v) => "$" + v }, grid: { color: C("--line") } } } } }));
  }

  // Chart.js on demand (one copy per canvas)
  const charts = {};
  async function drawLater(id, make) {
    if (!window.Chart) await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = CHART_JS; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }).catch(() => {});
    const cv = document.getElementById(id);
    if (!window.Chart || !cv) return;
    const css = getComputedStyle(document.body), C = (v) => css.getPropertyValue(v).trim();
    charts[id]?.destroy();
    charts[id] = new Chart(cv, make(C));
  }

  async function analytics(db, el) {
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
      el.innerHTML = `<div class="card"><h2>Analytics</h2><p>${rulesNote(e)}</p></div>`;
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
    drawLater("ad-chart", (C) => ({ type: "line", data: { labels: days.slice(-30).map((d) => d.slice(5).replace("-", "/")),
      datasets: [["visitors", "Visitors", C("--accent")], ["newVisitors", "New visitors", "#4cc9f0"], ["charts", "Charts made", "#b5e48c"]]
        .map(([k, l, c]) => ({ label: l, data: series(k).slice(-30), borderColor: c, backgroundColor: c, tension: 0.25, pointRadius: 2 })) },
      options: { responsive: true, maintainAspectRatio: false, devicePixelRatio: Math.max(2, window.devicePixelRatio || 1),
        plugins: { legend: { labels: { color: C("--ink") } } },
        scales: { x: { ticks: { color: C("--muted") }, grid: { color: C("--line") } }, y: { beginAtZero: true, ticks: { color: C("--muted"), precision: 0 }, grid: { color: C("--line") } } } } }));
  }

  return { render };
})();
