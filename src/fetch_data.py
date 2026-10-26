"""Download raw data from the CollegeFootballData.com API (free key required).

Everything is cached under data/raw/<year>/ so re-running the model doesn't
spend API calls. A full weekly run uses about 9 calls (the free tier allows 1,000/month), and the weekly job runs
about 25 times a week, so it ran out in late October 2026. Now: the team list is re-downloaded at most once a week,
prediction refreshes (light=True) only re-download games and lines, and if CFBD refuses a call (429 / 5xx) the last
saved copy is used. data/raw is kept between GitHub runs (actions/cache in weekly.yml) so that copy exists.
The AP/Coaches polls also come from ESPN (src/espn_polls.py), which has no limit.
"""
import json
import os
import time
from pathlib import Path

import requests

import espn_polls

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


def cached(season, name, path, refresh=False, max_age_days=None, **params):
    """max_age_days: with refresh, keep a saved copy younger than this (for tables that rarely change)."""
    f = RAW / str(season) / f"{name}.json"
    if f.exists() and (not refresh or (max_age_days and time.time() - f.stat().st_mtime < max_age_days * 86400)):
        return json.loads(f.read_text(encoding="utf-8"))
    try:
        data = _get(path, **params)
    except requests.HTTPError as e:
        if not f.exists():
            raise
        print(f"  warning: {path} failed ({e}); using the saved copy from {time.strftime('%Y-%m-%d %H:%M', time.gmtime(f.stat().st_mtime))} UTC")
        return json.loads(f.read_text(encoding="utf-8"))
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")
    print(f"  fetched {path} {params} -> {len(data) if hasattr(data, '__len__') else '?'} rows")
    return data


def fetch_season(year, refresh=False, with_extras=True, light=False):
    """Return every raw table the model needs for one season.

    refresh=True re-downloads (use for the in-progress season).
    with_extras=False skips polls/talent/returning (enough for the previous-season baseline).
    light=True (prediction refreshes): only games and lines are re-downloaded; the rest uses saved copies.
    """
    slow = refresh and not light
    d = {
        "teams": cached(year, "teams_fbs", "/teams/fbs", refresh, max_age_days=7, year=year),
        "games": cached(year, "games", "/games", refresh, year=year, seasonType="regular"),
    }
    if not with_extras:
        return d
    d["advanced"] = cached(year, "advanced_games", "/stats/game/advanced", slow,
                           year=year, seasonType="regular", excludeGarbageTime="true")
    d["lines"] = cached(year, "lines", "/lines", refresh, year=year, seasonType="regular")
    d["polls"] = cached(year, "rankings", "/rankings", slow, year=year, seasonType="regular")
    if refresh:
        d["polls"] = espn_polls.merge(d["polls"], d["teams"], year)
    # Talent/returning production are preseason numbers: never need a refresh once present.
    # Other rating systems, for the Compare tab (season-to-date, so refreshed each run)
    d["fpi"] = _optional(year, "fpi", "/ratings/fpi", slow, year=year)
    d["sp"] = _optional(year, "sp", "/ratings/sp", slow, year=year)
    d["talent"] = _optional(year, "talent", "/talent", year=year)
    d["returning"] = _optional(year, "returning", "/player/returning", year=year)
    return d


def _optional(season, name, path, refresh=False, **params):
    try:
        return cached(season, name, path, refresh, **params)
    except (requests.HTTPError, SystemExit) as e:  # SystemExit = no key offline; extras are optional
        print(f"  warning: {path} unavailable ({e}); continuing without it")
        return []
