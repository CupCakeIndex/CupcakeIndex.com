// Dynasty Draft: build one team out of units from real NFL seasons (the 2007 Patriots' passing, the 2000 Ravens'
// run defense...) under a salary cap (each unit costs its grade), then our model plays it through a 17-game season
// and the playoffs against real team-seasons.
// Grades come from docs/data/dynasty.json (src/dynasty_data.py): each unit's z-score within its own season, and how
// many points a game each unit is worth. Your rings add up across drafts (localStorage, synced when signed in).
const Dynasty = (() => {
  const STATS = "dynasty-stats", ROUNDS = 6, OFFERS = 3, GAMES = 17, CAP = 360;
  const LABEL = { pass: "Passing offense", run: "Run game", rush: "Pass rush", cover: "Coverage", rund: "Run defense", st: "Special teams" };
  const ROUND_NAMES = ["Wild Card", "Divisional", "Conference title", "Super Bowl"];
  let D, run;

  const rand = (n) => Math.floor(Math.random() * n);
  const normal = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const phi = (z) => 1 / (1 + Math.exp(-1.702 * z)); // normal curve, close enough for grades
  const grade = (z) => Math.max(1, Math.min(99, Math.round(100 * phi(z)))); // 1-99: where the unit stood in its season
  const T = (i) => D.teams[i]; // [year, name, abbr, record, z per unit...]
  const z = (i, u) => T(i)[4 + D.units.indexOf(u)];
  const strength = (i) => D.units.reduce((s, u, k) => s + D.w[k] * T(i)[4 + k], 0); // points a game better than average
  const mine = () => D.units.reduce((s, u, k) => s + D.w[k] * z(run.picks[u], u), 0);
  const short = (i) => { const [yr, name] = T(i); return `${yr} ${/^Washington/.test(name) ? "Washington" : name.split(" ").pop()}`; };
  const logo = (i) => thumb(`https://a.espncdn.com/i/teamlogos/nfl/500/${T(i)[2].toLowerCase()}.png`, 56);
  const stats = () => store.get(STATS) || { played: 0, rings: 0, trips: 0, best: null };

  async function load() { if (!D) D = await getJSON("data/dynasty.json"); }

  const open = () => D.units.filter((u) => run.picks[u] == null);
  const spent = () => Object.entries(run.picks).reduce((s, [u, i]) => s + grade(z(i, u)), 0);
  // can you afford this unit and still fill every other open slot (the cheapest unit costs 1)?
  const fits = (i, u) => grade(z(i, u)) <= CAP - spent() - (open().length - 1);
  // three team-seasons you haven't seen this draft, at least one of them with a unit you can afford
  function offers() {
    for (let tries = 0; ; tries++) {
      const out = [];
      while (out.length < OFFERS) { const i = rand(D.teams.length); if (!run.seen.has(i) && !out.includes(i)) out.push(i); }
      if (tries > 200 || out.some((i) => open().some((u) => fits(i, u)))) { out.forEach((i) => run.seen.add(i)); return out; }
    }
  }

  function start() {
    run = { picks: {}, seen: new Set(), rerolls: 1, season: null };
    run.offer = offers();
    draw();
  }

  function gradeChip(g) { return `<b class="dy-g ${g >= 80 ? "hi" : g >= 50 ? "md" : "lo"}">${g}</b>`; }

  function roster() {
    return `<div class="dy-roster">${D.units.map((u) => { const i = run.picks[u];
      return `<div class="dy-slot${i == null ? " empty" : ""}"><small>${LABEL[u]}</small>${i == null ? `<span class="muted">open</span>`
        : `<span class="dy-pick"><img src="${esc(logo(i))}" alt="" width="20" height="20" onerror="this.style.visibility='hidden'"> ${esc(short(i))} ${gradeChip(grade(z(i, u)))}</span>`}</div>`; }).join("")}</div>`;
  }

  function draftHtml() {
    const left = open(), n = ROUNDS - left.length + 1;
    return `<p class="dy-q">Round <b>${n}</b> of ${ROUNDS}: take one unit from one of these teams.</p>
      <div class="dy-offers">${run.offer.map((i) => `<div class="dy-team">
        <div class="dy-th"><img src="${esc(logo(i))}" alt="" width="40" height="40" onerror="this.style.visibility='hidden'"><div><b>${esc(T(i)[0])} ${esc(T(i)[1])}</b><small>${esc(T(i)[3])}</small></div></div>
        ${left.map((u) => `<button type="button" class="dy-unit" data-i="${i}" data-u="${u}"${fits(i, u) ? "" : ` disabled title="Over the cap"`}><span>${LABEL[u]}</span>${gradeChip(grade(z(i, u)))}</button>`).join("")}
      </div>`).join("")}</div>
      <div class="hl-btns"><button type="button" class="btn" id="dy-reroll"${run.rerolls ? "" : " disabled"}>New teams (${run.rerolls} left)</button>
        <span class="note">Grades are 1–99: how that unit stacked up against the rest of the NFL that season. Each unit costs its grade, and all six have to fit under the ${CAP} cap. Passing and coverage win the most games.</span></div>`;
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
    const edge = mine() - strength(opp), m = Math.round(edge + normal() * D.sd) || (Math.random() < phi(edge / D.sd) ? 3 : -3);
    const total = Math.max(Math.abs(m) + 3, Math.round(44 + normal() * 10));
    const a = Math.round((total + m) / 2), b = a - m;
    return { opp, win: m > 0, us: Math.max(a, 0), them: Math.max(b, 0), chance: phi(edge / D.sd) };
  }

  function playSeason() {
    const used = new Set(Object.values(run.picks)), pool = D.teams.map((_, i) => i).filter((i) => !used.has(i));
    const pick = (list) => list[rand(list.length)];
    const games = Array.from({ length: GAMES }, () => game(pick(pool)));
    const w = games.filter((g) => g.win).length;
    // 10+ wins makes it; 9 is a coin flip on tiebreakers; 13+ earns the bye
    const inP = w >= 10 || (w === 9 && Math.random() < 0.5), bye = w >= 13;
    // playoff teams: the top 35% of real team-seasons; the Super Bowl opponent, the top 15%
    const sorted = pool.slice().sort((a, b) => strength(b) - strength(a)), good = sorted.slice(0, Math.round(pool.length * 0.35)), elite = sorted.slice(0, Math.round(pool.length * 0.15));
    const playoffs = [];
    if (inP) for (let r = bye ? 1 : 0; r < 4; r++) { const g = game(pick(r === 3 ? elite : good)); g.round = ROUND_NAMES[r]; playoffs.push(g); if (!g.win) break; }
    const champ = playoffs.length && playoffs.every((g) => g.win) && playoffs.at(-1).round === "Super Bowl";
    const lastP = playoffs.at(-1);
    const result = !inP ? (w === 9 ? "Missed the playoffs on a tiebreaker" : "Missed the playoffs") : champ ? "Won the Super Bowl" : `Lost in the ${lastP.round}${lastP.round === "Super Bowl" ? "" : " round"}`;
    run.season = { games, playoffs, w, l: GAMES - w, inP, bye, champ, result };
    record();
    draw();
  }

  function record() {
    const s = stats(), r = run.season, rank = r.champ ? 5 : r.playoffs.filter((g) => g.win).length + (r.inP ? 1 : 0);
    s.played++; if (r.champ) s.rings++; if (r.inP) s.trips++;
    if (!s.best || rank > s.best.rank || (rank === s.best.rank && r.w > s.best.w)) { s.best = { rank, w: r.w, l: r.l, result: r.result }; s.newBest = true; } else s.newBest = false;
    store.set(STATS, s);
  }

  const chip = (g, i) => `<div class="dy-gm ${g.win ? "w" : "l"}" style="animation-delay:${i * 70}ms" title="Your chance: ${Math.round(100 * g.chance)}%">
      <b>${g.win ? "W" : "L"}</b> ${g.us}-${g.them} <span>${g.round ? `${esc(g.round)}: ` : "vs "}${esc(short(g.opp))}</span></div>`;

  function seasonHtml() {
    const r = run.season, s = stats();
    return `<div class="dy-season">
      <p class="dy-rec">${r.w}-${r.l} <span class="${r.champ ? "dy-champ" : ""}">${r.champ ? "🏆 " : ""}${esc(r.result)}</span></p>
      <h3>Regular season</h3><div class="dy-games">${r.games.map(chip).join("")}</div>
      ${r.inP ? `<h3>Playoffs${r.bye ? " <small class='muted'>(first-round bye)</small>" : ""}</h3><div class="dy-games">${r.playoffs.map((g, i) => chip(g, GAMES + i)).join("")}</div>` : ""}
      <div class="dg-end">
        <p class="hl-over">Your dynasty${s.newBest && s.played > 1 ? " (new best season!)" : ""}</p>
        <div class="dg-stats"><div><b>${s.rings}</b><small>rings</small></div><div><b>${s.played}</b><small>seasons</small></div><div><b>${s.trips}</b><small>playoff trips</small></div><div><b>${s.best ? `${s.best.w}-${s.best.l}` : "–"}</b><small>best season</small></div></div>
        <div class="hl-btns"><button type="button" class="btn primary" id="dy-again">Draft again</button><button type="button" class="btn" id="dy-share">Copy result</button><span class="muted" id="dy-copied"></span></div>
        <p class="note">Each game: your power rating against theirs plus game-day luck, the same spread of results real NFL games have. Hover a game for your chance going in.</p>
      </div></div>`;
  }

  function draw() {
    const v = document.getElementById("view-dynasty"), s = stats(), done = !open().length;
    v.innerHTML = `<div class="card dy">
      <h2><span class="dg-gt">&gt;</span> dynasty_draft</h2>
      <div class="hl-bar"><span>Cap left <b class="dy-cap">${CAP - spent()}</b></span><span>Rings <b>${s.rings}</b></span><span>Seasons <b>${s.played}</b></span><span class="hl-lv">NFL ${D.first}–${D.last}</span></div>
      ${roster()}
      ${run.season ? seasonHtml() : done ? readyHtml() : draftHtml()}
    </div>`;
    v.querySelector(".dy-offers")?.addEventListener("click", (e) => {
      const b = e.target.closest(".dy-unit");
      if (!b || b.disabled) return;
      run.picks[b.dataset.u] = +b.dataset.i;
      if (open().length) run.offer = offers();
      draw();
    });
    const on = (id, f) => { const b = document.getElementById(id); if (b) b.onclick = f; };
    on("dy-reroll", () => { if (run.rerolls) { run.rerolls--; run.offer = offers(); draw(); } });
    on("dy-play", playSeason);
    on("dy-redo", start);
    on("dy-again", start);
    on("dy-share", async () => {
      const r = run.season, st = stats();
      const t = `Cupcake Index Dynasty Draft: ${r.w}-${r.l}, ${r.result.toLowerCase()}${r.champ ? " 🏆" : ""}.\n` +
        D.units.map((u) => `${LABEL[u]}: ${short(run.picks[u])}`).join("\n") + `\nDynasty: ${st.rings} ring${st.rings === 1 ? "" : "s"} in ${st.played} season${st.played === 1 ? "" : "s"}.\ncupcakeindex.com/#/dynasty`;
      const msg = document.getElementById("dy-copied");
      try { await navigator.clipboard.writeText(t); msg.textContent = "copied"; } catch { msg.textContent = t; }
    });
  }

  async function render() {
    const v = document.getElementById("view-dynasty");
    try { await load(); } catch (e) { v.innerHTML = `<div class="card">Couldn't load the game (${esc(e.message)}).</div>`; return; }
    if (!run) start(); else draw(); // coming back mid-draft keeps your picks
  }

  // For the Games page
  function status() {
    const s = stats();
    return s.played ? `${s.rings} ring${s.rings === 1 ? "" : "s"} in ${s.played} ▸` : "play ▸";
  }

  return { render, status };
})();
