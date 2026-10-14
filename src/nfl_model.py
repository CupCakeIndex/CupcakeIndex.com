"""NFL-only rating model (the college model's margin-only ratings were too jumpy for a 17-game league).

    python src/nfl_model.py --backtest          # grade every week of 2020-2025 vs. the old settings and the books
    python src/nfl_model.py --search            # small grid search over the settings below

What's different from college, and why (each one was checked in the backtest):
  1. Last season matters all year. NFL rosters carry over, so a team's rating starts from last season's
     (regressed toward average) and that prior never fully fades. The old settings dropped it by week 6,
     which is how a good team became "bad" after one ugly loss.
  2. Efficiency, not just scores. Opponent-adjusted EPA per play (how well a team moves the ball and stops
     it, play by play) predicts next week better than scoring margin alone, which is noisy in a league full
     of one-score games. The rating blends both.
  3. Recent games count a bit more than September games.
  4. Quarterbacks. A team starting someone other than its usual QB is marked down.
Ratings are in points: +3 = a field goal better than an average team on a neutral field.
"""
import argparse
import csv
import itertools
import math
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nfl"
MOVED = {"OAK": "LV", "SD": "LAC", "STL": "LA"}  # relocated teams keep one id across seasons

# Chosen by --search on 2020-2025 (see README). Plain-English names so they can live in config.yaml.
PARAMS = {
    "margin_cap": 17,      # points; scores past two touchdowns and a field goal are mostly garbage time
    "home_field": 1.0,     # points (the modern NFL home edge is small)
    "carry_over": 0.6,     # share of last season's rating a team starts with
    "prior_games": 14,     # last season counts like this many games, all season long
    "decay": 0.95,         # each older week counts this much of the next newer one
    "epa_blend": 0.5,      # share of the rating that comes from efficiency (EPA/play) instead of scoring margin
    "epa_points": 90,      # 1.0 net EPA/play over a game ~= this many points of margin (0.1 EPA/play ~ 9 pts)
    "backup_qb": 4.5,      # points off for a team not starting its usual quarterback
    "sigma": 13.0,         # spread of NFL results around the prediction, for win chances
}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_games(path=RAW / "games.csv"):
    """Regular-season games: {season: [game]} with scores (None if not played yet) and starting QBs."""
    out = defaultdict(list)
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["game_type"] != "REG":
                continue
            hs, as_ = _num(r["home_score"]), _num(r["away_score"])
            out[int(r["season"])].append({
                "id": r["game_id"], "season": int(r["season"]), "week": int(r["week"]),
                "home": MOVED.get(r["home_team"], r["home_team"]), "away": MOVED.get(r["away_team"], r["away_team"]),
                "hp": hs, "ap": as_, "done": hs is not None and as_ is not None, "neutral": r["location"] == "Neutral",
                "hqb": r.get("home_qb_name") or None, "aqb": r.get("away_qb_name") or None,
                "line": _num(r.get("spread_line")),  # books: + = home favored
                "total_line": _num(r.get("total_line")),
                "espn": r.get("espn") or None,
            })
    return out


def load_epa(season):
    """{game id: {team: offensive EPA per play}} from nflverse team stats (missing file -> {})."""
    f = RAW / f"stats_team_week_{season}.csv"
    if not f.exists():
        return {}
    out = defaultdict(dict)
    with open(f, encoding="utf-8") as fh:
        for s in csv.DictReader(fh):
            if s.get("season_type") != "REG":
                continue
            plays = sum(_num(s.get(k)) or 0 for k in ("attempts", "carries", "sacks_suffered"))
            epa = sum(_num(s.get(k)) or 0 for k in ("passing_epa", "rushing_epa"))
            if plays:
                out[s["game_id"]][MOVED.get(s["team"], s["team"])] = epa / plays
    return out


def _solve(teams, rows, prior, k):
    """Weighted least squares: r[home] - r[away] = value, pulled toward `prior` with weight k; mean 0."""
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    A, y = [], []
    for h, a, v, w in rows:
        r = np.zeros(n)
        r[idx[h]], r[idx[a]] = 1, -1
        s = math.sqrt(w)
        A.append(r * s)
        y.append(v * s)
    s = math.sqrt(max(k, 1e-3))
    for t in teams:
        r = np.zeros(n)
        r[idx[t]] = s
        A.append(r)
        y.append(s * prior.get(t, 0.0))
    A.append(np.full(n, 100.0 / n))
    y.append(0.0)
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    return {t: float(sol[idx[t]]) for t in teams}


