"""College player projections: our own model (ESPN's fantasy projections only cover the NFL).

    python src/cfb_projections.py --season 2026            # write docs/data/cfb/2026/projections.json
    python src/cfb_projections.py --season 2026 --offline  # cached box scores only
    python src/cfb_projections.py --backtest               # accuracy check on past weeks (see backtest())

How it works, for each QB/RB/WR/TE:
  1. Every past game's stat line is opponent-adjusted: divided by how generous that defense is
     (its opponent-adjusted pass yards / rush yards / points allowed relative to an average FBS defense,
     so 300 yards against a sieve or an FCS team counts for less than 300 against a top defense).
  2. Baseline = recency-weighted average of those adjusted games, shrunk toward the player's own
     opponent-adjusted rate from last season (if he has one) so a couple of fluky games don't swing it.
  3. This week's projection = baseline x this opponent's defense factor x home/away x game script
     (our model's expected margin: favorites run more and pass less, and big favorites rest starters).
     Players who sat out their team's last game, or a QB who lost the job, are scaled down.

Data: ESPN's public scoreboard + box scores (no key), cached in data/raw/espn_cfb/<season>/;
our model's expected margins come from docs/data/cfb/<season>/week_N.json.
"""
import argparse
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "raw" / "espn_cfb"
OUT = ROOT / "docs" / "data" / "cfb"
SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
FBS_CONF = {"1", "4", "5", "8", "9", "12", "15", "17", "18", "37", "151"}  # ESPN conference ids (18 = FBS independents)

STATS = ["py", "ptd", "int", "ry", "rtd", "rec", "recy", "rectd"]
# Standard PPR: 1 pt per 25 pass yds, 4 per pass TD, -2 per INT, 1 per 10 rush/rec yds, 6 per TD, 1 per catch
PPR = {"py": 0.04, "ptd": 4, "int": -2, "ry": 0.1, "rtd": 6, "rec": 1, "recy": 0.1, "rectd": 6}
# Which defense factor adjusts each stat: P = pass yards allowed, R = rush yards allowed, S = points allowed
CAT = {"py": "P", "ptd": "S", "int": None, "ry": "R", "rtd": "S", "rec": "P", "recy": "P", "rectd": "S"}
# Opportunity behind each stat (efficiency = stat per opportunity); g = per game (volume only)
OPP = {"py": "pa", "ptd": "pa", "int": "pa", "ry": "ra", "rtd": "ra", "rec": "g", "recy": "rec", "rectd": "rec"}
VOL = ["pa", "ra", "rec", "g"]
KOPP = {"pa": 60, "ra": 25, "rec": 10}  # x kprior: how many attempts/carries/catches the prior efficiency is worth
POS_MAP = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE"}

# Tuned lightly on 2025 weeks 5-14 (coordinate search, coarse grids); 2026 weeks 3-4 held out as a check.
PARAMS = {
    "alpha": 0.75,   # strength of the opponent adjustment (0 = ignore the defense, 1 = full ratio)
    "lam": 0.85,     # recency: each older game counts this much of the next newer one
    "kprior": 2.0,   # scales KOPP: how hard efficiency is pulled toward last season / the position average
    "beta": 0.03,    # game script: pass x exp(-beta*margin/7), rush x exp(+beta*margin/7)
    "blow": 0.1,     # big favorites (14+ pts) lose up to 10% as starters sit late
    "home": 0.03,    # home +3%, road -3%
    "miss": 0.75,    # x this per team game missed in a row (injury/benched); 3+ straight = not listed
    "backup": 0.6,   # QB who wasn't his team's leading passer last game
    "kdef": 1.5,     # defense factors are shrunk toward average by this many games
    "lo": 0.55, "hi": 1.7,  # cap on the combined matchup multiplier
}

_session = requests.Session()


def _get(url):
    for attempt in range(4):
        try:
            r = _session.get(url, timeout=30)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"ESPN fetch failed: {url}")


