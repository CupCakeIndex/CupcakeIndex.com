"""Prime-time matchup post for X: an Offense radar and a Defense radar, both teams overlapping on each, like
Stats > Visualize > Radar on the site with Offense only / Defense only picked.

Runs every afternoon in season and only posts when there's a key night game (kickoff 7 PM Eastern or later):
  - NFL: any prime-time game (Thursday, Sunday and Monday night, Saturday nights late in the season)
  - college: a night game between two AP top-25 teams, or any night game with an AP top-5 team (Terry: "anytime a
    top 5 team plays"), when there's no NFL prime-time game that day
Each spoke is that team's season so far as a percentile among every team in its league (100 = best), with its rank
and BEST / TOP 5 / BOTTOM 5 / WORST tags, in the team's colors. The numbers come from the same files and formulas as
the site (docs/data/viz, viz.js), the win chance from our model's predictions. No lines, no link.

    python src/social/primetime.py                    # today (US Eastern)
    python src/social/primetime.py --date 2026-10-26  # pretend it's another day
"""
import argparse
import colorsys
import datetime as dt
import json
import math
import os
import sys

import requests
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import (ACCENT, BOTTOM, DATA, INK, LINE, MUTED, PAD, ROOT, TOP, W, canvas, chance, chip, fit, font,  # noqa: E402
                    hex_rgb, is_stale, latest, tweet, x_len)

ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"}
try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo("America/New_York")
except Exception:  # Windows without tz data: daylight time is close enough for a local test
    EASTERN = dt.timezone(dt.timedelta(hours=-4))
NIGHT = 19  # 7 PM Eastern or later counts as prime time
SHOWS = {0: ("Monday Night Football", "MNF"), 3: ("Thursday Night Football", "TNF"), 6: ("Sunday Night Football", "SNF")}

# The site's stats (viz.js), same formulas. S = season totals, g = games. key: (label, value(S, g), lower is better, columns it needs)
div = lambda a, b: a / b if b else None
STATS = {
    "epa_play": ("EPA per play", lambda S, g: div(S["epa"], S["adv_plays"]) if "adv_plays" in S else div(S["pass_epa"] + S["rush_epa"], S["plays"]), False, []),
    "ppa_play": ("PPA per play", None, False, ["ss_epa"]),  # season-long college file only; not in these totals, so skipped like the site's fallback
    "succ": ("Success rate", lambda S, g: div(100 * S["succ"], S["adv_plays"]), False, ["succ"]),
    "ypp": ("Yards per play", lambda S, g: div(S["pass_yds"] + S["rush_yds"], S["plays"]), False, []),
    "pts": ("Points scored", lambda S, g: div(S["pts"], g), False, []),
    "third": ("Third-down %", lambda S, g: div(100 * S["third_conv"], S["third_att"]), False, ["third_att"]),
    "pts_drive": ("Points per drive", lambda S, g: div(S["pts"], S["drives"]), False, ["drives"]),
    "giveaways": ("Turnovers", lambda S, g: div(S["int"] + S["fum_lost"], g), True, []),
    "def_epa_play": ("EPA allowed", lambda S, g: div(S["def_epa"], S["def_adv_plays"]) if "def_adv_plays" in S else div(S["opp_epa"], S["opp_plays"]), True, []),
    "def_succ": ("Success rate allowed", lambda S, g: div(100 * S["def_succ"], S["def_adv_plays"]), True, ["def_succ"]),
    "opp_pts": ("Points allowed", lambda S, g: div(S["opp_pts"], g), True, []),
    "opp_yds": ("Yards allowed", lambda S, g: div(S["opp_yds"] if "opp_yds" in S else S["opp_pass_yds"] + S["opp_rush_yds"], g), True, []),
    "def_sacks": ("Sacks", lambda S, g: div(S["def_sacks"], g), False, []),
    "takeaways": ("Takeaways", lambda S, g: div(S["def_int"] + S["def_fr"], g), False, ["def_fr"]),
    "opp_pts_play": ("Points allowed per play", lambda S, g: div(S["opp_pts"], S["opp_plays"]), True, ["opp_plays"]),
}
# the site's Offense only / Defense only views (viz.js RVIEWS): the first 5 of each list this league has
VIEWS = [("Offense", ["epa_play", "ppa_play", "succ", "ypp", "pts", "third", "pts_drive", "giveaways"]),
         ("Defense", ["def_epa_play", "def_succ", "opp_pts", "opp_yds", "def_sacks", "takeaways", "opp_pts_play"])]


