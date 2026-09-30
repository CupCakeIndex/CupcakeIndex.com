"""Power-ranking model. Pure functions: raw API data in, per-team factor scores out.

Every factor is turned into a 0-100 score (50 = average FBS team, each 16.7 points
= one standard deviation). The website blends those scores with the slider weights.
"""
from collections import defaultdict
from math import erf, sqrt

import numpy as np

FCS = "FCS"  # every non-FBS opponent is pooled into this one node
INVERTED = {"cupcake"}  # higher score = worse; the website blends these as (100 - score)

FACTORS = [
    ("power", "Power", "Opponent-adjusted scoring margin, capped so blowouts of bad teams don't count extra."),
    ("resume", "Résumé", "Strength of record: how many more wins than an average top-25 team would have with this schedule."),
    ("efficiency", "Efficiency", "Opponent-adjusted EPA/play and success rate, garbage time removed."),
    ("sos", "Schedule", "How hard was your road? The average strength of every opponent you played, no matter how good you are. Higher = tougher schedule."),
    ("recent", "Recent form", "How the team has played in its last few games."),
    ("cupcake", "Cupcake", "How much did you pad it? Only the games far below YOUR level count: FCS opponents, plus below-average teams 14+ points worse than you (bigger mismatches count more). A bad team playing other bad teams isn't padding. Higher = more padded, and it counts against the team. Only games already played count."),
    ("luck", "Bad luck", "Higher = has had bad luck: lost games they statistically won, so the record undersells them. Lower = has been winning coin flips."),
]

NFL_HELP = {
    "power": "Opponent-adjusted scoring margin, capped at 21 so garbage-time scores don't count extra.",
    "resume": "Strength of record: how many more wins than a top-8 team would have with this schedule.",
    "efficiency": "Opponent-adjusted EPA per play (offense minus defense).",
    "sos": "How hard was your road? The average strength of every opponent played. Higher = tougher schedule.",
    "luck": "Higher = has had bad luck in close games (one-score results are treated as coin flips). Lower = has been winning coin flips.",
}


def cupcake_weight(team_r, opp_r, is_fcs, cfg):
    """How much of a cupcake an opponent is FOR THIS TEAM (0-1).

    Relative, not absolute: a below-average opponent counts once they're `cupcake_gap` points worse
    than you on a neutral field, reaching 1.0 at gap + span. Bad teams playing other bad teams isn't padding.
    FCS opponents always count at least 0.5.
    """
    if "cupcake_gap" not in cfg:
        return 0.0
    w = 0.0
    if opp_r < cfg.get("cupcake_max_opp", 0.0):
        w = min(1.0, max(0.0, (team_r - opp_r - cfg["cupcake_gap"]) / cfg["cupcake_span"]))
    return max(w, 0.5) if is_fcs else w


def phi(x):
    return 0.5 * (1 + erf(x / sqrt(2)))


def g(d, *names, default=None):
    """Read the first present key (handles camelCase/snake_case API variants)."""
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


# --------------------------------------------------------------------------- games

def fbs_teams(raw_teams):
    return {g(t, "school"): t for t in raw_teams}


def normalize_games(raw_games, fbs):
    """All regular-season games involving at least one FBS team (completed or not)."""
    out = []
    for x in raw_games:
        home, away = g(x, "homeTeam", "home_team"), g(x, "awayTeam", "away_team")
        if home not in fbs and away not in fbs:
            continue
        hp, ap = g(x, "homePoints", "home_points"), g(x, "awayPoints", "away_points")
        done = bool(g(x, "completed", default=hp is not None)) and hp is not None and ap is not None
        out.append({
            "id": g(x, "id"), "week": g(x, "week"), "home": home, "away": away,
            "hnode": home if home in fbs else FCS, "anode": away if away in fbs else FCS,
            "hp": hp, "ap": ap, "done": done, "neutral": bool(g(x, "neutralSite", "neutral_site", default=False)),
            "hwp": g(x, "homePostgameWinProbability", "home_post_win_prob"),
            "start": g(x, "startDate", "start_date"),
            "espn": g(x, "espn", default=g(x, "id")),  # CFBD game ids are ESPN ids; nflverse provides them
            "hqb": g(x, "homeQB"), "aqb": g(x, "awayQB"), "hrest": g(x, "homeRest"), "arest": g(x, "awayRest"),
        })
    return out


