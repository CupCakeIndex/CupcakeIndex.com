"""Stat posts for the X account: plain-English stats and "hot takes" about schedules and records.

Each post is one stat anyone can follow (rushing yards, interceptions, who a team has actually beaten),
a card with the leader's photo or logo and a top-5 bar chart, and tweet text. Hot takes end with a
question to get replies. No links, no betting content, always 280 characters or fewer.
Posting is done by post_to_x.py, same as the daily posts.

    python src/social/obscure.py                     # next stat in the rotation -> out/social/
    python src/social/obscure.py --stat random       # any stat (also random-hot, random-stat)
    python src/social/obscure.py --stat nfl_qb_rush  # a specific one (--list prints them all)
    python src/social/obscure.py --all --out DIR     # render every stat (previews)

Runs twice a day from GitHub (.github/workflows/obscure.yml), and on demand with Run workflow.
"""
import argparse
import datetime as dt
import io
import json
import os
import random
import re
import sys

import requests
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import posted
import render as R
from render import DATA, ROOT, hex_rgb, latest, load, ranked, short, tweet

W, H = 1600, 900

# ------------------------------------------------------------------ looks: the site's themes (Settings > Theme)
# Colors copied from docs/style.css (dark versions). head = font for big text, body = everything else
# (None = JetBrains Mono). Fonts are free Google Fonts (OFL) in fonts/.
THEMES = {
    "mono":      {"bg": "#0a0a0b", "panel": "#111113", "ink": "#ececec", "muted": "#8a8a8f", "line": "#26262a", "accent": "#ff6b2c", "head": None, "body": None},
    "terminal":  {"bg": "#0a0b0a", "panel": "#0f1210", "ink": "#e4f2e9", "muted": "#7f8f85", "line": "#1f2a23", "accent": "#3dff8a", "head": None, "body": None},
    "amber":     {"bg": "#0c0a06", "panel": "#14110a", "ink": "#f3ead6", "muted": "#9a8e72", "line": "#2a2416", "accent": "#ffb000", "head": None, "body": None},
    "broadcast": {"bg": "#0d0e12", "panel": "#15171d", "ink": "#f1f2f4", "muted": "#9097a3", "line": "#252831", "accent": "#ff6b2c", "head": "BarlowCondensed-Bold.ttf", "body": "Inter.ttf"},
    "editorial": {"bg": "#15130f", "panel": "#1d1a15", "ink": "#efe8da", "muted": "#a39a8a", "line": "#2f2a22", "accent": "#e0675c", "head": "SourceSerif4.ttf", "body": "Inter.ttf"},
    "glass":     {"bg": "#000000", "panel": "#121215", "ink": "#f5f5f7", "muted": "#98989f", "line": "#232327", "accent": "#ff9f0a", "head": "Inter.ttf", "body": "Inter.ttf"},
    "varsity":   {"bg": "#0b1628", "panel": "#0f1e36", "ink": "#eef1f6", "muted": "#8d9bb3", "line": "#1f3253", "accent": "#d6a84a", "head": "Oswald.ttf", "body": "Inter.ttf"},
}
WEIGHT = {"Regular": 400, "Bold": 700, "ExtraBold": 800}
_fonts = {}


def font_for(theme, size, weight="Regular"):
    """The theme's font: head font for ExtraBold (titles, big numbers), body font for the rest."""
    t = THEMES[theme]
    name = (t["head"] if weight == "ExtraBold" else t["body"]) if t["head"] else None
    key = (name, size, weight)
    if key not in _fonts:
        if not name:
            _fonts[key] = R.font(size, weight)
        else:
            f = ImageFont.truetype(os.path.join(R.HERE, "fonts", name), size)
            try:  # variable fonts: set the weight axis, leave the others at default
                f.set_variation_by_axes([min(max(WEIGHT[weight], a["minimum"]), a["maximum"]) if a["name"] == b"Weight" else a["default"]
                                         for a in f.get_variation_axes()])
            except Exception:
                pass  # static font (Barlow Condensed Bold)
            _fonts[key] = f
    return _fonts[key]


# ------------------------------------------------------------------ data
ESPN_FF = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{y}/segments/0/leaguedefaults/3?view=kona_player_info"
POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}
# ESPN fantasy stat ids (season totals, real games)
PA, CMP, PY, PTD, INT, RA, RY, RTD, REC, RECY, RECTD = "0", "1", "3", "4", "20", "23", "24", "25", "53", "42", "43"
IMG_CACHE = os.path.join(ROOT, "data", "raw", "social_img")
_session = requests.Session()
_session.headers["User-Agent"] = "Mozilla/5.0 cupcakeindex-social"
_cache = {}


def image(url):
    """A picture from ESPN's CDN (headshot or logo), cached on disk; None if it can't be fetched."""
    if not url or os.environ.get("SOCIAL_NO_LOGOS"):
        return None
    path = os.path.join(IMG_CACHE, "".join(c if c.isalnum() else "_" for c in url)[-120:])
    try:
        if os.path.exists(path):
            return Image.open(path).convert("RGBA")
        r = _session.get(url, timeout=30)
        if r.status_code != 200:
            return None
        os.makedirs(IMG_CACHE, exist_ok=True)
        with open(path, "wb") as f:
            f.write(r.content)
        return Image.open(io.BytesIO(r.content)).convert("RGBA")
    except Exception:
        return None


