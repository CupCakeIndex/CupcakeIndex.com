// News tab: football headlines from public RSS feeds (ESPN, CBS Sports, Yahoo Sports, Pro Football Talk, ...).
// Browsers can't read those feeds directly, so src/news.py collects them hourly into docs/data/news.json.
// We only show headline + short summary + source, and every headline links out to the publisher.
const News = (() => {
  const PAGE = 40;
  const st = { source: "", q: "", shown: PAGE };
  let D = null, loadedAt = 0;

  async function load() {
    if (!D || Date.now() - loadedAt > 10 * 60000) { D = await getJSON("data/news.json"); loadedAt = Date.now(); }
    return D;
  }

  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const teamName = (k) => D.teams[k]?.name || "";
  const inLeague = (it, lg) => lg === "all" || it.league === lg || it.league === "both";

  // one headline card; `small` = compact version for team pages
  const card = (it, small) => {
    const pic = safeUrl(it.image);
    return `<article class="nw-item${pic && !small ? "" : " no-pic"}">
      ${pic && !small ? `<a class="nw-pic" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(pic)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></a>` : ""}
      <div class="nw-body">
        <p class="nw-meta"><b>${esc(it.source)}</b> · <time datetime="${esc(it.published)}" title="${esc(new Date(it.published).toLocaleString())}">${ago(it.published)}</time>${small ? "" : ` · <span class="muted">${it.league === "nfl" ? "NFL" : it.league === "cfb" ? "CFB" : "NFL/CFB"}</span>`}</p>
        <h3 class="nw-title"><a href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
        ${it.summary && !small ? `<p class="nw-sum">${esc(it.summary)}</p>` : ""}
        ${it.teams?.length && !small ? `<p class="nw-teams">${it.teams.map((k) => `<button data-team="${esc(teamName(k))}">${esc(D.teams[k]?.short || teamName(k))}</button>`).join("")}</p>` : ""}
      </div></article>`;
  };

  async function render(params) {
    const el = $("#view-news");
    const lg = params.get("all") === "1" ? "all" : league;
    if (!D) el.innerHTML = `<div class="card muted">Loading…</div>`;
    try { await load(); } catch (e) {
      el.innerHTML = `<div class="card">Couldn't load the news (${esc(e.message)}). Try again in a minute.</div>`;
      return;
    }
    const pool = D.items.filter((it) => inLeague(it, lg));
    const sources = [...new Set(pool.map((it) => it.source))].sort();
    if (st.source && !sources.includes(st.source)) st.source = "";
    const lgBtn = (v, label) => `<a class="nw-lg${v === lg ? " on" : ""}" href="#/news?league=${v === "all" ? league : v}${v === "all" ? "&all=1" : ""}">${label}</a>`;
    el.innerHTML = `<div class="card">
      <div class="sc-bar"><h2>News</h2>
        <div class="presets" id="nw-league">${lgBtn("cfb", "CFB")}${lgBtn("nfl", "NFL")}${lgBtn("all", "All")}</div>
        <select id="nw-source" aria-label="Source"><option value="">All sources</option>${sources.map((s) => `<option${s === st.source ? " selected" : ""}>${esc(s)}</option>`).join("")}</select>
        <input id="nw-q" type="search" placeholder="Filter by team…" aria-label="Filter by team" value="${esc(st.q)}">
        <span class="muted live-note" id="nw-count"></span></div>
      <div id="nw-list" class="nw-list"></div>
      <p class="note">Headlines from public RSS feeds; links go to the publisher. Updated ${ago(D.updated)}.</p></div>`;

    const draw = () => {
      const q = st.q.toLowerCase();
      const rows = pool.filter((it) => (!st.source || it.source === st.source)
        && (!q || it.teams.some((k) => teamName(k).toLowerCase().includes(q)) || it.title.toLowerCase().includes(q)));
      $("#nw-count").textContent = `${rows.length} headline${rows.length === 1 ? "" : "s"}`;
      $("#nw-list").innerHTML = rows.slice(0, st.shown).map((it) => card(it)).join("")
        + (rows.length > st.shown ? `<button class="btn nw-more" id="nw-more">Show more</button>` : "")
        || `<p class="muted">No headlines match.</p>`;
    };
    $("#nw-source").onchange = (e) => { st.source = e.target.value; st.shown = PAGE; draw(); };
    $("#nw-q").oninput = (e) => { st.q = e.target.value.trim(); st.shown = PAGE; draw(); };
    $("#nw-list").onclick = (e) => {
      if (e.target.id === "nw-more") { st.shown += PAGE; draw(); return; }
      const t = e.target.closest("[data-team]");
      if (t) { st.q = t.dataset.team; $("#nw-q").value = st.q; st.shown = PAGE; draw(); window.scrollTo(0, 0); }
    };
    draw();
  }

  // the 3 latest headlines that mention a team, for its team page ("" if none)
  async function forTeam(lg, id) {
    try { await load(); } catch { return ""; }
    const key = `${lg}:${id}`;
    const rows = D.items.filter((it) => it.teams?.includes(key)).slice(0, 3);
    if (!rows.length) return "";
    return `<div class="card nw-team"><div class="sc-bar"><h3>Latest news</h3>
      <a class="muted" href="#/news?league=${esc(lg)}" data-q="${esc(teamName(key))}">more ›</a></div>
      <div class="nw-list">${rows.map((it) => card(it, true)).join("")}</div>
      <p class="note">Links go to the publisher.</p></div>`;
  }
  // "more ›" on a team page opens the News tab filtered to that team
  document.addEventListener("click", (e) => { const a = e.target.closest(".nw-team [data-q]"); if (a) { st.q = a.dataset.q; st.source = ""; st.shown = PAGE; } });

  return { render, forTeam };
})();
