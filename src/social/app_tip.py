""""Add it to your home screen" post for X: how to save the site as an app on iPhone and Android,
plus one plain stat at the bottom so every post is a little different (X rejects exact repeats).

No link in the post (Terry's rule); the card itself shows the web address. 280 characters max.
Posting is done by post_to_x.py, same as the other posts.

    python src/social/app_tip.py                 # random look -> out/social/today.json
    python src/social/app_tip.py --theme mono    # a specific look
    python src/social/app_tip.py --no-stat       # just the how-to

Runs every 3 days from GitHub (.github/workflows/app_tip.yml), and on demand with Run workflow.
"""
import argparse
import datetime as dt
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R
from render import ROOT, hex_rgb, x_len
from obscure import STATS, THEMES, W, H, font_for, mix, wrap

ICON = os.path.join(ROOT, "docs", "apple-touch-icon.png")
STEPS = [
    ("IPHONE · SAFARI", ["Go to cupcakeindex.com", "Tap Share (box + arrow)", 'Tap "Add to Home Screen"', "Tap Add. Done."]),
    ("ANDROID · CHROME", ["Go to cupcakeindex.com", "Tap the 3-dot menu", 'Tap "Add to Home screen"', "Tap Install. Done."]),
]
# opening lines, rotated so the text never repeats exactly
INTROS = [
    "📲 Make the Cupcake Index an app on your phone. Free, no App Store needed.",
    "📲 The Cupcake Index works like an app on your phone. Free, no download from a store.",
    "📲 Want the Cupcake Index one tap away? Put it on your home screen. Free, no App Store.",
    "📲 Rankings, scores and cupcakes, one tap away. Add the Cupcake Index to your home screen.",
]
HOWTO = "\niPhone: Safari → Share → Add to Home Screen\nAndroid: Chrome → ⋮ → Add to Home screen"


def pick_stat(intro, rng):
    """A plain stat (no hot takes) whose whole tweet fits in 280; the shortest one if none fits."""
    keys = [k for k in STATS if not k.startswith("hot_")]
    rng.shuffle(keys)
    best = None
    for k in keys:
        try:
            f = STATS[k]()
        except Exception as e:  # one broken data source shouldn't stop the post
            print(f"[{k}] failed: {e!r}")
            continue
        if not f:
            continue
        text = f"{intro}{HOWTO}\n\nStat of the day: {f['text']}"
        if x_len(text) <= 280:
            return k, f
        if not best or len(f["text"]) < len(best[1]["text"]):
            best = (k, f)
    return best or (None, None)