def nfl_players():
    """Every rostered NFL QB/RB/WR/TE with real season-to-date stats: [{id, name, pos, team, s}]."""
    if "nfl" not in _cache:
        y = load(os.path.join(DATA, "index.json"))["leagues"]["nfl"]["latest"]["season"]
        teams = {str(t["team"]["id"]): t["team"] for t in
                 _session.get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams", timeout=30).json()["sports"][0]["leagues"][0]["teams"]}
        filt = {"players": {"filterSlotIds": {"value": [0, 2, 4, 6]}, "limit": 700, "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                            "filterStatsForSourceIds": {"value": [0]}, "filterStatsForSplitTypeIds": {"value": [0]},
                            "filterStatsForScoringPeriodIds": {"value": [0]}}}
        out = []
        for x in _session.get(ESPN_FF.format(y=y), headers={"X-Fantasy-Filter": json.dumps(filt)}, timeout=30).json().get("players", []):
            p = x["player"]
            st = next((s for s in p.get("stats", []) if s.get("seasonId") == y and s.get("statSourceId") == 0 and s.get("statSplitTypeId") == 0), None)
            t = teams.get(str(p.get("proTeamId")))
            if not st or not t or p.get("defaultPositionId") not in POS:
                continue
            out.append({"id": p["id"], "name": p["fullName"], "pos": POS[p["defaultPositionId"]], "team": t["abbreviation"],
                        "color": "#" + t.get("color", "555555"), "logo": (t.get("logos") or [{}])[0].get("href"),
                        "pic": f"https://a.espncdn.com/i/headshots/nfl/players/full/{p['id']}.png", "s": st["stats"]})
        _cache["nfl"] = out
    return _cache["nfl"]


def cfb_players():
    """College QB/RB/WR/TE from the site's season-pace file: real totals so far (so) and pace."""
    if "cfb" not in _cache:
        y = load(os.path.join(DATA, "index.json"))["leagues"]["cfb"]["latest"]["season"]
        path = os.path.join(DATA, "cfb", str(y), "pace.json")
        rows = load(path)["players"] if os.path.exists(path) else []
        cur, _, _ = latest("cfb")
        colors = {str(t.get("id")): t.get("color") for t in cur["teams"]}
        for r in rows:
            r.update(name=r["n"], team=r["ta"], logo=f"https://a.espncdn.com/i/teamlogos/ncaa/500/{r['t']}.png",
                     pic=f"https://a.espncdn.com/i/headshots/college-football/players/full/{r['id']}.png", color=colors.get(str(r["t"])) or "#555555")
        _cache["cfb"] = rows
    return _cache["cfb"]


def teams(league):
    """The latest rankings file's teams (site order), each with name/record/logo/color, plus a name lookup."""
    key = "teams-" + league
    if key not in _cache:
        cur, _, _ = latest(league)
        ts = ranked(cur)
        for t in ts:
            t["name"] = t["team"]
        _cache[key] = (ts, {t["team"]: t for t in ts}, cur["week"])
    return _cache[key]


g = lambda p, k: p["s"].get(k, 0) if "s" in p else p["so"].get(k, 0)


def leaders(rows, value, keep=lambda p: True, low=False, n=5):
    rows = [(p, value(p)) for p in rows if keep(p)]
    rows = [(p, v) for p, v in rows if v is not None]
    return sorted(rows, key=lambda r: r[1] if low else -r[1])[:n]


def rec(w, l):
    return f"{w}-{l}"


def opp_record(t, by_name, which):
    """Combined record of a team's opponents: which = 'beaten' (teams it beat), 'left' (still to play) or 'played'.
    FCS opponents aren't in our file: returned as a count instead."""
    rows = [s for s in t["schedule"] if (which == "beaten" and s.get("result") == "W") or (which == "left" and s.get("upcoming"))
            or (which == "played" and s.get("result"))]
    w = l = fcs = 0
    for s in rows:
        o = by_name.get(s["opp"])
        if o:
            w, l = w + o["wins"], l + o["losses"]
        else:
            fcs += 1
    return w, l, fcs, len(rows)


def pct(w, l):
    return w / (w + l) if w + l else None


# ------------------------------------------------------------------ the stats
# Each returns a fact dict or None (not enough data yet):
#   league, kind (player|team), title, sub (one plain line), unit, rows [(subject, sort value, shown text)],
#   text (tweet), question (hot takes: shown on the card too)
STATS = {}


def stat(key):
    def wrap(fn):
        STATS[key] = fn
        return fn
    return wrap


def fact(league, kind, rows, title, sub, unit, text, question=None, hot=False):
    if len(rows) < 3:
        return None
    return {"league": league, "kind": kind, "rows": rows, "title": title, "sub": sub, "unit": unit,
            "text": ("Hot take: " if hot else "") + text + (f" {question}" if question else ""), "question": question, "hot": hot}


def nxt(rows, n=2):
    return ", ".join(f"{(p.get('name') or p['team'])} {s}" for p, _, s in rows[1:1 + n])


def player_rows(r, fmt):
    return [(p, v, fmt(v)) for p, v in r]


n0 = lambda v: f"{v:,.0f}"
n1 = lambda v: f"{v:.1f}"


# --- schedules and records (the Cupcake Index's whole thing) ---------------------------
@stat("hot_cfb_paper_unbeaten")
def _():
    ts, by, wk = teams("cfb")
    rows = []
    for t in ts:
        if t["losses"] or t["wins"] < 3 or not (t["power_rank"] <= 25 or t.get("ap_rank")):
            continue
        w, l, fcs, n = opp_record(t, by, "beaten")
        rows.append((t, pct(w, l) if w + l else 0, f"{rec(w, l)}" + (f" +{fcs} FCS" if fcs else "")))
    rows.sort(key=lambda r: r[1])
    if len(rows) < 3:
        return None
    t, _, s = rows[0]
    cups = sum(1 for x in t["schedule"] if x.get("result") and (x.get("cupcake") or x.get("fcs")))
    return fact("cfb", "team", rows[:5], "Perfect on paper", "Unbeaten ranked teams, by the combined record of the teams they've beaten",
                "combined record of teams they've beaten",
                f"{(f'AP #' + str(t['ap_rank']) + ' ') if t.get('ap_rank') else ''}{t['team']} is {t['record']}. The teams it has beaten are a combined {s}"
                + (f", and {cups} of the wins came against cupcakes" if cups else "") + ".",
                "Does a perfect record mean anything without a real test?", hot=True)


@stat("hot_cfb_beaten_nobody")
def _():
    ts, by, wk = teams("cfb")
    rows = []
    for t in ts:
        if not t.get("ap_rank") or not t["wins"]:
            continue
        w, l, fcs, n = opp_record(t, by, "beaten")
        rows.append((t, pct(w, l) if w + l else 0, rec(w, l) + (f" +{fcs} FCS" if fcs else "")))
    rows.sort(key=lambda r: r[1])
    if len(rows) < 3:
        return None
    t, _, s = rows[0]
    return fact("cfb", "team", rows[:5], "Who have they beaten?", "AP Top 25 teams, by the combined record of the teams they've beaten",
                "combined record of teams they've beaten",
                f"AP #{t['ap_rank']} {t['team']} is {t['record']}. The teams it has beaten are a combined {s}.",
                "Contender, or a résumé made of cupcakes?", hot=True)


@stat("hot_nfl_paper_record")
def _():
    ts, by, wk = teams("nfl")
    rows = []
    for t in ts:
        if t["wins"] <= t["losses"]:
            continue
        w, l, _, n = opp_record(t, by, "beaten")
        rows.append((t, pct(w, l) or 0, rec(w, l)))
    rows.sort(key=lambda r: r[1])
    if len(rows) < 3:
        return None
    t, _, s = rows[0]
    return fact("nfl", "team", rows[:5], "Built on cupcakes?", "Winning NFL teams, by the combined record of the teams they've beaten",
                "combined record of teams they've beaten",
                f"The {t['team']} are {t['record']}. The teams they've beaten are a combined {s}.",
                "Real contender, or a soft schedule?", hot=True)


def schedule_left(league, top, hardest):
    ts, by, wk = teams(league)
    rows = []
    for t in ts[:top]:
        w, l, fcs, n = opp_record(t, by, "left")
        if n >= 3 and w + l:
            rows.append((t, pct(w, l), rec(w, l) + (f" +{fcs} FCS" if fcs else "")))
    rows.sort(key=lambda r: -r[1] if hardest else r[1])
    return rows[:5]


@stat("cfb_toughest_left")
def _():
    r = schedule_left("cfb", 25, True)
    if len(r) < 3:
        return None
    t, _, s = r[0]
    return fact("cfb", "team", r, "The gauntlet ahead", "Our top 25, by the combined record of the opponents still on their schedule",
                "combined record of opponents left",
                f"No team in our top 25 has a tougher road left than #{t['power_rank']} {t['team']}: its remaining opponents are a combined {s}.",
                "Who survives it?")


@stat("cfb_easiest_left")
def _():
    r = schedule_left("cfb", 25, False)
    if len(r) < 3:
        return None
    t, _, s = r[0]
    return fact("cfb", "team", r, "Cruise control", "Our top 25, by the combined record of the opponents still on their schedule (easiest first)",
                "combined record of opponents left",
                f"#{t['power_rank']} {t['team']} has the easiest road left in our top 25: its remaining opponents are a combined {s}.",
                "Should an easy path to the playoff count against them?", hot=True)


@stat("nfl_toughest_left")
def _():
    r = schedule_left("nfl", 32, True)
    if len(r) < 3:
        return None
    t, _, s = r[0]
    return fact("nfl", "team", r, "Brutal road ahead", "NFL teams, by the combined record of the opponents still on their schedule",
                "combined record of opponents left",
                f"The {t['team']} ({t['record']}) have the NFL's toughest schedule left: their remaining opponents are a combined {s}.")


@stat("nfl_easiest_left")
def _():
    r = schedule_left("nfl", 32, False)
    if len(r) < 3:
        return None
    t, _, s = r[0]
    return fact("nfl", "team", r, "Cupcakes ahead", "NFL teams, by the combined record of the opponents still on their schedule (easiest first)",
                "combined record of opponents left",
                f"The {t['team']} ({t['record']}) have the NFL's easiest schedule left: their remaining opponents are a combined {s}.",
                "Playoff lock, or will they still find a way?", hot=True)


@stat("hot_cfb_ap_overrated")
def _():
    ts, by, wk = teams("cfb")
    r = sorted(((t, t["power_rank"] - t["ap_rank"], f"AP #{t['ap_rank']} · us #{t['power_rank']}") for t in ts if t.get("ap_rank")),
               key=lambda x: -x[1])[:5]
    if len(r) < 3:
        return None
    t = r[0][0]
    return fact("cfb", "team", r, "The AP loves them. We don't.", "AP Top 25 teams we rank furthest below their poll spot",
                "spots lower in our rankings",
                f"{t['team']} ({t['record']}) is #{t['ap_rank']} in the AP poll. We have them #{t['power_rank']}.",
                "Who's wrong, us or the voters?", hot=True) | {"big": str(r[0][1])}  # the gap is the headline; both ranks are in the line above


@stat("hot_cfb_ap_snub")
def _():
    ts, by, wk = teams("cfb")
    r = sorted(((t, (t.get("ap_rank") or 40) - t["power_rank"], f"us #{t['power_rank']} · AP " + (f"#{t['ap_rank']}" if t.get("ap_rank") else "NR"))
                for t in ts[:25]), key=lambda x: -x[1])[:5]
    if len(r) < 3:
        return None
    t = r[0][0]
    return fact("cfb", "team", r, "The voters are sleeping", "Our top 25, by how far the AP poll has them below our spot",
                "spots higher in our rankings",
                f"We have {t['team']} ({t['record']}) at #{t['power_rank']}. The AP has them "
                + (f"at #{t['ap_rank']}." if t.get("ap_rank") else "unranked."),
                "Who's wrong, us or the voters?", hot=True) | ({"big": str(r[0][1])} if t.get("ap_rank") else {"big": "Unranked", "big_unit": f"in the AP poll (we have them #{t['power_rank']})"})


@stat("hot_nfl_record_lies")
def _():
    ts, by, wk = teams("nfl")
    order = {t["team"]: i + 1 for i, t in enumerate(sorted(ts, key=lambda t: (-(t["wins"] - t["losses"]), t["power_rank"])))}
    r = sorted(((t, t["power_rank"] - order[t["team"]], f"{t['record']} · us #{t['power_rank']}") for t in ts if t["wins"] > t["losses"]),
               key=lambda x: -x[1])[:5]
    if len(r) < 3:
        return None
    t = r[0][0]
    return fact("nfl", "team", r, "Don't trust the record", "Winning teams our rankings put furthest below their record",
                "spots below their record",
                f"The {t['team']} are {t['record']}, but by how they actually play we rank them #{t['power_rank']}.",
                "Is the record lying, or are we?", hot=True)


@stat("hot_nfl_better_than_record")
def _():
    ts, by, wk = teams("nfl")
    r = [(t, -t["power_rank"], f"{t['record']} · us #{t['power_rank']}") for t in ts if t["losses"] >= t["wins"] and t["wins"] + t["losses"] >= 2][:5]
    if len(r) < 3:
        return None
    t = r[0][0]
    return fact("nfl", "team", r, "Better than the record", "Teams at .500 or worse, by our power ranking", "in our rankings",
                f"The {t['team']} are {t['record']}, yet by how they actually play we rank them #{t['power_rank']}.",
                "Sleeping giant, or a bad team with good stats?", hot=True)


@stat("hot_nfl_close_calls")
def _():
    ts, by, wk = teams("nfl")
    rows = []
    for t in ts:
        ow, ol = (int(x) for x in t.get("one_score", "0-0").split("-"))
        if t["wins"] > t["losses"] and ow:
            rows.append((t, ow / t["wins"] + ow * 0.01, ("both wins" if ow == t["wins"] == 2 else f"all {ow} wins" if ow == t["wins"] else f"{ow} of {t['wins']} wins")))
    rows.sort(key=lambda r: -r[1])
    if len(rows) < 3:
        return None
    t, _, s = rows[0]
    return fact("nfl", "team", rows[:5], "Living on the edge", "Winning teams, by how many of their wins came by 8 points or fewer",
                "wins by one score", f"The {t['team']} are {t['record']}, and {s} came by one score.", "Clutch, or lucky?", hot=True)


@stat("nfl_one_score_games")
def _():
    ts, by, wk = teams("nfl")
    rows = []
    for t in ts:
        ow, ol = (int(x) for x in t.get("one_score", "0-0").split("-"))
        if ow + ol:
            rows.append((t, ow + ol + 0.01 * ow, f"{ow + ol} ({ow}-{ol})"))
    rows.sort(key=lambda r: -r[1])
    if len(rows) < 3:
        return None
    t, _, s = rows[0]
    return fact("nfl", "team", rows[:5], "Heart attack football", "Most games decided by 8 points or fewer (record in them)",
                "one-score games", f"The {t['team']} have played {s.split(' ')[0]} one-score games already and are {s.split(' ')[1].strip('()')} in them.")


@stat("cfb_biggest_blowout")
def _():
    ts, by, wk = teams("cfb")

    def best(t):
        out = None
        for s in t["schedule"]:
            if s.get("result") == "W" and not s.get("fcs"):
                a, b = (int(x) for x in s["score"].split("-"))
                if out is None or a - b > out[0]:
                    out = (a - b, s)
        return out
    rows = [(t, b[0], f"+{b[0]} vs {b[1]['opp']}") for t in ts if (b := best(t))]
    rows.sort(key=lambda r: -r[1])
    if len(rows) < 3:
        return None
    t, m, s = rows[0]
    game = best(t)[1]
    return fact("cfb", "team", rows[:5], "Biggest beatdown", "Largest win over an FBS opponent this season", "point margin",
                f"{t['team']} beat {game['opp']} {game['score']}, the biggest win by any FBS team over an FBS opponent this year.")


# --- betting hot takes (Terry OK'd these for X: books' lines vs our model, clearly "for fun") -----
# predictions in the rankings file: spread / vegas = expected HOME margin (+ = home favored), from us / the books.
def upcoming_lines(league):
    cur, _, _ = latest(league)
    ts, by, wk = teams(league)
    return [p for p in cur.get("predictions", []) if "actual" not in p and p.get("vegas") is not None
            and p["home"] in by and p["away"] in by], by


def side_line(p, home):
    """The books' point spread for one side, written the usual way (-7 = favored by 7)."""
    return -p["vegas"] if home else p["vegas"]


def fav_text(team_name, margin, league):
    return f"{short(team_name, league)} by {abs(margin):.1f}" if abs(margin) >= 0.5 else "a coin flip"


def vs_vegas(league):
    games, by = upcoming_lines(league)
    rows = []
    for p in sorted(games, key=lambda p: -abs(p["spread"] - p["vegas"])):
        home = p["spread"] > p["vegas"]  # we like the home side more than the books do
        pick = p["home"] if home else p["away"]
        ln = side_line(p, home)
        ours = -p["spread"] if home else p["spread"]
        rows.append((by[pick], abs(p["spread"] - p["vegas"]), f"{ln:+g} · us {ours:+.1f}", p))
    if len(rows) < 3:
        return None
    t, _, s, p = rows[0]
    s = f"{short(t['team'], league)} {side_line(p, t['team'] == p['home']):+g}"
    books_fav = p["home"] if p["vegas"] > 0 else p["away"]
    ours = fav_text(p["home"] if p["spread"] > 0 else p["away"], p["spread"], league)
    when = f"Week {p['week']}"
    return fact(league, "team", [r[:3] for r in rows[:5]], "We'd take the points" if side_line(p, t["team"] == p["home"]) > 0 else "Lay the points",
                f"{when}: the games where our model and the books disagree most (for fun, not betting advice)", "books' line · our model's line",
                f"{when}: we like {s}. The books have {short(books_fav, league)} by {abs(p['vegas']):g}; our model has it {ours}.",
                "Who's taking the other side? (For fun, not betting advice.)", hot=True) | {"big": s, "big_unit": "the books' line (our model's line in the chart)"}


def upset_alert(league):
    games, by = upcoming_lines(league)
    rows = []
    for p in games:
        if abs(p["vegas"]) < 1:
            continue
        dog_home = p["vegas"] < 0
        dog = p["home"] if dog_home else p["away"]
        ch = p["home_win_prob"] if dog_home else 1 - p["home_win_prob"]
        rows.append((by[dog], ch, f"+{abs(p['vegas']):g} · {R.chance(ch)}", p))
    rows.sort(key=lambda r: -r[1])
    if len(rows) < 3 or rows[0][1] < 0.4:
        return None
    t, ch, s, p = rows[0]
    fav = p["away"] if t["team"] == p["home"] else p["home"]
    return fact(league, "team", [r[:3] for r in rows[:5]], "Upset alert", f"Week {p['week']}: books' underdogs our model likes most (line · our win chance)",
                "underdog · our win chance",
                f"The books have {short(t['team'], league)} as a {abs(p['vegas']):g}-point underdog against "
                f"{short(fav, league)}. Our model gives them a {R.chance(ch)} chance to win.",
                "Who's riding with the underdog? (For fun, not betting advice.)", hot=True) | {
        "big": R.chance(ch), "big_unit": f"our win chance as a {abs(p['vegas']):g}-point underdog"}


@stat("hot_nfl_vs_vegas")
def _():
    return vs_vegas("nfl")


@stat("hot_cfb_vs_vegas")
def _():
    return vs_vegas("cfb")


@stat("hot_nfl_upset_alert")
def _():
    return upset_alert("nfl")


@stat("hot_cfb_upset_alert")
def _():
    return upset_alert("cfb")


# --- players: traditional stats only ---------------------------------------------------
@stat("nfl_qb_rush")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, RY), lambda p: p["pos"] == "QB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Quarterbacks who run", "Most rushing yards by an NFL quarterback this season", "rushing yards",
                f"{p['name']} ({p['team']}) has {s} rushing yards, the most of any NFL quarterback. Next: {nxt(r)}.")


