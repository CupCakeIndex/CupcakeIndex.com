"""Collector-card looks for the stat posts (Terry, Oct 2026), all drawn at 3x and scaled down for smooth edges,
everything straight and lined up:
  slab       the leader's card in a slate graded case, stat tiles and "the chase" bars beside it
  frontback  the card's front and back side by side; the back has the top 5 and a big "Did you know?"
  hand       the top 5 as a hand of playing cards (team-color pinstripe borders, name ribbon wrapped around the
             portrait), the number under each card and the stat's name under the hand
  numbered   postgame: a QB's gold numbered parallel, serial = his completions/attempts (postgame.py)
Same call as card_looks: look(f, A, image, team_logo).
"""
import math
import re

from PIL import Image, ImageDraw, ImageFilter

import render as R
from card_looks import OSW, info, who
from flare_card import COND, DR, H, INTER, W, circle, fit_font, grad_text, grain, lift, linear, mix, rounded, shadow, wrap
from render import hex_rgb

INK = (28, 24, 22)
WHITE = (255, 255, 255)
IMG = LOGO = None  # obscure.image / obscure.team_logo, set by each look (passed in, so this module never imports obscure)


def _use(image, team_logo):
    global IMG, LOGO
    IMG, LOGO = image, team_logo


S = 3  # supersampling
A = (255, 107, 44)
CREAM = (244, 240, 231)
GOLD = ((255, 236, 170), (214, 168, 70), (150, 104, 30))
MONO = lambda s: R.font(s, "Bold")


def _fit(d, text, make, size, max_w, min_size=10):
    while size > min_size and d.textlength(text, font=make(size)) > max_w:
        size -= 1
    return make(size)


def _rr_mask(size, r):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), r, fill=255)
    return m


def gold_fill(size):
    """A brushed gold gradient (light top-left to dark bottom-right, with a bright band)."""
    w, h = size
    g = Image.new("RGB", (w, h))
    px = g.load()
    a, m, b = GOLD
    for y in range(h):
        for x in range(0, w):
            t = (x / max(1, w) * 0.45 + y / max(1, h) * 0.55)
            band = max(0.0, 1 - abs(t - 0.38) * 6)  # a highlight band across the gold
            c = mix(a, m, t * 1.6) if t < 0.62 else mix(m, b, (t - 0.62) / 0.38)
            px[x, y] = mix(c, (255, 248, 220), band * 0.55)
    return g.convert("RGBA")


def foil_text(text, font):
    """Gold-foil text: gradient letters with a thin dark edge, like a stamped serial number."""
    t = grad_text(text, font, GOLD[0], GOLD[2])
    out = Image.new("RGBA", (t.width + 6, t.height + 6))
    edge = Image.new("RGBA", t.size, (60, 38, 6, 230))
    edge.putalpha(t.getchannel("A"))
    out.alpha_composite(edge, (3, 4))
    out.alpha_composite(t, (2, 2))
    return out