def _cached(path, url, refresh, keep=lambda d: True):
    """JSON from cache, else ESPN. refresh=False never touches the network for a cached file."""
    if path.exists() and not (refresh and not keep(json.loads(path.read_text(encoding="utf-8")))):
        return json.loads(path.read_text(encoding="utf-8"))
    if refresh is None:  # offline
        return None
    data = _get(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return data


# ---------------------------------------------------------------- data
def scoreboard(season, week, refresh):
    """FBS games of one regular-season week: [{id, week, done, teams: [{id, abbr, home, pts, fbs}]}]."""
    def reduce(d):
        out = []
        for e in d.get("events", []):
            c = e["competitions"][0]
            out.append({"id": e["id"], "week": week, "done": bool(c["status"]["type"]["completed"]),
                        "teams": [{"id": x["team"]["id"], "abbr": x["team"].get("abbreviation", ""),
                                   "home": x["homeAway"] == "home", "pts": int(x["score"]) if x.get("score") not in (None, "") else None,
                                   "fbs": str(x["team"].get("conferenceId", "")) in FBS_CONF} for x in c["competitors"]]})
        return out
    path = CACHE / str(season) / f"sb_{week}.json"
    url = f"{SITE}/scoreboard?week={week}&groups=80&limit=400&dates={season}&seasontype=2"
    if path.exists() and (refresh is not True or all(g["done"] for g in json.loads(path.read_text(encoding="utf-8")))):
        return json.loads(path.read_text(encoding="utf-8"))
    if refresh is None:
        return []
    games = reduce(_get(url))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(games, separators=(",", ":")), encoding="utf-8")
    return games


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def box(season, gid, refresh):
    """One finished game's skill-player lines: {team id: {athlete id: {n, stats...}}}. Cached forever."""
    path = CACHE / str(season) / "box" / f"{gid}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    if refresh is None:
        return None
    d = _get(f"{SITE}/summary?event={gid}")
    out = {}
    for tm in d.get("boxscore", {}).get("players", []):
        rows = out.setdefault(str(tm["team"]["id"]), {})
        for s in tm.get("statistics", []):
            keys = s.get("keys", [])
            for a in s.get("athletes", []):
                v = dict(zip(keys, a.get("stats", [])))
                r = rows.setdefault(a["athlete"]["id"], {"n": a["athlete"].get("displayName", "")})
                if s["name"] == "passing":
                    r.update(pa=_num(str(v.get("completions/passingAttempts", "0/0")).split("/")[-1]), py=_num(v.get("passingYards")),
                             ptd=_num(v.get("passingTouchdowns")), int=_num(v.get("interceptions")))
                elif s["name"] == "rushing":
                    r.update(ra=_num(v.get("rushingAttempts")), ry=_num(v.get("rushingYards")), rtd=_num(v.get("rushingTouchdowns")))
                elif s["name"] == "receiving":
                    r.update(rec=_num(v.get("receptions")), recy=_num(v.get("receivingYards")), rectd=_num(v.get("receivingTouchdowns")))
        for aid in [k for k, r in rows.items() if len(r) == 1]:  # defense/special teams only
            del rows[aid]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    return out


def load_season(season, last_week, refresh):
    """Finished games of weeks 1..last_week with their box scores attached (fetched in parallel)."""
    games = [g for w in range(1, last_week + 1) for g in scoreboard(season, w, refresh) if g["done"]]
    with ThreadPoolExecutor(8) as ex:
        boxes = list(ex.map(lambda g: box(season, g["id"], refresh), games))
    for g, b in zip(games, boxes):
        g["box"] = b
    return [g for g in games if g["box"]]


