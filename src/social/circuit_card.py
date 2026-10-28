"""The "circuit" look for team stat posts (hot takes, schedules, team lists), in the site's Season stats style (Terry,
2026-10-28: "those two look great"; mockups in branding/Concepts/x-circuit/). Thin neon traces, chamfered tags, ticked
tracks, corner traces and a faint grid. No card frame (Terry: "dont make them like cards"): the team logo sits in a
ticked ring on the left. Player posts keep the collector looks (slab, frontback, hand, trading).

The right side picks what to show from the stat:
  receipts  teams it has beaten, each with its record (paper records)
  road      the games left as a row of logos, winning teams lit orange (schedule left)
  list      the top 5 with bars (everything else)
Drawn at 2x and scaled down so the cut corners and circles are smooth.
"""
import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter

import render as R
from flare_card import COND, INTER, _font, fit_font, lift, mix, wrap
from render import hex_rgb, short

W, H, K = 1600, 900, 2
O = (255, 107, 44)
CYAN = (53, 200, 255)
INK = (242, 242, 244)
MUT = (139, 147, 161)
CARD = (13, 14, 17)
BG = (7, 8, 10)
RECEIPTS = ("hot_nfl_paper_record", "hot_cfb_paper_unbeaten", "hot_cfb_beaten_nobody")
ROAD = ("nfl_toughest_left", "nfl_easiest_left", "cfb_toughest_left", "cfb_easiest_left")


def MONO(s, bold=True):
    return _font(f"JetBrainsMono-{'Bold' if bold else 'Regular'}.ttf", s * K)


def k(*v):
    return tuple(round(x * K) for x in v)


class Canvas:
    """Draws in 1x coordinates onto a 2x image; see-through colors blend."""
    def __init__(self):
        self.img = Image.new("RGBA", (W * K, H * K), BG + (255,))

    def layer(self):
        return Image.new("RGBA", self.img.size, (0, 0, 0, 0))

    def put(self, ov):
        self.img.alpha_composite(ov)

    def d(self):
        ov = self.layer()
        return ov, ImageDraw.Draw(ov)

    def text(self, xy, s, font, fill, anchor="la", track=0):
        """track: letter spacing in px (the site's uppercase labels are spaced out)."""
        ov, d = self.d()
        x, y = k(*xy)
        if not track:
            d.text((x, y), s, font=font, fill=fill, anchor=anchor)
        else:
            w = self.width(s, font, track) * K
            if anchor[0] == "m":
                x -= w / 2
            elif anchor[0] == "r":
                x -= w
            for ch in s:
                d.text((x, y), ch, font=font, fill=fill, anchor="l" + anchor[1])
                x += d.textlength(ch, font=font) + track * K
        self.put(ov)

    def width(self, s, font, track=0):
        d = ImageDraw.Draw(self.img)
        return (d.textlength(s, font=font) + (track * K * max(0, len(s) - 1) if track else 0)) / K

    def fit(self, s, font, max_w):
        return R.fit(ImageDraw.Draw(self.img), s, font, max_w * K)


def cut(x0, y0, x1, y1, c):
    """The chamfered box: top-left and bottom-right corners cut off."""
    return [k(x0 + c, y0), k(x1, y0), k(x1, y1 - c), k(x1 - c, y1), k(x0, y1), k(x0, y0 + c)]


def tag(cv, x, y, s, color, solid=False, size=17, center=False):
    """The site's rank tag: a chamfered outline (or filled) box with the text in it. y is the middle."""
    f = MONO(size)
    w = cv.width(s, f, 1) + 22
    h = size + 12
    x0 = x - w / 2 if center else x
    ov, d = cv.d()
    d.polygon(cut(x0, y - h / 2, x0 + w, y + h / 2, 7), fill=color + (255,))
    if not solid:
        d.polygon(cut(x0 + 1.5, y - h / 2 + 1.5, x0 + w - 1.5, y + h / 2 - 1.5, 6.4), fill=CARD + (255,))
    cv.put(ov)
    cv.text((x0 + w / 2, y + 1), s, f, (11, 11, 13) if solid else color, "mm", 1)
    return w