def last_completed_week(games, done_share=0.9):
    by_week = defaultdict(list)
    for x in games:
        by_week[x["week"]].append(x["done"])
    done_weeks = [w for w, d in by_week.items() if any(d)]
    if not done_weeks:
        return 0
    w = max(done_weeks)
    if sum(by_week[w]) / len(by_week[w]) < done_share:  # week still being played
        w -= 1
    return w


# --------------------------------------------------------------------------- solver

def solve(teams, rows, fixed=None, prior=None, prior_strength=0.0, ridge=0.05):
    """Weighted least squares: rating[a] - rating[b] = value.

    rows: (a, b, value, weight). `fixed` pins nodes (e.g. FCS) to a value; any other
    node not in `teams` is solved as an extra pooled node. The FBS average is forced to 0.
    """
    fixed = fixed or {}
    nodes = list(teams) + sorted({n for a, b, _, _ in rows for n in (a, b)} - set(teams) - set(fixed))
    idx = {n: i for i, n in enumerate(nodes)}
    A, y = [], []
    for a, b, v, w in rows:
        r = np.zeros(len(nodes))
        rhs = v
        for node, sign in ((a, 1), (b, -1)):
            if node in fixed:
                rhs -= sign * fixed[node]
            else:
                r[idx[node]] += sign
        s = sqrt(w)
        A.append(r * s)
        y.append(rhs * s)
    for n in nodes:  # ridge toward prior (or 0) keeps early-season ratings sane
        r = np.zeros(len(nodes))
        k = ridge + (prior_strength if n in teams else 0)
        r[idx[n]] = sqrt(k)
        A.append(r)
        target = (prior or {}).get(n, 0.0) if n in teams else 0.0
        y.append(sqrt(k) * target * (prior_strength / k if k else 0))
    r = np.zeros(len(nodes))
    r[: len(teams)] = 100.0 / len(teams)  # mean of FBS teams = 0
    A.append(r)
    y.append(0.0)
    sol, *_ = np.linalg.lstsq(np.array(A), np.array(y), rcond=None)
    out = {n: float(sol[idx[n]]) for n in nodes}
    out.update(fixed)
    return out


def capped_margin(x, cfg):
    """Home-perspective margin: capped, then home-field removed."""
    m = max(-cfg["margin_cap"], min(cfg["margin_cap"], x["hp"] - x["ap"]))
    return m - (0 if x["neutral"] else cfg["home_field"])


def power_ratings(teams, games, cfg, prior=None, prior_strength=0.0):
    rows = []
    for x in games:
        if not x["done"]:
            continue
        w = cfg["fcs_game_weight"] if FCS in (x["hnode"], x["anode"]) else 1.0
        rows.append((x["hnode"], x["anode"], capped_margin(x, cfg), w))
    return solve(teams, rows, fixed={FCS: cfg["fcs_rating"]}, prior=prior, prior_strength=prior_strength)


def efficiency_ratings(teams, advanced, fbs, week, cfg):
    """Opponent-adjusted net PPA and net success rate (garbage time already excluded)."""
    seen, ppa_rows, sr_rows = set(), [], []
    for s in advanced:
        gid, team, opp = g(s, "gameId", "game_id"), g(s, "team"), g(s, "opponent")
        if gid in seen or team not in fbs or (g(s, "week") or 0) > week:
            continue
        o, d = g(s, "offense", default={}), g(s, "defense", default={})
        if g(o, "ppa") is None or g(d, "ppa") is None:
            continue
        seen.add(gid)
        onode = opp if opp in fbs else FCS
        w = cfg["fcs_game_weight"] if onode == FCS else 1.0
        ppa_rows.append((team, onode, o["ppa"] - d["ppa"], w))
        sr_rows.append((team, onode, g(o, "successRate", "success_rate", default=0) - g(d, "successRate", "success_rate", default=0), w))
    if not ppa_rows:
        return {}, {}
    return solve(teams, ppa_rows, ridge=0.5), solve(teams, sr_rows, ridge=0.5)