# ------------------------------------------------------------------ the games
def night_games(league, day):
    """Today's games that haven't started, kicking off 7 PM Eastern or later: [(event, kickoff, away, home)]."""
    params = {"dates": day.strftime("%Y%m%d")}
    if league == "cfb":
        params["groups"] = 80  # FBS
    try:
        events = requests.get(ESPN[league], params=params, timeout=30).json().get("events", [])
    except (requests.RequestException, ValueError) as e:
        print(f"{league}: ESPN scoreboard unavailable ({e})")
        return []
    out = []
    for e in events:
        kick = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(EASTERN)
        if e["status"]["type"]["state"] != "pre" or kick.date() != day or kick.hour < NIGHT:
            continue
        side = {c["homeAway"]: c for c in e["competitions"][0]["competitors"]}
        if "home" in side and "away" in side:
            out.append((e, kick, side["away"], side["home"]))
    return out


def pick_game(day):
    """The key prime-time game: NFL first; else a college night game between two AP top-25 teams (best ranks first),
    else one with an AP top-5 team (the best-ranked one)."""
    nfl = night_games("nfl", day)
    if nfl:
        return "nfl", nfl[0]
    ap = lambda c: (c.get("curatedRank") or {}).get("current") or 99
    cfb = [g for g in night_games("cfb", day) if ap(g[2]) <= 25 and ap(g[3]) <= 25 or min(ap(g[2]), ap(g[3])) <= 5]
    if cfb:
        return "cfb", min(cfb, key=lambda g: (max(ap(g[2]), ap(g[3])) > 25, ap(g[2]) + ap(g[3]) if max(ap(g[2]), ap(g[3])) <= 25 else min(ap(g[2]), ap(g[3]))))
    return None, None


# ------------------------------------------------------------------ the numbers (same as the site's radar)
def season_file(league):
    idx = json.load(open(os.path.join(DATA, "viz", "index.json"), encoding="utf-8"))
    return json.load(open(os.path.join(DATA, "viz", f"{league}_{idx[league][-1]}.json"), encoding="utf-8"))


def profiles(league):
    """{team key: {stat: (value, percentile, rank, tag)}} for every team, the two views [(name, [stat keys])], team count, season."""
    D = season_file(league)
    cols = D["tcols"]
    tot, games = {}, {}
    for r in D["trows"]:
        S = tot.setdefault(r[0], {c: 0 for c in cols})
        for c, v in zip(cols, r[3:]):
            S[c] += v or 0
        games[r[0]] = games.get(r[0], 0) + 1
    usable = lambda k: STATS[k][1] and all(c in cols for c in STATS[k][3])
    views = [(name, [k for k in keys if usable(k)][:5]) for name, keys in VIEWS]
    out = {k: {} for k in tot}
    for key in {k for _, ks in views for k in ks}:
        _, f, low, _ = STATS[key]
        vals = {k: f(tot[k], games[k]) for k in tot}
        have = [v for v in vals.values() if v is not None]
        for k, v in vals.items():
            if v is None:
                continue
            better = sum(1 for x in have if (x < v if low else x > v))
            worse = sum(1 for x in have if (x > v if low else x < v))
            pct = round(100 * worse / max(1, len(have) - 1))
            five = len(have) >= 15
            tag = "BEST" if not better else "WORST" if not worse else "TOP 5" if five and better < 5 else "BOTTOM 5" if five and worse < 5 else ""
            out[k][key] = (v, pct, better + 1, tag)
    return out, views, len(tot), D["season"]


# ------------------------------------------------------------------ team colors (same rule as the site's charts)
def lum(c):
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255


