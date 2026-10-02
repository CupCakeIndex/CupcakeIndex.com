"""Team list for the site's favorite-team picker and Team theme: docs/data/teams.json.

Every FBS and NFL team with its name, ESPN id (team pages), conference/division, mascot, logo and two colors.
College comes from CollegeFootballData's FBS list (data/raw/<season>/teams_fbs.json, cached by the weekly run);
NFL from nflverse's team list (data/raw/nfl/teams.csv). Runs in the weekly job; cheap and offline.

    python src/team_meta.py
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "docs" / "data" / "teams.json"
# ESPN team ids for NFL abbreviations (team pages are keyed by ESPN id)
NFL_ESPN = {"ARI": 22, "ATL": 1, "BAL": 33, "BUF": 2, "CAR": 29, "CHI": 3, "CIN": 4, "CLE": 5, "DAL": 6, "DEN": 7, "DET": 8, "GB": 9,
            "HOU": 34, "IND": 11, "JAX": 30, "KC": 12, "LV": 13, "LAC": 24, "LA": 14, "MIA": 15, "MIN": 16, "NE": 17, "NO": 18,
            "NYG": 19, "NYJ": 20, "PHI": 21, "PIT": 23, "SF": 25, "SEA": 26, "TB": 27, "TEN": 10, "WAS": 28}


ESPN_LOGO = {"LA": "lar", "WAS": "wsh"}  # ESPN's logo file names that differ from nflverse abbreviations


def hexc(c):
    c = (c or "").strip()
    if c and not c.startswith("#"):
        c = "#" + c
    return c.lower() if len(c) == 7 else None


def main():
    seasons = sorted((p for p in RAW.glob("*/teams_fbs.json")), key=lambda p: p.parent.name)
    cfb = []
    if seasons:
        for t in json.loads(seasons[-1].read_text(encoding="utf-8")):
            cfb.append({"name": t["school"], "id": t["id"], "mascot": t.get("mascot") or "", "group": t.get("conference") or "",
                        "color": hexc(t.get("color")), "alt": hexc(t.get("alternateColor") or t.get("alternate_color")),
                        "logo": f"https://cdn.collegefootballdata.com/logos/500/{t['id']}.png"})
    nfl = []
    with open(RAW / "nfl" / "teams.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            a = r["team_abbr"]
            if a not in NFL_ESPN:  # old cities (OAK, SD, STL) and duplicates
                continue
            nfl.append({"name": r["team_name"], "id": NFL_ESPN[a], "abbr": a, "mascot": r.get("team_nick") or "", "group": r.get("team_division") or "",
                        "color": hexc(r.get("team_color")), "alt": hexc(r.get("team_color2")),
                        "logo": f"https://a.espncdn.com/i/teamlogos/nfl/500/{ESPN_LOGO.get(a, a.lower())}.png"})
    out = {"cfb": sorted(cfb, key=lambda t: t["name"]), "nfl": sorted(nfl, key=lambda t: t["name"])}
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(cfb)} FBS + {len(nfl)} NFL teams -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
