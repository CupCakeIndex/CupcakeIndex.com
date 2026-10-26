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
import nfl_features
import tune
import highlights
import daily_game
import cfb_projections
import cfb_scores
import cfb_injuries

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
LEAGUES = {"cfb": fetch_data, "nfl": nfl_data}


def default_season():
    now = datetime.now()
    return now.year if now.month >= 8 else now.year - 1


def run_league(league, season, cfg_league, offline, light=False):
    cfg = cfg_league["model"]
    src = LEAGUES[league]
    print(f"{league.upper()} {season}: loading data")
    d = src.fetch_season(season, refresh=not offline, **({"light": True} if light and league == "cfb" else {}))  # light: fewer CFBD calls
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
    nfl_R, adjust, nfl_S = {}, None, {}
    if league == "nfl":
        nfl_data.ensure_team_stats(range(season - 4, season + 1), refresh_last=not offline)
        byweek, ngames = nfl_model.season_ratings(season)
        name_of = {t["abbr"]: t["school"] for t in d["teams"]}
        nfl_R = {w: {name_of.get(a, a): r for a, r in R.items()} for w, R in byweek.items()}
        by_id = {x["id"]: x for x in ngames}
        if not offline:  # next week's listed starter can be stale: swap out a QB that ESPN lists as out (Hurts, 2026 Week 7)
            nfl_features.fix_upcoming_qbs([x for x in ngames if x["season"] == season])
            for x in games:
                g = by_id.get(x.get("id"))
                if g and not g["done"]:
                    x["hqb"], x["aqb"] = g["hqb"], g["aqb"]
        F =nfl_features.Features([season], refresh_last=not offline, live=True)  # QB quality, injury reports
        adjust = lambda x: nfl_model.adjustments(by_id[x["id"]], ngames, nfl_model.PARAMS, F) if x["id"] in by_id else 0.0
        nfl_S = nfl_model.season_score_ratings(season)  # predicted scores (offense/defense points)
        winds = {} if offline else {x["id"]: nfl_features.forecast_wind(x) for x in ngames if x["week"] == last + 1 and not x["done"]}

        def nfl_score(x, m, S):
            g = by_id[x["id"]]
            hp_, ap_ = nfl_model.predict_score(g, m, S)
            w = nfl_features.weather_points({**g, "wind": winds.get(x["id"])}) / 2  # forecast wind, upcoming games only
            return hp_ + w, ap_ + w
    cfb_S, CI = {}, None
    if league == "cfb":  # same points model, non-FBS opponents pooled (src/cfb_scores.py)
        cfb_S = cfb_scores.season_score_ratings(games, prev["games"], teams, prev_teams, last)
        try:  # availability reports (SEC, ACC, Big 12, Big Ten, MAC): starting QB out and new absences (src/cfb_injuries.py)
            CI = cfb_injuries.Reports(season, offline)
            adjust = CI.adjust if CI.reps else None
        except Exception as e:  # never let the reports block the rankings
            print(f"  injuries: skipped ({e!r})")

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
        S = nfl_S.get(week)
        scores = (lambda x, m, S=S: nfl_score(x, m, S) if x["id"] in by_id else None) if S else None
        CS = cfb_S.get(week)
        if CS:
            scores = lambda x, m, CS=CS: cfb_scores.predict(x, m, CS, teams)
        week_R = res.pop("ratings")
        picks = model.predictions(games, week_R, week, cfg, lines, adjust, res.pop("eff"), scores)
        if CS:  # college: game-specific notes for the game page's "Why" box
            fbs_R = {t: r for t, r in week_R.items() if t in teams}
            by_cid = {str(x["espn"]): x for x in games}
            for p in picks:
                x = by_cid.get(str(p["espn_id"]))
                if x:
                    p["notes"] = nfl_model.matchup_notes(x, fbs_R, CS, games, lambda t: t, p["spread"],
                                                         skey=lambda t: t if t in teams else cfb_scores.FCS,
                                                         home_text="a real edge in college", F=CI if CI and CI.reps else None)
        if S:  # NFL: game-specific notes for the game page's "Why" box
            by_espn = {str(x["espn"]): x for x in ngames if x["espn"]}
            nick = lambda a: name_of.get(a, a).split()[-1]
            for p in picks:
                x = by_espn.get(str(p["espn_id"]))
                if x:
                    p["notes"] = nfl_model.matchup_notes(x, byweek[week], S, ngames, nick, p["spread"], F=F)
        keep_scores(out_dir / f"week_{week}.json", picks)
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
    if CI and CI.reps:
        CI.save(out_dir / "injuries.json")
    if league == "cfb" and weeks:
        comp = model.comparison(teams, d["polls"], weeks[-1], d.get("fpi"), d.get("sp"))
        (out_dir / "compare.json").write_text(json.dumps({"week": weeks[-1], "teams": comp}, separators=(",", ":")), encoding="utf-8")
        try:  # our own player projections (Stats > Projected); keeps last week's file if ESPN is down
            cfb_projections.build(season, weeks[-1], offline)
        except Exception as e:
            print(f"  projections: skipped ({e!r})")
    print(f"  wrote {len(weeks)} week(s) to {out_dir.relative_to(ROOT)}")
    return weeks, accuracy(graded)


