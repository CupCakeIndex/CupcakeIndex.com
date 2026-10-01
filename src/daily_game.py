"""Player pool for the Daily game (guess today's NFL player), from nflverse. No API key needed.

Writes docs/data/daily_nfl.json:
  teams:   {abbr: [conference, division]}
  players: [[name, espn_id, team, pos, birth_date, college, college_conf, jersey, draft_year, draft_round], ...]
           every active QB/RB/WR/TE (what you can guess)
  answers: espn ids of the well-known ones the daily answer is picked from
           (last season's top fantasy scorers at each position, still active)
The browser picks the day's answer from `answers` by date, so everyone gets the same player.

    python src/daily_game.py            # uses cached nflverse files when present
    python src/daily_game.py --refresh  # re-download them
"""
import argparse
import json
from pathlib import Path

from nfl_data import _csv, PLAYERS_URL, TEAMS_URL

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "daily_nfl.json"
STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_{season}.csv"
POSITIONS = ("QB", "RB", "WR", "TE")
TOP = {"QB": 20, "RB": 28, "WR": 36, "TE": 12}  # how many per position count as "well known"
OLD_TEAMS = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA"}
CONF_SHORT = {"Southeastern": "SEC", "Atlantic Coast": "ACC", "Pacific Ten": "Pac-12", "Pacific Twelve": "Pac-12", "Pac-12": "Pac-12",
              "Big Ten": "Big Ten", "Big 12": "Big 12", "Big Twelve": "Big 12", "Mountain West": "MWC", "Mid-American": "MAC",
              "American Athletic": "AAC", "Conference USA": "C-USA", "Sun Belt": "Sun Belt", "Big East": "Big East", "NO FOOTBALL": ""}


def _college(names, confs):
    """Final school + its conference. Transfers list every school, newest first ("Wyoming; Reedley")."""
    name = (names or "").split(";")[0].strip()
    conf = (confs or "").split(";")[0].replace(" Conference", "").strip()
    return name, CONF_SHORT.get(conf, conf)


def build(season, refresh=False, out_path=OUT):
    teams = {}
    for t in _csv(TEAMS_URL, "teams.csv", refresh):
        if t["team_abbr"] not in OLD_TEAMS and t.get("team_division"):
            teams[t["team_abbr"]] = [t["team_conf"], t["team_division"].split(" ", 1)[1]]

    players, by_gsis = [], {}
    for r in _csv(PLAYERS_URL, "players.csv", refresh):
        team = OLD_TEAMS.get(r.get("latest_team"), r.get("latest_team"))
        if r.get("position") not in POSITIONS or r.get("last_season") != str(season) or team not in teams:
            continue
        if not r.get("espn_id") or not r.get("birth_date"):
            continue
        college, conf = _college(r.get("college_name"), r.get("college_conference"))
        jersey = int(r["jersey_number"]) if (r.get("jersey_number") or "").isdigit() else None
        dy = int(r["draft_year"]) if (r.get("draft_year") or "").isdigit() else None
        rnd = int(r["draft_round"]) if (r.get("draft_round") or "").isdigit() else None
        row = [r["display_name"], r["espn_id"], team, r["position"], r["birth_date"], college, conf, jersey, dy, rnd]
        players.append(row)
        by_gsis[r["gsis_id"]] = row

    # well known = last season's top PPR scorers at each position who are still active
    stats = _csv(STATS_URL.format(season=season - 1), f"stats_player_reg_{season - 1}.csv", refresh)
    pts = {}
    for s in stats:
        row = by_gsis.get(s.get("player_id"))
        if row:
            pts[row[1]] = pts.get(row[1], 0) + float(s.get("fantasy_points_ppr") or 0)
    answers = []
    for pos in POSITIONS:
        ids = sorted((p[1] for p in players if p[3] == pos and p[1] in pts), key=lambda i: -pts[i])
        answers += ids[: TOP[pos]]

    players.sort(key=lambda p: p[0])
    out_path.write_text(json.dumps({"season": season, "teams": teams, "players": players, "answers": sorted(answers, key=int)},
                                   separators=(",", ":")), encoding="utf-8")
    print(f"  daily game: {len(players)} guessable players, {len(answers)} possible answers")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    build(a.season, a.refresh)
