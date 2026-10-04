"""Postgame "big game" posts for X: after a batch of games, the best individual stat line (if any is big enough)
gets a card with an action shot from that game and his line, and one post.

What counts: a monster line, e.g. 400 passing yards (450 in college), 175 rushing or receiving (college 225 / 200),
3+ total TDs (college 4), 3 sacks, 2 picks. Only the best one per run; each player/game posts once.
Action shot (required): a recap photo whose caption names him, or a still from a highlight clip of one of his plays.
A big game with no action shot is skipped for the next best one that has one.

    python src/social/postgame.py                       # games that finished in the last 9 hours, both leagues
    python src/social/postgame.py --league nfl --hours 72 --out DIR   # test on older games

Runs from .github/workflows/postgame.yml after each window of games. No link, 280 characters max.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import obscure as O
import posted
import render as R
from render import ROOT, hex_rgb, tweet

W, H = 1600, 900
SITE = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football"}
# a line is "big" when any of these is reached (ratio >= 1); the best line is the one with the most big-ish numbers
BIG = {"nfl": {"pass_yds": 400, "pass_td": 5, "rush_yds": 175, "rush_td": 3, "rec_yds": 175, "rec_td": 3, "rec": 13,
               "scrim": 225, "tds": 3, "sacks": 3, "def_int": 2, "tackles": 16},
       "cfb": {"pass_yds": 450, "pass_td": 6, "rush_yds": 225, "rush_td": 4, "rec_yds": 200, "rec_td": 3, "rec": 14,
               "scrim": 275, "tds": 4, "sacks": 3, "def_int": 2, "tackles": 17}}
HEAD = {"pass_yds": "PASSING YARDS", "pass_td": "PASSING TDS", "rush_yds": "RUSHING YARDS", "rush_td": "RUSHING TDS",
        "rec_yds": "RECEIVING YARDS", "rec_td": "RECEIVING TDS", "rec": "CATCHES", "scrim": "YARDS FROM SCRIMMAGE",
        "tds": "TOUCHDOWNS", "sacks": "SACKS", "def_int": "INTERCEPTIONS", "tackles": "TACKLES"}


def num(v):
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def lines(summary):
    """Every player's line in a game: {athlete id: {name, team id, pic, stats...}} from the ESPN box score."""
    out = {}
    for side in (summary.get("boxscore") or {}).get("players", []):
        tid = str(side["team"]["id"])
        for c in side.get("statistics", []):
            keys = c.get("keys") or []
            for a in c.get("athletes", []):
                ath = a["athlete"]
                p = out.setdefault(str(ath["id"]), {"id": str(ath["id"]), "name": ath.get("displayName", ""), "last": ath.get("lastName", ""),
                                                    "tid": tid, "pic": (ath.get("headshot") or {}).get("href"), "s": {}})
                st = dict(zip(keys, a.get("stats", [])))
                s = p["s"]
                if c["name"] == "passing":
                    s["cmp_att"] = st.get("completions/passingAttempts", "")
                    s["pass_yds"], s["pass_td"], s["int_thrown"] = num(st.get("passingYards")), num(st.get("passingTouchdowns")), num(st.get("interceptions"))
                elif c["name"] == "rushing":
                    s["car"], s["rush_yds"], s["rush_td"] = num(st.get("rushingAttempts")), num(st.get("rushingYards")), num(st.get("rushingTouchdowns"))
                elif c["name"] == "receiving":
                    s["rec"], s["rec_yds"], s["rec_td"], s["long"] = num(st.get("receptions")), num(st.get("receivingYards")), num(st.get("receivingTouchdowns")), num(st.get("longReception"))
                elif c["name"] == "defensive":
                    s["tackles"], s["sacks"], s["def_td"] = num(st.get("totalTackles")), num(st.get("sacks")), num(st.get("defensiveTouchdowns"))
                elif c["name"] == "interceptions":
                    s["def_int"] = num(st.get("interceptions"))
    for p in out.values():
        s = p["s"]
        s["scrim"] = s.get("rush_yds", 0) + s.get("rec_yds", 0)
        s["tds"] = s.get("rush_td", 0) + s.get("rec_td", 0)
    return out


