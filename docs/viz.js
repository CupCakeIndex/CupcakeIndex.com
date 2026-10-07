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
      ["win_pct", "Win %", (S, g) => div(100 * S.wins, g), { den: (S, g) => g, pct: 1, need: ["pts"] }],
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
  const covRating = (S) => { // the NFL passer rating formula on the throws at him (Pro Football Reference's coverage charting)
    if (!S.cov_tgt) return null;
    const c = (x) => Math.max(0, Math.min(2.375, x)), a = S.cov_tgt;
    return (c((S.cov_cmp / a - 0.3) * 5) + c((S.cov_yds / a - 3) * 0.25) + c((S.cov_td / a) * 20) + c(2.375 - (S.cov_int / a) * 25)) / 6 * 100;
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
    // Deep cuts (NFL, src/deep_stats.py from play-by-play). A "stop" = the offense failed on that play: under 40% of the
    // yards needed on 1st down, 60% on 2nd, no conversion on 3rd/4th. Everyone credited on the tackle gets it.
    ["Deep cuts: run defense", [
      ["run_stop", "Run stops", (S) => S.run_stop, { count: 1, need: ["run_stop"] }],
      ["run_stop_rate", "Run stops per 100 snaps", (S) => div(100 * S.run_stop, S.snaps), { den: (S) => S.snaps, d: 1, unit: "snaps", need: ["run_stop"] }],
      ["stop_pct", "Stop % of run tackles", (S) => div(100 * S.run_stop, S.run_tkl), { den: (S) => S.run_tkl, pct: 1, unit: "run tackles", need: ["run_stop"] }],
      ["stuff", "Stuffs (run tackles at or behind the line)", (S) => S.stuff, { count: 1, need: ["stuff"] }],
      ["run_depth", "Avg gain on his run tackles", (S) => div(S.run_tkl_yds, S.run_tkl), { den: (S) => S.run_tkl, d: 1, low: 1, unit: "run tackles", need: ["run_tkl"] }],
      ["sy_stop", "Short-yardage stops (3rd/4th & 2 or less)", (S) => S.sy_stop, { count: 1, need: ["sy_stop"] }],
    ]],
    ["Deep cuts: pass rush and coverage", [
      ["sack_rate", "Sacks per 100 snaps", (S) => div(100 * S.def_sacks, S.snaps), { den: (S) => S.snaps, d: 1, unit: "snaps", need: ["third_sacks"] }],
      ["third_sacks", "Drive-killing sacks (3rd/4th down)", (S) => S.third_sacks, { count: 1, d: 1, need: ["third_sacks"] }],
      ["heat", "Sacks + QB hits", (S) => S.def_sacks + S.qb_hits, { count: 1, d: 1, need: ["third_sacks"] }],
      ["ball", "Ball production (INT + passes defended)", (S) => S.def_int + S.pd, { count: 1, need: ["pass_stop"] }],
      ["pass_stop", "Pass stops (tackled a catch short)", (S) => S.pass_stop, { count: 1, need: ["pass_stop"] }],
      ["third_stop", "3rd/4th-down stops", (S) => S.third_stop, { count: 1, need: ["third_stop"] }],
      ["rz_stop", "Red-zone stops", (S) => S.rz_stop, { count: 1, need: ["rz_stop"] }],
      ["dtakeaways", "Takeaways (INT + forced fumbles)", (S) => S.def_int + S.ff, { count: 1, need: ["ff"] }],
    ]],
    // who was in coverage on each throw: Pro Football Reference's charting (nflverse pfr_advstats)
    ["Deep cuts: coverage (DBs)", [
      ["cov_rating", "Passer rating allowed (coverage rating)", covRating, { den: (S) => S.cov_tgt, d: 1, low: 1, unit: "targets", need: ["cov_tgt"] }],
      ["cov_win", "Coverage success % (targets not caught)", (S) => div(100 * (S.cov_tgt - S.cov_cmp), S.cov_tgt), { den: (S) => S.cov_tgt, pct: 1, unit: "targets", need: ["cov_tgt"] }],
      ["cov_cmp_pct", "Completion % allowed", (S) => div(100 * S.cov_cmp, S.cov_tgt), { den: (S) => S.cov_tgt, pct: 1, low: 1, unit: "targets", need: ["cov_tgt"] }],
      ["cov_ypt", "Yards allowed per target", (S) => div(S.cov_yds, S.cov_tgt), { den: (S) => S.cov_tgt, d: 1, low: 1, unit: "targets", need: ["cov_tgt"] }],
      ["cov_tgt", "Targets in coverage", (S) => S.cov_tgt, { count: 1, need: ["cov_tgt"] }],
      ["cov_yds", "Yards allowed in coverage", (S) => S.cov_yds, { count: 1, low: 1, need: ["cov_tgt"] }],
      ["cov_td", "TDs allowed in coverage", (S) => S.cov_td, { count: 1, low: 1, need: ["cov_tgt"] }],
      ["cov_yac", "Yards after catch allowed per catch", (S) => div(S.cov_yac, S.cov_cmp), { den: (S) => S.cov_cmp, d: 1, low: 1, unit: "catches allowed", need: ["cov_yac"] }],
      ["pressure", "Pressures (sacks, hits, hurries)", (S) => S.pressure, { count: 1, need: ["pressure"] }],
      ["miss_tkl", "Missed tackles", (S) => S.miss_tkl, { count: 1, low: 1, need: ["miss_tkl"] }],
      ["miss_pct", "Missed tackle %", (S) => div(100 * S.miss_tkl, S.miss_tkl + S.pfr_tkl), { den: (S) => S.miss_tkl + S.pfr_tkl, pct: 1, low: 1, unit: "tackle tries", need: ["miss_tkl"] }],
    ]],
    ["Deep cuts: offense", [
      ["rush_succ_pct", "Run success %", (S) => div(100 * S.rush_succ, S.carries), { den: (S) => S.carries, pct: 1, unit: "carries", need: ["rush_succ"] }],
      ["stuffed_pct", "Stuffed % (runs for 0 or less)", (S) => div(100 * S.rush_stuffed, S.carries), { den: (S) => S.carries, pct: 1, low: 1, unit: "carries", need: ["rush_stuffed"] }],
      ["rush_10", "Explosive runs (10+ yards)", (S) => S.rush_10, { count: 1, need: ["rush_10"] }],
      ["sy_conv_pct", "Short-yardage conversion % (3rd/4th & 2 or less)", (S) => div(100 * S.sy_conv, S.sy_carries), { den: (S) => S.sy_carries, pct: 1, unit: "short-yardage carries", need: ["sy_conv"] }],
      ["gl_carries", "Goal-line carries (inside the 5)", (S) => S.gl_carries, { count: 1, need: ["gl_carries"] }],
      ["deep_rec", "Deep catches (20+ air yards)", (S) => S.deep_rec, { count: 1, need: ["deep_rec"] }],
      ["deep_catch_pct", "Deep catch %", (S) => div(100 * S.deep_rec, S.deep_tgt), { den: (S) => S.deep_tgt, pct: 1, unit: "deep targets", need: ["deep_rec"] }],
      ["rec_20", "Big plays (20+ yard catches)", (S) => S.rec_20, { count: 1, need: ["rec_20"] }],
      ["third_conv", "3rd/4th-down conversion catches", (S) => S.third_conv, { count: 1, need: ["third_conv"] }],
      ["third_rate", "3rd-down conversion % per target", (S) => div(100 * S.third_conv, S.third_tgt), { den: (S) => S.third_tgt, pct: 1, unit: "3rd-down targets", need: ["third_conv"] }],
      ["rz_tgt", "Red-zone targets", (S) => S.rz_tgt, { count: 1, need: ["rz_tgt"] }],
      ["deep_cmp_pct", "Deep ball completion % (QB)", (S) => div(100 * S.deep_cmp, S.deep_att), { den: (S) => S.deep_att, pct: 1, unit: "deep throws", need: ["deep_cmp"] }],
      ["third_db_pct", "3rd/4th-down conversion % (QB)", (S) => div(100 * S.third_db_conv, S.third_db), { den: (S) => S.third_db, pct: 1, unit: "3rd-down dropbacks", need: ["third_db"] }],
      ["clutch", "Clutch EPA per dropback (4th quarter, one-score game)", (S) => div(S.clutch_epa, S.clutch_db), { den: (S) => S.clutch_db, d: 2, unit: "clutch dropbacks", need: ["clutch_db"] }],
      ["rz_td_pct", "Red-zone TD % (QB)", (S) => div(100 * S.rz_pass_td, S.rz_att), { den: (S) => S.rz_att, pct: 1, unit: "red-zone throws", need: ["rz_att"] }],
      ["hit_pct", "Hit or sacked % (QB)", (S) => div(100 * S.hit, S.dropbacks), { den: (S) => S.dropbacks, pct: 1, low: 1, unit: "dropbacks", need: ["hit"] }],
    ]],
  ];
  const statsFor = (who, D) => (who === "players" ? P : T).map(([g, list]) => [g, list.filter(([, , , o]) =>
    (!o.lg || o.lg === D.league) && (!o.need || o.need.every((c) => (who === "players" ? D.pcols : D.tcols).includes(c))))]).filter(([, l]) => l.length);
  const findStat = (who, D, k) => statsFor(who, D).flatMap(([, l]) => l).find((s) => s[0] === k);

  // ---------------------------------------------------------------- state (all in the link)
  const DEF = { who: "teams", type: "bar", stat: "epa_play", y: "pts", from: "", to: "", wk1: "", wk2: "", per: "game", top: "10",
    group: "", team: "", pos: "", pick: "", order: "best", cum: "", radar: "", logo: "", names: "", min: "", role: "", noexit: "", exp: "", draft: "" }; // logo/names: "" = on, "0" = off; min: "" = automatic
  let st = { ...DEF };
  const save = () => {
    const q = new URLSearchParams({ league, show: "visualize" });
    Object.entries(st).forEach(([k, v]) => { if (v !== "" && v !== DEF[k]) q.set(k, v); });
    history.replaceState(null, "", `#/stats?${q}`);
  };

  async function file(season) {
    const k = `${league}_${season}`;
    if (!files.has(k)) files.set(k, getJSON(`data/viz/${k}.json`).then((D) => { // deep cuts: a sparse [column, value, ...] list ends each NFL player row
      if (D?.xcols?.length) {
        const n = D.pcols.length + 3;
        D.pcols = D.pcols.concat(D.xcols);
        for (const r of D.prows) { const x = r.length > n ? r.pop() : []; for (let i = 0; i < D.xcols.length; i++) r.push(0); for (let i = 0; i < x.length; i += 2) r[n + x[i]] = x[i + 1]; }
      }
      return D;
    }).catch(() => null));
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
  // team logos: ESPN's small logos (they allow drawing into a picture, so "Download picture" keeps them)
  let LOGOS = null;
  const imgs = new Map();
  async function loadLogos() {
    if (LOGOS) return;
    const t = await getJSON("data/teams.json").catch(() => ({}));
    LOGOS = {};
    for (const lg of ["cfb", "nfl"]) for (const x of t[lg] || []) {
      const path = lg === "nfl" ? (x.logo || "").replace("https://a.espncdn.com", "") : `/i/teamlogos/ncaa/500/${x.id}.png`;
      if (path.startsWith("/i/")) LOGOS[`${lg}:${x.id}`] = `https://a.espncdn.com/combiner/i?img=${path}&w=160&h=160`;
    }
  }
  function logoImg(key, redraw) {
    const u = LOGOS?.[key];
    if (!u) return null;
    let im = imgs.get(u);
    if (!im) { im = new Image(); im.crossOrigin = "anonymous"; im.src = u; imgs.set(u, im); }
    if (!im.complete && redraw) im.addEventListener("load", redraw, { once: true });
    return im.complete && im.naturalWidth ? im : null;
  }
  async function loadChartJs() {
    if (window.Chart) return;
    await new Promise((ok, bad) => { const s = document.createElement("script"); s.src = CHART_JS; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }

  // ---------------------------------------------------------------- crunching
  // rows -> { key: {S: summed columns, g: games, wk: {week: S}} } for one season, weeks wk1..wk2
  function sum(D, who, w1, w2, byWeek) {
    const cols = who === "players" ? D.pcols : D.tcols, rows = who === "players" ? D.prows : D.trows, out = {};
    const left = who === "players" && st.noexit ? D.pcols.indexOf("left") + 3 : -1; // NFL QBs gone by halftime (hurt, or a blowout)
    for (const r of rows) {
      if (r[1] < w1 || r[1] > w2) continue;
      if (left > 2 && r[left]) continue;
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
  // NFL players also carry [3] role (EDGE, IDL, LB, CB, S, TE...), [4] year in the league (1 = rookie), [5] drafted ("R2 #45" or "UDFA")
  const FINE = { EDGE: "Edge rushers", IDL: "Interior D-line", LB: "Linebackers", CB: "Cornerbacks", S: "Safeties", TE: "Tight ends" };
  const EXP = [["", "Everyone"], ["1", "Rookies"], ["2", "2nd year"], ["3", "3rd year"], ["1-2", "Rookies + 2nd year"], ["4+", "Vets (4+ years)"]];
  const DRAFT = [["", "Any"], ["1", "1st round"], ["2-3", "Rounds 2-3"], ["4-7", "Rounds 4-7"], ["U", "Undrafted"]];
  const expOk = (y, e) => y != null && (e === "1-2" ? y >= 1 && y <= 2 : e === "4+" ? y >= 4 : y === +e);
  const draftOk = (dr, f) => { if (!dr) return false; const r = /^R(\d)/.exec(dr)?.[1]; return f === "U" ? !r : f === "1" ? r === "1" : f === "2-3" ? r === "2" || r === "3" : r >= "4"; };
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
    try { await Promise.all([loadChartJs(), loadLogos()]); } catch { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart library. Check your connection and try again.</div>`; return; }
    const span = seasons.filter((s) => s >= +st.from && s <= +st.to);
    const Ds = (await Promise.all(span.map(file))).filter(Boolean);
    await Promise.all(Ds.map(ours));
    if (!Ds.length) { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart data. Try again in a minute.</div>`; return; }
    draw(el, seasons, Ds);
  }
  const stSub = () => Live.statsSubtabs("visualize");

  // Presets: popular charts, one pick away (the Presets dropdown). People's own presets are added below these.
  const T_ = (o) => ({ who: "teams", ...o }), P_ = (o) => ({ who: "players", ...o });
  const PRESETS = {
    nfl: [
      ["Schedule vs record (the Schedules chart)", T_({ type: "scatter", stat: "ci_sos", y: "win_pct", top: "all" })],
      ["Who's for real: EPA per play vs points", T_({ type: "scatter", stat: "epa_play", y: "pts", top: "all" })],
      ["Best offenses (EPA per play)", T_({ type: "bar", stat: "epa_play", top: "15" })],
      ["Best defenses (EPA per play allowed)", T_({ type: "bar", stat: "def_epa_play", top: "15" })],
      ["Turnover margin", T_({ type: "bar", stat: "to_margin", per: "total", top: "all" })],
      ["Team profiles (radar)", T_({ type: "radar", top: "3" })],
      ["Top passers (EPA per dropback)", P_({ type: "bar", stat: "epa_db", pos: "QB", top: "15" })],
      ["QB efficiency vs volume", P_({ type: "scatter", stat: "epa_db", y: "pass_yds", pos: "QB", top: "all" })],
      ["Passing yards race", P_({ type: "line", stat: "pass_yds", pos: "QB", top: "5", cum: "1" })],
      ["QB profiles (radar)", P_({ type: "radar", pos: "QB", top: "3" })],
      ["Rushing yards race", P_({ type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" })],
      ["Workhorse RB1s (carries per game)", P_({ type: "bar", stat: "carries", role: "RB1", top: "15" })],
      ["Best WR1s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR1", top: "15" })],
      ["Best WR2s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR2", top: "15" })],
      ["Deep threats: yards per catch vs catch rate", P_({ type: "scatter", stat: "ypr", y: "catch_pct", pos: "WR", top: "25" })],
      ["Yards after catch leaders", P_({ type: "bar", stat: "yac", top: "15" })],
      ["Fantasy (PPR) leaders", P_({ type: "bar", stat: "ppr", top: "20" })],
      ["Sack leaders", P_({ type: "bar", stat: "def_sacks", per: "total", pos: "DEF", top: "15" })],
      ["DB coverage: passer rating allowed (corners)", P_({ type: "bar", stat: "cov_rating", pos: "CB", top: "15" })],
      ["DB coverage: success % vs yards per target (corners)", P_({ type: "scatter", stat: "cov_win", y: "cov_ypt", pos: "CB", top: "all" })],
      ["DB coverage: safeties, passer rating allowed", P_({ type: "bar", stat: "cov_rating", pos: "S", top: "15" })],
      ["DB coverage: rookie corners, success %", P_({ type: "bar", stat: "cov_win", pos: "CB", exp: "1", top: "15" })],
      ["DB coverage: most picked on (targets)", P_({ type: "bar", stat: "cov_tgt", per: "total", pos: "CB", top: "15" })],
      ["DB coverage: corner profiles (radar)", P_({ type: "radar", pos: "CB", top: "3" })],
      ["Deep cuts: pressure leaders", P_({ type: "bar", stat: "pressure", per: "total", pos: "DEF", top: "15" })],
      ["Deep cuts: missed tackles (most)", P_({ type: "bar", stat: "miss_tkl", per: "total", pos: "DEF", order: "worst", top: "15" })],
      ["Deep cuts: rookie LBs, run stops", P_({ type: "bar", stat: "run_stop", per: "total", pos: "LB", exp: "1", top: "15" })],
      ["Deep cuts: rookie LBs, stop rate vs run stops", P_({ type: "scatter", stat: "run_stop_rate", y: "run_stop", per: "total", pos: "LB", exp: "1", top: "all" })],
      ["Deep cuts: safeties who stop the run", P_({ type: "bar", stat: "run_stop", per: "total", pos: "S", top: "15" })],
      ["Deep cuts: undrafted run stoppers", P_({ type: "bar", stat: "run_stop", per: "total", pos: "DEF", draft: "U", top: "15" })],
      ["Deep cuts: rookie edge rushers, sacks + hits", P_({ type: "bar", stat: "heat", per: "total", pos: "EDGE", exp: "1", top: "15" })],
      ["Deep cuts: drive-killing sacks", P_({ type: "bar", stat: "third_sacks", per: "total", pos: "DEF", top: "15" })],
      ["Deep cuts: rookie DBs, ball production", P_({ type: "bar", stat: "ball", per: "total", pos: "CB", exp: "1", top: "15" })],
      ["Deep cuts: short-yardage backs", P_({ type: "bar", stat: "sy_conv_pct", pos: "RB", top: "15" })],
      ["Deep cuts: who gets stuffed most (RBs)", P_({ type: "bar", stat: "stuffed_pct", pos: "RB", order: "worst", top: "15" })],
      ["Deep cuts: rookie WRs, deep catches", P_({ type: "bar", stat: "deep_rec", per: "total", pos: "WR", exp: "1", top: "15" })],
      ["Deep cuts: 3rd-down go-to guys", P_({ type: "bar", stat: "third_conv", per: "total", top: "15" })],
      ["Deep cuts: clutch QBs", P_({ type: "bar", stat: "clutch", pos: "QB", top: "15" })],
      ["Deep cuts: deep ball QBs", P_({ type: "bar", stat: "deep_cmp_pct", pos: "QB", top: "15" })],
    ],
    cfb: [
      ["Schedule vs cupcakes (the Schedules chart)", T_({ type: "scatter", stat: "ci_sos", y: "ci_cupcake", top: "all" })],
      ["Who's for real: EPA per play vs points", T_({ type: "scatter", stat: "epa_play", y: "pts", top: "50" })],
      ["Power rating vs record (who's lucky?)", T_({ type: "scatter", stat: "ci_rating", y: "win_pct", top: "50" })],
      ["Best offenses (EPA per play)", T_({ type: "bar", stat: "epa_play", top: "15" })],
      ["Best defenses (EPA per play allowed)", T_({ type: "bar", stat: "def_epa_play", top: "15" })],
      ["Success rate vs EPA (consistent or explosive?)", T_({ type: "scatter", stat: "succ", y: "epa_play", top: "50" })],
      ["Third-down rate", T_({ type: "bar", stat: "third", top: "15" })],
      ["Team profiles (radar)", T_({ type: "radar", top: "3" })],
      ["Top passers (passing efficiency)", P_({ type: "bar", stat: "eff", pos: "QB", top: "15" })],
      ["Passing yards race", P_({ type: "line", stat: "pass_yds", pos: "QB", top: "5", cum: "1" })],
      ["QB profiles (radar)", P_({ type: "radar", pos: "QB", top: "3" })],
      ["Rushing yards race", P_({ type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" })],
      ["Best WR1s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR1", top: "15" })],
      ["Scrimmage yards leaders", P_({ type: "bar", stat: "scrim", top: "15" })],
      ["Sack leaders", P_({ type: "bar", stat: "def_sacks", per: "total", pos: "DEF", top: "15" })],
    ],
  };
  // your own presets: localStorage "viz-presets" {nfl: [{name, st}], cfb: [...]}, synced to your account when signed in (account.js)
  const MINE = "viz-presets";
  const mine = () => store.get(MINE) || {};
  const saveMine = (v) => store.set(MINE, v);
  const RADAR = { teams: ["epa_play", "def_epa_play", "ypp", "third", "giveaways", "def_sacks", "pts"], players: {
    QB: ["pass_yds", "pass_td", "cmp_pct", "ypa", "int", "epa_db", "eff", "rush_yds"], RB: ["rush_yds", "ypc", "rush_td", "rec", "rec_yds", "epa_rush"],
    WR: ["rec", "rec_yds", "rec_td", "ypr", "catch_pct", "epa_tgt", "yac"],
    CB: ["cov_rating", "cov_win", "cov_ypt", "cov_td", "ball", "def_int", "miss_pct"], S: ["cov_rating", "cov_win", "cov_ypt", "ball", "tackles", "run_stop", "miss_pct"], DEF: ["tackles", "def_sacks", "tfl", "qb_hits", "pd", "def_int"], K: ["fg_made", "fg_pct"], "": ["scrim", "tds", "rec_yds", "rush_yds", "pass_yds"] } };

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
    // depth chart role by actual use over the weeks picked: WR1 = the team's wide receiver with the most targets
    // (college: catches), RB1 = most carries + catches, QB1 = most pass attempts, TE1 = most targets among tight ends
    const role = {};
    if (who === "players" && st.role) {
      const fine = (k) => { const p = (meta(k)?.[1] || "").toUpperCase(), S = agg[k].S;
        if (["QB", "RB", "WR", "TE"].includes(p)) return p;
        if (["FB", "HB"].includes(p)) return "RB";
        return p ? "" : S.att >= 10 ? "QB" : S.carries > S.rec && S.carries >= 5 ? "RB" : S.rec ? "WR" : ""; };
      const use = { QB: (S) => S.att + S.sacked, RB: (S) => S.carries + S.rec, WR: (S) => (S.targets || S.rec) + S.rec_yds / 1000, TE: (S) => (S.targets || S.rec) + S.rec_yds / 1000 };
      const groups = {};
      for (const k in agg) { const f = fine(k); if (f) (groups[`${agg[k].team}|${f}`] ||= []).push(k); }
      for (const [g, list] of Object.entries(groups)) {
        const f = g.split("|")[1];
        list.sort((a, b) => use[f](agg[b].S) - use[f](agg[a].S)).forEach((k, i) => { role[k] = f + (i + 1); });
      }
    }
    const ok = (k) => {
      const a = agg[k], t = tm(teamOf(k));
      if (st.group && t[3] !== st.group) return false;
      if (who === "players" && st.team && teamOf(k) !== st.team) return false;
      if (who === "players" && st.role) return role[k] === st.role;
      if (who === "players" && st.pos && (FINE[st.pos] ? meta(k)?.[3] !== st.pos : POS_OF(meta(k)?.[1], a.S) !== st.pos)) return false;
      if (who === "players" && st.exp && !expOk(meta(k)?.[4], st.exp)) return false;
      if (who === "players" && st.draft && !draftOk(meta(k)?.[5], st.draft)) return false;
      return true;
    };
    let keys = Object.keys(agg).filter(ok);
    // rates: only who has at least 35% of the leader's attempts/plays (picked ones always count)
    // who counts for a rate stat: your minimum (in the stat's own unit: dropbacks, carries...) for the main stat,
    // otherwise 35% of the leader's. Highlighted ones always count.
    const autoMin = (s) => s[3].den ? Math.round(0.35 * Math.max(0, ...keys.map((k) => s[3].den(agg[k].S, agg[k].g) || 0))) : 0;
    const minFor = (s) => (st.min !== "" && s === stat ? +st.min : autoMin(s));
    const qualify = (s) => {
      if (!s[3].den) return keys;
      const m = minFor(s);
      return keys.filter((k) => picks.includes(k) || (s[3].den(agg[k].S, agg[k].g) || 0) >= m);
    };
    const UNITS = { epa_db: "dropbacks", pass_epa_play: "pass plays", rush_epa_play: "rushes", epa_rush: "carries", ypc: "carries", ypr: "catches",
      catch_pct: "targets", epa_tgt: "targets", fg_pct: "field goal tries", third: "third downs", ppa_play: "plays", win_pct: "games" };
    const unitOf = (s) => UNITS[s[0]] || s[3].unit || (["ypa", "cmp_pct", "rating", "eff"].includes(s[0]) ? "pass attempts" : who === "teams" ? "plays" : "attempts");
    const per = st.type === "pie" ? "total" : st.per; // a pie is a share of the whole: always season totals
    const val = (s, k) => value(s, agg[k].S, agg[k].g, per);
    const rank = (s, list) => list.filter((k) => val(s, k) != null).sort((a, b) => (s[3].low ? 1 : -1) * (val(s, a) - val(s, b)) * (st.order === "worst" ? -1 : 1));
    const top = st.top === "all" ? 9999 : +st.top || 10;
    const name = (k) => who === "players" ? meta(k)?.[0] || k : tm(k)[0];
    const short = (k) => who === "players" ? (meta(k)?.[0] || k).replace(/^(\S)\S*\s/, "$1. ") : tm(k)[1] || tm(k)[0];
    const color = (k) => tm(teamOf(k))[2] || "#888";
    const PAL = [accentOf(), "#4cc9f0", "#f72585", "#b5e48c", "#ffd166", "#9b5de5", "#00f5d4", "#ff8fab", "#90be6d", "#f4a261", "#577590", "#e9c46a"]; // lines, pie slices, radar: easy to tell apart
    function accentOf() { return getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#ff6b2c"; }
    const css = getComputedStyle(document.body), C = (v) => css.getPropertyValue(v).trim();
    const ink = C("--ink"), muted = C("--muted"), line = C("--line"), accent = C("--accent");
    const weeksTxt = `${w1 > 1 || w2 < 99 ? `Weeks ${w1}–${D.bowls && w2 >= D.bowls ? "bowls" : Math.min(w2, maxWk)}` : league === "nfl" ? "Regular season" : "Full season incl. bowls"}`;
    const seasonTxt = multi ? `${st.from}–${st.to}` : st.to;
    const perTxt = (s) => (s[3].count && per === "game" ? " per game" : "");
    const lgTxt = league === "nfl" ? "NFL" : "College";
    let title = "", body = "", note = "";
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const statSel = (id, v) => `<select id="${id}">${groups.map(([g, l]) => `<optgroup label="${esc(g)}">${l.map((s) => `<option value="${s[0]}"${s[0] === v ? " selected" : ""}>${esc(s[1])}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const seg = (id, opts, v) => `<div class="seg vz-seg" id="${id}">${opts.map(([k, l]) => `<button data-v="${k}" class="${k === v ? "active" : ""}">${l}</button>`).join("")}</div>`;
    const posOpts = [["", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR / TE"], ...(D.xcols?.length ? [["TE", "TE only"]] : []), ["K", "Kicker"], ["DEF", "Defense"],
      ...(D.xcols?.length ? Object.entries(FINE).filter(([k]) => k !== "TE").map(([k, l]) => [k, `Defense: ${l}`]) : [])];
    const wkOpts = [["", "–"], ...Array.from({ length: Math.max(maxWk, D.league === "nfl" ? 18 : 1) }, (_, i) => [i + 1, D.bowls && i + 1 >= D.bowls ? "Bowls" : i + 1])];

    // the chart
    let cfg;
    const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, devicePixelRatio: Math.max(3, window.devicePixelRatio || 1), // drawn at 3x: sharp on any screen and in the downloaded picture
      plugins: { legend: { labels: { color: ink, font: { family: "JetBrains Mono", size: 11 } } }, tooltip: { titleFont: { family: "JetBrains Mono" }, bodyFont: { family: "JetBrains Mono" } } },
      scales: { x: { ticks: { color: muted, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: line } }, y: { ticks: { color: muted, font: { family: "JetBrains Mono", size: 10 } }, grid: { color: line } } } };
    const hl = (k) => picks.includes(k);
    const showLogo = st.logo !== "0", showNames = st.names !== "0" || !showLogo; // something has to say who's who
    const redraw = () => chart?.draw();
    const drawLogo = (ctx, k, x, y, sz) => { const im = logoImg(teamOf(k), redraw); if (im) ctx.drawImage(im, x - sz / 2, y - sz / 2, sz, sz); return !!im; };
    if (st.type === "bar") {
      const list = rank(stat, qualify(stat));
      const shown = [...new Set([...list.slice(0, top), ...picks.filter((k) => list.includes(k))])];
      title = `${stat[1]}${perTxt(stat)}`;
      cfg = { type: "bar", data: { labels: shown.map(short), datasets: [{ data: shown.map((k) => val(stat, k)), backgroundColor: shown.map((k) => hl(k) ? accent : color(k)),
        borderColor: shown.map((k) => (hl(k) ? ink : "transparent")), borderWidth: 2 }] },
        options: { ...base, indexAxis: "y", layout: { padding: { right: 56 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { title: (c) => name(shown[c[0].dataIndex]), label: (c) => fmt(stat, c.raw, st.per) } } },
          scales: { ...base.scales, y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, autoSkip: false, display: showNames, padding: showLogo ? 28 : 3 },
            afterFit: (sc) => { if (showLogo) sc.width = Math.max(sc.width, 30); } } } },
        plugins: [{ id: "vzBar", afterDatasetsDraw(c) { // logo by each name, the number at the end of each bar
          const { ctx, chartArea: a } = c;
          ctx.save(); ctx.font = "bold 10px JetBrains Mono"; ctx.textBaseline = "middle";
          c.getDatasetMeta(0).data.forEach((b, i) => {
            const v = c.data.datasets[0].data[i], sz = Math.min(20, b.height + 4);
            if (showLogo) drawLogo(ctx, shown[i], a.left - sz / 2 - 4, b.y, sz);
            ctx.fillStyle = ink; ctx.textAlign = v < 0 ? "right" : "left";
            ctx.fillText(fmt(stat, v, st.per), b.x + (v < 0 ? -4 : 4), b.y);
          });
          ctx.restore(); } }] };
      body = { h: Math.max(260, shown.length * 26 + 60) };
      note = `${list.length} ${who} ranked${stat[3].den ? ` (at least ${minFor(stat)} ${unitOf(stat)}${st.min === "" ? ", 35% of the leader's; change it with Minimum" : ""})` : ""}.`;
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
        options: { ...base, layout: { padding: { right: showLogo ? 26 : 0 } }, plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: showNames }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${fmt({ 3: { ...stat[3], count: 0 } }, c.raw)}` } } } },
        plugins: [{ id: "vzLine", afterDatasetsDraw(c) { // each line ends in its team's logo
          if (!showLogo) return;
          c.data.datasets.forEach((d, i) => {
            const pts = c.getDatasetMeta(i).data, j = d.data.map((v) => v != null).lastIndexOf(true);
            if (j >= 0) drawLogo(c.ctx, sers[i], pts[j].x + 14, pts[j].y, 20);
          }); } }] };
      body = { h: 380 };
      note = picks.length ? "" : `The top ${sers.length} in ${stat[1].toLowerCase()}. Pick ${who} below to compare your own.`;
    } else if (st.type === "pie") {
      const s = stat[3].count ? stat : all.find((x) => x[3].count);
      st.stat = s[0];
      const list = rank(s, keys).filter((k) => val(s, k) > 0), n = Math.min(top, 12);
      const shown = list.slice(0, n), rest = list.slice(n).reduce((a, k) => a + val(s, k), 0);
      const total = list.reduce((a, k) => a + val(s, k), 0);
      title = `${who === "players" && st.team ? tm(st.team)[0] + ": " : ""}share of ${s[1].toLowerCase()}`.replace(/^s/, "S");
      cfg = { type: "doughnut", data: { labels: [...shown.map(short), ...(rest ? ["Everyone else"] : [])],
        datasets: [{ data: [...shown.map((k) => val(s, k)), ...(rest ? [rest] : [])], backgroundColor: [...shown.map((k, i) => PAL[i % PAL.length]), ...(rest ? [line] : [])], borderColor: C("--card"), borderWidth: 2 }] },
        plugins: [{ id: "vzPie", afterDatasetsDraw(c) { // team logos on their slices; the share shows on hover
          if (!showLogo || who !== "teams") return;
          c.getDatasetMeta(0).data.forEach((arc, i) => { if (i < shown.length && arc.circumference > 0.3) { const p = arc.tooltipPosition(); drawLogo(c.ctx, shown[i], p.x, p.y, 24); } }); } }],
        options: { ...base, scales: {}, plugins: { ...base.plugins, legend: { position: "bottom", labels: base.plugins.legend.labels, display: showNames },
          tooltip: { ...base.plugins.tooltip, callbacks: {
            title: (c) => (c[0].dataIndex < shown.length ? name(shown[c[0].dataIndex]) : "Everyone else"),
            label: (c) => `${Math.round((100 * c.raw) / total)}% of the ${who === "players" && st.team ? "team's" : "total"} ${s[1].toLowerCase()}`,
            afterLabel: (c) => `(${fmt({ 3: { ...s[3], count: 0, d: per === "game" ? 1 : s[3].d } }, c.raw)} ${s[1].toLowerCase()}${perTxt(s)})` } } } } };
      body = { h: 420 };
      note = who === "players" && !st.team ? "Tip: pick a team in Filters to see how one team splits it up (who gets the carries, the targets...)." : "";
      if (!stat[3].count) note = `Pie charts need a total, so this shows ${s[1].toLowerCase()}. ` + note;
    } else if (st.type === "scatter") {
      const pool = qualify(stat).filter((k) => qualify(ystat).includes(k)).filter((k) => val(stat, k) != null && val(ystat, k) != null);
      // How many: the top N by the stat across the bottom (X), plus anyone highlighted
      const both = [...new Set([...rank(stat, pool).slice(0, top), ...picks.filter((k) => pool.includes(k))])];
      title = `${stat[1]}${perTxt(stat)} vs ${ystat[1].toLowerCase()}${perTxt(ystat)}`;
      const label = new Set([...rank(stat, both).slice(0, 4), ...rank(ystat, both).slice(0, 4), ...rank(stat, both).slice(-2), ...picks]);
      const pts = both.map((k) => ({ x: val(stat, k), y: val(ystat, k), k }));
      const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), mx = avg(pts.map((p) => p.x)), my = avg(pts.map((p) => p.y));
      const named = !showNames ? new Set() : pts.length <= 40 ? new Set(pts.map((p) => p.k)) : label; // every name when there's room
      cfg = { type: "scatter", data: { datasets: [{ data: pts, pointRadius: pts.map((p) => (showLogo ? 11 : hl(p.k) ? 7 : 5)), pointHoverRadius: showLogo ? 13 : 7,
        pointBackgroundColor: pts.map((p) => (showLogo ? "transparent" : hl(p.k) ? accent : color(p.k))), pointBorderColor: pts.map((p) => (showLogo ? (hl(p.k) ? accent : "transparent") : ink)),
        pointBorderWidth: pts.map((p) => (hl(p.k) ? 2 : showLogo ? 0 : 0.5)) }] },
        options: { ...base, layout: { padding: { right: 36, top: 8 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${name(c.raw.k)}: ${fmt(stat, c.raw.x, st.per)}, ${fmt(ystat, c.raw.y, st.per)}` } } },
          scales: { x: { ...base.scales.x, reverse: !!stat[3].low, title: { display: true, text: stat[1] + perTxt(stat) + (stat[3].low ? " (better →)" : ""), color: muted } },
            y: { ...base.scales.y, reverse: !!ystat[3].low, title: { display: true, text: ystat[1] + perTxt(ystat) + (ystat[3].low ? " (better ↑)" : ""), color: muted } } } },
        plugins: [{ id: "vzLabels", afterDatasetsDraw(c) {
          const { ctx, chartArea: a, scales: { x, y } } = c;
          ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = muted; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x.getPixelForValue(mx), a.top); ctx.lineTo(x.getPixelForValue(mx), a.bottom); ctx.moveTo(a.left, y.getPixelForValue(my)); ctx.lineTo(a.right, y.getPixelForValue(my)); ctx.stroke();
          ctx.setLineDash([]); ctx.font = "10px JetBrains Mono"; ctx.fillStyle = ink;
          c.getDatasetMeta(0).data.forEach((p, i) => {
            const sz = hl(pts[i].k) ? 26 : 20, logo = showLogo && drawLogo(ctx, pts[i].k, p.x, p.y, sz);
            if (showLogo && !logo) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fillStyle = color(pts[i].k); ctx.fill(); ctx.fillStyle = ink; } // no logo (an FCS team): a dot
            if (named.has(pts[i].k)) ctx.fillText(short(pts[i].k), p.x + (showLogo ? 13 : 7), p.y + 3);
          });
          ctx.restore(); } }] };
      body = { h: 440 };
      note = `${both.length < pool.length ? `Top ${both.length} of ${pool.length} ${who} by ${stat[1].toLowerCase()}` : `${both.length} ${who}`}${stat[3].den ? ` (at least ${minFor(stat)} ${unitOf(stat)} for ${stat[1].toLowerCase()})` : ""}. Dashed lines are the averages. ${stat[3].low || ystat[3].low ? "Axes are flipped where lower is better, so up and right is always good." : "Up and right is good."}`;
    } else { // radar: percentiles among everyone shown
      const want = who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""];
      const custom = st.radar ? st.radar.split(",") : want;
      const axes = custom.map((k) => all.find((s) => s[0] === k)).filter(Boolean).slice(0, 8);
      const lead = rank(axes[0], qualify(axes[0]));
      const sers = (picks.length ? picks.filter((k) => agg[k]) : lead.slice(0, Math.min(top, 4))).slice(0, 5);
      // compare against real workloads only (a backup with 5 throws and 0 picks isn't the bar for interceptions)
      const VOL = { QB: (S) => S.att, RB: (S) => S.carries, WR: (S) => S.rec, DEF: (S) => S.tackles, K: (S) => S.fg_att };
      const vol = who === "players" ? VOL[st.pos] || ((S) => S.att + S.carries + S.rec + S.tackles) : null;
      const most = vol ? Math.max(...keys.map((x) => vol(agg[x].S) || 0)) : 0;
      const regulars = vol ? keys.filter((x) => picks.includes(x) || (vol(agg[x].S) || 0) >= (st.min !== "" ? +st.min : most * 0.35)) : keys;
      const pctile = (s, k) => { const q = qualify(s).filter((x) => regulars.includes(x)), v = val(s, k); if (v == null) return null; const vals = q.map((x) => val(s, x)).filter((x) => x != null);
        const below = vals.filter((x) => (s[3].low ? x > v : x < v)).length; return Math.round((100 * below) / Math.max(1, vals.length - 1)); };
      title = `${who === "teams" ? "Team" : "Player"} profiles (percentile among ${who}${st.pos ? ` at ${st.pos}` : ""})`;
      cfg = { type: "radar", data: { labels: axes.map((s) => s[1].replace(/ \(.+\)/, "")), datasets: sers.map((k, i) => ({ label: short(k), data: axes.map((s) => pctile(s, k)),
        borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length] + "33", borderWidth: 2, pointRadius: 2 })) },
        options: { ...base, scales: { r: { min: 0, max: 100, ticks: { display: false, stepSize: 25 }, grid: { color: line }, angleLines: { color: line }, pointLabels: { color: ink, font: { family: "JetBrains Mono", size: 10 } } } },
          plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${axes[c.dataIndex][1]} ${fmt(axes[c.dataIndex], val(axes[c.dataIndex], sers[c.datasetIndex]), st.per)} (better than ${c.raw}%)` } } } } };
      body = { h: 440 };
      note = "100 = the best among everyone listed, 0 = the worst. Lower-is-better stats are flipped.";
    }
    const sub = `${lgTxt} · ${seasonTxt} · ${weeksTxt}${st.group ? ` · ${st.group}` : ""}${st.team ? ` · ${tm(st.team)[0]}` : ""}${st.role ? ` · ${st.role}s` : st.pos ? ` · ${st.pos === "DEF" ? "Defense" : FINE[st.pos] || st.pos}` : ""}${who === "players" && st.exp ? ` · ${EXP.find(([k]) => k === st.exp)?.[1]}` : ""}${who === "players" && st.draft ? ` · ${st.draft === "U" ? "Undrafted" : `Drafted: ${DRAFT.find(([k]) => k === st.draft)?.[1]}`}` : ""}`;
    const src = league === "nfl" ? "nflverse play-by-play (EPA)" : "CollegeFootballData.com (box scores; PPA = college EPA, garbage time left out)";
    const seasonOnly = [stat, ystat].some((s) => s[3].season) && (w1 > 1 || w2 < 99);

    el.innerHTML = stSub() + `<div class="card vz">
      <div class="sc-bar"><h2>Visualize</h2><span class="muted vz-tag">Make a chart, win the argument.</span></div>
      <div class="vz-q vz-findwrap"><input id="vz-q" type="search" placeholder="Search stats, presets, positions, teams… (try “run stops” or “rookie”)" autocomplete="off" spellcheck="false"><div class="vz-sugg" id="vz-qs" hidden></div></div>
      <div class="vz-presets">
        <label>Presets<select id="vz-preset"><option value="">Pick a chart…</option>
          <optgroup label="Popular">${PRESETS[league].map(([l], i) => `<option value="p${i}">${esc(l)}</option>`).join("")}</optgroup>
          ${(mine()[league] || []).length ? `<optgroup label="Yours">${mine()[league].map((m, i) => `<option value="m${i}">${esc(m.name)}</option>`).join("")}</optgroup>` : ""}
        </select></label>
        <button class="btn" id="vz-save" type="button">Save as preset</button>
        ${(mine()[league] || []).length ? `<button class="btn" id="vz-del" type="button" title="Delete one of your presets">Delete…</button>` : ""}
        <span class="vz-saveform hidden" id="vz-saveform"><input id="vz-pname" maxlength="40" placeholder="Name this chart"><button class="btn tour-next" id="vz-pok" type="button">Save</button><button class="btn" id="vz-pno" type="button">Cancel</button></span>
        <small class="muted" id="vz-pmsg"></small>
      </div>
      <div class="vz-ctl">
        <label>Chart${seg("vz-type", [["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["radar", "Radar"]], st.type)}</label>
        <label>Of${seg("vz-who", [["teams", "Teams"], ["players", "Players"]], who)}</label>
        ${st.type === "radar" ? `<details class="vz-wide vz-rstats"><summary>Stats on the web (${axes().length}) · tap to change</summary><div id="vz-radar">${groups.map(([g, l]) => `<fieldset><legend>${esc(g)}</legend>${l.map((s) => `<label><input type="checkbox" value="${s[0]}"${custom().includes(s[0]) ? " checked" : ""}> ${esc(s[1])}</label>`).join("")}</fieldset>`).join("")}<p class="muted">Pick 3 to 8.</p></div></details>`
          : `<label class="vz-wide">${st.type === "scatter" ? "Across (X)" : "Stat"}${statSel("vz-stat", stat[0])}</label>${st.type === "scatter" ? `<label class="vz-wide">Up (Y)${statSel("vz-y", ystat[0])}</label>` : ""}`}
        <label>Seasons<span class="vz-pair">${sel("vz-from", seasons.map((s) => [s, s]), st.from)}<i>to</i>${sel("vz-to", seasons.map((s) => [s, s]), st.to)}</span></label>
        <label>Weeks<span class="vz-pair">${sel("vz-wk1", wkOpts, st.wk1)}<i>to</i>${sel("vz-wk2", wkOpts, st.wk2)}</span></label>
        ${st.type === "pie" ? "" : `<label>Totals${seg("vz-per", [["game", "Per game"], ["total", "Total"]], st.per)}</label>`}
        ${st.type === "bar" ? `<label>Show${seg("vz-order", [["best", "Best"], ["worst", "Worst"]], st.order)}</label>` : ""}
        ${st.type === "line" && !multi ? `<label>Line${seg("vz-cum", [["", "Each week"], ["1", "Running total"]], st.cum)}</label>` : ""}
        <label>How many${sel("vz-top", [...[5, 10, 15, 20, 25, 50, 100].map((x) => [x, `Top ${x}`]), ["all", "All"]], st.top)}</label>
        ${stat[3].den && st.type !== "pie" || (st.type === "radar" && who === "players") ? `<label>Minimum <small class="muted">${esc(st.type === "radar" ? { QB: "pass attempts", RB: "carries", WR: "catches", DEF: "tackles", CB: "tackles", S: "tackles", K: "field goal tries" }[st.pos] || "touches" : unitOf(stat))}</small><input id="vz-min" type="number" min="0" inputmode="numeric" placeholder="auto ${st.type === "radar" ? "" : autoMin(stat)}" value="${esc(st.min)}"></label>` : ""}
        ${who === "players" && D.pcols.includes("left") ? `<div class="vz-chks"><label title="Games a player left by halftime (usually hurt, sometimes rested in a blowout). QBs: threw or ran in the first half and never after. Everyone else: a regular who played under half his side's snaps."><input type="checkbox" id="vz-noexit"${st.noexit ? " checked" : ""}> Leave out games they left by halftime</label></div>` : ""}
        ${st.type !== "radar" ? `<div class="vz-chks"><label><input type="checkbox" id="vz-logo"${st.logo !== "0" ? " checked" : ""}> Team logos</label><label><input type="checkbox" id="vz-names"${st.names !== "0" ? " checked" : ""}> ${who === "teams" ? "Team" : "Player"} names</label></div>` : ""}
      </div>
      <details class="vz-more"${st.group || st.team || st.pos || st.exp || st.draft || picks.length ? " open" : ""}><summary>Filters and highlights</summary><div class="vz-ctl">
        <label>${league === "nfl" ? "Division" : "Conference"}${sel("vz-group", [["", "All"], ...confs.map((c) => [c, c])], st.group)}</label>
        ${who === "players" ? `<label>Team${sel("vz-team", [["", "All teams"], ...Object.entries(D.teams).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, t]) => [k, t[0]])], st.team)}</label>
          <label>Position${sel("vz-pos", posOpts, st.pos)}</label>
          ${D.xcols?.length ? `<label>Experience${sel("vz-exp", EXP, st.exp)}</label><label>Drafted${sel("vz-draft", DRAFT, st.draft)}</label>` : ""}
          <label>Depth chart${sel("vz-role", [["", "Any"], ...["QB1", "QB2", "RB1", "RB2", "RB3", "WR1", "WR2", "WR3", "WR4", "TE1", "TE2"].map((r) => [r, r])], st.role)}</label>` : ""}
        <label class="vz-wide vz-findwrap">Highlight / compare<input id="vz-find" placeholder="Type a ${who === "teams" ? "team" : "player"}…" autocomplete="off" spellcheck="false"><div class="vz-sugg" id="vz-sugg" hidden></div></label>
        <div class="vz-picks">${picks.map((k) => `<button data-k="${esc(k)}" title="Remove">${esc(name(k))} ×</button>`).join("")}</div>
      </div></details>
      <div class="vz-frame" id="vz-frame"><div class="vz-title"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        <div class="vz-canvas" style="height:${body.h}px"><canvas id="vz-chart"></canvas></div>
        <div class="vz-mark">cupcakeindex.com · ${esc(league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com")}</div></div>
      ${seasonOnly ? `<p class="note">Our ratings and college PPA are season-long numbers (as of the latest rankings), so they ignore the weeks you picked.</p>` : ""}
      <div class="vz-actions">${Share.phone() && navigator.share ? "" : `<button class="btn" id="vz-png">Download picture</button>`}<button class="btn" id="vz-link">Copy link</button>${navigator.share ? `<button class="btn" id="vz-share">Share</button>` : ""}<button class="btn vz-reset" id="vz-reset">Start over</button></div>
      ${body.table ? `<details class="vz-tbl"><summary>See the numbers</summary><table class="box"><tbody>${body.table.map(([i, k, v]) => `<tr><td class="num muted">${i}</td><td>${who === "players" && /^\d+$/.test(k) ? `<a href="#/player/${esc(k)}?league=${league}">${esc(name(k))}</a>` : who === "teams" ? `<a href="#/team/${esc(k.split(":")[1])}?league=${league}">${esc(name(k))}</a>` : esc(name(k))}</td><td class="num">${esc(v)}</td></tr>`).join("")}</tbody></table></details>` : ""}
      <p class="note">${st.role ? esc(`${st.role} = each team's ${(({ QB: "quarterback with the most pass attempts", RB: "back with the most carries + catches", WR: "wide receiver with the most targets", TE: "tight end with the most targets" })[st.role.slice(0, 2)]).replace("the most", st.role.endsWith("1") ? "the most" : `the ${{ 2: "2nd", 3: "3rd", 4: "4th" }[st.role.slice(2)]}-most`)} in the weeks you picked${league === "cfb" ? " (catches stand in for targets in college)" : ""}. `) : ""}${esc(note)} Source: ${esc(src)}. Rates are total ÷ total over the weeks you pick, not an average of weekly averages. Updated ${esc(new Date(D.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}.</p></div>`;
    function custom() { return st.radar ? st.radar.split(",") : who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""]; }
    function axes() { return custom().filter((k) => all.some((s) => s[0] === k)); }

    chart?.destroy();
    chart = new Chart(document.getElementById("vz-chart"), cfg);
    if (typeof Stats !== "undefined") Stats.count("charts"); // analytics: charts made
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
    const on = (id, k, again = redo) => { const x = document.getElementById(id); if (x) x.onchange = () => { st[k] = x.value; if (k === "pos") st.radar = ""; if (k === "stat" || k === "pos") st.min = ""; again(); }; };
    const mi = document.getElementById("vz-min");
    if (mi) mi.onchange = () => { st.min = mi.value === "" ? "" : String(Math.max(0, Math.round(+mi.value) || 0)); redo(); };
    on("vz-role", "role");
    on("vz-stat", "stat"); on("vz-y", "y"); on("vz-wk1", "wk1"); on("vz-wk2", "wk2"); on("vz-top", "top"); on("vz-group", "group"); on("vz-team", "team"); on("vz-pos", "pos"); on("vz-exp", "exp"); on("vz-draft", "draft");
    on("vz-from", "from", reload); on("vz-to", "to", reload);
    const nx = document.getElementById("vz-noexit");
    if (nx) nx.onchange = () => { st.noexit = nx.checked ? "1" : ""; redo(); };
    ["logo", "names"].forEach((k) => { const x = document.getElementById("vz-" + k); if (x) x.onchange = () => { st[k] = x.checked ? "" : "0"; redo(); }; });
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
    // Search box: one place to find any stat, preset, position, team or filter instead of scrolling the dropdowns.
    // Each item: [label, what it is, extra words to match, apply()]
    const qbox = document.getElementById("vz-q"), qs = document.getElementById("vz-qs");
    const setWho = (w) => { if (w !== st.who) { st.who = w; st.pick = ""; st.team = ""; st.pos = ""; st.radar = ""; st.role = ""; } };
    const qItems = () => [
      ...PRESETS[league].map(([l, o]) => [l, "Preset", "chart idea", () => { st = { ...DEF, from: st.from, to: st.to, ...o }; reload(); }]),
      ...(mine()[league] || []).map((m) => [m.name, "Your preset", "mine saved", () => { st = { ...DEF, from: st.from, to: st.to, ...m.st }; reload(); }]),
      ...["players", "teams"].flatMap((w) => statsFor(w, D).flatMap(([g, l]) => l.map((x) => [x[1], `${w === "players" ? "Player" : "Team"} stat · ${g}`, `${g} ${x[0]}`,
        () => { setWho(w); if (st.type === "radar" || st.type === "pie" && !x[3].count) st.type = "bar"; st.stat = x[0]; st.min = ""; redo(); }]))),
      ...posOpts.filter(([k]) => k).map(([k, l]) => [l, "Position", `${k} position players`, () => { setWho("players"); st.pos = k; st.role = ""; st.min = ""; redo(); }]),
      ...(D.xcols?.length ? EXP.filter(([k]) => k).map(([k, l]) => [l, "Experience", "years experience rookie", () => { setWho("players"); st.exp = k; redo(); }]) : []),
      ...(D.xcols?.length ? DRAFT.filter(([k]) => k).map(([k, l]) => [l === "Any" ? l : k === "U" ? "Undrafted" : `Drafted: ${l}`, "Drafted", "draft round pick", () => { setWho("players"); st.draft = k; redo(); }]) : []),
      ...Object.entries(D.teams).map(([k, t]) => [t[0], "Team", `${t[1]} ${t[3] || ""}`, () => {
        if (st.who === "players") st.team = k; else st.pick = [...(st.pick ? st.pick.split(",") : []).filter((x) => x !== k), k].slice(-6).join(","); redo(); }]),
      ...confs.map((c) => [c, league === "nfl" ? "Division" : "Conference", "group", () => { st.group = c; redo(); }]),
      ...[["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["radar", "Radar"]].map(([k, l]) => [`${l} chart`, "Chart type", "chart type", () => { st.type = k; st.radar = ""; redo(); }]),
    ];
    let qHits = [], qCur = -1;
    const qShow = () => {
      const q = norm(qbox.value.trim());
      if (q.length < 2) { qs.hidden = true; qHits = []; return; }
      const words = q.split(/\s+/);
      qHits = qItems().map((it) => [it, norm(it[0]), norm(`${it[0]} ${it[1]} ${it[2]}`)]).filter(([, , all]) => words.every((w) => all.includes(w)))
        .map(([it, l]) => [it, l.startsWith(q) ? 0 : words.every((w) => l.includes(w)) ? 1 : 2]).sort((a, b) => a[1] - b[1]).slice(0, 12).map((x) => x[0]);
      qCur = -1;
      qs.innerHTML = qHits.map((it, i) => `<button type="button" data-i="${i}">${esc(it[0])} <small>${esc(it[1])}</small></button>`).join("")
        || `<p class="muted">Nothing matches “${esc(qbox.value.trim())}”.</p>`;
      qs.hidden = false;
    };
    const qPick = (it) => { if (it) { qbox.value = ""; qs.hidden = true; it[3](); } };
    qbox.oninput = qShow;
    qbox.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); qCur = Math.max(0, Math.min(qHits.length - 1, qCur + (e.key === "ArrowDown" ? 1 : -1)));
        qs.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", i === qCur));
      } else if (e.key === "Enter") { e.preventDefault(); qPick(qHits[Math.max(qCur, 0)]); }
      else if (e.key === "Escape") qs.hidden = true;
    };
    qs.onmousedown = (e) => e.preventDefault();
    qs.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) qPick(qHits[+b.dataset.i]); };
    qbox.onblur = () => setTimeout(() => (qs.hidden = true), 150);
    // presets: pick one (popular or yours), save the current chart as yours, or delete one of yours
    const pick = document.getElementById("vz-preset");
    pick.onchange = () => {
      const v = pick.value;
      if (!v) return;
      const chosen = v[0] === "p" ? PRESETS[league][+v.slice(1)]?.[1] : (mine()[league] || [])[+v.slice(1)]?.st;
      if (chosen) { st = { ...DEF, from: st.from, to: st.to, ...chosen }; reload(); }
    };
    const form = document.getElementById("vz-saveform"), msg = document.getElementById("vz-pmsg"), nm = document.getElementById("vz-pname");
    document.getElementById("vz-save").onclick = () => { form.classList.remove("hidden"); nm.value = title.slice(0, 40); nm.focus(); nm.select(); };
    document.getElementById("vz-pno").onclick = () => form.classList.add("hidden");
    const doSave = () => {
      const name = nm.value.trim();
      if (!name) return nm.focus();
      const all = mine(), list = (all[league] || []).filter((m) => m.name !== name); // same name: replace it
      const keep = Object.fromEntries(Object.entries(st).filter(([k, v]) => v !== "" && v !== DEF[k] && k !== "from" && k !== "to"));
      list.unshift({ name, st: keep });
      all[league] = list.slice(0, 30);
      saveMine(all);
      const signed = typeof Account !== "undefined" && Account.user();
      redo();
      const m = document.getElementById("vz-pmsg");
      if (m) m.textContent = signed ? `Saved “${name}” to your account.` : `Saved “${name}” on this device. Sign in (Settings) to keep it on every device.`;
    };
    document.getElementById("vz-pok").onclick = doSave;
    nm.onkeydown = (e) => { if (e.key === "Enter") doSave(); else if (e.key === "Escape") form.classList.add("hidden"); };
    const del = document.getElementById("vz-del");
    if (del) del.onclick = () => {
      const list = mine()[league] || [];
      const which = window.prompt(`Delete which preset? Type its name:\n${list.map((m) => "• " + m.name).join("\n")}`);
      if (!which) return;
      const all = mine(), left = list.filter((m) => m.name.toLowerCase() !== which.trim().toLowerCase());
      if (left.length === list.length) { msg.textContent = `No preset called “${which}”.`; return; }
      all[league] = left; saveMine(all); redo();
    };
    document.getElementById("vz-reset").onclick = () => { st = { ...DEF }; reload(); };
    const png = document.getElementById("vz-png"); // not on phones: Share does it there
    if (png) png.onclick = () => picture().then((c) => { if (typeof Stats !== "undefined") Stats.count("downloads"); const a = document.createElement("a"); a.href = c.toDataURL("image/png"); a.download = `cupcake-index-${st.stat}.png`; a.click(); });
    document.getElementById("vz-link").onclick = (e) => { navigator.clipboard?.writeText(location.href).then(() => { e.target.textContent = "Link copied"; setTimeout(() => (e.target.textContent = "Copy link"), 1500); }); };
    const sh = document.getElementById("vz-share");
    if (sh) sh.onclick = () => picture().then((c) => c.toBlob((b) => {
      const f = new File([b], "cupcake-index-chart.png", { type: "image/png" });
      (navigator.canShare?.({ files: [f] }) ? navigator.share({ files: [f], title }) : navigator.share({ url: location.href, title })).catch(() => {});
    }));

    // the picture: title, chart and the site's mark on the card color, 2x for sharp text
    // fine print under the picture: every setting behind it, so anyone can check (or rebuild) the chart
    function synopsis() {
      const u = (s) => (s[3].den ? ` (min. ${minFor(s)} ${unitOf(s)})` : "");
      const parts = [
        st.type === "scatter" ? `X: ${stat[1]}${perTxt(stat)}${u(stat)} · Y: ${ystat[1]}${perTxt(ystat)}${u(ystat)}`
          : st.type === "radar" ? `Stats: ${custom().map((k) => all.find((s) => s[0] === k)?.[1]).filter(Boolean).join(", ")} (percentiles)`
          : `Stat: ${stat[1]}${st.type === "pie" ? "" : perTxt(stat)}${u(stat)}`,
        `${lgTxt} ${seasonTxt}, ${weeksTxt.toLowerCase()}`,
        st.group && (league === "nfl" ? "Division: " : "Conference: ") + st.group,
        st.team && `Team: ${tm(st.team)[0]}`,
        st.role ? `Depth chart: ${st.role} (by use)` : st.pos && `Position: ${st.pos === "DEF" ? "Defense" : st.pos === "WR" ? "WR/TE" : st.pos}`,
        st.type === "bar" && `${st.order === "worst" ? "Worst" : "Top"} ${top}`,
        (st.type === "line" || st.type === "radar" || st.type === "pie") && !picks.length && `Top ${top}`,
        picks.length && `Highlighted: ${picks.map(name).join(", ")}`,
        st.noexit && "games left by halftime left out",
        st.type === "line" && st.cum && "running total",
      ].filter(Boolean);
      return `Filters: ${parts.join(" · ")}. Data: ${league === "nfl" ? "nflverse play-by-play" : "CollegeFootballData.com"}.`;
    }
    function wrap(x, text, maxW) {
      const lines = [];
      let cur = "";
      for (const w of text.split(" ")) {
        const t = cur ? cur + " " + w : w;
        if (x.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
      }
      return cur ? [...lines, cur] : lines;
    }
    async function picture() {
      const cv = document.getElementById("vz-chart"), W = cv.width, H = cv.height, sc = W / cv.clientWidth, pad = 24 * sc, top = 70 * sc;
      const probe = document.createElement("canvas").getContext("2d");
      probe.font = `${10 * sc}px JetBrains Mono, monospace`;
      const fine = wrap(probe, synopsis(), W);
      const bot = 34 * sc + fine.length * 14 * sc + 6 * sc;
      const out = document.createElement("canvas"); out.width = W + 2 * pad; out.height = H + top + bot;
      const x = out.getContext("2d");
      x.fillStyle = C("--card") || "#111"; x.fillRect(0, 0, out.width, out.height);
      x.fillStyle = accent; x.fillRect(0, 0, out.width, 4 * sc);
      x.fillStyle = ink; x.font = `700 ${18 * sc}px JetBrains Mono, monospace`; x.fillText(title, pad, 34 * sc);
      x.fillStyle = muted; x.font = `${12 * sc}px JetBrains Mono, monospace`; x.fillText(sub, pad, 54 * sc);
      x.drawImage(cv, pad, top);
      x.fillStyle = muted; x.font = `${10 * sc}px JetBrains Mono, monospace`;
      fine.forEach((line, i) => x.fillText(line, pad, top + H + 16 * sc + i * 14 * sc));
      x.fillStyle = accent; x.font = `700 ${12 * sc}px JetBrains Mono, monospace`; x.fillText("CUPCAKE_INDEX", pad, out.height - 12 * sc);
      x.fillStyle = muted; x.font = `${11 * sc}px JetBrains Mono, monospace`; x.textAlign = "right";
      x.fillText(`cupcakeindex.com · ${league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com"}`, out.width - pad, out.height - 12 * sc);
      return out;
    }
  }

  return { render };
})();
