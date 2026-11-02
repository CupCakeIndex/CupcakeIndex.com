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
    <div class="plt-perf"></div>${t.legs.map((l, j) => leg(l, .2 + i * .09 + j * .07)).join("")}<button class="plt-share" data-share="${i}">Share ticket</button></div></article>`;

  // The Share picture: the same slip as the page (cut-out notches, tear line, payout, photos, chance bars), tall so it fits a phone.
  async function image(t, name, heat) {
    const W = 1080, S = 2, X = 56, TW = W - X * 2, top = 150, stub = 300, R = 18, ROW = 186, O = "#ff6b2c", INK = "#ececec", MUTE = "#8a8a8f", LINE = "#26262a";
    const perf = top + stub, bottom = perf + t.legs.length * ROW + 14, H = bottom + 150, F = Share.F;
    await document.fonts.ready.then(() => Promise.all(["400", "700", "800"].map((w) => document.fonts.load(`${w} 16px "JetBrains Mono"`)))).catch(() => {});
    const [pics, mark] = await Promise.all([Promise.all(t.legs.map((l) => Share.loadImg(l.id ? `https://a.espncdn.com/i/headshots/nfl/players/full/${l.id}.png` : logo(l.team)))), Share.loadImg("favicon.svg")]);
    const draw = (photos) => {
      const cv = document.createElement("canvas");
      cv.width = W * S; cv.height = H * S;
      const x = cv.getContext("2d");
      x.scale(S, S);
      const txt = (s, px, py, font, color, align = "left", max = 9999) => {
        x.font = font; x.fillStyle = color; x.textAlign = align;
        s = String(s);
        while (s.length > 2 && x.measureText(s).width > max) s = s.slice(0, -2) + "…";
        x.fillText(s, px, py);
      };
      const slip = () => { // the ticket's outline, with a half circle bitten out of each side at the tear line
        x.beginPath(); x.moveTo(X, top); x.lineTo(X + TW, top); x.lineTo(X + TW, perf - R);
        x.arc(X + TW, perf, R, -Math.PI / 2, Math.PI / 2, true);
        x.lineTo(X + TW, bottom); x.lineTo(X, bottom); x.lineTo(X, perf + R);
        x.arc(X, perf, R, Math.PI / 2, -Math.PI / 2, true);
        x.closePath();
      };
      x.fillStyle = "#0a0a0b"; x.fillRect(0, 0, W, H);
      x.textBaseline = "alphabetic";
      txt(`> PICKS OF THE WEEK · NFL WEEK ${D.week}`, X, 72, F(700, 34), O, "left", TW);
      txt(`${name} ticket · ${t.legs.length} legs${t.night ? " · night games" : ""}`, X, 112, F(400, 24), MUTE, "left", TW);
      // paper, with the same glow that grows with risk
      x.save();
      x.shadowColor = `rgba(255,107,44,${.25 + .4 * heat})`; x.shadowBlur = 24 + 30 * heat;
      const g = x.createLinearGradient(X, top, X + TW * .5, top + 520);
      g.addColorStop(0, "#2a1a12"); g.addColorStop(.55, "#111113");
      x.fillStyle = g; slip(); x.fill();
      x.restore();
      x.strokeStyle = "rgba(255,107,44,.35)"; x.lineWidth = 2; slip(); x.stroke();
      // the shine across the top, caught mid-sweep
      x.save();
      x.beginPath(); x.rect(X, top, TW, stub - 2); x.clip();
      const sh = x.createLinearGradient(X + 330, 0, X + 560, 0);
      sh.addColorStop(0, "rgba(255,255,255,0)"); sh.addColorStop(.5, "rgba(255,255,255,.05)"); sh.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = sh; x.transform(1, 0, -.32, 1, 110, 0); x.fillRect(X + 200, top, 520, stub);
      x.restore();
      // payout and chance
      x.save(); x.shadowColor = "rgba(255,107,44,.6)"; x.shadowBlur = 34;
      txt(`~${t.pays.toFixed(1)}x`, X + 40, top + 158, F(800, 128), O);
      x.restore();
      txt(`$10 nets about $${Math.round(t.pays * 10)}`, X + 40, top + 228, F(400, 32), MUTE);
      txt(`${Math.round(t.chance * 100)}%`, X + TW - 40, top + 92, F(700, 58), INK, "right");
      txt("chance", X + TW - 40, top + 130, F(400, 26), MUTE, "right");
      // tear line
      x.save(); x.strokeStyle = "rgba(255,107,44,.45)"; x.lineWidth = 3; x.setLineDash([13, 9]);
      x.beginPath(); x.moveTo(X + 36, perf); x.lineTo(X + TW - 36, perf); x.stroke(); x.restore();
      // legs
      t.legs.forEach((l, k) => {
        const y = perf + 8 + k * ROW, cy = y + ROW / 2, r = 54, px = X + 36, pic = pics[k], tx = px + r * 2 + 24, rt = X + TW - 36, tw = rt - tx - 104;
        x.save(); x.beginPath(); x.arc(px + r, cy, r, 0, Math.PI * 2); x.clip();
        x.fillStyle = LINE; x.fillRect(px, cy - r, r * 2, r * 2);
        if (pic && photos) { const w = (r * 2) * (pic.width / pic.height); x.drawImage(pic, px + r - w / 2, cy - r, w, r * 2); }
        x.restore();
        const note = (l.notes || []).join(" · "), pct = Math.round(l.p * 100), up = note ? 50 : 34;
        txt(`${l.name} ${l.line}+ ${STAT[l.kind]}`, tx, cy - up, F(700, 30), INK, "left", tw);
        txt(`${l.away ? "at" : "vs"} ${l.opp} · ${l.day} · ${l.cleared} of last 5 · ${TIER[l.tier]} D`, tx, cy - up + 36, F(400, 22), MUTE, "left", tw);
        if (note) txt(note, tx, cy - up + 68, F(400, 22), O, "left", tw);
        const by = cy - up + (note ? 88 : 60);
        x.fillStyle = LINE; x.fillRect(tx, by, tw, 8);
        x.fillStyle = O; x.fillRect(tx, by, tw * l.p, 8);
        txt(`${pct}%`, rt, cy + 14, F(800, 38), INK, "right");
        if (k < t.legs.length - 1) { x.fillStyle = LINE; x.fillRect(X + 2, y + ROW, TW - 4, 2); }
      });
      // under the ticket
      txt("For fun, not betting advice. Pays are estimates. 21+.", X, bottom + 62, F(400, 22), MUTE, "left", TW);
      txt("cupcakeindex.com", W - X, bottom + 110, F(700, 26), INK, "right");
      x.font = F(700, 26);
      if (mark) x.drawImage(mark, W - X - x.measureText("cupcakeindex.com").width - 50, bottom + 80, 38, 38);
      return cv;
    };
    const blob = (cv) => new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("no image"))), "image/png"));
    const out = await blob(draw(true)).catch(() => blob(draw(false))); // a photo without CORS can't be exported: redraw without photos
    return { blob: out, name: `cupcake-index-picks-week-${D.week}.png` };
  }

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
    rail.onclick = async (e) => {
      const b = e.target.closest("[data-share]");
      if (!b) return;
      b.textContent = "Drawing...";
      try {
        const { blob, name } = await image(T[+b.dataset.share], NAMES[i], i / 4);
        await Share.download(blob, name);
        b.textContent = "Share ticket";
      } catch { b.textContent = "Couldn't draw it"; setTimeout(() => { b.textContent = "Share ticket"; }, 2000); }
    };
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