@stat("nfl_rb_receiving")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, RECY), lambda p: p["pos"] == "RB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Running backs who catch", "Most receiving yards by an NFL running back this season", "receiving yards",
                f"{p['name']} ({p['team']}) has {s} receiving yards, the most of any NFL running back. Next: {nxt(r)}.")


@stat("nfl_interceptions")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, INT), lambda p: p["pos"] == "QB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Gift wrapped", "Most interceptions thrown this season", "interceptions",
                f"{p['name']} ({p['team']}) has thrown {s} interceptions, the most in the NFL. Next: {nxt(r)}.")


@stat("nfl_catches_no_td")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, REC), lambda p: p["pos"] != "QB" and not g(p, RECTD) and not g(p, RTD)), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Still looking for six", "Most catches without a single touchdown this season", "catches, 0 TDs",
                f"{p['name']} ({p['team']}) has {s} catches and still no touchdown. Next: {nxt(r)}.")


@stat("nfl_yards_per_carry")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, RY) / g(p, RA) if g(p, RA) else None, lambda p: g(p, RA) >= 30), n1)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Yards per carry", "NFL leaders, minimum 30 carries", "yards per carry",
                f"{p['name']} ({p['team']}) is averaging {s} yards a carry, best in the NFL (30+ carries). Next: {nxt(r)}.")


