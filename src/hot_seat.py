"""Hot seat: each current head coach's chance of being out after this season (fired, or pushed out), from the
game rows src/coaches.py builds (NFL since 1999, college since 2006).

Trained on every past coach-season: "out" = he didn't finish the season as the team's coach or wasn't its coach
the next season, AND he wasn't a head coach anywhere in our data the next season (so leaving for a better job
doesn't count). Retirements count as out too; there's no free data that tells them apart.

What it looks at (a logistic regression, one per league):
  win % this season and wins over expected per game (NFL: the books' lines; college: last year's ratings)
  his record the season before at this team, years in the job (year 1-2 coaches are rarely fired),
  and the program's standard (its win % over the 10 seasons before), since 7-5 is fine at some places and not others.
This season's numbers so far stand in for the full season.

Labels: Safe under 15%, Teetering 15-35%, Hot seat 35%+.

    python src/hot_seat.py      # leave-one-season-out test of both leagues
"""
from collections import defaultdict

import numpy as np

BANDS = [(0.35, "hot"), (0.15, "teeter"), (0.0, "safe")]
FULL = {"nfl": 17, "cfb": 12}  # regular-season games: this season so far is filled out to a full season


def seasons(rows):
    """{(coach, team, season): stats} plus {(team, season): [coaches in order]} and {season: set of head coaches}."""
    out = defaultdict(lambda: {"g": 0, "w": 0.0, "x": 0.0, "xn": 0, "first": None})
    order, team_games = defaultdict(list), defaultdict(int)
    for y, c, t, o, us, them, post, title, p in sorted(rows, key=lambda r: r[0]):
        if post:
            continue
        team_games[(t, y)] += 1
        s = out[(c, t, y)]
        if s["first"] is None:
            s["first"] = team_games[(t, y)]
        s["g"] += 1
        win = 1.0 if us > them else 0.5 if us == them else 0.0
        s["w"] += win
        if p is not None:
            s["x"] += win - p
            s["xn"] += 1
        if c not in order[(t, y)]:
            order[(t, y)].append(c)
    hcs = defaultdict(set)
    for (c, t, y) in out:
        hcs[y].add(c)
    return out, order, team_games, hcs


def build_table(rows, lg):
    S, order, team_games, hcs = seasons(rows)
    # team win % by season (for the program's standard)
    team = defaultdict(lambda: [0.0, 0])
    for (c, t, y), s in S.items():
        team[(t, y)][0] += s["w"]
        team[(t, y)][1] += s["g"]
    last = max(y for (_, _, y) in S)
    X, Y, keys = [], [], []
    for (c, t, y), s in S.items():
        tg = team_games[(t, y)]
        if s["g"] < 3 or (s["first"] > 1 and s["g"] < 0.6 * tg):
            continue  # an interim coach's partial season
        pct = s["w"] / s["g"]
        woe = s["x"] / s["xn"] if s["xn"] else 0.0
        if y == last:  # unfinished season: the rest of it played exactly to expectations
            left = max(0, FULL[lg] - s["g"])
            exp_rate = pct - woe  # his team's average expected win chance in its games so far
            pct = (s["w"] + left * exp_rate) / (s["g"] + left)
            woe = woe * s["g"] / (s["g"] + left)
        tenure = 1
        while (c, t, y - tenure) in S:
            tenure += 1
        prev = S.get((c, t, y - 1))
        tp = team.get((t, y - 1))
        prev_pct = prev["w"] / prev["g"] if prev else (tp[0] / tp[1] if tp and tp[1] else pct)
        # his track record here: wins over expected per game over up to 3 seasons before this one
        past = [S[(c, t, yy)] for yy in range(y - 3, y) if (c, t, yy) in S]
        track = sum(q["x"] for q in past) / max(1, sum(q["xn"] for q in past)) if past else 0.0
        std_w = [team[(t, yy)] for yy in range(y - 10, y) if (t, yy) in team and team[(t, yy)][1]]
        std = sum(a for a, _ in std_w) / sum(b for _, b in std_w) if std_w else 0.5
        x = [pct, woe, prev_pct, 1.0 if tenure <= 2 else 0.0, min(tenure, 10) / 10, std, max(0.0, std - pct), track]
        if y == last:
            keys.append((c, t, y, x, None))
            continue
        replaced = order[(t, y)][-1] != c
        stayed = (c, t, y + 1) in S
        out = (replaced or not stayed) and c not in hcs.get(y + 1, set())
        keys.append((c, t, y, x, int(out)))
    return keys