def rosters(season, team_ids, refresh):
    """ESPN roster positions {athlete id: QB/RB/WR/TE} (current rosters; older seasons fall back to stats)."""
    def one(tid):
        d = _cached(CACHE / str(season) / "roster" / f"{tid}.json", f"{SITE}/teams/{tid}/roster", refresh)
        pos = {}
        for grp in (d or {}).get("athletes", []):
            for a in grp.get("items", []):
                p = POS_MAP.get((a.get("position") or {}).get("abbreviation", ""))
                if p:
                    pos[a["id"]] = p
        return pos
    out = {}
    with ThreadPoolExecutor(8) as ex:
        for pos in ex.map(lambda t: one(t) if refresh is not None or (CACHE / str(season) / "roster" / f"{t}.json").exists() else {}, sorted(team_ids)):
            out.update(pos)
    return out


def margins(season, week, src=None):
    """Our model's expected margin for each team in `week` (None = every upcoming week), from week `src`'s file
    (default: the previous week's): {espn game id: {team name: margin}}."""
    f = OUT / str(season) / f"week_{week - 1 if src is None else src}.json"
    if not f.exists():
        return {}
    out = {}
    for t in json.loads(f.read_text(encoding="utf-8"))["teams"]:
        for s in t.get("schedule", []):
            if (week is None or s.get("week") == week) and s.get("espn_id") and s.get("spread") is not None:
                out.setdefault(str(s["espn_id"]), {})[str(t["id"])] = s["spread"]
    return out


# ---------------------------------------------------------------- model
def team_games(games):
    """One row per team per game: offense, defense, home, and what the offense produced (P, R, S)."""
    rows = []
    for g in games:
        a, b = g["teams"]
        for t, o in ((a, b), (b, a)):
            lines = g["box"].get(t["id"], {}).values()
            rows.append({"off": t["id"], "def": o["id"], "home": t["home"], "fbs_off": t["fbs"], "fbs_def": o["fbs"],
                         "P": sum(r.get("py", 0) for r in lines), "R": sum(r.get("ry", 0) for r in lines), "S": t["pts"] or 0})
    return rows


def defense_factors(games, P=PARAMS):
    """Opponent-adjusted 'how much does this defense give up' factors, 1.0 = average FBS defense.
    Alternating fit of  produced = mu * offense[team] * defense[opponent];  FCS teams shrink toward
    the pooled FCS factor instead of 1.0 (we mostly see them once, against an FBS team)."""
    rows = team_games(games)
    out = {}
    for c in "PRS":
        base = [r[c] for r in rows if r["fbs_off"] and r["fbs_def"]]
        mu = sum(base) / max(1, len(base))
        off, de = {}, {}
        for _ in range(12):
            for side, other, fac, oth in (("def", "off", de, off), ("off", "def", off, de)):
                sums, ns, pool, pn = {}, {}, 0.0, 0
                for r in rows:
                    v = r[c] / (mu * oth.get(r[other], 1.0))
                    sums[r[side]] = sums.get(r[side], 0) + v
                    ns[r[side]] = ns.get(r[side], 0) + 1
                    if not r[f"fbs_{side}"]:
                        pool, pn = pool + v, pn + 1
                fcs = pool / pn if pn else 1.0
                fbs_ids = {r[side] for r in rows if r[f"fbs_{side}"]}
                for t in sums:
                    prior = 1.0 if t in fbs_ids else fcs
                    fac[t] = (sums[t] + P["kdef"] * prior) / (ns[t] + P["kdef"])
                m = sum(fac[t] for t in fbs_ids) / max(1, len(fbs_ids))
                for t in fac:
                    fac[t] /= m
                fac["_fcs"] = fcs / m
        out[c] = {"mu": mu, "def": de, "off": off}
    return out


def _dfac(D, c, opp, fbs):
    if c is None:
        return 1.0
    d = D[c]["def"]
    return d.get(opp, 1.0 if fbs else d.get("_fcs", 1.3))


