// 16-bit live field (Settings > Live field style): the same plays as the 8-bit field (live.js liveField), seen from
// behind the offense with 16-bit sprites. Original pixel art (branding/Concepts/16-bit field): 16x24 grids, colored
// per team at draw time and cached as images. Home teams wear their color, away teams white, like on TV.
// Off unless you pick it: localStorage "field-style" = "16bit".
const Field16 = (() => {
  const KEY = "field-style";
  const on = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null") === "16bit"; } catch { return false; } };
  // k outline  H helmet  h helmet shine  W helmet stripe  F facemask  s skin  J jersey  j jersey shade  P pants  p pants shade  S socks  B shoes
  const G = {
    back_stand: `......kkkk......|.....kHHWHk.....|....kHHHWHHk....|....kHhHWHHk....|....kkHHWHkk....|.....kssssk.....|..kkkJJJJJJkkk..|.kJJJJJJJJJJJJk.|.kJjJJJJJJJJjJk.|.kJjJJJJJJJJjJk.|.kskJJJJJJJJksk.|.kskJJJJJJJJksk.|.kk.kJJJJJJk.kk.|....kPPPPPPk....|....kPPPPPPk....|....kPPkkPPk....|....kPPk.kPPk...|....kPpk.kpPk...|....kSSk.kSSk...|....kSSk.kSSk...|....kSSk.kSSk...|...kBBBk.kBBBk..|...kkkk...kkkk..|................`,
    front_stand: `......kkkk......|.....kHHWHk.....|....kHHHWHHk....|....kHFFFFHk....|....kFsssFHk....|....kkFssFkk....|..kkkJJJJJJkkk..|.kJJJJJJJJJJJJk.|.kJjJJJJJJJJjJk.|.kJjJJJJJJJJjJk.|.kskJJJJJJJJksk.|.kskJJJJJJJJksk.|.kk.kJJJJJJk.kk.|....kPPPPPPk....|....kPPPPPPk....|....kPPkkPPk....|....kPPk.kPPk...|....kPpk.kpPk...|....kSSk.kSSk...|....kSSk.kSSk...|....kSSk.kSSk...|...kBBBk.kBBBk..|...kkkk...kkkk..|................`,
    line_back: `................|................|................|................|................|................|................|......kkkk......|.....kHHWHk.....|....kHHHWHHk....|..kkkkHHWHkkkk..|.kJJJJJJJJJJJJk.|kJjJJJJJJJJJJjJk|kJjJJJJJJJJJJjJk|kskJJJJJJJJJJksk|kskkJJJJJJJJkksk|kss.kPPPPPPk.ssk|.kk.kPPPPPPk.kk.|...kPPPkkPPPk...|..kPPPk..kPPPk..|..kSSk....kSSk..|..kSSk....kSSk..|.kBBBk....kBBBk.|.kkkk......kkkk.`,
    line_front: `................|................|................|................|................|................|................|......kkkk......|.....kHHWHk.....|....kHFFFFHk....|..kkkFsssFHkkk..|.kJJJkFssFkJJJk.|kJjJJJJJJJJJJjJk|kJjJJJJJJJJJJjJk|kskJJJJJJJJJJksk|kskkJJJJJJJJkksk|kss.kPPPPPPk.ssk|.kk.kPPPPPPk.kk.|...kPPPkkPPPk...|..kPPPk..kPPPk..|..kSSk....kSSk..|..kSSk....kSSk..|.kBBBk....kBBBk.|.kkkk......kkkk.`,
    celebrate: `.ksk........ksk.|.ksk........ksk.|.kJk.kkkk...kJk.|.kJkkHHWHk..kJk.|.kJkHHHWHHk.kJk.|..kkHhHWHHkkk...|....kkHHWHkk....|.....kssssk.....|..kkkJJJJJJkkk..|.kJJJJJJJJJJJJk.|.kJjJJJJJJJJjJk.|.kJjJJJJJJJJjJk.|..kJJJJJJJJJJk..|...kJJJJJJJJk...|....kPPPPPPk....|....kPPPPPPk....|....kPPkkPPk....|....kPPk.kPPk...|....kSSk.kSSk...|....kSSk.kSSk...|....kSSk.kSSk...|...kBBBk.kBBBk..|...kkkk...kkkk..|................`,
  };
  const DIG = { 0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001",
    5: "111100111001111", 6: "111100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001111" };
  const SKIN = ["#c6865e", "#8d5536", "#e0ac87", "#5c3a26"];
  const hex = (h) => { h = (h || "#888888").replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };
  const mix = (rgb, f) => rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * f))));
  const light = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 200;
  // the uniform: home = jersey in the team color; away = white jersey with team-color numbers
  function kit(home, color, alt) {
    const c = hex(color), a = hex(alt), white = [242, 242, 242];
    const stripe = light(a) && light(c) ? [20, 20, 20] : a;
    return home ? { H: c, W: stripe, J: c, N: light(c) ? [20, 20, 20] : [255, 255, 255], P: light(a) ? [222, 222, 222] : a, S: c }
      : { H: c, W: stripe, J: white, N: light(c) ? [20, 20, 20] : c, P: white, S: c };
  }
  const cache = new Map();
  function sprite(pose, k, num, skinIx = 0) {
    const key = [pose, k.H, k.J, k.N, k.P, k.W, num ?? "", skinIx].join("|");
    if (cache.has(key)) return cache.get(key);
    const rows = G[pose].split("|"), cv = document.createElement("canvas");
    cv.width = 16; cv.height = 24;
    const x = cv.getContext("2d"), img = x.createImageData(16, 24);
    const pal = { k: [16, 16, 20], H: k.H, h: mix(k.H, 1.35), W: k.W, F: [170, 170, 178], s: hex(SKIN[skinIx % 4]), J: k.J, j: mix(k.J, 0.78),
      P: k.P, p: mix(k.P, 0.78), S: k.S, B: [24, 24, 24] };
    rows.forEach((r, yy) => [...r].forEach((ch, xx) => {
      const c = pal[ch];
      if (!c) return;
      const i = (yy * 16 + xx) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }));
    // jersey number on the back (or chest), 3x5 digits
    const n = num != null && num !== "" && !pose.startsWith("line") ? String(num).slice(0, 2) : "";
    const top = pose === "celebrate" ? 10 : 8, x0 = 8 - Math.floor((n.length * 4 - 1) / 2);
    [...n].forEach((d, di) => [...(DIG[d] || "")].forEach((bit, bi) => {
      if (bit !== "1") return;
      const i = ((top + Math.floor(bi / 3)) * 16 + x0 + di * 4 + (bi % 3)) * 4;
      img.data[i] = k.N[0]; img.data[i + 1] = k.N[1]; img.data[i + 2] = k.N[2]; img.data[i + 3] = 255;
    }));
    x.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    cache.set(key, url);
    return url;
  }

  // Settings > Appearance > Live field style (live.js reads on() each time it draws)
  function section() {
    const cur = on() ? "16bit" : "8bit";
    return `<h3>Live field style</h3><p class="note">How plays look on the live field during games.</p>
      <div class="seg" id="set-field" role="group" aria-label="Live field style">${[["8bit", "8-bit (classic)"], ["16bit", "16-bit (behind the offense)"]].map(([k, l]) =>
        `<button type="button" data-f="${k}" class="${k === cur ? "active" : ""}">${l}</button>`).join("")}</div>`;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("#set-field [data-f]");
    if (!b) return;
    try { localStorage.setItem(KEY, JSON.stringify(b.dataset.f)); } catch {}
    document.querySelectorAll("#set-field [data-f]").forEach((x) => x.classList.toggle("active", x === b));
  });

  return { on, kit, sprite, section };
})();