def grade(p, league):
    """(score, headline key) — score >= 1 on the headline means it's a big game."""
    r = {k: p["s"].get(k, 0) / v for k, v in BIG[league].items()}
    if p["s"].get("pass_yds", 0) >= 100:  # a QB's rushing/receiving TDs aren't "touchdowns" here; his passing TDs carry it
        r["tds"] = 0
    top = max(r, key=r.get)
    return (r[top] + 0.35 * sum(v for k, v in r.items() if k != top and v >= 0.5), top) if r[top] >= 1 else (0, None)


def tiles(s):
    """The stat boxes on the card, by role: [(label, value)]."""
    f = lambda v: f"{v:,.0f}" if v == int(v) else f"{v:.1f}"
    if s.get("pass_yds", 0) >= 100:
        if s.get("rush_yds", 0) >= 40 or s.get("rush_td", 0):  # dual threat: passing and rushing, one number per box
            return [("C/ATT", s.get("cmp_att", "")), ("PASS YDS", f(s["pass_yds"])), ("PASS TD", f(s.get("pass_td", 0))),
                    ("RUSH YDS", f(s["rush_yds"])), ("RUSH TD", f(s.get("rush_td", 0)))]
        return [("C/ATT", s.get("cmp_att", "")), ("YDS", f(s["pass_yds"])), ("TD", f(s.get("pass_td", 0))), ("INT", f(s.get("int_thrown", 0)))]
    if s.get("sacks", 0) >= 2 or s.get("def_int", 0) >= 2 or s.get("tackles", 0) >= 12:
        return [(k, f(s.get(x, 0))) for k, x in (("TACKLES", "tackles"), ("SACKS", "sacks"), ("INT", "def_int"), ("DEF TD", "def_td"))]
    if s.get("rush_yds", 0) >= s.get("rec_yds", 0):
        t = [("CAR", f(s.get("car", 0))), ("YDS", f(s["rush_yds"])), ("TD", f(s.get("rush_td", 0)))]
        if s.get("rec_yds", 0) >= 30:
            t.append(("REC YDS", f(s["rec_yds"])))
        return t
    return [("REC", f(s.get("rec", 0))), ("YDS", f(s["rec_yds"])), ("TD", f(s.get("rec_td", 0))), ("LONG", f(s.get("long", 0)))]


def phrase(s):
    """The stat line in words: '11 catches, 247 yards, 3 TDs'."""
    n = lambda v, one, many: f"{v:,.0f} {one if v == 1 else many}" if v == int(v) else f"{v:.1f} {many}"
    if s.get("pass_yds", 0) >= 100:
        out = [f"{s.get('cmp_att', '')} for {s['pass_yds']:,.0f} yards", n(s.get("pass_td", 0), "TD", "TDs")]
        if s.get("int_thrown"):
            out.append(n(s["int_thrown"], "INT", "INTs"))
        if s.get("rush_yds", 0) >= 40 or s.get("rush_td"):
            out.append(f"plus {s['rush_yds']:,.0f} rushing yards" + (f" and {n(s['rush_td'], 'rushing TD', 'rushing TDs')}" if s.get("rush_td") else ""))
        return ", ".join(out)
    if s.get("sacks", 0) >= 2 or s.get("def_int", 0) >= 2 or s.get("tackles", 0) >= 12:
        return ", ".join(x for x in [n(s.get("tackles", 0), "tackle", "tackles"), s.get("sacks") and n(s["sacks"], "sack", "sacks"),
                                     s.get("def_int") and n(s["def_int"], "interception", "interceptions")] if x)
    if s.get("rush_yds", 0) >= s.get("rec_yds", 0):
        out = [n(s.get("car", 0), "carry", "carries"), f"{s['rush_yds']:,.0f} yards", n(s.get("rush_td", 0), "TD", "TDs")]
        if s.get("rec_yds", 0) >= 30:
            out.append(f"plus {n(s.get('rec', 0), 'catch', 'catches')} for {s['rec_yds']:,.0f}")
        return ", ".join(out)
    return ", ".join([n(s.get("rec", 0), "catch", "catches"), f"{s['rec_yds']:,.0f} yards", n(s.get("rec_td", 0), "TD", "TDs")])


