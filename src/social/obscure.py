"""On-demand "obscure stat" posts for the X account.

Picks one weird-but-true stat (randomly, or the one you name), renders a card with the leader's
headshot or team logo plus the next four, and writes the tweet text. No links, no betting content,
always 280 characters or fewer. Posting is done by post_to_x.py, same as the daily posts.

    python src/social/obscure.py                     # random stat -> out/social/obscure.png/.txt/.json
    python src/social/obscure.py --stat qb_rush      # a specific one
    python src/social/obscure.py --list              # every stat key
    python src/social/obscure.py --all --out DIR     # render every stat (previews)

Run it from GitHub: Actions > "Obscure stat post" > Run workflow (see README.md).
"""
import argparse
import json
import os
import random
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import ImageFont

import render as R
from render import DATA, ROOT, PAD, TOP, W, canvas, chip, fit, hex_rgb, latest, load, ranked, short, team_logo, tweet

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
_mono_font = R.font
WEIGHT = {"Regular": 400, "Bold": 700, "ExtraBold": 800}


def _font_file(name, size, weight):
    f = ImageFont.truetype(os.path.join(R.HERE, "fonts", name), size)
    try:  # variable fonts (Inter, Source Serif, Oswald): pick the weight, leave other axes at default
        f.set_variation_by_axes([min(max(WEIGHT[weight], a["minimum"]), a["maximum"]) if a["name"] == b"Weight" else a["default"]
                                 for a in f.get_variation_axes()])
    except Exception:
        pass  # static font (Barlow Condensed Bold)
    return f


def use_theme(name):
    """Point render.py's colors and font() at one theme (canvas() and card() read them at draw time)."""
    t = THEMES[name]
    R.BG, R.PANEL, R.INK, R.MUTED, R.LINE, R.ACCENT = (hex_rgb(t[k]) for k in ("bg", "panel", "ink", "muted", "line", "accent"))
    R.DOT = tuple(round(b + (i - b) * 0.09) for b, i in zip(R.BG, R.INK))  # faint dot grid
    R.font = (lambda size, weight="Regular": _font_file(t["head"] if weight == "ExtraBold" else t["body"], size, weight)) if t["head"] else _mono_font

ESPN_FF = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{y}/segments/0/leaguedefaults/3?view=kona_player_info"
POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}
# ESPN fantasy stat ids (season totals, real games)
PA, CMP, PY, PTD, INT, RA, RY, RTD, REC, RECY, RECTD, TGT = "0", "1", "3", "4", "20", "23", "24", "25", "53", "42", "43", "58"


def _json(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 cupcakeindex-social", **(headers or {})})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


_cache = {}


def nfl_players():
    """Every rostered NFL QB/RB/WR/TE with real season-to-date stats: [{id, name, pos, team, s}]."""
    if "nfl" not in _cache:
        y = load(os.path.join(DATA, "index.json"))["leagues"]["nfl"]["latest"]["season"]
        teams = {str(t["team"]["id"]): t["team"] for t in
                 _json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams")["sports"][0]["leagues"][0]["teams"]}
        filt = {"players": {"filterSlotIds": {"value": [0, 2, 4, 6]}, "limit": 700, "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                            "filterStatsForSourceIds": {"value": [0]}, "filterStatsForSplitTypeIds": {"value": [0]},
                            "filterStatsForScoringPeriodIds": {"value": [0]}}}
        out = []
        for x in _json(ESPN_FF.format(y=y), {"X-Fantasy-Filter": json.dumps(filt)}).get("players", []):
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


g = lambda p, k: p["s"].get(k, 0) if "s" in p else p["so"].get(k, 0)


def leaders(rows, value, keep=lambda p: True, low=False, n=5):
    rows = [(p, value(p)) for p in rows if keep(p)]
    rows = [(p, v) for p, v in rows if v is not None]
    return sorted(rows, key=lambda r: r[1] if low else -r[1])[:n]


# ------------------------------------------------------------------ the stats
# Each returns a fact dict or None (not enough data yet):
#   league, title (short, on the card), sub (one line of context), unit, rows [(subject, value)], fmt, text (tweet)
STATS = {}


def stat(key):
    def wrap(fn):
        STATS[key] = fn
        return fn
    return wrap


def n0(v):
    return f"{v:,.0f}"


def n1(v):
    return f"{v:.1f}"


def pct(v):
    return f"{v:.0%}"


def player_fact(league, rows, title, sub, unit, fmt, says):
    if len(rows) < 3:
        return None
    (p, v) = rows[0]
    nxt = ", ".join(f"{q['name']} {fmt(w)}" for q, w in rows[1:3])
    text = f"Obscure stat: {says(p, fmt(v))}. Next up: {nxt}."
    return {"league": league, "title": title, "sub": sub, "unit": unit, "rows": rows, "fmt": fmt, "text": text, "kind": "player"}


# NFL players --------------------------------------------------------
@stat("nfl_yards_per_catch")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RECY) / g(p, REC) if g(p, REC) else None, lambda p: g(p, REC) >= 10)
    return player_fact("nfl", r, "Yards per catch", "NFL leaders, minimum 10 catches", "yds per catch", n1,
                       lambda p, v: f"{p['name']} ({p['team']}) is averaging {v} yards every time he catches the ball")