# --------------------------------------------------------------------------- prior

def preseason_prior(teams, prev_ratings, talent, returning):
    """Starting guess: last year's rating (scaled by returning production) + roster talent."""
    tal = {g(t, "team", "school"): g(t, "talent") for t in talent}
    tal = {k: float(v) for k, v in tal.items() if v is not None}
    ret = {g(r, "team"): g(r, "percentPPA", "percent_ppa") for r in returning}
    tv = [tal[t] for t in teams if t in tal]
    mu, sd = (np.mean(tv), np.std(tv) or 1.0) if tv else (0, 1)
    prior = {}
    for t in teams:
        prev = prev_ratings.get(t, -10.0)  # new to FBS: assume below average
        r = ret.get(t)
        r = 0.5 if r is None else max(0.0, min(1.0, float(r)))
        prior[t] = prev * (0.3 + 0.7 * r) + (3.0 * (tal[t] - mu) / sd if t in tal else 0.0)
    m = np.mean(list(prior.values()))
    return {t: v - m for t, v in prior.items()}


def prior_strength(week, cfg):
    fade = cfg["prior_fade_week"]
    return cfg["prior_games"] * max(0.0, (fade - week) / (fade - 1))


# --------------------------------------------------------------------------- polls

def ap_ranks(polls, week):
    """AP poll released after `week`'s games (CFBD labels it week+1)."""
    best, best_week = {}, -1
    for pw in polls:
        pwk = g(pw, "week", default=0)
        if pwk > week + 1 or pwk <= best_week:
            continue
        for p in g(pw, "polls", default=[]):
            if "AP" in (g(p, "poll") or ""):
                best = {g(r, "school"): g(r, "rank") for r in g(p, "ranks", default=[])}
                best_week = pwk
    return best


# --------------------------------------------------------------------------- build

def to_scores(raw):
    vals = np.array(list(raw.values()), dtype=float)
    mu, sd = vals.mean(), vals.std() or 1.0
    return {t: round(float(np.clip(50 + 50 / 3 * (v - mu) / sd, 0, 100)), 1) for t, v in raw.items()}