def his_plays(summary, last):
    """His plays in the scoring plays / play-by-play: [(yardages, other surnames in the play text)]."""
    texts = [x.get("text", "") for x in summary.get("scoringPlays") or []]
    texts += [pl.get("text", "") for dr in (summary.get("drives") or {}).get("previous", []) for pl in dr.get("plays", [])]
    out = []
    for t in texts:
        if not re.search(rf"\b{re.escape(last)}\b", t, re.I):
            continue
        yds = {int(n) for n in re.findall(r"(\d+)[- ](?:yd|yds|yard|yards)\b", t, re.I) if 3 <= int(n) <= 100}
        names = {w for w in re.findall(r"[A-Z][a-z][A-Za-z'-]+", re.sub(r"\b[A-Z]\.", "", t)) if w.lower() != last.lower() and len(w) > 3}
        if yds:
            out.append((yds, names))
    return out


def action_shot(summary, p):
    """A photo of HIM from this game, or None:
    1. a recap/news photo whose caption names him (real game photography)
    2. a highlight clip that names him
    3. a clip of one of his plays that doesn't name him ("Caden Veltkamp connects for 55-yard TD pass" = his 55-yard
       catch): same yardage as one of his plays, plus another name from that play
    Clip stills get their bottom trimmed (TV tickers live there)."""
    last_raw = p["last"] or p["name"].split()[-1]
    last = re.escape(last_raw)
    named = lambda t: bool(re.search(rf"\b{last}\b", t or "", re.I))
    vids = [v for v in summary.get("videos") or [] if v.get("thumbnail")]
    mine = [v for v in vids if named(v.get("headline"))]
    mine.sort(key=lambda v: not re.search(r"touchdown|td\b|score", v.get("headline", ""), re.I))  # a scoring play first
    plays = his_plays(summary, last_raw)

    def his_clip(h):
        nums = {int(n) for n in re.findall(r"(\d+)[- ]?(?:yd|yard)", h or "", re.I)}
        return any(nums & yds and any(re.search(rf"\b{re.escape(nm)}\b", h) for nm in names) for yds, names in plays)
    linked = [v for v in vids if v not in mine and his_clip(v.get("headline"))]
    pics = []
    for a in [summary.get("article") or {}, *((summary.get("news") or {}).get("articles") or [])]:
        pics += [(i["url"], False) for i in a.get("images", []) if i.get("url") and named(i.get("caption"))]
    pics += [(v["thumbnail"], True) for v in mine + linked]
    for u, still in pics:
        im = O.image(u)
        if im and im.width >= 500:
            return im.crop((0, 0, im.width, round(im.height * 0.8))) if still else im
    return None


def games(league, hours):
    """Finished games that kicked off in the last `hours` hours."""
    now = dt.datetime.now(dt.timezone.utc)
    days = {(now - dt.timedelta(hours=h)).strftime("%Y%m%d") for h in (0, hours, hours / 2)}
    out = {}
    for d in days:
        q = f"dates={d}" + ("&groups=80&limit=400" if league == "cfb" else "")
        for e in O._session.get(f"{SITE[league]}/scoreboard?{q}", timeout=30).json().get("events", []):
            start = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
            if e["status"]["type"].get("completed") and now - start <= dt.timedelta(hours=hours):
                out[e["id"]] = e
    return list(out.values())


def best(leagues, hours):
    done = {x.get("stat") for x in posted.load()}
    picks = []
    for lg in leagues:
        for e in games(lg, hours):
            s = O._session.get(f"{SITE[lg]}/summary?event={e['id']}", timeout=30).json()
            comp = s["header"]["competitions"][0]
            for p in lines(s).values():
                sc, top = grade(p, lg)
                key = f"biggame:{lg}:{e['id']}:{p['id']}"
                if sc and key not in done:
                    picks.append((sc, lg, p, top, comp, s, key))
    picks.sort(key=lambda x: -x[0])
    return picks


FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_f = {}


def fnt(name, size, weight=700):
    """Display fonts for the card: Oswald (names), Barlow Condensed (numbers), Inter (small text)."""
    key = (name, size, weight)
    if key not in _f:
        f = ImageFont.truetype(os.path.join(FONTS, name), size)
        try:
            f.set_variation_by_axes([min(max(weight, a["minimum"]), a["maximum"]) if a["name"] == b"Weight" else a["default"] for a in f.get_variation_axes()])
        except Exception:
            pass
        _f[key] = f
    return _f[key]


