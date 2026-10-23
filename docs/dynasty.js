// Dynasty Draft: build one team out of units from real NFL seasons (the 2007 Patriots' passing, the 2000 Ravens'
// run defense...). Each round shows three franchises; pick a year from memory and a unit, and the grade shows after
// you lock it in (each year once per draft). Then our model plays it through a 17-game season and the playoffs
// against real team-seasons. Playoff games can be watched play by play on the gamecast field, with the real players
// from each unit's team-season (docs/dynasty_sim.js; the result is decided first, by the same quick sim).
// Grades come from docs/data/dynasty.json (src/dynasty_data.py): each unit's z-score within its own season, and how
// many points a game each unit is worth. Your rings add up across drafts (localStorage, synced when signed in).
const Dynasty = (() => {
  const STATS = "dynasty-stats", ROUNDS = 6, OFFERS = 3, GAMES = 17;
  // game-day luck, in points: about half of real NFL games' (D.sd, ~13), so the better roster usually wins
  const LUCK = 7;
  const LABEL = { pass: "Passing offense", run: "Run game", rush: "Pass rush", cover: "Coverage", rund: "Run defense", st: "Special teams" };
  const ROUND_NAMES = ["Wild Card", "Divisional", "Conference title", "Super Bowl"];
  let D, run, FR; // FR: franchise abbreviation -> its seasons (indexes into D.teams), oldest first

  const rand = (n) => Math.floor(Math.random() * n);
  const normal = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const phi = (z) => 1 / (1 + Math.exp(-1.702 * z)); // normal curve, close enough for grades
  const grade = (z) => Math.max(1, Math.min(99, Math.round(100 * phi(z)))); // 1-99: where the unit stood in its season
  const T = (i) => D.teams[i]; // [year, name, abbr, record, z per unit...]
  const z = (i, u) => T(i)[4 + D.units.indexOf(u)];
  const strength = (i) => D.units.reduce((s, u, k) => s + D.w[k] * T(i)[4 + k], 0); // points a game better than average
  const mine = () => D.units.reduce((s, u, k) => s + D.w[k] * z(run.picks[u], u), 0);
  const short = (i) => { const [yr, name] = T(i); return `${yr} ${/^Washington/.test(name) ? "Washington" : name.split(" ").pop()}`; };
  const logo = (i) => flogo(T(i)[2]);
  const flogo = (ab) => thumb(`https://a.espncdn.com/i/teamlogos/nfl/500/${ab.toLowerCase()}.png`, 56);
  const fname = (ab) => T(FR[ab].at(-1))[1]; // today's name
  const stats = () => store.get(STATS) || { played: 0, rings: 0, trips: 0, best: null };

  async function load() {
    if (D) return;
    D = await getJSON("data/dynasty.json");
    FR = {};
    D.teams.forEach((t, i) => (FR[t[2]] ||= []).push(i));
  }

  const open = () => D.units.filter((u) => run.picks[u] == null);
  const usedYears = () => new Set(Object.values(run.picks).map((i) => T(i)[0]));
  // three franchises you haven't been offered this draft
  function offers() {
    const all = Object.keys(FR).filter((ab) => !run.seen.has(ab)), out = [];
    while (out.length < OFFERS && all.length) out.push(all.splice(rand(all.length), 1)[0]);
    out.forEach((ab) => run.seen.add(ab));
    return out;
  }

  function start() {
    run = { picks: {}, seen: new Set(), rerolls: 1, season: null, last: null };
    run.offer = offers();
    draw();
  }

  function gradeChip(g) { return `<b class="dy-g ${g >= 80 ? "hi" : g >= 50 ? "md" : "lo"}">${g}</b>`; }

  function roster() {
    return `<div class="dy-roster">${D.units.map((u) => { const i = run.picks[u];
      return `<div class="dy-slot${i == null ? " empty" : ""}"><small>${LABEL[u]}</small>${i == null ? `<span class="muted">open</span>`
        : `<span class="dy-pick${run.last === u ? " fresh" : ""}"><img src="${esc(logo(i))}" alt="" width="20" height="20" onerror="this.style.visibility='hidden'"> ${esc(short(i))} ${gradeChip(grade(z(i, u)))}</span>`}</div>`; }).join("")}</div>`;
  }

  function draftHtml() {
    const left = open(), n = ROUNDS - left.length + 1;
    const used = usedYears(), L = run.last && run.picks[run.last];
    return `${L != null ? `<p class="dy-last">You took the <b>${esc(T(L)[0])} ${esc(T(L)[1])}</b> ${LABEL[run.last].toLowerCase()}: ${gradeChip(grade(z(L, run.last)))}</p>` : ""}
      <p class="dy-q">Round <b>${n}</b> of ${ROUNDS}: pick a team, a year and a unit.</p>
      <div class="dy-offers">${run.offer.map((ab) => `<div class="dy-team" data-ab="${esc(ab)}">
        <div class="dy-th"><img src="${esc(flogo(ab))}" alt="" width="40" height="40" onerror="this.style.visibility='hidden'"><div><b>${esc(fname(ab))}</b></div></div>
        <select class="dy-yr" aria-label="Year"><option value="">Pick a year…</option>${FR[ab].slice().reverse().map((i) =>
          `<option value="${i}"${used.has(T(i)[0]) ? " disabled" : ""}>${T(i)[0]} (${esc(T(i)[3])})${used.has(T(i)[0]) ? " · used" : ""}</option>`).join("")}</select>
        ${left.map((u) => `<button type="button" class="dy-unit" data-u="${u}" disabled><span>${LABEL[u]}</span><b class="dy-g">?</b></button>`).join("")}
      </div>`).join("")}</div>
      <div class="hl-btns"><button type="button" class="btn" id="dy-reroll"${run.rerolls ? "" : " disabled"}>New teams (${run.rerolls} left)</button>
        <span class="note">Grades stay hidden until you pick: 1–99, how that unit stacked up against the NFL that season. Each year only once per draft. Passing and coverage win the most games.</span></div>`;
  }

  // the real team-season yours plays most like (same six grades, weighted by how much each unit matters)
  function twin() {
    let best = -1, bd = Infinity;
    D.teams.forEach((t, i) => { const d = D.units.reduce((s, u, k) => s + D.w[k] * (t[4 + k] - z(run.picks[u], u)) ** 2, 0); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  function readyHtml() {
    const s = mine(), tw = twin();
    return `<div class="dy-ready"><p class="dy-q">Your team is set. Power rating <b>${s > 0 ? "+" : ""}${s.toFixed(1)}</b> <small class="muted">(points a game better than an average team)</small></p>
      <p>It plays most like the <b>${esc(T(tw)[0])} ${esc(T(tw)[1])}</b> (${esc(T(tw)[3])}).</p>
      <div class="hl-btns"><button type="button" class="btn primary" id="dy-play">Play the season</button><button type="button" class="btn" id="dy-redo">Start over</button></div></div>`;
  }

  // one game: the margin is your edge plus game-day noise; a believable score around it
  function game(opp) {
    const edge = mine() - strength(opp), m = Math.round(edge + normal() * LUCK) || (Math.random() < phi(edge / LUCK) ? 3 : -3);
    const total = Math.max(Math.abs(m) + 3, Math.round(44 + normal() * 10));
    // only scores a football team can finish on (never 1, 2, 4 or 5), keeping the winner
    const fix = (x) => ({ 1: 0, 2: 3, 4: 3, 5: 6 })[x] ?? x;
    let a = fix(Math.max(Math.round((total + m) / 2), 0)), b = fix(Math.max(Math.round((total + m) / 2) - m, 0));
    if (a === b) { if (m > 0) a += 3; else b += 3; }
    return { opp, win: m > 0, us: a, them: b, chance: phi(edge / LUCK), edge };
  }

  function playSeason() {
    const used = new Set(Object.values(run.picks)), pool = D.teams.map((_, i) => i).filter((i) => !used.has(i));
    const pick = (list) => list[rand(list.length)];
    const games = Array.from({ length: GAMES }, () => game(pick(pool)));
    const w = games.filter((g) => g.win).length;
    // 10+ wins makes it; 9 is a coin flip on tiebreakers; 13+ earns the bye
    const inP = w >= 10 || (w === 9 && Math.random() < 0.5), bye = w >= 13;
    // playoff teams: the top 15% of real team-seasons; the Super Bowl opponent, the top 5%
    const sorted = pool.slice().sort((a, b) => strength(b) - strength(a)), good = sorted.slice(0, Math.round(pool.length * 0.15)), elite = sorted.slice(0, Math.round(pool.length * 0.05));
    const playoffs = [];
    if (inP) for (let r = bye ? 1 : 0; r < 4; r++) { const g = game(pick(r === 3 ? elite : good)); g.round = ROUND_NAMES[r]; playoffs.push(g); if (!g.win) break; }
    const champ = playoffs.length && playoffs.every((g) => g.win) && playoffs.at(-1).round === "Super Bowl";
    const lastP = playoffs.at(-1);
    const result = !inP ? (w === 9 ? "Missed the playoffs on a tiebreaker" : "Missed the playoffs") : champ ? "Won the Super Bowl" : `Lost in the ${lastP.round}${lastP.round === "Super Bowl" ? "" : " round"}`;
    // the playoffs are decided now (and saved), but shown one game at a time: watch each one or sim the rest
    run.season = { games, playoffs, w, l: GAMES - w, inP, bye, champ, result, shown: 0 };
    run.watch = null;
    record();
    draw();
  }

  function record() {
    const s = stats(), r = run.season, rank = r.champ ? 5 : r.playoffs.filter((g) => g.win).length + (r.inP ? 1 : 0);
    s.played++; if (r.champ) s.rings++; if (r.inP) s.trips++;
    if (!s.best || rank > s.best.rank || (rank === s.best.rank && r.w > s.best.w)) { s.best = { rank, w: r.w, l: r.l, result: r.result }; s.newBest = true; } else s.newBest = false;
    store.set(STATS, s);
  }

  // playoff games not shown yet: the season's result (and a ring) stays hidden until they are
  const pending = () => !!run?.season && run.season.shown < run.season.playoffs.length;
  function shownStats() {
    const s = { ...stats() };
    if (pending() && run.season.champ) s.rings--;
    return s;
  }

  const chip = (g, i) => `<div class="dy-gm ${g.win ? "w" : "l"}" style="animation-delay:${i * 70}ms" title="Your chance: ${Math.round(100 * g.chance)}%">
      <b>${g.win ? "W" : "L"}</b> ${g.us}-${g.them} <span>${g.round ? `${esc(g.round)}: ` : "vs "}${esc(short(g.opp))}</span></div>`;

  function seasonHtml() {
    const r = run.season, s = stats(), wait = pending(), nx = r.playoffs[r.shown];
    return `<div class="dy-season">
      <p class="dy-rec">${r.w}-${r.l} <span class="${r.champ && !wait ? "dy-champ" : ""}">${wait ? "Made the playoffs" : `${r.champ ? "🏆 " : ""}${esc(r.result)}`}</span> <small class="dy-pr">power rating ${mine() > 0 ? "+" : ""}${mine().toFixed(1)}</small></p>
      <h3>Regular season</h3><div class="dy-games">${r.games.map(chip).join("")}</div>
      ${r.inP ? `<h3>Playoffs${r.bye ? " <small class='muted'>(first-round bye)</small>" : ""}</h3>${r.shown ? `<div class="dy-games">${r.playoffs.slice(0, r.shown).map((g, i) => chip(g, i)).join("")}</div>` : ""}` : ""}
      ${wait ? `<div class="dy-next">
        <p class="dy-q">${r.shown ? "Next up" : "You're in!"}: the <b>${esc(nx.round)}</b> vs the ${esc(T(nx.opp)[0])} ${esc(T(nx.opp)[1])} (${esc(T(nx.opp)[3])}).</p>
        <div class="hl-btns"><button type="button" class="btn primary" id="dy-watch">▶ Watch the ${esc(nx.round)} game</button><button type="button" class="btn" id="dy-simrest">Sim the rest</button></div>
        <p class="note">Play by play on the gamecast field, with the real players from each of your units' seasons against theirs. Lose and the run ends.</p></div>` : `<div class="dg-end">
        <p class="hl-over">Your dynasty${s.newBest && s.played > 1 ? " (new best season!)" : ""}</p>
        <div class="dg-stats"><div><b>${s.rings}</b><small>rings</small></div><div><b>${s.played}</b><small>seasons</small></div><div><b>${s.trips}</b><small>playoff trips</small></div><div><b>${s.best ? `${s.best.w}-${s.best.l}` : "–"}</b><small>best season</small></div></div>
        <div class="hl-btns"><button type="button" class="btn primary" id="dy-again">Draft again</button><button type="button" class="btn" id="dy-share">Copy result</button><span class="muted" id="dy-copied"></span></div>
        <p class="note">Each game: your power rating against theirs plus some game-day luck (half as much as real NFL games, so the better roster usually wins). Hover a game for your chance going in.</p>
      </div>`}</div>`;
  }

  function draw() {
    const v = document.getElementById("view-dynasty"), s = shownStats(), done = !open().length;
    clearTimeout(run.watch?.timer);
    v.innerHTML = `<div class="card dy">
      <h2><span class="dg-gt">&gt;</span> dynasty_draft</h2>
      <div class="hl-bar"><span>Rings <b>${s.rings}</b></span><span>Seasons <b>${s.played}</b></span><span class="hl-lv">NFL ${D.first}–${D.last}</span></div>
      ${run.watch ? watchHtml() : `${roster()}
      ${run.season ? seasonHtml() : done ? readyHtml() : draftHtml()}`}
    </div>`;
    if (run.watch) { paint(); later(); }
    const offersEl = v.querySelector(".dy-offers");
    // a year picked: that card's unit buttons wake up
    offersEl?.addEventListener("change", (e) => {
      const card = e.target.closest(".dy-team");
      if (card) card.querySelectorAll(".dy-unit").forEach((b) => { b.disabled = !e.target.value; });
    });
    offersEl?.addEventListener("click", (e) => {
      const b = e.target.closest(".dy-unit"), yr = b?.closest(".dy-team")?.querySelector(".dy-yr").value;
      if (!b || b.disabled || !yr) return;
      run.picks[b.dataset.u] = +yr;
      run.last = b.dataset.u;
      if (open().length) run.offer = offers();
      draw();
    });
    const on = (id, f) => { const b = document.getElementById(id); if (b) b.onclick = f; };
    on("dy-reroll", () => { if (run.rerolls) { run.rerolls--; run.offer = offers(); draw(); } });
    on("dy-play", playSeason);
    on("dy-redo", start);
    on("dy-again", start);
    on("dy-watch", () => watch(run.season.shown));
    on("dy-simrest", simRest);
    on("dy-share", async () => {
      const r = run.season, st = stats();
      const t = `Cupcake Index Dynasty Draft: ${r.w}-${r.l}, ${r.result.toLowerCase()}${r.champ ? " 🏆" : ""}.\n` +
        D.units.map((u) => `${LABEL[u]}: ${short(run.picks[u])}`).join("\n") + `\nDynasty: ${st.rings} ring${st.rings === 1 ? "" : "s"} in ${st.played} season${st.played === 1 ? "" : "s"}.\ncupcakeindex.com/#/dynasty`;
      const msg = document.getElementById("dy-copied");
      try { await navigator.clipboard.writeText(t); msg.textContent = "copied"; } catch { msg.textContent = t; }
    });
  }

  // ---- Playoff games on the gamecast field ----
  // Each side's real players: yours from the team-season behind each unit you drafted, theirs from their season.
  const ROS = {};
  const rosterOf = (yr) => (ROS[yr] ||= getJSON(`data/dynasty/rosters_${yr}.json`).catch((e) => { delete ROS[yr]; throw e; }));
  const SHOT = "https://static.www.nfl.com/image/private/f_auto,q_auto/league/";
  const LISTS = { pass: ["qb", "rec"], run: ["rb"], rush: ["rush"], cover: ["cov"], rund: ["tak"], st: ["k", "p", "ret"] };
  async function sides(g) {
    const yrs = [...new Set([...Object.values(run.picks), g.opp].map((i) => T(i)[0]))];
    const got = Object.fromEntries(await Promise.all(yrs.map(async (y) => [y, await rosterOf(y)])));
    const R = (i) => got[T(i)[0]][T(i)[2]] || {};
    const me = { id: "1", abbr: "YOU", z: {}, R: {} }, them = { id: "2", abbr: T(g.opp)[2], z: {}, R: R(g.opp) };
    D.units.forEach((u) => {
      me.z[u] = z(run.picks[u], u); them.z[u] = z(g.opp, u);
      LISTS[u].forEach((k) => { me.R[k] = R(run.picks[u])[k] || []; });
    });
    return { me, them };
  }
  // the field's hover/tap cards (8-bit look): who plays where, from the same lists
  function people(side) {
    const byId = new Map(), byName = new Map(), depth = {};
    const slot = (pos, key) => key === "qb" ? "qb" : key === "k" ? "pk" : key === "p" ? "p" : key === "ret" ? null
      : pos === "WR" ? "wr" : pos === "TE" ? "te" : /^(RB|FB|HB)$/.test(pos) ? "rb"
      : /^(DE|DL)$/.test(pos) || (pos === "OLB" && key === "rush") ? "de" : /^(DT|NT)$/.test(pos) ? "dt" : /LB$/.test(pos) ? "lb"
      : /^(CB|DB)$/.test(pos) ? "cb" : pos === "SS" ? "ss" : /^(FS|S|SAF)$/.test(pos) ? "fs" : null;
    Object.entries(side.R).forEach(([key, list]) => Array.isArray(list) && list.forEach((p, i) => {
      const k = slot(p[2], key), id = `${side.id}-${key}-${i}`;
      const pl = { id, name: p[0], num: "", pos: k === "pk" ? "K" : p[2], pic: p[3] ? SHOT + p[3] : "", out: false };
      byId.set(id, pl); byName.set(p[0].toLowerCase(), pl); byName.set(p[1].toLowerCase(), pl);
      if (k && !(depth[k] ||= []).some((x) => byId.get(x).name === p[0])) depth[k].push(id);
    }));
    return { byId, byName, depth };
  }
  function teamOf(side, g) {
    if (side.id === "1") return { id: "1", abbreviation: "YOU", displayName: "Your dynasty", location: "Your", name: "dynasty", color: "ff6b2c", alternateColor: "1a1a1a",
      logo: "icon-192.png", logos: [{ href: "icon-192.png", rel: ["full", "default"] }] };
    const [yr, name, ab] = T(g.opp);
    return { id: "2", abbreviation: ab, displayName: `${yr} ${name}`, location: String(yr), name, color: (side.R.c || "").replace("#", ""), alternateColor: "ffffff",
      logo: flogo(ab), logos: [{ href: flogo(ab), rel: ["full", "default"] }] };
  }

  async function watch(gi) {
    const g = run.season.playoffs[gi], btn = document.querySelector("#dy-watch, #view-dynasty [data-dy=next]");
    if (btn) { btn.disabled = true; btn.textContent = "Loading the rosters…"; }
    let sd;
    try { sd = await sides(g); } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = `Couldn't load the rosters (${e.message}). Try again`; }
      return;
    }
    const sim = DynastySim.build(sd.me, sd.them, g.us, g.them, g.edge ?? 0);
    run.watch = { gi, g, sd, sim, all: sim.drives.flatMap((d) => d.plays), k: 1, speed: store.get("dynasty-speed") === 2 ? 2 : 1, paused: false,
      gid: `dyn-${Date.now()}`, home: teamOf(sd.me, g), away: teamOf(sd.them, g), people: { home: people(sd.me), away: people(sd.them) } };
    draw();
    document.querySelector("#view-dynasty .dy-watch")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  // the game as it stood after the first k plays, in the shape of an ESPN game summary
  function state(w) {
    const last = w.all[w.k - 1], done = w.k >= w.all.length, ids = new Set(w.all.slice(0, w.k).map((p) => p.id));
    const previous = w.sim.drives.map((d) => ({ ...d, plays: d.plays.filter((p) => ids.has(p.id)) })).filter((d) => d.plays.length);
    const home = { homeAway: "home", team: w.home, score: String(last.homeScore) }, away = { homeAway: "away", team: w.away, score: String(last.awayScore) };
    const status = done ? { period: last.period.number, type: { state: "post", name: "STATUS_FINAL", shortDetail: "Final" } }
      : { period: last.period.number, displayClock: last.clock.displayValue, type: { state: "in", name: "STATUS_IN_PROGRESS" } };
    return { s: { drives: { previous }, winprobability: w.sim.winprobability.filter((x) => ids.has(x.playId)) }, comp: { competitors: [home, away], status }, home, away, done, last };
  }
  function bugHtml(st) {
    const w = run.watch, hs = +st.home.score, as = +st.away.score, q = st.last.period.number;
    const side = (t, name, n, win) => `<span class="dy-bt${win ? " win" : ""}"><img src="${esc(t.logo)}" alt="" width="28" height="28" onerror="this.style.visibility='hidden'"><b>${esc(name)}</b><em>${n}</em></span>`;
    return `<div class="dy-bug">${side(w.home, "You", hs, st.done && hs > as)}<span class="dy-bm"><small>${esc(w.g.round)}</small><b>${st.done ? "Final" : `Q${q} ${esc(st.last.clock.displayValue)}`}</b></span>${side(w.away, short(w.g.opp), as, st.done && as > hs)}</div>`;
  }
  function ctlHtml(st) {
    const w = run.watch, nx = run.season.playoffs[w.gi + 1];
    if (!st.done) return `<div class="hl-btns dy-ctl"><button type="button" class="btn" data-dy="pause">${w.paused ? "▶ Play" : "❚❚ Pause"}</button>
      <span class="dy-spd">${[1, 2].map((v) => `<button type="button" data-dy="spd" data-v="${v}" class="${w.speed === v ? "on" : ""}">${v}x</button>`).join("")}</span>
      <button type="button" class="btn" data-dy="skip">Skip to final</button><button type="button" class="btn" data-dy="rest">Sim the rest</button></div>`;
    const won = w.g.win;
    return `<div class="hl-btns dy-ctl">${won && nx ? `<button type="button" class="btn primary" data-dy="next">▶ Watch the ${esc(nx.round)} game</button><button type="button" class="btn" data-dy="rest">Sim the rest</button>`
      : `<button type="button" class="btn primary" data-dy="back">${won ? "🏆 See your season" : "See your season"}</button>`}
      <span class="note">${won ? (nx ? `On to the ${esc(nx.round)}.` : "Super Bowl champions!") : "The run ends here."}</span></div>`;
  }
  function lineupHtml() {
    const w = run.watch, { me, them } = w.sd;
    const names = (side, keys) => keys.flatMap((k) => (side.R[k] || []).slice(0, 2)).map((p) => esc(p[0])).join(", ") || "<span class='muted'>–</span>";
    const rows = D.units.map((u) => `<tr><th>${LABEL[u]}</th><td>${names(me, LISTS[u].slice(0, 2))} <small class="muted">${esc(short(run.picks[u]))}</small></td><td>${names(them, LISTS[u].slice(0, 2))}</td></tr>`).join("");
    return `<details class="dy-lineup"><summary>Lineups: your units' real players vs the ${esc(T(w.g.opp)[0])} ${esc(T(w.g.opp)[1])}</summary>
      <table><thead><tr><th></th><th>You</th><th>${esc(short(w.g.opp))}</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  }
  const watchHtml = () => `<div class="dy-watch"><div class="dy-bugbox"></div><div class="dy-ctlbox"></div><div class="dy-field"></div>${lineupHtml()}
    <p class="note">The final score comes from the same model as the regular season (power ratings plus game-day luck). The plays come from the matchups: your passing vs their coverage and pass rush, your run game vs their run defense. Offensive linemen aren't in play-by-play, so they aren't named.</p></div>`;
  // draw the field at the current play (keeps the play-by-play list where you scrolled it)
  function paint() {
    const w = run.watch, v = document.getElementById("view-dynasty"), box = v.querySelector(".dy-field");
    if (!box) return;
    const st = state(w), top = box.querySelector(".gcv-pbp")?.scrollTop || 0;
    box.innerHTML = Live.simField(st.s, st.comp, st.home, st.away, w.gid, w.people, st.done);
    const pbp = box.querySelector(".gcv-pbp");
    if (pbp) pbp.scrollTop = top;
    v.querySelector(".dy-bugbox").innerHTML = bugHtml(st);
    v.querySelector(".dy-ctlbox").innerHTML = ctlHtml(st);
    if (st.done && run.season.shown <= w.gi) run.season.shown = w.gi + 1; // this game's result is out now
  }
  // the next play once this one has had time to run (touchdowns and kickoffs take longer)
  function later() {
    const w = run.watch;
    clearTimeout(w.timer);
    if (w.k >= w.all.length || w.paused) return;
    const p = w.all[w.k - 1], td = /TOUCHDOWN/.test(p.text), t = td ? 6200 : /kickoff/i.test(p.type.text) ? 4400 : /punt|field goal/i.test(p.type.text) ? 4000 : 3000;
    w.timer = setTimeout(() => {
      const box = document.querySelector("#view-dynasty .dy-field");
      if (run.watch !== w || !box?.isConnected) return; // left the page: it picks up here when you come back
      if (!box.querySelector(".gcv-rpctl")) { w.k++; paint(); } // (not while you're replaying an earlier play)
      later();
    }, w.speed === 2 ? Math.max(t * 0.5, td ? 4200 : 1500) : t);
  }
  function simRest() {
    clearTimeout(run.watch?.timer);
    run.watch = null;
    run.season.shown = run.season.playoffs.length;
    draw();
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("#view-dynasty [data-dy]"), w = run?.watch;
    if (!b || !w) return;
    const k = b.dataset.dy;
    const ctl = () => { document.querySelector("#view-dynasty .dy-ctlbox").innerHTML = ctlHtml(state(w)); later(); };
    if (k === "pause") { w.paused = !w.paused; ctl(); }
    else if (k === "spd") { w.speed = +b.dataset.v === 2 ? 2 : 1; store.set("dynasty-speed", w.speed); ctl(); }
    else if (k === "skip") { clearTimeout(w.timer); w.k = w.all.length; paint(); }
    else if (k === "rest") simRest();
    else if (k === "next") watch(w.gi + 1);
    else if (k === "back") { run.watch = null; draw(); }
  });

  async function render() {
    const v = document.getElementById("view-dynasty");
    try { await load(); } catch (e) { v.innerHTML = `<div class="card">Couldn't load the game (${esc(e.message)}).</div>`; return; }
    if (!run) start(); else draw(); // coming back mid-draft keeps your picks
  }

  // For the Games page
  function status() {
    const s = shownStats();
    return s.played ? `${s.rings} ring${s.rings === 1 ? "" : "s"} in ${s.played} ▸` : "play ▸";
  }

  return { render, status };
})();