def build_week(fbs, games, advanced, polls, week, cfg, prior):
    teams = sorted(fbs)
    played = [x for x in games if x["done"] and x["week"] <= week]
    k = prior_strength(week, cfg)
    R = power_ratings(teams, played, cfg, prior, k)
    rank = {t: i + 1 for i, t in enumerate(sorted(teams, key=lambda t: -R[t]))}
    ppa, sr = efficiency_ratings(teams, advanced, fbs, week, cfg)
    bench_rank = min(cfg.get("benchmark_rank", 25), len(teams)) - 1
    bench = R[sorted(teams, key=lambda t: -R[t])[bench_rank]]  # e.g. the #25 CFB team's rating
    ap = ap_ranks(polls, week)

    raw = {f: {} for f, _, _ in FACTORS}
    detail = {}
    for t in teams:
        sched, perfs = [], []
        wins = losses = fcs_n = weak_n = os_w = os_l = 0
        xw = sor = cup_sum = 0.0
        opp_ratings = []
        for x in sorted((x for x in games if t in (x["home"], x["away"])), key=lambda x: (x["week"], x["start"] or "")):
            home = x["home"] == t
            opp, onode = (x["away"], x["anode"]) if home else (x["home"], x["hnode"])
            loc = "N" if x["neutral"] else ("H" if home else "A")
            loc_pts = 0 if x["neutral"] else (cfg["home_field"] if home else -cfg["home_field"])
            ro = R[onode]
            row = {"week": x["week"], "opp": opp, "fcs": onode == FCS, "loc": loc, "espn_id": x["espn"],
                   "opp_rank": rank.get(onode), "opp_rating": round(ro, 1)}
            cw = cupcake_weight(R[t], ro, onode == FCS, cfg)
            row["cupcake"] = cw > 0
            qb = x["hqb"] if home else x["aqb"]
            if qb:
                row["qb"] = qb
            rest, orest = (x["hrest"], x["arest"]) if home else (x["arest"], x["hrest"])
            if rest is not None and orest is not None and rest != orest:
                row["rest_diff"] = int(rest - orest)  # + = extra rest vs. opponent
            if x["done"] and x["week"] <= week:
                us, them = (x["hp"], x["ap"]) if home else (x["ap"], x["hp"])
                won = us > them
                m = max(-cfg["margin_cap"], min(cfg["margin_cap"], us - them)) - loc_pts
                perf = ro + m
                p25 = phi((bench - ro + loc_pts) / cfg["game_sigma"])  # chance a top-25 team wins it
                wins += won
                losses += not won
                sor += (1 - p25) if won else -p25
                wp = x["hwp"] if home else (1 - x["hwp"] if x["hwp"] is not None else None)
                xw += float(wp) if wp is not None else phi((us - them) / 7)
                if abs(us - them) <= cfg["one_score"]:
                    os_w += won
                    os_l += not won
                if onode == FCS:
                    fcs_n += 1
                elif cw > 0:
                    weak_n += 1
                cup_sum += cw
                opp_ratings.append(ro)
                perfs.append(perf)
                row.update(score=f"{us}-{them}", result="W" if won else "L", perf=round(perf, 1),
                           difficulty=round(1 - p25, 2))
            else:
                spread = (R[t] - ro + loc_pts) * cfg.get("spread_scale", 1.0)
                row.update(upcoming=True, spread=round(spread, 1), win_prob=round(phi(spread / cfg["game_sigma"]), 2))
            sched.append(row)
        n = wins + losses
        raw["power"][t] = R[t]
        raw["resume"][t] = sor
        raw["efficiency"][t] = (0.7 * ppa.get(t, 0) / (np.std(list(ppa.values())) or 1)
                                + 0.3 * sr.get(t, 0) / (np.std(list(sr.values())) or 1)) if ppa else R[t]
        raw["sos"][t] = float(np.mean(opp_ratings)) if opp_ratings else 0.0
        raw["recent"][t] = float(np.mean(perfs[-cfg["recent_games"]:])) if perfs else R[t]
        raw["cupcake"][t] = cup_sum / n if n else 0.0
        raw["luck"][t] = -(wins - xw)
        qbs = [r["qb"] for r in sched if r.get("qb") and "result" in r]
        nxt = next((r for r in sched if r.get("upcoming")), None)
        detail[t] = {
            "usual_qb": max(set(qbs), key=qbs.count) if qbs else None,
            "next_qb": nxt.get("qb") if nxt else None,
            "record": f"{wins}-{losses}", "wins": wins, "losses": losses,
            "one_score": f"{os_w}-{os_l}", "luck_wins": round(wins - xw, 2),
            "fcs_games": fcs_n, "weak_games": weak_n, "schedule": sched,
        }

    scores = {f: to_scores(v) for f, v in raw.items()}
    out = []
    for t in teams:
        info = fbs[t]
        logos = g(info, "logos", default=[]) or []
        out.append({
            "team": t, "id": g(info, "id") if not g(info, "abbr") else None,  # CFBD team ids are ESPN ids
            "conference": g(info, "conference"), "color": g(info, "color"),
            "logo": logos[0] if logos else None, "rating": round(R[t], 2), "power_rank": rank[t],
            "ap_rank": ap.get(t), "prior": round(prior.get(t, 0), 1) if prior else None,
            "scores": {f: scores[f][t] for f in scores},
            "raw": {f: round(raw[f][t], 3) for f in raw},
            **detail[t],
        })
    return {"week": week, "prior_weight": round(k, 2), "teams": out, "ratings": R}


