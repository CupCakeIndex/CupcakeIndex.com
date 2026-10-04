// The Vault's card photo cleanup: find the card in a photo (even when it's tilted or shot at an angle),
// then warp it flat to an exact 2.5 x 3.5 card. No libraries; everything runs on the phone.
//
// How it finds the card:
//  1. Shrink the photo and mark its "walls": strong edges whose color is unlike the background.
//  2. Flood in from the photo's border through everything that isn't a wall. That's the background
//     (soft shadows and table texture included). What the flood can't reach is the card.
//  3. Wrap the card in its outline, pick the 4 corners that cover it best, then straighten each side
//     by fitting a line along the card's real edge (so rounded corners come out square).
window.CardCrop = (function () {
  const CARD_W = 700, CARD_H = 980; // saved size: a 2.5 x 3.5 card
  const SLAB_W = 700, SLAB_H = 1130; // a graded slab (PSA's is about 3.3 x 5.35 in): taller than a card

  async function bitmapOf(src) {
    let blob = src;
    if (!(src instanceof Blob)) { const r = await fetch(src); if (!r.ok) throw new Error("image " + r.status); blob = await r.blob(); }
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) { return createImageBitmap(blob); }
  }

  const area = (q) => Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % q.length]; return s + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pct = (arr, p) => { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0; };

  // Returns the card's 4 corners in photo pixels (top-left, top-right, bottom-right, bottom-left), or null.
  function findQuad(bmp) {
    const s = Math.min(1, 400 / Math.max(bmp.width, bmp.height)), w = Math.max(8, Math.round(bmp.width * s)), h = Math.max(8, Math.round(bmp.height * s)), n = w * h;
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    // light blur (3x3) to calm photo noise
    const ch = [0, 1, 2].map((k) => {
      const a = new Float32Array(n), b = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = px[i * 4 + k];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; b[i] = (a[x > 0 ? i - 1 : i] + a[i] + a[x < w - 1 ? i + 1 : i]) / 3; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; a[i] = (b[y > 0 ? i - w : i] + b[i] + b[y < h - 1 ? i + w : i]) / 3; }
      return a;
    });
    // edge strength (Sobel, strongest color channel)
    const grad = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; let m = 0;
      for (const c of ch) {
        const gx = c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - 1] - c[i + w - 1];
        const gy = c[i + w - 1] + 2 * c[i + w] + c[i + w + 1] - c[i - w - 1] - 2 * c[i - w] - c[i - w + 1];
        m = Math.max(m, Math.abs(gx) + Math.abs(gy));
      }
      grad[i] = m;
    }
    // background = what's around the photo's border
    const ring = [];
    for (let x = 2; x < w - 2; x += 2) ring.push(2 * w + x, (h - 3) * w + x);
    for (let y = 2; y < h - 2; y += 2) ring.push(y * w + 2, y * w + w - 3);
    const med = ch.map((c) => pct(ring.map((i) => c[i]), 0.5));
    const cd = (i) => Math.abs(ch[0][i] - med[0]) + Math.abs(ch[1][i] - med[1]) + Math.abs(ch[2][i] - med[2]);
    const gT = Math.min(220, Math.max(50, pct(ring.map((i) => grad[i]), 0.9) * 1.6));
    const cT = Math.min(90, Math.max(28, pct(ring.map(cd), 0.9) * 1.3 + 12));
    // walls: strong edges, thickened by a pixel so small gaps don't leak; background-colored pixels never block
    const edge = new Uint8Array(n);
    for (let i = 0; i < n; i++) edge[i] = grad[i] >= gT ? 1 : 0;
    const pass = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let wall = 0;
      for (let dy = -1; dy <= 1 && !wall; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && edge[yy * w + xx]) { wall = 1; break; } }
      pass[i] = !wall || cd(i) < cT ? 1 : 0;
    }
    // flood the background in from the border
    const bg = new Uint8Array(n), qu = new Int32Array(n); let qh = 0, qt = 0;
    const seed = (i) => { if (pass[i] && !bg[i]) { bg[i] = 1; qu[qt++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (qh < qt) {
      const i = qu[qh++], x = i % w;
      if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (i >= w) seed(i - w); if (i < n - w) seed(i + w);
    }
    // the card = the biggest piece left (shaved by a pixel first so thin threads of texture don't hang on)
    const fg = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; fg[i] = !bg[i] && !bg[i - 1] && !bg[i + 1] && !bg[i - w] && !bg[i + w] ? 1 : 0; }
    const lab = new Int32Array(n); let best = 0, bestN = 0, id = 0;
    for (let i = 0; i < n; i++) {
      if (!fg[i] || lab[i]) continue;
      id++; let cnt = 0; qh = qt = 0; qu[qt++] = i; lab[i] = id;
      while (qh < qt) {
        const j = qu[qh++], x = j % w; cnt++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, k = j + dy * w + dx;
          if (xx < 0 || xx >= w || k < 0 || k >= n || !fg[k] || lab[k]) continue;
          lab[k] = id; qu[qt++] = k;
        }
      }
      if (cnt > bestN) { bestN = cnt; best = id; }
    }
    if (bestN < n * 0.04 || bestN > n * 0.97) return null;
    // outline points (grown back by the shaved pixel): each row's left/right ends, each column's top/bottom ends
    const pts = [], L = new Int32Array(h).fill(-1), Rr = new Int32Array(h).fill(-1), T = new Int32Array(w).fill(-1), Bt = new Int32Array(w).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lab[y * w + x] !== best) continue;
      if (L[y] < 0) L[y] = x; Rr[y] = x; if (T[x] < 0) T[x] = y; Bt[x] = y;
    }
    for (let y = 0; y < h; y++) if (L[y] >= 0) pts.push([L[y] - 1, y + 0.5], [Rr[y] + 2, y + 0.5]);
    for (let x = 0; x < w; x++) if (T[x] >= 0) pts.push([x + 0.5, T[x] - 1], [x + 0.5, Bt[x] + 2]);
    const hull = convexHull(pts);
    if (hull.length < 4) return null;
    const hullA = area(hull);
    let q = maxQuad(decimate(hull, 64));
    if (!q) return null;
    const qA = area(q);
    q = refine(q, pts, grad, w, h);
    // sanity checks: card-shaped, not a sliver, not just the whole photo
    const a = (len(q[0], q[1]) + len(q[2], q[3])) / 2, b = (len(q[1], q[2]) + len(q[3], q[0])) / 2, r = Math.max(a, b) / Math.min(a, b);
    const angOk = q.every((p, i) => { const u = q[(i + 3) % 4], v = q[(i + 1) % 4]; const c = ((u[0] - p[0]) * (v[0] - p[0]) + (u[1] - p[1]) * (v[1] - p[1])) / (len(u, p) * len(v, p)); return Math.abs(c) < 0.62; });
    if (qA < hullA * 0.88 || r < 1.12 || r > 2 || !angOk || area(q) > n * 0.985) return null;
    return upright(q.map(([x, y]) => [x / s, y / s]));
  }

  function convexHull(p) {
    p = p.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const v of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], v) <= 0) lo.pop(); lo.push(v); }
    for (let i = p.length - 1; i >= 0; i--) { const v = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], v) <= 0) up.pop(); up.push(v); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // thin the outline to about m evenly spaced points, keeping the sharpest turns
  function decimate(hull, m) {
    if (hull.length <= m) return hull;
    const per = hull.reduce((s, p, i) => s + len(p, hull[(i + 1) % hull.length]), 0), step = per / m, out = [hull[0]];
    let acc = 0;
    for (let i = 1; i < hull.length; i++) { acc += len(hull[i - 1], hull[i]); if (acc >= step) { out.push(hull[i]); acc = 0; } }
    return out;
  }
  // the 4 outline points that enclose the most area
  function maxQuad(P) {
    const m = P.length; let best = -1, q = null;
    const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    for (let i = 0; i < m; i++) for (let k = i + 2; k < m; k++) {
      let b1 = -1, j1 = -1, b2 = -1, l2 = -1;
      for (let j = i + 1; j < k; j++) { const t = tri(P[i], P[j], P[k]); if (t > b1) { b1 = t; j1 = j; } }
      for (let l = k + 1; l < m + i; l++) { const t = tri(P[i], P[k], P[l % m]); if (t > b2) { b2 = t; l2 = l % m; } }
      if (j1 >= 0 && l2 >= 0 && b1 + b2 > best) { best = b1 + b2; q = [P[i], P[j1], P[k], P[l2]]; }
    }
    return q;
  }
  // fit a straight line along each real card edge, slide it onto the sharpest edge nearby (the outline sits a
  // couple of pixels outside the card), and use where the lines cross as the corners
  function refine(q, pts, grad, w, h) {
    const mx = q.reduce((s, p) => s + p[0], 0) / 4, my = q.reduce((s, p) => s + p[1], 0) / 4;
    const lines = q.map((A, i) => {
      const B = q[(i + 1) % 4], L = len(A, B), d = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], tol = Math.max(1.5, L * 0.03);
      const sel = pts.filter((p) => { const vx = p[0] - A[0], vy = p[1] - A[1], t = (vx * d[0] + vy * d[1]) / L; return t > 0.12 && t < 0.88 && Math.abs(vx * d[1] - vy * d[0]) < tol; });
      if (sel.length < 8) return { c: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], d };
      const cx = sel.reduce((s, p) => s + p[0], 0) / sel.length, cy = sel.reduce((s, p) => s + p[1], 0) / sel.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of sel) { const x = p[0] - cx, y = p[1] - cy; sxx += x * x; sxy += x * y; syy += y * y; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { c: [cx, cy], d: [Math.cos(th), Math.sin(th)] };
    }).map((ln, i) => {
      const A = q[i], B = q[(i + 1) % 4], L = len(A, B);
      let nx = -ln.d[1], ny = ln.d[0];
      if (nx * (mx - ln.c[0]) + ny * (my - ln.c[1]) < 0) { nx = -nx; ny = -ny; } // point inward
      const t0 = ((A[0] - ln.c[0]) * ln.d[0] + (A[1] - ln.c[1]) * ln.d[1]), t1 = ((B[0] - ln.c[0]) * ln.d[0] + (B[1] - ln.c[1]) * ln.d[1]);
      const score = (off) => {
        let sum = 0, k = 0;
        for (let f = 0.15; f <= 0.85; f += 0.02) {
          const t = t0 + (t1 - t0) * f, x = Math.floor(ln.c[0] + ln.d[0] * t + nx * off), y = Math.floor(ln.c[1] + ln.d[1] * t + ny * off);
          if (x > 0 && y > 0 && x < w - 1 && y < h - 1) { sum += grad[y * w + x]; k++; }
        }
        return k ? sum / k : 0;
      };
      const s = []; for (let o = -2; o <= 6; o++) s.push(score(o));
      let bi = 0; s.forEach((v, j) => { if (v > s[bi]) bi = j; });
      let off = bi - 2;
      if (bi > 0 && bi < s.length - 1) { const den = s[bi - 1] - 2 * s[bi] + s[bi + 1]; if (den < 0) off += 0.5 * (s[bi - 1] - s[bi + 1]) / den; }
      if (L < 20) off = 0;
      return { c: [ln.c[0] + nx * off, ln.c[1] + ny * off], d: ln.d };
    });
    const minSide = Math.min(...q.map((p, i) => len(p, q[(i + 1) % 4])));
    return q.map((p, i) => {
      const a = lines[(i + 3) % 4], b = lines[i], den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
      if (Math.abs(den) < 0.2) return p;
      const t = ((b.c[0] - a.c[0]) * b.d[1] - (b.c[1] - a.c[1]) * b.d[0]) / den, x = [a.c[0] + a.d[0] * t, a.c[1] + a.d[1] * t];
      return len(x, p) < minSide * 0.08 ? x : p;
    });
  }
  // order the corners so the card comes out standing up with the least turning
  function upright(q) {
    let sum = 0; for (let i = 0; i < 4; i++) { const p = q[i], nx = q[(i + 1) % 4]; sum += p[0] * nx[1] - nx[0] * p[1]; }
    if (sum < 0) q = [q[0], q[3], q[2], q[1]]; // clockwise on screen
    let best = null, bs = -Infinity;
    for (let k = 0; k < 4; k++) {
      const c = [0, 1, 2, 3].map((i) => q[(i + k) % 4]);
      const top = (len(c[0], c[1]) + len(c[2], c[3])) / 2, side = (len(c[1], c[2]) + len(c[3], c[0])) / 2;
      const ang = Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]);
      const score = (top <= side ? 10 : 0) + Math.cos(ang);
      if (score > bs) { bs = score; best = c; }
    }
    return best;
  }

  // Warp the 4 corners flat to a card. turns = how many half-turns to spin it (the Rotate button).
  function warp(bmp, q, turns, slab) {
    const CW = slab ? SLAB_W : CARD_W, CH = slab ? SLAB_H : CARD_H;
    if (turns % 2) q = [q[2], q[3], q[0], q[1]];
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    q = q.map(([x, y]) => [x + (cx - x) * 0.006, y + (cy - y) * 0.006]); // a hair inside so no table shows at the edges
    const S = Math.min(1, 1800 / Math.max(bmp.width, bmp.height)), sw = Math.round(bmp.width * S), sh = Math.round(bmp.height * S);
    const sc = document.createElement("canvas"); sc.width = sw; sc.height = sh;
    const sg = sc.getContext("2d", { willReadFrequently: true }); sg.drawImage(bmp, 0, 0, sw, sh);
    const src = sg.getImageData(0, 0, sw, sh).data;
    const H = homography([[0, 0], [CW, 0], [CW, CH], [0, CH]], q.map(([x, y]) => [x * S, y * S]));
    const out = document.createElement("canvas"); out.width = CW; out.height = CH;
    const og = out.getContext("2d"), img = og.createImageData(CW, CH), o = img.data;
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const X = x + 0.5, Y = y + 0.5, z = H[6] * X + H[7] * Y + H[8], u = (H[0] * X + H[1] * Y + H[2]) / z - 0.5, v = (H[3] * X + H[4] * Y + H[5]) / z - 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(u))), y0 = Math.max(0, Math.min(sh - 2, Math.floor(v))), fx = Math.min(1, Math.max(0, u - x0)), fy = Math.min(1, Math.max(0, v - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, k = (y * CW + x) * 4;
      for (let c = 0; c < 3; c++) o[k + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy) + (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
      o[k + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    return jpeg(out);
  }
  // solve the 3x3 perspective map that sends the output rectangle onto the 4 corners
  function homography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (let i = 0; i < 8; i++) { // Gaussian elimination with pivoting
      let p = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
      for (let r = 0; r < 8; r++) { if (r === i) continue; const f = A[r][i] / A[i][i]; for (let k = i; k < 8; k++) A[r][k] -= f * A[i][k]; B[r] -= f * B[i]; }
    }
    return B.map((v, i) => v / A[i][i]).concat(1);
  }
  // the whole photo, fit inside a card without stretching
  function whole(bmp, turns, slab) {
    const CW = slab ? SLAB_W : CARD_W, CH = slab ? SLAB_H : CARD_H;
    const cv = document.createElement("canvas"); cv.width = CW; cv.height = CH;
    const g = cv.getContext("2d"); g.fillStyle = "#111"; g.fillRect(0, 0, CW, CH);
    if (turns % 2) { g.translate(CW, CH); g.rotate(Math.PI); }
    const k = Math.min(CW / bmp.width, CH / bmp.height);
    g.drawImage(bmp, (CW - bmp.width * k) / 2, (CH - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    return jpeg(cv);
  }
  function jpeg(cv) {
    let q = 0.85, url = cv.toDataURL("image/jpeg", q);
    while (url.length > 420000 && q > 0.4) { q -= 0.1; url = cv.toDataURL("image/jpeg", q); }
    return url;
  }
  // a photo that's already just the card (a scan or a listing photo): same shape as a card, nothing to trim
  const isScan = (bmp) => { const r = bmp.width / bmp.height; return Math.abs(r - 5 / 7) < 0.06 || Math.abs(r - 7 / 5) < 0.12 || isSlabPhoto(bmp); };
  // a photo cropped to just the slab (common on eBay)
  const isSlabPhoto = (bmp) => { const r = Math.min(bmp.width, bmp.height) / Math.max(bmp.width, bmp.height); return r > 0.57 && r < 0.655; };
  // the found outline is slab-shaped (long side / short side about 1.6 instead of 1.4)
  const isSlabQuad = (q) => { const a = (len(q[0], q[1]) + len(q[2], q[3])) / 2, b = (len(q[1], q[2]) + len(q[3], q[0])) / 2; return Math.max(a, b) / Math.min(a, b) > 1.52; };
  // re-shape an old slab photo that was saved squeezed into card shape (just a stretch: the squeeze was linear)
  async function unsquish(src) {
    const b = await bitmapOf(src), cv = document.createElement("canvas"); cv.width = SLAB_W; cv.height = SLAB_H;
    cv.getContext("2d").drawImage(b, 0, 0, SLAB_W, SLAB_H);
    return jpeg(cv);
  }
  const frame = (bmp) => upright([[0, 0], [bmp.width, 0], [bmp.width, bmp.height], [0, bmp.height]]);

  // corners placed by hand, in any order: sort them around their middle, then stand the card up
  const order = (q) => { const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    return upright(q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))); };

  return { CARD_W, CARD_H, SLAB_W, SLAB_H, bitmapOf, findQuad, warp, whole, isScan, isSlabPhoto, isSlabQuad, unsquish, frame, order };
})();
