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
    const toggle = (open) => {
      panel.hidden = !open;
      fab.setAttribute("aria-expanded", String(open));
      el.classList.toggle("open", open);
      if (open) setTimeout(() => ta.focus(), 50);
    };
    fab.addEventListener("click", () => toggle(panel.hidden));
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
  // a little formatting: paragraphs, "- " lists, **bold**, and links to the site's own pages only
  function fmt(t) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((#\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    return t.trim().split(/\n{2,}/).map((p) => {
      const lines = p.split("\n");
      return lines.every((l) => /^\s*[-*•] /.test(l)) ? `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•] /, ""))}</li>`).join("")}</ul>` : `<p>${lines.map(inline).join("<br>")}</p>`;
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
    return `You are the Cupcake Analyst, the stat desk inside The Cupcake Index (cupcakeindex.com), a college football and NFL power rankings and analytics site. Motto: "Bullying cupcakes isn't a résumé." A member is chatting with you in a small panel on the site.

Today is ${new Date().toISOString().slice(0, 10)}. Our data: weekly stats for NFL players ${S("nfl").at(-1)}-${S("nfl")[0]} and college ${S("cfb").at(-1)}-${S("cfb")[0]} (regular season; the current seasons are partial), NFL team game stats back to ${T("nfl").at(-1)}, our model's rankings (NFL after week ${R.nfl.week}, college after week ${R.cfb.week} of ${R.cfb.season}), and the NFL injury report and depth charts.

How to answer:
- Use the tools for every number. find_player before player_stats; leaderboard to rank someone among peers; team_stats and our_rankings for teams, schedules and cupcake padding; team_status for injuries and starters; site_tab for our Injuries / Frauds / Over-achievers tabs; pace_to for "on pace for" questions; stat_menu to find the right stat; site_lists for coaches, records, Trade watch and our Heisman race; rare_plays for specific plays; how_we_count for how OUR stats and rankings are defined (call it before explaining any of our numbers). Make several calls in one round when you can.
- Only state numbers that came from a tool result in this conversation. Never use numbers from memory. If our data can't answer it, say what's missing in one line.
- Charts: when a chart would help or the member asks for one, call chart_stats to find the Visualize stat, then show_chart. It opens the chart on the site behind this panel. To send them to a page (rankings, a team page, Injuries...), use open_page.
- Leaderboard stat names: any column (pass_yds, rush_td, tackles, def_sacks, pressure, pen, pts...) or a rate. Player rates: ${Object.keys(BotTools.RATES).join(", ")}, passer_rating, passer_rating_vs_blitz. Team rates: ${Object.keys(BotTools.TEAM_RATES).join(", ")}.
- No betting content: no spreads, lines, odds, over/unders or picks against a line. Our win chance from our_rankings is fine.

Style: a sharp fan who knows the numbers, talking to another fan. Lead with the answer in one sentence, then the two or three numbers that back it (with ranks), then stop. Usually under 120 words; a list only when they asked for one. Write stats in plain words ("yards per carry", not ypc or column names). Take a side when the numbers point one way. No em dashes, no "Great question", no wrap-up sentence, no hashtags, no emoji. Plain text; **bold** sparingly; "- " for list items.`;
  }

  // ---------- the tools: the Analyst's (bot-tools.js) plus the site's own ----------
  const SITE = [
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
      description: "Open a Stats > Visualize chart on the site. stat (and y_stat for a scatter) must be keys from chart_stats. who: players or teams. type: bar, line (week by week), scatter (stat across, y_stat up), pie, radar or table. team: show only that team's players. highlight: teams to color (teams charts). position: QB RB WR TE K OL EDGE IDL LB CB S (players). top: 5, 10, 15, 25 or all. season_from/season_to, weeks_from/weeks_to: the range (default: this season, every week). per: game or total.",
      input_schema: { type: "object", properties: { league: { type: "string", enum: ["nfl", "cfb"] }, who: { type: "string", enum: ["players", "teams"] }, type: { type: "string", enum: ["bar", "line", "scatter", "pie", "radar", "table"] },
        stat: { type: "string" }, y_stat: { type: "string" }, team: { type: "string" }, highlight: { type: "array", items: { type: "string" } }, position: { type: "string" }, top: { type: "string" },
        season_from: { type: "integer" }, season_to: { type: "integer" }, weeks_from: { type: "integer" }, weeks_to: { type: "integer" }, per: { type: "string", enum: ["game", "total"] }, title: { type: "string" } }, required: ["league", "who", "type", "stat"] },
      async execute(a, links) {
        const lg = String(a.league), C = await Viz.catalog(lg), list = C[a.who === "teams" ? "teams" : "players"];
        for (const k of [a.stat, a.y_stat].filter(Boolean)) if (!list.some((s) => s[0] === k)) throw new Error(`"${k}" isn't a Visualize stat. Call chart_stats first.`);
        const D = await BotTools.load(lg, BotTools.seasons(lg)[0]);
        const key = (n) => { const k = BotTools.teamKey(D, n); if (!k) throw new Error(`No ${lg} team matching "${n}".`); return k; };
        const o = { league: lg, show: "visualize", who: a.who, type: a.type, stat: a.stat };
        if (a.y_stat) o.y = a.y_stat;
        if (a.team && a.who === "players") o.team = key(a.team);
        if (a.highlight?.length) o.pick = a.highlight.slice(0, 6).map(key).join(",");
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
