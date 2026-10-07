// Share ▾ menu (Copy Link / Save Image) and the canvas picture helpers behind Save Image.
// Used by Pick'em; the bracket's My picks share the same look (1600x900 at 2x, dark terminal style, cupcake watermark).
const Share = (() => {
  const W = 1600, H = 900, S = 2;
  const C = { bg: "#0f1216", card: "#171b21", ink: "#e8eaed", muted: "#9aa3af", line: "#262c35", accent: "#ff7a3d", good: "#3ccf7e", bad: "#ff6b6b" };
  const F = (w, px) => `${w} ${px}px "JetBrains Mono", ui-monospace, monospace`;

  const loadImg = (src) => new Promise((ok) => {
    if (!src) return ok(null);
    const im = new Image(), t = setTimeout(() => ok(null), 6000);
    im.crossOrigin = "anonymous"; // ESPN's logo CDN allows it, so the canvas stays exportable
    im.onload = () => { clearTimeout(t); ok(im); };
    im.onerror = () => { clearTimeout(t); ok(null); };
    im.src = src;
  });
  const fonts = () => document.fonts.ready.then(() => Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "JetBrains Mono"`)))).catch(() => {});

  // Draw a picture and return it as a PNG blob. paint(d) draws the content; d = { x, text, fit, F, C, W, H, logos }.
  // The background, "> title" header and watermark are drawn here. logos = Map(key -> image) from logoUrls (key -> url).
  async function png({ title, sub, logoUrls = new Map(), paint }) {
    const [logos, mark] = await Promise.all([
      Promise.all([...logoUrls].map(([k, u]) => loadImg(u).then((im) => [k, im]))).then((x) => new Map(x)),
      loadImg("favicon.svg"),
      fonts(),
    ]);
    const draw = (withLogos) => {
      const cv = document.createElement("canvas");
      cv.width = W * S; cv.height = H * S;
      const x = cv.getContext("2d");
      x.scale(S, S);
      const fit = (s, w) => { s = String(s); while (s.length > 2 && x.measureText(s).width > w) s = s.slice(0, -2) + "…"; return s; };
      const text = (s, px, py, font, color, align = "left", maxW = 9999) => { x.font = font; x.fillStyle = color; x.textAlign = align; x.fillText(fit(s, maxW), px, py); };
      x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
      x.textBaseline = "alphabetic";
      text(`> ${title}`, 48, 78, F(700, 40), C.accent, "left", W - 96);
      if (sub) text(sub, 48, 116, F(400, 20), C.ink, "left", 1100);
      x.save();
      paint({ x, text, fit, F, C, W, H, logos: withLogos ? logos : new Map() });
      x.restore();
      // watermark: the cupcake mark + the address, bottom right
      x.textBaseline = "alphabetic";
      text("cupcakeindex.com", W - 48, H - 40, F(400, 16), C.muted, "right");
      x.font = F(400, 16);
      if (mark) { x.globalAlpha = 0.85; x.drawImage(mark, W - 48 - x.measureText("cupcakeindex.com").width - 38, H - 40 - 21, 28, 28); x.globalAlpha = 1; }
      return cv;
    };
    const blob = (cv) => new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("no image"))), "image/png"));
    try { return await blob(draw(true)); }
    catch { return blob(draw(false)); } // a logo without CORS "taints" the canvas so it can't export: redraw without logos
  }

  // phones and tablets (touch, with the share sheet): pictures go to the share sheet (Save Image, Messages, X...)
  // instead of a download, which doesn't work well in the home-screen app (Terry, Oct 6)
  const phone = () => matchMedia("(pointer: coarse)").matches && typeof navigator.canShare === "function";
  async function download(blob, name) {
    if (phone()) {
      const f = new File([blob], name, { type: blob.type || "image/png" });
      if (navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch (e) { /* closed the sheet */ } return; }
    }
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    if ("download" in a) { a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
    else window.open(url, "_blank"); // no download support: show the picture in a new tab (press and hold to save)
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { // older browsers / non-secure pages
      const t = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
    }
  }

  const menuHtml = () => `<span class="share"><button data-act="share" aria-haspopup="menu" aria-expanded="false">Share ▾</button>
    <span class="share-menu" role="menu" hidden><button data-act="copy" role="menuitem">Copy Link</button><button data-act="img" role="menuitem">${phone() ? "Share Image" : "Save Image"}</button></span></span>`;

  // Wire the menu inside root (root's content may be redrawn; lookups happen on each click).
  // image() returns { blob, name } or throws an Error whose message is shown on the button.
  function wire(root, { image }) {
    const outside = (e) => { if (!e.target.closest(".share")) menu(false); };
    const escKey = (e) => { if (e.key === "Escape") { menu(false); root.querySelector('[data-act="share"]')?.focus(); } };
    function menu(open) {
      const m = root.querySelector(".share-menu");
      if (m) { m.hidden = !open; root.querySelector('[data-act="share"]').setAttribute("aria-expanded", open); }
      const f = open ? "addEventListener" : "removeEventListener";
      document[f]("pointerdown", outside, true); document[f]("keydown", escKey);
    }
    root.addEventListener("click", async (e) => {
      const btn = e.target.closest(".share button[data-act]"), act = btn?.dataset.act;
      if (act === "share") menu(root.querySelector(".share-menu").hidden);
      if (act === "copy") {
        await copy(location.href);
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = "Copy Link"; menu(false); }, 1200);
      }
      if (act === "img") {
        const was = btn.textContent;
        btn.textContent = "Drawing…";
        try {
          const { blob, name } = await image();
          download(blob, name);
          btn.textContent = was; menu(false);
        } catch (err) { btn.textContent = err.message || "Couldn't draw it"; setTimeout(() => (btn.textContent = was), 2000); }
      }
    });
    return menu;
  }

  return { W, H, C, F, loadImg, png, download, copy, menuHtml, wire, phone };
})();