def player_games(games, pos_known):
    """{athlete id: {name, team, pos, games: [(week, opp, opp fbs, home, line)]}} plus each team's game order."""
    players, team_order = {}, {}
    for g in sorted(games, key=lambda g: g["week"]):
        a, b = g["teams"]
        for t, o in ((a, b), (b, a)):
            team_order.setdefault(t["id"], []).append(g["id"])
            lines = g["box"].get(t["id"], {})
            top_pa = max((r.get("pa", 0) for r in lines.values()), default=0)
            for aid, r in lines.items():
                p = players.setdefault(aid, {"n": r["n"], "t": t["id"], "games": []})
                p["t"], p["n"] = t["id"], r["n"]  # latest team (transfers mid-year are rare)
                p["games"].append({"gid": g["id"], "week": g["week"], "opp": o["id"], "ofbs": o["fbs"], "home": t["home"],
                                   "starter_qb": r.get("pa", 0) > 0 and r.get("pa", 0) == top_pa, **{k: r.get(k, 0) for k in STATS + ["pa", "ra"]}})
    for aid, p in players.items():
        p["pos"] = pos_known.get(aid) or _infer_pos(p["games"])
    return players, team_order


def _infer_pos(gs):
    n = len(gs)
    pa, ra, rec = (sum(x[k] for x in gs) / n for k in ("pa", "ra", "rec"))
    return "QB" if pa >= 4 else "RB" if ra > rec else "WR"


def totals(p, D, P=PARAMS):
    """Recency-weighted sums over a player's games: opponent-adjusted stats (Y) and opportunities (O).
    O: pass attempts, carries, catches, games. Stats are divided by the defense factor of that game
    (and home/road), so production against weak defenses counts for less."""
    Y, O = {k: 0.0 for k in STATS}, {k: 0.0 for k in VOL}
    for i, x in enumerate(reversed(p["games"])):
        w = P["lam"] ** i
        h = 1 + (P["home"] if x["home"] else -P["home"])
        for k in STATS:
            f = (_dfac(D, CAT[k], x["opp"], x["ofbs"]) ** P["alpha"]) * h if CAT[k] else 1.0
            Y[k] += w * x[k] / f
        for k in VOL:
            O[k] += w * (1 if k == "g" else x[k])
    return Y, O


def season_rates(games, pos_known, P=PARAMS):
    """Last season's opponent-adjusted totals per player (the prior): {id: (Y, O)}, unweighted."""
    D = defense_factors(games, P)
    players, _ = player_games(games, pos_known)
    flat = dict(P, lam=1.0)
    return {aid: totals(p, D, flat) for aid, p in players.items()}


