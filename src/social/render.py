"""Daily social graphics for the X account.

Reads the same JSON the site serves (docs/data/...) and renders one PNG plus the
tweet text for today's slot in the weekly rotation:

    Mon  CFB power rankings top 10 + biggest movers
    Tue  NFL power rankings top 10 + biggest movers
    Wed  Most padded schedules (Cupcake score) among the CFB top 25
    Thu  NFL Cupcake Bully of the Week
    Sat  CFB Cupcake Bully of the Week (slot "bully_cfb", bully.yml: ~11:40 PM Eastern with retries), Sun NFL game day
    Fri  (rest day: nothing posts)
    Sat  CFB game day: the week's biggest games with model win odds
    Sun  NFL game day: the slate with model win odds

Usage:
    python src/social/render.py                    # today's slot (US Eastern date) -> out/social/
    python src/social/render.py --day fri          # one specific slot
    python src/social/render.py --all --out DIR    # every slot (for previews)

Each slot writes <out>/<day>.png, <day>.txt (tweet text) and <day>.json
(metadata, including "skip": true when there's nothing fresh to post).
This script never talks to X. Posting lives in post_to_x.py.
"""
import argparse
import datetime as dt
import io
import re
import json
import os
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "docs", "data")
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = "https://cupcakeindex.com"
MOTTO = "Cupcake (n.): an opponent far below your level, scheduled for an easy win."  # tweet text
MOTTO_WORD, MOTTO_POS, MOTTO_DEF = "cup·cake", "n.", "an opponent far below your level, scheduled for an easy win."


def draw_motto(d, x, y, size, ink, muted, accent, right=False, font_for=None):
    """The site's motto on a card, dictionary style: 'cup·cake' bold, 'n.' in the accent color, the definition muted.
    (x, y) is the left end (or the right end with right=True), vertically centered on y."""
    f = font_for or font
    parts = [(MOTTO_WORD + " ", f(size, "Bold"), ink), (MOTTO_POS + " ", f(size, "Bold"), accent), (MOTTO_DEF, f(size), muted)]
    total = sum(d.textlength(t, font=ft) for t, ft, _ in parts)
    cx = x - total if right else x
    for t, ft, col in parts:
        d.text((cx, y), t, font=ft, fill=col, anchor="lm")
        cx += d.textlength(t, font=ft)
STALE_DAYS = 10            # don't post rankings older than this (offseason / broken weekly run)
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# ------------------------------------------------------------------ look (matches branding/twitter-banner.html)
W, H = 1600, 900
BG = (10, 10, 11)          # #0a0a0b
DOT = (30, 30, 34)
INK = (236, 236, 236)      # #ececec
MUTED = (138, 138, 143)    # #8a8a8f
DIM = (70, 70, 76)
LINE = (38, 38, 42)
PANEL = (20, 20, 22)
ACCENT = (255, 107, 44)    # #ff6b2c
GOOD = (60, 207, 126)
BAD = (255, 107, 107)
PAD = 64                   # outer margin


def font(size, weight="Regular"):
    return ImageFont.truetype(os.path.join(HERE, "fonts", f"JetBrainsMono-{weight}.ttf"), size)


def hex_rgb(h, default=(90, 90, 96)):
    try:
        h = h.lstrip("#")
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return default


def fit(d, text, f, max_w):
    """Trim text with an ellipsis so it fits max_w pixels."""
    if d.textlength(text, font=f) <= max_w:
        return text
    while text and d.textlength(text + "…", font=f) > max_w:
        text = text[:-1]
    return text.rstrip() + "…"


_logo_cache = {}


def team_logo(url, size):
    """Team logo from the CDN the site uses; None if offline (we fall back to a color chip)."""
    if not url or os.environ.get("SOCIAL_NO_LOGOS"):
        return None
    if url not in _logo_cache:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 cupcakeindex-social"})
            raw = urllib.request.urlopen(req, timeout=8).read()
            _logo_cache[url] = Image.open(io.BytesIO(raw)).convert("RGBA")
        except Exception:
            _logo_cache[url] = None
    im = _logo_cache[url]
    if im is None:
        return None
    im = im.copy()
    im.thumbnail((size, size), Image.LANCZOS)
    return im


