// The Cupcake Index: router, league toggle, rankings + picks views.
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
const RANK_VIEWS = new Set(["rankings", "picks", "schedules"]);
const VIEWS = new Set(["rankings", "picks", "schedules", "compare", "about", "updates", "scores", "stats", "standings", "game", "player", "team"]);

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

async function route() {
  const r = parseHash();
  let lg = r.params.get("league");
  if (!INDEX.leagues[lg]) lg = league;
  if (lg !== league || !LG) setLeague(lg);
  Live.stop();
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + r.view));
  document.querySelectorAll("#nav .tab").forEach((a) => a.classList.toggle("active", a.dataset.view === r.view));
  document.querySelectorAll(".rank-ctl").forEach((el) => el.classList.toggle("hidden", !RANK_VIEWS.has(r.view)));
  $("#drawer").classList.add("hidden");
  document.body.classList.remove("drawer-open");
  window.scrollTo(0, 0);
  if (RANK_VIEWS.has(r.view)) {
    await loadWeek();
    const team = r.params.get("team");
    if (r.view === "rankings" && team) openTeam(team);
    if (r.view === "schedules") renderSchedules();
  } else if (r.view === "updates") {
    renderNotes();
  } else if (r.view === "compare") {
    renderCompare();
  } else if (Live[r.view]) {
    Live[r.view](r.arg, r.params);
  }
}

