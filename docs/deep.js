// Stats > Deep cuts (NFL): super specific player stats, like run stops by rookie linebackers.
// Data: docs/data/deep/nfl_<season>.json (src/deep_stats.py, weekly, from nflverse play-by-play): season totals per player.
// A "stop" = the offense failed on that play (under 40% of the yards needed on 1st down, 60% on 2nd, no conversion on 3rd/4th).
// Every setting lives in the link, so a list can be shared.
const Deep = (() => {
  const files = new Map();
  let idx = null;
  const div = (a, b) => (b ? a / b : null);
  const DEF = { dstat: "run_stop", role: "LB", exp: "1", draft: "", dteam: "", order: "best", dseason: "" };

  // [key, label, value(S), opts]  opts: pct, d (decimals), low (lower is better), q: [column, per week] to qualify for a rate,
  // ctx: related columns shown next to it, side: "d" (defense) or "o" (offense), roles: who it's for, how: what it means
  const C = {   // context columns: [label, value(S), decimals]
    snaps: ["Snaps", (S) => S.d_snaps], osnaps: ["Snaps", (S) => S.o_snaps], g: ["G", (S) => S.games],
    tkl: ["Tkl", (S) => S.tkl], run_tkl: ["Run tkl", (S) => S.run_tkl], run_stop: ["Run stops", (S) => S.run_stop], stuff: ["Stuffs", (S) => S.stuff],
    sacks: ["Sacks", (S) => S.sacks], hits: ["QB hits", (S) => S.qb_hits], tfl: ["TFL", (S) => S.tfl], pd: ["PD", (S) => S.pd], ints: ["INT", (S) => S.ints],
    car: ["Car", (S) => S.carries], ryds: ["Rush yds", (S) => S.rush_yds], ypc: ["YPC", (S) => div(S.rush_yds, S.carries), 1], rtd: ["Rush TD", (S) => S.rush_td],
    tgt: ["Tgt", (S) => S.targets], rec: ["Rec", (S) => S.rec], recyds: ["Rec yds", (S) => S.rec_yds], rectd: ["Rec TD", (S) => S.rec_td],
    att: ["Att", (S) => S.att], db: ["Dropbacks", (S) => S.dropbacks], pyds: ["Pass yds", (S) => S.pass_yds], ptd: ["Pass TD", (S) => S.pass_td],
  };
  const G = [
    ["Run defense", "d", ["LB", "IDL", "EDGE", "S"], [
      ["run_stop", "Run stops", (S) => S.run_stop, { ctx: ["run_tkl", "stuff", "snaps"], how: "Tackles on runs where the offense failed (short of 40% of the yards needed on 1st down, 60% on 2nd, no conversion on 3rd/4th)." }],
      ["run_stop_rate", "Run stops per 100 snaps", (S) => div(100 * S.run_stop, S.d_snaps), { d: 1, q: ["d_snaps", 15], ctx: ["run_stop", "snaps", "g"], how: "Run stops for every 100 defensive snaps, so part-timers and starters compare fairly." }],
      ["stop_pct", "Stop % of run tackles", (S) => div(100 * S.run_stop, S.run_tkl), { pct: 1, q: ["run_tkl", 1.5], ctx: ["run_stop", "run_tkl", "snaps"], how: "How many of his run tackles were stops. High = he's making plays near the line, not 8 yards downfield." }],
      ["stuff", "Stuffs (run tackles at or behind the line)", (S) => S.stuff, { ctx: ["run_tkl", "tfl", "snaps"], how: "Tackles on runs that gained 0 yards or lost yards." }],
      ["run_depth", "Avg gain on his run tackles", (S) => div(S.run_tkl_yds, S.run_tkl), { d: 1, low: 1, q: ["run_tkl", 1.5], ctx: ["run_tkl", "run_stop", "snaps"], how: "How far the runner got before he brought him down. Lower is better." }],
      ["sy_stop", "Short-yardage stops", (S) => S.sy_stop, { ctx: ["run_tkl", "run_stop", "snaps"], how: "Tackles that stopped a run on 3rd or 4th down with 2 yards or less to go." }],
    ]],
    ["Pass rush", "d", ["EDGE", "IDL", "LB"], [
      ["sacks", "Sacks", (S) => S.sacks, { ctx: ["hits", "tfl", "snaps"], how: "Half sacks count as half." }],
      ["sack_rate", "Sacks per 100 snaps", (S) => div(100 * S.sacks, S.d_snaps), { d: 1, q: ["d_snaps", 15], ctx: ["sacks", "snaps", "g"], how: "Sacks for every 100 defensive snaps." }],
      ["third_sacks", "Drive-killing sacks (3rd/4th down)", (S) => S.third_sacks, { ctx: ["sacks", "hits", "snaps"], how: "Sacks on 3rd or 4th down, which usually end the drive." }],
      ["heat", "Sacks + QB hits", (S) => S.sacks + S.qb_hits, { ctx: ["sacks", "hits", "snaps"], how: "Sacks plus hits on the quarterback (the free data has no pressures, so this is the closest)." }],
      ["tfl", "Tackles for loss", (S) => S.tfl, { ctx: ["sacks", "stuff", "snaps"], how: "Tackles behind the line, runs or passes." }],
    ]],
    ["Coverage and takeaways", "d", ["CB", "S", "LB"], [
      ["ball", "Ball production (INT + PD)", (S) => S.ints + S.pd, { ctx: ["ints", "pd", "snaps"], how: "Interceptions plus passes defended." }],
      ["pass_stop", "Pass stops", (S) => S.pass_stop, { ctx: ["tkl", "pd", "snaps"], how: "Tackled a catch before it became a successful play (short of the sticks on 3rd, and so on)." }],
      ["third_stop", "3rd/4th-down stops", (S) => S.third_stop, { ctx: ["tkl", "run_stop", "snaps"], how: "Tackles on 3rd or 4th down that left the offense short. Usually forces a punt or a turnover on downs." }],
      ["rz_stop", "Red-zone stops", (S) => S.rz_stop, { ctx: ["tkl", "run_stop", "snaps"], how: "Stops inside his own 20-yard line." }],
      ["takeaways", "Takeaways (INT + forced fumbles)", (S) => S.ints + S.ff, { ctx: ["ints", "pd", "snaps"], how: "Interceptions plus forced fumbles." }],
      ["tkl", "Tackles", (S) => S.tkl, { ctx: ["run_tkl", "snaps", "g"], how: "Plays where he made or helped make the tackle." }],
    ]],
    ["Running", "o", ["RB", "QB", "WR"], [
      ["succ", "Run success %", (S) => div(100 * S.rush_succ, S.carries), { pct: 1, q: ["carries", 6], ctx: ["car", "ypc", "ryds"], how: "The opposite of a run stop: carries that gained 40% of the yards needed on 1st, 60% on 2nd, or converted on 3rd/4th." }],
      ["stuffed", "Stuffed % (0 or fewer yards)", (S) => div(100 * S.rush_stuffed, S.carries), { pct: 1, low: 1, q: ["carries", 6], ctx: ["car", "ypc", "ryds"], how: "Share of carries that went nowhere. Lower is better (part of that is the blocking)." }],
      ["rush_10", "Explosive runs (10+ yards)", (S) => S.rush_10, { ctx: ["car", "ypc", "ryds"], how: "Carries of 10 yards or more." }],
      ["boom", "Explosive run rate", (S) => div(100 * S.rush_10, S.carries), { pct: 1, q: ["carries", 6], ctx: ["car", "ypc", "ryds"], how: "Share of carries that went 10+ yards." }],
      ["sy_conv", "Short-yardage conversion %", (S) => div(100 * S.sy_conv, S.sy_carries), { pct: 1, q: ["sy_carries", 0.5], ctx: ["car", "ypc", "rtd"], extra: [["3rd/4th & short", (S) => S.sy_carries]], how: "Carries on 3rd or 4th down with 2 or fewer yards to go that moved the chains." }],
      ["gl_carries", "Goal-line carries (inside the 5)", (S) => S.gl_carries, { ctx: ["car", "rtd", "ryds"], extra: [["GL TDs", (S) => S.gl_td]], how: "Carries starting inside the opponent's 5-yard line." }],
      ["epa_rush", "EPA per carry", (S) => div(S.rush_epa, S.carries), { d: 2, q: ["carries", 6], ctx: ["car", "ypc", "ryds"], how: "Expected points added per carry: how much each run helped the offense score, given the down, distance and field spot." }],
    ]],
    ["Receiving", "o", ["WR", "TE", "RB"], [
      ["deep_rec", "Deep catches (20+ yards in the air)", (S) => S.deep_rec, { ctx: ["tgt", "rec", "recyds"], extra: [["Deep tgt", (S) => S.deep_tgt]], how: "Catches on throws that traveled 20+ yards past the line." }],
      ["deep_pct", "Deep catch %", (S) => div(100 * S.deep_rec, S.deep_tgt), { pct: 1, q: ["deep_tgt", 0.75], ctx: ["tgt", "rec", "recyds"], extra: [["Deep tgt", (S) => S.deep_tgt]], how: "Share of deep targets (20+ air yards) he caught." }],
      ["third_conv", "3rd/4th-down conversions", (S) => S.third_conv, { ctx: ["tgt", "rec", "recyds"], extra: [["3rd-down tgt", (S) => S.third_tgt]], how: "Catches on 3rd or 4th down that moved the chains or scored." }],
      ["third_rate", "3rd-down conversion % per target", (S) => div(100 * S.third_conv, S.third_tgt), { pct: 1, q: ["third_tgt", 1], ctx: ["tgt", "rec", "recyds"], extra: [["3rd-down tgt", (S) => S.third_tgt]], how: "Of his 3rd/4th-down targets, how many turned into a first down or TD." }],
      ["rec_20", "Big plays (20+ yard catches)", (S) => S.rec_20, { ctx: ["rec", "recyds", "rectd"], how: "Catches that gained 20 yards or more." }],
      ["yac_rec", "Yards after catch per catch", (S) => div(S.yac, S.rec), { d: 1, q: ["rec", 2], ctx: ["rec", "recyds", "rectd"], how: "Yards he gained after the ball was in his hands." }],
      ["rz_tgt", "Red-zone targets", (S) => S.rz_tgt, { ctx: ["tgt", "rectd", "recyds"], extra: [["RZ TDs", (S) => S.rz_rec_td]], how: "Targets inside the opponent's 20." }],
      ["epa_tgt", "EPA per target", (S) => div(S.rec_epa, S.targets), { d: 2, q: ["targets", 4], ctx: ["tgt", "rec", "recyds"], how: "Expected points added per time he was thrown to." }],
    ]],
    ["Passing", "o", ["QB"], [
      ["deep_cmp", "Deep ball completion %", (S) => div(100 * S.deep_cmp, S.deep_att), { pct: 1, q: ["deep_att", 2], ctx: ["att", "pyds", "ptd"], extra: [["Deep att", (S) => S.deep_att], ["Deep yds", (S) => S.deep_yds]], how: "Completions on throws 20+ yards in the air." }],
      ["third_db", "3rd/4th-down conversion %", (S) => div(100 * S.third_db_conv, S.third_db), { pct: 1, q: ["third_db", 6], ctx: ["db", "pyds", "ptd"], extra: [["3rd-down dropbacks", (S) => S.third_db]], how: "Dropbacks on 3rd or 4th down that moved the chains (sacks count against him)." }],
      ["clutch", "Clutch EPA per dropback", (S) => div(S.clutch_epa, S.clutch_db), { d: 2, q: ["clutch_db", 3], ctx: ["db", "pyds", "ptd"], extra: [["Clutch dropbacks", (S) => S.clutch_db]], how: "Expected points added per dropback in the 4th quarter or overtime of one-score games." }],
      ["rz_td", "Red-zone TD %", (S) => div(100 * S.rz_pass_td, S.rz_att), { pct: 1, q: ["rz_att", 2], ctx: ["att", "ptd", "pyds"], extra: [["RZ att", (S) => S.rz_att]], how: "Share of his throws inside the opponent's 20 that were TDs." }],
      ["hit_rate", "Hit or sacked %", (S) => div(100 * S.hit, S.dropbacks), { pct: 1, low: 1, q: ["dropbacks", 15], ctx: ["db", "att", "pyds"], how: "Share of dropbacks where he got hit or sacked. Lower is better (part of that is the line)." }],
      ["epa_db", "EPA per dropback", (S) => div(S.pass_epa, S.dropbacks), { d: 2, q: ["dropbacks", 15], ctx: ["db", "pyds", "ptd"], how: "Expected points added per dropback, sacks included." }],
    ]],
  ];
  const ALL = G.flatMap(([g, side, roles, l]) => l.map((s) => ({ key: s[0], label: s[1], v: s[2], ...s[3], group: g, side, roles })));
  const ROLES = { d: [["", "All defense"], ["EDGE", "Edge"], ["IDL", "D-line (interior)"], ["LB", "Linebackers"], ["CB", "Corners"], ["S", "Safeties"]],
    o: [["", "All offense"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"], ["TE", "TE"]] };
  const EXP = [["", "Everyone"], ["1", "Rookies"], ["2", "2nd year"], ["3", "3rd year"], ["1-2", "Rookies + 2nd year"], ["4+", "Vets (4+ years)"]];
  const DRAFT = [["", "Any"], ["1", "1st round"], ["2-3", "Rounds 2-3"], ["4-7", "Rounds 4-7"], ["U", "Undrafted"]];
  const PICKS = [
    ["Rookie LBs: run stops", { dstat: "run_stop", role: "LB", exp: "1" }],
    ["Rookie LBs: stop rate", { dstat: "run_stop_rate", role: "LB", exp: "1" }],
    ["Rookie edge: sacks", { dstat: "sacks", role: "EDGE", exp: "1" }],
    ["Rookie DBs: ball production", { dstat: "ball", role: "CB", exp: "1" }],
    ["Safeties who stop the run", { dstat: "run_stop", role: "S", exp: "" }],
    ["Undrafted run stoppers", { dstat: "run_stop", role: "", exp: "", draft: "U" }],
    ["Drive-killing sacks", { dstat: "third_sacks", role: "", exp: "" }],
    ["Short-yardage backs", { dstat: "sy_conv", role: "RB", exp: "" }],
    ["Who gets stuffed most", { dstat: "stuffed", role: "RB", exp: "", order: "worst" }],
    ["Rookie WRs: deep catches", { dstat: "deep_rec", role: "WR", exp: "1" }],
    ["3rd-down go-to guys", { dstat: "third_conv", role: "", exp: "" }],
    ["Clutch QBs", { dstat: "clutch", role: "QB", exp: "" }],
    ["Deep ball QBs", { dstat: "deep_cmp", role: "QB", exp: "" }],
  ];

  const file = (s) => files.get(s) || files.set(s, getJSON(`data/deep/nfl_${s}.json`).catch(() => null)).get(s);
  const fmtv = (st, v) => (v == null ? "–" : st.pct ? `${v.toFixed(1)}%` : st.d != null ? v.toFixed(st.d) : String(Math.round(v * 10) / 10));
  const ctxv = (v, d) => (v == null ? "–" : d ? v.toFixed(d) : String(Math.round(v * 10) / 10));
  const opt = (opts, v) => opts.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v) ? " selected" : ""}>${esc(l)}</option>`).join("");
  const expOk = (y, e) => !e || (e === "1-2" ? y >= 1 && y <= 2 : e === "4+" ? y >= 4 : y === +e);
  const draftOk = (dr, f) => {
    if (!f) return true;
    const r = /^R(\d)/.exec(dr)?.[1];
    return f === "U" ? !r : f === "1" ? r === "1" : f === "2-3" ? r === "2" || r === "3" : r >= "4";
  };

  async function render(params) {
    const el = document.getElementById("view-stats"), sub = Live.statsSubtabs("deep");
    if (league !== "nfl") {
      el.innerHTML = sub + `<div class="card">Deep cuts are NFL only for now: college data doesn't say who made each tackle. <a href="${link("stats", null, { show: "deep", league: "nfl" })}">See NFL deep cuts →</a></div>`;
      return;
    }
    const st = { ...DEF, ...Object.fromEntries([...params].filter(([k]) => k in DEF)) };
    el.innerHTML = sub + `<div class="card muted">Loading…</div>`;
    idx = idx || await getJSON("data/deep/index.json").catch(() => ({}));
    const seasons = idx.nfl || [];
    if (!seasons.length) { el.innerHTML = sub + `<div class="card">No deep-cut data yet. It's built every week.</div>`; return; }
    if (!seasons.includes(+st.dseason)) st.dseason = String(seasons.at(-1));
    const D = await file(st.dseason);
    if (!D) { el.innerHTML = sub + `<div class="card">Couldn't load the data. Try again in a minute.</div>`; return; }
    const stat = ALL.find((s) => s.key === st.dstat) || ALL[0];
    st.dstat = stat.key;
    if (!ROLES[stat.side].some(([k]) => k === st.role)) st.role = "";

    const cols = D.cols, wk = Math.max(1, D.weeks);
    const need = stat.q ? Math.ceil(stat.q[1] * wk) : 0;
    let rows = D.rows.map((r) => {
      const S = {};
      cols.forEach((c, i) => (S[c] = r[i + 1]));
      const m = D.players[r[0]];
      return { id: r[0], m, S, v: stat.v(S) };
    }).filter(({ m, S, v }) => v != null && (stat.side === "d" ? ["EDGE", "IDL", "LB", "CB", "S"] : ["QB", "RB", "WR", "TE"]).includes(m[1])
      && (!st.role || m[1] === st.role) && expOk(m[3], st.exp) && draftOk(m[4], st.draft) && (!st.dteam || m[2] === st.dteam)
      && (!stat.q || S[stat.q[0]] >= need) && (stat.q || v > 0));
    rows.sort((a, b) => ((st.order === "worst") !== !!stat.low ? a.v - b.v : b.v - a.v));
    const total = rows.length;
    rows = rows.slice(0, 50);
    const ctx = [...(stat.extra || []), ...stat.ctx.map((k) => C[k])].slice(0, 4);
    const teams = [...new Set(Object.values(D.players).map((m) => m[2]).filter(Boolean))].sort();
    const roleTxt = ROLES[stat.side].find(([k]) => k === st.role)[1], expTxt = EXP.find(([k]) => k === st.exp)?.[1] || "Everyone";
    const qTxt = stat.q ? `Needs ${need}+ ${{ d_snaps: "defensive snaps", run_tkl: "run tackles", carries: "carries", sy_carries: "short-yardage carries", deep_tgt: "deep targets", third_tgt: "3rd-down targets", rec: "catches", targets: "targets", deep_att: "deep throws", third_db: "3rd-down dropbacks", clutch_db: "clutch dropbacks", rz_att: "red-zone throws", dropbacks: "dropbacks" }[stat.q[0]]} to be listed. ` : "";

    el.innerHTML = sub + `<div class="card vz dp">
      <div class="sc-bar"><h2>Deep cuts</h2><span class="muted vz-tag">The stats nobody else will show you.</span></div>
      <div class="presets" id="dp-picks">${PICKS.map(([l, o], i) => `<button data-i="${i}" class="${Object.entries({ ...DEF, dseason: st.dseason, ...o }).every(([k, v]) => String(st[k]) === String(v)) ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <div class="vz-ctl">
        <label class="vz-wide">Stat<select id="dp-stat">${G.map(([g, , , l]) => `<optgroup label="${esc(g)}">${opt(l.map((s) => [s[0], s[1]]), st.dstat)}</optgroup>`).join("")}</select></label>
        <label>Position<select id="dp-role">${opt(ROLES[stat.side], st.role)}</select></label>
        <label>Experience<select id="dp-exp">${opt(EXP, st.exp)}</select></label>
        <label>Drafted<select id="dp-draft">${opt(DRAFT, st.draft)}</select></label>
        <label>Team<select id="dp-team">${opt([["", "All teams"], ...teams.map((t) => [t, t])], st.dteam)}</select></label>
        <label>Season<select id="dp-season">${opt(seasons.map((s) => [s, s]), st.dseason)}</select></label>
        <label>Show<div class="seg vz-seg" id="dp-order">${[["best", "Best"], ["worst", "Worst"]].map(([k, l]) => `<button data-v="${k}" class="${k === st.order ? "active" : ""}">${l}</button>`).join("")}</div></label>
      </div>
      <p class="fr-how"><b>${esc(stat.label)}</b>: ${esc(stat.how)}</p>
      <div class="table-wrap"><table class="box"><thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th>Pos</th><th title="Year in the NFL (1 = rookie)">Yr</th><th>Drafted</th>
        <th class="num">${esc(stat.label)}</th>${ctx.map(([l]) => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead><tbody>
        ${rows.map((r, i) => `<tr><td class="num muted">${i + 1}</td>
          <td>${r.m[5] ? `<a href="${link("player", r.m[5])}">${esc(r.m[0])}</a>` : esc(r.m[0])}</td>
          <td>${esc(r.m[2])}</td><td>${esc(r.m[1])}</td><td>${r.m[3] === 1 ? `<b class="dp-rk">R</b>` : r.m[3] || ""}</td><td class="muted">${esc(r.m[4])}</td>
          <td class="num"><b>${fmtv(stat, r.v)}</b></td>${ctx.map(([, f, d]) => `<td class="num">${ctxv(f(r.S), d)}</td>`).join("")}</tr>`).join("")
          || `<tr><td colspan="${7 + ctx.length}" class="muted">Nobody fits those filters${stat.q ? " yet (rates need enough plays to mean something)" : ""}.</td></tr>`}
      </tbody></table></div>
      <p class="note">${roleTxt} · ${expTxt} · ${st.dseason} through week ${D.weeks}. ${total > 50 ? `Top 50 of ${total}. ` : ""}${qTxt}<b class="dp-rk">R</b> = rookie.
        Play-by-play from nflverse (the NFL's official data). Everyone credited on a tackle gets it, so assisted tackles count for each player. Snaps from Pro Football Reference via nflverse.</p></div>`;

    const go = (o) => {
      const h = link("stats", null, { show: "deep", ...st, ...o });
      history.replaceState(null, "", h);
      render(new URLSearchParams(h.split("?")[1]));
    };
    el.querySelector("#dp-picks").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) go({ ...DEF, dseason: st.dseason, ...PICKS[+b.dataset.i][1] }); };
    el.querySelector("#dp-stat").onchange = (e) => {
      const ns = ALL.find((s) => s.key === e.target.value);
      go({ dstat: ns.key, role: ns.side === stat.side && (!st.role || ns.roles.includes(st.role)) ? st.role : ns.roles[0], order: "best" });
    };
    for (const [id, k] of [["dp-role", "role"], ["dp-exp", "exp"], ["dp-draft", "draft"], ["dp-team", "dteam"], ["dp-season", "dseason"]]) el.querySelector("#" + id).onchange = (e) => go({ [k]: e.target.value });
    el.querySelector("#dp-order").onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) go({ order: b.dataset.v }); };
  }
  return { render };
})();
