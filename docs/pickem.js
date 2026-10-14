// Pick'em: this week's games from ESPN's scoreboard. Tap a team to pick it; games lock at kickoff and are graded when final.
// The whole week also locks at Saturday 11:59 PM Eastern, or earlier when you tap "Lock in my picks".
// Picks are kept in this browser (per league + season + week) and in the URL, so the address bar is always a shareable link.
// Your season record (week by week, streak, vs. our model) is kept in this browser too: pickem-log-<league>-<season>.
// Uses helpers from app.js ($, esc, link, league, store, modelRanks, weekData, INDEX, thumb, parseHash) and live.js (Live.kit).
const Pickem = (() => {
  let cur = null;    // what's on screen: { lg, season, type, week, events, picks, all, key }
  let wired = false; // the view's click handlers are set up once (the view element stays; its content is redrawn)

  // Picks in the URL: each picked winner's ESPN team id in base 36, dot-separated (a team plays once a week), e.g. &picks=1j.8.2t
  const enc = (picks) => [...picks.values()].map((id) => (+id).toString(36)).join(".");
  const dec = (s) => (/^[0-9a-z.]{1,600}$/.test(s || "") ? s.split(".").filter(Boolean).map((x) => String(parseInt(x, 36))) : []);

  const comp = (e) => e.competitions[0];
  const side = (e, ha) => comp(e).competitors.find((c) => c.homeAway === ha);
  const state = (e) => e.status.type.state;
  const kicked = (e) => state(e) !== "pre" || new Date(e.date) <= Date.now();
  const locked = (e) => kicked(e) || !!cur?.weekLocked;

  // A time Eastern (EDT or EST, whichever applies) on the given weekday (0 = Sun) on or after the slate's first game
  function etAfter(events, dow, hhmm, strict = false) {
    if (!events.length) return null;
    const first = new Date(Math.min(...events.map((e) => +new Date(e.date))));
    const et = (d, o) => d.toLocaleString("en-US", { timeZone: "America/New_York", ...o });
    const day = new Date(et(first)).getDay(), n = (dow - day + 7) % 7 || (strict ? 7 : 0);
    const ymd = new Date(+first + n * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const probe = new Date(`${ymd}T${hhmm}:00Z`), edt = /EDT/.test(et(probe, { timeZoneName: "short" }));
    return +probe + (edt ? 4 : 5) * 36e5;
  }
  // Saturday 11:59 PM Eastern of the week this slate starts in
  const deadline = (events) => etAfter(events, 6, "23:59");
  // When next week's picks open: NFL Monday 11:59 PM Eastern, college Sunday 12:00 AM Eastern
  const nextOpens = (lg, events) => (lg === "nfl" ? etAfter(events, 1, "23:59") : etAfter(events, 0, "00:00", true));

  // ---- season log: { "2:5": { w, l, mw, ml, seq: "WWL", done } } per league + season, kept in this browser
  const logKey = (lg, season) => `pickem-log-${lg}-${season}`;
  const readLog = (lg, season) => { try { return JSON.parse(store.get(logKey(lg, season)) || "{}") || {}; } catch (e) { return {}; } };
  const writeLog = (lg, season, log) => store.set(logKey(lg, season), JSON.stringify(log));
  // Perfect Pick'em badge: every game on the week's slate picked, locked in before the deadline, and all of them right.
  // Kept in localStorage "pickem-badges" ([{lg, season, wk}]), which syncs to your account like your picks (account.js).
  const badges = () => { try { return JSON.parse(store.get("pickem-badges") || "[]") || []; } catch (e) { return []; } };
  function checkPerfect(lg, season, type, week, key, events, picks, g) {
    const lockedAt = +store.get(`${key}-lock`) || 0, slateN = +store.get(`${key}-slate`) || 0, due = deadline(events);
    if (!g.done || g.l || !g.w || !lockedAt || !slateN || (due && lockedAt > due) || g.w + (g.v || 0) < slateN || picks.size < slateN) return; // a tie is void, so it doesn't break a perfect week
    const list = badges(), wk = `${type}:${week}`;
    if (list.some((b) => b.lg === lg && b.season === +season && b.wk === wk)) return;
    list.push({ lg, season: +season, wk, n: g.w });
    store.set("pickem-badges", JSON.stringify(list));
    setTimeout(() => alert(`🏅 Perfect Pick'em! You went ${g.w}-0 this week. The badge (and a gold frame on your picture) is yours for good.`), 300);
  }
  // grade one week's stored picks: your record, the model's record on the same games, and the W/L sequence by kickoff
  function gradeWeek(events, picks, preds) {
    let w = 0, l = 0, v = 0, mw = 0, ml = 0, seq = "", pending = 0;
    events.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach((e) => {
      const id = picks.get(String(e.id));
      if (!id) return;
      if (state(e) !== "post") { pending++; return; }
      const won = comp(e).competitors.find((c) => c.winner);
      if (!won) { v++; return; } // a tie is void: doesn't count either way
      const right = String(won.team.id) === id;
      right ? w++ : l++;
      seq += right ? "W" : "L";
      const pr = preds.get(String(e.id));
      if (pr) ((pr.home_win_prob >= 0.5) === (won.homeAway === "home") ? mw++ : ml++);
    });
    return { w, l, v, mw, ml, seq, done: !pending && w + l + v > 0 };
  }
  const tname = (lg, t) => (lg === "nfl" ? t.shortDisplayName : t.location || t.shortDisplayName);
  const apRank = (c) => { const r = c.curatedRank?.current; return r && r <= 25 ? r : null; };

  // Final games with a pick: [right, wrong]
  function record(events, picks) {
    let w = 0, l = 0;
    events.forEach((e) => {
      const id = picks.get(String(e.id));
      if (!id || state(e) !== "post") return;
      const won = comp(e).competitors.find((c) => c.winner);
      if (!won) return; // a tie is void
      String(won.team.id) === id ? w++ : l++;
    });
    return [w, l];
  }

  async function render(params, refresh = false) {
    const K = Live.kit, lg = league, my = K.token(), root = $("#view-picks");
    if (params.get("board") === "1") return Leaderboard.render(root, lg); // Pick'em > Leaderboard (leaderboard.js)
    const q = new URLSearchParams();
    if (lg === "cfb") { q.set("groups", "80"); q.set("limit", "300"); }
    const wk = params.get("week"), yr = params.get("season");
    if (wk && /^\d+:\d+$/.test(wk)) { const [st, w] = wk.split(":"); q.set("seasontype", st); q.set("week", w); if (/^\d{4}$/.test(yr || "")) q.set("dates", yr); }
    if (!refresh) root.innerHTML = `<div class="card muted">Loading…</div>`;
    let sb, ranks;
    try {
      [sb, ranks] = await Promise.all([K.api(`${K.SITE(lg)}/scoreboard?${q}`, refresh ? 0 : 20000), modelRanks(lg)]);
    } catch (e) {
      root.innerHTML = `<div class="card">Couldn't load this week's games from ESPN (${esc(e.message)}). Try again in a minute.</div>`;
      return;
    }
    if (my !== K.token()) return;
    // ESPN keeps showing last week for a day or two; once next week's picks open (and nothing is live), show next week
    const opens = nextOpens(lg, sb.events || []);
    if (!wk && opens && Date.now() >= opens && !(sb.events || []).some((e) => state(e) === "in")) {
      const y = sb.season?.year, t = sb.season?.type, w = sb.week?.number;
      const tries = t === 2 ? [[t, w + 1], [3, 1]] : [[t, w + 1]]; // after the last regular-season week comes postseason week 1
      for (const [st, n] of tries) {
        q.set("seasontype", st); q.set("week", n); q.set("dates", y);
        const nx = await K.api(`${K.SITE(lg)}/scoreboard?${q}`, refresh ? 0 : 20000).catch(() => null);
        if (nx?.events?.length && nx.week?.number === n && nx.season?.type === st) { sb = nx; break; }
      }
      if (my !== K.token()) return;
    }
    const season = sb.season?.year, type = sb.season?.type, week = sb.week?.number;

    // the model's win chance for each game, from the rankings file made the week before
    const preds = new Map();
    if (type === 2 && INDEX.leagues[lg].seasons[season]?.weeks.includes(week - 1)) {
      const d = await weekData(lg, season, week - 1).catch(() => null);
      (d?.predictions || []).forEach((p) => preds.set(String(p.espn_id), p));
    }
    if (my !== K.token()) return;

    const events = (sb.events || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date) || a.id - b.id);
    // A shared link's picks win, else this browser's saved picks. Each pick is stored by game: event id -> team id.
    const key = `pickem-${lg}-${season}-${type}-${week}`;
    const ids = params.has("picks") ? dec(params.get("picks")) : dec(store.get(key));
    const picks = new Map();
    ids.forEach((id) => {
      const e = events.find((ev) => comp(ev).competitors.some((c) => String(c.team.id) === id));
      if (e) picks.set(String(e.id), id);
    });
    const due = deadline(events), mine = !params.has("picks") || params.get("picks") === store.get(key); // a friend's link isn't your record
    const lockedAt = +store.get(`${key}-lock`) || null;
    cur = { lg, season, type, week, events, picks, preds, ranks, key, mine, due, lockedAt, browsing: !!(wk && /^\d+:\d+$/.test(wk)), // browsing: an earlier week from the boxes
      weekLocked: !!lockedAt || (due != null && Date.now() > due), all: lg === "nfl" || params.get("all") === "1" };
    if (mine && picks.size) logWeek();
    if (mine) Leaderboard.publish(lg, season, readLog(lg, season)); // your row on the leaderboard (only if you have a leaderboard name)
    draw();
    if (!wired) wire(root);
    if (mine) catchUp(lg, season, type, week); // grade earlier weeks you picked but haven't opened since they finished

    if (events.some((e) => state(e) === "in")) K.poll(() => render(parseHash().params, true), 60000);
    else if (events.some((e) => state(e) === "pre" && new Date(e.date) - Date.now() < 3600000)) K.poll(() => render(parseHash().params, true), 120000);
  }

  // Which version of our model graded a week ("Our model on your games"). When the model changes, the weekly files are
  // rebuilt with the new model's picks, and every week graded with an older one gets graded again (catchUp).
  // NFL 2 = injuries + QB quality (v1.63.0).
  const MODEL_V = { nfl: 2, cfb: 1 };

  function logWeek() {
    const { lg, season, type, week, events, picks, preds } = cur;
    const log = readLog(lg, season), g = { ...gradeWeek(events, picks, preds), mv: MODEL_V[lg] };
    if (g.w + g.l + g.v || log[`${type}:${week}`]) { log[`${type}:${week}`] = g; writeLog(lg, season, log); }
    checkPerfect(lg, season, type, week, cur.key, events, picks, g);
  }

  // Earlier weeks with saved picks whose games weren't all final last time: fetch that week's scoreboard and grade it
  async function catchUp(lg, season, type, week) {
    const K = Live.kit, log = readLog(lg, season), todo = [];
    let n = 0;
    try { n = localStorage.length; } catch (e) { return; } // storage blocked (private mode): nothing to catch up
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i), m = k && k.match(new RegExp(`^pickem-${lg}-${season}-(\\d+)-(\\d+)$`));
      const g = log[`${m?.[1]}:${m?.[2]}`];
      if (m && !(+m[1] === type && +m[2] === week) && (!g?.done || g.v == null || (g.mv || 1) < MODEL_V[lg])) todo.push([+m[1], +m[2], k]); // v == null: graded before ties were void; old mv: graded with an older model
    }
    for (const [t, w, k] of todo.slice(0, 8)) {
      try {
        const q = new URLSearchParams({ seasontype: t, week: w, dates: season });
        if (lg === "cfb") { q.set("groups", "80"); q.set("limit", "300"); }
        const sb = await K.api(`${K.SITE(lg)}/scoreboard?${q}`, 600000);
        const ids = dec(store.get(k)), picks = new Map();
        ids.forEach((id) => { const e = (sb.events || []).find((ev) => comp(ev).competitors.some((c) => String(c.team.id) === id)); if (e) picks.set(String(e.id), id); });
        const preds = new Map();
        if (t === 2 && INDEX.leagues[lg].seasons[season]?.weeks.includes(w - 1)) {
          ((await weekData(lg, season, w - 1).catch(() => null))?.predictions || []).forEach((p) => preds.set(String(p.espn_id), p));
        }
        const g = { ...gradeWeek(sb.events || [], picks, preds), mv: MODEL_V[lg] };
        if (g.w + g.l + g.v) { log[`${t}:${w}`] = g; writeLog(lg, season, log); }
        checkPerfect(lg, season, t, w, k, sb.events || [], picks, g);
      } catch (e) { /* ESPN hiccup: try again next visit */ }
    }
    if (todo.length) Leaderboard.publish(lg, season, readLog(lg, season));
    if (todo.length && cur && cur.lg === lg && cur.season === season) draw();
  }

  // Your season so far, from the log: record, win %, week-by-week, best week, streak, vs. our model
  function seasonPanel() {
    const { lg, season, type, week } = cur, log = readLog(lg, season);
    const wkName0 = (k) => { const [t, w] = k.split(":"); return t === "3" ? (lg === "nfl" ? `Playoffs ${w}` : "Bowls") : `Wk ${w}`; };
    const mine = badges().filter((b) => b.lg === lg && b.season === +season);
    const badgeHtml = mine.length ? `<div class="pk-badges">${mine.map((b) => `<span class="pk-badge" title="Every game picked, locked in on time, all right">🏅 Perfect Pick'em · ${esc(wkName0(b.wk))} (${b.n}-0)</span>`).join("")}</div>` : "";
    const weeks = Object.entries(log).filter(([, g]) => g.w + g.l).sort(([a], [b]) => {
      const [ta, wa] = a.split(":").map(Number), [tb, wb] = b.split(":").map(Number);
      return ta - tb || wa - wb;
    });
    if (!weeks.length) return badgeHtml + `<div class="pk-season muted">Your season record shows up here once your first picked game is final. It's kept in this browser.</div>`;
    const W = weeks.reduce((n, [, g]) => n + g.w, 0), L = weeks.reduce((n, [, g]) => n + g.l, 0);
    const MW = weeks.reduce((n, [, g]) => n + g.mw, 0), ML = weeks.reduce((n, [, g]) => n + g.ml, 0);
    const seq = weeks.map(([, g]) => g.seq || "").join(""), streakChar = seq.at(-1);
    const streak = streakChar ? seq.length - seq.replace(new RegExp(`${streakChar}+$`), "").length : 0;
    const best = weeks.filter(([, g]) => g.done).sort(([, a], [, b]) => b.w / (b.w + b.l) - a.w / (a.w + a.l) || b.w - a.w)[0];
    const wkName = (k) => { const [t, w] = k.split(":"); return t === "2" ? `Wk ${w}` : t === "3" ? (lg === "nfl" ? `Playoffs ${w}` : `Bowls`) : `Wk ${w}`; };
    const pct = (w, l) => (w + l ? Math.round((100 * w) / (w + l)) : 0);
    const beatModel = MW + ML ? (W > MW ? "you're ahead of our model" : W < MW ? "our model is ahead of you" : "dead even with our model") : "";
    return `<div class="pk-season">
      ${badgeHtml}
      <div class="pk-big"><b>${W}-${L}</b><small>your ${season} season · ${pct(W, L)}%</small></div>
      <div class="pk-facts">
        ${streak > 1 ? `<span><b>${streak}</b> ${streakChar === "W" ? "right" : "wrong"} in a row</span>` : ""}
        ${best ? `<span>Best week: <b>${wkName(best[0])}</b> ${best[1].w}-${best[1].l}</span>` : ""}
        ${MW + ML ? `<span title="Our model's record picking the same games you picked">Our model on your games: <b>${MW}-${ML}</b> · ${beatModel}</span>` : ""}
      </div>
      <div class="pk-weeks">${weeks.map(([k, g]) => `<a class="pk-wk${k === `${type}:${week}` ? " now" : ""}${g.done ? "" : " open"}" href="${link("picks", null, { season, week: k })}" title="${g.done ? "Final" : "Games still to play"}: see your picks">
        <i style="--p:${pct(g.w, g.l)}%"></i><small>${wkName(k)}</small><b>${g.w}-${g.l}</b></a>`).join("")}${cur.browsing
          ? `<a class="pk-wk pk-this" href="${link("picks")}" title="Back to this week's games"><small>Back to</small><b>This week →</b></a>` : ""}</div>
    </div>`;
  }

  // CFB slate: games with an AP Top 25 team or one of our top 25 (plus any game you've picked); "All FBS games" shows the rest
  function slate() {
    const { lg, events, picks, ranks, all } = cur;
    if (all) return events;
    return events.filter((e) => picks.has(String(e.id)) || comp(e).competitors.some((c) => apRank(c) || (Live.kit.ourTeam(ranks, lg, c.team)?.rank || 99) <= 25));
  }

  const weekName = () => (cur.type === 2 ? `Week ${cur.week}` : cur.type === 3 ? (cur.lg === "nfl" ? "Playoffs" : "Bowls") : `Week ${cur.week}`);

  function draw() {
    const K = Live.kit, { lg, events, picks, preds, ranks } = cur, root = $("#view-picks");
    const list = slate(), [w, l] = record(events, picks), open = list.filter((e) => !locked(e)).length;
    const { due, lockedAt, weekLocked } = cur;
    const when = (t) => new Date(t).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
    const lockTxt = lockedAt ? `🔒 Locked in ${when(lockedAt)}` : weekLocked ? "🔒 Picks closed (Saturday 11:59 PM ET deadline)"
      : due ? `Picks lock ${when(due)}, or at kickoff` : "";
    const status = (w + l ? `<b class="pk-rec">You're ${w}-${l} this week</b> · ` : "")
      + `${picks.size} of ${list.length} game${list.length === 1 ? "" : "s"} picked` + (open || weekLocked ? "" : " · all games have kicked off")
      + (lockTxt ? ` · <span class="pk-lock${weekLocked ? " on" : ""}">${lockTxt}</span>` : "");
    const team = (e, c) => {
      const t = c.team, id = String(t.id), on = picks.get(String(e.id)) === id, st = state(e), ours = K.ourTeam(ranks, lg, t);
      const tie = st === "post" && !comp(e).competitors.some((x) => x.winner);
      const mark = on && st === "post" ? (tie ? `<b class="pk-mark V" title="Tie: this pick is void">VOID</b>` : c.winner ? `<b class="pk-mark W">✓</b>` : `<b class="pk-mark L">✗</b>`) : "";
      return `<button class="pk-team${on ? " on" : ""}${st === "post" && !tie ? (c.winner ? " win" : " lose") : ""}" data-team="${esc(id)}" aria-pressed="${on}"${locked(e) ? " disabled" : ""}>
        ${K.img(K.teamLogo(t), "sm")}${apRank(c) ? `<span class="ap-rk">${apRank(c)}</span>` : ""}
        <b class="pk-n">${esc(tname(lg, t))}</b><small class="muted">${esc(c.records?.[0]?.summary || "")}</small>
        ${ours ? `<span class="our-rk" title="Cupcake Index rank">#${ours.rank}</span>` : ""}
        <span class="pk-sc">${st === "pre" ? "" : esc(c.score ?? "")}</span>${mark}</button>`;
    };
    const game = (e) => {
      const p = preds.get(String(e.id)), a = side(e, "away"), h = side(e, "home");
      const fav = p && (p.home_win_prob >= 0.5 ? h : a), prob = p && chancePct(Math.max(p.home_win_prob, 1 - p.home_win_prob));
      const hint = fav ? `<span title="Our model's win chance for its favorite">model: ${esc(fav.team.abbreviation || tname(lg, fav.team))} ${prob}</span>` : "";
      const st = state(e), when = K.statusText(e.status, e.date) + (st === "pre" && locked(e) ? " · locked" : "");
      return `<div class="pk-game ${st}" data-id="${esc(e.id)}">
        <div class="pk-st">${st === "in" ? '<span class="live-dot"></span>' : ""}<span>${esc(when)}${comp(e).neutralSite ? " · neutral" : ""}</span><a href="${link("game", e.id)}" class="muted">details</a></div>
        ${team(e, a)}<div class="pk-at muted">@</div>${team(e, h)}
        ${hint ? `<div class="pk-hint muted">${hint}</div>` : ""}</div>`;
    };
    const toggle = lg === "cfb" ? `<div class="presets pk-show">${[["", "Top 25 games"], ["1", "All FBS games"]].map(([v, t]) =>
      `<button data-show="${v}" class="${!v === !cur.all ? "on" : ""}">${t}</button>`).join("")}</div>` : "";
    root.innerHTML = `<div class="subtabs"><a class="subtab on" href="${link("picks")}">My picks</a><a class="subtab" href="${link("picks", null, { board: 1 })}">Leaderboard</a></div>
      <div class="card pk-card">
      <h2>Pick'em · ${esc(weekName())} <span class="muted">${esc(LEAGUE_NAME[lg] || lg)}</span></h2>
      ${cur.mine ? seasonPanel() : `<div class="pk-season muted">These are a friend's picks from a shared link. Make your own picks to start your record.</div>`}
      <p class="pk-status">${status}</p>
      <div class="br-tools pk-tools">${toggle}<button data-act="clear"${picks.size && !weekLocked ? "" : " disabled"}>Clear picks</button>
        ${cur.mine && !weekLocked ? `<button data-act="lock" class="pk-lockbtn"${picks.size ? "" : " disabled"}>🔒 Lock in my picks</button>` : ""}${Share.menuHtml()}
        ${list.some((e) => cur.preds.has(String(e.id))) ? `<button data-act="modelimg" title="Download a picture of every winner our model picks this week">Share our picks</button>` : ""}</div>
      ${list.length ? `<div class="pk-grid">${list.map(game).join("")}</div>` : `<p class="muted">No games this week.</p>`}
      <p class="note">Tap a team to pick it; tap again to undo. Each game locks at kickoff, and the whole week locks Saturday at 11:59 PM Eastern (or as soon as you tap Lock in). Next week's games show up Sunday for college and Monday at 11:59 PM Eastern for the NFL.
        Your picks get a ✓ or ✗ when the game is final and add to your season record (a tie is void and doesn't count), which stays in this browser unless you clear its data.
        Pick every game, lock in before the deadline and get them all right for the permanent 🏅 Perfect Pick'em badge.
        Picks are saved in this browser and in the page link, so Share › Copy Link sends your slate to a friend. "model" = our ratings' win chance for the team they favor. Just for fun.</p></div>`;
  }

  // Remember the picks (this browser) and keep them in the URL
  function save() {
    const { lg, season, type, week, picks, key, all } = cur, e = enc(picks);
    store.set(key, e);
    cur.mine = true; // once you pick, these are yours
    const p = e ? { season, week: `${type}:${week}`, picks: e } : {};
    if (lg === "cfb" && all) p.all = "1";
    history.replaceState(history.state, "", link("picks", null, p));
  }

  function wire(root) {
    wired = true;
    root.addEventListener("click", (e) => {
      if (!cur || !root.querySelector(".pk-card")) return;
      const b = e.target.closest(".pk-team");
      if (b && !b.disabled) {
        const gid = b.closest(".pk-game").dataset.id, id = b.dataset.team;
        cur.picks.get(gid) === id ? cur.picks.delete(gid) : cur.picks.set(gid, id);
        save(); return draw();
      }
      const box = e.target.closest(".pk-game");
      if (box && !e.target.closest("a")) { location.hash = link("game", box.dataset.id); return; } // the rest of a game's box opens the game
      const show = e.target.closest("[data-show]");
      if (show) { cur.all = show.dataset.show === "1"; save(); return draw(); }
      if (e.target.closest('[data-act="lock"]')) {
        if (!confirm("Lock in your picks for this week? You won't be able to change them.")) return;
        store.set(`${cur.key}-lock`, String(Date.now()));
        store.set(`${cur.key}-slate`, String(slate().length)); // how many games were on the slate (Perfect Pick'em needs them all)
        cur.lockedAt = Date.now(); cur.weekLocked = true;
        return draw();
      }
      if (e.target.closest('[data-act="clear"]')) {
        // games that already kicked off keep their picks (they're locked)
        [...cur.picks.keys()].forEach((gid) => { const ev = cur.events.find((x) => String(x.id) === gid); if (ev && !locked(ev)) cur.picks.delete(gid); });
        save(); draw();
      }
    });
    Share.wire(root, { image });
    // Share our picks: downloads the model's picture (phones get the share sheet, where Save Image is)
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest('[data-act="modelimg"]');
      if (!btn || btn.disabled) return;
      const was = btn.textContent;
      btn.textContent = "Drawing…"; btn.disabled = true;
      const done = (t) => { btn.textContent = t; setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 1600); };
      try {
        const { blob, name } = await modelImage();
        await Share.download(blob, name);
        done(was);
      } catch (err) { done(err.message || "Couldn't draw it"); }
    });
  }

  // ---- Pictures (Save Image and Share our picks): the same card grid, drawn to fill the 1600x900 frame.
  // Each card: kickoff (or FINAL) on top, then away and home rows; the chosen team gets the orange tint and bar.
  // opts: { title, sub, stats: [[big, small]], games, chosen(e) -> "home" | "away" | null,
  //         right(e, c, on) -> [{ t, color, bold, small }] drawn right to left, footer, name }
  async function gridImage(opts) {
    const { lg } = cur, games = opts.games;
    const logoUrls = new Map();
    games.forEach((e) => comp(e).competitors.forEach((c) => logoUrls.set(String(c.team.id), thumb(Live.kit.teamLogo(c.team), 80))));
    const n = games.length, cols = n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 30 ? 5 : 6, rows = Math.ceil(n / cols);
    const kick = (e) => {
      const st = state(e);
      if (st === "post") return e.status?.type?.shortDetail || "FINAL";
      if (st === "in") return "LIVE · " + (e.status?.type?.shortDetail || "");
      return new Date(e.date).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
    };
    const blob = await Share.png({
      title: opts.title, sub: opts.sub, logoUrls,
      paint: ({ x, text, F, C, W, H, logos }) => {
        const rr = (px, py, w, h, r) => { x.beginPath(); if (x.roundRect) x.roundRect(px, py, w, h, r); else x.rect(px, py, w, h); };
        // stat chips, top right
        let sx = W - 48;
        x.textBaseline = "alphabetic";
        (opts.stats || []).slice().reverse().forEach(([big, small]) => {
          x.font = F(700, 30); const bw = x.measureText(big).width; x.font = F(400, 13); const sw = x.measureText(small).width;
          const w = Math.max(bw, sw) + 32, px = sx - w;
          rr(px, 44, w, 76, 10); x.fillStyle = C.card; x.fill(); x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
          text(big, px + w / 2, 86, F(700, 30), C.accent, "center");
          text(small.toUpperCase(), px + w / 2, 108, F(400, 13), C.muted, "center");
          sx = px - 12;
        });
        // the grid fills everything between the header and the footer
        const ay = 150, ah = H - 92 - ay, gap = rows > 5 ? 10 : 16;
        const cw = Math.min(560, (W - 96 - gap * (cols - 1)) / cols), ch = Math.min(190, (ah - gap * (rows - 1)) / rows);
        const ax = (W - (cw * cols + gap * (cols - 1))) / 2; // a short list stays centered instead of stretching
        const top = ay + (ah - (ch * rows + gap * (rows - 1))) / 2;
        const hh = Math.max(18, Math.min(30, ch * 0.2)), rh = (ch - hh) / 2;
        const fs = Math.max(12, Math.min(26, rh * 0.36)), ls = Math.min(44, rh * 0.62), ks = Math.max(10, Math.min(14, hh * 0.5));
        games.forEach((e, i) => {
          const gx = ax + (i % cols) * (cw + gap), gy = top + Math.floor(i / cols) * (ch + gap), pick = opts.chosen(e);
          x.save();
          rr(gx, gy, cw, ch, 12); x.fillStyle = C.card; x.fill(); x.clip();
          x.textBaseline = "middle";
          text(kick(e).toUpperCase(), gx + 16, gy + hh / 2 + 2, F(400, ks), C.muted, "left", cw - 32);
          [side(e, "away"), side(e, "home")].forEach((c, r) => {
            const t = c.team, on = c.homeAway === pick, ry = gy + hh + r * rh, mid = ry + rh / 2;
            if (on) {
              const gr = x.createLinearGradient(gx, 0, gx + cw, 0);
              gr.addColorStop(0, "rgba(255,122,61,0.30)"); gr.addColorStop(1, "rgba(255,122,61,0.06)");
              x.fillStyle = gr; x.fillRect(gx, ry, cw, rh);
              x.fillStyle = C.accent; x.fillRect(gx, ry, 5, rh);
            }
            if (r) { x.strokeStyle = C.line; x.lineWidth = 1; x.beginPath(); x.moveTo(gx + 14, ry); x.lineTo(gx + cw - 14, ry); x.stroke(); }
            const lx = gx + 18, im = logos.get(String(t.id));
            x.globalAlpha = on || !pick ? 1 : 0.55;
            if (im) x.drawImage(im, lx, mid - ls / 2, ls, ls);
            else text(String(t.abbreviation || "").slice(0, 4), lx + ls / 2, mid, F(700, fs * 0.5), C.muted, "center");
            x.globalAlpha = 1;
            // right side, drawn right to left
            let rx = gx + cw - 16;
            for (const part of opts.right(e, c, on)) {
              const f = F(part.bold ? 700 : 400, part.small ? fs * 0.7 : fs);
              text(part.t, rx, mid, f, part.color, "right"); x.font = f; rx -= x.measureText(part.t).width + 12;
            }
            let tx = lx + ls + 12;
            if (r) { text("@", tx, mid, F(400, fs * 0.8), C.muted); x.font = F(400, fs * 0.8); tx += x.measureText("@ ").width; }
            const ap = apRank(c);
            if (ap) { text(String(ap), tx, mid, F(400, fs * 0.7), C.muted); x.font = F(400, fs * 0.7); tx += x.measureText(String(ap)).width + 6; }
            text(tname(lg, t), tx, mid, F(on ? 700 : 400, fs), on ? C.accent : C.ink, "left", rx - tx - 4);
          });
          x.restore();
          rr(gx + 0.5, gy + 0.5, cw - 1, ch - 1, 12); x.strokeStyle = C.line; x.lineWidth = 1; x.stroke();
        });
        x.textBaseline = "alphabetic";
        text(opts.footer, 48, H - 40, F(400, 14), C.muted);
      },
    });
    return { blob, name: opts.name };
  }
  const graded = (e) => state(e) === "post" && comp(e).competitors.some((c) => c.winner);
  const fileWeek = () => weekName().toLowerCase().replace(/\s+/g, "");

  // ---- Share our picks: our model's pick in each game on the slate, its win chance and the predicted score
  async function modelImage() {
    const { lg, season, preds } = cur;
    const games = slate().filter((e) => preds.has(String(e.id)));
    if (!games.length) throw new Error("No predictions yet");
    const chosen = (e) => (preds.get(String(e.id)).home_win_prob >= 0.5 ? "home" : "away");
    let w = 0, l = 0;
    games.forEach((e) => { const won = graded(e) && comp(e).competitors.find((c) => c.winner); if (won) won.homeAway === chosen(e) ? w++ : l++; });
    return gridImage({
      title: `OUR ${weekName().toUpperCase()} PICKS · ${LEAGUE_NAME[lg] || lg.toUpperCase()}`,
      sub: "Our pick in orange, with its chance to win and our predicted score",
      stats: [[String(games.length), "games"], ...(w + l ? [[`${w}-${l}`, "so far"]] : [])],
      games, chosen,
      right: (e, c, on) => {
        const p = preds.get(String(e.id)), C = Share.C, out = [];
        if (graded(e) && on) out.push({ t: c.winner ? "✓" : "✗", color: c.winner ? C.good : C.bad, bold: true });
        const pts = p[c.homeAway === "home" ? "home_pts" : "away_pts"];
        if (pts != null) out.push({ t: String(pts), color: on ? C.ink : C.muted, bold: on });
        if (on) out.push({ t: chancePct(c.homeAway === "home" ? p.home_win_prob : 1 - p.home_win_prob), color: C.accent, small: true });
        return out;
      },
      footer: "Cupcake Index model · just for fun",
      name: `cupcake-index-${lg}-predictions-${season}-${fileWeek()}.png`,
    });
  }

  // ---- Save Image: the games you picked, your pick in orange, ✓/✗ once final
  async function image() {
    const { lg, events, picks, season } = cur;
    const games = events.filter((e) => picks.has(String(e.id)));
    if (!games.length) throw new Error("Pick a game first");
    const [w, l] = record(events, picks);
    const lg2 = readLog(lg, season), SW = Object.values(lg2).reduce((a, g) => a + g.w, 0), SL = Object.values(lg2).reduce((a, g) => a + g.l, 0);
    const chosen = (e) => { const id = picks.get(String(e.id)); return comp(e).competitors.find((c) => String(c.team.id) === id)?.homeAway || null; };
    return gridImage({
      title: `MY ${weekName().toUpperCase()} PICKS · ${LEAGUE_NAME[lg] || lg.toUpperCase()}`,
      sub: `${games.length} pick${games.length === 1 ? "" : "s"} · my pick in orange`,
      stats: [...(w + l ? [[`${w}-${l}`, "this week"]] : []), ...(SW + SL ? [[`${SW}-${SL}`, "season"]] : [])],
      games, chosen,
      right: (e, c, on) => {
        const C = Share.C, st = state(e), out = [];
        if (graded(e) && on) out.push({ t: c.winner ? "✓" : "✗", color: c.winner ? C.good : C.bad, bold: true });
        else if (st === "post" && on) out.push({ t: "VOID", color: C.muted, bold: true, small: true }); // a tie
        if (st === "pre") out.push({ t: c.records?.[0]?.summary || "", color: C.muted, small: true }); // record before kickoff
        else out.push({ t: String(c.score ?? ""), color: c.winner ? C.ink : C.muted, bold: !!c.winner });
        return out;
      },
      footer: "Pick'em · just for fun",
      name: `cupcake-index-${lg}-pickem-${season}-${fileWeek()}.png`,
    });
  }

  return { render, image };
})();