@stat("nfl_qb_rush")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RY), lambda p: p["pos"] == "QB")
    return player_fact("nfl", r, "QB rushing yards", "Quarterbacks, by rushing yards this season", "rush yds", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) leads all NFL quarterbacks with {v} rushing yards")


@stat("nfl_rb_receiving")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RECY), lambda p: p["pos"] == "RB")
    return player_fact("nfl", r, "RB receiving yards", "Running backs, by receiving yards this season", "rec yds", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has {v} receiving yards, the most of any NFL running back")


@stat("nfl_catch_rate")
def _():
    r = leaders(nfl_players(), lambda p: g(p, REC) / g(p, TGT) if g(p, TGT) else None, lambda p: g(p, TGT) >= 20)
    return player_fact("nfl", r, "Sure hands", "Catch rate (catches per target), minimum 20 targets", "catch rate", pct,
                       lambda p, v: f"{p['name']} ({p['team']}) has caught {v} of the passes thrown his way")


@stat("nfl_yards_per_carry")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RY) / g(p, RA) if g(p, RA) else None, lambda p: g(p, RA) >= 30)
    return player_fact("nfl", r, "Yards per carry", "NFL leaders, minimum 30 carries", "yds per carry", n1,
                       lambda p, v: f"{p['name']} ({p['team']}) is averaging {v} yards per carry")


@stat("nfl_td_rate")
def _():
    r = leaders(nfl_players(), lambda p: g(p, PTD) / g(p, PA) if g(p, PA) else None, lambda p: g(p, PA) >= 60)
    return player_fact("nfl", r, "Touchdown rate", "Share of pass attempts that went for a TD, minimum 60 throws", "of throws are TDs",
                       lambda v: f"{v:.1%}", lambda p, v: f"{v} of {p['name']}'s throws have been touchdowns ({p['team']})")


@stat("nfl_int_thrown")
def _():
    r = leaders(nfl_players(), lambda p: g(p, INT), lambda p: p["pos"] == "QB")
    return player_fact("nfl", r, "Gift wrapped", "Most interceptions thrown this season", "INTs thrown", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has thrown {v} interceptions, the most in the NFL")


@stat("nfl_td_per_touch")
def _():
    touches = lambda p: g(p, RA) + g(p, REC)
    r = leaders(nfl_players(), lambda p: touches(p) / (g(p, RTD) + g(p, RECTD)) if g(p, RTD) + g(p, RECTD) else None,
                lambda p: p["pos"] != "QB" and touches(p) >= 15, low=True)
    return player_fact("nfl", r, "Touches per TD", "Fewest touches per touchdown, minimum 15 touches (non-QBs)", "touches per TD", n1,
                       lambda p, v: f"{p['name']} ({p['team']}) scores once every {v} touches")


@stat("nfl_te_touchdowns")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RECTD), lambda p: p["pos"] == "TE")
    return player_fact("nfl", r, "Tight end TDs", "Tight ends, by receiving touchdowns", "rec TDs", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) leads all tight ends with {v} receiving touchdowns")


