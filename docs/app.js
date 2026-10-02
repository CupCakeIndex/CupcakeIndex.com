// The Cupcake Index: router, league toggle, rankings views.
// Live ESPN views (scores, stats, standings, game, player, team) live in live.js.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let INDEX, LG, DATA, PREV, weights, ranked = [];
let league = "cfb";
let loadedKey = null;
let beforeSolo = null; // weights to restore after cycling through a column header
let soloDir = "hi";    // "hi" = selected column high to low, "lo" = low to high
let reverse = false;   // true = list shown bottom-up by blended score
let colSort = null;    // {key: "record" | "ap", dir: "best" | "worst"}: overrides row order, keeps model ranks

const BASE_PRESETS = {
  "Hot right now": { power: 15, resume: 10, efficiency: 15, sos: 5, recent: 55 },
  "Equal": { power: 15, resume: 15, efficiency: 15, sos: 15, recent: 15, cupcake: 15, luck: 10 },
};
const SHORT = { power: "PWR", resume: "RES", efficiency: "EFF", sos: "SOS", recent: "FORM", cupcake: "CUP", luck: "UNLK" };
const LEAGUE_NAME = { cfb: "CFB", nfl: "NFL" };
const RANK_VIEWS = new Set(["rankings", "schedules"]);
const VIEWS = new Set(["rankings", "picks", "schedules", "compare", "about", "updates", "scores", "stats", "standings", "game", "player", "team", "freeagents", "daily", "fantasy", "news", "games", "settings", "privacy"]);
// Sub-pages that light up a parent tab in the nav (the Daily player game lives under Games)
const NAV_PARENT = { daily: "games" };

// ------------------------------------------------------------------ forgiving name search
// Lowercase, strip accents/punctuation ("D.J." -> "dj", "Smith-Njigba" -> "smith njigba"), drop jr/sr/ii/iii.
const normName = (x) => String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[.'’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, " ").trim();
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Score how well a query matches a name (lower = better); null = no match.
// Every query word must match a word in the name: exact/prefix is free, typos allowed by word length.
function fuzzyScore(query, name) {
  const qw = normName(query).split(" ").filter(Boolean), nw = normName(name).split(" ").filter(Boolean);
  if (!qw.length || !nw.length) return null;
  let score = 0;
  for (const q of qw) {
    const tol = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
    let best = Infinity;
    for (const w of nw) {
      if (w === q) { best = 0; break; }
      if (w.startsWith(q)) { best = Math.min(best, 0.1); continue; }
      const d = Math.min(editDistance(q, w, tol), q.length < w.length ? editDistance(q, w.slice(0, q.length), tol) + 0.2 : Infinity);
      if (d <= tol) best = Math.min(best, d);
    }
    if (best === Infinity) return null;
    score += best;
  }
  return score + (nw[0].startsWith(qw[0]) ? 0 : 0.05);
}

// Initials search: "OSU" -> Ohio State, Oklahoma State, Oregon State ("U" for University is optional); "FSU", "LSU", "MSU"...
function initialsScore(query, name) {
  const q = normName(query).replace(/[^a-z]/g, "");
  if (q.length < 2 || q.length > 5 || /\s/.test(query.trim())) return null;
  const words = normName(name).replace(/[()&.'-]/g, " ").split(" ").filter((w) => w && !["of", "the", "and", "at"].includes(w));
  if (words.length < 2) return null;
  const ini = words.map((w) => w[0]).join("");
  return q === ini || q === ini + "u" || q === "u" + ini ? 0.05 : null;
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}

// ------------------------------------------------------------------ routing
function parseHash() {
  const h = location.hash.slice(1);
  if (!h.startsWith("/")) return { view: "rankings", arg: null, params: new URLSearchParams(h) }; // old #league=..&team=.. links
  const [path, qs] = h.slice(1).split("?");
  const [view, arg] = path.split("/");
  return { view: VIEWS.has(view) ? view : "rankings", arg: arg ? decodeURIComponent(arg) : null, params: new URLSearchParams(qs || "") };
}

function link(view, arg = null, params = {}) {
  const qs = new URLSearchParams({ league, ...params });
  return `#/${view}${arg != null ? "/" + encodeURIComponent(arg) : ""}?${qs}`;
}

let lastPage = null;
function leagueWipe(lg) {
  // CFB <-> NFL: a thin scan line sweeps the content the way the switch moved (NFL right, CFB left)
  // while the other league fades in. The page itself never moves.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const dir = lg === "nfl" ? 1 : -1, main = document.querySelector("main");
  document.querySelectorAll(".lg-scan").forEach((e) => e.remove());
  if (main) {
    const r = main.getBoundingClientRect(), top = Math.max(0, r.top);
    const scan = document.createElement("div"), line = document.createElement("i");
    scan.className = `lg-scan ${dir > 0 ? "ltr" : "rtl"}`;
    scan.style.top = top + "px";
    scan.appendChild(line);
    document.body.appendChild(scan);
    const W = innerWidth;
    line.animate([{ transform: `translateX(${dir > 0 ? -140 : W + 20}px)` }, { transform: `translateX(${dir > 0 ? W + 20 : -140}px)` }],
      { duration: 450, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" });
    setTimeout(() => scan.remove(), 500); // a timer, not onfinish: some browsers finish animations early in background tabs
    main.classList.remove("lg-in"); void main.offsetWidth; main.classList.add("lg-in");
    setTimeout(() => main.classList.remove("lg-in"), 500);
  }
}
async function route() {
  const r = parseHash();
  let lg = r.params.get("league");
  if (!INDEX.leagues[lg]) lg = league;
  if (lg !== league && LG) leagueWipe(lg); // switching CFB <-> NFL: a quick wipe across the screen
  if (lg !== league || !LG) setLeague(lg);
  Live.stop();
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + r.view));
  setNavActive(NAV_PARENT[r.view] || r.view);
  $("#gear").classList.toggle("active", r.view === "settings");
  document.querySelectorAll(".rank-ctl").forEach((el) => el.classList.toggle("hidden", !RANK_VIEWS.has(r.view)));
  $("#drawer").classList.add("hidden");
  document.body.classList.remove("drawer-open");
  // a new page starts at the top; a tab or filter on the same page (Rushing -> Receiving) keeps your place,
  // with the page's height held while it reloads so it can't snap upward
  const page = r.view + "/" + (r.arg || "");
  if (page !== lastPage) window.scrollTo(0, 0);
  else {
    const v = $("#view-" + r.view);
    if (v) { v.style.minHeight = v.offsetHeight + "px"; clearTimeout(v._mh); v._mh = setTimeout(() => (v.style.minHeight = ""), 3000); }
  }
  lastPage = page;
  if (RANK_VIEWS.has(r.view)) {
    await loadWeek();
    const team = r.params.get("team");
    if (r.view === "rankings" && team) openTeam(team);
    if (r.view === "rankings") $("#daily-st").textContent = Daily.status();
    if (r.view === "schedules") renderSchedules();
  } else if (r.view === "updates") {
    renderNotes();
  } else if (r.view === "daily") {
    Daily.render();
  } else if (r.view === "games") {
    renderGames();
  } else if (r.view === "settings") {
    Settings.render();
  } else if (r.view === "picks") {
    Pickem.render(r.params);
  } else if (r.view === "fantasy") {
    Fantasy.render(r.params);
  } else if (r.view === "compare") {
    renderCompare();
  } else if (r.view === "news") {
    News.render(r.params);
  } else if (Live[r.view]) {
    Live[r.view](r.arg, r.params);
  }
}

// ------------------------------------------------------------------ nav
// Highlight the current page. A page inside the More menu lights up the More button and (wider screens) puts its name on it.
// Note: unknown routes (#/fantasy, #/news until those pages exist) fall back to rankings.
const phoneNav = window.matchMedia("(max-width: 640px)");
function setNavActive(view) {
  document.querySelectorAll("#nav [data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  const inMenu = [...document.querySelectorAll("#more-menu .mm-item.active")]
    .find((a) => phoneNav.matches || !a.closest(".nav-narrow"));
  $("#more-btn").classList.toggle("active", !!inMenu);
  $("#more-label").textContent = inMenu && !phoneNav.matches ? inMenu.textContent : "More"; // phones: no room for long names
  setMoreOpen(false);
}
function setMoreOpen(open) {
  $("#more-menu").hidden = !open;
  $("#more-btn").setAttribute("aria-expanded", open);
}
function initNav() {
  $("#more-btn").onclick = () => setMoreOpen($("#more-menu").hidden);
  $("#more-menu").onclick = (e) => { if (e.target.closest("a")) setMoreOpen(false); };
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".nav-more")) setMoreOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMoreOpen(false); });
  phoneNav.addEventListener("change", () => setNavActive(NAV_PARENT[parseHash().view] || parseHash().view));
}

// ------------------------------------------------------------------ games hub
// One card per game. To add a game: give it a view (its own section + route) and add a card here.
function renderGames() {
  const games = [
    { href: "#/daily", name: "daily_player", title: "Daily player", desc: "Guess today's mystery NFL player in 8 tries. Each guess shows how close you are on team, division, position, age, college and number. A new player every day at midnight.", status: Daily.status() },
  ];
  $("#view-games").innerHTML = `<div class="card">
    <h2>Games</h2>
    <p class="note">Quick games for football fans. Your progress and streaks are saved in this browser.</p>
    <div class="games-grid">${games.map((g) => `<a class="game-tile" href="${g.href}">
      <span class="gt-name"><span class="dg-gt">&gt;</span> ${esc(g.name)}</span>
      <b>${esc(g.title)}</b>
      <span class="gt-desc">${esc(g.desc)}</span>
      <span class="gt-st">${esc(g.status)}</span></a>`).join("")}
      <div class="game-tile soon"><span class="gt-name"><span class="dg-gt">&gt;</span> more_games<span class="gs-us">_</span></span><span class="gt-desc">More games are on the way.</span></div>
    </div></div>`;
}

// ------------------------------------------------------------------ init
const SITE_VERSION = "166"; // keep in sync with docs/version.txt and the ?v= in index.html
async function checkVersion() {
  try {
    const r = await fetch("version.txt", { cache: "no-store" });
    const v = (await r.text()).trim();
    if (v && v !== SITE_VERSION && sessionStorage.getItem("reloaded-for") !== v) {
      sessionStorage.setItem("reloaded-for", v);
      location.reload();
    }
  } catch {}
}

