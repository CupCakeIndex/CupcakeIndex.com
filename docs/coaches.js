// Coaches: head coach rankings from docs/data/coaches.json (src/coaches.py). Career or the last 3 seasons,
// current coaches or everyone in our data, every column sortable. The Coach score is explained under the table.
// Each coach also has a page (#/coach/<slug>): hot seat (src/hot_seat.py), stats, season by season, and his coaching
// tree from docs/data/coach_tree.json (src/coach_tree.py). Team pages show the head coach (forTeam).
const Coaches = (() => {
  let D = null, T = null, TREE = null;
  const load = async () => {
    if (!D) [D, T] = await Promise.all([getJSON("data/coaches.json").catch(() => ({})), getJSON("data/teams.json").catch(() => ({}))]);
  };
  const loadTree = async () => { if (!TREE) TREE = await getJSON("data/coach_tree.json").catch(() => ({ people: {}, edges: [] })); };
  // same as slug() in src/coach_tree.py
  const slug = (n) => (n || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const SEAT = { hot: "Hot seat", teeter: "Teetering", safe: "Safe" };
  const seatChip = (hs, small = false) => hs ? `<span class="seat seat-${hs.lab}${small ? " sm" : ""}" title="${esc(SEAT[hs.lab])}: ${Math.round(100 * hs.p)}% chance he's out after this season (our estimate)">${esc(SEAT[hs.lab])}${small ? "" : ` <small>${Math.round(100 * hs.p)}%</small>`}</span>` : "";
  const pct = (w, l) => (w + l ? w / (w + l) : null);
  const f1 = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1));
  // [key, header, tooltip, value to sort by (higher = better first), cell]
  const COLS = [
    ["score", "Score", "Coach score, 0–100 (50 = average). How it works is under the table.", (s) => s.score ?? -1, (s) => (s.score == null ? `<span class="muted" title="Not enough games yet">—</span>` : `<b>${s.score}</b>`)],
    ["pct", "Record", "Wins and losses (ties after the second dash). Sorts by win %.", (s) => s.pct ?? -1, (s) => `${s.w}-${s.l}${s.t ? "-" + s.t : ""}<small class="muted"> ${s.pct == null ? "" : s.pct.toFixed(3).replace(/^0/, "")}</small>`],
    ["good", "Vs winning teams", "Record against teams that finished with a winning record that season", (s) => pct(s.gw, s.gl) ?? -1, (s) => `${s.gw}-${s.gl}`],
    ["woe", "Wins over exp.", "Wins over expected per season. NFL: compared with the books' lines going in. College: compared with how good both teams were the year before.", (s) => s.woe_s ?? -99, (s) => f1(s.woe_s)],
    ["post", "Postseason", "Playoff record (college: bowls and the playoff)", (s) => s.pw + 0.01 * pct(s.pw, s.pl), (s) => `${s.pw}-${s.pl}`],
    ["ti", "Titles", "Super Bowls / national titles in our data", (s) => s.ti, (s) => (s.ti ? `<b>${s.ti}</b>` : `<span class="muted">0</span>`)],
    ["one", "One-score", "Record in games decided by 8 points or less", (s) => pct(s.ow, s.ol) ?? -1, (s) => `${s.ow}-${s.ol}`],
    ["lift", "Team lift", "His teams' win % minus that team's win % the year before he got there (percentage points)", (s) => s.lift ?? -99, (s) => (s.lift == null ? "—" : f1(s.lift))],
    ["cup", "Cupcake wins", "Share of his wins against teams with a losing record (and FCS teams in college). Lower is better.", (s) => -(s.cup ?? 101), (s) => (s.cup == null ? "—" : s.cup + "%")],
    ["yrs", "Seasons", "Seasons as a head coach in our data", (s) => s.yrs, (s) => `${s.yrs}<small class="muted"> ${s.y1 === s.y2 ? s.y1 : `${s.y1}–${String(s.y2).slice(2)}`}</small>`],
  ];

  function team(lg, key) {
    const list = T[lg] || [];
    return list.find((t) => (lg === "nfl" ? t.abbr === key : t.name === key)) || { name: key, abbr: key };
  }

  async function render(params) {
    const el = $("#view-coaches");
    if (!D) el.innerHTML = `<div class="card muted">Loading…</div>`;
    await load();
    const lg = league, L = D[lg];
    const scope = ["c", "r"].includes(params.get("scope")) ? params.get("scope") : "t", all = params.get("all") === "1"; // t = current team
    const sort = COLS.some(([k]) => k === params.get("sort")) || ["edge", "seat"].includes(params.get("sort")) ? params.get("sort") : "score";
    const dir = params.get("dir") === "asc" ? -1 : 1;
    const go = (ch) => {
      const p = new URLSearchParams(params);
      Object.entries(ch).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.set("league", lg);
      location.hash = `#/coaches?${p}`;
    };
    const head = `<h2>Coach rankings</h2><p class="muted co-sub">Bullying cupcakes isn't a résumé. Coaching wins are worth more against good teams.</p>`;
    if (!L) {
      el.innerHTML = head + `<div class="card">${lg === "cfb" ? "College coach rankings show up after the next data update (it needs the list of who coached where, from CollegeFootballData)." : "Couldn't load the coach rankings. Try again in a minute."} </div>`;
      return;
    }
    const edgeCol = lg === "nfl" && !all;
    const seatCol = ["seat", "Seat", "Hot seat: our estimate of his chance of being out after this season (Safe under 15%, Teetering 15–35%, Hot seat 35%+). Current coaches only.", (s, c) => c.hs?.p ?? -1, (s, c) => seatChip(c.hs, true) || `<span class="muted">—</span>`];
    const base = all ? COLS : [COLS[0], seatCol, ...COLS.slice(1)];
    const cols = edgeCol ? [...base.slice(0, 5), ["edge", "Rating boost", "What our NFL model adds to his team's power rating for him, in points (his teams' record against expectations in past seasons, shrunk for coaches with few games)", (s, c) => c.edge ?? -99, (s, c) => f1(c.edge)], ...base.slice(5)] : base;
    const col = cols.find(([k]) => k === sort) || cols[0];
    const rows = L.coaches.filter((c) => (all || c.on) && c[scope])
      .sort((a, b) => dir * (col[3](b[scope], b) - col[3](a[scope], a)) || (b[scope].score ?? -1) - (a[scope].score ?? -1) || b[scope].g - a[scope].g);
    const seg = (id, opts, v) => `<div class="presets" id="${id}">${opts.map(([k, l]) => `<button data-v="${k}" class="${k === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const th = ([k, l, tip]) => `<th class="num sortable${k === sort ? " on" : ""}" data-sort="${k}" title="${esc(tip)}">${esc(l)}${k === sort ? (dir > 0 ? " ▼" : " ▲") : ""}</th>`;
    const who = (c) => {
      const t = team(lg, c.tm), teams = new Set(c.st.map((s) => s[0])).size;
      return `<div class="team">${logo(t)}<div><a href="${link("coach", slug(c.n))}"><b>${esc(c.n)}</b></a>
        <small>${t.id ? `<a href="#/team/${esc(t.id)}?league=${lg}">${esc(lg === "nfl" ? t.abbr : t.name)}</a>` : esc(c.tm)}${c.on ? "" : " (last team)"}${teams > 1 ? ` · ${teams} teams` : ""}</small></div></div>`;
    };
    const min = { nfl: { c: 34, r: 17, t: 17 }, cfb: { c: 24, r: 12, t: 12 } }[lg][scope];
    el.innerHTML = head + `
      <div class="sc-bar co-bar">
        ${seg("co-all", [["", "Current coaches"], ["1", `Everyone since ${L.from}`]], all ? "1" : "")}
        ${seg("co-scope", [["t", all ? "Current/last team" : "Current team"], ["c", "All time"], ["r", "Last 3 seasons"]], scope)}
        <input id="co-search" type="search" placeholder="Filter coach or team…">
      </div>
      <div class="table-wrap"><table id="co-table"><thead><tr><th class="num">#</th><th>Coach</th>${cols.map(th).join("")}</tr></thead>
        <tbody>${rows.map((c, i) => `<tr data-name="${esc((c.n + " " + c.st.map((s) => s[0]).join(" ")).toLowerCase())}"><td class="num muted">${i + 1}</td><td>${who(c)}</td>
          ${cols.map(([k, , , , cell]) => `<td class="num${k === sort ? " on" : ""}">${cell(c[scope], c)}</td>`).join("")}</tr>`).join("")
          || `<tr><td colspan="${cols.length + 2}" class="muted">No coaches.</td></tr>`}</tbody></table></div>
      <div class="card prose co-how">
        <h3>How the Coach score works</h3>
        <p>It's 0 to 100, and 50 is an average head coach. ${{ t: "Only his games with his current team", c: "His whole career", r: "Last 3 seasons only" }[scope]}, and a coach needs ${min} games to get one.</p>
        <ul>
          <li><b>35% wins over expected.</b> ${lg === "nfl" ? "How many more games his teams won than the books' lines said they would." : "How many more games his teams won than you'd expect from how good both teams were the year before. Did he beat where the program was?"}</li>
          <li><b>30% record vs winning teams.</b> Beating good teams is what counts. A short record gets pulled toward average.</li>
          <li><b>15% postseason wins</b> per season.</li>
          <li><b>10% team lift.</b> How much better his teams did than the team did the year before he got there.</li>
          <li><b>10% cupcake padding, which counts against him.</b> The share of his wins against losing teams${lg === "cfb" ? " and FCS teams" : ""}.</li>
        </ul>
        ${lg === "nfl" ? `<p><b>Rating boost</b> is what the coach adds to his team's power rating in our NFL model, in points. It comes from his teams' record against expectations in past seasons, shrunk for coaches with few games. In our tests on 2013–2025 it made the win chances a little sharper.</p>` : ""}
        <p class="muted">Data: ${lg === "nfl" ? `every NFL game since ${L.from} (nflverse)` : `every FBS game since ${L.from} (CollegeFootballData)`}, including the playoffs. Click a column to sort by it.</p>
      </div>`;
    $("#co-all").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) go({ all: b.dataset.v }); };
    $("#co-scope").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) go({ scope: b.dataset.v === "t" ? null : b.dataset.v }); };
    el.querySelector("#co-table thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.sort;
      if (k) go({ sort: k === "score" ? null : k, dir: k === sort && dir > 0 ? "asc" : null });
    };
    $("#co-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      el.querySelectorAll("#co-table tbody tr").forEach((tr) => tr.classList.toggle("hidden", !!q && !(tr.dataset.name || "").includes(q)));
    };
  }

  // for Stats > Visualize: {team key: coach stats} for one season, keyed like the chart data (NFL abbr, college name)
  async function forSeason(lg, season) {
    await load();
    const out = {};
    for (const c of D[lg]?.coaches || []) {
      const s = c.st.find(([, a, b]) => a <= season && season <= b);
      if (s && c.c) out[s[0]] = { co_name: c.n, co_score: c.c.score, co_pct: c.c.pct == null ? null : 100 * c.c.pct, co_good: pct(c.c.gw, c.c.gl) == null ? null : 100 * pct(c.c.gw, c.c.gl), co_woe: c.c.woe_s, co_yrs: c.c.yrs, co_edge: c.edge };
    }
    return out;
  }

  // ---------------------------------------------------------------- one coach's page
  const yrs = (a, b) => (a === b ? `${a}` : `${a}–${String(b).slice(2)}`);
  const initials = (n) => (n || "").split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const pic = (p, n, cls = "") => (safeUrl(p?.img) ? `<img class="co-face ${cls}" src="${esc(p.img)}" alt="" loading="lazy" decoding="async">`
    : `<span class="co-face ph ${cls}">${esc(initials(n))}</span>`);
  const teamName = (lg, key) => team(lg, key).name || key;
  const teamLink = (lg, key) => { const t = team(lg, key); return t.id ? `<a href="#/team/${esc(t.id)}?league=${lg}">${logo(t)} ${esc(teamName(lg, key))}</a>` : esc(key); };
  function findCoach(s) { // [[league, coach]] for every league he was a head coach in, his current job first
    return ["nfl", "cfb"].map((lg) => [lg, (D[lg]?.coaches || []).find((c) => slug(c.n) === s)]).filter(([, c]) => c)
      .sort(([, a], [, b]) => b.on - a.on || b.c.g - a.c.g);
  }

  async function page(s, params) {
    const el = $("#view-coach");
    el.innerHTML = `<div class="card muted">Loading…</div>`;
    await Promise.all([load(), loadTree()]);
    const mine = findCoach(s), P = TREE.people || {}, me = P[s];
    if (!mine.length && !me) { el.innerHTML = `<div class="card">Coach not found. <a href="${link("coaches")}">All coaches →</a></div>`; return; }
    const [lg, c] = mine[0] || [league, null], name = c?.n || me.n;
    // ---- header: photo, job, hot seat
    const since = c && c.st.filter((x) => x[0] === c.tm).at(-1)?.[1];
    const job = !c ? `<span class="muted">Not a head coach in our data</span>`
      : c.on ? `Head coach, ${teamLink(lg, c.tm)} <small class="muted">since ${since}</small>`
      : `Last head coaching job: ${teamLink(lg, c.tm)} <small class="muted">(${yrs(c.st.at(-1)[1], c.st.at(-1)[2])})</small>`;
    const hs = c?.on && c.hs;
    const seat = hs ? `<div class="co-seat seat-${hs.lab}"><div><span class="seat seat-${hs.lab}">${esc(SEAT[hs.lab])}</span>
        <b>${Math.round(100 * hs.p)}%</b> <small>chance he's out after this season</small></div>
        ${hs.why?.length ? `<ul>${hs.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>` : "";
    // ---- stats: current team / career / last 3, like the Coaches table
    const scope = ["t", "c", "r"].includes(params.get("scope")) && c?.[params.get("scope")] ? params.get("scope") : c?.t ? "t" : "c";
    const S = c?.[scope];
    const tile = (k, v, sub = "") => `<div class="co-tile"><small>${esc(k)}</small><b>${v}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
    const also = mine.slice(1).map(([l2, c2]) => `the ${l2 === "nfl" ? "NFL" : "college game"}: ${c2.c.w}-${c2.c.l}${c2.c.t ? "-" + c2.c.t : ""} (${c2.st.map((x) => `${esc(teamName(l2, x[0]))} ${yrs(x[1], x[2])}`).join(", ")})`);
    const stats = !S ? "" : `<div class="presets co-scope" id="co-pscope">${[["t", c.on ? "Current team" : "Last team"], ["c", "All time"], ["r", "Last 3 seasons"]]
        .filter(([k]) => c[k]).map(([k, l]) => `<button data-v="${k}" class="${k === scope ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="co-tiles">
        ${tile("Coach score", S.score ?? "—", S.rk ? `#${S.rk} in the ${lg === "nfl" ? "NFL" : "FBS"}` : "not enough games")}
        ${tile("Record", `${S.w}-${S.l}${S.t ? "-" + S.t : ""}`, S.pct == null ? "" : S.pct.toFixed(3).replace(/^0/, "") + " win %")}
        ${tile("Postseason", `${S.pw}-${S.pl}`, S.ti ? `${S.ti} title${S.ti > 1 ? "s" : ""}` : "")}
        ${tile("Vs winning teams", `${S.gw}-${S.gl}`)}
        ${tile("Wins over expected", f1(S.woe_s), "per season")}
        ${tile("One-score games", `${S.ow}-${S.ol}`)}
        ${tile("Team lift", S.lift == null ? "—" : f1(S.lift), "win % vs the year before him")}
        ${tile("Cupcake wins", S.cup == null ? "—" : S.cup + "%", "of his wins")}
        ${tile("Seasons", S.yrs, yrs(S.y1, S.y2))}
      </div>${also.length ? `<p class="note">Also a head coach in ${also.join("; ")}.</p>` : ""}`;
    // ---- season by season (every league he coached in)
    const seas = mine.flatMap(([l2, c2]) => (c2.sea || []).map((r) => [l2, ...r])).sort((a, b) => b[1] - a[1]);
    const seasons = !seas.length ? "" : `<div class="table-wrap"><table class="box co-seas"><thead><tr><th>Season</th><th>Team</th><th class="num">Record</th><th class="num">Postseason</th></tr></thead><tbody>
      ${seas.map(([l2, y, tm, w, l, t, pw, pl]) => `<tr><td>${y}</td><td>${teamLink(l2, tm)}</td><td class="num">${w}-${l}${t ? "-" + t : ""}</td><td class="num">${pw + pl ? `${pw}-${pl}` : `<span class="muted">—</span>`}</td></tr>`).join("")}
      </tbody></table></div>`;
    // ---- coaching tree: edges are [mentor, assistant, league, team, first season, last season, role]
    const E = TREE.edges || [];
    const group = (list, i) => { const m = new Map(); list.forEach((e) => { if (!m.has(e[i])) m.set(e[i], []); m.get(e[i]).push(e); }); return [...m]; };
    const first = ([, es]) => Math.min(...es.map((e) => e[4]));
    const how = (es) => es.slice().sort((a, b) => a[4] - b[4]).map((e) => `${e[6] || "Assistant"}, ${teamName(e[2], e[3])} ${yrs(e[4], e[5])}`).join(" · ");
    // kids: his branch ({n, html}) or null. Branches past the first column start closed; +N opens one (like Ancestry)
    const node = (k, es, kids) => {
      const p = P[k] || { n: k }, f = findCoach(k)[0], now = f && f[1].on ? `<small class="tr-now">${esc(teamName(f[0], f[1].tm))}</small>` : "";
      const tog = kids ? `<button class="tr-tog" type="button" aria-expanded="false" data-n="${kids.n}" title="Show or hide the ${kids.n} coach${kids.n > 1 ? "es" : ""} behind ${esc(p.n)}">+${kids.n}</button>` : "";
      return `<li><a class="tr-node" href="${link("coach", k)}" title="${esc(p.n)}: ${esc(how(es))}">${pic(p, p.n)}<span><b>${esc(p.n)}</b>${now}<small>${esc(how(es))}</small></span></a>${tog}${kids ? kids.html : ""}</li>`;
    };
    const branch = (k, depth, max, seen, from, to) => { // from/to: 1 -> 0 walks up to mentors, 0 -> 1 walks down to assistants
      if (depth > max) return null;
      const g = group(E.filter((e) => e[from] === k && !seen.has(e[to])), to).sort((a, b) => first(a) - first(b));
      return g.length ? { n: g.length, html: `<ul${depth > 1 ? ` class="shut"` : ""}>${g.map(([x, es]) => node(x, es, branch(x, depth + 1, max, new Set([...seen, x]), from, to))).join("")}</ul>` } : null;
    };
    const upHtml = branch(s, 1, 5, new Set([s]), 1, 0)?.html, downHtml = branch(s, 1, 3, new Set([s]), 0, 1)?.html;
    const nDown = new Set(E.filter((e) => e[0] === s).map((e) => e[1])).size;
    // drawn left to right like an ancestry chart: him, then the next generation in the column to his right, and so on
    const chart = (kids) => `${/class="tr-tog"/.test(kids) ? `<div class="presets tr-all"><button type="button" data-tr="1">Expand all</button><button type="button" data-tr="">Collapse all</button></div>` : ""}
      <div class="htree"><ul><li><span class="tr-node me">${pic(me, name)}<span><b>${esc(name)}</b></span></span>${kids}</li></ul></div>`;
    const tree = `<div class="co-tree">
        <div><h4>Came from</h4>${upHtml ? `<p class="note">Head coaches he worked under (next column), and who they worked under.</p>${chart(upHtml)}` : `<p class="muted">No head coaches in our data that he worked under.</p>`}</div>
        <div><h4>His tree${nDown ? ` <small class="muted">${nDown} head coach${nDown > 1 ? "es" : ""}</small>` : ""}</h4>${downHtml ? `<p class="note">His assistants who became head coaches (next column), and theirs.</p>${chart(downHtml)}` : `<p class="muted">None of his assistants have become head coaches yet.</p>`}</div>
      </div>
      <p class="note">From each coach's Wikipedia page: an assistant job links him to that team's head coach that season. NFL and FBS head coaches only, from our head coach lists (NFL since ${TREE.from?.nfl || 1999}, college since ${TREE.from?.cfb || 2005}) plus the earlier head coaching jobs on our coaches' pages. Someone who'd already been a head coach for 3+ seasons doesn't count as an assistant's tree.</p>`;
    el.innerHTML = `<div class="card co-hero">
        ${pic(me, name, "big")}
        <div class="co-id"><h2>${esc(name)}</h2><p>${job}</p>
          ${me?.w ? `<p class="co-links"><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(me.w.replace(/ /g, "_"))}" target="_blank" rel="noopener">Wikipedia</a>${me.cr ? ` <small class="muted">· photo from Wikipedia</small>` : ""}</p>` : ""}</div>
        ${seat}
      </div>
      ${hs ? `<p class="note co-seat-how">Hot seat is our estimate, from a model trained on every head coach season since 1999 (NFL) and 2006 (college): this season's record against what we expected, last season, years in the job and the program's usual standard. Tested on seasons it never saw, its Safe coaches were out about 7% of the time, Teetering about 22% and Hot seat about half. Just for fun.</p>` : ""}
      ${S ? `<div class="card"><h3>Stats</h3>${stats}</div>` : ""}
      <div class="card"><h3>Coaching tree</h3>${tree}</div>
      ${seasons ? `<div class="card"><h3>Season by season</h3>${seasons}</div>` : ""}
      <p class="note"><a href="${link("coaches")}">← All coaches</a></p>`;
    const sc = $("#co-pscope");
    if (sc) sc.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) location.hash = link("coach", s, { scope: b.dataset.v }); };
    // open / close a branch, or a whole tree
    const flip = (b, open) => { b.setAttribute("aria-expanded", open); b.textContent = open ? "–" : `+${b.dataset.n}`; b.nextElementSibling?.classList.toggle("shut", !open); };
    el.querySelector(".co-tree").onclick = (e) => {
      const b = e.target.closest(".tr-tog");
      if (b) return flip(b, b.getAttribute("aria-expanded") !== "true");
      const all = e.target.closest("[data-tr]");
      if (all) all.parentElement.nextElementSibling.querySelectorAll(".tr-tog").forEach((t) => flip(t, !!all.dataset.tr));
    };
  }

  // the head coach on a team page (top right): photo, name, hot seat; links to his page
  async function forTeam(lg, teamId) {
    await Promise.all([load(), loadTree()]);
    const t = (T[lg] || []).find((x) => String(x.id) === String(teamId));
    const c = t && (D[lg]?.coaches || []).find((x) => x.on && x.tm === (lg === "nfl" ? t.abbr : t.name));
    if (!c) return "";
    return `<a class="th-rk th-coach" href="${link("coach", slug(c.n))}" title="${esc(c.n)}: stats, hot seat and coaching tree">${pic((TREE.people || {})[slug(c.n)], c.n)}
      <span><small>HEAD COACH</small><b>${esc(c.n.split(" ").slice(-1)[0])}</b>${seatChip(c.hs, true)}</span></a>`;
  }

  return { render, forSeason, page, forTeam, slug };
})();