def lift(c):
    """Lighter in the same hue until it shows on the dark card (burgundy stays burgundy, navy stays blue)."""
    if lum(c) >= 0.4:
        return c
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
    s = min(0.85, s)
    while lum(c) < 0.4 and l < 0.85:
        l += 0.02
        c = tuple(round(v * 255) for v in colorsys.hls_to_rgb(h, l, s))
    return c


def team_colors(league, away_id, home_id):
    """[(line, dots)] for away, home: each team's main color (lifted), dots in its other color. The webs overlap, so two
    look-alikes can't both keep their main color: the away team switches first (the home team keeps its own)."""
    meta = json.load(open(os.path.join(DATA, "teams.json"), encoding="utf-8"))
    def opts(tid):
        t = next((x for x in meta.get(league, []) if str(x["id"]) == str(tid)), {})
        cs = [hex_rgb(x, None) for x in (t.get("color"), t.get("alt")) if x]
        return [lift(c) for c in cs if c and 0.06 < lum(c) < 0.85] or [ACCENT]
    a, h = opts(away_id), opts(home_id)
    far = lambda x, y: math.dist(x, y) > 90
    pair = next(((x, y) for x, y in ((a[0], h[0]), (a[-1], h[0]), (a[0], h[-1])) if far(x, y)), (ACCENT, h[0]))
    dot = lambda line, o: next((c for c in o if c != line), line)
    return [(pair[0], dot(pair[0], a)), (pair[1], dot(pair[1], h))]


# ------------------------------------------------------------------ the picture
SS = 3  # drawn 3x and scaled down, for smooth lines


def radar(w, h, stats, teams):
    """One radar panel (w x h at 1x) with every team's web on it. teams: [(profile, line, dots)]. Under each stat
    name, one tag per team ("87% #4 TOP 5"), stacked, in the team's color."""
    im = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    z = lambda v: round(v * SS)
    n, top = len(stats), 64
    R = min(w * 0.25, (h - top - 96 - 64) / 2)  # room for the panel header, the top label (96) and the bottom labels (64)
    cx, cy = w / 2, top + 96 + R + ((h - top - 96 - 64) - 2 * R) / 2
    pt = lambda i, frac: (cx + math.cos(-math.pi / 2 + 2 * math.pi * i / n) * R * frac, cy + math.sin(-math.pi / 2 + 2 * math.pi * i / n) * R * frac)
    for ring in (0.25, 0.5, 0.75, 1):
        d.polygon([(z(x), z(y)) for x, y in (pt(i, ring) for i in range(n))], outline=LINE + (255,), width=z(1.5))
    for i in range(n):
        x, y = pt(i, 1)
        d.line((z(cx), z(cy), z(x), z(y)), fill=LINE + (255,), width=z(1.5))
    for prof, line, dots in teams:
        vals = [prof.get(k, (None, 0))[1] / 100 for k in stats]
        poly = [(z(x), z(y)) for x, y in (pt(i, max(0.02, v)) for i, v in enumerate(vals))]
        layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).polygon(poly, fill=line + (56,))
        im.alpha_composite(layer)
        d.line(poly + [poly[0]], fill=line + (255,), width=z(3.5), joint="curve")
        for x, y in poly:
            d.ellipse((x - z(6), y - z(6), x + z(6), y + z(6)), fill=dots + (255,), outline=line + (255,), width=z(2))
    lf, pf = font(z(19)), font(z(17), "Bold")
    for i, k in enumerate(stats):
        a = -math.pi / 2 + 2 * math.pi * i / n
        x, y = cx + math.cos(a) * (R + 22), cy + math.sin(a) * (R + 22)
        c, s = math.cos(a), math.sin(a)
        label = STATS[k][0]
        pills = []
        for prof, line, _ in teams:
            _, pct, rk, tag = prof.get(k, (None, None, None, ""))
            pills.append((f"{pct}% #{rk}" + (f" {tag}" if tag else "") if pct is not None else "n/a", line))
        tw = d.textlength(label, font=lf) / SS
        pws = [d.textlength(t, font=pf) / SS + 14 for t, _ in pills]
        bw, bh = max([tw] + pws), 26 + 28 * len(pills)
        left = x - bw / 2 if abs(c) < 0.3 else x if c > 0 else x - bw
        left = min(max(left, 12), w - 12 - bw)  # long names stay inside the panel
        topy = y - bh if s < -0.9 else y - 4 if s > 0.9 else y - bh / 2
        ax = (lambda ww: left + (bw - ww) / 2) if abs(c) < 0.3 else (lambda ww: left) if c > 0 else (lambda ww: left + bw - ww)
        d.text((z(ax(tw)), z(topy)), label, font=lf, fill=INK)
        for j, ((t, line), pw) in enumerate(zip(pills, pws)):
            px, py = ax(pw), topy + 26 + 28 * j
            d.rounded_rectangle((z(px), z(py), z(px + pw), z(py + 24)), z(4), fill=line + (255,))
            d.text((z(px + 7), z(py + 3)), t, font=pf, fill=(0, 0, 0) if lum(line) > 0.55 else (255, 255, 255))
    return im.resize((w, h), Image.LANCZOS)


