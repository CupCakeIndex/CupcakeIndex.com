"""The stat card's "broadcast" look (Terry picked it 2026-10-21): team-color backdrop with light rays and speed
stripes, the player (or team logo) big on the left over a giant faded number and a ribbon, and a glass panel on
the right with the headline number and the top 5 (headshots, rank badges, team-color bars).

obscure.card() draws every stat card with this. The theme only picks the accent color.
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import render as R
from render import hex_rgb, short

W, H = 1600, 900
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_fonts = {}


def _font(name, size, weight=None):
    key = (name, size, weight)
    if key not in _fonts:
        f = ImageFont.truetype(os.path.join(FONTS, name), size)
        if weight:
            try:  # variable font: set the weight axis
                f.set_variation_by_axes([min(max(weight, a["minimum"]), a["maximum"]) if a["name"] == b"Weight" else a["default"]
                                         for a in f.get_variation_axes()])
            except Exception:
                pass
        _fonts[key] = f
    return _fonts[key]


def COND(s):
    return _font("BarlowCondensed-Bold.ttf", s)


def INTER(s, w=500):
    return _font("Inter.ttf", s, w)


class DR:
    """ImageDraw that blends see-through colors (Pillow overwrites alpha when drawing straight onto RGBA)."""
    def __init__(self, img):
        self.img = img

    def __getattr__(self, name):
        def call(*a, **k):
            if name in ("textlength", "textbbox"):
                return getattr(ImageDraw.Draw(self.img), name)(*a, **k)
            ov = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
            r = getattr(ImageDraw.Draw(ov), name)(*a, **k)
            self.img.alpha_composite(ov)
            return r
        return call


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def lift(c, floor=70):
    """Dark team colors (Jets green, Raiders black): brighten until they read on black."""
    for _ in range(30):
        if 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] >= floor:
            break
        c = mix(c, (255, 255, 255), 0.12)
    return c


def linear(size, a, b, horizontal=False):
    w, h = size
    g = Image.new("RGBA", size)
    d = ImageDraw.Draw(g)
    n = w if horizontal else h
    for i in range(n):
        d.line((i, 0, i, h) if horizontal else (0, i, w, i), fill=mix(a, b, i / max(1, n - 1)) + (255,))
    return g


def radial_mask(center, radius, strength):
    small = Image.new("L", (W // 8, H // 8))
    px = small.load()
    cx, cy = center
    for y in range(small.height):
        for x in range(small.width):
            px[x, y] = int(255 * strength * max(0.0, 1 - math.hypot(x * 8 - cx, y * 8 - cy) / radius))
    return small.resize((W, H), Image.BICUBIC)


def grain(img, strength=0.3):
    n = Image.effect_noise(img.size, 64).convert("L").point(lambda v: 128 + (v - 128) // 4).convert("RGBA")
    return Image.blend(img, ImageChops.overlay(img, n), strength).convert("RGBA")


def shadow(im, blur=18, alpha=0.6, color=(0, 0, 0)):
    s = Image.new("RGBA", im.size, color + (0,))
    s.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
    pad = blur * 3
    big = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    big.alpha_composite(s, (pad, pad))
    return big.filter(ImageFilter.GaussianBlur(blur)), pad


def text_layer(text, font, fill=(255, 255, 255, 255)):
    d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    asc, desc = font.getmetrics()
    im = Image.new("RGBA", (int(d.textlength(text, font=font)) + 8, asc + desc + 8), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((4, 4), text, font=font, fill=fill)
    return im.crop(im.getbbox()) if im.getbbox() else im


def grad_text(text, font, top, bottom):
    m = text_layer(text, font)
    g = linear(m.size, top, bottom)
    g.putalpha(m.getchannel("A"))
    return g


def rounded(im, r):
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, im.width - 1, im.height - 1), r, fill=255)
    im.putalpha(ImageChops.multiply(im.getchannel("A"), m))
    return im


def circle(im, size, bg, ring=None, ring_w=1, logo=False):
    """A headshot (cropped to the face) or a logo in a circle."""
    s = size * 4
    base = Image.new("RGBA", (s, s), bg + (255,))
    if im:
        if logo:
            p = im.copy()
            p.thumbnail((int(s * 0.7), int(s * 0.7)), Image.LANCZOS)
            base.alpha_composite(p, ((s - p.width) // 2, (s - p.height) // 2))
        else:
            w = int(s * 1.45)
            p = im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
            base.alpha_composite(p, ((s - w) // 2, int(-s * 0.02)))
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(base, (0, 0), m)
    if ring:
        ImageDraw.Draw(out).ellipse((0, 0, s - 1, s - 1), outline=ring, width=ring_w * 4)
    return out.resize((size, size), Image.LANCZOS)


def fade_bottom(im, start=0.86):
    g = Image.new("L", im.size, 255)
    d = ImageDraw.Draw(g)
    y0 = int(im.height * start)
    for y in range(y0, im.height):
        d.line((0, y, im.width, y), fill=int(255 * (1 - (y - y0) / max(1, im.height - y0))))
    im = im.copy()
    im.putalpha(ImageChops.multiply(im.getchannel("A"), g))
    return im


def fit_font(d, text, make, size, max_w, min_size=20):
    while size > min_size and d.textlength(text, font=make(size)) > max_w:
        size -= 2
    return make(size)


def wrap(d, text, font, max_w, lines):
    words, out, cur = text.split(), [], ""
    for w in words:
        if d.textlength((cur + " " + w).strip(), font=font) <= max_w:
            cur = (cur + " " + w).strip()
        else:
            out.append(cur)
            cur = w
    out.append(cur)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = R.fit(d, out[-1] + " …", font, max_w)
    return [o for o in out if o]


def draw(f, accent, image, team_logo):
    """f: an obscure.py fact. image(url) fetches a picture; team_logo(p) gives a logo that shows on a dark panel."""
    A = accent
    (lead, _, big), rows = f["rows"][0], f["rows"][:5]
    tc = hex_rgb(lead.get("color") or "", (90, 90, 96))
    hot = lift(tc, 95)
    player = f["kind"] == "player"
    name = lead.get("name") or lead["team"]

    # backdrop: team color, faint logo pattern, a spotlight with rays, speed stripes (one in the accent)
    img = linear((W, H), mix(tc, (0, 0, 0), 0.1), mix(tc, (0, 0, 0), 0.8), horizontal=True)
    logo = team_logo(lead)
    if logo:
        tile = logo.copy()
        tile.thumbnail((90, 90), Image.LANCZOS)
        tile.putalpha(tile.getchannel("A").point(lambda v: int(v * 0.06)))
        for row, y in enumerate(range(-40, H, 130)):
            for x in range(-60 + (row % 2) * 90, 900, 180):
                img.alpha_composite(tile, (x, y))
    img.alpha_composite(Image.composite(Image.new("RGBA", (W, H), mix(hot, (255, 255, 255), 0.35) + (255,)),
                                        Image.new("RGBA", (W, H), (0, 0, 0, 0)), radial_mask((470, 380), 650, 0.3)))
    rays = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rays)
    for i in range(14):
        a = i * 2 * math.pi / 14
        rd.polygon([(470, 330), (470 + 1400 * math.cos(a - 0.09), 330 + 1400 * math.sin(a - 0.09)),
                    (470 + 1400 * math.cos(a + 0.09), 330 + 1400 * math.sin(a + 0.09))], fill=(255, 255, 255, 24))
    img.alpha_composite(rays.filter(ImageFilter.GaussianBlur(10)))
    st = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(st)
    for x, w, c in [(560, 70, (255, 255, 255, 30)), (665, 16, A + (200,)), (700, 6, (255, 255, 255, 90)),
                    (1020, 140, (255, 255, 255, 16)), (1190, 10, (255, 255, 255, 36))]:
        sd.polygon([(x, 0), (x + w, 0), (x + w - 380, H), (x - 380, H)], fill=c)
    img.alpha_composite(st)

    big = f.get("big") or big  # some stats show a different headline number than their bar label
    unit = f["unit"].upper()
    if " +" in big and big.endswith("FCS"):  # "2-7 +2 FCS": big number 2-7, FCS games in the label
        big, extra = big.split(" +", 1)
        unit += f" (PLUS {extra})"
    unit = f.get("big_unit", "").upper() or unit

    # giant faded number behind the hero (only when it's short enough to read as a number)
    if len(big) <= 5:
        num = grad_text(big, COND(820 if len(big) <= 3 else 600), mix(hot, (255, 255, 255), 0.45), mix(tc, (0, 0, 0), 0.4))
        num.putalpha(num.getchannel("A").point(lambda v: int(v * 0.55)))
        img.alpha_composite(num, (-10, H - num.height + 30))
    # ribbon behind the hero
    rf = COND(40)
    band = Image.new("RGBA", (2200, 64), A + (255,))
    bd = ImageDraw.Draw(band)
    unit_txt, x = f"  {f.get('tag') or f['title']}  /".upper(), 0
    while x < band.width:
        bd.text((x, 32), unit_txt, font=rf, fill=(14, 14, 16), anchor="lm")
        x += bd.textlength(unit_txt, font=rf)
    img.alpha_composite(band.rotate(-12, resample=Image.BICUBIC, expand=True), (-300, 600))

    pic = image(lead.get("pic")) if player else None
    if pic and f.get("costume"):
        pic = f["costume"](pic.copy(), lead)
    if pic and pic.getbbox():
        pic = pic.crop(pic.getbbox())
        pic = pic.resize((int(pic.width * 770 / pic.height), 770), Image.LANCZOS)
        x = max(0, min(140, 520 - pic.width // 2))
        rim, pad = shadow(pic, 14, 0.9, A)  # accent rim light
        img.alpha_composite(rim, (x - pad - 10, H - pic.height - pad + 2))
        g, pad = shadow(pic, 34, 0.5, mix(hot, (255, 255, 255), 0.5))
        img.alpha_composite(g, (x - pad, H - pic.height - pad + 4))
        img.alpha_composite(fade_bottom(pic), (x, H - pic.height))
    elif logo:  # team stat: the logo is the hero
        hero = logo.copy()
        hero.thumbnail((480, 480), Image.LANCZOS)
        hx, hy = 420 - hero.width // 2, 440 - hero.height // 2
        g, pad = shadow(hero, 30, 0.6, mix(hot, (255, 255, 255), 0.5))
        img.alpha_composite(g, (hx - pad, hy - pad))
        s, pad = shadow(hero, 16, 0.55)
        img.alpha_composite(s, (hx - pad + 12, hy - pad + 18))
        img.alpha_composite(hero, (hx, hy))
    img = grain(img)
    d = DR(img)
    bf = R.font(26, "Bold")  # brand, top left
    d.text((48, 40), ">", font=bf, fill=A)
    d.text((76, 40), "CUPCAKE", font=bf, fill=(255, 255, 255))
    d.text((76 + d.textlength("CUPCAKE", font=bf), 40), "_INDEX", font=bf, fill=A)

    # glass panel
    px0, py0, px1, py1 = 860, 60, W - 50, H - 60
    s, pad = shadow(Image.new("RGBA", (px1 - px0, py1 - py0), (0, 0, 0, 255)), 30, 0.6)
    img.alpha_composite(s, (px0 - pad + 10, py0 - pad + 20))
    d.rounded_rectangle((px0, py0, px1, py1), 28, fill=(8, 10, 14, 200), outline=(255, 255, 255, 38), width=2)
    img.alpha_composite(rounded(linear((px1 - px0 - 56, 6), A, lift(tc, 120), horizontal=True), 3), (px0 + 28, py0 + 1))
    x0, xr = px0 + 44, px1 - 44
    tx = x0
    for label, solid in ((f["league"].upper(), False), ((f.get("tag") or ("HOT TAKE" if f["hot"] else "BY THE NUMBERS")).upper(), True)):
        tf = INTER(17, 800)
        tw = d.textlength(label, font=tf)
        d.rounded_rectangle((tx, py0 + 40, tx + tw + 30, py0 + 74), 17, fill=A if solid else None, outline=A, width=2)
        d.text((tx + 15, py0 + 57), label, font=tf, fill=(10, 10, 12) if solid else A, anchor="lm")
        tx += tw + 44
    tfont = fit_font(d, f["title"].upper(), COND, 84, xr - x0, 52)
    title = text_layer(f["title"].upper(), tfont)
    s, pad = shadow(title, 8, 0.8)
    ty = py0 + 100 + (84 - tfont.size) // 2
    img.alpha_composite(s, (x0 - pad + 3, ty - pad + 4))
    img.alpha_composite(title, (x0, ty))
    y = py0 + 188
    for line in wrap(d, f["sub"], INTER(21), xr - x0, 2):
        d.text((x0, y), line, font=INTER(21), fill=(185, 190, 200))
        y += 28

    # hero line: the number (glowing), then who
    y = max(y + 22, py0 + 250)
    hf = fit_font(d, big, COND, 150, 330, 72)
    if d.textlength(big, font=hf) > 330:  # too wide to sit beside the name: smaller, with the name underneath
        hf = fit_font(d, big, COND, 84, xr - x0, 40)
    hn = grad_text(big, hf, mix(A, (255, 255, 255), 0.35), A)
    g, pad = shadow(hn, 22, 0.75, A)
    img.alpha_composite(g, (x0 - pad, y + 10 - pad))
    img.alpha_composite(hn, (x0, y + 10))
    if hn.width <= 330:  # name beside the number
        nx, ny = x0 + hn.width + 28, y
    else:  # a wide headline ("+57 vs Kent State"): name underneath
        nx, ny = x0, y + hn.height + 4
    nf = fit_font(d, name.upper(), COND, 48, xr - nx, 28)
    d.text((nx, ny + 26), name.upper(), font=nf, fill=(255, 255, 255))
    meta = " · ".join(x for x in (lead.get("pos"), lead["team"], lead.get("draft")) if x) if player else         (f"{lead.get('record', '')} · #{lead['power_rank']} in our rankings" if lead.get("power_rank") else lead.get("record", ""))
    mx = nx
    small = team_logo(lead)
    if small and player:
        small = small.copy()
        small.thumbnail((30, 30), Image.LANCZOS)
        img.alpha_composite(small, (mx, ny + 88))
        mx += 40
    d.text((mx, ny + 90), R.fit(d, meta, INTER(20, 600), xr - mx), font=INTER(20, 600), fill=(185, 190, 200))
    ul = wrap(d, unit, INTER(16, 800), xr - nx, 2)
    for i, line in enumerate(ul):
        d.text((nx, ny + 124 + i * 22), line, font=INTER(16, 800), fill=A)
    y = max(y + hn.height + 40, ny + 140 + 22 * len(ul))

    # leaderboard
    q = f.get("question")
    bottom = py1 - (40 + 34 * len(wrap(d, q, INTER(22, 700), xr - x0 - 26, 2)) if q else 30)
    row_h = min(70, (bottom - y) // max(1, len(rows)))
    vmax = max(abs(v) for _, v, _ in rows) or 1
    av = max(30, min(54, row_h - 12))
    vf = COND(40)  # values: shrink until the widest fits, and the bars make room for it
    while vf.size > 24 and max(d.textlength(s_, font=vf) for _, _, s_ in rows) > 230:
        vf = COND(vf.size - 2)
    val_w = max(d.textlength(s_, font=vf) for _, _, s_ in rows)
    for i, (p, v, s_) in enumerate(rows):
        cy = y + i * row_h + row_h // 2
        col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 80)
        if i == 0:
            hl = linear((px1 - 28 - (x0 - 16), row_h - 4), mix(A, (0, 0, 0), 0.55), (14, 16, 20), horizontal=True)
            hl.putalpha(200)
            img.alpha_composite(rounded(hl, 16), (x0 - 16, cy - (row_h - 4) // 2))
        if player:
            face = circle(image(p.get("pic")), av, mix(col, (0, 0, 0), 0.4), A if i == 0 else (255, 255, 255, 60), 3 if i == 0 else 1)
        else:
            face = circle(team_logo(p), av, (24, 26, 32), A if i == 0 else (255, 255, 255, 60), 3 if i == 0 else 1, logo=True)
        img.alpha_composite(face, (x0, cy - av // 2))
        bx, by = x0 + av - 18, cy + av // 2 - 22
        d.ellipse((bx, by, bx + 24, by + 24), fill=A if i == 0 else (40, 42, 50), outline=(10, 10, 12), width=2)
        d.text((bx + 12, by + 12), str(i + 1), font=INTER(13, 800), fill=(10, 10, 12) if i == 0 else (230, 230, 235), anchor="mm")
        who = p.get("name") or short(p["team"], f["league"])
        lx = x0 + av + 22
        ink = (255, 255, 255) if i == 0 else (215, 218, 225)
        bx0, bx1 = x0 + 290, min(xr - 110, int(xr - val_w - 30))
        if player:
            d.text((lx, cy - 12), R.fit(d, who, INTER(22, 700), bx0 - lx - 12), font=INTER(22, 700), fill=ink, anchor="lm")
            d.text((lx, cy + 14), p["team"], font=INTER(15, 600), fill=(150, 155, 165), anchor="lm")
        else:
            d.text((lx, cy), R.fit(d, who, INTER(22, 700), bx0 - lx - 12), font=INTER(22, 700), fill=ink, anchor="lm")
        d.rounded_rectangle((bx0, cy - 7, bx1, cy + 7), 7, fill=(255, 255, 255, 22))
        fw = max(14, int((bx1 - bx0) * min(1, abs(v) / vmax)))
        c1 = A if i == 0 else col
        bar = rounded(linear((fw, 14), mix(c1, (0, 0, 0), 0.25), mix(c1, (255, 255, 255), 0.25), horizontal=True), 7)
        if i == 0:
            g, pad = shadow(bar, 10, 0.8, A)
            img.alpha_composite(g, (bx0 - pad, cy - 7 - pad))
        img.alpha_composite(bar, (bx0, cy - 7))
        d.text((xr, cy), s_, font=vf, fill=ink, anchor="rm")

    if q:  # hot takes: the take, as a callout at the bottom of the panel
        lines = wrap(d, q, INTER(22, 700), xr - x0 - 26, 2)
        top = py1 - 30 - 34 * len(lines)
        d.rectangle((x0, top - 4, x0 + 6, py1 - 30), fill=A)
        for i, line in enumerate(lines):
            d.text((x0 + 22, top + i * 34), line, font=INTER(22, 700), fill=(255, 255, 255))
    d.text((px1 - 44, py1 + 24), "cupcakeindex.com", font=R.font(17), fill=(220, 220, 225), anchor="rm")
    return img
