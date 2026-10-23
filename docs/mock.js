// Mock draft (Play > Mock draft): our two-round NFL mock for next spring, and "Be the GM", where you pick for one team
// and the others draft by the same rules (best player left plus a bonus at their needs, with a little randomness).
// Data: docs/data/nfl/mock_draft.json (src/mock_draft.py): the order from our season sims, team needs from our unit
// ranks, and a prospect board ranked by draft headlines, production and position value.
const Mock = (() => {
  const STATS = "mock-gm";
  let D, gm = null, mode = "ours", rnd = 1, posF = "";

  const teamLogo = (ab) => thumb(`https://a.espncdn.com/i/teamlogos/nfl/500/${ab.toLowerCase()}.png`, 40);
  const schoolLogo = (sid) => thumb(`https://a.espncdn.com/i/teamlogos/ncaa/500/${sid}.png`, 40);
  const tm = (ab) => D.teams[ab];
  const player = (b) => `<a href="${link("player", b.id, { league: "cfb" })}"><b>${esc(b.name)}</b></a>`;
  const POS_LIST = ["QB", "RB", "WR", "TE", "OT", "IOL", "OL", "EDGE", "DL", "LB", "CB", "S"];

  async function load() { if (!D) D = await getJSON("data/nfl/mock_draft.json"); }

  function row(pk, ab, b, why, you) {
    return `<div class="mk-pick${you ? " you" : ""}">
      <span class="mk-n">${pk}</span>
      <a class="mk-tm" href="${link("team", tm(ab).id, { league: "nfl" })}" title="${esc(tm(ab).name)}"><img src="${esc(teamLogo(ab))}" alt="" width="28" height="28"><span>${esc(ab)}</span></a>
      <img class="mk-sch" src="${esc(schoolLogo(b.sid))}" alt="" width="24" height="24" onerror="this.style.visibility='hidden'">
      <div class="mk-who">${player(b)} <span class="mk-pos">${esc(b.pos)}</span> <small class="muted">${esc(b.school)} · ${esc(b.cls)}</small>
        ${why ? `<small class="mk-why">${esc(why)}</small>` : ""}</div>
    </div>`;
  }

  function ours() {
    const list = D.picks.filter(([pk]) => (rnd === 1 ? pk <= 32 : pk > 32));
    return `<div class="seg mk-rnd">${[1, 2].map((r) => `<button type="button" data-rnd="${r}" class="${rnd === r ? "active" : ""}">Round ${r}</button>`).join("")}</div>
      <div class="mk-list">${list.map(([pk, ab, i, why]) => row(pk, ab, D.board[i], why)).join("")}</div>
      <p class="note">Our ${D.year} mock, updated ${esc(D.updated.slice(0, 10))}. <b>Order</b>: ${D.sims.toLocaleString("en-US")} simulations of the rest of the season from our win chances; teams that miss the playoffs pick first (fewest projected wins first), then playoff teams. No trades. <b>The board</b> ranks college juniors and up (plus sophomores the draft headlines treat as prospects) by how many draft headlines named them in the last 30 days (${D.headlines.toLocaleString("en-US")} headlines from mock drafts, big boards and team coverage), their ${D.season} production against everyone at their position, and how early their position usually goes. Our stats can't see film, so the headlines stand in for the scouts. <b>Picks</b>: each team takes the best player left, with a boost at its biggest needs (the units that rank lowest in our numbers). A team with its quarterback rarely takes another.</p>`;
  }

  // ---- Be the GM
  function fit(ab, i, needs, noise) {
    const b = D.board[i], u = D.need_of[b.pos], nd = needs[ab].map((n) => n[0]);
    return b.score + (nd.includes(u) ? D.need_bonus[nd.indexOf(u)] : 0) - (u === "QB" && !nd.includes("QB") ? 3 : 0) + noise * (Math.random() - 0.5);
  }
  function startGM(ab) {
    gm = { ab, pick: 0, left: D.board.map((_, i) => i), made: [], needs: Object.fromEntries(Object.entries(D.teams).map(([k, t]) => [k, t.needs.map((n) => [n[0], n[1]])])) };
    advance();
  }
  const slotTeam = (n) => D.order[n % 32];
  function take(i) {
    const ab = slotTeam(gm.pick), u = D.need_of[D.board[i].pos];
    gm.left = gm.left.filter((x) => x !== i);
    gm.made.push([gm.pick + 1, ab, i]);
    gm.needs[ab] = gm.needs[ab].filter((n) => n[0] !== u); // that need is filled
    gm.pick++;
  }
  // computer teams pick until it's your turn (or the draft ends)
  function advance() {
    while (gm.pick < 64 && slotTeam(gm.pick) !== gm.ab) {
      const ab = slotTeam(gm.pick), sc = new Map(gm.left.map((i) => [i, fit(ab, i, gm.needs, 0.5)]));
      take(gm.left.reduce((a, i) => (sc.get(i) > sc.get(a) ? i : a)));
    }
    draw();
  }
  function grade() {
    const mine = gm.made.filter(([, ab]) => ab === gm.ab), v = mine.map(([pk, , i]) => pk - (i + 1));
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { mine, v, letter: avg >= 10 ? "A" : avg >= 4 ? "B" : avg >= -4 ? "C" : avg >= -10 ? "D" : "F" };
  }
  function gmHtml() {
    const fav = typeof Profile !== "undefined" && Profile.mine("nfl");
    const favAb = fav && Object.keys(D.teams).find((k) => String(D.teams[k].id) === String(fav.id));
    if (!gm) return `<p class="dy-q">Pick your team. The other 31 draft on their own (best player left, nudged toward their needs), and you're on the clock at your picks. Two rounds.</p>
      <div class="mk-teams">${D.order.map((ab, n) => `<button type="button" class="mk-tbtn${ab === favAb ? " fav" : ""}" data-ab="${ab}"><img src="${esc(teamLogo(ab))}" alt="" width="28" height="28"><span>${esc(ab)}</span><small>#${n + 1}</small></button>`).join("")}</div>`;
    const t = tm(gm.ab), done = gm.pick >= 64;
    const recent = gm.made.slice(-6).reverse().map(([pk, ab, i]) => row(pk, ab, D.board[i], "", ab === gm.ab)).join("");
    if (done) {
      const g = grade();
      return `<div class="mk-done"><p class="dy-rec">${esc(t.name)} draft grade: <span class="dy-champ">${g.letter}</span></p>
        <div class="mk-list">${g.mine.map(([pk, ab, i], k) => row(pk, ab, D.board[i], g.v[k] >= 8 ? `Steal: #${i + 1} on our board at pick ${pk}` : g.v[k] <= -12 ? `Reach: #${i + 1} on our board at pick ${pk}` : `#${i + 1} on our board at pick ${pk}`, true)).join("")}</div>
        <div class="hl-btns"><button type="button" class="btn primary" id="mk-again">Draft again</button><button type="button" class="btn" id="mk-other">Pick another team</button><button type="button" class="btn" id="mk-share">Copy result</button><span class="muted" id="mk-copied"></span></div>
        <p class="note">The grade compares where you picked each player with where he sits on our board: taking our #5 at pick 12 is value, our #60 at pick 12 is a reach.</p></div>`;
    }
    const avail = gm.left.filter((i) => !posF || D.board[i].pos === posF).slice(0, 40);
    return `<div class="mk-clock"><img src="${esc(teamLogo(gm.ab))}" alt="" width="40" height="40"><div><b>${esc(t.name)} are on the clock</b>
        <small class="muted">Pick ${gm.pick + 1} (round ${gm.pick < 32 ? 1 : 2}) · needs: ${gm.needs[gm.ab].map((n) => esc(D.teams[gm.ab].needs.find((x) => x[0] === n[0])?.[2] || n[0])).join(", ") || "none left"}</small></div></div>
      <div class="mk-pos-f"><button type="button" data-pos="" class="${posF ? "" : "on"}">All</button>${POS_LIST.filter((p) => gm.left.some((i) => D.board[i].pos === p)).map((p) => `<button type="button" data-pos="${p}" class="${posF === p ? "on" : ""}">${p}</button>`).join("")}</div>
      <div class="mk-board">${avail.map((i) => { const b = D.board[i];
        return `<div class="mk-prow"><span class="mk-n">${i + 1}</span><img class="mk-sch" src="${esc(schoolLogo(b.sid))}" alt="" width="24" height="24" onerror="this.style.visibility='hidden'">
          <div class="mk-who">${player(b)} <span class="mk-pos">${esc(b.pos)}</span> <small class="muted">${esc(b.school)} · ${esc(b.cls)}${b.buzz ? ` · ${b.buzz} draft headline${b.buzz === 1 ? "" : "s"}` : ""}</small></div>
          <button type="button" class="btn primary mk-take" data-i="${i}">Draft</button></div>`; }).join("")}</div>
      ${recent ? `<h3 class="mk-h3">Latest picks</h3><div class="mk-list">${recent}</div>` : ""}
      <p class="note"># = rank on our board. <button type="button" class="linkbtn" id="mk-quit">Start over</button></p>`;
  }

  function draw() {
    const v = document.getElementById("view-mock");
    v.innerHTML = `<div class="card mk dy">
      <h2><span class="dg-gt">&gt;</span> mock_draft <small class="muted">${D.year} NFL Draft</small></h2>
      <div class="seg mk-mode"><button type="button" data-mode="ours" class="${mode === "ours" ? "active" : ""}">Our mock</button><button type="button" data-mode="gm" class="${mode === "gm" ? "active" : ""}">Be the GM</button></div>
      ${mode === "ours" ? ours() : gmHtml()}
    </div>`;
    v.querySelector(".mk-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { mode = b.dataset.mode; draw(); } };
    v.querySelector(".mk-rnd")?.addEventListener("click", (e) => { const b = e.target.closest("[data-rnd]"); if (b) { rnd = +b.dataset.rnd; draw(); } });
    v.querySelector(".mk-teams")?.addEventListener("click", (e) => { const b = e.target.closest("[data-ab]"); if (b) { posF = ""; startGM(b.dataset.ab); } });
    v.querySelector(".mk-pos-f")?.addEventListener("click", (e) => { const b = e.target.closest("[data-pos]"); if (b) { posF = b.dataset.pos; draw(); } });
    v.querySelector(".mk-board")?.addEventListener("click", (e) => {
      const b = e.target.closest(".mk-take");
      if (!b) return;
      take(+b.dataset.i);
      posF = "";
      advance();
      if (gm.pick >= 64) record();
      v.querySelector(".mk-clock, .mk-done")?.scrollIntoView({ block: "nearest" });
    });
    const on = (id, f) => { const b = document.getElementById(id); if (b) b.onclick = f; };
    on("mk-again", () => startGM(gm.ab));
    on("mk-other", () => { gm = null; draw(); });
    on("mk-quit", () => { gm = null; draw(); });
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
  }

  function status() { const s = store.get(STATS); return s?.played ? `${s.played} draft${s.played === 1 ? "" : "s"} ▸` : "play ▸"; }

  return { render, status };
})();
