// Fantasy (NFL): this week's start / sit calls and a lineup builder, from ESPN's fantasy projections (PPR, ESPN's default league).
// Matchups: fantasy points each defense has allowed by position this season (from ESPN's weekly player totals), and for
// D/ST the opponent's spot in our rankings. Your team is kept in this browser and in the page link.
// Uses helpers from app.js ($, esc, link, league, store, modelRanks, fuzzyScore) and live.js (Live.kit).
const Fantasy = (() => {
  const FF = (y) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${y}`;
  const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
  const ORDER = ["QB", "RB", "WR", "TE", "K", "D/ST"];
  // "Obvious starters" at each position = this many most-rostered players. Sleepers come from just past that line.
  const TIER = { QB: 12, RB: 24, WR: 30, TE: 12, K: 12, "D/ST": 12 };
  const SHOW = { QB: 3, RB: 4, WR: 4, TE: 3, K: 3, "D/ST": 3 }; // calls listed per side
  const INJ = { OUT: "Out", QUESTIONABLE: "Questionable", DOUBTFUL: "Doubtful", INJURY_RESERVE: "Injured Reserve", SUSPENSION: "Suspension", DAY_TO_DAY: "Day-To-Day" };
  const GONE = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]); // won't play: never a "start"
  // Lineup: ESPN's default league (QB, 2 RB, 2 WR, TE, FLEX, K, D/ST) plus a 7-man bench
  const SLOTS = [["QB", ["QB"]], ["RB", ["RB"]], ["RB", ["RB"]], ["WR", ["WR"]], ["WR", ["WR"]], ["TE", ["TE"]], ["FLEX", ["RB", "WR", "TE"]], ["K", ["K"]], ["D/ST", ["D/ST"]]];
  const BENCH = 7, KEY = "fantasy-team";

  let cur = null;    // { y, week, players: Map id -> player, teams, allowed, ranks }
  let team = { s: Array(SLOTS.length).fill(null), b: [] }; // starters by slot (player id or null), bench ids
  let moving = null; // the row being moved: "s3" (starter slot 3) or "b1" (bench spot 1)
  let posTab = "";   // start/sit position filter ("" = all)
  let wired = false;

  // ESPN's fantasy API takes its query in a header; cached for 10 minutes per query
  const cache = new Map();
  async function ff(y, filter, maxAge = 600000) {
    const k = y + JSON.stringify(filter), hit = cache.get(k);
    if (hit && Date.now() - hit.t < maxAge) return hit.data;
    const r = await fetch(`${FF(y)}/segments/0/leaguedefaults/3?view=kona_player_info`, { headers: { "X-Fantasy-Filter": JSON.stringify(filter) } });
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    const data = (await r.json()).players || [];
    cache.set(k, { t: Date.now(), data });
    return data;
  }
  // This week's projection only (stat ids like "20264" = season 2026, week 4)
  const projFilter = (y, week, extra) => ({ players: { ...extra, filterStatsForExternalIds: { value: [+`${y}${week}`] },
    filterStatsForSourceIds: { value: [1] }, filterStatsForSplitTypeIds: { value: [1] } } });

  // A player as this view uses him: projection, rostered %, injury, opponent this week
  function player(x, y, week, teams) {
    const p = x.player || x, pos = POS[p.defaultPositionId];
    if (!pos) return null;
    const st = (p.stats || []).find((s) => s.seasonId === y && s.scoringPeriodId === week && s.statSourceId === 1 && s.statSplitTypeId === 1);
    const t = teams.get(p.proTeamId), g = t?.games?.[week]?.[0];
    const home = g && g.homeProTeamId === p.proTeamId, opp = g ? teams.get(home ? g.awayProTeamId : g.homeProTeamId) : null;
    return { id: p.id, name: p.fullName, pos, team: t, opp, at: home ? "vs" : "@", bye: !!t && !g, kickoff: g?.date,
      own: p.ownership?.percentOwned || 0, inj: p.injuryStatus || "ACTIVE", proj: st ? st.appliedTotal : null };
  }

  async function load() {
    const now = new Date(), y = now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear(); // before September: last season
    const K = Live.kit;
    const [season, sched] = await Promise.all([K.api(FF(y), 3600000), K.api(`${FF(y)}?view=proTeamSchedules_wl`, 21600000)]);
    const week = Math.min(season.currentScoringPeriod?.id || 1, 18);
    const teams = new Map((sched.settings?.proTeams || []).filter((t) => t.id).map((t) => [t.id, {
      id: t.id, abbrev: t.abbrev.toUpperCase(), name: `${t.location} ${t.name}`, games: t.proGamesByScoringPeriod || {} }]));
    const weeks = Array.from({ length: week - 1 }, (_, i) => i + 1);
    const [list, played, ranks] = await Promise.all([
      ff(y, projFilter(y, week, { filterSlotIds: { value: [0, 2, 4, 6, 16, 17] }, limit: 750, sortPercOwned: { sortPriority: 1, sortAsc: false } })),
      // points each defense has allowed: weekly totals of the 300 most-rostered QB/RB/WR/TE (an error just drops matchup notes)
      weeks.length ? ff(y, { players: { filterSlotIds: { value: [0, 2, 4, 6] }, limit: 300, sortPercOwned: { sortPriority: 1, sortAsc: false },
        filterStatsForSourceIds: { value: [0] }, filterStatsForSplitTypeIds: { value: [1] }, filterStatsForScoringPeriodIds: { value: weeks } } }).catch(() => []) : [],
      modelRanks("nfl").catch(() => null),
    ]);
    const players = new Map();
    list.forEach((x) => { const p = player(x, y, week, teams); if (p) players.set(p.id, p); });
    return { y, week, teams, players, ranks, allowed: allowedRanks(played, y, week, teams) };
  }

  // Rank defenses by PPR points allowed per game to each position: 1 = allows the most
  function allowedRanks(played, y, week, teams) {
    const tot = new Map(); // "teamId|POS" -> points
    for (const x of played) {
      const p = x.player, pos = POS[p?.defaultPositionId];
      for (const s of p?.stats || []) {
        if (s.seasonId !== y || s.statSourceId !== 0 || s.statSplitTypeId !== 1 || !s.appliedTotal) continue;
        const g = teams.get(p.proTeamId)?.games?.[s.scoringPeriodId]?.[0];
        if (!g) continue;
        const opp = g.homeProTeamId === p.proTeamId ? g.awayProTeamId : g.homeProTeamId;
        tot.set(`${opp}|${pos}`, (tot.get(`${opp}|${pos}`) || 0) + s.appliedTotal);
      }
    }
    const out = new Map();
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const rows = [...teams.values()].map((t) => {
        const g = Object.keys(t.games).filter((w) => +w < week && t.games[w]?.length).length;
        return [t.id, g ? (tot.get(`${t.id}|${pos}`) || 0) / g : null];
      }).filter((r) => r[1] != null).sort((a, b) => b[1] - a[1]);
      if (rows.length >= 30) rows.forEach(([id], i) => out.set(`${id}|${pos}`, i + 1));
    }
    return out;
  }

  const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
  const pts = (v) => (v == null ? "–" : v.toFixed(1));
  // The matchup in words: "@ KC, who allow the 3rd-most points to RBs" (only the top / bottom 10 are worth a mention)
  function matchup(p) {
    if (!p.opp) return "";
    const head = `${p.at} ${p.opp.abbrev}`;
    if (p.pos === "D/ST") {
      const r = cur.ranks?.byName.get(p.opp.name)?.rank;
      return r ? `${head}, #${r} in our rankings` : head;
    }
    const r = cur.allowed.get(`${p.opp.id}|${p.pos}`);
    if (!r) return head;
    if (r <= 10) return `${head}, who allow the ${r === 1 ? "" : ord(r) + "-"}most points to ${p.pos}s`;
    if (r >= 23) return `${head}, who allow the ${r === 32 ? "" : ord(33 - r) + "-"}fewest points to ${p.pos}s`;
    return head;
  }
  // matchup score for sorting calls: + = soft defense, - = tough (0 when unknown)
  const soft = (p) => { const r = cur.allowed.get(`${p.opp?.id}|${p.pos}`); return r ? (16.5 - r) / 16 : 0; };

  // Start 'em: just past the most-rostered tier, but projected like a starter. Sit 'em: in that tier, projected well below it.
  function calls(pos) {
    const all = [...cur.players.values()].filter((p) => p.pos === pos);
    const byOwn = all.slice().sort((a, b) => b.own - a.own), n = TIER[pos];
    const ownRank = new Map(byOwn.map((p, i) => [p.id, i + 1]));
    const projRank = new Map(all.filter((p) => p.proj > 0).sort((a, b) => b.proj - a.proj).map((p, i) => [p.id, i + 1]));
    const pr = (p) => projRank.get(p.id) || 999;
    const start = byOwn.filter((p) => ownRank.get(p.id) > n && ownRank.get(p.id) <= n * 2.5 && !GONE.has(p.inj) && p.inj !== "DOUBTFUL" && pr(p) <= n * 1.25)
      .sort((a, b) => pr(a) - pr(b) || soft(b) - soft(a)).slice(0, SHOW[pos]);
    const out = byOwn.slice(0, n).filter((p) => p.bye || GONE.has(p.inj) || (p.proj != null && p.proj <= 0)); // ESPN projects 0 = not expected to play
    const sit = byOwn.slice(0, n).filter((p) => !out.includes(p) && p.proj != null)
      .map((p) => [p, pr(p) - ownRank.get(p.id) + (p.inj === "QUESTIONABLE" ? 3 : p.inj === "DOUBTFUL" ? 8 : 0) - 4 * soft(p)])
      .filter(([p, s]) => s >= 4 && pr(p) > n * 0.6).sort((a, b) => b[1] - a[1]).slice(0, SHOW[pos]).map((x) => x[0]);
    const why = (p, side) => {
      const rk = `${pos}${pr(p) < 999 ? pr(p) : "–"} this week`;
      const bits = side === "start" ? [`Projected ${pts(p.proj)} (${rk}), on ${Math.round(p.own)}% of rosters`]
        : [`Projected ${pts(p.proj)} (${rk}) though on ${Math.round(p.own)}% of rosters`];
      if (INJ[p.inj] && !GONE.has(p.inj)) bits.push(`listed ${INJ[p.inj]}`);
      const m = matchup(p);
      if (m) bits.push(m);
      return bits.join("; ");
    };
    return { start: start.map((p) => [p, why(p, "start")]), sit: sit.map((p) => [p, why(p, "sit")]), out };
  }

  // ---------------------------------------------------------------- drawing
  const injTag = (p) => (INJ[p.inj] ? Live.kit.injTag({ status: INJ[p.inj] }, p.pos === "D/ST" ? "" : p.id) : "");
  const nameLink = (p) => `<a href="${p.pos === "D/ST" ? link("team", p.team?.id) : link("player", p.id)}">${esc(p.name)}</a>`;
  const opp = (p) => (p.bye ? `<span class="ft-bye">BYE</span>` : p.opp ? `${p.at} ${esc(p.opp.abbrev)}` : "");

  function callRow(p, why) {
    return `<li><div class="ft-line"><span class="ft-nm">${nameLink(p)}${injTag(p)}</span><small class="muted">${esc(p.team?.abbrev || "")} ${opp(p)}</small>
      <b class="ft-pts">${pts(p.proj)}</b></div><p class="ft-why">${esc(why)}</p></li>`;
  }

  function drawCalls() {
    const box = $("#ft-calls");
    if (!box) return;
    const list = posTab ? [posTab] : ORDER;
    box.innerHTML = list.map((pos) => {
      const c = calls(pos);
      const side = (k, title) => `<div class="ft-side ft-${k}"><h4>${title}</h4>${c[k].length ? `<ul>${c[k].map(([p, w]) => callRow(p, w)).join("")}</ul>`
        : `<p class="muted ft-none">${k === "start" ? "No standout sleepers this week." : "No big names projected to flop."}</p>`}</div>`;
      const out = c.out.length ? `<p class="note ft-out">Out or not expected to play: ${c.out.map((p) => `${nameLink(p)} <span class="muted">(${p.bye ? "bye" : esc(INJ[p.inj] || "projected 0")})</span>`).join(", ")}</p>` : "";
      return `<div class="ft-pos"><h3><span class="ft-gt">&gt;</span> ${pos}</h3><div class="ft-pair">${side("start", "Start 'em")}${side("sit", "Sit 'em")}</div>${out}</div>`;
    }).join("");
  }

  const fits = (i, p) => (i >= SLOTS.length ? true : SLOTS[i][1].includes(p.pos)); // slot index >= 9 = bench
  const total = (s) => s.reduce((t, id) => t + (cur.players.get(id)?.proj || 0), 0);

  // Best lineup: fill each fixed slot with its top projection, FLEX last from what's left (the best possible total)
  function best() {
    const pool = [...team.s, ...team.b].filter((id) => id != null && cur.players.has(id))
      .sort((a, b) => (cur.players.get(b).proj || 0) - (cur.players.get(a).proj || 0));
    const s = Array(SLOTS.length).fill(null), order = [0, 1, 2, 3, 4, 5, 7, 8, 6];
    for (const i of order) {
      const k = pool.findIndex((id) => fits(i, cur.players.get(id)));
      if (k >= 0) s[i] = pool.splice(k, 1)[0];
    }
    return { s, b: pool };
  }

  function teamRow(id, i) {
    const p = id != null ? cur.players.get(id) : null, bench = i >= SLOTS.length, key = bench ? `b${i - SLOTS.length}` : `s${i}`;
    const lab = bench ? "BN" : SLOTS[i][0];
    const src = moving && (moving[0] === "s" ? +moving.slice(1) : SLOTS.length + +moving.slice(1));
    const srcP = moving && (moving[0] === "s" ? cur.players.get(team.s[src]) : cur.players.get(team.b[src - SLOTS.length]));
    // a move target: the moving player fits here, and whoever is here fits where the moving player was
    const ok = moving && key !== moving && !(bench && moving[0] === "b") && srcP && fits(i, srcP) && (!p || fits(src, p));
    const cls = [moving === key ? "on" : "", ok ? "ok" : "", bench ? "bn" : ""].filter(Boolean).join(" ");
    if (!p) return `<tr class="${cls}" data-k="${key}"><td><button class="ft-slot" data-mv="${key}"${ok ? "" : " disabled"}>${lab}</button></td>
      <td colspan="2" class="muted ft-empty">${ok ? "move here" : "empty"}</td><td></td></tr>`;
    return `<tr class="${cls}" data-k="${key}"><td><button class="ft-slot" data-mv="${key}" title="Move this player">${lab}</button></td>
      <td><span class="ft-nm">${nameLink(p)}${injTag(p)}</span><small class="muted ft-sub">${esc(p.pos)} · ${esc(p.team?.abbrev || "FA")} ${opp(p)}</small></td>
      <td class="num ft-pts">${pts(p.proj)}</td>
      <td><button class="ft-x" data-rm="${key}" aria-label="Remove ${esc(p.name)}">✕</button></td></tr>`;
  }

  function drawTeam() {
    const box = $("#ft-team");
    if (!box) return;
    const n = team.s.filter((x) => x != null).length + team.b.length, tot = total(team.s), b = best(), gain = total(b.s) - tot;
    box.innerHTML = `
      <div class="dg-prompt ft-prompt"><label class="dg-gt" for="ft-in">&gt;</label>
        <input id="ft-in" type="search" autocomplete="off" spellcheck="false" placeholder="add a player or D/ST_" aria-label="Add a player to your team"${n >= SLOTS.length + BENCH ? " disabled" : ""}>
        <div id="ft-list" class="gs-results dg-list hidden" role="listbox"></div></div>
      <div class="ft-tools br-tools">
        <button data-act="best"${gain > 0.05 ? "" : " disabled"}>Best lineup${gain > 0.05 ? ` (+${gain.toFixed(1)})` : ""}</button>
        <button data-act="copy"${n ? "" : " disabled"}>Copy link</button>
        <button data-act="clear"${n ? "" : " disabled"}>Clear team</button>
        <span class="ft-total">Projected <b>${tot.toFixed(1)}</b></span></div>
      ${moving ? `<p class="note ft-hint">Tap a highlighted spot to move or swap that player. <button class="link" data-act="cancel">Cancel</button></p>` : ""}
      <div class="table-wrap"><table class="box ft-tbl"><thead><tr><th>Slot</th><th>Player</th><th class="num">Proj</th><th></th></tr></thead>
        <tbody>${team.s.map((id, i) => teamRow(id, i)).join("")}
        <tr class="ft-sep"><td colspan="4">Bench</td></tr>
        ${(team.b.length ? team.b : []).map((id, j) => teamRow(id, SLOTS.length + j)).join("")}
        ${moving && moving[0] === "s" && team.b.length < BENCH ? teamRow(null, SLOTS.length + team.b.length) : ""}
        ${!team.b.length && !moving ? `<tr><td></td><td colspan="3" class="muted ft-empty">Extra players go here.</td></tr>` : ""}</tbody></table></div>`;
    wireInput();
  }

  // ---------------------------------------------------------------- team edits, saving
  // In the link: starters in slot order then "~" then bench, ESPN fantasy ids in base 36 (D/STs are negative)
  const enc = () => (team.s.some((x) => x != null) || team.b.length
    ? team.s.map((id) => (id == null ? "" : id.toString(36))).join(".") + "~" + team.b.map((id) => id.toString(36)).join(".") : "");
  function dec(str) {
    if (!/^[0-9a-z.~-]{1,400}$/.test(str || "")) return null;
    const [s, b = ""] = str.split("~"), num = (x) => (x && /^-?[0-9a-z]+$/.test(x) ? parseInt(x, 36) : null);
    const st = s.split(".").slice(0, SLOTS.length).map(num);
    while (st.length < SLOTS.length) st.push(null);
    return { s: st, b: b.split(".").map(num).filter((x) => x != null).slice(0, BENCH) };
  }
  function save() {
    const e = enc();
    store.set(KEY, e);
    history.replaceState(null, "", link("fantasy", null, e ? { team: e } : {}));
  }
  const has = (id) => team.s.includes(id) || team.b.includes(id);
  function add(id) {
    const p = cur.players.get(id);
    if (!p || has(id)) return;
    const i = team.s.findIndex((x, k) => x == null && fits(k, p));
    if (i >= 0) team.s[i] = id;
    else if (team.b.length < BENCH) team.b.push(id);
    else return;
    save(); drawTeam();
    $("#ft-in")?.focus();
  }
  function take(key) { // remove whoever is at key; returns their id
    const j = +key.slice(1);
    if (key[0] === "s") { const id = team.s[j]; team.s[j] = null; return id; }
    return team.b.splice(j, 1)[0];
  }
  function move(from, to) {
    const get = (k) => (k[0] === "s" ? team.s[+k.slice(1)] : team.b[+k.slice(1)]);
    const a = get(from), b = get(to);
    const put = (k, id) => { if (k[0] === "s") team.s[+k.slice(1)] = id; else if (id == null) team.b.splice(+k.slice(1), 1); else team.b[+k.slice(1)] = id; };
    put(to, a); put(from, b ?? null);
  }

  // Autocomplete: the 750 most-rostered QB/RB/WR/TE/K/D/ST, best name match first, then most rostered
  function wireInput() {
    const inp = $("#ft-in"), list = $("#ft-list");
    if (!inp) return;
    let hits = [], sel = 0;
    const paint = () => {
      list.classList.toggle("hidden", !hits.length);
      list.innerHTML = hits.map((p, i) => `<button type="button" data-id="${p.id}" class="${i === sel ? "on" : ""}"><span>${esc(p.name)}</span>
        <small>${esc(p.pos)} · ${esc(p.team?.abbrev || "FA")} ${p.bye ? "· bye" : p.opp ? `${p.at} ${esc(p.opp.abbrev)}` : ""} · ${pts(p.proj)}</small></button>`).join("");
    };
    inp.oninput = () => {
      const q = inp.value.trim();
      sel = 0;
      hits = q.length < 2 ? [] : [...cur.players.values()].filter((p) => !has(p.id))
        .map((p) => [fuzzyScore(q, `${p.name} ${p.pos === "D/ST" ? p.team?.abbrev || "" : ""}`), p]).filter(([s]) => s != null)
        .sort((a, b) => a[0] - b[0] || b[1].own - a[1].own).slice(0, 7).map((x) => x[1]);
      paint();
    };
    inp.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); if (hits[sel]) add(hits[sel].id); }
      else if (e.key === "Escape") { hits = []; paint(); }
    };
    inp.onblur = () => setTimeout(() => { hits = []; paint(); }, 150);
    list.onmousedown = (e) => e.preventDefault(); // keep focus in the input
    list.onclick = (e) => { const b = e.target.closest("[data-id]"); if (b) add(+b.dataset.id); };
  }

  function wire(root) {
    wired = true;
    root.addEventListener("click", async (e) => {
      if (!cur || !root.querySelector("#ft-team")) return;
      const pt = e.target.closest("[data-pos]");
      if (pt) { posTab = pt.dataset.pos; root.querySelectorAll("#ft-pos button").forEach((x) => x.classList.toggle("on", x === pt)); return drawCalls(); }
      const mv = e.target.closest("[data-mv]");
      if (mv) {
        const k = mv.dataset.mv;
        if (!moving) { if (mv.closest("tr").querySelector(".ft-nm")) moving = k; }
        else if (k === moving) moving = null;
        else if (mv.closest("tr").classList.contains("ok")) { move(moving, k); moving = null; save(); }
        return drawTeam();
      }
      const rm = e.target.closest("[data-rm]");
      if (rm) { take(rm.dataset.rm); moving = null; save(); return drawTeam(); }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "best") { team = best(); moving = null; save(); drawTeam(); }
      if (act === "clear") { team = { s: Array(SLOTS.length).fill(null), b: [] }; moving = null; save(); drawTeam(); }
      if (act === "cancel") { moving = null; drawTeam(); }
      if (act === "copy") {
        const b = e.target.closest("button");
        await Share.copy(location.href);
        b.textContent = "Copied ✓";
        setTimeout(() => { if (b.isConnected) b.textContent = "Copy link"; }, 1200);
      }
    });
  }

  async function render(params) {
    const K = Live.kit, my = K.token(), root = $("#view-fantasy");
    if (league !== "nfl") {
      root.innerHTML = `<div class="card">Fantasy is NFL only. <a href="#/fantasy?league=nfl">Go to NFL fantasy →</a></div>`;
      return;
    }
    if (!cur) root.innerHTML = `<div class="card muted">Loading…</div>`;
    try {
      const data = await load();
      if (my !== K.token()) return;
      cur = data;
    } catch (e) {
      root.innerHTML = `<div class="card">Couldn't load ESPN's fantasy projections (${esc(e.message)}). Try again in a minute.</div>`;
      return;
    }
    // A shared link's team wins, else this browser's saved team
    team = dec(params.get("team")) || dec(store.get(KEY)) || { s: Array(SLOTS.length).fill(null), b: [] };
    moving = null;
    // players on the team who aren't among the 750 most rostered: look them up by id
    const missing = [...team.s, ...team.b].filter((id) => id != null && !cur.players.has(id));
    if (missing.length) {
      const extra = await ff(cur.y, projFilter(cur.y, cur.week, { filterIds: { value: missing } })).catch(() => []);
      if (my !== K.token()) return;
      extra.forEach((x) => { const p = player(x, cur.y, cur.week, cur.teams); if (p) cur.players.set(p.id, p); });
    }
    team.s = team.s.map((id, i) => (id != null && cur.players.has(id) && fits(i, cur.players.get(id)) ? id : null));
    team.b = team.b.filter((id) => cur.players.has(id));
    if (!params.has("team") && enc()) history.replaceState(null, "", link("fantasy", null, { team: enc() }));
    const anyProj = [...cur.players.values()].some((p) => p.proj != null);

    root.innerHTML = `<div class="card ft-card">
      <h2>Fantasy · Week ${cur.week} <span class="muted">NFL · PPR</span></h2>
      ${anyProj ? "" : `<p class="note">ESPN hasn't posted projections for week ${cur.week} yet.</p>`}
      <h3 class="ft-h">Start / Sit</h3>
      <div class="presets" id="ft-pos">${[["", "All"], ...ORDER.map((p) => [p, p])].map(([v, l]) => `<button data-pos="${v}" class="${v === posTab ? "on" : ""}">${l}</button>`).join("")}</div>
      <div id="ft-calls"></div>
      <p class="note"><b>Start 'em</b> = sleepers: players just outside the most-rostered group at their position (top ${TIER.QB} QBs, ${TIER.RB} RBs, ${TIER.WR} WRs, ${TIER.TE} TEs, ${TIER.K} Ks and D/STs)
        whom ESPN projects like starters this week. <b>Sit 'em</b> = widely rostered players projected well below that level, with injury listings and tough matchups counting against them.
        "Allow the most / fewest points" = PPR points per game each defense has given up to that position this season (top 10 / bottom 10 only).
        D/ST matchups show the opponent's spot in our rankings.</p>
    </div>
    <div class="card ft-card">
      <h2>My team · Week ${cur.week}</h2>
      <div id="ft-team" class="ft-team"></div>
      <p class="note">Type a name at the <b class="dg-gt">&gt;</b> prompt to add a player; he takes the first open starting spot that fits, or the bench.
        Tap a slot label (QB, RB, BN…) to move or swap a player. <b>Best lineup</b> starts the highest projections on your roster.
        Your team is saved in this browser and in the page link.</p>
    </div>
    <p class="note ft-foot">Projections are ESPN's (PPR scoring, ESPN's standard league) and change through the week; rostered % is across ESPN leagues. Just for fun.</p>`;
    drawTeam();
    drawCalls();
    if (!wired) wire(root);
  }

  return { render };
})();