async function init() {
  checkVersion();
  try {
    INDEX = await getJSON("data/index.json");
  } catch (e) {
    $("main").innerHTML = `<div class="card">No rankings yet. Run <code>python src/run_weekly.py</code> first.</div>`;
    return;
  }
  const leagues = Object.keys(INDEX.leagues);
  const want = parseHash().params.get("league") || store.get("league");
  league = leagues.includes(want) ? want : leagues[0];
  $("#league").innerHTML = leagues.map((l) => `<button data-league="${esc(l)}">${esc(LEAGUE_NAME[l] || l)}</button>`).join("");
  $("#league").onclick = (e) => {
    const l = e.target.dataset.league;
    if (!l || l === league) return;
    const { view } = parseHash();
    // on a team page: jump to your favorite team in the other league, if you have one
    const fav = view === "team" && typeof Profile !== "undefined" ? Profile.get()?.[l] : null;
    if (fav) { location.hash = link("team", fav.id, { league: l }).slice(1); return; }
    // game/player/team pages belong to one league; fall back to that league's scores
    const next = ["game", "player", "team", "freeagents"].includes(view) ? "scores" : view;
    location.hash = `#/${next}?league=${l}`;
  };
  $("#updated").textContent = "Rankings updated " + new Date(INDEX.updated).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ".";

  $("#presets").onclick = (e) => {
    const p = e.target.dataset.preset;
    if (p) setWeights(presets()[p] || LG.default_weights);
  };
  $("#reset").onclick = () => setWeights(LG.default_weights);
  // Weights live in a floating panel opened from the bottom-right button
  const wpanel = $("#weights"), fab = $("#weights-fab");
  const setWeightsOpen = (open) => { wpanel.hidden = !open; fab.setAttribute("aria-expanded", open); fab.classList.toggle("open", open); };
  fab.onclick = () => setWeightsOpen(wpanel.hidden);
  $("#weights-close").onclick = () => setWeightsOpen(false);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setWeightsOpen(false); });
  document.addEventListener("pointerdown", (e) => { if (!wpanel.hidden && !wpanel.contains(e.target) && !fab.contains(e.target)) setWeightsOpen(false); });
  // Factor columns hidden until "Breakdown" is on (remembered per browser)
  const setBreakdown = (on) => { document.body.classList.toggle("show-breakdown", on); $("#breakdown").setAttribute("aria-pressed", on); $("#breakdown").classList.toggle("on", on); store.set("breakdown", on); };
  setBreakdown(!!store.get("breakdown"));
  $("#breakdown").onclick = () => setBreakdown(!document.body.classList.contains("show-breakdown"));
  $("#clear").onclick = () => setWeights({});
  document.querySelector("th.factors-col").onclick = (e) => { const k = e.target.dataset.only; if (k) { colSort = null; solo(k); } };
  document.querySelector("#table thead").addEventListener("click", (e) => {
    const k = e.target.closest("th[data-col]")?.dataset.col;
    if (!k) return;
    // cycle: best first -> worst first -> off
    colSort = !colSort || colSort.key !== k ? { key: k, dir: "best" } : colSort.dir === "best" ? { key: k, dir: "worst" } : null;
    render();
  });
  $("#rankby").onchange = (e) => {
    const [k, dir] = e.target.value.split(":");
    if (!k) return restoreBlend();
    if (!soloKey()) beforeSolo = { ...weights };
    applySolo(k, dir);
  };
  $("#season").onchange = () => { fillWeeks(); loadWeek(true); };
  $("#week").onchange = () => loadWeek(true);
  ["#search", "#conf", "#top25", "#profile"].forEach((s) => $(s).addEventListener("input", render));
  ["#sp-show", "#sp-conf"].forEach((s) => $(s).addEventListener("input", renderSchedules));
  const closeDrawer = () => { $("#drawer").classList.add("hidden"); document.body.classList.remove("drawer-open"); history.replaceState(history.state, "", link("rankings")); };
  $("#drawer").onclick = (e) => { if ("close" in e.target.dataset) closeDrawer(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").classList.contains("hidden")) closeDrawer(); });
  $("#table tbody").onclick = (e) => {
    const cm = e.target.closest(".cupm");
    if (cm) return cupTip(cm);
    const tr = e.target.closest("tr[data-team]");
    if (tr) openTeam(tr.dataset.team);
  };
  initSearch();
  initNav();
  window.addEventListener("hashchange", route);
  initBack();
  initPicLinks();
  CIT.apply(); // now that the header exists: search placeholder for the current theme
  // Refresh button (header): the home-screen app has no browser reload, so this reloads the page with fresh data
  $("#refresh")?.addEventListener("click", (e) => { e.currentTarget.classList.add("spin"); setTimeout(() => location.reload(), 150); });
  await route();
}

// Every team logo and player headshot opens its page, even where it isn't inside a link. The team or player comes
// from the picture's own address (ESPN/CFBD put the id in it; NFL logos use the abbreviation).
const NFL_ESPN = { ari: 22, atl: 1, bal: 33, buf: 2, car: 29, chi: 3, cin: 4, cle: 5, dal: 6, den: 7, det: 8, gb: 9, hou: 34, ind: 11,
  jax: 30, kc: 12, lv: 13, lac: 24, lar: 14, mia: 15, min: 16, ne: 17, no: 18, nyg: 19, nyj: 20, phi: 21, pit: 23, sf: 25, sea: 26,
  tb: 27, ten: 10, wsh: 28, was: 28 };
function picTarget(src) {
  let u = src || "";
  try { u = decodeURIComponent(u); } catch (e) {}
  let m = u.match(/\/i\/teamlogos\/(nfl|ncaa)\/500(?:-dark)?\/([a-z0-9]+)\.png/i);
  if (m) {
    const lg = m[1].toLowerCase() === "nfl" ? "nfl" : "cfb", id = lg === "nfl" ? NFL_ESPN[m[2].toLowerCase()] : m[2];
    return id ? link("team", id, { league: lg }) : null;
  }
  m = u.match(/collegefootballdata\.com\/logos\/\d+\/(\d+)\.png/);
  if (m) return link("team", m[1], { league: "cfb" });
  m = u.match(/\/i\/headshots\/(nfl|college-football)\/players\/full\/(\d+)\.png/);
  if (m) return link("player", m[2], { league: m[1] === "nfl" ? "nfl" : "cfb" });
  return null;
}
function initPicLinks() {
  document.addEventListener("click", (e) => {
    const im = e.target.closest?.("img");
    // pictures that already do something (links, buttons, the rankings row panel, the live field) keep their behavior
    if (!im || im.closest("a, button, label, tr[data-team], .tf-field, .gear, #drawer")) return;
    const to = picTarget(im.getAttribute("src"));
    if (to) { e.preventDefault(); location.hash = to.slice(to.indexOf("#")); }
  });
}

// Back button (phones, in the header): shows once you've moved around inside the site; same as the browser's back
function initBack() {
  const btn = document.createElement("button");
  btn.className = "back-fab hidden";
  btn.type = "button";
  btn.setAttribute("aria-label", "Back");
  btn.innerHTML = `<span aria-hidden="true">&larr;</span><span class="bk-t"> Back</span>`; // phones in the header: arrow only
  btn.onclick = () => history.back();
  (document.querySelector(".top .controls") || document.body).prepend(btn); // in the header, left of search
  // each history entry remembers how deep it is; a brand-new entry has no state yet
  let depth = history.state?.cupDepth || 0;
  history.replaceState({ ...(history.state || {}), cupDepth: depth }, "");
  window.addEventListener("hashchange", () => {
    if (history.state?.cupDepth == null) { depth += 1; history.replaceState({ ...(history.state || {}), cupDepth: depth }, ""); }
    else depth = history.state.cupDepth;
    btn.classList.toggle("hidden", depth < 1);
  });
  btn.classList.toggle("hidden", depth < 1);
  // float it at the top of the screen once the header has scrolled out of view
  const top = document.querySelector(".top");
  const pin = () => btn.classList.toggle("floating", !!top && top.getBoundingClientRect().bottom < 0);
  window.addEventListener("scroll", pin, { passive: true });
  pin();
}

function setLeague(l) {
  league = l;
  LG = INDEX.leagues[l];
  loadedKey = null;
  store.set("league", l);
  if (CIT.name() === "team") CIT.apply(); // Team theme: this league's favorite team's colors
  if (typeof Profile !== "undefined") Profile.header();
  document.querySelectorAll("#league button").forEach((b) => b.classList.toggle("active", b.dataset.league === l));
  document.body.dataset.league = l;
  $("#profile").innerHTML = `<option value="">All schedule profiles</option>` + Object.entries(PROFILES).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join("");
  $("#league-tag").textContent = LEAGUE_NAME[l] || l;
  document.querySelectorAll("#nav [data-view]").forEach((a) => (a.href = link(a.dataset.view)));
  $("#notes-link").href = link("updates");
  weights = loadWeights(l);
  reverse = false;
  beforeSolo = null;

  const seasons = Object.keys(LG.seasons).sort((a, b) => b - a);
  $("#season").innerHTML = seasons.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#season").value = LG.latest.season;
  fillWeeks();
  const tips = presetTips();
  $("#presets").innerHTML = Object.keys(presets()).map((p) => `<button data-preset="${esc(p)}" title="${esc(tips[p] || "")}">${esc(p)}</button>`).join("");
  $("#factor-help").innerHTML = LG.factors.map((f) => `<li><b>${esc(f.label)}:</b> ${esc(f.help)}</li>`).join("");
  $("#rankby").innerHTML = `<option value="">Blend (sliders)</option>` + LG.factors.map((f) =>
    `<option value="${esc(f.key)}:hi">${esc(f.label)}: high to low</option><option value="${esc(f.key)}:lo">${esc(f.label)}: low to high</option>`).join("");
  buildSliders();
}

// Presets. "Best teams" = weights re-learned each week from which blend best predicts the next week's
// winners; "Most deserving" = what a team has earned (record quality, schedule, padding).
function presets() {
  const m = LG.modes;
  return { ...(m ? { "Best teams": m.best, "Most deserving": m.deserving } : {}), "Default": LG.default_weights, ...BASE_PRESETS };
}

function presetTips() {
  const m = LG.modes;
  if (!m) return {};
  const pct = (x) => (x == null ? "?" : (100 * x).toFixed(1) + "%");
  return {
    "Best teams": `Who would win. Weights learned from ${m.games} games; the higher-ranked team won ${pct(m.accuracy.best)} of the following week's games.`,
    "Most deserving": "Who has earned it: strength of record, schedule difficulty and cupcake padding. Ignores margin of victory and luck.",
    "Default": "The site's standard blend.",
  };
}

const sameWeights = (a, b) => LG.factors.every((f) => (a[f.key] || 0) === ((b || {})[f.key] || 0));

function loadWeights(l) {
  const lgInfo = INDEX.leagues[l];
  let saved = store.get("weights_" + l);
  // a saved blend with only one factor on is a leftover column sort (older bug), not a real blend
  if (saved && Object.values(saved).filter((v) => v > 0).length <= 1) saved = null;
  return Object.fromEntries(lgInfo.factors.map((f) => [f.key, (saved && f.key in saved ? saved : lgInfo.default_weights)[f.key] ?? 0]));
}

function fillWeeks() {
  const s = LG.seasons[$("#season").value];
  $("#week").innerHTML = s.weeks.slice().reverse().map((w) => `<option value="${w}">${w === 0 ? "Preseason" : "Week " + w}</option>`).join("");
}

// Weekly model files, cached (also used by live.js for model lines/ranks)
const weekCache = new Map();
function weekData(lg, season, week) {
  const url = `data/${lg}/${season}/week_${week}.json`;
  if (!weekCache.has(url)) weekCache.set(url, getJSON(url).catch((e) => { weekCache.delete(url); throw e; }));
  return weekCache.get(url);
}

async function loadWeek(force = false) {
  const season = $("#season").value, week = +$("#week").value;
  const key = `${league}:${season}:${week}`;
  if (key === loadedKey && !force) { render(); return; }
  try {
    DATA = await weekData(league, season, week);
  } catch (e) {
    $("#table tbody").innerHTML = `<tr><td colspan="8" class="muted">Couldn't load this week. Try refreshing.</td></tr>`;
    return;
  }
  loadedKey = key;
  PREV = LG.seasons[season].weeks.includes(week - 1) ? await weekData(league, season, week - 1).catch(() => null) : null;
  const confs = [...new Set(DATA.teams.map((t) => t.conference).filter(Boolean))].sort();
  const cur = $("#conf").value;
  $("#conf").innerHTML = `<option value="">${league === "nfl" ? "All divisions" : "All conferences"}</option>` + confs.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#conf").value = confs.includes(cur) ? cur : "";
  const spc = $("#sp-conf").value;
  $("#sp-conf").innerHTML = `<option value="">${league === "nfl" ? "All divisions" : "All conferences"}</option>` + confs.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#sp-conf").value = confs.includes(spc) ? spc : "";
  const hasAP = DATA.teams.some((t) => t.ap_rank);
  document.body.classList.toggle("no-ap", !hasAP);
  $("#top25-label").lastChild.textContent = hasAP ? " AP Poll top 25 only" : league === "nfl" ? " Top 10 only" : " Top 25 only";
  $("#prior-note").textContent = DATA.prior_weight > 0
    ? `Early season: the preseason expectation still counts like ${(+DATA.prior_weight).toFixed(1)} games in the Power rating. It fades to zero in a few weeks.`
    : "";
  renderCotw();
  render();
  if (parseHash().view === "schedules") renderSchedules();
}

function renderCotw() {
  const c = DATA.cupcake_of_week;
  $("#cotw").classList.toggle("hidden", !c);
  if (!c) return;
  const team = DATA.teams.find((t) => t.team === c.team) || {};
  const [us, them] = String(c.score_line).split("-");
  // NFL: team name only ("Jaguars"), so the banner never wraps; college names are already short
  const nick = (n) => (league === "nfl" ? String(n).split(" ").pop() : n);
  const dual = (n) => esc(nick(n)); // team name only, no city (Jaguars, Patriots), on every screen
  const oppTag = c.fcs ? `<span class="prof-badge prof-walk">FCS</span>` : `<span class="muted">#${esc(c.opp_rank)}</span>`;
  $("#cotw").innerHTML = `
    <div class="cotw-tag"><span>Cupcake</span><span>Bully of the Week</span><small>Week ${esc(c.week)}</small></div>
    <div class="cotw-main">
      ${safeUrl(team.logo) ? `<img src="${esc(thumb(team.logo, 46))}" alt="" width="46" height="46" class="cotw-logo">` : ""}
      <div>
        <div class="cotw-line"><a href="#" data-team="${esc(c.team)}" class="cotw-team">${dual(c.team)}</a>
          <span class="cotw-score">${esc(us)}<span>–</span>${esc(them)}</span></div>
        <div class="cotw-sub">over ${dual(c.opp)} ${oppTag} · <span class="cotw-full">won </span>by ${esc(c.margin)}</div>
      </div>
    </div>
    ${c.espn_id ? `<a class="cotw-btn" href="${link("game", c.espn_id)}">Box score →</a>` : ""}`;
  $("#cotw").querySelector("[data-team]").onclick = (e) => { e.preventDefault(); openTeam(c.team); };
}

// ------------------------------------------------------------------ weights
function buildSliders() {
  $("#sliders").innerHTML = LG.factors.map((f) => `
    <div class="slider">
      <div class="slider-top"><span title="${esc(f.help)}">${esc(f.label)}</span><span id="v-${esc(f.key)}"></span></div>
      <input type="range" min="0" max="100" step="5" id="w-${esc(f.key)}" aria-label="${esc(f.label)} weight">
      <p>${esc(f.help)}</p>
    </div>`).join("");
  LG.factors.forEach((f) => {
    const el = $("#w-" + f.key);
    el.value = weights[f.key] ?? 0;
    el.oninput = () => { reverse = false; colSort = null; weights[f.key] = +el.value; store.set("weights_" + league, weights); showWeights(); render(); };
  });
  showWeights();
}

// save=false for temporary views (column-header sorts) so they never overwrite the user's saved blend
function setWeights(w, rev = false, save = true) {
  reverse = rev;
  weights = Object.fromEntries(LG.factors.map((f) => [f.key, (w || {})[f.key] ?? 0]));
  if (save) store.set("weights_" + league, weights);
  LG.factors.forEach((f) => ($("#w-" + f.key).value = weights[f.key]));
  showWeights();
  if (DATA) render();
}

const factor = (key) => LG.factors.find((f) => f.key === key);

// "hi" = the column's displayed value high to low (for Cupcake: most cupcakes = #1)
function applySolo(key, dir) {
  soloDir = dir;
  setWeights({ [key]: 100 }, dir === "lo", false);
}

// Header clicks cycle: high to low -> low to high -> back to the previous blend
function solo(key) {
  if (soloKey() === key && soloDir === "hi") return applySolo(key, "lo");
  if (soloKey() === key) return restoreBlend();
  if (!soloKey()) beforeSolo = { ...weights };
  applySolo(key, "hi");
}

function restoreBlend() {
  setWeights(beforeSolo || loadWeights(league), false, false);
  beforeSolo = null;
}

function soloKey() {
  const on = Object.entries(weights).filter(([, w]) => w > 0);
  return on.length === 1 ? on[0][0] : null;
}

function showWeights() {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const only = soloKey();
  LG.factors.forEach((f) => {
    $("#v-" + f.key).textContent = total ? Math.round((100 * (weights[f.key] || 0)) / total) + "%" : "0%";
  });
  $("#rankby").value = only ? `${only}:${soloDir}` : "";
  const P = presets();
  document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", sameWeights(weights, P[b.dataset.preset])));
  const active = Object.keys(P).find((k) => sameWeights(weights, P[k]));
  $("#wf-preset").textContent = only ? `${factor(only).label} only` : active || "Custom";
  $("#weights-note").textContent = !total ? "All weights are 0. Showing teams ordered by Power rating. Move a slider or click a column header."
    : only ? `Sorted by ${factor(only).label} only, ${soloDir === "hi" ? "high to low. Click the header again for low to high." : "low to high. Click the header again to go back to your blend."}` : "";
}

// Blended score. Inverted factors count as (100 - score).
function composite(teams, w = weights, factors = LG.factors) {
  const inv = new Set(factors.filter((f) => f.invert).map((f) => f.key));
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const val = (t, k) => (inv.has(k) ? 100 - (t.scores[k] ?? 50) : t.scores[k] ?? 50);
  return teams
    .map((t) => ({ ...t, comp: total ? Object.entries(w).reduce((s, [k, x]) => s + x * val(t, k), 0) / total : t.scores.power }))
    .sort((a, b) => b.comp - a.comp || b.rating - a.rating)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

// Ranking shown in the table. Sorting by an inverted factor alone (Cupcake) numbers teams by that
// factor itself, so #1 = the softest schedule; everything else uses the blended ranking.
function rankTeams(teams) {
  const list = composite(teams), only = soloKey();
  if (!only || !factor(only)?.invert) return list;
  return [...list].sort((a, b) => b.scores[only] - a.scores[only] || b.rating - a.rating).map((t, i) => ({ ...t, rank: i + 1 }));
}

// Model rank lookup for another view (scores/standings), using that league's saved weights.
async function modelRanks(lg) {
  const info = INDEX.leagues[lg];
  if (!info) return null;
  const d = await weekData(lg, info.latest.season, info.latest.week).catch(() => null);
  if (!d) return null;
  const list = composite(d.teams, info.default_weights, info.factors); // "our #" everywhere = the Default ranking
  return { byName: new Map(list.map((t) => [t.team, t])), byId: new Map(list.filter((t) => t.id).map((t) => [String(t.id), t])), data: d };
}

// ------------------------------------------------------------------ rankings table
const heat = (v) => `background:hsla(${Math.round(v * 1.3)},65%,45%,.18)`;
const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : "");
// Serve images at display size (x2 for sharp phone screens) through ESPN's resizer.
// Full-size logos are ~12KB and headshots ~230KB; thumbnails are ~1-7KB.
function thumb(url, w, h = w, crop = false) {
  if (!safeUrl(url)) return "";
  const cfbd = url.match(/^https:\/\/cdn\.collegefootballdata\.com\/logos\/\d+\/(\d+)\.png$/); // CFBD logo ids are ESPN ids
  const path = cfbd ? `/i/teamlogos/ncaa/500/${cfbd[1]}.png` : (url.match(/^https:\/\/a\.espncdn\.com(\/i\/[^?]+)$/) || [])[1];
  return path ? `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(path)}&w=${w * 2}&h=${h * 2}${crop ? "&scale=crop" : ""}` : url;
}
const logo = (t, cls = "") => safeUrl(t.logo)
  ? `<img src="${esc(thumb(t.logo, 28))}" alt="" loading="lazy" decoding="async" width="26" height="26" class="${cls}">` : `<span class="logo-ph ${cls}"></span>`;
// CFB: show only teams in the AP Top 25 (at wherever the model ranks them). NFL has no poll: model top 10.
const inTopFilter = (t) => (document.body.classList.contains("no-ap") ? t.rank <= (league === "nfl" ? 10 : 25) : !!t.ap_rank);

// Points for/against from completed games (scores are stored from the team's side, e.g. "45-6")
function pointDiff(t) {
  if (t._pd) return t._pd;
  let pf = 0, pa = 0;
  for (const g of t.schedule) {
    if (!g.result) continue;
    const [a, b] = String(g.score).split("-").map(Number);
    pf += a || 0; pa += b || 0;
  }
  return (t._pd = { pf, pa, diff: pf - pa });
}

// Schedule profile: Schedule (how hard was your road?) x Cupcake (how much did you pad it?)
const PROFILES = {
  gauntlet: { badge: "GAUNTLET", name: "Gauntlet", desc: "Hard schedule, no fluff." },
  barbell: { badge: "BARBELL", name: "Barbell", desc: "Hard schedule, but padded with cupcakes too." },
  grind: { badge: "GRIND", name: "Honest Grind", desc: "Easier schedule, but no padding. They played their peers." },
  walk: { badge: "CUPCAKE WALK", short: "WALK", name: "Cupcake Walk", desc: "Easy schedule and padded. The records to be most skeptical of." },
};
const HARD_SOS = 55, PADDED = 60; // score thresholds (50 = average)
function profileOf(t) {
  if (t.scores.cupcake == null || !(t.wins + t.losses)) return null;
  const hard = t.scores.sos >= HARD_SOS, padded = t.scores.cupcake >= PADDED;
  return hard ? (padded ? "barbell" : "gauntlet") : padded ? "walk" : "grind";
}
const profileBadge = (k) => `<span class="prof-badge prof-${k}" title="Schedule profile: ${PROFILES[k].name}. ${PROFILES[k].desc}">${tagText(PROFILES[k].badge, PROFILES[k].short)}</span>`;
// tag label with an optional short version for phones (the rankings table swaps to it under 640px)
const tagText = (full, short) => (short ? `<span class="tl-f">${full}</span><span class="tl-s">${short}</span>` : full);
const profileIcon = (t) => {
  const k = profileOf(t);
  return k ? ` ${profileBadge(k)}` : "";
};

// Schedule tags for one game in a rankings file (FCS / cupcake / top 25)
const schedTags = (g, nfl) => [g.fcs && '<span class="pill over">FCS</span>', g.cupcake && '<span class="pill over">cupcake</span>',
  !g.fcs && g.opp_rank <= (nfl ? 8 : 25) && `<span class="pill under">top ${nfl ? 8 : 25}</span>`].filter(Boolean).join(" ");

// One schedule game as a mini version of the box score's scorebug; the whole thing links to the game.
// g: { href, eid, wk, state: "pre"|"in"|"post", status, result: "W"|"L" (for the "me" team), neutral, tags, note, diff, winp,
//      away/home: { name, abbr, logo, score, rank, color, me } }   (away on the left, like the real scorebug)
function miniBug(g) {
  const side = (s, which) => {
    const lose = g.state === "post" && g.result && (s.me ? g.result === "L" : g.result === "W");
    const pic = safeUrl(s.logo) ? `<img src="${esc(thumb(s.logo, 24))}" alt="" loading="lazy" decoding="async" width="24" height="24">` : `<span class="logo-ph"></span>`;
    const name = `<span class="mb-nm">${s.rank ? `<i>#${esc(s.rank)}</i>` : ""}<b class="full">${esc(s.name)}</b><b class="ab">${esc(s.abbr || s.name)}</b></span>`;
    const score = `<span class="mb-sc">${g.state === "pre" ? "" : esc(s.score ?? "")}</span>`;
    return `<span class="mb-tm ${which}${s.me ? " me" : ""}${lose ? " lose" : ""}">${which === "away" ? pic + name + score : score + name + pic}</span>`;
  };
  const mid = g.state === "post" ? `<b class="${g.result === "W" ? "W" : g.result === "T" ? "T" : "L"}">${esc(g.result || "")}</b><small>${esc(g.status || "Final")}</small>`
    : g.state === "in" ? `<b class="live">LIVE</b><small>${esc(g.status || "")}</small>`
    : `<b class="mb-at">${g.neutral ? "VS" : "@"}</b><small class="mb-when">${esc(g.status || "")}</small>`;
  const right = g.diff != null ? `<span class="mb-right" title="Difficulty: the chance a typical top team would lose this game"><em>DIFF</em><span class="mb-bar"><i style="width:${Math.round(g.diff * 100)}%"></i></span><b>${Math.round(g.diff * 100)}%</b></span>`
    : g.winp != null ? `<span class="mb-right mb-win" title="${esc(g.why || "Cupcake Index model's chance this team wins")}"><b>${chancePct(g.winp)}</b> to win</span>` : "";
  const why = g.winp != null && g.why ? `<span class="mb-why">${esc(g.why)}</span>` : "";
  const foot = g.tags || g.note || right ? `<span class="mb-foot"><span class="mb-tags">${g.tags || ""}${g.note ? `<small>${g.note}</small>` : ""}</span>${right}${why}</span>` : "";
  const body = `<span class="mb-wk">WK<b>${esc(g.wk ?? "")}</b></span>${side(g.away, "away")}<span class="mb-mid">${mid}</span>${side(g.home, "home")}${foot}`;
  const res = g.state === "post" && ["W", "L", "T"].includes(g.result) ? ` res-${g.result}` : ""; // win/loss/tie tint
  const attrs = `class="mbug ${g.state}${res}${foot ? "" : " nofoot"}"${g.eid ? ` data-eid="${esc(g.eid)}"` : ""} style="--ac:${esc(g.away.color || "#6b7280")};--hc:${esc(g.home.color || "#6b7280")}"`;
  return g.href ? `<a ${attrs} href="${esc(g.href)}">${body}</a>` : `<div ${attrs}>${body}</div>`;
}

// "Best win" receipt: the highest-ranked opponent a team has beaten (FBS/NFL rank from the power ratings)
const TESTED = { cfb: { top: 25, quality: 40 }, nfl: { top: 10, quality: 16 } };
function bestWin(t) {
  const wins = t.schedule.filter((g) => g.result === "W");
  const ranked = wins.filter((g) => g.opp_rank && !g.fcs).sort((a, b) => a.opp_rank - b.opp_rank);
  return ranked[0] || wins[0] || null;
}
function isUntested(t) {
  const q = TESTED[league];
  if (!q || t.rank > q.top || !(t.wins + t.losses)) return false;
  const b = bestWin(t);
  return !b || !b.opp_rank || b.fcs || b.opp_rank > q.quality;
}
const bestWinText = (g) => g ? `${g.opp_rank && !g.fcs ? "#" + g.opp_rank + " " : ""}${g.opp}${g.fcs ? " (FCS)" : ""}, ${g.score}` : "none yet";
const untestedTag = (t) => isUntested(t)
  ? ` <span class="pill untested" title="No win over a top-${TESTED[league].quality} team yet. Best win: ${esc(bestWinText(bestWin(t)))}">${tagText("Beaten Nobody", "NOBODY")}</span>` : "";

// Padding meter: one small square per game played, filled = a cupcake game, plus a plain count ("2 cupcakes").
// Half or more of the games against cupcakes = heavy padding (count shown in the accent color).
// NFL week files from before the NFL got a Cupcake score have no scores.cupcake: no meter.
function cupMeter(t) {
  if (t.scores.cupcake == null || !(t.wins + t.losses)) return "";
  const played = t.schedule.filter((g) => g.result);
  const cups = played.filter((g) => g.cupcake);
  const n = cups.length, heavy = n && n / played.length >= 0.5;
  const tip = (n
    ? `${n} of ${played.length} games against cupcakes: ${cups.map((g) => g.opp + (g.fcs ? " (FCS)" : "")).join(", ")}.`
    : `No cupcakes in ${played.length} games played.`)
    + ` A cupcake is an opponent far below this team's level (FCS teams always count). Filled square = cupcake game.`;
  const sq = played.map((g) => `<i${g.cupcake ? ' class="on"' : ""}></i>`).join("");
  return `<button type="button" class="cupm${heavy ? " heavy" : ""}${n ? "" : " none"}" data-tip="${esc(tip)}" title="${esc(tip)}" aria-label="${esc(tip)}">`
    + `<span class="cupm-sq" aria-hidden="true">${sq}</span><span class="cupm-n">${n ? n + (n === 1 ? " cupcake" : " cupcakes") : "no cupcakes"}</span></button>`;
}
// Tap (phones) or click on a padding meter: a small explanation box instead of opening the team panel
function cupTip(btn) {
  let pop = document.getElementById("cupm-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "cupm-pop";
    pop.className = "cupm-pop";
    pop.setAttribute("role", "tooltip");
    document.body.appendChild(pop);
    const hide = () => pop.classList.add("hidden");
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".cupm, #cupm-pop")) hide(); });
    window.addEventListener("scroll", hide, { passive: true });
  }
  pop.textContent = btn.dataset.tip;
  pop.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + window.scrollY + 6) + "px";
  pop.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 8)) + "px";
}