@stat("nfl_completion_pct")
def _():
    r = leaders(nfl_players(), lambda p: g(p, CMP) / g(p, PA) if g(p, PA) else None, lambda p: g(p, PA) >= 60)
    return player_fact("nfl", r, "Completion %", "NFL leaders, minimum 60 throws", "completion %", lambda v: f"{v:.1%}",
                       lambda p, v: f"{p['name']} ({p['team']}) is completing {v} of his passes")


@stat("nfl_targets_no_td")
def _():
    r = leaders(nfl_players(), lambda p: g(p, TGT), lambda p: p["pos"] != "QB" and not g(p, RECTD) and not g(p, RTD))
    return player_fact("nfl", r, "Still waiting", "Most targets without a single touchdown", "targets, 0 TDs", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has been targeted {v} times and still has no touchdown")


@stat("nfl_yards_per_target")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RECY) / g(p, TGT) if g(p, TGT) else None, lambda p: g(p, TGT) >= 20)
    return player_fact("nfl", r, "Yards per target", "Receiving yards every time he's thrown to, minimum 20 targets", "yds per target", n1,
                       lambda p, v: f"Throw it to {p['name']} ({p['team']}) and you get {v} yards on average")


# College players ------------------------------------------------------
@stat("cfb_qb_rush")
def _():
    r = leaders(cfb_players(), lambda p: g(p, "ry"), lambda p: p["pos"] == "QB")
    return player_fact("cfb", r, "QB rushing yards", "FBS quarterbacks, by rushing yards this season", "rush yds", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has {v} rushing yards, the most of any FBS quarterback")


@stat("cfb_yards_per_catch")
def _():
    r = leaders(cfb_players(), lambda p: g(p, "recy") / g(p, "rec") if g(p, "rec") else None, lambda p: g(p, "rec") >= 12)
    return player_fact("cfb", r, "Yards per catch", "FBS leaders, minimum 12 catches", "yds per catch", n1,
                       lambda p, v: f"{p['name']} ({p['team']}) is averaging {v} yards per catch")


@stat("cfb_rb_receiving")
def _():
    r = leaders(cfb_players(), lambda p: g(p, "recy"), lambda p: p["pos"] == "RB")
    return player_fact("cfb", r, "RB receiving yards", "FBS running backs, by receiving yards", "rec yds", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has {v} receiving yards, the most of any FBS running back")


@stat("cfb_pass_td_pace")
def _():
    r = leaders(cfb_players(), lambda p: p["ptd"], lambda p: p["pos"] == "QB")
    return player_fact("cfb", r, "Passing TD pace", "Season pace: TDs so far plus our projection for every game left", "pass TD pace", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) is on pace for {v} touchdown passes this season")


@stat("cfb_td_per_catch")
def _():
    r = leaders(cfb_players(), lambda p: g(p, "rectd") / g(p, "rec") if g(p, "rec") else None, lambda p: g(p, "rec") >= 10)
    return player_fact("cfb", r, "TD every few catches", "Share of catches that went for a TD, minimum 10 catches", "of catches are TDs", pct,
                       lambda p, v: f"{v} of {p['name']}'s catches have been touchdowns ({p['team']})")


@stat("cfb_wr_rushing")
def _():
    r = leaders(cfb_players(), lambda p: g(p, "ry"), lambda p: p["pos"] in ("WR", "TE"))
    return player_fact("cfb", r, "Receivers who run", "FBS wide receivers and tight ends, by rushing yards", "rush yds", n0,
                       lambda p, v: f"{p['name']} ({p['team']}) has {v} rushing yards, the most of any FBS receiver")


# Teams ------------------------------------------------------------------
def team_fact(league, rows, title, sub, unit, fmt, says):
    if len(rows) < 3:
        return None
    (t, v) = rows[0]
    nxt = ", ".join(f"{short(q['team'], league)} {fmt(w)}" for q, w in rows[1:3])
    return {"league": league, "title": title, "sub": sub, "unit": unit, "rows": rows, "fmt": fmt, "kind": "team",
            "text": f"Obscure stat: {says(t, fmt(v))}. Next up: {nxt}."}


def upcoming(t):
    return [s for s in t["schedule"] if s.get("upcoming") and s.get("opp_rating") is not None]


def played(t):
    return [s for s in t["schedule"] if s.get("result")]


def margin(s):
    try:
        a, b = (int(x) for x in s["score"].split("-"))
        return a - b if s["result"] == "W" else -abs(a - b) if s["result"] == "L" else 0
    except Exception:
        return None


@stat("cfb_luckiest")
def _():
    cur, _, _ = latest("cfb")
    r = leaders(ranked(cur), lambda t: t.get("luck_wins"), lambda t: t["wins"] + t["losses"] >= 3)
    return team_fact("cfb", r, "Living right", "Wins above what their play deserved (close games, turnovers)", "lucky wins", lambda v: f"+{v:.1f}",
                     lambda t, v: f"{t['team']} ({t['record']}) has {v.lstrip('+')} more wins than their play has earned, the luckiest in FBS")


@stat("nfl_unluckiest")
def _():
    cur, _, _ = latest("nfl")
    r = leaders(ranked(cur), lambda t: t.get("luck_wins"), lambda t: t["wins"] + t["losses"] >= 2, low=True)
    return team_fact("nfl", r, "Snakebit", "Fewer wins than their play deserves (close losses, bad bounces)", "wins lost to luck", n1,
                     lambda t, v: f"The {t['team']} ({t['record']}) are {v.lstrip('-')} wins below what their play deserves, the unluckiest in the NFL")


@stat("cfb_ap_overrated")
def _():
    cur, _, _ = latest("cfb")
    r = leaders(ranked(cur), lambda t: t["power_rank"] - t["ap_rank"] if t.get("ap_rank") else None)
    return team_fact("cfb", r, "The AP loves them", "AP Top 25 teams we rank furthest below their poll spot", "spots below AP", n0,
                     lambda t, v: f"{t['team']} is #{t['ap_rank']} in the AP poll but #{t['power_rank']} in ours, {v} spots apart")


@stat("cfb_hardest_left")
def _():
    cur, _, _ = latest("cfb")
    avg = lambda t: sum(s["opp_rating"] for s in upcoming(t)) / len(upcoming(t)) if upcoming(t) else None
    r = leaders(ranked(cur)[:25], avg)
    return team_fact("cfb", r, "Gauntlet ahead", "Our top 25, by average strength of the opponents left", "avg opponent rating", lambda v: f"{v:+.1f}",
                     lambda t, v: f"Of our top 25, #{t['power_rank']} {t['team']} has the toughest road left ({len(upcoming(t))} games to go)")


@stat("nfl_easiest_left")
def _():
    cur, _, _ = latest("nfl")
    avg = lambda t: sum(s["opp_rating"] for s in upcoming(t)) / len(upcoming(t)) if upcoming(t) else None
    r = leaders(ranked(cur), avg, low=True)
    return team_fact("nfl", r, "Cupcakes ahead", "NFL teams by average strength of the opponents left", "avg opponent rating", lambda v: f"{v:+.1f}",
                     lambda t, v: f"The {t['team']} have the softest schedule left in the NFL ({len(upcoming(t))} games to go)")


@stat("nfl_one_score")
def _():
    cur, _, _ = latest("nfl")
    n = lambda t: sum(int(x) for x in t.get("one_score", "0-0").split("-"))
    r = leaders(ranked(cur), lambda t: n(t) or None)
    return team_fact("nfl", r, "Heart attack club", "Most games decided by 8 points or fewer", "one-score games", n0,
                     lambda t, v: f"The {t['team']} have played {v} one-score games already ({t['one_score']} in them)")


@stat("cfb_biggest_win")
def _():
    cur, _, _ = latest("cfb")
    best = lambda t: max((m for s in played(t) if not s.get("fcs") and (m := margin(s)) is not None), default=None)
    r = leaders(ranked(cur), best)
    return team_fact("cfb", r, "Biggest beatdown", "Largest win over an FBS opponent this season", "point margin", lambda v: f"+{v:.0f}",
                     lambda t, v: f"{t['team']}'s {v} win is the biggest by any FBS team over an FBS opponent this year")


@stat("nfl_toughest_so_far")
def _():
    cur, _, _ = latest("nfl")
    r = leaders(ranked(cur), lambda t: t["scores"].get("sos"))
    return team_fact("nfl", r, "Survived the gauntlet", "Toughest schedule so far (our schedule score, 0-100)", "schedule score", n0,
                     lambda t, v: f"The {t['team']} ({t['record']}) have played the NFL's toughest schedule so far")


# Hot takes -------------------------------------------------------------
# Same data, but each one makes a debatable point and ends with a question to get people replying.
# Rule: arguments about teams and players on the field only. No betting angles, nothing personal.
def hot(league, rows, title, sub, unit, fmt, says, kind="team"):
    if len(rows) < 3:
        return None
    t, v = rows[0]
    return {"league": league, "title": title, "sub": sub, "unit": unit, "rows": rows, "fmt": fmt, "kind": kind,
            "kicker": "Hot take", "text": "Hot take: " + says(t, fmt(v))}


def best_win(t):
    wins = [s for s in played(t) if s["result"] == "W" and s.get("opp_rank") and not s.get("fcs")]
    return min(wins, key=lambda s: s["opp_rank"]) if wins else None


@stat("hot_cfb_beaten_nobody")
def _():
    cur, _, _ = latest("cfb")
    r = leaders(ranked(cur), lambda t: best_win(t)["opp_rank"] if best_win(t) else 200, lambda t: t.get("ap_rank"))

    def says(t, v):
        b = best_win(t)
        win = f"its best win is over #{b['opp_rank']} {b['opp']} in our rankings" if b else "it hasn't beaten a single FBS team"
        return f"AP #{t['ap_rank']} {t['team']} is {t['record']}, and {win}. Contender, or a résumé made of cupcakes?"
    return hot("cfb", r, "Beaten nobody?", "AP-ranked teams whose best win is the weakest (our rank of that opponent)", "our rank of best win",
               lambda v: f"#{v:.0f}" if v < 200 else "none", says)


@stat("hot_cfb_ap_snub")
def _():
    cur, _, _ = latest("cfb")
    r = leaders(ranked(cur)[:25], lambda t: (t["ap_rank"] or 40) - t["power_rank"])
    return hot("cfb", r, "The AP is sleeping", "Our top 25, by how far the AP poll has them below our spot", "spots higher than AP", n0,
               lambda t, v: f"We have {t['team']} ({t['record']}) at #{t['power_rank']}. The AP has them "
                            + (f"at #{t['ap_rank']}." if t.get("ap_rank") else "unranked.") + " Who's wrong, us or the voters?")


@stat("hot_cfb_paper_unbeaten")
def _():
    cur, _, _ = latest("cfb")
    cups = lambda t: sum(1 for s in played(t) if s.get("cupcake") or s.get("fcs"))
    r = leaders(ranked(cur), lambda t: t["scores"]["cupcake"], lambda t: t["losses"] == 0 and t["wins"] >= 3)
    return hot("cfb", r, "Paper perfect?", "Unbeaten teams, by Cupcake score (0-100, higher = more padding)", "cupcake score", n0,
               lambda t, v: f"{t['team']} is {t['record']}, but {cups(t)} of those wins came against cupcakes, the most padded "
                            "unbeaten in FBS. Does a perfect record mean anything without a real test?")


@stat("hot_nfl_record_lies")
def _():
    cur, _, _ = latest("nfl")
    teams = ranked(cur)
    by_rec = {t["team"]: i + 1 for i, t in enumerate(sorted(teams, key=lambda t: (-(t["wins"] - t["losses"]), t["power_rank"])))}
    r = leaders(teams, lambda t: t["power_rank"] - by_rec[t["team"]], lambda t: t["wins"] > t["losses"])
    return hot("nfl", r, "Record or reality?", "Winning teams our model ranks furthest below their record", "spots below record", n0,
               lambda t, v: f"The {t['team']} are {t['record']}, but by how they actually play we have them #{t['power_rank']}. "
                            "Is the record lying, or is our model?")


@stat("hot_nfl_better_than_record")
def _():
    cur, _, _ = latest("nfl")
    r = leaders(ranked(cur), lambda t: -t["power_rank"], lambda t: t["losses"] >= t["wins"] and t["wins"] + t["losses"] >= 2)
    return hot("nfl", r, "Better than the record", "Teams at .500 or worse, by our power ranking", "our rank",
               lambda v: f"#{-v:.0f}", lambda t, v: f"The {t['team']} are {t['record']}, yet they're {v} in our rankings by how they "
                                                    "actually play. Sleeping giant, or a bad team with good stats?")


@stat("hot_nfl_lucky_record")
def _():
    cur, _, _ = latest("nfl")
    r = leaders(ranked(cur), lambda t: t.get("luck_wins"), lambda t: t["wins"] > t["losses"])
    return hot("nfl", r, "Living on luck", "Winning teams, by wins above what their play deserves", "lucky wins", lambda v: f"+{v:.1f}",
               lambda t, v: f"The {t['team']} are {t['record']}, but by our math {v.lstrip('+')} of those wins came from close-game luck. "
                            "Clutch, or living on borrowed time?")


@stat("hot_nfl_empty_yards")
def _():
    r = leaders(nfl_players(), lambda p: g(p, PY) / g(p, PTD) if g(p, PTD) else g(p, PY), lambda p: g(p, PA) >= 80)
    return hot("nfl", r, "Empty yards?", "Passing yards per touchdown pass, minimum 80 throws", "yds per TD pass", n0,
               lambda p, v: f"{p['name']} ({p['team']}) has {g(p, PY):,.0f} passing yards but just {g(p, PTD):.0f} TD pass{'' if g(p, PTD) == 1 else 'es'}, "
                            f"one every {v} yards. Stat-sheet QB, or bad luck in the red zone?", kind="player")


@stat("hot_nfl_volume_merchant")
def _():
    r = leaders(nfl_players(), lambda p: g(p, RECY) / g(p, TGT) if g(p, TGT) else None, lambda p: g(p, TGT) >= 25, low=True)
    return hot("nfl", r, "Volume or value?", "Fewest yards per target, minimum 25 targets", "yds per target", n1,
               lambda p, v: f"{p['name']} ({p['team']}) has been thrown to {g(p, TGT):.0f} times and averages {v} yards a target, "
                            "the least of anyone with 25+. Is he getting open, or just getting fed?", kind="player")


# ------------------------------------------------------------------ card
def card(f):
    font = R.font  # the theme's (set by use_theme)
    img, d = canvas(f["league"], f.get("kicker", "Obscure stat"), f["title"], f["sub"])
    (lead, v), rest = f["rows"][0], f["rows"][1:]
    # left: big picture panel, outlined in the team color
    px, py, ps = PAD, TOP + 10, 400
    col = hex_rgb(lead.get("color", ""))
    d.rectangle((px, py, px + ps, py + ps), fill=R.PANEL, outline=col + (255,), width=3)
    pic = team_logo(lead.get("pic") or lead.get("logo"), ps - 40)
    if pic is None and lead.get("logo"):
        pic = team_logo(lead.get("logo"), ps - 80)
    if pic:
        img.alpha_composite(pic, (px + (ps - pic.width) // 2, py + ps - 6 - pic.height if lead.get("pic") else py + (ps - pic.height) // 2))
    else:
        chip(img, d, lead, px + 100, py + 100, ps - 200)
    # right: name, the number, then the next four
    x0 = px + ps + 56
    name = lead.get("name") or lead["team"]
    d.text((x0, py), fit(d, name, font(48, "ExtraBold"), W - PAD - x0), font=font(48, "ExtraBold"), fill=R.INK)
    meta = f"{lead.get('pos', '')} · {lead['team']}" if f["kind"] == "player" else f"#{lead.get('power_rank', '?')} in our rankings · {lead.get('record', '')}"
    d.text((x0, py + 64), meta, font=font(24), fill=R.MUTED)
    d.text((x0, py + 104), f["fmt"](v), font=font(120, "ExtraBold"), fill=R.ACCENT)
    low = max(py + 236, d.textbbox((x0, py + 104), f["fmt"](v), font=font(120, "ExtraBold"))[3] + 14)  # tall fonts (Oswald) need room
    d.text((x0, low), f["unit"].upper(), font=font(22, "Bold"), fill=R.MUTED)
    y = max(py + 300, low + 50)
    d.line((x0, y, W - PAD, y), fill=R.LINE)
    for i, (p, w) in enumerate(rest[:4]):
        cy = y + 22 + i * 36
        who = p.get("name") or short(p["team"], f["league"])
        tag = p["team"] if f["kind"] == "player" else ""
        d.text((x0, cy), f"{i + 2}.", font=font(22, "Bold"), fill=R.MUTED, anchor="lm")
        d.text((x0 + 44, cy), fit(d, who + (f"  {tag}" if tag else ""), font(22, "Bold"), W - PAD - x0 - 220), font=font(22, "Bold"), fill=R.INK, anchor="lm")
        d.text((W - PAD, cy), f["fmt"](w), font=font(22, "Bold"), fill=R.INK, anchor="rm")
    return img


def make(key, out, theme=None):
    f = STATS[key]()
    if not f:
        return None
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"obscure-{key}.png")
    theme = theme or random.choice(list(THEMES))
    use_theme(theme)
    card(f).convert("RGB").save(png, optimize=True)
    text = tweet(f["text"], "", with_link=False)  # never a link (Terry's rule)
    meta = {"day": "obscure", "stat": key, "theme": theme, "image": png, "text": text, "skip": False, "reason": ""}
    with open(os.path.join(out, f"obscure-{key}.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stat", default="random", help="stat key, or random / random-hot / random-obscure")
    ap.add_argument("--theme", choices=["random", *THEMES], default="random", help="card look (site themes)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--all", action="store_true", help="render every stat")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    if a.list:
        print("\n".join(STATS))
        return
    pools = {"random": list(STATS), "random-hot": [k for k in STATS if k.startswith("hot_")],
             "random-obscure": [k for k in STATS if not k.startswith("hot_")]}
    if a.stat not in STATS and a.stat not in pools:
        sys.exit(f"Unknown stat '{a.stat}'. Run with --list to see them.")
    keys = list(STATS) if a.all else random.sample(pools[a.stat], len(pools[a.stat])) if a.stat in pools else [a.stat]
    m = None
    for key in keys:
        try:
            m = make(key, a.out, None if a.theme == "random" else a.theme)
        except Exception as e:  # one broken data source shouldn't stop a random pick
            print(f"[{key}] failed: {e!r}")
            m = None
        if m:
            print(f"[{key}] {m['theme']} {m['image']} ({len(m['text'])} chars)\n   {m['text']}")
            if not a.all:
                break
        else:
            print(f"[{key}] not enough data yet")
    if not a.all:
        if not m:
            sys.exit("No stat had enough data.")
        with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
            json.dump(m, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
