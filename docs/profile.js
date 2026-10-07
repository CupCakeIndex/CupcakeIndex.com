// Your profile: name, what you watch (college / NFL / both) and your favorite team in each.
// Asked once after your first sign-in (Account), editable any time in Settings, and works signed out too (this browser only).
// Saved in localStorage "cupcake-profile" (synced to your account like your picks). It drives the Team theme
// (Varsity's look in your team's colors, applied in index.html <head>) and the team button in the header.
const Profile = (() => {
  const KEY = "cupcake-profile";
  let teams = null, closeMenu = null;
  document.addEventListener("click", (e) => { if (closeMenu && !e.target.closest(".my-team")) closeMenu(); });
  const get = () => store.get(KEY) || null;
  const loadTeams = async () => teams || (teams = await getJSON("data/teams.json").catch(() => ({ cfb: [], nfl: [] })));
  const mine = (lg) => get()?.[lg] || null; // exact favorite for this league (no fallback)

  function save(p) {
    store.set(KEY, p);
    CIT.apply();
    header();
    if (typeof render === "function" && DATA) render(); // rankings: highlight your team's row
    if (typeof Push !== "undefined") Push.sync(); // alerts: final scores follow your new teams
  }

  // every favorite: your main team in each league first, then the extras
  function favorites() {
    const p = get() || {}, out = [];
    for (const lg of ["cfb", "nfl"]) if (p[lg]) out.push({ ...p[lg], lg });
    for (const f of p.favs || []) if (!out.some((x) => x.lg === f.lg && x.id === f.id)) out.push(f);
    return out;
  }
  // header: your team's logo. One favorite = straight to its page; more = a small "My teams" menu.
  function header() {
    const ctl = $(".top .controls");
    if (!ctl) return;
    ctl.querySelector(".my-team")?.remove();
    const favs = favorites();
    if (!favs.length) return;
    const main = favs.find((f) => f.lg === league) || favs[0];
    const icon = `<img src="${esc(thumb(main.logo, 28))}" alt="" width="26" height="26">`;
    const one = favs.length === 1;
    ctl.insertAdjacentHTML("beforeend", `<div class="my-team">${one
      ? `<a class="my-team-btn" href="${link("team", main.id, { league: main.lg })}" title="Your team: ${esc(main.name)}" aria-label="Your team: ${esc(main.name)}">${icon}</a>`
      : `<button type="button" class="my-team-btn" aria-haspopup="true" aria-expanded="false" title="My teams" aria-label="My teams">${icon}</button>
         <div class="my-team-menu hidden" role="menu"><b>My teams</b>${favs.map((f) => `<a role="menuitem" href="${link("team", f.id, { league: f.lg })}">
           <img src="${esc(thumb(f.logo, 22))}" alt="" width="22" height="22"> ${esc(f.name)} <small>${f.lg === "nfl" ? "NFL" : "CFB"}</small></a>`).join("")}</div>`}</div>`);
    if (!one) {
      const box = ctl.querySelector(".my-team"), btn = box.querySelector("button"), menu = box.querySelector(".my-team-menu");
      const set = (on) => { menu.classList.toggle("hidden", !on); btn.setAttribute("aria-expanded", on); };
      btn.onclick = (e) => { e.stopPropagation(); set(menu.classList.contains("hidden")); };
      menu.onclick = () => set(false);
      closeMenu = () => set(false);
    }
  }

  // the welcome / edit window
  async function open(first = false) {
    const all = await loadTeams(), p = get() || {};
    document.querySelector(".pf-wrap")?.remove();
    const watch = p.watch || "both";
    const first_ = (Account.user?.()?.displayName || "").split(" ")[0];
    const w = document.createElement("div");
    w.className = "pf-wrap";
    w.innerHTML = `<form class="card pf" id="pf-form" role="dialog" aria-modal="true" aria-labelledby="pf-title">
      <h2 id="pf-title">${first === "refresh" ? "Quick check-in" : first ? "Welcome to the Cupcake Index" : "Your profile"}</h2>
      ${first === "refresh" ? `<p class="note">We added alerts for your teams and a Pick'em leaderboard. Make sure these are right (change anything any time in Settings).</p>`
        : first ? `<p class="note">Three quick questions so the site feels like yours. You can change these any time in Settings.</p>` : ""}
      <label class="pf-row"><span>What should we call you?</span><input id="pf-name" type="text" maxlength="30" autocomplete="given-name" value="${esc(p.name || first_)}"></label>
      <div class="pf-row"><span>What do you watch?</span>
        <div class="seg" id="pf-watch">${[["cfb", "College"], ["nfl", "NFL"], ["both", "Both"]].map(([k, l]) =>
          `<button type="button" data-w="${k}" class="${k === watch ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="pf-row pf-cfb"><span>Favorite college team</span><div class="pf-search" data-for="cfb"></div></div>
      <div class="pf-row pf-nfl"><span>Favorite NFL team</span><div class="pf-search" data-for="nfl"></div></div>
      <div class="pf-row"><span>Other teams you follow <small>(optional: quick links, and alerts if they're on)</small></span>
        <div class="pf-search" data-for="extra"></div>
        <div class="pf-chips" id="pf-chips"></div></div>
      <label class="pf-check"><input type="checkbox" id="pf-theme" ${first === true || CIT.name() === "team" ? "checked" : ""}> Use my team's colors for the site (Team theme)</label>
      ${first && typeof Push !== "undefined" && Push.canAsk() ? `<label class="pf-check"><input type="checkbox" id="pf-push" checked> Send me alerts for my teams (kickoffs, scores, finals)</label>` : ""}
      ${first && typeof Leaderboard !== "undefined" && Account.user?.() && !Leaderboard.name() ? `<div class="pf-row"><span>Pick'em leaderboard name <small>(optional; nobody else can have it)</small></span>
        <div class="lb-set"><input id="lb-name" maxlength="20" autocomplete="off" spellcheck="false" placeholder="Pick a name"><small id="lb-msg" class="muted"></small></div></div>`
        : first && typeof Account !== "undefined" && Account.enabled() && !Account.user?.() ? `<p class="note pf-signin">Want your Pick'em record on every device and a name on the Pick'em leaderboard? Sign in with Google in Settings (free).</p>` : ""}
      <div class="pf-btns"><button type="submit" class="gbtn pf-save">Save</button><button type="button" class="boxbtn" id="pf-skip">${first ? "Skip for now" : "Cancel"}</button></div>
    </form>`;
    document.body.appendChild(w);
    const $w = (s) => w.querySelector(s);
    let pick = watch;
    const show = () => { $w(".pf-cfb").hidden = pick === "nfl"; $w(".pf-nfl").hidden = pick === "cfb"; };
    show();
    $w("#pf-watch").onclick = (e) => { const b = e.target.closest("[data-w]"); if (!b) return; pick = b.dataset.w; w.querySelectorAll("#pf-watch button").forEach((x) => x.classList.toggle("active", x === b)); show(); };
    let extras = [...(p.favs || [])];
    const chips = () => { $w("#pf-chips").innerHTML = extras.map((f, i) => `<span class="pf-chip"><img src="${esc(thumb(f.logo, 18))}" alt="" width="18" height="18"> ${esc(f.name)}
      <button type="button" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join(""); };
    chips();
    // typed team search (like the bracket's "> pick_" prompt): name, mascot, abbreviation or initials ("osu", "ttu")
    const chosen = { cfb: p.cfb || null, nfl: p.nfl || null };
    const initials = (n) => n.split(/[\s-]+/).map((x) => x[0] || "").join("").toLowerCase();
    const matches = (q, lgs) => {
      q = q.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const lg of lgs) for (const t of all[lg] || []) {
        const name = t.name.toLowerCase(), score = name.startsWith(q) ? 0 : (t.mascot || "").toLowerCase().startsWith(q) || (t.abbr || "").toLowerCase() === q ? 1
          : initials(t.name) === q ? 1 : name.includes(q) || (t.mascot || "").toLowerCase().includes(q) ? 2 : -1;
        if (score >= 0) out.push({ ...t, lg, score });
      }
      return out.sort((x, y) => x.score - y.score || x.name.localeCompare(y.name)).slice(0, 6);
    };
    const field = (box) => {
      const which = box.dataset.for, lgs = which === "extra" ? ["cfb", "nfl"] : [which];
      const draw = () => {
        const t = which === "extra" ? null : chosen[which];
        box.innerHTML = t
          ? `<span class="pf-picked"><img src="${esc(thumb(t.logo, 22))}" alt="" width="22" height="22"> ${esc(t.name)}<button type="button" aria-label="Change team">×</button></span>`
          : `<label class="pf-tty"><span class="pf-gt">&gt;</span><input type="text" autocomplete="off" spellcheck="false" placeholder="${which === "extra" ? "add a team_" : "type your team_"}" aria-label="Search teams"></label><div class="pf-sug" role="listbox"></div>`;
        if (t) { box.querySelector("button").onclick = () => { chosen[which] = null; draw(); box.querySelector("input").focus(); }; return; }
        const inp = box.querySelector("input"), sug = box.querySelector(".pf-sug");
        let list = [];
        const pick = (t) => {
          if (which === "extra") { if (!extras.some((f) => f.lg === t.lg && f.id === t.id)) { extras.push(t); chips(); } inp.value = ""; sug.innerHTML = ""; inp.focus(); }
          else { chosen[which] = t; draw(); }
        };
        inp.oninput = () => {
          list = matches(inp.value, lgs);
          sug.innerHTML = list.map((t, i) => `<button type="button" role="option" data-i="${i}"><img src="${esc(thumb(t.logo, 20))}" alt="" width="20" height="20">
            ${esc(t.name)} <small>${esc(which === "extra" ? (t.lg === "nfl" ? "NFL" : "CFB") : t.group || "")}</small></button>`).join("")
            || (inp.value.trim() ? `<span class="pf-none">no match_</span>` : "");
        };
        inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); if (list[0]) pick(list[0]); } };
        sug.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) pick(list[+b.dataset.i]); };
      };
      draw();
    };
    w.querySelectorAll(".pf-search").forEach(field);
    $w("#pf-chips").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { extras.splice(+b.dataset.i, 1); chips(); } };
    const close = () => w.remove();
    $w("#pf-skip").onclick = () => { if (first && !get()) save({ name: $w("#pf-name").value.trim(), watch: pick }); close(); }; // don't ask again
    w.addEventListener("click", (e) => { if (e.target === w) close(); });
    $w("#pf-form").onsubmit = async (e) => {
      e.preventDefault();
      const lb = $w("#lb-name")?.value.trim();
      if (lb) { // claim the leaderboard name first; if it's taken, say so and keep the window open
        const m = $w("#lb-msg");
        if (!Leaderboard.valid(lb)) { m.textContent = "3–20 letters, numbers or spaces (and keep it clean)."; m.className = "lb-bad"; return; }
        m.textContent = "Saving…"; m.className = "muted";
        try { await Leaderboard.claim(lb); } catch (err) { m.textContent = err.message === "taken" ? "Taken. Try another (or leave it empty)." : "Couldn't save the name. Try again, or leave it empty."; m.className = "lb-bad"; return; }
      }
      const find = (lg) => { const t = chosen[lg]; if (!t || pick === (lg === "cfb" ? "nfl" : "cfb")) return null; const { score, lg: _l, ...clean } = t; return clean; };
      const np = { name: $w("#pf-name").value.trim(), watch: pick, cfb: find("cfb"), nfl: find("nfl"), favs: extras.map(({ score, ...f }) => f) };
      if ($w("#pf-theme").checked && (np.cfb || np.nfl)) CIT.save(CIT.mode(), "team");
      else if (CIT.name() === "team" && !$w("#pf-theme").checked) CIT.save(CIT.mode(), "varsity");
      save(np);
      const alerts = $w("#pf-push");
      if (alerts) { Push.markAsked(); if (alerts.checked) Push.turnOn(); } // still inside the tap, as iPhone requires
      close();
      if (typeof Settings !== "undefined" && !document.getElementById("view-settings").classList.contains("hidden")) Settings.render();
    };
    $w("#pf-name").focus();
  }

  // Settings section
  function section() {
    const p = get();
    const line = (lg, label) => p?.[lg] ? `<span class="pf-team"><img src="${esc(thumb(p[lg].logo, 22))}" alt="" width="22" height="22"> ${esc(p[lg].name)} <small>${label}</small></span>` : "";
    return `<h3>Your team</h3>
      ${p && (p.cfb || p.nfl) ? `<p class="pf-sum">${p.name ? `<b>${esc(p.name)}</b> · ` : ""}${line("cfb", "college")}${line("nfl", "NFL")}${(p.favs || []).length ? `<small class="muted">+ ${p.favs.length} more</small>` : ""}</p>`
        : `<p class="note">Pick your favorite college and/or NFL team: get a one-tap button to it in the header, its row highlighted on Rankings, and the Team theme in its colors.</p>`}
      <button type="button" class="boxbtn" id="pf-edit">${p && (p.cfb || p.nfl) ? "Edit" : "Pick my team"}</button>`;
  }
  function wire(root) { const b = root.querySelector("#pf-edit"); if (b) b.onclick = () => open(false); }

  // one-time check-in for everyone after new features (alerts, leaderboard names): bump SETUP to ask again
  const SETUP = 2;
  function checkIn() {
    if (navigator.webdriver) return;
    if ((+store.get("ci-setup") || 0) >= SETUP) return;
    if (document.querySelector(".pf-wrap, .tour")) { setTimeout(checkIn, 4000); return; } // the welcome window or the tour is up
    store.set("ci-setup", SETUP);
    open(get() ? "refresh" : true); // people who already set things up get the check-in; new visitors the normal welcome
  }
  setTimeout(checkIn, 3500); // after sign-in has settled, so signed-in people get the leaderboard name too

  return { get, mine, favorites, save, open, header, section, wire, KEY };
})();