def bright(rgb, floor=150):
    """A team color that still pops on black (navy and maroon get lifted)."""
    m = max(rgb)
    return rgb if m >= floor else tuple(min(255, round(c * floor / max(1, m))) for c in rgb)


def ink_on(rgb):
    return (0, 0, 0) if 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 else (255, 255, 255)


def card(lg, p, top, comp, photo, theme):
    """Broadcast-style card: the action shot full-bleed, a team-color slash, a giant ghost number, the line."""
    T = {k: hex_rgb(v) for k, v in O.THEMES[theme].items() if isinstance(v, str) and v.startswith("#")}
    me = next(c for c in comp["competitors"] if str(c["team"]["id"]) == p["tid"])
    opp = next(c for c in comp["competitors"] if c is not me)
    tc = hex_rgb("#" + (me["team"].get("color") or "555555"), (90, 90, 96))
    alt = hex_rgb("#" + (me["team"].get("alternateColor") or "ffffff"), (255, 255, 255))
    colorful = max(tc) - min(tc) > 40
    hot = bright(tc) if colorful else T["accent"]  # black/gray/white teams use the theme accent
    img = Image.new("RGBA", (W, H), (8, 8, 10, 255))

    # 1. the photo, full bleed, pushed left so the player sits in the open part of the card
    if photo:
        ph = ImageEnhance.Contrast(ImageEnhance.Color(photo.convert("RGB")).enhance(1.15)).enhance(1.08).convert("RGBA")
        sc = max(W / ph.width, H / ph.height) * 1.18
        ph = ph.resize((round(ph.width * sc), round(ph.height * sc)), Image.LANCZOS)
        left = min(max(0, ph.width // 2 - 470), ph.width - W)
        top_ = round((ph.height - H) * 0.3)
        img.alpha_composite(ph.crop((left, top_, left + W, top_ + H)))
    else:  # no action shot: big headshot over a team-color field
        bg = Image.new("RGBA", (W, H), tc + (255,))
        bg.putalpha(Image.linear_gradient("L").rotate(90).resize((W, H)).point(lambda v: round(v * 0.8)))
        img.alpha_composite(bg)
        head = O.image(p.get("pic"))
        if head:
            sc = 820 / head.height
            head = head.resize((round(head.width * sc), 820), Image.LANCZOS)
            img.alpha_composite(head, (max(0, 430 - head.width // 2), H - 820))

    # 2. shading: dark right side for the text, dark floor and top, team color wash from the bottom left
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    for x in range(560, W):
        sd.line((x, 0, x, H), fill=(6, 6, 9, round(250 * min(1.0, (x - 560) / 420) ** 1.3)))
    img.alpha_composite(shade)
    top_band = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # its own layer: lines drawn on the same layer replace each other
    tb = ImageDraw.Draw(top_band)
    for y in range(600, H):
        tb.line((0, y, W, y), fill=(0, 0, 0, round(170 * ((y - 600) / 300) ** 1.6)))
    for y in range(150):
        tb.line((0, y, 900, y), fill=(0, 0, 0, round(150 * (1 - y / 150))))
    img.alpha_composite(top_band)
    wash = Image.new("RGBA", (W, H), tc + (0,))
    ramp = Image.linear_gradient("L").resize((W, H))  # 0 at the top, 255 at the bottom
    wash.putalpha(ramp.point(lambda v: round(max(0, v - 170) * 0.75)))  # a hint of team color low down, not a tint
    img.alpha_composite(wash)

    # 3. team-color slash with an accent edge
    slash = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sl = ImageDraw.Draw(slash)
    sl.polygon([(905, 0), (975, 0), (795, H), (725, H)], fill=tc + (240,))
    sl.polygon([(985, 0), (997, 0), (817, H), (805, H)], fill=hot + (255,))
    sl.polygon([(1007, 0), (1011, 0), (831, H), (827, H)], fill=alt + (170,))
    img.alpha_composite(slash)

    # 4. giant ghost number behind the text
    big = f"{p['s'][top]:,.0f}" if p["s"][top] == int(p["s"][top]) else f"{p['s'][top]:.1f}"
    ghost = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(ghost).text((W + 40, H // 2 + 30), big, font=fnt("BarlowCondensed-Bold.ttf", 600), anchor="rm",
                               fill=(0, 0, 0, 0), stroke_width=3, stroke_fill=hot + (60,))
    img.alpha_composite(ghost)

    d = ImageDraw.Draw(img)
    bf = O.font_for("mono", 26, "Bold")  # brand, top left over the photo
    d.text((48, 40), ">", font=bf, fill=T["accent"])
    d.text((76, 40), "CUPCAKE", font=bf, fill=(255, 255, 255))
    d.text((76 + d.textlength("CUPCAKE", font=bf), 40), "_INDEX", font=bf, fill=T["accent"])
    d.text((48, 76), "cupcakeindex.com", font=O.font_for("mono", 18), fill=(230, 230, 230))

    x0, xr = 1030, W - 56
    bfnt = fnt("Inter.ttf", 19, 800)
    x = x0
    for label, solid in (("BIG GAME", True), (lg.upper(), False)):
        tw = d.textlength(label, font=bfnt)
        if solid:
            d.rectangle((x, 52, x + tw + 30, 88), fill=hot)
            d.text((x + 15, 70), label, font=bfnt, fill=ink_on(hot), anchor="lm")
        else:
            d.rectangle((x, 52, x + tw + 30, 88), outline=(255, 255, 255), width=2)
            d.text((x + 15, 70), label, font=bfnt, fill=(255, 255, 255), anchor="lm")
        x += tw + 44
    # name: first small, LAST huge
    parts = p["name"].split(" ", 1)
    first, last = (parts[0], parts[1]) if len(parts) > 1 else ("", parts[0])
    d.text((x0, 112), first.upper(), font=fnt("Oswald.ttf", 42, 500), fill=(205, 205, 210))
    size = 132
    while size > 60 and d.textlength(last.upper(), font=fnt("Oswald.ttf", size, 700)) > xr - x0:
        size -= 4
    lf = fnt("Oswald.ttf", size, 700)
    d.text((x0 - 4, 160), last.upper(), font=lf, fill=(255, 255, 255))
    ty = d.textbbox((x0, 160), last.upper(), font=lf)[3] + 20
    # team line with logo
    logo = O.image(((me["team"].get("logos") or [{}])[0]).get("href") or me["team"].get("logo"))
    tx = x0
    if logo:
        logo.thumbnail((40, 40), Image.LANCZOS)
        img.alpha_composite(logo, (x0, ty))
        tx += 52
    d.text((tx, ty + 20), (me["team"].get("displayName") or me["team"].get("abbreviation", "")).upper(), font=fnt("Inter.ttf", 20, 700), fill=(190, 190, 196), anchor="lm")
    # the headline number, glowing, with its label beside it
    ny = ty + 50
    nf = fnt("BarlowCondensed-Bold.ttf", 240)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).text((x0 - 8, ny), big, font=nf, fill=hot + (210,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(20)))
    d = ImageDraw.Draw(img)
    d.text((x0 - 8, ny), big, font=nf, fill=hot)
    nb = d.textbbox((x0 - 8, ny), big, font=nf)
    w1, w2 = (HEAD[top].split(" ", 1) + [""])[:2]
    lab = fnt("Oswald.ttf", 36, 600)
    d.text((nb[2] + 24, nb[3] - 48), w1, font=lab, fill=(255, 255, 255), anchor="ls")
    d.text((nb[2] + 24, nb[3] - 4), w2, font=lab, fill=(255, 255, 255), anchor="ls")

    # 5. stat strip
    ts = tiles(p["s"])
    sy = 690
    d.line((x0, sy, xr, sy), fill=(90, 90, 96), width=1)
    cw = (xr - x0) / len(ts)
    for i, (lab_, val) in enumerate(ts):
        cx = x0 + cw * i + cw / 2
        vs = 60  # shrink until it fits its box with room to spare
        while vs > 30 and d.textlength(str(val), font=fnt("BarlowCondensed-Bold.ttf", vs)) > cw - 26:
            vs -= 2
        d.text((cx, sy + 48), str(val), font=fnt("BarlowCondensed-Bold.ttf", vs), fill=(255, 255, 255), anchor="mm")
        d.text((cx, sy + 94), lab_, font=fnt("Inter.ttf", 15, 700), fill=(150, 150, 158), anchor="mm")
        if i:
            d.line((x0 + cw * i, sy + 20, x0 + cw * i, sy + 108), fill=(70, 70, 76), width=1)
    # 6. final score chip
    won, cy = me.get("winner"), 840
    chip_txt = f"{me.get('score')}-{opp.get('score')}  {'VS' if me.get('homeAway') == 'home' else '@'} {(opp['team'].get('abbreviation') or '').upper()}"
    d.rectangle((x0, cy - 22, x0 + 44, cy + 22), fill=hot if won else (70, 70, 76))
    d.text((x0 + 22, cy), "W" if won else "L", font=fnt("Oswald.ttf", 26, 700), fill=ink_on(hot) if won else (255, 255, 255), anchor="mm")
    cf = fnt("Oswald.ttf", 28, 600)
    d.text((x0 + 60, cy), chip_txt, font=cf, fill=(255, 255, 255), anchor="lm")
    ol = O.image(((opp["team"].get("logos") or [{}])[0]).get("href") or opp["team"].get("logo"))
    if ol:
        ol.thumbnail((34, 34), Image.LANCZOS)
        img.alpha_composite(ol, (round(x0 + 74 + d.textlength(chip_txt, font=cf)), cy - 17))
    d.text((xr, cy), "FINAL", font=fnt("Inter.ttf", 18, 800), fill=(150, 150, 158), anchor="rm")

    # 7. a little film grain so it doesn't look flat
    grain = Image.effect_noise((W, H), 40).point(lambda v: round(abs(v - 128) * 0.22))
    gl = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    gl.putalpha(grain)
    img.alpha_composite(gl)
    return img


def make(pick, out, theme=None, photo=None):
    sc, lg, p, top, comp, s, key = pick
    me = next(c for c in comp["competitors"] if str(c["team"]["id"]) == p["tid"])
    opp = next(c for c in comp["competitors"] if c is not me)
    nm = lambda c: c["team"].get("location") if lg == "cfb" else c["team"].get("name") or c["team"].get("displayName")
    res = f"{'win over' if me.get('winner') else 'loss to'} {nm(opp)}"
    text = f"{p['name']} ({me['team'].get('abbreviation', '')}) went off: {phrase(p['s'])} in {nm(me)}'s {me.get('score')}-{opp.get('score')} {res}."
    theme = theme or O.random.choice(list(O.THEMES))
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"postgame-{lg}-{p['id']}.png")
    card(lg, p, top, comp, photo, theme).convert("RGB").save(png, optimize=True)
    return {"day": "postgame", "stat": key, "theme": theme, "image": png, "text": tweet(text, "", with_link=False), "skip": False, "reason": ""}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--league", choices=["both", "nfl", "cfb"], default="both")
    ap.add_argument("--hours", type=float, default=9, help="games that kicked off this many hours ago or less")
    ap.add_argument("--theme", choices=["random", *O.THEMES], default="random")
    ap.add_argument("--top", type=int, default=1, help="render the best N (tests); only the best one becomes today.json")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    picks = best(["nfl", "cfb"] if a.league == "both" else [a.league], a.hours)
    if not picks:
        print("No big games this time. Nothing to post.")
        return
    # every card needs an action shot of him: a big game without one gives way to the next best that has one
    made = 0
    for pk in picks:
        photo = action_shot(pk[5], pk[2])
        if not photo:
            print(f"[{pk[1]} {pk[0]:.2f}] {pk[2]['name']}: no action shot, skipping")
            continue
        m = make(pk, a.out, None if a.theme == "random" else a.theme, photo)
        print(f"[{pk[1]} {pk[0]:.2f}] {m['image']} ({len(m['text'])} chars)\n   {m['text']}")
        if not made:
            with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
                json.dump(m, fh, indent=1, ensure_ascii=False)
        made += 1
        if made >= a.top:
            break
    if not made:
        print("No big game with an action shot this time. Nothing to post.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