// ------------------------------------------------------------------ init
async function init() {
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
    // game/player/team pages belong to one league; fall back to that league's scores
    const next = ["game", "player", "team"].includes(view) ? "scores" : view;
    location.hash = `#/${next}?league=${l}`;
  };
  $("#updated").textContent = "Rankings updated " + new Date(INDEX.updated).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ".";

  $("#presets").onclick = (e) => {
    const p = e.target.dataset.preset;
    if (p) setWeights(presets()[p] || LG.default_weights);
  };
  $("#reset").onclick = () => setWeights(LG.default_weights);
  // Phones: sliders start collapsed so the rankings table is on the first screen
  $("#weights-toggle").onclick = () => {
    const open = $("#weights").classList.toggle("collapsed") === false;
    $("#weights-toggle").setAttribute("aria-expanded", open);
    $("#weights-toggle").textContent = open ? "Done ▴" : "Adjust ▾";
  };
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
  const closeDrawer = () => { $("#drawer").classList.add("hidden"); document.body.classList.remove("drawer-open"); history.replaceState(null, "", link("rankings")); };
  $("#drawer").onclick = (e) => { if ("close" in e.target.dataset) closeDrawer(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").classList.contains("hidden")) closeDrawer(); });
  $("#table tbody").onclick = (e) => {
    const tr = e.target.closest("tr[data-team]");
    if (tr) openTeam(tr.dataset.team);
  };
  window.addEventListener("hashchange", route);
  await route();
}

function setLeague(l) {
  league = l;
  LG = INDEX.leagues[l];
  loadedKey = null;
  store.set("league", l);
  document.querySelectorAll("#league button").forEach((b) => b.classList.toggle("active", b.dataset.league === l));
  document.body.dataset.league = l;
  $("#profile").innerHTML = `<option value="">All schedule profiles</option>` + Object.entries(PROFILES).map(([k, p]) => `<option value="${k}">${p.icon} ${p.name}</option>`).join("");
  $("#league-tag").textContent = LEAGUE_NAME[l] || l;
  document.querySelectorAll("#nav .tab").forEach((a) => (a.href = link(a.dataset.view)));
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
  const saved = store.get("weights_" + l);
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
  if (key === loadedKey && !force) { render(); renderPicks(); return; }
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
  $("#sp-conf").innerHTML = `<option value="">All conferences</option>` + confs.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#sp-conf").value = confs.includes(spc) ? spc : "";
  const hasAP = DATA.teams.some((t) => t.ap_rank);
  document.body.classList.toggle("no-ap", !hasAP);
  $("#top25-label").lastChild.textContent = hasAP ? " AP Poll top 25 only" : league === "nfl" ? " Top 10 only" : " Top 25 only";
  $("#prior-note").textContent = DATA.prior_weight > 0
    ? `Early season: the preseason expectation still counts like ${DATA.prior_weight} game(s) in the Power rating. It fades to zero in a few weeks.`
    : "";
  renderCotw();
  render();
  renderPicks();
  if (parseHash().view === "schedules") renderSchedules();
}

function renderCotw() {
  const c = DATA.cupcake_of_week;
  $("#cotw").classList.toggle("hidden", !c);
  if (!c) return;
  const opp = `${esc(c.opp)} (${c.fcs ? "FCS" : "#" + esc(c.opp_rank) + " FBS"})`;
  $("#cotw").innerHTML = `<span class="cotw-icon">🧁</span><div><b>Cupcake of the Week</b> <span class="muted">· week ${esc(c.week)}</span><br>
    <a href="#" data-team="${esc(c.team)}">${esc(c.team)}</a> beat up on ${opp}, ${esc(c.score_line)}.
    ${c.espn_id ? `<a class="boxlink" href="${link("game", c.espn_id)}">box score</a>` : ""}</div>`;
  $("#cotw").querySelector("[data-team]").onclick = (e) => { e.preventDefault(); openTeam(c.team); };
}

// ------------------------------------------------------------------ weights
function buildSliders() {
  $("#sliders").innerHTML = LG.factors.map((f) => `
    <div class="slider">
      <div class="slider-top"><span>${esc(f.label)}</span><span id="v-${esc(f.key)}"></span></div>
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

function setWeights(w, rev = false) {
  reverse = rev;
  weights = Object.fromEntries(LG.factors.map((f) => [f.key, (w || {})[f.key] ?? 0]));
  store.set("weights_" + league, weights);
  LG.factors.forEach((f) => ($("#w-" + f.key).value = weights[f.key]));
  showWeights();
  if (DATA) render();
}

const factor = (key) => LG.factors.find((f) => f.key === key);

// "hi" = the column's displayed value high to low (for Cupcake: most cupcakes = #1)
function applySolo(key, dir) {
  soloDir = dir;
  setWeights({ [key]: 100 }, dir === "lo");
}

// Header clicks cycle: high to low -> low to high -> back to the previous blend
function solo(key) {
  if (soloKey() === key && soloDir === "hi") return applySolo(key, "lo");
  if (soloKey() === key) return restoreBlend();
  if (!soloKey()) beforeSolo = { ...weights };
  applySolo(key, "hi");
}

function restoreBlend() {
  setWeights(beforeSolo || LG.default_weights);
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
  const list = composite(d.teams, loadWeights(lg), info.factors);
  return { byName: new Map(list.map((t) => [t.team, t])), byId: new Map(list.filter((t) => t.id).map((t) => [String(t.id), t])), data: d };
}

// ------------------------------------------------------------------ rankings table
const heat = (v) => `background:hsla(${Math.round(v * 1.3)},65%,45%,.18)`;
const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : "");
// Serve images at display size (x2 for sharp phone screens) through ESPN's resizer.
// Full-size logos are ~12KB and headshots ~230KB; thumbnails are ~1-7KB.
function thumb(url, w, h = w) {
  if (!safeUrl(url)) return "";
  const cfbd = url.match(/^https:\/\/cdn\.collegefootballdata\.com\/logos\/\d+\/(\d+)\.png$/); // CFBD logo ids are ESPN ids
  const path = cfbd ? `/i/teamlogos/ncaa/500/${cfbd[1]}.png` : (url.match(/^https:\/\/a\.espncdn\.com(\/i\/[^?]+)$/) || [])[1];
  return path ? `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(path)}&w=${w * 2}&h=${h * 2}` : url;
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
  gauntlet: { icon: "🛡️", name: "Gauntlet", desc: "Hard schedule, no fluff." },
  barbell: { icon: "🏋️", name: "Barbell", desc: "Hard schedule, but padded with cupcakes too." },
  grind: { icon: "⚙️", name: "Honest Grind", desc: "Easier schedule, but no padding. They played their peers." },
  walk: { icon: "🧁", name: "Cupcake Walk", desc: "Easy schedule and padded. The records to be most skeptical of." },
};
const HARD_SOS = 55, PADDED = 60; // score thresholds (50 = average)
function profileOf(t) {
  if (t.scores.cupcake == null || !(t.wins + t.losses)) return null;
  const hard = t.scores.sos >= HARD_SOS, padded = t.scores.cupcake >= PADDED;
  return hard ? (padded ? "barbell" : "gauntlet") : padded ? "walk" : "grind";
}
const profileIcon = (t) => {
  const k = profileOf(t);
  return k ? ` <span class="prof" title="Schedule profile: ${PROFILES[k].name}. ${PROFILES[k].desc}">${PROFILES[k].icon}</span>` : "";
};

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
  ? ` <span class="pill untested" title="No win over a top-${TESTED[league].quality} team yet. Best win: ${esc(bestWinText(bestWin(t)))}">Beaten Nobody</span>` : "";

function cotwTag(t) {
  const c = DATA.cupcake_of_week;
  if (!c || c.team !== t.team) return "";
  return ` <span class="pill cup-badge" title="Cupcake of the Week: ${esc(c.score_line)} over ${esc(c.opp)}">🧁 of the week</span>`;
}

function apTag(t) {
  if (t.ap_rank && t.rank - t.ap_rank >= 10) return `<span class="pill over" title="AP has them ${t.rank - t.ap_rank} spots higher">Overrated</span>`;
  if ((t.ap_rank && t.ap_rank - t.rank >= 10) || (!t.ap_rank && t.rank <= 15 && !document.body.classList.contains("no-ap"))) return `<span class="pill under" title="Model ranks them well above the AP poll">Underrated</span>`;
  return "";
}

function render() {
  if (!DATA) return;
  ranked = rankTeams(DATA.teams);
  const prevRank = PREV ? Object.fromEntries(rankTeams(PREV.teams).map((t) => [t.team, t.rank])) : {};
  const q = $("#search").value.trim().toLowerCase(), conf = $("#conf").value, top = $("#top25").checked, prof = league === "cfb" ? $("#profile").value : "";
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
  $("#table tbody").innerHTML = rows.map((t) => {
    const p = prevRank[t.team], d = p ? p - t.rank : 0, pd = pointDiff(t);
    const mv = !p ? "" : d > 0 ? `<span class="up">▲${d}</span>` : d < 0 ? `<span class="down">▼${-d}</span>` : `<span class="muted">–</span>`;
    const chips = LG.factors.map((f) => {
      const v = t.scores[f.key];
      return `<span class="chip${only === f.key ? " sel" : ""}" style="${heat(f.invert ? 100 - v : v)}" title="${esc(f.label)}: ${esc(v)}">${Math.round(v)}</span>`;
    }).join("");
    return `<tr data-team="${esc(t.team)}">
      <td class="num rank">${t.rank}</td><td class="mv">${mv}</td>
      <td><div class="team">${logo(t)}<div><b>${esc(t.team)}${profileIcon(t)}${cotwTag(t)}${untestedTag(t)}${apTag(t)}</b><small>${esc(t.conference || "")}</small></div></div></td>
      <td class="num">${esc(t.record)}</td>
      <td class="num diff ${pd.diff > 0 ? "up" : pd.diff < 0 ? "down" : ""}" title="${pd.pf} scored, ${pd.pa} allowed">${pd.diff > 0 ? "+" : ""}${pd.diff}</td>
      <td class="num ap">${t.ap_rank ? esc(t.ap_rank) : '<span class="muted">–</span>'}</td>
      <td><div class="score">${t.comp.toFixed(1)}<span class="bar"><i style="width:${+t.comp || 0}%"></i></span></div></td>
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
  const f = LG.factors.filter((x) => !x.invert).map((x) => ({ ...x, v: t.scores[x.key] })).sort((a, b) => b.v - a.v);
  const out = [];
  if (t.next_qb && t.usual_qb && t.next_qb !== t.usual_qb) out.push(`QB change: ${t.next_qb} is listed to start next, not ${t.usual_qb}, who started most games so far. The rating doesn't account for this.`);
  const strong = f.filter((x) => x.v >= 65).slice(0, 2);
  if (strong.length) out.push("Strengths: " + strong.map((x) => `${x.label.toLowerCase()} (${Math.round(x.v)})`).join(", ") + ".");
  const weak = f.filter((x) => x.v < 40).slice(-2).reverse();
  if (weak.length) out.push("Weaknesses: " + weak.map((x) => `${x.label.toLowerCase()} (${Math.round(x.v)})`).join(", ") + ".");
  const games = t.wins + t.losses, cups = t.fcs_games + t.weak_games;
  if (league === "cfb" && cups >= 2) out.push(`Cupcake score ${Math.round(t.scores.cupcake)}: ${cups} of ${games} games were cupcakes for a team this good (${t.fcs_games} FCS, ${t.weak_games} FBS teams far below them). Those wins barely count.`);
  if (isUntested(t)) out.push(`Beaten Nobody: no win over a top-${TESTED[league].quality} team yet. Best win: ${bestWinText(bestWin(t))}.`);
  const cw = t.cotw_weeks || [];
  if (cw.length) out.push(`🧁 Cupcake of the Week ${cw.length === 1 ? "once" : cw.length + " times"} this season (week ${cw.join(", ")}).`);
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
  const sched = t.schedule.map((g) => {
    const tags = [g.fcs && '<span class="pill over">FCS</span>', g.cupcake && '<span class="pill over">cupcake</span>',
      !g.fcs && g.opp_rank <= (nfl ? 8 : 25) && `<span class="pill under">top ${nfl ? 8 : 25}</span>`].filter(Boolean).join(" ");
    const opp = `${g.loc === "A" ? "@ " : g.loc === "N" ? "vs " : ""}${g.opp_rank && !g.fcs ? `<span class="muted">#${esc(g.opp_rank)}</span> ` : ""}${esc(g.opp)}${tags ? " " + tags : ""}`
      + (g.qb ? `<small class="muted">QB ${esc(g.qb)}${g.qb !== t.usual_qb && t.usual_qb ? " ⚠" : ""}${g.rest_diff ? ` · ${g.rest_diff > 0 ? "+" : ""}${esc(g.rest_diff)} days rest vs. opp` : ""}</small>` : "");
    const box = g.espn_id ? ` <a class="boxlink" href="${link("game", g.espn_id)}">${g.upcoming ? "preview" : "box score"}</a>` : "";
    if (g.upcoming) return `<tr><td>${esc(g.week)}</td><td>${opp}</td><td colspan="2" class="muted">Model: ${g.spread > 0 ? "favored by " + esc(g.spread) : "underdog by " + esc(-g.spread)} (${Math.round(g.win_prob * 100)}%)${box}</td></tr>`;
    return `<tr><td>${esc(g.week)}</td><td>${opp}</td><td><span class="${g.result === "W" ? "W" : "L"}">${esc(g.result)}</span> ${esc(g.score)}${box}</td>
      <td class="num" title="A benchmark team wins this game ${Math.round((1 - g.difficulty) * 100)}% of the time">${Math.round(g.difficulty * 100)}%</td></tr>`;
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
      ${nfl ? `<div class="stat"><small>Main starting QB</small><b>${esc(t.usual_qb || "—")}</b></div>`
            : `<div class="stat"><small>FCS games</small><b>${esc(t.fcs_games)}</b></div><div class="stat"><small>FBS mismatches</small><b>${esc(t.weak_games)}</b></div>`}
      ${!nfl && profileOf(t) ? `<div class="stat wide-stat"><small>Schedule profile</small><b>${PROFILES[profileOf(t)].icon} ${PROFILES[profileOf(t)].name}</b><small class="muted">${PROFILES[profileOf(t)].desc} <a href="${link("schedules")}">See all →</a></small></div>` : ""}
    </div>
    <h3>Factor scores</h3>
    ${LG.factors.map((f) => `<div class="frow" title="${esc(f.help)}"><span>${esc(f.label)}</span><span class="bar${f.invert ? " inv" : ""}"><i style="width:${+t.scores[f.key] || 0}%"></i></span><b class="num">${Math.round(t.scores[f.key])}</b></div>`).join("")}
    <p class="note">Power rating = points better than an average ${nfl ? "NFL" : "FBS"} team on a neutral field.${nfl ? "" : " Cupcake: higher = softer schedule for a team at this level, counting only games already played."}</p>
    <h3>Schedule</h3>
    <table class="sched"><thead><tr><th>Wk</th><th>Opponent</th><th>Result</th><th class="num" title="How hard it is for a ${bench} to win this game">Difficulty</th></tr></thead><tbody>${sched}</tbody></table>
    <p class="note">Difficulty is the chance a typical ${bench} would lose this game.${nfl ? " ⚠ = a different QB than the team's usual starter." : " Beating FCS teams is close to 0%."}</p>`;
  $("#drawer").classList.remove("hidden");
  document.body.classList.add("drawer-open"); // stop the page behind from scrolling on phones
  history.replaceState(null, "", link("rankings", null, { team: name }));
  Live.teamId(league, t).then((id) => {
    const a = $("#team-page-link");
    if (a && id) a.href = link("team", id); else if (a) a.remove();
  });
}

// ------------------------------------------------------------------ schedule profile chart
function renderSchedules() {
  if (!DATA || league !== "cfb") {
    $("#sp-chart").innerHTML = `<p class="muted" style="padding:16px">Schedule profiles are a college football feature. NFL teams don't schedule cupcakes.</p>`;
    $("#sp-legend").innerHTML = "";
    return;
  }
  const all = composite(DATA.teams).filter((t) => profileOf(t));
  const show = $("#sp-show").value, conf = $("#sp-conf").value;
  let teams = show === "ap" ? all.filter((t) => t.ap_rank) : show === "all" ? all : all.filter((t) => t.rank <= +show);
  if (conf) teams = all.filter((t) => t.conference === conf);
  const xs = all.map((t) => t.scores.sos), ys = all.map((t) => t.scores.cupcake);
  // padded domain so logos at the extremes aren't clipped or covering the corner labels
  const x0 = Math.min(...xs) - 7, x1 = Math.max(...xs) + 9;
  const y0 = Math.min(...ys) - 12, y1 = Math.max(...ys) + 10;
  const px = (v) => ((v - x0) / (x1 - x0)) * 100, py = (v) => 100 - ((v - y0) / (y1 - y0)) * 100;
  const cx = px(HARD_SOS), cy = py(PADDED);
  const quad = (k, l, t, w, h, pos) => `<div class="sp-q sp-${k}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%"><span class="sp-ql ${pos}">${PROFILES[k].icon} ${PROFILES[k].name}</span></div>`;
  $("#sp-chart").innerHTML = `
    ${quad("walk", 0, 0, cx, cy, "tl")}${quad("barbell", cx, 0, 100 - cx, cy, "tr")}
    ${quad("grind", 0, cy, cx, 100 - cy, "bl")}${quad("gauntlet", cx, cy, 100 - cx, 100 - cy, "br")}
    <span class="sp-axis sp-x">Schedule: harder →</span><span class="sp-axis sp-y">Cupcake: more padded →</span>
    ${teams.map((t) => `<button class="sp-dot" data-team="${esc(t.team)}" style="left:${px(t.scores.sos)}%;top:${py(t.scores.cupcake)}%"
        title="#${t.rank} ${esc(t.team)} (${esc(t.record)}) · Schedule ${Math.round(t.scores.sos)} · Cupcake ${Math.round(t.scores.cupcake)}">
        ${safeUrl(t.logo) ? `<img src="${esc(thumb(t.logo, 26))}" alt="${esc(t.team)}" width="26" height="26" loading="lazy" decoding="async">` : `<span>${esc(t.team.slice(0, 3))}</span>`}</button>`).join("")}`;
  $("#sp-chart").onclick = (e) => { const b = e.target.closest("[data-team]"); if (b) { ranked = rankTeams(DATA.teams); openTeam(b.dataset.team); } };
  const counts = Object.fromEntries(Object.keys(PROFILES).map((k) => [k, teams.filter((t) => profileOf(t) === k)]));
  $("#sp-legend").innerHTML = Object.entries(PROFILES).map(([k, p]) => `<div class="sp-leg sp-${k}"><b>${p.icon} ${p.name}</b> <span class="muted">(${counts[k].length})</span><small>${p.desc}</small>
    <small>${counts[k].slice(0, 6).map((t) => `#${t.rank} ${esc(t.team)}`).join(", ")}${counts[k].length > 6 ? "…" : ""}</small></div>`).join("");
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
  const ours = composite(cur.teams);
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

// ------------------------------------------------------------------ picks
const BOOK_ABBR = { DraftKings: "DK", Bovada: "Bovada", "ESPN Bet": "ESPN", FanDuel: "FD", BetMGM: "MGM", Caesars: "CZR", Consensus: "Consensus" };
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
// Home-perspective margin (positive = home favored) -> "Team -7.5"
const lineText = (g, margin) => margin === 0 ? "Pick'em" : `${esc(margin > 0 ? g.home : g.away)} −${Math.abs(margin).toFixed(1)}`;
const rec = (r) => r && r.games ? `${r.correct}-${r.games - r.correct} (${((100 * r.correct) / r.games).toFixed(1)}%)` : "—";

function qbNote(g) {
  if (!g.home_qb && !g.away_qb) return "";
  const usual = Object.fromEntries(DATA.teams.map((t) => [t.team, t.usual_qb]));
  const one = (team, qb) => qb ? `${esc(qb)}${usual[team] && usual[team] !== qb ? ' <b class="hot" title="Not the usual starter">⚠</b>' : ""}` : "?";
  return `<small class="muted">QBs: ${one(g.away, g.away_qb)} vs. ${one(g.home, g.home_qb)}</small>`;
}

function renderPicks() {
  if (!DATA) return;
  const p = DATA.predictions || [];
  $("#picks-title").textContent = `Week ${DATA.week + 1} picks vs. the sportsbooks (made after week ${DATA.week})`;
  const a = LG.seasons[$("#season").value].accuracy;
  $("#acc").innerHTML = a.games ? `
    <b>Season record.</b> Straight up: model ${rec(a.model_su_lined || a)} vs. books' favorite ${rec(a.vegas_su)}.
    Against the spread: ${rec(a.ats)}, and on 3+ point disagreements, ${rec(a.ats_strong)}. You need 52.4% to break even on a bet at standard −110 odds.
    <br>The books usually know more (injuries, weather, sharp money). Where the model disagrees, treat it as a conversation starter, not a bet.`
    : "Picks are graded once the games are played.";
  const edgeKey = (g) => (g.edge == null ? -1 : Math.abs(g.edge));
  const rows = [...p].sort((x, y) => edgeKey(y) - edgeKey(x) || Math.abs(x.spread) - Math.abs(y.spread));
  $("#picks tbody").innerHTML = rows.length ? rows.map((g) => {
    const books = g.books ? g.books.map((b) => {
      // Book lines are home-side; show them from the same favorite as the median line
      const favHome = g.vegas >= 0, bookFavHome = b.spread <= 0;
      const txt = b.spread === 0 ? "PK" : (bookFavHome === favHome ? "" : esc(bookFavHome ? g.home : g.away) + " ") + "−" + Math.abs(b.spread);
      const tip = `${b.book}${b.total ? " · O/U " + b.total : ""}${b.open != null ? ` · opened ${g.home} ${signed(b.open)}` : ""}`;
      return `<span class="book" title="${esc(tip)}">${esc(BOOK_ABBR[b.book] || b.book)} ${txt}</span>`;
    }).join("") : '<span class="muted">No line yet</span>';
    const edge = g.edge == null ? '<span class="muted">—</span>'
      : `<b class="${Math.abs(g.edge) >= 3 ? "hot" : ""}">${esc(g.ats_pick)} ${signed(g.best_line)}</b><small class="muted">edge ${Math.abs(g.edge).toFixed(1)} · best at ${esc(BOOK_ABBR[g.best_book] || g.best_book)}</small>`;
    let res = '<span class="muted">—</span>';
    if (g.actual !== undefined) {
      const mark = (ok) => ok == null ? '<span class="muted">push</span>' : `<span class="${ok ? "W" : "L"}">${ok ? "✓" : "✗"}</span>`;
      res = `${esc(g.actual > 0 ? g.home : g.away)} by ${Math.abs(g.actual)}<small class="muted">SU ${mark(g.correct)}${g.edge != null ? " · ATS " + mark(g.ats_correct) : ""}</small>`;
    }
    const wp = g.pick === g.home ? g.home_win_prob : 1 - g.home_win_prob;
    const matchup = `${esc(g.away)} <span class="muted">@</span> ${esc(g.home)}`;
    return `<tr><td>${g.espn_id ? `<a href="${link("game", g.espn_id)}">${matchup}</a>` : matchup}${qbNote(g)}</td>
      <td>${lineText(g, g.spread)}<small class="muted">${esc(g.pick)} wins ${Math.round(wp * 100)}%</small></td>
      <td>${g.vegas != null ? lineText(g, g.vegas) : '<span class="muted">—</span>'}<div class="books">${books}</div></td>
      <td>${edge}</td><td>${res}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="muted">No games scheduled.</td></tr>`;
}

document.addEventListener("DOMContentLoaded", init);
