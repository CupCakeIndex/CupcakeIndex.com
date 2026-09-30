"""Find the official YouTube highlight video for recent games (YouTube Data API, key in YOUTUBE_API_KEY).

Only videos from official channels are accepted (league, network and conference channels), the title has
to name both teams and say "highlights", and the video must allow embedding. Results are cached in
docs/data/<league>/<season>/highlights.json so each game is searched at most a few times.
Free quota is 10,000 units/day and a search costs 100, so each run is capped at MAX_SEARCHES.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
API = "https://www.googleapis.com/youtube/v3/search"
MAX_SEARCHES = 60   # 6,000 quota units; Monday + Tuesday runs stay under the daily limit
MAX_TRIES = 3       # give up on a game after this many empty searches
LOOKBACK_WEEKS = 3  # also retry recent weeks that came up empty

OFFICIAL = {
    "nfl": {"nfl"},
    "cfb": {"espn college football", "espn", "sec network", "big ten network", "acc digital network", "acc network",
            "big 12 conference", "cbs sports", "cbs sports college football", "fox college football", "fox sports",
            "nbc sports", "the cw sports", "pac-12 network", "mountain west", "american athletic conference",
            "sun belt conference", "conference usa", "mac sports", "espnu"},
}


def _matches(title, home, away, league):
    t = title.lower()
    if "highlight" not in t:
        return False
    names = [home, away]
    if league == "nfl":  # "Chicago Bears" -> "bears"
        keys = [n.split()[-1].lower() for n in names]
    else:                 # "Ohio State" -> "ohio state"; "Miami" -> "miami"
        keys = [n.lower() for n in names]
    return all(k in t for k in keys)


def _search(key, league, g):
    start = datetime.fromisoformat(str(g["start"]).replace("Z", "+00:00")) if g.get("start") else None
    params = {
        "key": key, "part": "snippet", "type": "video", "videoEmbeddable": "true", "maxResults": 10,
        "q": f"{g['away']} vs {g['home']} highlights",
    }
    if start:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        params["publishedAfter"] = (start - timedelta(hours=6)).isoformat().replace("+00:00", "Z")
        params["publishedBefore"] = (start + timedelta(days=6)).isoformat().replace("+00:00", "Z")
    r = requests.get(API, params=params, timeout=20)
    if r.status_code == 403:
        raise PermissionError(r.text[:200])  # quota exhausted or key problem: stop for this run
    r.raise_for_status()
    for item in r.json().get("items", []):
        sn = item.get("snippet", {})
        if sn.get("channelTitle", "").strip().lower() in OFFICIAL[league] and _matches(sn.get("title", ""), g["home"], g["away"], league):
            return {"id": item["id"]["videoId"], "title": sn.get("title"), "channel": sn.get("channelTitle")}
    return None


def update(league, season, games, last_week, wanted_teams=None):
    """Search for highlights of completed games in the last few weeks. `wanted_teams`: only games involving these (CFB)."""
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        print("  highlights: YOUTUBE_API_KEY not set, skipping")
        return
    path = ROOT / "docs" / "data" / league / str(season) / "highlights.json"
    cache = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    todo = [g for g in games if g["done"] and last_week - LOOKBACK_WEEKS < g["week"] <= last_week
            and (wanted_teams is None or g["home"] in wanted_teams or g["away"] in wanted_teams)]
    todo.sort(key=lambda g: -g["week"])  # newest first
    searched = found = 0
    for g in todo:
        gid = str(g["espn"])
        entry = cache.get(gid, {})
        if entry.get("id") or entry.get("tries", 0) >= MAX_TRIES:
            continue
        if searched >= MAX_SEARCHES:
            break
        try:
            hit = _search(key, league, g)
        except PermissionError as e:
            print(f"  highlights: stopped early ({e})")
            break
        except requests.RequestException as e:
            print(f"  highlights: search failed for {g['away']} @ {g['home']}: {e}")
            continue
        searched += 1
        if hit:
            cache[gid] = hit
            found += 1
        else:
            cache[gid] = {"tries": entry.get("tries", 0) + 1}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    print(f"  highlights: {searched} searches, {found} new videos, {sum(1 for v in cache.values() if v.get('id'))} total")
