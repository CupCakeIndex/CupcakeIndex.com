"""Coach rankings (the Coaches page, plus the "Head coach" stats in Stats > Visualize): docs/data/coaches.json.

NFL: every game since 1999 from nflverse (games.csv lists both head coaches). College: our saved game history
(data/history/cfb/, from cupcake_history.py) plus CollegeFootballData's list of who coached where each year
(one call, saved in data/history/cfb_coaches.json, so it works without a key after the first run).

For each coach, career and last 3 seasons: record, postseason record, titles, record against teams that finished
with a winning record, wins over expected, one-score games, how many of his wins came against cupcakes (losing
teams, and FCS teams in college), and how much better his teams were than the year before he got there.

Each coach has three sets: with his current team (the page's default), all time, and the last 3 seasons.

Coach score (0-100, 50 = average coach with enough games):
  35% wins over expected   NFL: the books' lines going into each game. College: our ratings from the year before
                           (did he beat where the program was?).
  30% win % vs winning teams (shrunk toward average for coaches with few of those games)
  15% postseason wins per season
  10% team lift            his teams' win % minus the team's the year before he arrived
  10% cupcake padding      share of his wins that came against cupcakes (counts against him)

    python src/coaches.py
"""
import csv
import json
import math
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "docs" / "data" / "coaches.json"
HIST = ROOT / "data" / "history"
MOVED = {"OAK": "LV", "SD": "LAC", "STL": "LA"}
NAME_FIX = {"Klint Kubliak": "Klint Kubiak"}  # nflverse typos
WEIGHTS = {"woe": 0.35, "good": 0.30, "post": 0.15, "lift": 0.10, "cup": -0.10}
MIN_GAMES = {"nfl": {"c": 34, "r": 17, "t": 17}, "cfb": {"c": 24, "r": 12, "t": 12}}  # c = all time, r = last 3 seasons, t = current team  # fewer games: listed, but no score


def season_now():
    t = date.today()
    return t.year if t.month >= 8 else t.year - 1


def phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


# ------------------------------------------------------------------ games: one row per coach per game
# (season, coach, team, opp, us, them, postseason, title game, expected win chance or None)