def glow_line(cv, pts, color, width, blur=3, alpha=150):
    ov, d = cv.d()
    d.line([k(*p) for p in pts], fill=color + (alpha,), width=round(width * K * 2))
    cv.put(ov.filter(ImageFilter.GaussianBlur(blur * K)))
    ov, d = cv.d()
    d.line([k(*p) for p in pts], fill=color + (255,), width=round(width * K))
    cv.put(ov)


def kick(cv, x0, xr, y, label, small="", color=O):
    """// LABEL [small] ----------------------------o"""
    f = MONO(18)
    cv.text((x0, y), "// ", f, color + (150,), "lm")
    x = x0 + cv.width("// ", f)
    cv.text((x, y), label.upper(), f, color, "lm", 2)
    x += cv.width(label.upper(), f, 2) + 12
    if small:
        cv.text((x, y), small.upper(), MONO(16, False), MUT, "lm", 1)
        x += cv.width(small.upper(), MONO(16, False), 1) + 14
    ov, d = cv.d()
    n = 40
    for i in range(n):  # fading trace
        a = int(150 - 130 * i / n)
        d.line([k(x + (xr - x) * i / n, y), k(x + (xr - x) * (i + 1) / n, y)], fill=color + (a,), width=K)
    d.ellipse(k(xr - 3.5, y - 3.5, xr + 3.5, y + 3.5), fill=color + (255,))
    cv.put(ov)


def tiles(cv, x0, xr, y, items):
    """items: (big, label, kind) with kind 'hero' (orange) or ''. Returns the bottom."""
    gap, h = 14, 118
    lf = MONO(14)
    if any(cv.width(l.upper(), lf, 1.5) > 420 for _, l, kd in items if kd == "hero"):
        h = 138  # the label takes two lines: room for both under the number
    # the hero tile is as wide as its label needs (within reason); the rest share what's left
    want = [max(cv.width(b, COND(66 * K)) / K + 40, min(cv.width(l.upper(), lf, 1.5) + 40, 560)) if kd == "hero" else 0 for b, l, kd in items]
    rest = [i for i, w in enumerate(want) if not w]
    free = xr - x0 - gap * (len(items) - 1) - sum(want)
    ws = [w or free / max(1, len(rest)) for w in want]
    if rest and free / len(rest) < 200:  # too tight: all equal
        ws = [(xr - x0 - gap * (len(items) - 1)) / len(items)] * len(items)
    x = x0
    for (big, label, kd), w in zip(items, ws):
        c = O if kd == "hero" else (58, 61, 69)
        ov, d = cv.d()
        d.polygon(cut(x, y, x + w, y + h, 14), fill=c + (255,))
        d.polygon(cut(x + 1.5, y + 1.5, x + w - 1.5, y + h - 1.5, 13.4), fill=CARD + (255,))
        cv.put(ov)
        if kd == "hero":  # orange wash, strongest at the top left
            wash = Image.new("L", k(w, h), 0)
            wd = ImageDraw.Draw(wash)
            for i in range(wash.width):
                wd.line([(i, 0), (i, wash.height)], fill=int(56 * (1 - i / wash.width) + 10))
            m = Image.new("L", cv.img.size, 0)
            ImageDraw.Draw(m).polygon(cut(x + 1.5, y + 1.5, x + w - 1.5, y + h - 1.5, 13.4), fill=255)
            sol = Image.new("RGBA", cv.img.size, O + (0,))
            full = Image.new("L", cv.img.size, 0)
            full.paste(wash, k(x, y))
            sol.putalpha(ImageChops.multiply(full, m))
            cv.put(sol)
        bf = COND(66 * K)
        while cv.width(big, bf) > w - 36 and bf.size > 36 * K:
            bf = COND(bf.size - 2 * K)
        cv.text((x + 18, y + 12), big, bf, O if kd == "hero" else INK)
        lines = wrap(ImageDraw.Draw(cv.img), label.upper(), lf, (w - 36) * K, 2)
        ly = y + h - 16 - 18 * (len(lines) - 1)
        for i, line in enumerate(lines):
            cv.text((x + 18, ly + i * 18), line, lf, (255, 180, 143) if kd == "hero" else MUT, "ls", 1.5)
        x += w + gap
    return y + h


