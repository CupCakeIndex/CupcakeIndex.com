"""Conversation starters: a handful of debatable numbers about every team in our college top 25, for the Takes tab
on its team page (docs/data/starters.json; takes.js shows them above our X posts).

Each one is {big, label, text}: a big number, what it is, and a sentence that ends in something to argue about.
Most compare the team to the rest of the top 25 ("best in the top 25 at...", "last in the top 25 at..."), from our
rankings file (model, schedule, win chances) plus ESPN's season team stats and our since-2005 facts.
Win chances only, never our own lines (Terry's rule), and never 100% before a game is played (99.9% cap).

    python src/starters.py          # weekly.yml, after the rankings update
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from math import prod
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "starters.json"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{}/statistics"
TOP = 25
PER_TEAM = 7


def latest_week():
    weeks = sorted((ROOT / "docs" / "data" / "cfb").glob("*/week_*.json"),
                   key=lambda p: (int(p.parent.name), int(p.stem.split("_")[1])))
    return json.loads(weeks[-1].read_text(encoding="utf-8"))


def espn_stats(tid):
    try:
        r = requests.get(ESPN.format(tid), timeout=20).json()
        out = {}
        for c in r["results"]["stats"]["categories"]:
            for s in c["stats"]:
                try:
                    out.setdefault(f"{c['name']}.{s['name']}", float(str(s.get("value", s.get("displayValue"))).replace(",", "")))
                except (TypeError, ValueError):
                    pass
        return out
    except Exception as e:
        print(f"  ! ESPN stats for {tid}: {e}")
        return {}


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def pct(p):
    """A win chance as shown on the site: never 0% or 100% before the game (99.9% cap)."""
    p = min(max(p, 0.001), 0.999)
    return f"{p * 100:.1f}%" if p >= 0.995 or p <= 0.005 else f"{round(p * 100)}%"


def a_n(s):
    """'a 24%' / 'an 11%', 'an 8%', 'an 80%'."""
    return ("an " if s[:1] == "8" or s[:2] in ("11", "18") and not s[2:3].isdigit() else "a ") + s


def games(t):
    """Played games: [(game, us, them)]."""
    out = []
    for g in t["schedule"]:
        if g.get("result") and g.get("score") and "-" in g["score"]:
            a, b = g["score"].split("-")[:2]
            out.append((g, int(a), int(b)))
    return out


def opp(g):
    return f"{'No. ' + str(g['opp_rank']) + ' ' if g.get('opp_rank') and g['opp_rank'] <= 25 else ''}{g['opp']}"


# stats compared across the top 25: (name, label, how to get it, higher is better, format)
def per_game(k):
    return lambda s, t: s[k] / s["general.gamesPlayed"] if s.get(k) is not None and s.get("general.gamesPlayed") else None


def allowed(t):
    gs = games(t)
    return sum(b for _, _, b in gs) / len(gs) if gs else None


STATS = [
    ("ypp", "yards per play", lambda s, t: s["rushing.totalYards"] / s["rushing.totalOffensivePlays"] if s.get("rushing.totalOffensivePlays") else None, True, "{:.1f}"),
    ("ppg", "points a game", lambda s, t: s.get("passing.totalPointsPerGame"), True, "{:.1f}"),
    ("allowed", "points allowed a game", lambda s, t: allowed(t), False, "{:.1f}"),
    ("third", "third-down conversion rate", lambda s, t: s.get("miscellaneous.thirdDownConvPct"), True, "{:.0f}%"),
    ("to", "turnover margin", lambda s, t: s.get("miscellaneous.turnOverDifferential"), True, "{:+.0f}"),
    ("sacks", "sacks a game", per_game("defensive.sacks"), True, "{:.1f}"),
    ("sacked", "sacks allowed a game", per_game("passing.sacks"), False, "{:.1f}"),
    ("ypa", "yards per pass attempt", lambda s, t: s.get("passing.yardsPerPassAttempt"), True, "{:.1f}"),
    ("ypc", "yards per carry", lambda s, t: s.get("rushing.yardsPerRushAttempt"), True, "{:.1f}"),
    ("pen", "penalty yards a game", per_game("miscellaneous.totalPenaltyYards"), False, "{:.0f}"),
    ("tfl", "tackles for loss a game", per_game("defensive.tacklesForLoss"), True, "{:.1f}"),
    ("ints", "interceptions a game", per_game("defensiveInterceptions.interceptions"), True, "{:.1f}"),
]
QUESTIONS = {  # (best, worst)
    "ypp": ("Most explosive offense in the country, or just the schedule?", "Can a top-25 team win it all moving the ball like this?"),
    "ppg": ("Is anyone in the top 25 slowing this offense down?", "Is the offense good enough for a playoff run?"),
    "allowed": ("Best defense in the country?", "Can you win a title giving up this many?"),
    "third": ("Clutch, or a product of short-yardage luck?", "Fixable, or a fatal flaw?"),
    "to": ("Skill or luck? Turnovers tend to even out.", "Is the ball security going to cost them a big game?"),
    "sacks": ("Scariest pass rush in the country?", "Where is the pass rush?"),
    "sacked": ("Elite line, or a QB who gets rid of it fast?", "Is the offensive line going to hold up in November?"),
    "ypa": ("Best passing attack in the country?", "Can they win a big game through the air?"),
    "ypc": ("Best run game in the top 25?", "Is the run game good enough when the weather turns?"),
    "pen": ("Most disciplined team in the country?", "Are the penalties going to cost them a big one?"),
    "tfl": ("Most disruptive front in the country?", "Is the defense too passive up front?"),
    "ints": ("Ballhawks, or quarterbacks gifting it to them?", "Why isn't the secondary making plays?"),
}


def starters(t, ctx):
    name, out = t["team"], []
    gs = games(t)
    w, l = t["wins"], t["losses"]

    # 1. us vs the AP
    ap, ours = t.get("ap_rank"), t["power_rank"]
    if not ap:
        out.append((9, {"big": f"#{ours}", "label": "in our rankings, unranked by the AP",
                        "text": f"We have {name} at No. {ours}. The AP poll doesn't have them in its top 25 at all. Are the voters sleeping on them, or are we?"}))
    elif abs(ap - ours) >= 4:
        hi = ours < ap
        out.append((6 + abs(ap - ours) / 4, {"big": f"#{ours} vs #{ap}", "label": "our rank vs the AP",
                    "text": f"We have {name} at No. {ours}; the AP has them at No. {ap}. "
                            + ("We like them more than the voters do. Who's right?" if hi else "The voters like them more than our numbers do. Who's right?")}))

    # 2. margin against real teams
    real = [(g, a, b) for g, a, b in gs if not g.get("cupcake")]
    if real:
        m = sum(a - b for _, a, b in real) / len(real)
        rk = ctx["margin_rank"].get(t["id"])
        out.append((5 + (3 if rk in (1, TOP) else 0), {"big": f"{m:+.1f}", "label": f"average margin vs non-cupcakes ({len(real)} game{'s' if len(real) > 1 else ''})",
                    "text": f"Take out the cupcakes and {name} is {'winning' if m > 0 else 'losing'} by {abs(m):.1f} a game"
                            + (f", {ordinal(rk)} in the top 25." if rk else ".") + (" Dominant, or not tested yet?" if m > 20 else " Is that a top-25 team?" if m < 7 else " Where does that rank them for you?")}))

    # 3. cupcakes
    cup = sum(1 for g, _, _ in gs if g.get("cupcake"))
    if cup >= 2:
        out.append((7 + cup, {"big": f"{cup} of {len(gs)}", "label": "games against cupcakes",
                    "text": f"{cup} of {name}'s {len(gs)} games have come against cupcakes. Should the ranking take a hit for that?"}))
    elif cup == 0 and len(gs) >= 4:
        out.append((6, {"big": "0", "label": "cupcakes played",
                    "text": f"{name} hasn't played a single cupcake. Only {ctx['no_cupcake']} of the top 25 can say that. Does that earn them the benefit of the doubt?"}))

    # 4. best win / worst loss
    wins = [(g, a, b) for g, a, b in gs if g["result"] == "W"]
    if wins:
        g, a, b = max(wins, key=lambda x: x[0].get("opp_rating") or -99)
        if g.get("opp_rank") and g["opp_rank"] <= 40:
            out.append((5 + (3 if g["opp_rank"] <= 15 else 0), {"big": f"{a}-{b}", "label": f"best win: {opp(g)}",
                        "text": f"{name}'s best win so far: {a}-{b} over {opp(g)} (No. {g['opp_rank']} in our rankings). Résumé-worthy, or not enough yet?"}))
        else:
            out.append((8, {"big": "None", "label": "wins over our top 40",
                        "text": f"{name} is {w}-{l} without a win over anyone in our top 40. The best so far: {opp(g)}. Paper tiger?"}))
    losses = [(g, a, b) for g, a, b in gs if g["result"] == "L"]
    if losses:
        g, a, b = min(losses, key=lambda x: x[0].get("opp_rating") or 99)
        out.append((6, {"big": f"{a}-{b}", "label": f"worst loss: {opp(g)}",
                    "text": f"{name} lost {a}-{b} to {opp(g)}. How much should one loss count against them?"}))

    # 5. the road ahead
    left = [g for g in t["schedule"] if g.get("upcoming") and g.get("win_prob") is not None]
    if left:
        hard = min(left, key=lambda g: g["win_prob"])
        out.append((6 + (3 if hard["win_prob"] < 0.5 else 0), {"big": pct(hard["win_prob"]), "label": f"chance to beat {opp(hard)} ({'home' if hard.get('loc') == 'H' else 'road' if hard.get('loc') == 'A' else 'neutral'})",
                    "text": f"{name}'s toughest game left: {'vs.' if hard.get('loc') != 'A' else 'at'} {opp(hard)}, Week {hard['week']}. Our model gives them {pct(hard['win_prob'])}. Who you got?"}))
        if not l:
            p = prod(g["win_prob"] for g in left)
            out.append((7 + (3 if p > 0.25 else 0), {"big": pct(p), "label": "chance to finish the regular season unbeaten",
                        "text": f"{name} is {w}-0. Our model gives them {a_n(pct(p))} chance to win every game left. Higher or lower than you'd say?"}))
        else:
            ew = w + sum(g["win_prob"] for g in left)
            n = w + l + len(left)
            out.append((4, {"big": f"{round(ew)}-{n - round(ew)}", "label": "projected regular-season record",
                        "text": f"Add up {name}'s win chances for every game left and you get about {round(ew)}-{n - round(ew)}. Over or under?"}))

    # 6. close games and luck
    os_w, os_l = (int(x) for x in (t.get("one_score") or "0-0").split("-")[:2])
    if os_w + os_l >= 2:
        out.append((5 + abs(os_w - os_l), {"big": f"{os_w}-{os_l}", "label": "in one-score games",
                    "text": f"{name} is {os_w}-{os_l} in games decided by 8 points or less. "
                            + ("Clutch, or living on borrowed time?" if os_w > os_l else "Unlucky, or just not good enough to close?" if os_l > os_w else "Which way does it break from here?")}))

    # 7. best and worst in the top 25 (ESPN season stats)
    for key, (rank, val) in ctx["stat_ranks"].get(t["id"], {}).items():
        label, fmt = next((s[1], s[4]) for s in STATS if s[0] == key)
        if rank in (1, 2):
            out.append((8 - rank, {"big": fmt.format(val), "label": f"{label}: {ordinal(rank)} in the top 25",
                        "text": f"{name} is {ordinal(rank)} in the top 25 in {label} ({fmt.format(val)}). {QUESTIONS[key][0]}"}))
        elif rank in (ctx["n"], ctx["n"] - 1):
            out.append((8 - (ctx["n"] - rank), {"big": fmt.format(val), "label": f"{label}: {'last' if rank == ctx['n'] else '2nd to last'} in the top 25",
                        "text": f"{name} is {'last' if rank == ctx['n'] else 'second to last'} in the top 25 in {label} ({fmt.format(val)}). {QUESTIONS[key][1]}"}))

    # 8. one fact from history (Just the facts, since 2005)
    fact = next((f for f in ctx["facts"].get(str(t["id"]), []) if any(w_ in f.get("label", "") for w_ in ("ranked", "top-10", "road"))), None)
    if fact:
        out.append((4, {"big": fact["big"], "label": fact["label"], "text": f"{name}: {fact['detail'] or fact['big'] + ' ' + fact['label']}. Does history matter this year?"}))

    out.sort(key=lambda x: -x[0])
    return [x[1] for x in out[:PER_TEAM]]


def main():
    d = latest_week()
    top = sorted([t for t in d["teams"] if t.get("power_rank")], key=lambda t: t["power_rank"])[:TOP]
    with ThreadPoolExecutor(max_workers=8) as pool:
        stats = dict(zip([t["id"] for t in top], pool.map(espn_stats, [t["id"] for t in top])))

    # rank every top-25 team in each stat (1 = best)
    stat_ranks = {}
    for key, _label, get, hi, _fmt in STATS:
        vals = []
        for t in top:
            try:
                v = get(stats[t["id"]], t)
            except (KeyError, ZeroDivisionError, TypeError):
                v = None
            if v is not None:
                vals.append((t["id"], v))
        if len(vals) < TOP - 3:
            continue
        vals.sort(key=lambda x: -x[1] if hi else x[1])
        for i, (tid, v) in enumerate(vals):
            stat_ranks.setdefault(tid, {})[key] = (i + 1, v)
    margins = []
    for t in top:
        real = [(a - b) for g, a, b in games(t) if not g.get("cupcake")]
        if real:
            margins.append((t["id"], sum(real) / len(real)))
    margin_rank = {tid: i + 1 for i, (tid, _) in enumerate(sorted(margins, key=lambda x: -x[1]))}
    try:
        facts = json.loads((ROOT / "docs" / "data" / "cfb" / "facts.json").read_text(encoding="utf-8"))["teams"]
    except (OSError, ValueError, KeyError):
        facts = {}
    ctx = {"stat_ranks": stat_ranks, "margin_rank": margin_rank, "facts": facts, "n": TOP,
           "no_cupcake": sum(1 for t in top if not any(g.get("cupcake") for g, _, _ in games(t)))}

    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
           "season": d["season"], "week": d["week"], "teams": {}}
    for t in top:
        out["teams"][f"cfb:{t['id']}"] = starters(t, ctx)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Conversation starters for {len(out['teams'])} teams (week {d['week']})")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