def ratings(games, epa, before_week, prior_m, prior_e, P=PARAMS):
    """Ratings in points from this season's games before `before_week`.
    Returns (blended rating, margin rating, efficiency rating in points)."""
    teams = sorted({x[s] for x in games for s in ("home", "away")})
    played = [x for x in games if x["done"] and x["week"] < before_week]
    last = max((x["week"] for x in played), default=0)
    m_rows, e_rows = [], []
    for x in played:
        w = P["decay"] ** (last - x["week"])
        hfa = 0 if x["neutral"] else P["home_field"]
        m = max(-P["margin_cap"], min(P["margin_cap"], x["hp"] - x["ap"]))
        m_rows.append((x["home"], x["away"], m - hfa, w))
        e = epa.get(x["id"], {})
        if x["home"] in e and x["away"] in e:
            e_rows.append((x["home"], x["away"], (e[x["home"]] - e[x["away"]]) * P["epa_points"] - hfa, w))
    pm = {t: P["carry_over"] * prior_m.get(t, 0.0) for t in teams}
    pe = {t: P["carry_over"] * prior_e.get(t, 0.0) for t in teams}
    k = P["prior_games"]
    if P.get("prior_fade"):  # old college-style setting: prior fades to nothing by this week
        k *= max(0.0, (P["prior_fade"] - (before_week - 1)) / (P["prior_fade"] - 1))
    Rm = _solve(teams, m_rows, pm, k)
    Re = _solve(teams, e_rows, pe, k) if e_rows or prior_e else Rm
    b = P["epa_blend"] if e_rows or prior_e else 0.0
    return {t: (1 - b) * Rm[t] + b * Re[t] for t in teams}, Rm, Re


def usual_qb(games, team, before_week):
    """The QB who started most of this team's games so far (None before 2 starts)."""
    c = Counter((x["hqb"] if x["home"] == team else x["aqb"]) for x in games
                if x["done"] and x["week"] < before_week and team in (x["home"], x["away"]))
    c.pop(None, None)
    top = c.most_common(1)
    return top[0][0] if top and top[0][1] >= 2 else None


def predict(x, R, games, P=PARAMS):
    """Expected home margin and home win chance for game x."""
    m = R.get(x["home"], 0.0) - R.get(x["away"], 0.0) + (0 if x["neutral"] else P["home_field"])
    for side, sign in (("h", 1), ("a", -1)):
        team, qb = (x["home"], x["hqb"]) if side == "h" else (x["away"], x["aqb"])
        u = usual_qb(games, team, x["week"])
        if qb and u and qb != u:
            m -= sign * P["backup_qb"]
    return m, 0.5 * (1 + math.erf(m / (P["sigma"] * math.sqrt(2))))


# ------------------------------------------------------------------ predicted scores
# The margin above says who wins and by how much; this says how many points the game has. Each team gets an
# offense number (points it scores above average) and a defense number (points it allows above average), fit to
# this season's scores with opponents adjusted, recent weeks counting more and last season carried over.
# Predicted total = both offenses vs. both defenses; the two scores split that total by the margin.
TOTALS = {
    "pts_cap": 40,         # points; a 52-point blowout says little more about the offense than 40 does
    "carry_over": 0.7,     # share of last season's offense/defense numbers a team starts with
    "prior_games": 16,     # last season counts like this many games (chosen by --score-search on 2020-2025)
    "avg_games": 32,       # league scoring level: last season's average counts like this many games
    "decay": 0.95,
}


