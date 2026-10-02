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
    const opts = (lg) => {
      const groups = {};
      for (const t of all[lg] || []) (groups[t.group || "Other"] ||= []).push(t);
      return `<option value="">Pick a team</option>` + Object.keys(groups).sort().map((g) => `<optgroup label="${esc(g)}">${groups[g]
        .map((t) => `<option value="${esc(t.name)}"${p[lg]?.name === t.name ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</optgroup>`).join("");
    };
    const watch = p.watch || "both";
    const first_ = (Account.user?.()?.displayName || "").split(" ")[0];
    const w = document.createElement("div");
    w.className = "pf-wrap";
    w.innerHTML = `<form class="card pf" id="pf-form" role="dialog" aria-modal="true" aria-labelledby="pf-title">
      <h2 id="pf-title">${first ? "Welcome to the Cupcake Index" : "Your profile"}</h2>
      ${first ? `<p class="note">Three quick questions so the site feels like yours. You can change these any time in Settings.</p>` : ""}
      <label class="pf-row"><span>What should we call you?</span><input id="pf-name" type="text" maxlength="30" autocomplete="given-name" value="${esc(p.name || first_)}"></label>
      <div class="pf-row"><span>What do you watch?</span>
        <div class="seg" id="pf-watch">${[["cfb", "College"], ["nfl", "NFL"], ["both", "Both"]].map(([k, l]) =>
          `<button type="button" data-w="${k}" class="${k === watch ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <label class="pf-row pf-cfb"><span>Favorite college team</span><select id="pf-cfb">${opts("cfb")}</select></label>
      <label class="pf-row pf-nfl"><span>Favorite NFL team</span><select id="pf-nfl">${opts("nfl")}</select></label>
      <div class="pf-row"><span>Other teams you follow <small>(optional, for quick links)</small></span>
        <div class="pf-add"><select id="pf-extra"><option value="">Add a team</option>
          <optgroup label="College">${(all.cfb || []).map((t) => `<option value="cfb|${esc(t.name)}">${esc(t.name)}</option>`).join("")}</optgroup>
          <optgroup label="NFL">${(all.nfl || []).map((t) => `<option value="nfl|${esc(t.name)}">${esc(t.name)}</option>`).join("")}</optgroup></select></div>
        <div class="pf-chips" id="pf-chips"></div></div>
      <label class="pf-check"><input type="checkbox" id="pf-theme" ${first || CIT.name() === "team" ? "checked" : ""}> Use my team's colors for the site (Team theme)</label>
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
    $w("#pf-extra").onchange = (e) => {
      const [lg, n] = e.target.value.split("|"), t = (all[lg] || []).find((x) => x.name === n);
      if (t && !extras.some((f) => f.lg === lg && f.id === t.id)) { extras.push({ ...t, lg }); chips(); }
      e.target.value = "";
    };
    $w("#pf-chips").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) { extras.splice(+b.dataset.i, 1); chips(); } };
    const close = () => w.remove();
    $w("#pf-skip").onclick = () => { if (first && !get()) save({ name: $w("#pf-name").value.trim(), watch: pick }); close(); }; // don't ask again
    w.addEventListener("click", (e) => { if (e.target === w) close(); });
    $w("#pf-form").onsubmit = (e) => {
      e.preventDefault();
      const find = (lg) => { const n = $w("#pf-" + lg).value; const t = (all[lg] || []).find((x) => x.name === n); return t && pick !== (lg === "cfb" ? "nfl" : "cfb") ? t : null; };
      const np = { name: $w("#pf-name").value.trim(), watch: pick, cfb: find("cfb"), nfl: find("nfl"), favs: extras };
      if ($w("#pf-theme").checked && (np.cfb || np.nfl)) CIT.save(CIT.mode(), "team");
      else if (CIT.name() === "team" && !$w("#pf-theme").checked) CIT.save(CIT.mode(), "varsity");
      save(np);
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

  return { get, mine, favorites, save, open, header, section, wire, KEY };
})();
