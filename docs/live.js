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
  const SIZES = { xs: [18, 18], sm: [22, 22], lg: [28, 28], xl: [56, 56], hero: [96, 96], bigface: [96, 96], hs: [30, 30], leadshot: [52, 52], headshot: [132, 96] }; // CSS display sizes
  let boxTab = "off"; // remembered across live refreshes
  const img = (src, cls = "lg") => {
    if (!safeUrl(src)) return `<span class="logo-ph ${cls}"></span>`;
    const [w, h] = SIZES[cls] || [40, 40];
    const crop = cls === "leadshot" || cls === "hs" || cls === "bigface"; // round headshots: square crop centered on the face
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

  // Where to watch: the channel's streaming service. Plain https links: on phones they open the app if it's installed.
  const WATCH = [
    [/espn\+/i, "ESPN+", "https://plus.espn.com/"],
    [/peacock|\bnbc\b/i, "Peacock", "https://www.peacocktv.com/"],
    [/paramount|\bcbs\b(?!\s*sports)/i, "Paramount+", "https://www.paramountplus.com/"],
    [/netflix/i, "Netflix", "https://www.netflix.com/"],
    [/\bfox\b|\bfs1\b|\bfs2\b|\bbtn\b|big ten net/i, "FOX One", "https://www.foxone.com/"],
    [/espn|\babc\b|\bsecn?\b|sec network|\baccn\b|acc network|\blhn\b/i, "ESPN", "https://www.espn.com/watch/"],
    [/prime|amazon/i, "Prime Video", "https://www.primevideo.com/"],
    [/nfl\s*net|\bnfln\b/i, "NFL+", "https://www.nfl.com/plus/"],
    [/youtube/i, "YouTube TV", "https://tv.youtube.com/"],
    [/\btnt\b|trutv|\bmax\b/i, "HBO Max", "https://www.hbomax.com/"],
    [/\bcw\b/i, "The CW", "https://www.cwtv.com/"],
  ];
  const watchFor = (ch) => { const m = WATCH.find(([re]) => re.test(ch || "")); return m ? { app: m[1], href: m[2] } : null; };
  // the channel, plus a "▶ Peacock" button for games you can still watch (a span, so it works inside the card links)
  const watch = (ch, st) => {
    if (!ch) return "";
    const w = st !== "post" && watchFor(ch);
    return w ? `<span class="watch-ch">${esc(ch)}</span> <span class="watch" role="link" tabindex="0" data-href="${esc(w.href)}" title="Watch on ${esc(w.app)}">&#9654; ${esc(w.app)}</span>`
      : `<span class="watch-ch">${esc(ch)}</span>`;
  };
  if (!window.__watchWired) {
    window.__watchWired = true;
    const go = (e) => {
      const b = e.target.closest?.(".watch[data-href]");
      if (!b || (e.type === "keydown" && e.key !== "Enter")) return;
      e.preventDefault(); e.stopPropagation();
      window.open(b.dataset.href, "_blank", "noopener");
    };
    document.addEventListener("click", go, true); // capture: beat the game-card link around it
    document.addEventListener("keydown", go, true);
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

  // ---------------------------------------------------------------- college availability reports (src/cfb_injuries.py)
  // weeks: { "6": { "Alabama": { opp, qb: passing leader, players: [[name, "#4", "QB", status]] } } }
  let cfbInjP = null;
  const cfbInj = () => (cfbInjP ||= getJSON(`data/cfb/${INDEX.leagues.cfb.latest.season}/injuries.json`).catch(() => { cfbInjP = null; return null; }));
  const INJ_ORDER = ["Out", "Out - (1st Half)", "Out (1st Half)", "Doubtful", "Game Time Decision", "Questionable"];
  const nmKey = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const CFB_INJ_NOTE = "From the conference availability reports: the SEC, ACC, Big 12, Big Ten and MAC publish them for conference games. Anyone not listed is available.";
  // one team's report for a week (or its latest one): { wk, opp, qb, players }
  function cfbInjFor(d, team, wk = null) {
    if (!d?.weeks || !team) return null;
    const w = wk != null ? (d.weeks[wk]?.[team] ? wk : null) : Object.keys(d.weeks).map(Number).sort((a, b) => b - a).find((k) => d.weeks[k][team]);
    return w == null ? null : { wk: w, ...d.weeks[w][team] };
  }
  const cfbInjList = (r) => `<ul class="inj-list cfb-inj-list">${r.players.slice().sort((a, b) => INJ_ORDER.indexOf(a[3]) - INJ_ORDER.indexOf(b[3])).map(([n, num, pos, st]) =>
    `<li><div><b>${esc(n)}</b> <small class="muted">${esc([pos, num].filter(Boolean).join(" "))}</small> <span class="cfb-st ${st.startsWith("Out") ? "out" : st === "Doubtful" ? "d" : "q"}">${esc(st)}</span>${r.qb && nmKey(r.qb) === nmKey(n) ? ` <span class="inj-starter" title="This team's passing leader">STARTING QB</span>` : ""}</div></li>`).join("")
    || `<li class="muted">Nobody listed.</li>`}</ul>`;

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
      ${events.length ? "" : `<div class="card muted">No games this week. Pick another week above, or see <a href="${link("rankings")}">the rankings →</a></div>`}`;
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
    const model = p && chanceText(p) ? `<span${p.why ? ` title="${esc(p.why)}"` : ""}>Model: ${chanceText(p)}${scorePred(p) ? `, ${scorePred(p)}` : ""}</span>` : "";
    const foot = [odds?.details ? `${esc(odds.details)}${odds.overUnder ? ` · O/U ${esc(odds.overUnder)}` : ""}` : "", model, watch(c.broadcast || c.broadcasts?.[0]?.names?.[0] || "", st)].filter(Boolean).join(" · ");
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
  // Who's who on the live field: each team's roster (names, numbers, headshots) and depth chart (who starts where).
  // ESPN doesn't say which 22 are on the field each snap, so spots get the listed starter ("likely"); the players
  // named in the play text (passer, receiver, runner, tacklers...) are matched to the roster and shown for sure.
  // injuries (ESPN marks Out / IR / Doubtful on the roster) are re-read every 15 minutes
  const peopleCache = new Map();
  async function teamPeople(lg, teamId, season) {
    const key = `${lg}-${teamId}-${season}`;
    const hit = peopleCache.get(key);
    if (hit && Date.now() - hit.t < 900000) return hit.job;
    const job = (async () => {
      const coreLg = lg === "nfl" ? "nfl" : "college-football";
      const [ro, dc] = await Promise.all([
        api(`${SITE(lg)}/teams/${encodeURIComponent(teamId)}/roster`, 900000).catch(() => null),
        api(`https://sports.core.api.espn.com/v2/sports/football/leagues/${coreLg}/seasons/${season}/teams/${encodeURIComponent(teamId)}/depthcharts`, 3600000).catch(() => null),
      ]);
      const byId = new Map(), byName = new Map();
      const groups = ro?.athletes || [];
      (groups[0]?.items ? groups.flatMap((g) => g.items || []) : groups).forEach((a) => {
        const full = a.fullName || a.displayName || "", parts = full.replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, "").split(" ");
        const inj = (a.injuries || [])[0]?.status || "";
        const pl = { id: String(a.id), name: full, num: a.jersey || "", pos: a.position?.abbreviation || "", pic: a.headshot?.href || "", inj,
          out: /^(out|injured reserve|doubtful|suspen|physically unable)/i.test(inj) };
        byId.set(pl.id, pl);
        byName.set(full.toLowerCase(), pl);
        if (parts.length > 1) byName.set(`${parts[0][0]}.${parts.slice(1).join(" ")}`.toLowerCase(), pl); // "D.Metcalf"
      });
      const depth = {};
      (dc?.items || []).forEach((it) => Object.entries(it.positions || {}).forEach(([k, v]) => {
        if (!depth[k]) depth[k] = (v.athletes || []).sort((a, b) => (a.rank || a.slot) - (b.rank || b.slot))
          .map((x) => (/athletes\/(\d+)/.exec(x.athlete?.$ref || "") || [])[1]).filter(Boolean);
      }));
      return { byId, byName, depth };
    })();
    peopleCache.set(key, { job, t: Date.now() });
    job.catch(() => peopleCache.delete(key));
    return job;
  }

  // A new play replays on the field (ball carrier runs / pass arcs / kick sails, then the teams line up again);
  // the same play on later refreshes just sits there with the players idling. tfSeen: game id -> {play, t}.
  const tfSeen = new Map();
  const playNum = (x) => { try { return BigInt(x); } catch (e) { return -1n; } }; // ESPN play ids count up through the game
  // "CLV 44" -> yard line from the home goal (0-100). ESPN's play text sometimes uses its own nicknames.
  const ABBR_ALIAS = { CLV: "CLE", ARZ: "ARI", BLT: "BAL", HST: "HOU", LA: "LAR", WSH: "WAS", JAC: "JAX" };
  function textSpot(t, home, away) {
    if (!t) return null;
    if (t === "50") return 50;
    const [ab, n] = t.trim().split(/\s+/), side = (ABBR_ALIAS[ab.toUpperCase()] || ab.toUpperCase());
    const is = (c) => [c.team.abbreviation, ABBR_ALIAS[c.team.abbreviation]].filter(Boolean).map((x) => x.toUpperCase()).includes(side);
    return is(away) ? 100 - +n : is(home) ? +n : null;
  }
  // Replay: the last few real plays (no timeouts / quarter breaks), and what's needed to redraw the field for one
  const NOT_A_PLAY = new Set(["21", "74", "75", "2", "65"]);
  const tfCtx = new Map(); // game id -> latest liveField arguments
  const recentPlays = (s, n = 3) => [...(s.drives?.previous || []), ...(s.drives?.current ? [s.drives.current] : [])]
    .flatMap((dr) => dr.plays || []).filter((p) => p.text && p.start?.yardLine != null && !NOT_A_PLAY.has(String(p.type?.id || ""))).slice(-n);
  // the game as it stood right after play `pid`: drives cut off at that play, so liveField draws (and replays) it
  function upToPlay(s, pid) {
    const all = [...(s.drives?.previous || []), ...(s.drives?.current ? [s.drives.current] : [])], out = [];
    for (const dr of all) {
      const i = (dr.plays || []).findIndex((p) => String(p.id) === String(pid));
      if (i < 0) { out.push(dr); continue; }
      out.push({ ...dr, plays: dr.plays.slice(0, i + 1) });
      return { ...s, drives: { previous: out } };
    }
    return null;
  }
  function replayMenu(s) {
    const ps = recentPlays(s);
    if (!ps.length) return "";
    const line = (p) => {
      const st = p.start || {}, dd = st.down >= 1 && st.down <= 4 ? `${["", "1ST", "2ND", "3RD", "4TH"][st.down]} & ${st.distance}` : "";
      const t = (p.text || "").trim().replace(/^(\([^)]*\)\s*)+/, "");
      return `${dd ? `<b>${dd}</b> ` : ""}${esc(t.length > 70 ? t.slice(0, 68) + "…" : t)}`;
    };
    return `<button class="tf-rb" type="button" aria-expanded="false">▶ REPLAY</button><div class="tf-rmenu hidden">
      ${ps.length > 1 ? `<button type="button" data-rp="${ps.map((p) => esc(p.id)).join(",")}"><b>▶ ALL ${ps.length}</b> back to back</button>` : ""}
      ${ps.slice().reverse().map((p) => `<button type="button" data-rp="${esc(p.id)}">${line(p)}</button>`).join("")}</div>`;
  }
  // After the final: the game's top plays (biggest win-chance swings, touchdowns, turnovers, long gains, long
  // field goals), 5 to 10 of them, in the order they happened. Each gets a short label for the title card.
  function topPlays(s) {
    const plays = recentPlays(s, 1e4);
    const swing = new Map();
    let prev = null;
    for (const w of s.winprobability || []) {
      if (prev != null) swing.set(String(w.playId), Math.abs(w.homeWinPercentage - prev));
      prev = w.homeWinPercentage;
    }
    const last = plays.filter((p) => p.scoringPlay).at(-1);
    const sc = plays.map((p) => {
      const t = `${p.type?.text || ""} ${p.text || ""}`.toLowerCase(), yds = +p.statYardage || 0;
      const td = p.scoringPlay && /touchdown/.test(t), fg = p.scoringPlay && /field goal/.test(t) && !/no good|missed|blocked/.test(t);
      const to = /intercept|fumble recovery \(opponent\)|recovered by|blocked|safety|turnover on downs/.test(t) && !/no play/.test(t);
      const kind = td ? (/intercept|fumble|return/.test(t) && !/pass from/.test(t) ? "DEFENSIVE TOUCHDOWN" : "TOUCHDOWN")
        : /intercept/.test(t) ? "INTERCEPTION" : /fumble/.test(t) && to ? "FUMBLE" : /safety/.test(t) ? "SAFETY"
        : /blocked/.test(t) ? "BLOCKED KICK" : /turnover on downs/.test(t) ? "4TH DOWN STOP" : fg ? "FIELD GOAL"
        : /sack/.test(t) ? "SACK" : yds >= 20 ? `${yds}-YARD ${/pass/.test(t) ? "PASS" : /run|rush/.test(t) ? "RUN" : "GAIN"}` : "BIG PLAY";
      const fgYds = +(t.match(/(\d+) y(ar)?d field goal/)?.[1] || 0);
      let score = (swing.get(String(p.id)) || 0) * 100 + (td ? 40 : 0) + (to ? 30 : 0) + Math.max(0, yds - 15)
        + (fg && fgYds >= 50 ? 20 : 0) + (p === last ? 15 : 0);
      if (/no play|kneel|extra point|two-point|penalty/.test(t) && !td) score = 0;
      return { p, score, kind };
    });
    const n = Math.max(5, Math.min(10, sc.filter((x) => x.score >= 25).length));
    return sc.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => plays.indexOf(a.p) - plays.indexOf(b.p));
  }
  const hlButton = (hl) => hl.length ? `<button class="tf-rb tf-hb" type="button">▶ PLAY HIGHLIGHTS</button>` : "";
  function liveField(s, comp, home, away, tc, gameId, people = null, replayMode = false, final = null) {
    if (!replayMode) tfCtx.set(gameId, { s, comp, home, away, tc, people, final });
    const drives = s.drives || {};
    const drive = drives.current || (drives.previous || []).at(-1);
    const play = drive?.plays?.at(-1);
    const spot = play?.end?.yardLine ?? play?.start?.yardLine;
    if (spot == null) return "";
    pixelFont();
    const seen = tfSeen.get(gameId);
    // never step back: if a slow feed hands us an older play than one already shown, it isn't a new play (no clock reset)
    const older = seen && playNum(seen.play) > playNum(play.id);
    const fresh = !seen || (!older && seen.play !== String(play.id));
    if (fresh) tfSeen.set(gameId, { play: String(play.id), t: Date.now() });
    const since = (Date.now() - tfSeen.get(gameId).t) / 1000;
    const at = play.end?.down ? play.end : play.start?.down ? play.start : play.end || {};
    // who has the ball now: the play's own end (after a punt, kickoff or turnover it names the new offense right away);
    // ESPN's game-level possession flag can lag a few seconds behind
    const possId = String(play.end?.team?.id || comp.competitors.find((c) => c.possession)?.team?.id || at.team?.id || drive.team?.id || "");
    const newDrive = !!drive?.team?.id && String(drive.team.id) !== possId; // possession just changed: the old drive is over
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
    // "... TOUCHDOWN. C.Boswell extra point is GOOD" / "TWO-POINT CONVERSION ATTEMPT. J.Allen pass to ... ATTEMPT SUCCEEDS."
    const two = /two-point conversion attempt\.?(.*?)attempt (succeeds|fails)/i.exec(play.text || "");
    const pat = !isTD ? null : two ? { kind: "2pt", good: /succeeds/i.test(two[2]), pass: /\bpass\b/i.test(two[1]) }
      : /extra point/i.test(play.text || "") ? { kind: "xp", good: /extra point is good/i.test(play.text || "") } : null;
    const PAT_AT = 5.2, PAT_LEN = 2.6; // the try starts once everyone has jogged off; the kickoff setup follows it
    const down = at.down >= 1 && at.down <= 4 && !isTD ? at.down : 0, dist = down ? at.distance || 0 : 0; // ESPN marks scores as down -1
    const fd = down && dist && dist < toGo ? spot + dir * dist : null; // goal to go: no first-down line
    const X = (yl) => 100 + yl * 10; // 10 px per yard; 10-yard end zones
    // kickoff replays run longer: kickoff lineup, the kick to where it really landed ("kicks 61 yards from LA 35 to BUF 4"),
    // the return to where it ended, then everyone shows up at the new spot
    const ko = fresh && /kickoff/.test(type) ? (() => {
      const kd = String(play.start?.team?.id) === String(home.team.id) ? 1 : -1;
      const tb = /touchback/.test(txt), fair = /fair catch/.test(txt);
      const lt = /kicks .*? to ([A-Z]{2,4} \d{1,2}|50)\b/i.exec(play.text || "")?.[1];
      const ly = tb ? (kd > 0 ? 105 : -5) : (lt ? textSpot(lt, home, away) : null) ?? (kd > 0 ? 95 : 5);
      const endYl = isTD ? (kd > 0 ? -4 : 104) : spot; // a return touchdown ends in the kicking team's end zone
      const returned = !tb && !fair && !/kicks [^.]*out of bounds/i.test(play.text || "") && ly !== endYl;
      const land = 1.9, end = returned ? land + Math.min(2.2, Math.max(1, Math.abs(endYl - ly) * 0.05)) : land + 0.3;
      return { kd, ly, endYl, returned, land, end, len: end + 0.4 };
    })() : null;
    const RT = ko ? ko.len : 2.4, SHIFT = RT - 2.4; // when the replay ends (and how much later than a normal play)
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
    const start = newDrive ? null : drive?.start?.yardLine;
    if (off && start != null && start !== spot) {
      const a = Math.min(X(start), X(spot)), b = Math.max(X(start), X(spot));
      base.push(r(a, 0, b - a, H, col(off), ' opacity=".28"'));
    }

    // replay timing (seconds): the play runs 0.3-1.6, banner 1.2-3.2, teams walk to the new line 1.9-2.6
    const from = play.start?.yardLine ?? spot, moved = from !== spot;
    const anim = fresh;
    const appear = (t) => (anim && t ? ` opacity="0" visibility="hidden"><set attributeName="visibility" to="visible" begin="${t}s" fill="freeze"/><animate attributeName="opacity" from="0" to="1" begin="${t}s" dur=".2s" fill="freeze"/` : "");
    // lines: blue line of scrimmage, yellow first-down line (they show up after the replay)
    const lines = isTD ? "" : `<g${appear(RT + 0.1)}>${r(X(spot) - 3, 0, 6, H, "#3d7bff")}${fd != null ? r(X(fd) - 3, 0, 6, H, "#ffd21f") : ""}</g>`;
    // pixel players (idle bob, staggered): offense behind the ball, defense across it
    let k = 0;
    // who: { name, num, pos, pic, sure } -> hover/tap label (see the field's pointer handler in game())
    const guy = (x, y, c, flip, who) => {
      const jersey = col(c), helm = alt(c);
      const tag = who ? ` data-name="${esc(who.name)}" data-num="${esc(who.num || "")}" data-pos="${esc(who.pos || "")}" data-pic="${esc(who.pic || "")}"`
        + ` data-team="${esc(c.team.abbreviation || "")}" data-sure="${who.sure ? 1 : 0}"` : ` data-team="${esc(c.team.abbreviation || "")}"`;
      return `<g class="tf-guy"${tag} style="animation-delay:${-((k++ * 0.37) % 0.8).toFixed(2)}s">`
        + r(x - 6, y - 14, 12, 8, helm) + r(x - 8, y - 6, 16, 12, jersey) + r(x - 7, y + 6, 5, 8, "#f2f2f2") + r(x + 2, y + 6, 5, 8, "#f2f2f2")
        + r(x + (flip ? -9 : 5), y - 4, 4, 6, "#f5c9a6") + "</g>";
    };
    // casting: depth-chart starters for each formation spot, skipping anyone ESPN lists as out or who got hurt
    // this game; QB / RB / WR / TE / K / P go to whoever this game's play-by-play says is actually in
    const P = (c) => people?.[c === home ? "home" : "away"];
    const PLAY_POS = { QB: "qb", RB: "rb", FB: "rb", WR: "wr", TE: "te", PK: "pk", K: "pk", P: "p" };
    const STRIP = (t) => (t || "").trim().replace(/^(\([^)]*\)\s*)+/, "");
    const lookName = (c, nm) => nm && P(c)?.byName.get(nm.trim().replace(/^[A-Z]{2,4}-/, "").replace(/[.,]$/, "").toLowerCase()); // "WAS-M.Mariota"
    const gameIn = new Map(); // team id -> { recent: {qb: [ids, newest first]...}, hurt: Set of ids }
    const allPlays = [...(drives.previous || []), ...(drives.current ? [drives.current] : [])].flatMap((dr) => dr.plays || []);
    const NM0 = "([A-Z][A-Za-z'.-]*(?:\\s[A-Z][A-Za-z'.-]+)?)";
    for (const pl of allPlays) {
      const tid = String(pl.start?.team?.id || pl.team?.id || ""), c = tid === String(home.team.id) ? home : tid === String(away.team.id) ? away : null;
      if (!c || !P(c)) continue;
      const g = gameIn.get(tid) || { recent: {}, hurt: new Set() };
      gameIn.set(tid, g);
      const t = STRIP(pl.text), g1 = (re) => (new RegExp(re).exec(t) || [])[1];
      const names = [g1(`^${NM0} (?:pass|sacked|scrambles|kneels|spiked)`), g1(` pass .*?to ${NM0}`), g1(`^${NM0} (?:left|right|up|middle|runs?|rush)`),
        g1(`^${NM0} (?:\\d+ yard field goal|extra point|punts|kicks)`)];
      for (const nm of names) {
        const who = lookName(c, nm), k = who && PLAY_POS[who.pos];
        if (!k) continue;
        g.hurt.delete(who.id); // back on the field
        const list = (g.recent[k] ||= []), at = list.indexOf(who.id);
        if (at >= 0) list.splice(at, 1);
        list.unshift(who.id);
      }
      // "J.Daniels was injured during the play" (either team)
      for (const m of (pl.text || "").matchAll(new RegExp(`${NM0} (?:was|is) injured`, "g"))) {
        for (const tc2 of [home, away]) {
          const who = lookName(tc2, m[1]);
          if (!who) continue;
          const g2 = gameIn.get(String(tc2.team.id)) || { recent: {}, hurt: new Set() };
          gameIn.set(String(tc2.team.id), g2);
          g2.hurt.add(who.id);
          Object.values(g2.recent).forEach((l) => { const i = l.indexOf(who.id); if (i >= 0) l.splice(i, 1); });
        }
      }
    }
    const pick = (c, keys, n = 0) => {
      const d = P(c)?.depth || {}, g = gameIn.get(String(c.team.id)), ok = (id) => { const p = P(c)?.byId.get(id); return p && !p.out && !g?.hurt.has(id); };
      const ids = [...(keys.length === 1 && g?.recent[keys[0]] || [])];
      keys.forEach((k) => {
        const healthy = (d[k] || []).filter(ok);
        (keys.length === 1 ? healthy : healthy.slice(0, 1)).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
      });
      const pl = P(c)?.byId.get(ids[n]);
      return pl ? { ...pl, sure: false } : null;
    };
    const OFF_KEYS = [["lt"], ["lg"], ["c"], ["rg"], ["rt"], ["qb"], ["rb"], ["wr", 0], ["wr", 1], ["te"]];
    const castOff = (c) => OFF_KEYS.map(([k, n]) => pick(c, [k], n || 0));
    const castDef = (c) => {
      const d = P(c)?.depth || {}, have = (ks) => ks.filter((k) => d[k]?.length);
      const dl = have(["lde", "ldt", "nt", "rdt", "rde", "de", "dt"]), lb = have(["wlb", "lilb", "mlb", "rilb", "slb", "lb", "olb"]);
      const one = (k) => pick(c, [k]);
      return [...[0, 1, 2, 3].map((i) => (dl[i] ? one(dl[i]) : null)), ...[0, 1, 2].map((i) => (lb[i] ? one(lb[i]) : null)),
        one("lcb") || pick(c, ["cb"]), one("rcb") || pick(c, ["cb"], 1), one("ss"), one("fs")];
    };
    // names in the play text: "A.Rodgers pass short middle to R.Wilson ... (G.Delpit; C.Schwesinger)"
    const named = (c, nm) => { const pl = nm && P(c)?.byName.get(nm.trim().replace(/[.,]$/, "").toLowerCase()); return pl ? { ...pl, sure: true } : null; };
    const NM = "([A-Z][A-Za-z'.-]*(?:\\s[A-Z][A-Za-z'.-]+)?)";
    const ptxt = STRIP(play.text);
    const grab = (re) => (new RegExp(re).exec(ptxt) || [])[1];
    const inPlay = {
      qb: grab(`^${NM} (?:pass|sacked|scrambles|kneels|spiked)`), wr: grab(` pass .*?to ${NM}`),
      rb: /\bpass\b|sacked|kneels|spike|punts|kicks/.test(ptxt) ? null : grab(`^${NM} (?:left|right|up|middle|runs?|rush)`),
      cb: grab(`INTERCEPTED by ${NM}`), sack: grab(`sacked .*?\\(${NM}`),
      tacklers: ((/\(([^()]*)\)\.?\s*$/.exec(ptxt) || [])[1] || "").split(/[;,]/).map((x) => x.trim()).filter((x) => /^[A-Z]/.test(x)),
    };
    const castPlay = (o, d) => {
      const offC = castOff(o), defC = castDef(d);
      const put = (arr, i, c, nm) => { const pl = named(c, nm); if (pl) arr[i] = pl; };
      put(offC, 5, o, inPlay.qb); put(offC, 6, o, inPlay.rb); put(offC, 7, o, inPlay.wr);
      put(defC, 7, d, inPlay.cb); put(defC, 1, d, inPlay.sack);
      inPlay.tacklers.forEach((t, i) => put(defC, [5, 9, 4][i] ?? 6, d, t));
      return [offC, defC];
    };

    // formations: [role, yards off the ball, y]. Offense behind the ball, defense across it.
    const OFF_SET = [["ol", 1.6, 110], ["ol", 1.6, 130], ["c", 1.6, 150], ["ol", 1.6, 170], ["ol", 1.6, 190], ["qb", 5, 150], ["rb", 7.5, 132],
      ["wr", 1.6, 40], ["wr2", 1.6, 262], ["te", 2.8, 222]];
    const DEF_SET = [["dl", 1.6, 120], ["dl", 1.6, 140], ["dl", 1.6, 160], ["dl", 1.6, 180], ["lb", 5, 110], ["lb", 5, 150], ["lb", 5, 190],
      ["cb", 6, 40], ["cb", 6, 262], ["s", 11, 100], ["s", 11, 200]];
    const D = 2.4; // replay length (s): snap at .4, whistle at 2.4, then everyone resets at the new line
    const motion = (keys, len = D, begin = 0) => {
      if (!keys?.length) return "";
      const pts = [[0, 0, 0], ...keys];
      if (pts.at(-1)[0] < len) pts.push([len, pts.at(-1)[1], pts.at(-1)[2]]);
      return `<animateTransform attributeName="transform" type="translate" values="${pts.map((q) => `${q[1].toFixed(1)} ${q[2].toFixed(1)}`).join(";")}"
        keyTimes="${pts.map((q) => (q[0] / len).toFixed(3)).join(";")}" dur="${len}s" begin="${begin}s" fill="freeze"/>`;
    };
    const ball = (x, y) => `<g class="tf-sh">${r(x - 9, y - 4, 18, 8, "#8b4a1f") + r(x - 6, y - 6, 12, 12, "#8b4a1f") + r(x - 4, y - 1, 8, 2, "#ffffff")}</g>`;
    // one formation at yard line `at`; odir = the offense's direction; moves(role, x, y) -> keyframes [[t, dx, dy], ...]
    const formation = (at, o, odir, moves = () => null, len = D, begin = 0, cast = null) => {
      const [offC, defC] = cast || [castOff(o), castDef(o === home ? away : home)];
      const d = o === home ? away : home, out = [];
      OFF_SET.forEach(([role, yd, y], i) => { const x = X(at) - odir * yd * 10; out.push(`<g>${motion(moves(role, x, y, true), len, begin)}${guy(x, y, o, odir < 0, offC[i])}</g>`); });
      DEF_SET.forEach(([role, yd, y], i) => { const x = X(at) + odir * yd * 10; out.push(`<g>${motion(moves(role, x, y, false), len, begin)}${guy(x, y, d, odir > 0, defC[i])}</g>`); });
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
      const scorer = `<g opacity="0"><set attributeName="opacity" to="1" begin="${t}s"/><g>${guy(sx0, 150, team, !right, named(team, inPlay.wr || inPlay.rb || inPlay.cb))}${ball(sx0 + 2, 120)}
        <animateTransform attributeName="transform" type="translate" values="0 0;0 -18;0 0" dur=".45s" begin="${t}s" repeatCount="5"/></g>
        <animate attributeName="opacity" from="1" to="0" begin="${t + 2.4}s" dur=".4s" fill="freeze"/></g>`;
      return flash + scorer + confetti;
    };
    // after a touchdown the field is a party, not a formation
    // kickoff setup: kicking team across its own 35 with the ball on a tee, return team spread out, two returners deep
    const kickoffSet = (k) => {
      const kd = k === home ? 1 : -1, K = k === home ? 35 : 65, recv = otherTeam(k), out = [];
      [30, 55, 80, 105, 130, 170, 195, 220, 245, 270].forEach((y) => out.push(guy(X(K) - kd * 12, y, k, kd < 0)));
      out.push(guy(X(K) - kd * 70, 150, k, kd < 0, pick(k, ["pk"]))); // the kicker
      [60, 105, 150, 195, 240].forEach((y) => out.push(guy(X(K + kd * 15), y, recv, kd > 0)));
      [90, 150, 210].forEach((y) => out.push(guy(X(K + kd * 35), y, recv, kd > 0)));
      [120, 180].forEach((y, i) => out.push(guy(X(kd > 0 ? 95 : 5), y, recv, kd > 0, pick(recv, ["kr"], i))));
      return out.join("") + r(X(K) - 3, 156, 6, 6, "#ff8c1a") + ball(X(K), 150); // ball on a tee
    };
    const party = isTD && tdTeam ? celebrate(tdTeam, fresh ? RT - 0.1 : 0) : "";
    const setupAt = !fresh ? 0 : isTD ? (pat ? PAT_AT + PAT_LEN + 0.3 : PAT_AT) + SHIFT : RT + 0.1; // TD: replay, party, jog off, the try, then the kickoff setup
    const lineup = kicker ? (fresh ? party : "") + `<g${appear(setupAt)}>${kickoffSet(kicker)}</g>`
      : off ? `<g${appear(RT + 0.1)}>${formation(spot, off, dir)}${ball(bx, 150)}</g>` : "";

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
    // hover / tap the flag: what it was for. "PENALTY on PIT-M.Pittman, False Start, 5 yards, enforced at PIT 22 - No Play."
    const flagWho = /penalty on [a-z]{2,4}-([^,]+),/i.exec(play.text || "")?.[1]?.trim();
    const flagTag = !isFlag ? "" : ` class="tf-flag" data-flag="${esc(pm ? pm[2] : "Penalty")}" data-flagsub="${esc([pm && pm[1].toUpperCase(), flagWho && !/^team$/i.test(flagWho) ? flagWho : "",
      pm && `${pm[3]} yards`, /declined/.test(txt) ? "declined" : /offsetting/.test(txt) ? "offsetting" : /no play/.test(txt) ? "no play" : ""].filter(Boolean).join(" · "))}"`;
    const flagHit = (x, y) => `<rect x="${x - 22}" y="${y - 22}" width="44" height="44" fill="transparent"/>`; // easier to hit than the 16-px flag
    const flagOnField = isFlag ? `<g${flagTag}>${flagHit(X(from) + (String(play.start?.team?.id) === String(home.team.id) ? 1 : -1) * 18, 176)}${flagSprite(X(from) + (String(play.start?.team?.id) === String(home.team.id) ? 1 : -1) * 18, 176)}</g>` : "";

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
        ? `<g>${formation(from, pteam, pdir, offField, exitLen, 0, castPlay(pteam, dteam))}<g>${pig}<animate attributeName="opacity" from="1" to="0" begin="${D}s" dur=".2s" fill="freeze"/><set attributeName="visibility" to="hidden" begin="${D + 0.2}s" fill="freeze"/></g>
            <animate attributeName="opacity" from="1" to="0" begin="${exitLen}s" dur=".2s" fill="freeze"/><set attributeName="visibility" to="hidden" begin="${exitLen + 0.2}s" fill="freeze"/></g>`
        : `<g>${formation(from, pteam, pdir, moves, D, 0, castPlay(pteam, dteam))}${pig}<animate attributeName="opacity" from="1" to="0" begin="${D}s" dur=".2s" fill="freeze"/><set attributeName="visibility" to="hidden" begin="${D + 0.2}s" fill="freeze"/></g>`;
      if (ko) { // kickoff: lined up, the kick, the catch where it landed, the return to where he went down
        const { kd, land, end, returned } = ko, kx = X(from), lx = X(ko.ly), ex2 = X(ko.endYl), kt = pteam, rt = dteam;
        const mover = (x, y, c, flip, who, keys) => `<g>${motion(keys, RT)}${guy(x, y, c, flip, who)}</g>`;
        const retName = (new RegExp(`\\.\\s+${NM} (?:to |pushed|ran |for )`).exec(ptxt) || [])[1]; // "...to BUF 4. R.Davis pushed ob at LA 26"
        const tacklers = inPlay.tacklers.map((t) => named(kt, t));
        const stop = returned ? end : land + 0.3, out = [];
        // kicking team: a line across the kick spot, sprint downfield on the kick, close in on the returner
        [30, 55, 80, 105, 130, 170, 195, 220, 245, 270].forEach((y, i) => {
          const x = kx - kd * 12, mid = x + (lx - x) * 0.55, near = i >= 3 && i <= 6;
          const fx = returned ? ex2 - kd * (14 + (i % 3) * 16) : lx - kd * (70 + (i % 4) * 25), fy = returned ? y + (150 - y) * (near ? 0.85 : 0.45) : y;
          out.push(mover(x, y, kt, kd < 0, near ? tacklers[i - 3] || null : null, [[0.6, 0, 0], [land, mid - x, 0], [stop, fx - x, fy - y]]));
        });
        out.push(mover(kx - kd * 70, 150, kt, kd < 0, pick(kt, ["pk"]), [[0.6, kd * 64, 0], [stop, kd * 64 + (returned ? (ex2 - kx) * 0.45 : 40), 0]])); // the kicker
        // return team: front lines drop back and block, two deep: one fields it and runs it back, the other leads the way
        const blockers = [...[60, 105, 150, 195, 240].map((y) => [kx + kd * 150, y]), ...[90, 150, 210].map((y) => [kx + kd * 350, y])];
        blockers.forEach(([x, y], i) => {
          const fx = returned ? ex2 - kd * (6 + (i % 2) * 10) : x + kd * 60, fy = returned ? y + (150 - y) * 0.4 : y;
          out.push(mover(x, y, rt, kd > 0, null, [[0.6, 0, 0], [land, kd * 50, 0], [stop, fx - x, fy - y]]));
        });
        const deep = X(kd > 0 ? 95 : 5), retWho = named(rt, retName) || pick(rt, ["kr"], 0);
        out.push(mover(deep, 120, rt, kd > 0, retWho, [[land, lx - deep, 30], ...(returned ? [[end, ex2 - deep, 30]] : [])]));
        out.push(mover(deep, 180, rt, kd > 0, pick(rt, ["kr"], 1), [[land, lx - deep + kd * 30, -10], ...(returned ? [[end, ex2 - deep - kd * 20, -10]] : [])]));
        // the ball: on the tee, in the air, then carried
        const air = flying(0.6, land - 0.6, `M${kx},150 Q${(kx + lx) / 2},-60 ${lx},150`, returned ? `<set attributeName="opacity" to="0" begin="${land}s" fill="freeze"/>` : "");
        const carried = returned ? `<g opacity="0"><set attributeName="opacity" to="1" begin="${land}s" fill="freeze"/><g transform="translate(${lx} 150)"><g>${ball(0, 0)}${motion([[land, 0, 0], [end, ex2 - lx, 0]], RT)}</g></g></g>` : "";
        const tee = `<g>${r(kx - 3, 156, 6, 6, "#ff8c1a")}<g>${ball(kx, 150)}<set attributeName="opacity" to="0" begin=".6s" fill="freeze"/></g></g>`;
        replay = `<g>${out.join("")}${tee}${air}${carried}<animate attributeName="opacity" from="1" to="0" begin="${RT}s" dur=".2s" fill="freeze"/><set attributeName="visibility" to="hidden" begin="${RT + 0.2}s" fill="freeze"/></g>`;
      }
      if (isFlag) { // a striped ref steps up at the sideline and tosses a fluttering flag to the spot
        const rx = Math.max(130, Math.min(1070, sx + pdir * 40)), land = sx + pdir * 18;
        replay += `<g opacity="0"><set attributeName="opacity" to="1" begin="0s" fill="freeze"/>${refSprite(rx, 30, true)}
          <animate attributeName="opacity" from="1" to="0" begin="2.6s" dur=".3s" fill="freeze"/></g>`;
        replay += `<g opacity="0"${flagTag}>${flagHit(0, 0)}${flagSprite(0, 0)}<set attributeName="opacity" to="1" begin=".35s" fill="freeze"/>
          <animateMotion path="M${rx + 8},24 Q${(rx + land) / 2},-50 ${land},176" begin=".35s" dur=".95s" fill="freeze"/></g>`;
      }
      const big = isTD ? "TOUCHDOWN!" : isFG ? (fgGood ? "IT'S GOOD!" : /blocked/.test(type + txt) ? "BLOCKED!" : "NO GOOD!")
        : isInt ? "PICKED OFF!" : /fumble/.test(type + txt) && /recover/.test(txt) ? "FUMBLE!" : isSack ? "SACK!" : /safety/.test(type + txt) ? "SAFETY!"
          : isFlag ? "FLAG!" : incomplete ? "INCOMPLETE" : /touchback/.test(txt) ? "TOUCHBACK" : /fair catch/.test(txt) ? "FAIR CATCH"
            : isKneel ? "TAKE A KNEE" : isSpike ? "SPIKE!" : play.end?.down === 1 && (play.start?.down || 0) > 0 && moved && !isKick ? "FIRST DOWN!" : "";
      const sub = big === "FLAG!" ? flagInfo : "";
      if (big) {
        banner = `<g opacity="0"><rect x="@BX0@" y="${sub ? 92 : 105}" width="@BW@" height="${sub ? 116 : 90}" fill="#000" opacity=".78"/>
          <text x="@BXC@" y="${sub ? 136 : 152}" class="tf-big">${big}</text>${sub ? `<text x="@BXC@" y="182" class="tf-sub">${esc(sub)}</text>` : ""}
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.85;1" begin="${big === "FLAG!" ? 1.3 : ko ? (ko.returned || isTD ? RT - 0.4 : ko.land + 0.1) : 2}s" dur="${sub ? 2.6 : 2}s" fill="freeze"/></g>`;
      }
      if (pat && scorer) { // the try: extra point through the posts, or a two-point run / pass at the goal line
        const sd = scorer === home ? 1 : -1, goal = sd > 0 ? 100 : 0;
        const los = goal - sd * (pat.kind === "xp" ? (league === "nfl" ? 15 : 3) : league === "nfl" ? 2 : 3), lx = X(los), t0 = PAT_AT + SHIFT;
        const holdX = lx - sd * 70, posts = sd > 0 ? 1190 : 10, inEZ = X(goal + sd * 4);
        const patMoves = (role, x, y, isOff) => {
          if (pat.kind === "xp") return isOff ? (role === "qb" ? [[0.4, holdX - x, 0]] : role === "rb" ? [[0.4, holdX - sd * 20 - x, 0], [0.55, holdX - x, 0]] : null)
            : role === "dl" ? [[0.6, -sd * 12, 0]] : null;
          if (!pat.pass) return isOff ? (role === "rb" ? [[0.6, lx - sd * 30 - x, 150 - y], [1.4, (pat.good ? inEZ : lx + sd * 5) - x, 150 - y]] : [[0.8, sd * 12, 0]])
            : [[1.4, ((pat.good ? inEZ : lx + sd * 6) - x) * 0.6, (150 - y) * 0.6]];
          return isOff ? (role === "qb" ? [[0.8, -sd * 40, 0]] : role === "wr" ? [[1.4, inEZ - x, 100 - y]] : [[0.8, -sd * 8, 0]])
            : [[1.4, (inEZ - x) * 0.6, (100 - y) * 0.5]];
        };
        const pball = pat.kind === "xp"
          ? `<g transform="translate(${lx} 150)"><g>${ball(0, 0)}${motion([[0.4, holdX - lx, 0]], 0.6, t0)}<set attributeName="opacity" to="0" begin="${t0 + 0.6}s" fill="freeze"/></g></g>`
            + flying(t0 + 0.6, 1.0, `M${holdX},150 Q${(holdX + posts) / 2},-30 ${posts},${pat.good ? 150 : 70}`)
          : pat.pass
            ? `<g transform="translate(${lx} 150)"><g>${ball(0, 0)}${motion([[0.8, -sd * 50, 0]], 0.9, t0)}<set attributeName="opacity" to="0" begin="${t0 + 0.9}s" fill="freeze"/></g></g>`
              + flying(t0 + 0.9, 0.55, `M${lx - sd * 50},150 Q${(lx + inEZ) / 2},40 ${pat.good ? inEZ : inEZ + sd * 20},${pat.good ? 100 : 160}`)
            : `<g transform="translate(${lx} 150)"><g>${ball(0, 0)}${motion([[0.6, -sd * 30, 0], [1.4, (pat.good ? inEZ : lx + sd * 5) - lx + sd * 10, 0]], 1.5, t0)}</g></g>`;
        replay += `<g opacity="0" visibility="hidden"><set attributeName="visibility" to="visible" begin="${t0}s" fill="freeze"/><set attributeName="opacity" to="1" begin="${t0}s" fill="freeze"/>${formation(los, scorer, sd, patMoves, PAT_LEN, t0)}${pball}
          <animate attributeName="opacity" from="1" to="0" begin="${t0 + PAT_LEN}s" dur=".2s" fill="freeze"/><set attributeName="visibility" to="hidden" begin="${t0 + PAT_LEN + 0.2}s" fill="freeze"/></g>`;
        const word = pat.kind === "xp" ? (pat.good ? "IT'S GOOD!" : "NO GOOD!") : pat.good ? "2 PT GOOD!" : "2 PT FAILS";
        banner += `<g opacity="0"><rect x="@BX0@" y="105" width="@BW@" height="90" fill="#000" opacity=".78"/><text x="@BXC@" y="152" class="tf-big">${word}</text>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.85;1" begin="${t0 + 1.4}s" dur="1.5s" fill="freeze"/></g>`;
      }
    }

    // phones: frame the action (old spot, new spot, first-down line) instead of all 120 yards; kickoffs and scores stay full
    let vbX = 0, vbW = 1200;
    if (typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches && !kicker && !ko) {
      const xs = [X(spot), X(from), fd != null ? X(fd) : X(spot)];
      const lo = Math.min(...xs) - 220, hi = Math.max(...xs) + 220;
      vbW = Math.min(1200, Math.max(640, hi - lo));
      vbX = Math.max(0, Math.min(1200 - vbW, (lo + hi) / 2 - vbW / 2));
    }
    const teamTag = (c) => `<span class="tf-team" style="--c:${col(c)}">${img(teamLogo(c.team), "xs")}${esc(c.team.abbreviation || "")}</span>`;
    const where = kicker ? `${esc(kicker.team.abbreviation || "")} KICKS OFF` : at.possessionText ? `BALL ON ${esc(at.possessionText)}` : "";
    const ddText = isTD ? "TOUCHDOWN!" : down ? `${["", "1ST", "2ND", "3RD", "4TH"][down]} & ${dist < toGo ? dist : "GOAL"}` : "";
    const lastText = play?.text ? play.text.trim() : "";
    // the play clock isn't running during a timeout, the two-minute warning, between quarters or at halftime:
    // when the latest entry in the feed is one of those, stop the bar and say why (until the next real play comes in)
    const stName = comp?.status?.type?.name, tId = String(play?.type?.id || ""), stopTxt = play?.text || "";
    const to = stopTxt.match(/Timeout #(\d+) by ([A-Za-z]{2,4})/), toTeam = to && (ABBR_ALIAS[to[2].toUpperCase()] || to[2].toUpperCase());
    const brk = stName === "STATUS_HALFTIME" || tId === "65" ? "HALFTIME"
      : stName === "STATUS_END_PERIOD" || tId === "2" ? (stName === "STATUS_END_PERIOD" && comp.status.type.shortDetail || "END OF QUARTER").toUpperCase()
      : tId === "21" ? (to ? `TIMEOUT · ${toTeam} (#${to[1]})` : "TIMEOUT")
      : tId === "74" ? (/injur/i.test(stopTxt) ? "INJURY TIMEOUT" : "OFFICIAL TIMEOUT")
      : tId === "75" ? "TWO-MINUTE WARNING" : "";
    return `<div class="card tecmo" data-play="${esc(play.id)}" style="--tf-font:'${PIXEL_FONT}'">
      <div class="tf-bar">
        <span>${off ? teamTag(off) + `<b class="tf-arrow">${dir > 0 ? "▶" : "◀"}</b>` : ""}</span>
        <span class="tf-dd">${ddText}</span>
        <span class="tf-where">${where}${toGo <= 20 && off && !isTD ? ` <b class="tf-red">RED ZONE</b>` : ""}</span>
      </div>
      <div class="tf-wrap" data-gid="${esc(gameId)}"><div class="tf-tip hidden"></div>${replayMode ? "" : (final ? hlButton(final) : replayMenu(s)) + zoomButtons}<div class="tf-cap hidden"></div><div class="tf-zm">
      <svg class="tf-field" viewBox="${vbX.toFixed(0)} 0 ${vbW.toFixed(0)} ${H}" shape-rendering="crispEdges" role="img"
        aria-label="${esc([off ? `${off.team.abbreviation} ball` : "", ddText, where].filter(Boolean).join(", "))}">${base.join("")}${lines}${lineup}${anim ? "" : flagOnField}${replay}${banner.replace(/@BX0@/g, (vbX + vbW / 2 - Math.min(700, vbW - 40) / 2).toFixed(0)).replace(/@BW@/g, Math.min(700, vbW - 40).toFixed(0)).replace(/@BXC@/g, (vbX + vbW / 2).toFixed(0))}</svg></div></div>
      ${final ? `<p class="tf-hlnote"><b>FINAL</b> ${final.length ? `Tap PLAY HIGHLIGHTS to watch the game's top ${final.length} plays.` : ""}</p>`
        : brk ? `<div class="tf-clock" title="The play clock is stopped"><span class="tf-clabel"><b class="tf-stop">${esc(brk)}</b></span><span class="tf-track"><i class="stop"></i></span></div>`
        : `<div class="tf-clock" title="A rough 40-second play clock from when the last play reached us. ESPN's feed often runs 30+ seconds behind the stadium, so it can run out before the next play shows up. The field checks for a new play every 5 seconds and replays it as soon as it arrives">
        <span class="tf-clabel" style="--d:${Math.max(0, 40 - since).toFixed(1)}s"><b>PLAY CLOCK</b><b class="tf-wait">WAITING ON NEXT PLAY</b></span><span class="tf-track"><i style="animation-delay:-${Math.min(since, 40).toFixed(1)}s"></i></span></div>`}
      <div class="tf-key"><span><i style="background:#3d7bff"></i>Line of scrimmage</span>${fd != null ? `<span><i style="background:#ffd21f"></i>First down</span>` : ""}
        ${drive?.description && !newDrive ? `<span class="muted">This drive: ${esc(drive.description)}</span>` : ""}</div>
      ${lastText ? `<p class="tf-last"><b>LAST PLAY</b> ${esc(lastText)}</p>` : ""}
    </div>`;
  }

  // The live field comes in two looks (picked above it, remembered in "gamecast-view"): the 8-bit field above, or
  // "clean": a flat field strip and the drive's plays, drawn only with the theme's own colors and fonts (Settings > Theme)
  const GCV = [["clean", "Default"], ["8bit", "8-bit"]];
  const gcvMode = () => (store.get("gamecast-view") === "8bit" ? "8bit" : "clean"); // "Default" unless you picked 8-bit
  // the Clean field's ball, drawn in the theme's own colors: card-colored body with an accent outline, seam and stripes,
  // laces in the text color that roll over the top like a spiral, and a soft accent shine for depth
  const FOOTBALL = `<svg viewBox="0 0 60 36" aria-hidden="true"><defs><radialGradient id="gcv-lth" cx="40%" cy="26%" r="75%"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.55"/><stop offset=".6" style="stop-color:var(--accent);stop-opacity:.12"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></radialGradient>
    <clipPath id="gcv-bc"><path d="M3 18 Q30 -5 57 18 Q30 41 3 18Z"/></clipPath></defs>
    <path d="M3 18 Q30 -5 57 18 Q30 41 3 18Z" style="fill:var(--card)"/><path d="M3 18 Q30 -5 57 18 Q30 41 3 18Z" fill="url(#gcv-lth)"/>
    <g clip-path="url(#gcv-bc)"><path d="M6 22 Q30 31 54 22" style="fill:none;stroke:var(--accent);stroke-width:1;opacity:.45"/>
    <rect x="12" y="0" width="2.4" height="36" style="fill:var(--accent);opacity:.8"/><rect x="45.6" y="0" width="2.4" height="36" style="fill:var(--accent);opacity:.8"/>
    <g class="gcv-lace" style="fill:var(--ink)"><rect x="21" y="16.6" width="18" height="1.8" rx=".9"/>${[23, 26.5, 30, 33.5, 37].map((x) => `<rect x="${x - 0.6}" y="14.8" width="1.2" height="5.4" rx=".6"/>`).join("")}</g></g>
    <path d="M3 18 Q30 -5 57 18 Q30 41 3 18Z" style="fill:none;stroke:var(--accent);stroke-width:1.6"/></svg>`;
  // pinch-zoom and drag on the Clean field (phones), kept per game through the refresh; double-tap resets
  const gcvZoom = new Map(); // game id -> {s, x, y}
  // (the field is redrawn wider rather than stretched, so it stays sharp; its box keeps the height it had before zooming)
  const zoomStyle = (gid) => { const z = gcvZoom.get(gid); return z && z.s > 1 ? `--zs:${z.s.toFixed(3)};--zx:${z.x.toFixed(1)}px;--zy:${z.y.toFixed(1)}px` : ""; };
  const standsStyle = (gid) => { const z = gcvZoom.get(gid); return z && z.s > 1 && z.h ? `height:${z.h}px` : ""; };
  const gcvOpen = new Set(); // play-by-play drives you opened (kept open through the refresh)
  const gcvReplay = new Map();
  const gcvPause = new Map(); // game id -> { at, left }: replay paused at this time, with this long left before the next play
  const gcvStep = new Map();  // game id -> { fn, start, wait }: the replay's next step (so a pause can hold it)
  let gcvSpeed = store.get("gamecast-speed") === 2 ? 2 : 1; // replay speed // game id -> play id being replayed in the Clean view (until "Back to live")
  const gcvTip = new Map(); // game id -> the sim-line play being looked at (kept through the refresh every few seconds)
  // end zone logo: ESPN's version made to sit on the team's own color, else the dark-background one (dark mode), else the usual one
  const ezLogo = (t) => {
    const L = t?.logos || [], has = (r) => L.find((l) => (l.rel || []).includes(r))?.href;
    return has("primary_logo_on_primary_color") || (document.documentElement.dataset.theme === "dark" && has("dark")) || teamLogo(t);
  };
  const gcvSeen = new Map(); // game id -> {play, spot} last drawn (so a new play slides in from the old spot)
  const gcvCtx = new Map(); // game id -> latest fieldView arguments (to redraw right away when the look changes)
  function fieldView(s, comp, home, away, tc, gameId, people, final) {
    gcvCtx.set(gameId, [s, comp, home, away, tc, gameId, people, final]);
    // replaying a play from the play-by-play: draw the game as it stood right after it (the list stays the whole game)
    const rp = gcvReplay.get(gameId), sv = (rp && upToPlay(s, rp)) || s;
    const mode = gcvMode(), html = mode === "clean" ? (cleanField(sv, comp, home, away, gameId, null, s, rp && sv !== s ? rp : null) || (final ? cleanField(s, comp, home, away, gameId, final) : "")) : liveField(s, comp, home, away, tc, gameId, people, false, final);
    if (!html) return "";
    return `<div class="gcv-wrap${gcvPause.has(gameId) ? " paused" : ""}" data-gid="${esc(gameId)}"><div class="presets gcv-pick"><span class="muted">Field:</span>${GCV.map(([k, t]) =>
      `<button type="button" data-gcv="${k}" class="${k === mode ? "on" : ""}" aria-pressed="${k === mode}">${t}</button>`).join("")}</div>${html}</div>`;
  }
  let gcvWired = false;
  function wireGcv() {
    if (gcvWired) return;
    gcvWired = true;
    // sim lines: hovering (or tapping) a bar shows that play under the field
    const simTip = (g) => {
      const card = g?.closest(".gcv") || document.querySelector(".gcv"), tip = card?.querySelector(".gcv-tip");
      card?.querySelectorAll(".gcv-sim.on").forEach((x) => x !== g && x.classList.remove("on"));
      if (!tip) return;
      const gid = card.closest(".gcv-wrap")?.dataset.gid;
      if (g) { g.classList.add("on"); tip.textContent = g.dataset.tip; tip.hidden = false; gcvTip.set(gid, g.dataset.tip); } else { tip.hidden = true; gcvTip.delete(gid); }
    };
    document.addEventListener("mouseover", (e) => { const g = e.target.closest?.(".gcv-sim"); if (g || e.target.closest?.(".gcv-field")) simTip(g); });
    document.addEventListener("mouseleave", (e) => { if (e.target.classList?.contains("gcv-field")) simTip(null); }, true);
    document.addEventListener("click", (e) => { const g = e.target.closest?.(".gcv-sim"); if (g) simTip(g); else if (e.target.closest?.(".gcv-field")) simTip(null); });
    const redraw = (wrap) => {
      const args = gcvCtx.get(wrap.dataset.gid);
      if (!args) return;
      const top = wrap.querySelector(".gcv-pbp")?.scrollTop || 0, t = document.createElement("template");
      t.innerHTML = fieldView(...args);
      const nw = t.content.firstElementChild;
      wrap.replaceWith(t.content);
      const pbp = nw?.querySelector(".gcv-pbp");
      if (pbp) pbp.scrollTop = top;
    };
    // pinch (two fingers) zooms around the fingers, one finger drags once zoomed, double-tap goes back to the whole field
    let zs = null, lastTap = 0;
    const zClamp = (st, z) => {
      const w = st.clientWidth, h = st.clientHeight;
      z.s = Math.min(4, Math.max(1, z.s));
      if (z.s <= 1.02) return Object.assign(z, { s: 1, x: 0, y: 0 });
      z.x = Math.min(0, Math.max(w - w * z.s, z.x)); z.y = Math.min(0, Math.max(h - h * z.s, z.y));
      return z;
    };
    const zApply = (st, gid, z) => {
      z.h = z.s > 1 ? gcvZoom.get(gid)?.h || st.offsetHeight : 0;
      gcvZoom.set(gid, z);
      st.style.height = z.h ? `${z.h}px` : "";
      const zm = st.querySelector(".gcv-zoom");
      zm?.setAttribute("style", zoomStyle(gid));
      st.classList.toggle("zoomed", z.s > 1);
    };
    const tp = (t, st) => { const r = st.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
    document.addEventListener("touchstart", (e) => {
      const st = e.target.closest?.(".gcv-stands"), gid = st?.closest(".gcv-wrap")?.dataset.gid;
      if (!st) return;
      const z = { s: 1, x: 0, y: 0, ...gcvZoom.get(gid) };
      if (e.touches.length === 2) {
        const [a, b] = [tp(e.touches[0], st), tp(e.touches[1], st)];
        zs = { st, gid, pinch: true, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, z };
        e.preventDefault();
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300 && z.s > 1) { zApply(st, gid, { s: 1, x: 0, y: 0 }); zs = null; e.preventDefault(); lastTap = 0; return; }
        lastTap = now;
        if (z.s > 1) { const [x, y] = tp(e.touches[0], st); zs = { st, gid, pinch: false, px: x, py: y, z }; }
      }
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
      if (!zs) return;
      const { st, gid, z } = zs;
      if (zs.pinch && e.touches.length === 2) {
        const [a, b] = [tp(e.touches[0], st), tp(e.touches[1], st)], s2 = Math.min(4, Math.max(1, z.s * (Math.hypot(a[0] - b[0], a[1] - b[1]) / zs.d)));
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        zApply(st, gid, zClamp(st, { s: s2, x: mx - (zs.cx - z.x) * (s2 / z.s), y: my - (zs.cy - z.y) * (s2 / z.s) }));
      } else if (!zs.pinch && e.touches.length === 1) {
        const [x, y] = tp(e.touches[0], st);
        zApply(st, gid, zClamp(st, { s: z.s, x: z.x + x - zs.px, y: z.y + y - zs.py }));
      } else return;
      e.preventDefault();
    }, { passive: false });
    document.addEventListener("touchend", (e) => { if (zs && e.touches.length === 0) zs = null; });
    // remember which past drives are open in the play-by-play
    document.addEventListener("toggle", (e) => {
      const d = e.target.closest?.("details[data-dk]");
      if (!d || d.closest(".gcv-drv.cur")) return;
      d.open ? gcvOpen.add(d.dataset.dk) : gcvOpen.delete(d.dataset.dk);
    }, true);
    // click a play in the play-by-play to replay it on the field; "Back to live" returns
    document.addEventListener("click", (e) => {
      const li = e.target.closest?.(".gcv-plays li[data-pid], .gcv-sim[data-pid]"), live = e.target.closest?.("[data-gcvlive]"), wrap = (li || live)?.closest(".gcv-wrap");
      if (!wrap) return;
      const gid = wrap.dataset.gid;
      clearTimeout(gcvSeq.get(gid));
      gcvPause.delete(gid);
      if (live) { gcvReplay.delete(gid); gcvSeen.delete(gid); return redraw(wrap); }
      replayFrom(gid, li.dataset.pid, true);
    });
    // replay a play, then every play after it in order (each animating from where the last ended); back to live once caught up
    const gcvSeq = new Map(); // game id -> timer for the next replayed play
    // Watch from kickoff (finished games) and the 1x / 2x replay speed
    document.addEventListener("click", (e) => {
      const from = e.target.closest?.("[data-gcvfrom]"), spd = e.target.closest?.("[data-gcvspd]"), wrap = (from || spd)?.closest(".gcv-wrap");
      if (!wrap) return;
      if (spd) { gcvSpeed = +spd.dataset.gcvspd === 2 ? 2 : 1; store.set("gamecast-speed", gcvSpeed); return redraw(wrap); }
      const s0 = gcvCtx.get(wrap.dataset.gid)?.[0], first = [...(s0?.drives?.previous || []), ...(s0?.drives?.current ? [s0.drives.current] : [])]
        .flatMap((d) => d.plays || []).find((x) => x.text && !NOT_A_PLAY.has(String(x.type?.id || "")));
      if (first) { clearTimeout(gcvSeq.get(wrap.dataset.gid)); gcvPause.delete(wrap.dataset.gid); replayFrom(wrap.dataset.gid, first.id, true); }
    });
    // Pause / Play during a replay: the animations freeze where they are (CSS) and the next play waits
    document.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-gcvpause]"), wrap = b?.closest(".gcv-wrap");
      if (!wrap) return;
      const gid = wrap.dataset.gid, now = Date.now(), st = gcvStep.get(gid), ps = gcvPause.get(gid);
      if (ps) { // play: shift the play's clock by the time spent paused so it carries on from the same frame
        gcvPause.delete(gid);
        const seen = gcvSeen.get(gid);
        if (seen) { if (seen.at) seen.at += now - ps.at; if (seen.patAt) seen.patAt += now - ps.at; }
        if (st) { st.start = now; st.wait = ps.left; gcvSeq.set(gid, setTimeout(st.fn, ps.left)); }
        wrap.classList.remove("paused");
      } else {
        clearTimeout(gcvSeq.get(gid));
        gcvPause.set(gid, { at: now, left: st ? Math.max(0, st.wait - (now - st.start)) : 0 });
        wrap.classList.add("paused");
      }
      b.innerHTML = gcvPause.has(gid) ? "▶ Play" : "❚❚ Pause";
      b.setAttribute("aria-pressed", gcvPause.has(gid));
    });
    const replayFrom = (gid, pid, first) => {
      const s0 = gcvCtx.get(gid)?.[0], all = [...(s0?.drives?.previous || []), ...(s0?.drives?.current ? [s0.drives.current] : [])]
        .flatMap((d) => d.plays || []).filter((x) => x.text && !NOT_A_PLAY.has(String(x.type?.id || "")))
        .filter((x, k, arr) => arr.findIndex((y) => String(y.id) === String(x.id)) === k); // each play once (ESPN can list a drive twice)
      const i = all.findIndex((x) => String(x.id) === String(pid)), p = all[i], wrap = document.querySelector(`.gcv-wrap[data-gid="${gid}"]`);
      if (!p || !wrap) return;
      if (first) gcvSeen.set(gid, { play: "replay", spot: p.start?.yardLine ?? p.end?.yardLine }); // the first one starts where the play started
      gcvReplay.set(gid, String(p.id));
      redraw(wrap);
      const nx = all[i + 1], base = /touchdown/i.test(p.text) ? 6200 : /kickoff/i.test(p.type?.text || "") ? 4600 : 3800;
      // 2x: less time between plays (each animation still finishes; a touchdown waits for its extra point or two-point try)
      const wait = gcvSpeed === 2 ? Math.max(base * 0.55, /two-point conversion/i.test(p.text) ? 5600 : /touchdown/i.test(p.text) ? 4800 : 2000) : base;
      const step = () => {
        if (gcvReplay.get(gid) !== String(p.id) || gcvPause.has(gid)) return; // stopped, paused, or another play was picked
        if (nx) return replayFrom(gid, nx.id, false);
        gcvReplay.delete(gid); // caught up: back to live
        const w = document.querySelector(`.gcv-wrap[data-gid="${gid}"]`);
        if (w) redraw(w);
      };
      gcvStep.set(gid, { fn: step, start: Date.now(), wait });
      gcvSeq.set(gid, setTimeout(step, wait));
    };
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gcv]"), wrap = b?.closest(".gcv-wrap");
      if (!wrap || b.dataset.gcv === gcvMode()) return;
      stopReplay?.();
      store.set("gamecast-view", b.dataset.gcv);
      const args = gcvCtx.get(wrap.dataset.gid);
      if (!args) return;
      const t = document.createElement("template");
      t.innerHTML = fieldView(...args);
      wrap.replaceWith(t.content);
      const tfWrap = view("game").querySelector(".tecmo .tf-wrap");
      if (tfWrap) { wireFieldZoom(); applyZoom(tfWrap); }
    });
  }
  function cleanField(s, comp, home, away, gameId, final, live = s, replaying = null) {
    const drives = s.drives || {}, drive = drives.current || (drives.previous || []).at(-1), play = drive?.plays?.at(-1);
    const ab = (c) => esc(c?.team?.abbreviation || "");
    const dd = (p) => { const x = p?.start || {}; return x.down >= 1 && x.down <= 4 ? `${["", "1st", "2nd", "3rd", "4th"][x.down]} & ${x.distance}` : ""; };
    const clean = (t) => (t || "").trim().replace(/^(\([^)]*\)\s*)+/, "");
    if (final) { // after the final: the game's top plays as a list
      if (!final.length) return "";
      return `<div class="card gcv"><div class="gcv-bar"><b>FINAL</b><span class="muted">Top plays</span></div>
        <ol class="gcv-plays">${final.map(({ p, kind }) => `<li><span class="gcv-k">${esc(kind.toLowerCase())}</span><span class="muted">Q${esc(p.period?.number || "")} ${esc(p.clock?.displayValue || "")}</span> ${esc(clean(p.text))}</li>`).join("")}</ol></div>`;
    }
    const spot = play?.end?.yardLine ?? play?.start?.yardLine;
    if (spot == null) return "";
    const at = play.end?.down ? play.end : play.start?.down ? play.start : play.end || {};
    const possId = String(play.end?.team?.id || comp.competitors.find((c) => c.possession)?.team?.id || at.team?.id || drive.team?.id || "");
    const newDrive = !!drive?.team?.id && String(drive.team.id) !== possId;
    const off = String(home.team.id) === possId ? home : String(away.team.id) === possId ? away : null;
    const dir = off === home ? 1 : off === away ? -1 : 0, toGo = dir > 0 ? 100 - spot : spot;
    // (a play from the scoreboard feed may not be marked as scoring yet, so the word TOUCHDOWN counts too)
    const isTD = (!!play.scoringPlay || /TOUCHDOWN/.test(play.text || "")) && /touchdown/i.test(`${play.type?.text || ""} ${play.text || ""}`) && !/nullified|no play/i.test(play.text || "");
    const down = at.down >= 1 && at.down <= 4 && !isTD ? at.down : 0, dist = down ? at.distance || 0 : 0;
    const fd = down && dist && dist < toGo ? spot + dir * dist : null;
    const X = (yl) => 100 + yl * 10, H = 320, pct = (x) => `${(x / 12).toFixed(2)}%`;
    // the drive so far, from its first snap (not the kickoff or punt that started it)
    const snap1 = newDrive ? null : (drive?.plays || []).find((p) => p.start?.yardLine != null && !/kickoff|punt/i.test(p.type?.text || "") && !NOT_A_PLAY.has(String(p.type?.id || "")));
    const start = snap1?.start?.yardLine;
    // a new play: the ball, the lines and the drive bar slide over from where they were (same play on a refresh: no motion)
    // a new play animates; a refresh within 2 seconds picks the animation up where it was (instead of cutting it off)
    const seen = gcvSeen.get(gameId), isNew = !!seen && seen.play !== String(play.id);
    const resume = !isNew && !!seen?.at && Date.now() - seen.at < 2000, freshPlay = isNew || resume;
    const prevSpot = isNew ? seen.spot : resume ? seen.from : null, moved = freshPlay && prevSpot != null && prevSpot !== spot;
    const prevFd = isNew ? seen.fd : resume ? seen.fromFd : null;
    // ESPN often posts the touchdown first and adds "extra point is GOOD" to the same play a little later: kick it when it shows up
    const samePlay = !!seen && seen.play === String(play.id), hasPat = isTD && /extra point is (good|no good)/i.test(play.text || "");
    const patAt = hasPat ? (samePlay && seen.patAt) || Date.now() : 0, patLate = hasPat && (samePlay ? !seen.patAt || !!seen.patLate : false);
    const patSince = patAt ? (Date.now() - patAt) / 1000 : 99;
    gcvSeen.set(gameId, { play: String(play.id), spot, fd, from: prevSpot, fromFd: prevFd, at: isNew ? Date.now() : resume ? seen.at : 0, patAt, patLate });
    // the first-down marker moves after the ball (and the line of scrimmage) get there: slide from the old marker, or fade in for a new set of downs
    // (no saved marker, e.g. a replay: work it out from where the play started, "2nd & 7 at the LA 40")
    const st0 = play.start || {}, d0 = String(st0.team?.id || "") === String(home.team.id) ? 1 : String(st0.team?.id || "") === String(away.team.id) ? -1 : 0;
    const fd0 = prevFd ?? (st0.down >= 1 && st0.down <= 4 && st0.distance && d0 && st0.yardLine != null ? st0.yardLine + d0 * st0.distance : null);
    const fdMove = freshPlay && fd != null && /kickoff/i.test(play.type?.text || "") ? ' class="gcv-fdin"' : freshPlay && fd != null && fd0 != null && fd0 !== fd ? ` class="gcv-slide fd" style="--dx:${X(fd0) - X(fd)}px"` : "";
    const el = resume ? (gcvPause.get(gameId)?.at || Date.now()) - seen.at : 0; // ms already played (frozen while paused)
    const dx = moved ? X(prevSpot) - X(spot) : 0;
    const svg = [`<defs><filter id="gcv-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="1200" height="${H}"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <linearGradient id="gcv-dg"${dir < 0 ? ' x1="1" x2="0"' : ""}><stop offset="0" style="stop-color:var(--accent);stop-opacity:0"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:.32"/></linearGradient>
      <radialGradient id="gcv-light" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`,
      `<rect class="gcv-turf" x="100" y="0" width="1000" height="${H}"/>`];
    for (let i = 0; i < 10; i += 2) svg.push(`<rect class="gcv-band" x="${X(i * 10)}" y="0" width="100" height="${H}"/>`);
    for (const [c, x0] of [[home, 0], [away, 1100]]) {
      // each end zone: the team's color, deepest at the back line and fading toward the goal line, a thin border in it,
      // and their logo turned to read from the sideline (the team's own version made to sit on their color)
      const tz = teamColor(c.team), rot = `rotate(${x0 ? 90 : -90} ${x0 + 50} ${H / 2})`;
      svg.push(`<linearGradient id="gcv-ezg-${x0}" x1="${x0 ? 1 : 0}" x2="${x0 ? 0 : 1}"><stop offset="0" style="stop-color:${tz};stop-opacity:.55"/><stop offset="1" style="stop-color:${tz};stop-opacity:.18"/></linearGradient>
        <rect class="gcv-ez${isTD && (x0 ? spot >= 50 : spot < 50) ? " td" : ""}" x="${x0}" y="0" width="100" height="${H}" style="--tz:${tz}"/>
        <rect x="${x0}" y="0" width="100" height="${H}" fill="url(#gcv-ezg-${x0})"/>
        <rect class="gcv-ezline" x="${x0 + 5}" y="5" width="90" height="${H - 10}" style="stroke:${tz}"/>
        <image class="gcv-ezlogo" href="${esc(ezLogo(c.team))}" x="${x0 + 2}" y="${H / 2 - 48}" width="96" height="96" transform="${rot}"/>`);
    }
    if (off && toGo <= 20 && !isTD) svg.push(`<rect class="gcv-rzone" x="${dir > 0 ? X(80) : X(0)}" y="0" width="200" height="${H}"/>`); // red zone glows
    for (let yl = 0; yl <= 100; yl += 10) svg.push(`<line class="gcv-yl${yl === 50 ? " mid" : ""}${yl % 100 ? "" : " goal"}" x1="${X(yl)}" x2="${X(yl)}" y1="0" y2="${H}"/>`);
    // a tick for every yard along both sidelines (longer every 5), so the exact first-down spot can be read
    for (let yl = 1; yl < 100; yl++) if (yl % 10) {
      const len = yl % 5 ? 9 : 16;
      svg.push(`<line class="gcv-tick" x1="${X(yl)}" x2="${X(yl)}" y1="0" y2="${len}"/><line class="gcv-tick" x1="${X(yl)}" x2="${X(yl)}" y1="${H - len}" y2="${H}"/>`);
    }
    for (let yl = 10; yl <= 90; yl += 10) svg.push(`<text class="gcv-num" x="${X(yl)}" y="${H - 22}">${yl > 50 ? 100 - yl : yl}</text>`);
    svg.push(`<rect x="0" y="0" width="1200" height="${H}" fill="url(#gcv-light)"/>`); // stadium lights
    const slide = moved ? ` class="gcv-slide" style="--dx:${dx}px"` : "";
    // small pointers on both sidelines: white at the ball, accent at the first-down spot
    const ptr = (x, cls) => `<path class="gcv-ptr ${cls}" d="M${x - 9} 0 h18 l-9 14 z"/><path class="gcv-ptr ${cls}" d="M${x - 9} ${H} h18 l-9 -14 z"/>`;
    if (!isTD) svg.push(`<g${slide}>${ptr(X(spot), "los")}</g>`);
    // sim lines: the drive's plays as bars from where each started to where it ended (hover or tap one for the play)
    const sims = newDrive ? [] : (drive?.plays || []).filter((p) => p.start?.yardLine != null && p.end?.yardLine != null && p.text
      && !NOT_A_PLAY.has(String(p.type?.id || "")) && !/kickoff|punt/i.test(p.type?.text || "")).slice(-14); // the whole drive (lanes get thinner as it grows)
    const laneH = (H - 120) / Math.max(sims.length, 4);
    // one shape per play: rounded where it started, tapering to a point where it ended (a dot for no gain)
    const simPath = (a, b, y, h) => {
      const r = h / 2, cy = y + r;
      if (a === b) return `M${a - h} ${cy} a${h} ${h} 0 1 0 ${h * 2} 0 a${h} ${h} 0 1 0 ${-h * 2} 0Z`;
      const sd = b > a ? 1 : -1, hl = Math.min(h * 2.6, Math.abs(b - a) * 0.7), hh = h * 1.15, neck = b - sd * hl, st = a + sd * r; // thin shaft, small arrowhead
      return `M${st} ${y} L${neck} ${y} L${neck} ${cy - hh} L${b} ${cy} L${neck} ${cy + hh} L${neck} ${y + h} L${st} ${y + h} A${r} ${r} 0 0 ${sd > 0 ? 1 : 0} ${st} ${y}Z`;
    };
    sims.forEach((p, i) => {
      const a = X(p.start.yardLine), b = X(p.end.yardLine), yds = Math.round((p.end.yardLine - p.start.yardLine) * (dir || 1));
      const y = 30 + i * laneH + laneH * 0.3, h = Math.max(6, laneH * 0.22), x = Math.min(a, b), w = Math.max(8, Math.abs(b - a));
      const cls = yds > 0 ? "gain" : yds < 0 ? "loss" : "none", grow = moved && i === sims.length - 1 ? " grow" : "";
      const tip = `${dd(p) ? dd(p) + ": " : ""}${clean(p.text)}`, on = gcvTip.get(gameId) === tip ? " on" : "";
      const lx = a <= b ? x - 8 : x + w + 8, anchor = a <= b ? "end" : "start"; // label at the start of the bar
      svg.push(`<g class="gcv-sim ${cls}${grow}${on}" data-tip="${esc(tip)}" data-pid="${esc(p.id)}"><rect class="hit" x="${x - 60}" y="${(y + h / 2 - laneH / 2).toFixed(1)}" width="${w + 120}" height="${laneH.toFixed(1)}"/>
        <path class="bar" d="${simPath(a, b, y, h)}" style="transform-origin:${a <= b ? "left" : "right"}"/>
        <text x="${lx}" y="${(y + h / 2).toFixed(1)}" text-anchor="${anchor}" style="--lf:${Math.min(20, laneH * 0.95).toFixed(1)}">${yds > 0 ? "+" : ""}${yds}</text></g>`);
    });
    if (!isTD) svg.push(`<g${slide}><line class="gcv-los" x1="${X(spot)}" x2="${X(spot)}" y1="0" y2="${H}" filter="url(#gcv-glow)"/></g>`);
    if (fd != null) svg.push(`<g${fdMove}><line class="gcv-fd" x1="${X(fd)}" x2="${X(fd)}" y1="0" y2="${H}" filter="url(#gcv-glow)"/>${ptr(X(fd), "fd")}</g>`);
    // standing pieces (real 3D, they stand up off the tilted field): the down box at the ball and the first-down stick
    const from = moved ? ` style="left:${pct(X(spot))};--from:${pct(X(prevSpot))}"` : ` style="left:${pct(X(spot))}"`;
    // how the ball gets to the new spot: passes arc, kicks and punts sail end over end, runs hop along the ground
    // (only the play itself: a touchdown's text goes on with its two-point try, "...TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT.
    // D.Prescott pass to R.Flournoy is incomplete", which must not make a run fly like a pass or the touchdown look incomplete)
    const mainTxt = (play.text || "").split(/two-point conversion attempt/i)[0];
    const ptype = `${play.type?.text || ""} ${mainTxt}`.toLowerCase();
    // an interception: the pass flies to where it was picked ("INTERCEPTED by C.Durde at BUF 44"), then it's run back
    const intAt = /intercept/.test(ptype) ? textSpot((play.text || "").match(/intercepted by .*? at ([A-Z]{2,4} \d{1,2}|50)/i)?.[1], home, away) : null;
    const fly = !moved ? "" : /kickoff/.test(ptype) ? "ko" : intAt != null ? "int" : /punt|kickoff|field goal/.test(ptype) ? "kick" : /\bpass\b/.test(ptype) && !/sack/.test(ptype) ? "pass" : "run";
    // the ball changed hands during the play: the old team's badge rides along, then swaps to the new team when it's caught
    const startC = String(play.start?.team?.id || "") === String(home.team.id) ? home : String(play.start?.team?.id || "") === String(away.team.id) ? away : null;
    const swapAt = { ko: 1.4, int: 1.2, kick: 1.5, pass: 1.1, run: 1 }[fly] || 0;
    const bt = fly === "ko" ? 2.6 : swapAt || 1; // when the ball stops (then the line of scrimmage and the first-down marker move)
    // a kickoff: kicked from the kicking team's spot, into the end zone, then carried out to where the return ended
    const koFrom = play.start?.yardLine, koKd = startC === home ? 1 : startC === away ? -1 : -(dir || 1);
    const badge = (c, cls = "") => `<i class="gcv-poss${cls}" style="--tc:${teamColor(c.team)};--sw:${swapAt}s" title="${ab(c)} has the ball"><img src="${esc(teamLogo(c.team))}" alt="${ab(c)}"></i>`;
    const badges = !off ? "" : fly && startC && startC !== off ? badge(startC, " out") + badge(off, " in") : badge(off);
    // the call for the latest play, shown over the field while it's the newest (it pops in when the play is new)
    const pm = /penalty on ([a-z]{2,4})-[^,]*,\s*([^,]+?),\s*(\d+)\s*yards?/i.exec(play.text || "");
    const isPen = /penalty/.test(ptype), isInc = /incomplete/.test(ptype) && !isPen && !isTD;
    const call = isTD ? "Touchdown"
      : /field goal|extra point/.test(ptype) ? (/no good|missed|blocked/.test(ptype) ? "No good" : "It's good")
      : /intercept/.test(ptype) ? "Intercepted" : /fumble/.test(ptype) && /recover/.test(ptype) ? "Fumble" : /safety/.test(ptype) ? "Safety"
      : isPen ? `Flag${pm ? ` · ${pm[2]} · ${pm[1].toUpperCase()} · ${pm[3]} yds` : ""}${/declined/.test(ptype) ? " · declined" : /offsetting/.test(ptype) ? " · offsetting" : ""}`
      : /sack/.test(ptype) ? "Sack" : isInc ? "Incomplete" : /timeout/.test(ptype) ? "Timeout" : /touchback/.test(ptype) ? "Touchback"
      : /fair catch/.test(ptype) ? "Fair catch" : /turnover on downs/.test(ptype) ? "Turnover on downs"
      : play.end?.down === 1 && (play.start?.down || 0) > 1 && moved && !/punt|kickoff/.test(ptype) ? "First down" : "";
    const callHtml = call ? `<div class="gcv-call${freshPlay ? " pop" : ""}${isPen ? " flag" : ""}">${esc(call)}</div>` : "";
    // where across the field the play went, from the play text: "pass short right", "pass deep left", "left end", "up the middle"...
    // (the offense's left or right; on screen that depends on which way they're going). The ball goes there, then is spotted back.
    const ptx = mainTxt.toLowerCase();
    const pm2 = /pass (?:incomplete )?(short|deep) (left|right|middle)/.exec(ptx);
    const rm2 = /\b(left|right) (end|tackle|guard)\b/.exec(ptx) || (/up the middle|\bmiddle\b/.test(ptx) ? [0, "middle", "guard"] : null);
    const latMag = pm2 ? (pm2[1] === "deep" ? 0.8 : 0.55) : rm2 ? ({ end: 0.85, tackle: 0.45, guard: 0.25 })[rm2[2]] : 0;
    const latSide = pm2 ? pm2[2] : rm2 ? rm2[1] : null;
    const latf = !latSide || latSide === "middle" || !dir ? 0 : (latSide === "right" ? 1 : -1) * latMag * (dir > 0 ? 0.3 : -0.3); // share of the field's depth
    const deep = pm2?.[1] === "deep";
    // incomplete: a ghost ball sails about 12 yards downfield and fades; the real ball stays at the line
    const incTo = Math.max(-5, Math.min(105, spot + dir * 12));
    const ghost = freshPlay && isInc && dir ? `<i class="gcv-ballp ghost" style="--tilt:${dir < 0 ? -1 : 1};left:${pct(X(spot))};--to:${pct(X(incTo))}"><i class="gcv-latw out" style="--latf:${latf}"><i class="gcv-shadow"></i><i class="gcv-ball3">${FOOTBALL}</i></i></i>` : "";
    // a penalty: a yellow flag on the field at the spot (tossed in when the play is new)
    const flag = isPen ? `<i class="gcv-flagp${freshPlay ? " toss" : ""}" style="left:${pct(X(spot) + (dir || 1) * 18)}"><i class="gcv-flag"><svg viewBox="0 0 20 16" aria-hidden="true"><path d="M2 2 Q10 -1 18 3 L17 13 Q9 10 2 13 Z"/><circle cx="4" cy="12" r="2.2"/></svg></i></i>` : "";
    // field goals and extra points: kicked from the holder's spot toward the goalposts, through them (good) or wide (missed).
    // An extra point inside a touchdown's play text ("H.Mevis extra point is GOOD") is kicked right after the touchdown.
    const isFG = /field goal|extra point/.test(String(play.type?.text || "").toLowerCase()) || /^(\([^)]*\)\s*)*\S+ \d+ yard field goal/i.test(play.text || "");
    const patTxt = isTD ? /extra point is (good|no good)/i.exec(play.text || "") : null;
    let fgBall = "";
    const lateKick = !!patTxt && patLate && patSince < 2.6; // the extra point arrived after the touchdown was already shown
    if ((freshPlay && (isFG || patTxt)) || lateKick) {
      const kd = isFG ? (startC === home ? 1 : startC === away ? -1 : dir || 1) : spot >= 50 ? 1 : -1;
      const hold = isFG ? (play.start?.yardLine ?? spot) - kd * 7 : (kd > 0 ? 100 : 0) - kd * (league === "nfl" ? 22 : 10);
      const good = isFG ? !/no good|missed|blocked|fail/.test(ptype) : /good/i.test(patTxt[1]) && !/no good/i.test(patTxt[1]);
      // a miss goes wide the way the play-by-play says ("wide right" is the kicker's right; kicking toward +x, that's the near sideline)
      const wide = /wide (left|right)/i.exec(isFG ? play.text || "" : (play.text || "").slice((play.text || "").toLowerCase().indexOf("extra point")))?.[1]?.toLowerCase();
      const wtop = wide ? ((wide === "right") === (kd > 0) ? 76 : 26) : 26;
      fgBall = `<i class="gcv-ballp fg${good ? "" : " miss"}" style="--wtop:${wtop}%;left:${pct(X(hold))};--hold:${pct(X(hold))};--to:${pct(X(kd > 0 ? 110 : -10))};--past:${pct(X(kd > 0 ? 116 : -16))};--kd:${kd};--fgd:${isFG ? 0 : lateKick ? (0.3 - patSince).toFixed(2) : bt + 0.8}s"><i class="gcv-shadow"></i><i class="gcv-ball3">${FOOTBALL}</i></i>`;
    }
    // a two-point try after a touchdown ("TWO-POINT CONVERSION ATTEMPT. D.Prescott pass to R.Flournoy is incomplete. ATTEMPT FAILS"):
    // the touchdown ball fades, a new one shows up on the 2 (the 3 in college) and is snapped, then thrown or run in.
    // A good try ends in the end zone, a stop just short of the goal line, an incompletion sails out the back and fades.
    const twoM = isTD ? /two-point conversion attempt\.?\s*(.*?)attempt (succeeds|fails)/i.exec(play.text || "") : null;
    const TWO_AT = bt + 1, TWO_RES = TWO_AT + 1.7; // when the new ball shows up, and when the try is decided (Good +2 / No good)
    let twoBall = "";
    if (twoM && freshPlay) {
      const kd = spot >= 50 ? 1 : -1, goal = kd > 0 ? 100 : 0, how = twoM[1].toLowerCase(), good = /succeeds/i.test(twoM[2]);
      const pass = /\bpass\b/.test(how), inc = pass && /incomplete/.test(how);
      const los = goal - kd * (league === "nfl" ? 2 : 3), to = good ? goal + kd * 3 : inc ? goal + kd * 9 : goal - kd * 1;
      twoBall = `<i class="gcv-ballp two${pass ? " pass" : ""}${inc ? " inc" : ""}" style="left:${pct(X(los))};--to:${pct(X(to))};--t0:${TWO_AT.toFixed(2)}s;--tilt:${kd < 0 ? -1 : 1}"><i class="gcv-shadow"></i><i class="gcv-ball3">${FOOTBALL}</i></i>`;
    }
    // points pop up over the end zone they were scored in: +6 when the touchdown lands, then "Good +1" (extra point) or "Good +2" (two-point try),
    // "Good +3" for a field goal as it clears the uprights, or "No good". Only when the play is new.
    const pops = [];
    if (freshPlay) {
      const tdRight = spot >= 50, fgClear = 2.2 * 0.8;
      if (isTD) {
        pops.push(["+6", tdRight, bt]);
        if (patTxt) pops.push(/no good/i.test(patTxt[1]) ? ["No good", tdRight, bt + 0.8 + fgClear, true] : ["Good +1", tdRight, bt + 0.8 + fgClear]);
        if (twoM) pops.push(/succeeds/i.test(twoM[2]) ? ["Good +2", tdRight, TWO_RES] : ["No good", tdRight, TWO_RES, true]);
      } else if (isFG) {
        const kd = startC === home ? 1 : startC === away ? -1 : dir || 1, miss = /no good|missed|blocked|fail/.test(ptype);
        pops.push(miss ? ["No good", kd > 0, fgClear, true] : [`Good ${/extra point/.test(ptype) ? "+1" : "+3"}`, kd > 0, fgClear]);
      }
    } else if (lateKick) {
      const at = 0.3 - patSince + 2.2 * 0.8;
      pops.push(/no good/i.test(patTxt[1]) ? ["No good", spot >= 50, at, true] : ["Good +1", spot >= 50, at]);
    }
    const popsHtml = pops.map(([txt, right, at, miss]) => `<b class="gcv-pts${miss ? " miss" : ""}" style="${right ? "right" : "left"}:9%;--pd:${at.toFixed(2)}s">${txt}</b>`).join("");
    const posts = [0, 100].map((x) => `<i class="gcv-post" style="left:${x}%"><i class="gp-base"></i><i class="gp-bar"></i><i class="gp-up a"></i><i class="gp-up b"></i></i>`).join("");
    const stand = `${(dir || isTD) && !isFG && !((patTxt || twoM) && !freshPlay) ?`<i class="gcv-ballp${fly ? ` move ${fly}` : ""}${fly === "pass" && deep ? " deep" : ""}${ghost ? " hold" : ""}${patTxt || twoM ? " patout" : ""}"${from.replace('style="', `style="--tilt:${dir < 0 ? -1 : 1};--ktilt:${dir < 0 ? 1 : -1};${fly === "int" ? `--mid:${pct(X(intAt))};` : ""}${fly === "ko" ? `--kd:${koKd};--mid:${pct(X(koKd > 0 ? 105 : -5))};${koFrom != null ? `--kfrom:${pct(X(koFrom))};` : ""}` : ""}`)}><i class="gcv-latw${latf && (fly === "pass" || fly === "run") ? ` go ${fly}` : ""}" style="--latf:${latf}"><i class="gcv-shadow"></i><i class="gcv-ball3">${FOOTBALL}</i></i></i>` : ""}${badges ? `<i class="gcv-lospin${moved ? " slide" : ""}" style="left:${pct(X(spot))}${moved ? `;--from:${pct(X(prevSpot))}` : ""}">${badges}</i>` : ""}`; // who has it: their logo above the field, on the line of scrimmage
    const ddText = isTD ? "Touchdown" : down ? `${["", "1st", "2nd", "3rd", "4th"][down]} & ${dist < toGo ? dist : "Goal"}` : "";
    // the whole game's play-by-play, newest drive first: who had it, how each drive ended (so a change of possession is clear)
    // (ESPN can list the drive in progress both as "current" and in "previous": keep one)
    const ld = live.drives || {}, seenDr = new Set(), allDr = [...(ld.previous || []), ...(ld.current ? [ld.current] : [])].filter((d) => (d.plays || []).some((p) => p.text))
      .reverse().filter((d) => { const k = String(d.id || d.plays?.[0]?.id); return !seenDr.has(k) && seenDr.add(k); });
    const pbp = allDr.map((d, di) => {
      const team = String(d.team?.id) === String(home.team.id) ? home : String(d.team?.id) === String(away.team.id) ? away : null;
      const ps = d.plays.filter((p) => p.text && !NOT_A_PLAY.has(String(p.type?.id || ""))).reverse();
      const res = d.displayResult || d.result || "";
      const dk = String(d.id || d.plays?.[0]?.id), open = !di || gcvOpen.has(dk) || ps.some((p) => String(p.id) === String(replaying));
      return `<li class="gcv-drv${di ? "" : " cur"}"><details data-dk="${esc(dk)}"${open ? " open" : ""}><summary class="gcv-dh">${team ? `${img(teamLogo(team.team), "xs")}<b>${ab(team)}</b>` : ""}<span class="muted">${esc(d.description || "")}</span>${res ? `<span class="gcv-res">${esc(res)}</span>` : ""}</summary>
        <ol class="gcv-plays">${ps.map((p, i) => `<li data-pid="${esc(p.id)}" title="Replay this play"${String(p.id) === String(replaying) ? ' class="rp-on"' : di || i || replaying ? "" : ` class="now${moved ? " in" : ""}"`}><span class="gcv-pc">Q${esc(p.period?.number || "")} ${esc(p.clock?.displayValue || "")}</span>${dd(p) ? `<span class="gcv-k">${dd(p)}</span>` : ""}${esc(clean(p.text))}</li>`).join("")}</ol></details></li>`;
    }).join("");
    // game clock: quarter and time left (or halftime / end of quarter)
    const gst = comp.status || {}, per = gst.period || 0, stn = gst.type?.name || "";
    const qn = (n) => (n <= 4 ? `Q${n}` : n === 5 ? "OT" : `${n - 4}OT`);
    const isPost = comp.status?.type?.state === "post";
    const clock = replaying ? `Replay · ${qn(play.period?.number || per)} ${play.clock?.displayValue || ""}` : isPost ? "Final" : stn === "STATUS_HALFTIME" ? "Halftime" : stn === "STATUS_END_PERIOD" ? (gst.type?.shortDetail || "End of quarter")
      : per ? `${qn(per)} · ${gst.displayClock || ""}` : "";
    // replaying: the score as it stood after this play (ESPN puts it on every play; the latest play that has one),
    // since the page's own score is the live or final one. The points go up in step with the field, matching the
    // "+6" / "Good +1" pops: the 6 when the touchdown lands, the extra point once it clears the uprights, a two-point
    // try when it succeeds, a field goal as it clears, anything else (a safety) when the ball stops.
    let scoreHtml = "";
    if (replaying) {
      const ps = [...(drives.previous || []), ...(drives.current ? [drives.current] : [])].flatMap((d) => d.plays || []);
      const hasSc = (p) => p.awayScore != null && p.homeScore != null, iPl = ps.findIndex((p) => String(p.id) === String(play.id));
      const after = ps.slice(0, iPl + 1).reverse().find(hasSc), before = ps.slice(0, Math.max(0, iPl)).reverse().find(hasSc);
      const a = after ? +after.awayScore : 0, h = after ? +after.homeScore : 0, a0 = before ? +before.awayScore : 0, h0 = before ? +before.homeScore : 0;
      const da = a - a0, dh = h - h0, d = Math.max(da, dh), fgClear = 2.2 * 0.8;
      const steps = !freshPlay || d <= 0 ? [] // [seconds in, points so far]
        : isTD && d > 6 ? [[bt, 6], [twoM ? TWO_RES : bt + 0.8 + fgClear, d]]
        : [[isFG ? fgClear : bt, d]];
      // each side's number at every step (only the scoring side's goes up), stacked in place: each pops in on time and
      // the one before it goes away. The other side gets a step too only when who's leading changes (its color).
      const awayScored = da > 0 && da >= dh, series = (base, scored) => [base, ...steps.map((s) => base + (scored ? s[1] : 0))];
      const av = steps.length ? series(a0, awayScored) : [a], hv = steps.length ? series(h0, !awayScored) : [h];
      const cell = (vals, other, popIt) => {
        const last = vals.length - 1, lead = (k) => vals[k] > other[k];
        if (!last || (!popIt && vals.every((_, k) => lead(k) === lead(0)))) return `<b class="n${lead(last) ? " lead" : ""}">${vals[last]}</b>`;
        return `<b class="n stk${popIt ? "" : " quiet"}">${vals.map((v, k) => `<span class="${[k ? "in" : "", k < last ? "out" : "", lead(k) ? "lead" : ""].filter(Boolean).join(" ")}" style="${k ? `--at:${steps[k - 1][0].toFixed(2)}s;` : ""}${k < last ? `--to:${steps[k][0].toFixed(2)}s` : ""}">${v}</span>`).join("")}</b>`;
      };
      scoreHtml = `<span class="gcv-score" aria-label="Score: ${ab(away)} ${a}, ${ab(home)} ${h}">${img(teamLogo(away.team), "xs")}<b>${ab(away)}</b>${cell(av, hv, awayScored)}<i>–</i>${cell(hv, av, !awayScored)}<b>${ab(home)}</b>${img(teamLogo(home.team), "xs")}</span>`;
    }
    // the looping glows and bobs are timed off the clock, so the redraw every few seconds doesn't make them jump
    return `<div class="card gcv${isTD ? " td" : ""}" style="--t:-${Date.now() % 26400}ms;--el:-${el}ms;--bt:${bt}s">
      <div class="gcv-bar">${off ? `<span class="gcv-off">${img(teamLogo(off.team), "xs")}<b>${ab(off)}</b> ball ${dir > 0 ? "→" : "←"}</span>` : "<span></span>"}
        <span class="gcv-mid">${scoreHtml}<b class="gcv-dd${moved ? " pop" : ""}">${esc(ddText)}</b>${clock ? `<span class="gcv-clock">${esc(clock)}</span>` : ""}</span>
        ${replaying ? `<span class="gcv-rpctl"><button type="button" class="gcv-pause" data-gcvpause aria-pressed="${gcvPause.has(gameId)}">${gcvPause.has(gameId) ? "▶ Play" : "❚❚ Pause"}</button><span class="gcv-spd">${[1, 2].map((v) => `<button type="button" data-gcvspd="${v}" class="${gcvSpeed === v ? "on" : ""}">${v}x</button>`).join("")}</span><button type="button" class="gcv-live" data-gcvlive>● <span class="gcv-bt">Back to </span>${isPost ? "final" : "live"}</button></span>`
          : isPost ? `<span><button type="button" class="gcv-live" data-gcvfrom>▶ Watch from kickoff</button></span>` : `<span class="muted">${at.possessionText ? `Ball on ${esc(at.possessionText)}` : ""}${toGo <= 20 && off && !isTD ? ` · <b class="gcv-rz">Red zone</b>` : ""}</span>`}</div>
      <div class="gcv-stands${gcvZoom.get(gameId)?.s > 1 ? " zoomed" : ""}" style="${standsStyle(gameId)}">${callHtml}${popsHtml}<div class="gcv-zoom" style="${zoomStyle(gameId)}"><div class="gcv-3d"><svg class="gcv-field" viewBox="0 0 1200 ${H}" role="img" aria-label="${esc([off ? `${off.team.abbreviation} ball` : "", ddText, at.possessionText ? `ball on ${at.possessionText}` : ""].filter(Boolean).join(", "))}">${svg.join("")}</svg>${posts}${flag}${ghost}${fgBall}${twoBall}${stand}</div></div></div>
      ${sims.some((p) => gcvTip.get(gameId) === `${dd(p) ? dd(p) + ": " : ""}${clean(p.text)}`) ? `<div class="gcv-tip">${esc(gcvTip.get(gameId))}</div>` : `<div class="gcv-tip" hidden></div>`}
      <div class="gcv-key"><span><i class="los"></i>Line of scrimmage</span>${fd != null ? `<span><i class="fd"></i>First down</span>` : ""}${sims.length ? `<span class="muted">Bars: this drive's plays, hover or tap one</span>` : ""}</div>
      ${pbp ? `<div class="gcv-pbp"><ol class="gcv-drives">${pbp}</ol></div>` : ""}
    </div>`;
  }

  // Live games read two ESPN feeds on every check: the game summary (full play-by-play, refreshes every ~6 s)
  // and the scoreboard (refreshes every ~4 s, often a play ahead). Whichever has the newer play wins.
  // College uses the game's own conference scoreboard (the all-FBS one is ~1 MB).
  const sbGroup = new Map(); // game id -> conference id, learned on the first load
  // game id -> the scoreboard entry with the newest play seen so far. A late, stale or failed scoreboard check reuses it,
  // so the field never jumps back a play (that used to replay the old play and reset the play clock)
  const sbLast = new Map();
  function mergeScoreboard(s, sb, id) {
    let sc = (sb?.events || []).find((e) => String(e.id) === String(id))?.competitions?.[0];
    const kept = sbLast.get(String(id)), comp = s.header?.competitions?.[0];
    if (!sc || (kept && playNum(kept.situation?.lastPlay?.id) > playNum(sc.situation?.lastPlay?.id))) sc = kept;
    else sbLast.set(String(id), sc);
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

  // zoom + pan (phones: pinch with two fingers, drag with one while zoomed; computers: the +/- buttons or a
  // trackpad pinch). Kept per game, so a new play doesn't throw you back out.
  const zoomButtons = `<div class="tf-zbtns"><button type="button" class="tf-zb" data-z="in" aria-label="Zoom in">+</button><button type="button" class="tf-zb" data-z="out" aria-label="Zoom out">−</button></div>`;
  const zoomOf = new Map(); // game id -> {s, x, y}
  function applyZoom(wrap, z) {
    const zm = wrap?.querySelector(".tf-zm");
    if (!zm) return;
    if (z) {
      const w = zm.clientWidth, h = zm.clientHeight;
      z.s = Math.min(4, Math.max(1, z.s));
      z.x = Math.min(0, Math.max(w - w * z.s, z.x));
      z.y = Math.min(0, Math.max(h - h * z.s, z.y));
      if (z.s < 1.02) Object.assign(z, { s: 1, x: 0, y: 0 });
      zoomOf.set(wrap.dataset.gid, z);
    }
    z = zoomOf.get(wrap.dataset.gid) || { s: 1, x: 0, y: 0 };
    zm.style.setProperty("--zs", z.s);
    zm.style.setProperty("--zx", `${z.x}px`);
    zm.style.setProperty("--zy", `${z.y}px`);
    wrap.classList.toggle("zoomed", z.s > 1);
  }
  // zoom by `f` keeping the point (px, py) inside the field (in px from its top-left) where it is
  const zoomAt = (wrap, f, px, py) => {
    const z = { ...(zoomOf.get(wrap.dataset.gid) || { s: 1, x: 0, y: 0 }) }, s = Math.min(4, Math.max(1, z.s * f));
    applyZoom(wrap, { s, x: px - (px - z.x) * (s / z.s), y: py - (py - z.y) * (s / z.s) });
  };
  let fieldZoomWired = false, zoomDragged = 0;
  function wireFieldZoom() {
    if (fieldZoomWired) return;
    fieldZoomWired = true;
    const root = view("game"), pts = new Map();
    let g0 = null; // the gesture so far: start positions + zoom
    const start = (wrap) => {
      const r = wrap.querySelector(".tf-zm").getBoundingClientRect(), p = [...pts.values()];
      const mid = { x: p.reduce((a, q) => a + q.x, 0) / p.length - r.left, y: p.reduce((a, q) => a + q.y, 0) / p.length - r.top };
      g0 = { wrap, mid, dist: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
        z: { ...(zoomOf.get(wrap.dataset.gid) || { s: 1, x: 0, y: 0 }) }, moved: 0 };
    };
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest?.(".tf-zb");
      if (!b) return;
      const wrap = b.closest(".tf-wrap"), zm = wrap.querySelector(".tf-zm");
      zoomAt(wrap, b.dataset.z === "in" ? 1.5 : 1 / 1.5, zm.clientWidth / 2, zm.clientHeight / 2);
    });
    // a drag or pinch isn't a tap: don't open a player's name card when it ends
    root.addEventListener("click", (ev) => { if (Date.now() - zoomDragged < 300 && ev.target.closest?.(".tf-zm")) ev.stopImmediatePropagation(); }, true);
    root.addEventListener("pointerdown", (ev) => {
      const wrap = ev.target.closest?.(".tf-zm")?.closest(".tf-wrap");
      if (!wrap || ev.pointerType === "mouse" && !wrap.classList.contains("zoomed")) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pts.size > 2) return;
      start(wrap);
    });
    root.addEventListener("pointermove", (ev) => {
      if (!g0 || !pts.has(ev.pointerId)) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const p = [...pts.values()], r = g0.wrap.querySelector(".tf-zm").getBoundingClientRect();
      const mid = { x: p.reduce((a, q) => a + q.x, 0) / p.length - r.left, y: p.reduce((a, q) => a + q.y, 0) / p.length - r.top };
      const s = p.length > 1 && g0.dist ? g0.z.s * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) / g0.dist : g0.z.s;
      if (p.length < 2 && g0.z.s <= 1) return; // one finger on an unzoomed field: let the page scroll
      g0.moved = Math.max(g0.moved, Math.hypot(mid.x - g0.mid.x, mid.y - g0.mid.y), Math.abs(s - g0.z.s) * 100);
      const k = Math.min(4, Math.max(1, s)) / g0.z.s; // the spot under the fingers stays under the fingers
      applyZoom(g0.wrap, { s, x: mid.x - (g0.mid.x - g0.z.x) * k, y: mid.y - (g0.mid.y - g0.z.y) * k });
    });
    const end = (ev) => {
      if (!pts.delete(ev.pointerId)) return;
      if (g0 && g0.moved > 6) zoomDragged = Date.now();
      if (pts.size && g0) start(g0.wrap); // one finger lifted: keep panning with the other
      else g0 = null;
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    // trackpad pinch (the browser sends it as ctrl + wheel)
    root.addEventListener("wheel", (ev) => {
      const zm = ev.target.closest?.(".tf-zm");
      if (!zm || !ev.ctrlKey) return;
      ev.preventDefault();
      const r = zm.getBoundingClientRect();
      zoomAt(zm.closest(".tf-wrap"), Math.exp(-ev.deltaY / 100), ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
  }

  // hover (or tap) a pixel player: highlight him and show number, name, position, headshot
  let fieldTipsWired = false;
  function wireFieldTips() {
    if (fieldTipsWired) return;
    fieldTipsWired = true;
    const root = view("game");
    let on = null;
    const PICK = ".tf-field .tf-guy, .tf-field .tf-flag";
    const show = (g, ev) => {
      const wrap = g.closest(".tf-wrap"), tip = wrap?.querySelector(".tf-tip");
      if (!tip) return;
      if (on && on !== g) on.classList.remove("on");
      on = g; g.classList.add("on");
      const d = g.dataset;
      tip.innerHTML = d.flag
        ? `<span class="tf-tipflag"></span><div><b>FLAG · ${esc(d.flag)}</b><small>${esc(d.flagsub || "Penalty on the play")}</small></div>`
        : d.name
        ? `${d.pic ? `<img src="${esc(d.pic)}" alt="" width="40" height="40">` : ""}<div><b>${d.num ? `#${esc(d.num)} ` : ""}${esc(d.name)}</b>
           <small>${esc([d.pos, d.team].filter(Boolean).join(" · "))}${d.sure === "1" ? " · in this play" : " · likely (depth chart)"}</small></div>`
        : `<div><b>${esc(d.team)}</b><small>No name for this spot</small></div>`;
      const r = wrap.getBoundingClientRect(), b = g.getBoundingClientRect();
      tip.style.left = `${Math.min(r.width - 10, Math.max(10, b.left - r.left + b.width / 2))}px`;
      tip.style.top = `${b.top - r.top}px`;
      tip.classList.toggle("flip", b.left - r.left > r.width * 0.6);
      tip.classList.toggle("flipl", b.left - r.left < r.width * 0.25);
      tip.classList.remove("hidden");
    };
    const hide = () => { if (on) on.classList.remove("on"); on = null; root.querySelectorAll(".tf-tip").forEach((t) => t.classList.add("hidden")); };
    // phones: the players are tiny, so a tap picks whoever is closest to the finger (within ~36 px)
    const nearest = (ev) => {
      const field = ev.target.closest?.(".tf-field");
      if (!field) return null;
      let best = null, bd = 36 * 36;
      field.querySelectorAll(".tf-guy, .tf-flag").forEach((g) => {
        const b = g.getBoundingClientRect();
        if (!b.width || getComputedStyle(g).visibility === "hidden") return;
        const dx = ev.clientX - (b.left + b.width / 2), dy = ev.clientY - (b.top + b.height / 2);
        const dd = (dx * dx + dy * dy) * (g.classList.contains("tf-flag") ? 0.3 : 1); // the flag wins close calls
        if (dd < bd) { bd = dd; best = g; }
      });
      return best;
    };
    let touch = false;
    root.addEventListener("pointerdown", (ev) => { touch = ev.pointerType !== "mouse"; });
    root.addEventListener("pointerover", (ev) => { if (ev.pointerType !== "mouse") return; const g = ev.target.closest?.(PICK); if (g) show(g, ev); });
    root.addEventListener("pointerout", (ev) => { if (ev.pointerType !== "mouse") return; const g = ev.target.closest?.(PICK); if (g && !g.contains(ev.relatedTarget)) hide(); });
    root.addEventListener("click", (ev) => {
      if (ev.target.closest?.(".tf-rb, .tf-rmenu")) return;
      const g = ev.target.closest?.(PICK) || (touch ? nearest(ev) : null);
      if (g && g === on && touch) hide(); // tap the same one again to close
      else if (g) show(g, ev);
      else if (!ev.target.closest(".tf-tip")) hide();
    });
    // replay button (bottom right of the field): pick one of the last 3 plays, or all 3 back to back
    root.addEventListener("click", (ev) => {
      const rb = ev.target.closest?.(".tf-rb"), item = ev.target.closest?.(".tf-rmenu [data-rp]");
      root.querySelectorAll(".tf-rmenu").forEach((m) => { if (!rb || !m.parentNode.contains(rb)) m.classList.add("hidden"); });
      if (rb?.classList.contains("on")) { stopReplay?.(); return; } // "■ LIVE": back to the live field now
      if (rb?.classList.contains("tf-hb")) { // after the final: the top plays back to back
        const wrap = rb.closest(".tf-wrap"), hl = tfCtx.get(wrap.dataset.gid)?.final || [];
        runReplay(wrap, hl.map((x) => x.p.id), hl);
        return;
      }
      if (rb) {
        const m = rb.parentNode.querySelector(".tf-rmenu");
        m.classList.toggle("hidden");
        rb.setAttribute("aria-expanded", String(!m.classList.contains("hidden")));
      } else if (item) runReplay(item.closest(".tf-wrap"), item.dataset.rp.split(","));
    });
  }
  let replayRun = 0, stopReplay = null;
  // labels: highlights only, the title card shown before each play ({kind, p})
  async function runReplay(wrap, ids, labels = null) {
    stopReplay?.(); // one at a time: put the live field back before starting another
    const ctx = tfCtx.get(wrap?.dataset.gid), live = wrap?.querySelector(".tf-field");
    if (!ctx || !live) return;
    const run = ++replayRun, field = wrap.closest(".tecmo"), liveBar = field.querySelector(".tf-bar");
    const btn = wrap.querySelector(".tf-rb"), btnText = btn.textContent, cap = wrap.querySelector(".tf-cap"), zm = wrap.querySelector(".tf-zm");
    btn.textContent = labels ? "■ STOP" : "■ LIVE";
    btn.classList.add("on");
    field.classList.add("replaying");
    let shown = live, shownBar = liveBar;
    const done = () => {
      stopReplay = null;
      if (shown !== live) {
        shown.replaceWith(live);
        try { live.setCurrentTime(60); } catch (e) {} // put back into the page, its animations would start over: skip to the end
      }
      if (shownBar && shownBar !== liveBar) shownBar.replaceWith(liveBar);
      btn.textContent = btnText;
      btn.classList.remove("on");
      field.classList.remove("replaying");
      cap?.classList.add("hidden");
      zm?.classList.remove("tf-dim");
    };
    stopReplay = () => { replayRun++; done(); };
    for (let i = 0; i < ids.length; i++) {
      const p = ctx.s && upToPlay(ctx.s, ids[i]);
      if (!p) continue;
      const key = `${wrap.dataset.gid}#replay`;
      tfSeen.delete(key); // so it's drawn as a new play and runs its replay
      const t = document.createElement("template");
      t.innerHTML = liveField(p, ctx.comp, ctx.home, ctx.away, ctx.tc, key, ctx.people, true);
      const svg = t.content.querySelector(".tf-field");
      if (!svg || run !== replayRun || !wrap.isConnected) return;
      const pl = p.drives.previous.at(-1).plays.at(-1), txt = (pl.type?.text || "") + " " + (pl.text || "");
      if (labels && cap) {
        // title card between plays: the field dims, the card says what's coming, then the play runs with the card up top
        const q = pl.period?.number, qs = q ? (q > 4 ? "OT" : `Q${q}`) : "";
        const score = pl.awayScore != null ? `${ctx.away.team.abbreviation} ${pl.awayScore} · ${ctx.home.team.abbreviation} ${pl.homeScore}` : "";
        const desc = (pl.text || "").trim().replace(/^(\([^)]*\)\s*)+/, "");
        // whose play it was: the offense, except for the defense's big moments
        const offT = String(pl.start?.team?.id || pl.team?.id || p.drives.previous.at(-1).team?.id || ""), defK = /INTERCEPTION|FUMBLE|DEFENSIVE|BLOCKED|SAFETY|STOP|SACK/.test(labels[i].kind);
        const tm = [ctx.home, ctx.away].find((c) => (String(c.team.id) === offT) !== defK)?.team.abbreviation || "";
        cap.innerHTML = `<div class="tf-cap-top"><b>PLAY ${i + 1} OF ${ids.length}</b><span>${esc([qs, pl.clock?.displayValue].filter(Boolean).join(" "))}</span></div>
          <div class="tf-cap-kind">${esc(`${tm ? tm + " " : ""}${labels[i].kind}`)}</div><p>${esc(desc.length > 120 ? desc.slice(0, 118) + "…" : desc)}</p>${score ? `<small>${esc(score)}</small>` : ""}`;
        cap.classList.remove("hidden", "mini");
        cap.style.animation = "none"; void cap.offsetWidth; cap.style.animation = ""; // replay the wipe-in for every card
        zm?.classList.add("tf-dim");
        await new Promise((r) => setTimeout(r, 2200));
        if (run !== replayRun || !wrap.isConnected) return;
        cap.classList.add("mini");
        zm?.classList.remove("tf-dim");
      }
      svg.insertAdjacentHTML("beforeend", `<text x="${svg.viewBox.baseVal.x + 14}" y="292" class="tf-rlabel">${labels ? "HIGHLIGHT" : "REPLAY"}${ids.length > 1 ? ` ${i + 1}/${ids.length}` : ""}</text>`);
      shown.replaceWith(svg);
      shown = svg;
      const bar = t.content.querySelector(".tf-bar"); // the down and spot of the play being replayed
      if (bar && shownBar) { shownBar.replaceWith(bar); shownBar = bar; }
      // touchdowns play out the celebration and the try; everything else is done in about 4 seconds
      // (kickoffs run up to 2 seconds longer: the kick and the return)
      const koExtra = /kickoff/i.test(pl.type?.text || "") ? 2000 : 0;
      await new Promise((r) => setTimeout(r, (pl.scoringPlay && /touchdown/i.test(txt) ? (labels ? 7500 : 10500) : 4300) + koExtra));
      if (run !== replayRun || !wrap.isConnected) return;
    }
    done();
  }

  // Between full refreshes, check ESPN's tiny "situation" feed (~600 bytes, vs ~500 KB for the full game) every 2 s;
  // as soon as it names a newer play than the one on screen, do the full refresh right away
  let sitTimer = null;
  function watchSituation(lg, id, params, newestId) {
    clearInterval(sitTimer);
    const my = token, lp = lg === "nfl" ? "nfl" : "college-football";
    sitTimer = setInterval(async () => {
      if (my !== token) return clearInterval(sitTimer); // left the page, or a refresh already started
      if (document.hidden) return;
      try {
        const j = await (await fetch(`https://sports.core.api.espn.com/v2/sports/football/leagues/${lp}/events/${id}/competitions/${id}/situation?_=${Date.now()}`)).json();
        const pid = (j.lastPlay?.$ref || "").match(/plays\/(\d+)/)?.[1];
        if (pid && my === token && playNum(pid) > playNum(newestId)) { clearInterval(sitTimer); game(id, params, true); }
      } catch (e) { /* the full 5-second check still runs */ }
    }, 2000);
  }
  // "Last 5 meetings" card. Pair keys are our team names sorted ("Alabama|Auburn"); college files are split by the
  // key's first letter (h2h/a.json). Rows: [date, home, away, home pts, away pts, note?], newest first.
  const h2hFiles = new Map();
  async function meetingsCard(lg, ranks, away, home, date) {
    const nm = (c) => (lg === "nfl" ? c.team.displayName : ourTeam(ranks, lg, c.team)?.team || c.team.location);
    const A = nm(away), H = nm(home);
    if (!A || !H) return "";
    const key = [A, H].sort().join("|"), ch = key[0].toLowerCase();
    const url = lg === "nfl" ? "data/nfl/h2h.json" : `data/cfb/h2h/${ch >= "a" && ch <= "z" ? ch : "0"}.json`;
    if (!h2hFiles.has(url)) h2hFiles.set(url, getJSON(url).catch(() => { h2hFiles.delete(url); return null; }));
    const d = await h2hFiles.get(url);
    const day = (date || "").slice(0, 10);
    const rows = (d?.games?.[key] || []).filter((g) => !day || g[0] <= day);
    if (!rows.length) return "";
    const ab = (n) => esc(n === A ? away.team.abbreviation : n === H ? home.team.abbreviation : n);
    const logoOf = (n) => img(teamLogo(n === A ? away.team : home.team), "xs");
    const winsOf = (n, list) => list.filter((g) => (g[1] === n && g[3] > g[4]) || (g[2] === n && g[4] > g[3])).length;
    const rec = (n1, n2, w1, w2) => (w1 === w2 ? `tied ${w1}-${w2}` : w1 > w2 ? `${ab(n1)} ${w1}-${w2}` : `${ab(n2)} ${w2}-${w1}`);
    const r = d.rec?.[key], [k1, k2] = key.split("|");
    const since = lg === "nfl" ? 1999 : 1979;
    const fmtDay = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `<div class="card mt"><h3>Last ${rows.length === 1 ? "meeting" : `${rows.length} meetings`}</h3>
      <p class="mt-sum">${r ? `Since ${since}: <b>${rec(k1, k2, r[0], r[1])}</b>${r[2] ? `, ${r[2]} tie${r[2] > 1 ? "s" : ""}` : ""}` : ""}${rows.length > 1 ? ` · Last ${rows.length}: <b>${rec(A, H, winsOf(A, rows), winsOf(H, rows))}</b>` : ""}</p>
      <div class="mt-list">${rows.map(([dt, h, a, hp, ap, note]) => `<div class="mt-row">
        <span class="mt-d">${fmtDay(dt)}</span>
        <span class="mt-g"><span class="${ap > hp ? "mt-w" : ""}">${logoOf(a)}${ab(a)} ${ap}</span> <span class="muted">@</span> <span class="${hp > ap ? "mt-w" : ""}">${logoOf(h)}${ab(h)} ${hp}</span></span>
        ${note ? `<small class="mt-n">${esc(note)}</small>` : ""}</div>`).join("")}</div></div>`;
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
    if (refresh) mergeScoreboard(s, sb, id);
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
    let people = null;
    if (st === "in" || st === "post") { // post: the highlights player uses the same field
      wireFieldTips(); wireGcv(); // before the rosters load, so the buttons work right away
      const yr = s.header?.season?.year;
      const [ph, pa] = await Promise.all([teamPeople(lg, home.team.id, yr).catch(() => null), teamPeople(lg, away.team.id, yr).catch(() => null)]);
      if (my !== token) return;
      people = { home: ph, away: pa };
    }
    const side = (c, which) => {
      const ours = ourTeam(ranks, lg, c.team);
      const ap = c.rank && c.rank <= 25 ? c.rank : null;
      const result = st === "post" ? (c.winner ? " win" : " lose") : "";
      const logoImg = img(teamLogo(c.team), "xl");
      const name = `<div class="sb-name">
          <a href="${link("team", c.team.id)}">${ap ? `<span class="sb-rank">${ap}</span>` : ""}<b><span class="sb-full">${esc(c.team.location || tname(c))}</span><span class="sb-ab">${esc(c.team.abbreviation || "")}</span></b></a>
          <small>${esc(c.team.name || "")}</small>
          <em><span class="sb-rec">${esc(c.record?.[0]?.summary || c.record?.[0]?.displayValue || "")}</span>${ours ? `<span class="sb-our"> · Cupcake Index #${ours.rank}</span>` : ""}</em></div>`;
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
          <small>${esc(venue || "")}${venue && tv ? " · " : ""}${tv ? watch(tv, st) : ""}</small>
          <span class="muted live-note">${liveBadge(st === "in")}</span>
        </div>
        ${side(home, "home")}
      </div>
      <p class="gm-acts"><a class="btn" href="${link("stats", null, { show: "visualize", who: "teams", type: "radar", pick: `${lg}:${away.team.id},${lg}:${home.team.id}` })}">📈 Compare these two</a></p>
      ${lineTable || st === "in" ? `<div class="card sb-under">${lineTable}
        ${st === "in" && s.situation?.lastPlay?.text ? `<p class="note">Last play: ${esc(s.situation.lastPlay.text)}</p>` : ""}</div>` : ""}
      ${st === "in" ? fieldView(s, comp, home, away, tc, String(id), people, null)
        : st === "post" && recentPlays(s).length ? fieldView(s, comp, home, away, tc, String(id), people, topPlays(s)) : ""}`;

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
    // our predicted score (NFL), and after the final how far off it was, plus how close it's been all season
    const predScoreBox = (p) => {
      if (p?.home_pts == null) return "";
      const fin = st === "post" && home.score != null && away.score != null;
      const off = fin ? Math.abs(p.away_pts - +away.score) + Math.abs(p.home_pts - +home.score) : null;
      const acc = INDEX.leagues[lg].seasons[season]?.accuracy;
      return `<div class="pred-score">
          <span class="ps-label">Predicted score</span>
          <span class="ps-line"><span class="sb-chip" style="--c:${tc.away}"></span>${esc(away.team.abbreviation)} <b>${p.away_pts}</b>
            <span class="muted">-</span> <b>${p.home_pts}</b> ${esc(home.team.abbreviation)}<span class="sb-chip" style="--c:${tc.home}"></span></span>
          ${fin ? `<span class="ps-final">Final ${esc(away.score)}-${esc(home.score)} · off by ${off} point${off === 1 ? "" : "s"} in all</span>` : ""}
        </div>
        ${acc?.score_mae != null ? `<p class="note">How close we get: on average, each team's real score lands about ${Math.round(acc.score_mae)} points from our prediction (${acc.score_mae} this season over ${acc.score_games} games, ${lg === "nfl" ? "7.4 over 2020–2025" : "8.8 over 2025 and 2026"}).</p>` : ""}`;
    };
    // odds + model
    const pc = s.pickcenter || [];
    if (pc.length || pred) {
      col.left.push(`<div class="card"><h3>Lines</h3><div class="books">
        ${pc.map((o) => `<span class="book">${esc(o.provider?.name || "Book")}: ${esc(o.details || "—")}${o.overUnder ? ` · O/U ${esc(o.overUnder)}` : ""}</span>`).join("")}
        ${pred && chanceText(pred) ? `<span class="book hot">Cupcake Index model: ${chanceText(pred)}</span>` : ""}</div>
        ${predScoreBox(pred)}
        ${pred?.notes?.length ? `<div class="why why-notes"><b>Why we lean ${esc(pred.home_win_prob >= 0.5 ? pred.home : pred.away)}</b>
          <ul>${pred.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
          : pred?.why ? `<p class="why"><b>Why:</b> ${esc(pred.why)}</p>` : ""}</div>`);
    }
    // last 5 meetings (src/social/h2h.py): NFL since 1999, college since 1979
    const mt = await meetingsCard(lg, ranks, away, home, comp.date);
    if (my !== token) return;
    if (mt) col.left.push(mt);
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
    let leadRows = LEAD_CATS.map(([key, label]) => {
      const A = leaderFor(away.team.id, key), H = leaderFor(home.team.id, key);
      if (!A && !H) return "";
      const av = A?.value ?? -1, hv = H?.value ?? -1;
      const unit = (A || H).mainStat?.label || "";
      return `<div class="lrow">${lside(A, "away", av > hv)}<span class="lcat">${label}<small>${esc(unit)}</small></span>${lside(H, "home", hv > av)}</div>`;
    }).join("");
    // takeaways: everyone with an interception or a fumble recovery (ties all listed); own-fumble recoveries don't count
    const takeaways = (teamId) => {
      const tp = (s.boxscore?.players || []).find((t) => String(t.team?.id) === String(teamId));
      const by = new Map();
      const add = (a, kind, n) => {
        if (!(n > 0)) return;
        const k = String(a.id), o = by.get(k) || { a, int: 0, fr: 0 };
        o[kind] += n; by.set(k, o);
      };
      for (const cat of tp?.statistics || []) {
        const col = (lab) => cat.labels?.indexOf(lab);
        if (cat.name === "interceptions" && col("INT") >= 0) cat.athletes.forEach((x) => add(x.athlete, "int", +x.stats[col("INT")]));
        if (cat.name === "fumbles" && col("REC") >= 0 && col("FUM") >= 0) cat.athletes.forEach((x) => { if (+x.stats[col("FUM")] === 0) add(x.athlete, "fr", +x.stats[col("REC")]); });
      }
      return [...by.values()].sort((x, y) => (y.int + y.fr) - (x.int + x.fr) || y.int - x.int);
    };
    const tside = (list, which, win) => {
      if (!list.length) return `<span class="lside ${which} empty">–</span>`;
      const what = (o) => [o.int ? `${o.int > 1 ? o.int + " " : ""}INT` : "", o.fr ? `${o.fr > 1 ? o.fr + " " : ""}FR` : ""].filter(Boolean).join(", ");
      const total = list.reduce((n, o) => n + o.int + o.fr, 0);
      const names = list.slice(0, 4).map((o) => `<span class="tk-one"><a href="${link("player", o.a.id)}">${esc(o.a.shortName || (o.a.firstName && o.a.lastName ? `${o.a.firstName[0]}. ${o.a.lastName}` : o.a.displayName))}</a> <small>${what(o)}</small></span>`).join("");
      const pics = `<span class="tk-pics">${list.slice(0, 3).map((o) => face(o.a.headshot?.href, o.a.displayName, "leadshot")).join("")}</span>`;
      const txt = `<span class="ltxt tk-list">${names}</span>`, num = `<span class="lbig${win ? " win" : ""}">${total}</span>`;
      return `<span class="lside tk ${which}">${which === "away" ? pics + txt + num : num + txt + pics}</span>`;
    };
    if (st !== "pre") {
      const TA = takeaways(away.team.id), TH = takeaways(home.team.id);
      const ta = TA.reduce((n, o) => n + o.int + o.fr, 0), th = TH.reduce((n, o) => n + o.int + o.fr, 0);
      if (ta || th) leadRows += `<div class="lrow">${tside(TA, "away", ta > th)}<span class="lcat">Takeaways<small>INT · FR</small></span>${tside(TH, "home", th > ta)}</div>`;
    }
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
    if (!inj.length && lg === "cfb" && st !== "post") {
      const d = await cfbInj();
      if (my !== token) return;
      const reps = [away, home].map((c) => [c, cfbInjFor(d, ourTeam(ranks, lg, c.team)?.team, s.header?.week)]).filter(([, r]) => r);
      if (reps.length) col.right.push(`<div class="card"><h3>Availability report</h3><div class="box-pair">${reps.map(([c, r]) => `<div><b>${esc(c.team.displayName || c.team.location)}</b>${cfbInjList(r)}</div>`).join("")}</div><p class="note">${CFB_INJ_NOTE}</p></div>`);
    }
    const oldField = view("game").querySelector(".tecmo"); // same play as last time: keep it so a running animation isn't restarted
    const pbpTop = view("game").querySelector(".gcv-pbp")?.scrollTop || 0; // keep your place in the Clean play-by-play through the refresh
    view("game").innerHTML = `<p><a href="${link("scores")}" class="boxlink">← Scores</a></p>${head}${leadersStrip}<div class="game-cols"><div class="gcol">${col.left.join("")}</div><div class="gcol">${col.right.join("")}</div></div>${col.full.join("")}`;
    const newField = view("game").querySelector(".tecmo");
    const pbpNew = view("game").querySelector(".gcv-pbp");
    if (pbpNew && pbpTop) pbpNew.scrollTop = pbpTop;
    if (oldField && newField && oldField.dataset.play === newField.dataset.play) {
      newField.replaceWith(oldField);
      oldField.querySelector(".tf-last")?.replaceWith(newField.querySelector(".tf-last") || "");
      // moving the field restarts its CSS animations, so swap in the new play clock (it's timed from when the play arrived)
      oldField.querySelector(".tf-clock")?.replaceWith(newField.querySelector(".tf-clock") || "");
    }
    const tfWrap = view("game").querySelector(".tecmo .tf-wrap");
    if (tfWrap) { wireFieldZoom(); applyZoom(tfWrap); }
    if (wp.length > 2) initWp(wp, s, away, home);
    const bx = $("#boxscore .box-tabs");
    if (bx) bx.onclick = (e) => {
      const k = e.target.dataset.bt;
      if (!k) return;
      boxTab = k;
      bx.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.bt === k));
      document.querySelectorAll("#boxscore .box-sec").forEach((sec) => sec.classList.toggle("hidden", sec.dataset.sec !== k));
    };
    if (st === "in") { // live: a full check every 5 s, plus the tiny "situation" feed every 2 s to catch a new play sooner
      poll((r) => game(id, params, r), 5000);
      const dr = s.drives?.current || s.drives?.previous?.at(-1);
      watchSituation(lg, id, params, dr?.plays?.at(-1)?.id);
    }
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

  // Air yards: how far past the line of scrimmage each pass was caught, for each QB.
  // NFL: ESPN gives yards after catch, so air = gain - YAC (rows that don't match ESPN's "short"/"deep" label are dropped, since
  // ESPN's YAC is sometimes wrong). College: the play text says where it was caught ("caught at OU40", or "thrown to OU40" when
  // incomplete). The text's team letters can differ from ESPN's (UT vs TEX), so they're matched up from "to the UT43" spots first.
  function airPasses(s) {
    const plays = (s.drives?.previous || []).concat(s.drives?.current && !(s.drives.previous || []).some((d) => d.id === s.drives.current.id) ? [s.drives.current] : []).flatMap((d) => d.plays || []);
    const sp = (t) => { const m = /^([A-Z&]+)\s+(\d+)$/.exec((t || "").trim()); return m ? [m[1], +m[2]] : null; };
    const alias = {}, own = {}, known = new Set();
    for (const p of plays) {
      for (const x of [p.start, p.end]) {
        const a = sp(x?.possessionText);
        if (!a) continue;
        known.add(a[0]);
        if (a[1] !== 50 && x.team?.id && x.yardsToEndzone === 100 - a[1]) own[x.team.id] = a[0];
      }
      const e = sp(p.end?.possessionText), m = / to the ([A-Z&]+) ?(\d+)/.exec(p.text || "");
      if (e && m && +m[2] === e[1] && e[1] !== 50) alias[m[1]] = e[0];
    }
    const toGo = (side, n, team) => { // yards from the offense's goal line
      if (n === 50) return 50;
      const X = alias[side] || side;
      return !known.has(X) || !own[team] ? null : X === own[team] ? 100 - n : n;
    };
    const out = [];
    for (const p of plays) {
      const t = p.text || "", type = p.type?.text || "";
      if (!/\bpass\b/i.test(t) || /no play|spiked|two-point|2pt|conversion/i.test(`${t} ${type}`) || /sack/i.test(type)) continue;
      const who = /(?:#\d+\s+)?([A-Z][A-Za-z.'\-]*(?:\s[A-Z][A-Za-z.'\-]+)?)\s+pass\b/.exec(t.replace(/^(\([^)]*\)\s*)+/, "").replace(/^[\w\- ]*?(?=#\d)/, ""));
      const team = String(p.start?.team?.id || ""), los = p.start?.yardsToEndzone;
      if (!who || !team || los == null) continue;
      const inc = /incomplete/i.test(t), int = /intercept/i.test(t), depth = /pass (?:complete |incomplete )?(short|deep)/i.exec(t)?.[1]?.toLowerCase();
      let air = null;
      const spot = /(?:caught at|thrown to) ([A-Z&]+) ?(\d+)/.exec(t);
      if (spot) { const y = toGo(spot[1], +spot[2], team); if (y != null) air = los - y; }
      else if (!inc && !int && p.yardsAfterCatch != null && p.statYardage != null) {
        air = p.statYardage - p.yardsAfterCatch;
        if (p.yardsAfterCatch > 90 || (depth === "short" && air > 17) || (depth === "deep" && air < 14)) air = null;
      }
      if (air != null && (air < -20 || air > 75 || (depth === "short" && air > 30))) air = null;
      const dir = /pass (?:complete |incomplete )?(?:(?:short|deep) )?(left|middle|right)/i.exec(t)?.[1]?.toLowerCase() || "middle";
      const to = /\bpass\b.*?\bto (?:#\d+\s+)?([A-Z][A-Za-z'\-]*\.\s?[A-Z][A-Za-z'\-]+)/.exec(t)?.[1] || null;
      const yac = air != null && !inc && !int && p.statYardage != null ? p.statYardage - air : 0;
      out.push({ qb: who[1], to, team, yac, half: (p.period?.number || 1) <= 2 ? 1 : 2, inc: inc || int, int, td: /touchdown/i.test(t) && !int && !inc, depth, dir, air, p });
    }
    return out;
  }
  // Every run, from the play-by-play: who carried it, which gap (NFL: "left end" ... "up the middle"; college only says left/middle/right), and the gain.
  const GAPS = { "left end": 0.12, "left tackle": 0.27, "left guard": 0.39, "up the middle": 0.5, "right guard": 0.61, "right tackle": 0.73, "right end": 0.88, left: 0.27, middle: 0.5, right: 0.73 };
  function rushPlays(s) {
    const plays = (s.drives?.previous || []).concat(s.drives?.current && !(s.drives.previous || []).some((d) => d.id === s.drives.current.id) ? [s.drives.current] : []).flatMap((d) => d.plays || []);
    const out = [];
    for (const p of plays) {
      const t = (p.text || "").replace(/^(\([^)]*\)\s*)+/, ""), type = p.type?.text || "";
      if (!/rush/i.test(type) || /no play|two-point|2pt|conversion|kneel|spike/i.test(`${t} ${type}`) || p.statYardage == null) continue;
      const m = /(?:#\d+\s+)?([A-Z][A-Za-z'\-]*\.\s?[A-Z][A-Za-z'\-]+)(?:\s(?:Jr|Sr|II|III|IV|V)\.?)?\s+(?:scrambles\s+|rush\s+)?(left end|left tackle|left guard|up the middle|right guard|right tackle|right end|left|middle|right)\b/.exec(t);
      if (!m) continue;
      out.push({ qb: m[1], team: String(p.start?.team?.id || ""), half: (p.period?.number || 1) <= 2 ? 1 : 2, gap: m[2], air: p.statYardage,
        td: /touchdown/i.test(`${type} ${t}`) && !/fumble/i.test(type), int: /fumble/i.test(t) && /recovered by/i.test(t) && /opponent/i.test(type), inc: false, p });
    }
    return out;
  }
  // Pinch to zoom and drag to pan a player-page chart on a phone: two fingers zoom around them (up to 4x), one finger pans once
  // zoomed, a double-tap goes back. Unzoomed, a one-finger swipe still scrolls the page. The zoom applies to the SVGs in the box.
  function pinchPan(box) {
    if (!box || box.dataset.pz) return;
    box.dataset.pz = "1";
    let z = { s: 1, x: 0, y: 0 }, g = null, lastTap = 0;
    const rel = (t) => { const r = box.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
    const apply = () => {
      const w = box.clientWidth, h = box.clientHeight;
      z.x = Math.min(0, Math.max(w - w * z.s, z.x)); z.y = Math.min(0, Math.max(h - h * z.s, z.y)); // keep the chart covering the box
      box.querySelectorAll("svg").forEach((el) => { el.style.transformOrigin = "0 0"; el.style.transform = z.s > 1 ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : ""; });
      box.classList.toggle("pz-on", z.s > 1);
    };
    box.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        const [a, b] = [rel(e.touches[0]), rel(e.touches[1])];
        g = { pinch: true, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2, z0: { ...z } };
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300 && z.s > 1) { z = { s: 1, x: 0, y: 0 }; apply(); g = null; lastTap = 0; return; } // double-tap: back to the whole chart
        lastTap = now;
        if (z.s > 1) { const [x, y] = rel(e.touches[0]); g = { pinch: false, px: x, py: y, z0: { ...z } }; }
      }
    }, { passive: true });
    box.addEventListener("touchmove", (e) => {
      if (!g) return;
      if (g.pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = [rel(e.touches[0]), rel(e.touches[1])], s2 = Math.min(4, Math.max(1, g.z0.s * Math.hypot(a[0] - b[0], a[1] - b[1]) / g.d));
        const cx = (g.mx - g.z0.x) / g.z0.s, cy = (g.my - g.z0.y) / g.z0.s, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; // the chart point under the fingers stays under them
        z = { s: s2, x: mx - cx * s2, y: my - cy * s2 };
        apply();
      } else if (!g.pinch && e.touches.length === 1 && z.s > 1) {
        e.preventDefault();
        const [x, y] = rel(e.touches[0]);
        z = { s: z.s, x: g.z0.x + x - g.px, y: g.z0.y + y - g.py };
        apply();
      }
    }, { passive: false });
    box.addEventListener("touchend", (e) => {
      if (e.touches.length === 1 && z.s > 1) { const [x, y] = rel(e.touches[0]); g = { pinch: false, px: x, py: y, z0: { ...z } }; } // one finger left: keep panning
      else if (!e.touches.length) g = null;
    });
  }

  // ESPN's position is sometimes just wrong (it lists Justin Tucker, a kicker, as a wide receiver): espn id -> [abbreviation, name]
  const POS_FIX = { 15683: ["PK", "Place Kicker"] };
  const fixPos = (a) => (a && POS_FIX[a.id] ? { ...a, position: { ...(a.position || {}), abbreviation: POS_FIX[a.id][0], displayName: POS_FIX[a.id][1], name: POS_FIX[a.id][1] } } : a);

  // Drag to read a chart (like the win-odds chart): a mouse just hovers. On a phone the line shows the moment you touch.
  // axis "x" (read sideways, like the kick chart): it follows your finger left and right right away, while up/down still scrolls
  // the page. axis "y" (read up and down, like the pass chart): touch shows it at that spot; hold a moment and it slides with
  // your finger without scrolling. show(p) gets the pointer in the SVG's own coordinates; hide() when you let go or leave.
  function scrubber(svg, show, hide, axis = "x") {
    const at = (e) => { const m = svg.getScreenCTM(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : null; };
    // pinched: from a second finger until every finger is up, or while the chart is zoomed in (pinchPan's pz-on), touches
    // zoom and pan the chart and the line stays hidden
    let held = false, timer = 0, pinched = false;
    const off = () => pinched || !!svg.closest(".pz-on");
    svg.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { const p = at(e); if (p) show(p); } });
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    svg.addEventListener("touchstart", (e) => {
      if (e.touches.length > 1) pinched = true;
      if (off()) { clearTimeout(timer); held = false; return hide(); } // two fingers: that's a pinch
      const t = e.touches[0], p = at(t);
      if (p) show(p); // right away
      clearTimeout(timer);
      if (axis === "y") timer = setTimeout(() => { held = true; }, 220);
    }, { passive: true });
    svg.addEventListener("touchmove", (e) => {
      if (e.touches.length > 1 || off()) return;
      if (axis === "x" || held) { if (held) e.preventDefault(); const p = at(e.touches[0]); if (p) show(p); } else clearTimeout(timer);
    }, { passive: false });
    svg.addEventListener("touchend", (e) => { if (e.touches.length) return; clearTimeout(timer); held = false; pinched = false; hide(); });
  }
  // the scrub line's label: a small rounded tag (same look as the kicking chart's value tags)
  const scanTag = (x, y, txt, anchor = "middle") => { const w = 14 + 7 * txt.length, x0 = anchor === "end" ? x - w : anchor === "start" ? x : x - w / 2;
    return `<g class="ky-pill"><rect x="${x0.toFixed(1)}" y="${(y - 10).toFixed(1)}" width="${w.toFixed(1)}" height="19" rx="9.5"/><text x="${(x0 + w / 2).toFixed(1)}" y="${(y + 3.5).toFixed(1)}">${esc(txt)}</text></g>`; };

  // Player page (NFL kickers): every field goal this season, seen from the side about 45 degrees off, the posts on the right.
  // Each dot is the kick's line of scrimmage, the way kicks are called (field goal distance = yard line + 17).
  // All weeks: one arc, his longest make. Pick a game and its kicks play back one at a time: the ball's flight through the
  // uprights, or off to the side it missed (from the play text: "No Good, Wide Right"), dropping short, or blocked.
  // NFL records held by a player (src/nfl_records.py, from Wikipedia's record lists): [[record, value, when], ...]
  let recordsP = null;
  const nflRecords = (id) => (recordsP ||= getJSON("data/nfl/records.json").catch(() => ({}))).then((d) => d?.players?.[id] || []);
  async function kickChartInto(a, season, slot) {
    const id = encodeURIComponent(a.id);
    // his NFL record kick, if he has one (Cam Little's 68-yarder): drawn in gold
    const recFG = (await nflRecords(a.id)).find((r) => /^Longest field goal$/i.test(r[0]));
    const recD = recFG ? parseInt(recFG[1], 10) : null, recYr = recFG ? +(/(19|20)\d\d/.exec(recFG[2])?.[0] || 0) : 0;
    // one season's kicks: this season's chart file (src/pass_charts.py) or, for past seasons, the kick-only file (--kicks)
    const fetchSeason = async (y) => {
      let f = await getJSON(`data/nfl/${y}/charts/${id}.json`).catch(() => null);
      if (!f?.kick?.length) f = await getJSON(`data/nfl/${y}/kicks/${id}.json`).catch(() => null);
      return f?.kick?.length ? f : null;
    };
    // which seasons he has a chart for (pass_charts.py kick_index), for the season picker; "all" = his whole career on one field
    const idx = await getJSON("data/nfl/kicks_index.json").catch(() => ({}));
    const years = (idx[a.id] || [+season]).map(Number);
    let yr = String(years.includes(+season) ? +season : years.at(-1)), file = {}, kicks = [], weeks = [], sel = "all", halt = () => {};
    const got = new Map();
    const load = async () => {
      const list = yr === "all" ? years : [+yr];
      const files = (await Promise.all(list.map(async (y) => { if (!got.has(y)) got.set(y, await fetchSeason(y)); return [y, got.get(y)]; }))).filter(([, f]) => f);
      kicks = files.flatMap(([y, f]) => f.kick.map((r) => ({ yr: y, wk: r[0], q: r[1], clock: String(r[2]).replace(/^0(?=\d)/, ""), d: r[3], side: r[4], res: r[5], text: r[7] })))
        .map((k, i) => ({ ...k, i }));
      file = yr === "all" ? { xp: files.reduce((t, [, f]) => (f.xp ? [t[0] + f.xp[0], t[1] + f.xp[1]] : t), [0, 0]), ranks: {} } : files[0]?.[1] || {};
      weeks = [...new Set(kicks.map((k) => k.wk))].sort((x, y) => x - y);
      sel = "all";
    };
    await load();
    const secs = (c) => { const [m, s2] = String(c).split(":").map(Number); return (m || 0) * 60 + (s2 || 0); };
    if (!slot.isConnected) return;
    if (!kicks.length) return slot.remove();
    const WHAT = { g: "good", m: "no good", s: "short", b: "blocked" };
    const tip = (k) => `${yr === "all" ? `${k.yr}, ` : ""}Week ${k.wk}, Q${k.q} ${k.clock}: ${k.d}-yard try, ${WHAT[k.res]}. ${(k.text || "").replace(/^(\([^)]*\)\s*)+/, "")}`;
    const shell = () => {
      slot.innerHTML = `<div class="card pc kc"><div class="sc-bar"><h3>Kick chart</h3>
          <select id="kc-yr" aria-label="Season">${[...years].reverse().map((y) => `<option value="${y}"${String(y) === yr ? " selected" : ""}>${y}</option>`).join("")}${years.length > 1 ? `<option value="all"${yr === "all" ? " selected" : ""}>All years (${years[0]}–${String(years.at(-1)).slice(2)})</option>` : ""}</select>
          ${yr === "all" ? "" : `<select id="kc-wk" aria-label="Week"><option value="all">All weeks</option>${weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join("")}</select>`}</div>
        <div id="kc-body"></div></div>`;
      $("#kc-yr").onchange = async (e) => { halt(); yr = e.target.value; await load(); shell(); };
      if ($("#kc-wk")) $("#kc-wk").onchange = (e) => { sel = e.target.value; draw(); };
      draw();
    };
    const draw = () => {
      halt();
      const all = sel === "all", pts = kicks.filter((k) => all || k.wk === +sel).sort((p, q) => p.q - q.q || secs(q.clock) - secs(p.clock));
      // The field from the side, about 45 degrees off (like a camera in the stands): distance runs left to right toward the
      // posts on the right, height goes up, and across the field (lat, yards; + = the kicker's left) runs back into the
      // picture, so a kick wide left sails behind the far upright and wide right in front of the near one. That makes the
      // hash unimportant, so every kick starts on the middle line (no free data says which hash it was on).
      const narrow = slot.clientWidth < 560;
      const W = narrow ? 400 : 640, H = narrow ? 250 : 320, top = Math.max(70, Math.ceil((Math.max(...kicks.map((k) => k.d)) + 3) / 5) * 5); // always out past midfield
      // the whole strip fits: its near-left corner (pushed left by the slant) and far-right corner (pushed right) stay on the picture
      const LAT = 12, C45 = Math.SQRT1_2, M = 10, PX = (W - 2 * M) / (top + 2 * LAT * 0.45 * C45); // pixels per yard along the field
      const OB = 0.45 * PX, LEFT = M + LAT * OB * C45, BASE = H - LAT * OB * C45 - 14; // across the field is foreshortened, 45 degrees back
      const P = (d, lat = 0, h = 0) => [LEFT + (top - d) * PX + lat * OB * C45, BASE - lat * OB * C45 - h * PX]; // d = yards in front of the posts
      const pt = (d, lat) => P(d, lat).map((n) => n.toFixed(1)).join(",");
      const strip = (d0, d1, l0 = -LAT, l1 = LAT) => `${pt(d0, l0)} ${pt(d1, l0)} ${pt(d1, l1)} ${pt(d0, l1)}`;
      const half = 3.08; // the uprights are 18.5 feet apart: 3.08 yards either side of the middle
      const SNAP = 7; // the holder is 7 yards behind the line: a kick's distance to the posts is its line of scrimmage + 7 (+ 10 for the end zone)
      const g = [`<linearGradient id="pc-turf" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="pc-turf-near"/><stop offset="1" class="pc-turf-far"/></linearGradient>`,
        `<polygon class="pc-turf" points="${strip(top, 0)}"/>`]; // the field ends at the end line, where the posts stand
      for (let d = top; d > 10; d -= 10) if (Math.round((top - d) / 10) % 2 === 0) g.push(`<polygon class="pc-stripe" points="${strip(d, Math.max(10, d - 10))}"/>`);
      g.push(`<polygon class="kc-ez" points="${strip(10, 0)}"/>`); // the end zone
      for (let d = 10; d <= top; d += 5) { // yard lines, numbered like the field (the goal line is 10 yards in front of the posts)
        const [x0, y0] = P(d, -LAT), [x1, y1] = P(d, LAT), line = d - 10;
        g.push(`<line class="pc-yl${line % 10 ? " five" : ""}${line === 0 ? " kc-goal" : ""}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`);
      }
      // our logo painted at midfield (the 50 is 60 yards from the posts), lying flat on the field: the picture's width runs along
      // the field and its height runs back toward the far sideline, foreshortened and slanted like everything else (docs/img/cupcake-mark.svg, 217 x 304)
      { const [m0x, m0y] = P(60, -LAT), [m1x, m1y] = P(60, LAT); // the 50-yard line itself, brighter, and named at the far sideline
        g.push(`<line class="kc-fifty" x1="${m0x.toFixed(1)}" y1="${m0y.toFixed(1)}" x2="${m1x.toFixed(1)}" y2="${m1y.toFixed(1)}"/><text class="kc-axis" x="${(m1x + 4).toFixed(1)}" y="${(m1y - 4).toFixed(1)}">50 YD LINE</text>`); }
      { const ka = 9 / 217, kb = 12 / 304, a = PX * ka, c = -OB * C45 * kb, d2 = OB * C45 * kb, [mx, my] = P(60, 0); // 9 yards along, 12 across, centered on the 50
        g.push(`<image class="kc-logo" href="img/cupcake-mark.svg" width="217" height="304" transform="matrix(${a.toFixed(4)} 0 ${c.toFixed(4)} ${d2.toFixed(4)} ${(mx - a * 108.5 - c * 152).toFixed(1)} ${(my - d2 * 152).toFixed(1)})"/>`); }
      // kicks sit at their line of scrimmage, the way they're called: field goal distance = yard line + 17 (10 for the end zone,
      // 7 for the snap back to the holder), so a 60-yarder sits on the 43. The scale marks field goal distance at that spot.
      for (let fg = 20; fg - SNAP <= top; fg += 10) {
        const [tx, ty] = P(fg - SNAP, 0), [ux, uy] = P(fg - SNAP, -2.2);
        g.push(`<line class="kc-tick" x1="${tx.toFixed(1)}" y1="${ty.toFixed(1)}" x2="${ux.toFixed(1)}" y2="${uy.toFixed(1)}"/><text class="kc-num" x="${ux.toFixed(1)}" y="${(uy + 12).toFixed(1)}">${fg}</text>`);
      }
      { const [lx2, ly2] = P(top, -LAT); g.push(`<text class="kc-axis" x="${(lx2 + 4).toFixed(1)}" y="${(ly2 + 13).toFixed(1)}">FIELD GOAL DISTANCE (YARD LINE + 17)</text>`); }
      for (const lat of [-half, half]) for (let d = 11; d < top; d++) if (d % 5) { const [x0, y0] = P(d, lat - 0.5), [x1, y1] = P(d, lat + 0.5); g.push(`<line class="pc-hash" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`); }
      g.push(`<polygon class="pc-side" points="${strip(top, 0)}"/>`);
      // the goalposts on the end line, to scale: crossbar 10 feet up, uprights 35 feet above it. The far upright is drawn
      // first so kicks that go behind it read that way; the near one is drawn over the flights (below).
      const BAR = 3.33, TIP = BAR + 11.67, post = (lat, h0, h1) => { const [x0, y0] = P(0, lat, h0), [x1, y1] = P(0, lat, h1); return `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`; };
      const [bx0, by0] = P(0, half, BAR), [bx1, by1] = P(0, -half, BAR);
      g.push(`<path class="kc-post" d="${post(half, BAR, TIP)}M${bx0.toFixed(1)},${by0.toFixed(1)}L${bx1.toFixed(1)},${by1.toFixed(1)}${post(0, 0, BAR)}"/>`);
      const nearPost = `<path class="kc-post" d="${post(-half, BAR, TIP)}"/>`;
      // kick spots: on the middle line at the real distance, stepping back (into the picture) only so dots don't cover each other
      // many kicks (a career): smaller dots. Every dot stays on the field: when a spot is full it shares the least crowded one
      const rad = pts.length > 80 ? 2.6 : 4.2, step = pts.length > 80 ? 1.35 : 2.2, placed = [], spot = new Map();
      pts.slice().sort((p, q) => q.d - p.d || p.i - q.i).forEach((k) => {
        let lat = 0, fewest = Infinity;
        for (let n = 1; n < 80; n++) {
          const tl = Math.ceil((n - 1) / 2) * step * (n % 2 ? 1 : -1);
          if (Math.abs(tl) > LAT - 1) break; // the sidelines
          const [tx, ty] = P(k.d - SNAP, tl), hits = placed.filter((q) => (q.x - tx) ** 2 + (q.y - ty) ** 2 < (2 * rad + 0.5) ** 2).length;
          if (!hits) { lat = tl; break; }
          if (hits < fewest) { fewest = hits; lat = tl; }
        }
        const [x, y] = P(k.d - SNAP, lat);
        placed.push({ x, y });
        spot.set(k.i, [x, y, lat]);
      });
      // the flight in 3D: t runs 0 -> 1 from the spot to the end line (or where it fell). Height is a real arc, topping out
      // around 15 yards on a 50-yarder and crossing the posts about 6 yards up (over the crossbar); sideways it drifts out to
      // the side it missed, most of it late, the way a kick hooks. Short kicks land before the posts; blocked ones die off the spot.
      const flight = (k) => {
        const lat0 = spot.get(k.i)[2], d0 = k.d - SNAP, d1 = k.res === "b" ? Math.max(0, d0 - 5) : k.res === "s" ? 3 : 0;
        const aim = k.side === "l" ? half + 2 : k.side === "r" ? -half - 2 : 0;
        const apex = k.res === "b" ? 1.5 : 5 + k.d * 0.2, end = k.res === "g" || k.res === "m" ? 6 : 0;
        const out = [];
        for (let n = 0; n <= 36; n++) {
          const t = n / 36, d = d0 + (d1 - d0) * t, lat = lat0 + (aim - lat0) * t * t, h = apex * 4 * t * (1 - t) + end * t * t;
          const [x, y] = P(d, lat, h);
          out.push(`${n ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`);
        }
        return out.join("");
      };
      const cls = (k) => (k.res === "g" ? "make" : k.res === "s" ? "short" : k.res === "b" ? "block" : "miss");
      const made = pts.filter((k) => k.res === "g"), long = made.length ? made.reduce((p, q) => (q.d > p.d ? q : p)) : null;
      const rec = recD ? made.find((k) => k.d === recD && (!recYr || k.yr === recYr || !k.yr)) : null; // the NFL record kick, in gold
      const arcs = all ? [...new Set([long, rec].filter(Boolean))] : pts; // the season view keeps one arc: the longest make (and the record)
      arcs.forEach((k) => g.push(`<path class="kc-arc ${cls(k)}${all ? " long" : ""}${k === rec ? " rec" : ""}" data-i="${k.i}" d="${flight(k)}"/>`));
      g.push(nearPost);
      pts.slice().sort((p, q) => (q.res === "g") - (p.res === "g")).forEach((k) => { // makes first, misses drawn on top
        const [x, y] = spot.get(k.i);
        g.push(`<circle class="kc-dot ${cls(k)}${pts.length > 80 ? " many" : ""}${k === rec ? " rec" : ""}" data-i="${k.i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}"><title>${esc(tip(k))}</title></circle>`);
        if (!all) g.push(`<text class="kc-dist" data-i="${k.i}" x="${x.toFixed(1)}" y="${(y + 15).toFixed(1)}">${k.d}</text>`); // a game: each kick's distance under its spot
      });
      // above-left of the dot, clear of the yard numbers; the record kick says so
      if (all && long) { const [x, y] = spot.get(long.i); g.push(`<text class="kc-long${long === rec ? " rec" : ""}" x="${(x - 8).toFixed(1)}" y="${(y - 9).toFixed(1)}">${long === rec ? "NFL RECORD" : "LONG"} ${long.d}</text>`); }
      else if (rec) { const [x, y] = spot.get(rec.i); g.push(`<text class="kc-long rec" x="${(x - 8).toFixed(1)}" y="${(y - 9).toFixed(1)}">NFL RECORD ${rec.d}</text>`); }
      g.push(`<circle class="kc-ball" id="kc-ball" r="4"/>`);
      // the numbers over the chart, ranked against the league's kickers on "All weeks" (src/pass_charts.py)
      const R = all ? file.ranks?.kick : null, rk = (key) => (R?.[key] ? `<em class="ay-rk${R[key][0] <= 5 ? " top" : ""}">#${R[key][0]} of ${R[key][1]}</em>` : "");
      const stat = (v, label, c2 = "", key = "") => `<span class="ay-stat ${c2}"><b>${v}</b><small>${label}</small>${rk(key)}</span>`;
      const far = pts.filter((k) => k.d >= 50), xp = all ? file.xp : null;
      const chip = (c2, label) => `<span class="pc-chip"><span class="ay-key ${c2}"></span>${label}</span>`;
      $("#kc-body").innerHTML = `<div class="ay-stats">${stat(`${made.length}/${pts.length}`, "Field goals", "big")}${stat(pts.length ? `${Math.round((100 * made.length) / pts.length)}%` : "–", "Made", "", "pct")}
          ${stat(long ? long.d : "–", "Longest", "", "long")}${stat(`${far.filter((k) => k.res === "g").length}/${far.length}`, "From 50+", "", "fg50")}${xp ? stat(`${xp[0]}/${xp[1]}`, "Extra points") : ""}</div>
        <div class="pc-ctl">${all ? "" : `<button class="gcv-live" id="kc-go">▶ Play</button>`}<span class="muted">${pts.length} kick${pts.length === 1 ? "" : "s"}${all ? (yr === "all" ? " · pick a season to play its games back" : " · pick a week to play them back") : ""}</span><span class="pc-legend">${chip("kc-k-make", "Good")}${pts.some((k) => k.res === "m") ? chip("kc-k-miss", "Missed") : ""}${pts.some((k) => k.res === "s") ? chip("kc-k-short", "Short") : ""}${pts.some((k) => k.res === "b") ? chip("kc-k-block", "Blocked") : ""}</span></div>
        <div class="pc-stage"><svg class="pc-field kc-field" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(a.displayName)} kick chart">${g.join("")}</svg></div>
        <p class="kc-play muted" id="kc-play">${all ? `The arc is his longest make. Tap a kick for the play.` : "Tap a kick for the play."}</p>${rec ? `<p class="rec-txt">★ Gold = the NFL record: ${esc(recFG[0].toLowerCase())}, ${esc(recFG[1])} (${esc(recFG[2])}).</p>`
          : recFG && years.includes(recYr) ? `<p class="rec-txt">★ His NFL-record ${esc(recFG[1])} field goal (${esc(recFG[2])}) is in gold under ${recYr} and All years.</p>` : ""}
        <p class="note">Every field goal try (nflverse play-by-play, through Week ${file.ranks?.kick?._wk ?? "–"}). Seen from the side: each dot is the kick's line of scrimmage (field goal distance = yard line + 17), and the line is the ball's flight. A miss wide left goes behind the far upright, wide right in front of the near one; which way a miss went comes from the play-by-play text. Ranks: NFL kickers with ${file.ranks?.kick?._min ?? "–"}+ tries.</p>`;
      const svg = slot.querySelector(".kc-field"), ball = svg.querySelector("#kc-ball");
      // drag across the field: a line at that distance, with how far it is from the posts and which yard line it is
      svg.insertAdjacentHTML("beforeend", `<g class="sc-scan hidden"></g>`);
      const scan = svg.querySelector(".sc-scan");
      scrubber(svg, (p) => {
        const d = Math.round(Math.min(top, Math.max(0, top - (p.x - LEFT) / PX)));
        const [x0, y0] = P(d, -LAT), [x1, y1] = P(d, LAT), line = d - 10;
        scan.innerHTML = `<line class="sc-line" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>${scanTag(x1, y1 - 14, d <= 10 ? "end zone" : `${d + SNAP}-yd FG · from the ${line > 50 ? 100 - line : line}`)}`;
        scan.classList.remove("hidden");
      }, () => scan.classList.add("hidden"));
      pinchPan(slot.querySelector(".kc .pc-stage"));
      const pick = (k) => {
        svg.querySelectorAll(".on").forEach((x) => x.classList.remove("on"));
        svg.querySelectorAll(`[data-i="${k.i}"]`).forEach((x) => x.classList.add("on"));
        svg.classList.add("picked");
        $("#kc-play").textContent = tip(k);
      };
      svg.addEventListener("click", (e) => { const el = e.target.closest("[data-i]"), k = el && kicks[+el.dataset.i]; if (k) { halt(); show(pts); pick(k); } });
      const show = (list) => list.forEach((k) => svg.querySelectorAll(`[data-i="${k.i}"]`).forEach((x) => { x.classList.remove("kc-wait"); x.style.strokeDashoffset = ""; }));
      // play a game back: each kick's dot appears, the ball flies along its arc, then the next one
      const play = () => {
        halt();
        let stop = false, timer = 0, raf = 0;
        halt = () => { stop = true; clearTimeout(timer); cancelAnimationFrame(raf); ball.classList.remove("on"); show(pts); };
        svg.classList.remove("picked");
        pts.forEach((k) => svg.querySelectorAll(`[data-i="${k.i}"]`).forEach((x) => x.classList.add("kc-wait")));
        const one = (n) => {
          if (stop || n >= pts.length) { if (!stop) { ball.classList.remove("on"); $("#kc-play").textContent = "Tap a kick for the play."; } return; }
          const k = pts[n], dot = svg.querySelector(`.kc-dot[data-i="${k.i}"]`), arc = svg.querySelector(`.kc-arc[data-i="${k.i}"]`);
          dot.classList.remove("kc-wait");
          svg.querySelector(`.kc-dist[data-i="${k.i}"]`)?.classList.remove("kc-wait");
          $("#kc-play").textContent = tip(k);
          const L = arc.getTotalLength(), t0 = performance.now(), dur = 1100;
          arc.style.strokeDasharray = `${L}`; arc.style.strokeDashoffset = `${L}`; arc.classList.remove("kc-wait");
          ball.classList.add("on");
          const step = (now) => {
            if (stop) return;
            const t = Math.min(1, (now - t0) / dur), p = arc.getPointAtLength(L * t);
            arc.style.strokeDashoffset = `${L * (1 - t)}`;
            ball.setAttribute("cx", p.x.toFixed(1)); ball.setAttribute("cy", p.y.toFixed(1));
            if (t < 1) raf = requestAnimationFrame(step);
            else { arc.style.strokeDasharray = ""; arc.style.strokeDashoffset = ""; ball.classList.remove("on"); timer = setTimeout(() => one(n + 1), 650); }
          };
          timer = setTimeout(() => { raf = requestAnimationFrame(step); }, 350);
        };
        one(0);
      };
      $("#kc-go")?.addEventListener("click", play);
      if (!all) play(); // picking a game plays it
    };
    shell();
  }
  // Player page: a chart of every throw (QBs), target (WRs, TEs, RBs) or run (RBs) this season, seen from behind the line.
  // Left/middle/right across, yards downfield up. Pick a week to play it back one snap at a time; "All weeks" is the combined, still chart.
  // Built from each game's play-by-play (airPasses / rushPlays above), so it only loads when you scroll to it.
  const PC_MODES = {
    pass: { tab: "Throws", title: "Pass chart", per: "air yards per catch", noun: "throws", y: "air yards" },
    target: { tab: "Targets", title: "Target chart", per: "air yards per catch", noun: "targets", y: "air yards" },
    rush: { tab: "Runs", title: "Rush chart", per: "yards per carry", noun: "runs", y: "yards" },
  };
  async function passChartInto(lg, a, gl, slot, modes, season, params = null) {
    const ids = Object.keys(gl?.events || {});
    if (!ids.length) return slot.remove();
    const evs = ids.map((id) => ({ id, ...gl.events[id] })).sort((x, y) => new Date(x.gameDate) - new Date(y.gameDate));
    // NFL: src/pass_charts.py's file from nflverse (it has where every incomplete pass was thrown); its weeks are matched to ESPN's games by date
    const file = lg === "nfl" && season ? await getJSON(`data/nfl/${season}/charts/${encodeURIComponent(a.id)}.json`).catch(() => null) : null;
    const day = (d) => Math.round(new Date(d).getTime() / 864e5);
    const fileWk = evs.map((e) => { const w = Object.keys(file?.dates || {}).find((k) => Math.abs(day(file.dates[k]) - day(e.gameDate)) <= 1); return w == null ? null : +w; });
    const sums = await Promise.all(evs.map((e, gi) => fileWk[gi] != null ? null : api(`${SITE(lg)}/summary?event=${encodeURIComponent(e.id)}`, 3600000).catch(() => null)));
    if (!slot.isConnected) return;
    const norm = (x) => (x || "").toLowerCase().replace(/[^a-z]/g, "");
    const last = norm((a.lastName || "").split(" ")[0]), first = norm(a.firstName);
    const isMe = (nm) => { const m = /^([A-Za-z']+)\.\s?([A-Za-z'\-]+)/.exec(nm || ""); return !!m && norm(m[2]) === last && first.startsWith(norm(m[1])); };
    const plays = { pass: [], target: [], rush: [] };
    const fromFile = (r, i, md, gi) => ({ g: gi, air: r[3], dir: r[4], gap: r[4], inc: r[5] === "i" || r[5] === "x", int: r[5] === "x" || r[5] === "f", td: r[5] === "t", yac: r[6] || 0,
      half: r[1] <= 2 ? 1 : 2, p: { id: `${gi}-${md}-${i}`, period: { number: r[1] }, clock: { displayValue: String(r[2]).replace(/^0(?=\d)/, "") }, text: r[7] } });
    evs.forEach((e, gi) => {
      if (fileWk[gi] != null) return ["pass", "target", "rush"].forEach((md) => (file[md] || []).forEach((r, i) => { if (r[0] === fileWk[gi]) plays[md].push(fromFile(r, i, md, gi)); }));
      if (!sums[gi]) return;
      const ps = airPasses(sums[gi]);
      ps.filter((x) => isMe(x.qb)).forEach((x) => plays.pass.push({ ...x, g: gi }));
      ps.filter((x) => isMe(x.to)).forEach((x) => plays.target.push({ ...x, g: gi }));
      rushPlays(sums[gi]).filter((x) => isMe(x.qb)).forEach((x) => plays.rush.push({ ...x, g: gi }));
    });
    modes = modes.filter((m) => plays[m].some((x) => x.air != null));
    if (!modes.length) return slot.remove();
    // a shared link (?chart=rush&cw=<game id>) opens that tab and week; otherwise the first tab on the most recent game
    let mode = modes.includes(params?.get("chart")) ? params.get("chart") : modes[0], halt = () => {};
    let sel = params?.get("cw") === "all" ? "all" : (() => { const gi = evs.findIndex((e) => String(e.id) === params?.get("cw")); return gi >= 0 ? String(gi) : null; })();
    const gamesOf = (md) => evs.map((e, gi) => ({ gi, label: `Wk ${e.week ?? ""} ${e.atVs || ""} ${e.opponent?.abbreviation || ""}`.trim(), n: plays[md].filter((x) => x.g === gi && x.air != null).length })).filter((g) => g.n);
    const shell = () => {
      const games = gamesOf(mode);
      if (sel === null || (sel !== "all" && !games.some((g) => String(g.gi) === sel))) sel = games.length ? String(games.at(-1).gi) : "all";
      slot.innerHTML = `<div class="card pc"><div class="sc-bar"><h3>${PC_MODES[mode].title}</h3>
          ${modes.length > 1 ? `<div class="seg pc-mode">${modes.map((m) => `<button data-pm="${m}" class="${m === mode ? "active" : ""}">${PC_MODES[m].tab}</button>`).join("")}</div>` : ""}
          <select id="pc-game"><option value="all"${sel === "all" ? " selected" : ""}>All weeks (combined)</option>${games.map((g) => `<option value="${g.gi}"${String(g.gi) === sel ? " selected" : ""}>${esc(g.label)}</option>`).join("")}</select><span class="br-tools pc-share">${Share.menuHtml()}</span></div>
        <div id="pc-body"></div></div>`;
      Share.wire(slot.querySelector(".pc"), { image });
      slot.querySelector(".pc-mode")?.addEventListener("click", (e) => { const m = e.target.closest("[data-pm]")?.dataset.pm; if (m && m !== mode) { halt(); mode = m; shell(); } });
      $("#pc-game").onchange = (e) => { sel = e.target.value; draw(); };
      draw();
    };
    // Share: the page's link remembers the tab and week (?chart=pass&cw=<ESPN game id> or all), so Copy Link opens right here.
    const setUrl = () => {
      const [path, q] = location.hash.split("?"), u = new URLSearchParams(q || "");
      u.set("chart", mode); u.set("cw", sel === "all" ? "all" : String(evs[+sel]?.id || "all"));
      history.replaceState(null, "", `${path}?${u}`);
    };
    // Save Image: the chart's SVG (with its CSS colors copied onto each shape, since a picture can't see the page's styles),
    // drawn on the site's 1600x900 share card with the stat tiles down the side
    const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-size", "font-family", "font-weight", "text-anchor", "letter-spacing", "paint-order", "stop-color", "display"];
    const svgPicture = (svg) => {
      const copy = svg.cloneNode(true), from = [svg, ...svg.querySelectorAll("*")], to = [copy, ...copy.querySelectorAll("*")];
      from.forEach((el, n) => { const cs = getComputedStyle(el); to[n].setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";")); to[n].removeAttribute("class"); });
      to.filter((el) => el.tagName === "title").forEach((el) => el.remove());
      const vb = svg.viewBox.baseVal;
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg"); copy.setAttribute("width", vb.width * 2); copy.setAttribute("height", vb.height * 2);
      return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`, w: vb.width, h: vb.height };
    };
    const image = async () => {
      const svg = slot.querySelector(".pc-field");
      if (!svg) throw new Error("Nothing to draw");
      const pic = svgPicture(svg), field = await new Promise((ok) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = pic.url; });
      if (!field) throw new Error("Couldn't draw it");
      const M = PC_MODES[mode], game = gamesOf(mode).find((x) => String(x.gi) === sel);
      const tiles = [...slot.querySelectorAll(".ay-stat")].map((e) => [e.querySelector("b")?.textContent.trim() || "", e.querySelector("small")?.textContent.trim() || "", e.querySelector("em")?.textContent.trim() || ""]);
      const legend = [...slot.querySelectorAll(".pc-chip")].map((e) => { // [kind, label, color] in the page's own colors
        const key = e.querySelector(".ay-key"), cs = key ? getComputedStyle(key) : null, bg = cs?.backgroundColor || "";
        return [key?.className.replace("ay-key", "").trim() || "", e.textContent.trim(), bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : cs?.borderTopColor || "#fff"];
      });
      const blob = await Share.png({
        title: `${a.displayName} · ${M.title}`.toUpperCase(),
        sub: `${sel === "all" ? `${season || ""} season, all weeks`.trim() : game?.label || ""}${a.team?.displayName ? ` · ${a.team.displayName}` : ""}`,
        logoUrls: new Map(a.headshot?.href ? [["face", a.headshot.href]] : []),
        paint: ({ x, text, F, C, logos }) => {
          // the field, as big as it fits on the left
          const bw = 1000, bh = 690, s = Math.min(bw / pic.w, bh / pic.h), dw = pic.w * s, dh = pic.h * s;
          x.drawImage(field, 48 + (bw - dw) / 2, 150 + (bh - dh) / 2, dw, dh);
          // legend under the field
          let lx = 48;
          for (const [k, label, col] of legend) {
            x.beginPath(); x.arc(lx + 7, 862, 6, 0, Math.PI * 2);
            if (k === "inc" || k === "yac") { x.strokeStyle = col; x.lineWidth = 2; if (k === "yac") x.setLineDash([2, 3]); x.stroke(); x.setLineDash([]); } else { x.fillStyle = col; x.fill(); }
            text(label, lx + 20, 868, F(400, 17), C.muted); x.font = F(400, 17); lx += 40 + x.measureText(label).width;
          }
          // headshot and stat tiles down the right side
          let ty = 168;
          const face = logos.get("face");
          if (face) { const fh = 96, fw = (face.width / face.height) * fh; x.drawImage(face, 1100, ty, fw, fh); ty += 120; }
          tiles.forEach(([v, label, rank], n) => {
            text(v.replace(/\s+/g, " "), 1100, ty + 34, F(700, n ? 34 : 44), n ? C.ink : C.accent, "left", 450);
            text(label, 1100, ty + 60, F(400, 18), C.muted, "left", 450);
            if (rank) text(rank, 1552, ty + 34, F(700, 18), C.accent, "right");
            ty += n ? 86 : 96;
          });
        },
      });
      const slug = (a.displayName || "player").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return { blob, name: `cupcake-index-${slug}-${mode}-${sel === "all" ? "season" : (game?.label || "week").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png` };
    };
    const draw = () => {
      halt();
      setUrl();
      const M = PC_MODES[mode], rush = mode === "rush", games = gamesOf(mode);
      const list = plays[mode].filter((x) => sel === "all" || x.g === +sel), pts = list.filter((x) => x.air != null);
      const caught = pts.filter((x) => !x.inc), avg = (xs) => (xs.length ? xs.reduce((n, x) => n + x.air, 0) / xs.length : null);
      const f1 = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + Math.abs(v).toFixed(1));
      const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "–");
      // The field in perspective, drawn right in the SVG (a TV view from behind the line): far yards get narrower and closer together.
      // fx = across the field (0 = left sideline, 1 = right), v = yards past the line of scrimmage.
      const narrow = slot.clientWidth < 560; // phones get a taller field so the text stays readable
      const W = narrow ? 400 : 640, H = narrow ? 460 : 380, NEAR = H - 34, FAR = 22, NW = W - 24, FW = W * (narrow ? 0.62 : 0.56), K = NW / FW - 1;
      const maxV = Math.max(...pts.map((x) => x.air + (mode === "target" && !x.inc ? Math.max(0, x.yac || 0) : 0)));
      const top = Math.max(rush ? 20 : 40, Math.ceil((maxV + 3) / 10) * 10), bot = Math.min(-8, Math.floor((Math.min(...pts.map((x) => x.air)) - 2) / 5) * 5);
      const z = (v) => 1 + K * ((v - bot) / (top - bot)), S = (v) => 1 / z(v);
      const P = (fx, v) => [W / 2 + (fx - 0.5) * NW * S(v), NEAR - ((NEAR - FAR) * (1 - S(v))) / (1 - 1 / (1 + K))];
      const pt = (fx, v) => P(fx, v).map((n) => n.toFixed(1)).join(",");
      const band = (v0, v1, f0 = 0, f1 = 1) => `${pt(f0, v0)} ${pt(f1, v0)} ${pt(f1, v1)} ${pt(f0, v1)}`;
      // Across the field the play-by-play only says left, middle or right (runs: the gap), so each play goes in its lane at its
      // real depth. Inside a lane nothing is guessed: dots start at the lane's center and only step aside so they don't cover each other.
      const rad = (v) => 4 * S(v) + 1.8;
      const lane = (x) => {
        if (!rush) return { left: [0, 1 / 3], middle: [1 / 3, 2 / 3], right: [2 / 3, 1] }[x.dir] || [1 / 3, 2 / 3];
        const c = GAPS[x.gap] ?? 0.5, half = /end|tackle|guard|up the/.test(x.gap) ? 0.055 : 0.11;
        return [c - half, c + half];
      };
      const g = [`<linearGradient id="pc-turf" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="pc-turf-near"/><stop offset="1" class="pc-turf-far"/></linearGradient>`,
        `<polygon class="pc-turf" points="${band(bot, top)}"/>`];
      for (let v = Math.ceil(bot / 10) * 10; v < top; v += 10) if (Math.round(v / 10) % 2 === 0) g.push(`<polygon class="pc-stripe" points="${band(Math.max(v, bot), Math.min(v + 10, top))}"/>`);
      g.push(`<polygon class="pc-back" points="${band(bot, 0)}"/>`);
      if (!rush) for (const f of [1 / 3, 2 / 3]) g.push(`<line class="pc-lanediv" x1="${P(f, bot)[0].toFixed(1)}" y1="${P(f, bot)[1].toFixed(1)}" x2="${P(f, top)[0].toFixed(1)}" y2="${P(f, top)[1].toFixed(1)}"/>`);
      for (let v = bot + 1; v < top; v++) if (v % 5) for (const hf of [0.4, 0.6]) g.push(`<line class="pc-hash" x1="${P(hf - 0.012, v)[0].toFixed(1)}" x2="${P(hf + 0.012, v)[0].toFixed(1)}" y1="${P(hf, v)[1].toFixed(1)}" y2="${P(hf, v)[1].toFixed(1)}"/>`);
      for (let v = Math.ceil(bot / 5) * 5; v <= top; v += 5) {
        if (!v) continue;
        const [x0, y] = P(0, v), [x1] = P(1, v), fs = (8 * S(v) + 4).toFixed(1);
        g.push(`<line class="pc-yl${v % 10 ? " five" : ""}" x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`);
        if (!(v % 10)) g.push(`<text class="pc-num" x="${P(0.035, v)[0].toFixed(1)}" y="${(y - 3).toFixed(1)}" style="font-size:${fs}px">${v > 0 ? "+" : "−"}${Math.abs(v)}</text><text class="pc-num r" x="${P(0.965, v)[0].toFixed(1)}" y="${(y - 3).toFixed(1)}" style="font-size:${fs}px">${v > 0 ? "+" : "−"}${Math.abs(v)}</text>`);
      }
      g.push(`<polygon class="pc-side" points="${band(bot, top)}"/>`);
      const [lx0, ly] = P(0, 0), [lx1] = P(1, 0);
      g.push(`<line class="ay-los pc-losl" x1="${lx0}" x2="${lx1}" y1="${ly}" y2="${ly}"/>`);
      const labels = [`<text class="pc-los" x="${lx0 + 4}" y="${ly + 13}">LOS</text><text class="pc-los r" x="${lx1 - 4}" y="${ly + 13}">LOS</text>`]; // drawn over the dots
      const mid = rush ? avg(caught) : avg(pts); // the dashed line: yards per carry, or aDOT
      if (mid != null) { const [mx0, my] = P(0, mid), [mx1] = P(1, mid); g.push(`<line class="ay-avg" x1="${mx0}" x2="${mx1}" y1="${my}" y2="${my}"/>`); labels.push(`<text class="pc-avg" x="${mx1 - 8}" y="${my + 12}">${rush ? "AVG" : "aDOT"} ${f1(mid)}</text>`); }
      // where each lane is, under the field
      const lanes = rush ? [["left end", "END"], ["left tackle", "TKL"], ["left guard", "GRD"], ["up the middle", "MID"], ["right guard", "GRD"], ["right tackle", "TKL"], ["right end", "END"]].map(([k2, l]) => [GAPS[k2], l])
        : [[1 / 6, "LEFT"], [0.5, "MIDDLE"], [5 / 6, "RIGHT"]];
      for (const [f, l] of lanes) g.push(`<text class="pc-lane" x="${P(f, bot)[0].toFixed(1)}" y="${H - 10}">${l}</text>`);
      // targets: a dotted line from where he caught it to where the play ended (yards after the catch)
      const pos = new Array(pts.length), placed = [];
      pts.map((x, i) => i).sort((i, j) => pts[i].air - pts[j].air || i - j).forEach((i) => {
        const v = pts[i].air, [lo, hi] = lane(pts[i]), r = rad(v), [cx, cy] = P((lo + hi) / 2, v);
        const xmin = P(lo, v)[0] + r + 1, xmax = P(hi, v)[0] - r - 1;
        let best = cx;
        for (let n = 1; n < 60; n++) { // 0, +1, -1, +2, -2 ... steps from the center until there's room
          const tx = cx + Math.ceil((n - 1) / 2) * r * 0.9 * (n % 2 ? 1 : -1);
          if (tx < xmin || tx > xmax) continue;
          if (placed.every((q) => (q.x - tx) ** 2 + (q.y - cy) ** 2 >= (q.r + r + 0.5) ** 2)) { best = tx; break; }
        }
        placed.push({ x: best, y: cy, r });
        pos[i] = { f: 0.5 + (best - W / 2) / (NW * S(v)), v };
      });
      pts.forEach((x, i) => {
        if (mode !== "target" || x.inc || !x.yac) return;
        const [ax, ay] = P(pos[i].f, x.air), [bx, by] = P(pos[i].f, x.air + x.yac);
        g.push(`<line class="pc-yac" data-i="${i}" x1="${ax.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${ay.toFixed(1)}" y2="${by.toFixed(1)}"/><circle class="pc-yacend" data-i="${i}" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${(2.6 * S(x.air + x.yac) + 0.8).toFixed(1)}"/>`);
      });
      // runs: a dotted path from the ball carrier's spot behind the line, bending toward the gap he ran through, to where he was stopped
      const runD = (i) => {
        const [sx, sy] = P(0.5, bot + 3), [ex, ey] = P(pos[i].f, pts[i].air), [cx, cy] = P(0.5 + (pos[i].f - 0.5) * 0.9, Math.min(0, pts[i].air) - 1);
        return `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`;
      };
      if (rush) pts.forEach((x, i) => g.push(`<path class="pc-run${x.td ? " td" : ""}" data-i="${i}" d="${runD(i)}"/>`));
      g.push(`<path class="pc-arc" id="pc-arc" d=""/>`);
      const what = (x) => (x.td ? "touchdown" : x.int ? (rush ? "fumble lost" : "intercepted") : x.inc ? "incomplete" : "");
      // misses first, then catches, then picks on top so they never hide
      const layer = (x) => (x.int ? 2 : x.inc ? 0 : 1);
      pts.map((x, i) => i).sort((i, j) => layer(pts[i]) - layer(pts[j]) || pts[j].air - pts[i].air).forEach((i) => {
        const x = pts[i], [cx, cy] = P(pos[i].f, x.air);
        let tip = `${games.find((q) => q.gi === x.g)?.label || ""} · Q${x.p.period?.number || ""} ${x.p.clock?.displayValue || ""}: ${x.air} ${M.y}${what(x) ? ", " + what(x) : ""}. ${(x.p.text || "").replace(/^(\([^)]*\)\s*)+/, "")}`;
        if (mode === "target" && x.yac && !x.inc) tip = tip.replace(`${x.air} ${M.y}`, `caught ${x.air} yds out, ${x.yac} after the catch`);
        g.push(`<circle class="ay-dot${x.inc ? " inc" : ""}${x.int ? " int" : ""}${x.td ? " td" : ""}" data-i="${i}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad(x.air).toFixed(1)}"><title>${esc(tip)}</title></circle>`);
      });
      g.push(...labels);
      const QB = { f: 0.5, v: bot + 3 }, [qx, qy] = P(QB.f, QB.v), tag = mode === "rush" ? (a.position?.abbreviation || "RB").slice(0, 2) : "QB";
      g.push(`<circle class="pc-qb" cx="${qx}" cy="${qy}" r="10"/><text class="pc-qbt" x="${qx}" y="${qy + 3.5}">${esc(tag)}</text>`,
        `<circle class="pc-flash" id="pc-flash" r="6"/>`);
      // league ranks (NFL, from src/pass_charts.py) go under each stat on "All weeks"
      const R = sel === "all" ? file?.ranks?.[mode] : null;
      const rk = (key) => (R?.[key] ? `<em class="ay-rk${R[key][0] <= 5 ? " top" : ""}">#${R[key][0]} of ${R[key][1]}</em>` : "");
      const stat = (v, label, cls = "", key = "") => `<span class="ay-stat ${cls}"${key ? ` data-k="${key}"` : ""}><b>${v}</b><small>${label}</small>${rk(key)}</span>`;
      const share = (f, xs) => pct(xs.filter(f).length, xs.length);
      const mean = (xs) => (xs.length ? xs.reduce((n, v) => n + v, 0) / xs.length : null);
      const halvesOf = (xs) => { const a1 = avg(xs.filter((x) => x.half === 1)), a2 = avg(xs.filter((x) => x.half === 2));
        return stat(`${f1(a1)} <i>→</i> <span class="${a1 != null && a2 != null ? (a2 < a1 ? "down" : "up") : ""}">${f1(a2)}</span>`, "1st half → 2nd half", "halves"); };
      const stats = rush
        ? stat(f1(avg(caught)), "yards per carry", "big", "ypc") + halvesOf(caught) + stat(share((x) => x.air >= 10, caught), "runs of 10+ yds", "", "big") + stat(share((x) => x.air <= 0, caught), "stuffed (0 or less)", "", "stuff")
        : mode === "target"
          ? stat(f1(avg(pts)), "aDOT (avg depth of target)", "big", "adot") + stat(f1(mean(caught.map((x) => x.yac || 0))), "YAC per catch", "", "yac") + stat(`${list.filter((x) => !x.inc).length}/${list.length}`, `caught (${pct(list.filter((x) => !x.inc).length, list.length)})`, "", "catch") + stat(share((x) => x.air >= 20, pts), "targets 20+ yds out", "", "deep")
          : stat(f1(avg(pts)), "aDOT (air yards per throw)", "big", "adot") + stat(`${list.filter((x) => !x.inc).length}/${list.length}`, `completed (${pct(list.filter((x) => !x.inc).length, list.length)})`, "", "cmp") + stat(f1(avg(caught)), "air yards per catch", "", "aypc") + halvesOf(pts) + stat(share((x) => x.air >= 20, pts), "throws 20+ yds out", "", "deep") + stat(share((x) => x.air < 0, pts), "thrown behind the line");
      const nInc = list.filter((x) => x.inc && x.air == null).length;
      const chip = (cls, label) => `<span class="pc-chip"><span class="ay-key ${cls}"></span>${label}</span>`;
      const legend = rush ? chip("", "Run") + chip("td", "Touchdown") + (pts.some((x) => x.int) ? chip("int", "Fumble lost") : "")
        : chip("", "Caught") + chip("td", "Touchdown") + (pts.some((x) => x.inc && !x.int) ? chip("inc", "Incomplete") : "") + (pts.some((x) => x.int) ? chip("int", "Intercepted") : "") + (mode === "target" && pts.some((x) => x.yac && !x.inc) ? chip("yac", "After the catch") : "");
      const fine = [rush ? "Each run sits in its gap (college play-by-play only says left, middle or right), at the yards it gained. Side by side in a gap only means they'd overlap." : "The play-by-play says how far each throw went and whether it went left, middle or right (from the QB's view), so each one sits in its lane at its real depth. Dots side by side in a lane only means they'd overlap, not where on the field they were.",
        mode === "target" ? "Routes run aren't in any free data, so this shows the throws that came his way." : "",
        nInc ? `${nInc} incomplete pass${nInc === 1 ? "" : "es"} not shown (ESPN doesn't mark where ${nInc === 1 ? "it was" : "they were"} thrown).` : "",
        R ? `Ranks: NFL ${R._qb ? "QBs" : "players"} with ${R._min}+ ${M.noun} through Week ${R._wk}${mode === "rush" ? " (stuffed: #1 = fewest)" : ""}.` : "", "Tap a dot for the play."].filter(Boolean).join(" ");
      $("#pc-body").innerHTML = `<div class="ay-stats">${stats}</div>
        <div class="pc-ctl">${sel === "all" ? "" : `<button class="gcv-live" id="pc-play">▶ Play</button>`}<span class="muted" id="pc-now">${pts.length} ${mode === "rush" ? "runs" : mode === "target" ? "targets" : "throws"}${sel === "all" ? ` · ${games.length} game${games.length === 1 ? "" : "s"} · pick a week to play them back` : ""}</span><span class="pc-legend">${legend}</span></div>
        <div class="pc-stage"><svg class="pc-field" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(a.displayName)} ${esc(M.title.toLowerCase())}"><defs><filter id="gcv-glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${g.join("")}</svg></div>
        <p class="note">${fine}</p>`;
      // Play (one week only): hide everything, then run the plays in order. A thin line draws from the QB to the spot, the dot lands,
      // and a completion (or a run) flashes a ring out from it (white for a touchdown). "All weeks" never animates.
      let timer = null, landT = null, k = 0;
      const btn = $("#pc-play"), now = $("#pc-now"), els = pts.map((_, i) => [...slot.querySelectorAll(`.pc-field [data-i="${i}"]`)]);
      // drag up and down the field: a line at that depth, with how many yards past (or behind) the line of scrimmage it is
      const fieldSvg = slot.querySelector(".pc-field");
      fieldSvg.insertAdjacentHTML("beforeend", `<g class="sc-scan hidden"></g>`);
      const scan = fieldSvg.querySelector(".sc-scan");
      pinchPan(slot.querySelector(".pc-stage"));
      scrubber(fieldSvg, (p) => {
        const sv = 1 - ((NEAR - Math.min(NEAR, Math.max(FAR, p.y))) * (1 - 1 / (1 + K))) / (NEAR - FAR); // invert P: screen height -> depth
        const v = Math.round(bot + ((1 / sv - 1) / K) * (top - bot));
        const [x0, y] = P(0, v), [x1] = P(1, v);
        scan.innerHTML = `<line class="sc-line" x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y.toFixed(1)}"/>${scanTag(x1 - 4, y - 12, v === 0 ? "at the line" : `${v > 0 ? "+" : "−"}${Math.abs(v)} yds`, "end")}`;
        scan.classList.remove("hidden");
      }, () => scan.classList.add("hidden"), "y"); // read up and down
      const arc = $("#pc-arc"), flash = $("#pc-flash");
      const show = (i, on) => els[i]?.forEach((e) => e.classList.toggle("pc-hide", !on));
      // the completions tile counts up as each throw lands (1/1, 1/2, 2/3 ...), and goes back to the full game when playback ends
      const tile = slot.querySelector('.ay-stat[data-k="cmp"], .ay-stat[data-k="catch"]'), tileB = tile?.querySelector("b"), tileS = tile?.querySelector("small");
      const full = tile ? [tileB.innerHTML, tileS.innerHTML] : null, word = mode === "target" ? "caught" : "completed";
      let landed = 0;
      const tally = (n) => {
        if (!tile) return;
        const c = pts.slice(0, n).filter((x) => !x.inc).length;
        tileB.textContent = `${c}/${n}`; tileS.textContent = `${word} (${n ? pct(c, n) : "–"})`;
        tile.classList.add("pc-live"); tile.classList.remove("pc-tick"); void tile.offsetWidth; if (n) tile.classList.add("pc-tick");
      };
      const land = (i) => { show(i, true); if (i + 1 > landed) { landed = i + 1; tally(landed); } };
      const stop = (done) => {
        clearTimeout(timer); clearTimeout(landT); timer = null; btn.textContent = done ? "↺ Replay" : "▶ Play"; arc.setAttribute("d", ""); arc.dataset.i = ""; flash.classList.remove("go");
        if (done && tile) { tileB.innerHTML = full[0]; tileS.innerHTML = full[1]; tile.classList.remove("pc-live", "pc-tick"); }
      };
      const step = () => {
        if (!btn.isConnected) { timer = null; return; } // left the page
        if (k) land(k - 1); // in case the timer to land it was skipped
        if (k >= pts.length) { now.textContent = `${pts.length} ${M.noun}`; return stop(true); }
        const x = pts[k], i = k, to = pos[k], peak = rush ? 0 : 2.2 + Math.max(0, x.air) * 0.16;
        const air = (u) => { const f = QB.f + (to.f - QB.f) * u, v = QB.v + (to.v - QB.v) * u, [px, py] = P(f, v); return [px, py - 4 * peak * u * (1 - u) * 7 * S(v)]; };
        const dur = rush ? 560 : 650; // how long the line takes to draw in
        // one smooth curve (a throw: through the top of its arc), drawn in frame by frame with an ease-out, then faded
        const [sx, sy] = air(0), [mx, my] = air(0.5), [ex, ey] = air(1), cx = 2 * mx - (sx + ex) / 2, cy = 2 * my - (sy + ey) / 2;
        arc.setAttribute("d", rush ? runD(i) : `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
        const L = arc.getTotalLength() || 1, t0 = performance.now(), fade = 500, run = String(i);
        arc.dataset.i = run; arc.style.strokeDasharray = `${L} ${L}`; arc.style.strokeDashoffset = L; arc.style.opacity = 0.75;
        const tick = (t) => {
          if (arc.dataset.i !== run) return; // a newer play took over the line
          const e = t - t0, u = Math.min(1, e / dur);
          arc.style.strokeDashoffset = (L * (1 - u) ** 3).toFixed(1);
          if (e > dur) arc.style.opacity = Math.max(0, 0.75 * (1 - (e - dur) / fade)).toFixed(2);
          if (e < dur + fade) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        landT = setTimeout(() => {
          land(i);
          if (x.inc) return;
          const [fx, fy] = P(to.f, to.v);
          flash.setAttribute("cx", fx.toFixed(1)); flash.setAttribute("cy", fy.toFixed(1));
          flash.classList.toggle("td", !!x.td);
          flash.classList.remove("go"); void flash.getBBox(); flash.classList.add("go");
        }, dur);
        const yacTxt = mode === "target" && !x.inc && x.yac ? ` + ${x.yac} after the catch` : "";
        now.textContent = `${k + 1}/${pts.length} · Q${x.p.period?.number || ""} ${x.p.clock?.displayValue || ""} · ${x.air} yds${yacTxt}${what(x) ? " · " + what(x) : ""}`;
        k++;
        timer = setTimeout(step, 1300); // one play every 1.3 s
      };
      halt = () => { if (timer) stop(false); };
      if (btn) btn.onclick = () => {
        if (timer) return stop(false);
        if (k === 0 || k >= pts.length) { k = 0; landed = 0; tally(0); els.forEach((_, i) => show(i, false)); }
        btn.textContent = "❚❚ Pause"; timer = setTimeout(step, 50);
      };
    };
    shell();
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
    if (params.get("show") === "injuries") return injuries(params);
    if (params.get("show") === "visualize") return Viz.render(params); // viz.js
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
  const stSubStats = (on) => ""; // Leaders, Visualize, Injuries... are pills in the group bar (app.js GROUPS)
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

  // ---------------------------------------------------------------- Injuries (a sub-view of Stats, NFL)
  // Every team's injury load as "% healthy": ESPN's league injury report, weighted by who the player is.
  // Key player = at each depth-chart spot, everyone down to the first healthy player (the starter, plus the next man up
  // when the starter is out). Position weights: a QB counts
  // far more than a punter. Status: Out / IR / suspended = all of it, Doubtful 3/4, Questionable 1/4.
  // Backups count a little; a player not on the depth chart (often a starter already moved to IR) counts 30%.
  const INJ_W = { qb: 10, lt: 3, rt: 3, lg: 2, c: 2, rg: 2, wr: 3, te: 2, rb: 2, fb: 0.5, lde: 3, rde: 3, de: 3, ldt: 2.5, rdt: 2.5, nt: 2.5, dt: 2.5,
    wlb: 2, slb: 2, olb: 2.5, lilb: 2, rilb: 2, mlb: 2, lb: 2, lcb: 3, rcb: 3, cb: 3, nb: 1.5, ss: 2, fs: 2, s: 2, pk: 1, p: 0.5 };
  const INJ_POS_W = { QB: 10, OT: 3, T: 3, G: 2, OG: 2, C: 2, WR: 3, TE: 2, RB: 2, FB: 0.5, DE: 3, EDGE: 3, DT: 2.5, NT: 2.5, LB: 2, OLB: 2.5, ILB: 2,
    MLB: 2, CB: 3, S: 2, SS: 2, FS: 2, DB: 2, PK: 1, K: 1, P: 0.5 };
  const INJ_STARTS = 5; // starts (last season + this one) that make an injured player a key player
  const INJ_HIT = (st) => (/out|injured reserve|suspen|physically unable|non-football/i.test(st) ? 1 : /doubtful/i.test(st) ? 0.75 : /questionable|day-to-day/i.test(st) ? 0.25 : 0);
  // ESPN's injury report isn't touched during games, so today's games' play-by-play is read too:
  // "WAS-M.Mariota was injured during the play." / "Injury Update: ... his return is Doubtful." / "... has returned to the game."
  // -> { live: any game on now, byTeam: team id -> Map(athlete id -> { status, hit, note, pl }) }
  const IG_HIT = { Questionable: 0.4, Doubtful: 0.75, Out: 1, Hurt: 0.5 };
  async function inGameInjuries() {
    const sb = await api(`${SITE("nfl")}/scoreboard`, 30000).catch(() => null);
    const today = new Date().toDateString(), byTeam = new Map();
    const games = (sb?.events || []).filter((e) => e.status?.type?.state === "in" || (e.status?.type?.state === "post" && new Date(e.date).toDateString() === today));
    const yr = sb?.season?.year || new Date().getFullYear();
    const NMX = "(?:[A-Z]{2,4}-)?([A-Z][A-Za-z'-]*\\.[A-Z][A-Za-z'-]+(?: (?:Jr|Sr|II|III)\\.?)?)";
    await Promise.all(games.map(async (e) => {
      const s = await api(`${SITE("nfl")}/summary?event=${e.id}`, e.status.type.state === "in" ? 30000 : 600000).catch(() => null);
      const comps = e.competitions?.[0]?.competitors || [];
      const ppl = await Promise.all(comps.map((c) => teamPeople("nfl", c.team.id, yr).then((p) => [String(c.team.id), p]).catch(() => null)));
      const find = (nm) => {
        const key = nm.replace(/\s+(jr|sr|ii|iii)\.?$/i, "").toLowerCase(); // roster names are keyed without the suffix
        for (const x of ppl) { const pl = x && x[1].byName.get(key); if (pl) return [x[0], pl]; }
        return null;
      };
      const plays = [...(s?.drives?.previous || []), ...(s?.drives?.current ? [s.drives.current] : [])].flatMap((d) => d.plays || []);
      for (const play of plays) {
        const t = play.text || "", q = play.period?.number ? ` (Q${play.period.number})` : "";
        const set = (nm, status, note) => {
          const hit = find(nm);
          if (!hit) return;
          const m = byTeam.get(hit[0]) || new Map();
          byTeam.set(hit[0], m);
          if (status) m.set(hit[1].id, { status, hit: IG_HIT[status], note: note + q, pl: hit[1] }); else m.delete(hit[1].id);
        };
        for (const m of t.matchAll(new RegExp(`${NMX} was injured during the play`, "g"))) set(m[1], "Hurt", "Hurt during today's game");
        for (const m of t.matchAll(new RegExp(`Injury Update: ${NMX}[^.]*?(?:return is|is) (Questionable|Doubtful|Out)`, "gi")))
          set(m[1], m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(), `In-game update: ${m[2].toLowerCase()} to return`);
        for (const m of t.matchAll(new RegExp(`${NMX} (?:has )?returned to the game`, "g"))) set(m[1], null);
      }
    }));
    return { live: games.some((e) => e.status.type.state === "in"), byTeam };
  }
  // The NFL's official report (nfl.com, the same one each team's site shows; src/nfl_injuries.py, every 10 minutes): its game
  // status wins over ESPN's until the team's game ends, since ESPN lags (Trey Amos stayed IR on ESPN when Washington
  // listed him Questionable). Game statuses come with the final report (usually Friday); before a team posts them, its report
  // only has practice notes, so ESPN's status stands (Wednesday: Deebo Samuel "did not participate" isn't "expected to play").
  // Once a team's report has game statuses, being on it with no status = expected to play.
  const injNorm = (n) => (n || "").toLowerCase().replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/, "").replace(/[^a-z ]/g, "");
  const officialFor = (off, team) => {
    const nm = (team.displayName || team.name || "").toLowerCase();
    const k = Object.keys(off?.teams || {}).find((x) => nm.endsWith(x.toLowerCase()));
    const r = k && off.teams[k];
    if (!r || Date.now() > Date.parse(r.kickoff) + 4 * 3600000) return null;
    const m = new Map(r.players.map((p) => [injNorm(p[0]), { status: p[4], note: [p[2], p[3]].filter(Boolean).join(" · ") }]));
    m.final = r.players.some((p) => p[4]); // game statuses are out
    return m;
  };
  let injP = null, injAt = 0;
  const injData = () => {
    if (Date.now() - injAt > 55000) { injP = null; injAt = Date.now(); } // refreshed about once a minute
    return (injP ||= (async () => {
    const [rep, stand, ig, starts] = await Promise.all([api(`${SITE("nfl")}/injuries`, 120000),
      api(`${STAND("nfl")}/standings?level=3`, 86400000).catch(() => null), inGameInjuries().catch(() => ({ live: false, byTeam: new Map() })),
      getJSON("data/nfl_starts.json").catch(() => null)]);
    const offRep = await getJSON("data/nfl_injuries.json").catch(() => null);
    const tm = new Map(stand ? groupsOf(stand).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]) : []);
    const yr = rep.season?.year || new Date().getFullYear();
    const teams = await Promise.all((rep.injuries || []).map(async (t) => {
      const dc = await api(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${yr}/teams/${t.id}/depthcharts`, 3600000).catch(() => null);
      // who's missing (Out / IR / Doubtful, or hurt in today's game and not back): decides who the next man up is
      const idOf = (i) => (/\/id\/(\d+)/.exec((i.athlete?.links || []).map((l) => l.href).join(" ")) || [])[1] || "";
      const off = officialFor(offRep, t);
      const stOf = (name, s) => { const o = off?.get(injNorm(name)); return o && (o.status || off.final) ? o.status : s; }; // official game status, else ESPN's
      const missing = new Set((t.injuries || []).filter((i) => INJ_HIT(stOf(i.athlete?.displayName, i.status)) >= 0.75).map(idOf).filter(Boolean));
      // the league report leaves out long-term injured reserve (Trey Amos, Laremy Tunsil...): the team roster has them
      const reported = new Set((t.injuries || []).map(idOf));
      const roster = await teamPeople("nfl", t.id, yr).catch(() => null);
      const extra = roster ? [...roster.byId.values()].filter((p) => !reported.has(p.id))
        .map((p) => ({ ...p, inj: stOf(p.name, p.inj), offNote: off?.get(injNorm(p.name))?.note })).filter((p) => INJ_HIT(p.inj) > 0) : [];
      extra.forEach((p) => { if (INJ_HIT(p.inj) >= 0.75) missing.add(p.id); });
      for (const [id, g] of ig.byTeam.get(String(t.id)) || []) if (g.hit >= 0.5) missing.add(id);
      // each depth-chart spot (QB, LT, the three WR spots...) in order: KEY players are everyone down to the first
      // healthy one, so with the QB1 out, QB2 is the starter now and counts fully too
      const slot = new Map(), spotsSeen = new Set(); // athlete id -> { key, depth, isKey }
      let total = 0;
      (dc?.items || []).forEach((it) => Object.entries(it.positions || {}).forEach(([k, v]) => {
        if (!(k in INJ_W)) return;
        const spots = new Map();
        (v.athletes || []).forEach((a) => {
          const id = (/athletes\/(\d+)/.exec(a.athlete?.$ref || "") || [])[1];
          if (id) { const sl = a.slot || 1; if (!spots.has(sl)) spots.set(sl, []); spots.get(sl).push({ id, r: a.rank || 99 }); }
        });
        for (const [sl, list] of spots) {
          if (spotsSeen.has(`${k}:${sl}`)) continue; // the same spot in another formation
          spotsSeen.add(`${k}:${sl}`);
          total += INJ_W[k];
          list.sort((a, b) => a.r - b.r);
          let filled = false;
          list.forEach((x, i) => {
            const isKey = !filled, old = slot.get(x.id);
            if (!missing.has(x.id)) filled = true;
            if (!old || (isKey && !old.isKey) || (!old.isKey && i + 1 < old.depth)) slot.set(x.id, { key: k, depth: i + 1, isKey });
          });
        }
      }));
      // [weight, depth-chart spot, key?]. A regular starter (INJ_STARTS+ starts last season + this one, data/nfl_starts.json)
      // is key even when ESPN has dropped him from the depth chart or buried him at the bottom (IR: Trey Amos, Sam Cosmi)
      const weight = (id, pos) => {
        const s = slot.get(id), regular = (starts?.players?.[id] || 0) >= INJ_STARTS;
        if (s && (s.isKey || regular)) return [INJ_W[s.key], s, true];
        if (regular) return [INJ_POS_W[pos] || 2, s, true];
        return [s ? INJ_W[s.key] * (s.depth === 2 ? 0.15 : 0.05) : (INJ_POS_W[pos] || 1) * 0.3, s, false];
      };
      const hurt = (t.injuries || []).map((i) => ({ i, st: stOf(i.athlete?.displayName, i.status) })).filter((x) => INJ_HIT(x.st) > 0).map(({ i, st }) => {
        const a = i.athlete || {}, id = idOf(i), o = off?.get(injNorm(a.displayName));
        const pos = a.position?.abbreviation || "", [w, s, key] = weight(id, pos);
        return { id, name: a.displayName || "", pos, status: st, key, onChart: !!s, w, lost: w * INJ_HIT(st),
          note: o ? `NFL report: ${o.note}` : i.shortComment || "", pic: a.headshot?.href || "" };
      });
      for (const p of extra) {
        const [w, s, key] = weight(p.id, p.pos);
        hurt.push({ id: p.id, name: p.name, pos: p.pos, status: p.inj, key, onChart: !!s, w, lost: w * INJ_HIT(p.inj),
          note: p.offNote ? `NFL report: ${p.offNote}` : /injured reserve/i.test(p.inj) ? "On injured reserve" : "", pic: p.pic });
      }
      // today's games: hurt in the game counts right away (or counts more, if the report had him lower)
      for (const [id, g] of ig.byTeam.get(String(t.id)) || []) {
        const st = g.status === "Hurt" ? "Hurt in game" : g.status, have = hurt.find((h) => h.id === id);
        if (have) {
          if (g.hit * have.w > have.lost) Object.assign(have, { status: st, lost: g.hit * have.w, note: g.note, ingame: true });
          continue;
        }
        const [w, s, key] = weight(id, g.pl.pos);
        hurt.push({ id, name: g.pl.name, pos: g.pl.pos, status: st, key, onChart: !!s, w, lost: w * g.hit, note: g.note, pic: g.pl.pic, ingame: true });
      }
      hurt.sort((a, b) => b.lost - a.lost);
      const lost = hurt.reduce((s, h) => s + h.lost, 0);
      const info = tm.get(String(t.id)) || { id: t.id, displayName: t.displayName, abbreviation: t.displayName };
      return { id: String(t.id), team: info, hurt, health: total ? Math.max(0, Math.min(100, 100 * (1 - lost / total))) : 100,
        keyOut: hurt.filter((h) => h.key && h.lost >= 0.75 * h.w).length };
    }));
    teams.sort((a, b) => a.health - b.health);
    teams.live = ig.live;
    return teams;
  })().catch((e) => { injP = null; throw e; }));
  };

  const injChip = (h) => { const f = h.w ? h.lost / h.w : INJ_HIT(h.status);
    return `<span class="inj-st ${f >= 1 ? "out" : f >= 0.75 ? "dbt" : "q"}">${esc(/injured reserve/i.test(h.status) ? "IR" : h.status)}</span>`; };
  const injList = (t) => `<ul class="inj-list">${t.hurt.map((h) => `<li>${face(h.pic, h.name, "hs")}<div><a href="${link("player", h.id)}"><b>${esc(h.name)}</b></a>
      <small class="muted">${esc(h.pos)}</small> ${injChip(h)}${h.key ? ` <span class="inj-starter" title="A starter, the next man up because the starter is out, or a regular starter (5+ starts since last season)">KEY</span>` : ""}${h.ingame ? ` <span class="inj-live">IN-GAME</span>` : ""}
      ${h.note ? `<small class="inj-note">${esc(h.note)}</small>` : ""}</div></li>`).join("") || `<li class="muted">Nobody on the report.</li>`}</ul>`;

  async function injuries(params, refresh = false) {
    const my = token;
    if (league !== "nfl") { // college: the conference availability reports, most banged-up first
      if (!refresh) view("stats").innerHTML = stSubStats("injuries") + `<div class="card muted">Loading the availability reports…</div>`;
      const d = await cfbInj();
      if (my !== token) return;
      const weeks = Object.keys(d?.weeks || {}).map(Number).sort((a, b) => b - a);
      // early in the week only a few teams have reported, and the first reports can list nobody yet: show the newest week
      // with 10+ teams that actually lists players, and say so when a newer week was skipped
      const listed = (w) => Object.values(d.weeks[w]).some((r) => r.players.length);
      const wk = weeks.find((w) => Object.keys(d.weeks[w]).length >= 10 && listed(w)) ?? weeks.find(listed) ?? weeks[0];
      const skipped = weeks.length && wk != null && weeks[0] > wk ? weeks[0] : null;
      const wt = (st) => (st.startsWith("Out") ? 1 : st === "Doubtful" ? 0.75 : 0.3);
      const rows = wk == null ? [] : Object.entries(d.weeks[wk]).map(([t, r]) => ({ t, ...r, load: r.players.reduce((a, p) => a + wt(p[3]), 0) })).sort((a, b) => b.load - a.load);
      view("stats").innerHTML = stSubStats("injuries") + `<div class="card"><h2>College availability reports${wk != null ? ` <span class="muted">Week ${wk}</span>` : ""}</h2>
        ${rows.length ? rows.map((r) => `<details class="cfb-inj"><summary><b>${esc(r.t)}</b> <span class="muted">vs ${esc(r.opp)}</span>
          <span class="cfb-cnt">${r.players.filter((p) => p[3].startsWith("Out")).length} out · ${r.players.filter((p) => !p[3].startsWith("Out")).length} other</span></summary>${cfbInjList(r)}</details>`).join("")
          : `<p class="muted">No reports yet.</p>`}
        ${skipped ? `<p class="note">Week ${skipped} reports so far don't list anyone, so this is week ${wk}. They fill in two or three days before the games.</p>` : ""}
        <p class="note">${CFB_INJ_NOTE} Each week's reports start two or three days before the game. Tap a team to see its list. <a href="${link("stats", null, { show: "injuries", league: "nfl" })}">NFL injuries →</a></p></div>`;
      return;
    }
    if (!refresh) view("stats").innerHTML = stSubStats("injuries") + `<div class="card muted">Loading every team's injury report and depth chart…</div>`;
    let teams;
    try { teams = await injData(); } catch (e) { return fail("stats", e); }
    if (my !== token) return;
    const pick = (params.get("team") || "").toUpperCase();
    const avg = teams.reduce((s, t) => s + t.health, 0) / teams.length;
    const col = (h) => (h >= 92 ? "var(--inj-good)" : h >= 82 ? "var(--inj-mid)" : "var(--inj-bad)");
    const ord = (n) => n + ([11, 12, 13].includes(n % 100) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
    const focus = teams.find((t) => t.team.abbreviation === pick) || teams[0];
    const rank = teams.indexOf(focus) + 1;
    const list = injList;
    view("stats").innerHTML = stSubStats("injuries") + `<div class="card">
      <div class="sc-bar"><h2>Injuries <small class="muted">NFL · how healthy is each team?</small></h2><span class="muted">${liveBadge(teams.live)}</span></div>
      <div class="inj-head">${img(teamLogo(focus.team), "lg")}<div><b>${esc(focus.team.displayName || "")}</b>
        <span class="inj-big" style="color:${col(focus.health)}">${Math.round(focus.health)}% healthy</span>
        <small class="muted">${rank === 1 ? "The most banged-up team in the NFL" : `${ord(rank)} most banged-up of ${teams.length}`} · ${focus.keyOut} key player${focus.keyOut === 1 ? "" : "s"}, ${focus.hurt.length} total on the report · league average ${Math.round(avg)}%</small></div></div>
      <div class="inj-chart" id="inj-chart" role="list">${teams.map((t, i) => `<button class="inj-row${t === focus ? " on" : ""}" data-t="${esc(t.team.abbreviation)}" role="listitem"
          title="${esc(t.team.displayName || "")}: ${Math.round(t.health)}% healthy, ${t.keyOut} key players, ${t.hurt.length} total on the report">
          <span class="inj-rk">${i + 1}</span><span class="tm">${img(teamLogo(t.team), "xs")} ${esc(t.team.abbreviation)}</span>
          <span class="inj-bar"><i style="width:${t.health.toFixed(1)}%;background:${col(t.health)}"></i><em style="left:${avg.toFixed(1)}%" title="League average"></em></span>
          <span class="inj-pct">${Math.round(t.health)}%</span><span class="inj-so">${t.keyOut} key, ${t.hurt.length} total</span></button>`).join("")}</div>
      <p class="fr-how">Tap a team for its report. <b>% healthy</b> weighs who's hurt: a starting QB counts about 10x a punter. <b>Key players</b> count fully: the starters, the next man up when a starter is out (with QB1 out, QB2 is the starter, so losing him hurts just as much), and anyone hurt who has started 5+ games since last season (even if ESPN has dropped him from the depth chart, like most players on IR). Other backups count a little. Out or IR counts fully, Doubtful 3/4, Questionable 1/4. Statuses come from the NFL's official report once a team posts game statuses (usually Friday); before that, from ESPN, since midweek reports only list who practiced. The dashed line is the league average.</p>
      <div id="inj-detail"><h3>${esc(focus.team.displayName || "")} injury report</h3>${list(focus)}</div>
      <p class="note">The NFL's official injury report (the game statuses each team's site shows) until a team's game is played, otherwise ESPN's, with ESPN's depth charts, plus today's games: anyone hurt during a game counts right away (from the play-by-play, marked IN-GAME) and drops off if he returns. During games this page refreshes every minute. Players already moved off the depth chart (often to IR) count at 30%.</p></div>`;
    $("#inj-chart").onclick = (e) => {
      const b = e.target.closest("[data-t]");
      if (!b) return;
      const p = new URLSearchParams(params); p.set("team", b.dataset.t); p.set("show", "injuries");
      location.hash = `#/stats?${p}`;
    };
    poll((r) => injuries(params, r), teams.live ? 60000 : 600000); // every minute while games are on
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
    // this week's opponent for each team: [opponent id, home?], and how many games each team has played (for season pace)
    const opp = new Map(), played = new Map(), done = Date.now() - 4 * 3600000;
    for (const t of sched?.settings?.proTeams || []) {
      const g = t.proGamesByScoringPeriod?.[wk]?.[0];
      if (g) opp.set(t.id, g.homeProTeamId === t.id ? [g.awayProTeamId, true] : [g.homeProTeamId, false]);
      played.set(t.id, Object.values(t.proGamesByScoringPeriod || {}).flat().filter((x) => x?.date && x.date < done).length);
    }
    const list = [];
    for (const { player: p } of (await r.json()).players || []) {
      const pos = PJ_POS[p?.defaultPositionId];
      if (!pos || !p.proTeamId) continue; // rostered on an NFL team
      const st = (p.stats || []).filter((s) => s.seasonId === y), pj = st.filter((s) => s.statSourceId === 1), real = st.filter((s) => s.statSourceId === 0);
      const week = pj.find((s) => s.statSplitTypeId === 1 && s.scoringPeriodId === wk), ros = pj.find((s) => s.statSplitTypeId === 0);
      const so = real.find((s) => s.statSplitTypeId === 0);
      const line = (s) => ({ ...(s?.stats || {}), pts: s?.appliedTotal || 0 });
      const W = line(week), R = line(ros), S = line(so);
      // Season pace, the usual "on pace" (same as our X pace posts): total so far / team games played x 17.
      // (It used to be ESPN's rest-of-season projection added on, which is cautious and showed far less than the X posts.)
      const tgp = played.get(p.proTeamId) || 0;
      const pace = Object.fromEntries(PJ_PACE_KEYS.map((k) => [k, tgp ? ((S[k] || 0) / tgp) * 17 : 0]));
      list.push({ id: p.id, name: p.fullName, pos, team: p.proTeamId, opp: opp.get(p.proTeamId), week: W, ros: R, so: S, pace });
    }
    const data = { y, wk, list };
    cache.set(url, { t: Date.now(), data });
    return data;
  }

  // ---------------------------------------------------------------- NFL defensive season pace
  // ESPN's fantasy projections skip defenders, so this is ours: his per-game average so far x (his games + his team's
  // games left of 17). From the Visualize data (docs/data/viz/nfl_<season>.json, nflverse, Sunday and Tuesday mornings).
  const DP_POS = { LB: "Linebackers", EDGE: "Edge", IDL: "D-line", CB: "Corners", S: "Safeties" }; // roles from src/deep_stats.py
  const DP_COLS = [["Tackles", "tackles"], ["Sacks", "def_sacks"], ["TFL", "tfl"], ["QB hits", "qb_hits"], ["PBU", "pd"], ["INT", "def_int"], ["FF", "ff"]];
  const DP_KEY = { LB: "tackles", EDGE: "def_sacks", IDL: "def_sacks", CB: "pd", S: "tackles" };
  let defPaceP = null;
  const defPace = () => (defPaceP ||= (async () => {
    const idx = await getJSON("data/viz/index.json"), season = (idx.nfl || []).at(-1);
    const D = await getJSON(`data/viz/nfl_${season}.json`);
    const ci = Object.fromEntries(D.pcols.map((c, i) => [c, i + 3])), ff = (D.xcols || []).indexOf("ff");
    const tg = {}, out = new Map();
    for (const r of D.trows) tg[r[0]] = (tg[r[0]] || 0) + 1;
    const through = Math.max(0, ...D.trows.map((r) => r[1]));
    for (const r of D.prows) {
      const m = D.pmeta[r[0]];
      if (!m || !DP_POS[m[3]]) continue;
      const o = out.get(r[0]) || { id: r[0], name: m[0], pos: m[3], yr: m[4], team: r[2], g: 0, so: Object.fromEntries(DP_COLS.map(([, k]) => [k, 0])) };
      o.g++; o.team = r[2];
      for (const [, k] of DP_COLS) o.so[k] += k === "ff" ? (() => { const x = r.at(-1); if (!Array.isArray(x)) return 0; for (let i = 0; i < x.length; i += 2) if (x[i] === ff) return x[i + 1]; return 0; })() : r[ci[k]] || 0;
      out.set(r[0], o);
    }
    for (const o of out.values()) {
      o.left = Math.max(0, 17 - (tg[o.team] || 0));
      const tgp = tg[o.team] || o.g; // the usual "on pace" (same as our X pace posts): total / team games played x 17
      o.pace = Object.fromEntries(DP_COLS.map(([, k]) => [k, tgp ? (o.so[k] / tgp) * 17 : 0]));
    }
    return { season, through, list: [...out.values()] };
  })().catch(() => { defPaceP = null; return null; }));

  async function defProjected(params, pos) {
    const my = token;
    view("stats").innerHTML = stSubStats("projected") + `<div class="card muted">Loading…</div>`;
    const [data, teams] = await Promise.all([defPace(), api(`${STAND("nfl")}/standings?level=3`, 86400000).then((d) => new Map(groupsOf(d).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]))).catch(() => new Map())]);
    if (my !== token) return;
    if (!data) { view("stats").innerHTML = stSubStats("projected") + `<div class="card">Couldn't load the defensive stats. Try again in a minute.</div>`; return; }
    const sort = DP_COLS.some(([, k]) => k === params.get("sort")) ? params.get("sort") : DP_KEY[pos], dir = params.get("dir") === "asc" ? -1 : 1;
    const go = (changes) => {
      const p = new URLSearchParams(params);
      Object.entries(changes).forEach(([k, v]) => (v == null || v === "" ? p.delete(k) : p.set(k, v)));
      p.set("league", "nfl"); p.set("show", "projected"); p.set("when", "pace");
      location.hash = `#/stats?${p}`;
    };
    const all = data.list.filter((r) => r.pos === pos && r.g >= 1).sort((a, b) => dir * (b.pace[sort] - a.pace[sort]) || b.pace.tackles - a.pace.tackles).slice(0, 100);
    const th = (k, l) => `<th class="num sortable${k === sort ? " on" : ""}" data-sort="${k}">${esc(l)}${k === sort ? (dir > 0 ? " ▼" : " ▲") : ""}</th>`;
    const abbr = (key) => teams.get(String(key).split(":")[1])?.abbreviation || "";
    const tm = (key) => { const t = teams.get(String(key).split(":")[1]); return t ? `<a href="${link("team", t.id)}"><span class="tm">${img(teamLogo(t), "xs")} ${esc(t.abbreviation)}</span></a>` : ""; };
    view("stats").innerHTML = stSubStats("projected") + `
      <div class="sc-bar">
        <div class="presets" id="pj-when"><button data-when="" >This week</button><button data-when="pace" class="on">Season pace</button></div>
        <div class="presets" id="pj-pos">${[["", "All"], ...Object.values(PJ_POS).map((p) => [p, p]), ...Object.entries(DP_POS)].map(([v, l]) => `<button data-pos="${v}" class="${v === pos ? "on" : ""}">${l}</button>`).join("")}</div>
        <input id="pj-search" type="search" placeholder="Filter player or team…">
      </div>
      <p class="fr-how"><b>Season pace</b>: where each defender's ${esc(data.season)} totals are headed at this rate, the usual "on pace": his total so far divided by his team's games played, times 17. Same math as our X posts. Hover a number to see his total so far.</p>
      <div class="table-wrap"><table id="pj-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th class="num" title="Games played + team games left">G</th>${DP_COLS.map(([l, k]) => th(k, l)).join("")}</tr></thead>
        <tbody>${all.map((r, i) => `<tr data-name="${esc(r.name.toLowerCase())} ${esc(abbr(r.team).toLowerCase())}"><td class="num muted">${i + 1}</td>
          <td><div class="team">${face(`https://a.espncdn.com/i/headshots/nfl/players/full/${r.id}.png`, r.name, "hs")}<div><a href="${link("player", r.id)}"><b>${esc(r.name)}</b></a><small class="muted">${esc(DP_POS[r.pos])}${r.yr === 1 ? " · rookie" : ""}</small></div></div></td>
          <td>${tm(r.team)}</td><td class="num">${r.g}<small class="muted"> +${r.left}</small></td>
          ${DP_COLS.map(([, k]) => `<td class="num${k === sort ? " on" : ""}" title="${Math.round(r.so[k] * 10) / 10} so far">${paceFmt(r.pace[k])}</td>`).join("")}</tr>`).join("")
          || `<tr><td colspan="11" class="muted">No defensive stats yet.</td></tr>`}</tbody></table></div>
      <p class="note">Click a column to sort by it. Top 100 at the position. Stats through week ${esc(data.through)} (nflverse, the NFL's official play-by-play; updated Sunday and Tuesday mornings). ESPN doesn't project defenders, so this is a straight-line pace: no adjustment for opponents or injuries.</p>`;
    $("#pj-when").onclick = (e) => { const b = e.target.closest("[data-when]"); if (b && !b.dataset.when) go({ when: null, pos: null, sort: null, dir: null }); };
    $("#pj-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (b) go({ pos: b.dataset.pos || "all", sort: null, dir: null, pages: null, when: DP_POS[b.dataset.pos] ? "pace" : null }); };
    view("stats").querySelector("#pj-table thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.sort;
      if (k) go({ sort: k === DP_KEY[pos] ? null : k, dir: k === sort && dir > 0 ? "asc" : null });
    };
    $("#pj-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      view("stats").querySelectorAll("#pj-table tbody tr").forEach((tr) => tr.classList.toggle("hidden", !!q && !(tr.dataset.name || "").includes(q)));
    };
  }

  async function projected(params) {
    const my = token;
    if (league !== "nfl") return cfbProjected(params);
    if (DP_POS[params.get("pos")]) return defProjected(params, params.get("pos"));
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
        <div class="presets" id="pj-pos">${[["", "All"], ...Object.values(PJ_POS).map((p) => [p, p]), ...Object.entries(DP_POS)].map(([v, l]) => `<button data-pos="${v}" class="${v === pos ? "on" : ""}" ${DP_POS[v] ? 'title="Defense: season pace"' : ""}>${l}</button>`).join("")}</div>
        <input id="pj-search" type="search" placeholder="Filter player or team…">
      </div>
      <p class="fr-how">${pace ? `<b>Season pace</b>: where each player's ${esc(data.y)} totals are headed. The usual "on pace": his total so far divided by his team's games played, times 17 (same math as our X posts). Hover a number to see his total so far.`
        : `ESPN's projections for <b>${esc(whenTxt)}</b>.`} These are ESPN's fantasy football forecasts, not betting lines.</p>
      <div class="table-wrap"><table id="pj-table"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th>${wk1 ? "<th>Opp</th>" : ""}
        ${cols.map(([l, k, t]) => th(k, l, t)).join("")}${th("pts", "PPR pts", "Projected fantasy points, PPR scoring (1 per catch)")}</tr></thead>
        <tbody>${rows || `<tr><td colspan="13" class="muted">No projections yet. <a href="${link("stats")}">See this season's leaders →</a></td></tr>`}</tbody></table></div>
      ${all.length > shown ? `<p><button id="pj-more" class="btn">Show 100 more</button></p>` : ""}
      <p class="note">Click a column to sort by it. Players on bye or projected for nothing (out) aren't listed${ros ? "; rest-of-season totals skip byes and games ESPN expects them to miss" : ""}. Projections: ESPN fantasy, updated through the week.</p>`;
    $("#pj-when").onclick = (e) => { const b = e.target.closest("[data-when]"); if (b) go({ when: b.dataset.when, sort: null, dir: null, pages: null }); };
    $("#pj-pos").onclick = (e) => { const b = e.target.closest("[data-pos]"); if (b) go({ pos: b.dataset.pos || "all", sort: null, dir: null, pages: null, ...(DP_POS[b.dataset.pos] ? { when: "pace" } : {}) }); };
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
  const PACE_HOW = `Season pace = his per-game average so far times his team's regular-season games: where he ends up if he keeps doing exactly what he's doing. Hover a number for our projection too: what he has done so far plus our model for every game left, using each opponent's defense, home or away, and expected game flow (big favorites run more and rest starters late). It assumes he stays healthy and keeps his role.`;
  // straight-line pace (per game so far x total games); our model's projected finish is kept as r.model
  const PACE_KEYS = ["py", "ptd", "int", "ry", "rtd", "rec", "recy", "rectd"];
  const straightPace = (r) => {
    const n = r.g + r.gl, f = r.g ? n / r.g : 0, out = { ...r, model: r };
    PACE_KEYS.forEach((k) => { out[k] = (r.so[k] || 0) * f; });
    out.pts = (r.spts || 0) * f;
    return out;
  };
  const cfbTm = (id, ab) => `<a href="${link("team", id)}"><span class="tm">${img(`https://a.espncdn.com/i/teamlogos/ncaa/500/${encodeURIComponent(id)}.png`, "xs")} ${esc(ab)}</span></a>`;
  const pjFmt = (v, label) => (!v || v < 0.05 ? `<span class="muted">–</span>` : /yds/.test(label) ? Math.round(v).toLocaleString() : v.toFixed(1));

  async function cfbProjected(params) {
    const my = token;
    view("stats").innerHTML = stSubStats("projected") + `<div class="card muted">Loading…</div>`;
    const pace = params.get("when") === "pace";
    let data = await (pace ? cfbPace() : cfbProj());
    if (my !== token) return;
    if (pace && data?.players) data = { ...data, players: data.players.map(straightPace) };
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
    const soFar = (r, k) => (pace ? ` title="${esc(`${Math.round(r.so[CFB_PJ[k]] || 0).toLocaleString()} so far · our projection ${Math.round(r.model[CFB_PJ[k]] || 0).toLocaleString()}`)}"` : "");
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
      <p class="fr-how">${pace ? `<b>Season pace</b>: each player's per-game average so far over his team's full ${esc(data.season)} regular season. Hover a number to see his total so far and our model's projected finish.`
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
  // On game day ESPN's season summary (and our weekly pace/projection files) can be a game behind its game log,
  // which updates as soon as a game ends. So season totals get added up from the log when it has more games.
  const RATE = /pct|per|long|qbr|rating|avg/i;
  function logSeason(gl) {
    const stp = (gl?.seasonTypes || []).find((s) => /regular/i.test(s.displayName || "")) || gl?.seasonTypes?.[0], names = gl?.names || [];
    if (!stp || !names.length) return null;
    const seen = new Set(), sum = {};
    for (const ev of (stp.categories || []).flatMap((c) => c.events || [])) {
      if (seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      names.forEach((n, i) => { const v = parseFloat(String(ev.stats?.[i] ?? "").replace(/,/g, "")); if (!RATE.test(n) && isFinite(v)) sum[n] = (sum[n] || 0) + v; });
    }
    return { n: seen.size, sum, weeks: [...seen].map((e) => +(gl.events?.[e]?.week || 0)) };
  }
  const PACE_NAME = { py: "passingYards", ptd: "passingTouchdowns", int: "interceptions", ry: "rushingYards", rtd: "rushingTouchdowns", rec: "receptions", recy: "receivingYards", rectd: "receivingTouchdowns" };
  const PPR_PTS = { py: 0.04, ptd: 4, int: -2, ry: 0.1, rtd: 6, rec: 1, recy: 0.1, rectd: 6 }; // same as src/cfb_projections.py
  const soLine = (v, d = 0) => `${(+v || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })} so far`;

  async function cfbProjPane(id, gl) {
    const d = await cfbProj(), r = d?.players?.find((p) => p.id === String(id));
    if (!r) return null;
    if (logSeason(gl)?.weeks.some((w) => w >= +d.week)) return null; // this week's game is already played: the projection is moot
    const keys = PJ_COLS.filter(([, k]) => (r[CFB_PJ[k]] || 0) >= 0.05 && !(k === "20" && r.pos !== "QB"));
    return { k: "week", tab: `Week ${esc(d.week)} ${r.h ? "vs" : "@"} ${esc(r.oa)}`,
      cells: [...keys.map(([l, k]) => [l, pjFmt(r[CFB_PJ[k]], l)]), ["PPR pts", r.pts.toFixed(1)]],
      note: `Our own estimate, for fun, not a betting line. <a href="${link("stats", null, { show: "projected", league: "cfb", pos: r.pos })}">How these work →</a>` };
  }
  async function cfbPacePane(id, gl) {
    let r = (await cfbPace())?.players?.find((p) => p.id === String(id));
    if (!r) return null;
    const L = logSeason(gl), extra = L ? L.n - r.g : 0;
    if (extra > 0 && r.gl >= extra) { // games played since the pace file was made: their real stats in, their projections out
      const keep = (r.gl - extra) / r.gl, so = {}, tot = {};
      for (const k of Object.keys(PACE_NAME)) { so[k] = L.sum[PACE_NAME[k]] ?? r.so[k] ?? 0; tot[k] = so[k] + Math.max(0, (r[k] || 0) - (r.so[k] || 0)) * keep; }
      const pts = (o) => Object.keys(PPR_PTS).reduce((s, k) => s + PPR_PTS[k] * (o[k] || 0), 0);
      r = { ...r, ...tot, so, g: L.n, gl: r.gl - extra, pts: pts(tot), spts: pts(so) };
    }
    const main = PACE_MAIN[r.pos] || [], sp = straightPace(r);
    const sub = (so, m, d = 0) => `${soLine(so, d)} · ours ${(+m || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })}`;
    return { k: "pace", tab: "Season pace",
      cells: [...PJ_COLS.filter(([, k]) => main.includes(k)).map(([l, k]) => [l, paceFmt(sp[CFB_PJ[k]]), sub(r.so[CFB_PJ[k]], Math.round(r[CFB_PJ[k]] || 0))]), ["PPR pts", sp.pts.toFixed(1), sub(r.spts, r.pts, 1)]],
      note: `${r.g + r.gl} games, ${r.gl} left. Big number: his per-game average so far over the full season. "Ours": what he's done plus our projection for each game left, adjusted for those defenses and expected blowouts. <a href="${link("stats", null, { show: "projected", league: "cfb", when: "pace", pos: r.pos })}">Full list →</a>` };
  }
  async function nflPanes(id) {
    const d = await pjPlayers().catch(() => null), r = d?.list?.find((p) => String(p.id) === String(id));
    if (!r) { // defenders: our straight-line pace
      const dp = (await defPace())?.list.find((p) => String(p.id) === String(id));
      if (!dp) return [];
      const main = { LB: ["tackles", "def_sacks", "tfl", "pd", "def_int"], EDGE: ["def_sacks", "qb_hits", "tfl", "tackles", "ff"], IDL: ["def_sacks", "qb_hits", "tfl", "tackles"],
        CB: ["def_int", "pd", "tackles", "ff"], S: ["tackles", "def_int", "pd", "tfl"] }[dp.pos];
      return [{ k: "pace", tab: "Season pace", cells: DP_COLS.filter(([, k]) => main.includes(k)).sort((a, b) => main.indexOf(a[1]) - main.indexOf(b[1])).map(([l, k]) => [l, paceFmt(dp.pace[k]) === `<span class="muted">–</span>` ? "0" : paceFmt(dp.pace[k]), soLine(dp.so[k])]),
        note: `His per-game average so far over ${dp.g + dp.left} games (${dp.left} left), if he keeps it up. <a href="${link("stats", null, { show: "projected", league: "nfl", when: "pace", pos: dp.pos })}">Full list →</a>` }];
    }
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
  async function outlookInto(lg, id, slot, gl) {
    const html = outlookCard(lg === "cfb" ? await Promise.all([cfbProjPane(id, gl), cfbPacePane(id, gl)]) : await nflPanes(id));
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
    kicking: "fieldGoalPct", punting: "puntYards", scoring: "totalPoints", returning: "kickReturnYards" };
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
    return { id, lg, name: bio.displayName, short: bio.shortName || bio.displayName, pos: fixPos(bio).position?.abbreviation, headshot: bio.headshot?.href,
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
    // his position's category, or else the one with the most seasons (ESPN lists Justin Tucker as a wide receiver: Kicking, not
    // his one trick-play pass)
    const most = catNames.slice().sort((a, b) => main.cats[b].rows.filter(lvlOk).length - main.cats[a].rows.filter(lvlOk).length || (a === "scoring") - (b === "scoring"))[0]; // Scoring always ties (every kicker scores): it loses ties
    const cat = catNames.includes(st.cat) ? st.cat : catNames.includes(PRIMARY(main.pos)) ? PRIMARY(main.pos) : most;
    const C = main.cats[cat];
    // only stats that have a number in the seasons shown (college and NFL feeds name some stats differently: a college
    // kicker's "FGM" has no NFL seasons, and the chart would be empty)
    const usable = C.names.filter((n) => C.rows.some((r) => lvlOk(r) && num(r.vals[n]) != null));
    const names = usable.length ? usable : C.names;
    const metric = names.includes(st.metric) ? st.metric : names.includes(KEY_METRIC[cat]) ? KEY_METRIC[cat] : names.find((n) => /yards/i.test(n)) || names[1] || names[0];
    return { catNames, cat, C, metric, names, align: st.align === "career" ? "career" : "season", lvl, lvlOk, hasBoth };
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
    const { catNames, cat, C, metric, names, align, lvl, lvlOk, hasBoth } = pk;
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
    const max = /pct/i.test(metric) ? 100 // percentages run 0-100
      : Math.max(1, ...series.flatMap((s) => s.rows.filter((r) => inView.has(r.x)).map((r) => r.v)), ...xs.map(benchAt).filter((v) => v != null));
    // line chart (SVG): one line per player, a dot on each season; the line breaks over seasons with no stats
    const W = 720, H = 250, padL = 46, padR = 14, top = 38, base = H - 22; // headroom over the tallest bar for its value tag
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
    // bar version (the kicking chart's look): rounded bars with a gradient in the player's color that grow up from the axis.
    // One player: wide bars on a faint track, a value tag on each (up to 14 seasons) and a dashed top-10 marker per season.
    // Comparing players: grouped, narrower bars.
    const one = series.length === 1, bnodes = [], bw = one ? Math.min(64, gw * 0.56) : Math.min(34, (gw - 10) / series.length);
    const tags = one && xs.length <= 8, small = one && !tags && gw >= 34; // many seasons: a small plain number over each bar instead of a tag
    const gdefs = `<defs>${series.map((sr, si) => `<linearGradient id="cc-g${si}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:color-mix(in srgb, ${sr.color} 78%, #fff)"/><stop offset="1" style="stop-color:color-mix(in srgb, ${sr.color} 70%, #000)"/></linearGradient>`).join("")}</defs>`;
    const tag = (cx, y, txt) => { const w = 14 + 7.4 * String(txt).length; return `<g class="ky-pill cc-tag"><rect x="${(cx - w / 2).toFixed(1)}" y="${(y - 27).toFixed(1)}" width="${w.toFixed(1)}" height="19" rx="9.5"/><text x="${cx.toFixed(1)}" y="${(y - 13.5).toFixed(1)}">${esc(txt)}</text></g>`; };
    const bars = gdefs + xs.map((x, gi) => series.map((sr, si) => {
      const r = sr.rows.find((q) => q.x === x);
      if (!r) return "";
      const bx = padL + gi * gw + (gw - bw * series.length) / 2 + si * bw, by = py(r.v), w = bw - 2, cx = bx + w / 2, b = one ? benchAt(x) : null;
      bnodes.push({ x: cx, y: by, x0: bx, x1: bx + w, si, label: align === "career" ? `Career yr ${x} · ${r.year}` : String(r.year), team: r.team.abbr, val: r.vals[metric] });
      const fill = mixLv && r.level === "NCAA" ? shade(sr, r) : `url(#cc-g${si})`;
      return `${one ? `<rect class="ky-track" x="${bx.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${(base - top).toFixed(1)}" rx="7"/>` : ""}<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${(base - by).toFixed(1)}" rx="${one ? 7 : 3}" class="cc-bar" data-n="${bnodes.length - 1}" style="fill:${fill};animation-delay:${(0.05 + (gi / Math.max(1, xs.length - 1)) * 0.6).toFixed(2)}s"/>`
        + (b != null ? `<line class="ky-bench" x1="${(bx - 5).toFixed(1)}" x2="${(bx + w + 5).toFixed(1)}" y1="${py(b).toFixed(1)}" y2="${py(b).toFixed(1)}"/>` : "")
        + (tags ? tag(cx, by, r.vals[metric]) : small ? `<text class="ky-val" x="${cx.toFixed(1)}" y="${(by - 6).toFixed(1)}">${esc(r.vals[metric])}</text>` : "");
    }).join("")).join("");
    // comparing players: the top-10 average stays a line over the bars (one player gets a marker on each bar instead)
    const benchOver = benchLine && !one ? benchLine.replace(/data-n="(\d+)"/g, (_, n) => { bnodes.push({ ...nodes[+n] }); return `data-n="${bnodes.length - 1}"`; }) : "";
    // kicking, one player, FG %: one bar chart that splits a season by distance when tapped (kickYears)
    const kickOne = cat === "kicking" && players.length === 1 && metric === "fieldGoalPct";
    if (!kickOne) kyData = null;
    const svg = (mode, body) => `<svg viewBox="0 0 ${W} ${H}" class="cc-chart cc-${mode}" data-mode="${mode}" role="img" aria-label="${esc(C.labels[metric])} by ${align === "career" ? "career year" : "season"}">${grid}${xlabels}${body}</svg>`;
    const mode = ccPref("view", "line") === "bar" ? "bar" : "line";
    const chart = `<div class="cc-range" id="cc-range"><div class="cc-rtrack"><i class="cc-rsel"></i><span class="cc-rlab"></span>
        <button class="cc-rh" role="slider" aria-label="First season"></button><button class="cc-rh" role="slider" aria-label="Last season"></button></div></div>
      <div class="cc-box" id="cc-box" data-mode="${mode}">${svg("line", lines)}${svg("bar", bars + benchOver)}<i class="cc-rline"></i><i class="cc-rline"></i><div class="cc-tip"></div></div>
      <p class="cc-hint muted">${isZoomed ? `Showing ${align === "career" ? "career years " : ""}${xs[0]}–${xs[xs.length - 1]} · <button class="link" id="cc-unzoom">Reset zoom</button>` : "Drag the squares above the chart to zoom in on a stretch of seasons"}</p>`;
    // what the hover box needs (read by initCcHover once the chart is on the page)
    ccHover = { W, H, top, base, padL, padR, all: allXs, sel: [xs[0], xs[xs.length - 1]], zoomed: isZoomed, career: align === "career", cols: xs.map((x, gi) => ({ x, px: px(gi) })), sets: { line: nodes, bar: bnodes }, stat: C.labels[metric], series: series.map((sr) => ({ name: sr.p.name, color: sr.color })) };
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
        <label>Chart <select id="cc-metric">${names.map((n) => `<option value="${esc(n)}"${n === metric ? " selected" : ""}>${esc(C.labels[n])}</option>`).join("")}</select></label>
        <label>Line up by <select id="cc-align"><option value="season"${align === "season" ? " selected" : ""}>Season</option><option value="career"${align === "career" ? " selected" : ""}>Career year</option></select></label>
        ${kickOne ? "" : `<div class="seg" id="cc-view"><button data-v="line" class="${mode === "line" ? "active" : ""}">Line</button><button data-v="bar" class="${mode === "bar" ? "active" : ""}">Bar</button></div>`}
        <div class="seg"><button id="cc-tbl" class="${ccPref("table", "1") === "1" ? "active" : ""}" title="Show or hide the data table">Table</button></div>
        <div class="cc-search"><input id="cc-q" type="search" placeholder="Compare with another player…" autocomplete="off"${players.length >= 4 ? " disabled" : ""}><div id="cc-results" class="cc-results hidden"></div></div>
      </div>
      <div class="cc-legend">${legend}</div>
      ${kickOne ? kickYears(series[0].rows, bench) || chart : chart}
      <div class="table-wrap${ccPref("table", "1") === "1" ? "" : " hidden"}" id="cc-table">${table}</div>
    </div>`;
  }

  // Kicking, one player: field goal % by season as bars. Tap a season and its bar splits into make % by distance (1-19 ...
  // 50+) and extra points (blue), the other seasons fading back; tap it again (or another season) to put it back together.
  const KICK_SPLITS = [["fieldGoalsMade1_19-fieldGoalAttempts1_19", "1–19"], ["fieldGoalsMade20_29-fieldGoalAttempts20_29", "20–29"],
    ["fieldGoalsMade30_39-fieldGoalAttempts30_39", "30–39"], ["fieldGoalsMade40_49-fieldGoalAttempts40_49", "40–49"], ["fieldGoalsMade50-fieldGoalAttempts50", "50+"],
    ["xp", "XP"]]; // extra points: ESPN has made and tried as two stats
  let kyData = null; // what the tap handler needs (wireCareer)
  function kickYears(rows, bench) {
    const ma = (v) => { const m = /^(\d+)-(\d+)$/.exec(String(v ?? "")); return m ? [+m[1], +m[2]] : null; };
    const yrs = rows.map((r) => ({ year: r.year, team: r.team, pct: num(r.vals.fieldGoalPct), fg: ma(r.vals["fieldGoalsMade-fieldGoalAttempts"]),
      parts: KICK_SPLITS.map(([k, label]) => ({ k, label, x: k === "xp" ? (num(r.vals.extraPointsMade) != null && num(r.vals.extraPointAttempts) != null ? [num(r.vals.extraPointsMade), num(r.vals.extraPointAttempts)] : null) : ma(r.vals[k]) })) }))
      .filter((r) => r.pct != null);
    if (!yrs.length) return "";
    const W = 720, H = 290, padL = 48, padR = 12, top = 36, base = H - 50, gw = (W - padL - padR) / yrs.length, bw = Math.min(84, gw * 0.56);
    const compact = yrs.length > 7, tiny = gw < 44; // many seasons: plain small numbers instead of tags, short labels
    const py = (p) => base - (p / 100) * (base - top);
    const grid = [0, 25, 50, 75, 100].map((f) => `<line x1="${padL}" y1="${py(f).toFixed(1)}" x2="${W - padR}" y2="${py(f).toFixed(1)}" class="${f ? "cc-grid" : "cc-axis"}"/><text x="${padL - 6}" y="${(py(f) + 3.5).toFixed(1)}" class="cc-y">${f}%</text>`).join("");
    // a value pill over a bar: the number on a small rounded tag
    const pill = (cx, y, txt, cls = "") => `<g class="ky-pill${cls}"><rect x="${(cx - 27).toFixed(1)}" y="${(y - 27).toFixed(1)}" width="54" height="19" rx="9.5"/><text x="${cx.toFixed(1)}" y="${(y - 13.5).toFixed(1)}">${txt}</text></g>`;
    const defs = `<defs><linearGradient id="ky-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ky-g0"/><stop offset="1" class="ky-g1"/></linearGradient>
      <linearGradient id="ky-gx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ky-gx0"/><stop offset="1" class="ky-gx1"/></linearGradient></defs>`;
    const bars = yrs.map((r, i) => {
      const x = padL + i * gw + (gw - bw) / 2, y = py(r.pct), cx = x + bw / 2, b = bench?.get(r.year);
      return `<g class="ky-yr" data-i="${i}" role="button" aria-label="${r.year}: ${r.pct}% field goals. Tap to split by distance"><rect class="ky-hit" x="${(padL + i * gw).toFixed(1)}" y="${top - 30}" width="${gw.toFixed(1)}" height="${base - top + 66}"/>
        <rect class="ky-track" x="${x.toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${base - top}" rx="7"/>
        <rect class="ky-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - y).toFixed(1)}" rx="7"/>
        ${b != null ? `<line class="ky-bench" x1="${(x - 6).toFixed(1)}" x2="${(x + bw + 6).toFixed(1)}" y1="${py(b).toFixed(1)}" y2="${py(b).toFixed(1)}"><title>Top-10 kickers' average: ${b.toFixed(1)}%</title></line>` : ""}
        ${compact ? `<text class="ky-val" x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}">${Math.round(r.pct)}</text>` : pill(cx, y, `${r.pct.toFixed(1)}%`)}
        <text class="ky-x${compact ? " sm" : ""}" x="${cx.toFixed(1)}" y="${base + 19}">${tiny ? "’" + String(r.year).slice(2) : r.year}</text><text class="ky-sub${compact ? " sm" : ""}" x="${cx.toFixed(1)}" y="${base + 35}">${r.fg ? (compact ? `${r.fg[0]}/${r.fg[1]}` : `${r.fg[0]} of ${r.fg[1]}`) : ""}</text></g>`;
    }).join("");
    kyData = { yrs, W, padL, padR, top, base, gw, bw, py, pill, open: null };
    const hasBench = yrs.some((r) => bench?.get(r.year) != null);
    return `<div class="cc-box ky-box"><svg viewBox="0 0 ${W} ${H}" id="ky-chart" class="ky-chart" role="img" aria-label="Field goal percentage by season">${defs}${grid}${bars}<g id="ky-split"></g>

        </svg></div>
      <p class="cc-hint muted ky-cap">${hasBench ? `<span class="ky-key"><i></i>Top-10 kickers' average</span>` : ""}<span id="ky-hint">Tap a season to split it into make % by distance and extra points.</span></p>`;
  }
  // tap a season: its bar breaks apart into the six distance / XP bars, sliding out across the chart; tap again to fold them back
  function wireKickYears() {
    const svg = $("#ky-chart"), D = kyData;
    if (!svg || !D) return;
    const split = svg.querySelector("#ky-split"), ease = (t) => 1 - (1 - t) ** 3;
    let raf = 0;
    const animate = (from, to, dur, done) => {
      cancelAnimationFrame(raf);
      const t0 = performance.now(), rects = [...split.querySelectorAll(".ky-part")];
      const step = (now) => {
        const t = ease(Math.min(1, (now - t0) / dur));
        rects.forEach((el, j) => ["x", "y", "width", "height"].forEach((a) => el.setAttribute(a, (from[j][a] + (to[j][a] - from[j][a]) * t).toFixed(1))));
        if (t < 1) raf = requestAnimationFrame(step); else done?.();
      };
      raf = requestAnimationFrame(step);
    };
    const geo = (i) => { // the season's bar, cut into six slices (where the parts start) and the six bars across the chart (where they end)
      const r = D.yrs[i], x = D.padL + i * D.gw + (D.gw - D.bw) / 2, y = D.py(r.pct), n = r.parts.length;
      const sw = (D.W - D.padL - D.padR) / n, pw = Math.min(64, sw * 0.6);
      return r.parts.map((p, j) => {
        const pct = p.x && p.x[1] ? p.x[0] / p.x[1] : null, ty = pct == null ? D.base : D.py(pct * 100);
        return { p, pct, cx: D.padL + j * sw + sw / 2, from: { x: x + (j * D.bw) / n, y, width: D.bw / n, height: D.base - y },
          to: { x: D.padL + j * sw + (sw - pw) / 2, y: ty, width: pw, height: D.base - ty } };
      });
    };
    const close = (instant) => {
      const i = D.open;
      if (i == null) return;
      D.open = null;
      svg.classList.remove("ky-split-on");
      svg.querySelectorAll(".ky-yr").forEach((g) => g.classList.remove("ky-dim", "ky-on"));
      $("#ky-hint").textContent = "Tap a season to split it into make % by distance and extra points.";
      split.querySelectorAll(".ky-lbl").forEach((t) => t.remove());
      if (instant) { split.innerHTML = ""; return; }
      const G = geo(i);
      animate(G.map((x) => x.to), G.map((x) => x.from), 380, () => { if (D.open == null) split.innerHTML = ""; });
    };
    const open = (i) => {
      close(true);
      D.open = i;
      const r = D.yrs[i], G = geo(i);
      svg.classList.add("ky-split-on");
      svg.querySelectorAll(".ky-yr").forEach((g) => { const me = +g.dataset.i === i; g.classList.toggle("ky-on", me); g.classList.toggle("ky-dim", !me); });
      split.innerHTML = G.map((x) => `<rect class="ky-part${x.p.k === "xp" ? " xp" : ""}" x="${x.from.x}" y="${x.from.y}" width="${x.from.width}" height="${x.from.height}" rx="6"/>`).join("");
      $("#ky-hint").textContent = `${r.year}: make % from each distance, and extra points (blue). Tap again to put it back.`;
      animate(G.map((x) => x.from), G.map((x) => x.to), 520, () => {
        if (D.open !== i) return;
        split.insertAdjacentHTML("afterbegin", `<g class="ky-lbl">${G.map((x) => `<rect class="ky-track" x="${x.to.x.toFixed(1)}" y="${D.top}" width="${x.to.width.toFixed(1)}" height="${D.base - D.top}" rx="6"/>`).join("")}</g>`); // the 100% tracks, under the bars
        split.insertAdjacentHTML("beforeend", G.map((x, j) => `${x.p.k === "xp" ? `<line class="ky-lbl ky-sep" x1="${(x.cx - (D.W - D.padL - D.padR) / G.length / 2).toFixed(1)}" x2="${(x.cx - (D.W - D.padL - D.padR) / G.length / 2).toFixed(1)}" y1="${D.top}" y2="${D.base + 34}"/>` : ""}
          <g class="ky-lbl">${D.pill(x.cx, x.pct == null ? D.base : x.to.y, x.pct == null ? "–" : Math.round(x.pct * 100) + "%", x.p.k === "xp" ? " xp" : "")}</g>
          <text class="ky-lbl ky-x" x="${x.cx.toFixed(1)}" y="${D.base + 19}">${x.p.label}</text><text class="ky-lbl ky-sub" x="${x.cx.toFixed(1)}" y="${D.base + 35}">${x.p.x ? `${x.p.x[0]} of ${x.p.x[1]}` : "none"}</text>`).join(""));
      });
    };
    svg.onclick = (e) => {
      const g = e.target.closest(".ky-yr"), i = g ? +g.dataset.i : null;
      if (D.open != null && (i === D.open || i == null || g.classList.contains("ky-dim"))) return close(false); // tap anywhere to fold it back
      if (i != null) open(i);
    };
  }

  // chart style and table on/off are remembered per browser (a convenience; everything works without it)
  function ccPref(k, def) { try { return localStorage.getItem("cc-" + k) ?? def; } catch { return def; } }
  function ccSetPref(k, v) { try { localStorage.setItem("cc-" + k, v); } catch {} }

  let playerIndexP = null; // all-time NFL player list, loaded the first time someone searches
  const playerIndex = () => (playerIndexP ||= fetch("data/players_nfl.json").then((r) => r.json()).catch(() => { playerIndexP = null; return []; }));

  // search result headshot: initials underneath, ESPN's photo on top (removed if ESPN has none, so the initials show)
  const searchFace = (lg, id, name) => `<span class="gs-face">${esc(initials(name))}<img src="${esc(thumb(`https://a.espncdn.com/i/headshots/${lg === "nfl" ? "nfl" : "college-football"}/players/full/${encodeURIComponent(id)}.png`, 22, 22, true))}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
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
      .slice(0, 8).map(([, p]) => ({ key: `nfl:${p[1]}`, name: p[0], pic: searchFace("nfl", p[1], p[0]), tag: `NFL · ${p[2]}${p[3] ? ` · ${p[3]}–${p[4] || ""}` : ""}` }));
    const seen = new Set(local.map((x) => x.key));
    const live = (d?.items || []).filter((it) => it.league === "nfl" || it.league === "college-football")
      .map((it) => ({ key: `${it.league === "nfl" ? "nfl" : "cfb"}:${it.id}`, name: it.displayName, pic: searchFace(it.league === "nfl" ? "nfl" : "cfb", it.id, it.displayName), tag: it.league === "nfl" ? "NFL" : "College" }))
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
    // picking seasons is the range bar's job (initCcRange); on the chart a touch or a mouse just reads the dots
    box.addEventListener("pointerdown", (e) => show(e, e.pointerType === "touch"));
    box.addEventListener("pointermove", (e) => show(e, e.pointerType === "touch"));
    box.addEventListener("pointerleave", hide);
  }

  // Season range bar over Stats by year (Terry's sketch): drag either square to pick the first and last season, and the
  // chart zooms to them when you let go (at least two seasons). The track spans the chart's plot area with one stop per
  // season, so on the full chart the squares sit between the bars and dashed lines show where each one cuts the chart.
  function initCcRange() {
    const R = $("#cc-range"), box = $("#cc-box"), H = ccHover;
    if (!R || !box || !H) return;
    if (H.all.length < 3) { R.remove(); return; }
    const track = R.querySelector(".cc-rtrack"), sel = R.querySelector(".cc-rsel"), lab = R.querySelector(".cc-rlab");
    const hs = R.querySelectorAll(".cc-rh"), lines = box.querySelectorAll(".cc-rline"), n = H.all.length;
    let a = Math.max(0, H.all.indexOf(H.sel[0])), b = H.all.indexOf(H.sel[1]), drag = null;
    if (b < 0) b = n - 1;
    const yr = (x) => (H.career ? `Yr ${x}` : `${x}`);
    const fit = () => { // line the track up with the chart's plot area as drawn on screen
      const m = box.querySelector(`svg[data-mode="${box.dataset.mode}"]`)?.getScreenCTM();
      if (!m) return;
      const left = R.getBoundingClientRect().left, x0 = m.a * H.padL + m.e - left, x1 = m.a * (H.W - H.padR) + m.e - left;
      Object.assign(track.style, { left: `${x0}px`, width: `${x1 - x0}px` });
    };
    const draw = () => {
      const L = (a / n) * 100, Rt = ((b + 1) / n) * 100;
      hs[0].style.left = `${L}%`; hs[1].style.left = `${Rt}%`;
      Object.assign(sel.style, { left: `${L}%`, width: `${Rt - L}%` });
      lab.style.left = `${(L + Rt) / 2}%`;
      lab.textContent = `${yr(H.all[a])}–${yr(H.all[b])}`;
      hs[0].setAttribute("aria-valuetext", yr(H.all[a])); hs[1].setAttribute("aria-valuetext", yr(H.all[b]));
      const tr = track.getBoundingClientRect(), bx = box.getBoundingClientRect();
      lines.forEach((ln, i) => { // only lines up with the bars when the chart shows every season
        ln.style.display = drag != null && !H.zoomed ? "block" : "none";
        ln.style.left = `${tr.left - bx.left + (tr.width * (i ? Rt : L)) / 100}px`;
      });
    };
    const commit = () => {
      if (H.all[a] === H.sel[0] && H.all[b] === H.sel[1]) return;
      const all = a === 0 && b === n - 1;
      box.ccZoom?.(all ? null : H.all[a], all ? null : H.all[b]);
    };
    hs.forEach((h, i) => {
      h.onpointerdown = (e) => { e.preventDefault(); try { h.setPointerCapture(e.pointerId); } catch {} drag = i; R.classList.add("on"); draw(); };
      h.onpointermove = (e) => {
        if (drag !== i) return;
        const tr = track.getBoundingClientRect(), f = Math.round(((e.clientX - tr.left) / tr.width) * n);
        if (i) b = Math.min(n - 1, Math.max(a + 1, f - 1)); else a = Math.max(0, Math.min(b - 1, f));
        draw();
      };
      h.onpointerup = h.onpointercancel = () => { if (drag !== i) return; drag = null; R.classList.remove("on"); draw(); commit(); };
      h.onkeydown = (e) => { // arrow keys move a square one season
        const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (!d) return;
        e.preventDefault();
        if (i) b = Math.min(n - 1, Math.max(a + 1, b + d)); else a = Math.max(0, Math.min(b - 1, a + d));
        draw(); commit();
      };
    });
    fit(); draw();
    const re = () => { if (!R.isConnected) return removeEventListener("resize", re); fit(); draw(); };
    addEventListener("resize", re);
  }

  function wireCareer(id, params) {
    initCcHover();
    if ($("#cc-view")) $("#cc-view").onclick = (e) => {
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
    wireKickYears();
    pinchPan($("#cc-box")); pinchPan(document.querySelector(".ky-box")); // pinch to zoom on phones
    if ($("#cc-lvl")) $("#cc-lvl").onclick = (e) => { const v = e.target.dataset.lvl; if (v) go({ lvl: v, from: null, to: null }); };
    if ($("#cc-box")) $("#cc-box").ccZoom = (from, to) => go({ from, to });
    initCcRange();
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
    const ptab = params.get("tab") === "takes" ? "takes" : "";
    let bio, gl, takes, recs;
    try {
      [bio, gl, takes, recs] = await Promise.all([
        api(`${WEB(lg)}/athletes/${encodeURIComponent(id)}`, 300000),
        api(`${WEB(lg)}/athletes/${encodeURIComponent(id)}/gamelog${season ? `?season=${season}` : ""}`, 120000).catch(() => null),
        Takes.about("players", `${lg}:${id}`).catch(() => []), // our X posts about this player (takes.js)
        lg === "nfl" ? nflRecords(id) : [],
      ]);
    } catch (e) { return fail("player", e); }
    if (my !== token) return;
    const a = fixPos(bio.athlete);
    // college seasons for the game log (NFL players): ESPN keeps those games under his college athlete id
    const cseason = lg === "nfl" ? params.get("cseason") : null, cid = lg === "nfl" ? a.collegeAthlete?.id : null;
    const cgl = cid ? await api(`${WEB("cfb")}/athletes/${encodeURIComponent(cid)}/gamelog${cseason ? `?season=${encodeURIComponent(cseason)}` : ""}`, 3600000).catch(() => null) : null;
    if (my !== token) return;
    const logGl = cseason && cgl ? cgl : gl, logLg = logGl === cgl ? "cfb" : lg;
    const facts = [
      a.position?.displayName, a.displayJersey,
      [a.displayHeight, a.displayWeight].filter(Boolean).join(", "),
      a.age ? `Age ${a.age}` : "", a.displayDraft,
      a.college?.name || a.collegeTeam?.displayName ? `College: ${a.college?.name || a.collegeTeam?.displayName}` : "",
      a.displayBirthPlace ? `From ${a.displayBirthPlace}` : "",
    ].filter(Boolean);
    const inj = a.injuries?.[0];
    const fa = a.status?.type === "free-agent"; // ESPN keeps a free agent's last team on the record, so check the status
    // this season's tiles: if the game log has a game ESPN's summary hasn't counted yet, add the season up from the log
    let sumStats = a.statsSummary?.statistics || [], caughtUp = false;
    const L = season ? null : logSeason(gl);
    if (L) {
      sumStats = sumStats.map((x) => {
        const s = L.sum[x.name], cur = parseFloat(String(x.displayValue).replace(/,/g, ""));
        if (s == null || RATE.test(x.name) || !(s > cur)) return x;
        caughtUp = true;
        return { ...x, displayValue: s.toLocaleString(), rankDisplayValue: "" };
      });
      const per = (n, d) => (L.sum[d] ? L.sum[n] / L.sum[d] : null);
      const fix = { yardsPerReception: per("receivingYards", "receptions"), yardsPerRushAttempt: per("rushingYards", "rushingAttempts"),
        completionPct: L.sum.passingAttempts ? (100 * L.sum.completions) / L.sum.passingAttempts : null };
      if (caughtUp) sumStats = sumStats.map((x) => (fix[x.name] != null ? { ...x, displayValue: fix[x.name].toFixed(1), rankDisplayValue: "" } : x));
    }
    const summary = sumStats.map((x) => `<div class="stat"><small>${esc(x.displayName)}</small><b>${esc(x.displayValue)}</b>${x.rankDisplayValue ? `<small class="muted">${esc(x.rankDisplayValue)}</small>` : ""}</div>`).join("");

    let log = "";
    if (logGl?.seasonTypes?.length) {
      const groups = (logGl.categories || []).map((c) => `<th colspan="${c.count}" class="grp">${esc(c.displayName)}</th>`).join("");
      log = logGl.seasonTypes.map((stp) => {
        const evs = stp.categories.flatMap((c) => c.events || []);
        if (!evs.length) return "";
        const rows = evs.map((ev) => {
          const m = logGl.events?.[ev.eventId] || {};
          return `<tr><td>${esc(m.week ?? "")}</td>
            <td><span class="tm">${esc(m.atVs || "")} ${img(m.opponent?.logo, "xs")} ${esc(m.opponent?.abbreviation || "")}</span></td>
            <td><a href="${link("game", ev.eventId, { league: logLg })}"><span class="${m.gameResult === "W" ? "W" : m.gameResult === "L" ? "L" : ""}">${esc(m.gameResult || "")}</span> ${esc(m.score || "")}</a></td>
            ${ev.stats.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>`;
        }).join("");
        const tot = stp.summary?.stats?.[0]?.stats;
        return `<h4>${esc(stp.displayName)}</h4><div class="table-wrap"><table class="box">
          <thead>${groups ? `<tr><th colspan="3"></th>${groups}</tr>` : ""}<tr><th>Wk</th><th>Opp</th><th>Result</th>${(logGl.labels || []).map((l) => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead>
          <tbody>${rows}${tot ? `<tr class="tot"><td colspan="3">Totals</td>${tot.map((v) => `<td class="num">${esc(v)}</td>`).join("")}</tr>` : ""}</tbody></table></div>`;
      }).join("");
    }
    const thisYear = new Date().getFullYear(), born = birthYear(a);
    const hsLabel = [a.jersey ? "#" + a.jersey : "", a.position?.abbreviation || ""].filter(Boolean).join(" ");
    // every season of the career: ESPN lists them on the game log (e.g. 1985-2004 for Jerry Rice)
    const seasonF = (gl?.filters || []).find((f) => f.name === "season");
    const firstYear = a.debutYear || thisYear - 25;
    const cYears = ((cgl?.filters || []).find((f) => f.name === "season")?.options || []).map((o) => +o.value);
    const noLogs = !seasonF?.options?.length && a.active === false && !cYears.length; // retired and ESPN has no game logs at all (pre-1990s careers)
    const years = seasonF?.options?.length ? seasonF.options.map((o) => +o.value) : noLogs ? [] : Array.from({ length: thisYear - firstYear + 1 }, (_, i) => thisYear - i);
    const shown = +(season || seasonF?.value || gl?.requestedSeason?.year || thisYear);
    // years in the league: active players get ESPN's current count; retired ones get filled in from their career record below
    const exp = a.active !== false ? a.displayExperience || a.experience?.displayValue || "" : "";
    const head = `
      <div class="card player-head">
        <div class="hs-frame" style="--tc:${teamColor(a.team)}">
          ${face(a.headshot?.href, a.displayName, "headshot", lg === "nfl", born)}
          ${hsLabel ? `<span class="hs-tag">${esc(hsLabel)}</span>` : ""}</div>
        <div>
          <h2>${esc(a.displayName)}${lg === "nfl" && a.active === false ? ` <span class="retired-tag">Retired</span>` : ""}${recs.length ? ` <a class="rec-tag" href="#pl-recs" title="${esc(recs.map((r) => r[0]).join(" · "))}">★ NFL record${recs.length > 1 ? `s (${recs.length})` : ""}</a>` : ""}</h2>
          <p>${a.team ? `<a href="${link("team", a.team.id)}"><span class="tm">${img(a.team.logos?.[0]?.href || a.team.logo, "xs")} ${esc(a.team.displayName)}</span></a>` : ""}
            ${injInfo(inj) ? ` <span class="inj-line">${injTag(inj, a.id, fa ? "" : a.team?.id)} ${esc(injInfo(inj).tip)}</span>` : ""}</p>
          <p class="muted">${facts.map(esc).join(" · ")}<span id="pl-exp">${exp ? " · " + esc(exp) : ""}</span></p>
          <p class="pl-acts"><a class="btn" href="${link("stats", null, { show: "visualize", him: a.id })}">📈 Chart him</a></p>
        </div>
      </div>${takes.length ? `
      <div class="subtabs"><a class="subtab${ptab ? "" : " on"}" href="${link("player", id)}">Stats</a><a class="subtab${ptab ? " on" : ""}" href="${link("player", id, { tab: "takes" })}">Takes <small>${takes.length}</small></a></div>` : ""}`;
    if (ptab === "takes") {
      view("player").innerHTML = head + `<div class="card">${takes.length ? Takes.list(takes) : `<p class="muted">No takes about this player yet. <a href="${link("takes")}">See all our Takes →</a></p>`}</div>`;
      fillFaces(view("player"));
      return;
    }
    const pcModes = { QB: ["pass", "rush"], WR: ["target"], TE: ["target"], RB: ["rush", "target"], FB: ["rush", "target"] }[a.position?.abbreviation] || [];
    const kicker = logLg === "nfl" && !pcModes.includes("pass"); // a kick chart if he tried a field goal this season (kickChartInto drops it otherwise; ESPN's position can be wrong)
    // NFL records he holds, in gold: the first few, the rest behind "more"
    const recRow = (r) => `<li><b>${esc(r[0])}</b><span class="rec-val">${esc(r[1])}</span>${r[2] ? `<small>${esc(r[2])}</small>` : ""}</li>`;
    const recCard = recs.length ? `<div class="card rec-card" id="pl-recs"><h3>★ NFL record${recs.length > 1 ? "s" : ""} he holds</h3><ul>${recs.slice(0, 4).map(recRow).join("")}</ul>
      ${recs.length > 4 ? `<details><summary>${recs.length - 4} more</summary><ul>${recs.slice(4).map(recRow).join("")}</ul></details>` : ""}
      <p class="note muted">From the NFL's record lists (Wikipedia, citing the NFL Record & Fact Book and Pro Football Reference). Shared records count.</p></div>` : "";
    view("player").innerHTML = head + recCard + `
      ${summary ? `<div class="stats wide">${summary}</div>${caughtUp ? `<p class="note muted">Added up from his game-by-game stats, so it includes his latest game. Ranks come back once the overnight totals update.</p>` : ""}` : ""}
      <div id="career-slot"><div class="card muted">Loading stats by year…</div></div>
      ${pcModes.length && logGl?.events && Object.keys(logGl.events).length ? `<div id="pc-slot"><div class="card muted">Loading pass chart…</div></div>` : ""}
      ${kicker ? `<div id="kc-slot"></div>` : ""}
      <div class="card"><div class="sc-bar"><h3>Game log</h3>
        <select id="pl-season"${noLogs ? ` class="hidden"` : ""}>${years.filter((y) => !cYears.includes(y)).map((y) => `<option${!cseason && y === shown ? " selected" : ""}>${y}</option>`).join("")}${cYears.map((y) => `<option value="c${y}"${String(y) === cseason ? " selected" : ""}>${y} (college)</option>`).join("")}</select></div>
        ${log || (noLogs ? `<p class="muted">ESPN doesn't have game-by-game logs for this player's career. Season totals, where ESPN has them, are in Stats by year above.</p>` : shown < 2000 ? `<p class="muted">ESPN doesn't have game-by-game logs for ${shown} (older seasons are spotty before the late 1990s). Season totals are in Stats by year above.</p>`
          : `<p class="muted">No games logged for this season.</p>`)}</div>
      ${injInfo(inj) ? injCard(inj, a.id, fa ? "" : a.team?.id)
        : params.get("inj") ? `<div class="card inj-card" id="pl-inj"><h3>Injury</h3><p class="muted">ESPN has no injury details on file for this player right now.</p></div>` : ""}`;
    fillFaces(view("player"));
    if (my === token) outlookInto(lg, id, $("#career-slot"), season ? null : gl).catch(() => {});
    const pcSlot = $("#pc-slot");
    if (pcSlot) { // load every game's play-by-play only once you scroll near it (or right away, and scroll to it, from a shared chart link)
      const load = () => { if (my === token) passChartInto(logLg, a, logGl, pcSlot, pcModes, logLg === "nfl" ? shown : null, params).then(() => { if (params.get("chart") && my === token) pcSlot.scrollIntoView({ block: "start" }); }).catch(() => pcSlot.remove()); };
      if (params.get("chart")) load();
      else { const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "300px" }); io.observe(pcSlot); }
    }
    const kcSlot = $("#kc-slot");
    if (kcSlot) kickChartInto(a, shown, kcSlot).catch(() => kcSlot.remove());
    const toInj = params.get("inj") && $("#pl-inj");
    if (toInj) pulse(toInj);
    $("#pl-season").onchange = (e) => { const v = e.target.value; location.hash = link("player", id, v[0] === "c" ? { cseason: v.slice(1) } : { season: v }); };
    if (lg === "nfl" && OL_ABBR.has(a.position?.abbreviation)) { // linemen: blocking stats instead of ESPN's (tackles only)
      await olInto(id, $("#career-slot"));
      if (toInj && my === token) pulse(toInj);
      return;
    }
    const careers = await careersP;
    if (my !== token) return;
    const cst = { cat: params.get("cat"), metric: params.get("metric"), align: params.get("align"), from: params.get("from"), to: params.get("to"), lvl: params.get("lvl") };
    // top-10 average line; don't hold the chart up more than a few seconds for it
    const bench = careers ? await Promise.race([top10Avg(careers, cst).catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))]) : null;
    if (my !== token) return;
    $("#career-slot").innerHTML = careers ? careerCard(careers, cst, bench)
      : `<div class="card muted">Season-by-season stats aren't available for this player.</div>`;
    if (careers) {
      if ($("#cc-cats")) wireCareer(id, params); // not there when the player has no season stats
      fillFaces($("#career-slot"));
      const me = careers[0], n = me.seasons.length;
      if (!exp && n) $("#pl-exp").textContent = ` · ${n} ${me.lvl === "NFL" ? "NFL" : "college"} season${n > 1 ? "s" : ""} (${me.seasons[0]}${n > 1 ? "–" + me.seasons[n - 1] : ""})`;
    }
    if (toInj) pulse(toInj); // stats by year just filled in above it, so find it again
    else if (vs.length) $("#career-slot").scrollIntoView({ block: "start" });
  }
  // Offensive linemen: ESPN has no blocking stats (its only numbers are the odd tackle after an interception), so their
  // "by year" card comes from docs/data/nfl/ol_stats.json (src/viz_data.py, nflverse): snaps, penalties called on him, and
  // his line's pressures, sacks and runs on the plays he was on the field for. Ranks are among linemen with 300+ snaps.
  const OL_ABBR = new Set(["OL", "OT", "T", "OG", "G", "C"]);
  const OL_MET = [
    ["snaps", "Snaps", (r) => r.snaps, 0, false],
    ["pen", "Penalties", (r) => r.pen, 0, true],
    ["pen100", "Penalties per 100 snaps", (r) => (r.snaps ? (100 * r.pen) / r.snaps : null), 2, true],
    ["pr", "Pressure % on the field", (r) => (r.ol_db ? (100 * r.ol_pr) / r.ol_db : null), 1, true, "%"],
    ["sk", "Sack % on the field", (r) => (r.ol_db ? (100 * r.ol_sk) / r.ol_db : null), 1, true, "%"],
    ["ypc", "Yards per run on the field", (r) => (r.ol_run ? r.ol_ryds / r.ol_run : null), 2, false],
  ];
  async function olCard(id, on) {
    const D = await getJSON("data/nfl/ol_stats.json");
    const row = (a) => Object.fromEntries(D.cols.map((c, i) => [c, a[i]]));
    const years = Object.keys(D.seasons).filter((y) => D.seasons[y][id]).sort();
    if (!years.length) return `<div class="card muted">No blocking stats for him yet. They come from snap counts, so he needs NFL snaps on the line.</div>`;
    const ord = (n) => n + ([11, 12, 13].includes(n % 100) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
    const m = OL_MET.find((x) => x[0] === on) || OL_MET[3];
    const [, label, fn, d, low, unit = ""] = m;
    const fmt = (v, dd = d) => (v == null ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: dd, maximumFractionDigits: dd }) + unit);
    const bars = years.map((y) => {
      const me = row(D.seasons[y][id]), v = fn(me);
      const pool = Object.values(D.seasons[y]).map(row).filter((r) => r.snaps >= 300).map(fn).filter((x) => x != null);
      const rk = v != null && me.snaps >= 300 ? 1 + pool.filter((x) => (low ? x < v : x > v)).length : null;
      return { y, v, rk, n: pool.length, me };
    });
    const max = Math.max(...bars.map((b) => b.v || 0), 0.001);
    const last = bars.at(-1).me;
    const tiles = [["Games", last.g], ["Snaps", last.snaps.toLocaleString()], ["Penalties", last.pen, `${last.pn_hold} holding · ${last.pn_fs} false start`],
      ["Pressure %", last.ol_db ? ((100 * last.ol_pr) / last.ol_db).toFixed(1) + "%" : "–", last.ol_db ? `${last.ol_db} dropbacks` : "not out yet"]];
    return `<div class="card ol-card"><h3>Blocking by year</h3>
      <div class="stats wide">${tiles.map(([l, v, s]) => `<div class="stat"><small>${l} (${years.at(-1)})</small><b>${v}</b>${s ? `<small class="muted">${s}</small>` : ""}</div>`).join("")}</div>
      <div class="ol-mets">${OL_MET.map(([k, l]) => `<button class="ol-m${k === m[0] ? " on" : ""}" data-olm="${k}">${l}</button>`).join("")}</div>
      <div class="ol-bars">${bars.map((b) => `<div class="ol-bar"><span class="ol-y">${b.y}</span>
        <span class="ol-track">${b.v != null ? `<i style="width:${Math.max(2, (100 * b.v) / max).toFixed(1)}%"></i>` : ""}</span>
        <b>${fmt(b.v)}</b><small class="muted">${b.rk ? `${ord(b.rk)} of ${b.n}${low ? " (1st = fewest)" : ""}` : b.v == null ? "not out yet" : "under 300 snaps"}</small></div>`).join("")}</div>
      <p class="note muted">${low ? "Lower is better. " : ""}Ranks are among offensive linemen with 300+ snaps that season. Nobody tracks sacks allowed by one lineman for free (PFF charts them by hand and charges for it), so pressure, sack and run numbers are his line's results on the plays he was on the field for (nflverse play-by-play and participation, 2022 on; the current season's arrive when nflverse publishes them). Penalties are the accepted ones called on him.</p></div>`;
  }
  async function olInto(id, slot, on) {
    slot.innerHTML = await olCard(id, on).catch(() => `<div class="card muted">Blocking stats aren't available right now.</div>`);
    slot.querySelector(".ol-mets")?.addEventListener("click", (e) => {
      const k = e.target.closest("[data-olm]")?.dataset.olm;
      if (k) olInto(id, slot, k);
    });
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
      ${shown.flatMap((c) => c.groups.map((g) => table(c.groups.length > 1 || nfl ? g.name : c.name, bySeed(g)))).join("") || `<div class="card muted">No standings available. <a href="${link("rankings")}">See our rankings →</a></div>`}
      ${nfl && shown.length ? `<p class="note">Seed = playoff seed if the season ended today; seeds 1–7 make the playoffs.</p>` : ""}`;
    $("#st-conf").onclick = (e) => {
      const v = e.target.dataset?.conf;
      if (v) location.hash = link("standings", null, { conf: v });
    };
  }


  // ---------------------------------------------------------------- playoff picture (a sub-view of Standings)
  // CFB: a 12-team CFP field projected from our rankings. NFL: ESPN's seeds if the season ended today.
  // Past the first round, each game goes to our model's favorite (ratings + home field, same math as src/model.py).
  const stSub = (on) => ""; // Standings / Playoff picture are pills in the group bar (app.js GROUPS)
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
      history.replaceState(history.state, "", link("standings", null, { show: "playoff", mode: "mine", ...(s ? { seeds: s } : {}), ...(p ? { picks: p } : {}) }));
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
        await Share.download(blob, `cupcake-index-${lg}-bracket-${season}.png`); // phones: the share sheet; computers: a download
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
    view("freeagents").innerHTML = trSub("freeagents") + `<div class="card muted">Loading…</div>`;
    let cands, teams;
    try {
      [cands, teams] = await Promise.all([faCandidates(), api(`${STAND("nfl")}/standings?level=3`, 86400000).then((d) => new Map(groupsOf(d).flatMap((g) => g.entries).map((e) => [String(e.team.id), e.team]))).catch(() => new Map())]);
    } catch (e) { return fail("freeagents", e); }
    if (my !== token) return;
    const done = new Map(); // id -> confirmed free agent row, or null if they're actually on a practice squad / retired
    view("freeagents").innerHTML = trSub("freeagents") + `<div class="card">
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
      const st = c.status?.type?.state, when = el.querySelector(".mb-when");
      if (when && st === "pre") when.textContent = statusText(c.status, c.date);
      // played since the weekly rankings file was made (e.g. Thursday night): show the real score and result
      if (el.classList.contains("pre") && (st === "post" || st === "in")) {
        const pts = (x) => x?.score?.displayValue ?? x?.score ?? "";
        for (const x of [me, op]) { const sc = el.querySelector(`.mb-tm.${x?.homeAway === "home" ? "home" : "away"} .mb-sc`); if (sc) sc.textContent = pts(x); }
        const mid = el.querySelector(".mb-mid");
        el.querySelector(".mb-win")?.remove(); el.querySelector(".mb-why")?.remove();
        el.classList.remove("pre"); el.classList.add(st);
        if (st === "in") { if (mid) mid.innerHTML = `<b class="live">LIVE</b><small>${esc(statusText(c.status, c.date))}</small>`; continue; }
        const r = me?.winner ? "W" : op?.winner ? "L" : "T";
        el.classList.add("res-" + r);
        if (mid) mid.innerHTML = `<b class="${r}">${r}</b><small>${esc(c.status?.type?.shortDetail || "Final")}</small>`;
        if (r !== "T") el.querySelector(`.mb-tm.${(r === "W" ? op : me)?.homeAway === "home" ? "home" : "away"}`)?.classList.add("lose");
      }
    }
  }

  async function team(id, params) {
    const lg = league, my = token;
    store.set("lastTeam-" + lg, String(id)); // standings open on this team's conference
    const nfl = lg === "nfl";
    const tab = ["glance", "roster", "takes", "injuries", ...(nfl ? ["depth", "moves"] : [])].includes(params.get("tab")) ? params.get("tab") : "schedule";
    loading("team");
    let sch, ros, ranks, extra, takes, starters;
    try {
      [sch, ros, ranks, extra, takes, starters] = await Promise.all([
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/schedule`, 60000),
        api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/roster`, 600000).catch(() => null),
        modelRanks(lg),
        tab === "depth" || (tab === "roster" && nfl) ? api(`${SITE(lg)}/teams/${encodeURIComponent(id)}/depthcharts`, 600000).catch(() => null)
          : tab === "injuries" ? (nfl ? injData() : cfbInj()).catch(() => null)
          : tab === "moves" ? api(`${SITE(lg)}/transactions?limit=1000`, 1800000).catch(() => null) : null,
        Takes.about("teams", `${lg}:${id}`).catch(() => []), // our X posts about this team (takes.js)
        Takes.starters(`${lg}:${id}`).catch(() => []), // top 25: conversation starters
      ]);
    } catch (e) { return fail("team", e); }
    if (my !== token) return;
    const T = sch.team || {};
    if (String(T.id) !== String(id)) { // opened by name, not id
      takes = await Takes.about("teams", `${lg}:${T.id}`).catch(() => []);
      starters = await Takes.starters(`${lg}:${T.id}`).catch(() => []);
    }
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
    // Just the Facts: true stats about this team from our game history (src/social/team_facts.py, nfl_facts.py)
    const factsAll = ours ? await getJSON(`data/${lg}/facts.json`).catch(() => null) : null;
    if (my !== token) return;
    const facts = factsAll?.teams?.[ours?.team] || [];
    const factsCard = facts.length ? `<div class="card jfacts"><h3>Just the facts <small>since ${esc(factsAll.since)} · updated ${esc(factsAll.updated)}</small></h3>
        <div class="jf-grid">${facts.map((f) => `<div class="jf"><b>${esc(f.big)}</b><span>${esc(f.label)}</span><small>${esc(f.detail)}</small></div>`).join("")}</div>
        <p class="note">${nfl ? "\"Winning record\" is going into the game; \"top 10\" is our top 10 by rating (final ratings for past seasons, today's for this one). Prime time = kickoff at 7 PM Eastern or later. Raiders, Chargers and Rams include their Oakland, San Diego and St. Louis years."
          : "Cupcake = an opponent far below this team's level, the same rule as the rankings. \"Ranked\" and \"top 10\" use the AP poll going into each game."}</p></div>` : "";
    const hub = `
      <div class="card thub" style="--tc:${esc(teamColor(T))}">
        <div class="th-top">
          ${img(teamLogo(T), "hero")}
          <div class="th-id"><h2>${esc(T.displayName || "")}</h2>
            <p>${[conf, T.standingSummary].filter(Boolean).map(esc).join(" · ")}</p>
            ${prof ? `<p class="th-prof">${profileBadge(prof)} <small>${esc(profs()[prof]?.desc || "")}</small></p>` : ""}</div>
          <div class="th-ranks">
            <div class="th-rk"><small>RECORD</small><b>${esc(T.recordSummary || ours?.record || "–")}</b></div>
            ${ours ? `<a class="th-rk ours" href="${link("rankings", null, { team: ours.team })}" title="Cupcake Index rank. Click for why."><small>OUR RANK</small><b>#${ours.rank}</b></a>` : ""}
            ${ours?.ap_rank ? `<div class="th-rk"><small>AP</small><b>#${esc(ours.ap_rank)}</b></div>` : ""}
            <span id="th-coach"></span>
          </div>
        </div>
        <div class="th-strip">
          <div><small>Points / game</small><b>${perGame((m) => m)}</b></div>
          <div><small>Allowed / game</small><b>${perGame((m, o) => o)}</b></div>
          ${ours ? `<div><small>Power rating</small><b>${ours.rating > 0 ? "+" : ""}${ours.rating.toFixed(1)}</b></div>` : ""}
          ${ours ? `<div><small>Why #${ours.rank}?</small><a class="boxlink" href="${link("breakdown", ours.team)}">See the breakdown →</a></div>` : ""}
        </div>
        ${ours?.scores ? `<p class="th-why">${esc(Breakdown.why(ours, [...ranks.byName.values()], lg))}</p>` : ""}
      </div>
      <div class="th-grid">
        ${facs.length ? `<div class="card"><h3>Factor scores</h3>${facs.map((f) => `<div class="frow" title="${esc(f.help || "")}"><span>${esc(f.label)}</span><span class="bar${f.invert ? " inv" : ""}"><i style="width:${+ours.scores[f.key] || 0}%"></i></span><b class="num">${Math.round(ours.scores[f.key])}</b></div>`).join("")}</div>` : ""}
        ${shown ? `<div class="card th-next"><h3>${next ? "Next game" : "Last game"}</h3><div class="mb-list">${bug(shown)}</div>
          <p class="note">${esc(shown.competitions[0].venue?.fullName || "")}${shown.competitions[0].venue?.fullName && shown.competitions[0].broadcasts?.[0]?.media?.shortName ? " · " : ""}${watch(shown.competitions[0].broadcasts?.[0]?.media?.shortName || "", stateOf(shown))}</p></div>` : ""}
      </div>${factsCard}`;

    // roster: offense / defense / special teams, each by position (QB, RB, WR, TE, OL... DL, LB, CB, S... K, P, LS)
    // and depth-chart order within a position (NFL), with a small header per position. Or sort by any column.
    const depthAt = new Map(); // athlete id -> 0 for a starter, 1 for the 2nd string...
    (tab === "roster" ? extra?.depthchart || [] : []).forEach((f) => Object.entries(f.positions || {}).forEach(([key, P]) => !["pr", "kr", "h"].includes(key) && (P.athletes || []).forEach((a, i) => { // returners / holder aren't "starters"
      const k = String(a.id);
      if (!depthAt.has(k) || i < depthAt.get(k)) depthAt.set(k, i);
    })));
    const POS_SEQ = ["QB", "RB", "HB", "FB", "WR", "TE", "OT", "T", "OL", "G", "OG", "C", "DE", "EDGE", "DL", "DT", "NT", "LB", "OLB", "ILB", "MLB",
      "CB", "DB", "S", "SS", "FS", "PK", "K", "P", "LS"];
    const posAt = (p) => { const i = POS_SEQ.indexOf(p.position?.abbreviation || ""); return i < 0 ? 99 : i; };
    const injAt = (p) => { const st = p.injuries?.[0]?.status || ""; return /out|reserve|suspen/i.test(st) ? 0 : /doubt/i.test(st) ? 1 : /quest/i.test(st) ? 2 : 3; };
    const RS = { num: ["#", (p) => +p.jersey || 999], name: ["Player", (p) => (p.lastName || p.displayName || "").toLowerCase()], pos: ["Pos", posAt],
      ht: ["Ht", (p) => p.height || 0], wt: ["Wt", (p) => p.weight || 0], age: [nfl ? "Age" : "Class", (p) => (nfl ? p.age : p.experience?.years) || 0], status: ["Status", injAt] };
    const rsort = RS[params.get("sort")] ? params.get("sort") : "", rdesc = params.get("dir") === "desc";
    const byDepth = (a, b) => posAt(a) - posAt(b) || (depthAt.get(String(a.id)) ?? 99) - (depthAt.get(String(b.id)) ?? 99) || (+a.jersey || 999) - (+b.jersey || 999);
    const rsorter = rsort ? (a, b) => { const x = RS[rsort][1](a), y = RS[rsort][1](b); return (x < y ? -1 : x > y ? 1 : 0) * (rdesc ? -1 : 1) || byDepth(a, b); } : byDepth;
    const rth = (k, cls = "") => { const on = rsort === k, d = on && !rdesc ? "desc" : "asc";
      return `<th class="sortable${cls}${on ? " on" : ""}"><a href="${link("team", id, { tab: "roster", sort: k, dir: d })}" title="Sort by ${esc(RS[k][0])}">${esc(RS[k][0])}${on ? (rdesc ? " ▼" : " ▲") : ""}</a></th>`; };
    const rosterRows = (ros?.athletes || []).filter((g) => g.items?.length).map((g) => {
      let last = null;
      const rows = g.items.slice().sort(rsorter).map((p) => {
        const pos = p.position?.abbreviation || "", head = !rsort && pos !== last ? `<tr class="ro-pos"><td colspan="7">${esc(p.position?.displayName || pos)}</td></tr>` : "";
        last = pos;
        const d = depthAt.get(String(p.id));
        return `${head}<tr data-pid="${esc(p.id)}"><td class="num muted">${esc(p.jersey || "")}</td>
        <td><div class="team">${face(p.headshot?.href, p.displayName, "hs")}<a href="${link("player", p.id)}">${esc(p.displayName)}</a>${d === 0 ? ` <small class="ro-st" title="Starter on ESPN's depth chart">S</small>` : ""}</div></td>
        <td>${esc(pos)}</td><td>${esc(p.displayHeight || "")}</td><td>${esc(p.displayWeight || "")}</td>
        <td>${esc(lg === "nfl" ? p.age ?? "" : p.experience?.abbreviation || "")}</td>
        <td>${injTag(p.injuries?.[0], p.id, T.id)}</td></tr>`;
      }).join("");
      return `<h4>${esc({ offense: "Offense", defense: "Defense", specialTeam: "Special teams", injuredReserveOrOut: "Injured reserve / out", suspended: "Suspended", practiceSquad: "Practice squad" }[g.position] || g.position)}</h4>
      <div class="table-wrap"><table class="box roster"><thead><tr>${rth("num", " num")}${rth("name")}${rth("pos")}${rth("ht")}${rth("wt")}${rth("age")}${rth("status")}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("") + (rosterRowsNote());
    function rosterRowsNote() {
      return `<p class="note">${rsort ? `Sorted by ${esc(RS[rsort][0])}. <a href="${link("team", id, { tab: "roster" })}">Back to position order</a>.` : `In position order${nfl ? ", starters first (depth chart order); S = starter" : ""}. Tap a column to sort by it.`}</p>`;
    }
    // Injuries tab (NFL): this team's "% healthy" and its full report, same math as Stats > Injuries
    const injTeam = tab === "injuries" && Array.isArray(extra) ? extra.find((t) => String(t.id) === String(T.id)) : null;
    const injRank = injTeam ? extra.indexOf(injTeam) + 1 : 0;
    const injAvg = injTeam ? extra.reduce((a, t) => a + t.health, 0) / extra.length : 0;
    const cfbRep = !nfl && tab === "injuries" ? cfbInjFor(extra, ourTeam(ranks, lg, T)?.team) : null;
    const injHtml = !nfl ? (cfbRep ? `<h3>Week ${cfbRep.wk} availability report <span class="muted">vs ${esc(cfbRep.opp)}</span></h3>${cfbInjList(cfbRep)}<p class="note">${CFB_INJ_NOTE}</p>`
        : `<p class="muted">No availability report for this team yet. <a href="${link("stats", null, { show: "injuries" })}">All college availability reports →</a></p><p class="note">${CFB_INJ_NOTE}</p>`)
      : !injTeam ? "" : `<div class="inj-head"><div><span class="inj-big" style="color:${injTeam.health >= 92 ? "var(--inj-good)" : injTeam.health >= 82 ? "var(--inj-mid)" : "var(--inj-bad)"}">Operating at ${Math.round(injTeam.health)}%</span>
        <small class="muted">${injRank === 1 ? "The most banged-up team in the NFL" : `#${injRank} most banged-up of ${extra.length}`} · ${injTeam.keyOut} key player${injTeam.keyOut === 1 ? "" : "s"}, ${injTeam.hurt.length} total on the report · league average ${Math.round(injAvg)}%</small></div></div>
      ${injList(injTeam)}
      <p class="note">Starters, the next man up and regular starters count fully; a QB about 10x a punter. Out or IR counts fully, Doubtful 3/4, Questionable 1/4. <a href="${link("stats", null, { show: "injuries", team: injTeam.team.abbreviation })}">Compare every team →</a></p>`;

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
      <div class="subtabs">${tabLink("schedule", "Schedule")}${tabLink("glance", "At a glance")}${tabLink("roster", "Roster")}${nfl ? tabLink("depth", "Depth chart") + tabLink("injuries", "Injuries") + tabLink("moves", "Transactions") : tabLink("injuries", "Injuries")}${takes.length || starters.length ? tabLink("takes", `Takes <small>${takes.length + starters.length}</small>`) : ""}</div>
      <div class="card">${tab === "glance" ? `<div id="tm-glance"><p class="muted">Loading…</p></div>` : tab === "takes" ? Takes.startersHtml(starters) + (takes.length ? `${starters.length ? `<h3 class="tk-posts-h">From our X account</h3>` : ""}${Takes.list(takes)}` : starters.length ? "" : `<p class="muted">No takes about this team yet. <a href="${link("takes")}">See all our Takes →</a></p>`)
        : tab === "roster"
        ? rosterRows || `<p class="muted">Roster not available.</p>`
        : tab === "injuries" ? injHtml || `<p class="muted">Injury report not available.</p>`
        : tab === "depth" ? depthRows || `<p class="muted">Depth chart not available.</p>`
        : tab === "moves" ? (movesRows ? `<div class="table-wrap"><table class="box moves"><tbody>${movesRows}</tbody></table></div>
            <p class="note">Signings, releases and injured-reserve moves since ${esc(new Date(extra.transactions[extra.transactions.length - 1].date).toLocaleDateString(undefined, { month: "long", day: "numeric" }))}.</p>`
            : `<p class="muted">No recent transactions. <a href="${link("trades")}">See who might be on the move →</a></p>`)
        : games ? `<div class="mb-list cols">${games}</div>${ourGames.size ? `<p class="note">Tap a game for the box score or preview. Diff (difficulty) is the chance a typical ${nfl ? "top-8 NFL" : "top-25"} team would lose that game; win chances are from the Cupcake Index model.</p>` : ""}`
        : `<p class="muted">No games scheduled. <a href="${link("scores")}">See all scores →</a></p>`}</div>`;
    // the head coach, top right (coaches.js): photo, name and hot seat, linking to his page
    Coaches.forTeam(lg, T.id).then((h) => { const el = my === token && $("#th-coach"); if (el && h) el.outerHTML = h; }).catch(() => {});
    // At a glance: charts from the Visualize data (viz.js)
    if (tab === "glance") Viz.glance(lg, T.id, $("#tm-glance")).catch(() => { const el = my === token && $("#tm-glance"); if (el) el.innerHTML = `<p class="muted">Couldn't load the charts. Try again in a minute.</p>`; });
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
  // ---------------------------------------------------------------- NFL trade watch
  // Who's most likely to be traded before the deadline, and where he'd fit (src/trade_watch.py, refreshed daily), under a
  // countdown to the next big date on the NFL calendar. The dates are from the NFL's 2026-27 calendar: add next year's
  // when the league announces them. A date with no announced time counts down to midnight Eastern (shown in days).
  const NFL_DATES = [
    ["2026-11-10T21:00:00Z", "Trade deadline", "4 p.m. ET, Tue Nov 10. After this, teams can't trade until March."],
    ["2026-11-17T21:00:00Z", "Last day to sign tagged players", "Franchise-tagged and restricted free agents still unsigned sit out the season."],
    ["2027-01-16T05:00:00Z", "Playoffs begin", "Wild Card Weekend, Jan 16-18.", 1],
    ["2027-02-14T05:00:00Z", "Super Bowl LXI", "SoFi Stadium, Inglewood, Calif.", 1],
    ["2027-03-03T21:00:00Z", "Franchise tag deadline", "4 p.m. ET, Mar 3: last day to tag a player."],
    ["2027-03-09T17:00:00Z", "Free agent talks open", "Noon ET, Mar 9: teams can start negotiating with other teams' free agents."],
    ["2027-03-11T21:00:00Z", "Free agency + trades open", "4 p.m. ET, Mar 11: the 2027 league year starts; signings and trades become official."],
    ["2027-04-29T05:00:00Z", "NFL Draft", "Apr 29-May 1, Washington, D.C.", 1],
  ];
  function countdownHtml() {
    const now = Date.now(), next = NFL_DATES.find(([t]) => Date.parse(t) > now);
    if (!next) return "";
    const [t, what, sub, dayOnly] = next, s = Math.max(0, Math.floor((Date.parse(t) - now) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const box = (n, l) => `<span class="cd-box"><b>${String(n).padStart(2, "0")}</b><small>${l}</small></span>`;
    return `<div class="cd-what">Countdown to <b>${esc(what)}</b></div>
      <div class="cd-time">${box(d, d === 1 ? "day" : "days")}${dayOnly ? "" : box(h, "hrs") + box(m, "min") + box(sec, "sec")}</div>
      <div class="cd-sub muted">${esc(sub)}</div>`;
  }
  // News > Trade watch and Free agents (college: Portal watch)
  const trSub = (on) => ""; // Trade watch / Free agents are pills in the group bar (app.js GROUPS)
  let twPos = "", twTeam = "";
  // One player's "why he might be traded" page (#/trades/ID): the chance, each reason in plain words, the headlines, the
  // teams he fits. His name goes on to his stats page.
  function tradeWhy(D, pid, { abOf, tlogo, money }) {
    const p = D.players.find((x) => String(x.id) === String(pid));
    const back = `<a class="tw-back" href="${link("trades")}">← Trade watch</a>`;
    if (!p) { view("trades").innerHTML = trSub("trades") + `<div class="card">${back}<p>He isn't on our trade list right now (it changes every few hours as the news moves). <a href="${link("player", pid)}">See his stats →</a></p></div>`; return; }
    const ab = abOf(p.team), T = D.teams[ab] || {}, short = (T.name || ab).split(" ").pop(), P = p.parts || {};
    const pct = Math.round(100 * (T.p || 0)), age = p.age ? Math.floor(p.age) : null;
    // each reason: [label, 0-1 (1 = pushes toward a trade), what it means for him]
    const reasons = [
      ["Trade talk", Math.min(1, (P.talk || 0) / 1.6), p.talk ? `${p.talk} trade headline${p.talk > 1 ? "s" : ""} named him in the last 2 weeks. People are discussing it, which is the best public sign a deal is being worked on.` : "No trade headlines about him in the last 2 weeks."],
      ["Is his team selling?", P.seller ?? 0, pct < 45 ? `The ${short} are ${T.record} with a ${pct}% playoff chance in our simulations. Teams out of the race trade veterans for picks.` : `The ${short} are ${T.record} with a ${pct}% playoff chance. Contenders rarely sell, so only the trade talk has him here.`],
      ["Contract", P.contract ?? 0.5, p.through === D.season ? `His deal ends after this season (${money(p.salary)} this year). Teams move players rather than lose them for nothing.` : p.through ? `Signed through ${p.through} (${money(p.salary)} this year). Longer deals get moved less often.` : "We couldn't find his contract."],
      ["Age", P.age ?? 0.5, age == null ? "We don't have his birth date." : age >= 30 ? `${age}: a veteran, the kind rebuilding teams move.` : age >= 28 ? `${age}: near the age rebuilding teams start moving players.` : `${age}: rebuilding teams usually keep players this young.`],
      ["Role", P.role ?? 0, `Plays ${Math.round(100 * p.share)}% of his side's snaps, so a contender would get a real contributor.`],
      ["Worth to a contender", P.worth ?? 0.6, p.salary >= 10e6 ? "Paid like a starter, a sign teams value him." : "A modest salary: cheap to add, but less of a difference-maker."],
      ["Position", P.position ?? 1, p.pos === "QB" ? "QBs rarely move mid-season (a new team has to learn him fast)." : p.pos === "RB" ? "Running backs move mid-season less than most positions." : `${p.pos}s get moved mid-season as often as anyone.`],
    ];
    const meter = (v) => `<span class="tw-meter"><i style="width:${Math.round(100 * Math.max(0, Math.min(1, v)))}%"></i></span>`;
    const tier = `<span class="tw-tier tw-${p.tier === "Likely" ? "hi" : p.tier === "Possible" ? "md" : "lo"}">${esc(p.tier)}</span>`;
    const rank = D.players.indexOf(p) + 1;
    view("trades").innerHTML = trSub("trades") + `<div class="card tw-why">
        ${back}
        <div class="tw-hero">
          <a href="${link("player", p.id)}" title="His stats">${face(`https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`, p.name, "bigface")}</a>
          <div>
            <div class="tw-why-h">
              <h2><a href="${link("player", p.id)}" title="His stats">${esc(p.name)}</a></h2>
              <span class="muted" id="tw-jersey">${esc(p.pos)}${age ? ` · ${age}` : ""}</span>
            </div>
            <span class="tm">${tlogo(ab)} ${esc(T.name || ab)}</span>
            <div class="tw-bio muted" id="tw-bio"></div>
          </div>
        </div>
        <p class="tw-why-sum">${tier} <b>#${rank}</b> on our trade list. <a href="${link("player", p.id)}">See his stats →</a></p>
        <div class="tw-stats" id="tw-stats"></div>
        <h3 class="tw-h3">Why he might be traded</h3>
        <div class="tw-reasons">${reasons.map(([l, v, t]) => `<div class="tw-reason"><div class="tw-reason-h"><b>${l}</b>${meter(v)}</div><p>${esc(t)}</p></div>`).join("")}</div>
        <p class="note">Longer bar = pushes harder toward a trade. Trade talk counts on its own; the other six multiply together, so one long contract or a young age pulls the whole thing down.</p>
        ${p.fits.length ? `<h3 class="tw-h3">Where he'd fit</h3><ol class="tw-fitlist">${p.fits.map(([f, why], k) =>
          `<li><span class="tm">${tlogo(f)} <b>${esc(D.teams[f]?.name || f)}</b></span>${k ? "" : ` <span class="tw-front">Frontrunner</span>`}<small class="muted">${esc(why)}</small></li>`).join("")}</ol>` : ""}
        ${p.stories?.length ? `<h3 class="tw-h3">The headlines</h3><ul class="tw-heads">${p.stories.filter((h) => safeUrl(h[1])).map(([t, u]) =>
          `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("")}</ul>${p.talk > p.stories.length ? `<p class="muted tw-more">…and ${p.talk - p.stories.length} more.</p>` : ""}` : ""}
      </div>`;
    // his bio and this season's line from ESPN (the same record his stats page uses), filled in when it arrives
    const my = token;
    api(`${WEB("nfl")}/athletes/${encodeURIComponent(p.id)}`, 600000).then((r) => {
      const a = r?.athlete;
      if (!a || my !== token || !$("#tw-bio")) return;
      if (a.jersey) $("#tw-jersey").textContent = `#${a.jersey} · ${p.pos}${age ? ` · ${age}` : ""}`;
      $("#tw-bio").textContent = [[a.displayHeight, a.displayWeight].filter(Boolean).join(", "), a.displayExperience,
        a.displayDraft ? `Drafted ${a.displayDraft}` : "", a.college?.name].filter(Boolean).join(" · ");
      const st = a.statsSummary?.statistics || [];
      if (st.length) $("#tw-stats").innerHTML = `<h3 class="tw-h3">${esc(a.statsSummary.displayName || "This season")}</h3><div class="tw-tiles">${st.map((x) =>
        `<div class="tw-tile"><b>${esc(x.displayValue)}</b><span>${esc(x.shortDisplayName || x.displayName)}</span>${x.rankDisplayValue ? `<small>${esc(x.rankDisplayValue)} in NFL</small>` : ""}</div>`).join("")}</div>`;
    }).catch(() => {});
  }

  async function trades(pid) {
    const my = token;
    if (league !== "nfl") return portal(pid);
    view("trades").innerHTML = trSub("trades") + `<div class="card muted">Loading…</div>`;
    let D;
    try { D = await getJSON("data/nfl/trade_watch.json"); } catch (e) { return fail("trades", e); }
    if (my !== token) return;
    // teams in the file are keyed by abbreviation; players carry the chart key ("nfl:28")
    const byId = Object.fromEntries(Object.entries(D.teams).map(([ab, t]) => [`nfl:${t.id}`, ab]));
    const abOf = (k) => byId[k] || k;
    const tlogo = (ab) => { const t = D.teams[ab]; return t ? img(`https://a.espncdn.com/i/teamlogos/nfl/500/${t.id}.png`, "xs") : ""; };
    const money = (v) => (v ? `$${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M` : "–");
    const gone = Date.now() > Date.parse(`${D.deadline}T21:00:00Z`);
    const POS = ["QB", "RB", "WR", "TE", "OL", "EDGE", "IDL", "LB", "CB", "S"];
    if (!D.teams[twTeam]) twTeam = "";
    if (pid != null) return tradeWhy(D, pid, { abOf, tlogo, money });
    const teamsByName = Object.entries(D.teams).sort((a, b) => a[1].name.localeCompare(b[1].name));
    view("trades").innerHTML = trSub("trades") + `<div class="card tw-cd" id="tw-cd">${countdownHtml()}</div>
      <div class="card">
        <div class="sc-bar"><h2>Trade watch</h2>
          <select id="tw-team" aria-label="Team"><option value="">All teams</option>${teamsByName.map(([ab, t]) => `<option value="${ab}"${ab === twTeam ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
          <select id="tw-pos" aria-label="Position"><option value="">All positions</option>${POS.map((p) => `<option value="${p}"${p === twPos ? " selected" : ""}>${p}</option>`).join("")}</select></div>
        ${gone ? `<p class="note">The ${D.season} deadline has passed. This was our list going in.</p>` : ""}
        <div id="tw-body"></div>
        <p class="note">Our guess at who gets moved, refreshed daily (last ${esc(D.updated.slice(0, 10))}). <b>Trade headlines</b> is how many news headlines from the last 2 weeks named him next to a trade word ("trade", "deadline", "rumors", "landing spots"...), from Google News searches for NFL trade news and for each team; the line under his name is one of them. Headlines count a lot, since they're the best public sign a deal is being discussed, but each extra one adds a little less. Players who were already traded drop off. <b>Sellers</b> are teams with a low playoff chance in ${D.sims.toLocaleString("en-US")} simulations of the rest of the season from our power ratings. A player also ranks higher when his contract ends soon (salary and years from ESPN), he's a veteran (rebuilding teams keep young players), he plays a big role, and he's worth something to a contender. QBs and running backs rarely move mid-season, so they count less. <b>Best fits</b> and a team's targets come from where its units rank in our play-by-play numbers, plus headlines that name the player with that team ("Packers urged to go after DeForest Buckner"). His first fit (★) is his <b>frontrunner</b>; pick that team and he gets a Frontrunner tag. We can't see teams' cap space, so a fit isn't a sure thing. Chance is a ranking (Likely, Possible, Long shot), not a percentage.</p></div>`;
    const head = (extra) => `<thead><tr><th>#</th><th>Player</th><th>Team</th><th>Contract</th><th title="Trade headlines naming him in the last 2 weeks">Trade headlines</th><th>Chance</th><th>${extra}</th></tr></thead>`;
    // his frontrunner = his best fit: a contender with a weak spot at his position, boosted by headlines linking the two
    const front = (p) => p.fits[0]?.[0];
    const row = (p, i, last) => `<tr>
        <td class="num">${i + 1}</td>
        <td><a href="${link("trades", p.id)}" title="Why he might be traded"><b>${esc(p.name)}</b></a> <span class="muted">${esc(p.pos)}${p.age ? ` · ${Math.floor(p.age)}` : ""}</span>${twTeam && front(p) === twTeam ? ` <span class="tw-front" title="${esc(D.teams[twTeam].name)} are his best fit: ${esc(p.fits[0][1])}">Frontrunner</span>` : ""}
          ${p.story && safeUrl(p.story[1]) ? `<a class="tw-story" href="${esc(p.story[1])}" target="_blank" rel="noopener">${esc(p.story[0])}</a>` : ""}</td>
        <td><span class="tm">${tlogo(abOf(p.team))} ${esc(abOf(p.team))}</span> <small class="muted">${esc(D.teams[abOf(p.team)]?.record || "")} · ${Math.round(100 * (D.teams[abOf(p.team)]?.p || 0))}% playoffs</small></td>
        <td>${p.through ? (p.through === D.season ? `<b class="tw-exp">ends ${p.through}</b>` : `thru ${p.through}`) : "–"} <small class="muted">${money(p.salary)}</small></td>
        <td class="num">${p.talk ? `<b class="tw-talk">${p.talk}</b>` : `<span class="muted">0</span>`}</td>
        <td><span class="tw-tier tw-${p.tier === "Likely" ? "hi" : p.tier === "Possible" ? "md" : "lo"}">${esc(p.tier)}</span></td>
        <td class="tw-fits">${last}</td></tr>`;
    const fitsOf = (p) => p.fits.map(([ab, why], k) => `<span class="tm${k ? "" : " tw-fit1"}" title="${k ? "" : "Frontrunner: "}${esc(why)}">${tlogo(ab)} ${esc(ab)}${k ? "" : `<sup class="tw-front-s">★</sup>`}</span>`).join(" ");
    const posOk = (p) => !twPos || p.pos === twPos;
    const none = (n, txt) => `<tr><td colspan="${n}" class="muted">${txt}</td></tr>`;
    const draw = () => {
      const el = $("#tw-body");
      if (!twTeam) {
        const rows = D.players.filter(posOk);
        el.innerHTML = `<div class="table-wrap"><table class="box tw-table">${head("Best fits")}<tbody>${rows.map((p, i) => row(p, i, fitsOf(p))).join("") || none(7, "No one at this position on our list.")}</tbody></table></div>`;
        return;
      }
      const T = D.teams[twTeam], short = T.name.split(" ").pop();
      const seen = new Set(), needs = T.needs.filter(([u]) => !seen.has(u) && seen.add(u)); // QB and WR share "passing offense"
      const buyer = T.p >= 0.35;
      const targets = T.targets.map(([i, why]) => [D.players[i], why]).filter(([p]) => p && posOk(p));
      const mine = D.players.filter((p) => abOf(p.team) === twTeam && posOk(p));
      el.innerHTML = `<div class="tw-team">
          <div class="tw-team-h"><span class="tm">${tlogo(twTeam)} <b>${esc(T.name)}</b></span> <span class="muted">${esc(T.record)} · ${Math.round(100 * T.p)}% playoff chance</span>
            <span class="tw-role ${buyer ? "tw-hi" : "tw-lo"}">${T.p >= 0.6 ? "Buyer" : buyer ? "On the fence" : "Seller"}</span></div>
          <p class="tw-needs">Weakest spots: ${needs.slice(0, 3).map(([u, r]) => `<b>${esc(u)}</b> <span class="muted">#${r} of 32</span>`).join(" · ")}</p>
          ${buyer ? "" : `<p class="note">With a ${Math.round(100 * T.p)}% playoff chance the ${esc(short)} are more likely to sell than buy. Here's who they'd go after if they do buy, and who they might trade away.</p>`}
        </div>
        <h3 class="tw-h3">Who the ${esc(short)} would most likely go after</h3>
        <div class="table-wrap"><table class="box tw-table">${head("Why them")}<tbody>${targets.map(([p, why], i) => row(p, i, `<small>${esc(why)}</small>`)).join("") || none(7, "No one at this position on their list.")}</tbody></table></div>
        <h3 class="tw-h3">Who the ${esc(short)} might trade away</h3>
        <div class="table-wrap"><table class="box tw-table">${head("Best fits")}<tbody>${mine.map((p, i) => row(p, i, fitsOf(p))).join("") || none(7, "No one from this team on our list.")}</tbody></table></div>`;
    };
    draw();
    $("#tw-pos").addEventListener("change", (e) => { twPos = e.target.value; draw(); });
    $("#tw-team").addEventListener("change", (e) => { twTeam = e.target.value; draw(); });
    const tick = setInterval(() => {
      const el = $("#tw-cd");
      if (my !== token || !el) return clearInterval(tick);
      el.innerHTML = countdownHtml();
    }, 1000);
  }
  // ---------------------------------------------------------------- college portal watch
  // The college Trade watch: who's most likely to enter the transfer portal, and the schools he'd fit
  // (src/portal_watch.py, refreshed daily), under a countdown to the January window.
  let pwPos = "", pwTeam = "";
  const PW_KIND = { up: "Moving up", snaps: "Wants snaps", starter: "Starter" };
  const pwTier = (t) => `<span class="tw-tier tw-${t === "Announced" || t === "Likely" ? "hi" : t === "Possible" ? "md" : "lo"}">${esc(t)}</span>`;
  function pwCountdown(D) {
    const t = `${D.window}T05:00:00Z`, s = Math.max(0, Math.floor((Date.parse(t) - Date.now()) / 1000));
    if (!s) return `<div class="cd-what">The transfer portal window is <b>open</b></div>`;
    const d = Math.floor(s / 86400), box = (n, l) => `<span class="cd-box"><b>${String(n).padStart(2, "0")}</b><small>${l}</small></span>`;
    return `<div class="cd-what">Countdown to <b>the transfer portal window</b></div><div class="cd-time">${box(d, d === 1 ? "day" : "days")}</div>
      <div class="cd-sub muted">Expected to open Jan 2 (the NCAA hasn't posted the 2027 dates). When a head coach leaves, his players get their own window.</div>`;
  }
  function portalWhy(D, pid, tlogo) {
    const p = D.players.find((x) => String(x.id) === String(pid));
    const back = `<a class="tw-back" href="${link("trades")}">← Portal watch</a>`;
    if (!p) { view("trades").innerHTML = `<div class="card">${back}<p>He isn't on our portal list right now (it changes every day as the news moves). <a href="${link("player", pid)}">See his stats →</a></p></div>`; return; }
    const T = D.teams[p.team] || {}, P = p.parts || {}, pct = (x) => Math.round(100 * x);
    const role = p.kind === "up" ? `One of the most productive ${p.group}s in FBS (top ${Math.max(1, 100 - pct(p.pct))}%) at a Group of 5 school. Bigger programs go to the portal for exactly this.`
      : p.kind === "snaps" ? `A backup: ${pct(p.share)}% of his team's ${p.group === "QB" ? "pass attempts" : p.group === "RB" ? "carries" : "targets"}, but efficient when he plays. Backups move to start somewhere.`
      : `A ${p.share >= 0.35 || p.pct >= 0.5 ? "regular" : "part-time"} player. Starters leave less often, mostly after a coaching change.`;
    const reasons = [
      ["Portal talk", p.said ? 1 : P.talk || 0, p.said ? "Headlines say he's leaving (redshirting to transfer or entering the portal)." : p.talk ? `${p.talk} headline${p.talk > 1 ? "s" : ""} named him next to a portal word in the last 3 weeks.` : "No portal headlines about him in the last 3 weeks."],
      ["Role", P.role ?? 0, role],
      ["His coach", Math.min(1, (P.coach || 0) / 0.6), T.coach ? `Our Hot seat model gives ${T.coach} a ${pct(P.coach || 0)}% chance of being out after this season. A new coach usually means a wave of transfers.` : "We don't have a hot-seat number for his coach."],
      ["Team's season", 1 - (P.bowl ?? 0.5), `${T.name} are ${T.record} with a ${pct(P.bowl ?? 0)}% chance of 6 wins (bowl eligible) in our simulations. A lost season makes leaving easier.`],
      ["Class", P.cls ?? 0.6, { FR: "A freshman: young players transfer a lot, but many wait a year.", SO: "A sophomore: the class that transfers most.", JR: "A junior: still has time to start somewhere else.", SR: "A senior: most are out of eligibility, so few transfer.", GR: "A grad student: almost always out of eligibility." }[p.cls] || "We don't have his class."],
      ["Position", Math.min(1, (P.position ?? 0.9) / 1.25), p.group === "QB" ? "Quarterbacks transfer more than anyone (only one plays)." : `${p.group}s transfer about as often as most positions.`],
    ];
    const meter = (v) => `<span class="tw-meter"><i style="width:${Math.round(100 * Math.max(0, Math.min(1, v)))}%"></i></span>`;
    view("trades").innerHTML = `<div class="card tw-why">
        ${back}
        <div class="tw-hero">
          <a href="${link("player", p.id)}" title="His stats">${face(`https://a.espncdn.com/i/headshots/college-football/players/full/${p.id}.png`, p.name, "bigface")}</a>
          <div>
            <div class="tw-why-h"><h2><a href="${link("player", p.id)}" title="His stats">${esc(p.name)}</a></h2>
              <span class="muted">${esc(p.pos)}${p.cls ? ` · ${esc(p.cls)}` : ""}</span></div>
            <span class="tm">${tlogo(p.team)} ${esc(T.name || "")}</span> <span class="muted">${esc(T.conf || "")}</span>
          </div>
        </div>
        <p class="tw-why-sum">${pwTier(p.tier)} <b>#${D.players.indexOf(p) + 1}</b> on our portal list · ${esc(PW_KIND[p.kind])}. <a href="${link("player", p.id)}">See his stats →</a></p>
        <h3 class="tw-h3">Why he might transfer</h3>
        <div class="tw-reasons">${reasons.map(([l, v, t]) => `<div class="tw-reason"><div class="tw-reason-h"><b>${l}</b>${meter(v)}</div><p>${esc(t)}</p></div>`).join("")}</div>
        <p class="note">Longer bar = pushes harder toward the portal. Portal talk counts on its own; the other five multiply together, so a senior with no eligibility left or a happy starter pulls the whole thing down.</p>
        ${p.fits.length ? `<h3 class="tw-h3">Where he'd fit</h3><ol class="tw-fitlist">${p.fits.map(([f, why], k) =>
          `<li><span class="tm">${tlogo(f)} <b>${esc(D.teams[f]?.name || f)}</b></span>${k ? "" : ` <span class="tw-front">Frontrunner</span>`}<small class="muted">${esc(why)}</small></li>`).join("")}</ol>` : ""}
        ${p.stories?.length ? `<h3 class="tw-h3">The headlines</h3><ul class="tw-heads">${p.stories.filter((h) => safeUrl(h[1])).map(([t, u]) =>
          `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("")}</ul>` : ""}
      </div>`;
  }
  async function portal(pid) {
    const my = token;
    view("trades").innerHTML = `<div class="card muted">Loading…</div>`;
    let D;
    try { D = await getJSON("data/cfb/portal_watch.json"); } catch (e) { return fail("trades", e); }
    if (my !== token) return;
    const tlogo = (id) => img(`https://a.espncdn.com/i/teamlogos/ncaa/500/${id}.png`, "xs");
    if (pid != null) return portalWhy(D, pid, tlogo);
    if (!D.teams[pwTeam]) pwTeam = "";
    const GROUPS = ["QB", "RB", "WR", "TE", "OL", "DL", "LB", "DB"];
    const teamsByName = Object.entries(D.teams).sort((a, b) => a[1].name.localeCompare(b[1].name));
    view("trades").innerHTML = `<div class="card tw-cd" id="pw-cd">${pwCountdown(D)}</div>
      <div class="card">
        <div class="sc-bar"><h2>Portal watch</h2>
          <select id="pw-team" aria-label="Team"><option value="">All teams</option>${teamsByName.map(([id, t]) => `<option value="${id}"${id === pwTeam ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
          <select id="pw-pos" aria-label="Position"><option value="">All positions</option>${GROUPS.map((g) => `<option value="${g}"${g === pwPos ? " selected" : ""}>${g}</option>`).join("")}</select></div>
        <div id="pw-body"></div>
        <p class="note">Our guess at who enters the transfer portal, refreshed daily (last ${esc(D.updated.slice(0, 10))}). <b>Announced</b> means headlines say he's leaving (many players now redshirt mid-season and transfer). <b>Portal headlines</b> counts news headlines from the last 3 weeks that name him next to a portal word, from Google News searches for each school. The rest comes from our numbers: <b>Moving up</b> is a standout at a Group of 5 school (top quarter of FBS at his position), the players bigger programs pull from the portal; <b>Wants snaps</b> is an efficient backup (under 35% of his team's attempts, carries or targets); his coach's chance of being out (our Hot seat model, since a new coach sets off transfers); and his team's chance of a bowl in ${D.sims.toLocaleString("en-US")} simulations. Seniors and grad students rank low because most are out of eligibility, and QBs rank higher because they transfer most. <b>Best fits</b> are teams whose unit at his position ranks low among the ${D.n} FBS teams we rate (Power 4 only for a mover-up), plus headlines that name him with a school. Our stats can't tell a backup lineman or defender from a starter, so those mostly show up through headlines or a coaching change. Chance is a ranking, not a percentage.</p></div>`;
    const head = (extra) => `<thead><tr><th>#</th><th>Player</th><th>Team</th><th>Role</th><th title="Portal headlines naming him in the last 3 weeks">Portal headlines</th><th>Chance</th><th>${extra}</th></tr></thead>`;
    const row = (p, i, last) => `<tr>
        <td class="num">${i + 1}</td>
        <td><a href="${link("trades", p.id)}" title="Why he might transfer"><b>${esc(p.name)}</b></a> <span class="muted">${esc(p.pos)}${p.cls ? ` · ${esc(p.cls)}` : ""}</span>${pwTeam && p.fits[0]?.[0] === pwTeam ? ` <span class="tw-front">Frontrunner</span>` : ""}
          ${p.story && safeUrl(p.story[1]) ? `<a class="tw-story" href="${esc(p.story[1])}" target="_blank" rel="noopener">${esc(p.story[0])}</a>` : ""}</td>
        <td><span class="tm">${tlogo(p.team)} ${esc(D.teams[p.team]?.name || "")}</span> <small class="muted">${esc(D.teams[p.team]?.record || "")} · ${Math.round(100 * (D.teams[p.team]?.bowl || 0))}% bowl</small></td>
        <td>${esc(PW_KIND[p.kind])}</td>
        <td class="num">${p.talk ? `<b class="tw-talk">${p.talk}</b>` : `<span class="muted">0</span>`}</td>
        <td>${pwTier(p.tier)}</td>
        <td class="tw-fits">${last}</td></tr>`;
    const fitsOf = (p) => p.fits.map(([id, why], k) => `<span class="tm${k ? "" : " tw-fit1"}" title="${k ? "" : "Frontrunner: "}${esc(why)}">${tlogo(id)} ${esc(D.teams[id]?.name || "")}${k ? "" : `<sup class="tw-front-s">★</sup>`}</span>`).join(" ");
    const posOk = (p) => !pwPos || p.group === pwPos;
    const none = (txt) => `<tr><td colspan="7" class="muted">${txt}</td></tr>`;
    const draw = () => {
      const el = $("#pw-body");
      if (!pwTeam) {
        el.innerHTML = `<div class="table-wrap"><table class="box tw-table">${head("Best fits")}<tbody>${D.players.filter(posOk).map((p, i) => row(p, i, fitsOf(p))).join("") || none("No one at this position on our list.")}</tbody></table></div>`;
        return;
      }
      const T = D.teams[pwTeam];
      const targets = T.targets.map(([i, why]) => [D.players[i], why]).filter(([p]) => p && posOk(p));
      const mine = D.players.filter((p) => p.team === pwTeam && posOk(p));
      el.innerHTML = `<div class="tw-team">
          <div class="tw-team-h"><span class="tm">${tlogo(pwTeam)} <b>${esc(T.name)}</b></span> <span class="muted">${esc(T.record)} · ${Math.round(100 * T.bowl)}% bowl chance${T.coach ? ` · ${esc(T.coach)} ${Math.round(100 * T.seat)}% likely out` : ""}</span></div>
          <p class="tw-needs">Weakest spots: ${T.needs.slice(0, 3).map(([u, r]) => `<b>${esc(u)}</b> <span class="muted">#${r} of ${D.n}</span>`).join(" · ")}</p>
        </div>
        <h3 class="tw-h3">Who ${esc(T.name)} would most likely go after</h3>
        <div class="table-wrap"><table class="box tw-table">${head("Why them")}<tbody>${targets.map(([p, why], i) => row(p, i, `<small>${esc(why)}</small>`)).join("") || none("No one at this position on their list.")}</tbody></table></div>
        <h3 class="tw-h3">Who might leave ${esc(T.name)}</h3>
        <div class="table-wrap"><table class="box tw-table">${head("Best fits")}<tbody>${mine.map((p, i) => row(p, i, fitsOf(p))).join("") || none("No one from this team on our list.")}</tbody></table></div>`;
    };
    draw();
    $("#pw-pos").addEventListener("change", (e) => { pwPos = e.target.value; draw(); });
    $("#pw-team").addEventListener("change", (e) => { pwTeam = e.target.value; draw(); });
  }
  return { stop, teamId, scores, game, stats, player, standings, team, freeagents, trades, searchPlayers, fillBugs, kit, statsSubtabs: (on) => stSubStats(on) };
})();
