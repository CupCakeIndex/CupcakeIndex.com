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

  function playerPoints(a, gl, lg, group) {
    const P = PP[group], names = gl?.names || [];
    if (!P || !names.includes(P.key)) return [];
    // this season's games, oldest first (no preseason), one row per game
    const seen = new Set(), G = [];
    for (const stp of gl.seasonTypes || []) {
      if (/pre/i.test(stp.displayName || "")) continue;
      for (const ev of (stp.categories || []).flatMap((c) => c.events || [])) {
        const m = gl.events?.[ev.eventId];
        if (!m || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const s = {};
        names.forEach((n, i) => { if (!(n in s)) s[n] = num(ev.stats?.[i]); });
        G.push({ m, s, t: Date.parse(m.gameDate) || 0 });
      }
    }
    G.sort((x, y) => x.t - y.t);
    // only a current season: his last game in the past 60 days (ESPN hands retired players their last season)
    if (G.length < 2 || Date.now() - G[G.length - 1].t > 60 * 86400000) return [];
    const who = a.lastName || a.displayName, team = a.team?.shortDisplayName || a.team?.name || "His team";
    const vs = (m) => `${m.atVs === "@" ? "at" : "vs"} ${m.opponent?.abbreviation || "?"}`;
    const key = G.map((g) => g.s[P.key] ?? 0), n = G.length, out = [];

    // his best ESPN rank this season (interceptions thrown don't count as a good thing)
    const ranked = (a.statsSummary?.statistics || []).filter((s) => s.rank && !(group === "passing" && s.name === "interceptions"))
      .sort((x, y) => x.rank - y.rank)[0];
    const top = lg === "nfl" ? 10 : 25;
    if (ranked && ranked.rank <= top) {
      const r = String(ranked.rankDisplayValue || ranked.rank).replace(/^Tied-/i, "tied for ");
      out.push({ big: r.replace(/^tied for /, "T-"), label: `in ${lg === "nfl" ? "the NFL" : "the country"}: ${ranked.displayName}`,
        text: `${who} is ${r} in ${ranked.displayName.replace(/\w+/g, (w) => (/[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()))} (${ranked.displayValue}). ${ranked.rank <= 3 ? "That's a name that belongs in the best-at-his-position talk." : `Top ${top}. Where does he rank at his position for you?`}` });
    }
    // last game against what he'd done before it
    if (n >= 4) {
      const last = key[n - 1], before = avg(key.slice(0, -1)), g = G[n - 1];
      if (before > 0 && (last >= before * 1.3 || last <= before * 0.7)) {
        const up = last > before, by = Math.round(Math.abs(last / before - 1) * 100);
        out.push({ big: fmt(last), label: `${P.w} last game (${vs(g.m)})`,
          text: `That's ${by}% ${up ? "over" : "under"} his ${fa(before)} a game before it. ${up ? "One more like it and it's a trend." : "Worth watching how he bounces back."}` });
      }
    }
    // last 3 games against the rest of the season
    if (n >= 6) {
      const l3 = avg(key.slice(-3)), early = avg(key.slice(0, -3));
      if (early > 0 && Math.abs(l3 / early - 1) >= 0.25) {
        const up = l3 > early;
        out.push({ big: fa(l3), label: `${P.w} a game, last 3`,
          text: `${up ? "Up" : "Down"} from ${fa(early)} a game in his first ${n - 3}. ${up ? "He's getting better as the season goes." : "Something has changed since the start of the year."}` });
      }
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
    // a streak going right now: TDs (sacks for defenders) in a row, or a drought
    let on = 0, off = 0;
    for (let i = n - 1; i >= 0 && (G[i].s[P.td] || 0) > 0; i--) on++;
    for (let i = n - 1; i >= 0 && !(G[i].s[P.td] || 0); i--) off++;
    const tdTot = G.reduce((s, g) => s + (g.s[P.td] || 0), 0);
    if (on >= (group === "defensive" ? 2 : 3)) out.push({ big: `${on} straight`, label: `games with a ${P.tdw}`, text: `${who} has a ${P.tdw} in each of his last ${on} games. Don't expect it to stop.` });
    else if (off >= 3 && tdTot > 0 && group !== "defensive") out.push({ big: `${off} straight`, label: `games without a ${P.tdw}`, text: `${who} has ${fmt(tdTot)} on the year but none in his last ${off}. The end zone has dried up.` });
    // the efficiency number people argue about at his position
    const sum = (k) => G.reduce((s, g) => s + (g.s[k] || 0), 0);
    if (group === "passing" && sum("passingAttempts") >= 50) {
      const td = sum("passingTouchdowns"), int = sum("interceptions");
      out.push({ big: `${fmt(td)}:${fmt(int)}`, label: "TD passes to interceptions",
        text: !int ? "Not one pick all year. Nobody protects the ball better." : td / int >= 3 ? `${fmt(td / int, 1)} touchdowns for every pick. He doesn't give games away.` : td / int < 1.5 ? "That's too many turnovers for the touchdowns he's getting." : "Fine, not special. He needs more big throws or fewer mistakes." });
    } else if (group === "rushing" && sum("rushingAttempts") >= 30) {
      const ypc = sum("rushingYards") / sum("rushingAttempts");
      if (ypc >= 5 || ypc < 4) out.push({ big: fmt(ypc, 1), label: "yards a carry", text: ypc >= 5 ? "Over 5 a carry. He should be getting the ball more." : "Under 4 a carry. That's a hard number to win with." });
    } else if (group === "receiving" && sum("receptions") >= 15) {
      const ypr = sum("receivingYards") / sum("receptions");
      if (ypr >= 14 || ypr < 10) out.push({ big: fmt(ypr, 1), label: "yards a catch", text: ypr >= 14 ? "A real big-play threat. Every catch is a chunk." : "Mostly short stuff. He's a chain-mover, not a home-run hitter." });
    } else if (group === "defensive" && sum("sacks") >= 3) {
      out.push({ big: fmt(sum("sacks"), 1), label: "sacks this season", text: `${fmt(sum("sacks") / n, 2)} a game. Quarterbacks have to know where he is.` });
    }
    // his best game, and how many big ones
    if (n >= 3) {
      const hi = G.reduce((b, g) => ((g.s[P.key] ?? 0) > (b.s[P.key] ?? 0) ? g : b), G[0]), bigs = key.filter((v) => v >= P.big).length;
      out.push({ big: fmt(hi.s[P.key] ?? 0), label: `season high: ${P.w} (${vs(hi.m)})`,
        text: `${hi.m.gameResult === "W" ? "A win" : hi.m.gameResult === "L" ? "A loss" : "The result"}, ${hi.m.score || ""}. ${bigs >= 2 ? `He has ${bigs} games with ${P.big}+ ${P.w} this year.` : bigs === 1 ? `His only ${P.big}+ game so far.` : "He hasn't had a true monster game yet."}` });
    }
    return out.slice(0, 7);
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

  const pointsHtml = (rows) => !rows.length ? "" : `<div class="tk-st-head"><h3>Talking points</h3><small class="muted">From this season's games · updates after every game</small></div>
    <div class="tk-st">${rows.map((r) => `<div class="tk-st-item"><b>${esc(r.big)}</b><small>${esc(r.label)}</small><p>${esc(r.text)}</p></div>`).join("")}</div>`;
  const headlinesHtml = (rows, first) => !rows.length ? "" : `<h3 class="${first ? "" : "tk-posts-h"}">In the headlines</h3><ul class="tk-hl">${rows.map((it) =>
    `<li><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a> <small class="muted">${esc(it.source || "")} · ${esc(new Date(it.published).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</small></li>`).join("")}</ul>`;

  return { render, about, list, starters, startersHtml, playerPoints, headlines, pointsHtml, headlinesHtml };
})();
