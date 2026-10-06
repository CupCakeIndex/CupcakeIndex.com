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
  // grade one week's stored picks: your record, the model's record on the same games, and the W/L sequence by kickoff
  function gradeWeek(events, picks, preds) {
    let w = 0, l = 0, mw = 0, ml = 0, seq = "", pending = 0;
    events.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach((e) => {
      const id = picks.get(String(e.id));
      if (!id) return;
      const won = state(e) === "post" && comp(e).competitors.find((c) => c.winner);
      if (!won) { pending++; return; }
      const right = String(won.team.id) === id;
      right ? w++ : l++;
      seq += right ? "W" : "L";
      const pr = preds.get(String(e.id));
      if (pr) ((pr.home_win_prob >= 0.5) === (won.homeAway === "home") ? mw++ : ml++);
    });
    return { w, l, mw, ml, seq, done: !pending && w + l > 0 };
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
      if (!won) return; // a tie (or no result yet) isn't graded
      String(won.team.id) === id ? w++ : l++;
    });
    return [w, l];
  }

  async function render(params, refresh = false) {
    const K = Live.kit, lg = league, my = K.token(), root = $("#view-picks");
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
    cur = { lg, season, type, week, events, picks, preds, ranks, key, mine, due, lockedAt,
      weekLocked: !!lockedAt || (due != null && Date.now() > due), all: lg === "nfl" || params.get("all") === "1" };
    if (mine && picks.size) logWeek();
    draw();
    if (!wired) wire(root);
    if (mine) catchUp(lg, season, type, week); // grade earlier weeks you picked but haven't opened since they finished

    if (events.some((e) => state(e) === "in")) K.poll(() => render(parseHash().params, true), 60000);
    else if (events.some((e) => state(e) === "pre" && new Date(e.date) - Date.now() < 3600000)) K.poll(() => render(parseHash().params, true), 120000);
  }

  function logWeek() {
    const { lg, season, type, week, events, picks, preds } = cur;
    const log = readLog(lg, season), g = gradeWeek(events, picks, preds);
    if (g.w + g.l || log[`${type}:${week}`]) { log[`${type}:${week}`] = g; writeLog(lg, season, log); }
  }

  // Earlier weeks with saved picks whose games weren't all final last time: fetch that week's scoreboard and grade it
  async function catchUp(lg, season, type, week) {
    const K = Live.kit, log = readLog(lg, season), todo = [];
    let n = 0;
    try { n = localStorage.length; } catch (e) { return; } // storage blocked (private mode): nothing to catch up
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i), m = k && k.match(new RegExp(`^pickem-${lg}-${season}-(\\d+)-(\\d+)$`));
      if (m && !(+m[1] === type && +m[2] === week) && !log[`${m[1]}:${m[2]}`]?.done) todo.push([+m[1], +m[2], k]);
    }
    for (const [t, w, k] of todo.slice(0, 6)) {
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
        const g = gradeWeek(sb.events || [], picks, preds);
        if (g.w + g.l) { log[`${t}:${w}`] = g; writeLog(lg, season, log); }
      } catch (e) { /* ESPN hiccup: try again next visit */ }
    }
    if (todo.length && cur && cur.lg === lg && cur.season === season) draw();
  }

  // Your season so far, from the log: record, win %, week-by-week, best week, streak, vs. our model
  function seasonPanel() {
    const { lg, season, type, week } = cur, log = readLog(lg, season);
    const weeks = Object.entries(log).filter(([, g]) => g.w + g.l).sort(([a], [b]) => {
      const [ta, wa] = a.split(":").map(Number), [tb, wb] = b.split(":").map(Number);
      return ta - tb || wa - wb;
    });
    if (!weeks.length) return `<div class="pk-season muted">Your season record shows up here once your first picked game is final. It's kept in this browser.</div>`;
    const W = weeks.reduce((n, [, g]) => n + g.w, 0), L = weeks.reduce((n, [, g]) => n + g.l, 0);
    const MW = weeks.reduce((n, [, g]) => n + g.mw, 0), ML = weeks.reduce((n, [, g]) => n + g.ml, 0);
    const seq = weeks.map(([, g]) => g.seq || "").join(""), streakChar = seq.at(-1);
    const streak = streakChar ? seq.length - seq.replace(new RegExp(`${streakChar}+$`), "").length : 0;
    const best = weeks.filter(([, g]) => g.done).sort(([, a], [, b]) => b.w / (b.w + b.l) - a.w / (a.w + a.l) || b.w - a.w)[0];
    const wkName = (k) => { const [t, w] = k.split(":"); return t === "2" ? `Wk ${w}` : t === "3" ? (lg === "nfl" ? `Playoffs ${w}` : `Bowls`) : `Wk ${w}`; };
    const pct = (w, l) => (w + l ? Math.round((100 * w) / (w + l)) : 0);
    const beatModel = MW + ML ? (W > MW ? "you're ahead of our model" : W < MW ? "our model is ahead of you" : "dead even with our model") : "";
    return `<div class="pk-season">
      <div class="pk-big"><b>${W}-${L}</b><small>your ${season} season · ${pct(W, L)}%</small></div>
      <div class="pk-facts">
        ${streak > 1 ? `<span><b>${streak}</b> ${streakChar === "W" ? "right" : "wrong"} in a row</span>` : ""}
        ${best ? `<span>Best week: <b>${wkName(best[0])}</b> ${best[1].w}-${best[1].l}</span>` : ""}
        ${MW + ML ? `<span title="Our model's record picking the same games you picked">Our model on your games: <b>${MW}-${ML}</b> · ${beatModel}</span>` : ""}
      </div>
      <div class="pk-weeks">${weeks.map(([k, g]) => `<span class="pk-wk${k === `${type}:${week}` ? " now" : ""}${g.done ? "" : " open"}" title="${g.done ? "Final" : "Games still to play"}">
        <i style="--p:${pct(g.w, g.l)}%"></i><small>${wkName(k)}</small><b>${g.w}-${g.l}</b></span>`).join("")}</div>
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
      const mark = on && st === "post" && comp(e).competitors.some((x) => x.winner) ? (c.winner ? `<b class="pk-mark W">✓</b>` : `<b class="pk-mark L">✗</b>`) : "";
      return `<button class="pk-team${on ? " on" : ""}${st === "post" ? (c.winner ? " win" : " lose") : ""}" data-team="${esc(id)}" aria-pressed="${on}"${locked(e) ? " disabled" : ""}>
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
    root.innerHTML = `<div class="card pk-card">
      <h2>Pick'em · ${esc(weekName())} <span class="muted">${esc(LEAGUE_NAME[lg] || lg)}</span></h2>
      ${cur.mine ? seasonPanel() : `<div class="pk-season muted">These are a friend's picks from a shared link. Make your own picks to start your record.</div>`}
      <p class="pk-status">${status}</p>
      <div class="br-tools pk-tools">${toggle}<button data-act="clear"${picks.size && !weekLocked ? "" : " disabled"}>Clear picks</button>
        ${cur.mine && !weekLocked ? `<button data-act="lock" class="pk-lockbtn"${picks.size ? "" : " disabled"}>🔒 Lock in my picks</button>` : ""}${Share.menuHtml()}</div>
      ${list.length ? `<div class="pk-grid">${list.map(game).join("")}</div>` : `<p class="muted">No games this week.</p>`}
      <p class="note">Tap a team to pick it; tap again to undo. Each game locks at kickoff, and the whole week locks Saturday at 11:59 PM Eastern (or as soon as you tap Lock in). Next week's games show up Sunday for college and Monday at 11:59 PM Eastern for the NFL.
        Your picks get a ✓ or ✗ when the game is final and add to your season record, which stays in this browser unless you clear its data.
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
      const show = e.target.closest("[data-show]");
      if (show) { cur.all = show.dataset.show === "1"; save(); return draw(); }
      if (e.target.closest('[data-act="lock"]')) {
        if (!confirm("Lock in your picks for this week? You won't be able to change them.")) return;
        store.set(`${cur.key}-lock`, String(Date.now()));
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
  }

  // ---- Save Image: the games you picked as a grid of matchups, your pick in orange, ✓/✗ once final
  async function image() {
    const { lg, events, picks, season } = cur;
    const games = events.filter((e) => picks.has(String(e.id)));
    if (!games.length) throw new Error("Pick a game first");
    const [w, l] = record(events, picks);
    const logoUrls = new Map();
    games.forEach((e) => comp(e).competitors.forEach((c) => logoUrls.set(String(c.team.id), thumb(Live.kit.teamLogo(c.team), 40))));
    const n = games.length, cols = n <= 4 ? 2 : n <= 9 ? 3 : n <= 20 ? 4 : n <= 40 ? 5 : 6, rows = Math.ceil(n / cols);
    const blob = await Share.png({
      title: `MY ${weekName().toUpperCase()} PICKS · ${LEAGUE_NAME[lg] || lg.toUpperCase()}`,
      sub: (w + l ? `${w}-${l} this week · ` : "") + `${n} pick${n === 1 ? "" : "s"}` + (() => {
        const lg2 = readLog(lg, season), W = Object.values(lg2).reduce((a, g) => a + g.w, 0), L = Object.values(lg2).reduce((a, g) => a + g.l, 0);
        return W + L ? ` · ${W}-${L} on the season` : "";
      })(),
      logoUrls,
      paint: ({ x, text, F, C, W, H, logos }) => {
        const ax = 48, ay = 150, aw = W - 96, ah = H - 80 - ay - 20;
        const gap = rows > 8 ? 8 : 14, cw = (aw - gap * (cols - 1)) / cols, ch = Math.min(96, (ah - gap * (rows - 1)) / rows);
        const top = ay + (ah - (ch * rows + gap * (rows - 1))) / 2, rh = ch / 2, fs = Math.max(11, Math.min(18, rh * 0.42)), ls = Math.min(26, rh - 8);
        x.textBaseline = "middle";
        games.forEach((e, i) => {
          const gx = ax + (i % cols) * (cw + gap), gy = top + Math.floor(i / cols) * (ch + gap), st = state(e);
          const pickId = picks.get(String(e.id)), graded = st === "post" && comp(e).competitors.some((c) => c.winner);
          x.fillStyle = C.card; x.fillRect(gx, gy, cw, ch);
          x.strokeStyle = C.line; x.lineWidth = 1;
          x.beginPath(); x.moveTo(gx, gy + rh); x.lineTo(gx + cw, gy + rh); x.stroke();
          x.strokeRect(gx + 0.5, gy + 0.5, cw - 1, ch - 1);
          [side(e, "away"), side(e, "home")].forEach((c, r) => {
            const t = c.team, on = String(t.id) === pickId, ry = gy + r * rh, mid = ry + rh / 2, lx = gx + 12;
            if (on) { x.fillStyle = "#2a1a12"; x.fillRect(gx + 1, ry + 1, cw - 2, rh - 1); x.fillStyle = C.accent; x.fillRect(gx, ry, 4, rh); }
            const im = logos.get(String(t.id));
            if (im) x.drawImage(im, lx, mid - ls / 2, ls, ls);
            else text(String(t.abbreviation || "").slice(0, 4), lx + ls / 2, mid, F(700, 9), C.muted, "center"); // logo didn't load
            const right = (graded && on ? fs * 1.4 : 0) + fs * (st === "pre" ? 3 : 2.2);
            const ap = apRank(c), nx = lx + ls + 8;
            let tx = nx;
            if (r) { text("@", tx, mid, F(400, fs), C.muted); x.font = F(400, fs); tx += x.measureText("@ ").width; }
            if (ap) { text(String(ap), tx, mid, F(400, fs * 0.75), C.muted); x.font = F(400, fs * 0.75); tx += x.measureText(String(ap)).width + 6; }
            text(tname(lg, t), tx, mid, F(on ? 700 : 400, fs), on ? C.accent : C.muted, "left", gx + cw - tx - right - 10);
            if (st === "pre" && cw > 240) text(c.records?.[0]?.summary || "", gx + cw - 10, mid, F(400, fs * 0.8), C.muted, "right"); // record before kickoff
            if (st !== "pre") text(String(c.score ?? ""), gx + cw - 10 - (graded && on ? fs * 1.4 : 0), mid, F(c.winner ? 700 : 400, fs), c.winner ? C.ink : C.muted, "right");
            if (graded && on) text(c.winner ? "✓" : "✗", gx + cw - 10, mid, F(700, fs), c.winner ? C.good : C.bad, "right");
          });
        });
        x.textBaseline = "alphabetic";
        text("Pick'em · just for fun", 48, H - 40, F(400, 14), C.muted);
      },
    });
    return { blob, name: `cupcake-index-${lg}-pickem-${season}-${weekName().toLowerCase().replace(/\s+/g, "")}.png` };
  }

  return { render, image };
})();
