"""Weekly job: fetch data, rebuild every week of the season, write JSON for the website.

    python src/run_weekly.py                       # both leagues, current season, fresh data
    python src/run_weekly.py --league nfl          # just one league
    python src/run_weekly.py --season 2025         # any past season (backtest)
    python src/run_weekly.py --offline             # reuse cached data, no downloads
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import yaml

import fetch_data
import model
import nfl_data

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
LEAGUES = {"cfb": fetch_data, "nfl": nfl_data}


def default_season():
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def run_league(league, season, cfg_league, offline):
    cfg = cfg_league["model"]
    src = LEAGUES[league]
    print(f"{league.upper()} {season}: loading data")
    d = src.fetch_season(season, refresh=not offline)
    prev = src.fetch_season(season - 1, with_extras=False)

    prev_teams = model.fbs_teams(prev["teams"])
    prev_R = model.power_ratings(sorted(prev_teams), model.normalize_games(prev["games"], prev_teams), cfg)

    teams = model.fbs_teams(d["teams"])
    games = model.normalize_games(d["games"], teams)
    prior = model.preseason_prior(sorted(teams), prev_R, d["talent"], d["returning"])
    last = model.last_completed_week(games, cfg.get("done_share", 0.9))
    if league == "nfl" and not offline:
        nfl_data.add_book_lines(d, last + 1)
    lines = model.lines_by_game(d.get("lines", []))
    print(f"  {len(teams)} teams, {sum(x['done'] for x in games)} completed games, through week {last}")

    out_dir = OUT / league / str(season)
    out_dir.mkdir(parents=True, exist_ok=True)
    weeks, graded, cotw_hist = [], [], {}
    for week in (range(1, last + 1) if last else [0]):
        res = model.build_week(teams, games, d["advanced"], d["polls"], week, cfg, prior)
        cotw = model.cupcake_of_week(games, res["ratings"], week, cfg) if league == "cfb" else None
        if cotw:
            cotw_hist.setdefault(cotw["team"], []).append(week)
        res["cupcake_of_week"] = cotw
        for t in res["teams"]:
            t["cotw_weeks"] = list(cotw_hist.get(t["team"], []))
        picks = model.predictions(games, res.pop("ratings"), week, cfg, lines)
        graded += [p for p in picks if "actual" in p]
        res.update(season=season, league=league, predictions=picks,
                   generated=datetime.now(timezone.utc).isoformat(timespec="minutes"))
        (out_dir / f"week_{week}.json").write_text(json.dumps(res, separators=(",", ":")), encoding="utf-8")
        weeks.append(week)
    print(f"  wrote {len(weeks)} week(s) to {out_dir.relative_to(ROOT)}")
    return weeks, accuracy(graded)


def accuracy(graded):
    def record(key, rows):
        rows = [p for p in rows if p.get(key) is not None]
        return {"games": len(rows), "correct": sum(p[key] for p in rows)}

    su = record("correct", graded)
    with_line = [p for p in graded if "vegas" in p]
    acc = {
        **su,
        "mae": round(sum(p["error"] for p in graded) / len(graded), 1) if graded else None,
        "vegas_su": record("vegas_correct", with_line),       # same games, books' favorite
        "model_su_lined": record("correct", with_line),
        "ats": record("ats_correct", with_line),
        "ats_strong": record("ats_correct", [p for p in with_line if abs(p["edge"]) >= 3]),
        "vegas_mae": round(sum(abs(p["actual"] - p["vegas"]) for p in with_line) / len(with_line), 1) if with_line else None,
    }
    pct = lambda r: f"{r['correct']}/{r['games']} ({r['correct'] / r['games']:.1%})" if r["games"] else "n/a"
    if graded:
        print(f"  model straight up: {pct(su)}, avg miss {acc['mae']} pts")
        print(f"  on games with a line: model {pct(acc['model_su_lined'])} vs books {pct(acc['vegas_su'])}; "
              f"books avg miss {acc['vegas_mae']} pts")
        print(f"  model vs the spread: {pct(acc['ats'])}; edges of 3+ pts: {pct(acc['ats_strong'])}")
    return acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", choices=["cfb", "nfl", "all"], default="all")
    ap.add_argument("--season", type=int, default=default_season())
    ap.add_argument("--offline", action="store_true", help="use cached data only")
    args = ap.parse_args()

    cfg_all = yaml.safe_load((ROOT / "src" / "config.yaml").read_text(encoding="utf-8"))
    idx_file = OUT / "index.json"
    idx = json.loads(idx_file.read_text(encoding="utf-8")) if idx_file.exists() else {}
    idx.setdefault("leagues", {})

    failed = []
    for league in (["cfb", "nfl"] if args.league == "all" else [args.league]):
        try:
            weeks, acc = run_league(league, args.season, cfg_all[league], args.offline)
        except Exception as e:  # one league's outage shouldn't block the other
            print(f"  ERROR building {league}: {e!r}")
            failed.append(league)
            continue
        weights = cfg_all[league]["default_weights"]
        L = idx["leagues"].setdefault(league, {"seasons": {}})
        L["seasons"][str(args.season)] = {"weeks": weeks, "accuracy": acc}
        latest = max(L["seasons"], key=int)
        L.update(
            latest={"season": int(latest), "week": max(L["seasons"][latest]["weeks"])},
            factors=[{"key": k, "label": lbl, "help": (model.NFL_HELP.get(k, h) if league == "nfl" else h),
                      **({"invert": True} if k in model.INVERTED else {})}
                     for k, lbl, h in model.FACTORS if k in weights],
            default_weights=weights,
            updated=datetime.now(timezone.utc).isoformat(timespec="minutes"),
        )
    idx["updated"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    idx_file.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    if failed:
        raise SystemExit(f"Failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