def score_ratings(games, before_week, prior, T=TOTALS):
    """(offense, defense, league average points per team) from games before `before_week`.
    prior = (offense, defense, average) from last season, or None."""
    teams = sorted({x[s] for x in games for s in ("home", "away")})
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    played = [x for x in games if x["done"] and x["week"] < before_week]
    last = max((x["week"] for x in played), default=0)
    po, pd, pavg = prior or ({}, {}, 22.0)
    A, y = [], []
    for x in played:  # unknowns: offense[0..n), defense[n..2n), average[2n]
        w = math.sqrt(T["decay"] ** (last - x["week"]))
        for us, them, pts in ((x["home"], x["away"], x["hp"]), (x["away"], x["home"], x["ap"])):
            r = np.zeros(2 * n + 1)
            r[idx[us]], r[n + idx[them]], r[2 * n] = 1, 1, 1
            A.append(r * w)
            y.append(min(pts, T["pts_cap"]) * w)
    k = math.sqrt(T["prior_games"])
    for t in teams:
        for off, val in ((0, po.get(t, 0.0)), (n, pd.get(t, 0.0))):
            r = np.zeros(2 * n + 1)
            r[off + idx[t]] = k
            A.append(r)
            y.append(k * T["carry_over"] * val)
    r = np.zeros(2 * n + 1)
    r[2 * n] = math.sqrt(T["avg_games"])
    A.append(r)
    y.append(math.sqrt(T["avg_games"]) * pavg)
    for off in (0, n):  # offense and defense each average 0
        r = np.zeros(2 * n + 1)
        r[off:off + n] = 100.0 / n
        A.append(r)
        y.append(0.0)
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    return ({t: float(sol[idx[t]]) for t in teams}, {t: float(sol[n + idx[t]]) for t in teams}, float(sol[2 * n]))


def predict_score(x, margin, S):
    """(home points, away points) for game x, given the expected home margin and score_ratings() output."""
    O, D, avg = S
    total = 2 * avg + O.get(x["home"], 0) + D.get(x["away"], 0) + O.get(x["away"], 0) + D.get(x["home"], 0)
    total = max(total, abs(margin) + 6)  # the loser still scores something
    return (total + margin) / 2, (total - margin) / 2


def matchup_notes(x, R, S, games, nick, margin):
    """A few plain-English facts about this one game, for the game page's "Why" box (ranks and per-game numbers,
    no point spreads). nick: team abbr -> short name ("49ers")."""
    O, D, avg = S
    rank = lambda vals, t, low=False: 1 + sorted(vals, key=lambda k: vals[k] if low else -vals[k]).index(t)
    h, a = x["home"], x["away"]
    fav, dog = (h, a) if margin >= 0 else (a, h)  # margin: the model's expected home margin (QB changes included)
    notes = [f"Our ratings: {nick(fav)} #{rank(R, fav)}, {nick(dog)} #{rank(R, dog)}."]
    for off, de in ((fav, dog), (dog, fav)):
        orank, drank = rank(O, off), rank(D, de, low=True)  # defense: fewest points allowed = #1
        tag = "strength vs. strength" if orank <= 10 and drank <= 10 else f"edge {nick(off)}" if orank + 8 <= drank else f"edge {nick(de)}" if drank + 8 <= orank else "even"
        notes.append(f"{nick(off)} offense (#{orank}, about {avg + O[off]:.0f} points a game vs. an average defense) "
                     f"against the {nick(de)} defense (#{drank}): {tag}.")
    form = []
    for t in (fav, dog):
        last = sorted((g for g in games if g["done"] and g["week"] < x["week"] and t in (g["home"], g["away"])), key=lambda g: g["week"])[-3:]
        if last:
            res = "-".join("T" if g["hp"] == g["ap"] else "W" if (g["hp"] > g["ap"]) == (g["home"] == t) else "L" for g in reversed(last))
            form.append(f"{nick(t)} {res}")
    if form:
        notes.append(f"Last 3 games (newest first): {', '.join(form)}.")
    for t, qb in ((h, x["hqb"]), (a, x["aqb"])):
        u = usual_qb(games, t, x["week"])
        if qb and u and qb != u:
            notes.append(f"{nick(t)}: {qb} expected to start instead of {u}, which the model marks down.")
    if not x["neutral"]:
        notes.append(f"Home field: {nick(h)}, worth a little (the home edge is small in today's NFL).")
    return notes


def final_score_ratings(games, prior, T=TOTALS):
    return score_ratings(games, 99, prior, T)


def season_score_ratings(season, back=4, T=TOTALS):
    """For the weekly job: {week: score_ratings} after each played week (0 = preseason)."""
    all_games = load_games()
    prior = None
    for s in range(season - back, season):
        if all_games.get(s):
            prior = final_score_ratings(all_games[s], prior, T)
    games = all_games.get(season, [])
    last = max((x["week"] for x in games if x["done"]), default=0)
    return {w: score_ratings(games, w + 1, prior, T) for w in range(0, last + 1)}


def final_ratings(games, epa, prior_m, prior_e, P=PARAMS):
    """End-of-season (margin, efficiency) ratings, used as next season's prior."""
    _, Rm, Re = ratings(games, epa, 99, prior_m, prior_e, P)
    return Rm, Re


