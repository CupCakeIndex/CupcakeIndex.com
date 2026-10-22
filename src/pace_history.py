"""Week-by-week totals for every NFL player-season since 1999, for the Cupcake Analyst's pace_to lookup
("does he get to 2,000?": how did players on the same pace through the same number of games actually finish).

Writes analyst/data/pace.json. Past seasons don't change, so run it once a year (after the season):
    python src/pace_history.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from viz_data import NFLV, nflverse_csv  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "analyst" / "data" / "pace.json"
# analyst column -> nflverse column, and the season total a player needs to be stored. Anyone hot enough early to be a
# comparison (90% of a big pace through 3+ games) clears these, so the comps aren't only the ones who finished strong.
STATS = {"pass_yds": ("passing_yards", 1500), "pass_td": ("passing_tds", 10), "rush_yds": ("rushing_yards", 400), "rush_td": ("rushing_tds", 5),
         "rec": ("receptions", 30), "rec_yds": ("receiving_yards", 400), "rec_td": ("receiving_tds", 5), "def_sacks": ("def_sacks", 4)}
FIRST = 1999


def num(x):
    try:
        v = float(x or 0)
    except ValueError:
        return 0
    return int(v) if v == int(v) else v


def main():
    last = int(sys.argv[1]) if len(sys.argv) > 1 else 2025
    out = {"seasons": [FIRST, last], "note": "Regular season only; games he played, in order. 1999-2020 were 16-game seasons.", "stats": {k: [] for k in STATS}}
    for season in range(FIRST, last + 1):
        rows = nflverse_csv(f"{NFLV}/stats_player/stats_player_week_{season}.csv", f"stats_player_week_{season}.csv")
        by = {}
        for r in rows:
            if r.get("season_type") != "REG":
                continue
            p = by.setdefault(r["player_id"], {"name": r["player_display_name"] or r["player_name"], "pos": r.get("position") or "", "teams": [], "wk": []})
            if r.get("team") and r["team"] not in p["teams"]:
                p["teams"].append(r["team"])
            p["wk"].append((int(r["week"]), r))
        n = 0
        for p in by.values():
            p["wk"].sort(key=lambda x: x[0])
            for k, (col, need) in STATS.items():
                vals = [num(r.get(col)) for _, r in p["wk"]]
                if sum(vals) >= need:
                    out["stats"][k].append([p["name"], season, "/".join(p["teams"]), p["pos"], " ".join(str(v) for v in vals)])
                    n += 1
        print(season, len(by), "players,", n, "stored")
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(OUT, round(OUT.stat().st_size / 1024), "KB", {k: len(v) for k, v in out["stats"].items()})


if __name__ == "__main__":
    main()
