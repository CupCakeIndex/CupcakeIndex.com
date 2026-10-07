// Stats > Visualize: make your own chart from any stat (bar, line, pie, scatter, radar) for any weeks and seasons,
// to back up an argument on X. Data: docs/data/viz/<league>_<season>.json (src/viz_data.py, weekly): one row per team
// or player per game, raw counts only, so any range of weeks adds up exactly and rates are total / total.
// NFL from nflverse (official play-by-play, with EPA); college from CollegeFootballData.com (box scores, PPA = college EPA).
// Every setting lives in the link, so a chart can be shared. Charts by Chart.js (cdnjs), loaded the first time.
const Viz = (() => {
  const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  const files = new Map();
  let chart = null, idx = null;

  // ---------------------------------------------------------------- the stats
  // v(S, g) -> value from summed columns S over g games; den(S) for rates (who qualifies); low = lower is better;
  // count = a total that can be shown per game; need = columns it needs (stats a league's data lacks are hidden)
  const div = (a, b) => (b ? a / b : null);
  const T = [ // teams
    ["Scoring", [
      ["pts", "Points scored", (S) => S.pts, { count: 1 }],
      ["opp_pts", "Points allowed", (S) => S.opp_pts, { count: 1, low: 1 }],
      ["margin", "Point margin", (S) => S.pts - S.opp_pts, { count: 1, fmt: "+" }],
    ]],
    ["Offense", [
      ["yds", "Total yards", (S) => S.pass_yds + S.rush_yds, { count: 1 }],
      ["ypp", "Yards per play", (S) => div(S.pass_yds + S.rush_yds, S.plays), { den: (S) => S.plays, d: 2 }],
      ["pass_yds", "Passing yards", (S) => S.pass_yds, { count: 1 }],
      ["rush_yds", "Rushing yards", (S) => S.rush_yds, { count: 1 }],
      ["ypa", "Yards per pass attempt", (S) => div(S.pass_yds, S.att), { den: (S) => S.att, d: 2 }],
      ["ypc", "Yards per carry", (S) => div(S.rush_yds, S.carries), { den: (S) => S.carries, d: 2 }],
      ["cmp_pct", "Completion %", (S) => div(100 * S.cmp, S.att), { den: (S) => S.att, pct: 1 }],
      ["pass_td", "Passing TDs", (S) => S.pass_td, { count: 1 }],
      ["rush_td", "Rushing TDs", (S) => S.rush_td, { count: 1 }],
      ["first_downs", "First downs", (S) => S.first_downs, { count: 1 }],
      ["third", "Third-down %", (S) => div(100 * S.third_conv, S.third_att), { den: (S) => S.third_att, pct: 1, need: ["third_att"] }],
      ["giveaways", "Turnovers (giveaways)", (S) => S.int + S.fum_lost, { count: 1, low: 1 }],
      ["sacked", "Sacks allowed", (S) => S.sacked, { count: 1, low: 1, need: ["sacked"] }],
    ]],
    ["Defense", [
      ["opp_yds", "Yards allowed", (S) => S.opp_yds ?? S.opp_pass_yds + S.opp_rush_yds, { count: 1, low: 1 }],
      ["opp_pass_yds", "Passing yards allowed", (S) => S.opp_pass_yds, { count: 1, low: 1 }],
      ["opp_rush_yds", "Rushing yards allowed", (S) => S.opp_rush_yds, { count: 1, low: 1 }],
      ["def_sacks", "Sacks", (S) => S.def_sacks, { count: 1 }],
      ["def_int", "Interceptions", (S) => S.def_int, { count: 1 }],
      ["takeaways", "Takeaways", (S) => S.def_int + S.def_fr, { count: 1, need: ["def_fr"] }],
      ["to_margin", "Turnover margin", (S) => S.def_int + S.def_fr - S.int - S.fum_lost, { count: 1, fmt: "+", need: ["def_fr"] }],
      ["tfl", "Tackles for loss", (S) => S.tfl, { count: 1, need: ["tfl"] }],
    ]],
    ["Discipline and kicking", [
      ["pen", "Penalties", (S) => S.pen, { count: 1, low: 1 }],
      ["pen_yds", "Penalty yards", (S) => S.pen_yds, { count: 1, low: 1 }],
      ["fg_pct", "Field goal %", (S) => div(100 * S.fg_made, S.fg_att), { den: (S) => S.fg_att, pct: 1, need: ["fg_att"] }],
    ]],
    ["Cupcake Index (our model)", [
      ["win_pct", "Win %", (S, g) => div(100 * S.wins, g), { den: (S, g) => 1, pct: 1, need: ["pts"] }],
      ["ci_rating", "Power rating (our model)", (S) => S.ci_rating, { d: 1, fmt: "+", season: 1 }],
      ["ci_rank", "Our ranking", (S) => S.ci_rank, { low: 1, season: 1 }],
      ["ci_sos", "Schedule strength (0–100, higher = harder)", (S) => S.ci_sos, { d: 0, season: 1 }],
      ["ci_cupcake", "Cupcake score (0–100, higher = more padded)", (S) => S.ci_cupcake, { d: 0, low: 1, season: 1, lg: "cfb" }],
      ["ci_resume", "Résumé score (0–100)", (S) => S.ci_resume, { d: 0, season: 1 }],
      ["ci_eff", "Efficiency score (0–100)", (S) => S.ci_eff, { d: 0, season: 1 }],
    ]],
    ["Advanced", [
      ["epa_play", "EPA per play (offense)", (S) => S.adv_plays != null ? div(S.epa, S.adv_plays) : div(S.pass_epa + S.rush_epa, S.plays), { den: (S) => S.adv_plays ?? S.plays, d: 3 }],
      ["def_epa_play", "EPA per play allowed (defense)", (S) => S.def_adv_plays != null ? div(S.def_epa, S.def_adv_plays) : div(S.opp_epa, S.opp_plays), { den: (S) => S.def_adv_plays ?? S.opp_plays, d: 3, low: 1 }],
      ["net_epa", "Net EPA per play (offense minus defense)", (S) => { const o = S.adv_plays != null ? div(S.epa, S.adv_plays) : div(S.pass_epa + S.rush_epa, S.plays), d = S.def_adv_plays != null ? div(S.def_epa, S.def_adv_plays) : div(S.opp_epa, S.opp_plays); return o == null || d == null ? null : o - d; }, { den: (S) => S.adv_plays ?? S.plays, d: 3, fmt: "+" }],
      ["pass_epa_play", "EPA per pass play", (S) => S.pass_plays != null ? div(S.pass_epa, S.pass_plays) : div(S.pass_epa, S.att + S.sacked), { den: (S) => S.pass_plays ?? S.att + S.sacked, d: 3 }],
      ["rush_epa_play", "EPA per rush", (S) => S.rush_plays != null ? div(S.rush_epa, S.rush_plays) : div(S.rush_epa, S.carries), { den: (S) => S.rush_plays ?? S.carries, d: 3 }],
      ["succ", "Success rate (offense)", (S) => div(100 * S.succ, S.adv_plays), { den: (S) => S.adv_plays, pct: 1, need: ["succ"] }],
      ["def_succ", "Success rate allowed (defense)", (S) => div(100 * S.def_succ, S.def_adv_plays), { den: (S) => S.def_adv_plays, pct: 1, low: 1, need: ["def_succ"] }],
      ["epa_total", "Total EPA (offense)", (S) => S.epa ?? S.pass_epa + S.rush_epa, { count: 1, d: 1 }],
    ]],
  ];
  const rating = (S) => { // NFL passer rating
    if (!S.att) return null;
    const c = (x) => Math.max(0, Math.min(2.375, x));
    return (c((S.cmp / S.att - 0.3) * 5) + c((S.pass_yds / S.att - 3) * 0.25) + c((S.pass_td / S.att) * 20) + c(2.375 - (S.int / S.att) * 25)) / 6 * 100;
  };
  const P = [ // players
    ["Passing", [
      ["pass_yds", "Passing yards", (S) => S.pass_yds, { count: 1, pos: "QB" }],
      ["pass_td", "Passing TDs", (S) => S.pass_td, { count: 1, pos: "QB" }],
      ["int", "Interceptions thrown", (S) => S.int, { count: 1, low: 1, pos: "QB" }],
      ["cmp_pct", "Completion %", (S) => div(100 * S.cmp, S.att), { den: (S) => S.att, pct: 1, pos: "QB" }],
      ["ypa", "Yards per attempt", (S) => div(S.pass_yds, S.att), { den: (S) => S.att, d: 2, pos: "QB" }],
      ["rating", "Passer rating (NFL formula)", rating, { den: (S) => S.att, d: 1, pos: "QB", lg: "nfl" }],
      ["eff", "Passing efficiency (NCAA formula)", (S) => div(8.4 * S.pass_yds + 330 * S.pass_td + 100 * S.cmp - 200 * S.int, S.att), { den: (S) => S.att, d: 1, pos: "QB", lg: "cfb" }],
      ["sacked", "Times sacked", (S) => S.sacked, { count: 1, low: 1, pos: "QB", lg: "nfl" }],
    ]],
    ["Rushing and receiving", [
      ["rush_yds", "Rushing yards", (S) => S.rush_yds, { count: 1, pos: "RB" }],
      ["rush_td", "Rushing TDs", (S) => S.rush_td, { count: 1, pos: "RB" }],
      ["carries", "Carries", (S) => S.carries, { count: 1, pos: "RB" }],
      ["ypc", "Yards per carry", (S) => div(S.rush_yds, S.carries), { den: (S) => S.carries, d: 2, pos: "RB" }],
      ["rec", "Receptions", (S) => S.rec, { count: 1, pos: "WR" }],
      ["targets", "Targets", (S) => S.targets, { count: 1, pos: "WR", lg: "nfl" }],
      ["rec_yds", "Receiving yards", (S) => S.rec_yds, { count: 1, pos: "WR" }],
      ["rec_td", "Receiving TDs", (S) => S.rec_td, { count: 1, pos: "WR" }],
      ["ypr", "Yards per catch", (S) => div(S.rec_yds, S.rec), { den: (S) => S.rec, d: 1, pos: "WR" }],
      ["catch_pct", "Catch rate", (S) => div(100 * S.rec, S.targets), { den: (S) => S.targets, pct: 1, pos: "WR", lg: "nfl" }],
      ["yac", "Yards after catch", (S) => S.yac, { count: 1, pos: "WR", lg: "nfl" }],
      ["air_yds", "Air yards", (S) => S.air_yds, { count: 1, pos: "WR", lg: "nfl" }],
      ["scrim", "Scrimmage yards", (S) => S.rush_yds + S.rec_yds, { count: 1 }],
      ["tds", "Rushing + receiving TDs", (S) => S.rush_td + S.rec_td, { count: 1 }],
      ["ppr", "Fantasy points (PPR)", (S) => S.ppr, { count: 1, d: 1, lg: "nfl" }],
    ]],
    ["Defense and kicking", [
      ["tackles", "Tackles", (S) => S.tackles, { count: 1, pos: "DEF" }],
      ["def_sacks", "Sacks", (S) => S.def_sacks, { count: 1, d: 1, pos: "DEF" }],
      ["tfl", "Tackles for loss", (S) => S.tfl, { count: 1, d: 1, pos: "DEF" }],
      ["qb_hits", "QB hits (college: hurries)", (S) => S.qb_hits, { count: 1, pos: "DEF" }],
      ["pd", "Passes defended", (S) => S.pd, { count: 1, pos: "DEF" }],
      ["def_int", "Interceptions", (S) => S.def_int, { count: 1, pos: "DEF" }],
      ["fg_made", "Field goals made", (S) => S.fg_made, { count: 1, pos: "K" }],
      ["fg_pct", "Field goal %", (S) => div(100 * S.fg_made, S.fg_att), { den: (S) => S.fg_att, pct: 1, pos: "K" }],
    ]],
    ["Advanced", [
      ["epa_total", "Total EPA (pass + rush + catch)", (S) => S.pass_epa + S.rush_epa + S.rec_epa, { count: 1, d: 1, lg: "nfl" }],
      ["epa_db", "EPA per dropback", (S) => div(S.pass_epa, S.att + S.sacked), { den: (S) => S.att + S.sacked, d: 3, pos: "QB", lg: "nfl" }],
      ["epa_rush", "EPA per rush", (S) => div(S.rush_epa, S.carries), { den: (S) => S.carries, d: 3, pos: "RB", lg: "nfl" }],
      ["epa_tgt", "EPA per target", (S) => div(S.rec_epa, S.targets), { den: (S) => S.targets, d: 3, pos: "WR", lg: "nfl" }],
      ["ppa_total", "Total PPA (college EPA, full season)", (S) => S.ss_epa, { d: 1, lg: "cfb", season: 1 }],
      ["ppa_play", "PPA per play (college EPA, full season)", (S) => div(S.ss_epa, S.ss_epa_plays), { den: (S) => S.ss_epa_plays, d: 3, lg: "cfb", season: 1 }],
      ["ppa_pass", "Passing PPA (full season)", (S) => S.ss_pass_epa, { d: 1, lg: "cfb", season: 1, pos: "QB" }],
      ["ppa_rush", "Rushing PPA (full season)", (S) => S.ss_rush_epa, { d: 1, lg: "cfb", season: 1 }],
    ]],
  ];
  const statsFor = (who, D) => (who === "players" ? P : T).map(([g, list]) => [g, list.filter(([, , , o]) =>
    (!o.lg || o.lg === D.league) && (!o.need || o.need.every((c) => (who === "players" ? D.pcols : D.tcols).includes(c))))]).filter(([, l]) => l.length);
  const findStat = (who, D, k) => statsFor(who, D).flatMap(([, l]) => l).find((s) => s[0] === k);

  // ---------------------------------------------------------------- state (all in the link)
  const DEF = { who: "teams", type: "bar", stat: "epa_play", y: "pts", from: "", to: "", wk1: "", wk2: "", per: "game", top: "10",
    group: "", team: "", pos: "", pick: "", order: "best", cum: "", radar: "" };
  let st = { ...DEF };
  const save = () => {
    const q = new URLSearchParams({ league, show: "visualize" });
    Object.entries(st).forEach(([k, v]) => { if (v !== "" && v !== DEF[k]) q.set(k, v); });
    history.replaceState(null, "", `#/stats?${q}`);
  };

  async function file(season) {
    const k = `${league}_${season}`;
    if (!files.has(k)) files.set(k, getJSON(`data/viz/${k}.json`).catch(() => null));
    return files.get(k);
  }
  // our model's numbers for that season (the latest rankings file), keyed like the chart data: CFB by id, NFL by name
  async function ours(D) {
    if (D.ours) return;
    D.ours = {};
    const weeks = INDEX.leagues[D.league]?.seasons?.[D.season]?.weeks || [];
    if (!weeks.length) return;
    const R = await getJSON(`data/${D.league}/${D.season}/week_${weeks.at(-1)}.json`).catch(() => null);
    const byName = Object.fromEntries(Object.entries(D.teams).map(([k, t]) => [t[0], k]));
    for (const t of R?.teams || []) {
      const k = D.league === "cfb" ? `cfb:${t.id}` : byName[t.team];
      if (k) D.ours[k] = { ci_rating: t.rating, ci_rank: t.power_rank, ci_sos: t.scores?.sos, ci_cupcake: t.scores?.cupcake, ci_resume: t.scores?.resume, ci_eff: t.scores?.efficiency };
    }
  }
  async function loadChartJs() {
    if (window.Chart) return;
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = CHART_JS; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }

  // ---------------------------------------------------------------- crunching
  // rows -> { key: {S: summed columns, g: games, wk: {week: S}} } for one season, weeks wk1..wk2
  function sum(D, who, w1, w2, byWeek) {
    const cols = who === "players" ? D.pcols : D.tcols, rows = who === "players" ? D.prows : D.trows, out = {};
    for (const r of rows) {
      if (r[1] < w1 || r[1] > w2) continue;
      const o = out[r[0]] || (out[r[0]] = { S: Object.fromEntries(cols.map((c) => [c, 0])), g: 0, wk: {}, team: r[2] });
      o.g++;
      o.team = r[2];
      cols.forEach((c, i) => { o.S[c] += r[i + 3]; });
      if (who === "teams") o.S.wins = (o.S.wins || 0) + (r[3] > r[4] ? 1 : r[3] === r[4] ? 0.5 : 0); // pts vs opp_pts
      if (byWeek) { const w = o.wk[r[1]] || (o.wk[r[1]] = Object.fromEntries(cols.map((c) => [c, 0]))); cols.forEach((c, i) => { w[c] += r[i + 3]; }); }
    }
    if (who === "players" && D.pseason) for (const [k, v] of Object.entries(D.pseason)) if (out[k]) D.pseason_cols.forEach((c, i) => { out[k].S["ss_" + c] = v[i]; });
    if (who === "teams") for (const k in out) if (!D.tcols.includes("opp_yds")) out[k].S.opp_yds = out[k].S.opp_pass_yds + out[k].S.opp_rush_yds;
    return out;
  }
  const value = (stat, S, g, per) => { const v = stat[2](S, g); return v == null ? null : stat[3].count && per === "game" && g ? v / g : v; };
  const POS_OF = (pos, S) => {
    const p = (pos || "").toUpperCase();
    if (p === "QB") return "QB";
    if (["RB", "FB", "HB"].includes(p)) return "RB";
    if (["WR", "TE"].includes(p)) return "WR";
    if (["K", "PK", "P"].includes(p)) return "K";
    if (p) return "DEF";
    return S.att >= 10 ? "QB" : S.fg_att ? "K" : S.carries > S.rec && S.carries >= 5 ? "RB" : S.rec ? "WR" : "DEF"; // college defenders have no position on file
  };
  const fmt = (stat, v, per) => {
    if (v == null || Number.isNaN(v)) return "–";
    const o = stat[3], d = o.pct ? 1 : o.d ?? (o.count && per === "game" ? 1 : 0);
    const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    return (v < 0 ? "-" : o.fmt === "+" && v > 0 ? "+" : "") + s + (o.pct ? "%" : "");
  };

  // ---------------------------------------------------------------- page
  async function render(params) {
    const el = document.getElementById("view-stats");
    st = { ...DEF, ...Object.fromEntries([...params].filter(([k]) => k in DEF)) };
    el.innerHTML = stSub() + `<div class="card muted">Loading…</div>`;
    idx = idx || await getJSON("data/viz/index.json").catch(() => ({}));
    const seasons = idx[league] || [];
    if (!seasons.length) { el.innerHTML = stSub() + `<div class="card">No chart data for ${league === "nfl" ? "the NFL" : "college"} yet. It's built every week with the rankings.</div>`; return; }
    if (!seasons.includes(+st.to)) st.to = String(seasons.at(-1));
    if (!seasons.includes(+st.from) || +st.from > +st.to) st.from = st.to;
    try { await loadChartJs(); } catch { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart library. Check your connection and try again.</div>`; return; }
    const span = seasons.filter((s) => s >= +st.from && s <= +st.to);
    const Ds = (await Promise.all(span.map(file))).filter(Boolean);
    await Promise.all(Ds.map(ours));
    if (!Ds.length) { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart data. Try again in a minute.</div>`; return; }
    draw(el, seasons, Ds);
  }
  const stSub = () => Live.statsSubtabs("visualize");

  const IDEAS = { // one-tap starting points
    nfl: [["Schedule vs record (the Schedules chart)", { who: "teams", type: "scatter", stat: "ci_sos", y: "win_pct", top: "50" }], ["EPA per play vs points", { who: "teams", type: "scatter", stat: "epa_play", y: "pts" }], ["Best offenses (EPA)", { who: "teams", type: "bar", stat: "epa_play" }],
      ["Top passers (EPA per dropback)", { who: "players", type: "bar", stat: "epa_db", pos: "QB" }], ["Rushing yards by week", { who: "players", type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" }],
      ["QB profiles", { who: "players", type: "radar", pos: "QB", top: "3" }]],
    cfb: [["Schedule vs cupcakes (the Schedules chart)", { who: "teams", type: "scatter", stat: "ci_sos", y: "ci_cupcake", group: "" }], ["EPA per play vs points", { who: "teams", type: "scatter", stat: "epa_play", y: "pts" }], ["Best defenses (EPA allowed)", { who: "teams", type: "bar", stat: "def_epa_play" }],
      ["Top passers (efficiency)", { who: "players", type: "bar", stat: "eff", pos: "QB" }], ["Rushing yards by week", { who: "players", type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" }],
      ["Team profiles", { who: "teams", type: "radar", top: "3" }]],
  };
  const RADAR = { teams: ["epa_play", "def_epa_play", "ypp", "third", "giveaways", "def_sacks", "pts"], players: {
    QB: ["pass_yds", "pass_td", "cmp_pct", "ypa", "int", "epa_db", "eff", "rush_yds"], RB: ["rush_yds", "ypc", "rush_td", "rec", "rec_yds", "epa_rush"],
    WR: ["rec", "rec_yds", "rec_td", "ypr", "catch_pct", "epa_tgt", "yac"], DEF: ["tackles", "def_sacks", "tfl", "qb_hits", "pd", "def_int"], K: ["fg_made", "fg_pct"], "": ["scrim", "tds", "rec_yds", "rush_yds", "pass_yds"] } };

  function draw(el, seasons, Ds) {
    const D = Ds.at(-1), who = st.who, multi = Ds.length > 1;
    const groups = statsFor(who, D), all = groups.flatMap(([, l]) => l);
    const stat = all.find((s) => s[0] === st.stat) || all[0];
    st.stat = stat[0];
    const ystat = all.find((s) => s[0] === st.y) || all.find((s) => s[0] !== stat[0]);
    st.y = ystat[0];
    const maxWk = Math.max(...D.trows.map((r) => r[1]), 1);
    const w1 = Math.max(1, +st.wk1 || 1), w2 = Math.min(+st.wk2 || 99, 99);
    const meta = (k) => who === "players" ? D.pmeta[k] || Ds.find((x) => x.pmeta[k])?.pmeta[k] : D.teams[k] || Ds.find((x) => x.teams[k])?.teams[k];
    const teamOf = (k) => (who === "players" ? meta(k)?.[2] : k);
    const tm = (k) => D.teams[k] || Ds.find((x) => x.teams[k])?.teams[k] || [k, k, "#888888", ""];
    const confs = [...new Set(Object.values(D.teams).map((t) => t[3]).filter(Boolean))].sort();
    const picks = st.pick ? st.pick.split(",") : [];

    // add up every season in the span (the same weeks in each)
    const agg = {};
    Ds.forEach((d) => {
      const part = sum(d, who, w1, w2, st.type === "line");
      for (const [k, o] of Object.entries(part)) {
        const a = agg[k] || (agg[k] = { S: {}, g: 0, wk: {}, team: o.team, seasons: {} });
        for (const c in o.S) a.S[c] = (a.S[c] || 0) + o.S[c];
        a.g += o.g; a.team = o.team; a.seasons[d.season] = o;
        if (!multi) a.wk = o.wk;
      }
    });
    if (who === "teams") for (const k in agg) Object.assign(agg[k].S, Ds.at(-1).ours?.[k] || {}); // season-long: the latest season's
    // filters
    const ok = (k) => {
      const a = agg[k], t = tm(teamOf(k));
      if (st.group && t[3] !== st.group) return false;
      if (who === "players" && st.team && teamOf(k) !== st.team) return false;
      if (who === "players" && st.pos && POS_OF(meta(k)?.[1], a.S) !== st.pos) return false;
      return true;
    };
    let keys = Object.keys(agg).filter(ok);
    // rates: only who has at least 35% of the leader's attempts/plays (picked ones always count)
    const qualify = (s) => {
      if (!s[3].den) return keys;
      const best = Math.max(...keys.map((k) => s[3].den(agg[k].S) || 0));
      return keys.filter((k) => picks.includes(k) || (s[3].den(agg[k].S) || 0) >= best * 0.35);
    };
    const val = (s, k) => value(s, agg[k].S, agg[k].g, st.per);
    const rank = (s, list) => list.filter((k) => val(s, k) != null).sort((a, b) => (s[3].low ? 1 : -1) * (val(s, a) - val(s, b)) * (st.order === "worst" ? -1 : 1));
    const top = +st.top || 10;
    const name = (k) => who === "players" ? meta(k)?.[0] || k : tm(k)[0];
    const short = (k) => who === "players" ? (meta(k)?.[0] || k).replace(/^(\S)\S*\s/, "$1. ") : tm(k)[1] || tm(k)[0];
    const color = (k) => tm(teamOf(k))[2] || "#888";
    const PAL = [accentOf(), "#4cc9f0", "#f72585", "#b5e48c", "#ffd166", "#9b5de5", "#00f5d4", "#ff8fab", "#90be6d", "#f4a261", "#577590", "#e9c46a"]; // lines, pie slices, radar: easy to tell apart
    function accentOf() { return getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#ff6b2c"; }
    const css = getComputedStyle(document.body), C = (v) => css.getPropertyValue(v).trim();
    const ink = C("--ink"), muted = C("--muted"), line = C("--line"), accent = C("--accent");
    const weeksTxt = `${w1 > 1 || w2 < 99 ? `Weeks ${w1}–${D.bowls && w2 >= D.bowls ? "bowls" : Math.min(w2, maxWk)}` : league === "nfl" ? "Regular season" : "Full season incl. bowls"}`;
    const seasonTxt = multi ? `${st.from}–${st.to}` : st.to;
    const perTxt = (s) => (s[3].count && st.per === "game" ? " per game" : "");
    const lgTxt = league === "nfl" ? "NFL" : "College";
    let title = "", body = "", note = "";
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const statSel = (id, v) => `<select id="${id}">${groups.map(([g, l]) => `<optgroup label="${esc(g)}">${l.map((s) => `<option value="${s[0]}"${s[0] === v ? " selected" : ""}>${esc(s[1])}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const seg = (id, opts, v) => `<div class="seg vz-seg" id="${id}">${opts.map(([k, l]) => `<button data-v="${k}" class="${k === v ? "active" : ""}">${l}</button>`).join("")}</div>`;
    const wkOpts = [["", "–"], ...Array.from({ length: Math.max(maxWk, D.league === "nfl" ? 18 : 1) }, (_, i) => [i + 1, D.bowls && i + 1 >= D.bowls ? "Bowls" : i + 1])];

    // the chart
    let cfg;
    const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { labels: { color: ink, font: { family: "JetBrains Mono", size: 11 } } }, tooltip: { titleFont: { family: "JetBrains Mono" }, bodyFont: { family: "JetBrains Mono" } } },
      scales: { x: { ticks: { color: muted, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: line } }, y: { ticks: { color: muted, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: line } } } };
    const hl = (k) => picks.includes(k);
    if (st.type === "bar") {
      const list = rank(stat, qualify(stat));
      const shown = [...new Set([...list.slice(0, top), ...picks.filter((k) => list.includes(k))])];
      title = `${stat[1]}${perTxt(stat)}`;
      cfg = { type: "bar", data: { labels: shown.map(short), datasets: [{ data: shown.map((k) => val(stat, k)), backgroundColor: shown.map((k) => hl(k) ? accent : color(k)),
        borderColor: shown.map((k) => (hl(k) ? ink : "transparent")), borderWidth: 2 }] },
        options: { ...base, indexAxis: "y", plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { title: (c) => name(shown[c[0].dataIndex]), label: (c) => fmt(stat, c.raw, st.per) } } },
          scales: { ...base.scales, y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, autoSkip: false } } } } };
      body = { h: Math.max(260, shown.length * 26 + 60) };
      note = `${list.length} ${who} ranked${stat[3].den ? ` (at least 35% of the leader's ${who === "teams" ? "plays" : "attempts"})` : ""}.`;
      body.table = shown.map((k, i) => [i + 1, k, fmt(stat, val(stat, k), st.per)]);
    } else if (st.type === "line") {
      const list = rank(stat, qualify(stat)), sers = (picks.length ? picks.filter((k) => agg[k]) : list.slice(0, Math.min(top, 8)));
      title = `${stat[1]}${multi ? " by season" : st.cum ? ", adding up week by week" : " by week"}`;
      let labels, data;
      if (multi) {
        labels = Ds.map((d) => String(d.season));
        data = (k) => Ds.map((d) => { const o = agg[k].seasons[d.season]; return o ? value(stat, o.S, o.g, st.per) : null; });
      } else {
        const wks = [...new Set(D.trows.map((r) => r[1]))].filter((w) => w >= w1 && w <= w2).sort((a, b) => a - b);
        labels = wks.map((w) => (D.bowls && w >= D.bowls ? "Bowls" : `Wk ${w}`));
        data = (k) => {
          const run = {}; let g = 0;
          return wks.map((w) => {
            const S = agg[k].wk[w];
            if (!st.cum) return S ? stat[2](S, 1) : null;
            if (S) { g++; for (const c in S) run[c] = (run[c] || 0) + S[c]; }
            return g ? stat[3].count ? stat[2](run, g) : stat[2](run, g) : null;
          });
        };
      }
      cfg = { type: "line", data: { labels, datasets: sers.map((k, i) => ({ label: short(k), data: data(k), borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length],
        borderWidth: hl(k) || i === 0 ? 3 : 2, pointRadius: 3, spanGaps: true, tension: 0.25 })) },
        options: { ...base, plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${fmt({ 3: { ...stat[3], count: 0 } }, c.raw)}` } } } } };
      body = { h: 380 };
      note = picks.length ? "" : `The top ${sers.length} in ${stat[1].toLowerCase()}. Pick ${who} below to compare your own.`;
    } else if (st.type === "pie") {
      const s = stat[3].count ? stat : all.find((x) => x[3].count);
      st.stat = s[0];
      const list = rank(s, keys).filter((k) => val(s, k) > 0), n = Math.min(top, 12);
      const shown = list.slice(0, n), rest = list.slice(n).reduce((a, k) => a + val(s, k), 0);
      const total = list.reduce((a, k) => a + val(s, k), 0);
      title = `Share of ${s[1].toLowerCase()}`;
      cfg = { type: "doughnut", data: { labels: [...shown.map(short), ...(rest ? ["Everyone else"] : [])],
        datasets: [{ data: [...shown.map((k) => val(s, k)), ...(rest ? [rest] : [])], backgroundColor: [...shown.map((k, i) => PAL[i % PAL.length]), ...(rest ? [line] : [])], borderColor: C("--card"), borderWidth: 2 }] },
        options: { ...base, scales: {}, plugins: { ...base.plugins, legend: { position: "bottom", labels: base.plugins.legend.labels },
          tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.label}: ${fmt({ 3: { ...s[3], count: 0 } }, c.raw)} (${Math.round((100 * c.raw) / total)}%)` } } } } };
      body = { h: 420 };
      note = who === "players" && !st.team ? "Tip: pick a team in Filters to see how one team splits it up (who gets the carries, the targets...)." : "";
      if (!stat[3].count) note = `Pie charts need a total, so this shows ${s[1].toLowerCase()}. ` + note;
    } else if (st.type === "scatter") {
      const both = qualify(stat).filter((k) => qualify(ystat).includes(k)).filter((k) => val(stat, k) != null && val(ystat, k) != null);
      title = `${stat[1]}${perTxt(stat)} vs ${ystat[1].toLowerCase()}${perTxt(ystat)}`;
      const label = new Set([...rank(stat, both).slice(0, 4), ...rank(ystat, both).slice(0, 4), ...rank(stat, both).slice(-2), ...picks]);
      const pts = both.map((k) => ({ x: val(stat, k), y: val(ystat, k), k }));
      const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), mx = avg(pts.map((p) => p.x)), my = avg(pts.map((p) => p.y));
      cfg = { type: "scatter", data: { datasets: [{ data: pts, pointRadius: pts.map((p) => (hl(p.k) ? 7 : 5)), pointBackgroundColor: pts.map((p) => (hl(p.k) ? accent : color(p.k))), pointBorderColor: ink, pointBorderWidth: pts.map((p) => (hl(p.k) ? 2 : 0.5)) }] },
        options: { ...base, layout: { padding: { right: 36, top: 8 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${name(c.raw.k)}: ${fmt(stat, c.raw.x, st.per)}, ${fmt(ystat, c.raw.y, st.per)}` } } },
          scales: { x: { ...base.scales.x, reverse: !!stat[3].low, title: { display: true, text: stat[1] + perTxt(stat) + (stat[3].low ? " (better →)" : ""), color: muted } },
            y: { ...base.scales.y, reverse: !!ystat[3].low, title: { display: true, text: ystat[1] + perTxt(ystat) + (ystat[3].low ? " (better ↑)" : ""), color: muted } } } },
        plugins: [{ id: "vzLabels", afterDatasetsDraw(c) {
          const { ctx, chartArea: a, scales: { x, y } } = c;
          ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = muted; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x.getPixelForValue(mx), a.top); ctx.lineTo(x.getPixelForValue(mx), a.bottom); ctx.moveTo(a.left, y.getPixelForValue(my)); ctx.lineTo(a.right, y.getPixelForValue(my)); ctx.stroke();
          ctx.setLineDash([]); ctx.font = "10px JetBrains Mono"; ctx.fillStyle = ink;
          c.getDatasetMeta(0).data.forEach((p, i) => { if (label.has(pts[i].k)) ctx.fillText(short(pts[i].k), p.x + 7, p.y + 3); });
          ctx.restore(); } }] };
      body = { h: 440 };
      note = `${both.length} ${who}. Dashed lines are the averages. ${stat[3].low || ystat[3].low ? "Axes are flipped where lower is better, so up and right is always good." : "Up and right is good."}`;
    } else { // radar: percentiles among everyone shown
      const want = who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""];
      const custom = st.radar ? st.radar.split(",") : want;
      const axes = custom.map((k) => all.find((s) => s[0] === k)).filter(Boolean).slice(0, 8);
      const lead = rank(axes[0], qualify(axes[0]));
      const sers = (picks.length ? picks.filter((k) => agg[k]) : lead.slice(0, Math.min(top, 4))).slice(0, 5);
      const pctile = (s, k) => { const q = qualify(s), v = val(s, k); if (v == null) return null; const vals = q.map((x) => val(s, x)).filter((x) => x != null);
        const below = vals.filter((x) => (s[3].low ? x > v : x < v)).length; return Math.round((100 * below) / Math.max(1, vals.length - 1)); };
      title = `${who === "teams" ? "Team" : "Player"} profiles (percentile among ${who}${st.pos ? ` at ${st.pos}` : ""})`;
      cfg = { type: "radar", data: { labels: axes.map((s) => s[1].replace(/ \(.+\)/, "")), datasets: sers.map((k, i) => ({ label: short(k), data: axes.map((s) => pctile(s, k)),
        borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length] + "33", borderWidth: 2, pointRadius: 2 })) },
        options: { ...base, scales: { r: { min: 0, max: 100, ticks: { display: false, stepSize: 25 }, grid: { color: line }, angleLines: { color: line }, pointLabels: { color: ink, font: { family: "JetBrains Mono", size: 10 } } } },
          plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${axes[c.dataIndex][1]} ${fmt(axes[c.dataIndex], val(axes[c.dataIndex], sers[c.datasetIndex]), st.per)} (better than ${c.raw}%)` } } } } };
      body = { h: 440 };
      note = "100 = the best among everyone listed, 0 = the worst. Lower-is-better stats are flipped.";
    }
    const sub = `${lgTxt} · ${seasonTxt} · ${weeksTxt}${st.group ? ` · ${st.group}` : ""}${st.team ? ` · ${tm(st.team)[0]}` : ""}${st.pos ? ` · ${st.pos === "DEF" ? "Defense" : st.pos}` : ""}`;
    const src = league === "nfl" ? "nflverse play-by-play (EPA)" : "CollegeFootballData.com (box scores; PPA = college EPA, garbage time left out)";
    const seasonOnly = [stat, ystat].some((s) => s[3].season) && (w1 > 1 || w2 < 99);

    el.innerHTML = stSub() + `<div class="card vz">
      <div class="sc-bar"><h2>Visualize</h2><span class="muted vz-tag">Make a chart, win the argument.</span></div>
      <div class="vz-ideas">${IDEAS[league].map(([l], i) => `<button class="vz-idea" data-i="${i}">${esc(l)}</button>`).join("")}</div>
      <div class="vz-ctl">
        <label>Chart${seg("vz-type", [["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["radar", "Radar"]], st.type)}</label>
        <label>Of${seg("vz-who", [["teams", "Teams"], ["players", "Players"]], who)}</label>
        ${st.type === "radar" ? `<details class="vz-wide vz-rstats"><summary>Stats on the web (${axes().length}) · tap to change</summary><div id="vz-radar">${groups.map(([g, l]) => `<fieldset><legend>${esc(g)}</legend>${l.map((s) => `<label><input type="checkbox" value="${s[0]}"${custom().includes(s[0]) ? " checked" : ""}> ${esc(s[1])}</label>`).join("")}</fieldset>`).join("")}<p class="muted">Pick 3 to 8.</p></div></details>`
          : `<label class="vz-wide">${st.type === "scatter" ? "Across (X)" : "Stat"}${statSel("vz-stat", stat[0])}</label>${st.type === "scatter" ? `<label class="vz-wide">Up (Y)${statSel("vz-y", ystat[0])}</label>` : ""}`}
        <label>Seasons<span class="vz-pair">${sel("vz-from", seasons.map((s) => [s, s]), st.from)}<i>to</i>${sel("vz-to", seasons.map((s) => [s, s]), st.to)}</span></label>
        <label>Weeks<span class="vz-pair">${sel("vz-wk1", wkOpts, st.wk1)}<i>to</i>${sel("vz-wk2", wkOpts, st.wk2)}</span></label>
        <label>Totals${seg("vz-per", [["game", "Per game"], ["total", "Total"]], st.per)}</label>
        ${st.type === "bar" ? `<label>Show${seg("vz-order", [["best", "Best"], ["worst", "Worst"]], st.order)}</label>` : ""}
        ${st.type === "line" && !multi ? `<label>Line${seg("vz-cum", [["", "Each week"], ["1", "Running total"]], st.cum)}</label>` : ""}
        <label>How many${sel("vz-top", [5, 10, 15, 25, 50].map((x) => [x, `Top ${x}`]), st.top)}</label>
      </div>
      <details class="vz-more"${st.group || st.team || st.pos || picks.length ? " open" : ""}><summary>Filters and highlights</summary><div class="vz-ctl">
        <label>${league === "nfl" ? "Division" : "Conference"}${sel("vz-group", [["", "All"], ...confs.map((c) => [c, c])], st.group)}</label>
        ${who === "players" ? `<label>Team${sel("vz-team", [["", "All teams"], ...Object.entries(D.teams).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, t]) => [k, t[0]])], st.team)}</label>
          <label>Position${sel("vz-pos", [["", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR / TE"], ["K", "Kicker"], ["DEF", "Defense"]], st.pos)}</label>` : ""}
        <label class="vz-wide vz-findwrap">Highlight / compare<input id="vz-find" placeholder="Type a ${who === "teams" ? "team" : "player"}…" autocomplete="off" spellcheck="false"><div class="vz-sugg" id="vz-sugg" hidden></div></label>
        <div class="vz-picks">${picks.map((k) => `<button data-k="${esc(k)}" title="Remove">${esc(name(k))} ×</button>`).join("")}</div>
      </div></details>
      <div class="vz-frame" id="vz-frame"><div class="vz-title"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <div class="vz-canvas" style="height:${body.h}px"><canvas id="vz-chart"></canvas></div>
        <div class="vz-mark">cupcakeindex.com · ${esc(league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com")}</div></div>
      ${seasonOnly ? `<p class="note">Our ratings and college PPA are season-long numbers (as of the latest rankings), so they ignore the weeks you picked.</p>` : ""}
      <div class="vz-actions"><button class="btn" id="vz-png">Download picture</button><button class="btn" id="vz-link">Copy link</button>${navigator.share ? `<button class="btn" id="vz-share">Share</button>` : ""}<button class="btn vz-reset" id="vz-reset">Start over</button></div>
      ${body.table ? `<details class="vz-tbl"><summary>See the numbers</summary><table class="box"><tbody>${body.table.map(([i, k, v]) => `<tr><td class="num muted">${i}</td><td>${who === "players" && /^\d+$/.test(k) ? `<a href="#/player/${esc(k)}?league=${league}">${esc(name(k))}</a>` : who === "teams" ? `<a href="#/team/${esc(k.split(":")[1])}?league=${league}">${esc(name(k))}</a>` : esc(name(k))}</td><td class="num">${esc(v)}</td></tr>`).join("")}</tbody></table></details>` : ""}
      <p class="note">${esc(note)} Source: ${esc(src)}. Rates are total ÷ total over the weeks you pick, not an average of weekly averages. Updated ${esc(new Date(D.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}.</p></div>`;
    function custom() { return st.radar ? st.radar.split(",") : who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""]; }
    function axes() { return custom().filter((k) => all.some((s) => s[0] === k)); }

    chart?.destroy();
    chart = new Chart(document.getElementById("vz-chart"), cfg);
    save();

    // controls
    const redo = () => { save(); draw(el, seasons, Ds); };
    const reload = () => { save(); render(new URLSearchParams(location.hash.split("?")[1] || "")); };
    el.querySelectorAll(".vz-seg").forEach((g) => g.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const k = { "vz-type": "type", "vz-who": "who", "vz-per": "per", "vz-order": "order", "vz-cum": "cum" }[g.id];
      st[k] = b.dataset.v;
      if (k === "who") { st.pick = ""; st.team = ""; st.pos = ""; st.radar = ""; st.stat = b.dataset.v === "players" ? "scrim" : "epa_play"; st.y = b.dataset.v === "players" ? "tds" : "pts"; }
      if (k === "type") st.radar = "";
      redo();
    });
    const on = (id, k, again = redo) => { const x = document.getElementById(id); if (x) x.onchange = () => { st[k] = x.value; if (k === "pos") st.radar = ""; again(); }; };
    on("vz-stat", "stat"); on("vz-y", "y"); on("vz-wk1", "wk1"); on("vz-wk2", "wk2"); on("vz-top", "top"); on("vz-group", "group"); on("vz-team", "team"); on("vz-pos", "pos");
    on("vz-from", "from", reload); on("vz-to", "to", reload);
    const rs = document.getElementById("vz-radar");
    if (rs) rs.onchange = (e) => {
      const v = [...rs.querySelectorAll("input:checked")].map((o) => o.value);
      if (v.length < 3 || v.length > 8) { e.target.checked = !e.target.checked; return; } // keep 3 to 8
      st.radar = v.join(","); redo();
      document.querySelector(".vz-rstats")?.setAttribute("open", "");
    };
    // search every team/player in the data (not just the first few thousand): best name match first, then the bigger stat line
    const find = document.getElementById("vz-find"), sugg = document.getElementById("vz-sugg");
    const norm = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.'’-]/g, "").toLowerCase();
    const pool = Object.keys(agg).filter(ok).map((k) => [k, norm(name(k)), agg[k].S]);
    const size = (S) => who === "teams" ? 0 : (S.pass_yds || 0) + (S.rush_yds || 0) + (S.rec_yds || 0) + 10 * (S.tackles || 0) + 30 * (S.fg_made || 0);
    let hits = [], cur = -1;
    const add = (k) => { if (k && !picks.includes(k)) { st.pick = [...picks, k].slice(-6).join(","); redo(); } };
    const show = () => {
      const q = norm(find.value.trim());
      if (q.length < 2) { sugg.hidden = true; hits = []; return; }
      const words = q.split(/\s+/);
      hits = pool.filter(([, n]) => words.every((w) => n.includes(w)))
        .map(([k, n, S]) => [k, n.startsWith(q) ? 0 : n.split(" ").some((w) => w.startsWith(words[0])) ? 1 : 2, size(S)])
        .sort((a, b) => a[1] - b[1] || b[2] - a[2]).slice(0, 10).map((x) => x[0]);
      cur = -1;
      sugg.innerHTML = hits.map((k, i) => `<button type="button" data-i="${i}">${esc(name(k))}${who === "players" ? ` <small>${esc([POS_OF(meta(k)?.[1], agg[k].S), tm(teamOf(k))[0]].filter(Boolean).join(" · "))}</small>` : ""}</button>`).join("")
        || `<p class="muted">No ${who} named “${esc(find.value.trim())}” with stats in these weeks${st.pos || st.team || st.group ? " and filters" : ""}.</p>`;
      sugg.hidden = false;
    };
    find.oninput = show;
    find.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); cur = Math.max(0, Math.min(hits.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        sugg.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === cur));
      } else if (e.key === "Enter") { e.preventDefault(); add(hits[Math.max(cur, 0)]); }
      else if (e.key === "Escape") sugg.hidden = true;
    };
    sugg.onmousedown = (e) => e.preventDefault(); // keep the box focused while tapping a name
    sugg.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) add(hits[+b.dataset.i]); };
    find.onblur = () => setTimeout(() => (sugg.hidden = true), 150);
    el.querySelector(".vz-picks").onclick = (e) => { const b = e.target.closest("[data-k]"); if (b) { st.pick = picks.filter((k) => k !== b.dataset.k).join(","); redo(); } };
    el.querySelector(".vz-ideas").onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; st = { ...DEF, from: st.from, to: st.to, ...IDEAS[league][+b.dataset.i][1] }; reload(); };
    document.getElementById("vz-reset").onclick = () => { st = { ...DEF }; reload(); };
    document.getElementById("vz-png").onclick = () => picture().then((c) => { const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `cupcake-index-${st.stat}.png`; a.click(); });
    document.getElementById("vz-link").onclick = (e) => { navigator.clipboard?.writeText(location.href).then(() => { e.target.textContent = "Link copied"; setTimeout(() => (e.target.textContent = "Copy link"), 1500); }); };
    const sh = document.getElementById("vz-share");
    if (sh) sh.onclick = () => picture().then((c) => c.toBlob((b) => {
      const f = new File([b], "cupcake-index-chart.png", { type: "image/png" });
      (navigator.canShare?.({ files: [f] }) ? navigator.share({ files: [f], title }) : navigator.share({ url: location.href, title })).catch(() => {});
    }));

    // the picture: title, chart and the site's mark on the card color, 2x for sharp text
    async function picture() {
      const cv = document.getElementById("vz-chart"), W = cv.width, H = cv.height, sc = W / cv.clientWidth, pad = 24 * sc, top = 70 * sc, bot = 34 * sc;
      const out = document.createElement("canvas"); out.width = W + 2 * pad; out.height = H + top + bot;
      const x = out.getContext("2d");
      x.fillStyle = C("--card") || "#111"; x.fillRect(0, 0, out.width, out.height);
      x.fillStyle = accent; x.fillRect(0, 0, out.width, 4 * sc);
      x.fillStyle = ink; x.font = `700 ${18 * sc}px JetBrains Mono, monospace`; x.fillText(title, pad, 34 * sc);
      x.fillStyle = muted; x.font = `${12 * sc}px JetBrains Mono, monospace`; x.fillText(sub, pad, 54 * sc);
      x.drawImage(cv, pad, top);
      x.fillStyle = accent; x.font = `700 ${12 * sc}px JetBrains Mono, monospace`; x.fillText("CUPCAKE_INDEX", pad, out.height - 12 * sc);
      x.fillStyle = muted; x.font = `${11 * sc}px JetBrains Mono, monospace`; x.textAlign = "right";
      x.fillText(`cupcakeindex.com · ${league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com"}`, out.width - pad, out.height - 12 * sc);
      return out;
    }
  }

  return { render };
})();
