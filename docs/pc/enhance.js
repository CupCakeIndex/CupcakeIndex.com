// Card photo touch-up for display: fixes the color cast from room lighting, stretches dull contrast, lifts dark
// photos and sharpens a little. Runs in the browser when a card is shown; the saved photo is never changed
// (so eBay listings and the card reader still get the real photo).
//
//   CardEnhance.enhance(src) -> Promise<url of the touched-up copy>   (cached per photo)
(function () {
  const MAX = 1400;                 // longest side worked on; bigger photos are scaled down first
  const cache = new Map();          // src -> Promise<blob URL>
  let queue = Promise.resolve();    // one photo at a time, so scrolling a big binder stays smooth

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function pct(hist, total, p) {    // value below which p of the pixels fall
    let n = 0, want = total * p;
    for (let i = 0; i < 256; i++) { n += hist[i]; if (n >= want) return i; }
    return 255;
  }

  function touchUp(img) {
    const d = img.data, len = d.length, px = len / 4;
    // 1) color cast: gray-world white balance, pulled only part of the way and capped, so a red card stays red
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < len; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
    const mr = sr / px, mg = sg / px, mb = sb / px, gray = (mr + mg + mb) / 3;
    const wb = [mr, mg, mb].map((m) => clamp(1 + 0.6 * (gray / Math.max(m, 1) - 1), 0.88, 1.12));
    // 2) contrast: black and white points from the brightness histogram (0.5% / 99.5%), with limits
    const hist = new Uint32Array(256);
    for (let i = 0; i < len; i += 4) hist[Math.min(255, (0.299 * d[i] * wb[0] + 0.587 * d[i + 1] * wb[1] + 0.114 * d[i + 2] * wb[2]) | 0)]++;
    const lo = Math.min(pct(hist, px, 0.005), 40), hi = Math.max(pct(hist, px, 0.995), 200);
    const span = Math.max(hi - lo, 1);
    // 3) dim photos: lift the mids with a gentle curve
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += hist[i] * clamp((i - lo) / span, 0, 1);
    const mean = sum / px, gamma = mean < 0.45 ? clamp(Math.log(0.5) / Math.log(Math.max(mean, 0.05)), 0.72, 1) : 1;
    const lut = new Uint8ClampedArray(256 * 3);
    for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++)
      lut[c * 256 + v] = 255 * Math.pow(clamp((v * wb[c] - lo) / span, 0, 1), gamma);
    for (let i = 0; i < len; i += 4) {
      // 4) a touch more color (8%)
      let r = lut[d[i]], g = lut[256 + d[i + 1]], b = lut[512 + d[i + 2]];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = l + (r - l) * 1.08; d[i + 1] = l + (g - l) * 1.08; d[i + 2] = l + (b - l) * 1.08;
    }
    return img;
  }

  // 5) unsharp mask: add back some of the difference from a small blur (skips tiny differences, so grain stays put)
  function sharpen(img, w, h, amount = 0.55, threshold = 4) {
    const s = img.data, out = new Uint8ClampedArray(s);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const k = i + c, row = w * 4;
        const blur = (4 * s[k] + 2 * (s[k - 4] + s[k + 4] + s[k - row] + s[k + row]) + s[k - row - 4] + s[k - row + 4] + s[k + row - 4] + s[k + row + 4]) / 16;
        const diff = s[k] - blur;
        if (Math.abs(diff) > threshold) out[k] = s[k] + amount * diff;
      }
    }
    s.set(out);
    return img;
  }

  async function run(src) {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    ctx.putImageData(sharpen(touchUp(img), w, h), 0, 0);
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.9));
    return URL.createObjectURL(blob);
  }

  function enhance(src) {
    if (!src || src.startsWith("blob:")) return Promise.resolve(src);
    if (!cache.has(src)) {
      const p = queue.then(() => run(src));
      queue = p.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, 0)));
      cache.set(src, p.catch(() => src));   // if anything fails, the original photo is shown
    }
    return cache.get(src);
  }

  window.CardEnhance = { enhance };
})();
