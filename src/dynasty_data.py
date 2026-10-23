"""Builds docs/data/dynasty.json for the Dynasty Draft game (docs/dynasty.js).

Every finished NFL regular season since 1999 (from the Visualize season files, docs/data/viz/nfl_YYYY.json)
gets six unit grades: passing offense, run game, pass rush, coverage, run defense and special teams. A grade
is a z-score within that season, so a 2004 offense is measured against 2004 defenses, not today's.
How much each unit is worth comes from a regression of point margin per game on the six grades, across
all those seasons. In the game you build a team out of units from different seasons and it plays real ones.

Run: python src/dynasty_data.py
"""
import json
import os
from collections import defaultdict
from statistics import mean, pstdev

ROOT = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
VIZ = os.path.join(ROOT, "viz")

# Team names at the time (the season files use today's names), same as hilo_data.py.
OLD_NAMES = [("Las Vegas Raiders", 2019, "Oakland Raiders"), ("Los Angeles Rams", 2015, "St. Louis Rams"),
             ("Los Angeles Chargers", 2016, "San Diego Chargers"), ("Washington Commanders", 2019, "Washington"),
             ("Washington Commanders", 2021, "Washington Football Team")]
UNITS = ["pass", "run", "rush", "cover", "rund", "st"]


def team_name(name, yr):
    for now, last, old in OLD_NAMES:
        if name == now and yr <= last:
            return old
    return name


def div(a, b):
    return a / b if b else 0.0


def zs(vals):
    m, s = mean(vals), pstdev(vals) or 1
    return [(v - m) / s for v in vals]


def raw_units(t):
    """Each unit's raw number for one team-season (higher = better)."""
    opp_rushes = max(1.0, t["opp_plays"] - t["opp_att"] - t["def_sacks"])
    returns = div(t["pr_yds"] + t["kr_yds"], t["pr"] + t["kr"])
    return {
        "pass": div(t["pass_epa"], t["att"] + t["sacked"]),  # EPA per dropback (turnovers and sacks included)
        "run": div(t["rush_epa"], t["carries"]),  # EPA per carry
        "rush": div(t["def_sacks"], t["opp_att"] + t["def_sacks"]),  # sack rate
        "cover": -div(t["opp_pass_yds"] - 45 * t["def_int"], t["opp_att"]),  # yards per pass allowed, picks count against it
        "rund": -t["opp_rush_yds"] / opp_rushes,  # yards per run allowed
        "st": None,  # special teams: built from three parts below
        "_fg": div(t["fg_made"], t["fg_att"]), "_punt": div(t["pt_net"], t["pt_att"]), "_ret": returns, "_sttd": t["st_td"],
    }


def solve(X, y):
    """Least squares (normal equations, Gaussian elimination): y ~ X b."""
    n = len(X[0])
    A = [[sum(r[i] * r[j] for r in X) for j in range(n)] + [sum(r[i] * v for r, v in zip(X, y))] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(A[r][c]))
        A[c], A[p] = A[p], A[c]
        for r in range(n):
            if r != c:
                f = A[r][c] / A[c][c]
                A[r] = [a - f * b for a, b in zip(A[r], A[c])]
    return [A[i][n] / A[i][i] for i in range(n)]


def main():
    seasons = json.load(open(os.path.join(VIZ, "index.json"), encoding="utf-8"))["nfl"]
    current = max(seasons)
    rows, X, y, games = [], [], [], []
    for yr in [s for s in seasons if s < current]:
        d = json.load(open(os.path.join(VIZ, f"nfl_{yr}.json"), encoding="utf-8"))
        ti = {c: i + 3 for i, c in enumerate(d["tcols"])}
        tot = defaultdict(lambda: defaultdict(float))
        for r in d["trows"]:
            t = tot[r[0]]
            for c, i in ti.items():
                t[c] += r[i] or 0
            t["g"] += 1
            t["w"] += r[3] > r[4]
            t["l"] += r[3] < r[4]
            games.append(r[3] - r[4])
        ids = sorted(tot)
        raw = [raw_units(tot[k]) for k in ids]
        st = [sum(z) for z in zip(*(zs([r[p] for r in raw]) for p in ("_fg", "_punt", "_ret", "_sttd")))]
        for r, v in zip(raw, st):
            r["st"] = v
        grades = list(zip(*(zs([r[u] for r in raw]) for u in UNITS)))  # z-scores within the season
        for k, g in zip(ids, grades):
            t = tot[k]
            name, abbr = d["teams"][k][0], d["teams"][k][1]
            rows.append({"yr": yr, "name": team_name(name, yr), "abbr": abbr, "w": int(t["w"]), "l": int(t["l"]),
                         "t": int(t["g"] - t["w"] - t["l"]), "z": [round(v, 2) for v in g]})
            X.append(list(g) + [1.0])
            y.append((t["pts"] - t["opp_pts"]) / t["g"])
    b = solve(X, y)
    w = b[:6]
    fit = [sum(wi * xi for wi, xi in zip(w, x[:6])) for x in X]
    r2 = 1 - sum((a - p) ** 2 for a, p in zip(y, fit)) / sum((a - mean(y)) ** 2 for a in y)
    # one game's margin around a team's average: the game-to-game spread the season sim uses
    sd = round(pstdev(games) * 0.9, 1)  # most of a single game's spread is noise around the two teams' levels
    teams = [[r["yr"], r["name"], r["abbr"], f'{r["w"]}-{r["l"]}' + (f'-{r["t"]}' if r["t"] else ""), *r["z"]] for r in rows]
    out = {"units": UNITS, "w": [round(v, 2) for v in w], "sd": sd, "first": min(r["yr"] for r in rows),
           "last": max(r["yr"] for r in rows), "teams": teams}
    json.dump(out, open(os.path.join(ROOT, "dynasty.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print(f"{len(teams)} team-seasons {out['first']}-{out['last']}; weights {dict(zip(UNITS, out['w']))}; R^2 {r2:.2f}; sd {sd}")


if __name__ == "__main__":
    main()