function cotwTag(t) {
  const c = DATA.cupcake_of_week;
  if (!c || c.team !== t.team) return "";
  return ` <span class="pill cup-badge" title="Cupcake Bully of the Week: ${esc(c.score_line)} over ${esc(c.opp)}">BULLY</span>`;
}

function apTag(t) {
  if (t.ap_rank && t.rank - t.ap_rank >= 10) return `<span class="pill over" title="AP has them ${t.rank - t.ap_rank} spots higher">${tagText("Overrated", "OVER")}</span>`;
  if ((t.ap_rank && t.ap_rank - t.rank >= 10) || (!t.ap_rank && t.rank <= 15 && !document.body.classList.contains("no-ap"))) return `<span class="pill under" title="Model ranks them well above the AP poll">${tagText("Underrated", "UNDER")}</span>`;
  return "";
}

function render() {
  if (!DATA) return;
  ranked = rankTeams(DATA.teams);
  const prevRank = PREV ? Object.fromEntries(rankTeams(PREV.teams).map((t) => [t.team, t.rank])) : {};
  const q = $("#search").value.trim().toLowerCase(), conf = $("#conf").value, top = $("#top25").checked, prof = $("#profile").value;
  let ordered = reverse ? [...ranked].reverse() : ranked;
  if (colSort) {
    const pct = (t) => (t.wins + t.losses ? t.wins / (t.wins + t.losses) : 0);
    const cmp = colSort.key === "ap" ? (a, b) => (a.ap_rank || 999) - (b.ap_rank || 999)
      : colSort.key === "diff" ? (a, b) => pointDiff(b).diff - pointDiff(a).diff
      : (a, b) => pct(b) - pct(a) || b.wins - a.wins || a.rank - b.rank;
    const flip = colSort.dir === "worst" ? -1 : 1;
    ordered = [...ranked].sort((a, b) => {
      if (colSort.key === "ap" && !a.ap_rank !== !b.ap_rank) return a.ap_rank ? -1 : 1; // unranked always last
      return flip * cmp(a, b) || a.rank - b.rank;
    });
  }
  const rows = ordered.filter((t) => (!q || t.team.toLowerCase().includes(q)) && (!conf || t.conference === conf) && (!top || inTopFilter(t)) && (!prof || profileOf(t) === prof));
  const only = soloKey();
  // Score column: the blended score, or the sorted factor's own score during a single-factor sort
  const shown = (t) => (only ? t.scores[only] : t.comp);
  $("th.score-col").textContent = only ? SHORT[only] || "Score" : "Score";
  // Overrated/Underrated and Beaten Nobody compare the overall ranking; hide them while sorting by one column
  const blended = !only && !reverse;
  $("#table tbody").innerHTML = rows.map((t) => {
    const p = prevRank[t.team], d = p ? p - t.rank : 0, pd = pointDiff(t);
    const mv = !p ? "" : d > 0 ? `<span class="up">▲${d}</span>` : d < 0 ? `<span class="down">▼${-d}</span>` : `<span class="muted">–</span>`;
    const chips = LG.factors.map((f) => {
      const v = t.scores[f.key];
      return `<span class="chip${only === f.key ? " sel" : ""}" style="${heat(f.invert ? 100 - v : v)}" title="${esc(f.label)}: ${esc(v)}">${Math.round(v)}</span>`;
    }).join("");
    const bully = DATA.cupcake_of_week && DATA.cupcake_of_week.team === t.team;
    const mine = typeof Profile !== "undefined" && Profile.get()?.[league]?.name === t.team; // your favorite team's row
    const cls = [bully ? "bully" : "", mine ? "my-row" : ""].filter(Boolean).join(" ");
    return `<tr data-team="${esc(t.team)}"${cls ? ` class="${cls}"` : ""}>
      <td class="num rank">${t.rank}</td><td class="mv">${mv}</td>
      <td><div class="team">${logo(t)}<div class="tcell">
        <b class="tname" title="${esc(t.conference || "")}">${t.ap_rank ? `<span class="ap-rk" title="AP Poll rank">${esc(t.ap_rank)}</span>` : ""}${esc(t.team)}</b>
        <div class="tmeta">${cupMeter(t)}${profileIcon(t)}${cotwTag(t)}${blended ? untestedTag(t) + apTag(t) : ""}</div>
      </div></div></td>
      <td class="num">${esc(t.record)}</td>
      <td class="num diff ${pd.diff > 0 ? "up" : pd.diff < 0 ? "down" : ""}" title="${pd.pf} scored, ${pd.pa} allowed">${pd.diff > 0 ? "+" : ""}${pd.diff}</td>
      <td class="num ap">${t.ap_rank ? esc(t.ap_rank) : '<span class="muted">–</span>'}</td>
      <td><div class="score">${shown(t).toFixed(1)}<span class="bar"><i style="width:${+shown(t) || 0}%"></i></span></div></td>
      <td class="factors"><div class="chips">${chips}</div></td></tr>`;
  }).join("");
  const labels = LG.factors.map((f) => `<button class="chip head${only === f.key ? " sel" : ""}" data-only="${esc(f.key)}" title="Click: sort by ${esc(f.label)}, high to low. Again: low to high. Again: back to your blend. ${esc(f.help)}">${SHORT[f.key] || esc(f.label.slice(0, 4))}${only === f.key ? (soloDir === "hi" ? " ▼" : " ▲") : ""}</button>`).join("");
  document.querySelector("th.factors-col").innerHTML = `<div class="chips">${labels}</div>`;
  document.querySelectorAll("#table th[data-col]").forEach((th) => {
    const on = colSort?.key === th.dataset.col;
    th.classList.toggle("on", on);
    th.querySelector(".arrow").textContent = on ? (colSort.dir === "best" ? " ▼" : " ▲") : "";
  });
}

