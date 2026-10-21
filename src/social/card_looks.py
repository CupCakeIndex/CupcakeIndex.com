"""The stat card's other looks, rotated with the broadcast look (flare_card.py) so the feed doesn't repeat one layout
(Terry, 2026-10-21: "rotate all of the concept types... just keep the color theme consistent"). All use the site's
orange and the team's colors:
  poster   team-color halftone, stacked title, giant number over the player's shoulder, top 5 strip along the bottom
  podium   dark arena, top 5 as columns with the leader in the middle (heights by rank, values on top)
  trading  a tilted rookie-card-style card of the leader, info tiles, and "the chase" with segmented bars
Each takes the same fact as flare_card.draw and handles players, teams (logo instead of a photo) and hot takes.
"""
from PIL import Image, ImageDraw

import render as R
from flare_card import COND, DR, H, INTER, W, _font, circle, fade_bottom, fit_font, grad_text, grain, lift, linear, mix, \
    rounded, shadow, text_layer, wrap
from render import hex_rgb, short


def OSW(s, w=700):
    return _font("Oswald.ttf", s, w)


def info(f, image, team_logo):
    """What every look needs from a fact."""
    (lead, _, big), rows = f["rows"][0], f["rows"][:5]
    player = f["kind"] == "player"
    big = f.get("big") or big
    unit = f["unit"].upper()
    if " +" in big and big.endswith("FCS"):  # "2-7 +2 FCS": big number 2-7, FCS games in the label
        big, extra = big.split(" +", 1)
        unit += f" (PLUS {extra})"
    unit = f.get("big_unit", "").upper() or unit
    pic = image(lead.get("pic")) if player else None
    if pic and f.get("costume"):
        pic = f["costume"](pic.copy(), lead)
    if pic is not None and pic.getbbox():
        pic = pic.crop(pic.getbbox())
    else:
        pic = None
    meta = " · ".join(x for x in (lead.get("pos"), lead["team"], lead.get("draft")) if x) if player else \
        (f"{lead.get('record', '')} · #{lead['power_rank']} in our rankings" if lead.get("power_rank") else lead.get("record", ""))
    tc = hex_rgb(lead.get("color") or "", (90, 90, 96))
    return {"lead": lead, "rows": rows, "big": big, "unit": unit, "player": player, "pic": pic, "meta": meta, "tc": tc,
            "hot": lift(tc, 95), "logo": team_logo(lead), "name": lead.get("name") or lead["team"],
            "tag": (f.get("tag") or ("HOT TAKE" if f["hot"] else "BY THE NUMBERS")).upper()}


def who(p, f):
    return p.get("name") or short(p["team"], f["league"])


def face(p, f, size, image, team_logo, ring=None, ring_w=1):
    col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 80)
    if f["kind"] == "player":
        return circle(image(p.get("pic")), size, mix(col, (0, 0, 0), 0.35), ring, ring_w)
    return circle(team_logo(p), size, (24, 26, 32), ring, ring_w, logo=True)


def brand(d, x, y, A, size=24, right=False):
    bf = R.font(size, "Bold")
    parts = [(">", A), (" CUPCAKE", (255, 255, 255)), ("_INDEX", A)]
    w = sum(d.textlength(t, font=bf) for t, _ in parts)
    cx = x - w if right else x
    for t, c in parts:
        d.text((cx, y), t, font=bf, fill=c)
        cx += d.textlength(t, font=bf)


def callout(d, q, x, y, max_w, A, size=22):
    """The hot take's closing line, with an accent bar. Returns the y below it."""
    lines = wrap(d, q, INTER(size, 700), max_w - 26, 2)
    d.rectangle((x, y - 2, x + 6, y + 34 * len(lines) - 6), fill=A)
    for i, line in enumerate(lines):
        d.text((x + 22, y + i * 34), line, font=INTER(size, 700), fill=(255, 255, 255))
    return y + 34 * len(lines)