def chip(img, d, t, x, y, size):
    """Team logo at (x, y), or a team-color square if the logo can't be fetched."""
    lg = team_logo(t.get("logo"), size)
    if lg:
        img.alpha_composite(lg, (x + (size - lg.width) // 2, y + (size - lg.height) // 2))
    else:
        d.rounded_rectangle((x + 4, y + 4, x + size - 4, y + size - 4), 6, fill=hex_rgb(t.get("color", "")))


# ------------------------------------------------------------------ canvas: background, header, footer watermark
def canvas(league, kicker, title, subtitle):
    img = Image.new("RGBA", (W, H), BG + (255,))
    d = ImageDraw.Draw(img)
    for gx in range(12, W, 24):                      # the banner's faint dot grid
        for gy in range(12, H, 24):
            d.ellipse((gx - 1, gy - 1, gx + 1, gy + 1), fill=DOT)
    # header: > CUPCAKE_INDEX  ............  [CFB] WEEK 4
    f = font(22, "Bold")
    d.text((PAD, 44), ">", font=f, fill=ACCENT)
    d.text((PAD + 30, 44), "CUPCAKE", font=f, fill=INK)
    d.text((PAD + 30 + d.textlength("CUPCAKE", font=f), 44), "_INDEX", font=f, fill=ACCENT)
    tag_f = font(20, "Bold")
    x = W - PAD
    for tag, color in reversed([(league.upper(), ACCENT), (kicker.upper(), MUTED)] if league else [(kicker.upper(), MUTED)]):
        tw = d.textlength(tag, font=tag_f)
        d.rectangle((x - tw - 24, 40, x, 76), outline=color, width=2)
        d.text((x - tw - 12, 46), tag, font=tag_f, fill=color)
        x -= tw + 24 + 12
    d.text((PAD, 100), title, font=font(60, "ExtraBold"), fill=INK)
    if subtitle:
        d.text((PAD, 178), subtitle, font=font(24), fill=MUTED)
    # footer: motto bottom left, cupcake mark + cupcakeindex.com bottom right
    ff = font(22)
    draw_motto(d, PAD, H - 50, 22, INK, (110, 110, 116), ACCENT)
    url_f = font(26, "Bold")
    url = "cupcakeindex.com"
    uw = d.textlength(url, font=url_f)
    d.text((W - PAD - uw, H - 66), url, font=url_f, fill=INK)
    d.text((W - PAD - uw - 34, H - 66), ">", font=url_f, fill=ACCENT)
    mark = Image.open(os.path.join(HERE, "assets", "logo-mark.png")).convert("RGBA")
    mh = 64
    mark = mark.resize((round(mark.width * mh / mark.height), mh), Image.LANCZOS)
    img.alpha_composite(mark, (int(W - PAD - uw - 34 - 18 - mark.width), H - 50 - mh + 12))
    return img, d


TOP = 240          # content starts below the title block
BOTTOM = H - 100   # and ends above the footer


# ------------------------------------------------------------------ data
def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def site_rank(week_json, info):
    """Re-rank teams the way the website does (app.js composite): the Default weights blend of factor
    scores, inverted factors counting as 100 - score. Stored as power_rank so every card matches the site."""
    w, inv = info["default_weights"], {f["key"] for f in info["factors"] if f.get("invert")}
    total = sum(w.values())
    val = lambda t, k: 100 - t["scores"].get(k, 50) if k in inv else t["scores"].get(k, 50)
    comp = lambda t: sum(x * val(t, k) for k, x in w.items()) / total if total else t["scores"]["power"]
    for i, t in enumerate(sorted(week_json["teams"], key=lambda t: (-comp(t), -t["rating"]))):
        t["power_rank"] = i + 1
    return week_json


def latest(league):
    idx = load(os.path.join(DATA, "index.json"))
    info = idx["leagues"][league]
    lt = info["latest"]
    season, week = lt["season"], lt["week"]
    cur = site_rank(load(os.path.join(DATA, league, str(season), f"week_{week}.json")), info)
    prev_path = os.path.join(DATA, league, str(season), f"week_{week - 1}.json")
    prev = site_rank(load(prev_path), info) if os.path.exists(prev_path) else None
    acc = idx["leagues"][league]["seasons"].get(str(season), {}).get("accuracy", {})
    return cur, prev, acc


def is_stale(week_json, today):
    try:
        gen = dt.datetime.fromisoformat(week_json["generated"]).date()
    except Exception:
        return False
    return (today - gen).days > STALE_DAYS


def short(name, league):
    """NFL: 'Pittsburgh Steelers' -> 'Steelers'. CFB names are already short."""
    if league == "nfl":
        return name.split()[-1]
    return name


def link(view, league):
    return f"{SITE}/#/{view}?league={league}"


def ranked(cur):
    return sorted(cur["teams"], key=lambda t: t["power_rank"])


def moves(cur, prev):
    """team -> spots moved since last week (positive = up), None if no prior week."""
    if not prev:
        return {}
    before = {t["team"]: t["power_rank"] for t in prev["teams"]}
    return {t["team"]: before[t["team"]] - t["power_rank"] for t in cur["teams"] if t["team"] in before}


# ------------------------------------------------------------------ Mon/Tue: power rankings top 10 + movers
def rankings_card(league, today):
    cur, prev, _ = latest(league)
    week = cur["week"]
    mv = moves(cur, prev)
    teams = ranked(cur)
    lname = "College football" if league == "cfb" else "NFL"
    img, d = canvas(league, f"Week {week}", f"{lname} power rankings",
                    "Opponent-adjusted. Schedule-aware. Unimpressed by cupcakes.")
    # left: top-10 table
    row_h = (BOTTOM - TOP - 40) // 10
    f_rank, f_team, f_meta = font(30, "ExtraBold"), font(28, "Bold"), font(22)
    tx, tw = PAD, 900
    d.text((tx + 540, TOP), "RECORD", font=font(16, "Bold"), fill=DIM)
    d.text((tx + 700, TOP), "RATING", font=font(16, "Bold"), fill=DIM)
    d.text((tx + tw, TOP), "MOVE", font=font(16, "Bold"), fill=DIM, anchor="ra")
    for i, t in enumerate(teams[:10]):
        y = TOP + 30 + i * row_h
        if i:
            d.line((tx, y - 4, tx + tw, y - 4), fill=LINE, width=1)
        cy = y + row_h // 2 - 4
        d.text((tx, cy), f"{t['power_rank']:>2}", font=f_rank, fill=ACCENT if i == 0 else INK, anchor="lm")
        chip(img, d, t, tx + 62, cy - 22, 44)
        d.text((tx + 124, cy), fit(d, t["team"], f_team, 400), font=f_team, fill=INK, anchor="lm")
        d.text((tx + 540, cy), t["record"], font=f_meta, fill=MUTED, anchor="lm")
        d.text((tx + 700, cy), f"{t['rating']:+.1f}", font=f_meta, fill=MUTED, anchor="lm")
        m = mv.get(t["team"])
        if m is None and prev:
            txt, col = "NEW", ACCENT
        elif not m:
            txt, col = "—", DIM
        else:
            txt, col = (f"▲{m}", GOOD) if m > 0 else (f"▼{-m}", BAD)
        d.text((tx + tw, cy), txt, font=font(24, "Bold"), fill=col, anchor="rm")
    # right: biggest movers inside the top 25 (top 16 in the NFL)
    pool = 25 if league == "cfb" else 16
    px, pw = tx + tw + 60, W - PAD - (tx + tw + 60)
    d.rectangle((px, TOP, px + pw, BOTTOM - 24), fill=PANEL, outline=LINE)
    d.text((px + 28, TOP + 22), f"BIGGEST MOVES · TOP {pool}", font=font(18, "Bold"), fill=MUTED)
    inside = [t for t in teams[:pool] if t["team"] in mv]
    up = sorted([t for t in inside if mv[t["team"]] > 0], key=lambda t: -mv[t["team"]])[:3]
    down = sorted([t for t in teams if t["team"] in mv and mv[t["team"]] < 0 and
                   t["power_rank"] + mv[t["team"]] <= pool], key=lambda t: mv[t["team"]])[:3]
    y = TOP + 70
    for label, group, col in (("CLIMBING", up, GOOD), ("SLIDING", down, BAD)):
        d.text((px + 28, y), label, font=font(20, "Bold"), fill=col)
        y += 40
        if not group:
            d.text((px + 28, y), "nobody" if prev else "first week: no moves yet", font=font(22), fill=DIM)
            y += 46
        for t in group:
            m = mv[t["team"]]
            d.text((px + 28, y), fit(d, short(t["team"], league), font(26, "Bold"), pw - 200), font=font(26, "Bold"), fill=INK)
            d.text((px + pw - 28, y), f"{t['power_rank'] + m}→{t['power_rank']}", font=font(24), fill=col, anchor="ra")
            y += 46
        y += 24
    top = teams[0]
    riser = up[0] if up else None
    faller = down[0] if down else None
    s_ = "" if league == "nfl" else "s"     # "the Jaguars climb", "Boise State climbs"
    bits = [f"{lname} power rankings, Week {week}: {short(top['team'], league)} ({top['record']}) hold{s_} No. 1."]
    if riser:
        bits.append(f"{short(riser['team'], league)} climb{s_} {mv[riser['team']]} to No. {riser['power_rank']}.")
    if faller:
        bits.append(f"{short(faller['team'], league)} slide{s_} {-mv[faller['team']]} to No. {faller['power_rank']}.")
    bits.append("Records lie. Margins don't.")
    text = " ".join(bits)
    return img, text, link("rankings", league), is_stale(cur, today)


# ------------------------------------------------------------------ Wed: most padded schedules
def cupcake_card(today):
    cur, _, _ = latest("cfb")
    week = cur["week"]
    top25 = ranked(cur)[:25]
    padded = sorted(top25, key=lambda t: -t["scores"]["cupcake"])[:8]
    img, d = canvas("cfb", f"Week {week}", "Most padded résumés",
                    "Cupcake score (0-100) for the top 25. Higher = more wins vs. teams far below their level.")
    lab_w, bar_x0 = 470, PAD + 470
    bar_w = W - PAD - bar_x0 - 330
    row_h = (BOTTOM - TOP - 30) // len(padded)
    for i, t in enumerate(padded):
        y = TOP + 20 + i * row_h
        cy = y + row_h // 2
        chip(img, d, t, PAD, cy - 22, 44)
        d.text((PAD + 60, cy), fit(d, f"#{t['power_rank']} {t['team']}", font(26, "Bold"), lab_w - 80), font=font(26, "Bold"), fill=INK, anchor="lm")
        s = t["scores"]["cupcake"]
        bh = min(34, row_h - 26)
        d.rectangle((bar_x0, cy - bh // 2, bar_x0 + bar_w, cy + bh // 2), fill=PANEL)
        d.rectangle((bar_x0, cy - bh // 2, bar_x0 + int(bar_w * s / 100), cy + bh // 2), fill=ACCENT if i == 0 else (200, 86, 38))
        d.text((bar_x0 + bar_w + 18, cy), f"{s:.0f}", font=font(28, "ExtraBold"), fill=INK, anchor="lm")
        meta = " · ".join([t["record"]] + ([f"{t['fcs_games']} FCS"] if t.get("fcs_games") else [])
                          + ([f"{t['weak_games']} soft"] if t.get("weak_games") else []))
        d.text((W - PAD, cy), meta, font=font(20), fill=MUTED, anchor="rm")
    t0 = padded[0]
    fcs = f", {t0['fcs_games']} FCS" if t0["fcs_games"] else ""
    text = (f"Most padded résumés in the top 25 after Week {week}: {t0['team']} leads with a Cupcake score of "
            f"{t0['scores']['cupcake']:.0f} ({t0['record']}{fcs}). Higher = more padding, and it counts against you. "
            f"{MOTTO}")
    return img, text, link("schedules", "cfb"), is_stale(cur, today)


# ------------------------------------------------------------------ Bully of the Week (NFL Thu, CFB Sun)
def cfb_bully_now(today):
    """College Bully of the Week from this week's final scores (Thu-Sat), the morning after: the weekly rankings
    don't run until Monday. Same rules as model.cupcake_of_week, using the latest ratings (through last week):
    a 21+ point win over a cupcake for the winner (FCS, or a below-average FBS team 14+ points worse).
    Score = margin + how far below an average FBS team the loser is."""
    import yaml
    cfg = yaml.safe_load(open(os.path.join(ROOT, "src", "config.yaml"), encoding="utf-8"))["cfb"]["model"]
    cur, _, _ = latest("cfb")
    fbs = {str(t["id"]): t for t in cur["teams"] if t.get("id")}
    fcs = {n.lower(): r for n, r in cur.get("fcs_ratings", [])}
    def weight(tr, orr, is_fcs):  # model.cupcake_weight
        full, gap = cfg["cupcake_gap"] + cfg["cupcake_span"], tr - orr
        if is_fcs:
            return min(1.0, max(0.05, gap / full))
        return 0.0 if orr >= cfg.get("cupcake_max_opp", 0.0) else min(1.0, max(0.0, (gap - cfg["cupcake_gap"]) / cfg["cupcake_span"]))
    best = None
    sat = today - dt.timedelta(days=(today.weekday() - 5) % 7)  # Saturday night (today) or Sunday (yesterday)
    for back in (0, 1, 2):  # Saturday, Friday, Thursday
        day = (sat - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={day}&groups=80&limit=400"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
            events = json.load(r).get("events", [])
        for e in events:
            c = e["competitions"][0]
            if not c["status"]["type"].get("completed") or len(c["competitors"]) != 2:
                continue
            for me in c["competitors"]:
                op = next(x for x in c["competitors"] if x is not me)
                t = fbs.get(str(me["team"]["id"]))
                us, them = int(me.get("score") or 0), int(op.get("score") or 0)
                if not t or us - them < cfg.get("cotw_min_margin", 21):
                    continue
                o = fbs.get(str(op["team"]["id"]))
                ro = o["rating"] if o else fcs.get((op["team"].get("location") or "").lower(), cfg["fcs_rating"])
                if not weight(t["rating"], ro, not o) or t["rating"] - ro < cfg.get("cotw_min_gap", 0):
                    continue
                score = (us - them) - ro
                if best is None or score > best["score"]:
                    best = {"team": t["team"], "opp": o["team"] if o else op["team"].get("location", ""), "fcs": not o,
                            "opp_rank": o and o.get("power_rank"), "score_line": f"{us}-{them}", "margin": us - them, "score": round(score, 1),
                            "espn_id": e.get("id")}
    return best


def cfb_bully_slot(today):
    """Saturday-night college Bully (bully.yml). Also writes docs/data/cfb/bully_now.json so the site's banner
    shows it right away, before the rankings run makes it official. If the rankings already ran for this
    weekend's games, their pick is used as is."""
    cur, _, _ = latest("cfb")
    sat = today - dt.timedelta(days=(today.weekday() - 5) % 7)
    gen = dt.datetime.fromisoformat(cur["generated"]).date() if cur.get("generated") else None
    if gen and gen > sat:
        return bully_card(today, ("cfb",))
    b = cfb_bully_now(today)
    with open(os.path.join(DATA, "cfb", "bully_now.json"), "w", encoding="utf-8") as f:
        json.dump({"season": cur["season"], "week": cur["week"] + 1, "date": sat.isoformat(), "bully": b}, f, ensure_ascii=False)
    return bully_card(today, ("cfb",), {"cfb": b})


def bully_card(today, leagues=("cfb", "nfl"), now=None):
    """now: {league: bully} computed fresh (the CFB Sunday post); otherwise the latest rankings file's pick."""
    img, d = canvas("", "Bully of the Week", "Cupcake Bully of the Week",
                    "The biggest beating of an overmatched opponent. We see you.")
    lines, stale = [], True
    col_w = (W - 2 * PAD - 40 * (len(leagues) - 1)) // len(leagues)
    for i, league in enumerate(leagues):
        cur, _, _ = latest(league)
        stale = stale and is_stale(cur, today)
        c = (now or {}).get(league) if now is not None else cur.get("cupcake_of_week")
        x = PAD + i * (col_w + 40)
        d.rectangle((x, TOP, x + col_w, BOTTOM - 24), fill=PANEL, outline=LINE)
        tag = f"{league.upper()} · WEEK {cur['week'] + (1 if now is not None else 0)}"
        d.text((x + 32, TOP + 28), tag, font=font(20, "Bold"), fill=ACCENT)
        if not c:
            d.text((x + 32, TOP + 90), "No bully this week.", font=font(30, "Bold"), fill=MUTED)
            continue
        team = next((t for t in cur["teams"] if t["team"] == c["team"]), {"team": c["team"]})
        chip(img, d, team, x + 32, TOP + 80, 96)
        nm_f = font(40, "ExtraBold") if league == "cfb" else font(36, "ExtraBold")
        d.text((x + 148, TOP + 92), fit(d, c["team"], nm_f, col_w - 180), font=nm_f, fill=INK)
        d.text((x + 148, TOP + 146), f"#{team.get('power_rank', '?')} in our rankings", font=font(20), fill=MUTED)
        d.text((x + 32, TOP + 220), c["score_line"], font=font(96, "ExtraBold"), fill=ACCENT)
        opp = c["opp"] + (" (FCS)" if c.get("fcs") else "") + (f" · #{c['opp_rank']}" if c.get("opp_rank") and league == "cfb" else "")
        d.text((x + 32, TOP + 340), "over " + fit(d, opp, font(28, "Bold"), col_w - 140), font=font(28, "Bold"), fill=INK)
        # bully score meter
        my = BOTTOM - 100
        d.text((x + 32, my - 36), "BULLY SCORE", font=font(18, "Bold"), fill=MUTED)
        d.text((x + col_w - 32, my - 40), f"{c['score']:.0f}", font=font(30, "ExtraBold"), fill=INK, anchor="ra")
        d.rectangle((x + 32, my, x + col_w - 32, my + 18), fill=(34, 34, 38))
        d.rectangle((x + 32, my, x + 32 + int((col_w - 64) * min(c["score"], 100) / 100), my + 18), fill=ACCENT)
        lines.append(f"{league.upper()}: {short(c['team'], league)} {c['score_line']} over {short(c['opp'], league)}"
                     + (" (FCS)" if c.get("fcs") else "") + ".")
    if not lines:
        return img, "", link("rankings", leagues[0]), True  # no bully: no post
    text = "Cupcake Bully of the Week. " + " ".join(lines) + " Congrats on the win. It's not a résumé."
    return img, text, link("rankings", leagues[0]), stale


# ------------------------------------------------------------------ Fri: model vs Vegas
def gameday_card(league, today):
    cur, _, _ = latest(league)
    rank = {t["team"]: t for t in cur["teams"]}
    preds = [p for p in cur.get("predictions", []) if p["home"] in rank and p["away"] in rank]
    wk = preds[0]["week"] if preds else cur["week"] + 1
    # "biggest" game = best combined rank (both teams matter, the worse one most)
    preds.sort(key=lambda p: max(rank[p["home"]]["power_rank"], rank[p["away"]]["power_rank"]) * 2
               + min(rank[p["home"]]["power_rank"], rank[p["away"]]["power_rank"]))
    games = preds[:6]
    lname = "College football" if league == "cfb" else "NFL"
    img, d = canvas(league, f"Week {wk}", f"Game day: {'the big ones' if league == 'cfb' else 'the slate'}",
                    "Model win probability for the week's best matchups (by our power ranking).")
    if not games:
        d.text((PAD, TOP + 80), "No games on the board.", font=font(30, "Bold"), fill=MUTED)
    row_h = (BOTTOM - TOP - 10) // 6
    name_w = 360
    bx0, bx1 = PAD + 70 + name_w + 20, W - PAD - 70 - name_w - 20
    for i, p in enumerate(games):
        a, h = rank[p["away"]], rank[p["home"]]
        y = TOP + i * row_h
        cy = y + row_h // 2
        if i:
            d.line((PAD, y, W - PAD, y), fill=LINE)
        hp = p["home_win_prob"]
        chip(img, d, a, PAD, cy - 24, 48)
        d.text((PAD + 64, cy - 14), fit(d, short(a["team"], league), font(26, "Bold"), name_w), font=font(26, "Bold"), fill=INK, anchor="lm")
        d.text((PAD + 64, cy + 18), f"#{a['power_rank']} · {a['record']}", font=font(18), fill=MUTED, anchor="lm")
        chip(img, d, h, W - PAD - 48, cy - 24, 48)
        d.text((W - PAD - 64, cy - 14), fit(d, "@ " + short(h["team"], league), font(26, "Bold"), name_w), font=font(26, "Bold"), fill=INK, anchor="rm")
        d.text((W - PAD - 64, cy + 18), f"#{h['power_rank']} · {h['record']}", font=font(18), fill=MUTED, anchor="rm")
        # win-probability bar: away share from the left, home share from the right; favorite in orange
        split = bx0 + int((bx1 - bx0) * (1 - hp))
        bt, bb = cy - 6, cy + 14
        d.rectangle((bx0, bt, split, bb), fill=ACCENT if hp < 0.5 else (64, 64, 70))
        d.rectangle((split, bt, bx1, bb), fill=ACCENT if hp >= 0.5 else (64, 64, 70))
        d.text((bx0, bt - 8), chance(1 - hp), font=font(20, "Bold"), fill=INK if hp < 0.5 else MUTED, anchor="lb")
        d.text((bx1, bt - 8), chance(hp), font=font(20, "Bold"), fill=INK if hp >= 0.5 else MUTED, anchor="rb")
    if games:
        g = games[0]
        fav = g["home"] if g["home_win_prob"] >= 0.5 else g["away"]
        pr = max(g["home_win_prob"], 1 - g["home_win_prob"])
        close = min(games, key=lambda p: abs(p["home_win_prob"] - 0.5))
        text = (f"{lname} game day, Week {wk}. Headliner: {short(g['away'], league)} @ {short(g['home'], league)}, "
                f"model likes {short(fav, league)} at {chance(pr)}. Coin flip of the day: "
                f"{short(close['away'], league)} @ {short(close['home'], league)}. No cupcakes were harmed in this graphic.")
    else:
        text = f"No {lname} games on the board this week."
    return img, text, link("scores", league), is_stale(cur, today) or not games


# ------------------------------------------------------------------ driver
SLOTS = {
    "mon": lambda today: rankings_card("cfb", today),
    "tue": lambda today: rankings_card("nfl", today),
    "wed": cupcake_card,
    "thu": lambda today: bully_card(today, ("nfl",)),
    "fri": lambda today: (Image.new("RGB", (16, 9)), "", SITE, True),  # rest day: no post (no betting content)
    "sat": lambda today: gameday_card("cfb", today),
    "sun": lambda today: gameday_card("nfl", today),
    "bully_cfb": cfb_bully_slot,
}


def chance(p):
    """Win chance as text, never 100% (or 0%) before the game: 99.9% is the cap."""
    v = max(0.0, min(1.0, p)) * 100
    return f"{min(99.9, v):.1f}%" if v >= 99.5 else f"{max(0.1, v):.1f}%" if v < 0.5 else f"{round(v)}%"


def x_len(text):
    """Length the way X counts it for unverified accounts: links are 23, emoji and other wide characters are 2."""
    text = re.sub(r"https?://\S+", "x" * 23, text)
    return sum(2 if ord(c) > 0x10FF else 1 for c in text)


def tweet(text, url, with_link=True):
    """Keep it under X's 280 (a link always counts as 23 characters, plus the newline before it)."""
    budget = 280 - (24 if with_link else 0)
    while x_len(text) > budget:
        text = text[:-2].rsplit(" ", 1)[0] + "…"
    return f"{text}\n{url}" if with_link else text


def render(day, out, today):
    img, text, url, skip = SLOTS[day](today)
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"{day}.png")
    img.convert("RGB").save(png, optimize=True)
    # no link by default (Terry's call; also ~13x cheaper per post). Set repo variable X_INCLUDE_LINK=true to add it.
    with_link = os.environ.get("X_INCLUDE_LINK", "false").lower() == "true"
    body = tweet(text, url, with_link)
    with open(os.path.join(out, f"{day}.txt"), "w", encoding="utf-8") as f:
        f.write(body)
    meta = {"day": day, "image": png, "text": body, "skip": bool(skip),
            "reason": "data is stale or empty" if skip else ""}
    with open(os.path.join(out, f"{day}.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day", choices=list(SLOTS), help="rotation slot (default: today's, US Eastern); bully_cfb = Saturday night's college Bully of the Week")
    ap.add_argument("--all", action="store_true", help="render every slot")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    ap.add_argument("--date", help="pretend today is YYYY-MM-DD (staleness check + default slot)")
    a = ap.parse_args()
    # US Eastern date (fixed UTC-5 is close enough: the workflow runs mid-morning, nowhere near midnight)
    today = dt.date.fromisoformat(a.date) if a.date else (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date()
    days = list(SLOTS) if a.all else [a.day or DAYS[today.weekday()]]
    for day in days:
        m = render(day, a.out, today)
        print(f"[{day}] {'SKIP ' if m['skip'] else ''}{m['image']} ({len(m['text'])} chars)")
        print("   " + m["text"].replace("\n", "\n   "))
    # the workflow posts today's slot; point it at the right files
    if not a.all:
        with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as f:
            json.dump(m, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
