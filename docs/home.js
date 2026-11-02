// Home (#/home): your favorite teams and starred players on one page. Teams come from Profile, stars from localStorage
// "starred-players" ({ "nfl:123": {id, lg, name} }, synced to your account by account.js and works signed out too).
// Stats, scores and news come from ESPN through Live.homePlayer / Live.homeTeam. Refreshes every minute while a game is on.
const Home = (() => {
  const KEY = "starred-players", MAX = 30;
  let run = 0, timer = null;

  const stars = () => store.get(KEY) || {};
  const isStarred = (lg, id) => !!stars()[`${lg}:${id}`];
  const hasAny = () => Object.keys(stars()).length > 0 || (typeof Profile !== "undefined" && Profile.favorites().length > 0);
  const when = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // the star button on player pages; one listener, so it works however the page was drawn
  const button = (lg, id, name) => {
    const on = isStarred(lg, id);
    return `<button type="button" class="btn hm-star${on ? " on" : ""}" data-star="${esc(lg)}:${esc(id)}" data-name="${esc(name)}" aria-pressed="${on}">${on ? "★ Starred" : "☆ Star"}</button>`;
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-star]");
    if (!b) return;
    e.preventDefault();
    const key = b.dataset.star, s = stars(), [lg, id] = key.split(":");
    if (s[key]) delete s[key];
    else if (Object.keys(s).length >= MAX) { b.textContent = `${MAX} stars max`; return; }
    else s[key] = { id, lg, name: b.dataset.name };
    store.set(KEY, s);
    const on = !!s[key];
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
    b.textContent = on ? "★ Starred" : "☆ Star";
  });

  const loading = (n, tall) => Array.from({ length: n }, () => `<div class="hm-card hm-load${tall ? " tall" : ""}"></div>`).join("");

  function gameLine(t, g, lg) {
    if (!g) return "";
    return `<a class="hm-game" href="${link("game", g.id, { league: lg })}">${g.body}</a>`;
  }

  function teamCard(f, t, inj, news) {
    const lg = f.lg, href = link("team", f.id, { league: lg });
    if (!t) return `<div class="hm-card"><a class="hm-top" href="${href}"><img src="${esc(thumb(f.logo, 44))}" alt="" width="40" height="40"><b>${esc(f.name)}</b></a><p class="note">Couldn't load this team. Try again in a minute.</p></div>`;
    const live = t.next?.live, next = t.next && !live ? { id: t.next.id, body: `<span>Next</span><b>${t.next.home ? "vs" : "at"} ${esc(t.next.opp)}</b><small>${esc(when(t.next.date))}</small>` } : null;
    const now = live ? { id: t.next.id, body: `<span class="hm-live">LIVE</span><b>${esc(t.abbr)} ${esc(live.my)}, ${esc(t.next.opp)} ${esc(live.their)}</b><small>${esc(live.clock)}</small>` } : null;
    const last = t.last ? { id: t.last.id, body: `<span>Last</span><b>${esc(t.last.res)} ${esc(t.last.my)}-${esc(t.last.their)} ${t.last.home ? "vs" : "at"} ${esc(t.last.opp)}</b>` } : null;
    const hurt = inj ? [inj.out && `${inj.out} out`, inj.q && `${inj.q} questionable`].filter(Boolean).join(", ") : "";
    return `<div class="hm-card"><a class="hm-top" href="${href}"><img src="${esc(thumb(t.logo || f.logo, 44))}" alt="" width="40" height="40">
      <div><b>${esc(t.name)}</b><small>${esc([t.record, t.rank ? `our #${t.rank}` : "", t.standing].filter(Boolean).join(" · "))}</small></div></a>
      ${gameLine(t, now, lg)}${gameLine(t, last, lg)}${gameLine(t, next, lg)}
      ${hurt ? `<p class="hm-note">Injury report: ${esc(hurt)}</p>` : ""}
      ${(news || []).map((n) => `<a class="hm-news" href="${esc(safeUrl(n.url))}" target="_blank" rel="noopener">${esc(n.title)}</a>`).join("")}</div>`;
  }

  function playerCard(s, p) {
    const href = link("player", s.id, { league: s.lg });
    const unstar = `<button type="button" class="hm-x on" data-star="${esc(s.lg)}:${esc(s.id)}" data-name="${esc(s.name)}" aria-label="Unstar ${esc(s.name)}" aria-pressed="true">★</button>`;
    if (!p) return `<div class="hm-card">${unstar}<a class="hm-top" href="${href}"><div><b>${esc(s.name)}</b><small>Couldn't load this player.</small></div></a></div>`;
    const line = p.live ? `<span class="hm-live">LIVE</span> ${esc(p.live.clock)}<div class="hm-line">${p.live.main.map((m) => `<b>${esc(m)}</b>`).join("")}</div>`
      : p.last ? `<small>${esc(p.last.res)} ${esc(p.last.score)} ${esc(p.last.atVs)} ${esc(p.last.opp)}</small><div class="hm-line">${p.last.line.map((m) => `<b>${esc(m)}</b>`).join("")}</div>` : "";
    return `<div class="hm-card">${unstar}<a class="hm-top" href="${href}"><img class="hm-face" src="${esc(p.head || p.logo || "")}" alt="" loading="lazy">
      <div><b>${esc(p.name)}</b><small>${esc([p.pos, p.team].filter(Boolean).join(" · "))}</small></div></a>
      ${p.inj ? `<p class="hm-note">${esc(p.inj)}</p>` : ""}
      ${line ? `<a class="hm-stat" href="${href}">${line}</a>` : ""}
      ${p.season ? `<p class="hm-season">${esc(p.season.value)} ${esc(p.season.label)} this season${p.season.pace ? `, on pace for ${esc(p.season.pace)}` : ""}</p>` : ""}
      ${p.news ? `<a class="hm-news" href="${esc(safeUrl(p.news.url))}" target="_blank" rel="noopener">${esc(p.news.title)}</a>` : ""}</div>`;
  }

  async function injuries() {
    const d = await getJSON("data/nfl_injuries.json").catch(() => null), out = {};
    for (const [nick, v] of Object.entries(d?.teams || {})) {
      const st = v.players.map((p) => p[4].toLowerCase());
      out[nick] = { out: st.filter((x) => x === "out" || x === "doubtful").length, q: st.filter((x) => x === "questionable").length };
    }
    return out;
  }

  async function render() {
    const box = $("#view-home"), my = ++run;
    clearTimeout(timer);
    const favs = Profile.favorites(), S = Object.values(stars()), signed = typeof Account !== "undefined" && Account.user?.();
    const name = Profile.get()?.name;
    box.innerHTML = `<h2 class="hm-h">${name ? `Hey ${esc(name)}` : "Home"}</h2>
      <div class="hm-today"><a href="${link("daily")}"><span>Daily player</span><b>${esc(Daily.status())}</b></a><a href="${link("picks")}"><span>Pick'em</span><b>Make your picks ▸</b></a></div>
      <h3 class="hm-s">Your teams</h3>
      ${favs.length ? `<div class="hm-grid" id="hm-teams">${box.dataset.teams || loading(favs.length)}</div>` : `<div class="hm-empty"><p>Pick your teams to see their scores, next game, injuries and news here.</p><button type="button" class="boxbtn" id="hm-pick">Pick my teams</button></div>`}
      <h3 class="hm-s">Your players</h3>
      ${S.length ? `<div class="hm-grid" id="hm-players">${box.dataset.players || loading(S.length, true)}</div>` : `<div class="hm-empty"><p>Tap <b>☆ Star</b> on any player's page and how they're doing shows up here.</p></div>`}
      ${!signed && typeof Account !== "undefined" && Account.enabled() ? `<p class="note hm-sync">This page is saved on this device. <a href="${link("settings")}">Sign in</a> to have it everywhere.</p>` : ""}`;
    box.querySelector("#hm-pick")?.addEventListener("click", () => Profile.open(false));
    const [T, P, inj] = await Promise.all([
      Promise.all(favs.map((f) => Live.homeTeam(f.lg, f.id).catch(() => null))),
      Promise.all(S.map((s) => Live.homePlayer(s.lg, s.id).catch(() => null))),
      injuries(),
    ]);
    const news = await Promise.all(favs.map((f) => News.latest(f.lg, f.id, 2)));
    if (my !== run || parseHash().view !== "home") return;
    const teams = favs.map((f, i) => teamCard(f, T[i], f.lg === "nfl" && T[i] ? inj[T[i].nick] : null, news[i])).join("");
    // starred players with a game going first, then the order you starred them
    const order = S.map((s, i) => [s, P[i]]).sort((a, b) => !!b[1]?.live - !!a[1]?.live);
    const players = order.map(([s, p]) => playerCard(s, p)).join("");
    const t = box.querySelector("#hm-teams"), p = box.querySelector("#hm-players");
    if (t) t.innerHTML = teams;
    if (p) p.innerHTML = players;
    box.dataset.teams = teams;
    box.dataset.players = players;
    if (T.some((x) => x?.next?.live) || P.some((x) => x?.live)) timer = setTimeout(() => { if (parseHash().view === "home") render(); }, 60000);
  }

  return { render, button, hasAny, KEY };
})();
