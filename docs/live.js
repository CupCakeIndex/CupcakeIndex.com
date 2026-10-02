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
    // maxAge 0 = a live refresh: add a throwaway param so ESPN's edge cache can't hand back a stale copy
    const r = await fetch(maxAge ? url : `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`);
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
  const SIZES = { xs: [18, 18], sm: [22, 22], lg: [28, 28], xl: [56, 56], hero: [96, 96], hs: [30, 30], leadshot: [52, 52], headshot: [132, 96] }; // CSS display sizes
  let boxTab = "off"; // remembered across live refreshes
  const img = (src, cls = "lg") => {
    if (!safeUrl(src)) return `<span class="logo-ph ${cls}"></span>`;
    const [w, h] = SIZES[cls] || [40, 40];
    const crop = cls === "leadshot" || cls === "hs"; // round headshots: square crop centered on the face
    return `<img src="${esc(thumb(src, w, h, crop))}" alt="" loading="lazy" decoding="async" width="${w}" height="${h}" class="${cls}">`;
  };
  // A player's picture, or their initials when ESPN has no headshot (common for retired players).
  // wiki: also look for a Wikipedia photo (NFL players only; born = birth year, to rule out namesakes).
  const initials = (n) => { const w = (n || "").replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "").split(/\s+/).filter(Boolean); return ((w[0]?.[0] || "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase(); };
  const face = (src, name, cls, wiki = false, born = "") => safeUrl(src) ? img(src, cls)
    : `<span class="logo-ph ph-face ${cls}"${wiki ? ` data-wiki="${esc(name)}" data-born="${esc(born)}"` : ""} role="img" aria-label="${esc(name)}">${esc(initials(name))}</span>`;
  const wikiPics = new Map();
  function wikiPhoto(name, born) {
    if (!wikiPics.has(name)) wikiPics.set(name, (async () => {
      for (const title of [`${name} (American football)`, name]) {
        try {
          const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);
          if (!r.ok) continue;
          const d = await r.json(), desc = d.description || "";
          // must be an American football article, and the same person (birth year) when both sides know it
          if (d.type !== "standard" || !/american football|gridiron|\bNFL\b/i.test(desc)) continue;
          const b = desc.match(/born (\d{4})/)?.[1];
          if (born && b && b !== String(born)) continue;
          return safeUrl(d.thumbnail?.source) || null;
        } catch { /* try the next title */ }
      }
      return null;
    })());
    return wikiPics.get(name);
  }
  // Swap initials placeholders for Wikipedia photos where one is found
  function fillFaces(root) {
    root.querySelectorAll(".ph-face[data-wiki]").forEach((el) => {
      const cls = [...el.classList].find((c) => SIZES[c]);
      wikiPhoto(el.dataset.wiki, el.dataset.born).then((u) => {
        if (u && el.isConnected) el.outerHTML = img(u, cls).replace('class="', `title="Photo: Wikipedia" class="wiki `);
      });
    });
  }
  const teamLogo = (t) => t?.logo || t?.logos?.[0]?.href || "";
  const kickoff = (d) => new Date(d).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  const clockNow = () => new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const liveBadge = (on) => (on ? `<span class="live-dot"></span> Live · updated ${clockNow()}` : "");

  // ---------------------------------------------------------------- injury tags
  // A compact status tag (Q, D, O, IR, PUP...) from an ESPN injury entry; the tooltip has the body part and expected return.
  const INJ_ABBR = { questionable: "Q", doubtful: "D", out: "O", "injured reserve": "IR", "physically unable to perform": "PUP", "non-football injury": "NFI",
    suspension: "SUSP", suspended: "SUSP", "day-to-day": "DTD", probable: "P" };
  const notSpec = (s) => (s && !/not specified/i.test(s) ? s : "");
  function injInfo(i) {
    const status = i?.status || i?.type?.description || "";
    if (!status || /^active$/i.test(status)) return null;
    const ab = (i.type?.abbreviation && i.type.abbreviation !== "A" ? i.type.abbreviation : INJ_ABBR[status.toLowerCase()])
      || status.split(/\W+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 4);
    const d = i.details || {};
    const part = [notSpec(d.side), d.type, notSpec(d.detail) !== d.type ? notSpec(d.detail) : ""].filter(Boolean).join(" ");
    const back = d.returnDate ? new Date(d.returnDate.slice(0, 10) + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const level = /^(Q|P|DTD)$/.test(ab) ? "q" : ab === "D" ? "d" : "o";
    return { ab, level, status: status[0].toUpperCase() + status.slice(1), part, tip: [status[0].toUpperCase() + status.slice(1), part, back ? `est. return ${back}` : ""].filter(Boolean).join(" · ") };
  }
  // Every tag with a player id is a link: with tid (team id) it goes to that player's row on the team's roster
  // (#/team/ID?tab=roster&hl=PLAYER); without one (a free agent) it goes to the player's page and its injury card (?inj=1)
  const injTag = (i, pid = "", tid = "") => {
    const x = injInfo(i);
    return x ? `<span class="inj-tag inj-${x.level}${pid ? " go" : ""}" title="${esc(x.tip)}${pid ? ` · click for ${tid ? "the latest" : "details"}` : ""}"${pid ? ` data-pid="${esc(pid)}" role="link" tabindex="0"` : ""}${pid && tid ? ` data-tid="${esc(tid)}"` : ""}>${esc(x.ab)}</span>` : "";
  };
  // Tags often sit inside a player link, so they navigate from one shared handler instead of nesting another <a>
  const injGo = (e) => {
    const t = e.target.closest?.(".inj-tag[data-pid]");
    if (!t || (e.type === "keydown" && e.key !== "Enter")) return;
    e.preventDefault();
    e.stopPropagation();
    const { pid, tid } = t.dataset;
    const h = tid ? link("team", tid, { tab: "roster", hl: pid }) : link("player", pid, { inj: 1 });
    if (location.hash !== h) location.hash = h;
    else if (tid) highlightRow(pid);
    else pulse(view("player").querySelector("#pl-inj"));
  };
  document.addEventListener("click", injGo);
  document.addEventListener("keydown", injGo);
  // Scroll to a roster row or the player's injury card and give it a soft glow (gentler than the Schedules chart's ring)
  function pulse(el) {
    if (!el) return;
    el.classList.remove("hl-row");
    void el.offsetWidth; // restart the animation on a repeat click
    el.classList.add("hl-row");
    el.scrollIntoView({ block: "center" });
  }
  function highlightRow(pid) {
    view("team").querySelectorAll("tr.hl-row").forEach((r) => r.classList.remove("hl-row"));
    pulse(view("team").querySelector(`tr[data-pid="${CSS.escape(String(pid))}"]`));
  }
  // League-wide NFL injury report (big, so only used to add detail to tags that are already on screen)
  const athleteIdOf = (a) => a?.id || (a?.links?.[0]?.href || "").match(/\/id\/(\d+)/)?.[1] || null;
  async function injuryMap() {
    const d = await api(`${SITE("nfl")}/injuries`, 900000);
    const m = new Map();
    (d.injuries || []).forEach((t) => (t.injuries || []).forEach((i) => { const id = athleteIdOf(i.athlete); if (id && !m.has(id)) m.set(id, i); }));
    return m;
  }

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
    const yr = params.get("season");
    if (yr) q.set("dates", yr); // past seasons: ESPN has scoreboards back to 1999 (NFL) / 2001 (college)
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
      <div class="sc-bar"><select id="sc-season">${Array.from({ length: new Date().getFullYear() - (lg === "nfl" ? 1999 : 2001) + 1 }, (_, i) => new Date().getFullYear() - i)
        .map((y) => `<option${y === season ? " selected" : ""}>${y}</option>`).join("")}</select><select id="sc-week">${weekOpts}</select>${grpSel}<span class="muted live-note">${liveBadge(live.length)}</span></div>
      ${section("Live now", live)}${section("Upcoming", pre)}${section("Final", post)}
      ${events.length ? "" : `<div class="card muted">No games this week.</div>`}`;
    const go = (k, v) => { const p = new URLSearchParams(params); p.set(k, v); p.set("league", lg); location.hash = `#/scores?${p}`; };
    $("#sc-week").onchange = (e) => go("week", e.target.value);
    $("#sc-season").onchange = (e) => { const p = new URLSearchParams(params); p.set("season", e.target.value); p.delete("week"); p.set("league", lg); location.hash = `#/scores?${p}`; };
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
    const model = p && chanceText(p) ? `<span${p.why ? ` title="${esc(p.why)}"` : ""}>Model: ${chanceText(p)}</span>` : "";
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

  // ---------------------------------------------------------------- live field (8-bit, Tecmo Bowl spirit)
  // ESPN's yardLine counts from the HOME goal line: 0 = home end zone (drawn on the left), 100 = away end zone.
  // The home team attacks to the right, the away team to the left.
  const PIXEL_FONT = "Press Start 2P";
  function pixelFont() {
    if (document.getElementById("font-pixel")) return;
    const l = document.createElement("link");
    l.id = "font-pixel"; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap";
    document.head.appendChild(l);
  }
  // A new play replays on the field (ball carrier runs / pass arcs / kick sails, then the teams line up again);
  // the same play on later refreshes just sits there with the players idling. tfSeen: game id -> {play, t}.
  const tfSeen = new Map();
  // "CLV 44" -> yard line from the home goal (0-100). ESPN's play text sometimes uses its own nicknames.
  const ABBR_ALIAS = { CLV: "CLE", ARZ: "ARI", BLT: "BAL", HST: "HOU", LA: "LAR", WSH: "WAS", JAC: "JAX" };
  function textSpot(t, home, away) {
    if (!t) return null;
    if (t === "50") return 50;
    const [ab, n] = t.trim().split(/\s+/), side = (ABBR_ALIAS[ab.toUpperCase()] || ab.toUpperCase());
    const is = (c) => [c.team.abbreviation, ABBR_ALIAS[c.team.abbreviation]].filter(Boolean).map((x) => x.toUpperCase()).includes(side);
    return is(away) ? 100 - +n : is(home) ? +n : null;
  }
  function liveField(s, comp, home, away, tc, gameId) {
    const drives = s.drives || {};
    const drive = drives.current || (drives.previous || []).at(-1);
    const play = drive?.plays?.at(-1);
    const spot = play?.end?.yardLine ?? play?.start?.yardLine;
    if (spot == null) return "";
    pixelFont();
    const seen = tfSeen.get(gameId);
    const fresh = !seen || seen.play !== String(play.id);
    if (fresh) tfSeen.set(gameId, { play: String(play.id), t: Date.now() });
    const since = (Date.now() - tfSeen.get(gameId).t) / 1000;
    const at = play.end?.down ? play.end : play.start?.down ? play.start : play.end || {};
    const possId = String(comp.competitors.find((c) => c.possession)?.team?.id || at.team?.id || drive.team?.id || "");
    const off = String(home.team.id) === possId ? home : String(away.team.id) === possId ? away : null;
    const dir = off === home ? 1 : off === away ? -1 : 0; // +1 = attacking right
    const toGo = dir > 0 ? 100 - spot : spot;
    const type = (play.type?.text || "").toLowerCase(), txt = (play.text || "").toLowerCase();
    const isTD = !!play.scoringPlay && /touchdown/.test(type + txt);
    const startTeam = String(play.start?.team?.id || play.team?.id) === String(home.team.id) ? home : away;
    const otherTeam = (t) => (t === home ? away : home);
    const defScore = /return touchdown|interception.*touchdown|fumble.*touchdown|safety/.test(type + " " + txt) && !/kickoff return|punt return/.test(type) ? true
      : /kickoff return touchdown|punt return touchdown/.test(type); // the team that didn't start the play scored
    const scorer = !play.scoringPlay ? null : defScore ? otherTeam(startTeam) : startTeam;
    const tdTeam = isTD ? scorer : null;
    // after any score the next play is a kickoff: the scorer kicks (after a safety, the team that gave it up kicks)
    const kicker = !play.scoringPlay ? null : /safety/.test(type + txt) ? startTeam : scorer;
    const down = at.down >= 1 && at.down <= 4 && !isTD ? at.down : 0, dist = down ? at.distance || 0 : 0; // ESPN marks scores as down -1
    const fd = down && dist && dist < toGo ? spot + dir * dist : null; // goal to go: no first-down line
    const X = (yl) => 100 + yl * 10; // 10 px per yard; 10-yard end zones
    const H = 300, col = (c) => (c === home ? tc.home : tc.away);
    const alt = (c) => (c.team.alternateColor ? "#" + c.team.alternateColor.replace("#", "") : "#ffffff");
    const r = (x, y, w, h, fill, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
    const base = [];
    // turf: 5-yard stripes in two greens, white lines, hash ticks, numbers
    for (let i = 0; i < 20; i++) base.push(r(X(i * 5), 0, 50, H, i % 2 ? "#2f8f3e" : "#28803a"));
    for (let yl = 0; yl <= 100; yl += 5) base.push(r(X(yl) - 1, 0, 3, H, "#ffffff", ` opacity="${yl % 50 ? 0.55 : 0.9}"`));
    for (let yl = 1; yl < 100; yl++) if (yl % 5) base.push(r(X(yl) - 1, 96, 2, 8, "#ffffff", ' opacity=".5"') + r(X(yl) - 1, 196, 2, 8, "#ffffff", ' opacity=".5"'));
    for (let yl = 10; yl <= 90; yl += 10) {
      const n = yl > 50 ? 100 - yl : yl;
      base.push(`<text x="${X(yl)}" y="40" class="tf-num">${n}</text><text x="${X(yl)}" y="276" class="tf-num">${n}</text>`);
    }
    // end zones in team colors, checkerboard edge, team abbreviation
    for (const [c, x0] of [[home, 0], [away, 1100]]) {
      base.push(r(x0, 0, 100, H, col(c)));
      for (let y = 0; y < H; y += 20) base.push(r(x0 === 0 ? 90 : 1100, y + (y / 20 % 2 ? 10 : 0), 10, 10, "#ffffff", ' opacity=".35"'));
      const cx = x0 + 47, rot = x0 === 0 ? -90 : 90;
      base.push(`<text x="${cx}" y="${H / 2}" class="tf-ez" fill="${alt(c)}" transform="rotate(${rot} ${cx} ${H / 2})">${esc(c.team.abbreviation || "")}</text>`);
    }
    for (const gx of [10, 1190]) base.push(r(gx - 3, 118, 6, 64, "#ffd21f") + r(gx - 6, 116, 12, 6, "#ffd21f") + r(gx - 6, 178, 12, 6, "#ffd21f"));
    // this drive so far, in the offense's color
    const start = drive?.start?.yardLine;
    if (off && start != null && start !== spot) {
      const a = Math.min(X(start), X(spot)), b = Math.max(X(start), X(spot));
      base.push(r(a, 0, b - a, H, col(off), ' opacity=".28"'));
    }

    // replay timing (seconds): the play runs 0.3-1.6, banner 1.2-3.2, teams walk to the new line 1.9-2.6
    const from = play.start?.yardLine ?? spot, moved = from !== spot;
    const anim = fresh;
    const appear = (t) => (anim && t ? ` opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${t}s" dur=".2s" fill="freeze"/` : "");
    // lines: blue line of scrimmage, yellow first-down line (they show up after the replay)
    const lines = isTD ? "" : `<g${appear(2.5)}>${r(X(spot) - 3, 0, 6, H, "#3d7bff")}${fd != null ? r(X(fd) - 3, 0, 6, H, "#ffd21f") : ""}</g>`;
    // pixel players (idle bob, staggered): offense behind the ball, defense across it
    let k = 0;
    const guy = (x, y, c, flip) => {
      const jersey = col(c), helm = alt(c);
      return `<g class="tf-guy" style="animation-delay:${-((k++ * 0.37) % 0.8).toFixed(2)}s">`
        + r(x - 6, y - 14, 12, 8, helm) + r(x - 8, y - 6, 16, 12, jersey) + r(x - 7, y + 6, 5, 8, "#f2f2f2") + r(x + 2, y + 6, 5, 8, "#f2f2f2")
        + r(x + (flip ? -9 : 5), y - 4, 4, 6, "#f5c9a6") + "</g>";
    };
    // formations: [role, yards off the ball, y]. Offense behind the ball, defense across it.
    const OFF_SET = [["ol", 1.6, 110], ["ol", 1.6, 130], ["c", 1.6, 150], ["ol", 1.6, 170], ["ol", 1.6, 190], ["qb", 5, 150], ["rb", 7.5, 132],
      ["wr", 1.6, 40], ["wr2", 1.6, 262], ["te", 2.8, 222]];
    const DEF_SET = [["dl", 1.6, 120], ["dl", 1.6, 140], ["dl", 1.6, 160], ["dl", 1.6, 180], ["lb", 5, 110], ["lb", 5, 150], ["lb", 5, 190],
      ["cb", 6, 40], ["cb", 6, 262], ["s", 11, 100], ["s", 11, 200]];
    const D = 2.4; // replay length (s): snap at .4, whistle at 2.4, then everyone resets at the new line
    const motion = (keys, len = D) => {
      if (!keys?.length) return "";
      const pts = [[0, 0, 0], ...keys];
      if (pts.at(-1)[0] < len) pts.push([len, pts.at(-1)[1], pts.at(-1)[2]]);
      return `<animateTransform attributeName="transform" type="translate" values="${pts.map((q) => `${q[1].toFixed(1)} ${q[2].toFixed(1)}`).join(";")}"
        keyTimes="${pts.map((q) => (q[0] / len).toFixed(3)).join(";")}" dur="${len}s" fill="freeze"/>`;
    };
    const ball = (x, y) => `<g class="tf-sh">${r(x - 9, y - 4, 18, 8, "#8b4a1f") + r(x - 6, y - 6, 12, 12, "#8b4a1f") + r(x - 4, y - 1, 8, 2, "#ffffff")}</g>`;
    // one formation at yard line `at`; odir = the offense's direction; moves(role, x, y) -> keyframes [[t, dx, dy], ...]
    const formation = (at, o, odir, moves = () => null, len = D) => {
      const d = o === home ? away : home, out = [];
      OFF_SET.forEach(([role, yd, y]) => { const x = X(at) - odir * yd * 10; out.push(`<g>${motion(moves(role, x, y, true), len)}${guy(x, y, o, odir < 0)}</g>`); });
      DEF_SET.forEach(([role, yd, y]) => { const x = X(at) + odir * yd * 10; out.push(`<g>${motion(moves(role, x, y, false), len)}${guy(x, y, d, odir > 0)}</g>`); });
      return out.join("");
    };
    const bx = X(spot) - dir * 6;
    const celebrate = (team, t) => {
      const right = (team === home) === true; // home scores going right (into the away end zone)
      const ez = right ? 1100 : 0, cc = [col(team), alt(team), "#ffd21f", "#ffffff"];
      const flash = `<rect x="${ez}" y="0" width="100" height="${H}" fill="${alt(team)}" opacity="0">
        <animate attributeName="opacity" values="0;.55;0" dur=".5s" begin="${t}s" repeatCount="5"/></rect>`;
      const confetti = Array.from({ length: 28 }, (_, i) => {
        const x = 120 + ((i * 397) % 960), d = 1.6 + (i % 5) * 0.35, b = t + (i % 7) * 0.22;
        return `<rect x="${x}" y="-12" width="8" height="8" fill="${cc[i % 4]}" opacity="0"><set attributeName="opacity" to="1" begin="${b}s"/>
          <animateTransform attributeName="transform" type="translate" values="0 0;${(i % 3 - 1) * 30} ${H + 24}" dur="${d}s" begin="${b}s" repeatCount="2" fill="freeze"/></rect>`;
      }).join("");
      const sx0 = ez + 50;
      const scorer = `<g opacity="0"><set attributeName="opacity" to="1" begin="${t}s"/><g>${guy(sx0, 150, team, !right)}${ball(sx0 + 2, 120)}
        <animateTransform attributeName="transform" type="translate" values="0 0;0 -18;0 0" dur=".45s" begin="${t}s" repeatCount="5"/></g>
        <animate attributeName="opacity" from="1" to="0" begin="${t + 2.4}s" dur=".4s" fill="freeze"/></g>`;
      return flash + scorer + confetti;
    };
    // after a touchdown the field is a party, not a formation
    // kickoff setup: kicking team across its own 35 with the ball on a tee, return team spread out, two returners deep
    const kickoffSet = (k) => {
      const kd = k === home ? 1 : -1, K = k === home ? 35 : 65, recv = otherTeam(k), out = [];
      [30, 55, 80, 105, 130, 170, 195, 220, 245, 270].forEach((y) => out.push(guy(X(K) - kd * 12, y, k, kd < 0)));
      out.push(guy(X(K) - kd * 70, 150, k, kd < 0)); // the kicker
      [60, 105, 150, 195, 240].forEach((y) => out.push(guy(X(K + kd * 15), y, recv, kd > 0)));
      [90, 150, 210].forEach((y) => out.push(guy(X(K + kd * 35), y, recv, kd > 0)));
      [120, 180].forEach((y) => out.push(guy(X(kd > 0 ? 95 : 5), y, recv, kd > 0)));
      return out.join("") + r(X(K) - 3, 156, 6, 6, "#ff8c1a") + ball(X(K), 150); // ball on a tee
    };
    const party = isTD && tdTeam ? celebrate(tdTeam, fresh ? 2.3 : 0) : "";
    const setupAt = !fresh ? 0 : isTD ? 5.2 : 2.5; // after a TD: replay, party, everyone jogs off, then the kickoff setup
    const lineup = kicker ? (fresh ? party : "") + `<g${appear(setupAt)}>${kickoffSet(kicker)}</g>`
      : off ? `<g${appear(2.5)}>${formation(spot, off, dir)}${ball(bx, 150)}</g>` : "";

    // penalties: "PENALTY on PIT-M.Pittman, False Start, 5 yards, enforced at PIT 22 - No Play."
    const isFlag = /penalty/.test(type + txt);
    const pm = /penalty on ([a-z]{2,4})-[^,]*,\s*([^,]+?),\s*(\d+)\s*yards?/i.exec(play.text || "");
    const flagInfo = !isFlag ? "" : /declined/.test(txt) ? "DECLINED" + (pm ? ` · ${pm[2].toUpperCase()}` : "")
      : pm ? `${pm[2].toUpperCase()} · ${pm[1].toUpperCase()} · ${pm[3]} YDS` : "";
    // pixel ref (black-and-white stripes, arm up) and a two-frame fluttering flag
    const refSprite = (x, y, throwing) => `<g class="tf-sh">` + r(x - 5, y - 16, 10, 5, "#111") + r(x - 4, y - 11, 8, 6, "#f5c9a6")
      + [0, 1, 2, 3].map((i) => r(x - 7, y - 5 + i * 3, 14, 3, i % 2 ? "#111" : "#f2f2f2")).join("")
      + r(x - 6, y + 7, 5, 9, "#111") + r(x + 1, y + 7, 5, 9, "#111")
      + (throwing ? `<g>${r(x + 7, y - 14, 3, 12, "#f2f2f2")}<animate attributeName="opacity" values="1;0" keyTimes="0;.5" dur=".5s" begin=".1s" repeatCount="2" calcMode="discrete"/></g>${r(x + 7, y - 4, 3, 10, "#f2f2f2")}` : "") + "</g>";
    const flagSprite = (x, y) => `<g><g>${r(x - 9, y - 6, 16, 10, "#ffd21f")}${r(x + 7, y - 6, 4, 4, "#ffffff")}${r(x - 9, y + 4, 8, 2, "#c9a400")}
        <animate attributeName="opacity" values="1;0;1" keyTimes="0;.5;1" dur=".24s" repeatCount="8" calcMode="discrete" fill="freeze"/></g>
      <g opacity="0">${r(x - 8, y - 8, 14, 12, "#ffd21f")}${r(x + 6, y - 8, 4, 4, "#ffffff")}${r(x - 8, y + 4, 6, 2, "#c9a400")}
        <animate attributeName="opacity" values="0;1;0" keyTimes="0;.5;1" dur=".24s" repeatCount="8" calcMode="discrete" fill="freeze"/></g></g>`;
    const flagOnField = isFlag ? `<g>${flagSprite(X(from) + (String(play.start?.team?.id) === String(home.team.id) ? 1 : -1) * 18, 176)}</g>` : "";

    // the replay itself
    let replay = "", banner = "";
    if (anim) {
      const pdir = String(play.start?.team?.id) === String(home.team.id) ? 1 : -1; // direction of the team that ran the play
      const sx = X(from), ex = isTD ? X(pdir > 0 ? 104 : -4) : X(spot); // touchdowns finish in the end zone
      const carrier = play.start?.team?.id && String(play.start.team.id) === String(home.team.id) ? home : away;
      const pteam = carrier, dteam = pteam === home ? away : home;
      const isFG = /field goal|extra point/.test(type), isPunt = /punt/.test(type), isKO = /kickoff/.test(type), isKick = isFG || isPunt || isKO;
      const fgGood = isFG && /good/.test(type + txt) && !/no good|missed|blocked/.test(type + txt);
      const isSack = /sack/.test(type), isKneel = /kneel/.test(type + txt), isSpike = /spike/.test(type + txt);
      const isPass = !isKick && !isSack && !isSpike && (/pass/.test(type) || /\bpass\b/.test(txt));
      const isInt = isPass && /intercept/.test(type + txt), incomplete = isPass && !isInt && /incomplet/.test(type + txt);
      const isRun = !isKick && !isPass && !isSack && !isKneel && !isSpike && moved && !/penalty/.test(type);
      const qbx = sx - pdir * 50, drop = qbx - pdir * 30, rbx = sx - pdir * 75;
      // where the ball is caught: the end spot on a completion; on a pick, the spot in the text
      // ("INTERCEPTED by D.Ward at CLV 44"); ~15 yds downfield on an incompletion
      const intAt = isInt ? textSpot((play.text || "").match(/intercepted by .*? at ([A-Z]{2,4} \d{1,2}|50)/i)?.[1], home, away) : null;
      const catchX = isInt && intAt != null ? X(intAt) : incomplete || isInt ? sx + pdir * 150 : ex, catchY = 100;
      const postX = pdir > 0 ? 1190 : 10; // goalposts at the back of the end zone being attacked
      const kickFrom = isFG ? sx - pdir * 70 : isPunt ? sx - pdir * 140 : sx;
      const kickTo = isFG ? postX : isKO && /touchback/.test(txt) ? X(pdir > 0 ? 105 : -5) : ex;
      const chase = (x, y, tx, ty, f, t = 1.9) => [[t, (tx - x) * f, (ty - y) * f]];
      const moves = (role, x, y, isOff) => {
        if (isRun) {
          if (isOff) return role === "rb" ? [[0.6, sx - pdir * 40 - x, 150 - y], [1.9, ex - x, 150 - y]]
            : role === "qb" ? [[0.6, -pdir * 10, 0]] : role.startsWith("wr") ? [[1.9, pdir * 110, 0]] : [[0.9, pdir * 16, 0]];
          return chase(x, y, ex + pdir * 12, 150, role === "s" || role === "cb" ? 0.75 : 0.6);
        }
        if (isPass) {
          if (isOff) return role === "qb" ? [[0.9, drop - x, 0]] : role === "wr" ? [[1.6, catchX - x, catchY - y], [1.9, catchX - x + pdir * (incomplete ? 12 : 0), catchY - y]]
            : role === "wr2" ? [[1.9, pdir * 160, 0]] : role === "te" ? [[1.9, pdir * 110, -40]] : role === "rb" ? [[0.9, -pdir * 6, 14]]
              : isInt ? [[0.8, -pdir * 10, 0], [2.2, (ex - x) * 0.5, (150 - y) * 0.5]] : [[0.8, -pdir * 10, 0]];
          if (isInt && role === "cb" && y === 40) return [[1.55, catchX + pdir * 8 - x, catchY - y], [2.3, ex - x, 150 - y]]; // jumps the route, runs it back
          return role === "dl" ? chase(x, y, drop, 150, 0.55, 1.2) : chase(x, y, catchX + pdir * 14, catchY, role === "lb" ? 0.5 : 0.8);
        }
        if (isSack) {
          if (isOff) return role === "qb" ? [[1.2, ex - x, 0]] : [[0.8, -pdir * 10, 0]];
          return role === "dl" && y === 140 ? [[1.2, ex + pdir * 8 - x, 150 - y]] : chase(x, y, ex, 150, 0.4);
        }
        if (isKneel || isSpike) return isOff && role === "qb" ? [[0.6, sx - pdir * 14 - x, 0]] : null;
        if (isFG) return isOff ? (role === "qb" ? [[0.4, kickFrom - x, 0]] : role === "rb" ? [[0.4, kickFrom - pdir * 20 - x, 0], [0.55, kickFrom - x, 0]] : null)
          : role === "dl" ? [[0.6, -pdir * 12, 0]] : null;
        if (isPunt) return isOff ? (role === "qb" ? [[0.4, kickFrom - x, 0]] : [[2.2, pdir * 240, 0]])
          : role === "s" && y === 100 ? [[1.7, kickTo - x, 150 - y], [2.3, ex - x, 150 - y]] : chase(x, y, ex, 150, 0.4, 2.2);
        if (isKO) return isOff ? [[2.2, pdir * 260, 0]] : chase(x, y, kickTo, 150, 0.35, 2.2);
        return null; // timeouts, pre-snap flags: everyone holds
      };
      // the ball: snapped to the QB, then carried, thrown or kicked
      const held = (keys) => `<g transform="translate(${sx} 150)"><g>${ball(0, 0)}${motion(keys)}</g></g>`;
      const flying = (begin, dur, path, then = "") => `<g opacity="0">${ball(0, 0)}<set attributeName="opacity" to="1" begin="${begin}s" fill="freeze"/>
          <animateMotion path="${path}" begin="${begin}s" dur="${dur}s" fill="freeze"/>${then}</g>`;
      let pig = "";
      if (isRun) pig = held([[0.4, qbx - sx, 0], [0.6, -pdir * 40, 0], [1.9, ex - sx + pdir * 10, 0]]);
      else if (isSack) pig = held([[0.4, qbx - sx, 0], [1.2, ex - sx, 0]]);
      else if (isKneel || isSpike) pig = held([[0.4, -pdir * 14, 0], ...(isSpike ? [[0.7, -pdir * 10, 30]] : [])]);
      else if (isPass) {
        const throwHand = held([[0.4, qbx - sx, 0], [0.9, drop - sx, 0]]).replace("</g></g>", `<set attributeName="opacity" to="0" begin=".95s" fill="freeze"/></g></g>`);
        if (incomplete) { // sails past the receiver, skids into the turf with a little bounce
          const land = catchX + pdir * 40;
          pig = throwHand + flying(0.95, 0.9, `M${drop},150 Q${(drop + land) / 2},-10 ${land},120 L${land + pdir * 14},112 L${land + pdir * 24},122`);
        } else if (isInt) { // picked: the corner catches it and carries it back
          pig = throwHand + `<g opacity="0">${ball(0, 0)}<set attributeName="opacity" to="1" begin=".95s" fill="freeze"/>
            <animateMotion path="M${drop},150 Q${(drop + catchX) / 2},-10 ${catchX + pdir * 8},${catchY} L${ex},150" keyPoints="0;.72;1" keyTimes="0;.45;1" calcMode="linear" begin=".95s" dur="1.35s" fill="freeze"/></g>`;
        } else pig = throwHand + flying(0.95, 0.65, `M${drop},150 Q${(drop + catchX) / 2},-10 ${catchX},${catchY}`);
      } else if (isFG) { // snap, hold, kick: through the posts, or wide
        pig = held([[0.4, kickFrom - sx, 0]]).replace("</g></g>", `<set attributeName="opacity" to="0" begin=".6s" fill="freeze"/></g></g>`)
          + flying(0.6, 1.1, `M${kickFrom},150 Q${(kickFrom + postX) / 2},-40 ${postX},${fgGood ? 150 : 70}`);
      } else if (isKick) pig = flying(isPunt ? 0.6 : 0.4, 1.3, `M${kickFrom},150 Q${(kickFrom + kickTo) / 2},-60 ${kickTo},150`);
      else pig = ball(sx - pdir * 6, 150);
      const exitLen = 5.0;
      const offField = (role, x, y, isOff) => {
        const k = moves(role, x, y, isOff) || [], last = k.at(-1) || [0, 0, 0], endY = y + last[2];
        return [...k, [3.6, last[1], last[2]], [4.9, last[1] + (isOff ? -pdir : pdir) * 30, (endY < 150 ? -40 : H + 40) - y]];
      };
      replay = isTD
        ? `<g>${formation(from, pteam, pdir, offField, exitLen)}<g>${pig}<animate attributeName="opacity" from="1" to="0" begin="${D}s" dur=".2s" fill="freeze"/></g>
            <animate attributeName="opacity" from="1" to="0" begin="${exitLen}s" dur=".2s" fill="freeze"/></g>`
        : `<g>${formation(from, pteam, pdir, moves)}${pig}<animate attributeName="opacity" from="1" to="0" begin="${D}s" dur=".2s" fill="freeze"/></g>`;
      if (isFlag) { // a striped ref steps up at the sideline and tosses a fluttering flag to the spot
        const rx = Math.max(130, Math.min(1070, sx + pdir * 40)), land = sx + pdir * 18;
        replay += `<g opacity="0"><set attributeName="opacity" to="1" begin="0s" fill="freeze"/>${refSprite(rx, 30, true)}
          <animate attributeName="opacity" from="1" to="0" begin="2.6s" dur=".3s" fill="freeze"/></g>`;
        replay += `<g opacity="0">${flagSprite(0, 0)}<set attributeName="opacity" to="1" begin=".35s" fill="freeze"/>
          <animateMotion path="M${rx + 8},24 Q${(rx + land) / 2},-50 ${land},176" begin=".35s" dur=".95s" fill="freeze"/></g>`;
      }
      const big = isTD ? "TOUCHDOWN!" : isFG ? (fgGood ? "IT'S GOOD!" : /blocked/.test(type + txt) ? "BLOCKED!" : "NO GOOD!")
        : isInt ? "PICKED OFF!" : /fumble/.test(type + txt) && /recover/.test(txt) ? "FUMBLE!" : isSack ? "SACK!" : /safety/.test(type + txt) ? "SAFETY!"
          : isFlag ? "FLAG!" : incomplete ? "INCOMPLETE" : /touchback/.test(txt) ? "TOUCHBACK" : /fair catch/.test(txt) ? "FAIR CATCH"
            : isKneel ? "TAKE A KNEE" : isSpike ? "SPIKE!" : play.end?.down === 1 && (play.start?.down || 0) > 0 && moved && !isKick ? "FIRST DOWN!" : "";
      const sub = big === "FLAG!" ? flagInfo : "";
      if (big) {
        banner = `<g opacity="0"><rect x="250" y="${sub ? 92 : 105}" width="700" height="${sub ? 116 : 90}" fill="#000" opacity=".78"/>
          <text x="600" y="${sub ? 136 : 152}" class="tf-big">${big}</text>${sub ? `<text x="600" y="182" class="tf-sub">${esc(sub)}</text>` : ""}
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.85;1" begin="${big === "FLAG!" ? 1.3 : 2}s" dur="${sub ? 2.6 : 2}s" fill="freeze"/></g>`;
      }
    }

    const teamTag = (c) => `<span class="tf-team" style="--c:${col(c)}">${img(teamLogo(c.team), "xs")}${esc(c.team.abbreviation || "")}</span>`;
    const where = kicker ? `${esc(kicker.team.abbreviation || "")} KICKS OFF` : at.possessionText ? `BALL ON ${esc(at.possessionText)}` : "";
    const ddText = isTD ? "TOUCHDOWN!" : down ? `${["", "1ST", "2ND", "3RD", "4TH"][down]} & ${dist < toGo ? dist : "GOAL"}` : "";
    const lastText = play?.text ? play.text.trim() : "";
    return `<div class="card tecmo" data-play="${esc(play.id)}" style="--tf-font:'${PIXEL_FONT}'">
      <div class="tf-bar">
        <span>${off ? teamTag(off) + `<b class="tf-arrow">${dir > 0 ? "▶" : "◀"}</b>` : ""}</span>
        <span class="tf-dd">${ddText}</span>
        <span class="tf-where">${where}${toGo <= 20 && off && !isTD ? ` <b class="tf-red">RED ZONE</b>` : ""}</span>
      </div>
      <svg class="tf-field" viewBox="0 0 1200 ${H}" shape-rendering="crispEdges" role="img"
        aria-label="${esc([off ? `${off.team.abbreviation} ball` : "", ddText, where].filter(Boolean).join(", "))}">${base.join("")}${lines}${lineup}${anim ? "" : flagOnField}${replay}${banner}</svg>
      <div class="tf-clock" title="A rough play clock since the last play came in. It doesn't hold anything back: the field checks for a new play every 5 seconds and replays it as soon as it arrives">
        <span>PLAY CLOCK</span><span class="tf-track"><i style="animation-delay:-${Math.min(since, 40).toFixed(1)}s"></i></span></div>
      <div class="tf-key"><span><i style="background:#3d7bff"></i>Line of scrimmage</span>${fd != null ? `<span><i style="background:#ffd21f"></i>First down</span>` : ""}
        ${drive?.description ? `<span class="muted">This drive: ${esc(drive.description)}</span>` : ""}</div>
      ${lastText ? `<p class="tf-last"><b>LAST PLAY</b> ${esc(lastText)}</p>` : ""}
    </div>`;
  }

  // Live games read two ESPN feeds on every check: the game summary (full play-by-play, refreshes every ~6 s)
  // and the scoreboard (refreshes every ~4 s, often a play ahead). Whichever has the newer play wins.
  // College uses the game's own conference scoreboard (the all-FBS one is ~1 MB).
  const sbGroup = new Map(); // game id -> conference id, learned on the first load
  function mergeScoreboard(s, sb, id) {
    const ev = (sb?.events || []).find((e) => String(e.id) === String(id));
    const sc = ev?.competitions?.[0], comp = s.header?.competitions?.[0];
    if (!sc || !comp) return;
    const sit = sc.situation, lp = sit?.lastPlay;
    const drives = (s.drives ||= {});
    const cur = drives.current || (drives.previous || []).at(-1), last = cur?.plays?.at(-1);
    let newer = false;
    try { newer = !!lp?.id && (!last || BigInt(lp.id) > BigInt(last.id)); } catch (e) { newer = !!lp?.id && lp.id !== last?.id; }
    if (!newer) return;
    // the scoreboard is ahead: take its clock, score and possession, and add its last play to the drive
    comp.status = sc.status || comp.status;
    comp.competitors.forEach((c) => {
      const x = sc.competitors.find((y) => String(y.team?.id || y.id) === String(c.team?.id || c.id));
      if (x) c.score = x.score;
      c.possession = !!sit.possession && String(sit.possession) === String(c.team?.id);
    });
    const play = {
      id: lp.id, text: lp.text, type: lp.type, scoringPlay: (lp.scoreValue || 0) > 0,
      start: { yardLine: lp.start?.yardLine, team: lp.start?.team || lp.team },
      end: { yardLine: lp.end?.yardLine ?? sit.yardLine, down: sit.down, distance: sit.distance, possessionText: sit.possessionText,
        team: { id: sit.possession || lp.end?.team?.id } },
    };
    const same = cur && String(cur.team?.id) === String(lp.team?.id) && cur.start?.yardLine === lp.drive?.start?.yardLine;
    drives.current = same ? { ...cur, description: lp.drive?.description || cur.description, plays: [...cur.plays, play] }
      : { team: lp.team, start: lp.drive?.start, description: lp.drive?.description, plays: [play] };
  }

  async function game(id, params, refresh = false) {
    const lg = league, my = token;
    if (!refresh) loading("game");
    let s, ranks, sb = null;
    try {
      const grp = sbGroup.get(String(id));
      const sbUrl = lg === "nfl" ? `${SITE(lg)}/scoreboard` : grp ? `${SITE(lg)}/scoreboard?groups=${encodeURIComponent(grp)}` : null;
      [s, ranks, sb] = await Promise.all([api(`${SITE(lg)}/summary?event=${encodeURIComponent(id)}`, refresh ? 0 : 15000), modelRanks(lg),
        refresh && sbUrl ? api(sbUrl, 0).catch(() => null) : null]);
    } catch (e) { return fail("game", e); }
    if (my !== token) return;
    const comp = s.header?.competitions?.[0];
    if (!comp) return fail("game", new Error("no game data"));
    if (comp.groups?.id) sbGroup.set(String(id), comp.groups.id);
    if (sb) mergeScoreboard(s, sb, id);
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
        ${st === "in" && s.situation?.lastPlay?.text ? `<p class="note">Last play: ${esc(s.situation.lastPlay.text)}</p>` : ""}</div>` : ""}
      ${st === "in" ? liveField(s, comp, home, away, tc, String(id)) : ""}`;

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
        ${pred && chanceText(pred) ? `<span class="book hot">Cupcake Index model: ${chanceText(pred)}</span>` : ""}</div>
        ${pred?.why ? `<p class="why"><b>Why:</b> ${esc(pred.why)}</p>` : ""}</div>`);
    }
    // win probability
    const wp = s.winprobability || [];
    if (wp.length > 2) col.right.push(`<div class="card"><h3>Win probability</h3>${wpChart(wp, away, home, tc, wpTimes(wp, s), st === "post")}</div>`);
    // head-to-head leaders (ESPN style): one row per category, away leader left, home leader right
    const colorOf = (teamId) => (String(teamId) === String(home.team.id) ? tc.home : tc.away);
    const LEAD_CATS = [["passingYards", "Passing"], ["rushingYards", "Rushing"], ["receivingYards", "Receiving"], ["totalTackles", "Tackles"], ["sacks", "Sacks"]];
    // ESPN drops "TD" when it's zero; always show it so a 0-TD line doesn't look incomplete
    const withTD = (dv) => /TD/.test(dv) || !/YDS/.test(dv) ? dv : /INT/.test(dv) ? dv.replace(/, (\d+ INT)/, ", 0 TD, $1") : `${dv}, 0 TD`;
    const leaderFor = (teamId, key) => {
      const tl = (s.leaders || []).find((x) => String(x.team?.id) === String(teamId));
      return (tl?.leaders || []).find((c) => c.name === key)?.leaders?.[0] || null;
    };
    const injOf = new Map((s.injuries || []).flatMap((t) => (t.injuries || []).map((i) => [String(i.athlete?.id), i])));
    const lside = (L, which, win) => {
      if (!L) return `<span class="lside ${which} empty">–</span>`;
      const a = L.athlete, big = L.mainStat?.value ?? L.displayValue;
      const tag = st === "pre" ? injTag(injOf.get(String(a.id)), a.id, (which === "home" ? home : away).team.id) : "";
      const txt = `<span class="ltxt"><b>${esc(a.shortName || a.displayName)}${tag}</b><small>${esc(a.position?.abbreviation || "")} · ${esc(withTD(L.displayValue))}</small></span>`;
      const num = `<span class="lbig${win ? " win" : ""}">${esc(big)}</span>`;
      const pic = face(a.headshot?.href, a.displayName, "leadshot");
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
    const inj = (s.injuries || []).map((t) => ({ ...t, injuries: (t.injuries || []).filter(injInfo) })).filter((t) => t.injuries.length);
    if (inj.length && st !== "post") {
      col.right.push(`<div class="card"><h3>Injuries</h3><div class="box-pair">${inj.map((t) => `<div><b>${esc(t.team?.displayName || "")}</b><ul class="inj">${t.injuries.slice(0, 15).map((i) =>
        `<li><a href="${link("player", i.athlete?.id)}">${esc(i.athlete?.displayName)}</a> <span class="muted">${esc(i.athlete?.position?.abbreviation || "")}</span> ${injTag(i, i.athlete?.id, t.team?.id)}${injInfo(i)?.part ? ` <small class="muted">${esc(injInfo(i).part)}</small>` : ""}</li>`).join("")}</ul></div>`).join("")}</div></div>`);
    }
    const oldField = view("game").querySelector(".tecmo"); // same play as last time: keep it so a running animation isn't restarted
    view("game").innerHTML = `<p><a href="${link("scores")}" class="boxlink">← Scores</a></p>${head}${leadersStrip}<div class="game-cols"><div class="gcol">${col.left.join("")}</div><div class="gcol">${col.right.join("")}</div></div>${col.full.join("")}`;
    const newField = view("game").querySelector(".tecmo");
    if (oldField && newField && oldField.dataset.play === newField.dataset.play) {
      newField.replaceWith(oldField);
      oldField.querySelector(".tf-last")?.replaceWith(newField.querySelector(".tf-last") || "");
    }
    if (wp.length > 2) initWp(wp, s, away, home);
    const bx = $("#boxscore .box-tabs");
    if (bx) bx.onclick = (e) => {
      const k = e.target.dataset.bt;
      if (!k) return;
      boxTab = k;
      bx.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.bt === k));
      document.querySelectorAll("#boxscore .box-sec").forEach((sec) => sec.classList.toggle("hidden", sec.dataset.sec !== k));
    };
    if (st === "in") poll((r) => game(id, params, r), 5000); // live: check every 5 s so a new play replays right after the snap
  }

  // Where each win-probability point falls in game time (0 = kickoff, 1 = end of regulation, more for overtime),
  // from the play's quarter and clock. Points we can't place sit with the one before them.
  function wpTimes(wp, s) {
    const plays = new Map();
    [...(s.drives?.previous || []), ...(s.drives?.current ? [s.drives.current] : [])].forEach((d) => (d.plays || []).forEach((p) => plays.set(String(p.id), p)));
    const secs = (c) => { const [m, x] = String(c || "0:00").split(":").map(Number); return (m || 0) * 60 + (x || 0); };
    let prev = 0, maxQ = 4;
    const raw = wp.map((w) => {
      const p = plays.get(String(w.playId));
      if (p?.period?.number) {
        const q = p.period.number;
        maxQ = Math.max(maxQ, q);
        prev = Math.max(prev, q <= 4 ? (q - 1) * 900 + (900 - secs(p.clock?.displayValue)) : 3600 + (q - 5) * 600 + (600 - Math.min(600, secs(p.clock?.displayValue))));
      }
      return prev;
    });
    const total = 3600 + Math.max(0, maxQ - 4) * 600;
    return raw.map((t) => t / total);
  }

  function wpChart(wp, away, home, tc = {}, times = null, final = false) {
    const W = 600, H = 160, n = wp.length;
    const tx = (i) => (final && i === n - 1 ? 1 : times ? times[i] : i / (n - 1)) * W; // live: the line stops at the game clock
    const pts = wp.map((p, i) => `${tx(i).toFixed(1)},${((1 - p.homeWinPercentage) * H).toFixed(1)}`).join(" ");
    const last = wp[n - 1].homeWinPercentage, lastX = tx(n - 1);
    const lead = last >= 0.5 ? home : away, pct = chancePct(last >= 0.5 ? last : 1 - last, last === 0 || last === 1);
    const flip = lastX > W * 0.8;
    return `<p class="note">${esc(lead.team.displayName)} ${pct} <span class="muted">· hover or drag across the chart</span></p>
      <div class="wp-box" id="wp-box">
        <svg viewBox="0 0 ${W} ${H}" class="wp" preserveAspectRatio="none" role="img" aria-label="Win probability over the game">
          <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="wp-mid"/>
          <defs><clipPath id="wp-top"><rect x="0" y="0" width="${W}" height="${H / 2}"/></clipPath><clipPath id="wp-bot"><rect x="0" y="${H / 2}" width="${W}" height="${H / 2}"/></clipPath></defs>
          ${[0.25, 0.5, 0.75].map((q) => `<line x1="${q * W}" y1="0" x2="${q * W}" y2="${H}" class="wp-q"/>`).join("")}
          <polygon points="0,${H / 2} ${pts} ${lastX},${H / 2}" class="wp-area" clip-path="url(#wp-top)" style="fill:${tc.home || "var(--accent)"}"/>
          <polygon points="0,${H / 2} ${pts} ${lastX},${H / 2}" class="wp-area" clip-path="url(#wp-bot)" style="fill:${tc.away || "var(--accent)"}"/>
          <polyline points="${pts}" class="wp-line"/>
        </svg>
        <div class="wp-now${flip ? " flip" : ""}" style="left:${(lastX / W) * 100}%;top:${(1 - last) * 100}%"><i style="background:${last >= 0.5 ? tc.home : tc.away}"></i><b>${esc(lead.team.abbreviation)} ${pct}</b></div>
        <div class="wp-cursor hidden"><div class="wp-vline"></div><div class="wp-dot"></div><div class="wp-tip"></div></div>
      </div>
      <div class="wp-labels"><span><i class="sb-chip" style="--c:${tc.home}"></i>▲ ${esc(home.team.abbreviation)}</span><span class="muted">Q1 · Q2 · Q3 · Q4</span><span><i class="sb-chip" style="--c:${tc.away}"></i>▼ ${esc(away.team.abbreviation)}</span></div>`;
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
    const times = wpTimes(wp, s), final = s.header?.competitions?.[0]?.status?.type?.state === "post";
    const tf = (i) => (final && i === wp.length - 1 ? 1 : times[i]);
    const show = (clientX) => {
      const r = box.getBoundingClientRect();
      const f = Math.min(tf(wp.length - 1), Math.max(0, (clientX - r.left) / r.width));
      let i = 0;
      wp.forEach((_, j) => { if (Math.abs(tf(j) - f) <= Math.abs(tf(i) - f)) i = j; });
      const p = wp[i];
      const x = tf(i) * r.width, y = (1 - p.homeWinPercentage) * r.height;
      const hp = p.homeWinPercentage, homeLeads = hp >= 0.5;
      const pct = (hp === 0 || hp === 1 ? 100 : Math.min(99.9, Math.max(hp, 1 - hp) * 100)).toFixed(1); // 100% only once it's decided
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
    if (params.get("show") === "frauds") return frauds(params);
    if (params.get("show") === "projected") return projected(params);
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
        <td><div class="team">${face(A.headshot?.href, A.displayName, "hs")}<div><a href="${link("player", A.id)}"><b>${esc(A.displayName)}</b></a><small class="muted">${esc(A.position?.abbreviation || "")}</small></div></div></td>
        <td><span class="tm">${img(A.teamLogos?.[0]?.href, "xs")} ${esc(A.teamShortName || "")}</span></td>
        ${vals.map((v, j) => `<td class="num${`${prefix}.${def.names[j]}` === sort ? " on" : ""}">${esc(v)}</td>`).join("")}</tr>`;
    }).join("");
    const more = first.pagination && pages < first.pagination.pages;
    view("stats").innerHTML = stSubStats("leaders") + `
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

  // ---------------------------------------------------------------- NFL frauds (a sub-view of Stats)
  // Every week ESPN's fantasy feed sets a projection ("line") for each player: passing yards, TDs, catches...
  // A player's fraud score compares what they actually did with their lines in the games they played,
  // stat by stat for their position, as a weighted % below expectation. Over-achievers are the same list flipped.
  const stSubStats = (on) => `<div class="subtabs">` + [["leaders", "Leaders", {}], ["frauds", "Frauds", { show: "frauds" }], ["projected", "Projected", { show: "projected" }]]
    .map(([k, l, q]) => `<a class="subtab${k === on ? " on" : ""}" href="${link("stats", null, q)}">${l}</a>`).join("") + `</div>`;
  const FR_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE" };
  // [label, ESPN fantasy stat ids (summed), weight, minimum expected per game to count, higher is worse]
  // ids: 3 pass yds, 4 pass TD, 20 INT, 24 rush yds, 25 rush TD, 42 rec yds, 43 rec TD, 53 receptions, 210 games played
  const FR_KEYS = {
    QB: [["Pass yds", ["3"], 0.4, 10], ["Pass TD", ["4"], 0.3, 0], ["INT", ["20"], 0.15, 0, true], ["Rush yds", ["24"], 0.15, 10]],
    RB: [["Rush yds", ["24"], 0.5, 10], ["Rec yds", ["42"], 0.3, 10], ["TD", ["25", "43"], 0.2, 0]],
    WR: [["Rec", ["53"], 0.3, 1], ["Rec yds", ["42"], 0.5, 10], ["TD", ["25", "43"], 0.2, 0]],
  };
  FR_KEYS.TE = FR_KEYS.WR;
  const FR_MIN_GAMES = 2, FR_MIN_PTS = 8, FR_CUT = 25; // games played, projected PPR pts/game (a real role), % off to be listed
  let frState = { pos: "", over: false, injured: true };
  const FR_HURT = new Set(["OUT", "INJURY_RESERVE", "DOUBTFUL"]); // hidden unless "Include injured" is on

  async function frPlayers() {
    const now = new Date(), y = now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear(); // before September: last season
    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${y}`;
    const cur = (await api(base, 3600000)).currentScoringPeriod?.id || 18;
    const weeks = Array.from({ length: Math.min(cur, 18) }, (_, i) => i + 1);
    const filter = { players: { filterSlotIds: { value: [0, 2, 4, 6] }, limit: 350, sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterStatsForSourceIds: { value: [0, 1] }, filterStatsForSplitTypeIds: { value: [1] }, filterStatsForScoringPeriodIds: { value: weeks } } };
    const url = `${base}/segments/0/leaguedefaults/3?view=kona_player_info#frauds`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < 600000) return hit.data;
    const r = await fetch(url.split("#")[0], { headers: { "X-Fantasy-Filter": JSON.stringify(filter) } });
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    const sum = (s, ids) => ids.reduce((t, k) => t + (s.stats?.[k] || 0), 0);
    const list = [], all = (await r.json()).players || [];
    for (const { player: p } of all) {
      const pos = FR_POS[p?.defaultPositionId];
      if (!pos || !p.proTeamId) continue; // rostered on an NFL team
      const st = (p.stats || []).filter((s) => s.seasonId === y && s.statSplitTypeId === 1);
      const proj = new Map(st.filter((s) => s.statSourceId === 1).map((s) => [s.scoringPeriodId, s]));
      // games they actually played that also had a line (byes and games they sat out don't count)
      const games = st.filter((s) => s.statSourceId === 0 && s.stats?.["210"] && proj.has(s.scoringPeriodId));
      const n = games.length;
      if (n < FR_MIN_GAMES) continue;
      if (games.reduce((t, g) => t + (proj.get(g.scoringPeriodId).appliedTotal || 0), 0) / n < FR_MIN_PTS) continue;
      let score = 0, wsum = 0;
      const cells = FR_KEYS[pos].map(([label, ids, w, min, worse]) => {
        const act = games.reduce((t, g) => t + sum(g, ids), 0) / n;
        const exp = games.reduce((t, g) => t + sum(proj.get(g.scoringPeriodId), ids), 0) / n;
        const used = exp > 0 && exp >= min;
        if (used) { // shortfall as a share of the line, capped at ±100% so one stat can't swamp the rest
          score += w * Math.max(-1, Math.min(1, (worse ? act - exp : exp - act) / exp));
          wsum += w;
        }
        return { label, act, exp, used, bad: worse ? act > exp : act < exp };
      });
      if (wsum) list.push({ id: p.id, name: p.fullName, pos, team: p.proTeamId, n, cells, score: Math.round((100 * score) / wsum),
        hurt: FR_HURT.has(p.injuryStatus), injStatus: p.injuryStatus });
    }
    cache.set(url, { t: Date.now(), data: { y, list } });
    return { y, list };
  }

  async function frauds(params) {
    const my = token;
    if (league !== "nfl") {
      view("stats").innerHTML = stSubStats("frauds") + `<div class="card">Frauds are NFL only: they need ESPN's weekly player projections, which don't exist for college. <a href="${link("stats", null, { show: "frauds", league: "nfl" })}">See NFL frauds →</a></div>`;
      return;
    }
    view("stats").innerHTML = stSubStats("frauds") + `<div class="card muted">Loading…</div>`;
    let data, teams;
    try {
      [data, teams] = await Promise.all([frPlayers(), api(`${STAND("nfl")}/standings?level=3`, 86400000).then((d) => new Map(groupsOf(d).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]))).catch(() => new Map())]);
    } catch (e) { return fail("stats", e); }
    if (my !== token) return;
    const fmt = (v, label) => (/yds/.test(label) ? v.toFixed(0) : v.toFixed(1));
    view("stats").innerHTML = stSubStats("frauds") + `<div class="card">
      <div class="sc-bar"><h2>${frState.over ? "Over-achievers" : "Frauds"} <small class="muted">${data.y}</small></h2>
        <div class="presets" id="fr-pos">${[["", "All"], ...Object.values(FR_POS).map((p) => [p, p])].map(([v, l]) => `<button data-pos="${v}" class="${v === frState.pos ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="presets"><button id="fr-over" class="${frState.over ? "on" : ""}" title="Flip the list: players beating their projections">Show over-achievers</button>
          <button id="fr-inj" class="${frState.injured ? "on" : ""}" title="Players currently listed Out, IR or Doubtful are hidden unless this is on">Include injured</button></div></div>
      <p class="fr-how">Each week ESPN sets a projection for every player. <b>Fraud score</b> = how far below those projections they've played, on average, in the stats that matter for their position.</p>
      <div class="table-wrap"><table class="box" id="fr-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th>Pos</th><th class="num" title="Games played">G</th>
        <th class="num" title="Weighted % below (or above) their weekly projections">${frState.over ? "Above" : "Fraud score"}</th><th colspan="4">Per game: actual / projected</th></tr></thead><tbody></tbody></table></div>
      <p class="muted fr-inj-note" id="fr-inj-note"></p>
      <p class="note">Players with a real role (projected for ${FR_MIN_PTS}+ PPR fantasy points a game) and ${FR_MIN_GAMES}+ games. Stats per position: QB pass yards (40%), pass TDs (30%), interceptions (15%, more is worse), rush yards (15%); RB rush yards (50%), receiving yards (30%), TDs (20%); WR/TE catches (30%), receiving yards (50%), TDs (20%). Everything is per game, so games a player missed (injury, bye, benched) simply don't count against him. Each stat counts at most 100% off and stats a player is barely projected for are skipped. Listed at ${FR_CUT}%+ off. <span class="fr-low">Red</span> = below projection. Projections: ESPN fantasy.</p></div>`;
    const draw = () => {
      const pass = data.list.filter((r) => (!frState.pos || r.pos === frState.pos) && (frState.over ? -r.score : r.score) >= FR_CUT);
      const fit = frState.injured ? pass : pass.filter((r) => !r.hurt);
      const hidden = pass.length - fit.length;
      $("#fr-inj-note").textContent = hidden ? `${hidden} injured player${hidden > 1 ? "s" : ""} hidden (Out, IR or Doubtful).` : "";
      const rows = fit.sort((a, b) => (frState.over ? a.score - b.score : b.score - a.score));
      $("#fr-table tbody").innerHTML = rows.map((r, i) => {
        const t = teams.get(String(r.team));
        return `<tr><td class="num muted">${i + 1}</td>
          <td><div class="team">${face(`https://a.espncdn.com/i/headshots/nfl/players/full/${r.id}.png`, r.name, "hs")}<a href="${link("player", r.id)}">${esc(r.name)}</a>${r.hurt && FANTASY_INJ[r.injStatus] ? " " + injTag({ status: FANTASY_INJ[r.injStatus] }, r.id, r.team) : ""}</div></td>
          <td>${t ? `<a href="${link("team", t.id)}"><span class="tm">${img(teamLogo(t), "xs")} ${esc(t.abbreviation)}</span></a>` : ""}</td>
          <td>${esc(r.pos)}</td><td class="num">${r.n}</td><td class="num"><b class="${r.score > 0 ? "fr-low" : "fr-high"}">${Math.abs(r.score)}%</b></td>
          ${r.cells.map((c) => `<td class="fr-cell${c.used ? "" : " muted"}"><small class="muted">${esc(c.label)}</small> <span class="${c.used && c.bad ? "fr-low" : ""}">${fmt(c.act, c.label)}</span><small class="muted"> / ${fmt(c.exp, c.label)}</small></td>`).join("")}
          ${r.cells.length < 4 ? `<td colspan="${4 - r.cells.length}"></td>` : ""}</tr>`;
      }).join("") || `<tr><td colspan="10" class="muted">No one is ${FR_CUT}%+ ${frState.over ? "above" : "below"} their projections${data.list.length ? "" : " yet (it takes " + FR_MIN_GAMES + " games)"}.</td></tr>`;
    };
    $("#fr-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (!b) return; frState.pos = b.dataset.pos;
      $("#fr-pos").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
    $("#fr-over").onclick = () => { frState.over = !frState.over; frauds(params); };
    $("#fr-inj").onclick = (e) => { frState.injured = !frState.injured; e.currentTarget.classList.toggle("on", frState.injured); draw(); };
    draw();
  }

  // ---------------------------------------------------------------- NFL projections (a sub-view of Stats)
  // ESPN's fantasy feed again: statSourceId 1 = projection; statSplitTypeId 1 = one week, 0 = rest of the season
  // (this week through week 18; it equals the sum of the weekly projections). Points are ESPN's PPR scoring.
  // [label, ESPN fantasy stat id, tooltip]; ids: 3 pass yds, 4 pass TD, 20 INT, 24 rush yds, 25 rush TD,
  // 53 receptions, 42 rec yds, 43 rec TD; kickers: 83 FG made, 84 FG tried, 86 XP made
  const PJ_COLS = [["Pass yds", "3", "Passing yards"], ["Pass TD", "4", "Passing TDs"], ["INT", "20", "Interceptions thrown"],
    ["Rush yds", "24", "Rushing yards"], ["Rush TD", "25", "Rushing TDs"], ["Rec", "53", "Receptions"], ["Rec yds", "42", "Receiving yards"], ["Rec TD", "43", "Receiving TDs"]];
  const PJ_K = [["FGM", "83", "Field goals made"], ["FGA", "84", "Field goals tried"], ["XPM", "86", "Extra points made"]];
  const PJ_POS = { ...FR_POS, 5: "K" };
  // Projected opens on QBs ("All" is pos=all), each position sorted by its key stat until a column is clicked
  const PJ_KEY = { QB: "3", RB: "24", WR: "42", TE: "42", K: "83" };
  const pjPos = (params, list) => (params.get("pos") === "all" ? "" : list.includes(params.get("pos")) ? params.get("pos") : "QB");
  const pjSort = (params, cols, pos) => (params.get("sort") === "pts" || cols.some((c) => c[1] === params.get("sort")) ? params.get("sort") : PJ_KEY[pos] || "pts");

  const paceFmt = (v) => (!v || v < 0.5 ? `<span class="muted">–</span>` : Math.round(v).toLocaleString()); // season totals: whole numbers
  const PJ_PACE_KEYS = [...PJ_COLS, ...PJ_K].map((c) => c[1]).concat("pts");
  async function pjPlayers() {
    const now = new Date(), y = now.getMonth() < 8 ? now.getFullYear() - 1 : now.getFullYear(); // before September: last season
    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${y}`;
    const wk = Math.min((await api(base, 3600000)).currentScoringPeriod?.id || 1, 18);
    const url = `${base}/segments/0/leaguedefaults/3?view=kona_player_info#projected`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < 600000) return hit.data;
    const filter = { players: { filterSlotIds: { value: [0, 2, 4, 6, 17] }, limit: 400, sortPercOwned: { sortPriority: 1, sortAsc: false },
      filterStatsForSourceIds: { value: [0, 1] }, filterStatsForSplitTypeIds: { value: [0, 1] }, filterStatsForScoringPeriodIds: { value: [0, wk] } } };
    const [r, sched] = await Promise.all([fetch(url.split("#")[0], { headers: { "X-Fantasy-Filter": JSON.stringify(filter) } }),
      api(`${base}?view=proTeamSchedules_wl`, 86400000).catch(() => null)]);
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    // this week's opponent for each team: [opponent id, home?]
    const opp = new Map();
    for (const t of sched?.settings?.proTeams || []) {
      const g = t.proGamesByScoringPeriod?.[wk]?.[0];
      if (g) opp.set(t.id, g.homeProTeamId === t.id ? [g.awayProTeamId, true] : [g.homeProTeamId, false]);
    }
    const list = [];
    for (const { player: p } of (await r.json()).players || []) {
      const pos = PJ_POS[p?.defaultPositionId];
      if (!pos || !p.proTeamId) continue; // rostered on an NFL team
      const st = (p.stats || []).filter((s) => s.seasonId === y), pj = st.filter((s) => s.statSourceId === 1), real = st.filter((s) => s.statSourceId === 0);
      const week = pj.find((s) => s.statSplitTypeId === 1 && s.scoringPeriodId === wk), ros = pj.find((s) => s.statSplitTypeId === 0);
      const so = real.find((s) => s.statSplitTypeId === 0), playedWk = real.some((s) => s.statSplitTypeId === 1 && s.scoringPeriodId === wk);
      const line = (s) => ({ ...(s?.stats || {}), pts: s?.appliedTotal || 0 });
      const W = line(week), R = line(ros), S = line(so);
      // Season pace = real stats so far + ESPN's rest-of-season projection (once this week's game is played it's in both: drop the projected one)
      const pace = Object.fromEntries(PJ_PACE_KEYS.map((k) => [k, (S[k] || 0) + (R[k] || 0) - (playedWk ? W[k] || 0 : 0)]));
      list.push({ id: p.id, name: p.fullName, pos, team: p.proTeamId, opp: opp.get(p.proTeamId), week: W, ros: R, so: S, pace });
    }
    const data = { y, wk, list };
    cache.set(url, { t: Date.now(), data });
    return data;
  }

  async function projected(params) {
    const my = token;
    if (league !== "nfl") return cfbProjected(params);
    view("stats").innerHTML = stSubStats("projected") + `<div class="card muted">Loading…</div>`;
    let data, teams;
    try {
      [data, teams] = await Promise.all([pjPlayers(), api(`${STAND("nfl")}/standings?level=3`, 86400000).then((d) => new Map(groupsOf(d).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]))).catch(() => new Map())]);
    } catch (e) { return fail("stats", e); }
    if (my !== token) return;
    const when = ["ros", "pace"].includes(params.get("when")) ? "pace" : "", ros = false, pace = when === "pace", pos = pjPos(params, Object.values(PJ_POS));
    const cols = pos === "K" ? PJ_K : PJ_COLS;
    const sort = pjSort(params, cols, pos), dir = params.get("dir") === "asc" ? "asc" : "desc";
    const shown = Math.max(1, +params.get("pages") || 1) * 100;
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.set("league", "nfl"); p.set("show", "projected");
      location.hash = `#/stats?${p}`;
    };
    const val = (r) => (pace ? r.pace : ros ? r.ros : r.week), wk1 = !ros && !pace; // only "this week" has an opponent
    const all = data.list.filter((r) => val(r).pts > 0 && (!pos || r.pos === pos)) // nothing projected = bye week or ruled out
      .sort((a, b) => (dir === "desc" ? 1 : -1) * ((val(b)[sort] || 0) - (val(a)[sort] || 0)) || val(b).pts - val(a).pts);
    const fmt = (v, label) => (!v || v < 0.05 ? `<span class="muted">–</span>` : /yds/.test(label) ? Math.round(v).toLocaleString() : v.toFixed(1));
    const th = (key, label, title) => `<th class="num sortable${key === sort ? " on" : ""}" data-sort="${key}" title="${esc(title)}">${esc(label)}${key === sort ? (dir === "desc" ? " ▼" : " ▲") : ""}</th>`;
    const tm = (id) => { const t = teams.get(String(id)); return t ? `<a href="${link("team", t.id)}"><span class="tm">${img(teamLogo(t), "xs")} ${esc(t.abbreviation)}</span></a>` : ""; };
    const rows = all.slice(0, shown).map((r, i) => `<tr data-name="${esc(r.name.toLowerCase())} ${esc((teams.get(String(r.team))?.abbreviation || "").toLowerCase())}"><td class="num muted">${i + 1}</td>
        <td><div class="team">${face(`https://a.espncdn.com/i/headshots/nfl/players/full/${r.id}.png`, r.name, "hs")}<div><a href="${link("player", r.id)}"><b>${esc(r.name)}</b></a><small class="muted">${esc(r.pos)}</small></div></div></td>
        <td>${tm(r.team)}</td>${!wk1 ? "" : `<td class="pj-opp">${r.opp ? `<small class="muted">${r.opp[1] ? "vs" : "@"}</small> ${tm(r.opp[0])}` : ""}</td>`}
        ${cols.map(([l, k]) => `<td class="num${k === sort ? " on" : ""}"${pace ? ` title="${Math.round(r.so[k] || 0)} so far"` : ""}>${pace ? paceFmt(val(r)[k]) : fmt(val(r)[k], l)}</td>`).join("")}
        <td class="num${sort === "pts" ? " on" : ""}"${pace ? ` title="${r.so.pts.toFixed(1)} so far"` : ""}><b>${val(r).pts.toFixed(1)}</b></td></tr>`).join("");
    const whenTxt = ros ? `the rest of the ${data.y} season (weeks ${data.wk}–18)` : `week ${data.wk}`;
    view("stats").innerHTML = stSubStats("projected") + `
      <div class="sc-bar">
        <div class="presets" id="pj-when">${[["", "This week"], ["pace", "Season pace"]].map(([v, l]) => `<button data-when="${v}" class="${v === when ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="presets" id="pj-pos">${[["", "All"], ...Object.values(PJ_POS).map((p) => [p, p])].map(([v, l]) => `<button data-pos="${v}" class="${v === pos ? "on" : ""}">${l}</button>`).join("")}</div>
        <input id="pj-search" type="search" placeholder="Filter player or team…">
      </div>
      <p class="fr-how">${pace ? `<b>Season pace</b>: where each player's ${esc(data.y)} totals are headed. Real stats so far plus ESPN's projection for every game left (each one set for that week's opponent). Hover a number to see his total so far.`
        : `ESPN's projections for <b>${esc(whenTxt)}</b>.`} These are ESPN's fantasy football forecasts, not betting lines.</p>
      <div class="table-wrap"><table id="pj-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th>${wk1 ? "<th>Opp</th>" : ""}
        ${cols.map(([l, k, t]) => th(k, l, t)).join("")}${th("pts", "PPR pts", "Projected fantasy points, PPR scoring (1 per catch)")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="13" class="muted">No projections yet.</td></tr>`}</tbody></table></div>
      ${all.length > shown ? `<p><button id="pj-more" class="btn">Show 100 more</button></p>` : ""}
      <p class="note">Click a column to sort by it. Players on bye or projected for nothing (out) aren't listed${ros ? "; rest-of-season totals skip byes and games ESPN expects them to miss" : ""}. Projections: ESPN fantasy, updated through the week.</p>`;
    $("#pj-when").onclick = (e) => { const b = e.target.closest("[data-when]"); if (b) go({ when: b.dataset.when, sort: null, dir: null, pages: null }); };
    $("#pj-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (b) go({ pos: b.dataset.pos || "all", sort: null, dir: null, pages: null }); };
    view("stats").querySelector("#pj-table thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.sort;
      if (k) go({ sort: k === (PJ_KEY[pos] || "pts") ? null : k, dir: k === sort && dir === "desc" ? "asc" : null, pages: null });
    };
    $("#pj-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      view("stats").querySelectorAll("#pj-table tbody tr").forEach((tr) => tr.classList.toggle("hidden", !!q && !(tr.dataset.name || "").includes(q)));
    };
    if ($("#pj-more")) $("#pj-more").onclick = () => go({ pages: shown / 100 + 1 });
  }

  // ---------------------------------------------------------------- CFB projections (our model)
  // ESPN has no college projections, so the weekly job (src/cfb_projections.py) builds ours for every FBS
  // QB/RB/WR/TE: past games opponent-adjusted, then volume x efficiency x this week's matchup.
  const CFB_PJ = { 3: "py", 4: "ptd", 20: "int", 24: "ry", 25: "rtd", 53: "rec", 42: "recy", 43: "rectd" }; // NFL column ids -> our keys
  const CFB_HOW = `Each past game is adjusted for the defense he faced (big numbers against a bad defense or an FCS team count for less, production against a strong defense counts for more), then recent games weigh most. His per-throw, per-carry and per-catch rates are pulled toward last season's and the position average so a few fluky plays don't swing them, and this week's opponent, home field and our model's expected game flow (favorites run more) adjust the result. In backtests on 2025 and early 2026 it beat a plain season average (about 6.2 vs 6.9 PPR points off per player), but it can't see injuries or depth-chart news.`;
  let cfbProjP = null;
  const cfbProj = () => (cfbProjP ||= getJSON(`data/cfb/${INDEX.leagues.cfb.latest.season}/projections.json`).catch(() => { cfbProjP = null; return null; }));
  // Season pace: real totals so far + our projection for each remaining game (src/cfb_projections.py season_pace)
  let cfbPaceP = null;
  const cfbPace = () => (cfbPaceP ||= getJSON(`data/cfb/${INDEX.leagues.cfb.latest.season}/pace.json`).catch(() => { cfbPaceP = null; return null; }));
  const PACE_HOW = `Season pace = what he has actually done so far, plus our projection for every game left on his team's regular-season schedule. Each remaining game uses that opponent's defense, home or away, and our model's expected game flow, so a soft back half pushes the pace up and a tough one pulls it down. It assumes he stays healthy and keeps his role.`;
  const cfbTm = (id, ab) => `<a href="${link("team", id)}"><span class="tm">${img(`https://a.espncdn.com/i/teamlogos/ncaa/500/${encodeURIComponent(id)}.png`, "xs")} ${esc(ab)}</span></a>`;
  const pjFmt = (v, label) => (!v || v < 0.05 ? `<span class="muted">–</span>` : /yds/.test(label) ? Math.round(v).toLocaleString() : v.toFixed(1));

  async function cfbProjected(params) {
    const my = token;
    view("stats").innerHTML = stSubStats("projected") + `<div class="card muted">Loading…</div>`;
    const pace = params.get("when") === "pace";
    const data = await (pace ? cfbPace() : cfbProj());
    if (my !== token) return;
    if (!data?.players?.length) {
      view("stats").innerHTML = stSubStats("projected") + `<div class="card">No college projections yet: they're built with each weekly rankings update. <a href="${link("stats", null, { show: "projected", league: "nfl" })}">See NFL projections →</a></div>`;
      return;
    }
    const pos = pjPos(params, ["QB", "RB", "WR", "TE"]);
    const sort = pjSort(params, PJ_COLS, pos), dir = params.get("dir") === "asc" ? "asc" : "desc";
    const shown = Math.max(1, +params.get("pages") || 1) * 100;
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.set("league", "cfb"); p.set("show", "projected");
      location.hash = `#/stats?${p}`;
    };
    const val = (r, k) => (k === "pts" ? r.pts : r[CFB_PJ[k]] || 0);
    const all = data.players.filter((r) => !pos || r.pos === pos)
      .sort((a, b) => (dir === "desc" ? 1 : -1) * (val(b, sort) - val(a, sort)) || b.pts - a.pts);
    const th = (key, label, title) => `<th class="num sortable${key === sort ? " on" : ""}" data-sort="${key}" title="${esc(title)}">${esc(label)}${key === sort ? (dir === "desc" ? " ▼" : " ▲") : ""}</th>`;
    const soFar = (r, k) => (pace ? ` title="${esc(String(Math.round(r.so[CFB_PJ[k]] || 0)))} so far"` : "");
    const row = (r, i) => `<tr><td class="num muted">${i + 1}</td>
        <td><div class="team">${face(`https://a.espncdn.com/i/headshots/college-football/players/full/${encodeURIComponent(r.id)}.png`, r.n, "hs")}<div><a href="${link("player", r.id)}"><b>${esc(r.n)}</b></a><small class="muted">${esc(r.pos)}</small></div></div></td>
        <td>${cfbTm(r.t, r.ta)}</td>${pace ? `<td class="num">${r.g}<small class="muted"> +${r.gl}</small></td>` : `<td class="pj-opp"><small class="muted">${r.h ? "vs" : "@"}</small> ${cfbTm(r.o, r.oa)}</td>`}
        ${PJ_COLS.map(([l, k]) => `<td class="num${k === sort ? " on" : ""}"${soFar(r, k)}>${pace ? paceFmt(val(r, k)) : pjFmt(val(r, k), l)}</td>`).join("")}
        <td class="num${sort === "pts" ? " on" : ""}"><b>${r.pts.toFixed(1)}</b></td></tr>`;
    // the filter searches every projected player (not just the rows on screen) and keeps their overall rank
    const rows = (q) => {
      const hits = all.map((r, i) => [r, i]).filter(([r]) => !q || `${r.n} ${r.ta}`.toLowerCase().includes(q));
      return (q ? hits.slice(0, 200) : hits.slice(0, shown)).map(([r, i]) => row(r, i)).join("") || `<tr><td colspan="14" class="muted">No projected player matches.</td></tr>`;
    };
    view("stats").innerHTML = stSubStats("projected") + `
      <div class="sc-bar">
        <div class="presets" id="pj-when"><button data-when="" class="${pace ? "" : "on"}">This week</button><button data-when="pace" class="${pace ? "on" : ""}">Season pace</button></div>
        <div class="presets" id="pj-pos">${[["", "All"], ...["QB", "RB", "WR", "TE"].map((p) => [p, p])].map(([v, l]) => `<button data-pos="${v}" class="${v === pos ? "on" : ""}">${l}</button>`).join("")}</div>
        <input id="pj-search" type="search" placeholder="Find a player or team…">
      </div>
      <p class="fr-how">${pace ? `<b>Season pace</b>: where each player's ${esc(data.season)} regular-season totals are headed (our model). Hover a number to see his total so far.`
        : `Cupcake Index projections for <b>week ${esc(data.week)}</b> (our model).`} Our own estimates, for fun: not betting lines.</p>
      <div class="table-wrap"><table id="pj-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th>${pace ? `<th class="num" title="Games played + games left">G</th>` : "<th>Opp</th>"}
        ${PJ_COLS.map(([l, k, t]) => th(k, l, t)).join("")}${th("pts", "PPR pts", "Projected fantasy points, PPR scoring (1 per catch)")}</tr></thead>
        <tbody>${rows("")}</tbody></table></div>
      ${all.length > shown ? `<p id="pj-more-p"><button id="pj-more" class="btn">Show 100 more</button></p>` : ""}
      <p class="note"><b>How these work:</b> ${pace ? PACE_HOW + " " : ""}${CFB_HOW} ${all.length.toLocaleString()} FBS players ${pace ? "paced" : "projected"}, using games through week ${esc(data.through)}.</p>`;
    $("#pj-when").onclick = (e) => { const b = e.target.closest("[data-when]"); if (b) go({ when: b.dataset.when || null, sort: null, dir: null, pages: null }); };
    $("#pj-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (b) go({ pos: b.dataset.pos || "all", sort: null, dir: null, pages: null }); };
    view("stats").querySelector("#pj-table thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.sort;
      if (k) go({ sort: k === (PJ_KEY[pos] || "pts") ? null : k, dir: k === sort && dir === "desc" ? "asc" : null, pages: null });
    };
    $("#pj-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      view("stats").querySelector("#pj-table tbody").innerHTML = rows(q);
      $("#pj-more-p")?.classList.toggle("hidden", !!q);
      fillFaces(view("stats"));
    };
    if ($("#pj-more")) $("#pj-more").onclick = () => go({ pages: shown / 100 + 1 });
    fillFaces(view("stats"));
  }

  // Player page: one compact "outlook" card, small sub-tabs for this week's projection and the season pace.
  // Each pane: { k, tab, cells: [[label, value, "so far" line?]], note }
  const PACE_MAIN = { QB: ["3", "4", "20", "24"], RB: ["24", "25", "42"], WR: ["42", "53", "43"], TE: ["42", "53", "43"], K: ["83", "84", "86"] };
  const soLine = (v, d = 0) => `${(+v || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })} so far`;

  async function cfbProjPane(id) {
    const d = await cfbProj(), r = d?.players?.find((p) => p.id === String(id));
    if (!r) return null;
    const keys = PJ_COLS.filter(([, k]) => (r[CFB_PJ[k]] || 0) >= 0.05 && !(k === "20" && r.pos !== "QB"));
    return { k: "week", tab: `Week ${esc(d.week)} ${r.h ? "vs" : "@"} ${esc(r.oa)}`,
      cells: [...keys.map(([l, k]) => [l, pjFmt(r[CFB_PJ[k]], l)]), ["PPR pts", r.pts.toFixed(1)]],
      note: `Our own estimate, for fun, not a betting line. <a href="${link("stats", null, { show: "projected", league: "cfb", pos: r.pos })}">How these work →</a>` };
  }
  async function cfbPacePane(id) {
    const r = (await cfbPace())?.players?.find((p) => p.id === String(id));
    if (!r) return null;
    const main = PACE_MAIN[r.pos] || [];
    return { k: "pace", tab: "Season pace",
      cells: [...PJ_COLS.filter(([, k]) => main.includes(k)).map(([l, k]) => [l, paceFmt(r[CFB_PJ[k]]), soLine(r.so[CFB_PJ[k]])]), ["PPR pts", r.pts.toFixed(1), soLine(r.spts, 1)]],
      note: `${r.g + r.gl} games, ${r.gl} left: what he's done so far plus our projection for each game left, adjusted for those defenses. <a href="${link("stats", null, { show: "projected", league: "cfb", when: "pace", pos: r.pos })}">Full list →</a>` };
  }
  async function nflPanes(id) {
    const d = await pjPlayers(), r = d?.list?.find((p) => String(p.id) === String(id));
    if (!r) return [];
    const main = PACE_MAIN[r.pos] || [], cols = [...PJ_COLS, ...PJ_K].filter(([, k]) => main.includes(k));
    return [r.week.pts > 0 && { k: "week", tab: `Week ${esc(d.wk)}`,
        cells: [...cols.map(([l, k]) => [l, pjFmt(r.week[k], l)]), ["PPR pts", r.week.pts.toFixed(1)]],
        note: `ESPN's fantasy projection, not a betting line. <a href="${link("stats", null, { show: "projected", league: "nfl", pos: r.pos })}">All projections →</a>` },
      r.pace.pts > 0 && { k: "pace", tab: "Season pace",
        cells: [...cols.map(([l, k]) => [l, paceFmt(r.pace[k]), soLine(r.so[k])]), ["PPR pts", r.pace.pts.toFixed(1), soLine(r.so.pts, 1)]],
        note: `Real stats so far plus ESPN's projection for each game left (set for that week's opponent), if he stays healthy. <a href="${link("stats", null, { show: "projected", league: "nfl", when: "pace", pos: r.pos })}">Full list →</a>` }];
  }
  function outlookCard(panes) {
    panes = panes.filter(Boolean);
    if (!panes.length) return "";
    let on = "week";
    try { on = localStorage.getItem("outlookTab") || on; } catch (e) {}
    if (!panes.some((p) => p.k === on)) on = panes[0].k;
    return `<div class="card outlook"><div class="ol-tabs">${panes.map((p) => `<button data-k="${p.k}" class="${p.k === on ? "on" : ""}">${p.tab}</button>`).join("")}</div>
      ${panes.map((p) => `<div class="ol-pane${p.k === on ? "" : " hidden"}" data-k="${p.k}"><div class="ol-line">${p.cells.map(([l, v, sub]) =>
        `<span><small>${esc(l)}</small><b>${v}</b>${sub ? `<i>${sub}</i>` : ""}</span>`).join("")}</div><p class="note">${p.note}</p></div>`).join("")}</div>`;
  }
  async function outlookInto(lg, id, slot) {
    const html = outlookCard(lg === "cfb" ? await Promise.all([cfbProjPane(id), cfbPacePane(id)]) : await nflPanes(id));
    if (!html || !slot?.isConnected) return;
    slot.insertAdjacentHTML("beforebegin", html);
    const card = slot.previousElementSibling;
    card.querySelector(".ol-tabs").onclick = (e) => {
      const k = e.target.closest("[data-k]")?.dataset.k;
      if (!k) return;
      card.querySelectorAll("[data-k]").forEach((el) => el.classList.toggle(el.matches("button") ? "on" : "hidden", el.matches("button") ? el.dataset.k === k : el.dataset.k !== k));
      try { localStorage.setItem("outlookTab", k); } catch (e2) {}
    };
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
  const birthYear = (bio) => (bio.displayDOB || bio.dateOfBirth || "").match(/(\d{4})/)?.[1] || "";

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
        const C = (cats[c.name] ||= { names: [], labels: {}, rows: [], seasonTotals: {} });
        c.names.forEach((n, j) => { if (!C.names.includes(n)) C.names.push(n); C.labels[n] = c.labels[j]; });
        // ESPN's official career totals for the player's own league (every season on record, not just what we show)
        if (c.totals?.length) C[i === 0 ? "career" : "careerCollege"] = Object.fromEntries(c.names.map((n, j) => [n, c.totals[j]]));
        for (const r of c.statistics || []) {
          if (/all-?stars?/i.test(r.teamSlug || "")) continue; // skip all-star exhibitions
          if (/totals/i.test(r.teamSlug || "")) { // season total for a year split across teams
            C.seasonTotals[`${r.season?.year}|${level}`] = Object.fromEntries(c.names.map((n, j) => [n, r.stats[j]]));
            continue;
          }
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
    // seasons on record in the player's own league (pro for NFL players), from ESPN's career stats, not our game logs
    const lvl = lg === "nfl" ? "NFL" : "NCAA";
    const seasons = [...new Set(Object.values(cats).flatMap((C) => C.rows.filter((r) => r.level === lvl).map((r) => r.year)))].sort((a, b) => a - b);
    const debut = Math.min(...[bio.debutYear, seasons[0]].filter(Boolean)) || null;
    return { id, lg, name: bio.displayName, short: bio.shortName || bio.displayName, pos: bio.position?.abbreviation, headshot: bio.headshot?.href,
      born: birthYear(bio), active: bio.active !== false, lvl, debut, seasons, cats };
  }

  // Which category and stat the Stats by year card shows (from the URL, else the player's main stat)
  function careerPick(players, st) {
    const main = players[0];
    const all = Object.values(main.cats).flatMap((C) => C.rows);
    const hasBoth = main.lg === "nfl" && all.some((r) => r.level === "NCAA") && all.some((r) => r.level === "NFL");
    const lvl = hasBoth ? (["college", "nfl", "both"].includes(st.lvl) ? st.lvl : "nfl") : "both";
    const lvlOk = (r) => lvl === "both" || r.level === (lvl === "nfl" ? "NFL" : "NCAA");
    const catNames = Object.keys(main.cats).filter((k) => main.cats[k].rows.some(lvlOk));
    if (!catNames.length) return null;
    const cat = catNames.includes(st.cat) ? st.cat : catNames.includes(PRIMARY(main.pos)) ? PRIMARY(main.pos) : catNames[0];
    const C = main.cats[cat];
    const metric = C.names.includes(st.metric) ? st.metric : C.names.includes(KEY_METRIC[cat]) ? KEY_METRIC[cat] : C.names.find((n) => /yards/i.test(n)) || C.names[1] || C.names[0];
    return { catNames, cat, C, metric, align: st.align === "career" ? "career" : "season", lvl, lvlOk, hasBoth };
  }

  // Top-10 average line: for each season on the chart, the average of that season's 10 leaders in the stat
  // (NFL leaders for pro seasons, college leaders for college seasons). Only when lined up by season.
  const LEADER_CAT = { passing: "offense:passing", rushing: "offense:rushing", receiving: "offense:receiving", defensive: "defense",
    defensiveInterceptions: "defense", kicking: "specialTeams:kicking", punting: "specialTeams:punting", returning: "specialTeams:returning", scoring: "scoring" };
  async function top10Avg(players, st) {
    const pk = careerPick(players, st);
    if (!pk || pk.align !== "season" || !LEADER_CAT[pk.cat]) return null;
    const levelOf = new Map(); // season -> league level, preferring the main player's row
    [...players].reverse().forEach((p) => (p.cats[pk.cat]?.rows || []).filter(pk.lvlOk).forEach((r) => levelOf.set(r.year, r.level)));
    const out = new Map();
    await Promise.all([...levelOf].map(async ([year, level]) => {
      const lg = level === "NFL" ? "nfl" : "cfb";
      const d = await api(`${WEB(lg)}/statistics/byathlete?category=${LEADER_CAT[pk.cat]}&sort=${pk.cat}.${pk.metric}:desc&limit=10&season=${year}&seasontype=2`, 86400000).catch(() => null);
      const same = (c) => c.name.toLowerCase() === pk.cat.toLowerCase();
      const i = (d?.categories || []).find(same)?.names?.indexOf(pk.metric) ?? -1;
      if (i < 0) return;
      const vals = (d.athletes || []).map((a) => num((a.categories || []).find(same)?.totals?.[i])).filter((v) => v != null);
      if (vals.length >= 5) out.set(year, vals.reduce((a, v) => a + v, 0) / vals.length);
    }));
    return out.size ? out : null;
  }

  function careerCard(players, st, bench = null) {
    const main = players[0];
    const pk = careerPick(players, st);
    if (!pk) return `<div class="card"><h3>Stats by year</h3><p class="muted">No season stats available.</p></div>`;
    const { catNames, cat, C, metric, align, lvl, lvlOk, hasBoth } = pk;
    const collegeOnly = lvl === "college";
    const series = players.map((p, i) => {
      const PC = p.cats[cat], bySeason = new Map();
      for (const r of PC?.rows || []) {
        if (!lvlOk(r)) continue; // College / NFL switch
        if (lvl === "both" && align === "career" && r.level !== p.lvl) continue; // career years count from the real pro (or college) debut
        // one bar per season: a year split across teams uses ESPN's season total
        const k = `${r.year}|${r.level}`, prev = bySeason.get(k);
        bySeason.set(k, prev ? { ...r, team: { ...r.team, abbr: `${prev.team.abbr}/${r.team.abbr}` }, vals: PC.seasonTotals[k] || r.vals } : r);
      }
      const rows = [...bySeason.values()].filter((r) => num(r.vals[metric]) != null)
        .map((r, _, all) => ({ ...r, x: align === "career" ? r.year - ((!collegeOnly && p.debut) || all[0].year) + 1 : r.year, v: num(r.vals[metric]) }));
      // career total: ESPN's official figure for the league shown when it has one (right for averages too)
      const official = (collegeOnly && p.lg === "nfl" ? PC?.careerCollege : PC?.career)?.[metric];
      return { p, color: CMP_COLORS[i], rows, total: official != null ? official : rows.reduce((a, r) => a + r.v, 0).toLocaleString() };
    });
    const allXs = [...new Set(series.flatMap((s) => s.rows.map((r) => r.x)))].sort((a, b) => a - b);
    const zFrom = +st.from || -Infinity, zTo = +st.to || Infinity;
    const zoomed = allXs.filter((x) => x >= zFrom && x <= zTo);
    const xs = zoomed.length >= 2 ? zoomed : allXs, isZoomed = xs.length < allXs.length, inView = new Set(xs);
    const benchAt = (x) => (bench && align === "season" ? bench.get(x) : undefined);
    const max = Math.max(1, ...series.flatMap((s) => s.rows.filter((r) => inView.has(r.x)).map((r) => r.v)), ...xs.map(benchAt).filter((v) => v != null));
    // line chart (SVG): one line per player, a dot on each season; the line breaks over seasons with no stats
    const W = 720, H = 230, padL = 46, padR = 14, top = 18, base = H - 22;
    const gw = (W - padL - padR) / Math.max(1, xs.length), px = (gi) => padL + gi * gw + gw / 2, py = (v) => base - (Math.max(0, v) / max) * (base - top);
    const step = Math.ceil(xs.length / 12); // thin out year labels on long careers
    const fmt = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : +v.toFixed(v < 10 ? 1 : 0));
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line x1="${padL}" y1="${py(max * f).toFixed(1)}" x2="${W - padR}" y2="${py(max * f).toFixed(1)}" class="${f ? "cc-grid" : "cc-axis"}"/>`
      + `<text x="${padL - 6}" y="${(py(max * f) + 3.5).toFixed(1)}" class="cc-y">${fmt(max * f)}</text>`).join("");
    const xlabels = xs.map((x, gi) => (gi % step ? "" : `<text x="${px(gi).toFixed(1)}" y="${H - 5}" class="cc-x">${align === "career" ? "Yr " + x : x}</text>`)).join("");
    // lines draw themselves in left to right; each dot pops in as the line reaches it (CSS animations)
    const nodes = [];
    const mixLv = lvl === "both" && main.lg === "nfl"; // showing college and NFL seasons together
    const shade = (sr, r) => (mixLv && r.level === "NCAA" ? `color-mix(in srgb, ${sr.color} 42%, #3a3a40)` : sr.color);
    let benchLine = "";
    if (xs.some((x) => benchAt(x) != null)) {
      const pts = xs.map((x, gi) => benchAt(x) != null && { x: px(gi), y: py(benchAt(x)), gi, v: benchAt(x) });
      let d = "";
      pts.forEach((p, i) => { if (p) d += `${pts[i - 1] ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`; });
      benchLine = `<path d="${d}" class="cc-bench"/>` + pts.filter(Boolean).map((p) => {
        nodes.push({ x: p.x, y: p.y, si: -1, label: String(xs[p.gi]), team: "", val: fmt(p.v).toLocaleString() });
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="cc-dot cc-bdot" data-n="${nodes.length - 1}" style="animation-delay:${(0.1 + (p.gi / Math.max(1, xs.length - 1)) * 0.9).toFixed(2)}s"></circle>`;
      }).join("");
    }
    const lines = benchLine + series.map((sr, si) => {
      const pts = xs.map((x, gi) => { const r = sr.rows.find((q) => q.x === x); return r && { r, x: px(gi), y: py(r.v), gi }; });
      let d = "";
      pts.forEach((p, i) => { if (p) d += `${pts[i - 1] ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`; });
      const dots = pts.filter(Boolean).map((p) => {
        nodes.push({ x: p.x, y: p.y, si, label: align === "career" ? `Career yr ${xs[p.gi]} · ${p.r.year}` : String(p.r.year), team: p.r.team.abbr, val: p.r.vals[metric] });
        return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" class="cc-dot" data-n="${nodes.length - 1}" style="fill:${shade(sr, p.r)};animation-delay:${(0.1 + si * 0.15 + (p.gi / Math.max(1, xs.length - 1)) * 0.9).toFixed(2)}s"></circle>`;
      }).join("");
      return `<path d="${d}" stroke="${sr.color}" class="cc-line" pathLength="1" style="animation-delay:${si * 0.15}s"/>${dots}`;
    }).join("");
    // bar version: grouped bars that grow up from the axis, one group per season (top-10 average drawn over them)
    const bnodes = [], bw = Math.min(34, (gw - 10) / series.length);
    const bars = xs.map((x, gi) => series.map((sr, si) => {
      const r = sr.rows.find((q) => q.x === x);
      if (!r) return "";
      const bx = padL + gi * gw + (gw - bw * series.length) / 2 + si * bw, by = py(r.v);
      bnodes.push({ x: bx + (bw - 2) / 2, y: by, x0: bx, x1: bx + bw - 2, si, label: align === "career" ? `Career yr ${x} · ${r.year}` : String(r.year), team: r.team.abbr, val: r.vals[metric] });
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(base - by).toFixed(1)}" class="cc-bar" data-n="${bnodes.length - 1}" style="fill:${shade(sr, r)};animation-delay:${(0.05 + (gi / Math.max(1, xs.length - 1)) * 0.6).toFixed(2)}s"/>`;
    }).join("")).join("");
    const benchOver = benchLine ? benchLine.replace(/data-n="(\d+)"/g, (_, n) => { bnodes.push({ ...nodes[+n] }); return `data-n="${bnodes.length - 1}"`; }) : "";
    const svg = (mode, body) => `<svg viewBox="0 0 ${W} ${H}" class="cc-chart cc-${mode}" data-mode="${mode}" role="img" aria-label="${esc(C.labels[metric])} by ${align === "career" ? "career year" : "season"}">${grid}${xlabels}${body}</svg>`;
    const mode = ccPref("view", "line") === "bar" ? "bar" : "line";
    const chart = `<div class="cc-box" id="cc-box" data-mode="${mode}">${svg("line", lines)}${svg("bar", bars + benchOver)}<div class="cc-brush"></div><div class="cc-tip"></div></div>
      <p class="cc-hint muted">${isZoomed ? `Showing ${align === "career" ? "career years " : ""}${xs[0]}–${xs[xs.length - 1]} · <button class="link" id="cc-unzoom">Reset zoom</button>` : "Drag across the chart to zoom in on a stretch of seasons"}</p>`;
    // what the hover box needs (read by initCcHover once the chart is on the page)
    ccHover = { W, H, top, base, cols: xs.map((x, gi) => ({ x, px: px(gi) })), sets: { line: nodes, bar: bnodes }, stat: C.labels[metric], series: series.map((sr) => ({ name: sr.p.name, color: sr.color })) };
    const legend = series.map((sr, i) => `<span class="cc-chip" style="--c:${sr.color}">${face(sr.p.headshot, sr.p.name, "hs", sr.p.lg === "nfl", sr.p.born)} ${esc(sr.p.name)} <small>${esc(sr.p.pos || "")}</small>
      ${i ? `<button class="cc-x-btn" data-rm="${esc(sr.p.lg)}:${esc(sr.p.id)}" aria-label="Remove">×</button>` : ""}</span>`).join("")
      + (benchLine ? `<span class="cc-bench-key" title="Each season's average for the top 10 players in this stat"><i></i>Top-10 avg</span>` : "")
      + (mixLv && series.some((sr) => sr.rows.some((r) => inView.has(r.x) && r.level === "NCAA"))
        ? `<span class="cc-bench-key cc-lv-key"><b style="background:${series[0].color}"></b>NFL <b style="background:color-mix(in srgb, ${series[0].color} 42%, #3a3a40)"></b>College</span>` : "");

    const teamCell = (r) => `<span class="tm">${img(r.team.logo, "xs")} ${esc(r.team.abbr)}${r.level === "NCAA" && main.lg === "nfl" && lvl === "both" ? ' <span class="pill lvl">NCAA</span>' : ""}</span>`;
    // Both mode: college rows are dimmed like the chart's college shade, with a labeled line where the NFL starts
    const ncaa = (r) => mixLv && r?.level === "NCAA";
    const divider = (span) => `<tr class="cc-div"><td colspan="${span}"><span>College ↑</span><span>NFL ↓</span></td></tr>`;
    let table;
    if (players.length === 1) {
      const shownRows = C.rows.filter(lvlOk), tot = collegeOnly && main.lg === "nfl" ? C.careerCollege : C.career;
      const cols = C.names.filter((n) => shownRows.some((r) => r.vals[n] != null));
      table = `<table class="box career"><thead><tr><th>Year</th><th>Team</th>${cols.map((n) => `<th class="num${n === metric ? " on" : ""}" title="${esc(n)}">${esc(C.labels[n])}</th>`).join("")}</tr></thead><tbody>
        ${shownRows.map((r, i) => `${!ncaa(r) && ncaa(shownRows[i - 1]) ? divider(cols.length + 2) : ""}<tr${ncaa(r) ? ' class="cc-ncaa"' : ""}><td>${r.year}</td><td>${teamCell(r)}</td>${cols.map((n) => `<td class="num${n === metric ? " on" : ""}">${esc(r.vals[n] ?? "–")}</td>`).join("")}</tr>`).join("")}
        ${tot ? `<tr class="tot"><td>Career</td><td class="muted">${collegeOnly || main.lvl !== "NFL" ? "College" : "NFL"}</td>${cols.map((n) => `<td class="num${n === metric ? " on" : ""}">${esc(tot[n] ?? "")}</td>`).join("")}</tr>` : ""}</tbody></table>`;
    } else {
      table = `<table class="box career"><thead><tr><th>${align === "career" ? "Career yr" : "Season"}</th>${series.map((sr) => `<th colspan="2" class="cc-h" style="--c:${sr.color}">${esc(sr.p.short)}</th>`).join("")}</tr></thead><tbody>
        ${xs.map((x, i) => { const at = (xx) => series[0].rows.find((q) => q.x === xx), all = series.map((sr) => sr.rows.find((q) => q.x === x));
          // the line goes where the first player's NFL career starts; other players' college cells are dimmed on their own
          return `${i && at(x) && !ncaa(at(x)) && series[0].rows.some((q) => q.x < x && ncaa(q)) && !series[0].rows.some((q) => q.x < x && !ncaa(q)) ? divider(1 + series.length * 2) : ""}`
          + `<tr${all.every((r) => !r || ncaa(r)) && all.some(ncaa) ? ' class="cc-ncaa"' : ""}><td>${align === "career" ? "Yr " + x : x}</td>${all.map((r) => {
          const dim = ncaa(r) ? ' class="cc-ncaa-c"' : "";
          return r ? `<td${dim}>${align === "career" ? `<small class="muted">${r.year}</small> ` : ""}${teamCell(r)}</td><td class="num on${ncaa(r) ? " cc-ncaa-c" : ""}">${esc(r.vals[metric])}</td>` : `<td class="muted">–</td><td></td>`; }).join("")}</tr>`; }).join("")}
        <tr class="tot"><td>Career</td>${series.map((sr) => `<td class="muted">${sr.p.lvl === "NFL" && !collegeOnly ? "NFL" : "College"}</td><td class="num">${esc(sr.total)}</td>`).join("")}</tr></tbody></table>`;
    }
    return `<div class="card career-card">
      <div class="sc-bar"><h3>Stats by year</h3>
        <div class="seg" id="cc-cats">${catNames.map((k) => `<button data-cat="${esc(k)}" class="${k === cat ? "active" : ""}">${esc(CAT_LABEL[k] || k)}</button>`).join("")}</div></div>
      <div class="cc-controls">
        ${hasBoth ? `<div class="seg" id="cc-lvl" title="Which seasons to show">${[["college", "College"], ["nfl", "NFL"], ["both", "Both"]].map(([v, l]) => `<button data-lvl="${v}" class="${v === lvl ? "active" : ""}">${l}</button>`).join("")}</div>` : ""}
        <label>Chart <select id="cc-metric">${C.names.map((n) => `<option value="${esc(n)}"${n === metric ? " selected" : ""}>${esc(C.labels[n])}</option>`).join("")}</select></label>
        <label>Line up by <select id="cc-align"><option value="season"${align === "season" ? " selected" : ""}>Season</option><option value="career"${align === "career" ? " selected" : ""}>Career year</option></select></label>
        <div class="seg" id="cc-view"><button data-v="line" class="${mode === "line" ? "active" : ""}">Line</button><button data-v="bar" class="${mode === "bar" ? "active" : ""}">Bar</button></div>
        <div class="seg"><button id="cc-tbl" class="${ccPref("table", "1") === "1" ? "active" : ""}" title="Show or hide the data table">Table</button></div>
        <div class="cc-search"><input id="cc-q" type="search" placeholder="Compare with another player…" autocomplete="off"${players.length >= 4 ? " disabled" : ""}><div id="cc-results" class="cc-results hidden"></div></div>
      </div>
      <div class="cc-legend">${legend}</div>
      ${chart}
      <div class="table-wrap${ccPref("table", "1") === "1" ? "" : " hidden"}" id="cc-table">${table}</div>
    </div>`;
  }

  // chart style and table on/off are remembered per browser (a convenience; everything works without it)
  function ccPref(k, def) { try { return localStorage.getItem("cc-" + k) ?? def; } catch { return def; } }
  function ccSetPref(k, v) { try { localStorage.setItem("cc-" + k, v); } catch {} }

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

  // Stats by year hover: the dot nearest the pointer lights up and a box beside it shows that season's number.
  let ccHover = null;
  function initCcHover() {
    const box = $("#cc-box"), H = ccHover;
    if (!box || !H) return;
    const tip = box.querySelector(".cc-tip");
    let cur = -1, mode = box.dataset.mode;
    const marks = () => box.querySelectorAll(`svg[data-mode="${mode}"] [data-n]`);
    const hide = () => { cur = -1; tip.classList.remove("on"); box.querySelectorAll("[data-n].on").forEach((d) => d.classList.remove("on")); };
    box.ccMode = (m) => { mode = m; box.dataset.mode = m; hide(); };
    const show = (e, touch) => {
      const svg = box.querySelector(`svg[data-mode="${mode}"]`), nodes = H.sets[mode];
      const r = svg.getBoundingClientRect(), k = Math.min(r.width / H.W, r.height / H.H);
      const ox = (r.width - H.W * k) / 2, oy = (r.height - H.H * k) / 2;
      const mx = e.clientX - r.left, my = e.clientY - r.top, sx = (mx - ox) / k, sy = (my - oy) / k;
      let best = -1, bd = Infinity;
      nodes.forEach((n, i) => { if (n.x0 == null) { const dd = Math.hypot(ox + n.x * k - mx, oy + n.y * k - my); if (dd < bd) { bd = dd; best = i; } } });
      if (bd > (mode === "bar" ? (touch ? 22 : 10) : (touch ? 60 : 28))) { // not on a dot: on a bar?
        best = nodes.findIndex((n) => n.x0 != null && sx >= n.x0 - 2 && sx <= n.x1 + 2 && sy >= Math.min(n.y, H.H - 40) - 6 && sy <= H.H - 22);
        if (best < 0) return hide();
      }
      if (best === cur) return;
      cur = best;
      const n = nodes[best], s = n.si < 0 ? { name: "Top-10 average", color: "#6b6b70" } : H.series[n.si], x = ox + n.x * k, y = oy + n.y * k;
      marks().forEach((d) => d.classList.toggle("on", +d.dataset.n === best));
      tip.innerHTML = `<small>${esc(n.label)}${n.team ? ` · ${esc(n.team)}` : ""}</small><b>${esc(n.val)} <em>${esc(H.stat)}</em></b>${H.series.length > 1 || n.si < 0 ? `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>` : ""}`;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
      tip.classList.toggle("below", y < 70);
      tip.classList.toggle("edge-l", x < 80);
      tip.classList.toggle("edge-r", x > r.width - 80);
      tip.classList.remove("on"); void tip.offsetWidth; tip.classList.add("on"); // replay the pop-in for each new dot
    };
    const brush = box.querySelector(".cc-brush");
    let drag = null;
    const colAt = (clientX) => { // nearest season column to the pointer, and its x on screen
      const svg = box.querySelector(`svg[data-mode="${mode}"]`), r = svg.getBoundingClientRect(), k = Math.min(r.width / H.W, r.height / H.H);
      const ox = (r.width - H.W * k) / 2, sx = (clientX - r.left - ox) / k;
      let i = 0;
      H.cols.forEach((c, j) => { if (Math.abs(c.px - sx) < Math.abs(H.cols[i].px - sx)) i = j; });
      return { i, left: clientX - box.getBoundingClientRect().left, k, oy: (r.height - H.H * k) / 2 };
    };
    box.addEventListener("pointerdown", (e) => {
      show(e, e.pointerType === "touch");
      if (e.pointerType === "mouse" && e.button !== 0) return;
      drag = { x0: e.clientX, a: colAt(e.clientX) };
    });
    box.addEventListener("pointermove", (e) => {
      if (drag && Math.abs(e.clientX - drag.x0) > 12) {
        drag.moved = true;
        hide();
        const b = colAt(e.clientX), l = Math.min(drag.a.left, b.left), w = Math.abs(b.left - drag.a.left);
        Object.assign(brush.style, { display: "block", left: `${l}px`, width: `${w}px`, top: `${b.oy + H.top * b.k}px`, height: `${(H.base - H.top) * b.k}px` });
        return;
      }
      if (!drag) show(e, e.pointerType === "touch");
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      brush.style.display = "none";
      if (!d.moved || !e) return;
      const b = colAt(e.clientX), lo = Math.min(d.a.i, b.i), hi = Math.max(d.a.i, b.i);
      if (hi > lo && box.ccZoom) box.ccZoom(H.cols[lo].x, H.cols[hi].x); // need at least two seasons
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointerleave", () => { end(null); hide(); });
  }

  function wireCareer(id, params) {
    initCcHover();
    $("#cc-view").onclick = (e) => {
      const v = e.target.dataset.v, box = $("#cc-box");
      if (!v || !box || box.dataset.mode === v) return;
      ccSetPref("view", v);
      $("#cc-view").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
      box.ccMode(v); // switching shows the other chart, which replays its animation
    };
    $("#cc-tbl").onclick = (e) => {
      const on = $("#cc-table").classList.toggle("hidden") === false;
      e.currentTarget.classList.toggle("active", on);
      ccSetPref("table", on ? "1" : "0");
    };
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.delete("league");
      location.hash = link("player", id, Object.fromEntries(p));
    };
    const vs = (params.get("vs") || "").split(",").filter(Boolean);
    $("#cc-cats").onclick = (e) => { const c = e.target.dataset.cat; if (c) go({ cat: c, metric: null }); };
    $("#cc-metric").onchange = (e) => go({ metric: e.target.value });
    $("#cc-align").onchange = (e) => go({ align: e.target.value, from: null, to: null });
    if ($("#cc-lvl")) $("#cc-lvl").onclick = (e) => { const v = e.target.dataset.lvl; if (v) go({ lvl: v, from: null, to: null }); };
    if ($("#cc-box")) $("#cc-box").ccZoom = (from, to) => go({ from, to });
    if ($("#cc-unzoom")) $("#cc-unzoom").onclick = () => go({ from: null, to: null });
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
      a.age ? `Age ${a.age}` : "", a.displayDraft,
      a.college?.name || a.collegeTeam?.displayName ? `College: ${a.college?.name || a.collegeTeam?.displayName}` : "",
      a.displayBirthPlace ? `From ${a.displayBirthPlace}` : "",
    ].filter(Boolean);
    const inj = a.injuries?.[0];
    const fa = a.status?.type === "free-agent"; // ESPN keeps a free agent's last team on the record, so check the status
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
    const thisYear = new Date().getFullYear(), born = birthYear(a);
    const hsLabel = [a.jersey ? "#" + a.jersey : "", a.position?.abbreviation || ""].filter(Boolean).join(" ");
    // every season of the career: ESPN lists them on the game log (e.g. 1985-2004 for Jerry Rice)
    const seasonF = (gl?.filters || []).find((f) => f.name === "season");
    const firstYear = a.debutYear || thisYear - 25;
    const noLogs = !seasonF?.options?.length && a.active === false; // retired and ESPN has no game logs at all (pre-1990s careers)
    const years = seasonF?.options?.length ? seasonF.options.map((o) => +o.value) : noLogs ? [] : Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i);
    const shown = +(season || seasonF?.value || gl?.requestedSeason?.year || thisYear);
    // years in the league: active players get ESPN's current count; retired ones get filled in from their career record below
    const exp = a.active !== false ? a.displayExperience || a.experience?.displayValue || "" : "";
    view("player").innerHTML = `
      <div class="card player-head">
        <div class="hs-frame" style="--tc:${teamColor(a.team)}">
          ${face(a.headshot?.href, a.displayName, "headshot", lg === "nfl", born)}
          ${hsLabel ? `<span class="hs-tag">${esc(hsLabel)}</span>` : ""}</div>
        <div>
          <h2>${esc(a.displayName)}${lg === "nfl" && a.active === false ? ` <span class="retired-tag">Retired</span>` : ""}</h2>
          <p>${a.team ? `<a href="${link("team", a.team.id)}"><span class="tm">${img(a.team.logos?.[0]?.href || a.team.logo, "xs")} ${esc(a.team.displayName)}</span></a>` : ""}
            ${injInfo(inj) ? ` <span class="inj-line">${injTag(inj, a.id, fa ? "" : a.team?.id)} ${esc(injInfo(inj).tip)}</span>` : ""}</p>
          <p class="muted">${facts.map(esc).join(" · ")}<span id="pl-exp">${exp ? " · " + esc(exp) : ""}</span></p>
        </div>
      </div>
      ${summary ? `<div class="stats wide">${summary}</div>` : ""}
      <div id="career-slot"><div class="card muted">Loading stats by year…</div></div>
      <div class="card"><div class="sc-bar"><h3>Game log</h3>
        <select id="pl-season"${noLogs ? ` class="hidden"` : ""}>${years.map((y) => `<option${y === shown ? " selected" : ""}>${y}</option>`).join("")}</select></div>
        ${log || (noLogs ? `<p class="muted">ESPN doesn't have game-by-game logs for this player's career. Season totals, where ESPN has them, are in Stats by year above.</p>` : shown < 2000 ? `<p class="muted">ESPN doesn't have game-by-game logs for ${shown} (older seasons are spotty before the late 1990s). Season totals are in Stats by year above.</p>`
          : `<p class="muted">No games logged for this season.</p>`)}</div>
      ${injInfo(inj) ? injCard(inj, a.id, fa ? "" : a.team?.id)
        : params.get("inj") ? `<div class="card inj-card" id="pl-inj"><h3>Injury</h3><p class="muted">ESPN has no injury details on file for this player right now.</p></div>` : ""}`;
    fillFaces(view("player"));
    if (my === token) outlookInto(lg, id, $("#career-slot")).catch(() => {});
    const toInj = params.get("inj") && $("#pl-inj");
    if (toInj) pulse(toInj);
    $("#pl-season").onchange = (e) => { location.hash = link("player", id, { season: e.target.value }); };
    const careers = await careersP;
    if (my !== token) return;
    const cst = { cat: params.get("cat"), metric: params.get("metric"), align: params.get("align"), from: params.get("from"), to: params.get("to"), lvl: params.get("lvl") };
    // top-10 average line; don't hold the chart up more than a few seconds for it
    const bench = careers ? await Promise.race([top10Avg(careers, cst).catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))]) : null;
    if (my !== token) return;
    $("#career-slot").innerHTML = careers ? careerCard(careers, cst, bench)
      : `<div class="card muted">Season-by-season stats aren't available for this player.</div>`;
    if (careers) {
      if ($("#cc-view")) wireCareer(id, params); // not there when the player has no season stats
      fillFaces($("#career-slot"));
      const me = careers[0], n = me.seasons.length;
      if (!exp && n) $("#pl-exp").textContent = ` · ${n} ${me.lvl === "NFL" ? "NFL" : "college"} season${n > 1 ? "s" : ""} (${me.seasons[0]}${n > 1 ? "–" + me.seasons[n - 1] : ""})`;
    }
    if (toInj) pulse(toInj); // stats by year just filled in above it, so find it again
    else if (vs.length) $("#career-slot").scrollIntoView({ block: "start" });
  }
  // The player's current injury, at the bottom of their page: status, body part, expected return and ESPN's notes
  function injCard(i, pid, tid) {
    const x = injInfo(i), d = i.details || {};
    const day = (s) => new Date(s.length > 10 ? s : s + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const rows = [["Status", x.status], ["Injury", x.part], ["Est. return", d.returnDate ? day(d.returnDate.slice(0, 10)) : ""], ["Updated", i.date ? day(i.date) : ""]]
      .filter((r) => r[1]).map(([k, v]) => `<div class="stat"><small>${k}</small><b>${esc(v)}</b></div>`).join("");
    const notes = [...new Set([i.shortComment, i.longComment])].filter((c) => c && c.toLowerCase() !== x.status.toLowerCase());
    return `<div class="card inj-card" id="pl-inj"><h3>Injury ${injTag(i, pid, tid)}</h3><div class="stats wide">${rows}</div>
      ${notes.map((c) => `<p>${esc(c)}</p>`).join("")}</div>`;
  }

  // ---------------------------------------------------------------- standings
  function groupsOf(node) {
    if (node.standings?.entries) return [{ name: node.name, entries: node.standings.entries }];
    return (node.children || []).flatMap(groupsOf);
  }
  const stat = (e, key) => e.stats.find((s) => s.type === key || s.name === key)?.displayValue ?? "";
  const statNum = (e, key) => +(e.stats.find((s) => s.type === key || s.name === key)?.value ?? 0);

  // One conference at a time (CFB) or AFC/NFC with its divisions (NFL); ?conf= keeps the pick in the URL.
  const CONF_SHORT = { 8: "SEC", 5: "Big Ten", 4: "Big 12", 1: "ACC", 9: "Pac-12", 151: "AAC", 12: "C-USA", 18: "Ind.", 15: "MAC", 17: "MWC", 37: "Sun Belt" };
  const CONF_ORDER = ["8", "5", "4", "1", "9", "151", "12", "15", "17", "37", "18"]; // Power 4 first
  async function standings(_, params) {
    const lg = league, my = token;
    if (params.get("show") === "playoff") return playoff(lg, my, params);
    loading("standings");
    let d, ranks;
    try {
      [d, ranks] = await Promise.all([api(`${STAND(lg)}/standings?${lg === "nfl" ? "level=3" : "group=80"}`, 300000), modelRanks(lg)]);
    } catch (e) { return fail("standings", e); }
    if (my !== token) return;
    const nfl = lg === "nfl";
    // [label, ESPN stat, shown on phones too]
    const cols = nfl
      ? [["REC", "total", 1], ["PCT", "winPercent"], ["PF", "pointsFor"], ["PA", "pointsAgainst"], ["DIFF", "differential", 1], ["STRK", "streak", 1], ["DIV", "divisionRecord"], ["CONF", "vs. Conf."]]
      : [["CONF", "vsconf", 1], ["OVR", "total", 1], ["PF", "pointsfor"], ["PA", "pointsagainst"], ["STRK", "streak", 1], ["vs AP", "vsaprankedteams"]];
    const confs = (d.children || []).map((c) => ({ id: String(c.id), name: c.name, short: nfl ? c.abbreviation : CONF_SHORT[c.id] || c.abbreviation || c.name, groups: groupsOf(c) }))
      .sort((a, b) => ((CONF_ORDER.indexOf(a.id) + 1) || 99) - ((CONF_ORDER.indexOf(b.id) + 1) || 99));
    // default: the conference of the last team page you opened, else SEC / AFC
    const last = store.get("lastTeam-" + lg);
    const home = confs.find((c) => c.groups.some((g) => g.entries.some((e) => String(e.team.id) === String(last)))) || confs.find((c) => c.id === "8") || confs[0];
    const want = params.get("conf");
    const pick = want === "all" ? "all" : (confs.find((c) => c.id === want) || home)?.id;
    const shown = pick === "all" ? confs : confs.filter((c) => c.id === pick);
    const chips = [...confs.map((c) => [c.id, c.short, c.name]), ...(nfl ? [] : [["all", "All", "Every conference"]])];

    const table = (name, entries) => `<div class="card"><h3>${esc(name)}</h3><div class="table-wrap"><table class="standings"><thead><tr>
      <th class="num" title="Cupcake Index rank">Our #</th><th>Team</th>${cols.map(([l, , ph]) => `<th class="num${ph ? "" : " wide"}">${l}</th>`).join("")}
      ${nfl ? `<th class="num" title="Playoff seed if the season ended today (1-7 make it)">Seed</th>` : ""}${nfl ? "" : `<th class="num" title="Cupcake score: higher = softer schedule">CUP</th>`}</tr></thead><tbody>
      ${entries.map((e) => {
        const ours = ourTeam(ranks, lg, e.team), seed = statNum(e, "playoffseed");
        const nm = nfl ? e.team.displayName : e.team.location || e.team.displayName;
        return `<tr><td class="num">${ours ? `<a class="our-rk" href="${link("rankings", null, { team: ours.team })}" title="Cupcake Index rank">#${ours.rank}</a>` : "–"}</td>
          <td><a href="${link("team", e.team.id)}"><span class="tm">${img(teamLogo(e.team), "xs")} <span class="tn" title="${esc(nm)}">${esc(nm)}</span>${nfl ? `<span class="tn-short">${esc(e.team.shortDisplayName || nm)}</span>` : ""}</span></a></td>
          ${cols.map(([, k, ph]) => `<td class="num${ph ? "" : " wide"}">${esc(stat(e, k))}</td>`).join("")}
          ${nfl ? `<td class="num${seed && seed <= 7 ? " seed-in" : " muted"}">${seed || "–"}</td>` : ""}
          ${nfl ? "" : `<td class="num">${ours ? `<span class="chip" style="${heat(100 - ours.scores.cupcake)}">${Math.round(ours.scores.cupcake)}</span>` : "–"}</td>`}</tr>`;
      }).join("")}</tbody></table></div></div>`;
    const bySeed = (g) => [...g.entries].sort((a, b) => (statNum(a, "playoffseed") || 99) - (statNum(b, "playoffseed") || 99));
    view("standings").innerHTML = `${stSub(false)}<div class="sc-bar"><div class="presets" id="st-conf">${chips.map(([v, l, t]) =>
        `<button data-conf="${esc(v)}" title="${esc(t)}" class="${v === pick ? "on" : ""}">${esc(l)}</button>`).join("")}</div></div>
      ${shown.flatMap((c) => c.groups.map((g) => table(c.groups.length > 1 || nfl ? g.name : c.name, bySeed(g)))).join("") || `<div class="card muted">No standings available.</div>`}
      ${nfl && shown.length ? `<p class="note">Seed = playoff seed if the season ended today; seeds 1–7 make the playoffs.</p>` : ""}`;
    $("#st-conf").onclick = (e) => {
      const v = e.target.dataset?.conf;
      if (v) location.hash = link("standings", null, { conf: v });
    };
  }


  // ---------------------------------------------------------------- playoff picture (a sub-view of Standings)
  // CFB: a 12-team CFP field projected from our rankings. NFL: ESPN's seeds if the season ended today.
  // Past the first round, each game goes to our model's favorite (ratings + home field, same math as src/model.py).
  const stSub = (on) => `<div class="subtabs st-sub"><a class="subtab${on ? "" : " on"}" href="${link("standings")}">Standings</a>`
    + `<a class="subtab${on ? " on" : ""}" href="${link("standings", null, { show: "playoff" })}">Playoff picture</a></div>`;
  const GAME = { cfb: { hfa: 2.5, scale: 1.2, sigma: 15 }, nfl: { hfa: 1.5, scale: 1, sigma: 13.5 } }; // mirrors src/config.yaml
  // Normal CDF (Abramowitz-Stegun erf approximation), for win probabilities
  function phi(z) {
    const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }
  // My-picks state while a bracket is being built: ids[k] = team id picked in game k (games numbered in build order)
  let PK = null;
  // One bracket game: a/b = team slots (null = TBD), home = a hosts, kids = the games that feed it.
  // The favorite moves on as a projected slot; p = its win chance in this game.
  function bGame(lg, a, b, col, label, home, kids = []) {
    const g = { a, b, col, label, home, kids, win: null, p: null, spread: null };
    if (a?.rating != null && b?.rating != null) {
      const m = GAME[lg], spread = (a.rating - b.rating + (home ? m.hfa : 0)) * m.scale, pa = phi(spread / m.sigma);
      Object.assign(g, { spread, p: Math.max(pa, 1 - pa), win: { ...(pa >= 0.5 ? a : b), proj: true } });
    }
    if (PK) { // "My picks": the viewer's pick moves on instead (kept only if that team is actually in this game)
      g.key = PK.n++; g.fav = g.win;
      const pick = (id) => id && [a, b].find((s) => s && String(s.id) === id);
      const w = pick(PK.ids[g.key]) || (PK.fill && g.fav ? pick(String(g.fav.id)) : null); // fill = the model's favorite where you haven't picked
      g.win = w ? { ...w, proj: false } : null;
      PK.ids[g.key] = w ? String(w.id) : "";
    }
    return g;
  }
  const bySeed = (x, y) => (x && y && y.seed < x.seed ? [y, x] : [x, y]); // better seed first (hosts)

  // CFP (2026 rules): the 4 power-conference champions + the best Group of 6 champion get in, Notre Dame if top 12,
  // then at-large by rank. Straight seeding: the top 4 get byes; first-round games at the higher seed, then neutral bowls.
  // seated = My picks: seat i (seed i + 1) -> the team you typed there, or null (the slot becomes a seed prompt)
  function cfpBracket(ranks, seated = null) {
    const s = seated ? Array.from({ length: 12 }, (_, i) => seated(i)) : cfpField(ranks);
    const seed = (n) => s[n - 1] || null;
    const fr = [[8, 9], [5, 12], [7, 10], [6, 11]].map(([h, a]) => Object.assign(bGame("cfb", seed(h), seed(a), 0, "First round", true), { sa: h - 1, sb: a - 1 }));
    const qf = [1, 4, 2, 3].map((h, i) => Object.assign(bGame("cfb", seed(h), fr[i].win, 1, "Quarterfinal", false, [fr[i]]), { sa: h - 1 }));
    const sf = [0, 2].map((i) => bGame("cfb", qf[i].win, qf[i + 1].win, 2, "Semifinal", false, [qf[i], qf[i + 1]]));
    const root = bGame("cfb", sf[0].win, sf[1].win, 3, "National championship", false, sf);
    place(root, { i: 0 });
    return { field: s, root, cols: ["First round", "Quarterfinals", "Semifinals", "Title game"] };
  }
  function cfpField(ranks) {
    const list = [...ranks.byName.values()], P4 = ["SEC", "Big Ten", "Big 12", "ACC"];
    const champ = new Map(); // conference -> its highest-ranked team = our projected champion
    list.forEach((t) => { if (t.conference && !/independent/i.test(t.conference) && !champ.has(t.conference)) champ.set(t.conference, t); });
    const auto = P4.map((c) => champ.get(c)).filter(Boolean);
    const g6 = [...champ].filter(([c]) => !P4.includes(c)).map(([, t]) => t).sort((a, b) => a.rank - b.rank)[0];
    if (g6) auto.push(g6);
    const field = new Set(auto), nd = list.find((t) => t.team === "Notre Dame");
    if (nd && nd.rank <= 12) field.add(nd);
    for (const t of list) { if (field.size >= 12) break; field.add(t); }
    return [...field].sort((a, b) => a.rank - b.rank).map((t, i) => ({ ...cfbTeam(t), seed: i + 1, auto: auto.includes(t) }));
  }
  const cfbTeam = (t) => ({ name: t.team, short: t.team, logo: t.logo, id: String(t.id), rank: t.rank, record: t.record, rating: t.rating, conf: t.conference });

  // One NFL conference: 2v7, 3v6, 4v5 (1 has a bye), then the Divisional round reseeds (1 hosts the lowest seed left).
  // base = My picks: seat number of this conference's 1 seed (seed n sits in seat base + n - 1)
  function nflSide(slots, cols, conf, base = 0) {
    const s = new Map(slots.filter(Boolean).map((x) => [x.seed, x])), at = (n) => s.get(n) || null;
    const wc = [[2, 7], [3, 6], [4, 5]].map(([h, a]) => Object.assign(bGame("nfl", at(h), at(a), cols[0], `${conf} Wild Card`, true), { sa: base + h - 1, sb: base + a - 1 }));
    const full = wc.every((g) => g.win); // can't reseed until all three Wild Card winners are known
    const low = full ? wc.reduce((x, g) => (g.win.seed > x.win.seed ? g : x)) : wc[0];
    const rest = wc.filter((g) => g !== low);
    const d1 = Object.assign(bGame("nfl", at(1), full ? low.win : null, cols[1], `${conf} Divisional`, true, [low]), { sa: base });
    const d2 = bGame("nfl", ...(full ? bySeed(rest[0].win, rest[1].win) : [null, null]), cols[1], `${conf} Divisional`, true, rest);
    const top = bGame("nfl", ...bySeed(d1.win, d2.win), cols[2], `${conf} Championship`, true, [d1, d2]);
    place(top, { i: 0 });
    return top;
  }

  // Layout: first-round games stack top to bottom; every later game sits level with the games feeding it.
  const VGAP = 16, HEAD = 24;
  let BH = 56; // game box height; taller in My picks so each team is a comfortable tap target
  function place(g, n) {
    if (!g.kids.length) { g.y = n.i++ * (BH + VGAP); return; }
    g.kids.forEach((k) => place(k, n));
    g.y = g.kids.reduce((s, k) => s + k.y, 0) / g.kids.length;
  }
  // ---- My picks, typed: an empty slot is a little terminal prompt for the winner of the game feeding it.
  let TEAMX = new Map(); // CFB: ESPN team id -> ESPN team (abbreviation, mascot), so "OSU" or "Buckeyes" works too
  const terms = (s) => {
    const x = TEAMX.get(String(s.id)) || {}, list = [s.name, s.short, s.abbr, s.loc, s.mascot, x.abbreviation, x.location, x.name, x.displayName];
    const words = normName(s.name).split(" ");
    if (words.length > 1) list.push(words.map((w) => w[0]).join("")); // initials: "os" = Ohio State
    return [...new Set(list.map(normName).filter(Boolean))];
  };
  // Which team does the text mean, out of a list (a game's two teams, or every team still free for a seed)?
  // Exact word > start of a word/name > typo-tolerant match.
  function typedTeam(text, list) {
    const q = normName(text);
    if (!q) return null;
    let best = null;
    for (const t of list) for (const w of terms(t).flatMap((n) => [n, ...n.split(" ").slice(1).map((_, i, a) => a.slice(i).join(" "))])) {
      const f = w.startsWith(q) ? null : fuzzyScore(q, w);
      const sc = w === q ? 0 : w.startsWith(q) ? 1 : f != null ? 2 + f : null;
      if (sc != null && (!best || sc < best.sc || (sc === best.sc && w.length < best.w.length))) best = { t, sc, w };
    }
    return best;
  }
  // A chooser = what a prompt accepts: list = its teams, ph = hint while focused, idle = text while not
  const gameCh = (g) => ({ list: [g.a, g.b], ph: `${g.a.abbr || g.a.short} / ${g.b.abbr || g.b.short}`, idle: "pick_", label: `Type the winner: ${g.a.name} or ${g.b.name}` });
  // attr = data-k="game" (pick a winner) or data-seat="i" (type a seed)
  const typeRow = (attr, c, was = "") => `<div class="br-t br-in"><span class="br-sd">&gt;</span><span class="br-tty">
    <input ${attr} maxlength="24" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next"
      aria-label="${esc(c.label)}"${was ? ` data-was="${esc(was)}"` : ""}><span class="br-gh" aria-hidden="true"></span></span></div>`;
  // The visible text is drawn over the (transparent) input: what you typed, a block cursor, then the rest of the best match in grey.
  function ghost(inp, c) {
    const v = inp.value, on = document.activeElement === inp, m = typedTeam(v, c.list), gh = inp.nextElementSibling;
    inp.closest(".br-t").classList.toggle("ok", !!m);
    if (!v) {
      const ph = inp.dataset.was ? `was ${inp.dataset.was}` : on ? c.ph : c.idle;
      gh.innerHTML = `${on ? `<i class="cur"> </i>` : ""}<span class="gh-h">${esc(ph)}</span>`;
      return m;
    }
    let rest = m && m.sc <= 1 ? m.w.slice(normName(v).length) : "";
    if (/\s$/.test(v)) rest = rest.replace(/^\s/, "");
    const hint = m && (m.sc > 1 || m.w !== normName(m.t.short)) ? ` ${m.t.short}` : "";
    gh.innerHTML = `${esc(v)}${on ? `<i class="cur">${esc(rest[0] || " ")}</i>` : esc(rest[0] || "")}<span class="gh-r">${esc(rest.slice(1))}</span><span class="gh-h">${esc(hint)}</span>`;
    return m;
  }

  // Boxes over an SVG of thin connector lines; the projected champion's path is orange.
  // mine = My picks: the viewer's picks are solid, the model's favorite keeps a small grey win % as a hint.
  // seatCh(i) = My picks: the chooser for seed seat i (an empty seed slot is a prompt; a filled one can be retyped)
  function bracketHtml(root, cols, bw, gap, mine = false, seatCh = null) {
    const all = [];
    (function walk(g) { all.push(g); g.kids.forEach(walk); })(root);
    const X = (c) => c * (bw + gap), W = X(cols.length - 1) + bw, H = HEAD + Math.max(...all.map((g) => g.y)) + BH + 2;
    const champ = root.win?.name;
    const paths = all.flatMap((g) => g.kids.map((k) => {
      const right = k.col < g.col, x1 = X(k.col) + (right ? bw : 0), x2 = X(g.col) + (right ? 0 : bw), mx = (x1 + x2) / 2;
      const y1 = HEAD + k.y + BH / 2, y2 = HEAD + g.y + BH / 2;
      return `<path class="${champ && k.win?.name === champ ? "hot" : ""}" d="M${x1} ${y1}H${mx}V${y2}H${x2}"/>`;
    })).join("");
    const idx = new Map(all.map((g, i) => [g, i]));
    // src = the game whose winner fills this slot (My picks: filled slots can be retyped)
    const row = (s, g, src, seat) => {
      if (!s) return `<div class="br-t"><span class="br-sd"></span><span class="br-n">TBD</span></div>`;
      const won = g.win?.name === s.name, fav = mine ? g.fav?.name === s.name : won, open = mine && g.a && g.b;
      return `<div class="br-t${won ? " win" : ""}${won && s.name === champ ? " hot" : ""}${open ? " pk" : ""}"${open ? ` data-id="${esc(s.id)}" role="button" aria-pressed="${won}"` : ""}${open || src || seat != null ? ` tabindex="0"` : ""}${src ? ` data-src="${idx.get(src)}"` : ""}${seat != null ? ` data-seat="${seat}"` : ""}>
        ${seat != null ? `<span class="br-sd ed" title="Change this seed">${s.seed}</span>` : `<span class="br-sd">${s.seed}</span>`}${img(s.logo, "xs")}<span class="br-n" title="${esc(s.name)}">${esc(s.short)}</span>
        <span class="br-p"${mine ? ` title="Model's win chance"` : ""}>${fav && g.p ? chancePct(g.p) : ""}</span></div>`;
    };
    // My picks: match each slot to the game feeding it. Filled slots match by team; empty ones take the leftover games in order
    // (NFL Divisional slots before reseeding just follow the Wild Card games in order until all three are picked).
    const slot = (g, k) => {
      if (!mine) return row(g[k], g);
      const seat = g["s" + k];
      if (seatCh && seat != null) return g[k] ? row(g[k], g, null, seat) : typeRow(`data-seat="${seat}"`, seatCh(seat));
      const used = g.kids.filter((x) => x.win && [g.a, g.b].some((s) => s && String(s.id) === String(x.win.id)));
      const src = g[k] ? used.find((x) => String(x.win.id) === String(g[k].id)) : g.kids.filter((x) => !used.includes(x))[k === "b" && !g.a && g.sa == null ? 1 : 0];
      if (g[k] || src?.win) return row(g[k] || src.win, g, src); // (a Wild Card pick waiting on the reseed shows in its slot)
      return src?.a && src?.b ? typeRow(`data-k="${idx.get(src)}"`, gameCh(src)) : row(null, g);
    };
    return `<div class="br-scroll"><div class="br${mine ? " mine" : ""}" style="width:${W}px;height:${H}px">
      <svg width="${W}" height="${H}" aria-hidden="true">${paths}</svg>
      ${cols.map((c, i) => `<div class="br-h" style="left:${X(i)}px;width:${bw}px">${esc(c)}</div>`).join("")}
      ${all.map((g, i) => `<div class="br-m${g.a?.proj || g.b?.proj ? " proj" : ""}${g === root ? " final" : ""}" data-i="${i}"${mine ? "" : ` tabindex="0"`}
        style="left:${X(g.col)}px;top:${HEAD + g.y}px;width:${bw}px">${slot(g, "a")}${slot(g, "b")}</div>`).join("")}
      <div class="cc-tip"></div></div></div>`;
  }
  // Model's picks: hover (or tap) a game for both teams and the model's line. The box sits beside the game, never on it.
  // My picks: no hover box (the win % is inline and the chances box lists your picks); tapping a team picks it
  // (onPick(game, teamId, how)), and seats = { ch(i), set(i, teamId, how) } handles the typed seeds.
  function wireBracket(root, onPick, seats) {
    const el = $("#view-standings .br");
    if (!el) return;
    const all = [];
    (function walk(g) { all.push(g); g.kids.forEach(walk); })(root);
    const tip = el.querySelector(".cc-tip"), card = el.closest(".card");
    const who = (s) => (s ? `<span>#${s.seed} ${esc(s.name)}${s.rank ? ` · our #${s.rank}` : ""}${s.record ? ` · ${esc(s.record)}` : ""}${s.proj ? " · projected" : ""}</span>` : `<span>TBD</span>`);
    const show = (b) => {
      const g = all[+b.dataset.i], f = g.win; // the model's favorite
      const where = g.home && g.a ? `at ${esc(g.a.short)}` : "neutral site";
      tip.innerHTML = `<small>${esc(g.label)} · ${where}</small>` + (f ? `<b>${esc(f.short)} <em>${chancePct(g.p)} · by ${Math.abs(g.spread).toFixed(1)}</em></b>` : `<b>TBD</b>`) + who(g.a) + who(g.b);
      // beside the box (its right on the left half, its left on the right half), never on it: slide up or down from level
      // with the game to the spot that covers the least of the other games (usually none). It lives in the card, not the
      // scrolling bracket, so it can also use the space above and below the bracket.
      tip.className = "cc-tip br-tip";
      tip.style.transform = "none";
      const cr = card.getBoundingClientRect(), rel = (m) => { const r = m.getBoundingClientRect(); return [r.left - cr.left, r.top - cr.top, r.right - cr.left, r.bottom - cr.top]; };
      const tw = Math.min(tip.offsetWidth, cr.width), th = tip.offsetHeight, W = cr.width, H = cr.height, [bl, bt, br, bb] = rel(b);
      const boxes = [...el.querySelectorAll(".br-m")].map(rel);
      const clampX = (x) => Math.max(0, Math.min(x, W - tw)), cy = (bt + bb) / 2 - th / 2;
      const xs = [...((bl + br) / 2 < W / 2 ? [br + 8, bl - 8 - tw] : [bl - 8 - tw, br + 8]).filter((x) => x >= 0 && x + tw <= W), clampX((bl + br) / 2 - tw / 2)];
      let best = null;
      for (const x of xs) {
        for (let k = 0; k <= H / 4 && best?.o !== 0; k++) {
          const y = Math.max(0, Math.min(cy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8, H - th));
          const o = boxes.reduce((s, [l, t, r, btm]) => s + Math.max(0, Math.min(r, x + tw) - Math.max(l, x)) * Math.max(0, Math.min(btm, y + th) - Math.max(t, y)), 0);
          if (!best || o < best.o) best = { x, y, o };
        }
        if (best.o === 0) break;
      }
      tip.style.left = `${best.x}px`; tip.style.top = `${best.y}px`;
      tip.classList.add("on");
    };
    const hide = () => tip.classList.remove("on");
    if (!onPick) {
      card.appendChild(tip);
      el.onpointerover = (e) => { const b = e.target.closest(".br-m"); if (b && e.pointerType === "mouse") show(b); };
      el.onpointerleave = hide;
      // touch: a tap on a game opens it; the next tap anywhere closes it (see the page-wide pointerdown below)
      el.onclick = (e) => { const b = e.target.closest(".br-m"); if (b && !tipWasOn) show(b); };
      el.addEventListener("focusin", (e) => { const b = e.target.closest(".br-m"); if (b && e.target.matches(":focus-visible")) show(b); });
      return;
    }
    const chOf = (inp) => (inp.dataset.seat != null ? seats.ch(+inp.dataset.seat) : gameCh(all[+inp.dataset.k]));
    // Tapping your current pick again clears it (its next slot turns back into a prompt)
    const pickAt = (t) => { const pressed = t.getAttribute("aria-pressed") === "true"; onPick(all[+t.closest(".br-m").dataset.i], pressed ? "" : t.dataset.id, pressed ? "clear" : "click"); };
    // Retype a filled slot (a winner, or a seed): swap the row for a prompt; leaving it empty puts the team back
    const retype = (t, ch = "") => {
      const seat = t.dataset.seat, src = seat == null && all[+t.dataset.src];
      if (src && (!src.a || !src.b)) return;
      const old = t.outerHTML, box = document.createElement("div");
      box.innerHTML = seat != null ? typeRow(`data-seat="${seat}"`, seats.ch(+seat), t.querySelector(".br-n").textContent)
        : typeRow(`data-k="${t.dataset.src}"`, gameCh(src), t.querySelector(".br-n").textContent);
      const r = box.firstElementChild, inp = r.querySelector("input");
      r.dataset.old = old;
      t.replaceWith(r);
      inp.value = ch; inp.focus(); ghost(inp, chOf(inp));
    };
    el.onclick = (e) => {
      if (e.target.closest(".br-in")) return e.target.closest(".br-in").querySelector("input").focus();
      const sd = e.target.closest(".br-sd.ed"); // the seed number of a typed seed: retype that seed
      if (sd) return retype(sd.closest(".br-t"));
      const t = e.target.closest(".br-t.pk");
      if (t) return pickAt(t);
      const r = e.target.closest(".br-t[data-src], .br-t[data-seat]"); // a filled slot you can't pick from yet (the other slot is empty)
      if (r) return retype(r);
    };
    el.onkeydown = (e) => {
      const inp = e.target.closest(".br-in input");
      if (inp) {
        const c = chOf(inp), seat = inp.dataset.seat;
        if ((e.key === "Enter" || (e.key === "Tab" && !e.shiftKey && inp.value)) && !e.isComposing) {
          const m = typedTeam(inp.value, c.list);
          if (m) { e.preventDefault(); return seat != null ? seats.set(+seat, String(m.t.id), "typed") : onPick(all[+inp.dataset.k], String(m.t.id), "typed"); }
          if (e.key === "Enter" && seat != null && inp.dataset.was && !inp.value) { e.preventDefault(); return seats.set(+seat, "", "clear"); } // Enter on an emptied seed clears it
          if (e.key === "Enter") { e.preventDefault(); const r = inp.closest(".br-t"); r.classList.remove("no"); void r.offsetWidth; r.classList.add("no"); }
        }
        if (e.key === "Escape") { e.preventDefault(); if (inp.value) { inp.value = ""; ghost(inp, c); } else inp.blur(); }
        return;
      }
      const t = e.target.closest(".br-t.pk");
      if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return pickAt(t); }
      const r = e.target.closest(".br-t[data-src], .br-t[data-seat]"); // start typing (or Backspace) on a filled slot to retype it
      if (r && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "Backspace" || /^[a-z0-9&.' -]$/i.test(e.key) && e.key !== " ")) {
        e.preventDefault(); retype(r, e.key === "Backspace" ? "" : e.key);
      }
    };
    el.oninput = (e) => { const inp = e.target.closest(".br-in input"); if (inp) ghost(inp, chOf(inp)); };
    // (no onfocusin/onfocusout properties in Chrome; el is rebuilt on every draw, so listeners never pile up)
    el.addEventListener("focusin", (e) => { const inp = e.target.closest(".br-in input"); if (inp) ghost(inp, chOf(inp)); });
    el.addEventListener("focusout", (e) => {
      const inp = e.target.closest(".br-in input");
      if (!inp) return;
      const r = inp.closest(".br-t");
      if (r.dataset.old && r.isConnected) r.outerHTML = r.dataset.old; // retype left without Enter/Tab: put the team back
      else if (r.isConnected) ghost(inp, chOf(inp));
    });
    el.querySelectorAll(".br-in input").forEach((inp) => ghost(inp, chOf(inp)));
  }
  // The bracket's hover box closes on any press or scroll anywhere (one page-wide listener, added once).
  // tipWasOn lets the press that closed it skip reopening it, so "next tap anywhere closes it" holds on phones.
  let tipWasOn = false;
  const hideBrTip = () => { const t = document.querySelector(".cc-tip.br-tip.on"); tipWasOn = !!t; t?.classList.remove("on"); };
  document.addEventListener("pointerdown", hideBrTip, true);
  document.addEventListener("scroll", () => document.querySelector(".cc-tip.br-tip.on")?.classList.remove("on"), { capture: true, passive: true });

  // My picks travel in the URL as each game's winner (ESPN team id in base 36), games in build order, e.g. &picks=1j.8..2t
  const encPicks = (ids) => ids.map((id) => (id ? (+id).toString(36) : "")).join(".").replace(/\.+$/, "");
  const decPicks = (str) => (/^[0-9a-z.]{1,300}$/.test(str || "") ? str.split(".").map((x) => (x ? String(parseInt(x, 36)) : "")) : []);

  // ---- My picks chances: a Monte Carlo of the rest of the season, then the playoffs, from our power ratings.
  // Current records + the remaining regular-season schedule come from ESPN's weekly scoreboards; each remaining game
  // is a coin weighted by our model's win chance (same spread math as above). Then seed the field and play the bracket.
  const SIM_N = 5000, SIMS = new Map(); // `${lg}-${season}-${week}` -> Promise of the results (kept for the visit)
  function simOdds(lg, ranks, d) {
    const info = INDEX.leagues[lg].latest, key = `${lg}-${info.season}-${info.week}`;
    if (!SIMS.has(key)) SIMS.set(key, runSims(lg, info.season, ranks, d).catch((e) => { SIMS.delete(key); throw e; }));
    return SIMS.get(key);
  }
  async function runSims(lg, season, ranks, d) {
    const nfl = lg === "nfl", m = GAME[lg], T = [], at = new Map(); // T = every team we simulate; at = ESPN id -> index in T
    const add = (id, rating, conf, div, name) => { at.set(String(id), T.length); T.push({ id: String(id), rating: rating ?? 0, conf, div, name }); };
    if (nfl) (d.children || []).forEach((c) => groupsOf(c).forEach((g) => g.entries.forEach((e) =>
      add(e.team.id, ranks.byName.get(e.team.displayName)?.rating, c.abbreviation, g.name, e.team.displayName))));
    else ranks.byId.forEach((t) => add(t.id, t.rating, t.conference, null, t.team));
    const fcs = new Map((ranks.data.fcs_ratings || []).map(([n, r]) => [normName(n), r])); // CFB: FCS opponents' ratings
    const weeks = nfl ? 18 : 15, q = nfl ? "" : "groups=80&limit=300&";
    const t0 = performance.now();
    const boards = await Promise.all(Array.from({ length: weeks }, (_, i) =>
      api(`${SITE(lg)}/scoreboard?${q}seasontype=2&week=${i + 1}&dates=${season}`, 1800000).catch(() => null)));
    if (boards.filter(Boolean).length < weeks - 2) throw new Error("schedule unavailable");
    const W0 = new Float64Array(T.length), L0 = new Float64Array(T.length), G = [], seen = new Set();
    boards.forEach((sb) => (sb?.events || []).forEach((ev) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      const c = ev.competitions?.[0], h = c?.competitors?.find((x) => x.homeAway === "home"), a = c?.competitors?.find((x) => x.homeAway === "away");
      if (!h || !a) return;
      const hi = at.get(String(h.team?.id)), ai = at.get(String(a.team?.id)), st = ev.status?.type || {};
      if (hi == null && ai == null) return;
      if (st.state === "post") { // played: count it (only the teams we track); canceled/postponed games don't count
        if (!st.completed || /cancel|postpone/i.test(st.name || "")) return;
        const res = h.winner ? [1, 0] : a.winner ? [0, 1] : [0.5, 0.5];
        [[hi, res[0]], [ai, res[1]]].forEach(([i, w]) => { if (i != null) { W0[i] += w; L0[i] += 1 - w; } });
        return;
      }
      // still to play. CFB: an opponent we don't track is FCS (its rating if we have one); skip TBD placeholders
      const out = (x) => !x.team?.location || /tbd/i.test(x.team.displayName || "");
      if (nfl ? hi == null || ai == null : out(h) || out(a)) return;
      const r = (x, i) => (i != null ? T[i].rating : fcs.get(normName(x.team.location)) ?? -18);
      G.push([hi ?? -1, ai ?? -1, phi(((r(h, hi) - r(a, ai)) + (c.neutralSite ? 0 : m.hfa)) * m.scale / m.sigma)]);
    }));
    const tFetch = performance.now() - t0;

    // P(i beats j), home = i hosts
    const pw = (i, j, home) => phi(((T[i].rating - T[j].rating) + (home ? m.hfa : 0)) * m.scale / m.sigma);
    const play = (i, j, home) => (Math.random() < pw(i, j, home) ? i : j);
    const n = T.length, W = new Float64Array(n), L = new Float64Array(n), key = new Float64Array(n);
    const seedCount = new Uint32Array(n * 13), title = new Uint32Array(n);
    // NFL: conference -> its divisions (team indexes)
    const confs = nfl ? ["AFC", "NFC"].map((cf) => {
      const divs = new Map();
      T.forEach((t, i) => { if (t.conf === cf) { if (!divs.has(t.div)) divs.set(t.div, []); divs.get(t.div).push(i); } });
      return { all: T.map((t, i) => (t.conf === cf ? i : -1)).filter((i) => i >= 0), divs: [...divs.values()] };
    }) : null;
    const P4 = ["SEC", "Big Ten", "Big 12", "ACC"], ND = T.findIndex((t) => t.name === "Notre Dame");
    const byKey = (x, y) => key[y] - key[x];

    const one = () => {
      W.set(W0); L.set(L0);
      for (const [h, a, p] of G) {
        const hw = Math.random() < p;
        if (h >= 0) { if (hw) W[h]++; else L[h]++; }
        if (a >= 0) { if (hw) L[a]++; else W[a]++; }
      }
      if (nfl) {
        // seeds: 4 division winners by record (1-4), then the 3 best other records (5-7); ties = coin flip
        for (let i = 0; i < n; i++) key[i] = W[i] / (W[i] + L[i] || 1) + Math.random() * 1e-6;
        const champs = [];
        for (const cf of confs) {
          const wins = cf.divs.map((dv) => dv.reduce((x, y) => (key[y] > key[x] ? y : x))).sort(byKey);
          const s = [...wins, ...cf.all.filter((i) => !wins.includes(i)).sort(byKey).slice(0, 3)];
          s.forEach((i, k) => seedCount[i * 13 + k + 1]++);
          // 2v7, 3v6, 4v5 at the better seed; then the 1 seed hosts the lowest seed left; then the better seed hosts
          const wc = [[1, 6], [2, 5], [3, 4]].map(([x, y]) => (play(s[x], s[y], true) === s[x] ? x : y)).sort((x, y) => x - y);
          const d1 = play(s[0], s[wc[2]], true) === s[0] ? 0 : wc[2], d2 = play(s[wc[0]], s[wc[1]], true) === s[wc[0]] ? wc[0] : wc[1];
          const [hi, lo] = d1 < d2 ? [d1, d2] : [d2, d1];
          champs.push(play(s[hi], s[lo], true));
        }
        title[play(champs[0], champs[1], false)]++;
      } else {
        // résumé proxy: our rating + 3 points per game over .500. Champion = best record in the conference (ties: résumé).
        for (let i = 0; i < n; i++) key[i] = T[i].rating + 3 * (W[i] - L[i]);
        const best = new Map();
        T.forEach((t, i) => {
          if (!t.conf || /independent/i.test(t.conf)) return;
          const b = best.get(t.conf), pct = (x) => W[x] / (W[x] + L[x] || 1);
          if (b == null || pct(i) > pct(b) || (pct(i) === pct(b) && key[i] > key[b])) best.set(t.conf, i);
        });
        const order = T.map((_, i) => i).sort(byKey);
        const auto = P4.map((c) => best.get(c)).filter((i) => i != null);
        const g6 = [...best].filter(([c]) => !P4.includes(c)).map(([, i]) => i).sort(byKey)[0];
        if (g6 != null) auto.push(g6);
        const field = new Set(auto);
        if (ND >= 0 && order.indexOf(ND) < 12) field.add(ND);
        for (const i of order) { if (field.size >= 12) break; field.add(i); }
        const s = [...field].sort(byKey);
        s.forEach((i, k) => seedCount[i * 13 + k + 1]++);
        const fr = [[7, 8], [4, 11], [6, 9], [5, 10]].map(([x, y]) => play(s[x], s[y], true));
        const qf = [0, 3, 1, 2].map((x, k) => play(s[x], fr[k], false));
        title[play(play(qf[0], qf[1], false), play(qf[2], qf[3], false), false)]++;
      }
    };
    const t1 = performance.now();
    for (let k = 0; k < SIM_N; k += 250) { // in chunks, so the page never freezes
      for (let j = 0; j < 250; j++) one();
      await new Promise((r) => setTimeout(r));
    }
    const ms = performance.now() - t1;
    const idx = (id) => at.get(String(id));
    return {
      n: SIM_N, games: G.length, fetchMs: Math.round(tFetch), simMs: Math.round(ms),
      seedP: (id, seed) => (idx(id) == null ? 0 : seedCount[idx(id) * 13 + seed] / SIM_N),
      titleP: (id) => (idx(id) == null ? 0 : title[idx(id)] / SIM_N),
    };
  }
  // "1 in 4,210" / "1 in 3.1 million"; and a percent that never rounds a real chance down to 0
  function oneIn(p) {
    const x = 1 / p;
    if (x < 1e6) return `1 in ${Math.round(x).toLocaleString("en-US")}`;
    const [v, w] = x < 1e9 ? [x / 1e6, "million"] : x < 1e12 ? [x / 1e9, "billion"] : x < 1e15 ? [x / 1e12, "trillion"] : [x / 1e15, "quadrillion"];
    return x >= 1e18 ? `1 in ${x.toExponential(1).replace("e+", "×10^")}` : `1 in ${v < 10 ? v.toFixed(1) : Math.round(v)} ${w}`;
  }
  const pctTxt = (p) => (p >= 0.1 ? `${Math.min(99.9, p * 100).toFixed(1)}%` : p >= 1e-4 ? `${(p * 100).toPrecision(2)}%` : `${(p * 100).toExponential(1)}%`);

  // ---- Save Image: the bracket drawn straight onto a canvas, 1600x900 (Twitter's size) at 2x, in the site's dark terminal look
  const loadImg = (src) => new Promise((ok) => {
    if (!src) return ok(null);
    const im = new Image(), t = setTimeout(() => ok(null), 6000);
    im.crossOrigin = "anonymous"; // ESPN's logo CDN allows it, so the canvas stays exportable
    im.onload = () => { clearTimeout(t); ok(im); };
    im.onerror = () => { clearTimeout(t); ok(null); };
    im.src = src;
  });
  // o = { title, sub, stats: [[label, value]], foot }
  async function bracketPng(root, cols, o) {
    const Wd = 1600, Ht = 900, S = 2, C = { bg: "#0f1216", card: "#171b21", ink: "#e8eaed", muted: "#9aa3af", line: "#262c35", accent: "#ff7a3d" };
    const all = [];
    (function walk(g) { all.push(g); g.kids.forEach(walk); })(root);
    const teams = new Map();
    all.forEach((g) => [g.a, g.b].forEach((t) => t && teams.set(String(t.id), t)));
    const [logos, mark] = await Promise.all([
      Promise.all([...teams.values()].map((t) => loadImg(thumb(t.logo, 40)).then((im) => [String(t.id), im]))).then((x) => new Map(x)),
      loadImg("favicon.svg"),
      document.fonts.ready.then(() => Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "JetBrains Mono"`)))).catch(() => {}),
    ]);
    const F = (w, px) => `${w} ${px}px "JetBrains Mono", ui-monospace, monospace`;
    const paint = (withLogos) => {
      const cv = document.createElement("canvas");
      cv.width = Wd * S; cv.height = Ht * S;
      const x = cv.getContext("2d");
      x.scale(S, S);
      const fit = (s, w) => { s = String(s); while (s.length > 2 && x.measureText(s).width > w) s = s.slice(0, -2) + "…"; return s; };
      const text = (s, px, py, font, color, align = "left", maxW = 9999) => { x.font = font; x.fillStyle = color; x.textAlign = align; x.fillText(fit(s, maxW), px, py); };
      x.fillStyle = C.bg; x.fillRect(0, 0, Wd, Ht);
      x.textBaseline = "alphabetic";
      text(`> ${o.title}`, 48, 78, F(700, 40), C.accent);
      text(o.sub, 48, 116, F(400, 20), C.ink, "left", 1100);

      // the bracket: same tree and layout as the page, scaled into the left 1150px
      const ax = 48, ay = 150, aw = 1150, ah = 700, n = cols.length, gap = n > 4 ? 18 : 44;
      const bw = (aw - gap * (n - 1)) / n, bh = n > 4 ? 72 : 62;
      const ys = all.map((g) => g.y), y0 = Math.min(...ys), span = Math.max(...ys) - y0 || 1;
      const k = Math.min((ah - 30 - bh) / span, (bh + 100) / (BH + VGAP)), used = span * k + bh, top = ay + 30 + (ah - 30 - used) / 2;
      const X = (c) => ax + c * (bw + gap), Y = (g) => top + (g.y - y0) * k;
      cols.forEach((c, i) => text(c.toUpperCase(), X(i), top - 14, F(700, 11), C.muted, "left", bw));
      const champ = root.win && String(root.win.id);
      all.forEach((g) => g.kids.forEach((kd) => {
        const right = kd.col < g.col, x1 = X(kd.col) + (right ? bw : 0), x2 = X(g.col) + (right ? 0 : bw), mx = (x1 + x2) / 2;
        const y1 = Y(kd) + bh / 2, y2 = Y(g) + bh / 2, hot = champ && kd.win && String(kd.win.id) === champ;
        x.strokeStyle = hot ? C.accent : C.line; x.lineWidth = hot ? 2.5 : 1.5;
        x.beginPath(); x.moveTo(x1, y1); x.lineTo(mx, y1); x.lineTo(mx, y2); x.lineTo(x2, y2); x.stroke();
      }));
      x.textBaseline = "middle";
      all.forEach((g) => {
        const gx = X(g.col), gy = Y(g), fin = g === root;
        x.fillStyle = C.card; x.fillRect(gx, gy, bw, bh);
        x.strokeStyle = C.line; x.lineWidth = 1;
        x.beginPath(); x.moveTo(gx, gy + bh / 2); x.lineTo(gx + bw, gy + bh / 2); x.stroke();
        x.strokeStyle = fin ? C.accent : C.line; x.lineWidth = fin ? 2 : 1; x.strokeRect(gx + 0.5, gy + 0.5, bw - 1, bh - 1);
        [g.a, g.b].forEach((t, r) => {
          const mid = gy + (r + 0.5) * bh / 2, lx = gx + 28, ls = 22;
          if (!t) return text("TBD", lx, mid, F(400, 14), C.muted);
          const won = g.win && String(g.win.id) === String(t.id), hot = won && String(t.id) === champ;
          text(String(t.seed), gx + 20, mid, F(400, 12), C.muted, "right");
          const im = withLogos && logos.get(String(t.id));
          if (im) x.drawImage(im, lx, mid - ls / 2, ls, ls);
          else text(String(t.abbr || t.short).slice(0, 4).toUpperCase(), lx + ls / 2, mid, F(700, 9), C.muted, "center"); // logo didn't load
          if (hot) { x.fillStyle = C.accent; x.fillRect(gx, mid - bh / 4 + 1, 3, bh / 2 - 2); }
          text(t.short, lx + ls + 8, mid, F(won ? 700 : 400, n > 4 ? 14 : 16), hot ? C.accent : won ? C.ink : C.muted, "left", gx + bw - lx - ls - 14);
        });
      });

      // the chances panel
      const px = 1232, py = 150, pw = 320;
      x.textBaseline = "alphabetic";
      x.fillStyle = C.card; x.fillRect(px, py, pw, 470);
      x.strokeStyle = C.line; x.lineWidth = 1; x.strokeRect(px + 0.5, py + 0.5, pw - 1, 469);
      text("> CHANCES", px + 20, py + 36, F(700, 16), C.accent);
      o.stats.forEach(([l, v], i) => {
        const sy = py + 80 + i * 92;
        text(l.toUpperCase(), px + 20, sy, F(400, 12), C.muted, "left", pw - 40);
        text(v, px + 20, sy + 36, F(700, i < 2 ? 30 : 22), i === 0 ? C.accent : C.ink, "left", pw - 40);
      });
      x.font = F(400, 11);
      o.foot.split(" ").reduce((ls, w) => { const l = ls[ls.length - 1]; if (l && x.measureText(`${l} ${w}`).width <= pw - 40) ls[ls.length - 1] = `${l} ${w}`; else ls.push(w); return ls; }, [])
        .forEach((l, i, a) => text(l, px + 20, py + 452 - (a.length - 1 - i) * 16, F(400, 11), C.muted));
      // watermark: the cupcake mark + the address, bottom right
      text("cupcakeindex.com", Wd - 48, Ht - 40, F(400, 16), C.muted, "right");
      x.font = F(400, 16);
      if (mark) { x.globalAlpha = 0.85; x.drawImage(mark, Wd - 48 - x.measureText("cupcakeindex.com").width - 38, Ht - 40 - 21, 28, 28); x.globalAlpha = 1; }
      return cv;
    };
    const blob = (cv) => new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("no image"))), "image/png"));
    try { return await blob(paint(true)); }
    catch { return blob(paint(false)); } // a logo without CORS "taints" the canvas so it can't export: redraw without logos
  }

  async function playoff(lg, my, params) {
    loading("standings");
    const nfl = lg === "nfl", mine = params.get("mode") === "mine" || params.has("picks");
    let d, ranks;
    try {
      [d, ranks] = await Promise.all([nfl ? api(`${STAND(lg)}/standings?level=3`, 300000) : null, modelRanks(lg)]);
    } catch (e) { return fail("standings", e); }
    if (my !== token) return;
    const modes = `<div class="presets br-mode" id="br-mode">${[["", "Model's picks"], ["mine", "My picks"]].map(([m, l]) =>
      `<button data-mode="${m}" class="${!m === !mine ? "on" : ""}">${l}</button>`).join("")}</div>`;
    const out = (html) => {
      view("standings").innerHTML = stSub(true) + `<p class="muted br-cav">Current picture — changes weekly.</p>` + modes + html;
      $("#br-mode").onclick = (e) => {
        const m = e.target.dataset?.mode;
        if (m != null) location.hash = link("standings", null, m ? { show: "playoff", mode: m } : { show: "playoff" });
      };
    };
    if (!ranks) return out(`<div class="card muted">Couldn't load our rankings. Try refreshing.</div>`);
    const pick = (g) => (g.win ? `<p class="br-pick">Model's pick to win it all: <b class="tm">${img(g.win.logo, "xs")} ${esc(g.win.name)}</b>
      <span class="muted">(${chancePct(g.p)} in the ${nfl ? "Super Bowl" : "title game"})</span></p>` : "");
    const key = `<p class="note">Dashed boxes are projections: each game goes to our model's favorite (win % beside it). Orange line = the projected champion's path. Hover or tap a game for details.</p>`;
    const keyMine = `<p class="note">Start blank: type each seed at its <b class="br-gt">&gt;</b> prompt (${nfl ? "seven per conference, AFC teams on the AFC side" : "any 12 FBS teams"}), then pick every game by tapping a team or typing it.
      Enter or Tab takes the match and jumps to the next prompt; Esc clears. Tap a seed number to change that seed; tap your pick again to undo it.${nfl ? " The Divisional round reseeds from your Wild Card winners." : ""}
      Changing a seed or pick clears later picks that depended on it. Grey % = our model's win chance for its favorite. Orange line = your champion's path.</p>
      <p class="note">How the chances work: each remaining regular-season game is simulated with our power ratings (same win-chance math as our picks), then the field is seeded
      (${nfl ? "4 division winners seeded 1–4 by record, then the 3 best other records" : "auto bids for the 4 power-conference champions and the best Group of 6 champion, Notre Dame if top 12, then at-large; conference champion = best record, résumé = our rating + 3 points per game over .500"};
      ties are coin flips) and the playoffs are played out. Your field's chance multiplies each team's chance of landing exactly that seed, as if seeds were independent,
      so treat it as a rough estimate. Your games use each matchup's win chance (higher seed at home${nfl ? "; Super Bowl neutral" : "; first round only"}).</p>`;

    // Both leagues build the whole bracket in one go (rebuilt after every pick in My picks).
    // NFL: every team, with its conference and today's seed (ESPN's seeds if the season ended today)
    const nflTeams = () => (d.children || []).flatMap((c) => groupsOf(c).flatMap((g) => g.entries).map((e) => {
      const o = ourTeam(ranks, "nfl", e.team);
      return { name: e.team.displayName, short: e.team.shortDisplayName || e.team.displayName, logo: teamLogo(e.team), id: String(e.team.id), abbr: e.team.abbreviation,
        loc: e.team.location, mascot: e.team.name, conf: c.abbreviation, now: statNum(e, "playoffseed"), rank: o?.rank, record: stat(e, "total"), rating: o?.rating };
    }));
    const slotsOf = (abbr) => {
      const s = nflTeams().filter((t) => t.conf === abbr && t.now >= 1 && t.now <= 7).map((t) => ({ ...t, seed: t.now }));
      return s.length === 7 ? s : null;
    };
    // seated = My picks: seat i -> the team typed there (NFL seats 0-6 = AFC seeds 1-7, 7-13 = NFC; CFB seats 0-11)
    const build = (seated = null) => {
      if (!nfl) return cfpBracket(ranks, seated);
      const [as, ns] = seated ? [0, 7].map((o) => Array.from({ length: 7 }, (_, i) => seated(o + i))) : [slotsOf("AFC"), slotsOf("NFC")];
      if (!as || !ns) return null;
      const afc = nflSide(as, [0, 1, 2], "AFC", 0), nfc = nflSide(ns, [6, 5, 4], "NFC", 7);
      const root = bGame("nfl", afc.win, nfc.win, 3, "Super Bowl", false, [afc, nfc]);
      root.y = (afc.y + nfc.y) / 2;
      return { root, cols: ["AFC Wild Card", "AFC Divisional", "AFC Championship", "Super Bowl", "NFC Championship", "NFC Divisional", "NFC Wild Card"] };
    };
    const [title, bw, gap] = nfl ? ["Super Bowl bracket", 150, 22] : ["CFP projection", 196, 36];
    BH = mine ? 78 : 56;
    const b0 = build(); // today's picture
    if (!b0 && !mine) return out(`<div class="card muted">ESPN hasn't posted playoff seeds yet.</div>`);
    const table = nfl || !b0 ? "" : `<div class="card"><h3>The field</h3><div class="table-wrap"><table class="standings"><thead><tr>
        <th class="num">Seed</th><th>Team</th><th class="num" title="Cupcake Index rank">Our #</th><th class="num">REC</th><th>Bid</th></tr></thead><tbody>
        ${b0.field.map((s) => `<tr><td class="num">${s.seed}</td>
          <td><a href="${link("team", s.id)}"><span class="tm">${img(s.logo, "xs")} <span class="tn">${esc(s.name)}</span></span></a></td>
          <td class="num"><a class="our-rk" href="${link("rankings", null, { team: s.name })}">#${s.rank}</a></td><td class="num">${esc(s.record)}</td>
          <td>${s.auto ? `<span class="tag">champ</span> <span class="muted">${esc(s.conf)}</span>` : `<span class="muted">at-large</span>`}${s.seed <= 4 ? ` <span class="muted">· bye</span>` : ""}</td></tr>`).join("")}
        </tbody></table></div></div>`;
    const notes = nfl ? `<p class="note">Seeds are ESPN's playoff seeds if the season ended today (the same as the Seed column in Standings); each #1 seed gets a bye.
      The Divisional round reseeds, so the 1 seed hosts the lowest seed left. Higher seed hosts; the Super Bowl is neutral.</p>`
      : `<p class="note">Projection using the 2026 12-team format and our rankings: the four power-conference champions and the top Group of 6 champion
        get automatic bids (Notre Dame too if it's in our top 12), then seven at-large teams. Seeds are straight by rank, so seeds 1–4 get byes.
        Projected conference champion = that conference's highest-ranked team in our rankings. First-round games at the higher seed, later rounds on neutral sites.</p>`;

    if (!mine) {
      out(`<div class="card"><h3>${title}</h3>${pick(b0.root)}${bracketHtml(b0.root, b0.cols, bw, gap)}${key}</div>${table}${notes}`);
      return wireBracket(b0.root);
    }

    // My picks: a blank bracket. You type every seed (who gets in, and where), then pick every game.
    // Seeds and picks travel in the URL (&seeds=, &picks=) and are saved in this browser.
    const season = INDEX.leagues[lg].latest.season, saveKey = `bracket-${lg}-${season}`, seedKey = `bracketSeeds-${lg}-${season}`;
    const nSeat = nfl ? 14 : 12, seatConf = (i) => (nfl ? (i < 7 ? "AFC" : "NFC") : ""), seatSeed = (i) => (nfl ? i % 7 : i) + 1;
    const pool = new Map((nfl ? nflTeams() : [...ranks.byId.values()].map(cfbTeam)).map((t) => [t.id, t])); // every team you can seed
    const current = () => Array.from({ length: nSeat }, (_, i) => (nfl ? [...pool.values()].find((t) => t.conf === seatConf(i) && t.now === seatSeed(i))?.id : b0?.field[i]?.id) || "");
    const fromUrl = params.has("seeds") || params.has("picks"), savedSeeds = fromUrl ? params.get("seeds") : store.get(seedKey);
    const ids = decPicks(fromUrl ? params.get("picks") : store.get(saveKey));
    // links and saves from before blank brackets carried only picks, made on that day's seeds
    const raw = savedSeeds == null && ids.length ? current() : decPicks(savedSeeds);
    // keep real teams only, in the right conference, once each
    const seats = Array.from({ length: nSeat }, (_, i) => raw[i] || "").map((id, i, a) => {
      const t = pool.get(id);
      return t && (!nfl || t.conf === seatConf(i)) && a.indexOf(id) === i ? id : "";
    });
    const seated = (i) => { const t = pool.get(seats[i]); return t ? { ...t, seed: seatSeed(i) } : null; };
    // What a seed prompt accepts: teams not seeded elsewhere (NFL: that conference only); better-ranked teams win ties
    const seatCh = (i) => {
      const taken = new Set(seats.filter((x, j) => x && j !== i)), nm = `${nfl ? seatConf(i) + " " : ""}${seatSeed(i)} seed`;
      const list = [...pool.values()].filter((t) => !taken.has(t.id) && (!nfl || t.conf === seatConf(i))).sort((x, y) => (x.rank || 999) - (y.rank || 999));
      return { list, ph: "type a team", idle: `${nm}_`, label: `Type the ${nm}` };
    };

    out(`<div class="card" id="br-card"></div>${table}${notes}`);
    const card = $("#br-card");
    // Remember the bracket (this browser only) and keep it in the URL, so the address bar is always a shareable link
    const save = () => {
      const s = encPicks(seats), p = encPicks(ids);
      store.set(seedKey, s); store.set(saveKey, p);
      history.replaceState(null, "", link("standings", null, { show: "playoff", mode: "mine", ...(s ? { seeds: s } : {}), ...(p ? { picks: p } : {}) }));
    };

    // ---- the chances box (season sims run once per visit; until they finish, sim-based numbers say "simulating…")
    let odds = null, oddsErr = false, cur = null;
    const ab = (t) => t.abbr || TEAMX.get(String(t.id))?.abbreviation || t.short;
    const oddsNums = (b) => {
      const all = [];
      (function walk(g) { all.push(g); g.kids.forEach(walk); })(b.root);
      // each pick's win chance = the model's chance for the team you picked, in that matchup
      const picked = all.filter((g) => g.win && g.a && g.b && g.fav).map((g) => ({ g, p: String(g.win.id) === String(g.fav.id) ? g.p : 1 - g.p,
        w: g.win, l: String(g.win.id) === String(g.a.id) ? g.b : g.a }));
      const c = b.root.win, open = all.filter((g) => !g.win).length, empty = seats.filter((x) => !x).length;
      const pGames = picked.reduce((x, y) => x * y.p, 1), path = c ? picked.filter((x) => String(x.w.id) === String(c.id)).reduce((x, y) => x * y.p, 1) : null;
      // P(field as typed) ~ product of each team's chance of getting exactly that seed (as if seeds were independent);
      // a seed no sim produced counts as 1/N, so the total is an upper bound ("less than")
      let pField = 1, under = false;
      if (odds) seats.forEach((id, i) => { if (!id) return; let p = odds.seedP(id, seatSeed(i)); if (!p) { p = 1 / odds.n; under = true; } pField *= p; });
      return { picked: picked.sort((x, y) => x.p - y.p), c, open, empty, pGames, path, pField, under, done: !open && !empty, title: c && odds ? odds.titleP(c.id) : null };
    };
    const oddsHtml = (b) => {
      const o = oddsNums(b), wait = `<span class="muted">${oddsErr ? "couldn't load the schedule" : "simulating…"}</span>`;
      const row = (l, v, cls = "") => `<div class="bo-r${cls}"><span>${l}</span><b>${v}</b></div>`;
      const togo = [o.empty && `${o.empty} seed${o.empty === 1 ? "" : "s"}`, o.open && `${o.open} game${o.open === 1 ? "" : "s"}`].filter(Boolean).join(", ");
      const whole = o.pField * o.pGames, lt = o.under ? "less than " : "";
      return `<div class="bo-h">&gt; chances</div>
        ${row("Your champion wins it all", !o.c ? `<span class="muted">pick one</span>` : odds ? pctTxt(o.title) : wait)}
        ${o.c ? row("if your bracket plays out", pctTxt(o.path), " sub") : ""}
        ${row("Whole bracket", !o.done ? `<span class="muted">${togo} to go</span>` : odds ? `${lt}${oneIn(whole)}` : wait)}
        ${o.done && odds ? row(`= field ${lt}${oneIn(o.pField)} × games ${oneIn(o.pGames)}`, whole >= 1e-6 ? `${lt}${pctTxt(whole)}` : "under 0.0001%", " sub") : ""}
        ${o.picked.length ? `<div class="bo-h2">Your picks, boldest first</div><ol class="bo-l">${o.picked.map((x, k) =>
          `<li${k ? "" : ` class="risk"`}><b>${chancePct(x.p)}</b> ${esc(ab(x.w))} over ${esc(ab(x.l))} <span>${esc(x.g.label.replace(/^(AFC|NFC) /, "$1 "))}</span></li>`).join("")}</ol>` : ""}
        <p class="bo-fn">Estimates from our power ratings and ${SIM_N.toLocaleString("en-US")} simulations of the rest of the season. For fun, not betting advice.</p>`;
    };
    const paintOdds = () => { const el = card.querySelector("#br-odds"); if (el && cur) el.innerHTML = oddsHtml(cur); };
    simOdds(lg, ranks, d).then((r) => { odds = r; if (my === token) paintOdds(); }).catch(() => { oddsErr = true; if (my === token) paintOdds(); });

    // ---- Share: copy the link, or save a picture of the bracket
    const outside = (e) => { if (!e.target.closest(".br-share")) menu(false); };
    const escKey = (e) => { if (e.key === "Escape") { menu(false); card.querySelector('[data-act="share"]')?.focus(); } };
    function menu(open) {
      const m = card.querySelector(".br-menu");
      if (m) { m.hidden = !open; card.querySelector('[data-act="share"]').setAttribute("aria-expanded", open); }
      const f = open ? "addEventListener" : "removeEventListener";
      document[f]("pointerdown", outside, true); document[f]("keydown", escKey);
    }
    const saveImage = async (btn) => {
      const o = oddsNums(cur), c = o.c, was = btn.textContent;
      btn.textContent = "Drawing…";
      try {
        const blob = await bracketPng(cur.root, cur.cols, {
          title: `MY ${season} ${nfl ? "SUPER BOWL" : "CFP"} PICKS`,
          sub: c ? `Champion: ${c.name}` : "Champion: TBD",
          stats: [["Title chance", c ? (odds ? pctTxt(o.title) : "…") : "–"], ["If my bracket plays out", c ? pctTxt(o.path) : "–"],
            ["Whole bracket", o.done && odds ? `${o.under ? "< " : ""}${oneIn(o.pField * o.pGames)}` : "–"],
            ["Boldest call", o.picked[0] ? `${chancePct(o.picked[0].p)} ${ab(o.picked[0].w)} over ${ab(o.picked[0].l)}` : "–"]],
          foot: `Our power ratings + ${SIM_N.toLocaleString("en-US")} season sims. For fun.`,
        });
        const url = URL.createObjectURL(blob), a = document.createElement("a");
        if ("download" in a) { a.href = url; a.download = `cupcake-index-${lg}-bracket-${season}.png`; document.body.appendChild(a); a.click(); a.remove(); }
        else window.open(url, "_blank"); // no download support: show the picture in a new tab (press and hold to save)
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        btn.textContent = was; menu(false);
      } catch { btn.textContent = "Couldn't draw it"; setTimeout(() => (btn.textContent = was), 2000); }
    };

    // focus = { after: key } jumps to the next empty game after that one; { at: key } to that game's prompt;
    // { seat: i } to the next empty seed after seat i (then the first game); { seatAt: i } to that seed's prompt
    const draw = (fill = false, focus = null) => {
      PK = { ids, n: 0, fill };
      let b;
      try { b = build(seated); } finally { PK = null; }
      cur = b;
      const all = [];
      (function walk(g) { all.push(g); g.kids.forEach(walk); })(b.root);
      const left = all.filter((g) => !g.win).length, empty = seats.filter((x) => !x).length, c = b.root.win, sx = card.querySelector(".br-scroll")?.scrollLeft || 0;
      card.innerHTML = `<div class="br-top"><div class="br-head"><h3>${title}: my picks</h3>
        <p class="br-pick">Your champion: ${c ? `<b class="tm br-champ">${img(c.logo, "xs")} ${esc(c.name)}</b>`
          : `<b>TBD</b> <span class="muted">(${empty ? `${empty} seed${empty === 1 ? "" : "s"} and ` : ""}${left} game${left === 1 ? "" : "s"} left)</span>`}</p>
        <div class="br-tools"><button data-act="seeds" title="Today's seeds; you pick the games">Fill with current picture</button><button data-act="fill" title="Fill the games you haven't picked with our model's favorites">Model's winners</button>
          <button data-act="reset">Reset</button><span class="br-share"><button data-act="share" aria-haspopup="menu" aria-expanded="false">Share ▾</button>
          <span class="br-menu" role="menu" hidden><button data-act="copy" role="menuitem">Copy Link</button><button data-act="img" role="menuitem">Save Image</button></span></span></div></div>
        <div class="br-odds" id="br-odds" aria-live="polite">${oddsHtml(b)}</div></div>
        ${bracketHtml(b.root, b.cols, bw, gap, true, seatCh)}${keyMine}`;
      card.querySelector(".br-scroll").scrollLeft = sx;
      wireBracket(b.root, (g, id, how) => {
        ids[g.key] = id;
        // typed: keep going to the next empty slot. Cleared by a tap: focus that slot's prompt (mouse only, so phones don't pop the keyboard)
        draw(false, how === "typed" ? { after: g.key } : how === "clear" && matchMedia("(pointer: fine)").matches ? { at: g.key } : null);
        save();
      }, { ch: seatCh, set(i, id, how) { seats[i] = id; draw(false, how === "typed" ? { seat: i } : { seatAt: i }); save(); } });
      if (focus) {
        const sIns = [...card.querySelectorAll(".br-in input[data-seat]")].sort((p, q) => p.dataset.seat - q.dataset.seat);
        const gIns = [...card.querySelectorAll(".br-in input[data-k]")].map((x) => [all[+x.dataset.k].key, x]).sort((p, q) => p[0] - q[0]);
        const to = focus.seatAt != null ? sIns.find((x) => +x.dataset.seat === focus.seatAt)
          : focus.seat != null ? sIns.find((x) => +x.dataset.seat > focus.seat) || sIns[0] || gIns[0]?.[1]
          : focus.at != null ? gIns.find(([k]) => k === focus.at)?.[1]
          : (gIns.find(([k]) => k > focus.after) || gIns[0])?.[1] || sIns[0];
        to?.focus();
      }
    };
    if (!nfl) api(`${STAND(lg)}/standings?group=80`, 300000) // CFB abbreviations and mascots for typed picks
      .then((s) => groupsOf(s).flatMap((g) => g.entries).forEach((e) => TEAMX.set(String(e.team.id), e.team))).catch(() => {});
    card.onclick = async (e) => {
      const btn = e.target.closest("button[data-act]"), act = btn?.dataset.act;
      if (act === "seeds") { seats.splice(0, nSeat, ...current()); ids.length = 0; draw(); save(); }
      if (act === "fill") { draw(true); save(); }
      if (act === "reset") { seats.fill(""); ids.length = 0; draw(); save(); }
      if (act === "share") menu(card.querySelector(".br-menu").hidden);
      if (act === "img") saveImage(btn);
      if (act === "copy") {
        const url = location.href;
        try { await navigator.clipboard.writeText(url); }
        catch { // older browsers / non-secure pages
          const t = Object.assign(document.createElement("textarea"), { value: url });
          document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
        }
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = "Copy Link"; menu(false); }, 1200);
      }
    };
    draw();
  }

  // ---------------------------------------------------------------- NFL free agents
  // ESPN's fantasy feed lists active players with no NFL team (fantasy positions only: QB, RB, WR, TE, K), most notable first.
  // It counts practice-squad players as free agents too, so each one is checked against ESPN's core athlete record,
  // which also gives age, experience and last team.
  const FA_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K" };
  const FANTASY_INJ = { OUT: "Out", QUESTIONABLE: "Questionable", DOUBTFUL: "Doubtful", INJURY_RESERVE: "Injured Reserve", SUSPENSION: "Suspension" };
  let faState = { pos: "", q: "", sort: "best", dir: "desc" };
  // sortable columns: value to sort by, and which way a first click goes (youngest / newest first, most points first)
  const FA_COLS = { age: [(r) => r.age, "asc"], exp: [(r) => r.exp, "asc"], ppg: [(r) => r.prod?.ppg, "desc"] };
  // Production: PPR fantasy points per game from the most recent season they played (this season if they were cut
  // mid-year, else last season). Short seasons count as at least 4 games so one big game doesn't top the list.
  function faProduction(c, y) {
    const season = (yr) => (c.stats || []).find((st) => st.seasonId === yr && st.statSourceId === 0 && st.statSplitTypeId === 0 && st.appliedTotal > 0);
    const st = season(y) || season(y - 1);
    if (!st) return null;
    const games = st.appliedAverage ? Math.round(st.appliedTotal / st.appliedAverage) : 0;
    // compared with a typical starter at the position (PPR pts/game); kickers count half, as the easiest to replace
    const par = FA_PAR[FA_POS[c.defaultPositionId]] || 12;
    return { year: st.seasonId, ppg: st.appliedAverage || 0, games, score: st.appliedTotal / Math.max(games, 4) / par };
  }
  const FA_PAR = { QB: 17, RB: 12, WR: 12, TE: 9, K: 16 }; // a starting kicker scores ~8; counted at half
  async function faCandidates() {
    const now = new Date(), yr = now.getFullYear();
    for (const y of now.getMonth() < 2 ? [yr - 1] : [yr, yr - 1]) { // the fantasy season rolls over in the spring
      const filter = { players: { filterProTeamIds: { value: [0] }, limit: 1000, sortPercOwned: { sortPriority: 1, sortAsc: false },
        filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`00${y - 1}`, `00${y}`] }, filterRanksForScoringPeriodIds: { value: [0] } } };
      const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${y}/segments/0/leaguedefaults/3?view=kona_player_info`;
      const hit = cache.get(url);
      if (hit && Date.now() - hit.t < 600000) return hit.data;
      const r = await fetch(url, { headers: { "X-Fantasy-Filter": JSON.stringify(filter) } });
      if (!r.ok) throw new Error(`ESPN ${r.status}`);
      const list = ((await r.json()).players || []).map((x) => x.player).filter((p) => p?.active && FA_POS[p.defaultPositionId])
        .map((p) => ({ ...p, prod: faProduction(p, y) }));
      if (list.length) { cache.set(url, { t: Date.now(), data: list }); return list; }
    }
    return [];
  }

  async function freeagents(_, params) {
    const my = token;
    if (league !== "nfl") {
      view("freeagents").innerHTML = `<div class="card">Free agents are NFL only. <a href="#/freeagents?league=nfl">See NFL free agents →</a></div>`;
      return;
    }
    loading("freeagents");
    let cands, teams;
    try {
      [cands, teams] = await Promise.all([faCandidates(), api(`${STAND("nfl")}/standings?level=3`, 86400000).then((d) => new Map(groupsOf(d).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]))).catch(() => new Map())]);
    } catch (e) { return fail("freeagents", e); }
    if (my !== token) return;
    const done = new Map(); // id -> confirmed free agent row, or null if they're actually on a practice squad / retired
    view("freeagents").innerHTML = `<div class="card">
      <div class="sc-bar"><h2>NFL free agents</h2>
        <div class="presets" id="fa-pos">${[["", "All"], ...Object.values(FA_POS).map((p) => [p, p])].map(([v, l]) => `<button data-pos="${v}" class="${v === faState.pos ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="presets" id="fa-sort" title="How to order the list">${[["best", "Best"], ["rostered", "Most rostered"]].map(([v, l]) => `<button data-sort="${v}" class="${v === faState.sort ? "on" : ""}">${l}</button>`).join("")}</div>
        <input id="fa-search" type="search" placeholder="Filter by name or last team…" value="${esc(faState.q)}">
        <span class="muted live-note" id="fa-status"></span></div>
      <div class="table-wrap"><table class="box" id="fa-table"><thead></thead><tbody></tbody></table></div>
      <p class="note">Unsigned players ESPN lists as free agents. <b>Best</b> ranks them by production in their most recent season (PPR fantasy points per game compared with a typical starter at the same position, so a good kicker and a good receiver are judged fairly; kickers count half since they are the easiest to replace, and seasons under 4 games count as 4). <b>Most rostered</b> is how many ESPN fantasy leagues have them. ESPN only tracks free agents at QB, RB, WR, TE and K.</p></div>`;
    const draw = () => {
      if (my !== token) return;
      const q = normName(faState.q);
      const rows = cands.map((c) => done.get(c.id)).filter((r) => r && (!faState.pos || r.pos === faState.pos) && (!q || r.search.includes(q)));
      if (faState.sort === "best") rows.sort((a, b) => (b.prod?.score ?? -1) - (a.prod?.score ?? -1)); // else ESPN's order: most rostered
      else if (FA_COLS[faState.sort]) { // a clicked column; players with no value go last either way
        const val = FA_COLS[faState.sort][0], k = faState.dir === "desc" ? -1 : 1;
        rows.sort((a, b) => (val(a) == null) - (val(b) == null) || (val(a) == null ? 0 : k * (val(a) - val(b))));
      }
      const th = (key, label, title) => { const on = faState.sort === key;
        return `<th class="num sortable${on ? " on" : ""}" data-col="${key}" title="${title}">${label}${on ? (faState.dir === "desc" ? " ▼" : " ▲") : ""}</th>`; };
      $("#fa-table thead").innerHTML = `<tr><th class="num">#</th><th>Player</th><th>Pos</th>${th("age", "Age", "Age (click to sort)")}${th("exp", "Exp", "Seasons in the NFL, R = rookie (click to sort)")}<th>Last team</th>${th("ppg", "Pts/g", "PPR fantasy points per game in their most recent season (click to sort)")}</tr>`;
      const checked = cands.filter((c) => done.has(c.id)).length;
      $("#fa-status").textContent = checked < cands.length ? `Checking ESPN rosters… ${checked}/${cands.length}` : `${rows.length} player${rows.length === 1 ? "" : "s"}`;
      $("#fa-table tbody").innerHTML = rows.map((r, i) => `<tr><td class="num muted">${i + 1}</td>
        <td><div class="team">${face(r.headshot, r.name, "hs")}<a href="${link("player", r.id)}">${esc(r.name)}</a>${r.inj}</div></td>
        <td>${esc(r.pos)}</td><td class="num">${esc(r.age ?? "")}</td><td class="num">${r.exp == null ? "" : r.exp ? esc(r.exp) : "R"}</td>
        <td>${r.team ? `<a href="${link("team", r.team.id)}"><span class="tm">${img(teamLogo(r.team), "xs")} ${esc(r.team.abbreviation || r.team.displayName)}</span></a>` : `<span class="muted">–</span>`}</td>
        <td class="num">${r.prod ? `${r.prod.ppg.toFixed(1)} <small class="muted" title="${r.prod.games} games in ${r.prod.year}">${r.prod.games}g '${String(r.prod.year).slice(2)}</small>` : '<span class="muted">–</span>'}</td></tr>`).join("")
        || (checked < cands.length ? "" : `<tr><td colspan="7" class="muted">No free agents match.</td></tr>`);
    };
    let pending = null;
    const soon = () => { pending ||= setTimeout(() => { pending = null; draw(); }, 250); };
    $("#fa-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (!b) return; faState.pos = b.dataset.pos;
      $("#fa-pos").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
    $("#fa-search").oninput = (e) => { faState.q = e.target.value.trim(); draw(); };
    $("#fa-sort").onclick = (e) => { const b = e.target.closest("[data-sort]"); if (!b) return; faState.sort = b.dataset.sort;
      $("#fa-sort").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
    // column headers: first click sorts that column, the next flips it
    $("#fa-table thead").onclick = (e) => { const h = e.target.closest("[data-col]"); if (!h) return; const k = h.dataset.col;
      faState.dir = faState.sort === k ? (faState.dir === "desc" ? "asc" : "desc") : FA_COLS[k][1]; faState.sort = k;
      $("#fa-sort").querySelectorAll("button").forEach((x) => x.classList.remove("on")); draw(); };
    draw();
    // check each candidate against ESPN's athlete record, a few at a time, most notable first
    let next = 0;
    const worker = async () => {
      while (next < cands.length && my === token) {
        const c = cands[next++];
        const a = await api(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${c.id}`, 3600000).catch(() => null);
        const teamId = (a?.team?.$ref || "").match(/teams\/(\d+)/)?.[1];
        const team = teams.get(teamId) || null;
        done.set(c.id, a?.status?.type !== "free-agent" ? null : {
          id: c.id, name: a.displayName || c.fullName, pos: FA_POS[c.defaultPositionId], age: a.age, exp: a.experience?.years,
          headshot: a.headshot?.href, team, prod: c.prod, inj: FANTASY_INJ[c.injuryStatus] ? injTag({ status: FANTASY_INJ[c.injuryStatus] }, c.id) : "", // no team: links to the player's page
          search: normName(`${a.displayName || c.fullName} ${team?.displayName || ""} ${team?.abbreviation || ""}`),
        });
        soon();
      }
    };
    await Promise.all(Array.from({ length: 10 }, worker));
    if (my === token) draw();
  }

  // ---------------------------------------------------------------- team
  // Rankings team panel: its mini scorebugs only know names, so add ESPN's abbreviations and kickoff times once they load
  async function fillBugs(lg, id, root) {
    const sch = await api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/schedule`, 60000).catch(() => null);
    for (const e of sch?.events || []) {
      const el = root.querySelector(`.mbug[data-eid="${CSS.escape(String(e.id))}"]`);
      if (!el) continue;
      const c = e.competitions[0], me = c.competitors.find((x) => String(x.team?.id) === String(id)), op = c.competitors.find((x) => x !== me);
      const ab = (sel, x) => { const b = el.querySelector(sel); if (b && x?.team?.abbreviation) b.textContent = x.team.abbreviation; };
      ab(".mb-tm.me .ab", me); ab(".mb-tm:not(.me) .ab", op);
      const when = el.querySelector(".mb-when");
      if (when && c.status?.type?.state === "pre") when.textContent = statusText(c.status, c.date);
    }
  }

  async function team(id, params) {
    const lg = league, my = token;
    store.set("lastTeam-" + lg, String(id)); // standings open on this team's conference
    const nfl = lg === "nfl";
    const tab = ["roster", ...(nfl ? ["depth", "moves"] : [])].includes(params.get("tab")) ? params.get("tab") : "schedule";
    loading("team");
    let sch, ros, ranks, extra;
    try {
      [sch, ros, ranks, extra] = await Promise.all([
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/schedule`, 60000),
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/roster`, 600000).catch(() => null),
        modelRanks(lg),
        tab === "depth" ? api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/depthcharts`, 600000).catch(() => null)
          : tab === "moves" ? api(`${SITE(lg)}/transactions?limit=1000`, 1800000).catch(() => null) : null,
      ]);
    } catch (e) { return fail("team", e); }
    if (my !== token) return;
    const T = sch.team || {};
    const ours = ourTeam(ranks, lg, { id: T.id, displayName: T.displayName });

    // schedule: one mini scorebug per game, with our tags / difficulty / win chance from the latest rankings file
    const ourGames = new Map((ours?.schedule || []).filter((g) => g.espn_id).map((g) => [String(g.espn_id), g]));
    const score = (x) => x?.score?.displayValue ?? x?.score ?? "";
    const stateOf = (e) => e.competitions[0].status?.type?.state;
    const bug = (e) => {
      const c = e.competitions[0], st = stateOf(e), g = ourGames.get(String(e.id));
      const me = c.competitors.find((x) => String(x.team?.id ?? x.id) === String(T.id)) || c.competitors[0];
      const sd = (x) => {
        const o = ourTeam(ranks, lg, x.team), mine = x === me;
        return { name: x.team?.location || x.team?.shortDisplayName || "", abbr: x.team?.abbreviation, logo: teamLogo(x.team), score: score(x), me: mine,
          rank: o?.rank, color: teamColor(mine ? T : o ? { color: (o.color || "").replace("#", "") } : x.team) };
      };
      const away = c.competitors.find((x) => x.homeAway === "away") || c.competitors[0], home = c.competitors.find((x) => x !== away);
      return miniBug({ href: link("game", e.id), wk: (/\d+/.exec(e.week?.text || "") || [])[0] || (e.week?.text || "").slice(0, 4), state: st,
        status: st === "post" ? c.status?.type?.shortDetail || "Final" : statusText(c.status, c.date), result: st === "post" ? (me.winner ? "W" : c.competitors.some((x) => x !== me && x.winner) ? "L" : "T") : null,
        neutral: c.neutralSite, away: sd(away), home: sd(home), tags: g ? schedTags(g, nfl) : "",
        diff: st === "post" && g?.difficulty != null ? g.difficulty : null, winp: st === "pre" && g?.win_prob != null ? g.win_prob : null, why: st === "pre" ? g?.why : null });
    };
    const events = sch.events || [];
    const games = events.map(bug).join("");

    // team hub header: points per game from finished games, our rank / factors / schedule profile from the rankings file
    const done = events.filter((e) => stateOf(e) === "post");
    const perGame = (pick) => done.length ? (done.reduce((s, e) => {
      const c = e.competitions[0], me = c.competitors.find((x) => String(x.team?.id ?? x.id) === String(T.id)) || c.competitors[0];
      return s + (+score(pick(me, c.competitors.find((x) => x !== me))) || 0);
    }, 0) / done.length).toFixed(1) : "–";
    const next = events.find((e) => stateOf(e) === "in") || events.find((e) => stateOf(e) === "pre");
    const shown = next || done[done.length - 1];
    const prof = ours && profileOf(ours);
    const facs = (INDEX.leagues[lg].factors || []).filter((f) => ours?.scores?.[f.key] != null);
    const conf = ours?.conference || T.groups?.name || "";
    const hub = `
      <div class="card thub" style="--tc:${esc(teamColor(T))}">
        <div class="th-top">
          ${img(teamLogo(T), "hero")}
          <div class="th-id"><h2>${esc(T.displayName || "")}</h2>
            <p>${[conf, T.standingSummary].filter(Boolean).map(esc).join(" · ")}</p>
            ${prof ? `<p class="th-prof">${profileBadge(prof)} <small>${esc(PROFILES[prof].desc)}</small></p>` : ""}</div>
          <div class="th-ranks">
            <div class="th-rk"><small>RECORD</small><b>${esc(T.recordSummary || ours?.record || "–")}</b></div>
            ${ours ? `<a class="th-rk ours" href="${link("rankings", null, { team: ours.team })}" title="Cupcake Index rank. Click for why."><small>OUR RANK</small><b>#${ours.rank}</b></a>` : ""}
            ${ours?.ap_rank ? `<div class="th-rk"><small>AP</small><b>#${esc(ours.ap_rank)}</b></div>` : ""}
          </div>
        </div>
        <div class="th-strip">
          <div><small>Points / game</small><b>${perGame((m) => m)}</b></div>
          <div><small>Allowed / game</small><b>${perGame((m, o) => o)}</b></div>
          ${ours ? `<div><small>Power rating</small><b>${ours.rating > 0 ? "+" : ""}${ours.rating.toFixed(1)}</b></div>` : ""}
          ${ours ? `<div><small>Why #${ours.rank}?</small><a class="boxlink" href="${link("rankings", null, { team: ours.team })}">See the breakdown →</a></div>` : ""}
        </div>
      </div>
      <div class="th-grid">
        ${facs.length ? `<div class="card"><h3>Factor scores</h3>${facs.map((f) => `<div class="frow" title="${esc(f.help || "")}"><span>${esc(f.label)}</span><span class="bar${f.invert ? " inv" : ""}"><i style="width:${+ours.scores[f.key] || 0}%"></i></span><b class="num">${Math.round(ours.scores[f.key])}</b></div>`).join("")}</div>` : ""}
        ${shown ? `<div class="card th-next"><h3>${next ? "Next game" : "Last game"}</h3><div class="mb-list">${bug(shown)}</div>
          <p class="note">${[shown.competitions[0].venue?.fullName, shown.competitions[0].broadcasts?.[0]?.media?.shortName].filter(Boolean).map(esc).join(" · ")}</p></div>` : ""}
      </div>`;

    const rosterRows = (ros?.athletes || []).filter((g) => g.items?.length).map((g) => `
      <h4>${esc({ offense: "Offense", defense: "Defense", specialTeam: "Special teams", injuredReserveOrOut: "Injured reserve / out", suspended: "Suspended", practiceSquad: "Practice squad" }[g.position] || g.position)}</h4>
      <div class="table-wrap"><table class="box"><thead><tr><th class="num">#</th><th>Player</th><th>Pos</th><th>Ht</th><th>Wt</th><th>${lg === "nfl" ? "Age" : "Class"}</th><th>Status</th></tr></thead><tbody>
      ${g.items.map((p) => `<tr data-pid="${esc(p.id)}"><td class="num muted">${esc(p.jersey || "")}</td>
        <td><div class="team">${face(p.headshot?.href, p.displayName, "hs")}<a href="${link("player", p.id)}">${esc(p.displayName)}</a></div></td>
        <td>${esc(p.position?.abbreviation || "")}</td><td>${esc(p.displayHeight || "")}</td><td>${esc(p.displayWeight || "")}</td>
        <td>${esc(lg === "nfl" ? p.age ?? "" : p.experience?.abbreviation || "")}</td>
        <td>${injTag(p.injuries?.[0], p.id, T.id)}</td></tr>`).join("")}</tbody></table></div>`).join("");

    // depth chart: offense, defense, special teams; each position shows starter, then backups (with injury tags from the roster)
    const injById = new Map((ros?.athletes || []).flatMap((g) => g.items || []).map((p) => [String(p.id), p.injuries?.[0]]));
    const POS_ORDER = ["qb", "rb", "fb", "wr1", "wr2", "wr3", "te", "lt", "lg", "c", "rg", "rt"];
    const depthRows = tab !== "depth" ? "" : (extra?.depthchart || []).map((f) => {
      const keys = Object.keys(f.positions || {});
      const kind = keys.includes("qb") ? [0, "Offense"] : keys.includes("pk") ? [2, "Special teams"] : [1, "Defense"];
      if (kind[0] === 0) keys.sort((a, b) => (POS_ORDER.indexOf(a) + 1 || 99) - (POS_ORDER.indexOf(b) + 1 || 99));
      const deep = Math.min(4, Math.max(1, ...keys.map((k) => f.positions[k].athletes?.length || 0)));
      return [kind[0], `<h4>${kind[1]} <small class="muted">${esc(kind[0] === 2 ? "" : f.name || "")}</small></h4>
        <div class="table-wrap"><table class="box depth"><thead><tr><th>Pos</th>${Array.from({ length: deep }, (_, i) => `<th>${i ? ["2nd", "3rd", "4th"][i - 1] : "Starter"}</th>`).join("")}</tr></thead><tbody>
        ${keys.map((k) => { const P = f.positions[k], list = (P.athletes || []).slice(0, deep);
          return `<tr><td title="${esc(P.position?.displayName || "")}"><b>${esc(P.position?.abbreviation || k.toUpperCase())}</b></td>${Array.from({ length: deep }, (_, i) => {
            const a = list[i];
            return a ? `<td><a href="${link("player", a.id)}">${esc(a.shortName || a.displayName)}</a>${injTag(injById.get(String(a.id)), a.id, T.id)}</td>` : `<td></td>`;
          }).join("")}</tr>`; }).join("")}</tbody></table></div>`];
    }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join("");
    // recent roster moves for this team, from ESPN's league-wide transactions feed
    const moves = tab !== "moves" ? [] : (extra?.transactions || []).filter((t, i, all) => String(t.team?.id) === String(T.id) && !all.slice(0, i).some((u) => u.description === t.description && String(u.team?.id) === String(T.id))); // ESPN sometimes posts the same move twice
    const movesRows = moves.map((t) => `<tr><td class="muted">${esc(new Date(t.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</td><td>${esc(t.description)}</td></tr>`).join("");
    const tabLink = (t, label) => `<a class="subtab${tab === t ? " on" : ""}" href="${link("team", id, { tab: t })}">${label}</a>`;
    view("team").innerHTML = `${hub}
      <div class="subtabs">${tabLink("schedule", "Schedule")}${tabLink("roster", "Roster")}${nfl ? tabLink("depth", "Depth chart") + tabLink("moves", "Transactions") : ""}</div>
      <div class="card">${tab === "roster"
        ? rosterRows || `<p class="muted">Roster not available.</p>`
        : tab === "depth" ? depthRows || `<p class="muted">Depth chart not available.</p>`
        : tab === "moves" ? (movesRows ? `<div class="table-wrap"><table class="box moves"><tbody>${movesRows}</tbody></table></div>
            <p class="note">Signings, releases and injured-reserve moves since ${esc(new Date(extra.transactions[extra.transactions.length - 1].date).toLocaleDateString(undefined, { month: "long", day: "numeric" }))}.</p>`
            : `<p class="muted">No recent transactions.</p>`)
        : games ? `<div class="mb-list cols">${games}</div>${ourGames.size ? `<p class="note">Tap a game for the box score or preview. Diff (difficulty) is the chance a typical ${nfl ? "top-8 NFL" : "top-25"} team would lose that game; win chances are from the Cupcake Index model.</p>` : ""}`
        : `<p class="muted">No games scheduled.</p>`}</div>`;
    // latest headlines mentioning this team (news.js), under the schedule
    if (tab === "schedule") News.forTeam(lg, T.id).then((h) => { if (h && my === token) view("team").insertAdjacentHTML("beforeend", h); });
    // arrived from an injury tag: pulse that player's row and show their latest update under it
    const hl =tab === "roster" ? params.get("hl") : null;
    const hlRow = hl && view("team").querySelector(`tr[data-pid="${CSS.escape(hl)}"]`);
    const rosterInj = hlRow && (ros?.athletes || []).flatMap((g) => g.items || []).find((p) => String(p.id) === hl)?.injuries?.[0];
    const note = (i) => {
      if (!hlRow || !injInfo(i)) return;
      hlRow.nextElementSibling?.classList.contains("inj-note") && hlRow.nextElementSibling.remove();
      const when = i.date ? new Date(i.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      hlRow.insertAdjacentHTML("afterend", `<tr class="inj-note"><td></td><td colspan="${hlRow.cells.length - 1}"><b>${esc(injInfo(i).tip)}</b>${when ? ` <span class="muted">· updated ${esc(when)}</span>` : ""}${i.shortComment && i.shortComment.toLowerCase() !== injInfo(i).status.toLowerCase() ? `<br>${esc(i.shortComment)}` : ""}</td></tr>`);
    };
    if (hlRow) { note(rosterInj); highlightRow(hl); }
    // NFL rosters only carry the status; the league injury report adds the body part, expected return and latest news
    if (lg === "nfl" && tab === "roster" && view("team").querySelector(".inj-tag[data-pid]")) {
      injuryMap().then((m) => {
        if (my !== token) return;
        view("team").querySelectorAll(".inj-tag[data-pid]").forEach((el) => {
          const x = injInfo(m.get(el.dataset.pid));
          if (!x) return;
          el.title = x.tip + " · click for the latest";
          if (x.part) el.insertAdjacentHTML("afterend", ` <small class="muted">${esc(x.part)}</small>`);
        });
        if (hlRow && m.get(hl)) note({ ...m.get(hl), date: m.get(hl).date || rosterInj?.date });
      }).catch(() => {});
    }
  }

  // helpers shared with pickem.js and fantasy.js: ESPN fetch + cache, logos, our-rank lookup, game status, injury tags, polling tied to the current view
  const kit = { SITE, api, img, teamLogo, ourTeam, statusText, injTag, poll, teamColor, token: () => token };
  return { stop, teamId, scores, game, stats, player, standings, team, freeagents, searchPlayers, fillBugs, kit };
})();