function whyBullets(t) {
  // luck isn't a strength or weakness (it reads backwards: a low "Bad luck" score means GOOD luck); it gets its own line below
  const f = LG.factors.filter((x) => !x.invert && x.key !== "luck").map((x) => ({ ...x, v: t.scores[x.key] })).sort((a, b) => b.v - a.v);
  const out = [];
  if (t.next_qb && t.usual_qb && t.next_qb !== t.usual_qb) out.push(`QB change: ${t.next_qb} is listed to start next, not ${t.usual_qb}, who started most games so far. The rating doesn't account for this.`);
  const strong = f.filter((x) => x.v >= 65).slice(0, 2);
  if (strong.length) out.push("Strengths: " + strong.map((x) => `${x.label.toLowerCase()} (${Math.round(x.v)})`).join(", ") + ".");
  const weak = f.filter((x) => x.v < 40).slice(-2).reverse();
  if (weak.length) out.push("Weaknesses: " + weak.map((x) => `${x.label.toLowerCase()} (${Math.round(x.v)})`).join(", ") + ".");
  const games = t.wins + t.losses, cups = t.fcs_games + t.weak_games;
  if (t.scores.cupcake != null && cups >= 2) out.push(league === "nfl"
    ? `Cupcake score ${Math.round(t.scores.cupcake)}: ${cups} of ${games} games were against weaker, below-average teams. Those wins count for less.`
    : `Cupcake score ${Math.round(t.scores.cupcake)}: ${cups} of ${games} games were cupcakes for a team this good (${t.fcs_games} FCS, ${t.weak_games} FBS teams far below them). Those wins barely count.`);
  if (isUntested(t)) out.push(`Beaten Nobody: no win over a top-${TESTED[league].quality} team yet. Best win: ${bestWinText(bestWin(t))}.`);
  const cw = t.cotw_weeks || [];
  if (cw.length) out.push(`Cupcake Bully of the Week ${cw.length === 1 ? "once" : cw.length + " times"} this season (week ${cw.join(", ")}).`);
  if (t.luck_wins >= 1) out.push(`Lucky: about ${t.luck_wins.toFixed(1)} more wins than their play deserved (${t.one_score} in one-score games).`);
  if (t.luck_wins <= -1) out.push(`Unlucky: about ${(-t.luck_wins).toFixed(1)} fewer wins than their play deserved (${t.one_score} in one-score games).`);
  if (t.ap_rank && t.rank - t.ap_rank >= 10) out.push(`AP has them #${t.ap_rank}; the numbers say #${t.rank}.`);
  if (league === "cfb" && !t.ap_rank && t.rank <= 25) out.push("Unranked in the AP poll despite the numbers.");
  return out;
}