@stat("nfl_yards_per_catch")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, RECY) / g(p, REC) if g(p, REC) else None, lambda p: g(p, REC) >= 10), n1)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Big-play machine", "Yards per catch, minimum 10 catches", "yards per catch",
                f"{p['name']} ({p['team']}) is averaging {s} yards every time he catches the ball. Next: {nxt(r)}.")


@stat("nfl_completion_pct")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, CMP) / g(p, PA) if g(p, PA) else None, lambda p: g(p, PA) >= 60),
                    lambda v: f"{v:.1%}")
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Most accurate", "Completion percentage, minimum 60 throws", "completion %",
                f"{p['name']} ({p['team']}) is completing {s} of his passes, best in the NFL. Next: {nxt(r)}.")


@stat("nfl_te_touchdowns")
def _():
    r = player_rows(leaders(nfl_players(), lambda p: g(p, RECTD), lambda p: p["pos"] == "TE"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("nfl", "player", r, "Tight end touchdowns", "Most receiving touchdowns by a tight end", "touchdowns",
                f"{p['name']} ({p['team']}) leads all tight ends with {s} receiving touchdowns. Next: {nxt(r)}.")


@stat("hot_nfl_empty_yards")
def _():
    r = leaders(nfl_players(), lambda p: g(p, PY) / max(1, g(p, PTD)), lambda p: g(p, PA) >= 80)
    r = [(p, v, f"{g(p, PY):,.0f} yds, {g(p, PTD):.0f} TD") for p, v in r]
    if len(r) < 3:
        return None
    p, v, s = r[0]
    td = g(p, PTD)
    return fact("nfl", "player", r, "Empty yards?", "Fewest touchdown passes for the yards, minimum 80 throws", "passing yards per TD pass",
                f"{p['name']} ({p['team']}) has {g(p, PY):,.0f} passing yards and only {td:.0f} touchdown pass{'' if td == 1 else 'es'}.",
                "Stat-sheet QB, or bad luck in the red zone?", hot=True)


@stat("cfb_qb_rush")
def _():
    r = player_rows(leaders(cfb_players(), lambda p: g(p, "ry"), lambda p: p["pos"] == "QB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("cfb", "player", r, "Quarterbacks who run", "Most rushing yards by an FBS quarterback this season", "rushing yards",
                f"{p['name']} ({p['team']}) has {s} rushing yards, the most of any FBS quarterback. Next: {nxt(r)}.")


@stat("cfb_rb_receiving")
def _():
    r = player_rows(leaders(cfb_players(), lambda p: g(p, "recy"), lambda p: p["pos"] == "RB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("cfb", "player", r, "Running backs who catch", "Most receiving yards by an FBS running back this season", "receiving yards",
                f"{p['name']} ({p['team']}) has {s} receiving yards, the most of any FBS running back. Next: {nxt(r)}.")


@stat("cfb_pass_td_pace")
def _():
    r = player_rows(leaders(cfb_players(), lambda p: p["ptd"], lambda p: p["pos"] == "QB"), n0)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("cfb", "player", r, "On pace for history?", "Touchdown passes so far, plus our projection for every game left", "TD pass pace",
                f"{p['name']} ({p['team']}) is on pace for {s} touchdown passes this season. Next: {nxt(r)}.")


@stat("cfb_yards_per_catch")
def _():
    r = player_rows(leaders(cfb_players(), lambda p: g(p, "recy") / g(p, "rec") if g(p, "rec") else None, lambda p: g(p, "rec") >= 12), n1)
    if len(r) < 3:
        return None
    p, v, s = r[0]
    return fact("cfb", "player", r, "Big-play machine", "Yards per catch, minimum 12 catches", "yards per catch",
                f"{p['name']} ({p['team']}) is averaging {s} yards every time he catches the ball. Next: {nxt(r)}.")


# ------------------------------------------------------------------ card
# --- injuries: the most banged-up NFL teams (same math as the site's Stats > Injuries page, docs/live.js) -----------
INJ_W = {"qb": 10, "lt": 3, "rt": 3, "lg": 2, "c": 2, "rg": 2, "wr": 3, "te": 2, "rb": 2, "fb": 0.5, "lde": 3, "rde": 3, "de": 3, "ldt": 2.5,
         "rdt": 2.5, "nt": 2.5, "dt": 2.5, "wlb": 2, "slb": 2, "olb": 2.5, "lilb": 2, "rilb": 2, "mlb": 2, "lb": 2, "lcb": 3, "rcb": 3, "cb": 3,
         "nb": 1.5, "ss": 2, "fs": 2, "s": 2, "pk": 1, "p": 0.5}
INJ_POS_W = {"QB": 10, "OT": 3, "T": 3, "G": 2, "OG": 2, "C": 2, "WR": 3, "TE": 2, "RB": 2, "FB": 0.5, "DE": 3, "EDGE": 3, "DT": 2.5, "NT": 2.5,
             "LB": 2, "OLB": 2.5, "ILB": 2, "MLB": 2, "CB": 3, "S": 2, "SS": 2, "FS": 2, "DB": 2, "PK": 1, "K": 1, "P": 0.5}


def inj_hit(st):
    st = (st or "").lower()
    return 1 if re.search(r"out|injured reserve|suspen|physically unable|non-football", st) else 0.75 if "doubtful" in st \
        else 0.25 if re.search(r"questionable|day-to-day", st) else 0


def nfl_health():
    """Every NFL team's % healthy: [{name, health, key_out, total, key_names}], most banged-up first.
    Key players = at each depth-chart spot, everyone down to the first healthy player (the starter, plus the next
    man up when he's out). Position weights (QB ~10x a punter); Out/IR all of it, Doubtful 3/4, Questionable 1/4."""
    if "health" in _cache:
        return _cache["health"]
    site = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
    rep = _session.get(f"{site}/injuries", timeout=30).json()
    yr = (rep.get("season") or {}).get("year") or dt.date.today().year
    out = []
    for t in rep.get("injuries", []):
        dc = _session.get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/teams/{t['id']}/depthcharts", timeout=30).json()
        idof = lambda i: (re.search(r"/id/(\d+)", " ".join(l.get("href", "") for l in (i.get("athlete") or {}).get("links", []))) or [None, ""])[1]
        missing = {idof(i) for i in t.get("injuries", []) if inj_hit(i.get("status")) >= 0.75} - {""}
        slot, seen, total = {}, set(), 0.0
        for it in dc.get("items", []):
            for k, v in (it.get("positions") or {}).items():
                if k not in INJ_W:
                    continue
                spots = {}
                for a in v.get("athletes", []):
                    m = re.search(r"athletes/(\d+)", (a.get("athlete") or {}).get("$ref", ""))
                    if m:
                        spots.setdefault(a.get("slot") or 1, []).append((a.get("rank") or 99, m[1]))
                for sl, lst in spots.items():
                    if (k, sl) in seen:
                        continue
                    seen.add((k, sl))
                    total += INJ_W[k]
                    filled = False
                    for depth, (_, aid) in enumerate(sorted(lst), 1):
                        is_key, old = not filled, slot.get(aid)
                        if aid not in missing:
                            filled = True
                        if not old or (is_key and not old[2]) or (not old[2] and depth < old[1]):
                            slot[aid] = (k, depth, is_key)
        hurt = []
        for i in t.get("injuries", []):
            h = inj_hit(i.get("status"))
            if not h:
                continue
            s = slot.get(idof(i))
            w = INJ_W[s[0]] * (1 if s[2] else 0.15 if s[1] == 2 else 0.05) if s else INJ_POS_W.get(((i.get("athlete") or {}).get("position") or {}).get("abbreviation", ""), 1) * 0.3
            hurt.append({"name": (i.get("athlete") or {}).get("displayName", ""), "key": bool(s and s[2]), "lost": w * h, "w": w})
        hurt.sort(key=lambda x: -x["lost"])
        lost = sum(x["lost"] for x in hurt)
        keyed = [x for x in hurt if x["key"] and x["lost"] >= 0.75 * x["w"]]
        out.append({"name": t.get("displayName", ""), "health": max(0.0, min(100.0, 100 * (1 - lost / total))) if total else 100.0,
                    "key_out": len(keyed), "total": len(hurt), "key_names": [x["name"].split()[-1] for x in keyed]})
    out.sort(key=lambda x: x["health"])
    _cache["health"] = out
    return out


@stat("nfl_injuries")
def _():
    ts, by, wk = teams("nfl")
    hl = nfl_health()
    rows = [(by[h["name"]] | {"inj": h}, 100 - h["health"], f"{h['health']:.0f}%") for h in hl if h["name"] in by]
    if len(rows) < 5:
        return None
    t, h = rows[0][0], rows[0][0]["inj"]
    avg = sum(x["health"] for x in hl) / len(hl)
    names = ", ".join(h["key_names"][:4])
    healthiest = rows[-1][0]
    return fact("nfl", "team", rows[:5], "Most banged-up teams", "% healthy (longer bar = more hurt). Starters and the next man up count most; a QB about 10x a punter",
                "healthy",
                f"Injury report: the {short(t['team'], 'nfl')} are the most banged-up team in the NFL, {h['health']:.0f}% healthy with "
                f"{h['key_out']} key player{'s' if h['key_out'] != 1 else ''} out" + (f" ({names})" if names else "") + ". Next: " + ", ".join(f"{short(p['team'], 'nfl')} {x}" for p, _, x in rows[1:3]) + ". "
                f"League average {avg:.0f}%. Healthiest: {short(healthiest['team'], 'nfl')} {healthiest['inj']['health']:.0f}%.") | {
        "tag": "INJURY REPORT"}


# --- historic pace: a player on pace for (or near) a single-season record --------------------------
# Posted on their own after the games (.github/workflows/pace.yml): college Saturday night, NFL Sunday night.
# Pace = season total / team games played x the regular season (12 college games, 17 NFL), the usual "on pace".
# Records checked Oct 2026 (FBS counts bowl games since 2002; NFL is the regular season).
RECORDS = {
    "cfb": {"passingYards": (5967, "Bailey Zappe", "Western Kentucky", 2021), "passingTouchdowns": (62, "Bailey Zappe", "Western Kentucky", 2021),
            "rushingYards": (2628, "Barry Sanders", "Oklahoma State", 1988), "rushingTouchdowns": (37, "Barry Sanders", "Oklahoma State", 1988),
            "receivingYards": (2060, "Trevor Insley", "Nevada", 1999), "receptions": (158, "Zay Jones", "East Carolina", 2016),
            "receivingTouchdowns": (27, "Troy Edwards", "Louisiana Tech", 1998)},
    "nfl": {"passingYards": (5477, "Peyton Manning", "Broncos", 2013), "passingTouchdowns": (55, "Peyton Manning", "Broncos", 2013),
            "rushingYards": (2105, "Eric Dickerson", "Rams", 1984), "rushingTouchdowns": (28, "LaDainian Tomlinson", "Chargers", 2006),
            "receivingYards": (1964, "Calvin Johnson", "Lions", 2012), "receptions": (149, "Michael Thomas", "Saints", 2019),
            "receivingTouchdowns": (23, "Randy Moss", "Patriots", 2007)},
}
PACE_LABEL = {"passingYards": "passing yards", "passingTouchdowns": "passing TDs", "rushingYards": "rushing yards",
              "rushingTouchdowns": "rushing TDs", "receivingYards": "receiving yards", "receptions": "catches", "receivingTouchdowns": "receiving TDs"}
SEASON_GAMES = {"cfb": 12, "nfl": 17}
PACE_MIN = 0.9  # within 10% of the record (or past it) counts as historic; otherwise no post that week
# team games before a pace counts: yards and catches settle fast, TD paces are silly until mid-season
PACE_GAMES = {"cfb": (4, 6), "nfl": (5, 9)}  # (yards/catches, TDs)


def team_games(league, tid):
    """Games a team has played this regular season, from its record ("5-1", "4-1-1")."""
    key = f"tg-{league}-{tid}"
    if key not in _cache:
        lg = "nfl" if league == "nfl" else "college-football"
        t = _session.get(f"https://site.api.espn.com/apis/site/v2/sports/football/{lg}/teams/{tid}", timeout=30).json().get("team", {})
        item = next((i for i in t.get("record", {}).get("items", []) if i.get("type") == "total"), None) or (t.get("record", {}).get("items") or [{}])[0]
        _cache[key] = sum(int(x) for x in re.findall(r"\d+", item.get("summary", "")))
    return _cache[key]


def historic_pace(league):
    lg = "nfl" if league == "nfl" else "college-football"
    y = load(os.path.join(DATA, "index.json"))["leagues"][league]["latest"]["season"]
    cats = _session.get(f"https://site.api.espn.com/apis/site/v3/sports/football/{lg}/leaders?season={y}&seasontype=2&limit=10",
                        timeout=30).json().get("leaders", {}).get("categories", [])
    n, scope = SEASON_GAMES[league], "FBS" if league == "cfb" else "NFL"
    best = None
    for c in cats:
        rec_ = RECORDS[league].get(c.get("name"))
        if not rec_:
            continue
        rows = []
        for l in c.get("leaders", []):
            a, t = l.get("athlete", {}), l.get("team") or {}
            tg = team_games(league, t.get("id")) if t.get("id") else 0
            if tg < PACE_GAMES[league]["Touchdowns" in c["name"]] or not l.get("value"):
                continue
            pace = l["value"] / tg * n
            rows.append(({"name": a.get("displayName", ""), "pos": (a.get("position") or {}).get("abbreviation", ""), "team": t.get("abbreviation", ""),
                          "color": "#" + (t.get("color") or "555555"), "logo": ((t.get("logos") or [{}])[0]).get("href"),
                          "pic": (a.get("headshot") or {}).get("href"), "total": l["value"], "tg": tg}, pace, n0(pace)))
        rows.sort(key=lambda r: -r[1])
        if rows and (best is None or rows[0][1] / rec_[0] > best[0]):
            best = (rows[0][1] / rec_[0], c["name"], rows, rec_)
    if not best or best[0] < PACE_MIN:
        return None
    ratio, cat, rows, (rv, who, team, yr) = best
    p, pace, s = rows[0]
    what = PACE_LABEL[cat]
    season = f"over a {n}-game regular season" if league == "cfb" else "over 17 games"
    vs = (f"That would break the {scope} record of {rv:,} by {who} ({team}, {yr})." if pace > rv
          else f"That would tie the {scope} record set by {who} ({team}, {yr})." if round(pace) == rv
          else f"The {scope} record is {rv:,} by {who} ({team}, {yr}).")
    return fact(league, "player", rows[:5], "On historic pace", f"{what.capitalize()} pace {season}. The {scope} record: {rv:,} ({who}, {yr})",
                f"{what} pace", f"{p['name']} ({p['team']}) is on pace for {s} {what} {season}: {p['total']:,.0f} through {p['tg']} games. {vs}") | {
        "tag": "HISTORIC PACE"}


@stat("pace_cfb_historic")
def _():
    return historic_pace("cfb")


@stat("pace_nfl_historic")
def _():
    return historic_pace("nfl")


def wrap(d, text, f, max_w, lines=2):
    out, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= max_w or not cur:
            cur = t
        else:
            out.append(cur)
            cur = w
    out.append(cur)
    if len(out) > lines:
        out = out[:lines]
        out[-1] = R.fit(d, out[-1] + " …", f, max_w)
    return out


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def dark_logo(im):
    """True when a logo is mostly near-black (it would disappear on the card's dark panel)."""
    small = im.copy()
    small.thumbnail((64, 64))
    solid = small.getchannel("A").point(lambda v: 255 if v > 128 else 0)
    return bool(solid.getbbox()) and ImageStat.Stat(small.convert("L"), solid).mean[0] < 60


def card(f, theme):
    T = {k: hex_rgb(v) for k, v in THEMES[theme].items() if isinstance(v, str) and v.startswith("#")}
    F = lambda size, weight="Regular": font_for(theme, size, weight)
    (lead, _, big), rest = f["rows"][0], f["rows"][1:]
    team_col = hex_rgb(lead.get("color") or "", (90, 90, 96))
    img = Image.new("RGBA", (W, H), T["bg"] + (255,))
    d = ImageDraw.Draw(img)
    for gx in range(12, W, 28):  # faint dot grid
        for gy in range(12, H, 28):
            d.point((gx, gy), fill=mix(T["bg"], T["ink"], 0.12))

    # left: team-color panel with a slanted edge, big faded logo, the photo cut out on top (no frame)
    PW, slant = 690, 120
    grad = Image.new("RGBA", (PW, H))
    gd = ImageDraw.Draw(grad)
    for y in range(H):
        gd.line((0, y, PW, y), fill=mix(mix(team_col, (0, 0, 0), 0.25), mix(team_col, T["bg"], 0.8), y / H) + (255,))
    mask = Image.new("L", (PW, H), 0)
    ImageDraw.Draw(mask).polygon([(0, 0), (PW, 0), (PW - slant, H), (0, H)], fill=255)
    img.paste(grad, (0, 0), mask)
    logo = image(lead.get("logo"))
    if logo and dark_logo(logo):  # a black logo (Iowa, Pitt...) vanishes on the dark panel: use ESPN's version made for dark backgrounds
        u = lead.get("logo") or ""
        cfbd = re.search(r"collegefootballdata\.com/logos/\d+/(\d+)\.png", u)  # college logos: same team id at ESPN
        logo = image(f"https://a.espncdn.com/i/teamlogos/ncaa/500-dark/{cfbd[1]}.png" if cfbd else u.replace("/500/", "/500-dark/")) or logo
    pic = image(lead.get("pic")) if f["kind"] == "player" else None
    if logo:
        wm = logo.copy()
        wm.thumbnail((520, 520), Image.LANCZOS)
        if pic:  # watermark behind the player
            a = wm.getchannel("A").point(lambda v: v * 0.22)
            wm.putalpha(a)
            img.alpha_composite(wm, ((PW - slant // 2 - wm.width) // 2, 70))
        else:  # team stat: the logo IS the picture, with a soft shadow
            big_logo = logo.copy()
            big_logo.thumbnail((440, 440), Image.LANCZOS)
            sh = Image.new("RGBA", big_logo.size, (0, 0, 0, 0))
            sh.putalpha(big_logo.getchannel("A").point(lambda v: v * 0.55))
            sh = sh.filter(ImageFilter.GaussianBlur(14))
            x, y = (PW - slant // 2 - big_logo.width) // 2, (H - big_logo.height) // 2 + 20
            img.alpha_composite(sh, (x + 10, y + 16))
            img.alpha_composite(big_logo, (x, y))
    if pic:
        scale = 640 / pic.height
        pic = pic.resize((round(pic.width * scale), 640), Image.LANCZOS)
        layer = Image.new("RGBA", (PW, H), (0, 0, 0, 0))  # clip the photo to the slanted panel
        layer.alpha_composite(pic, (max(0, (PW - slant // 2 - pic.width) // 2), H - pic.height))
        layer.putalpha(ImageChops.multiply(layer.getchannel("A"), mask))
        img.alpha_composite(layer, (0, 0))
    elif not logo:
        d.rounded_rectangle((180, 260, 460, 540), 24, fill=team_col)

    d.line([(PW, 0), (PW - slant, H)], fill=T["accent"], width=8)
    # brand, top left over the panel
    bf = F(26, "Bold")
    d.text((48, 40), ">", font=bf, fill=T["accent"])
    d.text((76, 40), "CUPCAKE", font=bf, fill=(255, 255, 255))
    d.text((76 + d.textlength("CUPCAKE", font=bf), 40), "_INDEX", font=bf, fill=T["accent"])
    d.text((48, 76), "cupcakeindex.com", font=F(18), fill=(225, 225, 225))

    # right column
    x0, xr = PW + 40, W - 64
    tag_f = F(20, "Bold")
    x = x0
    for label, solid in ((f["league"].upper(), False), (f.get("tag") or ("HOT TAKE" if f["hot"] else "BY THE NUMBERS"), True)):
        tw = d.textlength(label, font=tag_f)
        if solid:
            d.rectangle((x, 44, x + tw + 28, 80), fill=T["accent"])
            d.text((x + 14, 49), label, font=tag_f, fill=T["bg"])
        else:
            d.rectangle((x, 44, x + tw + 28, 80), outline=T["accent"], width=2)
            d.text((x + 14, 49), label, font=tag_f, fill=T["accent"])
        x += tw + 40
    y = 104
    for line in wrap(d, f["title"], F(62, "ExtraBold"), xr - x0, 2):
        d.text((x0, y), line, font=F(62, "ExtraBold"), fill=T["ink"])
        y = max(y + 72, d.textbbox((x0, y), line, font=F(62, "ExtraBold"))[3] + 10)  # tall fonts (Oswald) need room
    for line in wrap(d, f["sub"], F(22), xr - x0, 2):
        d.text((x0, y + 4), line, font=F(22), fill=T["muted"])
        y += 30
    y += 26
    name = lead.get("name") or lead["team"]
    meta = f"{lead.get('pos', '')} · {lead['team']}" if f["kind"] == "player" else \
        (f"{lead['record']} · #{lead['power_rank']} in our rankings" + (f" · AP #{lead['ap_rank']}" if lead.get("ap_rank") else ""))
    d.text((x0, y), R.fit(d, name, F(40, "ExtraBold"), xr - x0), font=F(40, "ExtraBold"), fill=T["ink"])
    ny = d.textbbox((x0, y), R.fit(d, name, F(40, "ExtraBold"), xr - x0), font=F(40, "ExtraBold"))[3]
    d.text((x0, max(y + 50, ny + 8)), meta, font=F(20), fill=T["muted"])
    y = max(y + 86, ny + 44)
    unit = f["unit"].upper()
    if " +" in big and big.endswith("FCS"):  # "2-7 +2 FCS": big number 2-7, FCS games in the label
        big, extra = big.split(" +", 1)
        unit += f" (PLUS {extra})"
    big = f.get("big") or big  # some stats show a different headline number than their bar label
    unit = f.get("big_unit", "").upper() or unit
    bigf = F(104 if len(big) <= 9 else 76, "ExtraBold")
    d.text((x0, y), big, font=bigf, fill=T["accent"])
    by = d.textbbox((x0, y), big, font=bigf)
    d.text((x0, by[3] + 10), unit, font=F(18, "Bold"), fill=T["muted"])
    y = by[3] + 48

    # top 5 as bars (leader in the accent color)
    rows = f["rows"][:5]
    vals = [abs(v) for _, v, _ in rows]
    vmax = max(vals) or 1
    row_h = min(38, (H - (190 if f.get("question") else 110) - y) // max(1, len(rows)))
    lab_w, val_w = 300, 210
    for i, (p, v, s) in enumerate(rows):
        cy = y + i * row_h + row_h // 2
        who = p.get("name") or short(p["team"], f["league"])
        if f["kind"] == "player":
            who += f"  {p['team']}"
        col = T["accent"] if i == 0 else mix(T["muted"], T["bg"], 0.35)
        d.text((x0, cy), R.fit(d, who, F(19, "Bold"), lab_w - 10), font=F(19, "Bold"), fill=T["ink"] if i == 0 else T["muted"], anchor="lm")
        bx0, bx1 = x0 + lab_w, xr - val_w
        frac = abs(v) / vmax
        d.rectangle((bx0, cy - 9, bx1, cy + 9), fill=mix(T["bg"], T["ink"], 0.08))
        d.rectangle((bx0, cy - 9, bx0 + max(6, int((bx1 - bx0) * min(1, frac))), cy + 9), fill=col)
        d.text((xr, cy), R.fit(d, s, F(19, "Bold"), val_w - 14), font=F(19, "Bold"), fill=T["ink"] if i == 0 else T["muted"], anchor="rm")

    # hot takes: the question, as a callout at the bottom
    if f.get("question"):
        qf = F(26, "Bold")
        lines = wrap(d, f["question"], qf, xr - x0 - 36, 2)
        top = H - 56 - 36 * len(lines)
        d.rectangle((x0, top - 6, x0 + 8, H - 50), fill=T["accent"])
        for i, line in enumerate(lines):
            d.text((x0 + 26, top + i * 36), line, font=qf, fill=T["ink"])
    else:
        R.draw_motto(d, xr, H - 60, 17, T["ink"], T["muted"], T["accent"], right=True, font_for=F)
    return img


# ------------------------------------------------------------------ driver
def make(key, out, theme=None):
    f = STATS[key]()
    if not f:
        return None
    theme = theme or random.choice(list(THEMES))
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"obscure-{key}.png")
    card(f, theme).convert("RGB").save(png, optimize=True)
    text = tweet(f["text"], "", with_link=False)  # never a link (Terry's rule)
    meta = {"day": "obscure", "stat": key, "theme": theme, "image": png, "text": text, "skip": False, "reason": ""}
    with open(os.path.join(out, f"obscure-{key}.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)
    return meta


def rotation(now=None):
    """Scheduled runs (twice a day): walk a fixed shuffled order of every stat, one per run, so nothing
    repeats for ~2 weeks (X rejects exact duplicate posts). Afternoon run = even slot, evening = odd."""
    now = now or dt.datetime.now(dt.timezone.utc)
    order = sorted(k for k in STATS if not k.startswith("pace_"))  # pace posts have their own schedule (pace.yml)
    random.Random(now.year).shuffle(order)
    slot = now.timetuple().tm_yday * 2 + (now.hour >= 20)
    return [order[(slot + i) % len(order)] for i in range(len(order))]  # next one first, the rest as fallbacks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stat", default="rotate", help="stat key, or rotate (default) / random / random-hot / random-stat")
    ap.add_argument("--theme", choices=["random", *THEMES], default="random", help="card look (site themes)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--ok-empty", action="store_true", help="no stat qualifies: exit quietly (no today.json) instead of failing")
    ap.add_argument("--all", action="store_true", help="render every stat")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    if a.list:
        print("\n".join(STATS))
        return
    rot = [k for k in STATS if not k.startswith("pace_")]
    pools = {"random": rot, "random-hot": [k for k in STATS if k.startswith("hot_")],
             "random-stat": [k for k in rot if not k.startswith("hot_")],
             "random-obscure": [k for k in rot if not k.startswith("hot_")]}  # old name for random-stat
    if a.stat not in STATS and a.stat not in pools and a.stat != "rotate":
        sys.exit(f"Unknown stat '{a.stat}'. Run with --list to see them.")
    if a.all:
        keys = list(STATS)
    elif a.stat == "rotate":
        # skip anything posted in the last 14 days, so a stat that falls through to the next one in line
        # doesn't get posted again on the next run (that's how repeats happened)
        recent = posted.recent_stats(14)
        keys = [k for k in rotation() if k not in recent] or rotation()
    elif a.stat in pools:
        keys = random.sample(pools[a.stat], len(pools[a.stat]))
    else:
        keys = [a.stat]
    m = None
    for key in keys:
        try:
            m = make(key, a.out, None if a.theme == "random" else a.theme)
        except Exception as e:  # one broken data source shouldn't stop the post
            print(f"[{key}] failed: {e!r}")
            m = None
        if m and not a.all and posted.seen(m["text"]):
            print(f"[{key}] already posted this exact text; trying the next one")
            m = None
            continue
        if m:
            print(f"[{key}] {m['theme']} {m['image']} ({len(m['text'])} chars)\n   {m['text']}")
            if not a.all:
                break
        else:
            print(f"[{key}] not enough data yet")
    if not a.all:
        if not m:
            if a.ok_empty:
                print("Nothing to post this time.")
                return
            sys.exit("No stat had enough data.")
        with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
