// Takes: every stat card, hot take and Bully of the Week we post on X, on the site too (newest first).
// src/social/feed.py adds each post to docs/data/takes.json when it goes out, tagged with the teams and players it's about,
// so team and player pages get a Takes tab with theirs. Betting hot takes and breaking news are left out.
// Top-25 college teams' Takes tabs also lead with conversation starters (docs/data/starters.json, src/starters.py),
// and players' with talking points from their live game log plus headlines about them (playerPoints, headlines).
const Takes = (() => {
  const PAGE = 20;
  let D = null, loadedAt = 0, shown = PAGE, S = null;

  async function load() {
    if (!D || Date.now() - loadedAt > 10 * 60000) {
      D = await getJSON("data/takes.json").catch(() => ({ teams: {}, players: {}, items: [] }));
      loadedAt = Date.now();
    }
    return D;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const lgOf = (k) => k.split(":")[0];
  const idOf = (k) => k.split(":")[1];

  // "See the chart" in Visualize: a post's first player (every stat on him), else its teams side by side (radar)
  const chart = (it) => {
    const pl = (it.players || [])[0], tms = (it.teams || []).slice(0, 5);
    if (pl) return `#/stats?${new URLSearchParams({ league: lgOf(pl), show: "visualize", him: idOf(pl) })}`;
    if (tms.length) return `#/stats?${new URLSearchParams({ league: lgOf(tms[0]), show: "visualize", who: "teams", type: "radar", pick: tms.join(",") })}`;
    return "";
  };

  // one post: date and time, the card picture (tap for full size), the text, and chips for its teams and players
  const card = (it) => `<article class="tk-item">
      <p class="nw-meta"><time datetime="${esc(it.time)}">${esc(it.date_only ? new Date(it.time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : when(it.time))}</time>${it.league ? ` · <span class="muted">${it.league === "nfl" ? "NFL" : "CFB"}</span>` : ""}</p>
      ${it.image ? `<a class="tk-pic" href="${esc(it.image)}" target="_blank" rel="noopener"><img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.remove()"></a>` : ""}
      <p class="tk-text">${esc(it.text)}</p>
      ${it.teams?.length || it.players?.length ? `<p class="nw-teams">${(it.teams || []).filter((k) => D.teams[k]).map((k) =>
        `<a href="#/team/${esc(idOf(k))}?league=${esc(lgOf(k))}">${esc(D.teams[k].short || D.teams[k].name)}</a>`).join("")}${(it.players || []).filter((k) => D.players[k]).map((k) =>
        `<a href="#/player/${esc(idOf(k))}?league=${esc(lgOf(k))}">${esc(D.players[k])}</a>`).join("")}</p>` : ""}
      ${it.x || chart(it) ? `<p class="tk-x">${chart(it) ? `<a href="${esc(chart(it))}">📈 See the chart ›</a>` : ""}${it.x ? `<a class="muted" href="${esc(safeUrl(it.x))}" target="_blank" rel="noopener">See it on X ›</a>` : ""}</p>` : ""}
    </article>`;

  const list = (rows) => `<div class="nw-list tk-list">${rows.map(card).join("")}</div>`;

  async function render(params) {
    const el = $("#view-takes");
    if (!D) el.innerHTML = loadingHtml();
    await load();
    const lg = params.get("all") === "1" ? "all" : league;
    const rows = D.items.filter((it) => lg === "all" || !it.league || it.league === lg);
    const btn = (v, label) => `<a class="nw-lg${v === lg ? " on" : ""}" href="#/takes?league=${v === "all" ? league : v}${v === "all" ? "&all=1" : ""}">${label}</a>`;
    const draw = () => {
      el.innerHTML = `<div class="card">
        <div class="sc-bar"><h2>Takes</h2><div class="presets">${btn("cfb", "CFB")}${btn("nfl", "NFL")}${btn("all", "All")}</div></div>
        <p class="muted tk-intro">Stats, hot takes and the Bully of the Week, the same posts we put on X. Newest first.</p>
        ${rows.length ? list(rows.slice(0, shown)) + (rows.length > shown ? `<button class="btn nw-more" id="tk-more">Show more</button>` : "")
          : `<p class="muted">No takes yet. The next one goes out soon.</p>`}</div>`;
      const more = $("#tk-more");
      if (more) more.onclick = () => { shown += PAGE; draw(); };
    };
    shown = PAGE;
    draw();
  }

  // the posts about one team or player ("lg:id"), newest first: the Takes tab on their page
  async function about(kind, key) {
    await load();
    return D.items.filter((it) => (it[kind] || []).includes(key));
  }

  // conversation starters for a top-25 team (src/starters.py, weekly): a few debatable numbers, best first
  async function starters(key) {
    if (!S) S = await getJSON("data/starters.json").catch(() => ({ teams: {} }));
    return S.teams[key] || [];
  }
  const startersHtml = (rows) => !rows.length ? "" : `<div class="tk-st-head"><h3>Conversation starters</h3><small class="muted">Week ${esc(S.week)} · where they stand in our top 25</small></div>
    <div class="tk-st">${rows.map((r) => `<div class="tk-st-item"><b>${esc(r.big)}</b><small>${esc(r.label)}</small><p>${esc(r.text)}</p></div>`).join("")}</div>`;

  // Talking points for any player with games this season (Terry: Takes shouldn't only be our X posts). Built in the
  // browser from ESPN's live game log and season ranks, so they're current as soon as a game ends. group = the
  // player's main stat group (PRIMARY in live.js). Each one is {big, label, text}, like the team starters.
  const PP = {
    passing: { key: "passingYards", td: "passingTouchdowns", w: "passing yards", tdw: "TD pass", big: 300 },
    rushing: { key: "rushingYards", td: "rushingTouchdowns", w: "rushing yards", tdw: "rushing TD", big: 100 },
    receiving: { key: "receivingYards", td: "receivingTouchdowns", w: "receiving yards", tdw: "receiving TD", big: 100 },
    defensive: { key: "totalTackles", td: "sacks", w: "tackles", tdw: "sack", big: 10 },
  };
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
  const fmt = (v, d = 0) => (+v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const fa = (v) => fmt(v, v < 20 ? 1 : 0); // an average: 261 yards a game, 11.3 tackles

  // this season's games from an ESPN game log, oldest first (no preseason), one row per game: {m: game, s: {stat: number}, t}.
  // [] unless it's a current season: his last game in the past 60 days (ESPN hands retired players their last season).
  function games(gl) {
    const names = gl?.names || [], seen = new Set(), G = [];
    for (const stp of gl.seasonTypes || []) {
      if (/pre/i.test(stp.displayName || "")) continue;
      for (const ev of (stp.categories || []).flatMap((c) => c.events || [])) {
        const m = gl.events?.[ev.eventId];
        if (!m || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const s = {};
        const raw = {};
        names.forEach((n, i) => { if (!(n in s)) { s[n] = num(ev.stats?.[i]); raw[n] = ev.stats?.[i]; } });
        G.push({ m, s, raw, t: Date.parse(m.gameDate) || 0 });
      }
    }
    G.sort((x, y) => x.t - y.t);
    return G.length && Date.now() - G[G.length - 1].t <= 60 * 86400000 ? G : [];
  }

  // ex: {career: career() from live.js, stats: Viz.playerStats()}, both optional. Each point can carry viz: a Visualize stat
  // key, so "See the chart" opens that stat with him highlighted (Terry: "a see visualization at the bottom if applicable").
  const VK = { passingYards: "pass_yds", passingTouchdowns: "pass_td", rushingYards: "rush_yds", rushingTouchdowns: "rush_td", receivingYards: "rec_yds",
    receivingTouchdowns: "rec_td", receptions: "rec", totalTackles: "tackles", sacks: "def_sacks", interceptions: "def_int", completionPct: "cmp_pct" };
  const CAREER_CAT = { passing: "passing", rushing: "rushing", receiving: "receiving", defensive: "defensive" };
  function playerPoints(a, gl, lg, group, ex = {}) {
    const names = gl?.names || [];
    if (group === "kicking") return kickPoints(a, games(gl));
    const P = PP[group];
    if (!P || !names.includes(P.key)) return [];
    const G = games(gl);
    if (G.length < 2) return [];
    const who = a.lastName || a.displayName, team = a.team?.shortDisplayName || a.team?.name || "His team";
    const vs = (m) => `${m.atVs === "@" ? "at" : "vs"} ${m.opponent?.abbreviation || "?"}`;
    const key = G.map((g) => g.s[P.key] ?? 0), n = G.length, out = [], kv = VK[P.key];
    const sum = (k) => G.reduce((s, g) => s + (g.s[k] || 0), 0);
    const lgTxt = lg === "nfl" ? "the NFL" : "the country", nGames = lg === "nfl" ? 17 : 12;
    // "Adjusted QBR" -> "adjusted QBR"
    const low = (x) => x.replace(/\w+/g, (w) => (/[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()));

    // his best two ESPN ranks this season (interceptions thrown don't count as a good thing)
    const top = lg === "nfl" ? 10 : 25;
    const ranked = (a.statsSummary?.statistics || []).filter((s) => s.rank && s.rank <= top && !(group === "passing" && s.name === "interceptions"))
      .sort((x, y) => x.rank - y.rank).slice(0, 2);
    for (const rk of ranked) {
      const r = String(rk.rankDisplayValue || rk.rank).replace(/^Tied-/i, "tied for ");
      out.push({ big: r.replace(/^tied for /, "T-"), label: `in ${lgTxt}: ${rk.displayName}`, viz: VK[rk.name],
        text: `${who} is ${r} in ${low(rk.displayName)} (${rk.displayValue}). ${rk.rank <= 3 ? "That's a name that belongs in the best-at-his-position talk." : `Top ${top}. Where does he rank at his position for you?`}` });
    }
    // where he ranks at his position in the deeper stats (Visualize's numbers): his best few top-5s that ESPN doesn't show
    const used = new Set(ranked.map((rk) => VK[rk.name]).filter(Boolean));
    // (only stats made for his position, more-is-better ones he actually has, and not the field-zone splits or penalty lists)
    const deep = (ex.stats?.cats || []).flatMap(([g, l]) => (/where|zone|penalt|erased|usage|heisman|mvp/i.test(g) ? [] : l)).filter((x) => x.rank && x.rank <= 5 && x.n >= 20 && x.v && !x.low && x.pos === ex.stats.pos && !used.has(x.key))
      .sort((x, y) => x.rank - y.rank || y.n - x.n).slice(0, 3);
    const SAY = ["Nobody at his position does it better.", "Only one guy at his position is better at it.", "That's elite company.", "Not many people are talking about that.", "That should get more attention."];
    deep.forEach((x, i) => out.push({ big: `#${x.rank}`, label: `among ${ex.stats.posTxt}: ${x.label}`, viz: x.key,
      text: `${x.rank === 1 ? "Best" : `${["", "", "2nd", "3rd", "4th", "5th"][x.rank]}-best`} of ${x.n} ${ex.stats.posTxt} in ${low(x.label)} (${x.txt}). ${SAY[x.rank === 1 ? 0 : x.rank === 2 ? 1 : 2 + (i % 3)]}` }));
    // last game against what he'd done before it
    if (n >= 4) {
      const last = key[n - 1], before = avg(key.slice(0, -1)), g = G[n - 1];
      if (before > 0 && (last >= before * 1.3 || last <= before * 0.7)) {
        const up = last > before, by = Math.round(Math.abs(last / before - 1) * 100);
        out.push({ big: fmt(last), label: `${P.w} last game (${vs(g.m)})`, viz: kv,
          text: `That's ${by}% ${up ? "over" : "under"} his ${fa(before)} a game before it. ${up ? "One more like it and it's a trend." : "Worth watching how he bounces back."}` });
      }
    }
    // last 3 games against the rest of the season
    if (n >= 6) {
      const l3 = avg(key.slice(-3)), early = avg(key.slice(0, -3));
      if (early > 0 && Math.abs(l3 / early - 1) >= 0.25) {
        const up = l3 > early;
        out.push({ big: fa(l3), label: `${P.w} a game, last 3`, viz: kv,
          text: `${up ? "Up" : "Down"} from ${fa(early)} a game in his first ${n - 3}. ${up ? "He's getting better as the season goes." : "Something has changed since the start of the year."}` });
      }
    }
    // on pace for, against his best season (ESPN's career stats, his own league), and this year against last year
    const me = ex.career, C = me?.cats?.[CAREER_CAT[group]], last = new Date(G[n - 1].t);
    const yr = last.getFullYear() - (last.getMonth() < 5 ? 1 : 0), past = {};
    for (const r of C?.rows || []) {
      if (r.level !== me.lvl || r.year >= yr) continue;
      const T = C.seasonTotals?.[`${r.year}|${r.level}`];
      if (T) { past[r.year] = { v: num(T[P.key]) || 0, g: num(T.gamesPlayed) || 0 }; continue; }
      past[r.year] = { v: (past[r.year]?.v || 0) + (num(r.vals[P.key]) || 0), g: (past[r.year]?.g || 0) + (num(r.vals.gamesPlayed) || 0) };
    }
    const tot = sum(P.key), pace = (tot / n) * nGames;
    const best = Object.entries(past).sort((x, y) => y[1].v - x[1].v)[0];
    if (n >= 3 && n < nGames && tot > 0) {
      out.push({ big: fmt(pace), label: `${P.w}: his pace over ${nGames} games`, viz: kv,
        text: best && best[1].v > 0 ? (pace > best[1].v ? `That would beat his best season (${fmt(best[1].v)} in ${best[0]}). A career year is on the table.`
          : `His best is ${fmt(best[1].v)} (${best[0]}). He'd need a big finish to top it.`) : `He has ${fmt(tot)} through ${n} games.` });
    }
    const ly = past[yr - 1];
    if (ly?.g >= 4 && ly.v > 0 && n >= 3) {
      const now = tot / n, then = ly.v / ly.g;
      if (Math.abs(now / then - 1) >= 0.2) out.push({ big: `${now > then ? "+" : "-"}${Math.round(Math.abs(now / then - 1) * 100)}%`, label: `${P.w} a game vs last season`,
        text: `${fa(now)} a game this year, ${fa(then)} last year. ${now > then ? "The jump is real." : "He hasn't found last year's form."}` });
    }
    // his team's record in his games, and how his numbers swing with it
    const W = G.filter((g) => g.m.gameResult === "W"), L = G.filter((g) => g.m.gameResult === "L");
    if (W.length + L.length >= 3) {
      let text = W.length > L.length ? `${team} win more than they lose with him.` : W.length < L.length ? `${team} haven't won enough around him.` : `${team} are right at .500 with him.`;
      // wins against losses (not for defenders: they make more tackles in losses)
      if (W.length >= 2 && L.length >= 2 && group !== "defensive") {
        const aw = avg(W.map((g) => g.s[P.key] ?? 0)), al = avg(L.map((g) => g.s[P.key] ?? 0));
        text = `He averages ${fa(aw)} ${P.w} in wins and ${fa(al)} in losses. ${aw >= al * 1.25 ? "When he plays well, they win." : al >= aw ? "His numbers don't decide their games the way you'd think." : "They need more than him to win."}`;
      }
      out.push({ big: `${W.length}-${L.length}`, label: `${team} in his games`, text });
    }
    // home against road
    const H = G.filter((g) => g.m.atVs !== "@"), A = G.filter((g) => g.m.atVs === "@");
    if (H.length >= 2 && A.length >= 2) {
      const ah = avg(H.map((g) => g.s[P.key] ?? 0)), aa = avg(A.map((g) => g.s[P.key] ?? 0));
      if (Math.max(ah, aa) > 0 && Math.abs(ah - aa) / Math.max(ah, aa) >= 0.25) out.push({ big: fa(Math.max(ah, aa)), label: `${P.w} a game ${ah > aa ? "at home" : "on the road"}`, viz: kv,
        text: `Against ${fa(Math.min(ah, aa))} ${ah > aa ? "on the road" : "at home"}. ${ah > aa ? "He's a different player in front of his own crowd." : "He plays better away from home, which is rare."}` });
    }
    // a streak going right now: TDs (sacks for defenders) in a row, or a drought
    let on = 0, off = 0;
    for (let i = n - 1; i >= 0 && (G[i].s[P.td] || 0) > 0; i--) on++;
    for (let i = n - 1; i >= 0 && !(G[i].s[P.td] || 0); i--) off++;
    const tdTot = sum(P.td);
    if (on >= (group === "defensive" ? 2 : 3)) out.push({ big: `${on} straight`, label: `games with a ${P.tdw}`, viz: VK[P.td], text: `${who} has a ${P.tdw} in each of his last ${on} games. Don't expect it to stop.` });
    else if (off >= 3 && tdTot > 0 && group !== "defensive") out.push({ big: `${off} straight`, label: `games without a ${P.tdw}`, viz: VK[P.td], text: `${who} has ${fmt(tdTot)} on the year but none in his last ${off}. The end zone has dried up.` });
    // games with 2+ touchdowns
    const multi = G.filter((g) => (g.s[P.td] || 0) >= 2).length;
    if (group !== "defensive" && multi >= 2) out.push({ big: fmt(multi), label: `games with 2+ ${P.tdw === "TD pass" ? "TD passes" : P.tdw + "s"}`, viz: VK[P.td],
      text: `${fmt(multi)} of his ${n} games. When he gets going, he finds the end zone more than once.` });
    // the efficiency numbers people argue about at his position
    if (group === "passing" && sum("passingAttempts") >= 50) {
      const td = sum("passingTouchdowns"), int = sum("interceptions"), cp = (100 * sum("completions")) / sum("passingAttempts");
      out.push({ big: `${fmt(td)}:${fmt(int)}`, label: "TD passes to interceptions", viz: "pass_td",
        text: !int ? "Not one pick all year. Nobody protects the ball better." : td / int >= 3 ? `${fmt(td / int, 1)} touchdowns for every pick. He doesn't give games away.` : td / int < 1.5 ? "That's too many turnovers for the touchdowns he's getting." : "Fine, not special. He needs more big throws or fewer mistakes." });
      if (cp >= 68 || cp < 60) out.push({ big: `${fmt(cp, 1)}%`, label: "completion rate", viz: "cmp_pct", text: cp >= 68 ? "Accurate and it isn't close. Defenses can't sit on the short stuff." : "Too many incompletions. Drives die on his misses." });
      const ry = sum("rushingYards");
      if (ry >= 120) out.push({ big: fmt(ry), label: "rushing yards (a QB)", viz: "rush_yds", text: `${fa(ry / n)} a game on the ground. Defenses have to account for his legs too.` });
    } else if (group === "rushing" && sum("rushingAttempts") >= 30) {
      const ypc = sum("rushingYards") / sum("rushingAttempts");
      if (ypc >= 5 || ypc < 4) out.push({ big: fmt(ypc, 1), label: "yards a carry", viz: "ypc", text: ypc >= 5 ? "Over 5 a carry. He should be getting the ball more." : "Under 4 a carry. That's a hard number to win with." });
      const recY = sum("receivingYards");
      if (names.includes("receivingYards") && recY >= 120) out.push({ big: fmt(recY), label: "receiving yards (a back)", viz: "rec_yds", text: `${fmt(sum("receptions"))} catches too. He's a weapon in the passing game, not just a runner.` });
      const lr = Math.max(...G.map((g) => g.s.longRushing || 0));
      if (lr >= 40) out.push({ big: fmt(lr), label: "longest run this year", text: "He can take any carry the distance." });
    } else if (group === "receiving" && sum("receptions") >= 15) {
      const ypr = sum("receivingYards") / sum("receptions");
      if (ypr >= 14 || ypr < 10) out.push({ big: fmt(ypr, 1), label: "yards a catch", viz: "ypr", text: ypr >= 14 ? "A real big-play threat. Every catch is a chunk." : "Mostly short stuff. He's a chain-mover, not a home-run hitter." });
      const tg = sum("receivingTargets");
      if (names.includes("receivingTargets") && tg >= 20) out.push({ big: fa(tg / n), label: "targets a game", viz: "targets", text: tg / n >= 8 ? "The ball is coming to him. He's the first read." : `He catches ${Math.round((100 * sum("receptions")) / tg)}% of them.` });
      const lr = Math.max(...G.map((g) => g.s.longReception || 0));
      if (lr >= 50) out.push({ big: fmt(lr), label: "longest catch this year", text: "One missed tackle and he's gone." });
    } else if (group === "defensive") {
      const sk = sum("sacks"), it = sum("interceptions"), pd = sum("passesDefended"), ff = sum("fumblesForced"), tfl = sum("stuffs");
      if (sk >= 3) out.push({ big: fmt(sk, 1), label: "sacks this season", viz: "def_sacks", text: `${fmt(sk / n, 2)} a game. Quarterbacks have to know where he is.` });
      if (it >= 2) out.push({ big: fmt(it), label: "interceptions", viz: "def_int", text: "Quarterbacks who test him have paid for it." });
      if (pd >= 6) out.push({ big: fmt(pd), label: "passes defended", viz: "pd", text: "He's around the ball on every throw his way." });
      if (ff >= 2) out.push({ big: fmt(ff), label: "forced fumbles", text: "He doesn't just tackle, he takes the ball." });
      if (tfl >= 5) out.push({ big: fmt(tfl), label: "run stuffs", text: "Offenses keep losing yards when he's around." });
    }
    // his best game, how many big ones, and his floor
    if (n >= 3) {
      const hi = G.reduce((b, g) => ((g.s[P.key] ?? 0) > (b.s[P.key] ?? 0) ? g : b), G[0]), bigs = key.filter((v) => v >= P.big).length;
      out.push({ big: fmt(hi.s[P.key] ?? 0), label: `season high: ${P.w} (${vs(hi.m)})`, viz: kv,
        text: `${hi.m.gameResult === "W" ? "A win" : hi.m.gameResult === "L" ? "A loss" : "The result"}, ${hi.m.score || ""}. ${bigs >= 2 ? `He has ${bigs} games with ${P.big}+ ${P.w} this year.` : bigs === 1 ? `His only ${P.big}+ game so far.` : "He hasn't had a true monster game yet."}` });
      const lo = Math.min(...key), mean = avg(key);
      if (group !== "defensive" && mean > 0 && lo >= mean * 0.75) out.push({ big: fmt(lo), label: `his worst game: ${P.w}`, viz: kv, text: "Even his off days are good. Nobody has taken him out of a game yet." });
    }
    return out.slice(0, 12);
  }

  // kickers: makes, misses and long ones (ESPN's kicker log has "made-attempts" pairs)
  function kickPoints(a, G) {
    if (G.length < 3) return [];
    const pair = (k) => G.reduce(([m, t], g) => { const x = String(g.raw?.[k] ?? "").split("-").map(Number); return [m + (x[0] || 0), t + (x[1] || 0)]; }, [0, 0]);
    const [fm, ft] = pair("fieldGoalsMade-fieldGoalAttempts"), [f50, a50] = pair("fieldGoalsMade50-fieldGoalAttempts50"), [xm, xa] = pair("extraPointsMade-extraPointAttempts");
    const lng = Math.max(...G.map((g) => g.s.longFieldGoalMade || 0)), who = a.lastName || a.displayName, out = [];
    if (ft) out.push({ big: `${fm}/${ft}`, label: "field goals", viz: "fg_pct", text: fm === ft ? `${who} hasn't missed a field goal all year. Automatic.` : `${Math.round((100 * fm) / ft)}%. ${fm / ft >= 0.9 ? "Money." : fm / ft < 0.8 ? "Coaches can't fully trust him yet." : "Solid, not automatic."}` });
    if (a50) out.push({ big: `${f50}/${a50}`, label: "from 50+ yards", text: f50 === a50 ? "Perfect from long range. Midfield is field goal range for him." : `${a50 - f50} miss${a50 - f50 > 1 ? "es" : ""} from 50+.` });
    if (lng >= 50) out.push({ big: fmt(lng), label: "longest field goal", text: "The leg is real." });
    if (xa && xm < xa) out.push({ big: `${xm}/${xa}`, label: "extra points", text: `${xa - xm} missed extra point${xa - xm > 1 ? "s" : ""}. Those points add up.` });
    return out;
  }

  // headlines about him from the last few days (news.json, hourly): his full name, or his last name in a story about his team
  async function headlines(a, lg) {
    const N = await getJSON("data/news.json").catch(() => null);
    const rx = (s) => new RegExp(`(^|[^\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`, "i");
    const full = rx(a.displayName || "_"), last = (a.lastName || "").split(" ")[0], lastRx = last.length >= 4 ? rx(last) : null;
    const tk = a.team?.id ? `${lg}:${a.team.id}` : "";
    return (N?.items || []).filter((it) => it.league === lg && (full.test(`${it.title} ${it.summary || ""}`)
      || (lastRx && lastRx.test(it.title) && tk && (it.teams || []).includes(tk)))).slice(0, 5);
  }

  // a: the player (ESPN): a Visualize link under each point that has a stat (inViz: he's in this season's chart data),
  // and one for all his stats at the bottom
  const pointsHtml = (rows, a, lg, inViz) => {
    if (!rows.length) return "";
    const viz = (k) => `#/stats?${new URLSearchParams({ league: lg, show: "visualize", him: a.id, ...(k ? { stat: k } : {}) })}`;
    return `<div class="tk-st-head"><h3>Talking points</h3><small class="muted">From this season's games · updates after every game</small></div>
    <div class="tk-st">${rows.map((r) => `<div class="tk-st-item"><b>${esc(r.big)}</b><small>${esc(r.label)}</small><p>${esc(r.text)}</p>${r.viz && inViz ? `<a class="tk-st-viz" href="${viz(r.viz)}">📈 See the chart ›</a>` : ""}</div>`).join("")}</div>
    ${inViz ? `<p class="tk-st-all"><a class="btn" href="${viz("")}">📈 See all his stats in Visualize</a></p>` : ""}`;
  };
  const headlinesHtml = (rows, first) => !rows.length ? "" : `<h3 class="${first ? "" : "tk-posts-h"}">In the headlines</h3><ul class="tk-hl">${rows.map((it) =>
    `<li><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a> <small class="muted">${esc(it.source || "")} · ${esc(new Date(it.published).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</small></li>`).join("")}</ul>`;

  return { render, about, list, starters, startersHtml, games, playerPoints, headlines, pointsHtml, headlinesHtml };
})();
