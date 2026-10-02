"""College football game history for the cupcake stat posts (cupcake_stats.py).

One small file per season in data/history/cfb/<year>.json:
  ratings  our power rating for every team that season (end of season; the current season = so far),
           the same model as the site, so "cupcake" means exactly what it means on the rankings page
  fbs      the FBS teams that season
  games    every game with an FBS team: week, date (Eastern), home, away, scores, neutral site, conference game,
           bowl/playoff, and each team's AP rank going into the game

Past seasons are downloaded once (about 3 CollegeFootballData calls each) and kept in the repo; the current
season is refreshed every run. Needs CFBD_API_KEY (a GitHub secret) for anything not already downloaded.

    python src/social/cupcake_history.py                 # fill in missing seasons + refresh this one
    python src/social/cupcake_history.py --from 2005     # how far back (default 2005)
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import fetch_data  # noqa: E402
import model  # noqa: E402

ROOT = HERE.parent.parent
OUT = ROOT / "data" / "history" / "cfb"
FIRST = 2005
MISSING = set()  # seasons built without every piece (no key): rebuilt next time


def current_season(today=None):
    today = today or dt.date.today()
    return today.year if today.month >= 7 else today.year - 1


def cfg():
    with open(HERE.parent / "config.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)["cfb"]["model"]


def _get(year, name, season_type, refresh):
    """Cached CFBD call; [] when it can't be downloaded (no key on this computer)."""
    path = "/rankings" if name == "rankings" else "/games"
    for fresh in ([True, False] if refresh else [False]):
        try:
            return fetch_data.cached(year, name, path, fresh, year=year, seasonType=season_type)
        except SystemExit:  # no CFBD_API_KEY on this computer: fall back to the cached copy, if any
            continue
    print(f"  {year} {name}: not available (no CFBD_API_KEY and nothing cached)")
    MISSING.add(year)
    return []


def eastern_date(start, tbd=False):
    """CFBD times are UTC; a 7:30 PM Eastern kickoff is the next day in UTC. Five hours back gives the local day.
    Games without a kickoff time yet (TBD) are listed at midnight Eastern: their UTC date is already right."""
    if not start:
        return None
    t = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
    return (t if tbd else t - dt.timedelta(hours=5)).date().isoformat()


def build(year, refresh=False):
    reg = _get(year, "games", "regular", refresh)
    post = _get(year, "games_post", "postseason", refresh)
    polls = _get(year, "rankings", "regular", refresh)
    if not reg:
        return None
    raw = reg + post
    div = model.divisions(raw)
    fbs = {n for n, c in div.items() if c == "fbs"}
    c = cfg()
    rg = model.rating_games(raw, fbs)
    low = {n for x in rg for n in (x["hnode"], x["anode"]) if n not in fbs}
    R = model.power_ratings(sorted(fbs), rg, c, node_prior=model.lower_div_prior(low, div, {}, c))
    last_poll = model.ap_ranks(polls, 99)
    ap_by_week = {}
    games = []
    for x in raw:
        h, a = model.g(x, "homeTeam"), model.g(x, "awayTeam")
        if h not in fbs and a not in fbs:
            continue
        is_post = model.g(x, "seasonType") == "postseason"
        wk = model.g(x, "week", default=0)
        if is_post:
            ap = last_poll
        else:
            if wk not in ap_by_week:
                ap_by_week[wk] = model.ap_ranks(polls, wk - 1)  # the poll in effect going into this week
            ap = ap_by_week[wk]
        hp, apts = model.g(x, "homePoints"), model.g(x, "awayPoints")
        done = bool(model.g(x, "completed", default=False)) and hp is not None and apts is not None
        games.append({"w": wk, "d": eastern_date(model.g(x, "startDate"), bool(model.g(x, "startTimeTBD", default=False))), "h": h, "a": a,
                      "hp": hp if done else None, "ap": apts if done else None,
                      "n": bool(model.g(x, "neutralSite", default=False)), "c": bool(model.g(x, "conferenceGame", default=False)),
                      "p": is_post, "hr": ap.get(h), "ar": ap.get(a), "id": model.g(x, "id")})
    games.sort(key=lambda r: (r["d"] or "", r["id"] or 0))
    done_n = sum(r["hp"] is not None for r in games)
    return {"season": year, "complete": year < current_season() or done_n == len(games), "partial": year in MISSING, "fbs": sorted(fbs),
            "ratings": {t: round(r, 2) for t, r in R.items()}, "games": games}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="first", type=int, default=FIRST)
    ap.add_argument("--to", type=int, default=current_season())
    ap.add_argument("--refresh", action="store_true", help="re-download finished seasons too")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    now = current_season()
    for year in range(a.first, a.to + 1):
        f = OUT / f"{year}.json"
        if f.exists() and year < now and not a.refresh and not json.loads(f.read_text(encoding="utf-8")).get("partial"):
            continue
        d = build(year, refresh=a.refresh or year == now)
        if not d:
            print(f"{year}: no games available")
            continue
        f.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
        print(f"{year}: {len(d['games'])} games, {len(d['fbs'])} FBS teams -> {f.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
