"""Data for Cupcake Analyst, Terry's private fact-check page on claude.ai (analyst/index.html).

A claude.ai page can't fetch anything from the internet, so its data is published WITH it:
the Visualize stat files (docs/data/viz/*.json, used as they are) plus this script's analyst/data/rankings.json,
a compact copy of our latest rankings for both leagues (records, model scores, results, upcoming games with
win chance). Spreads, book lines and "edge" numbers are left out on purpose (Terry's no-betting rule).

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


def main():
    os.makedirs(OUT, exist_ok=True)
    out = {lg: rankings(lg) for lg in ("nfl", "cfb")}
    out["facts"] = {lg: json.load(open(os.path.join(DATA, lg, "facts.json"), encoding="utf-8")).get("teams", {}) for lg in ("nfl", "cfb")}
    out["viz"] = json.load(open(os.path.join(DATA, "viz", "index.json"), encoding="utf-8"))
    path = os.path.join(OUT, "rankings.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{path}: {os.path.getsize(path) // 1024} KB (NFL week {out['nfl']['week']}, college week {out['cfb']['week']})")


if __name__ == "__main__":
    main()
