"""Who actually starts in the NFL: each player's games started, last season + this season.

ESPN's depth chart drops (or buries) injured players, so the site's Injuries page and the injury X post use this to
spot a "key player" who's hurt: Sam Cosmi (Out) or Trey Amos (on IR) aren't on Washington's depth chart, but they
started plenty, so losing them counts fully.

ESPN marks the 22 starters in every game's lineup (core API competitor roster, "starter": true). Finished games
never change, so each game's starters are cached in data/history/nfl_starters_cache.json and only new games are fetched.
Writes docs/data/nfl_starts.json: {"seasons": [2025, 2026], "players": {athlete id: starts}}.

    python src/nfl_starts.py            # runs with the weekly rankings (.github/workflows/weekly.yml)
"""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "history" / "nfl_starters_cache.json"
OUT = ROOT / "docs" / "data" / "nfl_starts.json"
SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
S = requests.Session()
S.headers["User-Agent"] = "Mozilla/5.0 cupcakeindex"


def finished_games(season):
    """{event id: [team ids]} for every finished regular-season game."""
    out = {}
    for wk in range(1, 19):
        try:
            evs = S.get(f"{SITE}/scoreboard?seasontype=2&week={wk}&dates={season}", timeout=30).json().get("events", [])
        except Exception:
            continue
        for e in evs:
            if e.get("status", {}).get("type", {}).get("completed"):
                out[e["id"]] = [c["team"]["id"] for c in e["competitions"][0]["competitors"]]
    return out


def starters(eid, tid):
    r = S.get(f"{CORE}/events/{eid}/competitions/{eid}/competitors/{tid}/roster", timeout=30).json()
    return [str(x["playerId"]) for x in r.get("entries", []) if x.get("starter")]


def main():
    now = datetime.now(timezone.utc)
    season = now.year if now.month >= 8 else now.year - 1
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    seasons = [season - 1, season]
    for yr in seasons:
        games = finished_games(yr)
        todo = [(eid, tid) for eid, tids in games.items() for tid in tids if f"{eid}:{tid}" not in cache]
        print(f"  {yr}: {len(games)} finished games, {len(todo)} lineups to fetch")
        with ThreadPoolExecutor(8) as ex:
            for (eid, tid), ids in zip(todo, ex.map(lambda x: starters(*x), todo)):
                if len(ids) >= 18:  # a real lineup (not an empty feed)
                    cache[f"{eid}:{tid}"] = {"y": yr, "s": ids}
    keep = {k: v for k, v in cache.items() if v["y"] in seasons}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(keep, separators=(",", ":")), encoding="utf-8")
    counts = {}
    for v in keep.values():
        for pid in v["s"]:
            counts[pid] = counts.get(pid, 0) + 1
    OUT.write_text(json.dumps({"seasons": seasons, "generated": now.isoformat(timespec="minutes"), "players": counts},
                              separators=(",", ":")), encoding="utf-8")
    print(f"  starts for {len(counts)} players -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
