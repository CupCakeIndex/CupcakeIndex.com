"""Pass, target and rush charts for NFL player pages (docs/live.js passChartInto).

ESPN's play-by-play doesn't say where an NFL incomplete pass was thrown, and its yards-after-catch number is sometimes off.
nflverse's play-by-play has air yards and the side of the field on every attempt, so this writes one small file per player:
docs/data/nfl/<season>/charts/<espn id>.json

  {"pass":   [[week, quarter, clock, air yards, "left|middle|right", result, yards after catch, play text], ...],
   "target": [same, for the receiver],
   "rush":   [[week, quarter, clock, yards, "left end|left tackle|...|up the middle|...", result, 0, play text], ...],
   "kick":   [[week, quarter, clock, field goal distance, "l|c|r" (wide left / between the uprights / wide right), result,
              "l|c|r" (left hash / middle / right hash, ESTIMATED), play text], ...],
   "xp":     [extra points made, tried],
   "dates":  {week: "YYYY-MM-DD"}, so the page can match weeks to ESPN's games (playoff weeks are 19+),
   "ranks":  {"pass": {"adot": [rank, out of], ..., "_min": qualifying count, "_wk": through week}, ...}}

result: c = caught, t = touchdown, i = incomplete, x = intercepted; runs: r = run, t = touchdown, f = fumble lost;
kicks: g = good, m = missed (wide or off an upright), s = short, b = blocked. Which way a kick missed comes from the play text
("No Good, Wide Right"). No free data says which hash a kick came from, so it's estimated from the plays before it (hash_before).
Weeks nflverse hasn't posted yet are filled in on the page from ESPN. Runs in viz.yml (python src/pass_charts.py).
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from deep_stats import pbp  # noqa: E402
from viz_data import NFLV, nflverse_csv, season_now  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "nfl"


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def hash_step(r, spot):
    """The ball's hash after this play (l / c / r), from where the play went. Plays that don't move the ball (an incomplete
    pass, a spike, a penalty) leave it where it was; a kneel or sack is taken as the middle. A rough estimate: a short run to
    the left can still end between the hashes."""
    side = lambda x: {"left": "l", "right": "r"}.get(x or "", "c")  # noqa: E731
    if r.get("play_type") == "no_play" or r.get("qb_spike") == "1":
        return spot
    if r.get("qb_kneel") == "1" or r.get("sack") == "1":
        return "c"
    if r.get("pass_attempt") == "1":
        return side(r.get("pass_location")) if r.get("complete_pass") == "1" else spot
    if r.get("rush_attempt") == "1":
        return side(r.get("run_location"))
    return spot


def build(season, kicks_only=False):
    espn = {r["gsis_id"]: r["espn_id"] for r in nflverse_csv(f"{NFLV}/players/players.csv", "players.csv") if r.get("espn_id") and r.get("gsis_id")}
    by = defaultdict(lambda: {"pass": [], "target": [], "rush": [], "kick": [], "dates": {}})
    spot = {}  # game -> (team with the ball, estimated hash l / c / r) for the kick charts
    for r in pbp(season):
        gid, team = r.get("game_id"), r.get("posteam")
        had, where = spot.get(gid, ("", "c"))
        before = where if team and had == team else "c"  # a new possession starts in the middle
        if r.get("play_type") in ("kickoff", "punt", "extra_point", "field_goal"):
            spot[gid] = ("", "c")  # the next possession starts in the middle
        elif team:
            spot[gid] = (team, hash_step(r, before))
        if r.get("season_type") != "REG" and r.get("season_type") != "POST":
            continue
        if r.get("two_point_attempt") == "1" or r.get("qb_spike") == "1" or r.get("qb_kneel") == "1" or r.get("play_type") == "no_play":
            continue
        when = r.get("game_date") or ""
        wk, q, clock, desc = int(r["week"]), int(r["qtr"] or 0), (r.get("time") or "")[:5], (r.get("desc") or "")[:160]
        kicker = espn.get(r.get("kicker_player_id"))
        if r.get("play_type") == "field_goal" and kicker and num(r.get("kick_distance")) is not None:
            d = (r.get("desc") or "").lower()
            res = {"made": "g", "blocked": "b"}.get(r.get("field_goal_result"), "s" if "short" in d else "m")
            side = "c" if res in "gsb" else "l" if re.search(r"wide left|left upright", d) else "r" if re.search(r"wide right|right upright", d) else "c"
            by[kicker]["kick"].append([wk, q, clock, int(num(r["kick_distance"])), side, res, before, desc])
            by[kicker]["dates"][wk] = when
            continue
        if r.get("play_type") == "extra_point" and kicker and r.get("extra_point_result") in ("good", "failed", "blocked"):
            xp = by[kicker].setdefault("xp", [0, 0])
            xp[0] += r["extra_point_result"] == "good"; xp[1] += 1
            continue
        if r.get("pass_attempt") == "1" and r.get("sack") != "1":
            air = num(r.get("air_yards"))
            if air is None:  # throwaways and batted balls have no depth
                continue
            res = "x" if r.get("interception") == "1" else ("t" if r.get("pass_touchdown") == "1" else "c") if r.get("complete_pass") == "1" else "i"
            yac = int(num(r.get("yards_after_catch")) or 0) if res in "ct" else 0
            row = [wk, q, clock, int(air), r.get("pass_location") or "middle", res, yac, desc]
            if espn.get(r.get("passer_player_id")):
                by[espn[r["passer_player_id"]]]["pass"].append(row)
                by[espn[r["passer_player_id"]]]["dates"][wk] = when
            if espn.get(r.get("receiver_player_id")):
                by[espn[r["receiver_player_id"]]]["target"].append(row)
                by[espn[r["receiver_player_id"]]]["dates"][wk] = when
        elif r.get("rush_attempt") == "1" and espn.get(r.get("rusher_player_id")):
            yds = num(r.get("rushing_yards"))
            if yds is None:
                continue
            loc, gap = r.get("run_location") or "", r.get("run_gap") or ""
            where = "up the middle" if loc == "middle" or not loc else f"{loc} {gap or 'tackle'}"
            res = "f" if r.get("fumble_lost") == "1" else "t" if r.get("rush_touchdown") == "1" else "r"
            by[espn[r["rusher_player_id"]]]["rush"].append([wk, q, clock, int(yds), where, res, 0, desc])
            by[espn[r["rusher_player_id"]]]["dates"][wk] = when
    # league ranks for the stats over the chart (the page shows them on "All weeks"). #1 = highest, except "stuffed" (#1 = fewest).
    # Qualifying: at least 35% as many throws / targets / runs as the league leader.
    def mean(xs):
        return sum(xs) / len(xs) if xs else None

    def share(f, xs):
        return sum(1 for x in xs if f(x)) / len(xs) if xs else None

    stats = {
        "pass": {"adot": lambda r: mean([x[3] for x in r]), "cmp": lambda r: share(lambda x: x[5] in "ct", r), "aypc": lambda r: mean([x[3] for x in r if x[5] in "ct"]), "deep": lambda r: share(lambda x: x[3] >= 20, r)},
        "target": {"adot": lambda r: mean([x[3] for x in r]), "yac": lambda r: mean([x[6] for x in r if x[5] in "ct"]),
                   "catch": lambda r: share(lambda x: x[5] in "ct", r), "deep": lambda r: share(lambda x: x[3] >= 20, r)},
        "rush": {"ypc": lambda r: mean([x[3] for x in r]), "big": lambda r: share(lambda x: x[3] >= 10, r), "stuff": lambda r: share(lambda x: x[3] <= 0, r)},
        "kick": {"pct": lambda r: share(lambda x: x[5] == "g", r), "long": lambda r: max([x[3] for x in r if x[5] == "g"], default=None),
                 "fg50": lambda r: sum(1 for x in r if x[5] == "g" and x[3] >= 50)},
    }
    last_wk = max((int(w) for v in by.values() for w in v["dates"] if int(w) <= 18), default=0)
    # QB runs are ranked against other QBs (a QB = 20+ throws), everyone else's runs against non-QBs
    def is_qb(v):
        return len(v["pass"]) >= 20

    everyone = lambda v: True  # noqa: E731
    groups = [("pass", stats["pass"], everyone), ("target", stats["target"], everyone),
              ("rush", stats["rush"], is_qb), ("rush", stats["rush"], lambda v: not is_qb(v)), ("kick", stats["kick"], everyone)]
    for mode, fns, member in groups:
        mine = {pid: v for pid, v in by.items() if member(v)}
        most = max((len(v[mode]) for v in mine.values()), default=0)
        need = max(1, round(most * 0.35))
        pool = [pid for pid, v in mine.items() if len(v[mode]) >= need]
        for key, fn in fns.items():
            vals = {pid: fn(by[pid][mode]) for pid in pool}
            vals = {k: x for k, x in vals.items() if x is not None}
            order = sorted(vals, key=lambda k: vals[k], reverse=key != "stuff")
            for i, pid in enumerate(order):
                rank = 1 + sum(1 for k in order[:i] if vals[k] != vals[pid])  # ties share a rank
                by[pid].setdefault("ranks", {}).setdefault(mode, {"_min": need, "_wk": last_wk, "_qb": mode == "rush" and is_qb(by[pid])})[key] = [rank, len(order)]

    if kicks_only:  # past seasons: just the kick charts (a few KB a kicker), in their own folder so pass charts still use ESPN's games
        d = OUT / str(season) / "kicks"
        d.mkdir(parents=True, exist_ok=True)
        kickers = {pid: v for pid, v in by.items() if v["kick"]}
        for pid, v in kickers.items():
            out = {"kick": v["kick"], "xp": v.get("xp"), "dates": v["dates"], "ranks": {"kick": v.get("ranks", {}).get("kick")}}
            (d / f"{pid}.json").write_text(json.dumps({k: x for k, x in out.items() if x}, separators=(",", ":")), encoding="utf-8")
        print(f"kick charts {season}: {len(kickers)} kickers")
        return
    d = OUT / str(season) / "charts"
    d.mkdir(parents=True, exist_ok=True)
    for pid, v in by.items():
        (d / f"{pid}.json").write_text(json.dumps({k: x for k, x in v.items() if x}, separators=(",", ":")), encoding="utf-8")
    print(f"pass charts {season}: {len(by)} players")


def kick_index():
    """docs/data/nfl/kicks_index.json: {espn id: [seasons he has a kick chart for]}, so the page's season picker knows what exists
    (this season's chart files plus the kick-only files for past seasons)."""
    idx = defaultdict(set)
    for season_dir in OUT.iterdir():
        if not season_dir.name.isdigit():
            continue
        for sub in ("charts", "kicks"):
            for f in (season_dir / sub).glob("*.json") if (season_dir / sub).exists() else []:
                if sub == "kicks" or '"kick":' in f.read_text(encoding="utf-8"):
                    idx[f.stem].add(int(season_dir.name))
    (OUT / "kicks_index.json").write_text(json.dumps({k: sorted(v) for k, v in sorted(idx.items())}, separators=(",", ":")), encoding="utf-8")
    print(f"kick index: {len(idx)} kickers")


if __name__ == "__main__":
    # python src/pass_charts.py [season] [--kicks]   (--kicks: kick charts only, for past seasons)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    build(int(args[0]) if args else season_now(), kicks_only="--kicks" in sys.argv)
    kick_index()
