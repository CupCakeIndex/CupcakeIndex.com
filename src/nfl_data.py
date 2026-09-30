"""NFL data from nflverse (free, no key) + DraftKings lines from ESPN's public API.

Converted into the same shapes as the CollegeFootballData tables so model.py works unchanged:
teams, games, advanced (per-game EPA/play), lines.
"""
import csv
import io
import json

import requests

from fetch_data import RAW

GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv"
TEAMS_URL = "https://github.com/nflverse/nflverse-pbp/raw/master/teams_colors_logos.csv"
STATS_URL = "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{season}.csv"
ESPN_ODDS = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}/competitions/{id}/odds"


def _csv(url, name, refresh):
    f = RAW / "nfl" / name
    if f.exists() and not refresh:
        text = f.read_text(encoding="utf-8")
    else:
        r = requests.get(url, timeout=120)
        r.raise_for_status()
        text = r.text
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
        print(f"  fetched {url.rsplit('/', 1)[-1]}")
    return list(csv.DictReader(io.StringIO(text)))


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_season(season, refresh=False, with_extras=True):
    all_games = _csv(GAMES_URL, "games.csv", refresh)
    teams_raw = _csv(TEAMS_URL, "teams.csv", refresh)
    rows = [g for g in all_games if int(g["season"]) == season and g["game_type"] == "REG"]
    abbrs = {g["home_team"] for g in rows} | {g["away_team"] for g in rows}
    info = {t["team_abbr"]: t for t in teams_raw if t["team_abbr"] in abbrs}
    name = {a: info[a]["team_name"] if a in info else a for a in abbrs}

    teams = [{"school": name[a], "abbr": a, "conference": info.get(a, {}).get("team_division"),
              "color": info.get(a, {}).get("team_color"),
              "logos": [info[a]["team_logo_espn"]] if a in info else []} for a in sorted(abbrs)]
    games, lines = [], []
    for g in rows:
        hp, ap = _num(g["home_score"]), _num(g["away_score"])
        gid = g["game_id"]
        games.append({
            "id": gid, "week": int(g["week"]), "homeTeam": name[g["home_team"]], "awayTeam": name[g["away_team"]],
            "homePoints": int(hp) if hp is not None else None, "awayPoints": int(ap) if ap is not None else None,
            "completed": hp is not None, "neutralSite": g["location"] == "Neutral",
            "startDate": f"{g['gameday']}T{g['gametime'] or '00:00'}",
            "homeQB": g["home_qb_name"] or None, "awayQB": g["away_qb_name"] or None,
            "homeRest": _num(g["home_rest"]), "awayRest": _num(g["away_rest"]), "espn": g["espn"],
        })
        spread = _num(g["spread_line"])  # nflverse: positive = home favored
        if spread is not None:
            lines.append({"id": gid, "lines": [{
                "provider": "Consensus", "spread": -spread, "overUnder": _num(g["total_line"]),
                "homeMoneyline": _num(g["home_moneyline"]), "awayMoneyline": _num(g["away_moneyline"])}]})
    d = {"teams": teams, "games": games}
    if not with_extras:
        return d
    d["advanced"] = _advanced(season, name, refresh)
    d["lines"] = lines
    d["polls"], d["talent"], d["returning"] = [], [], []
    return d


def _advanced(season, name, refresh):
    """Per-game offensive EPA/play for each team; defense = the opponent's offense in that game."""
    try:
        stats = _csv(STATS_URL.format(season=season), f"stats_team_week_{season}.csv", refresh)
    except requests.HTTPError:
        print(f"  warning: no NFL team stats for {season} yet")
        return []
    off = {}
    for s in stats:
        if s.get("season_type") != "REG":
            continue
        plays = sum(_num(s.get(k)) or 0 for k in ("attempts", "carries", "sacks_suffered"))
        epa = sum(_num(s.get(k)) or 0 for k in ("passing_epa", "rushing_epa"))
        if plays:
            off[(s["game_id"], s["team"])] = (int(s["week"]), s["opponent_team"], epa / plays)
    out = []
    for (gid, team), (week, opp, epa) in off.items():
        if (gid, opp) not in off:
            continue
        o_epa = off[(gid, opp)][2]
        out.append({"gameId": gid, "week": week, "team": name.get(team, team), "opponent": name.get(opp, opp),
                    "offense": {"ppa": epa, "successRate": 0}, "defense": {"ppa": o_epa, "successRate": 0}})
    return out


def add_book_lines(d, week):
    """Add DraftKings (via ESPN) to the consensus line for one week's games. No key needed."""
    by_id = {x["id"]: x for x in d["lines"]}
    n = 0
    for g in d["games"]:
        if g["week"] != week or not g["espn"] or g["completed"]:
            continue
        try:
            r = requests.get(ESPN_ODDS.format(id=g["espn"]), timeout=20)
            r.raise_for_status()
            items = r.json().get("items", [])
        except (requests.RequestException, json.JSONDecodeError):
            continue
        for it in items:
            spread = it.get("spread")
            prov = (it.get("provider") or {}).get("name")
            if spread is None or not prov:
                continue
            entry = by_id.setdefault(g["id"], {"id": g["id"], "lines": []})
            if prov not in {l["provider"] for l in entry["lines"]}:
                entry["lines"].append({"provider": prov, "spread": float(spread), "overUnder": it.get("overUnder")})
                n += 1
        if g["id"] in by_id and by_id[g["id"]] not in d["lines"]:
            d["lines"].append(by_id[g["id"]])
    print(f"  added {n} sportsbook lines for NFL week {week}")


PLAYERS_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"


def build_player_index(out_path):
    """Every NFL player (past and present) with an ESPN id, for the player-compare search.

    ESPN's own search only knows active players; this lets people find Brady, Barry Sanders, etc.
    Rows: [name, espn_id, position, first_season, last_season], newest careers first.
    """
    try:
        rows = _csv(PLAYERS_URL, "players.csv", True)
    except requests.RequestException as e:
        print(f"  player index: download failed ({e}); keeping the old one")
        return
    out = []
    for r in rows:
        if not r.get("espn_id") or not r.get("display_name"):
            continue
        first, last = r.get("rookie_season") or "", r.get("last_season") or ""
        out.append([r["display_name"], r["espn_id"], r.get("position") or "", int(first) if first.isdigit() else None, int(last) if last.isdigit() else None])
    out.sort(key=lambda x: -(x[4] or 0))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"  player index: {len(out)} NFL players")

