"""Every team's schedule strength, every season we have games for, so the Analyst chat can answer "the weakest
schedule in the last 30 years" (docs/bot.js schedule_history). Writes docs/data/schedule_history.json.

College (1979 on, FBS teams): our game history (cupcake_history.py), with "cupcake" judged exactly like the site
(cupcake_stats.is_cup), and each opponent's end-of-season rating from that history. NFL (1999 on): every regular-season
score in nflverse's games list (complete, unlike the team-stat feed behind Visualize, which misses a few early games). For both, opponents' record leaves out the games against the team itself.

    python src/social/schedule_history.py      # cupcake_stats.yml runs it after cupcake_history.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cupcake_stats as C  # noqa: E402
from viz_data import nflverse_csv  # noqa: E402

ROOT = HERE.parent.parent
OUT = ROOT / "docs" / "data" / "schedule_history.json"
FIRST_NFL = 1999  # nflverse has every game from here; our play-by-play stats start here too


def opp_pct(team, opps, rec):
    """Opponents' combined win share, each opponent counted once per game played, games vs `team` left out."""
    w = l = t = 0
    for o in opps:
        r = rec.get(o, {})
        vs = r.get("vs", {}).get(team, (0, 0, 0))
        w, l, t = w + r.get("w", 0) - vs[0], l + r.get("l", 0) - vs[1], t + r.get("t", 0) - vs[2]
    n = w + l + t
    return round((w + t / 2) / n, 3) if n else None


def season_rows(games, teams, extra=None):
    """games: [(team, opp, us, them)] from each side. -> rows for `teams`."""
    rec = {}
    for team, opp, us, them in games:
        r = rec.setdefault(team, {"w": 0, "l": 0, "t": 0, "vs": {}, "opps": []})
        k = 0 if us > them else 1 if us < them else 2
        r["wlt"[k]] += 1
        v = list(r["vs"].get(opp, (0, 0, 0)))
        v[k] += 1
        r["vs"][opp] = tuple(v)
        r["opps"].append(opp)
    rows = []
    for t in teams:
        r = rec.get(t)
        if not r or not r["opps"]:
            continue
        rows.append({"team": t, "record": f"{r['w']}-{r['l']}" + (f"-{r['t']}" if r["t"] else ""), "games": len(r["opps"]),
                     "opp_win_pct": opp_pct(t, r["opps"], rec), **(extra(t, r) if extra else {})})
    return rows


def cfb():
    out = {}
    for season, d in sorted(C.history().items()):
        fbs, R = set(d["fbs"]), d["ratings"]
        done = [x for x in d["games"] if x["hp"] is not None]
        games = [g for x in done for g in ((x["h"], x["a"], x["hp"], x["ap"]), (x["a"], x["h"], x["ap"], x["hp"]))]

        def extra(t, r, season=season, done=done):
            mine = [x for x in done if t in (x["h"], x["a"])]
            cups = sum(1 for x in mine if C.is_cup(season, t, x["a"] if x["h"] == t else x["h"], x))
            rated = [R[o] for o in r["opps"] if o in R]
            return {"cupcakes": cups, "fcs_games": sum(1 for o in r["opps"] if o not in fbs),
                    "opp_rating": round(sum(rated) / len(rated), 2) if rated else None}
        out[season] = {"partial": not d.get("complete", True) or d.get("partial", False), "teams": season_rows(games, sorted(fbs), extra)}
    return out


def nfl():
    games = [g for g in nflverse_csv("https://github.com/nflverse/nfldata/raw/master/data/games.csv", "games.csv")
             if g["game_type"] == "REG" and g["home_score"] != "" and int(g["season"]) >= FIRST_NFL]
    # the names of the time (St. Louis Rams in 1999), from nflverse's team list
    name = {r["team_abbr"]: r["team_name"] for r in nflverse_csv("https://github.com/nflverse/nflverse-pbp/raw/master/teams_colors_logos.csv", "teams.csv")}
    out = {}
    for season in sorted({int(g["season"]) for g in games}):
        gs = [g for g in games if int(g["season"]) == season]
        sides = [(name.get(t, t), name.get(o, o), int(us), int(them)) for g in gs
                 for t, o, us, them in ((g["home_team"], g["away_team"], g["home_score"], g["away_score"]), (g["away_team"], g["home_team"], g["away_score"], g["home_score"]))]
        pd = {}
        for t, o, us, them in sides:
            pd.setdefault(t, []).append(us - them)

        def extra(t, r, pd=pd):  # opponents' average point margin a game: how good they were, not just their record
            m = [sum(pd[o]) / len(pd[o]) for o in r["opps"] if pd.get(o)]
            return {"opp_margin": round(sum(m) / len(m), 1) if m else None}
        out[season] = {"teams": season_rows(sides, sorted({t for t, *_ in sides}), extra)}
    return out


def main():
    data = {"note": "Opponents' win share leaves out games against the team itself. College: FBS teams, our game history "
                    "(bowls included), cupcakes by the site's rule, opp_rating = opponents' average end-of-season rating in our "
                    "model (points better than an average FBS team). NFL: regular season, opp_margin = opponents' average point "
                    "margin a game.", "cfb": cfb(), "nfl": nfl()}
    OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{OUT.name}: {OUT.stat().st_size // 1024} KB, college {min(data['cfb'])}-{max(data['cfb'])}, NFL {min(data['nfl'])}-{max(data['nfl'])}")


if __name__ == "__main__":
    main()
