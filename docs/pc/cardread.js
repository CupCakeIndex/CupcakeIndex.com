// The Vault's card reader: reads the printed text off the card photos (free, runs on the phone with Tesseract)
// and turns it into the form fields: player, team, year, set, card #, serial, rookie, auto, grade.
// Players are confirmed against the site's all-time NFL list (and ESPN search for college players), sets against
// a built-in list of football sets. Backs read best (copyright line, card #, name, team are all printed there).
window.CardRead = (function () {
  const TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let workerP = null;
  const worker = () => (workerP ||= new Promise((ok, no) => {
    const s = document.createElement("script"); s.src = TESS; s.onload = ok; s.onerror = () => no(new Error("reader didn't load")); document.head.appendChild(s);
  }).then(() => Tesseract.createWorker("eng")).catch((e) => { workerP = null; throw e; }));
  let playersP = null;
  const players = () => (playersP ||= fetch("../data/players_nfl.json").then((r) => r.json()).catch(() => { playersP = null; return []; }));

  // normalized text: capitals and single spaces only ("C.J. Stroud" -> "CJ STROUD")
  const norm = (s) => " " + (s || "").toUpperCase().replace(/[.'’`]/g, "").replace(/[^A-Z0-9&]+/g, " ").trim() + " ";

  // image (data URL) -> canvas, upscaled a bit and turned `deg` clockwise
  async function canvasOf(src, deg, invert) {
    const img = await createImageBitmap(await (await fetch(src)).blob());
    const k = 1.5, w = img.width * k, h = img.height * k, side = deg % 180 !== 0;
    const cv = document.createElement("canvas"); cv.width = side ? h : w; cv.height = side ? w : h;
    const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
    g.translate(cv.width / 2, cv.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(img, -w / 2, -h / 2, w, h);
    // second look: make all text dark-on-white, including white text on a dark name bar (the reader only sees
    // dark text). Each pixel becomes how far it is from its neighborhood's average brightness.
    if (invert) {
      const W = cv.width, H = cv.height, id = g.getImageData(0, 0, W, H), px = id.data, n = W * H, gray = new Float32Array(n), sum = new Float64Array((W + 1) * (H + 1));
      for (let i = 0; i < n; i++) gray[i] = 0.3 * px[i * 4] + 0.59 * px[i * 4 + 1] + 0.11 * px[i * 4 + 2];
      for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]; sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row; } }
      const r = Math.max(8, Math.round(W / 45));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
        const mean = (sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
        const dd = Math.abs(gray[y * W + x] - mean), i = (y * W + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = dd < 14 ? 255 : Math.max(0, 255 - (dd - 14) * 4);
      }
      g.setTransform(1, 0, 0, 1, 0, 0); g.putImageData(id, 0, 0);
    }
    return cv;
  }
  // how much real text came out: confident words of 3+ letters
  const yieldOf = (d) => (d.words || []).filter((w) => w.confidence > 70 && /^[A-Za-z]{3,}/.test(w.text)).length;
  async function ocr(src, tryTurns, invert, onlyDeg) {
    const wk = await worker();
    let best = null;
    for (const deg of onlyDeg != null ? [onlyDeg] : tryTurns ? [0, 90, 270] : [0]) {
      const d = (await wk.recognize(await canvasOf(src, deg, invert))).data, y = yieldOf(d);
      if (!best || y > best.y) best = { deg, y, text: d.text || "", lines: (d.lines || []).map((l) => ({ text: l.text, h: l.bbox.y1 - l.bbox.y0 })) };
      if (deg === 0 && y >= 14) break; // reads fine upright, no need to turn it
    }
    return best;
  }

  // football sets: [what to look for, what to fill in]. Common words (Select, One, Black...) only count right after "Panini".
  const SETS = [
    ["NATIONAL TREASURES", "Panini National Treasures"], ["FLAWLESS", "Panini Flawless"], ["IMMACULATE", "Panini Immaculate"], ["IMPECCABLE", "Panini Impeccable"],
    ["CONTENDERS OPTIC", "Panini Contenders Optic"], ["CONTENDERS", "Panini Contenders"], ["DONRUSS OPTIC", "Donruss Optic"], ["OPTIC", "Donruss Optic"],
    ["DONRUSS ELITE", "Donruss Elite"], ["CLEARLY DONRUSS", "Clearly Donruss"], ["DONRUSS", "Donruss"], ["PRIZM DRAFT PICKS", "Panini Prizm Draft Picks"], ["PRIZM", "Panini Prizm"],
    ["MOSAIC", "Panini Mosaic"], ["SPECTRA", "Panini Spectra"], ["OBSIDIAN", "Panini Obsidian"], ["PHOENIX", "Panini Phoenix"], ["PRESTIGE", "Panini Prestige"],
    ["CHRONICLES", "Panini Chronicles"], ["ILLUSIONS", "Panini Illusions"], ["LUMINANCE", "Panini Luminance"], ["ZENITH", "Panini Zenith"], ["PLAYBOOK", "Panini Playbook"],
    ["ROOKIES & STARS", "Panini Rookies & Stars"], ["ROOKIES AND STARS", "Panini Rookies & Stars"], ["PLATES & PATCHES", "Panini Plates & Patches"], ["GOLD STANDARD", "Panini Gold Standard"],
    ["UNPARALLELED", "Panini Unparalleled"], ["ENCASED", "Panini Encased"], ["CERTIFIED", "Panini Certified"], ["ABSOLUTE", "Panini Absolute"], ["REVOLUTION", "Panini Revolution"],
    ["PANINI SELECT", "Panini Select"], ["PANINI ONE", "Panini One"], ["PANINI BLACK", "Panini Black"], ["PANINI ORIGINS", "Panini Origins"], ["PANINI LEGACY", "Panini Legacy"],
    ["PANINI INSTANT", "Panini Instant"], ["PANINI CLASSICS", "Panini Classics"], ["PANINI XR", "Panini XR"], ["PANINI LIMITED", "Panini Limited"], ["PANINI SCORE", "Score"], ["SCORE FOOTBALL", "Score"],
    ["BOWMAN UNIVERSITY CHROME", "Bowman University Chrome"], ["BOWMAN UNIVERSITY", "Bowman University"], ["BOWMAN CHROME", "Bowman Chrome"], ["BOWMAN", "Bowman"],
    ["TOPPS CHROME", "Topps Chrome"], ["TOPPS FINEST", "Topps Finest"], ["FINEST", "Topps Finest"], ["STADIUM CLUB", "Topps Stadium Club"], ["TOPPS COMPOSITE", "Topps Composite"],
    ["TOPPS HERITAGE", "Topps Heritage"], ["TOPPS", "Topps"], ["SP AUTHENTIC", "SP Authentic"], ["UPPER DECK", "Upper Deck"], ["LEAF", "Leaf"], ["SAGE", "Sage"],
    ["FLEER", "Fleer"], ["PACIFIC", "Pacific"], ["PRO SET", "Pro Set"], ["PRESS PASS", "Press Pass"], ["PLAYOFF", "Playoff"], ["PANINI", "Panini"],
  ];
  const NOT_NAMES = /\b(PANINI|TOPPS|BOWMAN|DONRUSS|PRIZM|OPTIC|MOSAIC|SELECT|ROOKIE|QUARTERBACK|RECEIVER|RUNNING|BACK|LINEBACKER|TACKLE|END|SAFETY|CORNERBACK|KICKER|PUNTER|GUARD|CENTER|FOOTBALL|COLLEGE|NFL|AMERICA|CARD|INC|LLC|COMPANY|DRAFT|PICKS|CHROME|STATS|TEAM|HEIGHT|WEIGHT|BORN|HOMETOWN)\b/;

  // edits needed to turn a into b (stops early past `max`)
  function edits(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let low = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); low = Math.min(low, cur[j]); }
      if (low > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  async function findPlayer(all, lines, year) {
    const off = (p) => (year && p[3] && (year < p[3] - 1 || year > (p[4] || 2100) + 1) ? 1.5 : 0); // not playing the year on the card
    const list = await players();
    // 1) a full player name printed anywhere on the card (more times printed = more likely the card's player)
    let best = null;
    for (const p of list) {
      const n = norm(p[0]); if (n.length < 8) continue;
      let i = all.indexOf(n), hits = 0; while (i >= 0) { hits++; i = all.indexOf(n, i + 1); }
      if (hits && (!best || hits > best.hits || (hits === best.hits && (p[4] || 0) > (best.p[4] || 0)))) best = { p, hits };
    }
    if (best) return { name: best.p[0], from: best.p[3] };
    // 2) 2-3 word runs from the biggest lines (numbers and junk dropped), allowing an OCR slip of a letter or two
    const cands = [];
    for (const l of lines.slice().sort((a, b) => b.h - a.h).slice(0, 12)) {
      const words = norm(l.text).trim().split(" ").filter((x) => /^[A-Z]{2,}$/.test(x));
      for (let i = 0; i < words.length; i++) for (const k of [2, 3]) {
        const c = words.slice(i, i + k).join(" ");
        if (i + k <= words.length && c.length >= 6 && c.length <= 26 && !NOT_NAMES.test(c) && !cands.includes(c)) cands.push(c);
      }
    }
    let hit = null, hd = 9;
    for (const c of cands.slice(0, 30)) {
      const max = c.length >= 10 ? 2 : 1;
      for (const p of list) { const n = norm(p[0]).trim(); if (Math.abs(n.length - c.length) > max || n[0] !== c[0]) continue; const d = edits(c, n, max); if (d <= max && d + off(p) < hd) { hd = d + off(p); hit = p; } }
    }
    if (hit) return { name: hit[0], from: hit[3] };
    // 3) college players: ask ESPN
    for (const c of cands.slice(0, 2)) {
      try {
        const d = await (await fetch(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(c)}&limit=5&type=player`)).json();
        const it = (d.items || []).find((x) => (x.league === "college-football" || x.league === "nfl") && edits(c, norm(x.displayName).trim(), 2) <= 2);
        if (it) return { name: it.displayName };
      } catch (e) { /* offline: skip */ }
    }
    return null;
  }

  // Read the card. photos = { front: dataURL, back: dataURL }, teams = the site's team list, backTurned = back was already turned by hand.
  // Returns { fields: {...}, backDeg: 0 | 90 | 270 (which way the back's text runs), found: [...field names] }.
  async function read(photos, teams, backTurned) {
    const F = photos.front ? await ocr(photos.front, false) : null, B = photos.back ? await ocr(photos.back, !backTurned) : null;
    let all = norm(F?.text) + norm(B?.text), raw = (F?.text || "") + "\n" + (B?.text || "");
    const lines = [...(F?.lines || []), ...(B?.lines || [])];
    const out = {}, nowY = new Date().getFullYear() + 1;
    // year: the copyright line, else the newest year printed
    const cy = raw.match(/(?:©|\(c\)|@|copyright)\s*((?:19|20)\d{2})/i);
    if (cy) out.year = +cy[1];
    else { const ys = (raw.match(/\b(19[5-9]\d|20\d{2})\b/g) || []).map(Number).filter((y) => y <= nowY); if (ys.length) out.year = Math.max(...ys); }
    // set
    for (const [k, name] of SETS) if (all.includes(" " + k + " ")) { out.set = name; break; }
    // card number: "#339", "No. 339", "NO. RS-12"
    const num = raw.match(/(?:#|\bNo\.?)\s?([A-Z]{0,4}-?\d{1,4})\b/);
    if (num) out.number = "#" + num[1];
    // serial numbered: "12/99" (the front usually has it)
    for (const t of [F?.text || "", B?.text || ""]) {
      const m = [...t.matchAll(/\b(\d{1,4})\s?\/\s?(\d{1,4})\b/g)].find((x) => +x[1] >= 1 && +x[1] <= +x[2] && +x[2] <= 2500 && !(+x[2] >= 1950));
      if (m) { out.serial = "/" + m[2]; break; }
    }
    const grade = raw.match(/\b(PSA|BGS|SGC|CGC|CSG|HGA)\b[^0-9\n]{0,12}(10|[1-9](?:\.5)?)\b/i);
    // slab labels say the grade in words ("GEM MT 10", "MINT 9"); the company is often just a logo, so look for its name anywhere
    // (labels are two columns, so the number is often on the next line: "GEM MT" / "OPTIC PREVIEW 10")
    let label = null;
    if (!grade) {
      const ls = raw.split("\n"), WORDS = /\b(GEM\s*M(?:IN)?T|MINT|NM-?MT|EX-?MT|PRISTINE)\b/i;
      for (let i = 0; i < ls.length && !label; i++) {
        if (!WORDS.test(ls[i])) continue;
        const same = ls[i].match(/\b(?:GEM\s*M(?:IN)?T|MINT|NM-?MT|EX-?MT|PRISTINE)\s*\+?\s*(10|[1-9](?:\.5)?)\b/i);
        const next = (ls[i + 1] || "").match(/[A-Za-z][^\n]*?\s(10|[1-9](?:\.5)?)\b/);
        label = same || next;
      }
    }
    if (label) {
      const co = /\bPSA\b/i.test(raw) ? "PSA" : /\b(BGS|BECKETT)\b/i.test(raw) ? "BGS" : /\bSGC\b/i.test(raw) ? "SGC" : /\bCGC\b/i.test(raw) ? "CGC" : "PSA"; // PSA's label is the one that reads "GEM MT"
      out.grade = co + " " + label[1];
      const cert = (F?.text || raw).match(/\b(\d{8,10})\b/);
      if (cert) out.cert = cert[1];
    }
    if (grade) {
      out.grade = grade[1].toUpperCase() + " " + grade[2];
      const cert = (F?.text || raw).match(/\b(\d{8,10})\b/); // the slab label's cert number (PSA: 8-9 digits)
      if (cert) out.cert = cert[1];
    }
    if (/AUTOGRAPH|SIGNATURES?\b|\bAUTO\b/.test(all)) out.auto = true;
    // team: a full team name, or an NFL nickname ("TEXANS")
    let p = await findPlayer(all, lines, out.year);
    if (!p) { // second look with light and dark flipped (names are often white on a dark bar)
      const F2 = photos.front ? await ocr(photos.front, false, true, 0) : null, B2 = photos.back ? await ocr(photos.back, false, true, B?.deg || 0) : null;
      all += norm(F2?.text) + norm(B2?.text);
      p = await findPlayer(all, [...(F2?.lines || []), ...(B2?.lines || []), ...lines], out.year);
    }
    // team: an NFL team's full name, then its nickname ("TEXANS"), then a college's full name (longest first: "Ohio State" before "Ohio")
    const nfl = teams.filter((x) => x.abbr), cfb = teams.filter((x) => !x.abbr).sort((a, b) => b.name.length - a.name.length);
    const t = nfl.find((x) => all.includes(norm(x.name))) || nfl.find((x) => x.mascot && all.includes(norm(x.mascot))) || cfb.find((x) => all.includes(norm(x.name)));
    if (t) out.team = t.name;
    if (p) out.player = p.name;
    if (/\bRC\b|\bROOKIE\b/.test(all) || (p?.from && out.year && out.year === p.from)) out.rookie = true;
    return { fields: out, backDeg: B?.deg || 0, found: Object.keys(out), text: raw };
  }
  // load the reader ahead of time (it's a few MB the first time, then cached)
  const warm = () => worker().catch(() => {});
  return { read, warm };
})();
