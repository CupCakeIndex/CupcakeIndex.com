"""Builds docs/data/dynasty/rosters_YYYY.json: the real players behind each Dynasty Draft unit, for the playoff
gamecast (docs/dynasty_sim.js). One small file per season, loaded only when a playoff game starts.

For every team-season since 1999 (nflverse weekly player stats, regular season), the key names by unit:
  pass:  the QB (most dropbacks) and the top 5 targets (WR/TE/RB; by catches in 2003-08, which have no
         target counts), each with his share of the targets
  run:   the top 2 ball carriers (RB/FB) by carries
  rush:  the top 3 sack leaders
  cover: the top 4 defensive backs by passes defended + interceptions
  rund:  the top 4 front-seven tacklers (DL/LB)
  st:    kicker, punter and the main returner
Offensive linemen never show up in play-by-play text, so they aren't listed.
Each player is [full name, short name ("P.Manning"), position, headshot id, weight]; the weight is how often the
play text should name him (his share of the targets, carries, sacks...). Headshot ids are nflverse's NFL.com
image ids (https://static.www.nfl.com/image/private/f_auto,q_auto/league/<id>), blank when there is none.

Run: python src/dynasty_rosters.py          (only seasons without a file yet)
     python src/dynasty_rosters.py --all    (rebuild every season)
"""
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from viz_data import NFLV, nflverse_csv  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "dynasty")
DYN = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "dynasty.json")
SHOT = "https://static.www.nfl.com/image/private/f_auto,q_auto/league/"
NUM = ["attempts", "sacks_suffered", "carries", "targets", "receptions", "def_sacks", "def_qb_hits", "def_pass_defended", "def_interceptions",
       "def_tackles_solo", "def_tackle_assists", "def_tackles_with_assist", "fg_att", "pat_att", "pt_att", "punt_returns", "kickoff_returns"]


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def season(yr, colors):
    rows = nflverse_csv(f"{NFLV}/stats_player/stats_player_week_{yr}.csv", f"stats_player_week_{yr}.csv")
    tot = defaultdict(lambda: defaultdict(float))  # (team, player id) -> totals
    who = {}
    for r in rows:
        if r.get("season_type") != "REG" or not r.get("team"):
            continue
        k = (r["team"], r["player_id"])
        t = tot[k]
        for c in NUM:
            t[c] += f(r.get(c))
        shot = (r.get("headshot_url") or "").rsplit("/", 1)[-1] if SHOT in (r.get("headshot_url") or "") else ""
        who[k] = (r["player_display_name"], r["player_name"], r["position"] or r["position_group"], r["position_group"], shot)
    by_team = defaultdict(list)
    for (team, pid), t in tot.items():
        by_team[team].append((who[(team, pid)], t))

    def top(lst, score, n, groups=None):
        got = sorted(((p, score(t)) for p, t in lst if (groups is None or p[3] in groups) and score(t) > 0), key=lambda x: -x[1])[:n]
        s = sum(v for _, v in got) or 1
        return [[p[0], p[1], p[2], p[4], round(v / s, 2)] for p, v in got]

    out = {}
    for team, lst in sorted(by_team.items()):
        out[team] = {
            "c": colors.get(team, ""),
            "qb": top(lst, lambda t: t["attempts"] + t["sacks_suffered"], 1, {"QB"}),
            "rec": top(lst, lambda t: t["targets"] or t["receptions"], 5,  # (no targets in 2003-08: catches)
                        {"WR", "TE", "RB"}),
            "rb": top(lst, lambda t: t["carries"], 2, {"RB"}),
            "rush": top(lst, lambda t: t["def_sacks"] * 3 + t["def_qb_hits"], 3, {"DL", "LB", "DB"}),
            "cov": top(lst, lambda t: t["def_pass_defended"] + 2 * t["def_interceptions"], 4, {"DB"}),
            "tak": top(lst, lambda t: t["def_tackles_solo"] + t["def_tackle_assists"] + t["def_tackles_with_assist"], 4, {"DL", "LB"}),
            "k": top(lst, lambda t: t["fg_att"] + t["pat_att"], 1),
            "p": top(lst, lambda t: t["pt_att"], 1),
            "ret": top(lst, lambda t: t["punt_returns"] + t["kickoff_returns"], 1),
        }
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    d = json.load(open(DYN, encoding="utf-8"))
    colors = {r["team_abbr"]: r["team_color"] for r in nflverse_csv("https://github.com/nflverse/nflverse-pbp/raw/master/teams_colors_logos.csv", "teams.csv")}
    for yr in range(d["first"], d["last"] + 1):
        path = os.path.join(OUT, f"rosters_{yr}.json")
        if os.path.exists(path) and "--all" not in sys.argv:
            continue
        out = season(yr, colors)
        need = {t[2] for t in d["teams"] if t[0] == yr}
        missing = sorted(need - set(out))
        thin = sorted(ab for ab in need & set(out) if not (out[ab]["qb"] and out[ab]["rec"] and out[ab]["rb"] and out[ab]["k"]))
        json.dump(out, open(path, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
        print(f"{yr}: {len(out)} teams, {os.path.getsize(path) // 1024} KB" + (f"; MISSING {missing}" if missing else "") + (f"; thin {thin}" if thin else ""))


if __name__ == "__main__":
    main()
