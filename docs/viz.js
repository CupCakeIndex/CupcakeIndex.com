// Stats > Visualize: make your own chart from any stat (bar, line, pie, scatter, radar) for any weeks and seasons,
// to back up an argument on X. Data: docs/data/viz/<league>_<season>.json (src/viz_data.py, weekly): one row per team
// or player per game, raw counts only, so any range of weeks adds up exactly and rates are total / total.
// NFL from nflverse (official play-by-play, with EPA); college from CollegeFootballData.com (box scores, PPA = college EPA).
// Every setting lives in the link, so a chart can be shared. Charts by Chart.js (cdnjs), loaded the first time.
const Viz = (() => {
  const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
  const files = new Map();
  let chart = null, idx = null;
  let stepOn = 1, editOpen = false, mineOpen = false, mineSort = "new", mineQ = ""; const shut = { 4: 1 }; // the steps panel: phone tab, Simple's Edit box, closed steps on a computer

  // ---------------------------------------------------------------- the stats
  // v(S, g) -> value from summed columns S over g games; den(S) for rates (who qualifies); low = lower is better;
  // count = a total that can be shown per game; need = columns it needs (stats a league's data lacks are hidden)
  const div = (a, b) => (b ? a / b : null);
  // penalty types: [column key, name]. The short names people type are in the name, so the question box finds them ("most DPI").
  const PEN = [["hold", "Offensive holding"], ["fs", "False starts"], ["dpi", "Defensive pass interference (DPI)"], ["dog", "Delay of game"],
    ["dhold", "Defensive holding"], ["ur", "Unnecessary roughness (personal fouls)"], ["offside", "Offside (defense)"], ["rtp", "Roughing the passer"],
    ["fm", "Face masks"], ["form", "Illegal formation"], ["nzi", "Neutral zone infractions (NZI)"], ["ibw", "Illegal blocks above the waist"],
    ["iuh", "Illegal use of hands"], ["icon", "Illegal contact"], ["shift", "Illegal shift or motion"], ["opi", "Offensive pass interference (OPI)"],
    ["idp", "Ineligible man downfield"], ["enc", "Encroachment"], ["ig", "Intentional grounding"], ["unsp", "Unsportsmanlike conduct"],
    ["taunt", "Taunting"], ["hc", "Horse-collar tackles"], ["tmm", "Too many men on the field (12 men)"]];
  // the types grouped by kind of foul: [key, name, types]. Every type is in exactly one group.
  const PEN_FAM = [
    ["pre", "Pre-snap penalties (procedural: false starts, offside, delay, formation…)", ["fs", "offside", "nzi", "enc", "form", "shift", "dog", "tmm"], "pre-snap (procedural)"],
    ["holds", "Holding (offense + defense)", ["hold", "dhold"], "holding"],
    ["pi", "Pass interference and illegal contact", ["dpi", "opi", "icon"], "pass interference and illegal contact"],
    ["pf", "Personal fouls (roughness, roughing the passer, face masks, horse-collars)", ["ur", "rtp", "fm", "hc"], "personal foul"],
    ["conduct", "Unsportsmanlike conduct and taunting", ["unsp", "taunt"], "unsportsmanlike conduct"],
    ["blocks", "Blocking fouls (blocks above the waist, use of hands)", ["ibw", "iuh"], "blocking"],
    ["passrules", "Passing rule fouls (ineligible downfield, grounding)", ["idp", "ig"], "passing rule"],
  ];
  const lc1 = (x) => x[0].toLowerCase() + x.slice(1);
  // penalty yards: [key suffix, name] for every type and group, from yards columns with this prefix (tpy_ team, tpdy_ drawn, pny_ player)
  const penYds = (pre, types) => [...PEN.filter(([k]) => types.includes(k)).map(([k, l]) => [k, `Yards from ${lc1(l)}`, (S) => S[`${pre}${k}`]]),
    ...PEN_FAM.map(([k, , ks, short]) => [k, `Yards from ${short} penalties`, (S) => famSum(S, pre, ks.filter((x) => types.includes(x)))])];
  const famSum = (S, pre, ks) => ks.reduce((a, k) => a + (S[`${pre}${k}`] || 0), 0);
  // by the unit that committed it (from the play-by-play: who had the ball, and kicking plays)
  const PEN_SIDE = [["o", "the offense"], ["d", "the defense"], ["s", "special teams"]];
  // run direction (src/deep_stats.py RUN_DIRS): designed runs by gap, scrambles left out
  const RUN_DIRS = [["le", "left end"], ["lt", "left tackle"], ["lg", "left guard"], ["m", "middle"], ["rg", "right guard"], ["rt", "right tackle"], ["re", "right end"]];
  const RUN_SIDES = [["l", "left", ["le", "lt", "lg"]], ["m", "middle", ["m"]], ["r", "right", ["rg", "rt", "re"]]];
  const runDirStats = (who) => {
    const p = who === "teams" ? "t" : "", he = who === "teams" ? "they run" : "he runs", pos = who === "teams" ? undefined : "RB";
    const all = (S) => RUN_DIRS.reduce((a, [k]) => a + (S[`rd_${k}`] || 0), 0), o = { unit: "designed runs", need: ["rd_m"], pos, lg: "nfl" };
    return [
      [`${p}run_dir_gap`, `Where ${he}: all 7 gaps`, all, { ...o, count: 1, split: RUN_DIRS.map(([k, l]) => [l[0].toUpperCase() + l.slice(1), (S) => S[`rd_${k}`]]) }],
      [`${p}run_dir_side`, `Where ${he}: left / middle / right`, all, { ...o, count: 1, split: RUN_SIDES.map(([, l, ks]) => [l[0].toUpperCase() + l.slice(1), (S) => ks.reduce((a, k) => a + S[`rd_${k}`], 0)]) }],
      ...RUN_DIRS.map(([k, l]) => [`${p}run_pct_${k}`, `% of runs: ${l}`, (S) => div(100 * S[`rd_${k}`], all(S)), { ...o, den: all, pct: 1 }]),
      ...RUN_DIRS.map(([k, l]) => [`${p}run_ypc_${k}`, `Yards per carry: ${l}`, (S) => div(S[`rdy_${k}`], S[`rd_${k}`]), { ...o, den: (S) => S[`rd_${k}`], d: 2, unit: `runs ${l === "middle" ? "up the middle" : `off ${l}`}` }]),
    ];
  };
  // field goals by distance, extra points, punting (nflverse weekly stats, src/viz_data.py NV_EXTRA); mx_ = season high
  const FG_RANGES = [["u30", "under 30 yards", ["0_19", "20_29"]], ["30s", "30-39 yards", ["30_39"]], ["40s", "40-49 yards", ["40_49"]], ["50p", "50+ yards", ["50_59", "60_"]]];
  const kickStats = (who) => {
    const p = who === "teams" ? "t" : "", o = { pos: who === "teams" ? undefined : "K", lg: "nfl" };
    const fs = (S, pre, bins) => bins.reduce((a, b) => a + (S[`${pre}${b}`] || 0), 0);
    return [
      ...FG_RANGES.map(([k, l, bins]) => [`${p}fg_pct_${k}`, `Field goal % from ${l}`, (S) => div(100 * fs(S, "fgm_", bins), fs(S, "fga_", bins)), { ...o, den: (S) => fs(S, "fga_", bins), pct: 1, unit: `tries from ${l}`, need: ["fga_50_59"] }]),
      [`${p}fg_50`, "Field goals made from 50+", (S) => fs(S, "fgm_", ["50_59", "60_"]), { ...o, count: 1, need: ["fga_50_59"] }],
      [`${p}fg_long`, "Longest field goal (yards)", (S) => S.mx_fg_long || null, { ...o, noShare: 1, need: ["mx_fg_long"] }],
      [`${p}gwfg`, "Game-winning field goals", (S) => S.gwfg_made, { ...o, count: 1, need: ["gwfg_att"] }],
      [`${p}xp_pct`, "Extra point %", (S) => div(100 * S.pat_made, S.pat_att), { ...o, den: (S) => S.pat_att, pct: 1, unit: "extra point tries", need: ["pat_att"] }],
      [`${p}xp_miss`, "Extra points missed", (S) => S.pat_att - S.pat_made, { ...o, count: 1, low: 1, need: ["pat_att"] }],
      [`${p}punts`, "Punts", (S) => S.pt_att, { ...o, count: 1, need: ["pt_att"] }],
      [`${p}punt_avg`, "Punting average (gross)", (S) => div(S.pt_yds, S.pt_att), { ...o, den: (S) => S.pt_att, d: 1, unit: "punts", need: ["pt_att"] }],
      [`${p}punt_net`, "Net punting average", (S) => div(S.pt_net, S.pt_att), { ...o, den: (S) => S.pt_att, d: 1, unit: "punts", need: ["pt_net"] }],
      [`${p}punt_in20`, "Punts inside the 20", (S) => S.pt_in20, { ...o, count: 1, need: ["pt_att"] }],
      [`${p}punt_in20_pct`, "Inside-the-20 % of punts", (S) => div(100 * S.pt_in20, S.pt_att), { ...o, den: (S) => S.pt_att, pct: 1, unit: "punts", need: ["pt_att"] }],
      [`${p}punt_tb`, "Punt touchbacks", (S) => S.pt_tb, { ...o, count: 1, low: 1, need: ["pt_att"] }],
      [`${p}punt_long`, "Longest punt (yards)", (S) => S.mx_pt_long || null, { ...o, noShare: 1, need: ["mx_pt_long"] }],
      [`${p}punt_blk`, "Punts blocked", (S) => S.pt_blk, { ...o, count: 1, low: 1, need: ["pt_att"] }],
    ];
  };
  const returnStats = (who) => {
    const p = who === "teams" ? "t" : "", o = { lg: "nfl" };
    return [
      [`${p}kr_avg`, "Kick return average", (S) => div(S.kr_yds, S.kr), { ...o, den: (S) => S.kr, d: 1, unit: "kick returns", need: ["kr"] }],
      [`${p}kr_yds`, "Kick return yards", (S) => S.kr_yds, { ...o, count: 1, need: ["kr"] }],
      [`${p}kr`, "Kick returns", (S) => S.kr, { ...o, count: 1, need: ["kr"] }],
      [`${p}pr_avg`, "Punt return average", (S) => div(S.pr_yds, S.pr), { ...o, den: (S) => S.pr, d: 1, unit: "punt returns", need: ["pr"] }],
      [`${p}pr_yds`, "Punt return yards", (S) => S.pr_yds, { ...o, count: 1, need: ["pr"] }],
      [`${p}pr`, "Punt returns", (S) => S.pr, { ...o, count: 1, need: ["pr"] }],
      [`${p}ret_yds`, "Return yards (kicks + punts)", (S) => S.kr_yds + S.pr_yds, { ...o, count: 1, need: ["kr"] }],
      [`${p}ret_td`, "Kick and punt return TDs", (S) => S.ret_td, { ...o, count: 1, need: ["ret_td"] }],
      [`${p}st_td`, "Special teams TDs (returns, blocked kicks...)", (S) => S.st_td, { ...o, count: 1, need: ["st_td"] }],
    ];
  };
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
      ["pts_play", "Points per play", (S) => div(S.pts, S.plays), { den: (S) => S.plays, d: 3 }],
      ["pass_rate", "Pass rate (% of plays that are passes)", (S) => div(100 * (S.att + (S.sacked || 0)), S.plays), { den: (S) => S.plays, pct: 1 }],
      ["run_rate", "Run rate (% of plays that are runs)", (S) => div(100 * S.carries, S.plays), { den: (S) => S.plays, pct: 1 }],
      ["int_rate", "Interception rate (% of passes)", (S) => div(100 * S.int, S.att), { den: (S) => S.att, pct: 1, low: 1, unit: "pass attempts" }],
      ["sack_rate_off", "Sack rate allowed (% of dropbacks)", (S) => div(100 * S.sacked, S.att + S.sacked), { den: (S) => S.att + S.sacked, pct: 1, low: 1, unit: "dropbacks", need: ["sacked"] }],
    ]],
    ["Defense", [
      ["opp_yds", "Yards allowed", (S) => S.opp_yds ?? S.opp_pass_yds + S.opp_rush_yds, { count: 1, low: 1 }],
      ["opp_pass_yds", "Passing yards allowed", (S) => S.opp_pass_yds, { count: 1, low: 1 }],
      ["opp_rush_yds", "Rushing yards allowed", (S) => S.opp_rush_yds, { count: 1, low: 1 }],
      ["yds_margin", "Yardage margin (gained minus allowed)", (S) => S.pass_yds + S.rush_yds - (S.opp_yds ?? S.opp_pass_yds + S.opp_rush_yds), { count: 1, fmt: "+" }],
      ["ypp_allowed", "Yards per play allowed", (S) => div(S.opp_pass_yds + S.opp_rush_yds, S.opp_plays), { den: (S) => S.opp_plays, d: 2, low: 1, need: ["opp_plays"] }],
      ["opp_pts_play", "Points allowed per play", (S) => div(S.opp_pts, S.opp_plays), { den: (S) => S.opp_plays, d: 3, low: 1, need: ["opp_plays"] }],
      ["def_sacks", "Sacks", (S) => S.def_sacks, { count: 1 }],
      ["def_int", "Interceptions", (S) => S.def_int, { count: 1 }],
      ["takeaways", "Takeaways", (S) => S.def_int + S.def_fr, { count: 1, need: ["def_fr"] }],
      ["to_margin", "Turnover margin", (S) => S.def_int + S.def_fr - S.int - S.fum_lost, { count: 1, fmt: "+", need: ["def_fr"] }],
      ["tfl", "Tackles for loss", (S) => S.tfl, { count: 1, need: ["tfl"] }],
    ]],
    // NFL play-by-play (src/deep_stats.py): throws by depth (air yards), YAC allowed; blitz rate from FTN's charting; missed tackles from PFR's
    ["Pass defense and blitzing", [
      ["short_ypt", "Yards allowed per short throw (5 air yards or less)", (S) => div(S.opp_short_yds, S.opp_short_att), { den: (S) => S.opp_short_att, d: 2, low: 1, unit: "short throws", need: ["opp_short_att"] }],
      ["short_yds", "Short-throw yards allowed (5 air yards or less)", (S) => S.opp_short_yds, { count: 1, low: 1, need: ["opp_short_att"] }],
      ["deep_cmp_allowed", "Deep completion % allowed (20+ air yards)", (S) => div(100 * S.opp_deep_cmp, S.opp_deep_att), { den: (S) => S.opp_deep_att, pct: 1, low: 1, unit: "deep throws", need: ["opp_deep_att"] }],
      ["deep_yds_allowed", "Deep passing yards allowed (20+ air yards)", (S) => S.opp_deep_yds, { count: 1, low: 1, need: ["opp_deep_att"] }],
      ["opp_cmp_pct", "Completion % allowed", (S) => div(100 * S.opp_cmp, S.opp_att), { den: (S) => S.opp_att, pct: 1, low: 1, unit: "throws", need: ["opp_att"] }],
      ["yac_allowed", "Yards after catch allowed per catch", (S) => div(S.opp_yac, S.opp_cmp), { den: (S) => S.opp_cmp, d: 1, low: 1, unit: "catches allowed", need: ["opp_yac"] }],
      ["blitz_rate", "Blitz rate (% of dropbacks, FTN charting)", (S) => div(100 * S.blitz_db, S.ftn_db), { den: (S) => S.ftn_db, pct: 1, unit: "charted dropbacks", need: ["blitz_db"] }],
      ["team_miss_tkl", "Missed tackles (PFR charting)", (S) => S.miss_tkl, { count: 1, low: 1, need: ["miss_tkl"] }],
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
    // the team's head coach that season, with his career numbers (the Coaches page, coaches.js)
    ["Head coach (career)", [
      ["co_score", "Coach score (0–100)", (S) => S.co_score, { d: 0, season: 1 }],
      ["co_pct", "Coach career win %", (S) => S.co_pct, { d: 1, pct: 1, season: 1 }],
      ["co_good", "Coach win % vs winning teams", (S) => S.co_good, { d: 1, pct: 1, season: 1 }],
      ["co_woe", "Coach wins over expected per season", (S) => S.co_woe, { d: 1, fmt: "+", season: 1 }],
      ["co_yrs", "Coach seasons as head coach", (S) => S.co_yrs, { d: 0, season: 1 }],
      ["co_edge", "Coach rating boost (our model, points)", (S) => S.co_edge, { d: 1, fmt: "+", season: 1, lg: "nfl" }],
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
    // a whole defense's run stops and pressures: its players' numbers added up (NFL deep cuts; sum() adds the TX columns up by team).
    // Two players on one tackle both get it, as on their own pages.
    ["Run defense and pressure (players added up)", [
      ["run_stop", "Run stops", (S) => S.run_stop, { count: 1, need: ["run_stop"] }],
      ["stop_pct", "Stop % of run tackles", (S) => div(100 * S.run_stop, S.run_tkl), { den: (S) => S.run_tkl, pct: 1, unit: "run tackles", need: ["run_tkl"] }],
      ["stuff", "Stuffs (run tackles at or behind the line)", (S) => S.stuff, { count: 1, need: ["stuff"] }],
      ["run_depth", "Avg gain on run tackles", (S) => div(S.run_tkl_yds, S.run_tkl), { den: (S) => S.run_tkl, d: 1, low: 1, unit: "run tackles", need: ["run_tkl_yds"] }],
      ["sy_stop", "Short-yardage stops (3rd/4th & 2 or less)", (S) => S.sy_stop, { count: 1, need: ["sy_stop"] }],
      ["third_stop", "3rd/4th-down stops", (S) => S.third_stop, { count: 1, need: ["third_stop"] }],
      ["pressure", "Pressures (sacks, hits, hurries)", (S) => S.pressure, { count: 1, need: ["pressure"] }],
    ]],
    // accepted penalties by type, from play-by-play (src/deep_stats.py PEN_TYPES): tp_ = committed, tpd_ = drawn (the other team's)
    ["Penalties by type", [...PEN.map(([k, l]) => [`tpen_${k}`, l, (S) => S[`tp_${k}`], { count: 1, low: 1, need: [`tp_${k}`] }]),
    ]],
    ["Penalties grouped", [
      ...PEN_FAM.map(([k, l, ks]) => [`tpen_${k}`, l, (S) => famSum(S, "tp_", ks), { count: 1, low: 1, need: ["tp_fs"] }]),
      ...PEN_SIDE.map(([k, l]) => [`tpen_side_${k}`, `Penalties on ${l}`, (S) => S[`tps_${k}`], { count: 1, low: 1, need: ["tps_o"] }]),
      ...PEN_SIDE.map(([k, l]) => [`tpen_sidepct_${k}`, `% of penalties on ${l}`, (S) => div(100 * S[`tps_${k}`], S.tps_o + S.tps_d + S.tps_s), { den: (S) => S.tps_o + S.tps_d + S.tps_s, pct: 1, unit: "penalties", need: ["tps_o"] }]),
      ...PEN_FAM.map(([k, l, ks]) => [`tpend_${k}`, `${l.replace(/ \(.*\)$/, "")} drawn`, (S) => famSum(S, "tpd_", ks), { count: 1, need: ["tpd_fs"] }]),
      ...PEN_SIDE.map(([k, l]) => [`tpend_side_${k}`, `Penalties drawn by ${l}`, (S) => S[`tpds_${k}`], { count: 1, need: ["tpds_o"] }]),
    ]],
    ["Points erased by penalties", [
      ["tpen_ptsnull", "Points erased by penalties (their own; TD 6, FG 3, safety 2)", (S) => S.tp_ptsnull, { count: 1, low: 1, need: ["tp_ptsnull"] }],
      ["tpen_tdnull", "Touchdowns erased by penalties (their own)", (S) => S.tp_tdnull, { count: 1, low: 1, need: ["tp_tdnull"] }],
      ["tpend_ptsnull", "Opponent points erased by penalties (the opponent's own)", (S) => S.tpd_ptsnull, { count: 1, need: ["tpd_ptsnull"] }],
      ["tpend_tdnull", "Opponent touchdowns erased by penalties (the opponent's own)", (S) => S.tpd_tdnull, { count: 1, need: ["tpd_tdnull"] }],
    ]],
    ["Penalty yards", [
      ...penYds("tpy_", PEN.map(([k]) => k)).map(([k, l, fn]) => [`tpeny_${k}`, l, fn, { count: 1, low: 1, need: ["tpy_fs"] }]),
      ...PEN_SIDE.map(([k, l]) => [`tpeny_side_${k}`, `Penalty yards on ${l}`, (S) => S[`tpsy_${k}`], { count: 1, low: 1, need: ["tpsy_o"] }]),
      ...penYds("tpdy_", PEN.map(([k]) => k)).map(([k, l, fn]) => [`tpendy_${k}`, `${l} drawn`, fn, { count: 1, need: ["tpdy_fs"] }]),
      ...PEN_SIDE.map(([k, l]) => [`tpendy_side_${k}`, `Penalty yards drawn by ${l}`, (S) => S[`tpdsy_${k}`], { count: 1, need: ["tpdsy_o"] }]),
    ]],
    ["Penalties drawn by type (the other team's)", [...PEN.map(([k, l]) => [`tpend_${k}`, `${l} drawn`, (S) => S[`tpd_${k}`], { count: 1, need: [`tpd_${k}`] }]),
    ]],
    ["Drops and broken tackles (players added up)", [
      ["team_drops", "Drops (dropped passes)", (S) => S.drops, { count: 1, low: 1, need: ["drops"] }],
      ["team_drop_pct", "Drop % (drops per pass attempt)", (S) => div(100 * S.drops, S.att), { den: (S) => S.att, pct: 1, low: 1, unit: "pass attempts", need: ["drops"] }],
      ["team_btk", "Broken tackles (runs + catches)", (S) => S.rush_btk + S.rec_btk, { count: 1, need: ["rush_btk"] }],
    ]],
    // NFL play-by-play (src/deep_stats.py TCOLS) and nflverse's weekly team stats (src/viz_data.py NV_EXTRA)
    ["4th downs", [
      ["go4_rate", "Went for it on 4th down (% of 4th downs)", (S) => div(100 * S.go4_att, S.fd4), { den: (S) => S.fd4, pct: 1, unit: "4th downs", need: ["fd4"] }],
      ["go4_att", "4th-down tries (went for it)", (S) => S.go4_att, { count: 1, need: ["fd4"] }],
      ["go4_pct", "4th-down conversion %", (S) => div(100 * S.go4_conv, S.go4_att), { den: (S) => S.go4_att, pct: 1, unit: "4th-down tries", need: ["fd4"] }],
      ["go4_conv", "4th-down conversions", (S) => S.go4_conv, { count: 1, need: ["fd4"] }],
      ["dgo4_stop", "4th-down stop % (defense)", (S) => div(100 * (S.dgo4_att - S.dgo4_conv), S.dgo4_att), { den: (S) => S.dgo4_att, pct: 1, unit: "4th-down tries against", need: ["fd4"] }],
    ]],
    ["Drives", [
      ["pts_drive", "Points per drive", (S) => div(S.pts, S.drives), { den: (S) => S.drives, d: 2, unit: "drives", need: ["drives"] }],
      ["drive_score_pct", "Scoring drive % (TD or FG)", (S) => div(100 * S.drive_scores, S.drives), { den: (S) => S.drives, pct: 1, unit: "drives", need: ["drives"] }],
      ["drive_start", "Average drive start (own yard line)", (S) => div(S.drive_start, S.drives), { den: (S) => S.drives, d: 1, unit: "drives", need: ["drives"] }],
      ["drive_plays", "Plays per drive", (S) => div(S.drive_plays, S.drives), { den: (S) => S.drives, d: 1, unit: "drives", need: ["drives"] }],
      ["drive_mins", "Minutes per drive", (S) => div(S.drive_secs / 60, S.drives), { den: (S) => S.drives, d: 2, unit: "drives", need: ["drives"] }],
      ["top", "Time of possession (minutes)", (S) => S.drive_secs / 60, { count: 1, d: 1, need: ["drives"] }],
      ["drives", "Drives", (S) => S.drives, { count: 1, need: ["drives"] }],
    ]],
    ["Play style", [
      ["proe", "Pass rate over expected (+ = passes more than the situation calls for)", (S) => div(S.proe_sum, S.proe_n), { den: (S) => S.proe_n, d: 1, fmt: "+", unit: "plays", need: ["proe_n"] }],
      ["shotgun_pct", "Shotgun % (of runs and passes)", (S) => div(100 * S.sg, S.o_plays), { den: (S) => S.o_plays, pct: 1, unit: "plays", need: ["o_plays"] }],
      ["nohuddle_pct", "No-huddle %", (S) => div(100 * S.nh, S.o_plays), { den: (S) => S.o_plays, pct: 1, unit: "plays", need: ["o_plays"] }],
      ["team_cpoe", "Completion % over expected (CPOE)", (S) => div(S.cpoe_sum, S.cpoe_n), { den: (S) => S.cpoe_n, d: 1, fmt: "+", unit: "throws", need: ["cpoe_n"] }],
      ["team_scr", "QB scrambles", (S) => S.scr, { count: 1, need: ["o_plays"] }],
      ["team_scr_yds", "Scramble yards", (S) => S.scr_yds, { count: 1, need: ["o_plays"] }],
      ["team_two_pct", "Two-point conversion %", (S) => div(100 * S.two_conv, S.two_att), { den: (S) => S.two_att, pct: 1, unit: "two-point tries", need: ["two_att"] }],
      ["team_two_att", "Two-point tries", (S) => S.two_att, { count: 1, need: ["two_att"] }],
    ]],
    ["Big plays", [
      ["team_rush_20", "Runs of 20+ yards", (S) => S.rush_20, { count: 1, need: ["o_plays"] }],
      ["team_rush_40", "Runs of 40+ yards", (S) => S.rush_40, { count: 1, need: ["o_plays"] }],
      ["team_pass_20", "Completions of 20+ yards", (S) => S.pass_20, { count: 1, need: ["o_plays"] }],
      ["team_pass_40", "Completions of 40+ yards", (S) => S.pass_40, { count: 1, need: ["o_plays"] }],
      ["team_big_rate", "Big-play rate (20+ yard plays per 100 plays)", (S) => div(100 * (S.rush_20 + S.pass_20), S.o_plays), { den: (S) => S.o_plays, d: 1, unit: "plays", need: ["o_plays"] }],
    ]],
    ["Run direction", runDirStats("teams")],
    ["Kicking and punting (team)", kickStats("teams")],
    ["Returns (team)", returnStats("teams")],
    ["Fumbles and defensive scores (team)", [
      ["team_fum", "Fumbles (all, lost or not)", (S) => S.fum, { count: 1, low: 1, need: ["fum"] }],
      ["team_fum_lost", "Fumbles lost", (S) => S.fum_lost_all, { count: 1, low: 1, need: ["fum"] }],
      ["team_ff", "Forced fumbles", (S) => S.def_ff, { count: 1, need: ["def_ff"] }],
      ["team_def_td", "Defensive touchdowns", (S) => S.def_td, { count: 1, need: ["def_td"] }],
      ["team_int_yds", "Interception return yards", (S) => S.int_yds, { count: 1, need: ["int_yds"] }],
      ["team_fr_yds", "Fumble return yards", (S) => S.fr_yds, { count: 1, need: ["fr_yds"] }],
      ["team_safeties", "Safeties", (S) => S.safeties, { count: 1, need: ["safeties"] }],
      ["team_sack_yds", "Sack yards (defense)", (S) => S.sack_yds, { count: 1, need: ["sack_yds"] }],
      ["team_sack_yds_lost", "Yards lost to sacks (offense)", (S) => S.sack_yds_lost, { count: 1, low: 1, need: ["sack_yds_lost"] }],
    ]],
  ];
  const TX = ["run_stop", "run_tkl", "run_tkl_yds", "stuff", "sy_stop", "third_stop", "pressure", "drops", "rush_btk", "rec_btk"]; // player columns a team's total is added up from
  // where the ball went (src/deep_stats.py): zone = depth s/i/d (under 10 air yards, 10-19, 20+) + side l/m/r. QBs have
  // z_<zone>_att/_cmp/_yds, receivers zt_<zone> (targets) and zc_<zone> (catches). A "split" stat is a breakdown, not one number:
  // a bar chart stacks it (one 100% bar per player), a pie shows one player's slices; anywhere else it's the total.
  const ZONES = ["sl", "sm", "sr", "il", "im", "ir", "dl", "dm", "dr"];
  const ZD = { s: "Short", i: "Intermediate", d: "Deep" }, ZS = { l: "left", m: "middle", r: "right" };
  const zs = (S, col, f) => ZONES.filter(f).reduce((a, z) => a + (S[col(z)] || 0), 0);
  const zAtt = (z) => `z_${z}_att`, zCmp = (z) => `z_${z}_cmp`, zYds = (z) => `z_${z}_yds`, zTgt = (z) => `zt_${z}`, zRec = (z) => `zc_${z}`;
  const BY = { // [key, label, which zones]
    side: Object.entries(ZS).map(([k, l]) => [k, l, (z) => z[1] === k]),
    depth: Object.entries(ZD).map(([k, l]) => [k, l.toLowerCase(), (z) => z[0] === k]),
    zone: ZONES.map((z) => [z, `${ZD[z[0]].toLowerCase()} ${ZS[z[1]]}`, (x) => x === z]),
  };
  const DEPTH_TXT = { short: "short (under 10 air yards)", intermediate: "intermediate (10-19 air yards)", deep: "deep (20+ air yards)" };
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const splitOf = (col, by) => BY[by].map(([, l, f]) => [cap(l), (S) => zs(S, col, f)]);
  const zoneStats = (who) => {
    const att = who === "qb" ? zAtt : zTgt, need = [who === "qb" ? "z_sl_att" : "zt_sl"];
    const unit = who === "qb" ? "zoned throws" : "zoned targets", thing = who === "qb" ? "throws" : "targets", pos = who === "qb" ? "QB" : "WR";
    const all = (S) => zs(S, att, () => 1), o = { den: all, pct: 1, unit, need, pos, lg: "nfl" };
    return [
      [`${who}_by_side`, `${who === "qb" ? "Where he throws" : "Where he's targeted"}: left / middle / right`, all, { count: 1, unit, need, pos, lg: "nfl", split: splitOf(att, "side") }],
      [`${who}_by_depth`, `${who === "qb" ? "Where he throws" : "Where he's targeted"}: short / intermediate / deep`, all, { count: 1, unit, need, pos, lg: "nfl", split: splitOf(att, "depth") }],
      [`${who}_by_zone`, `${who === "qb" ? "Where he throws" : "Where he's targeted"}: all 9 zones`, all, { count: 1, unit, need, pos, lg: "nfl", split: splitOf(att, "zone") }],
      ...["side", "depth"].flatMap((by) => BY[by].map(([k, l, f]) => [`${who}_pct_${k}`, `% of ${thing} ${by === "side" ? `to the ${l}` : DEPTH_TXT[l]}`, (S) => div(100 * zs(S, att, f), all(S)), o])),
      ...BY.zone.map(([k, l, f]) => [`${who}_pct_${k}`, `% of ${thing}: ${l}`, (S) => div(100 * zs(S, att, f), all(S)), o]),
      ...["side", "depth"].flatMap((by) => BY[by].map(([k, l, f]) => [`${who}_n_${k}`, `${cap(thing)} ${by === "side" ? `to the ${l}` : DEPTH_TXT[l]}`, (S) => zs(S, att, f), { count: 1, need, pos, lg: "nfl" }])),
    ];
  };
  // how it went in each part of the field
  const zoneResults = (who) => {
    const att = who === "qb" ? zAtt : zTgt, ok = who === "qb" ? zCmp : zRec, need = [who === "qb" ? "z_sl_att" : "zt_sl"], pos = who === "qb" ? "QB" : "WR";
    const rows = [...BY.side.map((x) => [...x, `to the ${x[1]}`]), ...BY.depth.map((x) => [...x, DEPTH_TXT[x[1]]]), ...BY.zone.filter(([z]) => z[0] === "d").map((x) => [...x, `to the ${x[1]}`])];
    return rows.flatMap(([k, , f, txt]) => [
      [`${who}_cmp_${k}`, `${who === "qb" ? "Completion %" : "Catch %"} ${txt}`, (S) => div(100 * zs(S, ok, f), zs(S, att, f)), { den: (S) => zs(S, att, f), pct: 1, unit: `${who === "qb" ? "throws" : "targets"} there`, need, pos, lg: "nfl" }],
      ...(who === "qb" ? [[`qb_ypa_${k}`, `Yards per attempt ${txt}`, (S) => div(zs(S, zYds, f), zs(S, att, f)), { den: (S) => zs(S, att, f), d: 2, unit: "throws there", need, pos, lg: "nfl" }]] : []),
      // EPA, TDs and INTs by zone (added 2026-10): stats show only when every season picked has them
      ...(who === "qb" ? [
        [`qb_epa_${k}`, `EPA per throw ${txt}`, (S) => div(zs(S, (z) => `z_${z}_epa`, f), zs(S, att, f)), { den: (S) => zs(S, att, f), d: 3, unit: "throws there", need: ["z_sl_epa"], pos, lg: "nfl" }],
        [`qb_rate_${k}`, `Passer rating ${txt}`, (S) => rating({ att: zs(S, att, f), cmp: zs(S, ok, f), pass_yds: zs(S, zYds, f), pass_td: zs(S, (z) => `z_${z}_td`, f), int: zs(S, (z) => `z_${z}_int`, f) }), { den: (S) => zs(S, att, f), d: 1, unit: "throws there", need: ["z_sl_epa"], pos, lg: "nfl" }],
        [`qb_td_${k}`, `TD passes ${txt}`, (S) => zs(S, (z) => `z_${z}_td`, f), { count: 1, need: ["z_sl_epa"], pos, lg: "nfl" }],
        [`qb_int_${k}`, `Interceptions ${txt}`, (S) => zs(S, (z) => `z_${z}_int`, f), { count: 1, low: 1, need: ["z_sl_epa"], pos, lg: "nfl", vol: ["pass attempts", 100] }],
      ] : [
        [`rec_epa_${k}`, `EPA per target ${txt}`, (S) => div(zs(S, (z) => `ze_${z}`, f), zs(S, att, f)), { den: (S) => zs(S, att, f), d: 3, unit: "targets there", need: ["ze_sl"], pos, lg: "nfl" }],
        [`rec_ypt_${k}`, `Yards per target ${txt}`, (S) => div(zs(S, (z) => `zy_${z}`, f), zs(S, att, f)), { den: (S) => zs(S, att, f), d: 1, unit: "targets there", need: ["ze_sl"], pos, lg: "nfl" }],
      ]),
    ]);
  };
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
      ["int", "Interceptions thrown", (S) => S.int, { count: 1, low: 1, pos: "QB", vol: ["pass attempts", 100] }],
      ["cmp_pct", "Completion %", (S) => div(100 * S.cmp, S.att), { den: (S) => S.att, pct: 1, pos: "QB" }],
      ["ypa", "Yards per attempt", (S) => div(S.pass_yds, S.att), { den: (S) => S.att, d: 2, pos: "QB" }],
      ["rating", "Passer rating (NFL formula)", rating, { den: (S) => S.att, d: 1, pos: "QB", lg: "nfl" }],
      ["eff", "Passing efficiency (NCAA formula)", (S) => div(8.4 * S.pass_yds + 330 * S.pass_td + 100 * S.cmp - 200 * S.int, S.att), { den: (S) => S.att, d: 1, pos: "QB", lg: "cfb" }],
      ["sacked", "Times sacked", (S) => S.sacked, { count: 1, low: 1, pos: "QB", lg: "nfl", vol: ["pass attempts", 100] }],
      ["att", "Pass attempts", (S) => S.att, { count: 1, pos: "QB" }],
      ["td_pct", "TD % (TDs per attempt)", (S) => div(100 * S.pass_td, S.att), { den: (S) => S.att, pct: 1, pos: "QB" }],
      ["int_pct", "INT % (interceptions per attempt)", (S) => div(100 * S.int, S.att), { den: (S) => S.att, pct: 1, low: 1, pos: "QB" }],
      ["td_int", "TD-to-INT ratio", (S) => S.att ? S.pass_td / Math.max(S.int, 1) : null, { den: (S) => S.att, d: 1, pos: "QB" }],
      ["sack_pct", "Sack % (sacks per dropback)", (S) => div(100 * S.sacked, S.att + S.sacked), { den: (S) => S.att + S.sacked, pct: 1, low: 1, unit: "dropbacks", pos: "QB", lg: "nfl" }],
      ["tot_yds", "Total yards (passing + rushing)", (S) => S.pass_yds + S.rush_yds, { count: 1, pos: "QB" }],
      ["tot_td", "Total TDs (passing + rushing)", (S) => S.pass_td + S.rush_td, { count: 1, pos: "QB" }],
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
    // usage: his share of the team's total in the games he played (tm_ columns, added up in sum()), and stats built from two
    // columns. Any total can also be shown as a share with Show as > Share of team.
    ["Usage and share", [
      ["tgt_share", "Target share (% of team targets)", (S) => div(100 * S.targets, S.tm_targets), { den: (S) => S.targets, pct: 1, unit: "targets", pos: "WR", lg: "nfl" }],
      ["air_share", "Air-yards share (% of team air yards)", (S) => div(100 * S.air_yds, S.tm_air_yds), { den: (S) => S.targets, pct: 1, unit: "targets", pos: "WR", lg: "nfl" }],
      ["wopr", "WOPR (1.5 × target share + 0.7 × air-yards share)", (S) => S.tm_targets && S.tm_air_yds ? 1.5 * S.targets / S.tm_targets + 0.7 * S.air_yds / S.tm_air_yds : null, { den: (S) => S.targets, d: 2, unit: "targets", pos: "WR", lg: "nfl" }],
      ["rec_share", "Catch share (% of team catches)", (S) => div(100 * S.rec, S.tm_rec), { den: (S) => S.rec, pct: 1, unit: "catches", pos: "WR" }],
      ["carry_share", "Carry share (% of team carries)", (S) => div(100 * S.carries, S.tm_carries), { den: (S) => S.carries, pct: 1, unit: "carries", pos: "RB" }],
      ["yds_share", "Scrimmage-yard share (% of team rushing + receiving yards)", (S) => div(100 * (S.rush_yds + S.rec_yds), S.tm_rush_yds + S.tm_rec_yds), { den: (S) => S.carries + S.rec, pct: 1, unit: "touches" }],
      ["td_share", "TD share (% of team rushing + receiving TDs)", (S) => div(100 * (S.rush_td + S.rec_td), S.tm_rush_td + S.tm_rec_td), { den: (S) => S.carries + S.rec, pct: 1, unit: "touches" }],
      ["touches", "Touches (carries + catches)", (S) => S.carries + S.rec, { count: 1 }],
      ["ypt", "Yards per touch", (S) => div(S.rush_yds + S.rec_yds, S.carries + S.rec), { den: (S) => S.carries + S.rec, d: 2, unit: "touches" }],
      ["td_rate", "TD rate (% of touches)", (S) => div(100 * (S.rush_td + S.rec_td), S.carries + S.rec), { den: (S) => S.carries + S.rec, pct: 1, unit: "touches" }],
      ["adot", "Average depth of target (aDOT, air yards)", (S) => div(S.air_yds, S.targets), { den: (S) => S.targets, d: 1, unit: "targets", pos: "WR", lg: "nfl" }],
      ["racr", "RACR (receiving yards ÷ air yards)", (S) => div(S.rec_yds, S.air_yds), { den: (S) => S.targets, d: 2, unit: "targets", pos: "WR", lg: "nfl" }],
      ["yds_tgt", "Yards per target", (S) => div(S.rec_yds, S.targets), { den: (S) => S.targets, d: 1, unit: "targets", pos: "WR", lg: "nfl" }],
      ["yac_rec", "Yards after catch per catch", (S) => div(S.yac, S.rec), { den: (S) => S.rec, d: 1, unit: "catches", pos: "WR", lg: "nfl" }],
      ["ppr_touch", "Fantasy points (PPR) per touch", (S) => div(S.ppr, S.carries + S.rec), { den: (S) => S.carries + S.rec, d: 2, unit: "touches", lg: "nfl" }],
      ["snaps", "Snaps played", (S) => S.snaps, { count: 1, noShare: 1, lg: "nfl" }],
    ]],
    ["Defense and kicking", [
      ["tackles", "Tackles", (S) => S.tackles, { count: 1, pos: "DEF" }],
      ["def_sacks", "Sacks", (S) => S.def_sacks, { count: 1, d: 1, pos: "DEF" }],
      ["tfl", "Tackles for loss", (S) => S.tfl, { count: 1, d: 1, pos: "DEF" }],
      ["qb_hits", "QB hits (college: hurries)", (S) => S.qb_hits, { count: 1, pos: "DEF" }],
      ["pd", "Passes defended", (S) => S.pd, { count: 1, pos: "DEF" }],
      ["def_int", "Interceptions", (S) => S.def_int, { count: 1, pos: "DEF" }],
      ["havoc", "Havoc plays (tackles for loss + passes defended + INTs)", (S) => S.tfl + S.pd + S.def_int, { count: 1, d: 1, pos: "DEF" }],
      ["fg_att", "Field goal tries", (S) => S.fg_att, { count: 1, pos: "K" }],
      ["fg_made", "Field goals made", (S) => S.fg_made, { count: 1, pos: "K" }],
      ["fg_pct", "Field goal %", (S) => div(100 * S.fg_made, S.fg_att), { den: (S) => S.fg_att, pct: 1, pos: "K" }],
    ]],
    // our Heisman race (college; heisGame above): production that counts more against good teams, times winning
    ["Heisman race (our model)", [
      ["heisman", "Heisman score (our model)", (S, g) => (S.hz == null || !g ? null : S.hz * (0.6 + (0.6 * S.hz_w) / g)), { d: 0, lg: "cfb",
        about: "Heisman score (our model): his production (pass yards/25 + pass TDs x4 - INTs x2 + rushing and receiving yards/10 + rushing and receiving TDs x6), each game weighted by the opponent (x1.2 vs the top half of FBS by our power rating, x0.8 vs the bottom half, x0.5 vs FCS), then times his team's record in his games (0.6 + 0.6 x win %: unbeaten x1.2, .500 x0.9). Bullying cupcakes isn't a résumé." }],
      ["heis_prod", "Heisman production, opponent-weighted", (S) => S.hz, { count: 1, noShare: 1, d: 0, lg: "cfb" }],
      ["heis_raw", "Heisman production, raw (no opponent weighting)", (S) => S.hz_raw, { count: 1, noShare: 1, d: 0, lg: "cfb" }],
      ["heis_cup", "Cupcake padding (% of production lost to weighting)", (S) => (S.hz_raw ? (100 * (S.hz_raw - S.hz)) / S.hz_raw : null), { den: (S) => S.hz_raw, pct: 1, low: 1, lg: "cfb", unit: "production points" }],
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
      ["cov_yds", "Yards allowed in coverage", (S) => S.cov_yds, { count: 1, low: 1, need: ["cov_tgt"], vol: ["targets in coverage", 20] }],
      ["cov_td", "TDs allowed in coverage", (S) => S.cov_td, { count: 1, low: 1, need: ["cov_tgt"], vol: ["targets in coverage", 20] }],
      ["cov_yac", "Yards after catch allowed per catch", (S) => div(S.cov_yac, S.cov_cmp), { den: (S) => S.cov_cmp, d: 1, low: 1, unit: "catches allowed", need: ["cov_yac"] }],
      ["pressure", "Pressures (sacks, hits, hurries)", (S) => S.pressure, { count: 1, need: ["pressure"] }],
      ["miss_tkl", "Missed tackles", (S) => S.miss_tkl, { count: 1, low: 1, need: ["miss_tkl"], vol: ["tackles", 25] }],
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
    // drops, broken tackles and interceptions on throws to him: Pro Football Reference's charting (nflverse pfr_advstats), 2022 on
    ["Drops and broken tackles", [
      ["drops", "Drops", (S) => S.drops, { count: 1, low: 1, pos: "WR", need: ["drops"], vol: ["targets", 30] }],
      ["drop_pct", "Drop % (drops per target)", (S) => div(100 * S.drops, S.targets), { den: (S) => S.targets, pct: 1, low: 1, unit: "targets", pos: "WR", need: ["drops"] }],
      ["tgt_int", "Interceptions on throws to him", (S) => S.tgt_int, { count: 1, low: 1, pos: "WR", need: ["drops"], vol: ["targets", 30] }],
      ["btk", "Broken tackles (runs + catches)", (S) => S.rush_btk + S.rec_btk, { count: 1, need: ["drops"] }],
      ["rush_btk", "Broken tackles on runs", (S) => S.rush_btk, { count: 1, pos: "RB", need: ["drops"] }],
      ["rec_btk", "Broken tackles after the catch", (S) => S.rec_btk, { count: 1, pos: "WR", need: ["drops"] }],
      ["btk_rate", "Broken tackles per 100 touches", (S) => div(100 * (S.rush_btk + S.rec_btk), S.carries + S.rec), { den: (S) => S.carries + S.rec, d: 1, unit: "touches", need: ["drops"] }],
      ["pass_drops", "Passes his receivers dropped (QB)", (S) => S.pass_drops, { count: 1, pos: "QB", need: ["pass_drops"] }],
      ["adj_cmp", "Drop-adjusted completion % (QB, drops counted as catches)", (S) => div(100 * (S.cmp + S.pass_drops), S.att), { den: (S) => S.att, pct: 1, pos: "QB", need: ["pass_drops"] }],
    ]],
    // pressures and bad throws: PFR's passing charting; blitzes: FTN's charting (5+ rushers or a DB/LB blitzing), both via nflverse
    ["Deep cuts: QB under pressure and vs the blitz", [
      ["pressured_pct", "Pressured % of dropbacks", (S) => div(100 * S.qb_pressured, S.dropbacks), { den: (S) => S.dropbacks, pct: 1, low: 1, unit: "dropbacks", need: ["qb_pressured"] }],
      ["qb_pressured", "Times pressured", (S) => S.qb_pressured, { count: 1, low: 1, need: ["qb_pressured"], vol: ["pass attempts", 100] }],
      ["bz_rate", "Blitzed % of dropbacks", (S) => div(100 * S.bz_db, S.ftn_db), { den: (S) => S.ftn_db, pct: 1, unit: "charted dropbacks", need: ["bz_db"] }],
      ["bz_cmp_pct", "Completion % vs the blitz", (S) => div(100 * S.bz_cmp, S.bz_att), { den: (S) => S.bz_att, pct: 1, unit: "throws vs the blitz", need: ["bz_db"] }],
      ["bz_ypa", "Yards per attempt vs the blitz", (S) => div(S.bz_yds, S.bz_att), { den: (S) => S.bz_att, d: 2, unit: "throws vs the blitz", need: ["bz_db"] }],
      ["bz_rating", "Passer rating vs the blitz", (S) => rating({ att: S.bz_att, cmp: S.bz_cmp, pass_yds: S.bz_yds, pass_td: S.bz_td, int: S.bz_int }), { den: (S) => S.bz_att, d: 1, unit: "throws vs the blitz", need: ["bz_db"] }],
      ["bz_epa", "EPA per dropback vs the blitz", (S) => div(S.bz_epa, S.bz_db), { den: (S) => S.bz_db, d: 3, unit: "blitzed dropbacks", need: ["bz_db"] }],
      ["bad_throw_pct", "Bad throw %", (S) => div(100 * S.bad_throws, S.att), { den: (S) => S.att, pct: 1, low: 1, unit: "pass attempts", need: ["bad_throws"] }],
    ]],
    // where the ball went: nflverse's air yards + side of the field on every throw (the same data as the pass charts on player pages)
    ["Where QBs throw (field zones)", zoneStats("qb")],
    ["Where QBs throw: how it went", zoneResults("qb")],
    ["Where receivers get targeted", [...zoneStats("rec"), ...zoneResults("rec")]],
    // offensive linemen come from the snap counts (no box-score stats); penalties = accepted ones called on him, from play-by-play
    ["Offensive line and penalties", [
      ["off_snaps", "Snaps played", (S) => S.snaps, { count: 1, need: ["pen"] }],
      ["pen", "Penalties (called on him)", (S) => S.pen, { count: 1, low: 1, need: ["pen"], vol: ["snaps played", 200] }],
      ["pen_yds", "Penalty yards", (S) => S.pen_yds, { count: 1, low: 1, need: ["pen"], vol: ["snaps played", 200] }],
      ["pen_rate", "Penalties per 100 snaps", (S) => div(100 * S.pen, S.snaps), { den: (S) => S.snaps, d: 1, low: 1, unit: "snaps", need: ["pen"] }],
    ]],
    // breakdowns in counts ("abs"), not shares: pick a team and see who gets flagged for what, and how many times
    ["Penalties by type (called on him)", [
      ["pen_by_type", "Penalties by type: how many of each", (S) => S.pen, { count: 1, abs: 1, unit: "penalties", need: ["pn_fs"],
        split: PEN.filter(([k]) => !["dog", "tmm"].includes(k)).map(([k, l]) => [l.replace(/ \(.*\)$/, ""), (S) => S[`pn_${k}`] || 0]) }],
      ["pen_by_group", "Penalties by group: how many of each", (S) => S.pen, { count: 1, abs: 1, unit: "penalties", need: ["pn_fs"],
        split: PEN_FAM.map(([, , ks, short]) => [cap(short.replace(/ \(.*\)$/, "")), (S) => famSum(S, "pn_", ks)]) }],
      ...PEN.filter(([k]) => !["dog", "tmm"].includes(k)).map(([k, l]) => [`pen_${k}`, l, (S) => S[`pn_${k}`], { count: 1, low: 1, need: [`pn_${k}`], vol: ["snaps played", 200] }]),
    ]],
    ["Penalties grouped (called on him)", PEN_FAM.map(([k, l, ks]) => [`pen_${k}`, l, (S) => famSum(S, "pn_", ks), { count: 1, low: 1, need: ["pn_fs"], vol: ["snaps played", 200] }])],
    ["Points erased by his penalties", [
      ["pen_ptsnull", "Points erased by his penalties (TD 6, FG 3, safety 2)", (S) => S.pn_ptsnull, { count: 1, low: 1, need: ["pn_ptsnull"] }],
      ["pen_tdnull", "Touchdowns erased by his penalties", (S) => S.pn_tdnull, { count: 1, low: 1, need: ["pn_tdnull"] }],
    ]],
    ["Penalty yards (called on him)", penYds("pny_", PEN.map(([k]) => k).filter((k) => !["dog", "tmm"].includes(k)))
      .map(([k, l, fn]) => [`peny_${k}`, l, fn, { count: 1, low: 1, need: ["pny_fs"], vol: ["snaps played", 200] }])],
    // CPOE = how many more of his throws were caught than nflverse's model expected (2006+); WPA = how much his plays moved
    // his team's chance of winning (the passer, runner and target each get the play's)
    ["Accuracy and clutch (CPOE, win probability)", [
      ["cpoe", "Completion % over expected (CPOE)", (S) => div(S.cpoe_sum, S.cpoe_n), { den: (S) => S.cpoe_n, d: 1, fmt: "+", unit: "throws", pos: "QB", need: ["cpoe_n"] }],
      ["wpa", "Win probability added (in wins: +1.00 = one extra win)", (S) => S.wpa, { count: 1, d: 2, fmt: "+", need: ["wpa"] }],
      ["wpa_play", "Win probability added per play (% points)", (S) => div(100 * S.wpa, S.att + S.sacked + S.carries + S.targets), { den: (S) => S.att + S.sacked + S.carries + S.targets, d: 2, fmt: "+", unit: "plays", need: ["wpa"] }],
      ["pass_20", "Completions of 20+ yards (QB)", (S) => S.pass_20, { count: 1, pos: "QB", need: ["pass_20"] }],
      ["pass_40", "Completions of 40+ yards (QB)", (S) => S.pass_40, { count: 1, pos: "QB", need: ["pass_20"] }],
      ["pass_fd", "Passing first downs", (S) => S.pass_fd, { count: 1, pos: "QB", need: ["pass_fd"] }],
    ]],
    ["4th downs (players)", [
      ["fourth_att", "4th-down tries (he threw or ran it)", (S) => S.fourth_att, { count: 1, need: ["fourth_att"] }],
      ["fourth_conv", "4th-down conversions", (S) => S.fourth_conv, { count: 1, need: ["fourth_att"] }],
      ["fourth_pct", "4th-down conversion %", (S) => div(100 * S.fourth_conv, S.fourth_att), { den: (S) => S.fourth_att, pct: 1, unit: "4th-down tries", need: ["fourth_att"] }],
    ]],
    ["Big plays and first downs", [
      ["rush_20", "Runs of 20+ yards", (S) => S.rush_20, { count: 1, pos: "RB", need: ["rush_20"] }],
      ["rush_40", "Runs of 40+ yards", (S) => S.rush_40, { count: 1, pos: "RB", need: ["rush_20"] }],
      ["rec_40", "Catches of 40+ yards", (S) => S.rec_40, { count: 1, pos: "WR", need: ["rec_40"] }],
      ["rec_fd", "Receiving first downs", (S) => S.rec_fd, { count: 1, pos: "WR", need: ["rec_fd"] }],
      ["rec_fd_tgt", "First downs per target", (S) => div(S.rec_fd, S.targets), { den: (S) => S.targets, d: 2, unit: "targets", pos: "WR", need: ["rec_fd"] }],
      ["rush_fd", "Rushing first downs", (S) => S.rush_fd, { count: 1, pos: "RB", need: ["rush_fd"] }],
      ["tot_fd", "First downs (rushing + receiving)", (S) => S.rush_fd + S.rec_fd, { count: 1, need: ["rec_fd"] }],
      ["two_pt", "Two-point conversions", (S) => S.two_pt, { count: 1, need: ["two_pt"] }],
    ]],
    ["Scrambles and run direction", [
      ["scr", "QB scrambles", (S) => S.scr, { count: 1, pos: "QB", need: ["scr"] }],
      ["scr_yds", "Scramble yards", (S) => S.scr_yds, { count: 1, pos: "QB", need: ["scr"] }],
      ...runDirStats("players"),
    ]],
    ["Kicking and punting", kickStats("players")],
    ["Kick and punt returns", returnStats("players")],
    ["Fumbles and defensive scores", [
      ["fum", "Fumbles (all, lost or not)", (S) => S.fum, { count: 1, low: 1, need: ["fum"], vol: ["touches", 50] }],
      ["fum_lost_all", "Fumbles lost", (S) => S.fum_lost_all, { count: 1, low: 1, need: ["fum"], vol: ["touches", 50] }],
      ["def_td", "Defensive touchdowns", (S) => S.def_td, { count: 1, pos: "DEF", need: ["def_td"] }],
      ["int_yds", "Interception return yards", (S) => S.int_yds, { count: 1, pos: "DEF", need: ["int_yds"] }],
      ["safeties", "Safeties", (S) => S.safeties, { count: 1, pos: "DEF", need: ["safeties"] }],
      ["sack_yds", "Sack yards", (S) => S.sack_yds, { count: 1, pos: "DEF", need: ["sack_yds"] }],
      ["sack_yds_lost", "Yards lost to sacks (QB)", (S) => S.sack_yds_lost, { count: 1, low: 1, pos: "QB", need: ["sack_yds_lost"], vol: ["pass attempts", 100] }],
    ]],
  ];
  const statsFor = (who, D) => (who === "players" ? P : T).map(([g, list]) => [g, list.filter(([, , , o]) =>
    (!o.lg || o.lg === D.league) && (!o.need || o.need.every((c) => (who === "players" ? D.pcols : D.tcols).includes(c))))]).filter(([, l]) => l.length);
  const findStat = (who, D, k) => statsFor(who, D).flatMap(([, l]) => l).find((s) => s[0] === k);
  // a stat from loose words ("defensive epa", "ints", "run stops"): the one whose name covers the words best. A whole word in
  // its name counts most, part of a word a bit less, a word only in its group half; most of the words have to be covered.
  const norm = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.'’-]/g, "").toLowerCase();
  const QSYN = { def: "defense", defensive: "defense", offensive: "offense", defence: "defense", ints: "interceptions", int: "interceptions", picks: "interceptions",
    td: "tds", touchdown: "tds", touchdowns: "tds", yds: "yards", yd: "yards", yard: "yards", pct: "%", percent: "%", percentage: "%", rate: "%",
    catches: "receptions", passing: "pass", rushing: "rush", running: "run", receiving: "rec", tackle: "tackles", sacks: "sack",
    // football shorthand people type ("pbus", "tfls", "qbr")
    pbu: "defended", pbus: "defended", pd: "defended", pds: "defended", breakups: "defended", breakup: "defended", tfl: "loss", tfls: "loss",
    ff: "fumbles", qbr: "rating", comp: "completion", comps: "completion", cmp: "completion", recs: "receptions", tgt: "targets", tgts: "targets",
    looks: "targets", dropped: "drops", drop: "drops", fg: "field", fgs: "field", pts: "points", ppg: "points", rushes: "carries", atts: "attempts",
    explosives: "explosive", picked: "interceptions", interception: "interceptions", pressures: "pressures", btk: "broken", btks: "broken",
    flags: "penalties", nullified: "erased", wiped: "erased", negated: "erased", erase: "erased", flag: "penalties", flagged: "penalties", penalized: "penalties", holds: "holding", penalty: "penalties", kind: "type", kinds: "type", pi: "interference", personal: "personal", fourth: "4th" };
  const qStem = (t) => (t.length > 3 && !/ss$/.test(t) ? t.replace(/s$/, "") : t);
  // numbers never name a stat ("drops per 100 targets" = drops per target)
  // ...except "40+", which is part of a stat's name (runs of 40+ yards), not a count
  const qTok = (s) => norm(s).replace(/(\d+)\+/g, " $1plus ").split(/[\s/(),:;+]+/).filter((t) => t && !["the", "of", "a", "per"].includes(t) && !/^\d+$/.test(t)).map((t) => qStem(QSYN[t] || t));
  // Every word any stat's name, unit or group uses. Words outside it (typos, names, "blorp") are skipped instead of sinking the match,
  // so people can type the way they talk and the stat words still find the stat.
  const qVocab = new WeakMap();
  const vocabOf = (groups) => {
    if (!qVocab.has(groups)) qVocab.set(groups, new Set(groups.flatMap(([g, l]) => [...qTok(g), ...l.flatMap((x) => [...qTok(x[1]), ...qTok(x[0].replace(/_/g, " ")), ...qTok(x[3].unit || "")])])));
    return qVocab.get(groups);
  };
  const bestStats = (side, groups) => {
    const voc = vocabOf(groups), all = qTok(side);
    const ws = all.filter((t) => voc.has(t) || (t.length > 2 && [...voc].some((v) => v.startsWith(t))));
    if (!ws.length) return [];
    // words this side has no stat for count against it ("drawn" only exists for teams), so the other side can win
    const skip = (all.length - ws.length) * 0.06, asked = new Set(ws);
    return groups.flatMap(([g, l]) => l.map((x) => {
      // whole words of the name you see count most, then its unit ("targets" for drop %), then parts of words, then the group
      const hl = norm(`${x[1]} ${x[0].replace(/_/g, " ")}`), hg = norm(g), hw = new Set(qTok(x[1])), hu = new Set(qTok(x[3].unit || ""));
      // name words you didn't type (outside the brackets) cost a little: "tackles" is Tackles before Horse-collar tackles
      const extra = qTok(x[1].replace(/\(.*?\)/g, " ")).filter((t) => !asked.has(t)).length * 0.03;
      return [x, ws.reduce((n, t) => n + (hw.has(t) ? 1 : hu.has(t) ? 0.9 : hl.includes(t) ? 0.8 : hg.includes(t) ? 0.5 : 0), 0) / ws.length - hl.length / 1e4 - skip - extra];
    })).filter((s) => s[1] >= 0.65).sort((a, b) => b[1] - a[1]);
  };
  // the Filter box: "run stops > 20 and sacks >= 3", "QB, EPA per dropback over .1", "rookies and tackles at least 30 or sacks > 5".
  // "or" splits it into groups (any group can match), "and" / "&" / a comma splits a group into conditions (all must match).
  // A condition is a stat, a comparison and a number, or a position, team, division, "rookies" or "undrafted".
  const OPS = [["≥", /^(>=|≥|=>|at least|no less than)$/], ["≤", /^(<=|≤|=<|at most|no more than)$/], [">", /^(>|over|more than|above|greater than)$/],
    ["<", /^(<|under|less than|fewer than|below)$/], ["≠", /^(!=|≠|<>|not)$/], ["=", /^(=|==|is|equals)$/]];
  const OP_RE = /^(.*?)\s*(>=|<=|=>|=<|!=|<>|==|≥|≤|≠|>|<|=|at least|at most|no less than|no more than|more than|greater than|less than|fewer than|over|under|above|below|equals|is|not)\s*(-?\d*\.?\d+)\s*%?$/i;
  const cmp = (op, v, n) => (op === "≥" ? v >= n : op === "≤" ? v <= n : op === ">" ? v > n : op === "<" ? v < n : op === "≠" ? Math.abs(v - n) > 1e-9 : Math.abs(v - n) < 1e-9);
  const POS_WORDS = { qb: "QB", qbs: "QB", quarterback: "QB", quarterbacks: "QB", rb: "RB", rbs: "RB", running: "RB", back: "RB", backs: "RB", wr: "WR", wrs: "WR",
    receiver: "WR", receivers: "WR", te: "TE", tes: "TE", "tight end": "TE", "tight ends": "TE", k: "K", kicker: "K", kickers: "K", ol: "OL", "o-line": "OL", oline: "OL", linemen: "OL",
    def: "DEF", defense: "DEF", defenders: "DEF", edge: "EDGE", "edge rushers": "EDGE", idl: "IDL", dl: "IDL", "d-line": "IDL", lb: "LB", lbs: "LB", linebacker: "LB", linebackers: "LB",
    cb: "CB", cbs: "CB", corner: "CB", corners: "CB", cornerbacks: "CB", s: "S", safety: "S", safeties: "S", "running backs": "RB", "wide receivers": "WR" };
  function parseWhere(text, who, groups, teams, confs) {
    const out = { groups: [], read: [], bad: [] };
    for (const grp of String(text || "").split(/\s+or\s+|\s*\|\|\s*/i)) {
      const conds = [];
      for (let c of grp.split(/\s+and\s+|\s*&&?\s*|\s*,\s*|\s*;\s*/i).map((x) => x.trim()).filter(Boolean)) {
        const m = OP_RE.exec(c);
        if (m) {
          const s = bestStats(m[1], groups)[0]?.[0], op = OPS.find(([, r]) => r.test(m[2].toLowerCase()))?.[0];
          if (s && op) { conds.push({ k: "stat", s, op, n: +m[3], txt: `${s[1]} ${op} ${m[3]}` }); continue; }
          out.bad.push(c); continue;
        }
        const w = norm(c).replace(/\s+only$/, "");
        const pos = POS_WORDS[w] || (["QB", "RB", "WR", "TE", "K", "OL", "DEF", "EDGE", "IDL", "LB", "CB", "S"].includes(c.toUpperCase()) && c.toUpperCase());
        const team = Object.entries(teams).find(([, t]) => [t[0], t[1], t[0].split(" ").at(-1)].some((x) => norm(x || "") === w));
        const conf = confs.find((x) => norm(x) === w);
        if (pos && who === "players") conds.push({ k: "pos", v: pos, txt: pos });
        else if (/^rookies?$/.test(w) && who === "players") conds.push({ k: "exp", v: "1", txt: "rookies" });
        else if (/^undrafted$|^udfa$/.test(w) && who === "players") conds.push({ k: "draft", v: "U", txt: "undrafted" });
        else if (team) conds.push({ k: "team", v: team[0], txt: team[1][0] });
        else if (conf) conds.push({ k: "group", v: conf, txt: conf });
        else out.bad.push(c);
      }
      if (conds.length) { out.groups.push(conds); out.read.push(conds.map((x) => x.txt).join(" and ")); }
    }
    return out;
  }

  // ---------------------------------------------------------------- state (all in the link)
  const DEF = { who: "teams", type: "bar", stat: "epa_play", y: "pts", from: "", to: "", wk1: "", wk2: "", per: "game", top: "10",
    group: "", team: "", pos: "", pick: "", order: "best", cum: "", scope: "", radar: "", logo: "", names: "", min: "", role: "", noexit: "", exp: "", draft: "",
    // Style and picture: scheme = colors, ttl/subt = your own title, bg/size = the downloaded picture; nums/grid/curve: "" = on, "0" = off; big/round: "1" = on
    scheme: "", ttl: "", subt: "", bg: "", size: "", nums: "", grid: "", curve: "", big: "", round: "", // logo/names: "" = on, "0" = off; min: "" = automatic
    // where = the filter typed in plain English ("run stops > 20 and sacks >= 3"), every chart; cols = the Table's columns;
    // quad = scatter quadrant names, "top left|top right|bottom left|bottom right"
    where: "", cols: "", quad: "",
    // opp = only games vs "good" (top-half) teams or "soft" ones (cupcakes); last = each one's last N games
    opp: "", last: "",
    // cond = only games played in these conditions (NFL: weather, roof, field, division games; COND)
    cond: "",
    // pl = the player whose stat list is open (search a name: every stat we have on him, by group)
    pl: "",
    mode: "" }; // mode: "" = Simple, "adv" = Advanced (also remembered on this device: "viz-mode")
  let st = { ...DEF };
  const save = () => {
    const q = new URLSearchParams({ league, show: "visualize" });
    Object.entries(st).forEach(([k, v]) => { if (v !== "" && v !== DEF[k]) q.set(k, v); });
    history.replaceState(null, "", `#/stats?${q}`);
  };

  async function file(season, lg = league) {
    const k = `${lg}_${season}`;
    if (!files.has(k)) files.set(k, getJSON(`data/viz/${k}.json`).then((D) => { // deep cuts: a sparse [column, value, ...] list ends each NFL player row
      if (D?.xcols?.length) {
        const n = D.pcols.length + 3;
        D.pcols = D.pcols.concat(D.xcols);
        for (const r of D.prows) { const x = r.length > n ? r.pop() : []; for (let i = 0; i < D.xcols.length; i++) r.push(0); for (let i = 0; i < x.length; i += 2) r[n + x[i]] = x[i + 1]; }
      }
      if (D) D.tx = D.pcols && D.prows ? TX.filter((c) => D.pcols.includes(c)) : []; // player columns teams get added up from
      return D;
    }).catch(() => null));
    return files.get(k);
  }
  // our model's numbers for that season (the latest rankings file), keyed like the chart data: CFB by id, NFL by name
  async function ours(D) {
    if (D.ours) return;
    D.ours = {};
    const weeks = INDEX.leagues[D.league]?.seasons?.[D.season]?.weeks || [];
    const R = weeks.length ? await getJSON(`data/${D.league}/${D.season}/week_${weeks.at(-1)}.json`).catch(() => null) : null;
    const byName = Object.fromEntries(Object.entries(D.teams).map(([k, t]) => [t[0], k]));
    for (const t of R?.teams || []) {
      const k = D.league === "cfb" ? `cfb:${t.id}` : byName[t.team];
      if (k) D.ours[k] = { ci_rating: t.rating, ci_rank: t.power_rank, ci_sos: t.scores?.sos, ci_cupcake: t.scores?.cupcake, ci_resume: t.scores?.resume, ci_eff: t.scores?.efficiency };
    }
    const co = await Coaches.forSeason(D.league, D.season).catch(() => ({})); // NFL by abbreviation, college by name
    for (const [k, t] of Object.entries(D.teams)) {
      const c = co[D.league === "nfl" ? t[1] : t[0]];
      if (c) D.ours[k] = { ...D.ours[k], ...c };
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
  // opponents in the top half of that season (our power rating; seasons without our rankings: win %). "vs cupcakes" = the
  // other half plus anyone not ranked (FCS teams in college).
  function goodSet(D) {
    if (D.good) return D.good;
    const W = {};
    for (const r of D.trows) { const w = W[r[0]] || (W[r[0]] = [0, 0]); w[0] += r[3] > r[4] ? 1 : r[3] === r[4] ? 0.5 : 0; w[1]++; }
    const ours = Object.keys(D.ours || {}).filter((k) => D.ours[k].ci_rating != null);
    const score = ours.length ? (k) => D.ours[k]?.ci_rating ?? -1e9 : (k) => W[k][0] / W[k][1];
    const ks = (ours.length ? ours : Object.keys(W)).sort((a, b) => score(b) - score(a));
    return (D.good = new Set(ks.slice(0, Math.ceil(ks.length / 2))));
  }
  // Our Heisman score (college): production = pass yds/25 + pass TD x4 - INT x2 + rush/rec yds/10 + rush/rec TD x6, each
  // game weighted by the opponent: x1.2 vs the top half of FBS (our power rating), x0.8 vs the bottom half (cupcakes),
  // x0.5 vs FCS. Then times his team's record in his games (0.6 + 0.6 x win %): an unbeaten team's star gets x1.2, .500 x0.9.
  // Columns: hz = weighted production, hz_raw = the same unweighted, hz_w = his team's wins in his games.
  const HZ = { good: 1.2, soft: 0.8, fcs: 0.5 };
  function heisGame(D) {
    const good = goodSet(D), opp = {}, won = {};
    for (const t of D.trows) { opp[`${t[0]}|${t[1]}`] = t[2]; won[`${t[0]}|${t[1]}`] = t[3] > t[4] ? 1 : t[3] === t[4] ? 0.5 : 0; }
    const ix = Object.fromEntries(D.pcols.map((c, i) => [c, i + 3]));
    const v = (r, c) => r[ix[c]] || 0;
    return (r) => {
      const raw = v(r, "pass_yds") / 25 + 4 * v(r, "pass_td") - 2 * v(r, "int") + (v(r, "rush_yds") + v(r, "rec_yds")) / 10 + 6 * (v(r, "rush_td") + v(r, "rec_td"));
      const o = opp[`${r[2]}|${r[1]}`], m = o == null ? 1 : good.has(o) ? HZ.good : D.teams[o] ? HZ.soft : HZ.fcs;
      return { hz: raw * m, hz_raw: raw, hz_w: won[`${r[2]}|${r[1]}`] ?? 0 };
    };
  }
  function sum(D, who, w1, w2, byWeek) {
    const cols = who === "players" ? D.pcols : D.tcols, rows = who === "players" ? D.prows : D.trows, out = {};
    const mx = cols.map((c) => c.startsWith("mx_")); // season highs (longest field goal): the biggest one, not the sum
    const left = who === "players" && st.noexit ? D.pcols.indexOf("left") + 3 : -1; // NFL QBs gone by halftime (hurt, or a blowout)
    // vs good teams / vs cupcakes: who each team played each week
    const oppOf = {};
    if (st.opp) for (const r of D.trows) oppOf[`${r[0]}|${r[1]}`] = r[2];
    const good = st.opp ? goodSet(D) : null;
    const cond = st.cond && D.gcond ? COND.find(([k]) => k === st.cond)?.[2] : null;
    const keep = (r) => {
      if (r[1] < w1 || r[1] > w2 || (left > 2 && r[left])) return false;
      if (cond) { const c = D.gcond[`${who === "players" ? r[2] : r[0]}|${r[1]}`]; if (!c || !cond(c)) return false; }
      if (!st.opp) return true;
      const o = who === "players" ? oppOf[`${r[2]}|${r[1]}`] : r[2];
      return o != null && good.has(o) === (st.opp === "good");
    };
    // last N games: each one's own last N in the weeks picked (byes and missed games skipped)
    let lastOk = null;
    if (+st.last) {
      const wks = {};
      for (const r of rows) if (keep(r)) (wks[r[0]] ||= []).push(r[1]);
      lastOk = {};
      for (const k in wks) lastOk[k] = new Set(wks[k].sort((a, b) => a - b).slice(-st.last));
    }
    // a player's team totals in the games he played (tm_<column>): what "Share of team" divides by. Everyone on the
    // team counts toward the total, filters or not, and a traded player's share uses the team he was on that week.
    const TW = {}, played = new Set();
    if (who === "players") for (const r of rows) {
      if (r[1] < w1 || r[1] > w2) continue;
      const t = TW[`${r[2]}|${r[1]}`] || (TW[`${r[2]}|${r[1]}`] = new Array(cols.length).fill(0));
      for (let i = 0; i < cols.length; i++) t[i] += r[i + 3];
    }
    // the Heisman race (college players): each game's production, weighted by who it came against, and whether his team won
    const heis = who === "players" && D.league === "cfb" ? heisGame(D) : null;
    for (const r of rows) {
      if (!keep(r) || (lastOk && !lastOk[r[0]]?.has(r[1]))) continue;
      const o = out[r[0]] || (out[r[0]] = { S: Object.fromEntries(cols.map((c) => [c, 0])), g: 0, wk: {}, team: r[2] });
      o.g++;
      o.team = r[2];
      const hz = heis ? heis(r) : null;
      if (hz) for (const c in hz) o.S[c] = (o.S[c] || 0) + hz[c];
      if (who === "teams") played.add(`${r[0]}|${r[1]}`);
      cols.forEach((c, i) => { o.S[c] = mx[i] ? Math.max(o.S[c], r[i + 3]) : o.S[c] + r[i + 3]; });
      const t = TW[`${r[2]}|${r[1]}`];
      if (t) cols.forEach((c, i) => { o.S["tm_" + c] = (o.S["tm_" + c] || 0) + t[i]; });
      if (who === "teams") o.S.wins = (o.S.wins || 0) + (r[3] > r[4] ? 1 : r[3] === r[4] ? 0.5 : 0); // pts vs opp_pts
      if (byWeek) {
        const w = o.wk[r[1]] || (o.wk[r[1]] = Object.fromEntries(cols.map((c) => [c, 0])));
        cols.forEach((c, i) => { w[c] = mx[i] ? Math.max(w[c], r[i + 3]) : w[c] + r[i + 3]; });
        if (hz) for (const c in hz) w[c] = (w[c] || 0) + hz[c];
        if (t) cols.forEach((c, i) => { w["tm_" + c] = (w["tm_" + c] || 0) + t[i]; });
      }
    }
    if (who === "players" && D.pseason) for (const [k, v] of Object.entries(D.pseason)) if (out[k]) D.pseason_cols.forEach((c, i) => { out[k].S["ss_" + c] = v[i]; });
    if (who === "teams" && D.tx?.length) { // team run stops etc.: the team's players added up, same weeks
      const ix = D.tx.map((c) => D.pcols.indexOf(c) + 3);
      for (const k in out) for (const c of D.tx) out[k].S[c] = 0;
      for (const r of D.prows) {
        if (!played.has(`${r[2]}|${r[1]}`)) continue; // the team games counted above (weeks, opponents, last N)
        const o = out[r[2]];
        if (!o) continue;
        D.tx.forEach((c, i) => { o.S[c] += r[ix[i]] || 0; });
        if (byWeek && o.wk[r[1]]) { const w = o.wk[r[1]]; D.tx.forEach((c, i) => { w[c] = (w[c] || 0) + (r[ix[i]] || 0); }); }
      }
    }
    if (who === "teams") for (const k in out) if (!D.tcols.includes("opp_yds")) out[k].S.opp_yds = out[k].S.opp_pass_yds + out[k].S.opp_rush_yds;
    return out;
  }
  // Show as: a total any way you like. "share" = % of his team's total in the games he played (tm_ columns, sum()),
  // "snap" = per 100 snaps (NFL players). Rates (completion %...) stay as they are.
  const teamS = (S) => new Proxy(S, { get: (o, c) => o["tm_" + String(c)] });
  const value = (stat, S, g, per) => {
    const v = stat[2](S, g);
    if (v == null || !stat[3].count || (per === "share" && stat[3].noShare)) return v;
    if (per === "game") return g ? v / g : v;
    if (per === "share") { if (S.tm_snaps == null && S.tm_rec == null) return null; const t = stat[2](teamS(S), g); return t ? (100 * v) / t : null; }
    if (per === "snap") return S.snaps ? (100 * v) / S.snaps : null;
    return v;
  };
  const POS_OF = (pos, S) => {
    const p = (pos || "").toUpperCase();
    if (p === "QB") return "QB";
    if (["RB", "FB", "HB"].includes(p)) return "RB";
    if (["WR", "TE"].includes(p)) return "WR";
    if (["K", "PK", "P"].includes(p)) return "K";
    if (["T", "G", "C", "OT", "OG", "OL"].includes(p)) return "OL";
    if (p) return "DEF";
    return S.att >= 10 ? "QB" : S.fg_att ? "K" : S.carries > S.rec && S.carries >= 5 ? "RB" : S.rec ? "WR" : "DEF"; // college defenders have no position on file
  };
  // NFL players also carry [3] role (EDGE, IDL, LB, CB, S, TE...), [4] year in the league (1 = rookie), [5] drafted ("R2 #45" or "UDFA")
  const FINE = { EDGE: "Edge rushers", IDL: "Interior D-line", LB: "Linebackers", CB: "Cornerbacks", S: "Safeties", TE: "Tight ends" };
  const EXP = [["", "Everyone"], ["1", "Rookies"], ["2", "2nd year"], ["3", "3rd year"], ["1-2", "Rookies + 2nd year"], ["4+", "Vets (4+ years)"]];
  const DRAFT = [["", "Any"], ["1", "1st round"], ["2-3", "Rounds 2-3"], ["4-7", "Rounds 4-7"], ["U", "Undrafted"]];
  // game conditions (NFL, src/viz_data.py gcond): [roof 1 indoors / 2 outdoors, field 1 turf / 2 grass, temp °F, wind mph, division game]
  const COND = [["", "All games"], ["cold", "Cold (under 40°F)", (c) => c[2] != null && c[2] < 40], ["freezing", "Freezing (32°F or colder)", (c) => c[2] != null && c[2] <= 32],
    ["hot", "Hot (85°F or warmer)", (c) => c[2] != null && c[2] >= 85], ["windy", "Windy (15+ mph)", (c) => c[3] != null && c[3] >= 15],
    ["indoors", "Dome or closed roof", (c) => c[0] === 1], ["outdoors", "Outdoors", (c) => c[0] === 2], ["grass", "On grass", (c) => c[1] === 2],
    ["turf", "On turf", (c) => c[1] === 1], ["div", "Division games", (c) => c[4] === 1], ["nondiv", "Non-division games", (c) => c[4] === 0]];
  const OPP = [["", "Everyone"], ["good", "Vs top-half teams"], ["soft", "Vs cupcakes (bottom half)"]], LAST = [["", "All games"], ["3", "Last 3 games"], ["5", "Last 5 games"]];
  const expOk = (y, e) => y != null && (e === "1-2" ? y >= 1 && y <= 2 : e === "4+" ? y >= 4 : y === +e);
  const draftOk = (dr, f) => { if (!dr) return false; const r = /^R(\d)/.exec(dr)?.[1]; return f === "U" ? !r : f === "1" ? r === "1" : f === "2-3" ? r === "2" || r === "3" : r >= "4"; };
  const lc = (x) => x.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()); // "Passing yards" -> "passing yards", "EPA per play" stays
  const fmt = (stat, v, per) => {
    if (v == null || Number.isNaN(v)) return "–";
    const o = stat[3], sh = o.count && per === "share", d = o.pct || sh || (o.count && per === "snap") ? 1 : o.d ?? (o.count && per === "game" ? 1 : 0);
    const s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    return (v < 0 ? "-" : o.fmt === "+" && v > 0 ? "+" : "") + s + (o.pct || sh ? "%" : "");
  };

  // ---------------------------------------------------------------- page
  async function render(params) {
    const el = document.getElementById("view-stats");
    st = { ...DEF, ...Object.fromEntries([...params].filter(([k]) => k in DEF)) };
    if (!params.has("mode")) st.mode = store.get("viz-mode") === "adv" ? "adv" : "";
    el.innerHTML = stSub() + `<div class="card muted">Loading…</div>`;
    idx = idx || await getJSON("data/viz/index.json").catch(() => ({}));
    const pFrom = idx.players?.[league] || 0; // NFL seasons before this are team-only (smaller files, back to 1999)
    const seasons = (idx[league] || []).filter((s) => st.who !== "players" || s >= pFrom);
    if (!seasons.length) { el.innerHTML = stSub() + `<div class="card">No chart data for ${league === "nfl" ? "the NFL" : "college"} yet. It's built every week with the rankings.</div>`; return; }
    if (!seasons.includes(+st.to)) st.to = String(seasons.at(-1));
    if (!seasons.includes(+st.from) || +st.from > +st.to) st.from = st.from && +st.from < seasons[0] && +st.to >= seasons[0] ? String(seasons[0]) : st.to; // players from a team-only season: their first season
    try { await Promise.all([loadChartJs(), loadLogos()]); } catch { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart library. Check your connection and try again.</div>`; return; }
    const span = seasons.filter((s) => s >= +st.from && s <= +st.to);
    const Ds = (await Promise.all(span.map((s) => file(s)))).filter(Boolean);
    await Promise.all(Ds.map(ours));
    if (!Ds.length) { el.innerHTML = stSub() + `<div class="card">Couldn't load the chart data. Try again in a minute.</div>`; return; }
    draw(el, seasons, Ds);
  }
  const stSub = () => Live.statsSubtabs("visualize");

  // Presets: popular charts, one pick away (the Presets dropdown). A plain string starts a new heading in the dropdown.
  // People's own presets are added below these.
  const T_ = (o) => ({ who: "teams", ...o }), P_ = (o) => ({ who: "players", ...o });
  const PRESETS = {
    nfl: [
      "Teams",
      ["Schedule vs record (the Schedules chart)", T_({ type: "scatter", stat: "ci_sos", y: "win_pct", top: "all" })],
      ["Who's for real: EPA per play vs points", T_({ type: "scatter", stat: "epa_play", y: "pts", top: "all" })],
      ["Offense vs defense (EPA, four quadrants)", T_({ type: "scatter", stat: "epa_play", y: "def_epa_play", top: "all", quad: "Defense carries|Contenders|Bad at both|Shootouts" })],
      ["Pass offense vs run offense (EPA)", T_({ type: "scatter", stat: "pass_epa_play", y: "rush_epa_play", top: "all", quad: "Run first|Do it all|Stuck|Air it out" })],
      ["Coach score vs power rating", T_({ type: "scatter", stat: "co_score", y: "ci_rating", top: "all" })],
      ["Best offenses (EPA per play)", T_({ type: "bar", stat: "epa_play", top: "15" })],
      ["Best defenses (EPA per play allowed)", T_({ type: "bar", stat: "def_epa_play", top: "15" })],
      ["Net EPA: offense minus defense", T_({ type: "bar", stat: "net_epa", top: "all" })],
      ["Point margin", T_({ type: "bar", stat: "margin", per: "total", top: "all" })],
      ["Best offenses vs top-half defenses (EPA per play)", T_({ type: "bar", stat: "epa_play", top: "15", opp: "good" })],
      ["Point margin vs top-half teams only", T_({ type: "bar", stat: "margin", top: "all", opp: "good" })],
      ["Pass-happy teams (pass rate)", T_({ type: "bar", stat: "pass_rate", top: "15" })],
      ["Points per play", T_({ type: "bar", stat: "pts_play", top: "15" })],
      ["Yardage margin", T_({ type: "bar", stat: "yds_margin", top: "all" })],
      ["Turnover margin", T_({ type: "bar", stat: "to_margin", per: "total", top: "all" })],
      ["Most sacks allowed", T_({ type: "bar", stat: "sacked", per: "total", order: "worst", top: "15" })],
      ["Who blitzes the most", T_({ type: "bar", stat: "blitz_rate", top: "15" })],
      ["Worst deep-ball defenses (deep completion % allowed)", T_({ type: "bar", stat: "deep_cmp_allowed", order: "worst", top: "15" })],
      ["Most yards after catch allowed", T_({ type: "bar", stat: "yac_allowed", order: "worst", top: "15" })],
      ["Most penalized teams", T_({ type: "bar", stat: "pen", order: "worst", top: "15" })],
      ["Most false starts", T_({ type: "bar", stat: "tpen_fs", per: "total", order: "worst", top: "15" })],
      ["Pre-snap penalties, most to fewest", T_({ type: "bar", stat: "tpen_pre", per: "total", order: "worst", top: "all" })],
      ["Who draws the most pass interference", T_({ type: "bar", stat: "tpend_dpi", per: "total", top: "15" })],
      ["Points erased by their own penalties", T_({ type: "bar", stat: "tpen_ptsnull", per: "total", order: "worst", top: "15" })],
      ["NFL-wide by season: points erased by penalties since 1999", T_({ type: "bar", scope: "league", stat: "tpen_ptsnull", per: "total", from: "1999", to: "" })],
      ["Personal fouls, most to fewest", T_({ type: "bar", stat: "tpen_pf", per: "total", order: "worst", top: "all" })],
      ["Penalties: offense vs defense", T_({ type: "scatter", stat: "tpen_side_o", y: "tpen_side_d", per: "total", top: "all" })],
      ["NFL-wide by season: personal fouls per game since 1999", T_({ type: "bar", scope: "league", stat: "tpen_pf", from: "1999", to: "" })],
      ["NFL-wide by season: roughing the passer calls per game since 1999", T_({ type: "bar", scope: "league", stat: "tpen_rtp", from: "1999", to: "" })],
      ["Share of the league's sacks (pie)", T_({ type: "pie", stat: "def_sacks", top: "10" })],
      ["Team profiles (radar)", T_({ type: "radar", top: "3" })],
      "League history",
      ["NFL-wide by week: penalties per game, season vs season", T_({ type: "line", scope: "league", stat: "pen" })],
      ["NFL-wide by week: points per game, season vs season", T_({ type: "line", scope: "league", stat: "pts" })],
      ["NFL-wide by season: penalties per game since 1999", T_({ type: "bar", scope: "league", stat: "pen", from: "1999", to: "" })],
      ["NFL-wide by season: points per game since 1999", T_({ type: "bar", scope: "league", stat: "pts", from: "1999", to: "" })],
      ["NFL-wide by season: passing yards per game since 1999", T_({ type: "bar", scope: "league", stat: "pass_yds", from: "1999", to: "" })],
      ["NFL-wide by season: rushing yards per game since 1999", T_({ type: "bar", scope: "league", stat: "rush_yds", from: "1999", to: "" })],
      ["NFL-wide by season: sacks per game since 1999", T_({ type: "bar", scope: "league", stat: "def_sacks", from: "1999", to: "" })],
      "Quarterbacks",
      ["Top passers (EPA per dropback)", P_({ type: "bar", stat: "epa_db", pos: "QB", top: "15" })],
      ["Passer rating leaders", P_({ type: "bar", stat: "rating", pos: "QB", top: "15" })],
      ["QB efficiency vs volume", P_({ type: "scatter", stat: "epa_db", y: "pass_yds", pos: "QB", top: "all" })],
      ["Completion % vs yards per attempt", P_({ type: "scatter", stat: "cmp_pct", y: "ypa", pos: "QB", top: "all", quad: "Gunslingers|Elite|Struggling|Dink and dunk" })],
      ["Passing yards race", P_({ type: "line", stat: "pass_yds", pos: "QB", top: "5", cum: "1" })],
      ["Passing TD race", P_({ type: "line", stat: "pass_td", pos: "QB", top: "5", cum: "1" })],
      ["Most interceptions thrown", P_({ type: "bar", stat: "int", per: "total", pos: "QB", order: "worst", top: "15" })],
      ["Most sacked QBs", P_({ type: "bar", stat: "sacked", per: "total", pos: "QB", order: "worst", top: "15" })],
      ["Running QBs (rushing yards)", P_({ type: "bar", stat: "rush_yds", per: "total", pos: "QB", top: "15" })],
      ["Rookie QBs (EPA per dropback)", P_({ type: "bar", stat: "epa_db", pos: "QB", exp: "1", top: "10" })],
      ["Under pressure: pressured % vs EPA", P_({ type: "scatter", stat: "pressured_pct", y: "epa_db", pos: "QB", top: "all" })],
      ["Best vs the blitz (passer rating)", P_({ type: "bar", stat: "bz_rating", pos: "QB", top: "15" })],
      ["Fewest bad throws", P_({ type: "bar", stat: "bad_throw_pct", pos: "QB", top: "15" })],
      ["Red-zone TD % (QB)", P_({ type: "bar", stat: "rz_td_pct", pos: "QB", top: "15" })],
      ["3rd-down QBs (conversion %)", P_({ type: "bar", stat: "third_db_pct", pos: "QB", top: "15" })],
      ["QB profiles (radar)", P_({ type: "radar", pos: "QB", top: "3" })],
      "Where QBs throw",
      ["Where QBs throw: left / middle / right", P_({ type: "bar", stat: "qb_by_side", pos: "QB", top: "15" })],
      ["Where QBs throw: short / intermediate / deep", P_({ type: "bar", stat: "qb_by_depth", pos: "QB", top: "15" })],
      ["Where QBs throw: all 9 zones", P_({ type: "bar", stat: "qb_by_zone", pos: "QB", top: "10" })],
      ["One QB's throw map (pie: pick him in Highlight)", P_({ type: "pie", stat: "qb_by_zone", pos: "QB" })],
      ["Who throws deep the most (% of throws 20+ air yards)", P_({ type: "bar", stat: "qb_pct_d", pos: "QB", top: "15" })],
      ["Checkdown kings (% of throws under 10 air yards)", P_({ type: "bar", stat: "qb_pct_s", pos: "QB", top: "15" })],
      ["Who works the middle of the field", P_({ type: "bar", stat: "qb_pct_m", pos: "QB", top: "15" })],
      ["Aggressive vs accurate: deep % vs completion %", P_({ type: "scatter", stat: "qb_pct_d", y: "cmp_pct", pos: "QB", top: "all", quad: "Safe|Elite|Struggling|Gunslingers" })],
      ["Left vs right: % of throws to each side", P_({ type: "scatter", stat: "qb_pct_l", y: "qb_pct_r", pos: "QB", top: "all" })],
      ["Deep ball accuracy (completion % on 20+ air yards)", P_({ type: "bar", stat: "qb_cmp_d", pos: "QB", top: "15" })],
      ["Deep middle: who hits it (completion %)", P_({ type: "bar", stat: "qb_cmp_dm", pos: "QB", top: "15" })],
      ["Yards per attempt over the middle", P_({ type: "bar", stat: "qb_ypa_m", pos: "QB", top: "15" })],
      ["Yards per attempt on intermediate throws (10-19)", P_({ type: "bar", stat: "qb_ypa_i", pos: "QB", top: "15" })],
      ["Over the middle: how often vs how well (EPA per throw)", P_({ type: "scatter", stat: "qb_pct_m", y: "qb_epa_m", pos: "QB", top: "all", quad: "Picky but good|Middle masters|Stays away|Forces it" })],
      ["Passer rating over the middle", P_({ type: "bar", stat: "qb_rate_m", pos: "QB", top: "15" })],
      ["Hurt by drops: passes his receivers dropped", P_({ type: "bar", stat: "pass_drops", per: "total", pos: "QB", top: "15" })],
      ["Drop-adjusted completion %", P_({ type: "bar", stat: "adj_cmp", pos: "QB", top: "15" })],
      ["EPA per throw on deep balls (20+ air yards)", P_({ type: "bar", stat: "qb_epa_d", pos: "QB", top: "15" })],
      ["Passer rating: left vs right", P_({ type: "scatter", stat: "qb_rate_l", y: "qb_rate_r", pos: "QB", top: "all" })],
      ["QBs vs top-half defenses (EPA per dropback)", P_({ type: "bar", stat: "epa_db", pos: "QB", top: "15", opp: "good" })],
      ["QBs vs cupcakes (EPA per dropback)", P_({ type: "bar", stat: "epa_db", pos: "QB", top: "15", opp: "soft" })],
      ["TD % vs INT %", P_({ type: "scatter", stat: "td_pct", y: "int_pct", pos: "QB", top: "all", quad: "Careful|Elite|Struggling|Gunslingers" })],
      ["Throw-zone profiles (radar)", P_({ type: "radar", pos: "QB", top: "3", radar: "qb_pct_l,qb_pct_m,qb_pct_r,qb_pct_s,qb_pct_i,qb_pct_d" })],
      "Receivers",
      ["Best WR1s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR1", top: "15" })],
      ["Best WR2s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR2", top: "15" })],
      ["Receiving yards race", P_({ type: "line", stat: "rec_yds", pos: "WR", top: "5", cum: "1" })],
      ["Target leaders", P_({ type: "bar", stat: "targets", per: "total", pos: "WR", top: "15" })],
      ["Air yards leaders", P_({ type: "bar", stat: "air_yds", per: "total", pos: "WR", top: "15" })],
      ["Deep threats: yards per catch vs catch rate", P_({ type: "scatter", stat: "ypr", y: "catch_pct", pos: "WR", top: "25" })],
      ["EPA per target", P_({ type: "bar", stat: "epa_tgt", pos: "WR", top: "15" })],
      ["Yards after catch leaders", P_({ type: "bar", stat: "yac", top: "15" })],
      ["Where receivers get targeted: left / middle / right", P_({ type: "bar", stat: "rec_by_side", pos: "WR", top: "15" })],
      ["Where receivers get targeted: short / intermediate / deep", P_({ type: "bar", stat: "rec_by_depth", pos: "WR", top: "15" })],
      ["Tight ends: where they get targeted", P_({ type: "bar", stat: "rec_by_depth", pos: "TE", top: "10" })],
      ["Deep target share (% of targets 20+ air yards)", P_({ type: "bar", stat: "rec_pct_d", pos: "WR", top: "15" })],
      ["Catch % on deep targets", P_({ type: "bar", stat: "rec_cmp_d", pos: "WR", top: "15" })],
      ["Red-zone targets", P_({ type: "bar", stat: "rz_tgt", per: "total", top: "15" })],
      ["Most drops", P_({ type: "bar", stat: "drops", per: "total", pos: "WR", order: "worst", top: "15" })],
      ["Drop % (drops per target)", P_({ type: "bar", stat: "drop_pct", pos: "WR", order: "worst", top: "15" })],
      ["Broken tackles leaders", P_({ type: "bar", stat: "btk", per: "total", top: "15" })],
      ["Target share leaders", P_({ type: "bar", stat: "tgt_share", pos: "WR", top: "15" })],
      ["Target share, last 3 games (who's trending up)", P_({ type: "bar", stat: "tgt_share", pos: "WR", top: "15", last: "3" })],
      ["WOPR (target share + air-yards share)", P_({ type: "bar", stat: "wopr", pos: "WR", top: "15" })],
      ["Depth vs volume: aDOT vs target share", P_({ type: "scatter", stat: "adot", y: "tgt_share", pos: "WR", top: "all", quad: "Short + busy|Alpha|Role players|Deep shots" })],
      ["RACR (receiving yards per air yard)", P_({ type: "bar", stat: "racr", pos: "WR", top: "15" })],
      ["EPA per target over the middle", P_({ type: "bar", stat: "rec_epa_m", pos: "WR", top: "15" })],
      ["WR profiles (radar)", P_({ type: "radar", pos: "WR", top: "3" })],
      "Running backs",
      ["Rushing yards race", P_({ type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" })],
      ["Workhorse RB1s (carries per game)", P_({ type: "bar", stat: "carries", role: "RB1", top: "15" })],
      ["Yards per carry", P_({ type: "bar", stat: "ypc", pos: "RB", top: "15" })],
      ["Run success % vs yards per carry", P_({ type: "scatter", stat: "rush_succ_pct", y: "ypc", pos: "RB", top: "all", quad: "Boom or bust|Elite|Stuck|Grinders" })],
      ["Explosive runs (10+ yards)", P_({ type: "bar", stat: "rush_10", per: "total", pos: "RB", top: "15" })],
      ["Pass-catching backs", P_({ type: "bar", stat: "rec_yds", per: "total", pos: "RB", top: "15" })],
      ["Scrimmage yards leaders", P_({ type: "bar", stat: "scrim", per: "total", top: "15" })],
      ["Workhorses: carry share", P_({ type: "bar", stat: "carry_share", pos: "RB", top: "15" })],
      ["Yards per touch", P_({ type: "bar", stat: "ypt", pos: "RB", top: "15" })],
      ["RB profiles (radar)", P_({ type: "radar", pos: "RB", top: "3" })],
      "Fantasy",
      ["Fantasy (PPR) leaders", P_({ type: "bar", stat: "ppr", top: "20" })],
      ["Fantasy (PPR): QBs", P_({ type: "bar", stat: "ppr", pos: "QB", top: "15" })],
      ["Fantasy (PPR): RBs", P_({ type: "bar", stat: "ppr", pos: "RB", top: "15" })],
      ["Fantasy (PPR): WRs and TEs", P_({ type: "bar", stat: "ppr", pos: "WR", top: "15" })],
      ["Fantasy (PPR) points race", P_({ type: "line", stat: "ppr", top: "5", cum: "1" })],
      ["Fantasy (PPR) points per touch", P_({ type: "bar", stat: "ppr_touch", top: "15" })],
      "Defense",
      ["Sack leaders", P_({ type: "bar", stat: "def_sacks", per: "total", pos: "DEF", top: "15" })],
      ["Interception leaders", P_({ type: "bar", stat: "def_int", per: "total", pos: "DEF", top: "15" })],
      ["Tackles for loss", P_({ type: "bar", stat: "tfl", per: "total", pos: "DEF", top: "15" })],
      ["Passes defended", P_({ type: "bar", stat: "pd", per: "total", pos: "DEF", top: "15" })],
      ["Pass rushers: pressures vs sacks", P_({ type: "scatter", stat: "pressure", y: "def_sacks", per: "total", pos: "EDGE", top: "50" })],
      ["DB coverage: passer rating allowed (corners)", P_({ type: "bar", stat: "cov_rating", pos: "CB", top: "15" })],
      ["DB coverage: success % vs yards per target (corners)", P_({ type: "scatter", stat: "cov_win", y: "cov_ypt", pos: "CB", top: "all" })],
      ["DB coverage: safeties, passer rating allowed", P_({ type: "bar", stat: "cov_rating", pos: "S", top: "15" })],
      ["DB coverage: rookie corners, success %", P_({ type: "bar", stat: "cov_win", pos: "CB", exp: "1", top: "15" })],
      ["DB coverage: most picked on (targets)", P_({ type: "bar", stat: "cov_tgt", per: "total", pos: "CB", top: "15" })],
      ["DB coverage: corner profiles (radar)", P_({ type: "radar", pos: "CB", top: "3" })],
      ["Field goal % (kickers)", P_({ type: "bar", stat: "fg_pct", pos: "K", top: "15" })],
      ["Havoc plays (TFL + passes defended + INTs)", P_({ type: "bar", stat: "havoc", per: "total", pos: "DEF", top: "15" })],
      ["Sack share (% of his team's sacks)", P_({ type: "bar", stat: "def_sacks", per: "share", pos: "DEF", top: "15", min: "3" })],
      "Deep cuts",
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
      ["Deep cuts: goal-line carries", P_({ type: "bar", stat: "gl_carries", per: "total", pos: "RB", top: "15" })],
      ["Deep cuts: rookie WRs, deep catches", P_({ type: "bar", stat: "deep_rec", per: "total", pos: "WR", exp: "1", top: "15" })],
      ["Deep cuts: 3rd-down go-to guys", P_({ type: "bar", stat: "third_conv", per: "total", top: "15" })],
      ["Deep cuts: clutch QBs", P_({ type: "bar", stat: "clutch", pos: "QB", top: "15" })],
      ["Deep cuts: deep ball QBs", P_({ type: "bar", stat: "deep_cmp_pct", pos: "QB", top: "15" })],
      ["Deep cuts: most penalized players", P_({ type: "bar", stat: "pen", per: "total", order: "worst", top: "15" })],
      ["Who gets flagged for what (penalty types, most penalized players)", P_({ type: "bar", stat: "pen_by_type", per: "total", top: "15" })],
      ["Commanders: who gets flagged for what", P_({ type: "bar", stat: "pen_by_type", per: "total", team: "nfl:28", top: "25" })],
      ["TD killers: touchdowns erased by his penalties", P_({ type: "bar", stat: "pen_tdnull", per: "total", order: "worst", top: "15" })],
      ["Most holding calls (players)", P_({ type: "bar", stat: "pen_hold", per: "total", order: "worst", top: "15" })],
      ["Most pass interference calls (players)", P_({ type: "bar", stat: "pen_dpi", per: "total", order: "worst", top: "15" })],
      "Obscure but cool",
      ["NFL-wide by season: going for it on 4th down since 1999", T_({ type: "bar", scope: "league", stat: "go4_rate", from: "1999", to: "" })],
      ["NFL-wide by season: shotgun % since 1999", T_({ type: "bar", scope: "league", stat: "shotgun_pct", from: "1999", to: "" })],
      ["NFL-wide by season: extra point % (the 2015 rule change)", T_({ type: "bar", scope: "league", stat: "txp_pct", from: "1999", to: "" })],
      ["NFL-wide by season: kick returns per game (kickoff rule changes)", T_({ type: "bar", scope: "league", stat: "tkr", from: "1999", to: "" })],
      ["NFL-wide by season: points per drive since 1999", T_({ type: "bar", scope: "league", stat: "pts_drive", from: "1999", to: "" })],
      ["NFL-wide by season: field goal % from 50+", T_({ type: "bar", scope: "league", stat: "tfg_pct_50p", from: "1999", to: "" })],
      ["NFL-wide by season: no-huddle %", T_({ type: "bar", scope: "league", stat: "nohuddle_pct", from: "1999", to: "" })],
      ["Pass-happy or run-heavy: pass rate over expected vs EPA", T_({ type: "scatter", stat: "proe", y: "epa_play", top: "all", quad: "Run-heavy, working|Pass-happy, working|Run-heavy, stuck|Pass-happy, stuck" })],
      ["4th-down guts: go-for-it % vs conversion %", T_({ type: "scatter", stat: "go4_rate", y: "go4_pct", top: "all", quad: "Picky and good|Bold and good|Picky and bad|Bold and bad" })],
      ["Short-field merchants: drive start vs points per drive", T_({ type: "scatter", stat: "drive_start", y: "pts_drive", top: "all", quad: "Earn it|Gifted|Stuck|Wasting it" })],
      ["Best in the freezing cold since 2010 (point margin)", T_({ type: "bar", stat: "margin", cond: "freezing", from: "2010", to: "", top: "15" })],
      ["Who owns their division (point margin)", T_({ type: "bar", stat: "margin", cond: "div", top: "all" })],
      ["Where teams run: all 7 gaps", T_({ type: "bar", stat: "trun_dir_gap", top: "all" })],
      ["Clutch vs efficient QBs: EPA per dropback vs win probability added", P_({ type: "scatter", stat: "epa_db", y: "wpa", per: "total", pos: "QB", top: "all", quad: "Clutch, not pretty|Do it all|Neither|Pretty, not clutch" })],
      ["Accurate for real: CPOE vs completion %", P_({ type: "scatter", stat: "cmp_pct", y: "cpoe", pos: "QB", top: "all", quad: "Hard throws, on target|Elite|Struggling|Easy throws" })],
      ["QBs in the cold since 2022 (CPOE)", P_({ type: "bar", stat: "cpoe", pos: "QB", cond: "cold", from: "2022", to: "", top: "15" })],
      ["Win probability added leaders (any position)", P_({ type: "bar", stat: "wpa", per: "total", top: "15" })],
      ["Who keeps the chains moving: first downs per target", P_({ type: "bar", stat: "rec_fd_tgt", pos: "WR", top: "15" })],
      ["Where running backs run: all 7 gaps", P_({ type: "bar", stat: "run_dir_gap", per: "total", pos: "RB", top: "15" })],
      ["Long-range kickers since 2022 (field goal % from 50+)", P_({ type: "bar", stat: "fg_pct_50p", pos: "K", from: "2022", to: "", top: "15" })],
      ["Punters: net average vs inside-the-20 %", P_({ type: "scatter", stat: "punt_net", y: "punt_in20_pct", pos: "K", top: "all", quad: "Placement|Elite|Shanks|Boomers" })],
      ["Best kick returners, new kickoff era (2024 on)", P_({ type: "bar", stat: "kr_avg", from: "2024", to: "", top: "15" })],
    ],
    cfb: [
      "Heisman race",
      ["Heisman race: who we think should win it", P_({ type: "bar", stat: "heisman", top: "10" })],
      ["Heisman race week by week", P_({ type: "line", stat: "heis_prod", per: "total", top: "5", cum: "1" })],
      ["Raw production vs our Heisman score (who padded vs cupcakes?)", P_({ type: "scatter", stat: "heis_raw", y: "heisman", top: "25" })],
      "Teams",
      ["Schedule vs cupcakes (the Schedules chart)", T_({ type: "scatter", stat: "ci_sos", y: "ci_cupcake", top: "all" })],
      ["Who's for real: EPA per play vs points", T_({ type: "scatter", stat: "epa_play", y: "pts", top: "50" })],
      ["Power rating vs record (who's lucky?)", T_({ type: "scatter", stat: "ci_rating", y: "win_pct", top: "50" })],
      ["Offense vs defense (EPA, four quadrants)", T_({ type: "scatter", stat: "epa_play", y: "def_epa_play", top: "50", quad: "Defense carries|Contenders|Bad at both|Shootouts" })],
      ["Coach score vs power rating", T_({ type: "scatter", stat: "co_score", y: "ci_rating", top: "50" })],
      ["Success rate vs EPA (consistent or explosive?)", T_({ type: "scatter", stat: "succ", y: "epa_play", top: "50" })],
      ["Most padded schedules (cupcake score)", T_({ type: "bar", stat: "ci_cupcake", top: "15" })],
      ["Hardest schedules", T_({ type: "bar", stat: "ci_sos", top: "15" })],
      ["Best offenses (EPA per play)", T_({ type: "bar", stat: "epa_play", top: "15" })],
      ["Best defenses (EPA per play allowed)", T_({ type: "bar", stat: "def_epa_play", top: "15" })],
      ["Yards per play", T_({ type: "bar", stat: "ypp", top: "15" })],
      ["Point margin", T_({ type: "bar", stat: "margin", per: "total", top: "25" })],
      ["Point margin vs top-half teams only", T_({ type: "bar", stat: "margin", top: "25", opp: "good" })],
      ["Who feasts on cupcakes (points per game vs the bottom half)", T_({ type: "bar", stat: "pts", top: "15", opp: "soft" })],
      ["Pass-happy teams (pass rate)", T_({ type: "bar", stat: "pass_rate", top: "15" })],
      ["Third-down rate", T_({ type: "bar", stat: "third", top: "15" })],
      ["Most penalized teams", T_({ type: "bar", stat: "pen", order: "worst", top: "15" })],
      ["League-wide by week: points per game, season vs season", T_({ type: "line", scope: "league", stat: "pts" })],
      ["Team profiles (radar)", T_({ type: "radar", top: "3" })],
      "Players",
      ["Top passers (passing efficiency)", P_({ type: "bar", stat: "eff", pos: "QB", top: "15" })],
      ["Completion % vs yards per attempt", P_({ type: "scatter", stat: "cmp_pct", y: "ypa", pos: "QB", top: "50", quad: "Gunslingers|Elite|Struggling|Dink and dunk" })],
      ["QBs vs top-half defenses (passing efficiency)", P_({ type: "bar", stat: "eff", pos: "QB", top: "15", opp: "good" })],
      ["Catch share leaders (% of team catches)", P_({ type: "bar", stat: "rec_share", pos: "WR", top: "15" })],
      ["Workhorses: carry share", P_({ type: "bar", stat: "carry_share", pos: "RB", top: "15" })],
      ["Passing yards race", P_({ type: "line", stat: "pass_yds", pos: "QB", top: "5", cum: "1" })],
      ["Passing TD race", P_({ type: "line", stat: "pass_td", pos: "QB", top: "5", cum: "1" })],
      ["Running QBs (rushing yards)", P_({ type: "bar", stat: "rush_yds", per: "total", pos: "QB", top: "15" })],
      ["QB profiles (radar)", P_({ type: "radar", pos: "QB", top: "3" })],
      ["Rushing yards race", P_({ type: "line", stat: "rush_yds", pos: "RB", top: "5", cum: "1" })],
      ["Yards per carry", P_({ type: "bar", stat: "ypc", pos: "RB", top: "15" })],
      ["Rushing + receiving TDs", P_({ type: "bar", stat: "tds", per: "total", top: "15" })],
      ["Best WR1s (receiving yards per game)", P_({ type: "bar", stat: "rec_yds", role: "WR1", top: "15" })],
      ["Receiving yards race", P_({ type: "line", stat: "rec_yds", pos: "WR", top: "5", cum: "1" })],
      ["Yards per catch", P_({ type: "bar", stat: "ypr", pos: "WR", top: "15" })],
      ["Scrimmage yards leaders", P_({ type: "bar", stat: "scrim", top: "15" })],
      ["Sack leaders", P_({ type: "bar", stat: "def_sacks", per: "total", pos: "DEF", top: "15" })],
      ["Interception leaders", P_({ type: "bar", stat: "def_int", per: "total", pos: "DEF", top: "15" })],
      ["Tackle leaders", P_({ type: "bar", stat: "tackles", per: "total", pos: "DEF", top: "15" })],
      ["Tackles for loss", P_({ type: "bar", stat: "tfl", per: "total", pos: "DEF", top: "15" })],
    ],
  };
  // the dropdown's headings: [heading, [[name, index in the list], ...]] (the option's value is p<index>)
  const presetGroups = (list) => list.reduce((out, x, i) => { if (typeof x === "string") out.push([x, []]); else (out.at(-1) || (out[0] = ["Popular", []]))[1].push([x[0], i]); return out; }, []);
  // your own presets: localStorage "viz-presets" {nfl: [{name, st}], cfb: [...]}, synced to your account when signed in (account.js)
  const MINE = "viz-presets";
  const mine = () => store.get(MINE) || {};
  const saveMine = (v) => store.set(MINE, v);
  // My charts (the portfolio): each saved chart also keeps when it was saved, its seasons, what it shows and who's on it
  // ({name, st, at, what, teams, players}), so the list can be sorted by team, player or stat. A small picture of each
  // stays on this device only ("viz-thumbs", too big to sync); other devices show the chart type instead.
  const THUMBS = "viz-thumbs";
  const thumbs = () => { try { return JSON.parse(localStorage.getItem(THUMBS) || "{}"); } catch { return {}; } };
  const saveThumbs = (v) => { try { localStorage.setItem(THUMBS, JSON.stringify(v)); } catch {} };
  const RADAR = { teams: ["epa_play", "def_epa_play", "ypp", "third", "giveaways", "def_sacks", "pts"], players: {
    QB: ["pass_yds", "pass_td", "cmp_pct", "ypa", "int", "epa_db", "eff", "rush_yds"], RB: ["rush_yds", "ypc", "rush_td", "rec", "rec_yds", "epa_rush"],
    WR: ["rec", "rec_yds", "rec_td", "ypr", "catch_pct", "epa_tgt", "yac"],
    CB: ["cov_rating", "cov_win", "cov_ypt", "cov_td", "ball", "def_int", "miss_pct"], S: ["cov_rating", "cov_win", "cov_ypt", "ball", "tackles", "run_stop", "miss_pct"], DEF: ["tackles", "def_sacks", "tfl", "qb_hits", "pd", "def_int"], K: ["fg_made", "fg_pct"], "": ["scrim", "tds", "rec_yds", "rush_yds", "pass_yds"] } };

  function draw(el, seasons, Ds) {
    const D = Ds.at(-1), who = st.who, multi = Ds.length > 1;
    const have = { league: D.league, pcols: D.pcols, // a stat shows if every season picked has it (team run stops etc.: added up from players)
      tcols: [...D.tcols.filter((c) => Ds.every((d) => d.tcols.includes(c))), ...(D.tx || []).filter((c) => Ds.every((d) => d.tx?.includes(c)))] };
    const groups = statsFor(who, have), all = groups.flatMap(([, l]) => l);
    const stat = all.find((s) => s[0] === st.stat) || all[0];
    st.stat = stat[0];
    const ystat = all.find((s) => s[0] === st.y) || all.find((s) => s[0] !== stat[0]);
    st.y = ystat[0];
    if (!D.gcond) st.cond = "";
    const condTxt = st.cond ? COND.find(([k]) => k === st.cond)?.[1] || "" : "";
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
      const part = sum(d, who, w1, w2, st.type === "line" || st.scope === "league");
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
    // Share of team / per 100 snaps turn a total into a rate, so it needs a minimum too: his own total / his snaps
    const per = st.type === "pie" ? "total" : who === "teams" && ["share", "snap"].includes(st.per) || st.per === "snap" && !D.pcols.includes("snaps") ? "game" : st.per; // a pie is a share of the whole: always season totals
    const wkPer = per === "share" || per === "snap"; // a rate made from a total
    const denOf = (s) => s[3].den || (s[3].count && per === "share" ? (S) => s[2](S) : s[3].count && per === "snap" ? (S) => S.snaps : null);
    const autoMin = (s) => denOf(s) ? Math.round(0.35 * Math.max(0, ...keys.map((k) => denOf(s)(agg[k].S, agg[k].g) || 0))) : 0;
    const minFor = (s) => (st.min !== "" && s === stat ? +st.min : autoMin(s));
    const qualify = (s) => {
      if (!denOf(s)) return keys;
      const m = minFor(s);
      return keys.filter((k) => picks.includes(k) || (denOf(s)(agg[k].S, agg[k].g) || 0) >= m);
    };
    const UNITS = { epa_db: "dropbacks", pass_epa_play: "pass plays", rush_epa_play: "rushes", epa_rush: "carries", ypc: "carries", ypr: "catches",
      catch_pct: "targets", epa_tgt: "targets", fg_pct: "field goal tries", third: "third downs", ppa_play: "plays", win_pct: "games" };
    const unitOf = (s) => (s[3].count && per === "share" ? s[1].toLowerCase() : s[3].count && per === "snap" ? "snaps" : 0) || UNITS[s[0]] || s[3].unit || (["ypa", "cmp_pct", "rating", "eff"].includes(s[0]) ? "pass attempts" : who === "teams" ? "plays" : "attempts");
    const val = (s, k) => value(s, agg[k].S, agg[k].g, per);
    // the Filter box (every chart type): keep who matches any "or" group, where every condition in the group holds
    const W = (st.type === "line" || st.type === "bar") && who === "teams" && st.scope === "league" ? { groups: [], read: [], bad: [] } : parseWhere(st.where, who, groups, D.teams, confs);
    const condOk = (c, k) => c.k === "stat" ? (() => { const v = val(c.s, k); return v != null && !Number.isNaN(v) && cmp(c.op, v, c.n); })()
      : c.k === "pos" ? (FINE[c.v] ? meta(k)?.[3] === c.v : POS_OF(meta(k)?.[1], agg[k].S) === c.v)
      : c.k === "exp" ? expOk(meta(k)?.[4], c.v) : c.k === "draft" ? draftOk(meta(k)?.[5], c.v)
      : c.k === "team" ? teamOf(k) === c.v : c.k === "group" ? tm(teamOf(k))[3] === c.v : true;
    if (W.groups.length) keys = keys.filter((k) => picks.includes(k) || W.groups.some((g) => g.every((c) => condOk(c, k))));
    const whereRead = W.groups.length ? W.read.join(" or ") + (W.groups.flat().some((c) => c.k === "stat" && c.s[3].count) && per === "game" ? " (per game)" : "") : "";
    const rank = (s, list) => list.filter((k) => val(s, k) != null).sort((a, b) => (s[3].low ? 1 : -1) * (val(s, a) - val(s, b)) * (st.order === "worst" ? -1 : 1));
    const top = st.top === "all" ? 9999 : +st.top || 10;
    // a Head coach stat on the chart: teams go by their coach ("Macdonald", hover: "Mike Macdonald (Seattle Seahawks)")
    const coachy = who === "teams" && [stat[0], st.type === "scatter" ? st.y : ""].some((s) => s.startsWith("co_"));
    const coach = (k) => (coachy ? agg[k]?.S.co_name : null);
    const name = (k) => who === "players" ? meta(k)?.[0] || k : coach(k) ? `${coach(k)} (${tm(k)[0]})` : tm(k)[0];
    const short = (k) => who === "players" ? (meta(k)?.[0] || k).replace(/^(\S)\S*\s/, "$1. ") : coach(k) ? coach(k).split(" ").slice(1).join(" ") : tm(k)[1] || tm(k)[0];
    const css = getComputedStyle(document.body), C = (v) => css.getPropertyValue(v).trim();
    let ink = C("--ink"), muted = C("--muted"), line = C("--line"); // let: a light picture swaps them for a moment (picture())
    const accent = C("--accent") || "#ff6b2c";
    // Style > Colors: [name, highlight, color of every ordinary bar/dot (null = team colors), lines/pie/radar colors in order]
    const SCHEMES = {
      "": ["Site (team colors)", accent, null, [accent, "#4cc9f0", "#f72585", "#b5e48c", "#ffd166", "#9b5de5", "#00f5d4", "#ff8fab", "#90be6d", "#f4a261", "#577590", "#e9c46a"]],
      mono: ["Gray + one highlight", accent, "#6e6e6e", [accent, "#d4d4d4", "#9c9c9c", "#747474", "#b8b8b8", "#5a5a5a"]],
      ocean: ["Ocean", "#00c2ff", "#2b6f99", ["#00c2ff", "#4dd8c0", "#3d7bff", "#a3e9ff", "#2a9d8f", "#7a7fe0"]],
      neon: ["Neon", "#39ff14", "#7b3cff", ["#39ff14", "#ff2bd6", "#00e5ff", "#fff200", "#ff7a00", "#b026ff"]],
      sunset: ["Sunset", "#ffb703", "#a33a3a", ["#ffb703", "#fb8500", "#e63946", "#f4a261", "#ff5d8f", "#ffd6a5"]],
    };
    const [, hi, plain, PAL] = SCHEMES[st.scheme] || SCHEMES[""];
    const color = (k) => plain || (who === "players" && st.team ? hi : tm(teamOf(k))[2]) || "#888"; // one team's players: its color would be every bar, and some are near black
    const px = (n) => Math.round(n * (st.big ? 1.3 : 1)); // Bigger text
    const gridOn = st.grid !== "0", numsOn = st.nums !== "0", tension = st.curve === "0" ? 0 : 0.25, radius = st.round ? 6 : 0;
    const weeksTxt = `${w1 > 1 || w2 < 99 ? `Weeks ${w1}–${D.bowls && w2 >= D.bowls ? "bowls" : Math.min(w2, maxWk)}` : league === "nfl" ? "Regular season" : "Full season incl. bowls"}`;
    const seasonTxt = multi ? `${st.from}–${st.to}` : st.to;
    const perTxt = (s) => (!s[3].count ? "" : per === "game" ? " per game" : per === "share" ? " (share of team)" : per === "snap" ? " per 100 snaps" : "");
    const whole = (st.type === "line" || st.type === "bar") && who === "teams" && st.scope === "league"; // the whole league: a line or a bar per season
    const perTeam = stat[3].count ? per === "game" ? " per team per game" : " (all teams added up)" : "";
    let partial = 0;
    // the whole league (or division) week by week in one season: {week: {S: summed columns, n: team games}}. The week still
    // being played (just Thursday night so far) is left out until most of its games are in.
    const leagueWeeks = (d) => {
      const out = {}, lastWk = Math.max(0, ...d.trows.map((r) => r[1]));
      for (const k of keys) for (const [w, x] of Object.entries(agg[k].seasons[d.season]?.wk || {})) {
        const o = out[w] || (out[w] = { S: {}, n: 0 });
        o.n++; for (const c in x) o.S[c] = (o.S[c] || 0) + x[c];
      }
      const full = Math.max(0, ...Object.values(out).map((o) => o.n));
      if (d.season === +idx[league]?.at(-1) && out[lastWk] && out[lastWk].n < full / 2) { delete out[lastWk]; partial++; }
      return out;
    };
    const lgTxt = league === "nfl" ? "NFL" : "College";
    let title = "", body = "", note = "", tableRows = [], tableHead = [];
    // the Table's columns: the sort stat, the stats in the filter, then yours (or a set that fits the position)
    function tableCols() {
      const conds = W.groups.flat(), pk = st.pos || conds.find((c) => c.k === "pos")?.v || "";
      const def = who === "teams" ? RADAR.teams : pk === "OL" ? ["off_snaps", "pen", "pen_yds", "pen_rate"]
        : RADAR.players[{ TE: "WR", EDGE: "DEF", IDL: "DEF", LB: "DEF" }[pk] || pk] || RADAR.players[""];
      const ks = [...new Set([stat[0], ...conds.filter((c) => c.k === "stat").map((c) => c.s[0]), ...(st.cols ? st.cols.split(",") : def)])];
      return ks.map((k) => all.find((s) => s[0] === k)).filter(Boolean).slice(0, 14);
    }
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const statSel = (id, v) => `<select id="${id}">${groups.map(([g, l]) => `<optgroup label="${esc(g)}">${l.map((s) => `<option value="${s[0]}"${s[0] === v ? " selected" : ""}>${esc(s[1])}</option>`).join("")}</optgroup>`).join("")}</select>`;
    const seg = (id, opts, v) => `<div class="seg vz-seg" id="${id}">${opts.map(([k, l]) => `<button data-v="${k}" class="${k === v ? "active" : ""}">${l}</button>`).join("")}</div>`;
    const posOpts = [["", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR / TE"], ...(D.xcols?.length ? [["TE", "TE only"]] : []), ["K", "Kicker"], ...(D.xcols?.length ? [["OL", "O-line"]] : []), ["DEF", "Defense"],
      ...(D.xcols?.length ? Object.entries(FINE).filter(([k]) => k !== "TE").map(([k, l]) => [k, `Defense: ${l}`]) : [])];
    const wkOpts = [["", "–"], ...Array.from({ length: Math.max(maxWk, D.league === "nfl" ? 18 : 1) }, (_, i) => [i + 1, D.bowls && i + 1 >= D.bowls ? "Bowls" : i + 1])];

    // the chart
    let cfg;
    const base = { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, devicePixelRatio: Math.max(3, window.devicePixelRatio || 1), // drawn at 3x: sharp on any screen and in the downloaded picture
      plugins: { legend: { labels: { color: ink, font: { family: "JetBrains Mono", size: px(11) } } }, tooltip: { titleFont: { family: "JetBrains Mono" }, bodyFont: { family: "JetBrains Mono" } } },
      scales: { x: { ticks: { color: muted, font: { family: "JetBrains Mono", size: px(10) } }, grid: { color: line, display: gridOn } }, y: { ticks: { color: muted, font: { family: "JetBrains Mono", size: px(10) } }, grid: { color: line, display: gridOn } } } };
    const hl = (k) => picks.includes(k);
    const showLogo = st.logo !== "0", showNames = st.names !== "0" || !showLogo; // something has to say who's who
    const redraw = () => chart?.draw();
    const drawLogo = (ctx, k, x, y, sz) => { const im = logoImg(teamOf(k), redraw); if (im) ctx.drawImage(im, x - sz / 2, y - sz / 2, sz, sz); return !!im; };
    if (whole && st.type === "bar") { // one bar per season, the same weeks each year
      const bars = Ds.map((d) => {
        const L = leagueWeeks(d), S = {}; let n = 0;
        for (const o of Object.values(L)) { n += o.n; for (const c in o.S) S[c] = (S[c] || 0) + o.S[c]; }
        const v = n ? value(stat, S, n, per) : null;
        return { s: d.season, v: v == null || Number.isNaN(v) ? null : v, wks: Object.keys(L).map(Number) };
      });
      const last = bars.length - 1, now = bars[last];
      // the streak: how many seasons in a row the latest one keeps going the same way (up or down)
      const dir = last > 0 && now.v != null && bars[last - 1].v != null ? Math.sign(now.v - bars[last - 1].v) : 0;
      let streak = 0;
      while (dir && streak < last && bars[last - streak].v != null && bars[last - streak - 1].v != null && Math.sign(bars[last - streak].v - bars[last - streak - 1].v) === dir) streak++;
      const fade = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c);
      const f2 = { 3: { ...stat[3], d: stat[3].count && per === "game" ? 2 : stat[3].d } }; // 7.52, not 7.5
      title = `${stat[1]}${perTeam}, ${st.group || `${lgTxt}-wide`}, by season`;
      cfg = { type: "bar", data: { labels: bars.map((b) => String(b.s)), datasets: [{ data: bars.map((b) => b.v),
        backgroundColor: bars.map((b, i) => (i === last ? hi : i >= last - streak ? fade(hi, "8c") : plain || fade(muted, "59"))), borderRadius: radius, borderSkipped: "bottom" }] },
        options: { ...base, layout: { padding: { top: 22, right: 14 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => fmt(f2, c.raw, per) } } },
          scales: { ...base.scales, x: { ...base.scales.x, grid: { display: false } }, y: { ...base.scales.y, beginAtZero: true } } },
        plugins: [{ id: "vzSeasons", afterDatasetsDraw(c) { // the number on top: every bar when there's room, else the streak, else just the latest (phones)
          const { ctx } = c, pts = c.getDatasetMeta(0).data, gap = pts.length > 1 ? pts[1].x - pts[0].x : 99, roomy = gap >= 36;
          ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillStyle = ink;
          pts.forEach((b, i) => { const v = bars[i].v; if (!numsOn || v == null || !(roomy || i === last || (gap >= 30 && i >= last - streak))) return;
            ctx.font = `${i === last ? "bold " : ""}${px(10)}px JetBrains Mono`; ctx.fillText(fmt(f2, v, per), b.x, v < 0 ? b.base - 2 : b.y - 3); });
          ctx.restore(); } }] };
      body = { h: 380 };
      const order = bars.filter((b) => b.v != null).sort((a, b) => b.v - a.v), place = order.indexOf(now) + 1;
      const ord = (x) => x + ({ 1: "st", 2: "nd", 3: "rd" }[x % 100 > 10 && x % 100 < 14 ? 0 : x % 10] || "th");
      const played = Math.max(0, ...now.wks), wkTip = multi && now.wks.length && w2 > played && bars.some((b) => Math.max(0, ...b.wks) > played);
      note = `Each bar is one season: every ${st.group ? `${st.group} ` : ""}team's games in the weeks you picked added up${stat[3].count && per === "game" ? ", divided by the games played" : ""}.`
        + (multi && now.v != null ? ` ${now.s}: ${fmt(f2, now.v, per)}, ${place === 1 ? "the highest" : `${ord(place)} highest`} of ${order.length} seasons.` : "")
        + (streak >= 2 ? ` ${dir > 0 ? "Up" : "Down"} ${streak} seasons in a row (in orange).` : "")
        + (wkTip ? ` ${now.s} has played ${played} weeks: set Weeks to ${now.wks[0] === 0 ? 0 : 1} to ${played} so every season covers the same weeks.` : "")
        + (partial ? " A week with most of its games still to play is left out until it's done." : "")
        + (multi ? "" : " Pick more seasons to compare years.");
      body.table = [...bars].reverse().map((b) => [order.indexOf(b) + 1 || "–", String(b.s), fmt(f2, b.v, per)]);
    } else if (st.type === "bar" && stat[3].split) { // a breakdown: one 100% bar per player, split into its parts ("abs": counts, not shares)
      const abs = !!stat[3].abs, list = rank(stat, keys).filter((k) => val(stat, k) > 0);
      const shown = [...new Set([...list.slice(0, top), ...picks.filter((k) => list.includes(k))])];
      // counts: only the parts somebody on the chart has (21 penalty types, most of them empty for one team)
      const parts = abs ? stat[3].split.filter(([, f]) => shown.some((k) => f(agg[k].S) > 0)) : stat[3].split;
      const cnt = (k, i) => parts[i][1](agg[k].S), pctOf = (k, i) => (100 * cnt(k, i)) / (stat[2](agg[k].S) || 1); // shares of his season total, whatever Totals says
      const colorOf = (i) => (parts.length > PAL.length ? `hsl(${Math.round((i * 360) / parts.length + 18) % 360} 70% 58%)` : PAL[i % PAL.length]);
      title = abs ? `${stat[1]}${who === "players" && st.team ? ` · ${tm(st.team)[0]}` : ""}` : `${stat[1]} (share of each one's ${unitOf(stat)})`;
      cfg = { type: "bar", data: { labels: shown.map(short), datasets: parts.map(([l], i) => ({ label: l, data: shown.map((k) => (abs ? cnt(k, i) : pctOf(k, i))),
        backgroundColor: colorOf(i), borderColor: C("--card"), borderWidth: 1 })) },
        options: { ...base, indexAxis: "y", plugins: { ...base.plugins, legend: { position: "top", labels: base.plugins.legend.labels },
          tooltip: { ...base.plugins.tooltip, callbacks: { title: (c) => name(shown[c[0].dataIndex]), label: (c) => abs ? `${c.dataset.label}: ${c.raw}` : `${c.dataset.label}: ${Math.round(c.raw)}% (${cnt(shown[c.dataIndex], c.datasetIndex)} ${unitOf(stat).replace("zoned ", "")})` } } },
          scales: { x: { ...base.scales.x, stacked: true, min: 0, ...(abs ? { ticks: { ...base.scales.x.ticks, precision: 0 } } : { max: 100, ticks: { ...base.scales.x.ticks, callback: (v) => `${v}%` } }) },
            y: { ...base.scales.y, stacked: true, ticks: { ...base.scales.y.ticks, autoSkip: false, display: showNames, padding: showLogo ? 28 : 3 }, afterFit: (sc) => { if (showLogo) sc.width = Math.max(sc.width, 30); } } } },
        plugins: [{ id: "vzStack", afterDatasetsDraw(c) { // logo by each name, the share inside each piece wide enough to hold it
          const { ctx, chartArea: a } = c;
          ctx.save(); ctx.font = `bold ${px(9)}px JetBrains Mono`; ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = "#000";
          c.data.datasets.forEach((ds, i) => c.getDatasetMeta(i).data.forEach((b, j) => {
            if (i === 0 && showLogo) drawLogo(ctx, shown[j], a.left - Math.min(20, b.height + 4) / 2 - 4, b.y, Math.min(20, b.height + 4));
            if (numsOn && !c.getDatasetMeta(i).hidden && ds.data[j] && Math.abs(b.x - b.base) >= (abs ? 14 : 26)) ctx.fillText(abs ? String(ds.data[j]) : `${Math.round(ds.data[j])}%`, (b.x + b.base) / 2, b.y);
          }));
          ctx.restore(); } }] };
      body = { h: Math.max(260, shown.length * 26 + 90 + (abs ? Math.ceil(parts.length / 4) * 18 : 0)) };
      note = abs ? `The ${shown.length} with the most ${unitOf(stat)}${picks.length ? " plus your highlights" : ""}${st.team ? "" : ". Pick a team (or type “was penalties by type”) to see one team's players"}. Each piece is how many times he was flagged for that (accepted penalties only, from the play-by-play). Click a color in the key to hide it.`
        : `The ${shown.length} with the most ${unitOf(stat)}${picks.length ? " plus your highlights" : ""}. Each bar adds up to 100% of his own ${unitOf(stat)}. Short = under 10 air yards (how far past the line of scrimmage the ball was thrown), intermediate = 10-19, deep = 20+; throwaways and spikes have no zone. Click a color in the key to hide it.`;
      body.table = shown.map((k, i) => [i + 1, k, abs ? parts.map(([l], j) => [l, cnt(k, j)]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(" · ") : parts.map(([l], j) => `${l} ${Math.round(pctOf(k, j))}%`).join(" · ")]);
    } else if (st.type === "pie" && stat[3].split) { // one player's breakdown: the highlighted one, else the busiest
      const parts = stat[3].split, list = rank(stat, keys).filter((k) => val(stat, k) > 0);
      const k = picks.find((x) => list.includes(x)) || list[0];
      const vals = k ? parts.map(([, f]) => f(agg[k].S)) : [], total = vals.reduce((a, x) => a + x, 0);
      title = k ? `${name(k)}: ${stat[1].replace(/^Where he/, "where he")}` : stat[1];
      cfg = { type: "doughnut", data: { labels: parts.map(([l]) => l), datasets: [{ data: vals, backgroundColor: parts.map((p, i) => PAL[i % PAL.length]), borderColor: C("--card"), borderWidth: 2 }] },
        plugins: [{ id: "vzSplitPie", afterDatasetsDraw(c) { // the share on each slice big enough for it
          if (!numsOn) return;
          const { ctx } = c; ctx.save(); ctx.font = `bold ${px(11)}px JetBrains Mono`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#000";
          c.getDatasetMeta(0).data.forEach((arc, i) => { if (arc.circumference > 0.25 && total) { const p = arc.tooltipPosition(); ctx.fillText(`${Math.round((100 * vals[i]) / total)}%`, p.x, p.y); } });
          ctx.restore(); } }],
        options: { ...base, scales: {}, plugins: { ...base.plugins, legend: { position: "bottom", labels: base.plugins.legend.labels },
          tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.label}: ${Math.round((100 * c.raw) / (total || 1))}% (${c.raw} ${unitOf(stat).replace("zoned ", "")})` } } } } };
      body = { h: 420 };
      note = `${total} ${unitOf(stat)}. Pick someone in Highlight to see his${k && !picks.includes(k) ? ` (this is ${name(k)}, the one with the most)` : ""}.${/_by_/.test(stat[0]) ? " Short = under 10 air yards, intermediate = 10-19, deep = 20+; throwaways and spikes have no zone." : ""}`;
    } else if (st.type === "bar") {
      const list = rank(stat, qualify(stat));
      const shown = [...new Set([...list.slice(0, top), ...picks.filter((k) => list.includes(k))])];
      title = `${stat[1]}${perTxt(stat)}`;
      cfg = { type: "bar", data: { labels: shown.map(short), datasets: [{ data: shown.map((k) => val(stat, k)), backgroundColor: shown.map((k) => hl(k) ? hi : color(k)), borderRadius: radius,
        borderColor: shown.map((k) => (hl(k) ? ink : "transparent")), borderWidth: 2 }] },
        options: { ...base, indexAxis: "y", layout: { padding: { right: 56 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { title: (c) => name(shown[c[0].dataIndex]), label: (c) => fmt(stat, c.raw, per) } } },
          scales: { ...base.scales, y: { ...base.scales.y, ticks: { ...base.scales.y.ticks, autoSkip: false, display: showNames, padding: showLogo ? 28 : 3 },
            afterFit: (sc) => { if (showLogo) sc.width = Math.max(sc.width, 30); } } } },
        plugins: [{ id: "vzBar", afterDatasetsDraw(c) { // logo by each name, the number at the end of each bar
          const { ctx, chartArea: a } = c;
          ctx.save(); ctx.font = `bold ${px(10)}px JetBrains Mono`; ctx.textBaseline = "middle";
          c.getDatasetMeta(0).data.forEach((b, i) => {
            const v = c.data.datasets[0].data[i], sz = Math.min(20, b.height + 4);
            if (showLogo) drawLogo(ctx, shown[i], a.left - sz / 2 - 4, b.y, sz);
            if (!numsOn) return;
            ctx.fillStyle = ink; ctx.textAlign = v < 0 ? "right" : "left";
            ctx.fillText(fmt(stat, v, per), b.x + (v < 0 ? -4 : 4), b.y);
          });
          ctx.restore(); } }] };
      body = { h: Math.max(260, shown.length * 26 + 60) };
      note = `${list.length} ${who} ranked${stat[3].den ? ` (at least ${minFor(stat)} ${unitOf(stat)}${st.min === "" ? ", 35% of the leader's; change it with Minimum" : ""})` : ""}.`;
      body.table = shown.map((k, i) => [i + 1, k, fmt(stat, val(stat, k), per)]);
    } else if (whole) { // line: one line per season, week by week
      const wks = [...new Set(Ds.flatMap((d) => d.trows.map((r) => r[1])))].filter((w) => w >= w1 && w <= w2).sort((a, b) => a - b);
      const bowls = Ds.find((d) => d.bowls)?.bowls;
      title = `${stat[1]}${perTeam}, ${st.group || `${lgTxt}-wide`}, ${st.cum ? "adding up week by week" : "by week"}`;
      const sers = Ds.map((d) => {
        const L = leagueWeeks(d), run = {}; let g = 0;
        return [String(d.season), wks.map((w) => {
          const o = L[w];
          if (!o) return null; // no games that week (not played yet): no point
          if (st.cum) { g += o.n; for (const c in o.S) run[c] = (run[c] || 0) + o.S[c]; }
          const v = value(stat, st.cum ? run : o.S, st.cum ? g : o.n, per);
          return v == null || Number.isNaN(v) ? null : v;
        })];
      });
      const last = sers.length - 1;
      // many seasons: old to new runs from dim blue to the accent, so the color itself says the era
      const mix = (a, b, t) => "#" + [1, 3, 5].map((j) => Math.round(parseInt(a.slice(j, j + 2), 16) * (1 - t) + parseInt(b.slice(j, j + 2), 16) * t).toString(16).padStart(2, "0")).join("");
      const shade = (i) => sers.length > 6 && /^#[0-9a-f]{6}$/i.test(hi) ? mix("#33415c", hi, i / last) : PAL[(last - i) % PAL.length];
      cfg = { type: "line", data: { labels: wks.map((w) => (bowls && w >= bowls ? "Bowls" : `Wk ${w}`)), datasets: sers.map(([s, data], i) => ({ label: s, data,
        borderColor: shade(i), backgroundColor: shade(i), borderWidth: i === last ? 3 : 2, pointRadius: sers.length > 6 ? 1.5 : 3, spanGaps: true, tension })) },
        options: { ...base, plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${fmt(stat, c.raw, per)}` } } } } };
      body = { h: 380 };
      note = `Each line is one season: every ${st.group ? `${st.group} ` : ""}team's games that week added up${stat[3].count && per === "game" ? ", then divided by the games played (bye weeks don't drag it down)" : ""}.${partial ? " A week with most of its games still to play is left out until it's done." : ""}${multi ? "" : " Pick more seasons to compare years."}`;
    } else if (st.type === "line") {
      const list = rank(stat, qualify(stat)), sers = (picks.length ? picks.filter((k) => agg[k]) : list.slice(0, Math.min(top, 8)));
      title = `${stat[1]}${wkPer ? perTxt(stat) : ""}${multi ? " by season" : st.cum ? ", adding up week by week" : " by week"}`;
      let labels, data;
      if (multi) {
        labels = Ds.map((d) => String(d.season));
        data = (k) => Ds.map((d) => { const o = agg[k].seasons[d.season]; return o ? value(stat, o.S, o.g, per) : null; });
      } else {
        const wks = [...new Set(D.trows.map((r) => r[1]))].filter((w) => w >= w1 && w <= w2).sort((a, b) => a - b);
        labels = wks.map((w) => (D.bowls && w >= D.bowls ? "Bowls" : `Wk ${w}`));
        data = (k) => {
          const run = {}; let g = 0;
          return wks.map((w) => {
            const S = agg[k].wk[w];
            if (!st.cum) return S ? wkPer ? value(stat, S, 1, per) : stat[2](S, 1) : null;
            if (S) { g++; for (const c in S) run[c] = (run[c] || 0) + S[c]; }
            return g ? wkPer ? value(stat, run, g, per) : stat[2](run, g) : null;
          });
        };
      }
      cfg = { type: "line", data: { labels, datasets: sers.map((k, i) => ({ label: short(k), data: data(k), borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length],
        borderWidth: hl(k) || i === 0 ? 3 : 2, pointRadius: 3, spanGaps: true, tension })) },
        options: { ...base, layout: { padding: { right: showLogo ? 26 : 0 } }, plugins: { ...base.plugins, legend: { ...base.plugins.legend, display: showNames }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${wkPer ? fmt(stat, c.raw, per) : fmt({ 3: { ...stat[3], count: 0 } }, c.raw)}` } } } },
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
      title = `${who === "players" && st.team ? tm(st.team)[0] + ": " : ""}share of ${lc(s[1])}`.replace(/^s/, "S");
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
      title = `${stat[1]}${perTxt(stat)} vs ${lc(ystat[1])}${perTxt(ystat)}`;
      const label = new Set([...rank(stat, both).slice(0, 4), ...rank(ystat, both).slice(0, 4), ...rank(stat, both).slice(-2), ...picks]);
      const pts = both.map((k) => ({ x: val(stat, k), y: val(ystat, k), k }));
      const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1), mx = avg(pts.map((p) => p.x)), my = avg(pts.map((p) => p.y));
      const named = !showNames ? new Set() : pts.length <= 40 ? new Set(pts.map((p) => p.k)) : label; // every name when there's room
      cfg = { type: "scatter", data: { datasets: [{ data: pts, pointRadius: pts.map((p) => (showLogo ? 11 : hl(p.k) ? 7 : 5)), pointHoverRadius: showLogo ? 13 : 7,
        pointBackgroundColor: pts.map((p) => (showLogo ? "transparent" : hl(p.k) ? hi : color(p.k))), pointBorderColor: pts.map((p) => (showLogo ? (hl(p.k) ? hi : "transparent") : ink)),
        pointBorderWidth: pts.map((p) => (hl(p.k) ? 2 : showLogo ? 0 : 0.5)) }] },
        options: { ...base, layout: { padding: { right: 36, top: 8 } }, plugins: { ...base.plugins, legend: { display: false }, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${name(c.raw.k)}: ${fmt(stat, c.raw.x, per)}, ${fmt(ystat, c.raw.y, per)}` } } },
          scales: { x: { ...base.scales.x, reverse: !!stat[3].low, title: { display: true, text: stat[1] + perTxt(stat) + (stat[3].low ? " (better →)" : ""), color: muted } },
            y: { ...base.scales.y, reverse: !!ystat[3].low, title: { display: true, text: ystat[1] + perTxt(ystat) + (ystat[3].low ? " (better ↑)" : ""), color: muted } } } },
        plugins: [{ id: "vzLabels", afterDatasetsDraw(c) {
          const { ctx, chartArea: a, scales: { x, y } } = c;
          ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = muted; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x.getPixelForValue(mx), a.top); ctx.lineTo(x.getPixelForValue(mx), a.bottom); ctx.moveTo(a.left, y.getPixelForValue(my)); ctx.lineTo(a.right, y.getPixelForValue(my)); ctx.stroke();
          ctx.setLineDash([]);
          // your quadrant names (Style and picture), in the corners: on screen, so "top right" is top right even on a flipped axis
          const Q = (st.quad || "").split("|");
          if (Q.some(Boolean)) {
            ctx.font = `bold ${px(12)}px JetBrains Mono`; ctx.fillStyle = hi; ctx.globalAlpha = 0.8;
            [[0, a.left + 8, a.top + 6, "left", "top"], [1, a.right - 8, a.top + 6, "right", "top"], [2, a.left + 8, a.bottom - 6, "left", "bottom"], [3, a.right - 8, a.bottom - 6, "right", "bottom"]]
              .forEach(([i, x0, y0, al, bl]) => { if (Q[i]) { ctx.textAlign = al; ctx.textBaseline = bl; ctx.fillText(Q[i].toUpperCase(), x0, y0); } });
            ctx.globalAlpha = 1; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
          }
          ctx.font = `${px(10)}px JetBrains Mono`; ctx.fillStyle = ink;
          c.getDatasetMeta(0).data.forEach((p, i) => {
            const sz = hl(pts[i].k) ? 26 : 20, logo = showLogo && drawLogo(ctx, pts[i].k, p.x, p.y, sz);
            if (showLogo && !logo) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fillStyle = color(pts[i].k); ctx.fill(); ctx.fillStyle = ink; } // no logo (an FCS team): a dot
            if (named.has(pts[i].k)) ctx.fillText(short(pts[i].k), p.x + (showLogo ? 13 : 7), p.y + 3);
          });
          ctx.restore(); } }] };
      body = { h: 440 };
      note = `${both.length < pool.length ? `Top ${both.length} of ${pool.length} ${who} by ${lc(stat[1])}` : `${both.length} ${who}`}${stat[3].den ? ` (at least ${minFor(stat)} ${unitOf(stat)} for ${stat[1].toLowerCase()})` : ""}. Dashed lines are the averages. ${stat[3].low || ystat[3].low ? "Axes are flipped where lower is better, so up and right is always good." : "Up and right is good."}`;
    } else if (st.type === "table") { // a data table: pick the columns, sort by any of them (click a header), filter with words
      const list = rank(stat, qualify(stat)), shown = [...new Set([...list.slice(0, top), ...picks.filter((k) => list.includes(k))])];
      const cs = tableCols();
      title = `${who === "players" ? "Players" : "Teams"}${whereRead ? ` where ${whereRead}` : ""}, by ${lc(stat[1])}${perTxt(stat)}`;
      const lg = (k) => { const u = LOGOS?.[teamOf(k)]; return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ""; };
      const link = (k) => who === "players" && /^\d+$/.test(k) ? `<a href="#/player/${esc(k)}?league=${league}">${esc(name(k))}</a>`
        : who === "teams" ? `<a href="#/team/${esc(k.split(":")[1])}?league=${league}">${esc(name(k))}</a>` : esc(name(k));
      const pos = (k) => meta(k)?.[3] || meta(k)?.[1] || "";
      tableRows = shown.map((k, i) => [i + 1, name(k), ...(who === "players" ? [tm(teamOf(k))[1], pos(k)] : []), ...cs.map((s) => fmt(s, val(s, k), per))]);
      tableHead = ["#", who === "players" ? "Player" : "Team", ...(who === "players" ? ["Team", "Pos"] : []), ...cs.map((s) => s[1] + perTxt(s))];
      body = { h: 0, html: `<div class="vz-twrap"><table class="box vz-table"><thead><tr><th class="num">#</th><th>${who === "players" ? "Player" : "Team"}</th>${who === "players" ? "<th>Team</th><th>Pos</th>" : ""}
        ${cs.map((s) => `<th class="num${s === stat ? " on" : ""}" data-sort="${s[0]}" title="${esc(s[1] + perTxt(s))}: click to sort">${esc(s[1].replace(/ \(.+\)$/, ""))}${s === stat ? (st.order === "worst" ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
        <tbody>${shown.map((k, i) => `<tr${hl(k) ? ' class="hl"' : ""}><td class="num muted">${i + 1}</td><td class="vz-tname">${lg(k)}${link(k)}</td>${who === "players" ? `<td>${esc(tm(teamOf(k))[1])}</td><td class="muted">${esc(pos(k))}</td>` : ""}
          ${cs.map((s) => `<td class="num${s === stat ? " on" : ""}">${esc(fmt(s, val(s, k), per))}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cs.length + 4}" class="muted">Nobody matches.</td></tr>`}</tbody></table></div>` };
      note = `${shown.length < list.length ? `Top ${shown.length} of ${list.length}` : `${list.length}`} ${who}${whereRead ? " that match the filter" : ""}${stat[3].den ? ` (at least ${minFor(stat)} ${unitOf(stat)} for ${stat[1].toLowerCase()})` : ""}. Click a column to sort by it, again to flip it.`;
    } else { // radar: percentiles among everyone shown
      const want = who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""];
      const custom = st.radar ? st.radar.split(",") : want;
      const axes = custom.map((k) => all.find((s) => s[0] === k)).filter(Boolean).slice(0, 8);
      const lead = rank(axes[0], qualify(axes[0]));
      const sers = (picks.length ? picks.filter((k) => agg[k]) : lead.slice(0, Math.min(top, 4))).slice(0, 5);
      // compare against real workloads only (a backup with 5 throws and 0 picks isn't the bar for interceptions)
      const VOL = { QB: (S) => S.att, RB: (S) => S.carries, WR: (S) => S.rec, DEF: (S) => S.tackles, K: (S) => S.fg_att, OL: (S) => S.snaps };
      const vol = who === "players" ? VOL[st.pos] || ((S) => S.att + S.carries + S.rec + S.tackles) : null;
      const most = vol ? Math.max(...keys.map((x) => vol(agg[x].S) || 0)) : 0;
      const regulars = vol ? keys.filter((x) => picks.includes(x) || (vol(agg[x].S) || 0) >= (st.min !== "" ? +st.min : most * 0.35)) : keys;
      const pctile = (s, k) => { const q = qualify(s).filter((x) => regulars.includes(x)), v = val(s, k); if (v == null) return null; const vals = q.map((x) => val(s, x)).filter((x) => x != null);
        const below = vals.filter((x) => (s[3].low ? x > v : x < v)).length; return Math.round((100 * below) / Math.max(1, vals.length - 1)); };
      title = `${who === "teams" ? "Team" : "Player"} profiles (percentile among ${who}${st.pos ? ` at ${st.pos}` : ""})`;
      cfg = { type: "radar", data: { labels: axes.map((s) => s[1].replace(/ \(.+\)/, "")), datasets: sers.map((k, i) => ({ label: short(k), data: axes.map((s) => pctile(s, k)),
        borderColor: PAL[i % PAL.length], backgroundColor: PAL[i % PAL.length] + "33", borderWidth: 2, pointRadius: 2 })) },
        options: { ...base, scales: { r: { min: 0, max: 100, ticks: { display: false, stepSize: 25 }, grid: { color: line }, angleLines: { color: line }, pointLabels: { color: ink, font: { family: "JetBrains Mono", size: px(10) } } } },
          plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.dataset.label}: ${axes[c.dataIndex][1]} ${fmt(axes[c.dataIndex], val(axes[c.dataIndex], sers[c.datasetIndex]), st.per)} (better than ${c.raw}%)` } } } } };
      body = { h: 440 };
      note = "100 = the best among everyone listed, 0 = the worst. Lower-is-better stats are flipped.";
    }
    if (per === "share" && stat[3].count) note += ` Share of team = his part of his team's total in the games he played.`;
    if (stat[3].about) note += ` ${stat[3].about}`;
    if (condTxt) note += " Conditions come from nflverse's game list (kickoff temperature and wind; domes have none, so the weather choices leave them out).";
    if (st.opp) note += " Top half = the top half of our power ratings that season; cupcakes = the bottom half and anyone unranked.";
    const whereBox = `<label class="vz-wide">Filter <small class="muted">e.g. run stops > 20 and sacks >= 3, or QB, EPA per dropback over .1</small><input id="vz-where" type="search" maxlength="200" placeholder="Type conditions… (and / or, > < >= <=)" value="${esc(st.where)}" autocomplete="off" spellcheck="false">
        ${W.bad.length ? `<small class="vz-wbad">Couldn't read ${W.bad.map((b) => `“${esc(b)}”`).join(", ")}. Try a stat, a comparison and a number (“tackles >= 30”), a position, a team or “rookies”.</small>` : whereRead ? `<small class="muted">Showing ${who} where ${esc(whereRead)}.</small>` : ""}</label>`;
    const autoTitle = title;
    if (st.ttl) title = st.ttl; // Style > Your title
    const autoSub = `${lgTxt} · ${seasonTxt} · ${weeksTxt}${st.group ? ` · ${st.group}` : ""}${st.team ? ` · ${tm(st.team)[0]}` : ""}${st.role ? ` · ${st.role}s` : st.pos ? ` · ${st.pos === "DEF" ? "Defense" : FINE[st.pos] || st.pos}` : ""}${who === "players" && st.exp ? ` · ${EXP.find(([k]) => k === st.exp)?.[1]}` : ""}${who === "players" && st.draft ? ` · ${st.draft === "U" ? "Undrafted" : `Drafted: ${DRAFT.find(([k]) => k === st.draft)?.[1]}`}` : ""}${whereRead && st.type !== "table" ? ` · where ${whereRead}` : ""}${st.opp ? ` · ${OPP.find(([k]) => k === st.opp)[1].toLowerCase()}` : ""}${+st.last ? ` · last ${st.last} games` : ""}${condTxt ? ` · ${lc(condTxt)}` : ""}`;
    const sub = st.subt || autoSub;
    const src = league === "nfl" ? "nflverse play-by-play (EPA)" : "CollegeFootballData.com (box scores; PPA = college EPA, garbage time left out)";
    const seasonOnly = [stat, ystat].some((s) => s[3].season) && (w1 > 1 || w2 < 99);

    // ---- the page: Simple (question box, chart, takeaway, related) or Advanced (every control in 4 steps beside the chart).
    // The same controls either way: Simple keeps them under "Edit".
    const adv = st.mode === "adv";
    const shownPos = st.role ? `${st.role}s` : st.pos ? (st.pos === "DEF" ? "Defense" : FINE[st.pos] || (st.pos === "WR" ? "WRs and TEs" : `${st.pos}s`)) : "";
    const readout = [`${stat[1]}${st.type === "scatter" ? ` vs ${lc(ystat[1])}` : st.type === "pie" ? "" : perTxt(stat)}`,
      who === "players" ? [st.team ? tm(st.team)[0] : "", shownPos || "players"].filter(Boolean).join(" ") : st.group ? `${st.group} teams` : "Teams",
      seasonTxt, ...(st.opp ? [OPP.find(([k]) => k === st.opp)?.[1]] : []), ...(+st.last ? [`last ${st.last} games`] : []), ...(condTxt ? [condTxt] : [])];
    // filters that are on, each with an ✕ to take it off
    const chips = [
      ...(st.team && who === "players" ? [[`Team: ${tm(st.team)[0]}`, { team: "" }]] : []),
      ...(st.group ? [[st.group, { group: "" }]] : []),
      ...(st.role ? [[`Depth chart: ${st.role}`, { role: "" }]] : st.pos && who === "players" ? [[`Position: ${shownPos}`, { pos: "" }]] : []),
      ...(st.exp && who === "players" ? [[EXP.find(([k]) => k === st.exp)?.[1], { exp: "" }]] : []),
      ...(st.draft && who === "players" ? [[st.draft === "U" ? "Undrafted" : `Drafted: ${DRAFT.find(([k]) => k === st.draft)?.[1]}`, { draft: "" }]] : []),
      ...(st.opp ? [[OPP.find(([k]) => k === st.opp)?.[1], { opp: "" }]] : []),
      ...(+st.last ? [[`Last ${st.last} games`, { last: "" }]] : []),
      ...(condTxt ? [[condTxt, { cond: "" }]] : []),
      ...(st.wk1 || st.wk2 ? [[weeksTxt, { wk1: "", wk2: "" }]] : []),
      ...(wkPer ? [[per === "share" ? "Share of team" : "Per 100 snaps", { per: "game" }]] : []),
      ...(whereRead ? [[`Where ${whereRead}`, { where: "" }]] : []),
      ...(st.noexit ? [["No halftime exits", { noexit: "" }]] : []),
      ...picks.filter((k) => agg[k]).map((k) => [`★ ${short(k)}`, { pick: picks.filter((x) => x !== k).join(",") }]),
    ];
    // the takeaway: one plain sentence from the chart's own numbers
    const takeaway = (() => {
      const s = all.find((x) => x[0] === st.stat) || stat;
      if (whole || s[3].split || st.type === "radar" || st.type === "line") return "";
      if (st.type === "scatter") {
        const ks = rank(stat, qualify(stat)).slice(0, top).filter((k) => val(ystat, k) != null && !Number.isNaN(val(ystat, k)));
        if (ks.length < 4) return "";
        const avg = (s2) => ks.reduce((a, k) => a + val(s2, k), 0) / ks.length, mx = avg(stat), my = avg(ystat);
        const good = (s2, k, m) => (s2[3].low ? val(s2, k) < m : val(s2, k) > m);
        const both = ks.filter((k) => good(stat, k, mx) && good(ystat, k, my));
        return both.length ? `Better than average at both: ${both.slice(0, 4).map(name).join(", ")}${both.length > 4 ? ` and ${both.length - 4} more` : ""}.` : "Nobody here is better than average at both.";
      }
      const ks = rank(s, st.type === "pie" ? keys.filter((k) => val(s, k) > 0) : qualify(s));
      if (!ks.length) return "";
      const v = (k) => fmt(s, val(s, k), per);
      if (st.type === "pie") { const tot = ks.reduce((a, k) => a + val(s, k), 0); return `${name(ks[0])} has ${Math.round((100 * val(s, ks[0])) / tot)}% of the ${who === "players" && st.team ? "team's" : "total"} ${lc(s[1])}${ks[1] ? `; ${name(ks[1])} is next with ${Math.round((100 * val(s, ks[1])) / tot)}%` : ""}.`; }
      return `${name(ks[0])} ${st.order === "worst" ? (s[3].low ? "has the most" : "is at the bottom") : "leads"} with ${v(ks[0])}${ks[1] ? `; ${name(ks[1])} is next at ${v(ks[1])}` : ""}${ks.length > 2 && st.order !== "worst" ? `. ${ks.length} ${who} qualify` : ""}.`;
    })();
    // Related: the next questions, built by rule from this chart (same stat, same team, a closer look); they only offer stats this data has
    const related = (() => {
      const out = [], has = (k) => all.some((x) => x[0] === k), add = (l, p) => { if (out.length < 7 && !out.some((o) => o[0] === l)) out.push([l, p]); };
      const lead = rank(stat, qualify(stat))[0];
      if (whole) { add("Each team instead", { scope: "" }); return out; }
      if (st.type !== "line" && st.type !== "radar") add("↗ Week by week", { type: "line", top: "5", cum: "" });
      if (st.type === "line") add("▤ As a bar chart", { type: "bar" });
      if (who === "players" && !st.team && lead && teamOf(lead)) add(`⌂ ${tm(teamOf(lead))[0]}: who gets the ${lc(stat[1]).replace(/ \(.+\)$/, "")}`, { team: teamOf(lead), type: "bar", top: "10", pos: "", role: "", ...(stat[3].count ? { per: "share" } : {}) });
      if (who === "players" && st.team) add("⇄ The whole league", { team: "" });
      if (who === "players" && stat[3].count && per !== "share") add("% Share of team", { per: "share" });
      if (st.opp !== "good") add("▲ Only vs top-half teams", { opp: "good" });
      if (st.opp !== "soft") add("▼ Only vs cupcakes", { opp: "soft" });
      if (st.last !== "3") add("⏱ Last 3 games", { last: "3" });
      const g = groups.find(([, l]) => l.includes(stat)), sib = g ? g[1].filter((x) => x !== stat && !x[3].split) : [];
      // the natural partner: a count and the rate made from it (targets <-> catch rate, carries <-> yards per carry), else the group's other kind
      const base = (x) => lc(x[1]).replace(/ \(.+\)$/, "");
      const pair = (stat[3].den ? all.find((x) => x[3].count && !x[3].split && base(x) === unitOf(stat)) : all.find((x) => x !== stat && x[3].den && !x[3].split && unitOf(x) === base(stat)))
        || sib.find((x) => !!x[3].den !== !!stat[3].den) || sib[0];
      if (pair && st.type !== "scatter") add(`⁘ ${stat[1].replace(/ \(.+\)$/, "")} vs ${lc(pair[1]).replace(/ \(.+\)$/, "")}`, { type: "scatter", y: pair[0], top: "all", quad: "" });
      if (who === "players" && league === "nfl" && (st.pos === "QB" || stat[3].pos === "QB") && has("qb_by_zone") && stat[0] !== "qb_by_zone") add("◎ Where they throw (9 zones)", { stat: "qb_by_zone", type: "bar", pos: "QB", top: "10" });
      if (who === "players" && league === "nfl" && (st.pos === "WR" || stat[3].pos === "WR") && has("rec_by_zone") && stat[0] !== "rec_by_zone") add("◎ Where they get targeted", { stat: "rec_by_zone", type: "bar", top: "10" });
      sib.filter((x) => x !== pair).slice(0, 2).forEach((x) => add(`→ ${x[1]}`, { stat: x[0] }));
      return out;
    })();
    // More to explore: one preset from each other group, a different one each day
    const day = Math.floor(Date.now() / 864e5);
    const topics = presetGroups(PRESETS[league]).map(([g, l]) => [g, l[(day + g.length) % l.length]]).filter(([, x]) => x)
      .sort((a, b) => ((a[0].length * 7 + day) % 11) - ((b[0].length * 7 + day) % 11)).slice(0, 6);
    const stepHint = { 1: { bar: "Bar", line: "Line", pie: "Pie", scatter: "Scatter", radar: "Radar", table: "Table" }[st.type],
      2: `${stat[1].replace(/ \(.+\)$/, "")}${perTxt(stat)}`, 3: chips.length ? `${chips.length} on` : `All ${who}`, 4: "colors, title, picture" };
    const step = (n, label, body) => `<section class="vz-step" data-n="${n}"${shut[n] ? " data-shut" : ""}><button type="button" class="vz-sh" data-step="${n}"><span class="vz-num">${n}</span><b>${label}</b><small>${esc(stepHint[n] || "")}</small></button><div class="vz-sb">${body}</div></section>`;
    const presetsBox = `<div class="vz-presets">
        <label>Presets<select id="vz-preset"><option value="">Pick a chart…</option>
          ${presetGroups(PRESETS[league]).map(([g, l]) => `<optgroup label="${esc(g)}">${l.map(([n, i]) => `<option value="p${i}">${esc(n)}</option>`).join("")}</optgroup>`).join("")}
          ${(mine()[league] || []).length ? `<optgroup label="My charts">${mine()[league].map((m, i) => `<option value="m${i}">${esc(m.name)}</option>`).join("")}</optgroup>` : ""}
        </select></label>
      </div>`;
    const steps = `<div class="vz-steptabs">${[1, 2, 3, 4].map((n) => `<button type="button" data-tab="${n}" class="${stepOn === n ? "on" : ""}">${n} ${["Chart", "Data", "Who", "Look"][n - 1]}</button>`).join("")}</div>
      <div class="vz-steps" data-on="${stepOn}">
      ${step(1, "Chart", `<div class="vz-ctl">
        <label class="vz-wide">Chart${seg("vz-type", [["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["radar", "Radar"], ["table", "Table"]], st.type)}</label>
        ${(st.type === "line" || st.type === "bar") && who === "teams" ? `<label class="vz-wide">${st.type === "bar" ? "Bars" : "Lines"}${seg("vz-scope", [["", st.type === "bar" ? "Each team" : "Top teams"], ["league", `Whole ${league === "nfl" ? "NFL" : "league"}${st.type === "bar" ? " by season" : ""}`]], st.scope)}</label>` : ""}
        ${st.type === "line" && (!multi || whole) ? `<label class="vz-wide">Line${seg("vz-cum", [["", "Each week"], ["1", whole && per === "game" ? "Running average" : "Running total"]], st.cum)}</label>` : ""}
        ${st.type === "radar" ? `<details class="vz-wide vz-rstats"><summary>Stats on the web (${axes().length}) · tap to change</summary><div id="vz-radar">${groups.map(([g, l]) => `<fieldset><legend>${esc(g)}</legend>${l.map((s) => `<label><input type="checkbox" value="${s[0]}"${custom().includes(s[0]) ? " checked" : ""}> ${esc(s[1])}</label>`).join("")}</fieldset>`).join("")}<p class="muted">Pick 3 to 8.</p></div></details>` : ""}
        ${st.type === "table" ? `<details class="vz-wide vz-rstats"><summary>Columns (${tableCols().length}) · tap to change</summary><div id="vz-cols">${groups.map(([g, l]) => `<fieldset><legend>${esc(g)}</legend>${l.map((s) => `<label><input type="checkbox" value="${s[0]}"${tableCols().includes(s) ? " checked" : ""}> ${esc(s[1])}</label>`).join("")}</fieldset>`).join("")}<p class="muted">Up to 14. The sort column and the stats in your filter always show.</p></div></details>` : ""}
      </div>`)}
      ${step(2, "Data", `<div class="vz-ctl">
        <label>Of${seg("vz-who", [["teams", "Teams"], ["players", "Players"]], who)}</label>
        ${st.type === "pie" ? "" : `<label>Show as${seg("vz-per", [["game", "Per game"], ["total", "Total"], ...(who === "players" ? [["share", "Share of team"], ...(D.pcols.includes("snaps") ? [["snap", "Per 100 snaps"]] : [])] : [])], per)}</label>`}
        ${st.type === "radar" ? "" : `<label class="vz-wide">${st.type === "scatter" ? "Across (X)" : st.type === "table" ? "Sort by" : "Stat"}${statSel("vz-stat", stat[0])}${stat[3].count || st.type === "scatter" ? "" : `<small class="muted">Rate stat: Show as doesn't change it.</small>`}</label>${st.type === "scatter" ? `<label class="vz-wide">Up (Y)${statSel("vz-y", ystat[0])}</label>` : ""}`}
        <label>Seasons${who === "players" && idx.players?.[league] > (idx[league] || [])[0] ? ` <small class="muted">player stats start in ${idx.players[league]}</small>` : ""}<span class="vz-pair">${sel("vz-from", seasons.map((s) => [s, s]), st.from)}<i>to</i>${sel("vz-to", seasons.map((s) => [s, s]), st.to)}</span></label>
        <label>Weeks<span class="vz-pair">${sel("vz-wk1", wkOpts, st.wk1)}<i>to</i>${sel("vz-wk2", wkOpts, st.wk2)}</span></label>
        <label>Against${sel("vz-opp", OPP, st.opp)}</label>
        <label>Games${sel("vz-last", LAST.some(([k]) => k === st.last) ? LAST : [...LAST, [st.last, `Last ${st.last} games`]], st.last)}</label>
        ${D.gcond ? `<label>Conditions${sel("vz-cond", COND.map(([k, l]) => [k, l]), st.cond)}</label>` : ""}
        ${who === "players" && D.pcols.includes("left") ? `<div class="vz-chks vz-wide"><label title="Games a player left by halftime (usually hurt, sometimes rested in a blowout). QBs: threw or ran in the first half and never after. Everyone else: a regular who played under half his side's snaps."><input type="checkbox" id="vz-noexit"${st.noexit ? " checked" : ""}> Leave out games they left by halftime</label></div>` : ""}
      </div>`)}
      ${step(3, "Who", `<div class="vz-ctl">
        ${!whole ? whereBox : ""}
        <label>${league === "nfl" ? "Division" : "Conference"}${sel("vz-group", [["", "All"], ...confs.map((c) => [c, c])], st.group)}</label>
        ${who === "players" ? `<label>Team${sel("vz-team", [["", "All teams"], ...Object.entries(D.teams).sort((a, b) => a[1][0].localeCompare(b[1][0])).map(([k, t]) => [k, t[0]])], st.team)}</label>
          <label>Position${sel("vz-pos", posOpts, st.pos)}</label>
          ${D.xcols?.length ? `<label>Experience${sel("vz-exp", EXP, st.exp)}</label><label>Drafted${sel("vz-draft", DRAFT, st.draft)}</label>` : ""}
          <label>Depth chart${sel("vz-role", [["", "Any"], ...["QB1", "QB2", "RB1", "RB2", "RB3", "WR1", "WR2", "WR3", "WR4", "TE1", "TE2"].map((r) => [r, r])], st.role)}</label>` : ""}
        ${whole ? "" : `<label>How many${sel("vz-top", [...[5, 10, 15, 20, 25, 50, 100].map((x) => [x, `Top ${x}`]), ["all", "All"]], st.top)}</label>`}
        ${whole ? "" : denOf(stat) && st.type !== "pie" || (st.type === "radar" && who === "players") ? `<label>Minimum <small class="muted">${esc(st.type === "radar" ? { QB: "pass attempts", RB: "carries", WR: "catches", DEF: "tackles", CB: "tackles", S: "tackles", K: "field goal tries" }[st.pos] || "touches" : unitOf(stat))}</small><input id="vz-min" type="number" min="0" inputmode="numeric" placeholder="auto ${st.type === "radar" ? "" : autoMin(stat)}" value="${esc(st.min)}"></label>` : ""}
        ${(st.type === "bar" || st.type === "table") && !whole ? `<label>Show${seg("vz-order", [["best", "Best"], ["worst", "Worst"]], st.order)}</label>` : ""}
        <label class="vz-wide vz-findwrap">Highlight / compare<input id="vz-find" placeholder="Type a ${who === "teams" ? "team" : "player"}…" autocomplete="off" spellcheck="false"><div class="vz-sugg" id="vz-sugg" hidden></div></label>
        <div class="vz-picks">${picks.map((k) => `<button data-k="${esc(k)}" title="Remove">${esc(name(k))} ×</button>${who === "players" && st.pl !== k ? `<button data-plk="${esc(k)}" class="vz-plk" title="Every stat we have on him">All his stats</button>` : ""}`).join("")}</div>
      </div>`)}
      ${step(4, "Look", `<div class="vz-ctl">
        ${st.type !== "radar" && st.type !== "table" && !whole ? `<div class="vz-chks vz-wide"><label><input type="checkbox" id="vz-logo"${st.logo !== "0" ? " checked" : ""}> Team logos</label><label><input type="checkbox" id="vz-names"${st.names !== "0" ? " checked" : ""}> ${who === "teams" ? "Team" : "Player"} names</label></div>` : ""}
        <label>Colors${sel("vz-scheme", Object.entries(SCHEMES).map(([k, x]) => [k, x[0]]), st.scheme)}</label>
        <label class="vz-wide">Your title<input id="vz-ttl" maxlength="80" placeholder="${esc(autoTitle)}" value="${esc(st.ttl)}" spellcheck="true"></label>
        <label class="vz-wide">Your subtitle<input id="vz-subt" maxlength="100" placeholder="${esc(autoSub)}" value="${esc(st.subt)}" spellcheck="true"></label>
        ${st.type === "scatter" ? `<fieldset class="vz-wide vz-quad"><legend>Name the quadrants <small class="muted">(split by the dashed average lines)</small></legend>${["Top left", "Top right", "Bottom left", "Bottom right"].map((l, i) => `<label>${l}<input data-quad="${i}" maxlength="24" placeholder="${esc(["e.g. Lucky", "e.g. Elite", "e.g. Bad", "e.g. Unlucky"][i])}" value="${esc((st.quad || "").split("|")[i] || "")}" spellcheck="true"></label>`).join("")}</fieldset>` : ""}
        <label>Picture background${seg("vz-bg", [["", "Dark"], ["light", "Light"], ["clear", "See-through"]], st.bg)}</label>
        <label>Picture size${sel("vz-size", [["", "Like the screen"], ["x", "X post (16:9)"], ["sq", "Square"], ["story", "Phone story (9:16)"]], st.size)}</label>
        <div class="vz-chks vz-wide">${[["nums", "Numbers on bars", 1], ["grid", "Gridlines", 1], ["curve", "Smooth lines", 1], ["round", "Rounded bars", 0], ["big", "Bigger text", 0]]
          .map(([k, l, on]) => `<label><input type="checkbox" data-sty="${k}" data-on="${on}"${(on ? st[k] !== "0" : st[k]) ? " checked" : ""}> ${l}</label>`).join("")}</div>
        <p class="muted vz-wide">Background and size are for Download picture and Share; the chart here stays as is.</p>
      </div>`)}
      </div>`;
    const chipRow = chips.length ? `<div class="vz-on">${chips.map(([l], i) => `<button type="button" data-chip="${i}" title="Take this filter off">${esc(l)} ✕</button>`).join("")}${chips.length > 1 ? `<button type="button" class="vz-clear" data-chip="all">Clear all</button>` : ""}</div>` : "";
    const after = `${takeaway ? `<p class="vz-take"><b>Takeaway:</b> ${esc(takeaway)}</p>` : ""}
      ${related.length ? `<div class="vz-rel"><h4>Related</h4><div>${related.map(([l], i) => `<button type="button" class="vz-chip" data-rel="${i}">${esc(l)}</button>`).join("")}</div></div>` : ""}
      ${topics.length ? `<div class="vz-rel"><h4>More to explore</h4><div>${topics.map(([g, [l]], i) => `<button type="button" class="vz-chip vz-topic" data-topic="${i}"><small>${esc(g)}</small>${esc(l)}</button>`).join("")}</div></div>` : ""}`;
    // My charts: your saved charts as cards, newest first or grouped by team, player or stat, with a filter box
    const myList = mine()[league] || [], pics = thumbs()[league] || {};
    const TYPE_ICON = { bar: "▤", line: "↗", pie: "◔", scatter: "⁘", radar: "✳", table: "☷" };
    const minePanel = (() => {
      const q = norm(mineQ.trim()), has = (m) => !q || norm([m.name, m.what, ...(m.teams || []), ...(m.players || [])].join(" ")).includes(q);
      const list = myList.map((m, i) => [m, i]).filter(([m]) => has(m));
      const card = ([m, i]) => `<div class="vz-mc"><button type="button" class="vz-mc-open" data-mo="${i}">${pics[m.name] ? `<img src="${pics[m.name]}" alt="" loading="lazy">` : `<span class="vz-mc-ico">${TYPE_ICON[m.st.type || "bar"] || "▤"}</span>`}
          <b>${esc(m.name)}</b><small>${esc([m.what, m.st.from && m.st.to ? (m.st.from === m.st.to ? m.st.from : `${m.st.from}–${m.st.to}`) : ""].filter(Boolean).join(" · "))}</small>
          ${(m.players || []).length || (m.teams || []).length ? `<small class="vz-mc-who">${esc([...(m.players || []), ...(m.teams || [])].slice(0, 4).join(", "))}</small>` : ""}
          ${m.at ? `<small class="vz-mc-at">Saved ${esc(new Date(m.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</small>` : ""}</button>
        <button type="button" class="vz-mc-del" data-md="${i}" title="Delete this chart">✕</button></div>`;
      // grouped: a chart with two teams (or players) shows under each; ones with none go last
      const by = { team: (m) => m.teams || [], player: (m) => m.players || [], stat: (m) => (m.what ? [m.what] : []) }[mineSort];
      let body;
      if (!by) body = `<div class="vz-mc-grid">${list.map(card).join("")}</div>`;
      else {
        const g = {};
        for (const x of list) { const ks = by(x[0]); (ks.length ? ks : [mineSort === "team" ? "No team" : mineSort === "player" ? "No player" : "Other"]).forEach((k) => (g[k] ||= []).push(x)); }
        body = Object.entries(g).sort((a, b) => /^(No |Other)/.test(a[0]) - /^(No |Other)/.test(b[0]) || a[0].localeCompare(b[0]))
          .map(([k, l]) => `<h4 class="vz-mc-h">${esc(k)} <small>${l.length}</small></h4><div class="vz-mc-grid">${l.map(card).join("")}</div>`).join("");
      }
      const signed = typeof Account !== "undefined" && Account.user();
      return `<div class="vz-mine"><div class="vz-mine-head"><b>My charts</b><button type="button" class="vz-pl-x" id="vz-mx" title="Close">✕</button>
          <div class="vz-mine-ctl"><label class="vz-mine-sort">Sort${sel("vz-msort", [["new", "Newest"], ["team", "By team"], ["player", "By player"], ["stat", "By stat"]], mineSort)}</label>
          <input id="vz-mq" type="search" placeholder="Find a team, player or stat…" value="${esc(mineQ)}" autocomplete="off"></div></div>
        ${myList.length ? list.length ? body : `<p class="muted">No saved chart matches “${esc(mineQ)}”.</p>` : `<p class="muted">Nothing saved yet. Make a chart, then tap <b>☆ Save to My charts</b> under it. It keeps the seasons, filters and look, so it opens exactly the same later.</p>`}
        <p class="muted vz-pl-note">${signed ? "Saved to your account, so they're on every device you sign in on (the little pictures stay on the device that saved them)." : "Saved on this device. Sign in (Settings) to keep them on every device."} Up to 30 ${league === "nfl" ? "NFL" : "college"} charts.</p></div>`;
    })();
    // Everything on one player: every group he has a number in, each stat with his number and rank; tap one to chart it.
    // Ranks are against players at his position in these weeks (rates: anyone with 35% of the leader's volume), whatever the
    // filters. "Fewer is better" totals (interceptions thrown, penalties) get no rank: everyone who barely played would beat him.
    const plPanel = (() => {
      const k = st.pl;
      if (who !== "players" || !k || !agg[k]) return "";
      const m = meta(k) || [k, ""], posK = POS_OF(m[1], agg[k].S), everyone = Object.keys(agg).filter((x) => POS_OF(meta(x)?.[1], agg[x].S) === posK);
      const cats = groups.map(([g, l]) => [g, l.map((s) => {
        const v = value(s, agg[k].S, agg[k].g, "total"), den = s[3].den;
        if (v == null || Number.isNaN(v) || (s[3].count ? !v : den && !den(agg[k].S, agg[k].g))) return null;
        let n = 0, better = 0;
        const minD = den ? 0.35 * Math.max(0, ...everyone.map((x) => den(agg[x].S, agg[x].g) || 0)) : 0;
        if ((!den || den(agg[k].S, agg[k].g) >= minD) && !(s[3].count && s[3].low)) for (const x of everyone) {
          if (den && (den(agg[x].S, agg[x].g) || 0) < minD) continue;
          const w = value(s, agg[x].S, agg[x].g, "total");
          if (w == null || Number.isNaN(w)) continue;
          n++; if (s[3].low ? w < v : w > v) better++;
        }
        return [s, s[3].split ? `${fmt(s, v, "total")} total` : fmt(s, v, "total"), n ? better + 1 : 0];
      }).filter(Boolean)]).filter(([, l]) => l.length);
      const count = cats.reduce((a, [, l]) => a + l.length, 0);
      return `<div class="vz-pl"><div class="vz-pl-head"><div><b>Every stat on ${esc(m[0])}</b><small>${esc([m[1], tm(teamOf(k))[0], seasonTxt, `${count} stats in ${cats.length} groups`].filter(Boolean).join(" · "))}</small></div><button type="button" class="vz-pl-x" id="vz-plx" title="Close">✕</button></div>
        <div class="vz-pl-cats">${cats.map(([g, l]) => `<details${l.some(([s]) => s === stat) ? " open" : ""}><summary>${esc(g)} <small>${l.length}</small></summary><div class="vz-pl-stats">${l.map(([s, v, r]) => `<button type="button" data-pls="${s[0]}" title="${esc(s[1])}" class="${s === stat ? "on" : ""}"><span>${esc(s[1])}</span><b>${esc(v)}</b>${r ? `<small>#${r}</small>` : ""}</button>`).join("")}</div></details>`).join("")}</div>
        <p class="muted vz-pl-note">Tap a group, then a stat to chart it with ${esc(m[0])} highlighted. Totals for ${esc(seasonTxt)}, ${esc(weeksTxt.toLowerCase())}; # = his rank among ${esc({ QB: "QBs", RB: "running backs", WR: "receivers and tight ends", K: "kickers", OL: "offensive linemen", DEF: "defenders" }[posK] || "players")} (rates: ones with at least 35% of the leader's volume).</p></div>`;
    })();
    const frame = `${plPanel}${chipRow}<div class="vz-frame" id="vz-frame"><div class="vz-title"><b>${esc(title)}</b><small>${esc(sub)}</small></div>
        ${body.html || `<div class="vz-canvas" style="height:${body.h}px"><canvas id="vz-chart"></canvas></div>`}
        <div class="vz-mark">cupcakeindex.com · ${esc(league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com")}</div></div>
      ${seasonOnly ? `<p class="note">Our ratings and college PPA are season-long numbers (as of the latest rankings), so they ignore the weeks you picked.</p>` : ""}`;
    const actions = `<div class="vz-actions">${st.type === "table" ? `<button class="btn" id="vz-csv">Download spreadsheet (CSV)</button>` : Share.phone() && navigator.share ? "" : `<button class="btn" id="vz-png">Download picture</button>`}<button class="btn" id="vz-link">Copy link</button>${navigator.share && st.type !== "table" ? `<button class="btn" id="vz-share">Share</button>` : ""}<button class="btn" id="vz-save" type="button">☆ Save to My charts</button><button class="btn vz-reset" id="vz-reset">Start over</button></div>
      <div class="vz-saveform hidden" id="vz-saveform"><input id="vz-pname" maxlength="40" placeholder="Name this chart"><button class="btn tour-next" id="vz-pok" type="button">Save</button><button class="btn" id="vz-pno" type="button">Cancel</button></div>
      <small class="muted vz-pmsg" id="vz-pmsg"></small>
      ${body.table ? `<details class="vz-tbl"><summary>See the numbers</summary><table class="box"><tbody>${body.table.map(([i, k, v]) => `<tr><td class="num muted">${i}</td><td>${whole ? esc(k) : who === "players" && /^\d+$/.test(k) ? `<a href="#/player/${esc(k)}?league=${league}">${esc(name(k))}</a>` : who === "teams" ? `<a href="#/team/${esc(k.split(":")[1])}?league=${league}">${esc(name(k))}</a>` : esc(name(k))}</td><td class="num">${esc(v)}</td></tr>`).join("")}</tbody></table></details>` : ""}
      <p class="note">${st.role ? esc(`${st.role} = each team's ${(({ QB: "quarterback with the most pass attempts", RB: "back with the most carries + catches", WR: "wide receiver with the most targets", TE: "tight end with the most targets" })[st.role.slice(0, 2)]).replace("the most", st.role.endsWith("1") ? "the most" : `the ${{ 2: "2nd", 3: "3rd", 4: "4th" }[st.role.slice(2)]}-most`)} in the weeks you picked${league === "cfb" ? " (catches stand in for targets in college)" : ""}. `) : ""}${esc(note)} Source: ${esc(src)}. Rates are total ÷ total over the weeks you pick, not an average of weekly averages. Updated ${esc(new Date(D.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}.</p>`;
    const qBox = `<div class="vz-q vz-findwrap"><input id="vz-q" type="search" placeholder="${adv ? "Ask or search: stats, teams, players, presets… (try “sacks vs pressures”)" : "Ask a question… (try “who gets the targets on Washington”)"}" autocomplete="off" spellcheck="false"><div class="vz-sugg" id="vz-qs" hidden></div></div>`;
    const toggle = `<div class="seg vz-mode" id="vz-mode"><button data-v="" class="${adv ? "" : "active"}">Simple</button><button data-v="adv" class="${adv ? "active" : ""}">Advanced</button></div>`;

    el.innerHTML = stSub() + `<div class="card vz ${adv ? "vz-adv" : "vz-simple"}">
      <div class="sc-bar vz-head"><h2>Visualize</h2><span class="muted vz-tag">Make a chart, win the argument.</span><button type="button" class="vz-minebtn${mineOpen ? " on" : ""}" id="vz-mine" aria-expanded="${mineOpen}">★ My charts${myList.length ? ` (${myList.length})` : ""}</button>${toggle}</div>
      ${mineOpen ? minePanel : ""}
      ${adv ? `<div class="vz-top">${qBox}${presetsBox}</div>
      <div class="vz-grid"><div class="vz-side">${steps}</div><div class="vz-main">${frame}${after}${actions}</div></div>`
      : `${qBox}<p class="vz-read">Showing: <b>${esc(readout.join(" · "))}</b> <button type="button" class="vz-editbtn" id="vz-edit" aria-expanded="${editOpen}">${editOpen ? "Done ▴" : "Edit ▾"}</button></p>
      <div class="vz-editbox"${editOpen ? "" : " hidden"}>${presetsBox}${steps}</div>
      ${frame}${after}${actions}`}
    </div>`;
    function custom() { return st.radar ? st.radar.split(",") : who === "teams" ? RADAR.teams : RADAR.players[st.pos] || RADAR.players[""]; }
    function axes() { return custom().filter((k) => all.some((s) => s[0] === k)); }

    chart?.destroy();
    chart = cfg ? new Chart(document.getElementById("vz-chart"), cfg) : null;
    if (typeof Stats !== "undefined") Stats.count("charts"); // analytics: charts made
    save();

    // controls
    const reload = () => { save(); render(new URLSearchParams(location.hash.split("?")[1] || "")); };
    const redo = () => { if (st.who !== who) return reload(); save(); draw(el, seasons, Ds); }; // players and teams cover different seasons
    el.querySelectorAll(".vz-seg").forEach((g) => g.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const k = { "vz-type": "type", "vz-who": "who", "vz-per": "per", "vz-order": "order", "vz-cum": "cum", "vz-scope": "scope", "vz-bg": "bg" }[g.id];
      st[k] = b.dataset.v;
      if (k === "who") { st.pick = ""; st.team = ""; st.pos = ""; st.radar = ""; st.stat = b.dataset.v === "players" ? "scrim" : "epa_play"; st.y = b.dataset.v === "players" ? "tds" : "pts"; }
      if (k === "type") st.radar = "";
      redo();
    });
    const on = (id, k, again = redo) => { const x = document.getElementById(id); if (x) x.onchange = () => { st[k] = x.value; if (k === "pos") st.radar = ""; if (k === "stat" || k === "pos") st.min = ""; again(); }; };
    const mi = document.getElementById("vz-min");
    if (mi) mi.onchange = () => { st.min = mi.value === "" ? "" : String(Math.max(0, Math.round(+mi.value) || 0)); redo(); };
    on("vz-role", "role"); on("vz-scheme", "scheme"); on("vz-size", "size");
    ["ttl", "subt"].forEach((k) => { const x = document.getElementById("vz-" + k); if (x) x.onchange = () => { st[k] = x.value.trim(); redo(); }; });
    el.querySelectorAll("[data-sty]").forEach((x) => x.onchange = () => { st[x.dataset.sty] = +x.dataset.on ? (x.checked ? "" : "0") : (x.checked ? "1" : ""); redo(); });
    on("vz-stat", "stat"); on("vz-y", "y"); on("vz-wk1", "wk1"); on("vz-wk2", "wk2"); on("vz-top", "top"); on("vz-group", "group"); on("vz-team", "team"); on("vz-pos", "pos"); on("vz-exp", "exp"); on("vz-draft", "draft");
    on("vz-from", "from", reload); on("vz-to", "to", reload); on("vz-opp", "opp"); on("vz-last", "last"); on("vz-cond", "cond");
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
    // Filter box, the Table's columns and header sorting, quadrant names, the spreadsheet download
    const wh = document.getElementById("vz-where");
    if (wh) wh.onchange = () => { st.where = wh.value.trim(); redo(); };
    const cl = document.getElementById("vz-cols");
    if (cl) cl.onchange = (e) => {
      const v = [...cl.querySelectorAll("input:checked")].map((o) => o.value);
      if (v.length > 14) { e.target.checked = false; return; }
      st.cols = v.join(","); redo();
      document.getElementById("vz-cols")?.closest("details")?.setAttribute("open", "");
    };
    el.querySelectorAll(".vz-table th[data-sort]").forEach((th) => th.onclick = () => {
      if (st.stat === th.dataset.sort) st.order = st.order === "worst" ? "best" : "worst"; else { st.stat = th.dataset.sort; st.order = "best"; st.min = ""; }
      redo();
    });
    el.querySelectorAll("[data-quad]").forEach((x) => x.onchange = () => {
      const q = [0, 1, 2, 3].map((i) => (el.querySelector(`[data-quad="${i}"]`)?.value || "").replace(/\|/g, "/").trim());
      st.quad = q.some(Boolean) ? q.join("|") : ""; redo();
    });
    const csv = document.getElementById("vz-csv");
    if (csv) csv.onclick = () => {
      const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const text = [tableHead, ...tableRows].map((r) => r.map(cell).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv" })); // the mark makes Excel read it as UTF-8
      a.download = `cupcake-index-${who}-${st.stat}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (typeof Stats !== "undefined") Stats.count("downloads");
    };
    // search every team/player in the data (not just the first few thousand): best name match first, then the bigger stat line
    const find = document.getElementById("vz-find"), sugg = document.getElementById("vz-sugg");
    const pool =Object.keys(agg).filter(ok).map((k) => [k, norm(name(k)), agg[k].S]);
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
    el.querySelector(".vz-picks").onclick = (e) => {
      const p = e.target.closest("[data-plk]"); if (p) { st.pl = p.dataset.plk; redo(); document.querySelector(".vz-pl")?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
      const b = e.target.closest("[data-k]"); if (b) { st.pick = picks.filter((k) => k !== b.dataset.k).join(","); redo(); } };
    const plx = document.getElementById("vz-plx");
    if (plx) plx.onclick = () => { st.pl = ""; redo(); };
    el.querySelectorAll("[data-pls]").forEach((b) => b.onclick = () => {
      const s = all.find((x) => x[0] === b.dataset.pls); if (!s) return;
      // chart it against everyone: filters that could leave him out come off, and he's highlighted
      Object.assign(st, { stat: s[0], pick: [...new Set([...picks, st.pl])].slice(-6).join(","), team: "", pos: "", role: "", group: "", exp: "", draft: "", where: "", min: "", radar: "" });
      if (!["bar", "line", "table"].includes(st.type)) st.type = "bar";
      if (s[3].count && st.per !== "game") st.per = "total";
      redo();
      document.getElementById("vz-frame")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    // Search box: one place to find any stat, preset, position, team or filter instead of scrolling the dropdowns.
    // Each item: [label, what it is, extra words to match, apply()]
    const qbox = document.getElementById("vz-q"), qs = document.getElementById("vz-qs");
    const setWho = (w) => { if (w !== st.who) { st.who = w; st.pick = ""; st.team = ""; st.pos = ""; st.radar = ""; st.role = ""; } };
    // players by name: every stat we have on him (the season's player list; team-only seasons have none)
    const PL_FIRST = { QB: "pass_yds", RB: "rush_yds", FB: "rush_yds", WR: "rec_yds", TE: "rec_yds", K: "fg_made", PK: "fg_made", P: "punts", T: "off_snaps", G: "off_snaps", C: "off_snaps", OT: "off_snaps", OG: "off_snaps", OL: "off_snaps" };
    const plPool = (() => { const out = {}; for (const d of Ds) for (const [k, m] of Object.entries(d.pmeta || {})) out[k] = m; return Object.entries(out); })();
    // how big his stat line is (yards, tackles, kicks), so "allen" lists Josh Allen before backups
    const plSize = (() => {
      const out = {};
      for (const d of Ds) {
        const c = (n) => d.pcols?.indexOf(n) + 3, ix = [["pass_yds", 1], ["rush_yds", 1], ["rec_yds", 1], ["tackles", 10], ["fg_made", 30]].map(([n, w]) => [c(n), w]).filter(([i]) => i > 2);
        for (const r of d.prows || []) out[r[0]] = (out[r[0]] || 0) + ix.reduce((a, [i, w]) => a + (+r[i] || 0) * w, 0);
      }
      return out;
    })();
    const plItem = ([k, m]) => [m[0], `Player · ${[m[1], (D.teams[m[2]] || tm(m[2]))[1]].filter(Boolean).join(" ")} · every stat on him`, "player", () => {
      const p = (m[1] || "").toUpperCase();
      st = { ...DEF, from: st.from, to: st.to, mode: st.mode, who: "players", type: "bar", per: "total", top: "15", stat: PL_FIRST[p] || (league === "cfb" && !p ? "scrim" : "tackles"), pick: k, pl: k };
      reload();
    }];
    // names only (never "player" or "stat"), whole words first, this season's players before older ones
    const plFind = (words) => words.join("").length < 3 ? [] : plPool.map(([k, m]) => [k, m, norm(m[0])]).filter(([, , n]) => words.every((w) => n.includes(w)))
      .map(([k, m, n]) => [k, m, (n.startsWith(words.join(" ")) ? 0 : words.every((w) => n.split(" ").some((x) => x.startsWith(w))) ? 1 : 2) + (D.pmeta?.[k] ? 0 : 0.5)])
      .filter((x) => x[2] < 2).sort((a, b) => a[2] - b[2] || (plSize[b[0]] || 0) - (plSize[a[0]] || 0)).slice(0, 4).map(([k, m]) => plItem([k, m]));
    const qItems = () => [
      ...PRESETS[league].filter(Array.isArray).map(([l, o]) => [l, "Preset", "chart idea", () => { st = { ...DEF, from: st.from, to: st.to, mode: st.mode, ...o }; reload(); }]),
      ...(mine()[league] || []).map((m) => [m.name, "My chart", "mine saved portfolio", () => { st = { ...DEF, from: st.from, to: st.to, mode: st.mode, ...m.st }; reload(); }]),
      ...["players", "teams"].flatMap((w) => statsFor(w, have).flatMap(([g, l]) => l.map((x) => [x[1], `${w === "players" ? "Player" : "Team"} stat · ${g}`, `${g} ${x[0]}`,
        () => { setWho(w); if (st.type === "radar" || st.type === "pie" && !x[3].count) st.type = "bar"; st.stat = x[0]; st.min = ""; redo(); }]))),
      ...posOpts.filter(([k]) => k).map(([k, l]) => [l, "Position", `${k} position players`, () => { setWho("players"); st.pos = k; st.role = ""; st.min = ""; redo(); }]),
      ...(D.xcols?.length ? EXP.filter(([k]) => k).map(([k, l]) => [l, "Experience", "years experience rookie", () => { setWho("players"); st.exp = k; redo(); }]) : []),
      ...(D.xcols?.length ? DRAFT.filter(([k]) => k).map(([k, l]) => [l === "Any" ? l : k === "U" ? "Undrafted" : `Drafted: ${l}`, "Drafted", "draft round pick", () => { setWho("players"); st.draft = k; redo(); }]) : []),
      ...Object.entries(D.teams).map(([k, t]) => [t[0], "Team", `${t[1]} ${t[3] || ""}`, () => {
        if (st.who === "players") st.team = k; else st.pick = [...(st.pick ? st.pick.split(",") : []).filter((x) => x !== k), k].slice(-6).join(","); redo(); }]),
      ...confs.map((c) => [c, league === "nfl" ? "Division" : "Conference", "group", () => { st.group = c; redo(); }]),
      ...[["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"], ["radar", "Radar"], ["table", "Table"]].map(([k, l]) => [k === "table" ? "Data table" : `${l} chart`, "Chart type", k === "table" ? "chart type table spreadsheet rows columns sort filter query" : "chart type", () => { if (k === "table" && st.type !== "table") st.per = "total"; st.type = k; st.radar = ""; redo(); }]),
      [`Whole ${lgTxt} by week`, "Line chart", "league wide nfl-wide trend week by week season vs season all teams", () => { setWho("teams"); st.type = "line"; st.scope = "league"; redo(); }],
      [`Whole ${lgTxt} by season`, "Bar chart", "league wide nfl-wide trend year by year season vs season all teams history", () => { setWho("teams"); st.type = "bar"; st.scope = "league"; redo(); }],
    ];
    // Two stats at once: "run stops AND defensive EPA", "sacks vs pressures", "ypc & carries" (and / vs / & / x / a comma)
    // makes a scatter of the two, first one across (each side read by bestStats). A comparison ("run stops > 20 and
    // sacks >= 3") offers a Table filtered that way instead.
    const qBest = (side, w) => bestStats(side, statsFor(w, have));
    // A question in plain words ("who gets the targets on washington", "qbs vs cupcakes epa per dropback", "carry share last 3 games"):
    // keyword rules, not AI. It pulls out a team, a position, the opponents, last N games, chart words and a season, then reads the
    // stat from the words left over. Gives a search item [label, "Your question", "", apply], or null when it can't find a stat.
    const ASK_FILL = new Set(["who", "whos", "what", "whats", "which", "gets", "get", "getting", "got", "the", "on", "for", "in", "of", "a", "an", "is", "are",
      "has", "have", "had", "does", "do", "did", "most", "more", "much", "many", "team", "teams", "players", "player", "guys", "me", "show", "chart", "graph",
      "at", "to", "with", "by", "best", "top", "leaders", "leader", "lead", "leads", "led", "highest", "this", "season", "year", "so", "far", "their", "his",
      "how", "there", "than", "like", "look", "looks", "compare", "comparing", "all", "every", "league", "nfl", "college", "cfb", "ncaa", "fbs", "my", "our"]);
    const ASK_POS = Object.entries(POS_WORDS).filter(([w]) => !["running", "back", "backs", "k", "s", "def", "defense", "edge"].includes(w) && posOpts.some(([k]) => k === POS_WORDS[w]))
      .map(([w, p]) => [" " + norm(w) + " ", p]).sort((a, b) => b[0].length - a[0].length);
    const CITY = {};
    for (const x of Object.values(D.teams)) { const c = x[0].split(" ").slice(0, -1).join(" "); CITY[c] = (CITY[c] || 0) + 1; }
    // everyday words that never name a stat, so they don't make an answer a "closest match"
    const ASK_SKIP = new Set(["out", "off", "up", "over", "under", "when", "while", "from", "him", "her", "they", "them", "does", "during", "into", "about", "was", "were", "been", "will", "would", "could", "should", "per", "and", "season", "game", "games"]);
    const ask = (raw, plain) => {
      const lower = " " + norm(raw).replace(/[?!.,;:]/g, " ").replace(/\s+/g, " ").trim() + " ";
      let t = league === "cfb" ? lower.replace(/ targets? /g, " catches ") : lower;
      const o = {};
      const take = (re, f) => { const m = t.match(re); if (!m) return false; t = t.replace(re, " "); f(m); return true; };
      // seasons: "all time" / "ever" / "career" = every season we have, "since 2023", "2023 to 2025", or one season
      take(/ (all ?time|ever|career|all seasons|in history|history) /, () => { o.from = "first"; })
        || take(/ (since|from) ((19|20)\d\d) /, (m) => { o.from = m[2]; })
        || take(/ ((19|20)\d\d) (to|through|thru) ((19|20)\d\d) /, (m) => { o.from = m[1]; o.to = m[4]; })
        || take(/ (19|20)(\d\d) /, (m) => { o.from = o.to = m[1] + m[2]; });
      take(/ (in |over )?(the |his |their )?last (\d+|two|three|four|five|six) (games?|weeks?) /, (m) => { o.last = String({ two: 2, three: 3, four: 4, five: 5, six: 6 }[m[3]] || Math.max(1, Math.min(17, +m[3] || 3))); });
      take(/ (vs|against|versus|on|over) (the )?(good|winning|tophalf|top half|top|ranked|playoff|strong|best) ((teams?|defenses?|offenses?|opponents?) )?/, () => { o.opp = "good"; })
        || take(/ (vs|against|versus|on|over) (the )?(cupcakes?|bad|weak|bottomhalf|bottom half|losing|worst) ((teams?|defenses?|offenses?|opponents?) )?/, () => { o.opp = "soft"; })
        || take(/ (vs |against |versus )?cupcakes? /, () => { o.opp = "soft"; });
      // the whole league as one bar per season: "nfl wide per year", "league-wide by season", "each year"
      take(/ ((nfl|league|ncaa|college|fbs) ?wide|across the league|(per|by|each|every) (year|season)|year by year|season by season|over the years) /, () => {
        o.scope = "league"; o.type = "bar"; if (!o.from) o.from = "first";
      });
      take(/ ((nfl|league|ncaa|college|fbs) ?wide|across the league|(per|by|each|every) (year|season)) /, () => {});
      take(/ (week by week|by week|each week|every week|over time|trend|trending|per week) /, () => { o.type = "line"; o.top = "5"; });
      take(/ pie( chart)? /, () => { o.type = "pie"; }) || take(/ (table|spreadsheet) /, () => { o.type = "table"; o.per = "total"; });
      const said = / share /.test(t); // "carry share": a share stat by that name beats "carries, as a share"
      take(/ (who gets|share|distribution|split|breakdown|usage) /, () => { o.per = "share"; });
      take(/ per (100 )?snaps? /, () => { o.per = "snap"; }) || take(/ per game /, () => { o.per = "game"; }) || take(/ (in )?totals? /, () => { o.per = "total"; });
      // "most drops" = the most first, even though fewer drops is better; "fewest", "lowest" = the least first; "worst" = the worst first
      const dir = take(/ (most|highest|biggest|leads?|leaders?) /, () => {}) ? "most" : take(/ (fewest|least|lowest) /, () => {}) ? "few" : take(/ (worst|bottom) /, () => {}) ? "worst" : "";
      take(/ rookies? /, () => { o.exp = "1"; }); take(/ undrafted /, () => { o.draft = "U"; });
      let ball = take(/ (the )?(ball|rock|touches) /, () => {});
      take(/ running backs? /, () => { o.pos = "RB"; });
      if (!o.pos) { const p = ASK_POS.find(([w]) => t.includes(w)); if (p) { o.pos = p[1]; t = t.replace(p[0], " "); } }
      // a team: full name, nickname or school, longest first ("washington state" before "washington"); abbreviations only in capitals ("WAS")
      const tn = Object.entries(D.teams).flatMap(([k, x]) => [[x[0], k], ...(league === "nfl" ? [[x[0].split(" ").at(-1), k], ...(CITY[x[0].split(" ").slice(0, -1).join(" ")] === 1 ? [[x[0].split(" ").slice(0, -1).join(" "), k]] : [])] : [])])
        .map(([n, k]) => [" " + norm(n) + " ", k]).sort((a, b) => b[0].length - a[0].length).find(([n]) => t.includes(n));
      if (tn) { o.team = tn[1]; t = t.replace(tn[0], " "); }
      else {
        // abbreviations: in capitals anywhere ("WAS"), and in lowercase too ("was drops", "phi sacks") unless it's a stat word.
        // Abbreviations that are also everyday words ("who was", "top ten") count only as the first or last word.
        const AB_WORDS = new Set(["was", "no", "min", "ten", "sea", "car", "den", "la", "ind", "all", "ball", "army", "navy", "miss", "tex", "ore", "wis", "ark", "kent", "rice", "tem", "tul", "buff"]);
        const lw = norm(raw).replace(/[?!.,;:]/g, " ").split(/\s+/).filter(Boolean);
        const stw = new Set([...vocabOf(statsFor("players", have)), ...vocabOf(statsFor("teams", have))]);
        const byAb = (w) => Object.keys(D.teams).find((x) => norm(D.teams[x][1] || "") === w);
        const caps = (raw.match(/\b[A-Z]{2,4}\b/g) || []).map(norm);
        const hit = [...caps, ...lw.filter((w, i) => (!AB_WORDS.has(w) || i === 0 || i === lw.length - 1) && !ASK_FILL.has(w) && !stw.has(qStem(QSYN[w] || w)))]
          .find((w) => byAb(w) && t.includes(" " + w + " "));
        if (hit) { o.team = byAb(hit); t = t.replace(" " + hit + " ", " "); }
      }
      const rest = t.split(" ").filter((w) => w && !ASK_FILL.has(w)).join(" ");
      if (/ (vs|versus|and|x) /.test(` ${rest} `)) return null; // two stats: the scatter suggestions handle it
      // "what team" / "which teams" = teams; any other "who" question is about players ("who on the commanders has the most drops")
      const teamQ = / (what|which) (teams?|offenses?|defenses?) /.test(lower);
      const wantP = !teamQ && o.scope !== "league" && (o.pos || o.exp || o.draft || o.per === "share" || o.per === "snap" || / (who|whos|players?|guys|receivers?|qbs?|backs?|rookies?) /.test(lower));
      const wantT = teamQ || o.scope === "league" || (!wantP && / (teams?|offenses?|defenses?) /.test(lower));
      const P1 = rest ? qBest(rest, "players")[0] : null, T1 = rest ? qBest(rest, "teams")[0] : null;
      // a team named with no player words ("chiefs points per game") means the team, unless the player stat fits clearly better
      const w = wantT ? "teams" : wantP ? "players" : (T1?.[1] || 0) > (P1?.[1] || 0) + (o.team ? -0.01 : 0.05) ? "teams" : P1 || ball ? "players" : T1 ? "teams" : null;
      let s = (w === "players" ? P1 : T1)?.[0];
      const named = said && w === "players" && rest ? qBest(rest + " share", "players")[0] : null;
      if (named && /share/i.test(named[0][1]) && named[1] >= 0.9) { s = named[0]; delete o.per; }
      if (!s && ball && w === "players") s = statsFor("players", have).flatMap(([, l]) => l).find((x) => x[0] === "touches");
      if (!s || (!plain && !Object.keys(o).length && !ball && rest === lower.trim())) return null; // nothing beyond a plain stat name: the stat itself is listed
      const patch = { ...o, who: w, stat: s[0] };
      if (patch.from === "first") { patch.from = String(w === "players" ? Math.max(idx.players?.[league] || 0, (idx[league] || [])[0]) : (idx[league] || [])[0]); patch.to = String((idx[league] || []).at(-1)); }
      if (patch.from && !patch.to) patch.to = String((idx[league] || []).at(-1));
      // "most drops" = season totals, not one big game
      if (!patch.per && s[3].count && patch.type !== "line") patch.per = "total";
      // "fewest drops" means among players who get thrown to, not QBs and kickers with 0: only count players with real volume
      if (dir === "few" && s[3].low && s[3].vol && w === "players") {
        const yrs = Math.max(1, (+patch.to || +st.to || 0) - (+patch.from || +st.from || 0) + 1);
        patch.where = `${s[3].vol[0]} >= ${s[3].vol[1] * yrs}`;
      }
      if (dir === "worst" || (dir === "most" && s[3].low) || (dir === "few" && !s[3].low)) patch.order = "worst";
      if (patch.per === "share" && !(s[3].count && w === "players")) delete patch.per;
      if (w === "teams" && patch.team) { patch.pick = patch.team; delete patch.team; }
      if (w === "teams") { delete patch.pos; delete patch.exp; delete patch.draft; }
      if (s[3].split && patch.per === "share") patch.per = "total"; // a breakdown is already split up: "who gets flagged for what"
      if (patch.team && !patch.top) patch.top = s[3].split ? "25" : "10";
      const label = [`${s[1]}${patch.per === "share" ? " (share of team)" : patch.per === "snap" ? " per 100 snaps" : ""}`,
        patch.team ? `${D.teams[patch.team][0]} players` : patch.pick ? `highlight ${D.teams[patch.pick][0]}` : patch.pos ? posOpts.find(([k]) => k === patch.pos)?.[1] : "",
        patch.exp ? "rookies" : "", patch.draft ? "undrafted" : "", patch.opp ? OPP.find(([k]) => k === patch.opp)[1].toLowerCase() : "",
        patch.last ? `last ${patch.last} games` : "", patch.scope === "league" ? `${league === "nfl" ? "NFL" : "FBS"}-wide by season` : patch.type === "line" ? "week by week" : patch.type ? `${patch.type} chart` : "", patch.order === "worst" ? (s[3].low ? "most first" : "lowest first") : "", patch.where ? `${patch.where.replace(" >=", "")}+` : "", patch.from ? (patch.from === patch.to ? patch.from : `${patch.from}–${patch.to}`) : ""].filter(Boolean).join(" · ");
      const note = o.from === "first" && w === "players" && idx.players?.[league] > (idx[league] || [])[0] ? ` (player stats start in ${idx.players[league]})` : "";
      // some words matched no stat at all ("punt return yards"): it's a guess, so say so
      const voc = vocabOf(statsFor(w, have)), unknown = qTok(rest).filter((x) => /^[a-z]{3,}$/.test(x) && !ASK_SKIP.has(x) && !voc.has(x) && ![...voc].some((v) => v.startsWith(x)));
      return [label + note, unknown.length ? `Closest match (no stat for “${unknown.join(" ")}”)` : "Your question", "", () => { st = { ...DEF, from: patch.from || st.from, to: patch.to || st.to, mode: st.mode, ...patch }; reload(); }];
    };
    const EXAMPLES = league === "nfl"
      ? ["who gets the targets on Washington", "QBs vs cupcakes EPA per dropback", "carry share last 3 games", "rookies tackles", "sacks vs pressures", "passer rating over the middle"]
      : ["who gets the catches on Washington", "points per game vs cupcakes", "carry share", "passing efficiency vs top half defenses", "sacks vs tackles for loss"];
    const qPair = (q) => {
      if (OP_RE.test(q.split(/\s+or\s+|\s*,\s*|\s+and\s+|\s*&&?\s*/i)[0].trim()) || /\d/.test(q) && /[<>≥≤]|at least|at most|more than|less than|over|under/i.test(q)) {
        const tryWho = (w) => { const p = parseWhere(q, w, statsFor(w, have), D.teams, confs); return p.groups.length && !p.bad.length ? p : null; };
        const w = tryWho(st.who) ? st.who : tryWho(st.who === "players" ? "teams" : "players") ? (st.who === "players" ? "teams" : "players") : null;
        if (!w) return { hits: [], note: `Couldn't read all of that as a filter. Try “run stops > 20 and sacks >= 3”.` };
        const p = tryWho(w);
        return { hits: [[`Table of ${w} where ${p.read.join(" or ")}`, "Table · filter", "", () => {
          setWho(w); st.type = "table"; st.where = q; st.per = "total"; st.cols = "";
          const s1 = p.groups.flat().find((c) => c.k === "stat"); if (s1) { st.stat = s1.s[0]; st.order = s1.op === "<" || s1.op === "≤" ? "worst" : "best"; }
          redo(); }]], note: "" };
      }
      const parts =q.split(/\s+(?:and|vs\.?|versus|against|x)\s+|\s*(?:&|,)\s*/i).map((s) => s.trim()).filter(Boolean);
      if (parts.length !== 2) return null;
      const out = [], miss = {};
      for (const w of st.who === "teams" ? ["teams", "players"] : ["players", "teams"]) {
        // a part of the field on one side carries over to the other when that stat has one: "throws to the middle vs completion %"
        // = completion % to the middle, not completion % on every throw
        const zone = parts.map((p) => (p.match(/\b((deep|short|intermediate) )?(left|middle|right)\b|\b(deep|short|intermediate)\b/) || [])[0]);
        const side = (i) => {
          const base = qBest(parts[i], w), z = zone[1 - i];
          if (zone[i] || !z) return base;
          // the same part of the field exactly: "deep" is deep, not deep left
          const ZW = ["deep", "short", "intermediate", "left", "middle", "right"], want = z.split(" ").sort().join();
          const hit = qBest(`${parts[i]} ${z}`, w).find((x) => qTok(x[0][1]).filter((t) => ZW.includes(t)).sort().join() === want);
          return hit ? [[hit[0], hit[1] + 0.5], ...base.filter((x) => x[0] !== hit[0])] : base;
        };
        const A = side(0), B = side(1);
        miss[w] = [A[0]?.[0], B[0]?.[0]];
        for (const a of A.slice(0, 2)) for (const b of B.slice(0, 2)) if (a[0][0] !== b[0][0])
          out.push([a[1] + b[1], [`${a[0][1]} vs ${b[0][1]}`, `Scatter · ${w === "players" ? "players" : "teams"}`, "", () => {
            setWho(w); st.type = "scatter"; st.stat = a[0][0]; st.y = b[0][0]; st.min = ""; st.radar = ""; st.top = "all"; redo(); }]]);
      }
      // nothing on the same side: say which stat is a player stat and which is a team stat
      const half = (w) => miss[w].map((x, i) => x && [parts[i], x[1], w]).filter(Boolean);
      const note = out.length ? "" : [...half("players"), ...half("teams")].length < 2 ? ""
        : `Can't chart these together: ${[0, 1].map((i) => { const p = miss.players[i], t = miss.teams[i]; return p && !t ? `“${parts[i]}” is a player stat (${p[1]})` : t && !p ? `“${parts[i]}” is a team stat (${t[1]})` : `“${parts[i]}” is ${p ? p[1] : "?"}`; }).join(" and ")}. A scatter needs two player stats or two team stats.`;
      return { hits: out.sort((a, b) => b[0] - a[0]).slice(0, 4).map((x) => x[1]), note };
    };
    let qHits = [], qCur = -1;
    const qShow = () => {
      const raw = qbox.value.trim(), cfbT = league === "cfb" && /target/i.test(raw), q = cfbT ? norm(raw).replace(/targets?/g, "catch") : norm(raw);
      if (q.length < 2) {
        if (raw || document.activeElement !== qbox) { qs.hidden = true; qHits = []; return; }
        qHits = EXAMPLES.map((x) => [x, "Try asking", "", () => { qbox.value = x; qShow(); if (qHits[0]) qPick(qHits[0]); }]); qCur = -1;
        qs.innerHTML = `<p class="muted">Ask in plain words: a stat, plus a team, position, “vs cupcakes”, “last 3 games”, “week by week”…</p>` + qHits.map((it, i) => `<button type="button" data-i="${i}">${esc(it[0])} <small>${esc(it[1])}</small></button>`).join("");
        qs.hidden = false; return;
      }
      const words = q.split(/\s+/), pair = qPair(raw);
      const qt = qTok(q).filter((w) => !/^(and|vs|versus|against|x|&)$/.test(w)), extraW = (l) => qTok(l.replace(/\(.*?\)/g, " ")).filter((t) => !qt.includes(t)).length, whole =(it) => { const lt = new Set(qTok(it[0])); return qt.length && qt.every((w) => lt.has(w)); };
      const one = qItems().map((it) => [it, norm(it[0]), norm(`${it[0]} ${it[1]} ${it[2]}`)]).filter(([it, , all]) => words.every((w) => all.includes(w)) || whole(it))
        // whole words beat parts of words ("drop rate" is Drop %, not "sack rate ... dropbacks")
        .map(([it, l]) => [it, l.startsWith(q) ? 0 : whole(it) ? 0.5 : words.filter((w) => !/^(and|vs|versus|against|x|&)$/.test(w)).every((w) => l.includes(w)) ? 1 : 2])
        // ties: fewest name words you didn't type (outside the brackets), then the shorter name
        .sort((a, b) => a[1] - b[1] || (a[1] === 0.5 ? extraW(a[0][0]) - extraW(b[0][0]) || a[0][0].length - b[0][0].length : 0)).slice(0, 12);
      // a single item named by everything typed comes first, then the two-stat scatters, then looser single matches
      const asked = ask(raw, !one.some((x) => x[1] < 2));
      // two stats ("drops vs targets"): the scatter comes before single stats that merely contain both words; only an exact name beats it
      const cut = pair?.hits?.length ? 0.5 : 2;
      qHits = [...plFind(words), ...(asked ? [asked] : []), ...one.filter((x) => x[1] < cut || (x[1] < 2 && x[0][1] === "Preset" && / vs /.test(x[0][0]))).map((x) => x[0]), ...(pair?.hits || []),
        ...one.filter((x) => x[1] >= cut && !(x[1] < 2 && x[0][1] === "Preset" && / vs /.test(x[0][0]))).map((x) => x[0])];
      // nothing at all: drop one word at a time and offer what the rest of the question finds
      if (!qHits.length && words.length > 1) {
        const seen = new Set();
        for (let i = 0; i < words.length && qHits.length < 3; i++) {
          const near = ask(raw.split(/\s+/).filter((_, j) => j !== i).join(" "));
          if (near && !seen.has(near[0])) { seen.add(near[0]); qHits.push([near[0], "Closest match", "", near[3]]); }
        }
        // still nothing: any stat or preset named by one of the words ("jsn blorp drops" finds Drops)
        for (const w of words.filter((x) => x.length > 2 && !ASK_FILL.has(x))) for (const it of qItems()) {
          if (qHits.length >= 3) break;
          if (norm(it[0]).split(/\s+/).some((x) => x.startsWith(w) || x.startsWith(QSYN[w] || "~")) && !seen.has(it[0])) { seen.add(it[0]); qHits.push([it[0], "Closest match", "", it[3]]); }
        }
      }
      qCur = -1;
      qs.innerHTML = (cfbT ? `<p class="muted">College stats don't track targets, so these use catches.</p>` : "") + (pair?.note ? `<p class="muted">${esc(pair.note)}</p>` : "") + qHits.map((it, i) => `<button type="button" data-i="${i}">${esc(it[0])} <small>${esc(it[1])}</small></button>`).join("")
        || `<p class="muted">Nothing matches “${esc(raw)}”. To compare two stats, put “and” or “vs” between them.</p>`;
      qs.hidden = false;
    };
    const qPick = (it) => { if (it) { qbox.value = ""; qs.hidden = true; it[3](); } };
    qbox.oninput = qShow;
    qbox.onfocus = qShow;
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
      if (chosen) { st = { ...DEF, from: st.from, to: st.to, mode: st.mode, ...chosen }; reload(); }
    };
    const form = document.getElementById("vz-saveform"), nm = document.getElementById("vz-pname");
    document.getElementById("vz-save").onclick = () => { form.classList.remove("hidden"); nm.value = (st.ttl || title).slice(0, 40); nm.focus(); nm.select(); };
    document.getElementById("vz-pno").onclick = () => form.classList.add("hidden");
    // what the chart shows and who it's about, for sorting My charts: the highlighted ones (or the top 3 when nobody is),
    // and the team filter (or those players' teams)
    const onChart = () => {
      const mark = [...new Set([...picks, ...(st.pl ? [st.pl] : [])])].filter((k) => agg[k]);
      const ks = whole ? [] : mark.length ? mark : rank(stat, qualify(stat)).slice(0, 3);
      const teams = [...new Set((who === "players" && st.team ? [st.team] : ks.map(teamOf)).filter(Boolean).map((k) => tm(k)[0]))].slice(0, 6);
      return { what: st.type === "scatter" ? `${stat[1]} vs ${ystat[1]}` : st.type === "radar" ? `${lgTxt} ${who} radar` : stat[1], teams, players: who === "players" ? ks.map(name).slice(0, 6) : [] };
    };
    const doSave = () => {
      const name = nm.value.trim();
      if (!name) return nm.focus();
      const all = mine(), list = (all[league] || []).filter((m) => m.name !== name); // same name: replace it
      const keep = Object.fromEntries(Object.entries(st).filter(([k, v]) => v !== "" && v !== DEF[k] && k !== "mode"));
      list.unshift({ name, st: keep, at: new Date().toISOString(), ...onChart() });
      all[league] = list.slice(0, 30);
      saveMine(all);
      // the little picture: this device only
      const cv = document.getElementById("vz-chart");
      if (cv) try {
        // 16:9, not squashed: a tall chart keeps its top (the leaders), a wide one its middle
        const t = document.createElement("canvas"); t.width = 320; t.height = 180;
        const sw = Math.min(cv.width, (cv.height * 16) / 9), sh = (sw * 9) / 16;
        const x = t.getContext("2d"); x.fillStyle = C("--card") || "#111"; x.fillRect(0, 0, t.width, t.height); x.drawImage(cv, (cv.width - sw) / 2, 0, sw, sh, 0, 0, t.width, t.height);
        const tb = thumbs(), kept = new Set(all[league].map((m) => m.name));
        tb[league] = Object.fromEntries(Object.entries({ ...(tb[league] || {}), [name]: t.toDataURL("image/jpeg", 0.72) }).filter(([n]) => kept.has(n)));
        saveThumbs(tb);
      } catch {}
      const signed = typeof Account !== "undefined" && Account.user();
      redo();
      const m = document.getElementById("vz-pmsg");
      if (m) m.textContent = signed ? `Saved “${name}” to My charts (your account).` : `Saved “${name}” to My charts on this device. Sign in (Settings) to keep it on every device.`;
    };
    document.getElementById("vz-pok").onclick = doSave;
    nm.onkeydown = (e) => { if (e.key === "Enter") doSave(); else if (e.key === "Escape") form.classList.add("hidden"); };
    // My charts: open, sort, find, open one, delete one (tap ✕ twice)
    document.getElementById("vz-mine").onclick = () => { mineOpen = !mineOpen; redo(); if (mineOpen) document.querySelector(".vz-mine")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
    const mp = el.querySelector(".vz-mine");
    if (mp) {
      document.getElementById("vz-mx").onclick = () => { mineOpen = false; redo(); };
      document.getElementById("vz-msort").onchange = (e) => { mineSort = e.target.value; redo(); };
      const mq = document.getElementById("vz-mq");
      mq.oninput = () => { mineQ = mq.value; const at = mq.selectionStart; redo(); const n = document.getElementById("vz-mq"); n.focus(); n.setSelectionRange(at, at); };
      mp.onclick = (e) => {
        const o = e.target.closest("[data-mo]"), d = e.target.closest("[data-md]");
        if (o) { const m = myList[+o.dataset.mo]; if (m) { mineOpen = false; st = { ...DEF, from: st.from, to: st.to, mode: st.mode, ...m.st }; reload(); window.scrollTo({ top: 0 }); } }
        else if (d) {
          if (!d.classList.contains("sure")) { d.classList.add("sure"); d.textContent = "Delete?"; return; }
          const all = mine(), gone = (all[league] || [])[+d.dataset.md];
          all[league] = (all[league] || []).filter((_, i) => i !== +d.dataset.md); saveMine(all);
          const tb = thumbs(); if (gone && tb[league]) { delete tb[league][gone.name]; saveThumbs(tb); }
          redo();
        }
      };
    }
    document.getElementById("vz-reset").onclick = () => { st = { ...DEF, mode: st.mode }; reload(); };
    // Simple / Advanced, Edit, the steps (phone tabs, closing a step on a computer), filter chips, Related and More to explore
    el.querySelector("#vz-mode").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.mode = b.dataset.v; store.set("viz-mode", st.mode); redo(); };
    const eb = document.getElementById("vz-edit");
    if (eb) eb.onclick = () => { editOpen = !editOpen; el.querySelector(".vz-editbox").hidden = !editOpen; eb.textContent = editOpen ? "Done ▴" : "Edit ▾"; eb.setAttribute("aria-expanded", editOpen); };
    el.querySelectorAll(".vz-sh").forEach((h) => h.onclick = () => { const n = +h.dataset.step; shut[n] = !shut[n]; h.parentElement.toggleAttribute("data-shut", !!shut[n]); });
    el.querySelectorAll(".vz-steptabs button").forEach((b) => b.onclick = () => {
      stepOn = +b.dataset.tab; el.querySelector(".vz-steps").dataset.on = stepOn;
      el.querySelectorAll(".vz-steptabs button").forEach((x) => x.classList.toggle("on", x === b));
    });
    el.querySelectorAll("[data-chip]").forEach((b) => b.onclick = () => {
      const c = b.dataset.chip;
      (c === "all" ? chips : [chips[+c]]).forEach(([, p]) => Object.assign(st, p));
      if (c === "all") st.pick = "";
      redo();
    });
    el.querySelectorAll("[data-rel]").forEach((b) => b.onclick = () => { const p = related[+b.dataset.rel][1]; if (p.stat && p.stat !== st.stat) st.min = ""; Object.assign(st, p); redo(); });
    el.querySelectorAll("[data-topic]").forEach((b) => b.onclick = () => { const x = PRESETS[league][topics[+b.dataset.topic][1][1]]; if (x) { st = { ...DEF, from: st.from, to: st.to, mode: st.mode, ...x[1] }; reload(); } });
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
        st.type === "bar" && !whole && `${st.order === "worst" ? "Worst" : "Top"} ${top}`,
        whole ? `${st.group || "whole league"}, one ${st.type} per season` : (st.type === "line" || st.type === "radar" || st.type === "pie") && !picks.length && `Top ${top}`,
        picks.length && `Highlighted: ${picks.map(name).join(", ")}`,
        st.noexit && "games left by halftime left out",
        whereRead && `Filter: ${whereRead}`,
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
    // Style > Picture: Dark (the card color), Light (white, dark text: the chart is redrawn in light colors for a moment)
    // or See-through (no background, for dark posts); size: as on screen, or a fixed shape (the chart is laid out at that shape)
    function recolor() {
      const o = chart.options;
      for (const sc of Object.values(o.scales || {})) {
        if (sc.ticks) sc.ticks.color = muted; if (sc.grid) sc.grid.color = line; if (sc.title) sc.title.color = muted;
        if (sc.pointLabels) sc.pointLabels.color = ink; if (sc.angleLines) sc.angleLines.color = line;
      }
      if (o.plugins?.legend?.labels) o.plugins.legend.labels.color = ink;
      chart.update("none");
    }
    async function picture() {
      const SIZES = { x: [1600, 900, 800], sq: [1350, 1350, 640], story: [1080, 1920, 420] }; // pixels wide, high, and the width it's laid out at
      const size = SIZES[st.size], cv = document.getElementById("vz-chart"), box = cv.parentElement;
      const was = [ink, muted, line, box.style.width, box.style.height];
      if (st.bg === "light") { ink = "#141414"; muted = "#5c5c5c"; line = "#e4e4e4"; recolor(); }
      const W = size ? size[0] : cv.width + 2 * 24 * (cv.width / cv.clientWidth), sc = size ? size[0] / size[2] : cv.width / cv.clientWidth, pad = 24 * sc;
      const probe = document.createElement("canvas").getContext("2d"), font = (w, n) => `${w} ${n * sc}px JetBrains Mono, monospace`;
      probe.font = font(700, 18); const tl = wrap(probe, title, W - 2 * pad);
      probe.font = font(400, 12); const sl = wrap(probe, sub, W - 2 * pad);
      probe.font = font(400, 10); const fine = wrap(probe, synopsis(), W - 2 * pad);
      const top = (70 + (tl.length - 1) * 24 + (sl.length - 1) * 17) * sc, bot = (34 + fine.length * 14 + 6) * sc;
      if (size) { box.style.width = `${(W - 2 * pad) / sc}px`; box.style.height = `${Math.max(120, (size[1] - top - bot) / sc)}px`; chart.resize(); chart.update("none"); }
      const cw = W - 2 * pad, ch = size ? size[1] - top - bot : cv.height;
      const out = document.createElement("canvas"); out.width = W; out.height = size ? size[1] : ch + top + bot;
      const x = out.getContext("2d");
      if (st.bg !== "clear") { x.fillStyle = st.bg === "light" ? "#ffffff" : C("--card") || "#111"; x.fillRect(0, 0, out.width, out.height); }
      x.fillStyle = accent; x.fillRect(0, 0, out.width, 4 * sc);
      x.fillStyle = ink; x.font = font(700, 18); tl.forEach((t, i) => x.fillText(t, pad, (34 + i * 24) * sc));
      x.fillStyle = muted; x.font = font(400, 12); sl.forEach((t, i) => x.fillText(t, pad, (54 + (tl.length - 1) * 24 + i * 17) * sc));
      x.drawImage(cv, pad, top, cw, ch);
      x.fillStyle = muted; x.font = font(400, 10);
      fine.forEach((t, i) => x.fillText(t, pad, top + ch + 16 * sc + i * 14 * sc));
      x.fillStyle = accent; x.font = font(700, 12); x.fillText("CUPCAKE_INDEX", pad, out.height - 12 * sc);
      x.fillStyle = muted; x.font = font(400, 11); x.textAlign = "right";
      x.fillText(`cupcakeindex.com · ${league === "nfl" ? "data: nflverse" : "data: CollegeFootballData.com"}`, out.width - pad, out.height - 12 * sc);
      // put the chart on the page back the way it was
      [ink, muted, line] = was;
      if (size) { box.style.width = was[3]; box.style.height = was[4]; chart.resize(); }
      if (st.bg === "light" || size) recolor();
      return out;
    }
  }

  // ---------------------------------------------------------------- Team pages > At a glance (live.js)
  // Four small charts from the same files as Visualize, this season: who gets the targets (college: catches), who gets the
  // carries, points scored vs allowed by week, and where the team ranks. Each one opens in Visualize to change anything.
  async function glance(lg, id, el) {
    idx = idx || await getJSON("data/viz/index.json").catch(() => ({}));
    const season = (idx[lg] || []).at(-1), D = season && await file(season, lg), k = `${lg}:${id}`;
    if (!D || !D.trows.some((r) => r[0] === k)) { el.innerHTML = `<p class="muted">No stats for this team yet this season.</p>`; return; }
    const viz = (o) => `#/stats?${new URLSearchParams({ league: lg, show: "visualize", ...o })}`;
    const open = (o) => `<a class="gl-open" href="${viz(o)}">Open in Visualize →</a>`;
    const col = (c) => D.pcols.indexOf(c) + 3;
    const shares = (c) => { // [[player, total]...] on this team, and the team's total
      const by = {}; let tot = 0;
      for (const r of D.prows) if (r[2] === k) { const v = r[col(c)] || 0; by[r[0]] = (by[r[0]] || 0) + v; tot += v; }
      return [Object.entries(by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]), tot];
    };
    const bars = ([list, tot], unit, cls = "") => {
      const top = list[0]?.[1] || 1;
      return list.slice(0, 5).map(([p, v]) => { const m = D.pmeta[p] || [p, ""];
        return `<div class="gl-bar"><span class="gl-name" title="${esc(m[0])}"><a href="#/player/${esc(p)}?league=${lg}">${esc(m[0])}</a> <small class="muted">${esc(m[3] || m[1] || "")}</small></span>
          <span class="gl-track"><i class="${cls}" style="width:${(100 * v / top).toFixed(1)}%"></i></span><span class="gl-num"><b>${Math.round(100 * v / tot)}%</b> <small class="muted">${v}</small></span></div>`; }).join("")
        + `<p class="muted gl-foot">${tot} team ${unit}, ${D.season}</p>`;
    };
    const tg = D.league === "nfl" && shares("targets")[1] ? "targets" : "rec";
    const games = D.trows.filter((r) => r[0] === k).sort((a, b) => a[1] - b[1]);
    // points scored vs allowed, week by week (SVG, both themes through CSS colors)
    const W = Math.round(Math.min(560, Math.max(300, (el.clientWidth || 600) / 2 - 40))), H = 190, pad = 30, top = Math.max(10, ...games.flatMap((r) => [r[3], r[4]])) * 1.15;
    const x = (i) => pad + (games.length > 1 ? (i * (W - 2 * pad)) / (games.length - 1) : (W - 2 * pad) / 2), y = (v) => H - pad - (v * (H - 2 * pad)) / top;
    const tm = (t) => D.teams[t]?.[1] || "";
    const line = (j, cls) => `<polyline class="${cls}" points="${games.map((r, i) => `${x(i).toFixed(0)},${y(r[j]).toFixed(0)}`).join(" ")}"/>`
      + games.map((r, i) => `<circle class="${cls}" cx="${x(i).toFixed(0)}" cy="${y(r[j]).toFixed(0)}" r="4"><title>Week ${r[1]} vs ${esc(tm(r[2]))}: ${r[3]}-${r[4]}</title></circle>`
        + `<text class="${cls}" x="${x(i).toFixed(0)}" y="${(y(r[j]) + (r[j] >= r[7 - j] ? -9 : 17)).toFixed(0)}">${r[j]}</text>`).join("");
    const svg = `<svg class="gl-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Points scored and allowed by week">
      ${[0, 0.5, 1].map((f) => `<line class="gl-grid" x1="${pad}" x2="${W - pad}" y1="${y(top * f / 1.15).toFixed(0)}" y2="${y(top * f / 1.15).toFixed(0)}"/>`).join("")}
      ${line(4, "gl-against")}${line(3, "gl-for")}
      ${games.map((r, i) => `<text class="gl-wk" x="${x(i).toFixed(0)}" y="${H - 8}">${D.bowls && r[1] >= D.bowls ? "Bowl" : `Wk ${r[1]}`}</text>`).join("")}</svg>`;
    // where they rank (per game, among every team with a game this season)
    const saved = st; st = { ...DEF }; // sum() reads the Visualize settings (halftime exits, opponents, last N)
    const TS = sum(D, "teams", 1, 99);
    st = saved;
    const n = Object.keys(TS).length, statOf = (key) => T.flatMap(([, l]) => l).find((s) => s[0] === key);
    const ranks = [["pts", "Points / game"], ["opp_pts", "Allowed / game"], ["epa_play", "Offense EPA"], ["def_epa_play", "Defense EPA"]].map(([key, label]) => {
      const s = statOf(key), v = (t) => value(s, TS[t].S, TS[t].g, "game");
      const order = Object.keys(TS).filter((t) => v(t) != null).sort((a, b) => (s[3].low ? 1 : -1) * (v(a) - v(b)));
      const r = order.indexOf(k) + 1;
      return r ? `<div class="gl-bar"><span class="gl-name">${label} <small class="muted">${fmt({ 3: { ...s[3], d: s[3].count ? 1 : s[3].d } }, v(k), "total")}</small></span>
        <span class="gl-track"><i class="${r <= n / 2 ? "" : "gl-low"}" style="width:${(100 * (n - r + 1) / n).toFixed(1)}%"></i></span><span class="gl-num"><b>#${r}</b> <small class="muted">of ${order.length}</small></span></div>` : "";
    }).join("");
    el.innerHTML = `<div class="gl-grid2">
      <section class="gl-card"><h3>Who gets the ${tg === "targets" ? "targets" : "catches"}</h3>${bars(shares(tg), tg === "targets" ? "targets" : "catches")}${open({ who: "players", type: "bar", stat: tg === "targets" ? "tgt_share" : "rec_share", team: k, top: "10" })}</section>
      <section class="gl-card"><h3>Who gets the carries</h3>${bars(shares("carries"), "carries", "gl-alt")}${open({ who: "players", type: "bar", stat: "carry_share", team: k, top: "10" })}</section>
      <section class="gl-card"><h3>Points scored vs allowed</h3><p class="gl-key"><span class="gl-for">━ scored</span> <span class="gl-against">━ allowed</span></p>${svg}${open({ who: "teams", type: "line", stat: "pts", pick: k })}</section>
      <section class="gl-card"><h3>Where they rank</h3><p class="muted gl-foot">${D.league === "nfl" ? "NFL" : "FBS"} rank this season, 1 = best. Longer bar = better.</p>${ranks}${open({ who: "teams", type: "bar", stat: "net_epa", top: "all", pick: k })}</section>
    </div><p class="note">From the same play-by-play numbers as Stats &gt; Visualize${D.league === "cfb" ? " (college doesn't track targets, so catches stand in)" : ""}. Shares here are of the team's whole ${D.season} total; Visualize's "Share of team" counts only the games each player played.</p>`;
  }

  return { render, glance };
})();