def keep_scores(path, picks):
    """Once a game is played, keep the predicted score that was shown before it (made with that week's forecast and
    injury report) instead of re-predicting it with hindsight."""
    try:
        old = {str(p["espn_id"]): p for p in json.loads(path.read_text(encoding="utf-8"))["predictions"]}
    except (OSError, ValueError, KeyError):
        return
    for p in picks:
        o = old.get(str(p["espn_id"]))
        if "actual" in p and o and "home_pts" in o and "home_pts" in p:
            hs, as_ = p["final"]
            p["home_pts"], p["away_pts"] = o["home_pts"], o["away_pts"]
            p["score_error"] = abs(p["home_pts"] - hs) + abs(p["away_pts"] - as_)


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
    scored = [p for p in graded if "score_error" in p]
    if scored:  # predicted scores: how many points each team's score was off, on average
        acc["score_games"] = len(scored)
        acc["score_mae"] = round(sum(p["score_error"] for p in scored) / (2 * len(scored)), 1)
    pct = lambda r: f"{r['correct']}/{r['games']} ({r['correct'] / r['games']:.1%})" if r["games"] else "n/a"
    if graded:
        print(f"  model straight up: {pct(su)}, avg miss {acc['mae']} pts")
        print(f"  on games with a line: model {pct(acc['model_su_lined'])} vs books {pct(acc['vegas_su'])}; "
              f"books avg miss {acc['vegas_mae']} pts")
        print(f"  model vs the spread: {pct(acc['ats'])}; edges of 3+ pts: {pct(acc['ats_strong'])}")
        if scored:
            print(f"  predicted scores: each team off by {acc['score_mae']} pts on average ({len(scored)} games)")
    return acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", choices=["cfb", "nfl", "all"], default="all")
    ap.add_argument("--season", type=int, default=default_season())
    ap.add_argument("--offline", action="store_true", help="use cached data only")
    ap.add_argument("--keep-date", action="store_true",
                    help="prediction refresh (new injury reports and forecasts): leave the 'Rankings updated' date alone")
    args = ap.parse_args()

    cfg_all = yaml.safe_load((ROOT / "src" / "config.yaml").read_text(encoding="utf-8"))
    idx_file = OUT / "index.json"
    idx = json.loads(idx_file.read_text(encoding="utf-8")) if idx_file.exists() else {}
    idx.setdefault("leagues", {})

    failed = []
    for league in (["cfb", "nfl"] if args.league == "all" else [args.league]):
        try:
            weeks, acc = run_league(league, args.season, cfg_all[league], args.offline, light=args.keep_date)
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
            **({} if args.keep_date and "updated" in L else {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes")}),
        )
    if not (args.keep_date and "updated" in idx):
        idx["updated"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    idx_file.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    if failed:
        raise SystemExit(f"Failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
