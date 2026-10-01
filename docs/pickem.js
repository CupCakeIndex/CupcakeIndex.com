// Pick'em: this week's games from ESPN's scoreboard. Tap a team to pick it; games lock at kickoff and are graded when final.
// Picks are kept in this browser (per league + season + week) and in the URL, so the address bar is always a shareable link.
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
  const locked = (e) => state(e) !== "pre" || new Date(e.date) <= Date.now();
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
    cur = { lg, season, type, week, events, picks, preds, ranks, key, all: lg === "nfl" || params.get("all") === "1" };
    draw();
    if (!wired) wire(root);

    if (events.some((e) => state(e) === "in")) K.poll(() => render(parseHash().params, true), 60000);
    else if (events.some((e) => state(e) === "pre" && new Date(e.date) - Date.now() < 3600000)) K.poll(() => render(parseHash().params, true), 120000);
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
    const status = (w + l ? `<b class="pk-rec">You're ${w}-${l} this week</b> · ` : "")
      + `${picks.size} of ${list.length} game${list.length === 1 ? "" : "s"} picked` + (open ? "" : " · all games have kicked off");
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
      const fav = p && (p.home_win_prob >= 0.5 ? h : a), prob = p && Math.round(Math.max(p.home_win_prob, 1 - p.home_win_prob) * 100);
      const hint = fav ? `<span title="Our model's win chance for its favorite">model: ${esc(fav.team.abbreviation || tname(lg, fav.team))} ${prob}%</span>` : "";
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
      <p class="pk-status">${status}</p>
      <div class="br-tools pk-tools">${toggle}<button data-act="clear"${picks.size ? "" : " disabled"}>Clear picks</button>${Share.menuHtml()}</div>
      ${list.length ? `<div class="pk-grid">${list.map(game).join("")}</div>` : `<p class="muted">No games this week.</p>`}
      <p class="note">Tap a team to pick it; tap again to undo. Games lock at kickoff, and your picks get a ✓ or ✗ when the game is final.
        Picks are saved in this browser and in the page link, so Share › Copy Link sends your slate to a friend. "model" = our ratings' win chance for the team they favor. Just for fun.</p></div>`;
  }

  // Remember the picks (this browser) and keep them in the URL
  function save() {
    const { lg, season, type, week, picks, key, all } = cur, e = enc(picks);
    store.set(key, e);
    const p = e ? { season, week: `${type}:${week}`, picks: e } : {};
    if (lg === "cfb" && all) p.all = "1";
    history.replaceState(null, "", link("picks", null, p));
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
      sub: (w + l ? `${w}-${l} so far · ` : "") + `${n} pick${n === 1 ? "" : "s"}`,
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