function openTeam(name) {
  const t = ranked.find((x) => x.team === name);
  if (!t) return;
  const sosRank = [...DATA.teams].sort((a, b) => b.raw.sos - a.raw.sos).findIndex((x) => x.team === name) + 1;
  const why = whyBullets(t);
  const nfl = league === "nfl";
  // each game is a mini scorebug (away team on the left); ESPN abbreviations + kickoff times fill in after the panel opens
  const byName = new Map(DATA.teams.map((x) => [x.team, x]));
  const ourRank = new Map(rankTeams(DATA.teams).map((x) => [x.team, x.rank]));
  const col = (c) => Live.kit.teamColor({ color: (c || "").replace("#", "") });
  const sched = t.schedule.map((g) => {
    const o = byName.get(g.opp) || {};
    const [pf, pa] = String(g.score || "").split("-");
    const me = { name: t.team, logo: t.logo, rank: t.rank, color: col(t.color), score: pf, me: true };
    const op = { name: g.opp, logo: o.logo, rank: g.fcs ? null : ourRank.get(g.opp) || g.opp_rank, color: col(o.color), score: pa };
    const note = g.qb ? `QB ${esc(g.qb)}${g.qb !== t.usual_qb && t.usual_qb ? " ⚠" : ""}${g.rest_diff ? ` · ${g.rest_diff > 0 ? "+" : ""}${esc(g.rest_diff)} days rest vs. opp` : ""}` : "";
    return miniBug({ href: g.espn_id ? link("game", g.espn_id) : "", eid: g.espn_id, wk: g.week, state: g.upcoming ? "pre" : "post",
      status: g.upcoming ? "Preview" : "Final", result: g.result, neutral: g.loc === "N", away: g.loc === "H" ? op : me, home: g.loc === "H" ? me : op,
      tags: schedTags(g, nfl), note, diff: g.upcoming ? null : g.difficulty, winp: g.upcoming ? g.win_prob : null, why: g.upcoming ? g.why : null });
  }).join("");
  const bench = nfl ? "top-8 NFL team" : "top-25 team";
  $("#drawer-body").innerHTML = `
    <div class="d-head">${logo(t)}<div><h2>#${t.rank} ${esc(t.team)}</h2><span class="muted">${esc(t.conference || "")} · ${esc(t.record)}${t.ap_rank ? " · AP #" + esc(t.ap_rank) : ""}</span>
      <div><a id="team-page-link" class="boxlink" href="#">Roster, schedule &amp; stats →</a></div></div></div>
    ${why.length ? `<div class="why"><b>Why they're here</b><ul>${why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    <div class="stats">
      <div class="stat wide-stat"><small>Best win</small><b>${esc(bestWinText(bestWin(t)))}</b></div>
      <div class="stat"><small>Power rating</small><b>${t.rating > 0 ? "+" : ""}${t.rating.toFixed(1)}</b></div>
      <div class="stat"><small>Schedule rank</small><b>#${sosRank}</b></div>
      <div class="stat"><small>One-score games</small><b>${esc(t.one_score)}</b></div>
      <div class="stat"><small>Wins vs. deserved</small><b>${t.luck_wins > 0 ? "+" : ""}${t.luck_wins.toFixed(1)}</b></div>
      ${nfl ? `<div class="stat"><small>Main starting QB</small><b>${esc(t.usual_qb || "—")}</b></div>${t.scores.cupcake != null ? `<div class="stat"><small>Mismatch games</small><b>${esc(t.weak_games)}</b></div>` : ""}`
            : `<div class="stat"><small>FCS games</small><b>${esc(t.fcs_games)}</b></div><div class="stat"><small>FBS mismatches</small><b>${esc(t.weak_games)}</b></div>`}
      ${profileOf(t) ? `<div class="stat wide-stat"><small>Schedule profile</small><b>${profileBadge(profileOf(t))}</b><small class="muted">${PROFILES[profileOf(t)].desc} <a href="${link("schedules", null, { team: t.team })}">See it on the chart →</a></small></div>` : ""}
    </div>
    <h3>Factor scores</h3>
    ${LG.factors.map((f) => `<div class="frow" title="${esc(f.help)}"><span>${esc(f.label)}</span><span class="bar${f.invert ? " inv" : ""}"><i style="width:${+t.scores[f.key] || 0}%"></i></span><b class="num">${Math.round(t.scores[f.key])}</b></div>`).join("")}
    <p class="note">Power rating = points better than an average ${nfl ? "NFL" : "FBS"} team on a neutral field.${t.scores.cupcake != null ? " Cupcake: higher = softer schedule for a team at this level, counting only games already played." : ""}</p>
    <h3>Schedule</h3>
    <div class="mb-list">${sched}</div>
    <p class="note">Tap a game for the box score or preview. Diff (difficulty) is the chance a typical ${bench} would lose this game.${nfl ? " ⚠ = a different QB than the team's usual starter." : " Beating FCS teams is close to 0%."}</p>`;
  $("#drawer").classList.remove("hidden");
  document.body.classList.add("drawer-open"); // stop the page behind from scrolling on phones
  history.replaceState(history.state, "", link("rankings", null, { team: name }));
  Live.teamId(league, t).then((id) => {
    const a = $("#team-page-link");
    if (a && id) a.href = link("team", id); else if (a) a.remove();
    if (id) Live.fillBugs(league, id, $("#drawer-body"));
  });
}

// ------------------------------------------------------------------ schedule profile chart
function renderSchedules() {
  if (!DATA || !DATA.teams.some((t) => t.scores.cupcake != null)) {
    $("#sp-chart").innerHTML = `<p class="muted" style="padding:16px">No Cupcake scores in this week's data, so there are no schedule profiles to show.</p>`;
    $("#sp-legend").innerHTML = "";
    return;
  }
  const all = composite(DATA.teams).filter((t) => profileOf(t));
  const show = $("#sp-show").value, conf = $("#sp-conf").value;
  let teams = league === "nfl" ? all : show === "ap" ? all.filter((t) => t.ap_rank) : show === "all" ? all : all.filter((t) => t.rank <= +show);
  if (conf) teams = all.filter((t) => t.conference === conf);
  // arriving from a team panel: always include that team, even if the current filter would hide it
  const focus = parseHash().params.get("team");
  const focusTeam = focus && all.find((t) => t.team === focus);
  if (focusTeam && !teams.includes(focusTeam)) teams = [...teams, focusTeam];
  // NFL: most teams have no cupcakes yet, so they'd all sit on one flat row. Spread those teams out (below the
  // "padded" line, so their profile doesn't change) by how much weaker their opponents have been than them on average.
  const cupY = new Map(all.map((t) => [t, t.scores.cupcake]));
  if (league === "nfl") {
    const floor = Math.min(...all.map((t) => t.scores.cupcake));
    const gap = (t) => { const g = t.schedule.filter((x) => x.result && x.opp_rating != null); return g.length ? g.reduce((s, x) => s + Math.max(0, t.rating - x.opp_rating), 0) / g.length : 0; };
    const flat = all.filter((t) => t.scores.cupcake <= floor + 0.01).sort((a, b) => gap(a) - gap(b));
    flat.forEach((t, i) => cupY.set(t, floor - 10 + (flat.length > 1 ? (i / (flat.length - 1)) : 0.5) * Math.min(20, PADDED - 3 - (floor - 10))));
  }
  const xs = all.map((t) => t.scores.sos), ys = all.map((t) => cupY.get(t));
  // padded domain so logos at the extremes aren't clipped or covering the corner labels
  const x0 = Math.min(...xs) - 7, x1 = Math.max(...xs) + 9;
  const y0 = Math.min(...ys) - 12, y1 = Math.max(...ys) + 10;
  const px = (v) => ((v - x0) / (x1 - x0)) * 100, py = (v) => 100 - ((v - y0) / (y1 - y0)) * 100;
  const cx = px(HARD_SOS), cy = py(PADDED);
  // positions are stored as 0-1 fractions; initZoom() turns them into pixels for the current zoom/pan
  const quad = (k, l, t, w, h, pos) => `<div class="sp-q sp-${k}" data-x0="${l / 100}" data-x1="${(l + w) / 100}" data-y0="${t / 100}" data-y1="${(t + h) / 100}"><span class="sp-ql ${pos}">${profileBadge(k)}<small>${SP_QDESC[k]}</small></span></div>`;
  // dotted grid every 10 points (labels on the bottom and right edges) + dashed lines where the profiles split
  const tens = (a, b) => { const out = []; for (let v = Math.ceil(a / 10) * 10; v <= b; v += 10) out.push(v); return out; };
  const grid = tens(x0, x1).filter((v) => px(v) > 3 && px(v) < 96).map((v) => `<i class="sp-gl v" data-gx="${px(v) / 100}" data-l="${v}"></i>`).join("")
    + tens(y0, y1).filter((v) => v !== PADDED && py(v) > 12 && py(v) < 90).map((v) => `<i class="sp-gl h" data-gy="${py(v) / 100}" data-l="${v}"></i>`).join("")
    + `<i class="sp-gl v mid" data-gx="${cx / 100}"></i><i class="sp-gl h mid" data-gy="${cy / 100}"></i>`;
  const byName = new Map(teams.map((t) => [t.team, t]));
  $("#sp-chart").innerHTML = `${grid}
    ${quad("walk", 0, 0, cx, cy, "tl")}${quad("barbell", cx, 0, 100 - cx, cy, "tr")}
    ${quad("grind", 0, cy, cx, 100 - cy, "bl")}${quad("gauntlet", cx, cy, 100 - cx, 100 - cy, "br")}
    <span class="sp-axis sp-x">Schedule: harder →</span><span class="sp-axis sp-y">Cupcake: more padded →</span>
    <div class="sp-zoom" role="group" aria-label="Zoom"><button data-z="in" aria-label="Zoom in">+</button><button data-z="out" aria-label="Zoom out">−</button><button data-z="reset">Reset</button></div>
    <div class="cc-tip"></div>
    ${teams.map((t) => `<button class="sp-dot${t === focusTeam ? " focus" : ""}" data-team="${esc(t.team)}" data-fx="${px(t.scores.sos) / 100}" data-fy="${py(cupY.get(t)) / 100}"
        style="animation-delay:${Math.round((px(t.scores.sos) / 100) * 450)}ms" aria-label="#${t.rank} ${esc(t.team)} (${esc(t.record)}) · Schedule ${Math.round(t.scores.sos)} · Cupcake ${Math.round(t.scores.cupcake)}">
        ${safeUrl(t.logo) ? `<img src="${esc(thumb(t.logo, 26))}" alt="${esc(t.team)}" width="26" height="26" loading="lazy" decoding="async">` : `<span>${esc(t.team.slice(0, 3))}</span>`}${t === focusTeam ? `<b class="sp-flabel">${esc(t.team)}</b>` : ""}</button>`).join("")}`;
  const zoom = initZoom($("#sp-chart"), (team) => { ranked = rankTeams(DATA.teams); openTeam(team); });
  // hover a logo (mouse): the same pop-in box as the Stats-by-year chart
  const box = $("#sp-chart"), tip = box.querySelector(".cc-tip");
  box.onpointerover = (e) => {
    const dot = e.pointerType === "mouse" && e.target.closest(".sp-dot"), t = dot && byName.get(dot.dataset.team);
    if (!t) return;
    const p = profileOf(t);
    showTip(box, tip, parseFloat(dot.style.left), parseFloat(dot.style.top) - 12, `<small>#${t.rank} · ${esc(t.record)} · ${esc(t.conference || "")}</small><b>${esc(t.team)}</b>
      <span>Schedule ${Math.round(t.scores.sos)} · Cupcake ${Math.round(t.scores.cupcake)}</span>${p ? `<span>${profileBadge(p)}</span>` : ""}`);
  };
  box.onpointerout = (e) => { if (e.target.closest(".sp-dot") && !e.relatedTarget?.closest?.(".sp-dot")) tip.classList.remove("on"); };
  if (focusTeam) {
    const dot = $("#sp-chart .sp-dot.focus");
    zoom.focusOn(+dot.dataset.fx, +dot.dataset.fy, 1.8);
    dot.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => dot.classList.add("faded"), 10000); // highlight fades after ~10 seconds
  }
  const counts = Object.fromEntries(Object.keys(PROFILES).map((k) => [k, teams.filter((t) => profileOf(t) === k)]));
  $("#sp-legend").innerHTML = Object.entries(PROFILES).map(([k, p]) => `<div class="sp-leg sp-${k}">${profileBadge(k)} <span class="muted">(${counts[k].length})</span><small>${p.desc}</small>
    <small>${counts[k].slice(0, 6).map((t) => `#${t.rank} ${esc(t.team)}`).join(", ")}${counts[k].length > 6 ? "…" : ""}</small></div>`).join("");
  renderSchedBars(teams, all, conf, focusTeam);
}
const SP_QDESC = { walk: "easy road, padded", barbell: "hard road, padded", grind: "easy road, no padding", gauntlet: "hard road, no padding" };