# ------------------------------------------------------------------ poster
def poster(f, A, image, team_logo):
    I = info(f, image, team_logo)
    tc, hot, rows = I["tc"], I["hot"], I["rows"]
    img = linear((W, H), mix(hot, (255, 255, 255), 0.05), mix(tc, (0, 0, 0), 0.55))
    d = DR(img)
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for y in range(0, 640, 22):
        for x in range(0, W, 22):
            r = 1 + 6 * max(0, 1 - ((x - 1250) ** 2 + (y - 120) ** 2) ** 0.5 / 700)
            dd.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, 38))
    img.alpha_composite(dots)
    # hero: the player (or logo) right of center, the number over its shoulder
    if I["pic"]:
        pic = I["pic"].resize((int(I["pic"].width * 640 / I["pic"].height), 640), Image.LANCZOS)
        x = min(640, W - 120 - pic.width)
        s, pad = shadow(pic, 20, 0.55)
        img.alpha_composite(s, (x - pad + 12, 640 - pic.height - pad + 12))
        img.alpha_composite(pic, (x, 640 - pic.height))
    elif I["logo"]:
        lg = I["logo"].copy()
        lg.thumbnail((470, 470), Image.LANCZOS)
        x, y = 1010 - lg.width // 2, 330 - lg.height // 2
        s, pad = shadow(lg, 18, 0.55)
        img.alpha_composite(s, (x - pad + 14, y - pad + 18))
        img.alpha_composite(lg, (x, y))
    short_big = len(I["big"]) <= 6
    if short_big:
        num = text_layer(I["big"], OSW(430 if len(I["big"]) <= 3 else 300))
        numc = Image.new("RGBA", num.size, A + (255,))
        numc.putalpha(num.getchannel("A"))
        s, pad = shadow(numc, 22, 0.75)
        nx, ny = W - num.width - 70, 632 - num.height
        img.alpha_composite(s, (nx - pad + 12, ny - pad + 18))
        img.alpha_composite(numc, (nx, ny))
    brand(d, 60, 48, A)
    # left column: stacked title, sub, leader. Laid out at the biggest size that fits above the strip (y 600).
    _, lines = I_title(f["title"].upper(), d)
    colw = 580 if I["pic"] or I["logo"] else 1000

    def column(scale, draw):
        y = 100
        tf = fit_font(d, max(lines, key=len), lambda s: OSW(s, 700), int(120 * scale), colw, 40)
        for line in lines:
            box = d.textbbox((60, y), line, font=tf)
            if draw:
                d.text((60, y), line, font=tf, fill=(255, 255, 255))
            y = box[3] + int(tf.size * 0.12)
        sf = INTER(max(16, int(22 * min(1, scale + 0.15))), 600)
        for line in wrap(d, f["sub"], sf, colw, 2):
            if draw:
                d.text((64, y + 4), line, font=sf, fill=(235, 240, 238))
            y += sf.size + 8
        y += 16
        if draw:
            d.rectangle((64, y, 154, y + 6), fill=A)
        y += 20
        if not short_big:  # a headline like "Unranked" or "+57 vs Kent State" goes here instead of the giant number
            hf = fit_font(d, I["big"], lambda s: OSW(s, 700), int(72 * scale), colw, 30)
            box = d.textbbox((62, y), I["big"], font=hf)
            if draw:
                d.text((62, y - (box[1] - y)), I["big"], font=hf, fill=A)
            y += box[3] - box[1] + 14
        nf = fit_font(d, I["name"].upper(), lambda s: OSW(s, 600), int(52 * scale), colw, 26)
        box = d.textbbox((64, y), I["name"].upper(), font=nf)
        if draw:
            d.text((64, y - (box[1] - y)), I["name"].upper(), font=nf, fill=(255, 255, 255))
        y += box[3] - box[1] + 12
        if draw:
            d.text((64, y), R.fit(d, I["meta"], INTER(20, 500), colw), font=INTER(20, 500), fill=(220, 228, 224))
        y += 30
        if f.get("question"):
            y = callout(d, f["question"], 64, y + 10, colw, A, 20) if draw else y + 10 + 34 * len(wrap(d, f["question"], INTER(20, 700), colw - 26, 2))
        return y

    scale = 1.0
    while scale > 0.5 and column(scale, False) > 610:
        scale -= 0.05
    column(scale, True)
    # bottom strip: the top 5
    d.rectangle((0, 640, W, H), fill=(12, 12, 14))
    d.rectangle((0, 640, W, 646), fill=A)
    n = len(rows)
    cw = (W - 120) // max(5, n)
    for i, (p, v, s_) in enumerate(rows):
        cx = 60 + i * cw
        col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 80)
        img.alpha_composite(face(p, f, 120, image, team_logo, A if i == 0 else col, 4), (cx, 690))
        d.text((cx + 140, 688), f"#{i + 1}", font=INTER(18, 800), fill=A if i == 0 else (140, 140, 150))
        vf = fit_font(d, s_, lambda s: OSW(s, 700), 58, cw - 156, 22)
        d.text((cx + 140, 712 + (58 - vf.size) // 2), R.fit(d, s_, vf, cw - 156), font=vf, fill=(255, 255, 255))
        label = who(p, f)
        label = label.split()[-1] if I["player"] and " " in label else label
        d.text((cx + 140, 790), R.fit(d, label.upper(), INTER(17, 700), cw - 150), font=INTER(17, 700), fill=(210, 210, 215))
        if I["player"]:
            d.text((cx + 140, 812), p["team"], font=INTER(15, 600), fill=(130, 130, 140))
    d.text((W - 60, 868), "cupcakeindex.com", font=R.font(16), fill=(140, 140, 150), anchor="rm")
    return grain(img, 0.24)


def I_title(title, d):
    """A title broken into at most 3 stacked lines, about even."""
    words = title.split()
    if len(words) <= 1:
        return words, words
    best = None
    for k in (2, 3):
        if len(words) < k:
            continue
        # greedy split into k roughly even lines
        per = sum(len(w) for w in words) / k
        lines, cur = [], []
        for w in words:
            if cur and len(" ".join(cur + [w])) > per + 3 and len(lines) < k - 1:
                lines.append(" ".join(cur))
                cur = []
            cur.append(w)
        lines.append(" ".join(cur))
        score = max(len(x) for x in lines)
        if best is None or score < best[0] - 2:
            best = (score, lines)
    return words, best[1]


# ------------------------------------------------------------------ podium
def podium(f, A, image, team_logo):
    I = info(f, image, team_logo)
    rows = I["rows"]
    img = linear((W, H), (22, 20, 26), (6, 6, 8))
    spot = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spot)
    for cx in (380, 800, 1220):
        sd.polygon([(cx - 40, 0), (cx + 40, 0), (cx + 260, H), (cx - 260, H)], fill=(255, 255, 255, 12))
    from PIL import ImageFilter
    img.alpha_composite(spot.filter(ImageFilter.GaussianBlur(30)))
    tint = Image.new("RGBA", (W, H), I["hot"] + (0,))
    tint.putalpha(Image.linear_gradient("L").resize((W, H)).point(lambda v: int(v * 0.18)))
    img.alpha_composite(tint)
    d = DR(img)
    brand(d, 60, 44, A)
    tags = f"{f['league'].upper()} · {I['tag']}"
    d.text((W - 60, 48), tags, font=INTER(18, 800), fill=A, anchor="rt")
    tf = fit_font(d, f["title"].upper(), COND, 92, W - 240, 52)
    d.text((W // 2, 96), f["title"].upper(), font=tf, fill=(255, 255, 255), anchor="mt")
    y = 96 + tf.size + 8
    for line in wrap(d, f["sub"], INTER(22), W - 360, 2):
        d.text((W // 2, y), line, font=INTER(22), fill=(160, 160, 170), anchor="mt")
        y += 30
    q = f.get("question")
    if q:
        qf = INTER(22, 700)
        line = R.fit(d, q, qf, W - 400)
        tw = d.textlength(line, font=qf)
        d.rectangle((W // 2 - tw / 2 - 22, y + 10, W // 2 - tw / 2 - 16, y + 38), fill=A)
        d.text((W // 2 + 6, y + 24), line, font=qf, fill=(255, 255, 255), anchor="mm")
        y += 44
    order = [3, 1, 0, 2, 4][:len(rows)] if len(rows) == 5 else ([1, 0, 2] if len(rows) == 3 else list(range(len(rows))))
    order = [i for i in order if i < len(rows)]
    base_y = 790
    top_y = max(y + 200, 400)
    cw, gap = 210, 46
    x_start = (W - (cw * len(order) + gap * (len(order) - 1))) // 2
    heights = [1.0, 0.8, 0.68, 0.58, 0.5]  # podium steps by rank (the values are printed on them)
    for slot, idx in enumerate(order):
        p, v, s_ = rows[idx]
        col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 85)
        x = x_start + slot * (cw + gap)
        hgt = int((base_y - top_y) * heights[idx])
        yy = base_y - hgt
        c = A if idx == 0 else col
        bar = linear((cw, hgt), mix(c, (255, 255, 255), 0.15), mix(c, (0, 0, 0), 0.6))
        m = Image.new("L", (cw, hgt), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, cw - 1, hgt + 30), 22, fill=255)
        bar.putalpha(m)
        if idx == 0:
            g, pad = shadow(bar, 40, 0.7, A)
            img.alpha_composite(g, (x - pad, yy - pad))
        img.alpha_composite(bar, (x, yy))
        vf = fit_font(d, s_, COND, 76 if idx == 0 else 58, cw - 24, 22)
        d.text((x + cw // 2, yy + 22), s_, font=vf, fill=(255, 255, 255), anchor="mt")
        d.text((x + cw // 2, base_y + 14), R.fit(d, who(p, f).upper(), INTER(17, 800), cw + gap - 8), font=INTER(17, 800),
               fill=(255, 255, 255) if idx == 0 else (200, 200, 208), anchor="mt")
        if I["player"]:
            lg = team_logo(p)
            tw = d.textlength(p["team"], font=INTER(15, 600))
            lx = int(x + cw // 2 - (tw + (42 if lg else 0)) / 2)
            if lg:
                lg = lg.copy()
                lg.thumbnail((34, 34), Image.LANCZOS)
                img.alpha_composite(lg, (lx, base_y + 40))
                lx += 42
            d.text((lx, base_y + 57), p["team"], font=INTER(15, 600), fill=(150, 150, 160), anchor="lm")
        size = 150 if idx == 0 else 118
        img.alpha_composite(face(p, f, size, image, team_logo, A if idx == 0 else (255, 255, 255, 90), 5 if idx == 0 else 2),
                            (x + (cw - size) // 2, yy - size - 14))
    d.line((x_start - 30, base_y, W - x_start + 30, base_y), fill=(255, 255, 255, 60), width=2)
    d.text((W - 60, H - 30), "cupcakeindex.com", font=R.font(16), fill=(130, 130, 140), anchor="rm")
    return grain(img, 0.3)


# ------------------------------------------------------------------ trading card
def trading(f, A, image, team_logo):
    I = info(f, image, team_logo)
    tc, hot, rows, lead = I["tc"], I["hot"], I["rows"], I["lead"]
    img = linear((W, H), (16, 16, 20), (6, 6, 8))
    d = DR(img)
    for gx in range(0, W, 40):
        d.line((gx, 0, gx, H), fill=(255, 255, 255, 6))
    for gy in range(0, H, 40):
        d.line((0, gy, W, gy), fill=(255, 255, 255, 6))
    cw, ch = 520, 740
    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    holo = Image.blend(linear((cw, ch), (255, 120, 60), (120, 90, 255), horizontal=True), linear((cw, ch), (60, 230, 200), (255, 70, 160)), 0.5)
    card.alpha_composite(rounded(holo, 30))
    inner = linear((cw - 28, ch - 28), mix(hot, (255, 255, 255), 0.1), mix(tc, (0, 0, 0), 0.6))
    idr = DR(inner)
    if I["logo"]:
        wm = I["logo"].copy()
        wm.thumbnail((300, 300), Image.LANCZOS)
        if I["pic"]:
            wm.putalpha(wm.getchannel("A").point(lambda v: int(v * 0.18)))
            inner.alpha_composite(wm, ((inner.width - wm.width) // 2, 70))
        else:  # team: the logo is the picture
            wm.thumbnail((360, 360), Image.LANCZOS)
            s, pad = shadow(wm, 16, 0.55)
            inner.alpha_composite(s, ((inner.width - wm.width) // 2 - pad + 10, 140 - pad + 14))
            inner.alpha_composite(wm, ((inner.width - wm.width) // 2, 140))
    if I["pic"]:
        pic = I["pic"].resize((int(I["pic"].width * 520 / I["pic"].height), 520), Image.LANCZOS)
        if pic.width > inner.width:
            pic = pic.crop(((pic.width - inner.width) // 2, 0, (pic.width + inner.width) // 2, pic.height))
        inner.alpha_composite(pic, ((inner.width - pic.width) // 2, inner.height - pic.height - 150))
    idr.rectangle((0, inner.height - 150, inner.width, inner.height), fill=(10, 10, 12, 235))
    nf = fit_font(idr, I["name"].upper(), COND, 54, inner.width - 48, 28)
    idr.text((24, inner.height - 132), I["name"].upper(), font=nf, fill=(255, 255, 255))
    idr.text((26, inner.height - 66), R.fit(idr, I["meta"].upper(), INTER(19, 700), inner.width - 48), font=INTER(19, 700), fill=(200, 200, 210))
    idr.text((inner.width - 24, 22), f["league"].upper(), font=COND(34), fill=(255, 255, 255), anchor="rt")
    if I["logo"] and I["pic"]:
        lg2 = I["logo"].copy()
        lg2.thumbnail((64, 64), Image.LANCZOS)
        inner.alpha_composite(lg2, (20, 18))
    card.alpha_composite(rounded(inner, 22), (14, 14))
    card = card.rotate(-4, resample=Image.BICUBIC, expand=True)
    s, pad = shadow(card, 30, 0.7)
    img.alpha_composite(s, (90 - pad + 16, 70 - pad + 26))
    img.alpha_composite(card, (90, 70))
    x0, xr = 760, W - 60
    brand(d, xr, 44, A, 22, right=True)
    d.text((x0, 40), f"{f['league'].upper()} · {I['tag']}", font=INTER(18, 800), fill=A)
    tf = fit_font(d, f["title"].upper(), COND, 96, xr - x0, 52)
    d.text((x0, 72 + (96 - tf.size) // 2), f["title"].upper(), font=tf, fill=(255, 255, 255))
    y = 182
    for line in wrap(d, f["sub"], INTER(21), xr - x0, 2):
        d.text((x0, y), line, font=INTER(21), fill=(160, 160, 170))
        y += 28
    # tiles: the headline number, then facts about the leader
    if I["player"]:
        extra = [(lead["team"], "TEAM"), (lead.get("pos", ""), "POSITION"), (lead.get("draft") or "", "DRAFTED")]
    else:
        extra = [(lead.get("record", ""), "RECORD"), (f"#{lead['power_rank']}" if lead.get("power_rank") else "", "OUR RANK"),
                 (f"#{lead['ap_rank']}" if lead.get("ap_rank") else "", "AP POLL")]
    tiles = [(I["big"], I["unit"], True)] + [(v, k, False) for v, k in extra if v]
    ty = y + 16
    tw_ = [300 if len(I["big"]) > 6 else 200] + [150] * (len(tiles) - 1)
    x = x0
    for (val, lab, main), w in zip(tiles, tw_):
        if x + w > xr:
            break
        d.rounded_rectangle((x, ty, x + w, ty + 140), 18, fill=A if main else (28, 28, 34), outline=None if main else (55, 55, 64), width=2)
        vf = fit_font(d, val, COND, 76, w - 36, 26)
        d.text((x + 18, ty + 14 + (76 - vf.size) // 2), val, font=vf, fill=(12, 12, 14) if main else (255, 255, 255))
        for i, line in enumerate(wrap(d, lab, INTER(13, 800), w - 36, 2)[-2:]):
            d.text((x + 20, ty + 140 - 46 + i * 17), line, font=INTER(13, 800), fill=(12, 12, 14) if main else (150, 150, 160))
        x += w + 14
    # the chase
    y = ty + 170
    q = f.get("question")
    bottom = H - (90 if q else 50)
    d.text((x0, y), "THE CHASE", font=INTER(17, 800), fill=(150, 150, 160))
    y += 34
    row_h = min(68, (bottom - y) // max(1, len(rows)))
    vmax = max(abs(v) for _, v, _ in rows) or 1
    vf = COND(40)
    while vf.size > 22 and max(d.textlength(s_, font=vf) for _, _, s_ in rows) > 200:
        vf = COND(vf.size - 2)
    val_w = max(d.textlength(s_, font=vf) for _, _, s_ in rows)
    av = max(30, min(52, row_h - 10))
    for i, (p, v, s_) in enumerate(rows):
        cy = y + i * row_h + row_h // 2
        col = lift(hex_rgb(p.get("color") or "", (90, 90, 96)), 80)
        img.alpha_composite(face(p, f, av, image, team_logo, A if i == 0 else None, 3), (x0, cy - av // 2))
        ink = (255, 255, 255) if i == 0 else (205, 205, 212)
        bx0 = x0 + 300
        bx1 = int(xr - val_w - 30)
        if I["player"]:
            d.text((x0 + av + 18, cy - 10), R.fit(d, who(p, f), INTER(21, 700), bx0 - x0 - av - 30), font=INTER(21, 700), fill=ink, anchor="lm")
            d.text((x0 + av + 18, cy + 15), p["team"], font=INTER(14, 600), fill=(130, 130, 140), anchor="lm")
        else:
            d.text((x0 + av + 18, cy), R.fit(d, who(p, f), INTER(21, 700), bx0 - x0 - av - 30), font=INTER(21, 700), fill=ink, anchor="lm")
        seg = 22
        nseg = max(1, int((bx1 - bx0) / seg))
        on = max(1, round(nseg * min(1, abs(v) / vmax)))
        for k in range(nseg):
            sx = bx0 + k * seg
            d.rounded_rectangle((sx, cy - 9, sx + seg - 6, cy + 9), 3, fill=(A if i == 0 else col) if k < on else (34, 34, 40))
        d.text((xr, cy), s_, font=vf, fill=ink, anchor="rm")
    if q:
        callout(d, q, x0, H - 78, xr - x0, A, 20)
    d.text((xr, H - 26), "cupcakeindex.com", font=R.font(16), fill=(130, 130, 140), anchor="rm")
    return grain(img, 0.24)