def project(games, matchups, pos_known, prior=None, P=PARAMS, naive=False, D=None):
    """Projections for the coming week.
    matchups: {team id: {opp, ofbs, home, margin}} for the week being projected.
    prior: last season's {id: (Y, O)}.  naive=True gives the comparison baseline: plain season average.

    projection = volume x efficiency x matchup.  Volume (attempts, carries, catches per game) comes from
    this season only, recency-weighted. Efficiency (yards/TDs per attempt, carry or catch) is shrunk toward
    the player's own rate last season, which is itself shrunk toward the position average: a backup with
    20 throws doesn't keep a fluky 11 yards an attempt, and last year's role doesn't cap this year's volume."""
    D = D or defense_factors(games, P)
    players, team_order = player_games(games, pos_known)
    # position-average efficiency this season (opponent-adjusted)
    pos_eff = {}
    for p in players.values():
        Y, O = totals(p, D, dict(P, lam=1.0))
        acc = pos_eff.setdefault(p["pos"], [{k: 0.0 for k in STATS}, {k: 0.0 for k in VOL}])
        for k in STATS:
            acc[0][k] += Y[k]
        for k in VOL:
            acc[1][k] += O[k]
    out = {}
    for aid, p in players.items():
        m = matchups.get(p["t"])
        if not m or p["pos"] not in ("QB", "RB", "WR", "TE"):
            continue
        if naive:
            n = len(p["games"])
            proj = {k: sum(x[k] for x in p["games"]) / n for k in STATS}
        else:
            Y, O = totals(p, D, P)
            PY, PO = pos_eff[p["pos"]]
            pr = (prior or {}).get(aid)
            r = {}
            for k in STATS:
                o = OPP[k]
                if o == "g":  # catches: pure volume
                    r[k] = Y[k] / O["g"]
                    continue
                e_pos = PY[k] / PO[o] if PO[o] else 0.0
                K = max(1e-6, P["kprior"] * KOPP[o])
                e_prev = (pr[0][k] + K * e_pos) / (pr[1][o] + K) if pr else e_pos
                e = (Y[k] + K * e_prev) / (O[o] + K)
                r[k] = O[o] / O["g"] * e
            # sat out recent team games -> probably hurt or benched
            order = team_order.get(p["t"], [])
            missed = len(order) - 1 - order.index(p["games"][-1]["gid"]) if p["games"][-1]["gid"] in order else 0
            if missed >= 3:
                continue
            avail = P["miss"] ** missed
            if p["pos"] == "QB" and not missed and not p["games"][-1]["starter_qb"]:
                avail *= P["backup"]
            mg = m.get("margin") or 0.0
            h = 1 + (P["home"] if m["home"] else -P["home"])
            blow = 1 - P["blow"] * min(1.0, max(0.0, (mg - 14) / 21))
            script = {"P": math.exp(-P["beta"] * mg / 7), "R": math.exp(P["beta"] * mg / 7), "S": 1.0, None: math.exp(-P["beta"] * mg / 7)}
            proj = {}
            for k in STATS:
                c = CAT[k]
                f = (_dfac(D, c, m["opp"], m["ofbs"]) ** P["alpha"] if c else 1.0) * h * script[c]
                proj[k] = r[k] * min(P["hi"], max(P["lo"], f)) * blow * avail
        proj["pts"] = sum(PPR[k] * proj[k] for k in STATS)
        out[aid] = {"n": p["n"], "pos": p["pos"], "t": p["t"], "g": len(p["games"]), **proj}
    return out, D


def matchups_for(season, week, refresh, mg=None):
    """{team id: {opp, ofbs, home, margin, abbr, oabbr}} for the week's games (margin from our model, may be missing)."""
    mg = margins(season, week) if mg is None else mg
    out = {}
    for g in scoreboard(season, week, refresh):
        a, b = g["teams"]
        for t, o in ((a, b), (b, a)):
            out[t["id"]] = {"opp": o["id"], "ofbs": o["fbs"], "home": t["home"], "abbr": t["abbr"], "oabbr": o["abbr"],
                            "gid": g["id"], "margin": mg.get(g["id"], {}).get(t["id"]), "done": g["done"]}
    return out


# ---------------------------------------------------------------- weekly build
def build(season, last_week, offline=False, path=None):
    """Write projections for week last_week + 1. Never raises on a network problem: keeps the old file."""
    refresh = None if offline else True
    week = last_week + 1
    games = load_season(season, last_week, refresh)
    if not games:
        print("  projections: no box scores (offline with an empty cache?) - skipped")
        return None
    mu = matchups_for(season, week, refresh)
    if not mu:
        print(f"  projections: no week {week} schedule - skipped")
        return None
    ids = {t["id"] for g in games for t in g["teams"] if t["fbs"]}
    pos = rosters(season, ids, refresh)
    prior = load_prior(season - 1, refresh)
    proj, D = project(games, mu, pos, prior)
    rows = []
    for aid, r in proj.items():
        if r["pts"] < 1.0 or not mu[r["t"]]["opp"]:
            continue
        m = mu[r["t"]]
        rows.append({"id": aid, "n": r["n"], "pos": r["pos"], "t": r["t"], "ta": m["abbr"], "o": m["opp"], "oa": m["oabbr"], "h": int(m["home"]),
                     "g": r["g"], **{k: round(r[k], 2 if k in ("ptd", "int", "rtd", "rectd", "rec") else 1) for k in STATS}, "pts": round(r["pts"], 1)})
    rows.sort(key=lambda r: -r["pts"])
    data = {"season": season, "week": week, "through": last_week, "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
            "players": rows}
    path = path or OUT / str(season) / "projections.json"
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"  projections: {len(rows)} players for week {week} -> {path.relative_to(ROOT)}")
    season_pace(season, last_week, games, pos, prior, D, refresh)
    return data


