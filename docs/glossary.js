// Tap-to-explain glossary (Site review 11): the site's jargon (SOS, EPA, H2H, Gauntlet, Barbell, Bully, cupcake, PROE,
// CPOE) gets a dotted underline on every page; tap it (or hover on a computer) for a one-line explanation. The bubble is
// the same one the H2H / OVER tags use (app.js, ".tip-pop"). Only the first time each term shows up on a page, so a
// table full of "SOS" doesn't turn into a wall of underlines. Definitions match src/stat_glossary.py.
const Glossary = (() => {
  const TERMS = {
    SOS: "Strength of schedule: how good the teams they played are, no matter how good they are themselves. Higher = tougher schedule.",
    EPA: "Expected points added: how much each play changed a drive's expected points, from the down, distance and field position. Above 0 = better than an average play.",
    H2H: "Head to head: a team that beat another one, and is within 5 points of its score, is ranked right above it.",
    PROE: "Pass rate over expected: how much more (+) or less (-) a team passes than the situation (down, distance, score, time) usually calls for.",
    CPOE: "Completion % over expected: completions above (+) or below (-) what's expected for how hard each throw was. +5 = 5 points better than expected.",
    Gauntlet: "Gauntlet: a hard schedule with no fluff. No padding with cupcakes.",
    Barbell: "Barbell: a hard schedule, but padded with cupcakes too.",
    Bully: "Bully of the Week: the most lopsided beatdown of a cupcake that week.",
    cupcake: "Cupcake: an opponent far below a team's level, scheduled for an easy win (an FCS team, or a bad team 14+ points worse). Padding a record with them counts against a team.",
  };
  const key = (w) => (/^cupcakes?$/i.test(w) ? "cupcake" : w);
  // acronyms only in capitals; "cupcake(s)" any case, but not the site's name ("Cupcake Index")
  const RE = /\b(SOS|EPA|H2H|PROE|CPOE|Gauntlet|Barbell|Bully|[Cc]upcakes?)\b(?! Index)/g;
  const SKIP = "a, button, input, textarea, select, option, script, style, svg, code, .gl, .pill, .tip-pop, header, .brand, #gs-results, [contenteditable], .no-gl";

  function mark(root) {
    const done = new Set([...root.querySelectorAll(".gl")].filter((e) => e.offsetParent).map((e) => e.dataset.g)); // on the page you're looking at
    if (done.size === Object.keys(TERMS).length) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!n.nodeValue.trim() || n.parentElement.closest(SKIP) || !n.parentElement.offsetParent ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const hits = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (const m of n.nodeValue.matchAll(RE)) {
        const k = key(m[1]);
        if (done.has(k)) continue;
        done.add(k);
        hits.push([n, m.index, m[1], k]);
      }
    }
    for (let i = hits.length - 1; i >= 0; i--) { // back to front, so earlier offsets in the same text stay right
      const [n, at, word, k] = hits[i];
      const rest = n.splitText(at);
      rest.nodeValue = rest.nodeValue.slice(word.length);
      const s = document.createElement("span");
      s.className = "gl"; s.dataset.g = k; s.title = TERMS[k]; s.textContent = word; s.tabIndex = 0;
      n.parentNode.insertBefore(s, rest);
    }
  }

  // pages render on their own schedule (data loads, tabs), so re-check a moment after the page changes
  let timer = null;
  const main = document.querySelector("main");
  if (main) {
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => mark(main), 400); })
      .observe(main, { childList: true, subtree: true });
    mark(main);
  }
  return { TERMS, mark };
})();
