// Quick tour of the app: a card at the bottom of the screen that takes you to each real page as you go
// (Next / Back / Skip), with a pulsing box around the thing being explained. New visitors get a one-time
// "Take the tour?" invite; anyone can replay it from Settings. Remembered in localStorage "ci-tour" ("done").
const Tour = (() => {
  const KEY = "ci-tour";
  const top = () => { try { return rankTeams(DATA.teams)[0]?.team || ""; } catch { return ""; } };
  // view (+ arg/params) to open, sel = what to outline, only = one league only
  const STEPS = [
    { view: "rankings", sel: "#table", title: "Power rankings", text: "Every team scored on power, résumé, efficiency, schedule and more. Tap any team for why it's there." },
    { view: "rankings", sel: "#cotw", title: "Bully of the Week", text: "The week's most lopsided win over a team that never stood a chance. Bullying cupcakes isn't a résumé." },
    { view: "rankings", sel: "#weights-fab", title: "Your weights", text: "Think schedule matters more than margin? Change how much each factor counts and the whole ranking re-sorts." },
    { view: "rankings", sel: "#league", title: "College or NFL", text: "Switch leagues any time. Everything on the site follows." },
    { view: "rankings", sel: "#gs", title: "Search anything", text: "Any team or player, past or present. On a computer, press / to jump straight here." },
    { view: "breakdown", arg: top, sel: ".bd-tbl", title: "The breakdown", text: "Why a team is ranked where it is: what each factor adds, what separates it from the teams around it, and game by game." },
    { view: "schedules", sel: "#sp-chart", title: "Schedules chart", text: "Who played a gauntlet and who took the easy road. Tap a dot for that team." },
    { view: "resume", sel: "#rc-table", title: "Résumé Check", text: "Take away the easy wins and re-rank everyone on what's left." },
    { view: "shame", sel: "#hs-pad-table", title: "Hall of Shame", text: "The most padded schedules, this season and all-time." },
    { view: "scores", sel: "#view-scores .mb-list, #view-scores .card", title: "Live scores", text: "Every game, live. Tap one for the box score, the live field, win chances and highlights." },
    { view: "standings", sel: "#view-standings .card", title: "Standings and brackets", text: "Conference standings, the playoff picture, and a bracket you can fill out yourself." },
    { view: "stats", sel: "#view-stats .subtabs", title: "Stats", text: "Leaders in every category, plus Frauds (players way under their projections), Projected and the injury report." },
    { view: "stats", params: { show: "visualize" }, sel: "#vz-preset", title: "Make your own charts", text: "Stats > Visualize: pick a preset or build any chart for any team or player. Download it and win the argument." },
    { view: "picks", sel: ".pk-grid", title: "Pick'em", text: "Pick every game before Saturday night and keep a season record." },
    { view: "picks", sel: "#view-picks .subtabs", title: "Leaderboard and badges", text: "See where you rank. Pick every game, lock in on time and go perfect for the 🏅 Perfect Pick'em badge." },
    { view: "games", sel: "#view-games .card", title: "Games", text: "A new player to guess every day, and more ways to play." },
    { view: "news", sel: "#nw-list", title: "News", text: "Headlines from ESPN, CBS, Yahoo and more, filtered to your teams if you want." },
    { view: "takes", sel: "#view-takes .card", title: "Takes", text: "Our stat cards and hot takes, the same ones we post on X. Team pages have their own Takes tab." },
    { view: "settings", sel: "#view-settings .card", title: "Make it yours", text: "Themes, your favorite teams, alerts for your teams' games, and sign in to keep your picks everywhere. Replay this tour from here any time." },
  ];
  let steps = STEPS, i = 0, card = null, ring = null, target = null, find = null;
  const ls = (v) => { try { if (v === undefined) return localStorage.getItem(KEY); localStorage.setItem(KEY, v); } catch { return null; } return null; };

  // the pulsing box: follows the element (scrolling, resizing, the page filling in)
  // pinned to the screen (like the Weights button): the box gets pinned too
  const pinned = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return true; return false; };
  function place() {
    if (!ring) return;
    const r = target?.getBoundingClientRect();
    if (!r || !r.width || !r.height) { ring.style.display = "none"; return; }
    const pad = 6, h = Math.min(r.height, innerHeight * 0.55), fixed = pinned(target); // a long table: frame its top, not the whole page
    Object.assign(ring.style, { display: "block", position: fixed ? "fixed" : "absolute",
      top: `${r.top + (fixed ? 0 : scrollY) - pad}px`, left: `${Math.max(2, r.left + (fixed ? 0 : scrollX) - pad)}px`,
      width: `${Math.min(r.width + pad * 2, document.documentElement.clientWidth - 4)}px`, height: `${h + pad * 2}px` });
    // keep the card out of the way: if the box is down where the card sits, the card moves to the top
    if (card) { const ch = card.getBoundingClientRect().height + 32; card.classList.toggle("tour-up", r.top + h > innerHeight - ch && r.top > ch); }
  }
  function outline(sel) {
    clearInterval(find);
    target = null;
    if (ring) ring.style.display = "none";
    if (!sel) return;
    const t0 = Date.now();
    find = setInterval(() => { // pages fill in after loading: wait up to 6 seconds for it
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height) {
        clearInterval(find);
        target = el;
        const r = el.getBoundingClientRect(), tall = r.height > innerHeight * 0.5;
        if (!pinned(el)) scrollTo({ top: Math.max(0, r.top + scrollY - (tall ? 90 : innerHeight * 0.3)), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        place();
        setTimeout(place, 500); setTimeout(place, 1500);
      } else if (Date.now() - t0 > 6000) clearInterval(find);
    }, 200);
  }

  function go() {
    const s = steps[i], arg = typeof s.arg === "function" ? s.arg() : s.arg;
    const where = link(s.view, arg || null, s.params || {});
    if (location.hash !== where) location.hash = where;
    card.innerHTML = `<div class="tour-top"><small>${i + 1} of ${steps.length}</small><button class="tour-x" data-t="skip" aria-label="Close the tour">×</button></div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tour-dots">${steps.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="tour-btns">${i ? `<button class="btn" data-t="back">Back</button>` : `<button class="btn" data-t="skip">Skip</button>`}
        <button class="btn tour-next" data-t="next">${i === steps.length - 1 ? "Done" : "Next"}</button></div>`;
    card.querySelector(".tour-next").focus({ preventScroll: true });
    outline(s.sel);
  }

  function start() {
    end(false);
    document.querySelector(".tour-invite")?.remove(); // started from Settings while the invite was up
    steps = STEPS.filter((s) => !s.only || s.only === league);
    i = 0;
    card = document.createElement("div");
    card.className = "tour";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Quick tour");
    ring = document.createElement("div");
    ring.className = "tour-ring";
    document.body.append(ring, card);
    card.onclick = (e) => {
      const t = e.target.closest("[data-t]")?.dataset.t;
      if (t === "next") { if (i === steps.length - 1) end(); else { i++; go(); } }
      else if (t === "back" && i) { i--; go(); }
      else if (t === "skip") end();
    };
    document.addEventListener("keydown", keys);
    addEventListener("resize", place);
    addEventListener("scroll", place, { passive: true });
    go();
  }
  function keys(e) {
    if (!card) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight" && i < steps.length - 1) { i++; go(); }
    else if (e.key === "ArrowLeft" && i) { i--; go(); }
  }
  function end(remember = true) {
    clearInterval(find);
    card?.remove(); ring?.remove();
    card = ring = target = null;
    document.removeEventListener("keydown", keys);
    removeEventListener("resize", place);
    removeEventListener("scroll", place);
    if (remember) ls("done");
  }

  // a one-time invite for new visitors, once nothing else (the welcome window) is on screen
  function invite() {
    if (ls() || navigator.webdriver) return;
    if (document.querySelector(".pf-wrap") || card) { setTimeout(invite, 4000); return; }
    const b = document.createElement("div");
    b.className = "tour tour-invite";
    b.innerHTML = `<div class="tour-top"><small>New here?</small><button class="tour-x" aria-label="No thanks">×</button></div>
      <h3>Take the 2-minute tour</h3><p>A quick look around: rankings, live scores, your own charts, Pick'em and more. You can skip it any time.</p>
      <div class="tour-btns"><button class="btn" data-t="no">No thanks</button><button class="btn tour-next" data-t="yes">Show me</button></div>`;
    document.body.appendChild(b);
    b.onclick = (e) => {
      const t = e.target.closest("[data-t], .tour-x");
      if (!t) return;
      b.remove();
      if (t.dataset.t === "yes") start(); else ls("done");
    };
  }
  setTimeout(invite, 3000);
  document.addEventListener("click", (e) => { if (e.target.closest("#set-tour")) start(); }); // Settings > Take the tour

  return { start };
})();