def qb_adjust(games, x):
    """Points to add to the home side's expected margin for backup-QB starts (game x in this module's format)."""
    adj = 0.0
    for team, qb, sign in ((x["home"], x["hqb"], 1), (x["away"], x["aqb"], -1)):
        u = usual_qb(games, team, x["week"])
        if qb and u and qb != u:
            adj -= sign * PARAMS["backup_qb"]
    return adj


def season_ratings(season, P=PARAMS, back=4):
    """For the weekly job: {week: {team abbr: rating}} after each played week (0 = preseason), plus this
    season's games in this module's format. Last season's prior is rebuilt from `back` seasons ago."""
    all_games = load_games()
    pm, pe = {}, {}
    for s in range(season - back, season):
        if all_games.get(s):
            pm, pe = final_ratings(all_games[s], load_epa(s), pm, pe, P)
    games, epa = all_games.get(season, []), load_epa(season)
    last = max((x["week"] for x in games if x["done"]), default=0)
    out = {w: ratings(games, epa, w + 1, pm, pe, P)[0] for w in range(0, last + 1)}
    return out, games


# ------------------------------------------------------------------ backtest
def backtest(P=PARAMS, seasons=range(2020, 2026), all_games=None, epas=None, quiet=False):
    all_games = all_games or load_games()
    epas = epas or {s: load_epa(s) for s in range(min(seasons) - 1, max(seasons) + 1)}
    first = min(seasons) - 1
    pm, pe = final_ratings(all_games[first], epas.get(first, {}), {}, {}, P)
    n = right = books_n = books_right = 0
    err = brier = 0.0
    for s in seasons:
        games, epa = all_games[s], epas.get(s, {})
        for w in range(1, 19):
            wk = [x for x in games if x["week"] == w and x["done"]]
            if not wk:
                continue
            R, _, _ = ratings(games, epa, w, pm, pe, P)
            for x in wk:
                m, p = predict(x, R, games, P)
                act = x["hp"] - x["ap"]
                if act == 0:
                    continue
                n += 1
                right += (m > 0) == (act > 0)
                err += abs(act - m)
                brier += (p - (act > 0)) ** 2
                if x["line"] is not None and x["line"] != 0:
                    books_n += 1
                    books_right += (x["line"] > 0) == (act > 0)
        pm, pe = final_ratings(games, epa, pm, pe, P)
    res = {"games": n, "su": right / n, "mae": err / n, "brier": brier / n, "books_su": books_right / max(1, books_n)}
    if not quiet:
        print(f"  {n} games: picked {res['su']:.1%} right (books {res['books_su']:.1%}), "
              f"avg miss {res['mae']:.2f} pts, Brier {res['brier']:.4f}")
    return res


def score_backtest(T=TOTALS, seasons=range(2020, 2026), all_games=None, epas=None, quiet=False):
    """How close the predicted scores were, every week of `seasons`, vs. the books' spread and total."""
    all_games = all_games or load_games()
    epas = epas or {s: load_epa(s) for s in range(min(seasons) - 1, max(seasons) + 1)}
    first = min(seasons) - 1
    pm, pe = final_ratings(all_games[first], epas.get(first, {}), {}, {})
    sp = final_score_ratings(all_games[first], None, T)
    rows = []
    for s in seasons:
        games, epa = all_games[s], epas.get(s, {})
        for w in range(1, 19):
            wk = [x for x in games if x["week"] == w and x["done"]]
            if not wk:
                continue
            R, _, _ = ratings(games, epa, w, pm, pe)
            S = score_ratings(games, w, sp, T)
            for x in wk:
                m, _ = predict(x, R, games)
                h, a = predict_score(x, m, S)
                rows.append((x, round(h), round(a), m, h + a))
        pm, pe = final_ratings(games, epa, pm, pe)
        sp = final_score_ratings(games, sp, T)
    n = len(rows)
    team_err = sum(abs(h - x["hp"]) + abs(a - x["ap"]) for x, h, a, _, _ in rows) / (2 * n)
    tot_err = sum(abs(t - x["hp"] - x["ap"]) for x, _, _, _, t in rows) / n
    mar_err = sum(abs(m - x["hp"] + x["ap"]) for x, _, _, m, _ in rows) / n
    within7 = sum(abs(h - x["hp"]) <= 7 and abs(a - x["ap"]) <= 7 for x, h, a, _, _ in rows) / n
    bt = [(x, t) for x, _, _, _, t in rows if x.get("total_line")]
    books_tot = sum(abs(x["total_line"] - x["hp"] - x["ap"]) for x, _ in bt) / max(1, len(bt))
    ours_tot = sum(abs(t - x["hp"] - x["ap"]) for x, t in bt) / max(1, len(bt))
    bm = [(x, m) for x, _, _, m, _ in rows if x["line"] is not None]
    books_mar = sum(abs(x["line"] - x["hp"] + x["ap"]) for x, _ in bm) / max(1, len(bm))
    ours_mar = sum(abs(m - x["hp"] + x["ap"]) for x, m in bm) / max(1, len(bm))
    res = {"games": n, "team_err": team_err, "total_err": tot_err, "margin_err": mar_err, "within7": within7,
           "books_total_err": books_tot, "ours_total_err_lined": ours_tot, "books_margin_err": books_mar, "ours_margin_err_lined": ours_mar}
    if not quiet:
        print(f"  {n} games: each team's score off by {team_err:.1f} pts on average, total off by {tot_err:.1f}, "
              f"margin off by {mar_err:.1f}; both scores within 7: {within7:.1%}")
        print(f"  books on the same games: total off by {books_tot:.1f} (ours {ours_tot:.1f}), "
              f"margin off by {books_mar:.1f} (ours {ours_mar:.1f})")
    return res