def front(I, cw, ch, serial=None, rookie=False, keep_big=False):
    """The card front at cw x ch. serial "30/36" makes it a gold numbered parallel. Returns the card (and the 3x
    render plus the serial's box in it, when keep_big, for a close-up)."""
    W_, H_ = cw * S, ch * S
    lead, tc = I["lead"], I["tc"]
    hot = lift(tc, 105)
    card = Image.new("RGBA", (W_, H_))
    # border: cardstock, or gold for a numbered parallel
    border = gold_fill((W_, H_)) if serial else Image.new("RGBA", (W_, H_), CREAM + (255,))
    card.paste(border, (0, 0), _rr_mask((W_, H_), 16 * S))
    b = 16 * S
    iw, ih = W_ - 2 * b, H_ - 2 * b
    plate = 104 * S
    fh = ih - plate  # photo field height
    field = Image.new("RGBA", (iw, fh))
    # team colour field with a soft light behind the player
    base = Image.new("RGBA", (iw, fh), mix(tc, (0, 0, 0), 0.35) + (255,))
    glow = Image.new("RGBA", (iw, fh))
    ImageDraw.Draw(glow).ellipse((-iw * 0.2, fh * 0.05, iw * 1.2, fh * 1.25), fill=mix(hot, (255, 255, 255), 0.12) + (255,))
    base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(70 * S)))
    field.alpha_composite(base)
    # fine pinstripes, very faint
    st = Image.new("RGBA", (iw, fh))
    sd = ImageDraw.Draw(st)
    for k in range(-fh, iw, 14 * S):
        sd.line((k, fh, k + fh, 0), fill=(255, 255, 255, 12), width=2 * S)
    field.alpha_composite(st)
    if I.get("logo"):
        wm = I["logo"].copy()
        wm.thumbnail((int(iw * 0.86), int(iw * 0.86)), Image.LANCZOS)
        wm = wm.resize((int(iw * 0.86), int(wm.height * iw * 0.86 / wm.width)), Image.LANCZOS)
        wm.putalpha(wm.getchannel("A").point(lambda v: int(v * (0.13 if I.get("pic") else 1))))
        field.alpha_composite(wm, ((iw - wm.width) // 2, int(fh * 0.1)))
    if I.get("pic"):
        ph = int(fh * 0.86)
        pic = I["pic"].resize((int(I["pic"].width * ph / I["pic"].height), ph), Image.LANCZOS)
        if pic.width > iw:
            pic = pic.crop(((pic.width - iw) // 2, 0, (pic.width + iw) // 2, ph))
        sh = Image.new("RGBA", pic.size, (0, 0, 0, 0))
        sh.putalpha(pic.getchannel("A").point(lambda v: int(v * 0.45)))
        field.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10 * S)), ((iw - pic.width) // 2 + 6 * S, fh - ph + 4 * S))
        field.alpha_composite(pic, ((iw - pic.width) // 2, fh - ph))
    # bottom fade into the nameplate
    fade = Image.new("RGBA", (iw, 90 * S))
    fd = ImageDraw.Draw(fade)
    for y in range(fade.height):
        fd.line((0, y, iw, y), fill=(10, 10, 12, int(200 * (y / fade.height) ** 2)))
    field.alpha_composite(fade, (0, fh - fade.height))
    inner = Image.new("RGBA", (iw, ih), (12, 12, 14, 255))
    inner.alpha_composite(field)
    d = ImageDraw.Draw(inner)
    # nameplate: straight, centered
    d.rectangle((0, fh, iw, fh + 4 * S), fill=A)
    name = I["name"].upper()
    nf = _fit(d, name, lambda s: COND(s * S), 50, iw - 40 * S)
    d.text((iw // 2, fh + 46 * S), name, font=nf, fill=(255, 255, 255), anchor="mm")
    meta = I["meta"].upper()
    mf = INTER(13 * S, 700)
    # letterspaced meta line
    sp = 2.2 * S
    tw = sum(d.textlength(ch_, font=mf) + sp for ch_ in meta) - sp
    x = iw / 2 - tw / 2
    for ch_ in meta:
        d.text((x, fh + 82 * S), ch_, font=mf, fill=(170, 170, 182), anchor="lm")
        x += d.textlength(ch_, font=mf) + sp
    # set mark (top right) and team logo (top left)
    d.text((iw - 14 * S, 14 * S), "CUPCAKE INDEX", font=MONO(11 * S), fill=(255, 255, 255, 230), anchor="ra")
    d.text((iw - 14 * S, 30 * S), "2026 · SERIES ONE", font=MONO(9 * S), fill=(255, 255, 255, 170), anchor="ra")
    if I.get("logo") and I.get("pic"):
        lg = I["logo"].copy()
        lg.thumbnail((46 * S, 46 * S), Image.LANCZOS)
        inner.alpha_composite(lg, (14 * S, 12 * S))
    if rookie:
        sx, sy, sw_ = iw - 14 * S - 40 * S, 48 * S, 40 * S
        d.polygon([(sx, sy), (sx + sw_, sy), (sx + sw_, sy + 32 * S), (sx + sw_ / 2, sy + 46 * S), (sx, sy + 32 * S)], fill=(200, 28, 36))
        d.text((sx + sw_ / 2, sy + 19 * S), "RC", font=COND(26 * S), fill=(255, 255, 255), anchor="mm")
    box = None
    if serial:
        sf = foil_text(serial, INTER(17 * S, 700))
        sx, sy = iw - 16 * S - sf.width, fh - 14 * S - sf.height
        inner.alpha_composite(sf, (sx, sy))
        box = (b + sx, b + sy, b + sx + sf.width, b + sy + sf.height)
    inner.putalpha(_rr_mask((iw, ih), 9 * S))
    card.alpha_composite(inner, (b, b))
    # thin keyline inside the border
    ImageDraw.Draw(card).rounded_rectangle((b - 4 * S, b - 4 * S, W_ - b + 3 * S, H_ - b + 3 * S), 11 * S,
                                           outline=(150, 112, 40, 200) if serial else (205, 198, 184, 255), width=S)
    small = card.resize((cw, ch), Image.LANCZOS)
    return (small, card, box) if keep_big else small


def slab(card, label_left, label_right, accent=(255, 107, 44)):
    """A graded-card case around `card`: label on top, the same clear margin on every side. label_left: [(text, kind)]
    with kind in set|name|line; label_right: (big, small)."""
    cw, ch = card.size
    M, lh = 30, 150
    sw, sh = cw + 2 * M, M + lh + 24 + ch + M
    im = Image.new("RGBA", (sw * S, sh * S))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, sw * S - 1, sh * S - 1), 26 * S, fill=(112, 120, 136, 235), outline=(196, 204, 218, 235), width=4 * S)  # slate plastic
    d.rounded_rectangle((12 * S, 12 * S, (sw - 12) * S, (sh - 12) * S), 20 * S, outline=(255, 255, 255, 55), width=2 * S)
    lx, ly, lw = M * S, M * S, (sw - 2 * M) * S
    d.rounded_rectangle((lx, ly, lx + lw, ly + lh * S), 8 * S, fill=(250, 250, 247), outline=accent, width=5 * S)
    y = ly + 18 * S
    for text, kind in label_left:
        f = {"set": MONO(14 * S), "name": None, "line": MONO(13 * S)}[kind]
        if kind == "name":
            f = _fit(d, text, lambda s: COND(s * S), 38, lw - 180 * S)
        d.text((lx + 18 * S, y), text, font=f, fill=(28, 24, 22) if kind != "line" else (92, 86, 80))
        y += {"set": 24, "name": 46, "line": 22}[kind] * S
    big, small = label_right
    cx = lx + lw - 72 * S
    d.line((lx + lw - 144 * S, ly + 18 * S, lx + lw - 144 * S, ly + (lh - 18) * S), fill=(205, 200, 194), width=2 * S)
    d.text((cx, ly + 62 * S), big, font=_fit(d, big, lambda s: COND(s * S), 54, 120 * S), fill=(28, 24, 22), anchor="mm")
    d.text((cx, ly + 112 * S), small, font=MONO(12 * S), fill=(92, 86, 80), anchor="mm")
    # card well
    d.rounded_rectangle(((M - 6) * S, (M + lh + 18) * S, (sw - M + 5) * S, (sh - M + 5) * S), 22 * S, outline=(255, 255, 255, 50), width=2 * S)
    im = im.resize((sw, sh), Image.LANCZOS)
    im.alpha_composite(card, (M, M + lh + 24))
    # glare across the plastic
    gl = Image.new("RGBA", (sw, sh))
    ImageDraw.Draw(gl).polygon([(sw * 0.58, 0), (sw * 0.78, 0), (sw * 0.22, sh), (0, sh), (0, sh * 0.92)], fill=(255, 255, 255, 26))
    gl = gl.filter(ImageFilter.GaussianBlur(12))
    im.alpha_composite(Image.composite(gl, Image.new("RGBA", (sw, sh)), im.getchannel("A").point(lambda v: 255 if v else 0)))
    return im


def loupe(big, box, diameter, zoom=1.0):
    """A round close-up of the serial stamp, cut from the 3x render."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    r = int(max(x1 - x0, y1 - y0) * 0.8 / zoom)
    crop = big.crop((cx - r, cy - r, cx + r, cy + r)).resize((diameter, diameter), Image.LANCZOS)
    m = Image.new("L", (diameter * S, diameter * S), 0)
    ImageDraw.Draw(m).ellipse((0, 0, diameter * S - 1, diameter * S - 1), fill=255)
    m = m.resize((diameter, diameter), Image.LANCZOS)
    out = Image.new("RGBA", (diameter + 24, diameter + 24))
    ring = Image.new("RGBA", ((diameter + 24) * S, (diameter + 24) * S))
    ImageDraw.Draw(ring).ellipse((0, 0, ring.width - 1, ring.height - 1), fill=(30, 30, 34, 255), outline=(200, 200, 210, 255), width=3 * S)
    out.alpha_composite(ring.resize(out.size, Image.LANCZOS))
    crop.putalpha(m)
    out.alpha_composite(crop, (12, 12))
    return out


def back(f, I, bw, bh):
    """The back of the card: cardstock, header with the card number, the chase as a stat table, a fun-fact box."""
    lead, tc = I["lead"], I["tc"]
    card = Image.new("RGBA", (bw, bh))
    stock = linear((bw, bh), (226, 214, 190), (204, 190, 164))
    card.alpha_composite(rounded(stock, 18))
    d = DR(card)
    d.rounded_rectangle((14, 14, bw - 15, bh - 15), 12, outline=mix(tc, (0, 0, 0), 0.2), width=4)
    d.rectangle((28, 28, bw - 29, 118), fill=mix(tc, (0, 0, 0), 0.2))
    d.ellipse((40, 43, 100, 103), fill=A)
    d.text((70, 74), "1", font=COND(40), fill=(16, 14, 14), anchor="mm")
    d.text((118, 40), I["name"].upper(), font=fit_font(d, I["name"].upper(), COND, 40, bw - 170, 22), fill=(255, 255, 255))
    d.text((120, 98), I["meta"].upper(), font=INTER(14, 800), fill=(235, 230, 220), anchor="lm")
    d.text((44, 136), f["title"].upper(), font=fit_font(d, f["title"].upper(), OSW, 30, bw - 90, 18), fill=INK)
    y = 184
    cols = (44, 92, bw - 44)
    d.text((cols[0], y), "RK", font=MONO(14), fill=(100, 90, 80))
    d.text((cols[1], y), "PLAYER" if I["player"] else "TEAM", font=MONO(14), fill=(100, 90, 80))
    d.text((cols[2], y), f["unit"].upper()[:26], font=MONO(14), fill=(100, 90, 80), anchor="ra")
    y += 26
    rh = 40
    for i, (p, v, s) in enumerate(I["rows"]):
        if i % 2 == 0:
            d.rectangle((36, y - 4, bw - 36, y + rh - 8), fill=(255, 255, 255, 70))
        ink = (180, 60, 20) if i == 0 else INK
        d.text((cols[0], y + 14), f"{i + 1}", font=MONO(20), fill=ink, anchor="lm")
        nm = who(p, f) + (f"  {p['team']}" if I["player"] else "")
        d.text((cols[1], y + 14), R.fit(d, nm, MONO(19), cols[2] - cols[1] - 140), font=MONO(19), fill=ink, anchor="lm")
        d.text((cols[2], y + 14), s, font=MONO(20), fill=ink, anchor="rm")
        y += rh
    # fun fact box
    y += 8
    box_h = bh - 52 - y
    if box_h > 50:
        d.rounded_rectangle((36, y, bw - 36, y + box_h), 10, fill=(255, 250, 236), outline=INK, width=2)
        d.text((56, y + 16), "DID YOU KNOW?", font=MONO(18), fill=(180, 60, 20))
        fact_ = f["text"].split(". ")[0].rstrip(".") + "."
        size = 32  # as big as fits the box (up to 3 lines)
        while size > 16:
            lines = wrap(d, fact_, INTER(size, 600), bw - 120, 3)
            if " ".join(lines) == " ".join(fact_.split()) and 50 + len(lines) * size * 1.3 <= box_h - 12:
                break
            size -= 1
        for k, line in enumerate(lines):
            d.text((56, y + 50 + k * size * 1.3), line, font=INTER(size, 600), fill=INK)
    d.text((bw - 44, bh - 30), "© 2026 CUPCAKE INDEX", font=MONO(11), fill=(110, 100, 88), anchor="rs")
    return card


def bg_dark(tc):
    img = linear((W, H), mix(tc, (10, 10, 12), 0.82), (6, 6, 8))
    d = DR(img)
    for gx in range(0, W, 40):
        d.line((gx, 0, gx, H), fill=(255, 255, 255, 5))
    for gy in range(0, H, 40):
        d.line((0, gy, W, gy), fill=(255, 255, 255, 5))
    return img, d


def headline(d, f, I, x0, xr, y=40, title_size=84, bx=None):
    obscure_brand(d, bx or xr, y + 4)
    d.text((x0, y), f"{f['league'].upper()} · {I['tag']}", font=INTER(18, 800), fill=A)
    tf = fit_font(d, f["title"].upper(), COND, title_size, xr - x0, 44)
    d.text((x0, y + 30), f["title"].upper(), font=tf, fill=(255, 255, 255))
    yy = y + 36 + tf.size
    for line in wrap(d, f["sub"], INTER(20), xr - x0, 2):
        d.text((x0, yy), line, font=INTER(20), fill=(165, 165, 175))
        yy += 27
    return yy


def obscure_brand(d, xr, y):
    bf = R.font(20, "Bold")
    parts = [(">", A), (" CUPCAKE", (255, 255, 255)), ("_INDEX", A)]
    x = xr - sum(d.textlength(t, font=bf) for t, _ in parts)
    for t, c in parts:
        d.text((x, y), t, font=bf, fill=c)
        x += d.textlength(t, font=bf)


def tiles(d, f, I, x0, xr, y):
    """The headline number in an orange tile, then facts about the leader. Returns the y below them."""
    lead = I["lead"]
    if I["player"]:
        extra = [(lead["team"], "TEAM"), ((lead.get("pos") or "").upper(), "POSITION"), (lead.get("draft") or "", "DRAFTED")]
    else:
        extra = [(lead.get("record", ""), "RECORD"), (f"#{lead['power_rank']}" if lead.get("power_rank") else "", "OUR RANK")]
    items = [(I["big"], I["unit"], True)] + [(v, k, False) for v, k in extra if v]
    x = x0
    for val, lab, main in items:
        w = (290 if len(val) > 6 else 220) if main else 150
        if x + w > xr:
            break
        d.rounded_rectangle((x, y, x + w, y + 128), 16, fill=A if main else (28, 28, 34), outline=None if main else (55, 55, 64), width=2)
        vf = fit_font(d, val, COND, 70, w - 32, 24)
        d.text((x + 16, y + 12 + (70 - vf.size) // 2), val, font=vf, fill=(12, 12, 14) if main else (255, 255, 255))
        for k, line in enumerate(wrap(d, lab, INTER(13, 800), w - 32, 2)[-2:]):
            d.text((x + 18, y + 128 - 42 + k * 17), line, font=INTER(13, 800), fill=(12, 12, 14) if main else (150, 150, 160))
        x += w + 12
    return y + 128


def chase_bars(img, d, f, I, x0, xr, y, bottom):
    """The top 5: photo, name and team, a segmented bar, the number."""
    rows = I["rows"]
    d.text((x0, y), "THE CHASE", font=INTER(16, 800), fill=(150, 150, 160))
    y += 30
    rh = min(70, (bottom - y) // len(rows))
    vmax = max(abs(v) for _, v, _ in rows) or 1
    vf = COND(38)
    val_w = max(d.textlength(s_, font=vf) for _, _, s_ in rows)
    av = rh - 14
    for i, (p, v, s_) in enumerate(rows):
        cy = y + i * rh + rh // 2
        col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 80)
        pic = IMG(p.get("pic")) if I["player"] else None
        img.alpha_composite(circle(pic if pic else LOGO(p), av, mix(col, (0, 0, 0), 0.35), A if i == 0 else None, 3,
                                   logo=not pic), (x0, cy - av // 2))
        ink = (255, 255, 255) if i == 0 else (205, 205, 212)
        bx0, bx1 = x0 + 290, int(xr - val_w - 26)
        d.text((x0 + av + 16, cy - (10 if I["player"] else 0)), R.fit(d, who(p, f), INTER(20, 700), bx0 - x0 - av - 28), font=INTER(20, 700), fill=ink, anchor="lm")
        if I["player"]:
            d.text((x0 + av + 16, cy + 14), p["team"], font=INTER(13, 600), fill=(130, 130, 140), anchor="lm")
        seg = 20
        nseg = max(1, int((bx1 - bx0) / seg))
        on = max(1, round(nseg * min(1, abs(v) / vmax)))
        for k in range(nseg):
            sx = bx0 + k * seg
            d.rounded_rectangle((sx, cy - 8, sx + seg - 6, cy + 8), 3, fill=(A if i == 0 else col) if k < on else (34, 34, 40))
        d.text((xr, cy), s_, font=vf, fill=A if i == 0 else ink, anchor="rm")


def drop(img, im, x, y, blur=24, alpha=0.6, off=(10, 18)):
    s, pad = shadow(im, blur, alpha)
    img.alpha_composite(s, (x - pad + off[0], y - pad + off[1]))
    img.alpha_composite(im, (x, y))


def badge(n, size=60):
    """Smooth orange circle with the rank in it."""
    big = Image.new("RGBA", (size * 3, size * 3))
    d = ImageDraw.Draw(big)
    d.ellipse((0, 0, size * 3 - 1, size * 3 - 1), fill=A)
    d.text((size * 1.5, size * 1.55), str(n), font=COND(int(size * 2.1)), fill=(16, 14, 14), anchor="mm")
    return big.resize((size, size), Image.LANCZOS)


def brand(d, y=44):
    obscure_brand(d, W - 60, y)


def footer(d):
    d.text((W - 60, H - 18), "cupcakeindex.com", font=R.font(16), fill=(130, 130, 140), anchor="rs")


def p1(f, I):
    """Front + back, side by side, same top and bottom."""
    img, d = bg_dark(I["tc"])
    d.text((60, 36), f"{f['league'].upper()} · {I['tag']}", font=INTER(18, 800), fill=A)
    brand(d, 40)
    tf = fit_font(d, f["title"].upper(), COND, 80, 900, 40)
    d.text((60, 62), f["title"].upper(), font=tf, fill=WHITE)
    d.text((62, 62 + tf.size + 8), f["sub"], font=INTER(20), fill=(165, 165, 175))
    # the number, right-aligned on the title line
    vf = COND(96)
    d.text((W - 60, 70), I["big"], font=vf, fill=A, anchor="ra")
    vw = d.textlength(I["big"], font=vf)
    d.text((W - 60 - vw - 16, 126), I["unit"], font=INTER(15, 800), fill=(200, 200, 210), anchor="ra")
    top, bottom = 220, H - 50
    ch = bottom - top
    cw = int(ch / 1.4)
    fr = front(I, cw, ch, rookie=I["lead"].get("yr") == 1)
    drop(img, fr, 60, top)
    bx = 60 + cw + 36
    bk = back(f, I, W - 60 - bx, ch)
    bk.alpha_composite(badge(1, 60), (40, 43))
    drop(img, bk, bx, top)
    footer(d)
    return grain(img, 0.16)


def p2(f, I):
    """Graded slab + stat tiles + the chase."""
    img, d = bg_dark(I["tc"])
    glow = Image.new("RGBA", (W, H))
    ImageDraw.Draw(glow).ellipse((20, 60, 660, 860), fill=lift(I["tc"], 90) + (110,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(110)))
    card = front(I, 400, 560, rookie=I["lead"].get("yr") == 1)
    sl = slab(card, [("2026 CUPCAKE INDEX", "set"), (I["name"].upper(), "name"), (f["title"].upper(), "line"), (I["meta"].upper(), "line")],
                (I["big"], "#1 IN THE NFL"))
    sl = sl.resize((int(sl.width * (H - 90) / sl.height), H - 90), Image.LANCZOS)
    drop(img, sl, 80, (H - sl.height) // 2, 34, 0.75, (22, 26))
    x0, xr = 640, W - 60
    yy = headline(d, f, I, x0, xr, 40, 80)
    ty = tiles(d, f, I, x0, xr, yy + 14)
    chase_bars(img, d, f, I, x0, xr, ty + 26, H - 50)
    footer(d)
    return grain(img, 0.16)


def numbered(q, image, team_logo):
    """A QB's big game as a gold numbered parallel: his completions/attempts are the serial (30/36).
    q: name, team (abbreviation), color, logo, pic (urls), c, a, yds, td, ints, wl (W/L), res ("BEARS 31-23"),
    short ("BEARS 31 @ FALCONS 23"), score ("Bears 31, Falcons 23"), when ("Week 6"), league, why (one line)."""
    _use(image, team_logo)
    lead = {"name": q["name"], "team": q["team"], "pos": "QB", "color": q["color"], "logo": q["logo"]}
    pic = IMG(q.get("pic"))
    pic = pic.crop(pic.getbbox()) if pic is not None and pic.getbbox() else None
    tc = hex_rgb(q["color"] or "", (90, 90, 96))
    serial = f"{q['c']}/{q['a']}"
    pct = f"{100 * q['c'] / q['a']:.1f}"
    I = {"lead": lead, "tc": tc, "pic": pic, "logo": LOGO(lead), "name": q["name"], "meta": f"QB · {q['team']}"}
    img, d = bg_dark(tc)
    glow = Image.new("RGBA", (W, H))
    ImageDraw.Draw(glow).ellipse((20, 60, 660, 860), fill=lift(tc, 110) + (110,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(110)))
    card, big, box = front(I, 400, 560, serial=serial, keep_big=True)
    sl = slab(card, [(" · ".join(x for x in ("2026 CUPCAKE INDEX", q["when"].upper()) if x), "set"), (q["name"].upper(), "name"), (f"GOLD · #'D {serial}", "line"), (q["short"], "line")],
                (pct, "CMP %"), accent=(196, 150, 60))
    sl = sl.resize((int(sl.width * (H - 90) / sl.height), H - 90), Image.LANCZOS)
    drop(img, sl, 80, (H - sl.height) // 2, 34, 0.75, (22, 26))
    x0, xr = 640, W - 60
    d.text((x0, 40), f"{q['league'].upper()} · NUMBERED CARD", font=INTER(18, 800), fill=(214, 168, 70))
    brand(d, 44)
    d.text((x0, 66), q["name"].upper(), font=fit_font(d, q["name"].upper(), COND, 80, xr - x0, 44), fill=WHITE)
    d.text((x0 + 2, 156), " · ".join(x for x in (q["when"], q["score"]) if x), font=INTER(21), fill=(165, 165, 175))
    # the close-up of the stamp, like a collector's photo of the serial
    lp = loupe(big, box, 250, zoom=1.0)
    img.alpha_composite(lp, (x0 - 12, 205))
    tx = x0 + 270
    d.text((tx, 246), "SERIAL NUMBERED", font=INTER(15, 800), fill=(214, 168, 70))
    d.text((tx, 270), serial, font=INTER(54, 700), fill=WHITE)
    d.text((tx, 344), f"Numbered to his attempts: {q['c']} completions", font=INTER(20, 600), fill=(225, 225, 232))
    d.text((tx, 372), f"on {q['a']} throws, {pct}%.", font=INTER(20, 600), fill=(225, 225, 232))
    ty = 500
    xx = x0
    for val, lab in ((f"{q['yds']}", "PASS YDS"), (f"{q['td']}", "PASS TD"), (f"{q['ints']}", "INT"), (q["wl"], q["res"])):
        w = 210
        d.rounded_rectangle((xx, ty, xx + w, ty + 130), 16, fill=(28, 28, 34), outline=(55, 55, 64), width=2)
        d.text((xx + 18, ty + 12), val, font=COND(72), fill=WHITE)
        d.text((xx + 20, ty + 96), lab, font=INTER(13, 800), fill=(150, 150, 160))
        xx += w + 14
    d.rectangle((x0, 676, x0 + 5, 730), fill=(214, 168, 70))
    for k, line in enumerate(wrap(d, q["why"][0].upper() + q["why"][1:] + ".", INTER(22, 600), xr - x0 - 20, 2)):
        d.text((x0 + 20, 676 + k * 30), line, font=INTER(22, 600), fill=(210, 210, 218))
    footer(d)
    return grain(img, 0.16)


def face(p, f, rank, cw, ch, lead=False, big=False):
    """A playing card: rank and team logo in two corners, the player in a centered oval, name and team centered."""
    w, h = cw * S, ch * S
    tc = hex_rgb(p.get("color") or "", (90, 90, 96))
    im = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(im)
    # team-color frame: a light-to-dark sheen with thin diagonal pinstripes, then the white playing surface inside
    B = 17 * S
    frame = Image.new("RGBA", (w, h))
    fd = ImageDraw.Draw(frame)
    hi, lo = lift(tc, 55), mix(tc, (0, 0, 0), 0.35)
    for y in range(0, h, S):
        t = y / h
        fd.rectangle((0, y, w, y + S), fill=mix(hi, lo, t) + (255,))
    stripe = lift(tc, 95) + (70,)
    for x in range(-h, w, 9 * S):
        fd.line((x, h, x + h, 0), fill=stripe, width=2 * S)
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), 18 * S, fill=255)
    frame.putalpha(m)
    im.alpha_composite(frame)
    d.rounded_rectangle((0, 0, w - 1, h - 1), 18 * S, outline=A if lead else mix(tc, (0, 0, 0), 0.5), width=(5 if lead else 2) * S)
    d.rounded_rectangle((B - 3 * S, B - 3 * S, w - B + 3 * S, h - B + 3 * S), 12 * S, fill=(255, 255, 255))
    d.rounded_rectangle((B, B, w - B, h - B), 10 * S, fill=(251, 250, 246), outline=mix(tc, (255, 255, 255), 0.55), width=S)
    logo = LOGO(p)
    # corner indices: rank over the team logo, top left and (upside down) bottom right
    corner = Image.new("RGBA", (48 * S, 90 * S))
    cd = ImageDraw.Draw(corner)
    cd.text((24 * S, 4 * S), str(rank), font=COND(40 * S), fill=A, anchor="ma")
    if logo:
        lg = logo.copy()
        lg.thumbnail((30 * S, 30 * S), Image.LANCZOS)
        corner.alpha_composite(lg, ((48 * S - lg.width) // 2, 50 * S))
    im.alpha_composite(corner, (B + 4 * S, B + 4 * S))
    im.alpha_composite(corner.rotate(180), (w - B - 4 * S - corner.width, h - B - 4 * S - corner.height))
    # centered oval portrait, dead center so the card reads the same upside down
    ow, oh = int(w * 0.62), int(h * 0.60)
    ox, oy = (w - ow) // 2, (h - oh) // 2
    ry = h // 2 + int(h * 0.19)     # ribbon center: across the chest, between the corner indices
    ring = 5 * S
    bh = 32 * S
    # the ribbon wraps around the portrait: its back half shows outside the oval, a little higher (seen from above),
    # with swallowtail ends; the front half crosses the chest and is cut off by the oval's edge
    back_y = ry - 15 * S
    half_at = (ow / 2 + ring) * math.sqrt(max(0.0, 1 - ((ry - h / 2) / (oh / 2 + ring)) ** 2))
    tail, notch = 21 * S, 9 * S
    dark, darker = mix(tc, (0, 0, 0), 0.2), mix(tc, (0, 0, 0), 0.55)
    for sgn in (-1, 1):
        inner = w / 2 + sgn * (half_at - 20 * S)
        out = w / 2 + sgn * (half_at + tail)
        t0, t1 = back_y - bh * 0.42, back_y + bh * 0.42
        d.polygon([(inner, t0), (out, t0), (out - sgn * notch, back_y), (out, t1), (inner, t1)], fill=dark)
        # shadow where the ribbon turns around the back of the frame
        d.polygon([(inner, t0), (w / 2 + sgn * (half_at + 6 * S), t0), (w / 2 + sgn * (half_at + 6 * S), t1), (inner, t1)], fill=darker)
    d.ellipse((ox - ring, oy - ring, ox + ow + ring, oy + oh + ring), fill=A if lead else mix(tc, (255, 255, 255), 0.2))
    bg = Image.new("RGBA", (ow, oh), mix(tc, (0, 0, 0), 0.25) + (255,))
    gl = Image.new("RGBA", (ow, oh))
    ImageDraw.Draw(gl).ellipse((-ow * 0.2, oh * 0.15, ow * 1.2, oh * 1.3), fill=lift(tc, 120) + (255,))
    bg.alpha_composite(gl.filter(ImageFilter.GaussianBlur(30 * S)))
    pic = IMG(p.get("pic")) if f["kind"] == "player" else None
    if pic is not None and pic.getbbox():
        pic = pic.crop(pic.getbbox())
        # the headshot fills the oval down to the bottom; the ribbon crosses his chest
        ph = oh
        pic = pic.resize((int(pic.width * ph / pic.height), ph), Image.LANCZOS)
        bg.alpha_composite(pic, ((ow - pic.width) // 2, int(oh * 0.03)))
    elif logo:
        lg = logo.copy()
        lg.thumbnail((int(ow * 0.7), int(oh * 0.7)), Image.LANCZOS)
        bg.alpha_composite(lg, ((ow - lg.width) // 2, (oh - lg.height) // 2))
    m = Image.new("L", (ow, oh), 0)
    ImageDraw.Draw(m).ellipse((0, 0, ow - 1, oh - 1), fill=255)
    bg.putalpha(m)
    im.alpha_composite(bg, (ox, oy))
    # front half: parchment band clipped to the oval's outer edge, shaded darker toward the sides where it bends away
    band = Image.new("RGBA", (w, h))
    bd = ImageDraw.Draw(band)
    by0, by1 = ry - bh // 2, ry + bh // 2
    paper, shade = (244, 236, 216), (176, 160, 130)
    x0, x1 = int(w / 2 - half_at), int(w / 2 + half_at)
    for x in range(x0, x1 + 1, S):
        u = abs(x - w / 2) / half_at
        bd.rectangle((x, by0, x + S, by1), fill=mix(paper, shade, max(0.0, (u - 0.55) / 0.45) ** 1.6))
    rim = mix(tc, (255, 255, 255), 0.35)
    bd.line((x0, by0 + 4 * S, x1, by0 + 4 * S), fill=rim, width=2 * S)
    bd.line((x0, by1 - 4 * S, x1, by1 - 4 * S), fill=rim, width=2 * S)
    clip = Image.new("L", (w, h), 0)
    ImageDraw.Draw(clip).ellipse((ox - ring, oy - ring, ox + ow + ring, oy + oh + ring), fill=255)
    band.putalpha(Image.composite(band.getchannel("A"), Image.new("L", (w, h), 0), clip))
    im.alpha_composite(band)
    name = who(p, f).upper()
    nf = _fit(d, name, lambda s: COND(s * S), 28, 2 * half_at - 44 * S)
    d.text((w // 2, ry + S), name, font=nf, fill=INK, anchor="mm")
    return im if big else im.resize((cw, ch), Image.LANCZOS)


def hand(f, I):
    img, d = bg_dark(I["tc"])
    glow = Image.new("RGBA", (W, H))
    ImageDraw.Draw(glow).ellipse((W * 0.15, H * 0.3, W * 0.85, H * 1.3), fill=mix(I["tc"], (40, 30, 30), 0.5) + (110,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(100)))
    d.text((60, 36), f"{f['league'].upper()} · {I['tag']}", font=INTER(18, 800), fill=A)
    obscure_brand(d, W - 60, 40)
    tf = fit_font(d, f["title"].upper(), COND, 76, W - 520, 40)
    d.text((60, 62), f["title"].upper(), font=tf, fill=(255, 255, 255))
    d.text((62, 62 + tf.size + 6), f["sub"], font=INTER(20), fill=(165, 165, 175))
    cw, ch = 236, 330
    # a real hand: every card on one arc around a pivot below the canvas, so the two sides mirror exactly,
    # and each card tucks a little under its neighbour toward the middle
    step = 7.5                       # degrees between cards
    radius = 1820                    # pivot distance: sets how far apart the cards sit (and how much they overlap)
    px, py = W / 2, 455 + radius     # the leader's centre sits at y = 455
    labels = []
    order = [(3, -2), (4, 2), (1, -1), (2, 1), (0, 0)]  # outside in, the leader last (on top)
    for idx, slot in order:
        if idx >= len(I["rows"]):
            continue
        p, v, s = I["rows"][idx]
        k = 1.16 if idx == 0 else 1
        cwk, chk = int(cw * k), int(ch * k)
        ang = slot * step
        a = math.radians(ang)
        cx = px + radius * math.sin(a)
        cy = py - radius * math.cos(a) - (14 if idx == 0 else 0)
        # rotate at 3x, then scale down: smooth edges instead of stair steps
        big = face(p, f, idx + 1, cwk, chk, lead=idx == 0, big=True).rotate(-ang, resample=Image.BICUBIC, expand=True)
        c = big.resize((round(big.width / S), round(big.height / S)), Image.LANCZOS)
        x, y = round(cx - c.width / 2), round(cy - c.height / 2)
        sh, pad = shadow(c, 18, 0.6)
        img.alpha_composite(sh, (x - pad + 8, y - pad + 14))
        img.alpha_composite(c, (x, y))
        # the number under the card, tilted with it so it runs parallel to the card's bottom edge
        vf = COND((54 if idx == 0 else 42) * S)
        tw = int(ImageDraw.Draw(Image.new("RGBA", (1, 1))).textlength(s, font=vf)) + 20 * S
        lay = Image.new("RGBA", (tw, vf.size + 20 * S))
        ImageDraw.Draw(lay).text((tw // 2, lay.height // 2), s, font=vf, fill=A if idx == 0 else (235, 235, 240), anchor="mm")
        lay = lay.rotate(-ang, resample=Image.BICUBIC, expand=True)
        lay = lay.resize((round(lay.width / S), round(lay.height / S)), Image.LANCZOS)
        dist = chk / 2 + 44
        lx, ly = cx - math.sin(a) * dist, cy + math.cos(a) * dist
        labels.append((lay, lx, ly))
    for lay, lx, ly in labels:
        img.alpha_composite(lay, (round(lx - lay.width / 2), round(ly - lay.height / 2)))
    # what the numbers are, in the open space under the hand (otherwise it's only in the fine print up top)
    label = (f.get("label") or re.split(r"[,·(]", f.get("sub") or "")[0].strip() or I["unit"]).upper()
    lf = fit_font(d, label, COND, 40, W - 400, 24)
    d.text((W // 2, 800), label, font=lf, fill=(235, 235, 240), anchor="mm")
    lw = d.textlength(label, font=lf)
    for sgn in (-1, 1):
        x = W // 2 + sgn * (lw / 2 + 24)
        d.line((x, 800, x + sgn * 90, 800), fill=A, width=3)
    d.text((W - 60, H - 18), "cupcakeindex.com", font=R.font(16), fill=(130, 130, 140), anchor="rs")
    return grain(img, 0.16)


# the looks, called like card_looks: look(f, A, image, team_logo)
def look_slab(f, A_, image, team_logo):
    _use(image, team_logo)
    return p2(f, info(f, image, team_logo))


def look_frontback(f, A_, image, team_logo):
    _use(image, team_logo)
    return p1(f, info(f, image, team_logo))


def look_hand(f, A_, image, team_logo):
    _use(image, team_logo)
    return hand(f, info(f, image, team_logo))