def fit(X, Y, l2=1.0, iters=3000, lr=0.5):
    X = np.asarray(X, float)
    Y = np.asarray(Y, float)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd])
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        g = Z.T @ (p - Y) / len(Y) + l2 * np.r_[0, w[1:]] / len(Y)
        w -= lr * g
    return w, mu, sd


def prob(model, x):
    w, mu, sd = model
    z = np.r_[1.0, (np.asarray(x, float) - mu) / sd]
    return float(1 / (1 + np.exp(-z @ w)))


def band(p):
    return next(lab for cut, lab in BANDS if p >= cut)


def why(x, p, rec):
    """Short plain-English reasons pointing the same way as the label. rec: this season's [w, l, t] so far."""
    pct, woe, prev_pct, new, ten, std, below, track = x
    w, l, t = rec
    now = f"{w}-{l}" + (f"-{t}" if t else "")
    bad, good = [], []
    if woe <= -0.04:
        bad.append(f"{now} this season, behind what we expected")
    elif woe >= 0.04:
        good.append(f"{now} this season, ahead of what we expected")
    if below >= 0.08:
        bad.append(f"Below the program's usual standard (about {std * 100:.0f}% wins)")
    if prev_pct < 0.4 and not new:
        bad.append("Coming off a losing season")
    if track <= -0.05:
        bad.append("His teams have trailed expectations here the last few years")
    elif track >= 0.05:
        good.append("A strong track record here the last few years")
    if new:
        good.append("Year 1 or 2 in the job (schools rarely fire coaches that early)")
    if pct >= 0.7:
        good.append("On pace for a big season")
    if not bad and not good:
        good.append(f"{now} this season, about what we expected")
    if p >= 0.15 and not bad:
        bad.append(f"Year {round(ten * 10)}{'+' if ten >= 1 else ''} in the job, when the record has to show it")
    return (bad + good if p >= 0.15 else good + bad)[:3]


def run(rows, lg):
    """Train on every finished season, score this season's coaches: {(coach, team): {p, lab, why}}."""
    keys = build_table(rows, lg)
    train = [(x, yv) for _, _, _, x, yv in keys if yv is not None]
    model = fit([x for x, _ in train], [yv for _, yv in train])
    return {(c, t): x for c, t, y, x, yv in keys if yv is None}, model


def backtest(rows, lg):
    keys = build_table(rows, lg)
    seasons_ = sorted({y for _, _, y, _, yv in keys if yv is not None})
    preds = []
    for y in seasons_[-10:]:
        tr = [(x, yv) for _, _, yy, x, yv in keys if yv is not None and yy != y]
        m = fit([x for x, _ in tr], [v for _, v in tr])
        preds += [(prob(m, x), v) for _, _, yy, x, v in keys if yy == y and v is not None]
    P = np.array([p for p, _ in preds])
    V = np.array([v for _, v in preds])
    pos, neg = P[V == 1], P[V == 0]
    auc = (pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean()
    base = V.mean()
    brier, brier0 = ((P - V) ** 2).mean(), ((base - V) ** 2).mean()
    print(f"{lg}: {len(V)} coach-seasons (last 10 seasons, each predicted by a model that never saw it), out rate {base:.1%}")
    print(f"  AUC {auc:.3f} (0.5 = coin flip), Brier {brier:.4f} vs {brier0:.4f} guessing the average")
    for lab in ("safe", "teeter", "hot"):
        m = np.array([band(p) == lab for p in P])
        if m.any():
            print(f"  {lab:7}: {m.sum():4} coach-seasons, predicted {P[m].mean():.0%}, actually out {V[m].mean():.0%}")


if __name__ == "__main__":
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import coaches
    backtest(coaches.nfl_games(), "nfl")
    rows, _, _ = coaches.cfb_games(coaches.cfb_staff(refresh=False))
    backtest(rows, "cfb")
