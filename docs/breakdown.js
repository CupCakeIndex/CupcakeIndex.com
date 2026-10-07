// Breakdown page (#/breakdown/<team>): why a team sits where it does in our rankings, in numbers.
// Uses the rankings data app.js already loaded (DATA, LG, weights, composite, rankTeams) with your current weights:
// how many points each factor adds to the overall score, where the team ranks in each factor, what separates it
// from the teams right above and below, its rank week by week, and how it played in each game.
const Breakdown = (() => {
  // what each factor's raw number means (only where it has a plain unit)
  const RAW = {
    power: (t) => `${sign(t.raw?.power)} pts a game better than an average team, adjusted for opponents`,
    resume: (t) => `${sign(t.raw?.resume)} wins compared with a typical ${league === "nfl" ? "top-8 NFL" : "top-25"} team on this schedule`,
    sos: (t) => `opponents average ${sign(t.raw?.sos)} pts better than an average team`,
    recent: (t) => `${sign(t.raw?.recent)} pts a game better than average lately`,
    luck: (t) => `${sign(t.luck_wins)} wins compared with how they've played (one-score record ${t.one_score})`,
  };
  const sign = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${(+v).toFixed(1)}`);

  // each factor's share of the overall score (0-100): weight share x score (Cupcake counts backwards)
  function parts(t) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    return LG.factors.map((f) => {
      const s = t.scores[f.key] ?? 50, val = f.invert ? 100 - s : s;
      return { f, score: s, w: (weights[f.key] || 0) / total, pts: ((weights[f.key] || 0) / total) * val };
    });
  }
  // rank among every team in one factor (1 = best)
  const factorRank = (teams, f, t) => 1 + teams.filter((x) => (f.invert ? (x.scores[f.key] ?? 50) < (t.scores[f.key] ?? 50) : (x.scores[f.key] ?? 50) > (t.scores[f.key] ?? 50))).length;

  async function render(name) {
    const el = $("#view-breakdown");
    const all = rankTeams(DATA.teams), t = all.find((x) => x.team === name);
    if (!t) { el.innerHTML = `<div class="card">No team called “${esc(name || "")}” in this week's rankings. <a href="${link("rankings")}">Back to the rankings</a></div>`; return; }
    const P = parts(t), n = all.length, nfl = league === "nfl";
    const row = (p) => {
      const r = factorRank(all, p.f, t);
      return `<tr title="${esc(p.f.help)}"><td><b>${esc(p.f.label)}</b>${p.f.invert ? ` <small class="muted">(lower is better)</small>` : ""}${RAW[p.f.key] ? `<div class="muted bd-raw">${esc(RAW[p.f.key](t))}</div>` : ""}</td>
        <td class="num">${Math.round(p.w * 100)}%</td><td class="num">${Math.round(p.score)}</td>
        <td class="num"><span class="bd-rk${r <= Math.ceil(n * 0.1) ? " good" : r > n * 0.75 ? " bad" : ""}">#${r}</span></td>
        <td class="num"><b>${p.pts.toFixed(1)}</b></td></tr>`;
    };
    // the teams right above and below: what separates them, in points of overall score
    const vs = (o) => {
      if (!o) return "";
      const Q = parts(o), gaps = P.map((p, i) => ({ f: p.f, d: p.pts - Q[i].pts })).filter((g) => Math.abs(g.d) >= 0.05);
      const ahead = t.rank < o.rank, gap = P.reduce((a, p) => a + p.pts, 0) - Q.reduce((a, q) => a + q.pts, 0);
      const plus = gaps.filter((g) => g.d > 0).sort((a, b) => b.d - a.d), minus = gaps.filter((g) => g.d < 0).sort((a, b) => a.d - b.d);
      const list = (gs) => gs.slice(0, 2).map((g) => `${g.f.label} (${g.d > 0 ? "+" : ""}${g.d.toFixed(1)})`).join(" and ");
      return `<div class="bd-vs"><div class="bd-vs-h">${logo(o, "xs")} <b>#${o.rank} ${esc(o.team)}</b> <span class="muted">${esc(o.record)}</span>
          <span class="bd-gap">${ahead ? "ahead by" : "behind by"} ${Math.abs(gap).toFixed(1)}</span></div>
        <p>${plus.length ? `${esc(t.team)} is better in ${esc(list(plus))}` : `${esc(t.team)} isn't better in any factor`}${minus.length ? `; ${esc(o.team)} is better in ${esc(list(minus))}` : ""}.</p>
        <table class="box bd-cmp"><thead><tr><th>Factor</th><th class="num">${esc(t.team)}</th><th class="num">${esc(o.team)}</th><th class="num">Gap</th></tr></thead><tbody>
        ${P.map((p, i) => `<tr><td>${esc(p.f.label)}</td><td class="num">${p.pts.toFixed(1)}</td><td class="num">${Q[i].pts.toFixed(1)}</td><td class="num ${p.pts - Q[i].pts >= 0 ? "bd-pos" : "bd-neg"}">${p.pts - Q[i].pts >= 0 ? "+" : ""}${(p.pts - Q[i].pts).toFixed(1)}</td></tr>`).join("")}
        </tbody></table></div>`;
    };
    // game by game: how well they played (as a power rating) next to their season rating
    const games = t.schedule.filter((g) => g.result && g.perf != null).map((g) => {
      const vsSeason = g.perf - t.rating;
      return `<tr><td class="num muted">${esc(g.week)}</td><td>${g.loc === "A" ? "at " : g.loc === "N" ? "vs. " : ""}${g.opp_rank && !g.fcs ? `<small class="muted">#${esc(g.opp_rank)}</small> ` : ""}${esc(g.opp)}${g.cupcake ? ` <small class="bd-cup">cupcake</small>` : ""}${g.fcs ? ` <small class="muted">FCS</small>` : ""}</td>
        <td class="${g.result === "W" ? "bd-pos" : "bd-neg"}">${esc(g.result)} ${esc(g.score)}</td>
        <td class="num">${sign(g.perf)}</td><td class="num ${vsSeason >= 0 ? "bd-pos" : "bd-neg"}">${sign(vsSeason)}</td>
        <td class="num">${g.difficulty != null ? Math.round(g.difficulty * 100) + "%" : "–"}</td></tr>`;
    }).join("");
    el.innerHTML = `<div class="card bd">
      <div class="bd-head">${logo(t)}<div><h2>Why #${t.rank} ${esc(t.team)}?</h2>
        <span class="muted">${esc(t.conference || "")} · ${esc(t.record)}${t.ap_rank ? ` · AP #${esc(t.ap_rank)}` : ""} · overall score <b>${P.reduce((a, p) => a + p.pts, 0).toFixed(1)}</b> of 100</span>
        <div><a class="boxlink" href="${link("rankings", null, { team: t.team })}">Back to the rankings</a></div></div></div>
      <h3>How the score adds up</h3>
      <div class="table-wrap"><table class="box bd-tbl"><thead><tr><th>Factor</th><th class="num">Weight</th><th class="num">Score</th><th class="num" title="Rank of ${n} teams">Rank</th><th class="num">Adds</th></tr></thead>
        <tbody>${P.map(row).join("")}</tbody>
        <tfoot><tr><td><b>Overall</b></td><td class="num">100%</td><td></td><td class="num">#${t.rank}</td><td class="num"><b>${P.reduce((a, p) => a + p.pts, 0).toFixed(1)}</b></td></tr></tfoot></table></div>
      <p class="note">Each factor is scored 0–100 against every ${nfl ? "NFL" : "FBS"} team; “Adds” is its weight times its score (Cupcake counts backwards: less padding adds more). Weights are ${Object.values(weights).join("/") === Object.values(LG.default_weights).join("/") ? "the default ones" : "your own (Rankings > Weights)"}. Hover a factor for what it measures.</p>
      <h3>Next to them</h3>
      ${vs(all[t.rank - 2]) || ""}${vs(all[t.rank])}
      <h3>Rank by week</h3><div class="bd-weeks" id="bd-weeks"><span class="muted">Loading…</span></div>
      ${games ? `<h3>Game by game</h3><div class="table-wrap"><table class="box bd-games"><thead><tr><th class="num">Wk</th><th>Opponent</th><th>Result</th><th class="num">Played like</th><th class="num">vs. season</th><th class="num">Diff</th></tr></thead><tbody>${games}</tbody></table></div>
      <p class="note">“Played like” is the power rating that game was worth (opponent's strength plus the margin, capped${nfl ? "" : " so blowouts of bad teams don't count extra"}). Their season power rating is ${sign(t.rating)}. Diff is the chance a typical ${nfl ? "top-8 NFL" : "top-25"} team would lose that game.</p>` : ""}
    </div>`;
    weeksInto(t.team);
  }

  // their rank in every week of this season, with today's weights
  async function weeksInto(name) {
    const season = $("#season").value, ws = (LG.seasons[season]?.weeks || []).filter((w) => w <= +$("#week").value);
    const ranks = await Promise.all(ws.map((w) => weekData(league, season, w).then((d) => rankTeams(d.teams).find((x) => x.team === name)?.rank ?? null).catch(() => null)));
    const box = $("#bd-weeks");
    if (!box) return;
    box.innerHTML = ws.map((w, i) => {
      const r = ranks[i], prev = i ? ranks[i - 1] : null, mv = r != null && prev != null ? prev - r : 0;
      return `<div class="bd-wk"><small>Wk ${w}</small><b>${r != null ? "#" + r : "–"}</b>${mv ? `<i class="${mv > 0 ? "bd-pos" : "bd-neg"}">${mv > 0 ? "▲" : "▼"}${Math.abs(mv)}</i>` : "<i class=\"muted\">·</i>"}</div>`;
    }).join("");
  }

  return { render };
})();
