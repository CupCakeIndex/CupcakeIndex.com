// Admin page (#/admin): only for thecupcakeindex.support@gmail.com, signed in with Google. The database rules
// (firestore.rules) enforce it too, so nobody else can read anything here even from the browser console, and none of
// it is in the public repo or the site's files: this week's posts (admin_brief, src/social/brief.py), the cost log and
// quality checks (admin_ledger, src/social/ledger.py + check_post.py), the fixed costs Terry types in
// (admin_settings/costs), and the visitor analytics below. The page opens on a dashboard of tiles (Terry's sketch,
// Oct 26): Alerts, Costs, Analytics, Calendar, Next post, Right now; tap one to open its full section under it.
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
    el.innerHTML = `<div class="ad-dash">${DASH.map(([id, label]) => `<button type="button" class="ad-dt" data-sec="${id}" aria-expanded="false">
        <h3>${label}</h3><div class="ad-dv"><span class="muted">Loading…</span></div></button>`).join("")}</div>
      ${["alerts", "costs", "analytics", "posts"].map((id) => `<div id="ad-${id}" class="ad-sec" hidden></div>`).join("")}`;
    el.querySelectorAll(".ad-dt").forEach((b) => b.addEventListener("click", () => open(b.dataset.sec)));
    const today = day(new Date()), t = new Date(today + "T12:00:00");
    const mon = day(new Date(t.getTime() - ((t.getDay() + 6) % 7) * 864e5));
    const from = [today.slice(0, 8) + "01", mon].sort()[0]; // the month so far, or this week if it began last month
    let rows = null, err = null, fixed = {};
    try { rows = await ledger(from); } catch (e) { err = e; }
    // your typed-in costs: the database's copy, else this device's (costs() keeps one in case the database says no)
    try { fixed = JSON.parse(localStorage.getItem("ad-costs") || "{}"); } catch (e) { fixed = {}; }
    try { fixed = { ...fixed, ...((await db.collection("admin_settings").doc("costs").get()).data() || {}) }; } catch (e) { /* keep this device's */ }
    const cal = posts(db, $("#ad-posts"), mon, today, rows, err);
    costs(db, $("#ad-costs"), today, mon, rows, err, fixed, await chatCosts());
    analytics(db, $("#ad-analytics"));
    alerts($("#ad-alerts"), await cal);
    const was = sessionStorage.getItem("ad-open");
    if (was && was !== "next") open(was, false);
  }

  // ---------- the dashboard: tiles that open their section ----------
  const DASH = [["alerts", "Alerts"], ["costs", "Costs"], ["analytics", "Analytics"], ["posts", "Calendar"], ["next", "Next post"], ["now", "Right now"]];
  const tile = (id, html, cls = "") => {
    const b = document.querySelector(`.ad-dt[data-sec="${id}"]`);
    if (!b) return;
    b.querySelector(".ad-dv").innerHTML = html;
    b.classList.toggle("bad", cls === "bad");
    b.classList.toggle("good", cls === "good");
  };
  let openPost = null, nextPost = null; // set by posts(): opens one calendar entry's preview; the next one to go out
  function open(id, scroll = true) {
    if (id === "next") { if (nextPost && openPost) openPost(nextPost); else open("posts", scroll); return; }
    const sec = id === "now" ? "analytics" : id;
    const box = $(`#ad-${sec}`), shut = box && !box.hidden;
    document.querySelectorAll(".ad-sec").forEach((x) => { x.hidden = true; });
    document.querySelectorAll(".ad-dt").forEach((x) => x.setAttribute("aria-expanded", "false"));
    if (!box || shut) { sessionStorage.removeItem("ad-open"); return; }
    box.hidden = false;
    document.querySelector(`.ad-dt[data-sec="${id}"]`)?.setAttribute("aria-expanded", "true");
    sessionStorage.setItem("ad-open", id);
    if (sec === "posts") { // the week scrolls sideways: start at today
      const wk = box.querySelector(".ad-week"), col = wk?.querySelector(".ad-day.today");
      if (col) wk.scrollLeft = Math.max(0, col.getBoundingClientRect().left - wk.getBoundingClientRect().left + wk.scrollLeft);
    }
    if (scroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- alerts: posts the check stopped, previews that failed, GitHub jobs whose last run failed ----------
  const REPO = "CupCakeIndex/CupcakeIndex.com";
  async function failedJobs() {
    // the repo is public, so its Actions history is too: no key needed. Newest first; a job counts while its latest
    // finished run is a failure from the last 7 days (a later success clears it).
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?per_page=100&exclude_pull_requests=true`);
      if (!r.ok) return null;
      const latest = {};
      for (const x of (await r.json()).workflow_runs || []) if (x.status === "completed" && !latest[x.workflow_id]) latest[x.workflow_id] = x;
      return Object.values(latest).filter((x) => x.conclusion === "failure" && Date.now() - new Date(x.updated_at) < 7 * 864e5);
    } catch (e) { return null; }
  }
  async function alerts(el, cal) {
    const jobs = await failedJobs();
    const seen = new Set(JSON.parse(localStorage.getItem("ad-seen") || "[]"));
    const list = [];
    if (cal.err) list.push({ id: "rules", title: "Can't read the admin data", why: rulesNote(cal.err), html: true });
    if (cal.stale) list.push({ id: "brief-" + cal.today, title: "Today's post previews weren't made",
      why: `The 7 AM "Morning post brief" job didn't run (or hasn't yet). GitHub > Actions > Morning post brief > Run workflow.` });
    for (const e of cal.all || []) {
      if (e.status === "blocked") list.push({ id: `p-${e.day}-${e.t}-${e.title}-blocked`, title: `Stopped by the check: ${e.title}`, when: e, why: e.reason, post: e });
      if (e.status === "error") list.push({ id: `p-${e.day}-${e.t}-${e.title}-error`, title: `Preview failed: ${e.title}`, when: e, why: e.reason, post: e });
    }
    for (const j of jobs || []) list.push({ id: "gh-" + j.id, title: `GitHub job failed: ${j.name}`, at: j.updated_at,
      why: "Its last run failed. Open it to see the error, or tell Claude.", url: j.html_url });
    const fresh = list.filter((a) => !seen.has(a.id));
    const missed = (cal.all || []).filter((e) => e.status === "missed");
    tile("alerts", `<b class="ad-big">${fresh.length}</b><small>${fresh.length ? (fresh.length === 1 ? "new problem" : "new problems") : "all clear"}</small>`, fresh.length ? "bad" : "good");
    const when = (a) => a.when ? `${new Date(a.when.day + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" })} ${a.when.t ? time12(a.when.t) : ""}`
      : a.at ? new Date(a.at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
    const row = (a, i) => `<li class="ad-al${seen.has(a.id) ? " seen" : ""}"><div><b>${esc(a.title)}</b> <span class="muted">${esc(when(a))}</span>
        ${a.why ? `<p>${a.html ? a.why : esc(a.why)}</p>` : ""}</div>
        ${a.post ? `<button type="button" class="btn" data-a="${i}">See the post</button>` : a.url ? `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}</li>`;
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Alerts</h2><span class="muted">this week · only you can see this</span>
        ${fresh.length ? `<button type="button" class="btn ad-seen">Mark all as seen</button>` : ""}</div>
      ${list.length ? `<ul class="ad-alerts">${list.map(row).join("")}</ul>` : `<p>Nothing wrong this week: every post passed the check, every preview worked, and every GitHub job's last run went fine.</p>`}
      ${jobs == null ? `<p class="note">Couldn't reach GitHub to check the jobs this time.</p>` : ""}
      ${missed.length ? `<h3>Didn't post <span class="muted">not counted: often on purpose (the day's post limit, or nothing new to say)</span></h3>
        <ul class="ad-alerts">${missed.map((e) => `<li class="ad-al seen"><div><b>${esc(e.title)}</b> <span class="muted">${esc(when({ when: e }))}</span></div></li>`).join("")}</ul>` : ""}
    </div>`;
    el.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => openPost?.(list[+b.dataset.a].post)));
    el.querySelector(".ad-seen")?.addEventListener("click", () => {
      localStorage.setItem("ad-seen", JSON.stringify([...new Set([...seen, ...list.map((a) => a.id)])].slice(-300)));
      alerts(el, cal);
    });
  }
  const time12 = (x) => { if (!x) return ""; const h = +x.slice(0, 2); return `${h % 12 || 12}:${x.slice(3)} ${h < 12 ? "AM" : "PM"}`; };

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
    if (err) {
      el.innerHTML = `<div class="card"><h2>Posts this week</h2><p>${rulesNote(err)}</p></div>`;
      tile("posts", `<span class="muted">Couldn't read it</span>`, "bad");
      tile("next", `<span class="muted">Couldn't read it</span>`);
      return { err, all: [], today };
    }
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
    // the preview window sits at the page level: inside the Calendar section it would open invisibly (and block the
    // page) whenever that section is closed, e.g. from the Next post tile or an alert
    const dlg = el.querySelector(".ad-dlg"), inner = dlg.querySelector(".ad-dlg-in");
    document.querySelectorAll("#view-admin > .ad-dlg").forEach((d) => d.remove());
    $("#view-admin").appendChild(dlg);
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg || ev.target.closest("[data-close]")) dlg.close(); });
    const pic = (b64) => `<img alt="The post's picture" src="data:image/jpeg;base64,${b64}">`;
    el.querySelectorAll(".ad-p").forEach((b) => b.addEventListener("click", () => openPost(all[+b.dataset.i])));
    openPost = async (e) => {
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
    };
    // the Calendar and Next post tiles
    const td = items[today] || [], out = td.filter((e) => e.status === "posted").length;
    const ahead = td.filter((e) => (e.status === "scheduled" || e.status === "planned") && e.t && mins(e.t) >= nowM);
    nextPost = ahead.find((e) => !e.maybe && e.status === "planned") || ahead.find((e) => e.status === "planned") || ahead[0] || null;
    tile("posts", `<b class="ad-big">${out}</b><small>posted today · ${ahead.length} still to come</small>`);
    tile("next", nextPost ? `<b class="ad-mid">${time12(nextPost.t)}</b><small>${esc(nextPost.title)}${nextPost.maybe ? " (only if)" : ""}</small>
      ${nextPost.text ? `<span class="ad-snip">${esc(nextPost.text)}</span>` : ""}` : `<span class="muted">Nothing else today</span>`);
    const m = +today.slice(5, 7), stale = (m >= 8 || m === 1) && nowM > 7 * 60 + 30 && !brief[today]?.preview;
    return { all, today, stale };
  }

  // ---------- what it all costs (src/social/ledger.py), plus the fixed costs ----------
  // [label, dollars a month (null = not known yet), note, the key Terry's own number is saved under, its period]
  // Keyed ones are typed in on this page and saved to admin_settings/costs (owner only); the domain is typed per year.
  // the Analyst chat's Claude bill: its Worker counts every member's cost in Cloudflare and adds it up for the owner
  // (workers/analyst.js /admin). null = couldn't get it (most likely the Worker code there is older than this page).
  async function chatCosts() {
    try {
      const r = await fetch(CHAT + "/admin",
        { headers: { Authorization: `Bearer ${await firebase.auth().currentUser.getIdToken()}` } });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }
  const FIXED = [
    ["X Premium (@CupcakeIndex)", null, "your X subscription", "xPremium", "month"],
    ["cupcakeindex.com domain", null, "yearly renewal, shown per month", "domainYear", "year"],
    ["Firebase (accounts, alerts, analytics)", 0, "free Spark plan"],
    ["GitHub (site + all the automatic jobs)", 0, "free for a public repo"],
    ["CollegeFootballData", 0, "free plan"],
    ["Cloudflare (runs the Analyst chat)", 0, "free plan"],
  ];
  // the chat's cost against what comes in: each tier's paying subscribers × its price, minus Stripe's cut, counted by
  // the chat's Worker (workers/analyst.js /admin, from Stripe's webhook). Free members (its MEMBERS list) are a cost line.
  // Totals only, no emails.
  // Green +$ = profit, red = the chat costs more than comes in.
  const CHAT = "https://cupcake-analyst.thecupcakeindex-support.workers.dev";
  const moneyIn = (chat) => (chat?.tiers || []).reduce((a, t) => a + t.in, 0);
  // a net total: costs minus what comes in. Below zero is a profit: green, with a +
  const net = (n, q = "") => n > 0 ? `${money(n)}${q}` : `<span class="up">+${money(-n)}${q}</span>`;
  function subRow(chat, used) {
    if (!chat.tiers) return `<tr class="ad-sub"><td colspan="4"><small>Money in vs the chat's cost needs the newest
      workers/analyst.js in Cloudflare (Workers > cupcake-analyst > Edit code > Deploy).</small></td></tr>`;
    const inn = moneyIn(chat), profit = inn - used, pct = inn ? used / inn * 100 : used ? 100 : 0;
    const diff = (n) => `<b class="${n >= 0 ? "up" : "down"}">${n >= 0 ? "+" : "−"}${money(Math.abs(n))}</b>`;
    return `<tr class="ad-sub"><td colspan="4"><div class="ad-sub-top"><span>Money in vs the chat's cost <span class="muted">this month</span></span></div>
      <div class="ad-sub-bar${profit < 0 ? " over" : ""}"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></div>
      <ul class="ad-subs">${chat.tiers.map((t) => `<li><span>${esc(t.name)} contributions <span class="muted">$${t.price} a month</span></span>
        <span class="muted">${num(t.members)} ${t.members === 1 ? "member" : "members"} · ${money(t.in)} in after Stripe's cut${t.gross ? ` (of ${money(t.gross)})` : ""} · used ${money(t.usd)}</span>${diff(t.in - t.usd)}</li>`).join("")}
        ${chat.comped?.members || chat.comped?.usd ? `<li><span>Free members <span class="muted">your MEMBERS list, not paying</span></span>
          <span class="muted">${num(chat.comped.members)} ${chat.comped.members === 1 ? "member" : "members"} · ${num(chat.comped.questions)} questions · used ${money(chat.comped.usd)}</span>${diff(-chat.comped.usd)}</li>` : ""}
        ${chat.owner?.usd ? `<li><span>Your own use <span class="muted">free, not a subscription</span></span>
          <span class="muted">${num(chat.owner.questions)} questions · used ${money(chat.owner.usd)}</span>${diff(-chat.owner.usd)}</li>` : ""}</ul>
      ${chat.test_subs?.members ? `<ul class="ad-subs"><li><span>Test subscriptions <span class="muted">Stripe test mode, not real money</span></span>
        <span class="muted">${num(chat.test_subs.members)} test ${chat.test_subs.members === 1 ? "card" : "cards"} · ${num(chat.test_subs.questions)} questions · used ${money(chat.test_subs.usd)}</span><b class="${chat.test_subs.usd ? "down" : "up"}">${chat.test_subs.usd ? "−" + money(chat.test_subs.usd) : money(0)}</b></li></ul>` : ""}
      ${chat.unsorted?.usd ? `<small>${money(chat.unsorted.usd)} of the cost is from questions asked before the chat kept track of who asked.</small>` : ""}</td></tr>`;
  }
  function costs(db, el, today, mon, rows, err, mine = {}, chat = null) {
    if (err) {
      el.innerHTML = `<div class="card"><h2>Costs</h2><p>${rulesNote(err)}</p></div>`;
      tile("costs", `<span class="muted">Couldn't read it</span>`, "bad");
      return;
    }
    const FX = FIXED.map(([l, v, note, k, per]) => {
      const typed = k && typeof mine[k] === "number" ? mine[k] : null;
      return [l, typed == null ? v : per === "year" ? typed / 12 : typed, note, k, per, typed];
    });
    const month = today.slice(0, 7), r = rows.filter((x) => x.usd);
    const dayOf = (x) => day(new Date(x.at));
    const sum = (f) => r.filter(f).reduce((a, x) => a + x.usd, 0);
    const inMonth = (x) => dayOf(x).startsWith(month);
    const t = new Date(today + "T12:00:00"), dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(), done = t.getDate();
    // the chat's days (Eastern, like ours), this month only
    const cd = Object.entries(chat?.month === month ? chat.days || {} : {});
    const chatSum = (f, k = "usd") => cd.filter(([d]) => f(d)).reduce((a, [, x]) => a + (x[k] || 0), 0);
    const ydDay = day(new Date(t.getTime() - 864e5));
    const mtdChat = chatSum(() => true), wkChat = chatSum((d) => d >= mon);
    const mtd = sum(inMonth) + mtdChat, wk = sum((x) => dayOf(x) >= mon) + wkChat, td = sum((x) => dayOf(x) === today) + chatSum((d) => d === today);
    const yd = sum((x) => dayOf(x) === ydDay) + chatSum((d) => d === ydDay);
    const fixed = FX.reduce((a, f) => a + (f[1] || 0), 0), unknown = FX.some((f) => f[1] == null), inn = moneyIn(chat);
    tile("costs", `<b class="ad-big">${net(mtd + fixed - inn, unknown || !chat ? "+" : "")}</b><small>this month so far, fixed costs included${inn ? `, minus ${money(inn)} in` : ""} · today ${money(td)}</small>`);
    const tile2 = (big, label) => `<div class="ad-tile"><b>${big}</b><small>${esc(label)}</small></div>`;
    const CATS = [
      ["Posts on X", (x) => x.kind === "x", "posts", "$0.015 a post (X's API price, no links)"],
      ["Quality checks (Claude)", (x) => x.what === "check", "checks", "about 2 cents each; a cheaper model past $4.50 a month"],
      ["Post punch-ups (Claude)", (x) => x.what === "punch_up", "rewrites", "Claude rewrites each post before it goes out"],
      ["News takes (Claude)", (x) => x.what === "take", "tries", "the 1 PM take on the day's NFL news"],
    ];
    const checkM = sum((x) => inMonth(x) && x.what === "check");
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Costs</h2><span class="muted">only you can see this · Eastern days</span></div>
      <div class="ad-tiles">${tile2(money(td), "today so far")}${tile2(money(yd), "yesterday")}${tile2(money(wk), "this week (since Monday)")}${tile2(money(mtd), "this month so far")}${tile2(money(mtd / done), "per day, this month")}${tile2(money((mtd / done) * dim), "month at this pace")}</div>
      <h3>By what it's for</h3>
      <div class="table-wrap"><table class="ad-cost"><thead><tr><th>What</th><th class="n">This month</th><th class="n">This week</th><th class="n">Cost this month</th></tr></thead><tbody>
        ${CATS.map(([l, f, unit, note]) => `<tr><td>${esc(l)}<small>${esc(note)}</small></td><td class="n">${r.filter((x) => inMonth(x) && f(x)).length} ${unit}</td>
          <td class="n">${money(sum((x) => dayOf(x) >= mon && f(x)))}</td><td class="n">${money(sum((x) => inMonth(x) && f(x)))}</td></tr>`).join("")}
        <tr><td>Analyst chat (Claude)<small>${chat ? `members' questions, pictures included; $5 of Claude a month at most per person`
          : "couldn't reach the chat's counter: re-paste workers/analyst.js into Cloudflare (Workers > cupcake-analyst > Edit code > Deploy)"}</small></td>
          <td class="n">${chat ? `${num(chatSum(() => true, "q"))} questions${chat.takes ? `<small>${num(chat.takes)} take checks</small>` : ""}` : "?"}</td><td class="n">${chat ? money(wkChat) : "?"}</td><td class="n">${chat ? money(mtdChat) : "?"}</td></tr>
        ${chat ? subRow(chat, mtdChat) : ""}
        ${FX.map(([l, v, note, k, per, typed]) => `<tr><td>${esc(l)}<small>${esc(note)}</small>${k ? `<label class="ad-fx">$<input type="number" min="0" step="0.01" inputmode="decimal"
            data-k="${k}" value="${typed ?? ""}" placeholder="?" aria-label="${esc(l)}, dollars a ${per}"> a ${per}</label>` : ""}</td>
          <td class="n">fixed</td><td class="n"></td><td class="n">${v == null ? "?" : money(v)}</td></tr>`).join("")}
      ${inn ? `<tr><td>Money in: Analyst subscriptions<small>every tier's paying members × its price, after Stripe's cut; takes away from the total</small></td>
          <td class="n">${num(chat.tiers.reduce((a, t) => a + t.members, 0))} paying</td><td class="n"></td><td class="n"><span class="up">−${money(inn)}</span></td></tr>` : ""}
      </tbody><tfoot><tr><td>Total${inn ? " after money in" : ""}</td><td></td><td class="n">${money(wk)}</td><td class="n"><b>${net(mtd + fixed - inn, unknown || !chat ? " + ?" : "")}</b></td></tr></tfoot></table></div>
      <p class="ad-fx-row"><button type="button" class="btn ad-fx-save">Save my costs</button> <span class="muted ad-fx-msg">Type what you pay for X Premium and the domain; it saves when you leave the box.</span></p>
      <p class="note">Quality checks this month: ${money(checkM)} of the $4.50 budget${checkM >= 4.5 ? " (on the cheaper model until the 1st)" : ""}.
        Claude calls are counted from Oct 26, 2026; X posts from Oct 1 (from the posting log). These are estimates from list prices; the real bills are at console.anthropic.com (Usage) and the X developer console (Billing).</p>
      <div class="ad-chart"><canvas id="ad-cost-chart"></canvas></div></div>`;
    // saves when you leave a box (or tap Save). The totals update right away from this device's copy, even if the
    // database won't take it yet (rules not published): then it says so, and the number stays on this device.
    let saving = false;
    const save = async () => {
      if (saving) return;
      const msg = el.querySelector(".ad-fx-msg"), got = {}, keep = { ...mine };
      for (const i of el.querySelectorAll(".ad-fx input")) {
        const v = i.value.replace(/[$,\s]/g, "");
        if (v !== "" && !(+v >= 0)) { msg.textContent = "Numbers only, like 8 or 12.99."; return; }
        if (v === "") delete keep[i.dataset.k]; else keep[i.dataset.k] = Math.round(+v * 100) / 100;
        got[i.dataset.k] = v === "" ? firebase.firestore.FieldValue.delete() : keep[i.dataset.k];
      }
      if (FIXED.every(([, , , k]) => !k || keep[k] === mine[k])) return; // nothing changed
      saving = true;
      localStorage.setItem("ad-costs", JSON.stringify(keep));
      let note = "Saved.";
      try { await db.collection("admin_settings").doc("costs").set(got, { merge: true }); } catch (e) {
        note = `Saved on this device only: the database said no (${esc(e.code || e.message)}). To keep it on your phone and PC both, paste firestore.rules into Firebase console > Firestore Database > Rules > Publish, then type it again.`;
      }
      costs(db, el, today, mon, rows, err, keep);
      el.querySelector(".ad-fx-msg").innerHTML = note;
    };
    el.querySelectorAll(".ad-fx input").forEach((i) => {
      i.addEventListener("change", save);
      i.addEventListener("keydown", (ev) => { if (ev.key === "Enter") i.blur(); });
    });
    el.querySelector(".ad-fx-save").addEventListener("click", save);
    const days = [...Array(done)].map((_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
    drawLater("ad-cost-chart", (C) => ({ type: "bar", data: { labels: days.map((d) => d.slice(5).replace("-", "/")),
      datasets: [["Posts on X", (x) => x.kind === "x", C("--accent")], ["Claude", (x) => x.kind === "claude", "#4cc9f0"]]
        .map(([l, f, c]) => ({ label: l, data: days.map((d) => +sum((x) => dayOf(x) === d && f(x)).toFixed(3)), backgroundColor: c, stack: "s" }))
        .concat(chat ? [{ label: "Analyst chat", data: days.map((d) => +chatSum((x) => x === d).toFixed(3)), backgroundColor: "#b388ff", stack: "s" }] : []) },
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
      tile("analytics", `<span class="muted">Couldn't read it</span>`, "bad");
      tile("now", `<span class="muted">Couldn't read it</span>`, "bad");
      return;
    }
    const by = Object.fromEntries(rows.docs.map((d) => [d.id, d.data()]));
    const series = (k) => days.map((d) => by[d]?.[k] || 0);
    // dashboard: the last three days' visitors as little bars, and who's here right now
    const last3 = days.slice(-3).map((d, i) => [new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }), series("visitors").slice(-3)[i]]);
    const top = Math.max(1, ...last3.map((x) => x[1]));
    tile("analytics", `<div class="ad-mini">${last3.map(([l, v]) => `<div><i><span style="height:${Math.max(2, Math.round((100 * v) / top))}%"></span></i><b>${num(v)}</b><small>${l}</small></div>`).join("")}</div>
      <small>visitors, last 3 days</small>`);
    tile("now", `<b class="ad-big">${num(live)}</b><small>on the site now · ${num(accounts)} accounts · ${num(devices)} alert devices</small>`);
    // total of the last n days (back = 0), or of the n days before that (back = 1)
    const sum = (k, n, back = 0) => series(k).slice(days.length - n * (back + 1), days.length - n * back).reduce((a, b) => a + b, 0);
    // change vs the period before: "+12 · +15%" (no % when the period before was 0)
    const delta = (now, then) => {
      const d = now - then, cls = d > 0 ? "up" : d < 0 ? "down" : "";
      const pct = then ? ` · ${d >= 0 ? "+" : ""}${Math.round((100 * d) / then)}%` : "";
      return `<i class="ad-d ${cls}">${d >= 0 ? "+" : ""}${num(d)}${pct}</i>`;
    };
    const tile2 = (big, label, change = "") => `<div class="ad-tile"><b>${big}</b>${change}<small>${esc(label)}</small></div>`;
    const KEYS = [["visitors", "visitors"], ["newVisitors", "new visitors"], ["views", "page views"], ["charts", "charts made"], ["downloads", "charts downloaded"]];
    const row = (n) => KEYS.map(([k, l]) => tile2(num(sum(k, n)), n === 30 && k === "visitors" ? "visits (one per person per day)" : l, delta(sum(k, n), sum(k, n, 1)))).join("");
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>Analytics</h2><span class="muted">only you can see this · Eastern time</span></div>
      <h3>Right now</h3><div class="ad-tiles">${tile2(num(live), "on the site now (last 5 min)")}${tile2(num(accounts), "accounts")}${tile2(num(devices), "devices with alerts on")}</div>
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
