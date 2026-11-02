// Picks of the Week (Play tab): NFL tickets you swipe through, from docs/data/parlays.json (src/picks.py, parlays.yml).
// Tickets change through the week with injuries, trades, QB changes and weather. Pays are estimates, never a book's price.
const Parlays = (() => {
  const KEY = "parlay-level";
  const LV = ["1.5", "2", "3", "5", "10"], NAMES = ["Safest", "Careful", "Balanced", "Bold", "Risky"];
  const STAT = { pass: "pass yds", rush: "rush yds", rec: "rec yds" }, TIER = ["tough", "middling", "soft"], ESPN = { WAS: "wsh", LA: "lar" };
  let D;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const logo = (t) => `https://a.espncdn.com/i/teamlogos/nfl/500/${(ESPN[t] || t).toLowerCase()}.png`;
  const level = () => { try { const s = localStorage.getItem(KEY), v = +s; return s !== null && v >= 0 && v <= 4 ? v : 2; } catch { return 2; } };
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  function roll(el, to) { // the payout counts up
    const t0 = performance.now();
    const go = (t) => { const k = Math.min(1, (t - t0) / 700); el.textContent = `~${(to * (1 - (1 - k) ** 3)).toFixed(1)}x`; if (k < 1) requestAnimationFrame(go); };
    requestAnimationFrame(go);
  }

  function leg(l, delay) {
    const pic = l.id ? `https://a.espncdn.com/i/headshots/nfl/players/full/${esc(l.id)}.png` : logo(l.team);
    const who = l.id ? `<a href="#/player/${esc(l.id)}?league=nfl">${esc(l.name)}</a>` : esc(l.name);
    const notes = (l.notes || []).map((n) => `<small class="plt-note">${esc(n)}</small>`).join("");
    const pct = Math.round(l.p * 100);
    return `<div class="plt-leg" style="animation-delay:${delay}s"><img class="plt-pic" src="${pic}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${logo(l.team)}'">
      <div class="plt-m"><div class="plt-l">${who} ${l.line}+ ${STAT[l.kind]}</div><small>${l.away ? "at" : "vs"} ${esc(l.opp)} · ${esc(l.day)} · ${l.cleared} of last 5 · ${TIER[l.tier]} D</small>${notes}
      <div class="plt-bar"><i data-w="${pct}"></i></div></div><b>${pct}%</b></div>`;
  }

  const ticket = (t, i) => `<article class="plt-card" style="animation-delay:${i * .09}s,${i * .09 + .5}s"><div class="plt-t"><div class="plt-top"><div class="plt-p" data-p="${t.pays}">~0.0x</div>
    <div class="plt-win">$10 nets about $${Math.round(t.pays * 10)}${t.night ? " · night games" : ""}</div><div class="plt-ch"><b>${Math.round(t.chance * 100)}%</b>chance</div></div>
    <div class="plt-perf"></div>${t.legs.map((l, j) => leg(l, .2 + i * .09 + j * .07)).join("")}</div></article>`;

  function draw(i) {
    const box = $("#view-parlays"), v = LV[i], b = D.backtest[v];
    const T = [...(D.levels[v] || []), ...(D.prime[v] || []).map((t) => ({ ...t, night: 1 }))];
    box.style.setProperty("--heat", i / 4);
    box.querySelectorAll("[data-l]").forEach((x) => x.classList.toggle("on", +x.dataset.l === i));
    box.querySelector("#plt-rec").textContent = `Tickets like these hit ${b.hit}% of the time over ${b.n} tested, 2016-25.`;
    const rail = box.querySelector("#plt-rail"), dots = box.querySelector("#plt-dots");
    rail.scrollLeft = 0;
    rail.innerHTML = T.length ? T.map(ticket).join("") : `<div class="plt-off">Not enough reliable lines left at this risk level this week.</div>`;
    dots.innerHTML = T.length > 1 ? T.map((_, k) => `<i class="${k ? "" : "on"}"></i>`).join("") : "";
    rail.querySelectorAll(".plt-p").forEach((e) => roll(e, +e.dataset.p));
    requestAnimationFrame(() => requestAnimationFrame(() => rail.querySelectorAll("[data-w]").forEach((e) => { e.style.width = `${e.dataset.w}%`; })));
    rail.onscroll = () => {
      const c = rail.querySelector(".plt-card");
      if (!c) return;
      const k = Math.round(rail.scrollLeft / (c.offsetWidth + 24));
      dots.querySelectorAll("i").forEach((d, n) => d.classList.toggle("on", n === k));
    };
  }

  async function render() {
    const box = $("#view-parlays");
    box.innerHTML = `<p class="muted">Loading...</p>`;
    try { D = await getJSON("data/parlays.json"); } catch { box.innerHTML = `<p class="muted">Picks aren't available right now.</p>`; return; }
    const ch = D.changes || [];
    box.innerHTML = `<h2 class="plt-h">Picks of the Week</h2>
      <p class="muted plt-sub">NFL Week ${D.week}. Updated ${esc(when(D.updated))}. Tickets change with injuries, trades and weather.</p>
      <div class="plt-risk">${LV.map((x, i) => `<button data-l="${i}">${x}x<small>${NAMES[i]}</small></button>`).join("")}</div>
      <p class="muted plt-rec" id="plt-rec"></p><div class="plt-rail" id="plt-rail"></div><div class="plt-dots" id="plt-dots"></div>
      ${ch.length ? `<h3 class="plt-s">News changes</h3><div class="plt-off">${ch.map((c) => `<div><b>${esc(c.name)}</b> off the board: ${esc(c.why)}. <span>${esc(when(c.at))}</span></div>`).join("")}</div>` : ""}
      <p class="plt-fine">For fun, not betting advice. Chance is how often lines like these hit in past seasons, adjusted for news. Pays are estimates, and real prices depend on the sportsbook, which may not offer every line. Past hit rates don't promise future ones. Must be 21+. Gambling problem? Call 1-800-GAMBLER.</p>`;
    box.querySelector(".plt-risk").onclick = (e) => {
      const b = e.target.closest("[data-l]");
      if (!b) return;
      try { localStorage.setItem(KEY, b.dataset.l); } catch {}
      draw(+b.dataset.l);
    };
    draw(level());
  }
  return { render };
})();
