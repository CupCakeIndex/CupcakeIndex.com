// Mock draft (Play > Mock draft): our two-round NFL mock for next spring, and "Be the GM": a live draft (2 or all 7
// rounds) where the other teams pick one by one on screen by the same rules (best player left plus a bonus at their
// needs, with a little randomness), and you get a one-minute clock at each of your picks.
// Data: docs/data/nfl/mock_draft.json (src/mock_draft.py): the order from our season sims, team needs from our unit
// ranks, and a prospect board ranked by draft headlines, production and position value. Be the GM can also search every
// other draft-eligible player (docs/data/nfl/mock_pool.json, loaded on the first search) and take him: "not on our board".
const Mock = (() => {
  const STATS = "mock-gm";
  const CLOCK = 60, PACE = 450; // seconds on your clock; ms between the computer's picks on screen
  let D, POOL, gm = null, mode = "ours", rnd = 1, posF = "", q = "", gmRounds = 7, run = 0, tick = null;
  const OFF = 400; // where an off-board player counts in the grade: past anyone we have ranked
  const rankOf = (i) => (D.board[i].off ? null : i + 1);

  const teamLogo = (ab) => thumb(`https://a.espncdn.com/i/teamlogos/nfl/500/${ab.toLowerCase()}.png`, 40);
  const schoolLogo = (sid) => thumb(`https://a.espncdn.com/i/teamlogos/ncaa/500/${sid}.png`, 40);
  const tm = (ab) => D.teams[ab];
  const player = (b) => `<a href="${link("player", b.id, { league: "cfb" })}"><b>${esc(b.name)}</b></a>`;
  const POS_LIST = ["QB", "RB", "WR", "TE", "OT", "IOL", "OL", "EDGE", "DL", "LB", "CB", "S"];

  async function load() { if (!D) D = await getJSON("data/nfl/mock_draft.json"); }

  // who picks at overall pick n (0-based): the team that owns it after trades
  const slotTeam = (n) => (D.slots ? D.slots[n][0] : D.order[n % 32]);
  const fromTeam = (n) => (D.slots && D.slots[n][1] !== D.slots[n][0] ? D.slots[n][1] : "");
  const roundOf = (n) => (D.slots ? D.slots[n][2] : Math.floor(n / 32) + 1);
  const picksOf = (ab, rounds = gmRounds) => (D.slots || []).map((s, n) => (s[0] === ab && roundOf(n) <= rounds ? n + 1 : 0)).filter(Boolean);
  function row(pk, ab, b, why, you) {
    return `<div class="mk-pick${you ? " you" : ""}">
      <span class="mk-n">${pk}</span>
      <a class="mk-tm" href="${link("team", tm(ab).id, { league: "nfl" })}" title="${esc(tm(ab).name)}"><img src="${esc(teamLogo(ab))}" alt="" width="28" height="28"><span>${esc(ab)}${fromTeam(pk - 1) ? `<small class="mk-from">from ${esc(fromTeam(pk - 1))}</small>` : ""}</span></a>
      <img class="mk-sch" src="${esc(schoolLogo(b.sid))}" alt="" width="24" height="24" onerror="this.style.visibility='hidden'">
      <div class="mk-who">${player(b)} <span class="mk-pos">${esc(b.pos)}</span> <small class="muted">${esc(b.school)} · ${esc(b.cls)}</small>
        ${why ? `<small class="mk-why">${esc(why)}</small>` : ""}</div>
    </div>`;
  }

  function ours() {
    const list = D.picks.filter(([pk]) => (rnd === 1 ? pk <= 32 : pk > 32));
    return `<div class="seg mk-rnd">${[1, 2].map((r) => `<button type="button" data-rnd="${r}" class="${rnd === r ? "active" : ""}">Round ${r}</button>`).join("")}</div>
      <div class="mk-list">${list.map(([pk, ab, i, why]) => row(pk, ab, D.board[i], why)).join("")}</div>
      <p class="note">Our ${D.year} mock, updated ${esc(D.updated.slice(0, 10))}. <b>Order</b>: ${D.real_order ? "the real draft order from ESPN" : `${D.sims.toLocaleString("en-US")} simulations of the rest of the season from our win chances; teams that miss the playoffs pick first (fewest projected wins first), then playoff teams`}. Traded picks go to the team that owns them now (${(D.trades || []).filter((t) => t[1] <= 2).length} first- and second-round picks have changed hands, from ESPN's transactions), and a new trade shows up the next morning. <b>The board</b> ranks college juniors and up (plus sophomores the draft headlines treat as prospects) by how many draft headlines named them in the last 30 days (${D.headlines.toLocaleString("en-US")} headlines from mock drafts, big boards and team coverage), their ${D.season} production against everyone at their position, and how early their position usually goes. Our stats can't see film, so the headlines stand in for the scouts. <b>Picks</b>: each team takes the best player left, with a boost at its biggest needs (the units that rank lowest in our numbers). A team with its quarterback rarely takes another.</p>`;
  }

  // ---- Be the GM: a live draft. The computer's picks come in one at a time; at yours a one-minute clock runs.
  function fit(ab, i, needs, noise) {
    const b = D.board[i], u = D.need_of[b.pos], nd = needs[ab].map((n) => n[0]);
    return b.score + (nd.includes(u) ? D.need_bonus[nd.indexOf(u)] : 0) - (u === "QB" && !nd.includes("QB") ? 3 : 0) + noise * (Math.random() - 0.5);
  }
  const bestFor = (ab, noise) => { const sc = new Map(gm.left.map((i) => [i, fit(ab, i, gm.needs, noise)])); return gm.left.reduce((a, i) => (sc.get(i) > sc.get(a) ? i : a)); };
  function startGM(ab) {
    q = ""; posF = "";
    const total = D.slots ? D.slots.filter((s) => s[2] <= gmRounds).length : 32 * gmRounds;
    gm = { ab, total, pick: 0, fast: false, left: D.board.map((_, i) => i).filter((i) => !D.board[i].off), made: [], offIds: new Set(), auto: new Set(),
      needs: Object.fromEntries(Object.entries(D.teams).map(([k, t]) => [k, t.needs.map((n) => [n[0], n[1]])])) };
    simOn();
  }
  function take(i) {
    const ab = slotTeam(gm.pick), u = D.need_of[D.board[i].pos];
    gm.left = gm.left.filter((x) => x !== i);
    gm.made.push([gm.pick + 1, ab, i]);
    gm.needs[ab] = gm.needs[ab].filter((n) => n[0] !== u); // that need is filled
    gm.pick++;
  }
  const here = () => location.hash.startsWith("#/mock") && mode === "gm";
  // the computer picks, one at a time on screen, until it's your turn (or the draft ends); "Skip to my pick" speeds it up
  async function simOn() {
    const me = ++run;
    stopClock();
    while (gm && gm.pick < gm.total && slotTeam(gm.pick) !== gm.ab) {
      take(bestFor(slotTeam(gm.pick), 0.5));
      if (!gm.fast) { draw(); await new Promise((r) => setTimeout(r, PACE)); }
      if (me !== run || !here()) return; // left the page, started over or picked another team
    }
    gm.fast = false;
    gm.clock = CLOCK;
    if (gm.pick >= gm.total) record();
    draw();
    if (gm.pick < gm.total) startClock();
  }
  const mmss = (t) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.max(0, t) % 60).padStart(2, "0")}`;
  function stopClock() { clearInterval(tick); tick = null; }
  function startClock() {
    tick = setInterval(() => {
      if (!gm || !here()) return stopClock();
      gm.clock--;
      const el = document.getElementById("mk-timer");
      if (el) { el.textContent = mmss(gm.clock); el.classList.toggle("low", gm.clock <= 10); }
      if (gm.clock <= 0) { // time's up: the best fit on the board goes in for you
        stopClock();
        gm.auto.add(gm.pick + 1);
        take(bestFor(gm.ab, 0));
        q = ""; posF = "";
        simOn();
      }
    }, 1000);
  }
  function grade() {
    const mine = gm.made.filter(([, ab]) => ab === gm.ab), v = mine.map(([pk, , i]) => pk - (rankOf(i) ?? OFF));
    const avg = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) / Math.sqrt(gmRounds / 2); // 7 rounds: bigger gaps are normal late
    return { mine, v, letter: avg >= 10 ? "A" : avg >= 4 ? "B" : avg >= -4 ? "C" : avg >= -10 ? "D" : "F" };
  }
  function teamPicker() {
    const fav = typeof Profile !== "undefined" && Profile.mine("nfl");
    const favAb = fav && Object.keys(D.teams).find((k) => String(D.teams[k].id) === String(fav.id));
    return `<p class="dy-q">Pick your team. The other teams draft live on screen (best player left, nudged toward their needs), and you get a one-minute clock at each of your picks: search anyone and take him. Run out of time and we take the best fit for you.</p>
      <div class="seg mk-len">${[[2, "2 rounds"], [7, "All 7 rounds"]].map(([n, l]) => `<button type="button" data-len="${n}" class="${gmRounds === n ? "active" : ""}">${l}</button>`).join("")}</div>
      <div class="mk-teams">${D.order.map((ab) => { const pk = picksOf(ab);
        return `<button type="button" class="mk-tbtn${ab === favAb ? " fav" : ""}" data-ab="${ab}"${pk.length ? "" : ` disabled title="No picks in these rounds"`}><img src="${esc(teamLogo(ab))}" alt="" width="28" height="28"><span>${esc(ab)}</span><small>${pk.length ? `${pk.length} pick${pk.length === 1 ? "" : "s"} · first #${pk[0]}` : "no picks"}</small></button>`; }).join("")}</div>
      <p class="note">Picks include trades (from ESPN's transactions). ${D.real_order ? "" : "No compensatory picks until the real order comes out in January."}</p>`;
  }
  function gmHtml() {
    if (!gm) return teamPicker();
    const t = tm(gm.ab), done = gm.pick >= gm.total, mineLeft = picksOf(gm.ab).filter((n) => n > gm.pick + 1);
    const recent = gm.made.slice(-8).reverse().map(([pk, ab, i]) => row(pk, ab, D.board[i], "", ab === gm.ab)).join("");
    if (done) {
      const g = grade();
      return `<div class="mk-done"><p class="dy-rec">${esc(t.name)} draft grade: <span class="dy-champ">${g.letter}</span></p>
        <div class="mk-list">${g.mine.map(([pk, ab, i], k) => row(pk, ab, D.board[i], (gm.auto.has(pk) ? "Clock ran out, we picked. " : "") + (!rankOf(i) ? `Your guy: not on our board, taken at pick ${pk}` : g.v[k] >= 8 ? `Steal: #${i + 1} on our board at pick ${pk}` : g.v[k] <= -12 ? `Reach: #${i + 1} on our board at pick ${pk}` : `#${i + 1} on our board at pick ${pk}`), true)).join("")}</div>
        <div class="hl-btns"><button type="button" class="btn primary" id="mk-again">Draft again</button><button type="button" class="btn" id="mk-other">Pick another team</button><button type="button" class="btn" id="mk-share">Copy result</button><span class="muted" id="mk-copied"></span></div>
        <p class="note">The grade compares where you picked each player with where he sits on our board: taking our #5 at pick 12 is value, our #60 at pick 12 is a reach, and a player we don't have on the board counts as a big reach.</p></div>`;
    }
    const onClock = slotTeam(gm.pick) === gm.ab, ab = slotTeam(gm.pick);
    const head = `<div class="mk-clock${onClock ? " you" : ""}"><img src="${esc(teamLogo(ab))}" alt="" width="40" height="40"><div><b>${onClock ? "You're on the clock" : `${esc(tm(ab).name)} are picking`}</b>
        <small class="muted">Round ${roundOf(gm.pick)}, pick ${gm.pick + 1} of ${gm.total}${fromTeam(gm.pick) ? ` (from ${esc(tm(fromTeam(gm.pick)).name)})` : ""} · your next: ${mineLeft.length ? `#${mineLeft[0]}` : "none"}${onClock ? ` · needs: ${gm.needs[gm.ab].map((n) => esc(D.teams[gm.ab].needs.find((x) => x[0] === n[0])?.[2] || n[0])).join(", ") || "none left"}` : ""}</small></div>
        ${onClock ? `<b class="mk-timer${gm.clock <= 10 ? " low" : ""}" id="mk-timer">${mmss(gm.clock)}</b>` : `<button type="button" class="btn" id="mk-skip">Skip to my pick</button>`}</div>`;
    if (!onClock) return `${head}<div class="mk-list mk-live">${recent}</div>`;
    return `${head}
      <input type="search" class="mk-search" id="mk-q" placeholder="Search any prospect: name or school" value="${esc(q)}" autocomplete="off">
      <div class="mk-pos-f"><button type="button" data-pos="" class="${posF ? "" : "on"}">All</button>${POS_LIST.filter((p) => gm.left.some((i) => D.board[i].pos === p)).map((p) => `<button type="button" data-pos="${p}" class="${posF === p ? "on" : ""}">${p}</button>`).join("")}</div>
      <div class="mk-board">${boardRows()}</div>
      ${recent ? `<h3 class="mk-h3">Latest picks</h3><div class="mk-list">${recent}</div>` : ""}
      <p class="note"># = rank on our board. Search finds every draft-eligible player, on our board or not. <button type="button" class="linkbtn" id="mk-quit">Start over</button></p>`;
  }

  // the board you pick from: the best available (by position if one is picked), or search results from the board and
  // every other eligible player
  function boardRows() {
    const prow = (b, n, attr) => `<div class="mk-prow"><span class="mk-n">${n || "–"}</span><img class="mk-sch" src="${esc(schoolLogo(b.sid))}" alt="" width="24" height="24" onerror="this.style.visibility='hidden'">
      <div class="mk-who">${player(b)} <span class="mk-pos">${esc(b.pos)}</span> <small class="muted">${esc(b.school)} · ${esc(b.cls)}${n ? (b.buzz ? ` · ${b.buzz} draft headline${b.buzz === 1 ? "" : "s"}` : "") : " · not on our board"}</small></div>
      <button type="button" class="btn primary mk-take" ${attr}>Draft</button></div>`;
    const text = q.trim().toLowerCase();
    if (text.length < 2) return gm.left.filter((i) => !posF || D.board[i].pos === posF).slice(0, 40).map((i) => prow(D.board[i], i + 1, `data-i="${i}"`)).join("");
    const hit = (name, school) => { const f = fuzzyScore(text, name); return f != null ? f : school.toLowerCase().includes(text) ? 5 : null; };
    const fromBoard = gm.left.map((i) => [hit(D.board[i].name, D.board[i].school), i]).filter((x) => x[0] != null).map(([sc, i]) => [sc, i / 1000, prow(D.board[i], i + 1, `data-i="${i}"`)]);
    const fromPool = !POOL ? [] : POOL.players.map((r, k) => [hit(r[1], r[4]), k, r]).filter((x) => x[0] != null && !gm.offIds.has(x[2][0]))
      .map(([sc, k, r]) => [sc, 1 + k / 1e5, prow({ id: r[0], name: r[1], pos: r[2], sid: r[3], school: r[4], cls: r[5] }, 0, `data-p="${k}"`)]);
    const all = fromBoard.concat(fromPool).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 25);
    return all.length ? all.map((x) => x[2]).join("") : `<p class="muted">${POOL ? "No draft-eligible player matches." : "Searching…"}</p>`;
  }

  function draw() {
    const v = document.getElementById("view-mock");
    v.innerHTML = `<div class="card mk dy">
      <h2><span class="dg-gt">&gt;</span> mock_draft <small class="muted">${D.year} NFL Draft</small></h2>
      <div class="seg mk-mode"><button type="button" data-mode="ours" class="${mode === "ours" ? "active" : ""}">Our mock</button><button type="button" data-mode="gm" class="${mode === "gm" ? "active" : ""}">Be the GM</button></div>
      ${mode === "ours" ? ours() : gmHtml()}
    </div>`;
    v.querySelector(".mk-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { mode = b.dataset.mode; if (mode !== "gm") { gm = null; run++; stopClock(); } draw(); } };
    v.querySelector(".mk-rnd")?.addEventListener("click", (e) => { const b = e.target.closest("[data-rnd]"); if (b) { rnd = +b.dataset.rnd; draw(); } });
    v.querySelector(".mk-teams")?.addEventListener("click", (e) => { const b = e.target.closest("[data-ab]"); if (b && !b.disabled) startGM(b.dataset.ab); });
    v.querySelector(".mk-len")?.addEventListener("click", (e) => { const b = e.target.closest("[data-len]"); if (b) { gmRounds = +b.dataset.len; draw(); } });
    v.querySelector(".mk-pos-f")?.addEventListener("click", (e) => { const b = e.target.closest("[data-pos]"); if (b) { posF = b.dataset.pos; draw(); } });
    const qi = v.querySelector("#mk-q");
    qi?.addEventListener("input", async () => {
      q = qi.value;
      const box = v.querySelector(".mk-board");
      box.innerHTML = boardRows();
      if (q.trim().length >= 2 && !POOL) {
        try { POOL = await getJSON("data/nfl/mock_pool.json"); } catch { POOL = { players: [] }; }
        if (document.body.contains(box)) box.innerHTML = boardRows();
      }
    });
    v.querySelector(".mk-board")?.addEventListener("click", (e) => {
      const b = e.target.closest(".mk-take");
      if (!b) return;
      if (b.dataset.p != null) { // someone off our board: add him so the picks list can show him
        const r = POOL.players[+b.dataset.p];
        D.board.push({ id: r[0], name: r[1], pos: r[2], sid: r[3], school: r[4], cls: r[5], buzz: 0, score: 0, off: true });
        gm.offIds.add(r[0]);
        take(D.board.length - 1);
      } else take(+b.dataset.i);
      stopClock();
      q = "";
      posF = "";
      simOn();
    });
    const on = (id, f) => { const b = document.getElementById(id); if (b) b.onclick = f; };
    on("mk-again", () => startGM(gm.ab));
    on("mk-other", () => { gm = null; run++; stopClock(); draw(); });
    on("mk-quit", () => { gm = null; run++; stopClock(); draw(); });
    on("mk-skip", () => { gm.fast = true; });
    on("mk-share", async () => {
      const g = grade(), t = `Cupcake Index mock draft: I drafted for the ${tm(gm.ab).name} and got a ${g.letter}.\n` +
        g.mine.map(([pk, , i]) => `${pk}. ${D.board[i].name} (${D.board[i].pos}, ${D.board[i].school})`).join("\n") + "\ncupcakeindex.com/#/mock";
      const msg = document.getElementById("mk-copied");
      try { await navigator.clipboard.writeText(t); msg.textContent = "copied"; } catch { msg.textContent = t; }
    });
  }

  function record() {
    const s = store.get(STATS) || { played: 0, a: 0 };
    s.played++; if (grade().letter === "A") s.a++;
    store.set(STATS, s);
  }

  async function render(params) {
    const v = document.getElementById("view-mock");
    try { await load(); } catch (e) { v.innerHTML = `<div class="card">Couldn't load the mock draft (${esc(e.message)}).</div>`; return; }
    if (params?.get("gm")) mode = "gm";
    draw();
    if (gm && mode === "gm" && gm.pick < gm.total) { if (slotTeam(gm.pick) === gm.ab) { if (!tick) startClock(); } else simOn(); } // back mid-draft: pick up where it was
  }

  function status() { const s = store.get(STATS); return s?.played ? `${s.played} draft${s.played === 1 ? "" : "s"} ▸` : "play ▸"; }

  return { render, status };
})();
