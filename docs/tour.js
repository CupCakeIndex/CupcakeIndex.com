// Quick tour of the best features: a small card at the bottom of the screen that takes you to each real page as you
// go (Next / Back / Skip). New visitors get a one-time "Take the tour?" invite; anyone can replay it from Settings.
// Remembered in localStorage "ci-tour" ("done" = finished or skipped), so it never nags.
const Tour = (() => {
  const KEY = "ci-tour";
  const top = () => { try { return rankTeams(DATA.teams)[0]?.team || ""; } catch { return ""; } };
  const STEPS = [
    { view: "rankings", title: "Power rankings", text: "Every team scored on power, résumé, efficiency, schedule and more. Tap any team to see why it's there. Switch College / NFL at the top." },
    { view: "breakdown", arg: top, title: "The breakdown", text: "Why a team is ranked where it is, in numbers: what each factor adds, what separates it from the teams around it, and how it played game by game." },
    { view: "resume", title: "Résumé Check", text: "Bullying cupcakes isn't a résumé. Take away the easy wins and see who's left standing." },
    { view: "scores", title: "Live scores", text: "Every game, live. Tap one for the box score, the live field, win chances and highlights." },
    { view: "stats", params: { show: "visualize" }, title: "Make your own charts", text: "Stats > Visualize: chart any stat for any team or player, any weeks. Download the picture and win the argument." },
    { view: "picks", title: "Pick'em", text: "Pick every game before Saturday night and keep a season record." },
    { view: "takes", title: "Takes", text: "Our stat cards and hot takes, the same ones we post on X. Teams' pages have their own Takes tab." },
    { view: "settings", title: "Make it yours", text: "Themes, your favorite teams, alerts for your teams' games, and sign in to keep your picks on every device. Replay this tour from here any time." },
  ];
  let i = 0, card = null;
  const ls = (v) => { try { if (v === undefined) return localStorage.getItem(KEY); localStorage.setItem(KEY, v); } catch { return null; } return null; };

  function go() {
    const s = STEPS[i], arg = typeof s.arg === "function" ? s.arg() : s.arg;
    const target = link(s.view, arg || null, s.params || {});
    if (location.hash !== target) location.hash = target;
    card.innerHTML = `<div class="tour-top"><small>${i + 1} of ${STEPS.length}</small><button class="tour-x" data-t="skip" aria-label="Close the tour">×</button></div>
      <h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>
      <div class="tour-dots">${STEPS.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("")}</div>
      <div class="tour-btns">${i ? `<button class="btn" data-t="back">Back</button>` : `<button class="btn" data-t="skip">Skip</button>`}
        <button class="btn tour-next" data-t="next">${i === STEPS.length - 1 ? "Done" : "Next"}</button></div>`;
    card.querySelector(".tour-next").focus({ preventScroll: true });
  }

  function start() {
    end(false);
    document.querySelector(".tour-invite")?.remove(); // started from Settings while the invite was up
    i = 0;
    card = document.createElement("div");
    card.className = "tour";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Quick tour");
    document.body.appendChild(card);
    card.onclick = (e) => {
      const t = e.target.closest("[data-t]")?.dataset.t;
      if (t === "next") { if (i === STEPS.length - 1) end(); else { i++; go(); } }
      else if (t === "back" && i) { i--; go(); }
      else if (t === "skip") end();
    };
    document.addEventListener("keydown", keys);
    go();
  }
  function keys(e) {
    if (!card) return;
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight" && i < STEPS.length - 1) { i++; go(); }
    else if (e.key === "ArrowLeft" && i) { i--; go(); }
  }
  function end(remember = true) {
    card?.remove();
    card = null;
    document.removeEventListener("keydown", keys);
    if (remember) ls("done");
  }

  // a one-time invite for new visitors, once nothing else (the welcome window) is on screen
  function invite() {
    if (ls() || navigator.webdriver) return;
    if (document.querySelector(".pf-wrap") || card) { setTimeout(invite, 4000); return; }
    const b = document.createElement("div");
    b.className = "tour tour-invite";
    b.innerHTML = `<div class="tour-top"><small>New here?</small><button class="tour-x" aria-label="No thanks">×</button></div>
      <h3>Take the 1-minute tour</h3><p>A quick look at the best stuff on the site. You can skip it any time.</p>
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