// Hover box shared by the schedule charts (reuses the Stats-by-year .cc-tip look). x/y = anchor inside box.
function showTip(box, tip, x, y, html) {
  tip.innerHTML = html;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  tip.classList.toggle("below", y < 90);
  tip.classList.toggle("edge-l", x < 90);
  tip.classList.toggle("edge-r", x > box.clientWidth - 90);
  tip.classList.remove("on"); void tip.offsetWidth; tip.classList.add("on"); // replay the pop-in
}

// Two companion charts under the quadrant: each team's Schedule score (hardest first) and each
// conference's average. Bars grow out from 50 (an average schedule): right = tougher, left = easier.
function renderSchedBars(teams, all, conf, focusTeam) {
  const nfl = league === "nfl", r = (v) => Math.round(v);
  const sosRank = new Map([...all].sort((a, b) => b.scores.sos - a.scores.sos).map((t, i) => [t, i + 1]));
  const row = (x, n) => {
    const lo = Math.min(x.v, 50), w = Math.abs(x.v - 50);
    return `<button class="sb-row${x.on ? " on" : ""}" data-i="${n}"><span class="sb-lab">${x.logo || ""}<span>${x.label}</span></span>
      <span class="sb-track"><i class="sb-bar ${x.v >= 50 ? "up" : "dn"}" style="left:${lo}%;width:${w}%;animation-delay:${n * 22}ms"></i></span><span class="sb-val">${r(x.v)}</span></button>`;
  };
  const axis = `<div class="sb-axis"><span style="left:0">0</span><span style="left:25%">← easier</span><span style="left:50%">50</span><span style="left:75%">tougher →</span><span style="left:100%">100</span></div>`;
  const chart = (el, rows, onPick) => {
    let gap = -1;
    const hidden = rows.length - 24;
    if (rows.length > 32) { gap = 12; rows = [...rows.slice(0, 12), ...rows.slice(-12)]; } // long lists (all FBS): hardest 12 + easiest 12
    el.innerHTML = `<div class="sb-grid">${[0, 25, 50, 75, 100].map((v) => `<i class="${v === 50 ? "mid" : ""}" style="left:${v}%"></i>`).join("")}</div>`
      + rows.map((x, n) => (n === gap ? `<div class="sb-gap muted">⋯ ${hidden} more in between ⋯</div>` : "") + row(x, n)).join("") + axis + `<div class="cc-tip"></div>`;
    const tip = el.querySelector(".cc-tip");
    el.onpointerover = (e) => {
      const b = e.target.closest(".sb-row");
      if (!b || e.pointerType !== "mouse") return;
      const x = rows[+b.dataset.i], bar = b.querySelector(".sb-bar").getBoundingClientRect(), br = el.getBoundingClientRect();
      showTip(el, tip, (x.v >= 50 ? bar.right : bar.left) - br.left, bar.top - br.top - 4, x.tip);
    };
    el.onpointerleave = () => tip.classList.remove("on");
    el.onclick = (e) => { const b = e.target.closest(".sb-row"); if (b) onPick(rows[+b.dataset.i]); };
  };

  // 1) every team in the current filter, hardest schedule first
  const list = [...teams].sort((a, b) => b.scores.sos - a.scores.sos);
  chart($("#sb-teams"), list.map((t) => ({
    t, v: t.scores.sos, on: t === focusTeam,
    label: `<em>${t.rank}</em> ${esc(t.team)}`,
    logo: safeUrl(t.logo) ? `<img src="${esc(thumb(t.logo, 16))}" alt="" width="16" height="16" loading="lazy" decoding="async">` : "",
    tip: `<small>#${t.rank} · ${esc(t.record)} · ${esc(t.conference || "")}</small><b>${esc(t.team)}</b>
      <span>Schedule ${r(t.scores.sos)} · #${sosRank.get(t)} hardest of ${all.length}</span><span>Cupcake ${r(t.scores.cupcake)}</span>`,
  })), (x) => { ranked = rankTeams(DATA.teams); openTeam(x.t.team); });

  // 2) conference (NFL: division) averages over all of its teams; tap one to filter everything to it
  const groups = new Map();
  all.forEach((t) => { if (t.conference) { if (!groups.has(t.conference)) groups.set(t.conference, []); groups.get(t.conference).push(t); } });
  const avg = (ts, k) => ts.reduce((s, t) => s + t.scores[k], 0) / ts.length;
  const confs = [...groups].filter(([, ts]) => ts.length > 1).map(([c, ts]) => ({ c, ts, v: avg(ts, "sos"), cup: avg(ts, "cupcake") })).sort((a, b) => b.v - a.v);
  const unit = nfl ? "division" : "conference";
  $("#sb-confs-title").textContent = `Schedule strength by ${unit}`;
  $("#sb-confs-cap").textContent = `The average Schedule score of each ${unit}'s teams. Tap one to show just that ${unit}${conf ? " (tap it again to show all)" : ""}.`;
  chart($("#sb-confs"), confs.map((g) => {
    const top = [...g.ts].sort((a, b) => b.scores.sos - a.scores.sos)[0];
    return { c: g.c, v: g.v, on: g.c === conf, label: esc(g.c),
      tip: `<small>${g.ts.length} teams · average Cupcake ${r(g.cup)}</small><b>${esc(g.c)}</b><span>Average schedule ${r(g.v)}</span><span>Toughest: ${esc(top.team)} (${r(top.scores.sos)})</span>` };
  }), (x) => { $("#sp-conf").value = x.c === conf ? "" : x.c; renderSchedules(); });
}

