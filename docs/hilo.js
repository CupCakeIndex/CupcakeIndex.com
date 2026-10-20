// Higher or Lower: two NFL seasons side by side, tap the one with more of the stat, keep the streak going.
// Cards are real regular-season totals from docs/data/hilo.json (built by src/hilo_data.py): players 2022 on,
// teams back to 1999. Pairs get closer as the streak grows. Best streak lives in localStorage (synced when signed in).
const Hilo = (() => {
  const STATS = "hilo-stats";
  // [streak at which a level starts, name, smallest gap, biggest gap] (gap = difference / bigger value)
  const LEVELS = [[0, "Rookie", 0.25, 1], [5, "Starter", 0.12, 0.4], [10, "Pro Bowl", 0.05, 0.2], [20, "Hall of Fame", 0.001, 0.1]];
  let D, run, busy = false;

  const level = (n) => LEVELS.filter((l) => n >= l[0]).pop();
  const fmt = (v) => (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1));
  const rand = (n) => Math.floor(Math.random() * n);
  const best = () => store.get(STATS)?.best || 0;

  async function load() {
    if (D) return;
    D = await getJSON("data/hilo.json");
  }

  // A fresh pair at this streak's level: same stat, different values, not seen this run.
  function pickPair() {
    const [, , lo, hi] = level(run.streak);
    for (let tries = 0; tries < 400; tries++) {
      const s = D.stats[rand(D.stats.length)], a = s.items[rand(s.items.length)], b = s.items[rand(s.items.length)];
      if (a[0] === b[0] || a[1] === b[1]) continue;
      const gap = Math.abs(a[1] - b[1]) / Math.max(a[1], b[1]);
      const key = s.k + ":" + [a[0], b[0]].sort().join("-");
      if (gap < lo || gap > hi || run.seen.has(key)) continue;
      run.seen.add(key);
      return { stat: s, a, b };
    }
    run.seen.clear();   // ran out at this level (rare): allow repeats
    return pickPair();
  }

  function card(item, side, reveal) {
    const [name, id, yr, abbr, pos] = D.cards[item[0]];
    const img = id ? thumb(`https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`, 120, 88)
      : thumb(`https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`, 88);
    const win = reveal && item[1] > (side === "a" ? run.pair.b : run.pair.a)[1];
    return `<button type="button" class="hl-card${reveal ? (win ? " win" : " lose") : ""}${run.pick === side ? " picked" : ""}" data-side="${side}"${reveal ? " disabled" : ""}>
      <span class="hl-img${id ? "" : " hl-logo"}"><img src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'"></span>
      <b class="hl-name">${esc(name)}</b>
      <small>${yr}${id ? ` · ${esc(abbr)} · ${esc(pos)}` : " season"}</small>
      <span class="hl-val" data-v="${item[1]}">${reveal ? "0" : "?"}</span>
    </button>`;
  }

  function draw(reveal = false) {
    const v = document.getElementById("view-hilo"), { stat, a, b } = run.pair, lv = level(run.streak);
    v.innerHTML = `<div class="card hl">
      <h2><span class="dg-gt">&gt;</span> higher_or_lower</h2>
      <div class="hl-bar"><span>Streak <b>${run.streak}</b></span><span>Best <b>${Math.max(best(), run.streak)}</b></span><span class="hl-lv">${esc(lv[1])}</span></div>
      <p class="hl-q">Who had more <b>${esc(stat.label.toLowerCase())}</b>?</p>
      <div class="hl-pair">${card(a, "a", reveal)}<span class="hl-vs">vs</span>${card(b, "b", reveal)}</div>
      <div id="hl-after">${run.over ? endCard() : `<p class="note hl-note">Regular season totals. Players 2022–2025, teams 1999–2025. The closer you get to Hall of Fame, the closer the numbers.</p>`}</div>
    </div>`;
    if (reveal) countUp(v);
    if (run.over) wireEnd();
    else if (!reveal) v.querySelector(".hl-pair").onclick = (e) => { const c = e.target.closest("[data-side]"); if (c) choose(c.dataset.side); };
  }

  function countUp(v) {
    const els = [...v.querySelectorAll(".hl-val")], t0 = performance.now(), ms = 550;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3;
      for (const el of els) { const x = +el.dataset.v; el.textContent = fmt(k < 1 ? (Number.isInteger(x) ? Math.round(x * e) : x * e) : x); }
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => step(t0 + ms), ms + 60);   // land on the real number even if the tab skips animation frames
  }

  function choose(side) {
    if (busy || run.over) return;
    busy = true;
    run.pick = side;
    const { a, b } = run.pair, mine = side === "a" ? a : b, other = side === "a" ? b : a;
    const right = mine[1] > other[1];
    if (right) run.streak++;
    else run.over = true;
    if (run.over) record();
    draw(true);
    if (right) setTimeout(() => { busy = false; if (location.hash.startsWith("#/hilo")) next(); }, 1300);
    else busy = false;
  }

  function record() {
    const s = store.get(STATS) || { best: 0, played: 0, total: 0 };
    s.played++; s.total += run.streak; s.newBest = run.streak > s.best;
    s.best = Math.max(s.best, run.streak);
    store.set(STATS, s);
  }

  function endCard() {
    const s = store.get(STATS) || {};
    return `<div class="dg-end">
      <p class="hl-over">${s.newBest && run.streak ? "New best! " : ""}Streak over at <b>${run.streak}</b>.</p>
      <div class="dg-stats"><div><b>${run.streak}</b><small>this run</small></div><div><b>${s.best || 0}</b><small>best</small></div><div><b>${s.played || 0}</b><small>played</small></div><div><b>${s.played ? (s.total / s.played).toFixed(1) : "0"}</b><small>average</small></div></div>
      <div class="hl-btns"><button type="button" class="btn primary" id="hl-again">Play again</button><button type="button" class="btn" id="hl-share">Copy result</button><span class="muted" id="hl-copied"></span></div>
    </div>`;
  }

  function wireEnd() {
    document.getElementById("hl-again").onclick = start;
    document.getElementById("hl-share").onclick = async () => {
      const t = `Cupcake Index Higher or Lower: ${run.streak} in a row (${level(run.streak)[1]}). Best: ${best()}.\ncupcakeindex.com/#/hilo`, msg = document.getElementById("hl-copied");
      try { await navigator.clipboard.writeText(t); msg.textContent = "copied"; } catch { msg.textContent = t; }
    };
  }

  function next() { run.pick = null; run.pair = pickPair(); draw(); }
  function start() { run = { streak: 0, over: false, seen: new Set() }; busy = false; next(); }

  async function render() {
    const v = document.getElementById("view-hilo");
    try { await load(); } catch (e) { v.innerHTML = `<div class="card">Couldn't load the game (${esc(e.message)}).</div>`; return; }
    start();
  }

  // For the Games page: best streak so far
  function status() {
    const b = best();
    return b ? `best streak ${b} ▸` : "play ▸";
  }

  return { render, status };
})();