def nfl_games():
    import nfl_model
    rows = []
    with open(ROOT / "data" / "raw" / "nfl" / "games.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not r["home_score"] or not r["home_coach"]:
                continue
            hs, as_ = float(r["home_score"]), float(r["away_score"])
            line = nfl_model._num(r.get("spread_line"))
            p = phi(line / 13.0) if line is not None else None  # books: + = home favored
            post, title = r["game_type"] != "REG", r["game_type"] == "SB"
            h, a = MOVED.get(r["home_team"], r["home_team"]), MOVED.get(r["away_team"], r["away_team"])
            rows.append((int(r["season"]), r["home_coach"], h, a, hs, as_, post, title, p))
            rows.append((int(r["season"]), r["away_coach"], a, h, as_, hs, post, title, None if p is None else 1 - p))
    return rows


def nfl_current():
    """{team: coach} for this season: the coach listed for each team's latest game (played or next)."""
    cur, out = str(season_now()), {}
    with open(ROOT / "data" / "raw" / "nfl" / "games.csv", encoding="utf-8") as f:
        games = [r for r in csv.DictReader(f) if r["season"] == cur]
    played = [r for r in games if r["home_score"]]
    for r in played or games:  # in order, so the latest game wins
        out[MOVED.get(r["home_team"], r["home_team"])] = r["home_coach"]
        out[MOVED.get(r["away_team"], r["away_team"])] = r["away_coach"]
    return out


def cfb_staff(refresh):
    """{school: {year: [[coach, games], ...]}} in the order they coached (earliest hire first). From CFBD's /coaches,
    saved in data/history/cfb_coaches.json; refreshed at most once a day when a key is set."""
    f = HIST / "cfb_coaches.json"
    old = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
    fresh = old and datetime.now().timestamp() - f.stat().st_mtime < 20 * 3600
    if old and (fresh or not refresh or not os.environ.get("CFBD_API_KEY")):
        return old
    import fetch_data
    raw = fetch_data._get("/coaches", minYear=2005, maxYear=season_now())
    g = lambda o, *ks: next((o[k] for k in ks if o.get(k) is not None), None)
    out = defaultdict(lambda: defaultdict(list))
    for c in sorted(raw, key=lambda c: g(c, "hireDate", "hire_date") or ""):
        name = f"{g(c, 'firstName', 'first_name') or ''} {g(c, 'lastName', 'last_name') or ''}".strip()
        for s in g(c, "seasons") or []:
            if g(s, "school") and g(s, "year"):
                out[g(s, "school")][str(g(s, "year"))].append([name, int(g(s, "games") or 0)])
    f.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  coaches: {sum(len(v) for v in out.values())} school-seasons from CFBD")
    return out


def cfb_games(staff):
    seasons = {}
    for f in sorted((HIST / "cfb").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        seasons[d["season"]] = d
    rows, cur = [], {}
    for y in sorted(seasons):
        d, prev = seasons[y], seasons.get(y - 1)
        if not prev:
            continue  # the first saved season is only the "year before" for the next one
        R0 = prev["ratings"]
        games = sorted((x for x in d["games"] if x["hp"] is not None), key=lambda x: x["d"])
        last_post = max((x["d"] for x in games if x["p"]), default=None)
        title_done = d.get("complete") and last_post
        mine = defaultdict(list)
        for x in games:
            mine[x["h"]].append(x)
            mine[x["a"]].append(x)
        for team, gs in mine.items():
            staff_y = staff.get(team, {}).get(str(y))
            if not staff_y:
                continue  # FCS teams: no coach list
            # two coaches in one season (a firing): the first one coached his number of games, the next one the rest
            order = []
            for name, n in staff_y:
                order += [name] * n
            for i, x in enumerate(gs):
                coach = order[i] if i < len(order) else staff_y[-1][0]
                home = x["h"] == team
                opp = x["a"] if home else x["h"]
                us, them = (x["hp"], x["ap"]) if home else (x["ap"], x["hp"])
                hfa = 0 if x["n"] else (2.5 if home else -2.5)
                diff = 0.6 * (R0.get(team, -20) - R0.get(opp, -20)) + hfa  # last year's strength (FCS ~ -20), regressed
                title = bool(title_done and x["p"] and x["d"] == last_post)
                rows.append((y, coach, team, opp, us, them, x["p"], title, phi(diff / 16.0)))
            if y == max(seasons):
                cur[team] = staff_y[-1][0]
    fbs = set(seasons[max(seasons)]["fbs"])
    return rows, {t: c for t, c in cur.items() if t in fbs}, {y: set(d["fbs"]) for y, d in seasons.items()}


# ------------------------------------------------------------------ stats

def team_records(rows):
    """{(season, team): [wins, games]} from each team's own games (regular season)."""
    rec = defaultdict(lambda: [0.0, 0])
    seen = set()
    for y, _, t, o, us, them, post, *_ in rows:
        if post or (y, t, o, us, them) in seen:
            continue
        seen.add((y, t, o, us, them))
        rec[(y, t)][0] += 1 if us > them else 0.5 if us == them else 0
        rec[(y, t)][1] += 1
    return rec


def stats(games, rec, fbs, coach_of):
    """One coach's numbers over `games` (his rows). coach_of: {(season, team): set of coaches} (for team lift)."""
    w = sum(us > them for _, _, _, _, us, them, *_ in games)
    t = sum(us == them for _, _, _, _, us, them, *_ in games)
    g = len(games)
    good = lambda y, o: (lambda r: r[1] and r[0] / r[1] > 0.5)(rec.get((y, o), [0, 0]))
    cup = lambda y, o: (fbs is not None and o not in fbs.get(y, ())) or (lambda r: r[1] and r[0] / r[1] < 0.5)(rec.get((y, o), [0, 0]))
    vs = [x for x in games if good(x[0], x[3])]
    gw = sum(x[4] > x[5] for x in vs)
    cw = sum(x[4] > x[5] and cup(x[0], x[3]) for x in games)
    one = [x for x in games if abs(x[4] - x[5]) <= 8 and x[4] != x[5]]
    exp = [x for x in games if x[8] is not None]
    woe = sum((x[4] > x[5]) + 0.5 * (x[4] == x[5]) - x[8] for x in exp)
    post = [x for x in games if x[6]]
    yrs = sorted({x[0] for x in games})
    # team lift: his win % with each team minus that team's the season before he took over (a different coach)
    lift_n = lift_s = 0
    for team in {x[2] for x in games}:
        mine = [x for x in games if x[2] == team and not x[6]]
        y0 = min(x[0] for x in mine) if mine else None
        before = rec.get((y0 - 1, team)) if y0 else None
        if not mine or not before or not before[1] or games[0][1] in coach_of.get((y0 - 1, team), ()):
            continue
        pct = sum((x[4] > x[5]) + 0.5 * (x[4] == x[5]) for x in mine) / len(mine)
        lift_s += (pct - before[0] / before[1]) * len(mine)
        lift_n += len(mine)
    return {"g": g, "w": w, "l": g - w - t, "t": t, "pct": round((w + 0.5 * t) / g, 3) if g else None,
            "pw": sum(x[4] > x[5] for x in post), "pl": sum(x[4] < x[5] for x in post),
            "ti": sum(x[7] and x[4] > x[5] for x in games), "gw": gw, "gl": sum(x[4] < x[5] for x in vs),
            "cw": cw, "cup": round(100 * cw / w) if w else None, "ow": sum(x[4] > x[5] for x in one), "ol": sum(x[4] < x[5] for x in one),
            "woe": round(woe, 1), "woe_s": round(woe / len({x[0] for x in exp}), 2) if exp else None,
            "lift": round(100 * lift_s / lift_n, 1) if lift_n else None, "yrs": len(yrs), "y1": yrs[0], "y2": yrs[-1]}


def score(coaches, scope, min_g):
    """Coach score 0-100 among coaches with at least min_g games in this scope (career or recent)."""
    pool = [c[scope] for c in coaches if c.get(scope) and c[scope]["g"] >= min_g]
    if len(pool) < 5:
        return
    lg_good = sum(s["gw"] for s in pool) / max(1, sum(s["gw"] + s["gl"] for s in pool))
    part = {
        "woe": lambda s: (s["woe_s"] or 0) / max(1, s["g"] / s["yrs"]),  # per game, so long and short seasons compare
        "good": lambda s: (s["gw"] + 10 * lg_good) / (s["gw"] + s["gl"] + 10),
        "post": lambda s: s["pw"] / s["yrs"],
        "lift": lambda s: s["lift"] or 0.0,
        "cup": lambda s: s["cup"] or 0.0,
    }
    z = {}
    for k, f in part.items():
        v = [f(s) for s in pool]
        m = sum(v) / len(v)
        sd = math.sqrt(sum((x - m) ** 2 for x in v) / len(v)) or 1
        z[k] = (m, sd)
    for s in pool:
        tot = sum(WEIGHTS[k] * (f(s) - z[k][0]) / z[k][1] for k, f in part.items())
        s["score"] = max(1, min(99, round(50 + 15 * tot / 0.6)))  # 0.6 ~ the spread of the weighted sum
    for i, s in enumerate(sorted(pool, key=lambda s: -s["score"])):
        s["rk"] = i + 1


def build(lg, rows, current, fbs=None, edge=None):
    by_coach = defaultdict(list)
    coach_of = defaultdict(set)
    for x in rows:
        by_coach[x[1]].append(x)
        coach_of[(x[0], x[2])].add(x[1])
    rec = team_records(rows)
    now = max(x[0] for x in rows)
    active = {c: t for t, c in current.items()}
    out = []
    for name, games in by_coach.items():
        games.sort(key=lambda x: x[0])
        stints = []
        for x in games:
            if stints and stints[-1][0] == x[2] and x[0] - stints[-1][2] <= 1:
                stints[-1][2] = x[0]
            else:
                stints.append([x[2], x[0], x[0]])
        recent = [x for x in games if x[0] > now - 3]
        tm = active.get(name) or stints[-1][0]
        here = [x for x in games if x[2] == tm]  # just his current (or last) team
        c = {"n": NAME_FIX.get(name, name), "tm": tm, "on": name in active, "st": stints,
             "c": stats(games, rec, fbs, coach_of), "r": stats(recent, rec, fbs, coach_of) if recent else None,
             "t": stats(here, rec, fbs, coach_of) if here else None}
        if edge and name in active:
            c["edge"] = round(edge(name), 2)
        out.append(c)
    for sc in ("c", "r", "t"):
        score(out, sc, MIN_GAMES[lg][sc])
    out.sort(key=lambda c: (not c["on"], -(c["c"].get("score") or 0), -c["c"]["g"]))
    print(f"  {lg}: {len(out)} coaches, {sum(c['on'] for c in out)} current, {sum('score' in c['c'] for c in out)} with a career score")
    return {"from": min(x[0] for x in rows), "to": now, "coaches": out}


def main():
    import nfl_model
    from viz_data import nflverse_csv
    nflverse_csv("https://github.com/nflverse/nfldata/raw/master/data/games.csv", "games.csv")  # fresh coaches and scores
    d = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
    rec = nfl_model.coach_record()
    d["nfl"] = build("nfl", nfl_games(), nfl_current(),
                     edge=lambda c: nfl_model.PARAMS["coach"] * nfl_model.coach_value(rec, c, season_now()))  # what the model adds right now
    try:
        rows, cur, fbs = cfb_games(cfb_staff(refresh=True))
        if rows:
            d["cfb"] = build("cfb", rows, cur, fbs)
    except SystemExit as e:  # no CFBD key and no saved coach list yet
        print(f"  cfb skipped: {str(e).splitlines()[0]}")
    if "cfb" not in d and OUT.exists():  # keep the last college list rather than dropping it
        old = json.loads(OUT.read_text(encoding="utf-8"))
        if old.get("cfb"):
            d["cfb"] = old["cfb"]
    OUT.write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  {OUT.name}: {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