// Pinch-zoom (phones), drag-to-pan, +/- buttons, double-click and Ctrl/trackpad-pinch zoom (computers).
// Logos keep their size while the space between them stretches, so crowded clusters spread apart.
function initZoom(el, onPick) {
  const st = { k: 1, tx: 0, ty: 0 }, MAX = 8;
  const W = () => el.clientWidth, H = () => el.clientHeight;
  function layout() {
    st.k = Math.min(MAX, Math.max(1, st.k));
    st.tx = Math.min(0, Math.max(W() * (1 - st.k), st.tx));
    st.ty = Math.min(0, Math.max(H() * (1 - st.k), st.ty));
    const w = W() * st.k, h = H() * st.k;
    el.querySelectorAll("[data-fx]").forEach((d) => { d.style.left = `${d.dataset.fx * w + st.tx}px`; d.style.top = `${d.dataset.fy * h + st.ty}px`; });
    el.querySelectorAll("[data-gx]").forEach((g) => { g.style.left = `${g.dataset.gx * w + st.tx}px`; });
    el.querySelectorAll("[data-gy]").forEach((g) => { g.style.top = `${g.dataset.gy * h + st.ty}px`; });
    el.querySelectorAll("[data-x0]").forEach((q) => {
      const x0 = q.dataset.x0 * w + st.tx, y0 = q.dataset.y0 * h + st.ty;
      Object.assign(q.style, { left: `${x0}px`, top: `${y0}px`, width: `${(q.dataset.x1 - q.dataset.x0) * w}px`, height: `${(q.dataset.y1 - q.dataset.y0) * h}px` });
    });
    const zoomed = st.k > 1.01;
    el.classList.toggle("zoomed", zoomed);
    el.style.touchAction = zoomed ? "none" : "pan-y"; // when zoomed, one-finger drags pan the chart instead of the page
  }
  function zoomAt(factor, cx, cy) {
    const k2 = Math.min(MAX, Math.max(1, st.k * factor));
    st.tx = cx - (cx - st.tx) * (k2 / st.k);
    st.ty = cy - (cy - st.ty) * (k2 / st.k);
    st.k = k2;
    layout();
  }
  const local = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  const pts = new Map();
  let pinch = null, moved = 0, downOn = null;
  el.onpointerdown = (e) => {
    if (e.target.closest(".sp-zoom")) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { moved = 0; downOn = e.target.closest("[data-team]")?.dataset.team || null; }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); downOn = null; }
    if (e.pointerType === "mouse") el.classList.add("dragging");
  };
  const onMove = (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = [e.clientX, e.clientY];
    pts.set(e.pointerId, cur);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = el.getBoundingClientRect(), mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
      if (pinch) zoomAt(d / pinch, mx, my);
      pinch = d;
      e.preventDefault();
    } else if (st.k > 1.01) {
      st.tx += cur[0] - prev[0]; st.ty += cur[1] - prev[1];
      moved += Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]);
      layout();
      e.preventDefault();
    } else {
      moved += Math.abs(cur[0] - prev[0]) + Math.abs(cur[1] - prev[1]);
    }
  };
  const onUp = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) {
      el.classList.remove("dragging");
      if (downOn && moved < 8 && e.type === "pointerup") onPick(downOn); // a tap/click, not a drag
      downOn = null;
    }
  };
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  el.onclick = (e) => e.preventDefault();
  el.ondblclick = (e) => { const [x, y] = local(e); zoomAt(2, x, y); };
  el.onwheel = (e) => { // Ctrl/Cmd + scroll, or a trackpad pinch (browsers report it as ctrl+wheel)
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.01), x, y);
  };
  el.querySelector(".sp-zoom").onclick = (e) => {
    const z = e.target.dataset.z;
    if (z === "reset") { st.k = 1; st.tx = st.ty = 0; layout(); }
    else if (z) zoomAt(z === "in" ? 1.6 : 1 / 1.6, W() / 2, H() / 2);
  };
  window.addEventListener("resize", layout);
  layout();
  return {
    // center the view on a point (0-1 fractions) at zoom level k
    focusOn(fx, fy, k) {
      st.k = k;
      st.tx = W() / 2 - fx * W() * k;
      st.ty = H() / 2 - fy * H() * k;
      layout();
    },
  };
}