def card(day):
    league, game = pick_game(day)
    if not game:
        return None
    e, kick, away, home = game
    prof, views, nteams, season = profiles(league)
    key = lambda c: f"{league}:{c['team']['id']}"
    if key(away) not in prof or key(home) not in prof:
        print(f"No season stats for {away['team']['displayName']} or {home['team']['displayName']} yet.")
        return None
    nick = lambda c: c["team"]["shortDisplayName"] if league == "nfl" else c["team"].get("location") or c["team"]["shortDisplayName"]
    sat = kick.weekday() == 5
    show, tag = (SHOWS.get(kick.weekday(), ("Saturday Night Football" if sat else "Prime time", "PRIME TIME")) if league == "nfl"
                 else ("Saturday night" if sat else "Prime time", "PRIME TIME"))
    kt = f"{kick:%I:%M %p}".lstrip("0") + " ET"
    img, d = canvas(league, tag, fit(ImageDraw.Draw(Image.new("RGB", (1, 1))), f"{nick(away)} @ {nick(home)}", font(60, "ExtraBold"), W - 2 * PAD),
                    f"{show} · {kt} · {season} so far, percentile among {nteams} {'NFL' if league == 'nfl' else 'FBS'} teams (100 = best)")
    cols = team_colors(league, away["team"]["id"], home["team"]["id"])
    teams = [(prof[key(c)], line, dots) for c, (line, dots) in zip((away, home), cols)]
    pw, ph = (W - 2 * PAD - 40) // 2, BOTTOM - TOP - 8
    for i, (vname, stats) in enumerate(views):
        x0 = PAD + i * (pw + 40)
        d.rounded_rectangle((x0, TOP, x0 + pw, TOP + ph), 14, outline=LINE, width=2)
        d.text((x0 + 22, TOP + 18), vname.upper(), font=font(28, "ExtraBold"), fill=INK)
        # legend on the right of the panel header: logo, short name and record in each team's color
        lx = x0 + pw - 20
        for c, (line, _) in reversed(list(zip((away, home), cols))):
            rec = (c.get("records") or [{}])[0].get("summary", "")
            txt = f"{c['team'].get('abbreviation') or nick(c)} {rec}".strip()
            tw = d.textlength(txt, font=font(20, "Bold"))
            d.text((lx - tw, TOP + 22), txt, font=font(20, "Bold"), fill=line)
            chip(img, d, {"logo": c["team"].get("logo"), "color": "#" + (c["team"].get("color") or "5a5a60")}, int(lx - tw - 40), TOP + 16, 34)
            lx -= tw + 40 + 22
        d.rectangle((x0 + 20, TOP + 60, x0 + pw - 20, TOP + 62), fill=LINE)
        img.alpha_composite(radar(pw, ph - 10, stats, teams), (x0, TOP + 6))

    # the post: where the radars split hardest, who wins each radar, and our model's chance (BUT when they disagree)
    A, B = prof[key(away)], prof[key(home)]
    plural = league == "nfl"
    who = lambda c: f"the {nick(c)}" if plural else nick(c)
    Who = lambda c: who(c)[0].upper() + who(c)[1:]
    verb = "rank" if plural else "ranks"
    allk = [k for _, ks in views for k in ks]
    gap = max(allk, key=lambda k: abs(A.get(k, (0, 50))[1] - B.get(k, (0, 50))[1]))
    lead, trail = (away, home) if A[gap][1] > B[gap][1] else (home, away)
    label = STATS[gap][0]
    said = label if label[:3].isupper() else label[0].lower() + label[1:]
    split = (f"The radars split hardest on {said}, where {who(lead)} {verb} #{prof[key(lead)][gap][2]} "
             f"and {who(trail)} {verb} #{prof[key(trail)][gap][2]}.")
    score = []  # per radar: (winner or None, winner's spokes, the other's)
    for _, ks in views:
        a = sum(1 for k in ks if A.get(k, (0, 0))[1] > B.get(k, (0, 0))[1])
        b = sum(1 for k in ks if B.get(k, (0, 0))[1] > A.get(k, (0, 0))[1])
        score.append((away, a, b) if a > b else (home, b, a) if b > a else (None, a, b))
    (ow, o1, o2), (dw, d1, d2) = score
    if ow and ow is dw:
        radars = f"{Who(ow)} {'win' if plural else 'wins'} both radars, {o1}-{o2} on offense and {d1}-{d2} on defense."
    else:
        radars =(f"{Who(ow)} {'win' if plural else 'wins'} the offense radar {o1}-{o2}" if ow else "The offense radar splits even") + \
                 (f", {who(dw)} the defense radar {d1}-{d2}." if dw else ", and the defense radar splits even.")
    total_a = sum(1 for k in allk if A.get(k, (0, 0))[1] > B.get(k, (0, 0))[1])
    total_b = sum(1 for k in allk if B.get(k, (0, 0))[1] > A.get(k, (0, 0))[1])
    big = away if total_a > total_b else home if total_b > total_a else None
    cur, prev, _ = latest(league)
    # the latest file predicts next week; the last game of this week (Monday night) is in the one before it
    p = next((x for f in (cur, prev or {}) for x in f.get("predictions", []) if str(x.get("espn_id")) == str(e["id"])), None)
    upset, model = False, ""
    if p:
        hp = p["home_win_prob"]
        fav, pr = (home, hp) if hp >= 0.5 else (away, 1 - hp)
        upset = big is not None and big is not fav  # the radars favor one team and the model the other (Terry: "BUT ...")
        model = f" {'BUT our' if upset else 'Our'} model likes {who(fav)} at {chance(pr)}."
    text = f"{show}: {nick(away)} @ {nick(home)}. {split} {radars}{model}"
    if x_len(text) > 280:  # long names: the split sentence goes first
        text = f"{show}: {nick(away)} @ {nick(home)}. {radars}{model}"
    return img, text, is_stale(cur, day), f"primetime-{e['id']}", upset


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="YYYY-MM-DD (default: today, US Eastern)")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    day = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(EASTERN).date()
    os.makedirs(a.out, exist_ok=True)
    png = os.path.join(a.out, "primetime.png")
    made = card(day)
    if made:
        img, text, stale, key, upset = made
        img.convert("RGB").save(png, optimize=True)
        text = tweet(text, "", with_link=False)  # never a link (Terry's rule)
        meta = {"day": "primetime", "stat": f"primetime-{day.isoformat()}", "key": key, "image": png, "text": text, "keep": ["BUT"] if upset else [],
                "skip": stale, "reason": "rankings data is stale" if stale else ""}
    else:
        meta = {"day": "primetime", "image": png, "text": "", "skip": True, "reason": f"no key prime-time game ({day:%A})"}
    print(("SKIP: " + meta["reason"]) if meta["skip"] else f"{png}\n   {meta['text']}")
    for name in ("primetime.json", "today.json"):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