def score_search(passes=2):
    g, e = load_games(), {s: load_epa(s) for s in range(2019, 2026)}
    grid = {"pts_cap": [35, 40, 45, 60], "carry_over": [0.3, 0.5, 0.7, 0.9], "prior_games": [3, 5, 8, 12, 16],
            "avg_games": [8, 16, 32, 64, 128], "decay": [0.85, 0.9, 0.95, 1.0]}
    T = dict(TOTALS)
    best = score_backtest(T, all_games=g, epas=e, quiet=True)
    for _ in range(passes):
        for k, vals in grid.items():
            for v in vals:
                r = score_backtest({**T, k: v}, all_games=g, epas=e, quiet=True)
                if r["total_err"] < best["total_err"] - 1e-6:
                    best, T = r, {**T, k: v}
            print(f"  {k}={T[k]}: total off by {best['total_err']:.2f}, team score off by {best['team_err']:.2f}")
    print(T)


OLD = {**PARAMS, "carry_over": 0.65, "prior_games": 3, "prior_fade": 6, "decay": 1.0, "epa_blend": 0.0, "backup_qb": 0.0, "sigma": 13.5}


def search(passes=2):
    """Coordinate search: try each setting's values with the others held fixed, keep the best Brier score."""
    g, e = load_games(), {s: load_epa(s) for s in range(2019, 2026)}
    grid = {"carry_over": [0.4, 0.5, 0.6, 0.7, 0.8, 0.9], "prior_games": [2, 3, 4, 6, 9, 14], "decay": [0.85, 0.9, 0.95, 1.0],
            "epa_blend": [0.0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0], "epa_points": [60, 75, 90, 110, 130],
            "backup_qb": [0, 1.5, 3, 4.5, 6], "margin_cap": [14, 17, 21, 28, 35], "home_field": [0.5, 1.0, 1.5, 2.0, 2.5],
            "sigma": [12, 13, 14]}
    P = dict(PARAMS)
    best = backtest(P, all_games=g, epas=e, quiet=True)
    for _ in range(passes):
        for k, vals in grid.items():
            for v in vals:
                Q = {**P, k: v}
                r = backtest(Q, all_games=g, epas=e, quiet=True)
                if r["brier"] < best["brier"] - 1e-6:
                    best, P = r, Q
            print(f"  {k}={P[k]}: Brier {best['brier']:.4f}, picked {best['su']:.1%}, avg miss {best['mae']:.2f}")
    print(P)
    return best, P


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--search", action="store_true")
    ap.add_argument("--scores", action="store_true", help="grade the predicted scores")
    ap.add_argument("--score-search", action="store_true")
    a = ap.parse_args()
    if a.search:
        search()
    elif a.scores:
        score_backtest()
    elif a.score_search:
        score_search()
    else:
        print("old settings (fading prior, scores only):")
        backtest(OLD)
        print("new NFL model:")
        backtest()
