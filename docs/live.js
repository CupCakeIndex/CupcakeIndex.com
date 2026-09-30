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
  const SIZES = { xs: [18, 18], sm: [22, 22], lg: [28, 28], xl: [56, 56], hs: [30, 30], leadshot: [52, 52], headshot: [120, 88] }; // CSS display sizes
  let boxTab = "off"; // remembered across live refreshes
  const img = (src, cls = "lg") => {
    if (!safeUrl(src)) return `<span class="logo-ph ${cls}"></span>`;
    const [w, h] = SIZES[cls] || [40, 40];
    const crop = cls === "leadshot" || cls === "hs"; // round headshots: square crop centered on the face
    return `<img src="${esc(thumb(src, w, h, crop))}" alt="" loading="lazy" decoding="async" width="${w}" height="${h}" class="${cls}">`;
  };
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

  // A team's color, readable on a dark card: swap to the alternate color if the main one is near-black or near-white
  function teamColor(t) {
    const lum = (hex) => {
      const m = /^[0-9a-f]{6}$/i.test(hex || "") ? hex : null;
      if (!m) return null;
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const c of [t?.color, t?.alternateColor]) {
      const L = lum(c);
      if (L != null && L > 0.07 && L < 0.85) return "#" + c;
    }
    return "#6b7280";
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

    // broadcast scorebug in team colors
    const tc = { away: teamColor(away.team), home: teamColor(home.team) };
    const side = (c, which) => {
      const ours = ourTeam(ranks, lg, c.team);
      const ap = c.rank && c.rank <= 25 ? c.rank : null;
      const result = st === "post" ? (c.winner ? " win" : " lose") : "";
      const logoImg = img(teamLogo(c.team), "xl");
      const name = `<div class="sb-name">
          <a href="${link("team", c.team.id)}">${ap ? `<span class="sb-rank">${ap}</span>` : ""}<b>${esc(c.team.location || tname(c))}</b></a>
          <small>${esc(c.team.name || "")}</small>
          <em>${esc(c.record?.[0]?.summary || c.record?.[0]?.displayValue || "")}${ours ? ` · Cupcake Index #${ours.rank}` : ""}</em></div>`;
      const score = `<span class="sb-score">${st === "pre" ? "" : esc(c.score ?? "")}</span>`;
      return `<div class="sb-team ${which}${result}">${which === "away" ? logoImg + name + score : score + name + logoImg}</div>`;
    };
    const venue = s.gameInfo?.venue?.fullName;
    const tv = comp.broadcasts?.[0]?.media?.shortName || "";
    const statusLabel = st === "post" ? (comp.status?.type?.shortDetail || "Final") : st === "in" ? statusText(comp.status, comp.date) : kickoff(comp.date);
    const lines = (c) => (c.linescores || []).map((l) => `<td>${esc(l.displayValue ?? l.value)}</td>`).join("");
    const nPer = Math.max(away.linescores?.length || 0, home.linescores?.length || 0);
    const lineTable = nPer ? `<table class="linescore sb-lines"><thead><tr><th></th>${Array.from({ length: nPer }, (_, i) => `<th>${i < 4 ? i + 1 : "OT" + (i > 4 ? i - 3 : "")}</th>`).join("")}<th>T</th></tr></thead>
      <tbody>${[[away, "away"], [home, "home"]].map(([c, w]) => `<tr><td><span class="sb-chip" style="--c:${tc[w]}"></span>${esc(c.team.abbreviation)}</td>${lines(c)}<td><b>${esc(c.score ?? "")}</b></td></tr>`).join("")}</tbody></table>` : "";

    const head = `<div class="scorebug" style="--ac:${tc.away};--hc:${tc.home}">
        ${side(away, "away")}
        <div class="sb-mid">
          <span class="sb-status ${st}">${st === "in" ? '<span class="live-dot"></span>' : ""}${esc(statusLabel)}</span>
          <small>${[venue, tv].filter(Boolean).map(esc).join(" · ")}</small>
          <span class="muted live-note">${liveBadge(st === "in")}</span>
        </div>
        ${side(home, "home")}
      </div>
      ${lineTable || st === "in" ? `<div class="card sb-under">${lineTable}
        ${st === "in" && s.situation?.lastPlay?.text ? `<p class="note">Last play: ${esc(s.situation.lastPlay.text)}</p>` : ""}</div>` : ""}`;

    const col = { left: [], right: [], full: [] }; // two independent columns so short cards never leave gaps
    // highlights: official YouTube video (found by the weekly job) + ESPN's own clips (open on ESPN)
    const hlAll = await getJSON(`data/${lg}/${season}/highlights.json`).catch(() => ({}));
    if (my !== token) return;
    const yt = hlAll[String(id)];
    const clips = (s.videos || []).filter((v) => v.links?.web?.href).slice(0, 8);
    if (yt?.id || clips.length) {
      const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
      col.left.push(`<div class="card"><h3>Highlights</h3>
        ${yt?.id ? `<div class="yt"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt.id)}" title="${esc(yt.title || "Game highlights")}"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>
          <p class="note">${esc(yt.title || "")} · ${esc(yt.channel || "YouTube")}</p>` : ""}
        ${clips.length ? `${yt?.id ? "<h4>More clips on ESPN</h4>" : ""}<div class="clips">${clips.map((v) => `
          <a class="clip" href="${esc(safeUrl(v.links.web.href))}" target="_blank" rel="noopener">
            <span class="clip-thumb">${safeUrl(v.thumbnail) ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy" decoding="async">` : ""}<span class="clip-dur">${mmss(v.duration || 0)}</span><span class="clip-play">▶</span></span>
            <span class="clip-title">${esc(v.headline)}</span></a>`).join("")}</div><p class="note">ESPN clips open on espn.com.</p>` : ""}
      </div>`);
    }
    // odds + model
    const pc = s.pickcenter || [];
    if (pc.length || pred) {
      col.left.push(`<div class="card"><h3>Lines</h3><div class="books">
        ${pc.map((o) => `<span class="book">${esc(o.provider?.name || "Book")}: ${esc(o.details || "—")}${o.overUnder ? ` · O/U ${esc(o.overUnder)}` : ""}</span>`).join("")}
        ${pred ? `<span class="book hot">Cupcake Index model: ${lineText(pred, pred.spread)}</span>` : ""}</div></div>`);
    }
    // win probability
    const wp = s.winprobability || [];
    if (wp.length > 2) col.right.push(`<div class="card"><h3>Win probability</h3>${wpChart(wp, away, home, tc)}</div>`);
    // head-to-head leaders (ESPN style): one row per category, away leader left, home leader right
    const colorOf = (teamId) => (String(teamId) === String(home.team.id) ? tc.home : tc.away);
    const LEAD_CATS = [["passingYards", "Passing"], ["rushingYards", "Rushing"], ["receivingYards", "Receiving"], ["totalTackles", "Tackles"], ["sacks", "Sacks"]];
    // ESPN drops "TD" when it's zero; always show it so a 0-TD line doesn't look incomplete
    const withTD = (dv) => /TD/.test(dv) || !/YDS/.test(dv) ? dv : /INT/.test(dv) ? dv.replace(/, (\d+ INT)/, ", 0 TD, $1") : `${dv}, 0 TD`;
    const leaderFor = (teamId, key) => {
      const tl = (s.leaders || []).find((x) => String(x.team?.id) === String(teamId));
      return (tl?.leaders || []).find((c) => c.name === key)?.leaders?.[0] || null;
    };
    const lside = (L, which, win) => {
      if (!L) return `<span class="lside ${which} empty">–</span>`;
      const a = L.athlete, big = L.mainStat?.value ?? L.displayValue;
      const txt = `<span class="ltxt"><b>${esc(a.shortName || a.displayName)}</b><small>${esc(a.position?.abbreviation || "")} · ${esc(withTD(L.displayValue))}</small></span>`;
      const num = `<span class="lbig${win ? " win" : ""}">${esc(big)}</span>`;
      const pic = img(a.headshot?.href, "leadshot");
      return `<a class="lside ${which}" href="${link("player", a.id)}">${which === "away" ? pic + txt + num : num + txt + pic}</a>`;
    };
    const leadRows = LEAD_CATS.map(([key, label]) => {
      const A = leaderFor(away.team.id, key), H = leaderFor(home.team.id, key);
      if (!A && !H) return "";
      const av = A?.value ?? -1, hv = H?.value ?? -1;
      const unit = (A || H).mainStat?.label || "";
      return `<div class="lrow">${lside(A, "away", av > hv)}<span class="lcat">${label}<small>${esc(unit)}</small></span>${lside(H, "home", hv > av)}</div>`;
    }).join("");
    const leadersStrip = leadRows ? `<div class="card h2h" style="--ac:${tc.away};--hc:${tc.home}">
        <div class="h2h-head"><span>${img(teamLogo(away.team), "sm")} ${esc(away.team.abbreviation)}</span><h3>${st === "pre" ? "Season leaders" : "Game leaders"}</h3><span>${esc(home.team.abbreviation)} ${img(teamLogo(home.team), "sm")}</span></div>
        ${leadRows}</div>` : "";
    // team stats
    const bt = s.boxscore?.teams || [];
    if (bt.length === 2 && bt[0].statistics?.length) {
      const byId = Object.fromEntries(bt.map((t) => [t.team.id, t]));
      const A = byId[away.team.id] || bt[0], H = byId[home.team.id] || bt[1];
      col.right.push(`<div class="card"><h3>Team stats</h3><table class="teamstats"><thead><tr><th></th><th class="num">${esc(away.team.abbreviation)}</th><th class="num">${esc(home.team.abbreviation)}</th></tr></thead><tbody>
        ${A.statistics.map((x, i) => `<tr><td>${esc(x.label)}</td><td class="num">${esc(x.displayValue)}</td><td class="num">${esc(H.statistics[i]?.displayValue ?? "")}</td></tr>`).join("")}</tbody></table></div>`);
    }
    // player box score, split into Offense / Defense / Special Teams tabs
    const bp = s.boxscore?.players || [];
    if (bp.length) {
      const GROUPS = { off: ["passing", "rushing", "receiving", "fumbles"], def: ["defensive", "interceptions"], st: ["kicking", "punting", "kickReturns", "puntReturns"] };
      const all = [...new Set(bp.flatMap((t) => t.statistics.map((x) => x.name)))];
      const section = (cn) => `<h4>${esc(CAT_NAME[cn] || cn)}</h4><div class="box-pair">${bp.map((t) => {
        const cat = t.statistics.find((x) => x.name === cn);
        if (!cat || !cat.athletes?.length) return `<div></div>`;
        return `<div class="table-wrap"><table class="box"><thead><tr><th><span class="sb-chip" style="--c:${colorOf(t.team.id)}"></span>${esc(t.team.abbreviation)}</th>${cat.labels.map((l) => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead><tbody>
          ${cat.athletes.map((a) => `<tr><td><a href="${link("player", a.athlete.id)}">${esc(a.athlete.displayName)}</a></td>${a.stats.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`).join("")}
          ${cat.totals?.length ? `<tr class="tot"><td>Team</td>${cat.totals.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>` : ""}</tbody></table></div>`;
      }).join("")}</div>`;
      const tabs = [["off", "Offense"], ["def", "Defense"], ["st", "Special Teams"]].filter(([k]) => GROUPS[k].some((c) => all.includes(c)));
      if (!tabs.some(([k]) => k === boxTab)) boxTab = tabs[0]?.[0] || "off";
      col.full.push(`<div class="card" id="boxscore"><div class="box-head"><h3>Box score</h3>
        <div class="seg box-tabs">${tabs.map(([k, l]) => `<button data-bt="${k}" class="${k === boxTab ? "active" : ""}">${l}</button>`).join("")}</div></div>
        ${tabs.map(([k]) => `<div class="box-sec${k === boxTab ? "" : " hidden"}" data-sec="${k}">${GROUPS[k].filter((c) => all.includes(c)).map(section).join("")}</div>`).join("")}</div>`);
    }
    // scoring plays
    const sp = s.scoringPlays || [];
    if (sp.length) {
      col.right.push(`<div class="card"><h3>Scoring plays</h3><table class="plays"><tbody>${sp.map((p) => `<tr>
        <td class="muted">Q${esc(p.period?.number)} ${esc(p.clock?.displayValue || "")}</td><td>${img(p.team?.logo, "sm")}</td>
        <td><b>${esc(p.type?.abbreviation || "")}</b> ${esc(p.text)}</td><td class="num">${esc(p.awayScore)}-${esc(p.homeScore)}</td></tr>`).join("")}</tbody></table></div>`);
    }
    // injuries (mostly useful before kickoff)
    const inj = (s.injuries || []).filter((t) => t.injuries?.length);
    if (inj.length && st !== "post") {
      col.right.push(`<div class="card"><h3>Injuries</h3><div class="box-pair">${inj.map((t) => `<div><b>${esc(t.team?.displayName || "")}</b><ul class="inj">${t.injuries.slice(0, 15).map((i) =>
        `<li><a href="${link("player", i.athlete?.id)}">${esc(i.athlete?.displayName)}</a> <span class="muted">${esc(i.athlete?.position?.abbreviation || "")}</span> <span class="pill over">${esc(i.status)}</span></li>`).join("")}</ul></div>`).join("")}</div></div>`);
    }
    view("game").innerHTML = `<p><a href="${link("scores")}" class="boxlink">← Scores</a></p>${head}${leadersStrip}<div class="game-cols"><div class="gcol">${col.left.join("")}</div><div class="gcol">${col.right.join("")}</div></div>${col.full.join("")}`;
    if (wp.length > 2) initWp(wp, s, away, home);
    const bx = $("#boxscore .box-tabs");
    if (bx) bx.onclick = (e) => {
      const k = e.target.dataset.bt;
      if (!k) return;
      boxTab = k;
      bx.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.bt === k));
      document.querySelectorAll("#boxscore .box-sec").forEach((sec) => sec.classList.toggle("hidden", sec.dataset.sec !== k));
    };
    if (st === "in") poll((r) => game(id, params, r), 20000);
  }

  function wpChart(wp, away, home, tc = {}) {
    const W = 600, H = 160, n = wp.length;
    const pts = wp.map((p, i) => `${((i / (n - 1)) * W).toFixed(1)},${((1 - p.homeWinPercentage) * H).toFixed(1)}`).join(" ");
    const last = wp[n - 1].homeWinPercentage;
    const lead = last >= 0.5 ? home : away, pct = Math.round((last >= 0.5 ? last : 1 - last) * 100);
    return `<p class="note">${esc(lead.team.displayName)} ${pct}% <span class="muted">· hover or drag across the chart</span></p>
      <div class="wp-box" id="wp-box">
        <svg viewBox="0 0 ${W} ${H}" class="wp" preserveAspectRatio="none" role="img" aria-label="Win probability over the game">
          <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="wp-mid"/>
          <defs><clipPath id="wp-top"><rect x="0" y="0" width="${W}" height="${H / 2}"/></clipPath><clipPath id="wp-bot"><rect x="0" y="${H / 2}" width="${W}" height="${H / 2}"/></clipPath></defs>
          <polygon points="0,${H / 2} ${pts} ${W},${H / 2}" class="wp-area" clip-path="url(#wp-top)" style="fill:${tc.home || "var(--accent)"}"/>
          <polygon points="0,${H / 2} ${pts} ${W},${H / 2}" class="wp-area" clip-path="url(#wp-bot)" style="fill:${tc.away || "var(--accent)"}"/>
          <polyline points="${pts}" class="wp-line"/>
        </svg>
        <div class="wp-cursor hidden"><div class="wp-vline"></div><div class="wp-dot"></div><div class="wp-tip"></div></div>
      </div>
      <div class="wp-labels"><span><i class="sb-chip" style="--c:${tc.home}"></i>▲ ${esc(home.team.abbreviation)}</span><span><i class="sb-chip" style="--c:${tc.away}"></i>▼ ${esc(away.team.abbreviation)}</span></div>`;
  }

  // Stock-chart style hover: a dot rides the line and a tooltip shows the win % and the play at that moment.
  function initWp(wp, s, away, home) {
    const box = $("#wp-box");
    if (!box) return;
    const plays = new Map();
    const drives = [...(s.drives?.previous || []), ...(s.drives?.current ? [s.drives.current] : [])];
    drives.forEach((d) => (d.plays || []).forEach((p) => plays.set(String(p.id), p)));
    const cur = box.querySelector(".wp-cursor"), dot = box.querySelector(".wp-dot"), vline = box.querySelector(".wp-vline"), tip = box.querySelector(".wp-tip");
    const A = away.team.abbreviation, Hm = home.team.abbreviation;
    const show = (clientX) => {
      const r = box.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const i = Math.round(f * (wp.length - 1)), p = wp[i];
      const x = (i / (wp.length - 1)) * r.width, y = (1 - p.homeWinPercentage) * r.height;
      const hp = p.homeWinPercentage, homeLeads = hp >= 0.5;
      const pct = (Math.max(hp, 1 - hp) * 100).toFixed(1);
      const play = plays.get(String(p.playId));
      cur.classList.remove("hidden");
      vline.style.left = dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
      dot.classList.toggle("away", !homeLeads);
      tip.innerHTML = `<b>${esc(homeLeads ? Hm : A)} ${pct}%</b>` + (play
        ? `<small>Q${esc(play.period?.number)} ${esc(play.clock?.displayValue || "")} · ${esc(A)} ${esc(play.awayScore)}-${esc(play.homeScore)} ${esc(Hm)}</small>
           <small class="wp-play">${esc((play.text || "").slice(0, 120))}</small>` : "");
      tip.style.left = `${x}px`;
      tip.classList.toggle("flip", x > r.width * 0.55);
    };
    box.addEventListener("pointermove", (e) => show(e.clientX));
    box.addEventListener("pointerdown", (e) => show(e.clientX));
    box.addEventListener("pointerleave", () => cur.classList.add("hidden"));
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
  // ---------------------------------------------------------------- career stats by year (+ compare)
  const LEAGUE_OF = { nfl: "nfl", cfb: "cfb", "college-football": "cfb" };
  const DEF_POS = new Set(["LB", "OLB", "ILB", "MLB", "DE", "DT", "DL", "NT", "EDGE", "CB", "S", "SS", "FS", "DB", "SAF"]);
  const PRIMARY = (pos) => pos === "QB" ? "passing" : ["RB", "FB", "HB"].includes(pos) ? "rushing" : ["WR", "TE"].includes(pos) ? "receiving"
    : pos === "K" || pos === "PK" ? "kicking" : pos === "P" ? "punting" : DEF_POS.has(pos) ? "defensive" : null;
  const KEY_METRIC = { passing: "passingYards", rushing: "rushingYards", receiving: "receivingYards", defensive: "totalTackles",
    kicking: "fieldGoalsMade", punting: "puntYards", scoring: "totalPoints", returning: "kickReturnYards" };
  const CAT_LABEL = { passing: "Passing", rushing: "Rushing", receiving: "Receiving", defensive: "Defense", defensiveInterceptions: "Interceptions",
    kicking: "Kicking", punting: "Punting", scoring: "Scoring", returning: "Returns" };
  const CMP_COLORS = ["var(--accent)", "#e8e8e8", "#8f96a3", "#5aa9e6"];
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(n) ? null : n; };

  // One player's career: bio + every season, pro and college, keyed by category and stat name
  async function career(lg, id) {
    const bio = (await api(`${WEB(lg)}/athletes/${encodeURIComponent(id)}`, 600000)).athlete;
    const sources = [[lg, id, lg === "nfl" ? "NFL" : "NCAA"]];
    if (lg === "nfl" && bio.collegeAthlete?.id) sources.push(["cfb", bio.collegeAthlete.id, "NCAA"]);
    const got = await Promise.all(sources.map(([l, pid]) => api(`${WEB(l)}/athletes/${encodeURIComponent(pid)}/stats`, 600000).catch(() => null)));
    const cats = {};
    got.forEach((d, i) => {
      if (!d) return;
      const level = sources[i][2];
      for (const c of d.categories || []) {
        const C = (cats[c.name] ||= { names: [], labels: {}, rows: [] });
        c.names.forEach((n, j) => { if (!C.names.includes(n)) C.names.push(n); C.labels[n] = c.labels[j]; });
        for (const r of c.statistics || []) {
          if (/totals|all-?stars?/i.test(r.teamSlug || "")) continue; // skip summary rows and all-star exhibitions
          const t = d.teams?.[r.teamSlug] || {};
          C.rows.push({ year: r.season?.year, level, team: { abbr: t.abbreviation || "", logo: t.logos?.[0]?.href, color: t.color },
            vals: Object.fromEntries(c.names.map((n, j) => [n, r.stats[j]])) });
        }
      }
    });
    Object.values(cats).forEach((C) => {
      // ESPN sometimes repeats a season with no team attached; keep one row per season per level
      const seen = new Map();
      for (const r of C.rows) {
        const k = `${r.year}|${r.level}`, prev = seen.get(k);
        if (!prev || (!prev.team.abbr && r.team.abbr)) seen.set(k, r);
        else if (prev.team.abbr && r.team.abbr && prev.team.abbr !== r.team.abbr) seen.set(k + "|" + r.team.abbr, r); // real mid-season move
      }
      C.rows = [...seen.values()].sort((a, b) => a.year - b.year || (a.level === "NCAA" ? -1 : 1));
    });
    return { id, lg, name: bio.displayName, short: bio.shortName || bio.displayName, pos: bio.position?.abbreviation, headshot: bio.headshot?.href, cats };
  }

  function careerCard(players, st) {
    const main = players[0];
    const catNames = Object.keys(main.cats).filter((k) => main.cats[k].rows.length);
    if (!catNames.length) return `<div class="card"><h3>Stats by year</h3><p class="muted">No season stats available.</p></div>`;
    const cat = catNames.includes(st.cat) ? st.cat : catNames.includes(PRIMARY(main.pos)) ? PRIMARY(main.pos) : catNames[0];
    const C = main.cats[cat];
    const metric = C.names.includes(st.metric) ? st.metric : C.names.includes(KEY_METRIC[cat]) ? KEY_METRIC[cat] : C.names.find((n) => /yards/i.test(n)) || C.names[1] || C.names[0];
    const align = st.align === "career" ? "career" : "season";
    const series = players.map((p, i) => {
      const rows = (p.cats[cat]?.rows || []).filter((r) => num(r.vals[metric]) != null);
      return { p, color: CMP_COLORS[i], rows: rows.map((r, k) => ({ ...r, x: align === "career" ? k + 1 : r.year, v: num(r.vals[metric]) })) };
    });
    const xs = [...new Set(series.flatMap((s) => s.rows.map((r) => r.x)))].sort((a, b) => a - b);
    const max = Math.max(1, ...series.flatMap((s) => s.rows.map((r) => r.v)));
    // grouped bar chart (SVG)
    const W = 720, H = 220, pad = 28, gw = (W - pad) / Math.max(1, xs.length), bw = Math.min(34, (gw - 10) / series.length);
    const bars = xs.map((x, gi) => series.map((sr, si) => {
      const r = sr.rows.find((q) => q.x === x);
      if (!r) return "";
      const h = (r.v / max) * (H - 40), bx = pad + gi * gw + (gw - bw * series.length) / 2 + si * bw, by = H - 20 - h;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${sr.color}" rx="2"><title>${esc(sr.p.name)} · ${r.year} ${esc(r.team.abbr)}: ${esc(r.vals[metric])} ${esc(C.labels[metric])}</title></rect>`
        + (series.length === 1 ? `<text x="${(bx + (bw - 2) / 2).toFixed(1)}" y="${(by - 5).toFixed(1)}" class="cc-val">${esc(r.vals[metric])}</text>` : "");
    }).join("") + `<text x="${(pad + gi * gw + gw / 2).toFixed(1)}" y="${H - 4}" class="cc-x">${align === "career" ? "Yr " + x : x}</text>`).join("");
    const chart = `<svg viewBox="0 0 ${W} ${H}" class="cc-chart" role="img" aria-label="${esc(C.labels[metric])} by ${align === "career" ? "career year" : "season"}">
      <line x1="${pad}" y1="${H - 20}" x2="${W}" y2="${H - 20}" class="cc-axis"/>${bars}</svg>`;
    const legend = series.map((sr, i) => `<span class="cc-chip" style="--c:${sr.color}">${img(sr.p.headshot, "hs")} ${esc(sr.p.name)} <small>${esc(sr.p.pos || "")}</small>
      ${i ? `<button class="cc-x-btn" data-rm="${esc(sr.p.lg)}:${esc(sr.p.id)}" aria-label="Remove">×</button>` : ""}</span>`).join("");

    const teamCell = (r) => `<span class="tm">${img(r.team.logo, "xs")} ${esc(r.team.abbr)}${r.level === "NCAA" && main.lg === "nfl" ? ' <span class="pill lvl">NCAA</span>' : ""}</span>`;
    let table;
    if (players.length === 1) {
      const cols = C.names.filter((n) => C.rows.some((r) => r.vals[n] != null));
      table = `<table class="box career"><thead><tr><th>Year</th><th>Team</th>${cols.map((n) => `<th class="num${n === metric ? " on" : ""}" title="${esc(n)}">${esc(C.labels[n])}</th>`).join("")}</tr></thead><tbody>
        ${C.rows.map((r) => `<tr><td>${r.year}</td><td>${teamCell(r)}</td>${cols.map((n) => `<td class="num${n === metric ? " on" : ""}">${esc(r.vals[n] ?? "–")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    } else {
      table = `<table class="box career"><thead><tr><th>${align === "career" ? "Career yr" : "Season"}</th>${series.map((sr) => `<th colspan="2" class="cc-h" style="--c:${sr.color}">${esc(sr.p.short)}</th>`).join("")}</tr></thead><tbody>
        ${xs.map((x) => `<tr><td>${align === "career" ? "Yr " + x : x}</td>${series.map((sr) => { const r = sr.rows.find((q) => q.x === x);
          return r ? `<td>${align === "career" ? `<small class="muted">${r.year}</small> ` : ""}${teamCell(r)}</td><td class="num on">${esc(r.vals[metric])}</td>` : `<td class="muted">–</td><td></td>`; }).join("")}</tr>`).join("")}
        <tr class="tot"><td>Total</td>${series.map((sr) => `<td></td><td class="num">${sr.rows.reduce((a, r) => a + r.v, 0).toLocaleString()}</td>`).join("")}</tr></tbody></table>`;
    }
    return `<div class="card career-card">
      <div class="sc-bar"><h3>Stats by year</h3>
        <div class="seg" id="cc-cats">${catNames.map((k) => `<button data-cat="${esc(k)}" class="${k === cat ? "active" : ""}">${esc(CAT_LABEL[k] || k)}</button>`).join("")}</div></div>
      <div class="cc-controls">
        <label>Chart <select id="cc-metric">${C.names.map((n) => `<option value="${esc(n)}"${n === metric ? " selected" : ""}>${esc(C.labels[n])}</option>`).join("")}</select></label>
        <label>Line up by <select id="cc-align"><option value="season"${align === "season" ? " selected" : ""}>Season</option><option value="career"${align === "career" ? " selected" : ""}>Career year</option></select></label>
        <div class="cc-search"><input id="cc-q" type="search" placeholder="Compare with another player…" autocomplete="off"${players.length >= 4 ? " disabled" : ""}><div id="cc-results" class="cc-results hidden"></div></div>
      </div>
      <div class="cc-legend">${legend}</div>
      ${chart}
      <div class="table-wrap">${table}</div>
    </div>`;
  }

  let playerIndexP = null; // all-time NFL player list, loaded the first time someone searches
  const playerIndex = () => (playerIndexP ||= fetch("data/players_nfl.json").then((r) => r.json()).catch(() => { playerIndexP = null; return []; }));

  // Players: all-time NFL index (includes retired legends) + ESPN's live search (active college and NFL players)
  async function searchPlayers(text, limit = 10) {
    const [index, d] = await Promise.all([
      playerIndex(),
      api(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(text)}&limit=20&type=player`, 60000).catch(() => null),
    ]);
    // forgiving match (typos, accents, punctuation); ties go to longer/more recent careers
    const scored = [];
    for (const p of index) { const sc = fuzzyScore(text, p[0]); if (sc != null) scored.push([sc, p]); }
    const local = scored.sort((a, b) => a[0] - b[0] || ((b[1][4] || 0) - (b[1][3] || 0)) - ((a[1][4] || 0) - (a[1][3] || 0)) || (b[1][4] || 0) - (a[1][4] || 0))
      .slice(0, 8).map(([, p]) => ({ key: `nfl:${p[1]}`, name: p[0], tag: `NFL · ${p[2]}${p[3] ? ` · ${p[3]}–${p[4] || ""}` : ""}` }));
    const seen = new Set(local.map((x) => x.key));
    const live = (d?.items || []).filter((it) => it.league === "nfl" || it.league === "college-football")
      .map((it) => ({ key: `${it.league === "nfl" ? "nfl" : "cfb"}:${it.id}`, name: it.displayName, tag: it.league === "nfl" ? "NFL" : "College" }))
      .filter((x) => !seen.has(x.key));
    return [...local, ...live].slice(0, limit);
  }

  function wireCareer(id, params) {
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.delete("league");
      location.hash = link("player", id, Object.fromEntries(p));
    };
    const vs = (params.get("vs") || "").split(",").filter(Boolean);
    $("#cc-cats").onclick = (e) => { const c = e.target.dataset.cat; if (c) go({ cat: c, metric: null }); };
    $("#cc-metric").onchange = (e) => go({ metric: e.target.value });
    $("#cc-align").onchange = (e) => go({ align: e.target.value });
    document.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => go({ vs: vs.filter((v) => v !== b.dataset.rm).join(",") })));
    const q = $("#cc-q"), box = $("#cc-results");
    let t;
    q.oninput = () => {
      clearTimeout(t);
      const text = q.value.trim();
      if (text.length < 2) { box.classList.add("hidden"); return; }
      t = setTimeout(async () => {
        const items = await searchPlayers(text);
        box.innerHTML = items.length ? items.map((it) => `<button data-add="${esc(it.key)}">${esc(it.name)} <small>${esc(it.tag)}</small></button>`).join("")
          : `<p class="muted">No football players found.</p>`;
        box.classList.remove("hidden");
      }, 200);
    };
    box.onclick = (e) => { const a = e.target.closest("[data-add]")?.dataset.add; if (a && !vs.includes(a)) go({ vs: [...vs, a].slice(0, 3).join(",") }); };
  }

  async function player(id, params) {
    const lg = league, my = token;
    loading("player");
    const season = params.get("season");
    const vs = (params.get("vs") || "").split(",").filter(Boolean).slice(0, 3);
    const careersP = Promise.all([career(lg, id), ...vs.map((v) => { const [l, pid] = v.split(":"); return career(LEAGUE_OF[l] || "nfl", pid); })]).catch(() => null);
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
      <div id="career-slot"><div class="card muted">Loading stats by year…</div></div>
      <div class="card"><div class="sc-bar"><h3>Game log</h3>
        <select id="pl-season">${years.map((y) => `<option${String(y) === (season || String(gl?.requestedSeason?.year || thisYear)) ? " selected" : ""}>${y}</option>`).join("")}</select></div>
        ${log || `<p class="muted">No games logged for this season.</p>`}</div>`;
    $("#pl-season").onchange = (e) => { location.hash = link("player", id, { season: e.target.value }); };
    const careers = await careersP;
    if (my !== token) return;
    $("#career-slot").innerHTML = careers ? careerCard(careers, { cat: params.get("cat"), metric: params.get("metric"), align: params.get("align") })
      : `<div class="card muted">Season-by-season stats aren't available for this player.</div>`;
    if (careers) wireCareer(id, params);
    if (vs.length) $("#career-slot").scrollIntoView({ block: "start" });
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
        : `<div class="table-wrap"><table class="box"><thead><tr><th>Week</th><th>Opponent</th><th>Result</th></tr></thead><tbody>${games}</tbody></table></div>`}</div>`;
  }

  return { stop, teamId, scores, game, stats, player, standings, team, searchPlayers };
})();
