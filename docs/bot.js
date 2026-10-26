// The Cupcake Analyst chat: a small button in the bottom right, only for members (for now: the emails the Worker
// lists in MEMBERS). Ask a question; Claude answers from the site's own data with the same stat tools as Terry's
// Analyst page (bot-tools.js, generated from analyst/index.html), and can open a Visualize chart or a page of the
// site. The Claude key lives in the Worker (workers/analyst.js), which also counts questions and cost per member.
// The lookups run here, in the page, on the same files the site shows; only the conversation goes to the Worker.
const Bot = (() => {
  const URL_ = "https://cupcake-analyst.thecupcakeindex-support.workers.dev";
  const MAX_ROUNDS = 8; // tool rounds per question
  let me = null, msgs = [], busy = false, el = null, user = null, tools = null;
  // the stat tools (57 KB) load only for members, the first time the button shows
  const needTools = () => tools ||= new Promise((ok, bad) => {
    const s = document.createElement("script");
    s.src = `bot-tools.js?v=${SITE_VERSION}`; s.onload = ok; s.onerror = () => { tools = null; bad(new Error("The Analyst's tools didn't load. Check your connection.")); };
    document.head.appendChild(s);
  });

  async function call(path, body) {
    const token = await user.getIdToken();
    const r = await fetch(URL_ + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || `The Analyst isn't answering (${r.status}).`), { usage: d.usage });
    return d;
  }

  // ---------- who sees the button: signed in, and a member ----------
  window.addEventListener("account", async (ev) => {
    user = ev.detail;
    me = null;
    if (user) { try { me = await call("/me"); } catch (e) { me = null; } }
    show();
  });
  function show() {
    const on = !!me?.member;
    if (!on) { el?.remove(); el = null; return; }
    if (!el) build();
    needTools().catch(() => {});
    usageLine();
  }

  // ---------- the button and the panel ----------
  function build() {
    el = document.createElement("div");
    el.className = "bot";
    el.innerHTML = `<button type="button" class="bot-fab" aria-expanded="false" aria-controls="bot-panel" title="Ask the Cupcake Analyst">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>
        <span>Ask</span></button>
      <section id="bot-panel" class="bot-panel" hidden aria-label="Cupcake Analyst">
        <header><b>Cupcake Analyst</b><span class="bot-use muted"></span>
          <button type="button" class="bot-new" title="Start a new conversation">New</button>
          <button type="button" class="bot-x" aria-label="Close">✕</button></header>
        <div class="bot-log" aria-live="polite"><p class="bot-hi muted">Ask about any player, team or stat. I answer from the site's own numbers and can open a chart for you.
          Try "Who leads the NFL in CPOE?" or "Chart Indiana's offense vs defense".</p></div>
        <form class="bot-ask"><textarea rows="1" maxlength="600" placeholder="Ask a football question" aria-label="Your question"></textarea>
          <button type="submit" class="bot-send">Send</button></form>
      </section>`;
    document.body.appendChild(el);
    const fab = el.querySelector(".bot-fab"), panel = el.querySelector(".bot-panel"), ta = el.querySelector("textarea");
    let shut = 0;
    const toggle = (open) => { // the panel grows out of the Ask button, and shrinks back into it (style.css bot-pop)
      clearTimeout(shut);
      fab.setAttribute("aria-expanded", String(open));
      el.classList.toggle("open", open);
      panel.classList.toggle("closing", !open);
      if (open) { panel.hidden = false; setTimeout(() => ta.focus(), 50); }
      else shut = setTimeout(() => { panel.hidden = true; panel.classList.remove("closing"); }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    };
    fab.addEventListener("click", () => toggle(panel.hidden || panel.classList.contains("closing")));
    el.querySelector(".bot-x").addEventListener("click", () => toggle(false));
    el.querySelector(".bot-new").addEventListener("click", () => { if (busy) return; msgs = []; el.querySelector(".bot-log").innerHTML = ""; ta.focus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) toggle(false); });
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.querySelector("form").requestSubmit(); } });
    el.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = ta.value.trim();
      if (!q || busy) return;
      ta.value = ""; ta.style.height = "auto";
      ask(q);
    });
  }
  function usageLine() {
    const u = el?.querySelector(".bot-use");
    if (!u || !me) return;
    const over = me.questions > me.limit;
    u.textContent = `${me.questions}/${me.limit} this month${me.testing ? ` · $${(me.usd || 0).toFixed(2)}` : ""}${over ? " · over" : ""}`;
    u.title = me.testing ? `Testing: today ${me.today} questions. Members get ${me.limit} a month${me.day_limit ? ` and ${me.day_limit} a day` : ""}; you're not stopped at ${me.limit}, only at $${me.cap_usd} a month.` : "";
  }

  // ---------- the conversation ----------
  const log = () => el.querySelector(".bot-log");
  function bubble(cls, html) {
    const d = document.createElement("div");
    d.className = "bot-msg " + cls;
    d.innerHTML = html;
    log().appendChild(d);
    log().scrollTop = log().scrollHeight;
    return d;
  }
  // formatting so an answer scans instead of reading like a wall: the first line is the lead, "Label: detail" lines
  // become labeled rows, a short line ending in ":" is a small heading, and records, scores, win chances, ranks and
  // injury statuses are colored. Also **bold**, "- " lists, and links to the site's own pages only.
  const KV = /^([A-Z#][^:.!?]{0,34}):\s+(.+)$/; // "Giants: 163 points for", "Questionable: Marcus Mariota (knee)"
  function fmt(t) {
    const color = (h) => h.split(/(<[^>]+>)/).map((s, i) => i % 2 ? s : s
      .replace(/\b(out for the season|Out|IR|on injured reserve|Injured reserve)\b/g, '<span class="bot-bad">$1</span>')
      .replace(/\b(Questionable|Doubtful)\b/g, '<span class="bot-warn">$1</span>')
      .replace(/(^|[\s(])(#\d{1,3}|\d+(?:\.\d+)?%|\d{1,3}-\d{1,3}(?:-\d{1,2})?)(?=[\s,.;:)!?]|$)/g, '$1<span class="bot-num">$2</span>')).join("");
    const inline = (s) => color(esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((#\/[^)\s]+)\)/g, '<a href="$2">$1</a>'));
    const kv = (l) => { const m = l.match(KV); return m ? `<b class="bot-k">${inline(m[1])}</b> ${inline(m[2])}` : inline(l); };
    const paras = t.trim().split(/\n{2,}/);
    return paras.map((p, n) => {
      const lines = p.split("\n").map((l) => l.trim()).filter(Boolean), bullet = /^[-*•] /;
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^[^.!?]{2,40}:$/.test(l) && i < lines.length - 1) { out.push(`<h4 class="bot-h">${inline(l.slice(0, -1))}</h4>`); continue; }
        if (bullet.test(l)) { const items = []; while (i < lines.length && bullet.test(lines[i])) items.push(`<li>${kv(lines[i++].replace(bullet, ""))}</li>`); i--; out.push(`<ul>${items.join("")}</ul>`); continue; }
        if (KV.test(l) && (KV.test(lines[i + 1] || "") || KV.test(lines[i - 1] || ""))) { const rows = []; while (i < lines.length && KV.test(lines[i])) rows.push(`<div>${kv(lines[i++])}</div>`); i--; out.push(`<div class="bot-rows">${rows.join("")}</div>`); continue; }
        out.push(`<p${n === 0 && i === 0 && paras.length + lines.length > 2 ? ' class="bot-lead"' : ""}>${inline(l)}</p>`);
      }
      return out.join("");
    }).join("");
  }

  async function ask(q) {
    busy = true;
    el.classList.add("busy");
    bubble("me", `<p>${esc(q)}</p>`);
    const wait = bubble("bot wait", `<p class="muted"><span class="bot-dots">Thinking</span></p>`);
    const steps = wait.querySelector("p");
    try { await needTools(); } catch (e) { wait.innerHTML = `<p class="bot-err">${esc(e.message)}</p>`; busy = false; el.classList.remove("busy"); return; }
    BotTools.setSay((s) => { steps.innerHTML = `<span class="bot-dots">${esc(s)}</span>`; log().scrollTop = log().scrollHeight; });
    const keep = msgs.length;
    msgs.push({ role: "user", content: q });
    const links = [];
    try {
      const system = await prompt();
      let res = null;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        res = await call("/chat", { system, tools: TOOL_DEFS(), messages: msgs, newQuestion: round === 0 });
        me = { ...me, ...res.usage };
        usageLine();
        msgs.push({ role: "assistant", content: res.content }); // the whole turn, thinking blocks included, unchanged
        if (res.stop_reason !== "tool_use") break;
        const results = [];
        for (const b of res.content.filter((x) => x.type === "tool_use")) {
          let out, bad = false;
          try { out = await run(b.name, b.input || {}, links); } catch (e) { out = { error: String(e.message || e) }; bad = true; }
          let s = JSON.stringify(out);
          if (s.length > 40000) s = s.slice(0, 40000) + "…(cut: ask for a narrower list)";
          results.push({ type: "tool_result", tool_use_id: b.id, content: s, ...(bad ? { is_error: true } : {}) });
        }
        msgs.push({ role: "user", content: results }); // every result of the round in one message
        steps.innerHTML = `<span class="bot-dots">Thinking</span>`;
      }
      const text = (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
      wait.classList.remove("wait");
      wait.innerHTML = (text ? fmt(text) : `<p class="muted">${res?.stop_reason === "refusal" ? "I can't help with that one." : "I ran out of steps on that one. Try asking it a narrower way."}</p>`)
        + links.map((l) => `<p><a class="bot-link" href="${esc(l.href)}">${esc(l.label)} →</a></p>`).join("");
    } catch (e) {
      msgs.length = keep; // drop the failed question, so the conversation stays valid
      if (e.usage) { me = { ...me, ...e.usage }; usageLine(); }
      wait.classList.remove("wait");
      wait.innerHTML = `<p class="bot-err">${esc(e.message || "Something went wrong.")}</p>`;
    }
    log().scrollTop = log().scrollHeight;
    busy = false;
    el.classList.remove("busy");
  }

  // ---------- the instructions ----------
  async function prompt() {
    const R = await BotTools.base(), S = BotTools.seasons, T = BotTools.teamSeasons;
    // the site's rankings can land a few minutes before the chat's copy is rebuilt (analyst_refresh.yml): say so
    const idx = await getJSON(`data/index.json?_=${Date.now()}`).catch(() => null);
    const behind = ["nfl", "cfb"].filter((lg) => { const ss = idx?.leagues?.[lg]?.seasons || {}, k = Object.keys(ss).sort().at(-1); return k && ss[k].weeks.at(-1) > R[lg].week; });
    return `You are the Cupcake Analyst, the stat desk inside The Cupcake Index (cupcakeindex.com), a college football and NFL power rankings and analytics site. Motto: "Bullying cupcakes isn't a résumé." A member is chatting with you in a small panel on the site.

Right now it's ${new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })} for the member. Our data: weekly stats for NFL players ${S("nfl").at(-1)}-${S("nfl")[0]} and college ${S("cfb").at(-1)}-${S("cfb")[0]} (regular season; the current seasons are partial), NFL team game stats back to ${T("nfl").at(-1)}, our model's rankings (NFL after week ${R.nfl.week}, college after week ${R.cfb.week} of ${R.cfb.season}), and the NFL injury report and depth charts.${behind.length ? ` Our ${behind.map((x) => x.toUpperCase()).join(" and ")} rankings were just updated and our_rankings may still show last week's for a few minutes: say so if they ask about rankings. game_prediction, scores, standings and news are always current.` : ""}

How to answer:
- Use the tools for every number. find_player before player_stats; leaderboard to rank someone among peers; team_stats and our_rankings for teams, schedules and cupcake padding; team_status for injuries and starters (the same list as our Injuries tab); site_tab for our Injuries / Frauds / Over-achievers tabs; pace_to for "on pace for" questions; stat_menu to find the right stat; site_lists for coaches, records, Trade watch and our Heisman race; rare_plays for specific plays; how_we_count for how OUR stats and rankings are defined (call it before explaining any of our numbers). Make several calls in one round when you can.
- Only state numbers that came from a tool result in this conversation. Never use numbers from memory. If our data can't answer it, say what's missing in one line.
- Charts: when a chart would help or the member asks for one, call chart_stats to find the Visualize stats, then show_chart. It opens the chart on the site behind this panel. Match the chart to the question:
  - Comparing specific players ("Toney vs Smith"): a radar with players = both player_ids from find_player, position set, and radar_stats = 5-7 stats that matter for that position (a WR: catches, receiving yards, yards per catch, receiving TDs, catch rate, yards after the catch...). Every chart about named players passes their ids in players, so they're on it.
  - Comparing teams: a radar or bar with highlight = those teams.
  - Who leads a stat: a bar, top 10, with the player or team they asked about in players / highlight.
  - Two stats against each other: a scatter, with the named players or teams highlighted.
  When they ask to change the chart ("make it a radar"), keep the same players or teams and redo show_chart; don't drop who they asked about. Never say the chart tool can't do something before trying it.
  To send them to a page (rankings, a team page, Injuries...), use open_page.
- Leaderboard stat names: any column (pass_yds, rush_td, tackles, def_sacks, pressure, pen, pts...) or a rate. Player rates: ${Object.keys(BotTools.RATES).join(", ")}, passer_rating, passer_rating_vs_blitz. Team rates: ${Object.keys(BotTools.TEAM_RATES).join(", ")}.
- "Who wins", "who do you have", "predict this game": call game_prediction and answer with our pick, the win chance and the predicted score, then the one or two reasons that matter most. Never say we don't have a prediction without calling it.
- Days and times: say when a game is ("tonight", "tomorrow", "Saturday") only by copying its "when" from scores, which is already in the member's time. Never work it out from dates yourself.
- Injury notes and headlines are reports from the date they carry (note_date, published). A game they mention may already be over: check scores before saying a player will or won't play in a game.
- "What's the score", "did they win", "when do they play": scores. Standings, division leaders, playoff seeds: standings. Recent news on a team or player: news.
- Our site is the source of truth. If no tool covers what they asked, say "I can't look that up yet" and point to the page with open_page; never say the site doesn't have something, and never guess.
- No betting content: no spreads, lines, odds, over/unders or picks against a line. Our win chance and predicted score are fine.

Style: a sharp fan who knows the numbers, talking to another fan. Lead with the answer in one sentence, then the two or three numbers that back it (with ranks), then stop. Usually under 120 words. Make it easy to scan on a phone: one idea per short paragraph, never a block of several sentences. When you give three or more facts of the same kind (teams, players, injuries), put each on its own line as "Label: detail" (like "Giants: 4-2-1, won 1 straight") or as "- " items, under a short line ending in ":" if it helps. Write stats in plain words ("yards per carry", not ypc or column names). Take a side when the numbers point one way. No em dashes, no "Great question", no wrap-up sentence, no hashtags, no emoji. Plain text; **bold** sparingly; "- " for list items.`;
  }

  // ---------- the tools: the Analyst's (bot-tools.js) plus the site's own ----------
  // The site's own tools read the same files and ESPN feeds the pages read, at the moment they're asked, so the chat
  // and the site can't disagree. (bot-tools.js reads data/analyst.json, rebuilt by analyst_refresh.yml.)
  const ESPN = (lg, path) => `https://site.web.api.espn.com/apis/${path}/sports/football/${lg === "nfl" ? "nfl" : "college-football"}`;
  const getJSON = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`Couldn't reach ${u.includes("espn") ? "ESPN" : "the site's data"} (${r.status}). Try again.`); return r.json(); };
  const matchTeam = (q, names) => { // best match first, so "Washington" finds Washington before Washington State
    q = BotTools.norm(q);
    for (const t of [(n) => n === q, (n) => n.split(" ").includes(q), (n) => n.includes(q)]) { const n = names.find((x) => t(BotTools.norm(x))); if (n) return n; }
    return null;
  };
  // a kickoff in the member's own time, with the day spelled out, so the chat never does date math:
  // "tonight 8:15 PM EDT", "tomorrow 7:00 PM EDT", "Saturday Oct 31, 12:00 PM EDT", "last Sunday Oct 25, 1:00 PM EDT"
  function whenIs(iso) {
    const d = new Date(iso), now = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const n = Math.round((day(d) - day(now)) / 864e5), time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const wd = d.toLocaleDateString("en-US", { weekday: "long" }), md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (n === 0) return `${d.getHours() >= 17 ? "tonight" : "today"} ${time}`;
    if (n === 1) return `tomorrow ${time}`;
    if (n === -1) return `yesterday ${time}`;
    return `${n < 0 && n > -7 ? "last " : ""}${wd} ${md}, ${time}${Math.abs(n) > 6 ? ` (${n > 0 ? `in ${n} days` : `${-n} days ago`})` : ""}`;
  }
  // one week of ESPN's scoreboard (this week if w is empty), team names the way our pages show them:
  // "Washington Commanders" (NFL), "Washington" (college: no mascot)
  async function espnWeek(lg, w) {
    const nm = (t) => (lg === "nfl" ? t?.displayName : t?.location || t?.displayName), q = new URLSearchParams();
    if (lg === "cfb") { q.set("groups", "80"); q.set("limit", "300"); }
    if (w) { q.set("seasontype", "2"); q.set("week", String(w)); }
    const sb = await getJSON(`${ESPN(lg, "site/v2")}/scoreboard?${q}`);
    const games = (sb.events || []).map((e) => {
      const c = e.competitions?.[0] || {}, st = e.status?.type || {};
      const side = (h) => { const t = (c.competitors || []).find((x) => x.homeAway === h) || {};
        return { team: nm(t.team), score: st.state === "pre" ? undefined : +t.score, record: t.records?.[0]?.summary, ap_rank: t.curatedRank?.current < 99 ? t.curatedRank.current : undefined }; };
      return { week: sb.week?.number, away: side("away"), home: side("home"), status: st.state === "pre" ? "not started" : st.completed ? "final" : "live",
        detail: st.shortDetail, when: whenIs(e.date), tv: (c.broadcasts || []).flatMap((b) => b.names || []).join(", ") || undefined };
    });
    return { n: sb.week?.number, games, bye: (sb.week?.teamsOnBye || []).map(nm) };
  }
  const gameOf = (W, team) => { const hit = matchTeam(team, W.games.flatMap((g) => [g.home.team, g.away.team]).filter(Boolean)); return hit && W.games.filter((g) => g.home.team === hit || g.away.team === hit); };
  const SITE = [
    {
      name: "game_prediction",
      description: "Our model's pick for a team's next game (or a given week), read live from the site: who we have winning, each side's win chance, our predicted score, both QBs, and the reasons the game page lists. Use it for any 'who wins', 'who do you have', 'predict', 'what's the score going to be' question.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" }, week: { type: "integer" } }, required: ["league", "team"] },
      async execute(a) {
        const lg = String(a.league), idx = await (await fetch("data/index.json", { cache: "no-store" })).json();
        const seasons = idx.leagues[lg].seasons, season = Object.keys(seasons).sort().at(-1), weeks = seasons[season].weeks;
        // which game: the week they named, else their game this week if it hasn't finished (tonight's game, not next
        // week's), else the newest picks. The rankings file from week N holds the picks for week N + 1 (like the game page).
        let want = a.week ? +a.week : null;
        if (!want) {
          const W = await espnWeek(lg).catch(() => null), g = W && gameOf(W, a.team);
          if (g?.length && g[0].status !== "final") want = W.n;
        }
        const file = want && weeks.includes(want - 1) ? want - 1 : weeks.at(-1);
        const W = await (await fetch(`data/${lg}/${season}/week_${file}.json`)).json();
        const P = W.predictions || [], hit = matchTeam(a.team, P.flatMap((x) => [x.home, x.away]));
        const p = hit && P.find((x) => x.home === hit || x.away === hit);
        if (!p) throw new Error(`No ${lg} prediction for "${a.team}" in week ${file + 1} (a bye, or not a team we rank).`);
        const hp = p.home_win_prob;
        // what the game page shows; never the spread, book lines or "edge" (the site's own betting-style numbers stay off)
        return { season: +season, week: p.week, away: p.away, home: p.home, our_pick: p.pick,
          win_chance: { [p.home]: Math.round(100 * hp), [p.away]: Math.round(100 - 100 * hp) },
          predicted_score: p.home_pts != null ? { [p.home]: p.home_pts, [p.away]: p.away_pts } : null, qbs: { [p.home]: p.home_qb, [p.away]: p.away_qb },
          why: p.notes || (p.why ? [p.why] : []) };
      },
    },
    {
      name: "scores",
      description: "Live from ESPN, same as our Scores page: this week's games (or a given week) with kickoff time, TV, live score and clock, or the final. With team: just that team's game. Use it for 'did they win', 'what's the score', 'when do they play', 'who plays tonight'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" }, week: { type: "integer" } }, required: ["league"] },
      async execute(a) {
        const lg = String(a.league);
        let W = await espnWeek(lg, a.week);
        if (!a.team) return { as_of: new Date().toISOString(), week: W.n, games: W.games.slice(0, 60), on_bye: W.bye.length ? W.bye : undefined };
        const find = (W) => gameOf(W, a.team);
        let games = find(W), bye = matchTeam(a.team, W.bye);
        // a bye (or this week already played and they're asking what's next): look one week ahead
        if (!games && !a.week && W.n) { const N = await espnWeek(lg, W.n + 1); games = find(N); if (games) W = N; }
        if (!games) throw new Error(bye ? `${bye} are on a bye in week ${W.n}.` : `No ${lg} game for "${a.team}" on ESPN's scoreboard${a.week ? ` in week ${a.week}` : ""}.`);
        return { as_of: new Date().toISOString(), week: W.n, ...(bye ? { note: `${bye} had a bye in week ${W.n - 1}; this is their next game.` } : {}), games };
      },
    },
    {
      name: "standings",
      description: "Live from ESPN, same as our Standings page: each division (NFL) or conference (college) with records, points for and against, streak and NFL playoff seed (1-7 make it), plus our rank. Optional team to get just its group.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" } }, required: ["league"] },
      async execute(a) {
        const lg = String(a.league), d = await getJSON(`${ESPN(lg, "v2")}/standings?${lg === "nfl" ? "level=3" : "group=80"}`);
        const groupsOf = (n) => (n.standings?.entries ? [{ name: n.name, entries: n.standings.entries }] : (n.children || []).flatMap(groupsOf));
        const st = (e, k) => e.stats.find((s) => s.type === k || s.name === k)?.displayValue;
        const ours = Object.fromEntries((BotTools.data()?.[lg]?.teams || []).map((t) => [BotTools.norm(t.team), t.rank]));
        let groups = groupsOf(d).map((g) => ({ group: g.name, teams: g.entries.map((e) => {
          const name = lg === "nfl" ? e.team.displayName : e.team.location || e.team.displayName;
          return { team: name, our_rank: ours[BotTools.norm(name)], record: st(e, "total"), conf: lg === "nfl" ? st(e, "vs. Conf.") : st(e, "vsconf"),
            pts_for: st(e, lg === "nfl" ? "pointsFor" : "pointsfor"), pts_against: st(e, lg === "nfl" ? "pointsAgainst" : "pointsagainst"), streak: st(e, "streak"),
            ...(lg === "nfl" ? { seed: +(e.stats.find((s) => s.type === "playoffseed" || s.name === "playoffseed")?.value || 0) || undefined } : {}) }; }) }));
        if (a.team) {
          const hit = matchTeam(a.team, groups.flatMap((g) => g.teams.map((t) => t.team)));
          if (!hit) throw new Error(`No ${lg} team matching "${a.team}" in the standings.`);
          groups = groups.filter((g) => g.teams.some((t) => t.team === hit));
        }
        return { groups };
      },
    },
    {
      name: "news",
      description: "Our News page: the latest headlines (title, source, time, one-line summary), newest first. Optional search words (a team, a player, 'trade'). Use it for 'what happened with', 'any news on', 'why is he out'.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, search: { type: "string" } }, required: [] },
      async execute(a) {
        const n = await getJSON(`data/news.json?_=${Date.now()}`), w = BotTools.norm(a.search || "").split(" ").filter(Boolean);
        const items = (n.items || []).filter((x) => (!a.league || x.league === a.league) && w.every((t) => BotTools.norm(`${x.title} ${x.summary || ""}`).includes(t)));
        if (!items.length) throw new Error(`No headlines on our News page match "${a.search || ""}" right now.`);
        return { updated: n.updated, headlines: items.slice(0, 12).map((x) => ({ title: x.title, source: x.source, published: x.published, summary: x.summary || undefined })) };
      },
    },
    {
      name: "chart_stats",
      description: "Find the Stats > Visualize stat key for a chart. search = plain words ('yards per carry', 'sacks', 'epa'). who = players or teams. Returns up to 25 [key, label, group, position].",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, who: { type: "string", enum: ["players", "teams"] }, search: { type: "string" } }, required: ["league", "who", "search"] },
      async execute(a) {
        const C = await Viz.catalog(String(a.league)), list = C[a.who === "teams" ? "teams" : "players"];
        const w = BotTools.norm(a.search).split(" ").filter(Boolean);
        const score = (s) => w.filter((x) => BotTools.norm(s[1] + " " + s[0] + " " + s[2]).includes(x)).length;
        const hits = list.map((s) => [score(s), s]).filter(([n]) => n).sort((x, y) => y[0] - x[0]).slice(0, 25).map(([, s]) => s);
        return hits.length ? hits : { none: true, groups: [...new Set(list.map((s) => s[2]))] };
      },
    },
    {
      name: "show_chart",
      description: "Open a Stats > Visualize chart on the site. stat (and y_stat for a scatter) must be keys from chart_stats. who: players or teams. type: bar, line (week by week), scatter (stat across, y_stat up), pie, radar or table. players: player_ids from find_player (up to 5): a radar then shows exactly them, other charts highlight them. highlight: team names (teams charts: a radar shows exactly them; others color them). radar_stats: 4-8 chart_stats keys for the radar's spokes (leave out for the position's usual profile). team: only that team's players. position: QB RB WR TE K OL EDGE IDL LB CB S (players; set it for a player radar so percentiles compare like with like). top: 5, 10, 15, 25 or all. season_from/season_to, weeks_from/weeks_to: the range (default: this season, every week). per: game or total.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, who: { type: "string", enum: ["players", "teams"] }, type: { type: "string", enum: ["bar", "line", "scatter", "pie", "radar", "table"] },
        stat: { type: "string" }, y_stat: { type: "string" }, team: { type: "string" }, players: { type: "array", items: { type: "string" } }, highlight: { type: "array", items: { type: "string" } },
        radar_stats: { type: "array", items: { type: "string" } }, position: { type: "string" }, top: { type: "string" },
        season_from: { type: "integer" }, season_to: { type: "integer" }, weeks_from: { type: "integer" }, weeks_to: { type: "integer" }, per: { type: "string", enum: ["game", "total"] }, title: { type: "string" } }, required: ["league", "who", "type", "stat"] },
      async execute(a, links) {
        const lg = String(a.league), C = await Viz.catalog(lg), list = C[a.who === "teams" ? "teams" : "players"];
        for (const k of [a.stat, a.y_stat, ...(a.radar_stats || [])].filter(Boolean)) if (!list.some((s) => s[0] === k)) throw new Error(`"${k}" isn't a Visualize stat. Call chart_stats first.`);
        const D = await BotTools.load(lg, BotTools.seasons(lg)[0]);
        const key = (n) => { const k = BotTools.teamKey(D, n); if (!k) throw new Error(`No ${lg} team matching "${n}".`); return k; };
        const o = { league: lg, show: "visualize", who: a.who, type: a.type, stat: a.stat };
        if (a.y_stat) o.y = a.y_stat;
        if (a.team && a.who === "players") o.team = key(a.team);
        if (a.who === "players" && a.players?.length) {
          const bad = a.players.filter((id) => !D.pmeta[String(id)]);
          if (bad.length) throw new Error(`No ${lg} ${D.season || ""} games for player_id ${bad.join(", ")}. Use the player_id from find_player.`);
          o.pick = a.players.slice(0, 5).map(String).join(",");
        }
        if (a.who === "teams" && a.highlight?.length) o.pick = a.highlight.slice(0, 6).map(key).join(",");
        if (a.type === "radar" && a.radar_stats?.length) o.radar = a.radar_stats.slice(0, 8).join(",");
        if (a.position && a.who === "players") o.pos = String(a.position).toUpperCase();
        if (a.top) o.top = String(a.top);
        if (a.season_from) o.from = String(a.season_from);
        if (a.season_to) o.to = String(a.season_to);
        if (a.weeks_from) o.wk1 = String(a.weeks_from);
        if (a.weeks_to) o.wk2 = String(a.weeks_to);
        if (a.per) o.per = a.per;
        if (a.title) o.ttl = String(a.title).slice(0, 80);
        const href = `#/stats?${new URLSearchParams(o)}`;
        go(href);
        links.push({ href, label: a.title ? `Chart: ${a.title}` : "Open the chart" });
        return { opened: true, note: "The chart is open on the page behind the chat. Say what it shows in a sentence; don't repeat the link." };
      },
    },
    {
      name: "open_page",
      description: "Open a page of the site: rankings, resume (Résumé Check), schedules, team (a team's page, needs team), scores, standings, leaders (Stats), injuries, frauds (NFL), projected, records (NFL), takes, news, trade_watch (NFL), coaches.",
      input_schema: { type: "object", properties: { page: { type: "string", enum: ["rankings", "resume", "schedules", "team", "scores", "standings", "leaders", "injuries", "frauds", "projected", "records", "takes", "news", "trade_watch", "coaches"] },
        league: { type: "string", enum: ["nfl", "cfb"] }, team: { type: "string" } }, required: ["page", "league"] },
      async execute(a, links) {
        const lg = String(a.league), p = String(a.page);
        const SHOW = { injuries: "injuries", frauds: "frauds", projected: "projected", records: "records" };
        let href, label = p.replace("_", " ");
        if (p === "team") {
          const D = await BotTools.load(lg, BotTools.seasons(lg)[0]), k = BotTools.teamKey(D, a.team || "");
          if (!k) throw new Error(`No ${lg} team matching "${a.team}".`);
          href = `#/team/${encodeURIComponent(k.split(":")[1])}?league=${lg}`;
          label = D.teams[k][0];
        } else if (SHOW[p] || p === "leaders") href = `#/stats?league=${lg}${SHOW[p] ? "&show=" + SHOW[p] : ""}`;
        else href = `#/${p === "trade_watch" ? "trades" : p}?league=${lg}`;
        go(href);
        links.push({ href, label: `Open ${label}` });
        return { opened: true, page: label };
      },
    },
  ];
  // on a phone the panel covers the page: tuck it away so the chart or page is what they see
  function go(href) {
    location.hash = href.slice(1);
    if (window.innerWidth < 600) setTimeout(() => el?.querySelector(".bot-x")?.click(), 900);
  }
  const TOOL_DEFS = () => [...BotTools.TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    ...SITE.map(({ name, description, input_schema }) => ({ name, description, input_schema }))];
  async function run(name, input, links) {
    const t = SITE.find((x) => x.name === name) || BotTools.TOOLS.find((x) => x.name === name);
    if (!t) throw new Error(`No tool named ${name}.`);
    await BotTools.base();
    return t.execute(input, links);
  }

  return { show };
})();
