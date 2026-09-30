"""Download raw data from the CollegeFootballData.com API (free key required).

Everything is cached under data/raw/<year>/ so re-running the model doesn't
spend API calls. A full weekly run uses about 9 calls (the free tier allows 1,000/month).
"""
import json
import os
import time
from pathlib import Path

import requests

API = "https://api.collegefootballdata.com"
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"


def _get(path, **params):
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        raise SystemExit(
            "CFBD_API_KEY is not set. Get a free key at https://collegefootballdata.com/key\n"
            "then (PowerShell)  $env:CFBD_API_KEY = 'your-key'"
        )
    for attempt in range(3):
        r = requests.get(API + path, params=params, timeout=60,
                         headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def cached(season, name, path, refresh=False, **params):
    f = RAW / str(season) / f"{name}.json"
    if f.exists() and not refresh:
        return json.loads(f.read_text(encoding="utf-8"))
    data = _get(path, **params)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")
    print(f"  fetched {path} {params} -> {len(data) if hasattr(data, '__len__') else '?'} rows")
    return data


def fetch_season(year, refresh=False, with_extras=True):
    """Return every raw table the model needs for one season.

    refresh=True re-downloads (use for the in-progress season).
    with_extras=False skips polls/talent/returning (enough for the previous-season baseline).
    """
    d = {
        "teams": cached(year, "teams_fbs", "/teams/fbs", refresh, year=year),
        "games": cached(year, "games", "/games", refresh, year=year, seasonType="regular"),
    }
    if not with_extras:
        return d
    d["advanced"] = cached(year, "advanced_games", "/stats/game/advanced", refresh,
                           year=year, seasonType="regular", excludeGarbageTime="true")
    d["lines"] = cached(year, "lines", "/lines", refresh, year=year, seasonType="regular")
    d["polls"] = cached(year, "rankings", "/rankings", refresh, year=year, seasonType="regular")
    # Talent/returning production are preseason numbers: never need a refresh once present.
    d["talent"] = _optional(year, "talent", "/talent", year=year)
    d["returning"] = _optional(year, "returning", "/player/returning", year=year)
    return d


def _optional(season, name, path, **params):
    try:
        return cached(season, name, path, False, **params)
    except requests.HTTPError as e:
        print(f"  warning: {path} unavailable ({e}); continuing without it")
        return []
