// Live views backed by ESPN's public JSON feeds (fetched in the viewer's browser; no key needed).
// Uses helpers from app.js: $, esc, link, league, safeUrl, modelRanks, weekData, INDEX.
const Live = (() => {
  const SPORT = (lg) => (lg === "nfl" ? "nfl" : "college-football");
  // site.web.api serves the same feeds as site.api, but site.api rejects many browser requests (403)
  const SITE = (lg) => `https://site.web.api.espn.com/apis/site/v2/sports/football/${SPORT(lg)}`;
  const WEB = (lg) => `https://site.web.api.espn.com/apis/common/v3/sports/football/${SPORT(lg)}`;
  const STAND = (lg) => `https://site.web.api.espn.com/apis/v2/sports/football/${SPORT(lg)}`;

  // ---------------------------------------------------------------- fetching, caching, polling
  const cache = new Map();
  async function api(url, maxAge = 60000) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < maxAge) return hit.data;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    const data = await r.json();
    cache.set(url, { t: Date.now(), data });
    return data;
  }

  let timer = null, token = 0;
  function stop() { clearTimeout(timer); timer = null; token++; }
  // Re-run a view on an interval while it's still the current view; pauses while the tab is hidden.
  function poll(fn, ms) {
    const my = token;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (my !== token) return;
      if (document.hidden) return poll(fn, ms);
      fn(true);
    }, ms);
  }

  const view = (name) => $("#view-" + name);
  const loading = (name) => { view(name).innerHTML = `<div class="card muted">Loading…</div>`; };
  const fail = (name, e) => { view(name).innerHTML = `<div class="card">Couldn't load this from ESPN (${esc(e.message)}). Try again in a minute.</div>`; };
  const img = (src, cls = "lg") => safeUrl(src) ? `<img src="${esc(src)}" alt="" loading="lazy" class="${cls}">` : `<span class="logo-ph ${cls}"></span>`;
  const teamLogo = (t) => t?.logo || t?.logos?.[0]?.href || "";
  const kickoff = (d) => new Date(d).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  const clockNow = () => new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const liveBadge = (on) => (on ? `<span class="live-dot"></span> Live · updated ${clockNow()}` : "");

  function statusText(st, date) {
    const s = st?.type || {};
    if (s.state === "pre") return s.shortDetail && !/^\d/.test(s.shortDetail) ? s.shortDetail : kickoff(date);
    return s.shortDetail || s.detail || "";
  }

  // ESPN team id for a rankings team: CFB ids match CFBD's; NFL is looked up by name.
  async function teamId(lg, t) {
    if (t.id) return t.id;
    try {
      // the /teams list isn't CORS-enabled; standings carry the same ids
      const d = await api(`${STAND(lg)}/standings?level=3`, 86400000);
      return groupsOf(d).flatMap((g) => g.entries).find((e) => e.team.displayName === t.team)?.team.id || null;
    } catch { return null; }
  }

  function ourTeam(ranks, lg, espnTeam) {
    if (!ranks || !espnTeam) return null;
    return lg === "nfl" ? ranks.byName.get(espnTeam.displayName) : ranks.byId.get(String(espnTeam.id));
  }

  // ---------------------------------------------------------------- scores
  const CFB_GROUPS = [["80", "All FBS"], ["top25", "AP Top 25"], ["8", "SEC"], ["5", "Big Ten"], ["4", "Big 12"], ["1", "ACC"],
    ["151", "American"], ["12", "Conference USA"], ["15", "MAC"], ["17", "Mountain West"], ["9", "Pac-12"], ["37", "Sun Belt"], ["18", "Independents"]];

  async function scores(_, params, refresh = false) {
    const lg = league, my = token;
    const wk = params.get("week"), grp = params.get("group") || "80";
    const q = new URLSearchParams();
    if (lg === "cfb") { q.set("groups", grp === "top25" ? "80" : grp); q.set("limit", "300"); }
    if (wk) { const [st, w] = wk.split(":"); q.set("seasontype", st); q.set("week", w); }
    if (!refresh) loading("scores");
    let sb, ranks;
    try {
      [sb, ranks] = await Promise.all([api(`${SITE(lg)}/scoreboard?${q}`, refresh ? 0 : 20000), modelRanks(lg)]);
    } catch (e) { return fail("scores", e); }
    if (my !== token) return;

    // Model lines for this week's games come from the previous week's rankings file.
    const week = sb.week?.number, season = sb.season?.year;
    const preds = new Map();
    if (sb.season?.type === 2 && INDEX.leagues[lg].seasons[season]?.weeks.includes(week - 1)) {
      const d = await weekData(lg, season, week - 1).catch(() => null);
      (d?.predictions || []).forEach((p) => preds.set(String(p.espn_id), p));
    }
    if (my !== token) return;

    let events = sb.events || [];
    if (grp === "top25") events = events.filter((e) => e.competitions[0].competitors.some((c) => (c.curatedRank?.current || 99) <= 25));
    const state = (e) => e.status.type.state;
    const live = events.filter((e) => state(e) === "in"), pre = events.filter((e) => state(e) === "pre"), post = events.filter((e) => state(e) === "post");

    const cal = (sb.leagues?.[0]?.calendar || []).filter((c) => /regular|post/i.test(c.label));
    const cur = `${sb.season?.type}:${week}`;
    const weekOpts = cal.flatMap((c) => (c.entries || []).map((en) => {
      const v = `${c.value}:${en.value}`;
      return `<option value="${esc(v)}"${v === (wk || cur) ? " selected" : ""}>${esc(en.label)}${en.detail ? " · " + esc(en.detail) : ""}</option>`;
    })).join("");
    const grpSel = lg === "cfb" ? `<select id="sc-group">${CFB_GROUPS.map(([v, l]) => `<option value="${v}"${v === grp ? " selected" : ""}>${l}</option>`).join("")}</select>` : "";

    const section = (title, list) => list.length ? `<h3 class="sc-h">${title}</h3><div class="score-grid">${list.map((e) => card(e, lg, ranks, preds)).join("")}</div>` : "";
    view("scores").innerHTML = `
      <div class="sc-bar"><select id="sc-week">${weekOpts}</select>${grpSel}<span class="muted live-note">${liveBadge(live.length)}</span></div>
      ${section("Live now", live)}${section("Upcoming", pre)}${section("Final", post)}
      ${events.length ? "" : `<div class="card muted">No games this week.</div>`}`;
    const go = (k, v) => { const p = new URLSearchParams(params); p.set(k, v); p.set("league", lg); location.hash = `#/scores?${p}`; };
    $("#sc-week").onchange = (e) => go("week", e.target.value);
    if ($("#sc-group")) $("#sc-group").onchange = (e) => go("group", e.target.value);

    if (live.length) poll((r) => scores(_, params, r), 30000);
    else if (pre.some((e) => new Date(e.date) - Date.now() < 3600000)) poll((r) => scores(_, params, r), 120000);
  }

  function card(e, lg, ranks, preds) {
    const c = e.competitions[0];
    const st = e.status.type.state;
    const sit = c.situation;
    const teams = [...c.competitors].sort((a) => (a.homeAway === "away" ? -1 : 1));
    const row = (t) => {
      const ours = ourTeam(ranks, lg, t.team);
      const ap = t.curatedRank?.current;
      const win = st === "post" && t.winner;
      return `<div class="gc-team${win ? " win" : ""}${st === "post" && !t.winner ? " lose" : ""}">
        ${img(teamLogo(t.team), "sm")}
        ${ap && ap <= 25 ? `<span class="ap-rk">${ap}</span>` : ""}
        <b>${esc(lg === "nfl" ? t.team.shortDisplayName : t.team.location || t.team.shortDisplayName)}</b>
        <small class="muted">${esc(t.records?.[0]?.summary || "")}</small>
        ${ours ? `<span class="our-rk" title="Cupcake Index rank">#${ours.rank}</span>` : ""}
        ${sit?.possession === t.team.id ? `<span class="poss" title="Possession">●</span>` : ""}
        <span class="gc-score">${st === "pre" ? "" : esc(t.score)}</span></div>`;
    };
    const odds = c.odds?.[0];
    const p = preds.get(String(e.id));
    const model = p ? `Model: ${lineText(p, p.spread)}` : "";
    const foot = [odds?.details ? `${esc(odds.details)}${odds.overUnder ? ` · O/U ${esc(odds.overUnder)}` : ""}` : "", model, esc(c.broadcast || c.broadcasts?.[0]?.names?.[0] || "")].filter(Boolean).join(" · ");
    return `<a class="game-card ${st}" href="${link("game", e.id)}">
      <div class="gc-status">${st === "in" ? '<span class="live-dot"></span>' : ""}${esc(statusText(e.status, e.date))}</div>
      ${teams.map(row).join("")}
      ${st === "in" && sit?.downDistanceText ? `<div class="gc-sit${sit.isRedZone ? " rz" : ""}">${esc(sit.downDistanceText)}</div>` : ""}
      ${foot ? `<div class="gc-foot">${foot}</div>` : ""}
    </a>`;
  }

  // ---------------------------------------------------------------- game / box score
  const CAT_NAME = { passing: "Passing", rushing: "Rushing", receiving: "Receiving", fumbles: "Fumbles", defensive: "Defense", interceptions: "Interceptions",
    kickReturns: "Kick returns", puntReturns: "Punt returns", kicking: "Kicking", punting: "Punting" };

  async function game(id, params, refresh = false) {
    const lg = league, my = token;
    if (!refresh) loading("game");
    let s, ranks;
    try {
      [s, ranks] = await Promise.all([api(`${SITE(lg)}/summary?event=${encodeURIComponent(id)}`, refresh ? 0 : 15000), modelRanks(lg)]);
    } catch (e) { return fail("game", e); }
    if (my !== token) return;
    const comp = s.header?.competitions?.[0];
    if (!comp) return fail("game", new Error("no game data"));
    const st = comp.status?.type?.state;
    const away = comp.competitors.find((c) => c.homeAway === "away"), home = comp.competitors.find((c) => c.homeAway === "home");
    const tname = (c) => c.team.displayName || c.team.location;

    // our model's pick for this game (in the rankings file from the week before)
    let pred = null;
    const wk = s.header?.week, season = s.header?.season?.year;
    if (wk && INDEX.leagues[lg].seasons[season]?.weeks.includes(wk - 1)) {
      const d = await weekData(lg, season, wk - 1).catch(() => null);
      pred = (d?.predictions || []).find((p) => String(p.espn_id) === String(id)) || null;
    }
    if (my !== token) return;

    const side = (c) => {
      const ours = ourTeam(ranks, lg, c.team);
      const ap = c.rank;
      return `<div class="gh-team">
        ${img(teamLogo(c.team), "xl")}
        <div><a href="${link("team", c.team.id)}"><b>${ap && ap <= 25 ? `<span class="ap-rk">${ap}</span> ` : ""}${esc(tname(c))}</b></a>
        <small class="muted">${esc(c.record?.[0]?.summary || c.record?.[0]?.displayValue || "")}${ours ? ` · Cupcake Index #${ours.rank}` : ""}</small></div>
        <span class="gh-score${st === "post" && c.winner ? " win" : ""}">${st === "pre" ? "" : esc(c.score ?? "")}</span></div>`;
    };
    const lines = (c) => (c.linescores || []).map((l) => `<td>${esc(l.displayValue ?? l.value)}</td>`).join("");
    const nPer = Math.max(away.linescores?.length || 0, home.linescores?.length || 0);
    const lineTable = nPer ? `<table class="linescore"><thead><tr><th></th>${Array.from({ length: nPer }, (_, i) => `<th>${i < 4 ? i + 1 : "OT" + (i > 4 ? i - 3 : "")}</th>`).join("")}<th>T</th></tr></thead>
      <tbody>${[away, home].map((c) => `<tr><td>${esc(c.team.abbreviation)}</td>${lines(c)}<td><b>${esc(c.score ?? "")}</b></td></tr>`).join("")}</tbody></table>` : "";

    const venue = s.gameInfo?.venue?.fullName;
    const head = `<div class="card gamehead">
      <div class="gh-status">${st === "in" ? '<span class="live-dot"></span>' : ""}${esc(statusText(comp.status, comp.date))}${venue ? ` · ${esc(venue)}` : ""}<span class="muted live-note">${liveBadge(st === "in")}</span></div>
      <div class="gh-teams">${side(away)}<span class="gh-at">@</span>${side(home)}</div>
      ${lineTable}
      ${st === "in" && s.situation?.lastPlay?.text ? `<p class="note">Last play: ${esc(s.situation.lastPlay.text)}</p>` : ""}
    </div>`;

    const blocks = [];
    // odds + model
    const pc = s.pickcenter || [];
    if (pc.length || pred) {
      blocks.push(`<div class="card"><h3>Lines</h3><div class="books">
        ${pc.map((o) => `<span class="book">${esc(o.provider?.name || "Book")}: ${esc(o.details || "—")}${o.overUnder ? ` · O/U ${esc(o.overUnder)}` : ""}</span>`).join("")}
        ${pred ? `<span class="book hot">Cupcake Index model: ${lineText(pred, pred.spread)}</span>` : ""}</div></div>`);
    }
    // win probability
    const wp = s.winprobability || [];
    if (wp.length > 2) blocks.push(`<div class="card"><h3>Win probability</h3>${wpChart(wp, away, home)}</div>`);
    // leaders
    if (s.leaders?.length && st !== "pre") {
      blocks.push(`<div class="card"><h3>Game leaders</h3><div class="leaders">${s.leaders.map((tl) => `<div><b>${esc(tl.team?.abbreviation || "")}</b>${(tl.leaders || []).map((cat) => {
        const L = cat.leaders?.[0];
        return L ? `<div class="leader"><small class="muted">${esc(cat.displayName)}</small> <a href="${link("player", L.athlete.id)}">${esc(L.athlete.displayName)}</a> <span class="muted">${esc(L.displayValue)}</span></div>` : "";
      }).join("")}</div>`).join("")}</div></div>`);
    }
    // team stats
    const bt = s.boxscore?.teams || [];
    if (bt.length === 2 && bt[0].statistics?.length) {
      const byId = Object.fromEntries(bt.map((t) => [t.team.id, t]));
      const A = byId[away.team.id] || bt[0], H = byId[home.team.id] || bt[1];
      blocks.push(`<div class="card"><h3>Team stats</h3><table class="teamstats"><thead><tr><th></th><th class="num">${esc(away.team.abbreviation)}</th><th class="num">${esc(home.team.abbreviation)}</th></tr></thead><tbody>
        ${A.statistics.map((x, i) => `<tr><td>${esc(x.label)}</td><td class="num">${esc(x.displayValue)}</td><td class="num">${esc(H.statistics[i]?.displayValue ?? "")}</td></tr>`).join("")}</tbody></table></div>`);
    }
    // player box score
    const bp = s.boxscore?.players || [];
    if (bp.length) {
      const cats = [...new Set(bp.flatMap((t) => t.statistics.map((x) => x.name)))];
      blocks.push(`<div class="card"><h3>Box score</h3>${cats.map((cn) => `<h4>${esc(CAT_NAME[cn] || cn)}</h4><div class="box-pair">${bp.map((t) => {
        const cat = t.statistics.find((x) => x.name === cn);
        if (!cat || !cat.athletes?.length) return `<div></div>`;
        return `<div class="table-wrap"><table class="box"><thead><tr><th>${esc(t.team.abbreviation)}</th>${cat.labels.map((l) => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead><tbody>
          ${cat.athletes.map((a) => `<tr><td><a href="${link("player", a.athlete.id)}">${esc(a.athlete.displayName)}</a></td>${a.stats.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`).join("")}
          ${cat.totals?.length ? `<tr class="tot"><td>Team</td>${cat.totals.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>` : ""}</tbody></table></div>`;
      }).join("")}</div>`).join("")}</div>`);
    }
    // scoring plays
    const sp = s.scoringPlays || [];
    if (sp.length) {
      blocks.push(`<div class="card"><h3>Scoring plays</h3><table class="plays"><tbody>${sp.map((p) => `<tr>
        <td class="muted">Q${esc(p.period?.number)} ${esc(p.clock?.displayValue || "")}</td><td>${img(p.team?.logo, "sm")}</td>
        <td><b>${esc(p.type?.abbreviation || "")}</b> ${esc(p.text)}</td><td class="num">${esc(p.awayScore)}-${esc(p.homeScore)}</td></tr>`).join("")}</tbody></table></div>`);
    }
    // injuries (mostly useful before kickoff)
    const inj = (s.injuries || []).filter((t) => t.injuries?.length);
    if (inj.length && st !== "post") {
      blocks.push(`<div class="card"><h3>Injuries</h3><div class="box-pair">${inj.map((t) => `<div><b>${esc(t.team?.displayName || "")}</b><ul class="inj">${t.injuries.slice(0, 15).map((i) =>
        `<li><a href="${link("player", i.athlete?.id)}">${esc(i.athlete?.displayName)}</a> <span class="muted">${esc(i.athlete?.position?.abbreviation || "")}</span> <span class="pill over">${esc(i.status)}</span></li>`).join("")}</ul></div>`).join("")}</div></div>`);
    }
    view("game").innerHTML = `<p><a href="${link("scores")}" class="boxlink">← Scores</a></p>${head}<div class="game-grid">${blocks.join("")}</div>`;
    if (st === "in") poll((r) => game(id, params, r), 20000);
  }

  function wpChart(wp, away, home) {
    const W = 600, H = 160, n = wp.length;
    const pts = wp.map((p, i) => `${((i / (n - 1)) * W).toFixed(1)},${((1 - p.homeWinPercentage) * H).toFixed(1)}`).join(" ");
    const last = wp[n - 1].homeWinPercentage;
    const lead = last >= 0.5 ? home : away, pct = Math.round((last >= 0.5 ? last : 1 - last) * 100);
    return `<p class="note">${esc(lead.team.displayName)} ${pct}%</p>
      <svg viewBox="0 0 ${W} ${H}" class="wp" preserveAspectRatio="none" role="img" aria-label="Win probability over the game">
        <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="wp-mid"/>
        <polyline points="${pts}" class="wp-line"/>
      </svg>
      <div class="wp-labels"><span>Higher = ${esc(home.team.abbreviation)} more likely</span><span>Lower = ${esc(away.team.abbreviation)} more likely</span></div>`;
  }

  // ---------------------------------------------------------------- stats leaders
  const STAT_CATS = [
    { key: "passing", label: "Passing", category: "offense:passing", show: "passing", sort: "passing.passingYards" },
    { key: "rushing", label: "Rushing", category: "offense:rushing", show: "rushing", sort: "rushing.rushingYards" },
    { key: "receiving", label: "Receiving", category: "offense:receiving", show: "receiving", sort: "receiving.receivingYards" },
    { key: "defense", label: "Defense", category: "defense", show: "defensive", sort: "defensive.totalTackles" },
    { key: "ints", label: "Interceptions", category: "defense", show: "defensiveinterceptions", sort: "defensiveInterceptions.interceptions" },
    { key: "scoring", label: "Scoring", category: "scoring", show: "scoring", sort: "scoring.totalPoints" },
    { key: "kicking", label: "Kicking", category: "specialTeams:kicking", show: "kicking", sort: "kicking.fieldGoalsMade" },
  ];

  async function stats(_, params, refresh = false) {
    const lg = league, my = token;
    const cat = STAT_CATS.find((c) => c.key === params.get("cat")) || STAT_CATS[0];
    const sort = params.get("sort") || cat.sort, dir = params.get("dir") || "desc";
    const season = params.get("season"), pages = Math.max(1, +params.get("pages") || 1);
    if (!refresh) loading("stats");
    const url = (page) => `${WEB(lg)}/statistics/byathlete?category=${cat.category}&sort=${sort}:${dir}&limit=50&page=${page}` + (season ? `&season=${season}&seasontype=2` : "");
    let resps;
    try {
      resps = await Promise.all(Array.from({ length: pages }, (_, i) => api(url(i + 1), refresh ? 0 : 120000)));
    } catch (e) { return fail("stats", e); }
    if (my !== token) return;
    const first = resps[0];
    const def = (first.categories || []).find((c) => c.name === cat.show);
    if (!def) return fail("stats", new Error("stat category missing"));
    const athletes = resps.flatMap((r) => r.athletes || []);
    const prefix = cat.sort.split(".")[0];
    const curYear = first.currentSeason?.year || new Date().getFullYear();
    const shownYear = +(season || first.requestedSeason?.year || curYear);
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null ? p.delete(k) : p.set(k, v)));
      p.set("league", lg);
      location.hash = `#/stats?${p}`;
    };
    const cols = def.labels.map((l, i) => {
      const key = `${prefix}.${def.names[i]}`;
      const on = key === sort;
      return `<th class="num sortable${on ? " on" : ""}" data-sort="${esc(key)}" title="${esc(def.displayNames?.[i] || l)}">${esc(l)}${on ? (dir === "desc" ? " ▼" : " ▲") : ""}</th>`;
    }).join("");
    const rows = athletes.map((a, i) => {
      const A = a.athlete, vals = (a.categories.find((c) => c.name === cat.show) || {}).totals || [];
      return `<tr data-name="${esc(A.displayName.toLowerCase())} ${esc((A.teamShortName || "").toLowerCase())}"><td class="num muted">${i + 1}</td>
        <td><div class="team">${img(A.headshot?.href, "hs")}<div><a href="${link("player", A.id)}"><b>${esc(A.displayName)}</b></a><small class="muted">${esc(A.position?.abbreviation || "")}</small></div></div></td>
        <td><span class="tm">${img(A.teamLogos?.[0]?.href, "xs")} ${esc(A.teamShortName || "")}</span></td>
        ${vals.map((v, j) => `<td class="num${`${prefix}.${def.names[j]}` === sort ? " on" : ""}">${esc(v)}</td>`).join("")}</tr>`;
    }).join("");
    const more = first.pagination && pages < first.pagination.pages;
    view("stats").innerHTML = `
      <div class="sc-bar">
        <div class="presets">${STAT_CATS.map((c) => `<button data-cat="${c.key}" class="${c.key === cat.key ? "on" : ""}">${c.label}</button>`).join("")}</div>
        <select id="st-season">${[curYear, curYear - 1, curYear - 2].map((y) => `<option${y === shownYear ? " selected" : ""}>${y}</option>`).join("")}</select>
        <input id="st-search" type="search" placeholder="Filter player or team…">
      </div>
      <div class="table-wrap"><table id="stats-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th>${cols}</tr></thead><tbody>${rows}</tbody></table></div>
      ${more ? `<p><button id="st-more" class="btn">Show 50 more</button></p>` : ""}
      <p class="note">Click a column to sort by it. Sorting uses ESPN's full ${lg === "nfl" ? "NFL" : "FBS"} list, not just the rows shown.</p>`;
    view("stats").querySelector(".presets").onclick = (e) => { const c = e.target.dataset.cat; if (c) go({ cat: c, sort: null, dir: null, pages: null }); };
    view("stats").querySelector("thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.sort;
      if (k) go({ sort: k, dir: k === sort && dir === "desc" ? "asc" : "desc", pages: null });
    };
    $("#st-season").onchange = (e) => go({ season: +e.target.value === curYear ? null : e.target.value, pages: null });
    $("#st-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      view("stats").querySelectorAll("tbody tr").forEach((tr) => tr.classList.toggle("hidden", !!q && !tr.dataset.name.includes(q)));
    };
    if ($("#st-more")) $("#st-more").onclick = () => go({ pages: pages + 1 });
    if (!season) poll((r) => stats(_, params, r), 300000); // live-ish: refresh leaders every 5 minutes
  }

  // ---------------------------------------------------------------- player
  async function player(id, params) {
    const lg = league, my = token;
    loading("player");
    const season = params.get("season");
    let bio, gl;
    try {
      [bio, gl] = await Promise.all([
        api(`${WEB(lg)}/athletes/${encodeURIComponent(id)}`, 300000),
        api(`${WEB(lg)}/athletes/${encodeURIComponent(id)}/gamelog${season ? `?season=${season}` : ""}`, 120000).catch(() => null),
      ]);
    } catch (e) { return fail("player", e); }
    if (my !== token) return;
    const a = bio.athlete;
    const facts = [
      a.position?.displayName, a.displayJersey,
      [a.displayHeight, a.displayWeight].filter(Boolean).join(", "),
      a.age ? `Age ${a.age}` : "", a.displayExperience || a.experience?.displayValue, a.displayDraft,
      a.college?.name || a.collegeTeam?.displayName ? `College: ${a.college?.name || a.collegeTeam?.displayName}` : "",
      a.displayBirthPlace ? `From ${a.displayBirthPlace}` : "",
    ].filter(Boolean);
    const inj = a.injuries?.[0];
    const summary = (a.statsSummary?.statistics || []).map((x) => `<div class="stat"><small>${esc(x.displayName)}</small><b>${esc(x.displayValue)}</b>${x.rankDisplayValue ? `<small class="muted">${esc(x.rankDisplayValue)}</small>` : ""}</div>`).join("");

    let log = "";
    if (gl?.seasonTypes?.length) {
      const groups = (gl.categories || []).map((c) => `<th colspan="${c.count}" class="grp">${esc(c.displayName)}</th>`).join("");
      log = gl.seasonTypes.map((stp) => {
        const evs = stp.categories.flatMap((c) => c.events || []);
        if (!evs.length) return "";
        const rows = evs.map((ev) => {
          const m = gl.events?.[ev.eventId] || {};
          return `<tr><td>${esc(m.week ?? "")}</td>
            <td><span class="tm">${esc(m.atVs || "")} ${img(m.opponent?.logo, "xs")} ${esc(m.opponent?.abbreviation || "")}</span></td>
            <td><a href="${link("game", ev.eventId)}"><span class="${m.gameResult === "W" ? "W" : m.gameResult === "L" ? "L" : ""}">${esc(m.gameResult || "")}</span> ${esc(m.score || "")}</a></td>
            ${ev.stats.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`;
        }).join("");
        const tot = stp.summary?.stats?.[0]?.stats;
        return `<h4>${esc(stp.displayName)}</h4><div class="table-wrap"><table class="box">
          <thead>${groups ? `<tr><th colspan="3"></th>${groups}</tr>` : ""}<tr><th>Wk</th><th>Opp</th><th>Result</th>${(gl.labels || []).map((l) => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead>
          <tbody>${rows}${tot ? `<tr class="tot"><td colspan="3">Totals</td>${tot.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>` : ""}</tbody></table></div>`;
      }).join("");
    }
    const thisYear = new Date().getFullYear();
    const years = Array.from({ length: 4 }, (_, i) => thisYear - i).filter((y) => !a.debutYear || y >= a.debutYear);
    view("player").innerHTML = `
      <div class="card player-head">
        ${img(a.headshot?.href, "headshot")}
        <div>
          <h2>${esc(a.displayName)}</h2>
          <p>${a.team ? `<a href="${link("team", a.team.id)}"><span class="tm">${img(a.team.logos?.[0]?.href || a.team.logo, "xs")} ${esc(a.team.displayName)}</span></a>` : ""}
            ${inj ? ` <span class="pill over">${esc(inj.status || inj.type?.description || "Injured")}</span>` : ""}</p>
          <p class="muted">${facts.map(esc).join(" · ")}</p>
        </div>
      </div>
      ${summary ? `<div class="stats wide">${summary}</div>` : ""}
      <div class="card"><div class="sc-bar"><h3>Game log</h3>
        <select id="pl-season">${years.map((y) => `<option${String(y) === (season || String(gl?.requestedSeason?.year || thisYear)) ? " selected" : ""}>${y}</option>`).join("")}</select></div>
        ${log || `<p class="muted">No games logged for this season.</p>`}</div>`;
    $("#pl-season").onchange = (e) => { location.hash = link("player", id, { season: e.target.value }); };
  }

  // ---------------------------------------------------------------- standings
  function groupsOf(node) {
    if (node.standings?.entries) return [{ name: node.name, entries: node.standings.entries }];
    return (node.children || []).flatMap(groupsOf);
  }
  const stat = (e, key) => e.stats.find((s) => s.type === key || s.name === key)?.displayValue ?? "";
  const statNum = (e, key) => +(e.stats.find((s) => s.type === key || s.name === key)?.value ?? 0);

  async function standings() {
    const lg = league, my = token;
    loading("standings");
    let d, ranks;
    try {
      [d, ranks] = await Promise.all([api(`${STAND(lg)}/standings?${lg === "nfl" ? "level=3" : "group=80"}`, 300000), modelRanks(lg)]);
    } catch (e) { return fail("standings", e); }
    if (my !== token) return;
    const nfl = lg === "nfl";
    const cols = nfl
      ? [["W", "wins"], ["L", "losses"], ["T", "ties"], ["PCT", "winPercent"], ["PF", "pointsFor"], ["PA", "pointsAgainst"], ["DIFF", "differential"], ["STRK", "streak"], ["DIV", "divisionRecord"], ["CONF", "vs. Conf."]]
      : [["CONF", "vsconf"], ["OVR", "total"], ["PF", "pointsfor"], ["PA", "pointsagainst"], ["STRK", "streak"], ["vs AP", "vsaprankedteams"]];
    const groups = groupsOf(d);
    view("standings").innerHTML = groups.map((g) => {
      const entries = [...g.entries].sort((a, b) => (statNum(a, "playoffseed") || 99) - (statNum(b, "playoffseed") || 99));
      return `<div class="card"><h3>${esc(g.name)}</h3><div class="table-wrap"><table class="standings"><thead><tr><th>Team</th>${cols.map(([l]) => `<th class="num">${l}</th>`).join("")}
        <th class="num" title="Cupcake Index rank">Our #</th>${nfl ? "" : `<th class="num" title="Cupcake score: higher = softer schedule">CUP</th>`}</tr></thead><tbody>
        ${entries.map((e) => {
          const ours = ourTeam(ranks, lg, e.team);
          return `<tr><td><a href="${link("team", e.team.id)}"><span class="tm">${img(teamLogo(e.team), "xs")} ${esc(nfl ? e.team.displayName : e.team.location || e.team.displayName)}</span></a></td>
            ${cols.map(([, k]) => `<td class="num">${esc(stat(e, k))}</td>`).join("")}
            <td class="num">${ours ? `<a href="${link("rankings", null, { team: ours.team })}">#${ours.rank}</a>` : "–"}</td>
            ${nfl ? "" : `<td class="num">${ours ? `<span class="chip" style="${heat(100 - ours.scores.cupcake)}">${Math.round(ours.scores.cupcake)}</span>` : "–"}</td>`}</tr>`;
        }).join("")}</tbody></table></div></div>`;
    }).join("") || `<div class="card muted">No standings available.</div>`;
  }

  // ---------------------------------------------------------------- team
  async function team(id, params) {
    const lg = league, my = token;
    const tab = params.get("tab") || "schedule";
    loading("team");
    let sch, ros, ranks;
    try {
      [sch, ros, ranks] = await Promise.all([
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/schedule`, 60000),
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/roster`, 600000).catch(() => null),
        modelRanks(lg),
      ]);
    } catch (e) { return fail("team", e); }
    if (my !== token) return;
    const T = sch.team || {};
    const ours = ourTeam(ranks, lg, { id: T.id, displayName: T.displayName });

    const games = (sch.events || []).map((e) => {
      const c = e.competitions[0];
      const me = c.competitors.find((x) => String(x.team?.id ?? x.id) === String(T.id)) || c.competitors[0];
      const op = c.competitors.find((x) => x !== me);
      const st = c.status?.type?.state;
      const score = (x) => x?.score?.displayValue ?? x?.score ?? "";
      const res = st === "post" ? `<span class="${me.winner ? "W" : "L"}">${me.winner ? "W" : "L"}</span> ${esc(score(me))}-${esc(score(op))}`
        : `<span class="muted">${esc(statusText(c.status, c.date))}</span>`;
      const opRank = op?.curatedRank?.current;
      return `<tr><td>${esc(e.week?.text || "")}</td>
        <td><span class="tm">${me.homeAway === "away" ? "@" : "vs"} ${img(teamLogo(op?.team), "xs")} ${opRank && opRank <= 25 ? `<span class="ap-rk">${opRank}</span>` : ""}${esc(op?.team?.displayName || "")}</span></td>
        <td><a href="${link("game", e.id)}">${res}</a></td></tr>`;
    }).join("");

    const rosterRows = (ros?.athletes || []).filter((g) => g.items?.length).map((g) => `
      <h4>${esc({ offense: "Offense", defense: "Defense", specialTeam: "Special teams", injuredReserveOrOut: "Injured reserve / out", suspended: "Suspended", practiceSquad: "Practice squad" }[g.position] || g.position)}</h4>
      <div class="table-wrap"><table class="box"><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th>Ht</th><th>Wt</th><th>${lg === "nfl" ? "Age" : "Class"}</th><th>Status</th></tr></thead><tbody>
      ${g.items.map((p) => `<tr><td class="num muted">${esc(p.jersey || "")}</td>
        <td><div class="team">${img(p.headshot?.href, "hs")}<a href="${link("player", p.id)}">${esc(p.displayName)}</a></div></td>
        <td>${esc(p.position?.abbreviation || "")}</td><td>${esc(p.displayHeight || "")}</td><td>${esc(p.displayWeight || "")}</td>
        <td>${esc(lg === "nfl" ? p.age ?? "" : p.experience?.abbreviation || "")}</td>
        <td>${p.injuries?.[0] ? `<span class="pill over">${esc(p.injuries[0].status)}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`).join("");

    const tabLink = (t, label) => `<a class="subtab${tab === t ? " on" : ""}" href="${link("team", id, { tab: t })}">${label}</a>`;
    view("team").innerHTML = `
      <div class="card team-head" style="--tc:#${esc((T.color || "").replace(/[^0-9a-f]/gi, ""))}">
        ${img(teamLogo(T), "xl")}
        <div><h2>${esc(T.displayName || "")}</h2>
          <p class="muted">${esc(T.recordSummary || "")}${T.standingSummary ? " · " + esc(T.standingSummary) : ""}</p>
          ${ours ? `<p><a href="${link("rankings", null, { team: ours.team })}" class="boxlink">Cupcake Index #${ours.rank} · Power ${ours.rating > 0 ? "+" : ""}${ours.rating.toFixed(1)}${lg === "cfb" ? ` · Cupcake ${Math.round(ours.scores.cupcake)}` : ""} · see why →</a></p>` : ""}
        </div>
      </div>
      <div class="subtabs">${tabLink("schedule", "Schedule")}${tabLink("roster", "Roster")}</div>
      <div class="card">${tab === "roster"
        ? rosterRows || `<p class="muted">Roster not available.</p>`
        : `<table class="box"><thead><tr><th>Week</th><th>Opponent</th><th>Result</th></tr></thead><tbody>${games}</tbody></table>`}</div>`;
  }

  return { stop, teamId, scores, game, stats, player, standings, team };
})();
