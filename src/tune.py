"""Learn the "Best teams" weights from results instead of opinion.

For every week N we have each team's factor scores (computed only from games through week N) and the
model's list of week N+1 games with their final scores. A logistic regression asks: which blend of
factor-score differences best predicts who won the NEXT week's games? Positive coefficients become the
weights (scaled to 100). Nothing from week N+1 leaks into week N's scores, so this is a fair test.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

# "Most deserving": what a team has EARNED. Strength of record, how hard the road was, and a
# penalty for padding. No margin-of-victory or luck terms: those describe how good a team is, not what it earned.
DESERVING = {"resume": 60, "sos": 25, "cupcake": 15}


def game_rows(league, seasons, factors, inverted):
    X, y = [], []
    for season in seasons:
        d = DATA / league / str(season)
        for f in sorted(d.glob("week_*.json"), key=lambda p: int(p.stem.split("_")[1])) if d.exists() else []:
            wk = json.loads(f.read_text(encoding="utf-8"))
            s = {t["team"]: t["scores"] for t in wk["teams"]}
            for p in wk.get("predictions", []):
                if "actual" not in p or not p["actual"] or p["home"] not in s or p["away"] not in s:
                    continue
                h, a = s[p["home"]], s[p["away"]]
                val = lambda sc, k: (100 - sc[k]) if k in inverted else sc[k]
                X.append([val(h, k) - val(a, k) for k in factors])
                y.append(1.0 if p["actual"] > 0 else 0.0)
    return np.array(X, dtype=float), np.array(y)


def fit_logistic(X, y, l2=1.0, iters=50):
    """Newton's method with an intercept (home-field) and a small L2 penalty."""
    Z = np.hstack([np.ones((len(X), 1)), X / 10.0])  # scale: 10 score points per unit
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        grad = Z.T @ (p - y) + l2 * np.r_[0, w[1:]]
        H = (Z * (p * (1 - p))[:, None]).T @ Z + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        w -= np.linalg.solve(H, grad)
    return w


def to_weights(coef, factors):
    pos = np.clip(coef, 0, None)
    if pos.sum() == 0:
        return {k: (100 if k == "power" else 0) for k in factors}
    raw = 100 * pos / pos.sum()
    w = {k: int(5 * round(v / 5)) for k, v in zip(factors, raw)}
    w[max(w, key=w.get)] += 100 - sum(w.values())  # keep the total at exactly 100
    return w


def accuracy(X, y, weights, factors):
    """Share of games where the team with the higher blended score won (home field ignored)."""
    if not len(y):
        return None
    wv = np.array([weights.get(k, 0) for k in factors], dtype=float)
    diff = X @ wv
    ok = (diff != 0)
    return float(((diff[ok] > 0) == (y[ok] == 1)).mean())


def tune(league, season, factors, inverted, default_weights):
    """Fit on this season + last season; report accuracy, including a fit-on-last-season / test-on-this-season check."""
    X, y = game_rows(league, [season - 1, season], factors, inverted)
    if len(y) < 100:
        return None
    best = to_weights(fit_logistic(X, y)[1:], factors)
    deserving = {k: v for k, v in DESERVING.items() if k in factors}
    if sum(deserving.values()) != 100:  # NFL has no cupcake factor
        scale = 100 / sum(deserving.values())
        deserving = {k: round(v * scale) for k, v in deserving.items()}
    # out-of-sample check: learn from last season only, test on this season's games
    Xo, yo = game_rows(league, [season - 1], factors, inverted)
    Xt, yt = game_rows(league, [season], factors, inverted)
    oos = to_weights(fit_logistic(Xo, yo)[1:], factors) if len(yo) >= 100 else None
    return {
        "best": best,
        "deserving": deserving,
        "games": int(len(y)),
        "accuracy": {
            "best": accuracy(X, y, best, factors),
            "deserving": accuracy(X, y, deserving, factors),
            "old_default": accuracy(X, y, default_weights, factors),
            "power_only": accuracy(X, y, {"power": 1}, factors),
        },
        "out_of_sample": {
            "trained_on": season - 1, "tested_on": season, "games": int(len(yt)),
            "best": accuracy(Xt, yt, oos, factors) if oos else None,
            "old_default": accuracy(Xt, yt, default_weights, factors),
        },
    }
