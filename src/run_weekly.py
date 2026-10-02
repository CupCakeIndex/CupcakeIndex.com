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
import nfl_model
import tune
import highlights
import daily_game
import cfb_projections

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
    prev_div = model.divisions(prev["games"])
    prev_rg = model.rating_games(prev["games"], prev_teams)
    prev_low = {n for x in prev_rg for n in (x["hnode"], x["anode"]) if n not in prev_teams}
    prev_R = model.power_ratings(sorted(prev_teams), prev_rg, cfg, node_prior=model.lower_div_prior(prev_low, prev_div, {}, cfg))

    teams = model.fbs_teams(d["teams"])
    games = model.normalize_games(d["games"], teams)
    rgames = model.rating_games(d["games"], teams)
    div = model.divisions(d["games"])
    low = {n for x in rgames for n in (x["hnode"], x["anode"]) if n not in teams}
    node_prior = model.lower_div_prior(low, div, prev_R, cfg)
    prior = model.preseason_prior(sorted(teams), prev_R, d["talent"], d["returning"])
    last = model.last_completed_week(games, cfg.get("done_share", 0.9))
    if league == "nfl" and not offline:
        nfl_data.add_book_lines(d, last + 1)
    lines = model.lines_by_game(d.get("lines", []))
    print(f"  {len(teams)} teams, {sum(x['done'] for x in games)} completed games, through week {last}")

    # NFL: its own rating model (src/nfl_model.py): last season carries over all year, efficiency + margin, QB changes
    nfl_R, adjust = {}, None
    if league == "nfl":
        nfl_data.ensure_team_stats(range(season - 4, season + 1), refresh_last=not offline)
        byweek, ngames = nfl_model.season_ratings(season)
        name_of = {t["abbr"]: t["school"] for t in d["teams"]}
        nfl_R = {w: {name_of.get(a, a): r for a, r in R.items()} for w, R in byweek.items()}
        by_id = {x["id"]: x for x in ngames}
        adjust = lambda x: nfl_model.qb_adjust(ngames, by_id[x["id"]]) if x["id"] in by_id else 0.0

    out_dir = OUT / league / str(season)
    out_dir.mkdir(parents=True, exist_ok=True)
    weeks, graded, cotw_hist = [], [], {}
    for week in (range(1, last + 1) if last else [0]):
        res = model.build_week(teams, games, d["advanced"], d["polls"], week, cfg, prior, rgames, node_prior, ratings=nfl_R.get(week))
        cotw = model.cupcake_of_week(games, res["ratings"], week, cfg, teams)
        if cotw:
            cotw_hist.setdefault(cotw["team"], []).append(week)
        res["cupcake_of_week"] = cotw
        for t in res["teams"]:
            t["cotw_weeks"] = list(cotw_hist.get(t["team"], []))
        picks = model.predictions(games, res.pop("ratings"), week, cfg, lines, adjust, res.pop("eff"))
        graded += [p for p in picks if "actual" in p]
        res.update(season=season, league=league, predictions=picks,
                   generated=datetime.now(timezone.utc).isoformat(timespec="minutes"))
        (out_dir / f"week_{week}.json").write_text(json.dumps(res, separators=(",", ":")), encoding="utf-8")
        weeks.append(week)
    if league == "nfl" and not offline:
        nfl_data.build_player_index(OUT / "players_nfl.json")
        try:
            daily_game.build(season, out_path=OUT / "daily_nfl.json")  # Daily game player pool
        except Exception as e:  # never let the game block the rankings
            print(f"  daily game: skipped ({e})")
    if not offline and weeks and weeks[-1]:
        # CFB: only games involving ranked/top-30 teams, to stay inside the free YouTube quota
        wanted = None if league == "nfl" else {t["team"] for t in res["teams"] if t["power_rank"] <= 30 or t["ap_rank"]}
        highlights.update(league, season, games, weeks[-1], wanted)
    if league == "cfb" and weeks:
        comp = model.comparison(teams, d["polls"], weeks[-1], d.get("fpi"), d.get("sp"))
        (out_dir / "compare.json").write_text(json.dumps({"week": weeks[-1], "teams": comp}, separators=(",", ":")), encoding="utf-8")
        try:  # our own player projections (Stats > Projected); keeps last week's file if ESPN is down
            cfb_projections.build(season, weeks[-1], offline)
        except Exception as e:
            print(f"  projections: skipped ({e!r})")
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
        # Presets: "Best teams" weights are learned from results each run; "Most deserving" is fixed by definition
        presets = tune.tune(league, args.season, [k for k, _, _ in model.FACTORS if k in weights], model.INVERTED, weights)
        if presets:
            L["modes"] = presets
            print(f"  Best teams preset (learned from {presets['games']} games): {presets['best']}")
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