# ---------------------------------------------------------------- season pace
LAST_WEEK = 16  # regular season incl. conference title games and Army-Navy (unknown matchups are skipped)


def season_pace(season, last_week, games, pos_known, prior, D, refresh, P=PARAMS):
    """Season pace (Stats > Projected > Season pace, player pages): each player's real totals so far plus our
    projection for every remaining regular-season game: that opponent's defense, home/away and our model's
    expected margin, so a soft back half pushes the pace up and a tough one pulls it down.
    Writes docs/data/cfb/<season>/pace.json."""
    mg = margins(season, None, src=last_week)  # the newest rankings file has a margin for every upcoming game
    players, _ = player_games(games, pos_known)
    abbr = {t["id"]: t["abbr"] for g in games for t in g["teams"]}
    rest, left = {}, {}
    for w in range(last_week + 1, LAST_WEEK + 1):
        mu = {t: m for t, m in matchups_for(season, w, refresh, mg).items() if not m["done"] and m["opp"]}
        if not mu:
            continue
        for t in mu:
            left[t] = left.get(t, 0) + 1
        proj, _ = project(games, mu, pos_known, prior, P, D=D)
        for aid, r in proj.items():
            acc = rest.setdefault(aid, {k: 0.0 for k in STATS})
            for k in STATS:
                acc[k] += r[k]
    rows = []
    for aid, p in players.items():
        if p["pos"] not in ("QB", "RB", "WR", "TE"):
            continue
        so = {k: sum(x[k] for x in p["games"]) for k in STATS}
        tot = {k: so[k] + rest.get(aid, {}).get(k, 0.0) for k in STATS}
        pts = sum(PPR[k] * tot[k] for k in STATS)
        if pts < 20:
            continue
        rows.append({"id": aid, "n": p["n"], "pos": p["pos"], "t": p["t"], "ta": abbr.get(p["t"], ""), "g": len(p["games"]),
                     "gl": left.get(p["t"], 0), "so": {k: round(v) for k, v in so.items()}, **{k: round(v, 1) for k, v in tot.items()}, "pts": round(pts, 1),
                     "spts": round(sum(PPR[k] * so[k] for k in STATS), 1)})
    rows.sort(key=lambda r: -r["pts"])
    data = {"season": season, "through": last_week, "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "players": rows}
    path = OUT / str(season) / "pace.json"
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"  season pace: {len(rows)} players -> {path.relative_to(ROOT)}")
    return data


def load_prior(season, refresh):
    """Last season's per-player rates, saved small in data/raw so later runs don't refetch ~850 box scores."""
    f = CACHE / str(season) / "player_rates.json"
    if f.exists():
        return {k: tuple(v) for k, v in json.loads(f.read_text(encoding="utf-8")).items()}
    games = load_season(season, 15, refresh if refresh is None else False)  # finished season: cache is final
    if not games:
        return {}
    pr = season_rates(games, {})
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({k: [{s: round(x, 1) for s, x in d.items()} for d in v] for k, v in pr.items()}, separators=(",", ":")), encoding="utf-8")
    return pr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=datetime.now().year if datetime.now().month >= 8 else datetime.now().year - 1)
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    weeks = sorted(int(f.stem.split("_")[1]) for f in (OUT / str(a.season)).glob("week_*.json"))
    build(a.season, weeks[-1] if weeks else 0, a.offline)


if __name__ == "__main__":
    main()
