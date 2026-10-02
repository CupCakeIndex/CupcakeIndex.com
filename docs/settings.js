// Settings page (#/settings, the gear in the header): Appearance (Dark / Light / System) and Theme.
// Choices are saved in localStorage and applied by window.CIT (the small script in index.html <head>, so there's no flash on load).
// Each theme's colors, fonts and corners live in style.css (THEMES section); the previews below are drawn with those same variables.
const Settings = (() => {
  const MODES = [["dark", "Dark"], ["light", "Light"], ["system", "System"]];
  const THEMES = [
    { key: "mono", name: "Data Terminal Mono", blurb: "The default. Monospace, black, orange." },
    { key: "terminal", name: "Data Terminal", blurb: "Same terminal look in green." },
    { key: "amber", name: "Data Terminal Amber", blurb: "Terminal look in amber." },
    { key: "broadcast", name: "Sleek Broadcast", blurb: "TV-graphics style: condensed headings, rounded cards." },
    { key: "editorial", name: "Editorial", blurb: "Newspaper serif headlines. Best in Light." },
    { key: "glass", name: "Midnight Glass", blurb: "Pure black, frosted cards, pill tabs." },
    { key: "varsity", name: "Varsity", blurb: "Navy and gold, collegiate lettering." },
  ];

  // A tiny fake rankings card in the theme's own colors (the .thp element carries the theme + mode attributes)
  const preview = (key, mode) => `<span class="thp" data-theme-name="${key}" data-theme="${mode}" aria-hidden="true">
    <span class="thp-h">Index <i>CFB</i><em></em></span>
    ${[["1", "Alabama", 82, 1], ["2", "Texas", 74, 0]].map(([r, t, w, cup]) => `<span class="thp-row"><b>${r}</b>
      <span><u>${t}</u><s><i${cup ? ' class="on"' : ""}></i><i></i><i></i></s></span>
      <span class="thp-bar"><i style="width:${w}%"></i></span></span>`).join("")}</span>`;

  function render() {
    const v = document.getElementById("view-settings"), mode = CIT.mode(), name = CIT.name();
    const shown = document.documentElement.dataset.theme; // the mode actually on screen (System resolved)
    THEMES.forEach((t) => CIT.font(t.key)); // previews need every theme's fonts
    v.innerHTML = `<div class="card set">
      <h2>Settings</h2>
      ${typeof Account !== "undefined" ? Account.section() : ""}
      <h3>Appearance</h3>
      <p class="note">System follows your phone or computer's dark/light setting.</p>
      <div class="seg" id="set-mode" role="group" aria-label="Appearance">${MODES.map(([k, l]) =>
        `<button type="button" data-mode="${k}" class="${k === mode ? "active" : ""}" aria-pressed="${k === mode}">${l}</button>`).join("")}</div>
      <h3>Theme</h3>
      <p class="note">Colors and fonts for the whole site. Every theme has a dark and a light version.</p>
      <div class="th-grid" id="set-theme">${THEMES.map((t) => `<button type="button" class="th-opt${t.key === name ? " on" : ""}" data-theme-key="${t.key}" aria-pressed="${t.key === name}">
        ${preview(t.key, shown)}
        <b>${esc(t.name)}${t.key === name ? "<span>✓ in use</span>" : ""}</b><small>${esc(t.blurb)}</small></button>`).join("")}</div>
      <p class="note set-foot">Saved in this browser only. <button type="button" class="link" id="set-reset">Back to the default</button> (Data Terminal Mono, System)</p>
    </div>`;
    v.querySelector("#set-mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { CIT.save(b.dataset.mode, CIT.name()); render(); } };
    v.querySelector("#set-theme").onclick = (e) => { const b = e.target.closest("[data-theme-key]"); if (b) { CIT.save(CIT.mode(), b.dataset.themeKey); render(); } };
    v.querySelector("#set-reset").onclick = () => { CIT.save("system", "mono"); render(); };
    if (typeof Account !== "undefined") Account.wire(v);
  }

  return { render };
})();