def phone(img, T, x, y, w, h):
    """A phone outline with a home screen of blank apps and our icon lit up."""
    d = ImageDraw.Draw(img)
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x + 14, y + 22, x + w + 14, y + h + 22), 56, fill=(0, 0, 0, 150))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(18)))
    d.rounded_rectangle((x, y, x + w, y + h), 56, fill=mix(T["panel"], T["ink"], 0.04), outline=mix(T["line"], T["ink"], 0.25), width=6)
    d.rounded_rectangle((x + w // 2 - 60, y + 18, x + w // 2 + 60, y + 44), 13, fill=T["bg"])  # notch
    cols, size, gap = 4, 62, 24
    gx = x + (w - (cols * size + (cols - 1) * gap)) // 2
    gy = y + 90
    lit = (1, 2)  # row, col of our app
    icon = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS) if os.path.exists(ICON) else None
    lab = font_for(T["_name"], 15, "Bold")
    for r in range(4):
        for c in range(cols):
            ax, ay = gx + c * (size + gap), gy + r * (size + 44)
            if (r, c) == lit:
                glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
                ImageDraw.Draw(glow).rounded_rectangle((ax - 10, ay - 10, ax + size + 10, ay + size + 10), 26, fill=T["accent"] + (200,))
                img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(14)))
                m = Image.new("L", (size, size), 0)
                ImageDraw.Draw(m).rounded_rectangle((0, 0, size, size), 18, fill=255)
                if icon:
                    img.paste(icon, (ax, ay), m)
                else:
                    d.rounded_rectangle((ax, ay, ax + size, ay + size), 18, fill=T["accent"])
                d.text((ax + size // 2, ay + size + 8), "Cupcake", font=lab, fill=T["ink"], anchor="mt")
            else:
                d.rounded_rectangle((ax, ay, ax + size, ay + size), 18, fill=mix(T["panel"], T["ink"], 0.10))
    # dock
    dy = y + h - 120
    d.rounded_rectangle((x + 24, dy, x + w - 24, dy + 96), 30, fill=mix(T["panel"], T["ink"], 0.07))
    for c in range(cols):
        ax = gx + c * (size + gap)
        d.rounded_rectangle((ax, dy + 13, ax + size, dy + 13 + size), 18, fill=mix(T["panel"], T["ink"], 0.13))


def card(theme, stat):
    T = {k: hex_rgb(v) for k, v in THEMES[theme].items() if isinstance(v, str) and v.startswith("#")}
    T["_name"] = theme
    F = lambda size, weight="Regular": font_for(theme, size, weight)
    img = Image.new("RGBA", (W, H), T["bg"] + (255,))
    d = ImageDraw.Draw(img)
    for gx in range(12, W, 28):  # faint dot grid, like the stat cards
        for gy in range(12, H, 28):
            d.point((gx, gy), fill=mix(T["bg"], T["ink"], 0.12))

    # brand
    bf = F(26, "Bold")
    d.text((64, 44), ">", font=bf, fill=T["accent"])
    d.text((92, 44), "CUPCAKE", font=bf, fill=T["ink"])
    d.text((92 + d.textlength("CUPCAKE", font=bf), 44), "_INDEX", font=bf, fill=T["accent"])
    tag = "HOW TO"
    tf = F(20, "Bold")
    tx = 92 + d.textlength("CUPCAKE_INDEX", font=bf) + 24
    d.rectangle((tx, 42, tx + d.textlength(tag, font=tf) + 28, 78), fill=T["accent"])
    d.text((tx + 14, 47), tag, font=tf, fill=T["bg"])

    # title
    x0, xr = 64, 1060
    y = 112
    tfont = F(64, "ExtraBold")
    for line in wrap(d, "Put the Cupcake Index on your home screen", tfont, xr - x0, 2):
        d.text((x0, y), line, font=tfont, fill=T["ink"])
        y = max(y + 74, d.textbbox((x0, y), line, font=tfont)[3] + 10)
    d.text((x0, y + 14), "Opens full-screen like a real app. Free. No App Store, no account.", font=F(23), fill=T["muted"])
    y += 64

    # two step columns
    colw = (xr - x0 - 36) // 2
    for i, (head, steps) in enumerate(STEPS):
        cx = x0 + i * (colw + 36)
        d.rectangle((cx, y, cx + colw, y + 300), fill=T["panel"], outline=T["line"], width=2)
        d.rectangle((cx, y, cx + 6, y + 300), fill=T["accent"])
        d.text((cx + 28, y + 22), head, font=F(22, "Bold"), fill=T["accent"])
        sy = y + 72
        for n, s in enumerate(steps, 1):
            d.ellipse((cx + 28, sy - 2, cx + 64, sy + 34), outline=T["accent"], width=2)
            d.text((cx + 46, sy + 16), str(n), font=F(19, "Bold"), fill=T["accent"], anchor="mm")
            d.text((cx + 80, sy + 16), R.fit(d, s, F(21, "Bold"), colw - 100), font=F(21, "Bold"), fill=T["ink"], anchor="lm")
            sy += 54

    # phone on the right
    phone(img, T, 1150, 70, 380, 660)
    d = ImageDraw.Draw(img)

    # bottom strip: stat of the day (or the motto)
    by = H - 128
    d.rectangle((0, by, W, H), fill=T["panel"])
    d.line((0, by, W, by), fill=T["accent"], width=4)
    if stat:
        lab = "STAT OF THE DAY"
        lf = F(19, "Bold")
        lw = d.textlength(lab, font=lf)
        d.text((64, by + 30), lab, font=lf, fill=T["accent"])
        d.text((64, by + 60), stat["league"].upper(), font=F(17, "Bold"), fill=T["muted"])
        sf = F(24, "Bold")
        for i, line in enumerate(wrap(d, stat["text"], sf, W - 64 - (64 + lw + 40), 2)):
            d.text((64 + lw + 40, by + 26 + i * 36), line, font=sf, fill=T["ink"])
    else:
        R.draw_motto(d, 64, by + 64, 22, T["ink"], T["muted"], T["accent"], font_for=F)
    return img


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--theme", choices=["random", *THEMES], default="random")
    ap.add_argument("--no-stat", action="store_true", help="skip the stat of the day")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    rng = random.Random()
    theme = rng.choice(list(THEMES)) if a.theme == "random" else a.theme
    intro = INTROS[dt.date.today().toordinal() % len(INTROS)]
    key, stat = (None, None) if a.no_stat else pick_stat(intro, rng)
    text = f"{intro}{HOWTO}"
    if stat:  # trim the stat if it has to; the how-to always stays whole
        s = f"\n\nStat of the day: {stat['text']}"
        while x_len(text + s) > 280:
            s = s[:-2].rsplit(" ", 1)[0] + "…"
        text += s
    os.makedirs(a.out, exist_ok=True)
    png = os.path.join(a.out, "app-tip.png")
    card(theme, stat).convert("RGB").save(png, optimize=True)
    meta = {"day": "app_tip", "stat": key, "theme": theme, "image": png, "text": text, "skip": False, "reason": ""}
    for name in ("app-tip.json", "today.json"):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=1, ensure_ascii=False)
    print(f"[app_tip] {theme} stat={key} {png} ({x_len(text)} chars)\n{text}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
