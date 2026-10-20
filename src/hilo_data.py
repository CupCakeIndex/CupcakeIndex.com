"""Builds docs/data/hilo.json for the Higher or Lower game (docs/hilo.js).

Reads the Visualize season files (docs/data/viz/nfl_YYYY.json): regular-season player totals for
2022 onward and team totals back to 1999. Only finished seasons are used, so the numbers never change.
Each stat has a pool of real starters (e.g. QBs with 250+ attempts), so every pair is two names fans know.

Run: python src/hilo_data.py
"""
import json
import os
from collections import defaultdict

ROOT = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
VIZ = os.path.join(ROOT, "viz")

# (key, label, eligibility stat, minimum, stat to compare)
PLAYER_STATS = [
    ("pass_yds", "Passing yards", "att", 250, "pass_yds"),
    ("pass_td", "Passing TDs", "att", 250, "pass_td"),
    ("int", "Interceptions thrown", "att", 250, "int"),
    ("qb_rush", "Rushing yards (QBs)", "att", 250, "rush_yds"),
    ("rush_yds", "Rushing yards", "carries", 120, "rush_yds"),
    ("rush_td", "Rushing TDs", "carries", 120, "rush_td"),
    ("rec", "Catches", "targets", 60, "rec"),
    ("rec_yds", "Receiving yards", "targets", 60, "rec_yds"),
    ("rec_td", "Receiving TDs", "targets", 60, "rec_td"),
    ("def_sacks", "Sacks", "def_sacks", 5, "def_sacks"),
    ("tackles", "Tackles", "tackles", 80, "tackles"),
    ("def_int", "Interceptions", "def_int", 3, "def_int"),
    ("fg_made", "Field goals made", "fg_att", 20, "fg_made"),
]
TEAM_STATS = [
    ("t_pts", "Points scored", "pts"),
    ("t_opp", "Points allowed", "opp_pts"),
    ("t_wins", "Wins", None),
    ("t_sacks", "Sacks (defense)", "def_sacks"),
    ("t_rush", "Rushing yards (team)", "rush_yds"),
    ("t_pass", "Passing yards (team)", "pass_yds"),
]


# Team names at the time (the season files use today's names).
OLD_NAMES = [("Las Vegas Raiders", 2019, "Oakland Raiders"), ("Los Angeles Rams", 2015, "St. Louis Rams"),
             ("Los Angeles Chargers", 2016, "San Diego Chargers"), ("Washington Commanders", 2019, "Washington"),
             ("Washington Commanders", 2021, "Washington Football Team")]
HALF = {"def_sacks"}  # half sacks: keep one decimal


def team_name(name, yr):
    for now, last, old in OLD_NAMES:
        if name == now and yr <= last:
            return old
    return name


def main():
    seasons = json.load(open(os.path.join(VIZ, "index.json"), encoding="utf-8"))["nfl"]
    current = max(seasons)
    cards, stats = [], {k: [] for k, *_ in PLAYER_STATS + TEAM_STATS}
    for yr in [s for s in seasons if s < current]:
        d = json.load(open(os.path.join(VIZ, f"nfl_{yr}.json"), encoding="utf-8"))
        teams = d["teams"]
        # teams: add up every game
        ti = {c: i + 3 for i, c in enumerate(d["tcols"])}
        tot = defaultdict(lambda: defaultdict(float))
        for r in d["trows"]:
            t = tot[r[0]]
            for c, i in ti.items():
                t[c] += r[i] or 0
            t["wins"] += r[3] > r[4]
            t["ties"] += r[3] == r[4]
        for tid, t in tot.items():
            name, abbr = teams[tid][0], teams[tid][1]
            cards.append([team_name(name, yr), "", yr, abbr, "TEAM"])
            ci = len(cards) - 1
            for k, _, col in TEAM_STATS:
                stats[k].append([ci, t["wins"] if col is None else round(t[col], 1 if col in HALF else None)])
        # players: regular season totals (2022 on; older files have teams only)
        if not d.get("prows"):
            continue
        pi = {c: i + 3 for i, c in enumerate(d["pcols"])}
        ptot, pteam = defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(int))
        for r in d["prows"]:
            p = ptot[r[0]]
            for c, i in pi.items():
                if c != "left":
                    p[c] += r[i] or 0
            pteam[r[0]][r[2]] += 1
        for pid, p in ptot.items():
            meta = d["pmeta"].get(pid)
            if not meta:
                continue
            ci = None
            for k, _, elig, mn, col in PLAYER_STATS:
                if p[elig] < mn:
                    continue
                if ci is None:
                    tid = max(pteam[pid], key=pteam[pid].get)  # team he played the most games for
                    cards.append([meta[0], pid, yr, teams.get(tid, ["", ""])[1], meta[1]])
                    ci = len(cards) - 1
                stats[k].append([ci, round(p[col], 1 if col in HALF else None)])
    labels = {k: lab for k, lab, *_ in PLAYER_STATS + TEAM_STATS}
    out = {"cards": cards, "stats": [{"k": k, "label": labels[k], "items": v} for k, v in stats.items()]}
    json.dump(out, open(os.path.join(ROOT, "hilo.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print(f"{len(cards)} cards; " + ", ".join(f"{k} {len(v)}" for k, v in stats.items()))


if __name__ == "__main__":
    main()
