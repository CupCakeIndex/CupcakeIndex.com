// Picks of the Week (Play tab): NFL tickets with a risk slider, from docs/data/parlays.json (src/picks.py, parlays.yml).
// Tickets change through the week with injuries, trades, QB changes and weather. Pays are estimates, never a book's price.
const Parlays = (() => {
  const KEY = "parlay-level";
  const LV = ["1.5", "2", "3", "5", "10"], NAMES = ["Safest", "Careful", "Balanced", "Bold", "Risky"];
  const STAT = { pass: "pass yds", rush: "rush yds", rec: "rec yds" }, TIER = ["tough", "middling", "soft"], ESPN = { WAS: "wsh", LA: "lar" };
  let D;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const logo = (t) => `https://a.espncdn.com/i/teamlogos/nfl/500/${(ESPN[t] || t).toLowerCase()}.png`;
  const level = () => { try { const v = +localStorage.getItem(KEY); return v >= 0 && v <= 4 && localStorage.getItem(KEY) !== null ? v : 2; } catch { return 2; } };
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  function leg(l) {
    const who = l.id ? `<a href="#/player/${esc(l.id)}?league=nfl">${esc(l.name)}</a>` : esc(l.name);
    const note = (l.notes || []).length ? `<small class="plt-note">${esc(l.notes.join(" · "))}</small>` : "";
    return `<div class="plt-leg"><img src="${logo(l.team)}" alt="" loading="lazy"><div class="plt-m"><div class="plt-l">${who} ${l.line}+ ${STAT[l.kind]}</div>
      <small>${l.away ? "at" : "vs"} ${esc(l.opp)} · ${esc(l.day)} · cleared ${l.cleared} of last 5 · ${TIER[l.tier]} D</small>${note}</div><b>${Math.round(l.p * 100)}%</b></div>`;
  }

  const ticket = (t) => `<div class="plt-tk"><div class="plt-th"><b>Pays ~${t.pays.toFixed(1)}x</b><span>$10 wins about $${Math.round((t.pays - 1) * 10)}</span>
    <span class="plt-r">${Math.round(t.chance * 100)}% chance · ${t.legs.length} legs</span></div>${t.legs.map(leg).join("")}</div>`;

  function draw(i) {
    const v = LV[i], b = D.backtest[v], box = $("#view-parlays");
    box.querySelector("#plt-mult").textContent = `About ${v}x your money`;
    box.querySelector("#plt-lab").textContent = NAMES[i];
    box.querySelector("#plt-hit").textContent = `${b.hit}%`;
    box.querySelector("#plt-said").textContent = `${b.said}%`;
    box.querySelector("#plt-n").textContent = b.n;
    const w = D.levels[v] || [], p = D.prime[v] || [];
    box.querySelector("#plt-t").innerHTML = w.length ? w.map(ticket).join("") : `<div class="plt-off">Not enough reliable lines left at this risk level this week.</div>`;
    box.querySelector("#plt-p").innerHTML = p.length ? p.map(ticket).join("") : `<div class="plt-off">Not enough reliable night-game lines at this risk level.</div>`;
  }

  async function render() {
    const box = $("#view-parlays");
    box.innerHTML = `<p class="muted">Loading...</p>`;
    try { D = await getJSON("data/parlays.json"); } catch { box.innerHTML = `<p class="muted">Picks aren't available right now.</p>`; return; }
    const ch = D.changes || [], i = level();
    box.innerHTML = `<h2 class="plt-h">Picks of the Week</h2>
      <p class="muted plt-sub">NFL Week ${D.week}. Updated ${esc(when(D.updated))}. Tickets change with injuries, trades and weather.</p>
      <div class="plt-risk"><div class="plt-rt"><b id="plt-mult"></b><span id="plt-lab"></span></div>
        <input type="range" id="plt-r" min="0" max="4" step="1" value="${i}" aria-label="How risky">
        <div class="plt-ends"><span>SAFE</span><span>RISKY</span></div>
        <div class="plt-proof"><div><small>Hit rate 2016-25</small><b id="plt-hit"></b></div><div><small>We predicted</small><b id="plt-said"></b></div><div><small>Tickets tested</small><b id="plt-n"></b></div></div></div>
      <h3 class="plt-s">Weekend tickets</h3><div id="plt-t"></div>
      <h3 class="plt-s">Primetime</h3><div id="plt-p"></div>
      ${ch.length ? `<h3 class="plt-s">News changes</h3><div class="plt-off">${ch.map((c) => `<div><b>${esc(c.name)}</b> off the board: ${esc(c.why)}. <span>${esc(when(c.at))}</span></div>`).join("")}</div>` : ""}
      <p class="plt-fine">For fun, not betting advice. Chance is how often lines like these hit in past seasons, adjusted for news. Pays are estimates, and real prices depend on the sportsbook, which may not offer every line. Past hit rates don't promise future ones. Must be 21+. Gambling problem? Call 1-800-GAMBLER.</p>`;
    const r = box.querySelector("#plt-r");
    r.oninput = () => { try { localStorage.setItem(KEY, r.value); } catch {} draw(+r.value); };
    draw(i);
  }
  return { render };
})();
