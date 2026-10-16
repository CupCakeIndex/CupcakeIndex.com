// Coaches: head coach rankings from docs/data/coaches.json (src/coaches.py). Career or the last 3 seasons,
// current coaches or everyone in our data, every column sortable. The Coach score is explained under the table.
const Coaches = (() => {
  let D = null, T = null;
  const load = async () => {
    if (!D) [D, T] = await Promise.all([getJSON("data/coaches.json").catch(() => ({})), getJSON("data/teams.json").catch(() => ({}))]);
  };
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
    const sort = COLS.some(([k]) => k === params.get("sort")) || params.get("sort") === "edge" ? params.get("sort") : "score";
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
    const cols = edgeCol ? [...COLS.slice(0, 4), ["edge", "Rating boost", "What our NFL model adds to his team's power rating for him, in points (his teams' record against expectations in past seasons, shrunk for coaches with few games)", (s, c) => c.edge ?? -99, (s, c) => f1(c.edge)], ...COLS.slice(4)] : COLS;
    const col = cols.find(([k]) => k === sort) || cols[0];
    const rows = L.coaches.filter((c) => (all || c.on) && c[scope])
      .sort((a, b) => dir * (col[3](b[scope], b) - col[3](a[scope], a)) || (b[scope].score ?? -1) - (a[scope].score ?? -1) || b[scope].g - a[scope].g);
    const seg = (id, opts, v) => `<div class="presets" id="${id}">${opts.map(([k, l]) => `<button data-v="${k}" class="${k === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const th = ([k, l, tip]) => `<th class="num sortable${k === sort ? " on" : ""}" data-sort="${k}" title="${esc(tip)}">${esc(l)}${k === sort ? (dir > 0 ? " ▼" : " ▲") : ""}</th>`;
    const who = (c) => {
      const t = team(lg, c.tm), teams = new Set(c.st.map((s) => s[0])).size;
      return `<div class="team">${logo(t)}<div><b>${esc(c.n)}</b>
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
      if (s && c.c) out[s[0]] = { co_score: c.c.score, co_pct: c.c.pct == null ? null : 100 * c.c.pct, co_good: pct(c.c.gw, c.c.gl) == null ? null : 100 * pct(c.c.gw, c.c.gl), co_woe: c.c.woe_s, co_yrs: c.c.yrs, co_edge: c.edge };
    }
    return out;
  }

  return { render, forSeason };
})();
