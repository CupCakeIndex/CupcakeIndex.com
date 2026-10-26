"""Prime-time matchup post for X: both teams' radars side by side, like Stats > Visualize > Radar on the site.

Runs every afternoon in season and only posts when there's a key night game (kickoff 7 PM Eastern or later):
  - NFL: any prime-time game (Thursday, Sunday and Monday night, Saturday nights late in the season)
  - college: a night game between two AP top-25 teams (when there's no NFL prime-time game that day)
Each radar is that team's season so far, as a percentile among every team in its league (100 = best), with its
rank and BEST / TOP 5 / BOTTOM 5 / WORST tags, in the team's colors. The numbers come from the same files and
formulas as the site (docs/data/viz, viz.js), the win chance from our model's predictions. No lines, no link.

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
                    hex_rgb, is_stale, latest, tweet)

ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"}
try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo("America/New_York")
except Exception:  # Windows without tz data: daylight time is close enough for a local test
    EASTERN = dt.timezone(dt.timedelta(hours=-4))
NIGHT = 19  # 7 PM Eastern or later counts as prime time
SHOWS = {0: ("Monday Night Football", "MNF"), 3: ("Thursday Night Football", "TNF"), 6: ("Sunday Night Football", "SNF")}

# The site's team radar (viz.js RADAR.teams), same formulas. S = season totals, g = games.
# [key, label, value(S, g), lower is better, columns it needs]
div = lambda a, b: a / b if b else None
STATS = [
    ["epa_play", "EPA per play", lambda S, g: div(S["epa"], S["adv_plays"]) if "adv_plays" in S else div(S["pass_epa"] + S["rush_epa"], S["plays"]), False, []],
    ["def_epa_play", "EPA allowed", lambda S, g: div(S["def_epa"], S["def_adv_plays"]) if "def_adv_plays" in S else div(S["opp_epa"], S["opp_plays"]), True, []],
    ["ypp", "Yards per play", lambda S, g: div(S["pass_yds"] + S["rush_yds"], S["plays"]), False, []],
    ["third", "Third-down %", lambda S, g: div(100 * S["third_conv"], S["third_att"]), False, ["third_att"]],
    ["giveaways", "Turnovers", lambda S, g: div(S["int"] + S["fum_lost"], g), True, []],
    ["def_sacks", "Sacks", lambda S, g: div(S["def_sacks"], g), False, []],
    ["pts", "Points scored", lambda S, g: div(S["pts"], g), False, []],
]


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
    """The key prime-time game: NFL first; else the college night game between two AP top-25 teams with the best ranks."""
    nfl = night_games("nfl", day)
    if nfl:
        return "nfl", nfl[0]
    ap = lambda c: (c.get("curatedRank") or {}).get("current") or 99
    cfb = [g for g in night_games("cfb", day) if ap(g[2]) <= 25 and ap(g[3]) <= 25]
    if cfb:
        return "cfb", min(cfb, key=lambda g: ap(g[2]) + ap(g[3]))
    return None, None


# ------------------------------------------------------------------ the numbers (same as the site's radar)
def season_file(league):
    idx = json.load(open(os.path.join(DATA, "viz", "index.json"), encoding="utf-8"))
    return json.load(open(os.path.join(DATA, "viz", f"{league}_{idx[league][-1]}.json"), encoding="utf-8"))


def profiles(league):
    """{team key: {stat: (value, percentile, rank, tag)}} for every team in the league, plus the stats used."""
    D = season_file(league)
    cols = D["tcols"]
    tot, games = {}, {}
    for r in D["trows"]:
        S = tot.setdefault(r[0], {c: 0 for c in cols})
        for c, v in zip(cols, r[3:]):
            S[c] += v or 0
        games[r[0]] = games.get(r[0], 0) + 1
    stats = [s for s in STATS if all(c in cols for c in s[4])]
    out = {k: {} for k in tot}
    for key, label, f, low, _ in stats:
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
    return out, stats, len(tot), D["season"]


# ------------------------------------------------------------------ team colors (same rule as the site's charts)
def lum(c):
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255


def lift(c):
    """Lighter in the same hue until it shows on the dark card (burgundy stays burgundy, navy stays blue)."""
    if lum(c) >= 0.22:
        return c
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c))
    s = min(0.85, s)
    while lum(c) < 0.22 and l < 0.8:
        l += 0.02
        c = tuple(round(v * 255) for v in colorsys.hls_to_rgb(h, l, s))
    return c


def team_colors(teams):
    """[(line, dots)] per team: the main color (lifted), dots in the other one. Each team has its own panel, so two
    look-alike teams both keep their own colors (the site's overlaid charts swap one; here nothing overlaps)."""
    meta = json.load(open(os.path.join(DATA, "teams.json"), encoding="utf-8"))
    out = []
    for lg, tid in teams:
        t = next((x for x in meta.get(lg, []) if str(x["id"]) == str(tid)), {})
        opts = [hex_rgb(x, None) for x in (t.get("color"), t.get("alt")) if x]
        opts = [c for c in opts if c and 0.06 < lum(c) < 0.85]
        pick = (opts[0], lift(opts[0])) if opts else None
        line = pick[1] if pick else ACCENT
        other = next((c for c in opts if pick and c != pick[0]), None)
        out.append((line, lift(other) if other else line))
    return out


# ------------------------------------------------------------------ the picture
SS = 3  # drawn 3x and scaled down, for smooth lines


def radar(w, h, prof, stats, line, dots):
    """One team's radar panel (w x h at 1x): logo, name and record on top, the web below."""
    im = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    z = lambda v: round(v * SS)
    n = len(stats)
    R = min(w * 0.25, (h - 240) / 2)  # room for the header (92), the top label (74) and the bottom label (70)
    cx, cy = w / 2, (h + 96) / 2
    pt = lambda i, frac: (cx + math.cos(-math.pi / 2 + 2 * math.pi * i / n) * R * frac, cy + math.sin(-math.pi / 2 + 2 * math.pi * i / n) * R * frac)
    for ring in (0.25, 0.5, 0.75, 1):
        d.polygon([(z(x), z(y)) for x, y in (pt(i, ring) for i in range(n))], outline=LINE + (255,), width=z(1.5))
    for i in range(n):
        x, y = pt(i, 1)
        d.line((z(cx), z(cy), z(x), z(y)), fill=LINE + (255,), width=z(1.5))
    vals = [prof.get(s[0], (None, 0, None, ""))[1] / 100 for s in stats]
    poly = [(z(x), z(y)) for x, y in (pt(i, max(0.02, v)) for i, v in enumerate(vals))]
    layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).polygon(poly, fill=line + (70,))
    im.alpha_composite(layer)
    d.line(poly + [poly[0]], fill=line + (255,), width=z(3.5), joint="curve")
    for x, y in poly:
        d.ellipse((x - z(6), y - z(6), x + z(6), y + z(6)), fill=dots + (255,), outline=line + (255,), width=z(2))
    # stat names with the tag under each: "87% #4 TOP 5"
    lf, pf = font(z(19)), font(z(17), "Bold")
    for i, s in enumerate(stats):
        a = -math.pi / 2 + 2 * math.pi * i / n
        x, y = cx + math.cos(a) * (R + 22), cy + math.sin(a) * (R + 22)
        c = math.cos(a)
        _, pct, rk, tag = prof.get(s[0], (None, None, None, ""))
        pill = f"{pct}% #{rk}" + (f" {tag}" if tag else "") if pct is not None else "n/a"
        tw, pw = d.textlength(s[1], font=lf) / SS, d.textlength(pill, font=pf) / SS + 14
        bw = max(tw, pw)
        left = x - bw / 2 if abs(c) < 0.3 else x if c > 0 else x - bw
        top = y - 52 if math.sin(a) < -0.9 else y - 6 if math.sin(a) > 0.9 else y - 26
        ax = (lambda ww: left + (bw - ww) / 2) if abs(c) < 0.3 else (lambda ww: left) if c > 0 else (lambda ww: left + bw - ww)
        d.text((z(ax(tw)), z(top)), s[1], font=lf, fill=INK)
        px, py = ax(pw), top + 26
        d.rounded_rectangle((z(px), z(py), z(px + pw), z(py + 24)), z(4), fill=line + (255,))
        d.text((z(px + 7), z(py + 3)), pill, font=pf, fill=(0, 0, 0) if lum(line) > 0.55 else (255, 255, 255))
    return im.resize((w, h), Image.LANCZOS)


