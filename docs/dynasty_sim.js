// Dynasty Draft playoff gamecast: turns one playoff game into play-by-play with the real players from each
// team-season (docs/data/dynasty/rosters_YYYY.json, src/dynasty_rosters.py), in the same shape as an ESPN game
// summary (drives -> plays with text, yard line, down and distance, clock, score), so docs/live.js draws it on the
// gamecast field like a real game.
// The final score is the one the quick sim already drew (Dynasty's game(): power ratings plus game-day luck), so
// the gamecast and the season sim always agree. The plays in between come from the unit matchups: your passing vs
// their coverage and pass rush, your run game vs their run defense, kicks from special teams.
const DynastySim = (() => {
  const R = Math.random;
  const rand = (n) => Math.floor(R() * n);
  const normal = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const phi = (z) => 1 / (1 + Math.exp(-1.702 * z));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // a name from a roster list, weighted by how often he had the ball (or made the play) that season
  const pickW = (list) => { if (!list?.length) return null; let x = R() * list.reduce((s, p) => s + p[4], 0); for (const p of list) if ((x -= p[4]) <= 0) return p; return list.at(-1); };

  // Points -> scoring events: touchdowns (extra point, a missed one now and then, or a two-point try) and field goals.
  // Among the ways to make the score, the likeliest have about 1 in 5 points from field goals, like the NFL.
  function events(P) {
    const opts = [];
    for (let t = 0; 7 * t <= P + 1; t++) for (const v of ["", "miss", "two"]) {
      if (v && !t) continue;
      const rem = P - 7 * t + (v === "miss" ? 1 : v === "two" ? -1 : 0);
      if (rem < 0 || rem % 3) continue;
      const f = rem / 3, want = (P * 0.22) / 3;
      opts.push({ t, f, v, w: Math.exp(-((f - want) ** 2) / 2.5) * (v === "miss" ? 0.06 : v === "two" ? 0.12 : 1) * (f > 5 ? 0.2 : 1) });
    }
    let x = R() * opts.reduce((s, o) => s + o.w, 0), o = opts.at(-1);
    for (const c of opts) if ((x -= c.w) <= 0) { o = c; break; }
    const ev = [...Array(o.t).fill("td"), ...Array(o.f).fill("fg")];
    if (o.v) ev[0] = o.v === "miss" ? "td-miss" : "td-two";
    return shuffle(ev);
  }

  // side: { id, abbr, z: {pass, run, rush, cover, rund, st}, R: {qb, rec, rb, rush, cov, tak, k, p, ret} (roster lists) }
  // home attacks toward yard line 100 (yard lines are measured from the home goal line, like ESPN's)
  // sd: game-day luck in points (Dynasty's LUCK), for the win chance after each play
  function build(home, away, homePts, awayPts, edge, sd = 13) {
    const T = [home, away];
    const nm = (side, key, alt) => (pickW(side.R[key]) || pickW(side.R[alt] || []) || [`${side.abbr} ${key.toUpperCase()}`, `${side.abbr}-${key.toUpperCase()}`])[1];
    const spot = (abs) => (abs === 50 ? "50" : abs < 50 ? `${home.abbr} ${Math.round(abs)}` : `${away.abbr} ${Math.round(100 - abs)}`);
    const absOf = (side, p) => (side === home ? p : 100 - p); // offense yards from its own goal -> yard line
    let pid = 401900000, score = { [home.id]: 0, [away.id]: 0 };
    const plays = [];

    // --- who has each drive, and how each one ends ---
    const R0 = R() < 0.5 ? home : away, other = (s) => (s === home ? away : home);
    const ev = { [home.id]: events(homePts), [away.id]: events(awayPts) };
    let n1 = 10 + rand(3), n2 = 10 + rand(3);
    const owner = (i) => (i < n1 ? (i % 2 ? other(R0) : R0) : ((i - n1) % 2 ? R0 : other(R0)));
    const count = (s) => Array.from({ length: n1 + n2 }, (_, i) => i).filter((i) => owner(i) === s).length;
    while (T.some((s) => count(s) < ev[s.id].length + 1)) n2 += 2;
    const N = n1 + n2, plan = Array(N).fill(null);
    for (const s of T) {
      const mine = shuffle(Array.from({ length: N }, (_, i) => i).filter((i) => owner(i) === s));
      ev[s.id].forEach((e, k) => { plan[mine[k]] = e; });
    }
    // drives that don't score: punts mostly; turnovers more often against a good pass defense
    for (let i = 0; i < N; i++) {
      if (plan[i]) continue;
      const o = owner(i), d = other(o), last1 = i === n1 - 1, last2 = i === N - 1;
      if (last1) { plan[i] = "half"; continue; }
      if (last2) { plan[i] = "end"; continue; }
      const pTO = clamp(0.14 + 0.03 * ((d.z.cover + d.z.rush) / 2 - o.z.pass), 0.05, 0.26), x = R();
      plan[i] = x < pTO * 0.6 ? "int" : x < pTO ? "fum" : x < pTO + 0.05 ? "downs" : x < pTO + 0.12 ? "missfg" : "punt";
    }

    // --- one play: run or pass, decided by the matchup ---
    function snap(o, d, down, dist, p) {
      const passEdge = o.z.pass - d.z.cover, runEdge = o.z.run - d.z.rund;
      const passRate = clamp((down === 3 && dist > 4 ? 0.82 : down >= 3 && dist <= 2 ? 0.38 : down === 2 && dist > 7 ? 0.65 : 0.55) + 0.05 * (o.z.pass - o.z.run), 0.25, 0.9);
      if (R() < passRate) {
        if (R() < clamp(0.065 + 0.015 * (d.z.rush - o.z.pass), 0.025, 0.12)) return { k: "sack", y: -rand(9) - 2 };
        if (R() < clamp(0.035 + 0.008 * -passEdge, 0.012, 0.06)) return { k: "int", y: 8 + rand(18) };
        if (R() > clamp(0.63 + 0.035 * passEdge, 0.45, 0.78)) return { k: "inc", y: 0, deep: R() < 0.3 };
        const deep = R() < 0.17, y = deep ? 18 + rand(30) + Math.round(3 * passEdge) : Math.max(-2, Math.round(3 + -Math.log(R()) * (6.5 + 0.8 * passEdge)));
        return { k: "pass", y, deep };
      }
      if (R() < 0.012) return { k: "fum", y: rand(4) };
      const big = R() < clamp(0.05 + 0.015 * runEdge, 0.02, 0.09);
      return { k: "run", y: big ? 12 + rand(35) : Math.max(-4, Math.round(normal() * 3.6 + 3.9 + 0.5 * runEdge)) };
    }
    const DIRS = ["left end", "left tackle", "left guard", "up the middle", "right guard", "right tackle", "right end"];
    const PDIR = ["left", "middle", "right"];

    // the text, ESPN style: "C.Palmer pass deep right to L.Fitzgerald to NE 20 for 31 yards (D.McCourty)."
    function playText(o, d, r, from, to) {
      const qb = nm(o, "qb"), at = spot(absOf(o, to));
      r.qb = qb;
      if (r.k === "sack") { r.def = nm(d, "rush", "tak"); return `${qb} sacked at ${at} for ${r.y} yards (${r.def}).`; }
      if (r.k === "inc") { r.to = nm(o, "rec"); return `${qb} pass incomplete ${r.deep ? "deep" : "short"} ${PDIR[rand(3)]} to ${r.to}${R() < 0.3 ? ` (${nm(d, "cov")})` : ""}.`; }
      if (r.k === "pass") {
        r.to = nm(o, "rec");
        return `${qb} pass ${r.deep ? "deep" : "short"} ${PDIR[rand(3)]} to ${r.to} to ${at} for ${r.y} ${Math.abs(r.y) === 1 ? "yard" : "yards"} (${nm(d, r.y > 15 ? "cov" : R() < 0.5 ? "cov" : "tak")}).`;
      }
      if (r.k === "kneel") return `${qb} kneels to ${at} for -1 yards.`;
      r.qb = null;
      r.to = nm(o, "rb");
      return `${r.to} ${DIRS[rand(7)]} to ${at} for ${r.y} ${Math.abs(r.y) === 1 ? "yard" : "yards"} (${nm(d, "tak")}).`;
    }

    // --- one drive, from offense yard line p (0 = own goal), ending the way the plan says ---
    const TYPE = { run: ["5", "Rush"], pass: ["24", "Pass Reception"], inc: ["3", "Pass Incompletion"], sack: ["7", "Sack"], kneel: ["5", "Rush"] };
    const sit = (s, down, dist, p) => ({ down, distance: dist, yardLine: absOf(s, p), team: { id: s.id }, possessionText: spot(absOf(s, p)),
      downDistanceText: down ? `${["", "1st", "2nd", "3rd", "4th"][down]} & ${dist > 100 - p ? "Goal" : dist} at ${spot(absOf(s, p))}` : "" });
    const stat = (o, r) => ({ side: o.id, k: r.k, qb: r.qb, to: r.to, y: r.y, def: r.def });
    const callout = (r) => (r.k === "sack" ? r.def : (r.k === "pass" || r.k === "run") && r.y >= 20 ? `${r.to} · ${r.y} yds` : undefined);
    const push = (pl) => { pl.id = String(++pid); pl.homeScore = score[home.id]; pl.awayScore = score[away.id]; plays.push(pl); return pl; };

    function drive(o, p, mode, dPlays) {
      const d = other(o), startP = p;
      let down = 1, dist = Math.min(10, 100 - p), n = 0, result = "", next = null, end = p;
      const turnAt = mode === "int" || mode === "fum" ? 1 + rand(6) : 0;
      const kneelTeam = mode === "end" && score[o.id] > score[d.id];
      for (;;) {
        n++;
        // the decided ending on this play?
        if (mode === "half" && n > 2 + rand(3)) { result = "End of Half"; break; }
        if (mode === "end" && n > (kneelTeam ? 2 : 3 + rand(3))) { result = "End of Game"; break; }
        if (turnAt && n >= turnAt) {
          const isInt = mode === "int", y = isInt ? 8 + rand(16) : rand(5), at = Math.min(95, p + y), ret = rand(isInt ? 25 : 8);
          const tk = nm(d, isInt ? "cov" : "tak"), back = clamp(at - ret, 2, 98);
          const qb = isInt ? nm(o, "qb") : null, rb = isInt ? null : nm(o, "rb");
          const text = isInt ? `${qb} pass ${R() < 0.4 ? "deep" : "short"} ${PDIR[rand(3)]} INTERCEPTED by ${tk} at ${spot(absOf(o, at))}. ${tk} to ${spot(absOf(o, back))} for ${ret} yards (${nm(o, "rec")}).`
            : `${rb} ${DIRS[rand(7)]} to ${spot(absOf(o, at))} for ${y} yards (${tk}). FUMBLES (${tk}), RECOVERED by ${d.abbr}-${nm(d, "tak")} at ${spot(absOf(o, at))}. ${ret ? `${nm(d, "tak")} to ${spot(absOf(o, back))} for ${ret} yards.` : ""}`.trim();
          dPlays.push(push({ type: { id: isInt ? "26" : "29", text: isInt ? "Pass Interception Return" : "Fumble Recovery (Opponent)" }, text, statYardage: y,
            start: sit(o, down, dist, p), end: sit(d, 1, 10, 100 - back), t: 12, st: { side: o.id, k: isInt ? "int" : "fum", qb, to: rb, y: isInt ? 0 : y, def: tk }, callout: tk }));
          result = isInt ? "Interception" : "Fumble"; end = at; next = { side: d, p: 100 - back }; break;
        }
        if (mode === "end" && kneelTeam && p > 3) { // the winner runs out the clock
          const r = { k: "kneel", y: -1 };
          dPlays.push(push({ type: { id: TYPE.kneel[0], text: TYPE.kneel[1] }, text: playText(o, d, r, p, p - 1), statYardage: -1, start: sit(o, down, dist, p), end: sit(o, Math.min(4, down + 1), dist + 1, p - 1), t: 42 }));
          p -= 1; down = Math.min(4, down + 1); dist += 1; continue;
        }
        const inRange = p >= 62, scoreMode = mode === "td" || mode === "td-miss" || mode === "td-two";
        const kickMode = mode === "fg" || mode === "missfg";
        // field goal try: in range on 4th down (or a few plays into the red zone)
        if (kickMode && inRange && (down === 4 || (p >= 80 && R() < 0.3))) {
          const yds = 100 - p + 17, good = mode === "fg", k = nm(o, "k");
          dPlays.push(push({ type: { id: good ? "59" : "60", text: good ? "Field Goal Good" : "Field Goal Missed" }, scoringPlay: good,
            text: `${k} ${yds} yard field goal is ${good ? "GOOD" : `No Good, Wide ${R() < 0.5 ? "Left" : "Right"}`}, Holder-${nm(o, "p")}.`,
            statYardage: 0, start: sit(o, down, dist, p), end: sit(o, 0, 0, p), t: 5, st: { side: o.id, k: "fg", kick: k, good, y: yds }, callout: yds >= 50 ? `${k} · ${yds} yds` : undefined }));
          if (good) { score[o.id] += 3; dPlays.at(-1).homeScore = score[home.id]; dPlays.at(-1).awayScore = score[away.id]; }
          result = good ? "Field Goal" : "Missed FG"; end = p; next = good ? { kick: o } : { side: d, p: 100 - Math.max(p - 7, 20) }; break;
        }
        // punt on 4th down
        if (down === 4 && (mode === "punt" || (!scoreMode && !kickMode && mode !== "downs") || (kickMode && !inRange))) {
          const net = Math.min(clamp(Math.round(42 + normal() * 6 + 2 * o.z.st), 25, 60), 100 - p - 1), land = p + net, tb = land >= 100;
          const recv = tb ? 20 : 100 - land, ret = tb || R() < 0.45 ? 0 : rand(14), fin = clamp(recv + ret, 1, 99);
          dPlays.push(push({ type: { id: "52", text: "Punt" }, text: tb ? `${nm(o, "p")} punts ${100 - p} yards to end zone, Touchback.`
            : `${nm(o, "p")} punts ${net} yards to ${spot(absOf(o, land))}. ${ret ? `${nm(d, "ret")} to ${spot(absOf(d, fin))} for ${ret} yards (${nm(o, "tak")}).` : `${nm(d, "ret")}, fair catch by ${nm(d, "ret")}.`}`,
            statYardage: net, start: sit(o, down, dist, p), end: sit(d, 1, 10, fin), t: 8 }));
          result = "Punt"; end = p; next = { side: d, p: fin }; break;
        }
        // the snap: drives that must score keep going (no turnovers, no stalls); others stop short of scoring range
        const bad = (r) => {
          const np = p + r.y, conv = r.y >= dist && r.k !== "inc";
          return r.k === "int" || r.k === "fum" || np <= 0
            || (np >= 100 && !scoreMode)
            || (scoreMode && down >= 3 && !conv && np < 100) // a scoring drive converts its third downs
            || (kickMode && np > 93)
            || (kickMode && inRange && down === 3 && (conv || np < 62)) // in range: the third down fails (without losing the range) and the kicker comes on
            || (kickMode && !inRange && down >= 3 && !conv) // not yet in range: keep the drive alive
            || ((mode === "punt" || mode === "half" || mode === "end") && (np > 62 || (down === 3 && conv && r.redo)))
            || (mode === "downs" && (np > 75 || (down === 4 && conv) || (down === 3 && !conv && p < 45)));
        };
        let r = null;
        // (drives that end in a punt: half the third downs that would have been converted aren't, so three-and-outs happen)
        for (let tries = 0; tries < 12 && (!r || bad(r)); tries++) { r = snap(o, d, down, dist, p); r.redo = R() < 0.55; }
        // still nothing that fits (rare): a plain run that just moves the chains, or an incompletion
        if (bad(r)) r = { k: "run", y: Math.min(dist + rand(3), scoreMode ? 100 - p : 99 - p) };
        if (bad(r)) r = { k: "inc", y: 0, deep: false };
        if (scoreMode && n > 14 && p + r.y < 100) r = { k: R() < 0.5 ? "pass" : "run", y: 100 - p };
        const np = Math.min(100, p + r.y);
        if (np >= 100) { // touchdown
          const y = 100 - p, pass = r.k === "pass", qb = pass ? nm(o, "qb") : null, who = pass ? nm(o, "rec") : nm(o, "rb");
          const txt = pass ? `${qb} pass ${y > 15 ? "deep" : "short"} ${PDIR[rand(3)]} to ${who} for ${y} yds, TOUCHDOWN.` : `${who} ${DIRS[rand(7)]} for ${y} yds, TOUCHDOWN.`;
          score[o.id] += 6;
          let pat;
          if (mode === "td-two") { pat = ` TWO-POINT CONVERSION ATTEMPT. ${nm(o, "qb")} pass to ${nm(o, "rec")} is complete. ATTEMPT SUCCEEDS.`; score[o.id] += 2; }
          else if (mode === "td-miss") pat = ` ${nm(o, "k")} extra point is No Good, Wide ${R() < 0.5 ? "Left" : "Right"}, Holder-${nm(o, "p")}.`;
          else { pat = ` ${nm(o, "k")} extra point is GOOD, Holder-${nm(o, "p")}.`; score[o.id] += 1; }
          dPlays.push(push({ type: pass ? { id: "67", text: "Passing Touchdown" } : { id: "68", text: "Rushing Touchdown" }, scoringPlay: true, text: txt + pat,
            statYardage: y, start: sit(o, down, dist, p), end: { ...sit(o, 0, 0, 100), down: -1 }, t: 8,
            st: { side: o.id, k: pass ? "pass" : "run", qb, to: who, y, td: 1 }, callout: `${who} · ${y} yd${y === 1 ? "" : "s"}` }));
          result = "Touchdown"; end = 100; next = { kick: o }; break;
        }
        const conv = r.y >= dist && r.k !== "inc";
        const nd = conv ? 1 : down + 1, ndist = conv ? Math.min(10, 100 - np) : dist - (r.k === "inc" ? 0 : r.y);
        if (!conv && down === 4) { // turnover on downs
          dPlays.push(push({ type: { id: TYPE[r.k][0], text: TYPE[r.k][1] }, text: playText(o, d, r, p, np), statYardage: r.y, start: sit(o, down, dist, p), end: sit(d, 1, 10, 100 - np),
            t: r.k === "inc" ? 6 : 30, st: stat(o, r), callout: callout(r) }));
          result = "Downs"; end = np; next = { side: d, p: 100 - np }; break;
        }
        dPlays.push(push({ type: { id: TYPE[r.k][0], text: TYPE[r.k][1] }, text: playText(o, d, r, p, np), statYardage: r.y, start: sit(o, down, dist, p), end: sit(o, nd, Math.max(1, ndist), np),
          t: r.k === "inc" ? 6 : r.k === "sack" ? 34 : 28 + rand(14), st: stat(o, r), callout: callout(r) }));
        p = np; down = nd; dist = Math.max(1, ndist); end = p;
      }
      return { result, next, yards: end - startP };
    }

    // a kickoff, as the first play of the receiving team's drive
    function kickoff(k, dPlays) {
      const r = other(k), tb = R() < 0.6, land = tb ? 0 : rand(8) - 2, ret = tb ? 0 : 16 + rand(22) + Math.round(2 * r.z.st), fin = tb ? 25 : clamp(land + ret, 5, 60);
      dPlays.push(push({ type: { id: "53", text: "Kickoff" }, text: tb ? `${nm(k, "k")} kicks 65 yards from ${spot(absOf(k, 35))} to end zone, Touchback.`
        : `${nm(k, "k")} kicks ${65 + land} yards from ${spot(absOf(k, 35))} to ${spot(absOf(r, Math.max(1, land)))}. ${nm(r, "ret")} to ${spot(absOf(r, fin))} for ${ret} yards (${nm(k, "tak")}).`,
        statYardage: 0, start: { yardLine: absOf(k, 35), team: { id: k.id } }, end: sit(r, 1, 10, fin), t: 5 }));
      return fin;
    }

    // --- the game ---
    const drives = [];
    let next = null;
    for (let i = 0; i < N; i++) {
      const o = owner(i), dPlays = [];
      let p;
      if (i === 0 || i === n1) p = kickoff(other(o), dPlays); // each half starts with a kickoff
      else if (next?.kick) p = kickoff(next.kick, dPlays);
      else p = next?.p ?? 25;
      const first = dPlays.length ? dPlays[0] : null, startAbs = absOf(o, p);
      const res = drive(o, p, plan[i], dPlays);
      next = res.next;
      drives.push({ id: String(i + 1), team: { id: o.id }, plays: dPlays, start: { yardLine: startAbs }, end: { yardLine: dPlays.at(-1)?.end?.yardLine },
        displayResult: res.result, result: res.result, plan: plan[i], half: i < n1 ? 1 : 2, _first: first, _yds: res.yards });
    }

    // --- the clock: each half's plays share its 30 minutes, in proportion to how long each kind takes ---
    for (const h of [1, 2]) {
      const ps = drives.filter((d) => d.half === h).flatMap((d) => d.plays), tot = ps.reduce((s, p) => s + p.t, 0), f = 1800 / tot;
      let used = 0;
      for (const p of ps) {
        const t0 = (h - 1) * 1800 + used, q = Math.min(4, Math.floor(t0 / 900) + 1), left = q * 900 - t0;
        p.period = { number: q };
        p.clock = { displayValue: `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}` };
        p.wallclock = t0;
        used += p.t * f;
        p.dur = p.t * f;
      }
    }
    for (const d of drives) {
      const secs = d.plays.reduce((s, p) => s + (/kickoff/i.test(p.type.text) ? 0 : p.dur), 0), n = d.plays.filter((p) => !/kickoff/i.test(p.type.text)).length;
      d.description = `${n} play${n === 1 ? "" : "s"}, ${d._yds} yards, ${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`;
      delete d._first; delete d._yds;
      d.plays.forEach((p) => { delete p.t; });
    }
    // win chance after each play (for the highlights: the biggest swings), from the score, the time left and the edge
    const wp = [];
    for (const p of plays) {
      const left = Math.max(1, 3600 - p.wallclock - p.dur) / 3600, lead = p.homeScore - p.awayScore;
      wp.push({ playId: p.id, homeWinPercentage: phi((lead + edge * left) / (sd * Math.sqrt(left) + 0.5)) });
      delete p.wallclock; delete p.dur;
    }
    return { drives, winprobability: wp, final: { home: score[home.id], away: score[away.id] } };
  }

  return { build, events };
})();