// ------------------------------------------------------------------ compare vs. other systems
let cmpSort = { k: "ours", dir: 1 };
async function renderCompare() {
  const tb = $("#cmp-table tbody");
  if (league !== "cfb") { tb.innerHTML = `<tr><td colspan="8" class="muted">The comparison is a college football feature.</td></tr>`; return; }
  const season = LG.latest.season;
  let cmp, cur;
  try {
    [cmp, cur] = await Promise.all([getJSON(`data/cfb/${season}/compare.json`), weekData("cfb", season, LG.latest.week)]);
  } catch {
    tb.innerHTML = `<tr><td colspan="8" class="muted">Comparison data isn't available yet.</td></tr>`;
    return;
  }
  const ours = composite(cur.teams, LG.default_weights); // always the Default ranking, never a temporary sort
  const UNRANKED = 30; // polls stop at 25
  const rows = ours.map((t) => {
    const c = cmp.teams[t.team] || {};
    const vals = [c.ap || UNRANKED, c.coaches || UNRANKED, c.fpi, c.sp].filter((v) => v != null);
    const cons = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return { t, ours: t.rank, ap: c.ap, coaches: c.coaches, fpi: c.fpi, sp: c.sp, cons, gap: cons == null ? null : cons - t.rank };
  });

  // agreement (Spearman rank correlation) with each system, over teams both rank
  const spearman = (k) => {
    const pairs = rows.filter((r) => r[k] != null).map((r) => [r.ours, r[k]]);
    const rk = (arr) => { const s = [...arr].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = []; s.forEach(([, i], j) => (out[i] = j + 1)); return out; };
    const a = rk(pairs.map((p) => p[0])), b = rk(pairs.map((p) => p[1])), n = pairs.length;
    if (n < 10) return null;
    const d2 = a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
  };
  const top25 = (k) => rows.filter((r) => r[k] && r[k] <= 25);
  const overlap = (k) => top25(k).filter((r) => r.ours <= 25).length;
  $("#cmp-agree").innerHTML = [["fpi", "ESPN FPI"], ["sp", "SP+"], ["ap", "AP Poll"], ["coaches", "Coaches Poll"]].map(([k, label]) => {
    const rho = k === "fpi" || k === "sp" ? spearman(k) : null;
    return `<div class="stat"><small>vs. ${label}</small><b>${overlap(k)} of 25</b><small class="muted">same top-25 teams${rho != null ? ` · agreement ${rho.toFixed(2)}` : ""}</small></div>`;
  }).join("");

  // where we stand alone
  const eligible = rows.filter((r) => r.cons != null && (r.ours <= 25 || r.cons <= 25));
  const higher = eligible.filter((r) => [r.ap || UNRANKED, r.coaches || UNRANKED, r.fpi, r.sp].every((v) => v == null || v > r.ours)).sort((a, b) => b.gap - a.gap).slice(0, 4);
  const lower = eligible.filter((r) => [r.ap || UNRANKED, r.coaches || UNRANKED, r.fpi, r.sp].every((v) => v == null || v < r.ours)).sort((a, b) => a.gap - b.gap).slice(0, 4);
  const item = (r) => `<li><a href="#" data-team="${esc(r.t.team)}">${esc(r.t.team)}</a>${profileIcon(r.t)} <span class="muted">us #${r.ours} · consensus #${Math.round(r.cons)}</span></li>`;
  $("#cmp-callouts").innerHTML = `
    <div><b>We're higher than everyone</b><small class="muted">Every other system ranks them lower</small><ul>${higher.map(item).join("") || '<li class="muted">None this week</li>'}</ul></div>
    <div><b>We're lower than everyone</b><small class="muted">Every other system ranks them higher</small><ul>${lower.map(item).join("") || '<li class="muted">None this week</li>'}</ul></div>`;
  $("#cmp-callouts").onclick = (e) => { const a = e.target.closest("[data-team]"); if (a) { e.preventDefault(); ranked = rankTeams(DATA ? DATA.teams : cur.teams); openTeam(a.dataset.team); } };

  const draw = () => {
    const show = $("#cmp-show").value;
    const list = rows.filter((r) => show === "all" || r.ours <= 25 || (r.ap && r.ap <= 25) || (r.coaches && r.coaches <= 25) || (r.fpi && r.fpi <= 25) || (r.sp && r.sp <= 25));
    const v = (r, k) => (r[k] == null ? (k === "gap" ? 0 : 999) : r[k]);
    list.sort((a, b) => cmpSort.dir * (v(a, cmpSort.k) - v(b, cmpSort.k)) || a.ours - b.ours);
    const cell = (x) => (x == null ? '<span class="muted">–</span>' : x);
    tb.innerHTML = list.map((r) => `<tr data-team="${esc(r.t.team)}">
      <td><div class="team">${logo(r.t)}<div><b>${esc(r.t.team)}${profileIcon(r.t)}</b><small>${esc(r.t.record)}</small></div></div></td>
      <td class="num"><b>${r.ours}</b></td><td class="num">${cell(r.ap)}</td><td class="num">${cell(r.coaches)}</td>
      <td class="num">${cell(r.fpi)}</td><td class="num">${cell(r.sp)}</td><td class="num">${r.cons == null ? "–" : Math.round(r.cons)}</td>
      <td class="num ${r.gap >= 3 ? "up" : r.gap <= -3 ? "down" : "muted"}"><b>${r.gap == null ? "–" : (r.gap > 0 ? "+" : "") + Math.round(r.gap)}</b></td></tr>`).join("");
    document.querySelectorAll("#cmp-table th[data-k]").forEach((th) => th.classList.toggle("on", th.dataset.k === cmpSort.k));
  };
  $("#cmp-show").onchange = draw;
  document.querySelector("#cmp-table thead").onclick = (e) => {
    const k = e.target.closest("th[data-k]")?.dataset.k;
    if (!k) return;
    cmpSort = cmpSort.k === k ? { k, dir: -cmpSort.dir } : { k, dir: k === "gap" ? -1 : 1 };
    draw();
  };
  tb.onclick = (e) => { const tr = e.target.closest("tr[data-team]"); if (tr) { ranked = rankTeams(DATA ? DATA.teams : cur.teams); openTeam(tr.dataset.team); } };
  draw();
}

// ------------------------------------------------------------------ header search (teams + players, both leagues)
async function allTeams() {
  const out = [];
  for (const lg of Object.keys(INDEX.leagues)) {
    const L = INDEX.leagues[lg];
    const d = await weekData(lg, L.latest.season, L.latest.week).catch(() => null);
    (d?.teams || []).forEach((t) => out.push({ lg, t }));
  }
  return out;
}

function initSearch() {
  const q = $("#gs"), box = $("#gs-results"), wrap = $("#gsearch");
  let timer, results = [];
  const close = () => { box.classList.add("hidden"); wrap.classList.remove("open"); };
  const go = async (r) => {
    close(); q.value = ""; q.blur();
    if (r.type === "player") { const [lg, id] = r.key.split(":"); location.hash = `#/player/${encodeURIComponent(id)}?league=${lg}`; return; }
    const id = r.t.id || (await Live.teamId(r.lg, r.t));
    location.hash = id ? `#/team/${encodeURIComponent(id)}?league=${r.lg}` : `#/rankings?league=${r.lg}&team=${encodeURIComponent(r.t.team)}`;
  };
  q.oninput = () => {
    clearTimeout(timer);
    const text = q.value.trim();
    if (text.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const teams = (await allTeams())
        .map((x) => { const f = fuzzyScore(text, x.t.team), i = initialsScore(text, x.t.team); return { ...x, sc: f == null ? i : i == null ? f : Math.min(f, i) }; })
        .filter((x) => x.sc != null)
        .sort((a, b) => a.sc - b.sc || a.t.team.localeCompare(b.t.team))
        .slice(0, 8).map((x) => ({ type: "team", ...x }));
      const players = (await Live.searchPlayers(text, 8)).map((p) => ({ type: "player", ...p }));
      if (q.value.trim() !== text) return; // user kept typing
      results = [...teams, ...players];
      box.innerHTML = results.length ? `
        ${teams.length ? `<div class="gs-h">Teams</div>` + teams.map((r, i) => `<button data-i="${i}">${logo(r.t)} <span>${esc(r.t.team)}</span><small>${r.lg === "nfl" ? "NFL" : "College"} · ${esc(r.t.conference || "")}</small></button>`).join("") : ""}
        ${players.length ? `<div class="gs-h">Players</div>` + players.map((r, i) => `<button data-i="${teams.length + i}"><span>${esc(r.name)}</span><small>${esc(r.tag)}</small></button>`).join("") : ""}`
        : `<p class="muted gs-empty">No teams or players found.</p>`;
      box.classList.remove("hidden");
      wrap.classList.add("open");
    }, 180);
  };
  box.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) go(results[+b.dataset.i]); };
  q.onkeydown = (e) => {
    if (e.key === "Enter" && results.length && !box.classList.contains("hidden")) { e.preventDefault(); go(results[0]); }
    if (e.key === "Escape") { close(); q.blur(); }
  };
  q.onfocus = () => wrap.classList.add("open");
  q.onblur = () => setTimeout(() => { if (document.activeElement !== q) wrap.classList.remove("open"); }, 150);
  document.addEventListener("pointerdown", (e) => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/input|select|textarea/i.test(document.activeElement?.tagName || "")) { e.preventDefault(); q.focus(); }
  });
}

// ------------------------------------------------------------------ release notes
async function renderNotes() {
  try {
    const notes = await getJSON("data/release_notes.json");
    $("#notes").innerHTML = notes.map((n) => `
      <h3>${esc(new Date(n.date + "T12:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }))}${n.title ? ` <span class="muted">· ${esc(n.title)}</span>` : ""}</h3>
      <ul>${n.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("");
  } catch {
    $("#notes").innerHTML = `<p class="muted">Couldn't load release notes.</p>`;
  }
}

// ------------------------------------------------------------------ model lines (scores + game pages)
// Win chances never show 100% (or 0%) before a game is over: 99.9% is the cap (Terry's rule)
const chancePct = (p, done = false) => {
  const v = Math.max(0, Math.min(1, +p || 0)) * 100;
  if (done) return `${Math.round(v)}%`;
  return v >= 99.5 ? `${Math.min(99.9, v).toFixed(1)}%` : v < 0.5 ? `${Math.max(0.1, v).toFixed(1)}%` : `${Math.round(v)}%`;
};
// The model's favorite and its chance to win -> "Team 64% to win" (we show chances, not our own point spreads)
const chanceText = (g) => {
  const hp = g.home_win_prob != null ? g.home_win_prob : null;
  if (hp == null) return "";
  const home = hp >= 0.5;
  return `${esc(home ? g.home : g.away)} ${chancePct(home ? hp : 1 - hp)} to win`;
};

document.addEventListener("DOMContentLoaded", init);
