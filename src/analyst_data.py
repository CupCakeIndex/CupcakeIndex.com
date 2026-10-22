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

from site_rank import site_rank  # the ranking exactly as the website shows it

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
    site_rank(w, json.load(open(os.path.join(DATA, "index.json"), encoding="utf-8"))["leagues"][lg])  # power_rank = the site's "#"
    ours = {t["team"]: t["power_rank"] for t in w["teams"]}
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
            row = {"wk": g["week"], "opp": g["opp"], "loc": g.get("loc"), "opp_rank": ours.get(g["opp"], g.get("opp_rank"))}
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


def _load(*path):
    with open(os.path.join(DATA, *path), encoding="utf-8") as f:
        return json.load(f)


def extras():
    """The site's other lists, so the page can cite more than yards and EPA: NFL records held by current players,
    Trade watch, Heisman popularity (the page runs the Heisman model itself) and coaches (score, hot seat, scheme)."""
    import re
    out = {}
    names = {p[1]: p[0] for p in _load("players_nfl.json")}
    rec = _load("nfl", "records.json")
    out["records"] = {names.get(pid, pid): rows for pid, rows in rec["players"].items()}
    tw = _load("nfl", "trade_watch.json")
    abbr = {t["id"]: a for a, t in tw["teams"].items()}
    out["trade_watch"] = {"updated": tw["updated"], "deadline": tw["deadline"], "players": [
        {"name": p["name"], "pos": p["pos"], "team": abbr.get(p["team"].split(":")[-1], p["team"]), "score": p["score"], "tier": p.get("tier"),
         "why": p.get("why", []), "best_fits": [f[:2] for f in p.get("fits", [])[:3]], "trade_headlines_2wk": p.get("talk", 0),
         "latest_headline": (p.get("story") or [None])[0]} for p in tw["players"][:40]]}
    bz = _load("cfb", "heisman_buzz.json")
    out["heisman_buzz"] = {"season": bz["season"], "views": bz["views"]}
    prof = _load("coach_profile.json")["coaches"]
    co = _load("coaches.json")
    out["coaches"] = {}
    for lg in ("nfl", "cfb"):
        for c in co[lg]["coaches"]:
            if not c.get("on"):
                continue
            p = prof.get(re.sub(r"[^a-z0-9]+", "-", c["n"].lower()).strip("-"), {})
            car, sc = c.get("c", {}), p.get("scheme", {})
            out["coaches"][f"{lg}:{c['tm']}"] = {"coach": c["n"], "career": f"{car.get('w', 0)}-{car.get('l', 0)}", "years": car.get("yrs"),
                "coach_score": car.get("score"), "coach_rank": car.get("rk"), "hot_seat": (c.get("hs") or {}).get("lab"), "hot_seat_why": (c.get("hs") or {}).get("why"),
                "background": (p.get("bg") or {}).get("lab"), "tags": [t[0] for t in sc.get("tags", [])],
                "tendencies": [[s[1], s[2], s[3], f"{s[5]} of {s[6]}"] for s in sc.get("stats", [])]}
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    out = {lg: rankings(lg) for lg in ("nfl", "cfb")}
    out["facts"] = {lg: json.load(open(os.path.join(DATA, lg, "facts.json"), encoding="utf-8")).get("teams", {}) for lg in ("nfl", "cfb")}
    # the page reads "viz" as the seasons WITH player stats; the site's index also lists its team-only seasons
    idx = json.load(open(os.path.join(DATA, "viz", "index.json"), encoding="utf-8"))
    first = idx.get("players", {})
    out["viz"] = {lg: [s for s in idx[lg] if s >= first.get(lg, 0)] for lg in ("nfl", "cfb")}
    hist = os.path.join(OUT, "hist")
    # analyst/data/hist is gitignored, so a fresh checkout (the cloud refresh routine) won't have it: the page
    # already has 2006-2021 published, so list those
    out["hist"] = {"nfl": sorted(int(f[4:8]) for f in os.listdir(hist) if f.startswith("nfl_"))} if os.path.isdir(hist) else {"nfl": list(range(2006, first.get("nfl", 2022)))}
    # the site's live Stats tabs (Injuries % healthy, Frauds / Over-achievers), same math as the site (src/site_tabs.py)
    import site_tabs
    out["site"] = {}
    for k, fn in (("injuries", site_tabs.injuries), ("frauds", site_tabs.frauds)):
        try:
            out["site"][k] = fn()
        except Exception as e:
            print(f"  ! site tab {k} unavailable ({e})")
    try:
        out["extra"] = extras()
    except Exception as e:  # a missing file just means the page's "extras" lookup says it has none
        print(f"  ! extras unavailable ({e})")
        out["extra"] = {}
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