def ring_logo(cv, logo, cx, cy, tc):
    """The left side: the team's logo on a team-color glow inside a ticked ring."""
    r = 220
    glow = Image.new("RGBA", k(2 * r, 2 * r), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gc = lift(tc, 40)
    for i in range(60, 0, -1):  # radial glow, team color
        rr = r * K * i / 60
        a = int(215 * (1 - i / 60) ** 1.4) if i > 6 else 215
        gd.ellipse((r * K - rr, r * K - rr, r * K + rr, r * K + rr), fill=gc + (min(215, a + 20),))
    cv.img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(10 * K)), k(cx - r, cy - r))
    ov, d = cv.d()
    d.ellipse(k(cx - 219, cy - 219, cx + 219, cy + 219), outline=O + (140,), width=K)
    for deg in range(0, 360, 10):  # ticks
        a = math.radians(deg)
        d.line([k(cx + 209 * math.cos(a), cy + 209 * math.sin(a)), k(cx + 219 * math.cos(a), cy + 219 * math.sin(a))], fill=O + (150,), width=K)
    for deg in range(0, 360, 4):  # dashed inner ring
        a0, a1 = math.radians(deg), math.radians(deg + 2)
        d.line([k(cx + 190 * math.cos(a0), cy + 190 * math.sin(a0)), k(cx + 190 * math.cos(a1), cy + 190 * math.sin(a1))], fill=MUT + (70,), width=K)
    cv.put(ov)
    for nx, ny in ((cx, cy - 219), (cx - 219, cy)):  # two glowing nodes on the ring
        ov, d = cv.d()
        d.ellipse(k(nx - 9, ny - 9, nx + 9, ny + 9), fill=O + (120,))
        cv.put(ov.filter(ImageFilter.GaussianBlur(4 * K)))
        ov, d = cv.d()
        d.ellipse(k(nx - 5, ny - 5, nx + 5, ny + 5), fill=O + (255,))
        cv.put(ov)
    if logo:
        lg = logo.copy()
        lg.thumbnail(k(300, 300), Image.LANCZOS)
        sh = Image.new("RGBA", (lg.width + 120 * K, lg.height + 120 * K), (0, 0, 0, 0))
        sh.paste((0, 0, 0, 150), (60 * K, 60 * K), lg.getchannel("A"))
        cv.img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14 * K)), (round(cx * K - lg.width / 2 - 60 * K), round(cy * K - lg.height / 2 - 50 * K)))
        cv.img.alpha_composite(lg, (round(cx * K - lg.width / 2), round(cy * K - lg.height / 2)))


