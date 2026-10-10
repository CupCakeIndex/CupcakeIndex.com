"""Data for Cupcake Analyst, Terry's private fact-check page on claude.ai (analyst/index.html).

A claude.ai page can't fetch anything from the internet, so its data is published WITH it:
the Visualize stat files (docs/data/viz/*.json, used as they are) plus this script's analyst/data/rankings.json,
a compact copy of our latest rankings for both leagues (records, model scores, results, upcoming games with
win chance), plus NFL injury reports and depth charts (nflverse) and the list of team-only history seasons
(analyst/data/hist/, built by `python src/viz_data.py --history`). Spreads, book lines and "edge" numbers are left
out on purpose (Terry's no-betting rule).

    python src/analyst_data.py      # then republish the page (ask Claude: "refresh the analyst")
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
OUT = os.path.join(ROOT, "analyst", "data")


def latest(lg):
    idx = json.load(open(os.path.join(DATA, "index.json"), encoding="utf-8"))["leagues"][lg]["seasons"]
    season = max(idx, key=int)
    return int(season), idx[season]["weeks"][-1]


def rankings(lg):
    season, week = latest(lg)
    w = json.load(open(os.path.join(DATA, lg, str(season), f"week_{week}.json"), encoding="utf-8"))
    chance = {}
    for p in w.get("predictions", []):  # win chance only: no spreads, no book lines
        hp = p.get("home_win_prob")
        if hp is not None:
            chance[(p["home"], p["week"])] = round(100 * hp)
            chance[(p["away"], p["week"])] = round(100 - 100 * hp)
    teams = []
    for t in w["teams"]:
        games = []
        for g in t.get("schedule", []):
            row = {"wk": g["week"], "opp": g["opp"], "loc": g.get("loc"), "opp_rank": g.get("opp_rank")}
            if g.get("result"):
                row.update(res=g["result"], score=g.get("score"), cupcake=bool(g.get("cupcake")) or None, fcs=bool(g.get("fcs")) or None)
            elif (t["team"], g["week"]) in chance:
                row["win_chance"] = chance[(t["team"], g["week"])]
            games.append({k: v for k, v in row.items() if v is not None})
        teams.append({"team": t["team"], "conf": t.get("conference"), "rank": t.get("power_rank"), "ap": t.get("ap_rank"),
                      "record": t.get("record"), "one_score": t.get("one_score"), "rating": t.get("rating"),
                      "scores": t.get("scores"), "qb": t.get("usual_qb"), "fcs_games": t.get("fcs_games"), "games": games})
    return {"league": lg, "season": season, "week": week, "generated": w.get("generated"), "teams": teams}


def nfl_status():
    """{team name: {injuries: [...], depth: {position: [starter, backup]}, as_of}}: this week's injury report and the
    latest depth chart for every NFL team (nflverse; the depth charts are ESPN's, snapshotted daily)."""
    from viz_data import NFLV, nflverse_csv, season_now
    season = season_now()
    names = {r["team_abbr"]: r["team_name"] for r in nflverse_csv("https://github.com/nflverse/nflverse-pbp/raw/master/teams_colors_logos.csv", "teams.csv")}
    out = {}
    inj = [r for r in nflverse_csv(f"{NFLV}/injuries/injuries_{season}.csv", f"injuries_{season}.csv") if r["season_type"] == "REG"]
    wk = max((int(r["week"]) for r in inj), default=0)
    for r in inj:
        if int(r["week"]) == wk:
            t = out.setdefault(names.get(r["team"], r["team"]), {"injuries": [], "depth": {}})
            t["injuries"].append({k: v for k, v in {"name": r["full_name"], "pos": r["position"], "injury": r["report_primary_injury"] or r["practice_primary_injury"],
                                                     "game_status": r["report_status"], "practice": r["practice_status"]}.items() if v})
    dc = nflverse_csv(f"{NFLV}/depth_charts/depth_charts_{season}.csv", f"depth_charts_{season}.csv")
    last = {}
    for r in dc:
        last[r["team"]] = max(last.get(r["team"], ""), r["dt"])
    for r in dc:
        if r["dt"] == last[r["team"]] and r["pos_rank"] in ("1", "2"):
            t = out.setdefault(names.get(r["team"], r["team"]), {"injuries": [], "depth": {}})
            t["as_of"] = r["dt"][:10]
            slot = t["depth"].setdefault(r["pos_abb"], ["", ""])
            slot[int(r["pos_rank"]) - 1] = r["player_name"]
    return {"injury_week": wk, "teams": out}


def main():
    os.makedirs(OUT, exist_ok=True)
    out = {lg: rankings(lg) for lg in ("nfl", "cfb")}
    out["facts"] = {lg: json.load(open(os.path.join(DATA, lg, "facts.json"), encoding="utf-8")).get("teams", {}) for lg in ("nfl", "cfb")}
    out["viz"] = json.load(open(os.path.join(DATA, "viz", "index.json"), encoding="utf-8"))
    hist = os.path.join(OUT, "hist")
    out["hist"] = {"nfl": sorted(int(f[4:8]) for f in os.listdir(hist) if f.startswith("nfl_"))} if os.path.isdir(hist) else {"nfl": []}
    # the site's live Stats tabs (Injuries % healthy, Frauds / Over-achievers), same math as the site (src/site_tabs.py)
    import site_tabs
    out["site"] = {}
    for k, fn in (("injuries", site_tabs.injuries), ("frauds", site_tabs.frauds)):
        try:
            out["site"][k] = fn()
        except Exception as e:
            print(f"  ! site tab {k} unavailable ({e})")
    try:
        out["status"] = {"nfl": nfl_status()}
    except Exception as e:  # nflverse down: the page just says it has no injury/depth data
        print(f"  ! injuries/depth charts unavailable ({e})")
        out["status"] = {"nfl": {"injury_week": 0, "teams": {}}}
    path = os.path.join(OUT, "rankings.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{path}: {os.path.getsize(path) // 1024} KB (NFL week {out['nfl']['week']}, college week {out['cfb']['week']})")


if __name__ == "__main__":
    main()
