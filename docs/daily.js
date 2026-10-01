// Daily game: guess today's NFL player in 8 tries (Wordle / Poeltl style).
// The player pool is docs/data/daily_nfl.json (built by src/daily_game.py). Everyone gets the same player each day:
// the answer list is shuffled by a fixed hash and the day number picks from it. Progress + stats live in localStorage.
const Daily = (() => {
  const MAX = 8, HINT1 = 4, HINT2 = 6;          // tries; hints unlock after 4 and 6 misses
  const START = Date.UTC(2026, 9, 1);           // puzzle #1 = Oct 1, 2026
  const KEY = "daily-nfl", STATS = "daily-nfl-stats";
  const COLS = ["Team", "Div", "Pos", "Age", "College", "#"];
  let D, byId, today, answer, game, sel = 0;

  const dayNum = (d = new Date()) => Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - START) / 864e5);
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
  const P = (r) => r && { name: r[0], id: r[1], team: r[2], pos: r[3], born: r[4], college: r[5], cconf: r[6], num: r[7], dy: r[8], rnd: r[9] };
  const age = (born) => { const b = new Date(born + "T12:00:00"), n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };
  const shot = (id, w = 120, h = 88) => thumb(`https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`, w, h);

  async function load() {
    if (D) return;
    D = await getJSON("data/daily_nfl.json");
    byId = new Map(D.players.map((r) => [r[1], P(r)]));
  }

  function pickAnswer() {
    today = dayNum();
    const saved = store.get(KEY);
    game = saved && saved.day === today ? saved : { day: today, guesses: [], done: false };
    if (!game.id || !byId.has(game.id)) {   // same order for everyone: answers sorted by a salted hash
      const order = D.answers.filter((id) => byId.has(id)).sort((a, b) => hash("cupcake" + a) - hash("cupcake" + b));
      game.id = order[((today % order.length) + order.length) % order.length];
    }
    answer = byId.get(game.id);
  }

  // One feedback cell per column: [shown text, "g" exact / "y" close / "" miss, arrow]
  function grade(g) {
    const a = answer, T = D.teams, ga = age(g.born), aa = age(a.born);
    const div = (p) => T[p.team][0] + " " + T[p.team][1][0];
    const sameDiv = T[g.team][0] === T[a.team][0] && T[g.team][1] === T[a.team][1];
    const num = (x, y, close) => x === y ? "g" : Math.abs(x - y) <= close ? "y" : "";
    const arrow = (x, y) => x == null || y == null || x === y ? "" : y > x ? "↑" : "↓";
    return [
      [g.team, g.team === a.team ? "g" : sameDiv ? "y" : ""],
      [div(g), sameDiv ? "g" : T[g.team][0] === T[a.team][0] ? "y" : ""],
      [g.pos, g.pos === a.pos ? "g" : ["WR", "TE"].includes(g.pos) && ["WR", "TE"].includes(a.pos) ? "y" : ""],
      [ga, num(ga, aa, 2), arrow(ga, aa)],
      [g.college || "?", g.college && g.college === a.college ? "g" : g.cconf && g.cconf === a.cconf ? "y" : ""],
      [g.num ?? "?", g.num == null || a.num == null ? "" : num(g.num, a.num, 2), arrow(g.num, a.num)],
    ];
  }

  const won = () => game.guesses.includes(answer.id);
  const misses = () => game.guesses.length - (won() ? 1 : 0);

  function guessRow(id, i) {
    const g = byId.get(id), cells = grade(g), hit = id === answer.id;
    return `<div class="dg-row${hit ? " hit" : ""}">
      <div class="dg-name"><span class="dg-gt">&gt;</span> guess ${i + 1}: <b>${esc(g.name)}</b>${hit ? ` <span class="dg-ok">✓ match</span>` : ""}</div>
      <div class="dg-cells">${cells.map(([v, c, ar], k) => `<div class="dg-c ${c}" title="${esc(COLS[k] + ": " + v)}"><small>${COLS[k]}</small><span>${esc(v)}${ar ? `<i>${ar}</i>` : ""}</span></div>`).join("")}</div>
    </div>`;
  }

  function hints() {
    const m = misses(), out = [], a = answer;
    if (m >= HINT1) {
      const draft = a.dy ? `drafted ${a.dy}${a.rnd ? `, round ${a.rnd}` : ""}` : "undrafted";
      out.push(`<div class="dg-hint"><span class="dg-silbox"><img class="dg-sil" src="${esc(shot(a.id))}" alt="" width="120" height="88"></span>
        <div><span class="dg-gt">hint_1:</span> ${esc(draft)}${m >= HINT2 ? `<br><span class="dg-gt">hint_2:</span> initials ${esc(a.name.split(" ").filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w)).map((w) => w[0] + ".").join(" "))}` : `<br><span class="muted">another hint after ${HINT2} misses</span>`}</div></div>`);
    } else if (m) out.push(`<p class="muted dg-note">hint unlocks after ${HINT1} misses (${HINT1 - m} to go)</p>`);
    return out.join("");
  }

  function shareText() {
    const n = won() ? game.guesses.length : "X";
    const sq = { g: "🟩", y: "🟨", "": "⬛" };
    const rows = game.guesses.map((id) => grade(byId.get(id)).map((c) => sq[c[1]]).join(""));
    return `Cupcake Index Daily #${today + 1} ${n}/${MAX}\n${rows.join("\n")}\ncupcakeindex.com/#/daily`;
  }

  function stats() {
    const s = store.get(STATS) || { played: 0, wins: 0, streak: 0, best: 0, last: null };
    return `<div class="dg-stats">
      <div><b>${s.played}</b><small>Played</small></div><div><b>${s.played ? Math.round(100 * s.wins / s.played) : 0}%</b><small>Win %</small></div>
      <div><b>${s.streak}</b><small>Streak</small></div><div><b>${s.best}</b><small>Best</small></div></div>`;
  }
  function record(win) {
    const s = store.get(STATS) || { played: 0, wins: 0, streak: 0, best: 0, last: null };
    s.played++;
    if (win) { s.wins++; s.streak = s.last === today - 1 ? s.streak + 1 : 1; s.last = today; s.best = Math.max(s.best, s.streak); }
    else s.streak = 0;
    store.set(STATS, s);
  }

  function endCard() {
    const a = answer, w = won();
    return `<div class="dg-end">
      <div class="dg-ans"><img src="${esc(shot(a.id))}" alt="" width="120" height="88">
        <div><div class="dg-gt">${w ? `solved in ${game.guesses.length}/${MAX}` : "out of guesses. today's player:"}</div>
        <a class="dg-who" href="#/player/${encodeURIComponent(a.id)}?league=nfl">${esc(a.name)}</a>
        <div class="muted">${esc(a.team)} · ${esc(a.pos)} · ${esc(a.college || "")}${a.num != null ? ` · #${a.num}` : ""}</div></div></div>
      ${stats()}
      <div class="dg-share"><button class="btn" id="dg-share">Copy result</button> <span class="muted" id="dg-copied"></span></div>
      <pre class="dg-pre">${esc(shareText())}</pre>
      <p class="dg-next">next player in <b id="dg-clock">--:--:--</b></p>
    </div>`;
  }

  function prompt() {
    return `<div class="dg-prompt"><label class="dg-gt" for="dg-in">&gt;</label>
      <input id="dg-in" type="search" autocomplete="off" spellcheck="false" placeholder="type a player name_" aria-label="Guess a player">
      <span class="muted dg-left">${MAX - game.guesses.length} left</span>
      <div id="dg-list" class="gs-results dg-list hidden" role="listbox"></div></div>`;
  }

  function draw() {
    const v = document.getElementById("view-daily");
    v.innerHTML = `<div class="card dg">
      <h2>Daily player <span class="muted dg-num">#${today + 1}</span></h2>
      <p class="note">Guess today's mystery NFL player in ${MAX} tries. It's a well-known QB, RB, WR or TE. Each guess shows how close you are:
        <span class="dg-key g">green</span> = match, <span class="dg-key y">yellow</span> = close (same division or conference, WR/TE, within 2 years or numbers), ↑ ↓ = the answer is higher or lower.</p>
      <div class="dg-board">${game.guesses.map(guessRow).join("")}</div>
      ${game.done ? "" : prompt()}
      ${game.done ? "" : hints()}
      ${game.done ? endCard() : ""}
    </div>`;
    if (game.done) wireEnd(); else wireInput();
  }

  function submit(id) {
    if (!id || game.done || game.guesses.includes(id)) return;
    game.guesses.push(id);
    if (id === answer.id || game.guesses.length >= MAX) { game.done = true; record(id === answer.id); }
    store.set(KEY, game);
    draw();
    if (!game.done) document.getElementById("dg-in")?.focus();
  }

  function wireInput() {
    const inp = document.getElementById("dg-in"), list = document.getElementById("dg-list");
    let hits = [];
    const paint = () => {
      list.classList.toggle("hidden", !hits.length);
      list.innerHTML = hits.map((p, i) => `<button type="button" data-id="${esc(p.id)}" class="${i === sel ? "on" : ""}"><span>${esc(p.name)}</span><small>${esc(p.team)} · ${esc(p.pos)}</small></button>`).join("");
    };
    inp.oninput = () => {
      const q = inp.value.trim();
      sel = 0;
      hits = q.length < 2 ? [] : [...byId.values()].filter((p) => !game.guesses.includes(p.id))
        .map((p) => [fuzzyScore(q, p.name), p]).filter(([s]) => s != null).sort((a, b) => a[0] - b[0]).slice(0, 6).map((x) => x[1]);
      paint();
    };
    inp.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, Math.min(hits.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1))); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); if (hits[sel]) submit(hits[sel].id); }
      else if (e.key === "Escape") { hits = []; paint(); }
    };
    list.onmousedown = (e) => e.preventDefault(); // keep focus in the input
    list.onclick = (e) => { const b = e.target.closest("[data-id]"); if (b) submit(b.dataset.id); };
  }

  let clock;
  function wireEnd() {
    document.getElementById("dg-share").onclick = async () => {
      const t = shareText(), msg = document.getElementById("dg-copied");
      try { await navigator.clipboard.writeText(t); msg.textContent = "copied, paste it anywhere"; }
      catch { msg.textContent = "copy the text below"; }
    };
    clearInterval(clock);
    const tick = () => {
      const el = document.getElementById("dg-clock");
      if (!el) return clearInterval(clock);
      const n = new Date(), mid = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1), s = Math.max(0, Math.floor((mid - n) / 1000));
      if (dayNum() !== today) { clearInterval(clock); render(); return; } // a new day: load the new player
      el.textContent = [s / 3600, (s % 3600) / 60, s % 60].map((x) => String(Math.floor(x)).padStart(2, "0")).join(":");
    };
    tick();
    clock = setInterval(tick, 1000);
  }

  async function render() {
    const v = document.getElementById("view-daily");
    try { await load(); } catch (e) { v.innerHTML = `<div class="card">Couldn't load today's game (${esc(e.message)}).</div>`; return; }
    pickAnswer();
    draw();
  }

  // Status for the Rankings banner: has today's game been played?
  function status() {
    const g = store.get(KEY);
    if (!g || g.day !== dayNum() || !g.guesses?.length) return "play ▸";
    if (!g.done) return `${MAX - g.guesses.length} guesses left ▸`;
    return g.guesses.includes(g.id) ? `solved in ${g.guesses.length} ✓` : "missed today ✗";
  }

  return { render, status };
})();