def avatar(cv, logo, x, cy, size, ring, bg, text=None):
    s = round(size * K)
    base = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    m = Image.new("L", (s * 2, s * 2), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s * 2 - 1, s * 2 - 1), fill=255)
    m = m.resize((s, s), Image.LANCZOS)
    base.paste(bg + (255,), (0, 0), m)
    if logo:
        lg = logo.copy()
        lg.thumbnail((int(s * 0.74), int(s * 0.74)), Image.LANCZOS)
        base.alpha_composite(lg, ((s - lg.width) // 2, (s - lg.height) // 2))
    ring_im = Image.new("RGBA", (s * 2, s * 2), (0, 0, 0, 0))
    ImageDraw.Draw(ring_im).ellipse((2, 2, s * 2 - 3, s * 2 - 3), outline=ring + (255,), width=4 * K)
    base.alpha_composite(ring_im.resize((s, s), Image.LANCZOS))
    cv.img.alpha_composite(base, (round(x * K), round((cy - size / 2) * K)))
    if text and not logo:
        cv.text((x + size / 2, cy + 1), text, MONO(13), INK, "mm")


def track_row(cv, y, h, x0, xr, n, logo, name, meta, color, pct, label, lead, accent):
    """One row: tier line, number, logo, name + meta, ticked track with a neon trace into the value tag."""
    cy = y + h / 2
    tc = accent if lead else lift(color, 110)
    ov, d = cv.d()
    d.line([k(x0, y + 14), k(x0, y + h - 14)], fill=tc + (255,), width=2 * K)
    d.line([k(x0, y + h), k(xr, y + h)], fill=MUT + (40,), width=K)
    cv.put(ov)
    cv.text((x0 + 14, cy), n, MONO(16), MUT, "lm")
    av = min(52, h - 8)
    avatar(cv, logo, x0 + 60, cy, av, tc, mix(color, (0, 0, 0), 0.35), "FCS" if not logo else None)
    nx = x0 + 60 + av + 16
    tx0, tx1 = x0 + 480, xr - 56
    if h < 48:  # tight (6-7 rows): name only, and the meta goes after it
        nf = INTER(20 * K, 700)
        nm = cv.fit(name, nf, tx0 - nx - 16)
        cv.text((nx, cy), nm, nf, INK, "lm")
        if meta:
            mx = nx + cv.width(nm, nf) + 12
            if tx0 - mx > 80:
                cv.text((mx, cy + 1), cv.fit(meta, MONO(13, False), tx0 - mx - 16), MONO(13, False), MUT, "lm")
        meta, name = "", ""
    nf = INTER(22 * K, 700)
    if name:
        cv.text((nx, cy - (10 if meta else 0)), cv.fit(name, nf, tx0 - nx - 16), nf, (255, 255, 255) if lead else INK, "lm")
    if meta:
        cv.text((nx, cy + 14), cv.fit(meta, MONO(14, False), tx0 - nx - 16), MONO(14, False), MUT, "lm")
    ov, d = cv.d()  # track: a faint line with ticks every 10%
    d.line([k(tx0, cy), k(tx1, cy)], fill=MUT + (80,), width=K)
    for i in range(11):
        tx = tx0 + (tx1 - tx0) * i / 10
        d.line([k(tx, cy - 3.5), k(tx, cy + 3.5)], fill=MUT + (90,), width=K)
    cv.put(ov)
    fx = tx0 + (tx1 - tx0) * max(0.03, min(1, pct))
    glow_line(cv, [(tx0, cy), (fx, cy)], tc, 3, 3, 110)
    tw = cv.width(label, MONO(17), 1) + 22
    tag(cv, min(fx - tw / 2, xr - tw), cy, label, tc, solid=lead)


def callout(cv, x0, xr, y, label, text, color=O):
    """A box with a trace along its top ending in a node (the site's talking points)."""
    lines = wrap(ImageDraw.Draw(cv.img), text, INTER(30 * K, 700), (xr - x0 - 44) * K, 2)
    h = 50 + 38 * len(lines)
    ov, d = cv.d()
    for i in range(h):
        d.line([k(x0, y + i), k(xr, y + i)], fill=color + (int(22 * (1 - i / h)),))
    d.line([k(x0, y), k(xr, y)], fill=color + (255,), width=2 * K)
    d.line([k(xr - 1, y), k(xr - 1, y + 18)], fill=color + (255,), width=2 * K)
    d.ellipse(k(x0 - 5, y - 5, x0 + 5, y + 5), fill=color + (255,))
    cv.put(ov)
    cv.text((x0 + 22, y + 26), label, MONO(15), color, "lm", 2)
    for i, line in enumerate(lines):
        cv.text((x0 + 22, y + 44 + i * 38), line, INTER(30 * K, 700), (255, 255, 255))
    return h


def wl(rec_):
    """'6-1' / '1-4-1' -> (wins, losses)."""
    try:
        p = [int(x) for x in rec_.split("-")]
        return p[0], p[1]
    except Exception:
        return 0, 0


def draw(f, A, image, team_logo, key=""):
    import obscure  # the rankings (opponents' records) live there
    (lead, _, big), rows = f["rows"][0], f["rows"][:5]
    tc = hex_rgb(lead.get("color") or "", (90, 90, 96))
    _, by, _ = obscure.teams(f["league"]) if f["kind"] == "team" else ([], {}, 0)
    cv = Canvas()

    # backdrop: orange glow up right, a 32px grid, corner traces
    ov, d = cv.d()
    for i in range(40, 0, -1):
        rx, ry = 0.7 * W * i / 40, 0.8 * H * i / 40
        d.ellipse(k(1120 - rx, 360 - ry, 1120 + rx, 360 + ry), fill=O + (int(2.2 * (1 - i / 40) * 6),))
    cv.put(ov.filter(ImageFilter.GaussianBlur(30 * K)))
    ov, d = cv.d()
    for x in range(0, W, 32):
        d.line([k(x, 0), k(x, H)], fill=O + (12,), width=K)
    for y in range(0, H, 32):
        d.line([k(0, y), k(W, y)], fill=O + (12,), width=K)
    d.line([k(22, 23), k(112, 23)], fill=O + (255,), width=2 * K)
    d.line([k(23, 22), k(23, 56)], fill=O + (255,), width=2 * K)
    d.line([k(W - 112, H - 23), k(W - 22, H - 23)], fill=O + (255,), width=2 * K)
    d.line([k(W - 23, H - 56), k(W - 23, H - 22)], fill=O + (255,), width=2 * K)
    cv.put(ov)

    # brand, top left
    bf = MONO(24)
    cv.text((60, 58), ">", bf, O, "lm")
    x = 60 + cv.width("> ", bf)
    cv.text((x, 58), "CUPCAKE", bf, INK, "lm")
    cv.text((x + cv.width("CUPCAKE", bf), 58), "_INDEX", bf, O, "lm")

    # left: the team
    ring_logo(cv, team_logo(lead), 295, 350, tc)
    name = lead.get("name") or lead["team"]
    nf = COND(62 * K)
    while cv.width(name.upper(), nf) > 460 and nf.size > 34 * K:
        nf = COND(nf.size - 2 * K)
    cv.text((295, 640), name.upper(), nf, INK, "mm")
    bits = [lead.get("record"), lead.get("conference")]
    cv.text((295, 690), " · ".join(b for b in bits if b).upper(), MONO(17, False), (185, 190, 200), "mm", 3)
    cv.text((295, 855), "cupcakeindex.com", MONO(16, False), MUT, "mm")

    # right
    x0, xr = 590, 1540
    label = f.get("tag") or ("HOT TAKE" if f["hot"] else "SCHEDULE" if key in ROAD else "BY THE NUMBERS")
    kick(cv, x0, xr, 122, label, f"[{f['league']}]")
    tf = COND(88 * K)
    while cv.width(f["title"].upper(), tf) > xr - x0 and tf.size > 52 * K:
        tf = COND(tf.size - 2 * K)
    cv.text((x0, 150), f["title"].upper(), tf, INK)
    y = 150 + tf.size / K * 0.98 + 20
    for line in wrap(ImageDraw.Draw(cv.img), f["sub"], MONO(18, False), (xr - x0) * K, 2):
        cv.text((x0, y), line, MONO(18, False), MUT)
        y += 26
    big = f.get("big") or big
    unit = f.get("big_unit") or f["unit"]
    if " +" in big and big.endswith("FCS"):  # "2-7 +2 FCS": the number, FCS games in the label
        big, extra = big.split(" +", 1)
        unit += f" (plus {extra})"

    # what goes under the tiles
    mode, items = "list", []
    if key in RECEIPTS and lead.get("schedule"):
        items = [s for s in lead["schedule"] if s.get("result") == "W"]
        mode = "receipts" if 0 < len(items) <= 7 else "list"
    elif key in ROAD and lead.get("schedule"):
        items = [s for s in lead["schedule"] if s.get("upcoming")]
        mode = "road" if 0 < len(items) <= 13 else "list"

    rank = f"#{lead['power_rank']}" if lead.get("power_rank") else ""
    tl = [(big, unit, "hero"), (lead.get("record", ""), "Their record", "")]
    if mode == "road":
        good = sum(1 for s in items if (o := by.get(s["opp"])) and o["wins"] > o["losses"])
        tl.append((f"{good} of {len(items)}", "vs winning teams", ""))
    elif rank:
        tl.append((rank, "In our rankings", ""))
    y = tiles(cv, x0, xr, y + 22, [t for t in tl if t[0]])

    q = f.get("question")
    bottom = 830 - (50 + 38 * len(wrap(ImageDraw.Draw(cv.img), q, INTER(30 * K, 700), (xr - x0 - 44) * K, 2)) + 22) if q else 830
    y += 40
    if mode == "receipts":
        kick(cv, x0, xr, y, "The receipts", f"[{len(items):02d} wins]")
        y += 20
        h = min(57, (bottom - y) / len(items))
        for s in items:
            o = by.get(s["opp"])
            w_, l_ = (o["wins"], o["losses"]) if o else (0, 0)
            loc = {"H": "home", "A": "away", "N": "neutral"}.get(s.get("loc"), "")
            track_row(cv, y, h, x0, xr, f"W{s['week']}", team_logo(o) if o else None, short(s["opp"], f["league"]) if f["league"] == "cfb" else s["opp"],
                      " · ".join(b for b in (f"Won {s['score']}" if s.get("score") else "", loc) if b),
                      hex_rgb((o or {}).get("color") or "", (90, 90, 96)), w_ / (w_ + l_) if w_ + l_ else 0,
                      f"{w_}-{l_}" if o else "FCS", False, A)
            y += h
    elif mode == "road":
        kick(cv, x0, xr, y, "The road", f"[{len(items)} games]")
        y += 26
        n = len(items)
        sw = (xr - x0) / n
        av = min(62, sw - 18)
        line_y = y + 22 + av / 2
        glow_line(cv, [(x0 + sw / 2, line_y), (xr - sw / 2, line_y)], O, 2, 3, 90)
        for i, s in enumerate(items):
            cx = x0 + sw * i + sw / 2
            o = by.get(s["opp"])
            win = bool(o and o["wins"] > o["losses"])
            ring = O if win else (74, 79, 89)
            cv.text((cx, y + 8), f"WK{s['week']}", MONO(13, False), MUT, "mm", 1)
            avatar(cv, team_logo(o) if o else None, cx - av / 2, line_y, av, ring, mix(hex_rgb((o or {}).get("color") or "", (40, 40, 46)), (0, 0, 0), 0.25), "FCS")
            rec_ = o.get("record") if o else "FCS"
            tag(cv, cx, line_y + av / 2 + 22, rec_ or "", O if win else (107, 114, 128), solid=win, size=15, center=True)
            loc = {"H": "HOME", "A": "AWAY", "N": "NEUTRAL"}.get(s.get("loc"), "")
            cv.text((cx, line_y + av / 2 + 50), loc, MONO(12, False), MUT, "mm", 1)
        ly = line_y + av / 2 + 76
        for lx, c, t in ((x0, O, "WINNING RECORD"), (x0 + 170, MUT, ".500 OR WORSE")):
            ov, d = cv.d()
            d.line([k(lx, ly), k(lx + 18, ly)], fill=c + (255,), width=2 * K)
            cv.put(ov)
            cv.text((lx + 26, ly), t, MONO(13, False), MUT, "lm", 1)
    else:
        kick(cv, x0, xr, y, "The list", f"[{len(rows):02d}]")
        y += 20
        h = min(57, (bottom - y) / len(rows))
        vmax = max(abs(v) for _, v, _ in rows) or 1
        for i, (p, v, s_) in enumerate(rows):
            meta = " · ".join(b for b in (p.get("record"), f"#{p['power_rank']} in our rankings" if p.get("power_rank") else "") if b)
            track_row(cv, y, h, x0, xr, f"{i + 1:02d}", team_logo(p), p.get("name") or p["team"], meta,
                      hex_rgb(p.get("color") or "", (90, 90, 96)), abs(v) / vmax, s_, i == 0, A)
            y += h
    if q:
        callout(cv, x0, xr, max(y + 24, bottom), "THE VERDICT", q)
    return cv.img.resize((W, H), Image.LANCZOS)
