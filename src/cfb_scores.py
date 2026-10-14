"""College predicted scores: the same offense/defense points model as the NFL (src/nfl_model.py score_ratings),
with every non-FBS opponent pooled into one "FCS" team. The margin comes from the college model's own prediction.

    python src/cfb_scores.py            # grade predicted scores on 2025-26 (scores from data/history/cfb)
    python src/cfb_scores.py --search   # small grid search over CFB_TOTALS
"""
import argparse
import json
from pathlib import Path

import nfl_model

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "data" / "history" / "cfb"
FCS = "FCS"

# Chosen by --search on 2025-26 (college scoring swings more than the NFL's, and rosters turn over more)
CFB_TOTALS = {"pts_cap": 70, "carry_over": 0.3, "prior_games": 9, "avg_games": 64, "decay": 1.0}


def to_score_games(games, fbs):
    """College games (model.py format or history rows) -> score-model format, non-FBS teams pooled as FCS."""
    out = []
    for x in games:
        h, a = x.get("home", x.get("h")), x.get("away", x.get("a"))
        hp, ap = x.get("hp"), x.get("ap")
        done = x.get("done", hp is not None and ap is not None) and hp is not None and ap is not None
        out.append({"id": x.get("id"), "week": x.get("week", x.get("w")), "home": h if h in fbs else FCS, "away": a if a in fbs else FCS,
                    "hp": hp, "ap": ap, "done": done, "neutral": bool(x.get("neutral", x.get("n")))})
    return out


def season_score_ratings(games, prev_games, fbs, prev_fbs, last, T=CFB_TOTALS):
    """{week: score ratings after that week} for the weekly job; last season's final numbers are the prior."""
    prior = nfl_model.final_score_ratings(to_score_games(prev_games, prev_fbs), None, T) if prev_games else None
    sg = to_score_games(games, fbs)
    return {w: nfl_model.score_ratings(sg, w + 1, prior, T) for w in range(0, last + 1)}


def predict(x, margin, S, fbs):
    g = {"home": x["home"] if x["home"] in fbs else FCS, "away": x["away"] if x["away"] in fbs else FCS}
    return nfl_model.predict_score(g, margin, S)


# ------------------------------------------------------------------ backtest
def _hist(season):
    f = HIST / f"{season}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def backtest(T=CFB_TOTALS, seasons=(2025, 2026), quiet=False):
    rows = []
    for s in seasons:
        h, prev = _hist(s), _hist(s - 1)
        fbs, pfbs = set(h["fbs"]), set(prev["fbs"])
        prior = nfl_model.final_score_ratings(to_score_games(prev["games"], pfbs), None, T)
        sg = to_score_games(h["games"], fbs)
        by_id = {x["id"]: x for x in sg}
        cache = {}
        for f in sorted((ROOT / "docs" / "data" / "cfb" / str(s)).glob("week_*.json")):
            wk = int(f.stem.split("_")[1])
            for p in json.loads(f.read_text(encoding="utf-8"))["predictions"]:
                x = by_id.get(p["espn_id"])
                if not x or not x["done"]:
                    continue
                if wk not in cache:
                    cache[wk] = nfl_model.score_ratings(sg, wk + 1, prior, T)
                hp, ap = nfl_model.predict_score(x, p["spread"], cache[wk])
                totals = [b["total"] for b in p.get("books", []) if b.get("total")]
                rows.append((x, round(hp), round(ap), hp + ap, sorted(totals)[len(totals) // 2] if totals else None))
    n = len(rows)
    team_err = sum(abs(h - x["hp"]) + abs(a - x["ap"]) for x, h, a, _, _ in rows) / (2 * n)
    tot_err = sum(abs(t - x["hp"] - x["ap"]) for x, _, _, t, _ in rows) / n
    bt = [(x, t, b) for x, _, _, t, b in rows if b]
    books = sum(abs(b - x["hp"] - x["ap"]) for x, _, b in bt) / max(1, len(bt))
    ours = sum(abs(t - x["hp"] - x["ap"]) for x, t, _ in bt) / max(1, len(bt))
    res = {"games": n, "team_err": team_err, "total_err": tot_err, "books_total_err": books, "ours_total_err_lined": ours}
    if not quiet:
        print(f"  {n} games: each team's score off by {team_err:.1f} pts on average, total off by {tot_err:.1f}")
        print(f"  books on the same {len(bt)} games: total off by {books:.1f} (ours {ours:.1f})")
    return res


def search(passes=2):
    grid = {"pts_cap": [42, 49, 56, 70], "carry_over": [0.3, 0.5, 0.7], "prior_games": [2, 4, 6, 9],
            "avg_games": [16, 32, 64, 128], "decay": [0.9, 0.95, 1.0]}
    T = dict(CFB_TOTALS)
    best = backtest(T, quiet=True)
    for _ in range(passes):
        for k, vals in grid.items():
            for v in vals:
                r = backtest({**T, k: v}, quiet=True)
                if r["team_err"] < best["team_err"] - 1e-6:
                    best, T = r, {**T, k: v}
            print(f"  {k}={T[k]}: team score off by {best['team_err']:.2f}, total off by {best['total_err']:.2f}")
    print(T)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--search", action="store_true")
    a = ap.parse_args()
    search() if a.search else backtest()