def lines_by_game(raw_lines):
    """{game id: [book lines]}. CFBD spreads are from the home side: -7 = home favored by 7."""
    out = {}
    for x in raw_lines:
        books = [{"book": g(l, "provider"), "spread": float(l["spread"]),
                  "open": g(l, "spreadOpen", "spread_open"), "total": g(l, "overUnder", "over_under"),
                  "home_ml": g(l, "homeMoneyline", "home_moneyline"), "away_ml": g(l, "awayMoneyline", "away_moneyline")}
                 for l in g(x, "lines", default=[]) if g(l, "spread") is not None]
        if books:
            out[g(x, "id")] = books
    return out


def cupcake_of_week(games, ratings, week, cfg):
    """The team that beat up the most on the biggest cupcake this week.

    Eligible: a win by 21+ (cotw_min_margin) over an opponent that is a cupcake for the winner (see cupcake_weight).
    Score = margin of victory + how far below an average FBS team the opponent is.
    """
    fbs = [t for t in ratings if t != FCS]
    rank = {t: i + 1 for i, t in enumerate(sorted(fbs, key=lambda t: -ratings[t]))}
    best = None
    for x in games:
        if not x["done"] or x["week"] != week:
            continue
        for home in (True, False):
            t, o = (x["hnode"], x["anode"]) if home else (x["anode"], x["hnode"])
            us, them = (x["hp"], x["ap"]) if home else (x["ap"], x["hp"])
            if t == FCS or us - them < cfg.get("cotw_min_margin", 21) or not cupcake_weight(ratings[t], ratings[o], o == FCS, cfg):
                continue
            score = (us - them) - ratings[o]
            if best is None or score > best["score"]:
                best = {"week": week, "team": t, "opp": x["away"] if home else x["home"], "fcs": o == FCS,
                        "opp_rank": rank.get(o), "score_line": f"{us}-{them}", "margin": us - them,
                        "score": round(score, 1), "espn_id": x["espn"]}
    return best


def predictions(games, ratings, week, cfg, lines=None):
    """Model picks for week+1 games vs. the sportsbooks, graded if they've been played.

    `spread` / `vegas` are expected home margins (positive = home favored).
    `edge` = model minus Vegas: positive means the model likes the home side more than the books do.
    """
    out = []
    for x in games:
        if x["week"] != week + 1:
            continue
        spread = (ratings[x["hnode"]] - ratings[x["anode"]] + (0 if x["neutral"] else cfg["home_field"])) * cfg.get("spread_scale", 1.0)
        p = {"week": x["week"], "home": x["home"], "away": x["away"], "espn_id": x["espn"], "spread": round(spread, 1),
             "home_win_prob": round(phi(spread / cfg["game_sigma"]), 3),
             "pick": x["home"] if spread >= 0 else x["away"]}
        if x["hqb"] or x["aqb"]:
            p.update(home_qb=x["hqb"], away_qb=x["aqb"])
        books = (lines or {}).get(x["id"])
        if books:
            vegas = -float(np.median([b["spread"] for b in books]))
            edge = spread - vegas
            ats_home = edge > 0
            # best number for the model's side: most points when taking home, fewest when laying with away
            best = max(books, key=lambda b: b["spread"]) if ats_home else min(books, key=lambda b: b["spread"])
            p.update(books=books, vegas=round(vegas, 1), edge=round(edge, 1),
                     ats_pick=x["home"] if ats_home else x["away"], best_book=best["book"],
                     best_line=best["spread"] if ats_home else -best["spread"])
        if x["done"]:
            actual = x["hp"] - x["ap"]
            p.update(actual=actual, correct=(actual > 0) == (spread >= 0) if actual != 0 else None,
                     error=round(abs(actual - spread), 1))
            if books:
                cover = actual - p["vegas"]  # home margin beyond the line
                p.update(vegas_correct=(actual > 0) == (p["vegas"] > 0) if actual and p["vegas"] else None,
                         ats_correct=None if cover == 0 or p["edge"] == 0 else (cover > 0) == (p["edge"] > 0))
        out.append(p)
    return out
