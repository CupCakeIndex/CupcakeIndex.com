// Takes: every stat card, hot take and Bully of the Week we post on X, on the site too (newest first).
// src/social/feed.py adds each post to docs/data/takes.json when it goes out, tagged with the teams and players it's about,
// so team and player pages get a Takes tab with theirs. Betting hot takes and breaking news are left out.
const Takes = (() => {
  const PAGE = 20;
  let D = null, loadedAt = 0, shown = PAGE;

  async function load() {
    if (!D || Date.now() - loadedAt > 10 * 60000) {
      D = await getJSON("data/takes.json").catch(() => ({ teams: {}, players: {}, items: [] }));
      loadedAt = Date.now();
    }
    return D;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const lgOf = (k) => k.split(":")[0];
  const idOf = (k) => k.split(":")[1];

  // one post: date and time, the card picture (tap for full size), the text, and chips for its teams and players
  const card = (it) => `<article class="tk-item">
      <p class="nw-meta"><time datetime="${esc(it.time)}">${esc(it.date_only ? new Date(it.time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : when(it.time))}</time>${it.league ? ` · <span class="muted">${it.league === "nfl" ? "NFL" : "CFB"}</span>` : ""}</p>
      ${it.image ? `<a class="tk-pic" href="${esc(it.image)}" target="_blank" rel="noopener"><img src="${esc(it.image)}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.remove()"></a>` : ""}
      <p class="tk-text">${esc(it.text)}</p>
      ${it.teams?.length || it.players?.length ? `<p class="nw-teams">${(it.teams || []).filter((k) => D.teams[k]).map((k) =>
        `<a href="#/team/${esc(idOf(k))}?league=${esc(lgOf(k))}">${esc(D.teams[k].short || D.teams[k].name)}</a>`).join("")}${(it.players || []).filter((k) => D.players[k]).map((k) =>
        `<a href="#/player/${esc(idOf(k))}?league=${esc(lgOf(k))}">${esc(D.players[k])}</a>`).join("")}</p>` : ""}
      ${it.x ? `<p class="tk-x"><a class="muted" href="${esc(safeUrl(it.x))}" target="_blank" rel="noopener">See it on X ›</a></p>` : ""}
    </article>`;

  const list = (rows) => `<div class="nw-list tk-list">${rows.map(card).join("")}</div>`;

  async function render(params) {
    const el = $("#view-takes");
    if (!D) el.innerHTML = `<div class="card muted">Loading…</div>`;
    await load();
    const lg = params.get("all") === "1" ? "all" : league;
    const rows = D.items.filter((it) => lg === "all" || !it.league || it.league === lg);
    const btn = (v, label) => `<a class="nw-lg${v === lg ? " on" : ""}" href="#/takes?league=${v === "all" ? league : v}${v === "all" ? "&all=1" : ""}">${label}</a>`;
    const draw = () => {
      el.innerHTML = `<div class="card">
        <div class="sc-bar"><h2>Takes</h2><div class="presets">${btn("cfb", "CFB")}${btn("nfl", "NFL")}${btn("all", "All")}</div></div>
        <p class="muted tk-intro">Stats, hot takes and the Bully of the Week, the same posts we put on X. Newest first.</p>
        ${rows.length ? list(rows.slice(0, shown)) + (rows.length > shown ? `<button class="btn nw-more" id="tk-more">Show more</button>` : "")
          : `<p class="muted">No takes yet. The next one goes out soon.</p>`}</div>`;
      const more = $("#tk-more");
      if (more) more.onclick = () => { shown += PAGE; draw(); };
    };
    shown = PAGE;
    draw();
  }

  // the posts about one team or player ("lg:id"), newest first: the Takes tab on their page
  async function about(kind, key) {
    await load();
    return D.items.filter((it) => (it[kind] || []).includes(key));
  }

  return { render, about, list };
})();