def card(day):
    league, game = pick_game(day)
    if not game:
        return None
    e, kick, away, home = game
    prof, stats, nteams, season = profiles(league)
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
    cols = team_colors([(league, away["team"]["id"]), (league, home["team"]["id"])])
    pw, ph = (W - 2 * PAD - 40) // 2, BOTTOM - TOP - 8
    for i, (c, (line, dots)) in enumerate(zip((away, home), cols)):
        x0 = PAD + i * (pw + 40)
        d.rounded_rectangle((x0, TOP, x0 + pw, TOP + ph), 14, outline=LINE, width=2)
        chip(img, d, {"logo": c["team"].get("logo"), "color": "#" + (c["team"].get("color") or "5a5a60")}, x0 + 20, TOP + 18, 56)
        rec = (c.get("records") or [{}])[0].get("summary", "")
        rk = (c.get("curatedRank") or {}).get("current") or 99
        d.text((x0 + 90, TOP + 20), fit(d, c["team"]["displayName"], font(30, "Bold"), pw - 110), font=font(30, "Bold"), fill=INK)
        d.text((x0 + 90, TOP + 56), " · ".join(x for x in (rec, f"AP #{rk}" if rk <= 25 else "", "away" if i == 0 else "home") if x), font=font(20), fill=MUTED)
        d.rectangle((x0 + 20, TOP + 86, x0 + pw - 20, TOP + 89), fill=line)
        img.alpha_composite(radar(pw, ph - 10, prof[key(c)], stats, line, dots), (x0, TOP + 6))

    # the post: where the radars split hardest, who wins more spokes, and our model's chance
    A, B = prof[key(away)], prof[key(home)]
    plural = league == "nfl"
    who = lambda c: f"the {nick(c)}" if plural else nick(c)
    verb = "rank" if plural else "ranks"
    gap = max(stats, key=lambda s: abs(A.get(s[0], (0, 50))[1] - B.get(s[0], (0, 50))[1]))
    lead, trail = (away, home) if A[gap[0]][1] > B[gap[0]][1] else (home, away)
    rl, rt = prof[key(lead)][gap[0]][2], prof[key(trail)][gap[0]][2]
    wins = sum(1 for s in stats if A.get(s[0], (0, 0))[1] > B.get(s[0], (0, 0))[1])
    big, n = (away, wins) if wins * 2 > len(stats) else (home, len(stats) - wins)
    edge = (f"{who(big)[0].upper() + who(big)[1:]} {'win' if plural else 'wins'} {n} of {len(stats)} spokes." if n * 2 > len(stats)
            else f"They split the {len(stats)} spokes {n}-{n}.")
    said = gap[1] if gap[1][:3].isupper() else gap[1][0].lower() + gap[1][1:]  # "EPA per play", "yards per play"
    text = (f"{show}: {nick(away)} @ {nick(home)}. The radars split hardest on {said}, where {who(lead)} {verb} "
            f"#{rl} and {who(trail)} {verb} #{rt}. {edge}")
    cur, _, _ = latest(league)
    p = next((x for x in cur.get("predictions", []) if str(x.get("espn_id")) == str(e["id"])), None)
    if p:
        hp = p["home_win_prob"]
        fav, pr = (home, hp) if hp >= 0.5 else (away, 1 - hp)
        # the radars favor one team and the model the other: say so (Terry: "BUT our model likes the Eagles at 53%")
        upset = n * 2 > len(stats) and big is not fav
        text += f" {'BUT our' if upset else 'Our'} model likes {who(fav)} at {chance(pr)}."
    return img, text, is_stale(cur, day), f"primetime-{e['id']}"


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
        img, text, stale, key = made
        img.convert("RGB").save(png, optimize=True)
        text = tweet(text, "", with_link=False)  # never a link (Terry's rule)
        meta = {"day": "primetime", "stat": f"primetime-{day.isoformat()}", "key": key, "image": png, "text": text,
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
