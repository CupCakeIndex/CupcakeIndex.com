"""Trade watch: NFL players most likely to be traded before the deadline, and the teams they'd fit.

How it works (all from free data we already use, plus ESPN's contract records):
  1. Playoff chances: 10,000 simulations of the rest of the season from our model's win chances (the latest rankings
     file), seeding 4 division winners + 3 wild cards per conference. Teams with a low chance are sellers.
  2. Candidates: everyone who plays a real role (35%+ of his side's snaps) on a team with a playoff chance under 45%.
  3. Contract (ESPN): the year he's signed through and this season's salary. Expiring deals get moved; long new ones don't.
  4. Trade score = seller x contract x age x role x worth (QBs and running backs rarely move mid-season, so they count less).
     Rebuilding teams sell veterans on short deals and keep young players.
  5. Best fits: contenders (playoff chance 35-97%) whose unit at his position ranks low (our play-by-play numbers), best first.

Writes docs/data/nfl/trade_watch.json. Usage: python src/trade_watch.py [--no-contracts]
"""
import datetime as dt
import glob
import json
import os
import random
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs", "data")
OUT = os.path.join(DOCS, "nfl", "trade_watch.json")
DEADLINE = "2026-11-10"  # NFL 2026-27 calendar: Tuesday after Week 9, 4 p.m. ET
SIMS = 10000
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com)"}

# which team unit a position plays in, and how we measure that unit (lower rank = bigger need)
UNIT = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "WR", "OL": "OL", "EDGE": "RUSH", "IDL": "RUSH", "LB": "RUND", "CB": "COV", "S": "COV"}
UNIT_TXT = {"QB": "passing offense", "RB": "run game", "WR": "passing offense", "OL": "pass protection",
            "RUSH": "pass rush", "RUND": "run defense", "COV": "pass defense"}
DEFENSE = {"EDGE", "IDL", "LB", "CB", "S"}


def latest_week(season):
    files = glob.glob(os.path.join(DOCS, "nfl", str(season), "week_*.json"))
    return max(files, key=lambda p: int(re.findall(r"(\d+)\.json", p)[0]))


def playoff_chances(teams):
    """{team name: chance} from SIMS runs of the remaining games (our model's win chance for each)."""
    games, seen = [], set()
    for t in teams:
        for g in t["schedule"]:
            if g.get("upcoming") and g.get("win_prob") is not None and g["espn_id"] not in seen:
                seen.add(g["espn_id"])
                games.append((t["team"], g["opp"], g["win_prob"]))
    names = [t["team"] for t in teams]
    conf = {t["team"]: t["conference"].split()[0] for t in teams}
    div = {t["team"]: t["conference"] for t in teams}
    w0 = {t["team"]: t["wins"] + 0.5 * t.get("ties", 0) for t in teams}
    n0 = {t["team"]: t["wins"] + t["losses"] + t.get("ties", 0) for t in teams}
    made = dict.fromkeys(names, 0)
    rnd = random.Random(7)
    for _ in range(SIMS):
        w = dict(w0)
        for a, b, p in games:
            if rnd.random() < p:
                w[a] += 1
            else:
                w[b] += 1
        key = {n: w[n] + rnd.random() * 1e-3 for n in names}  # ties: a coin flip
        for cf in ("AFC", "NFC"):
            mine = [n for n in names if conf[n] == cf]
            champs = {max((n for n in mine if div[n] == d), key=key.get) for d in {div[n] for n in mine}}
            wild = sorted((n for n in mine if n not in champs), key=key.get, reverse=True)[:3]
            for n in champs | set(wild):
                made[n] += 1
    return {n: made[n] / SIMS for n in names}, {n: n0[n] for n in names}


def contract(pid):
    """(salary this season, signed through, years remaining) from ESPN's athlete contract record, or None."""
    for _ in range(3):
        try:
            r = requests.get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/{pid}/contracts/{SEASON}",
                             headers=UA, timeout=15)
            if r.status_code == 404:
                return None
            if r.ok:
                c = r.json()
                return c.get("salary"), c.get("signedThrough"), c.get("yearsRemaining")
        except requests.RequestException:
            pass
        time.sleep(1.5)
    return None


def ages():
    """{espn id: age in years} from the nflverse roster (birth dates)."""
    try:
        import csv, io
        r = requests.get(f"https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{SEASON}.csv", headers=UA, timeout=60)
        r.raise_for_status()
        today, out = dt.date.today(), {}
        for row in csv.DictReader(io.StringIO(r.text)):
            if row.get("espn_id") and row.get("birth_date") not in (None, "", "NA"):
                b = dt.date.fromisoformat(row["birth_date"][:10])
                out[row["espn_id"].split(".")[0]] = (today - b).days / 365.25, row.get("status")
        return out
    except Exception as e:
        print("roster/ages unavailable:", e)
        return {}


def main():
    global SEASON
    viz = json.load(open(os.path.join(DOCS, "viz", "index.json")))
    SEASON = max(viz["nfl"])
    rk = json.load(open(latest_week(SEASON), encoding="utf-8"))
    p_off, games = playoff_chances(rk["teams"])
    V = json.load(open(os.path.join(DOCS, "viz", f"nfl_{SEASON}.json"), encoding="utf-8"))
    by_name = {v[0]: k for k, v in V["teams"].items()}
    abbr = {k: v[1] for k, v in V["teams"].items()}
    tp = {by_name[n]: p for n, p in p_off.items() if n in by_name}
    rec = {by_name[t["team"]]: t["record"] for t in rk["teams"] if t["team"] in by_name}

    # team units: per-play numbers, ranked 1 (best) .. 32
    tc = {c: i + 3 for i, c in enumerate(V["tcols"])}
    T = {}
    for r in V["trows"]:
        s = T.setdefault(r[0], {})
        for c, i in tc.items():
            s[c] = s.get(c, 0) + r[i]
    def per(a, b):
        return lambda s: s[a] / s[b] if s.get(b) else 0
    metric = {"QB": (per("pass_epa", "att"), 1), "WR": (per("pass_epa", "att"), 1), "RB": (per("rush_epa", "carries"), 1),
              "OL": (per("sacked", "att"), -1), "RUSH": (per("def_sacks", "opp_att"), 1),
              "RUND": (lambda s: s["opp_rush_yds"] / max(1, s["opp_plays"] - s["opp_att"]), -1), "COV": (per("opp_pass_yds", "opp_att"), -1)}
    rank = {}
    for u, (f, sign) in metric.items():
        order = sorted(T, key=lambda k: -sign * f(T[k]))
        rank[u] = {k: i + 1 for i, k in enumerate(order)}

    # players: snaps share on his current team (offense = team plays, defense = opponent plays)
    pc = {c: i + 3 for i, c in enumerate(V["pcols"])}
    team_week = {(r[0], r[1]): r for r in V["trows"]}
    snaps, side = {}, {}
    for r in V["prows"]:
        pid, wk, team = r[0], r[1], r[2]
        m = V["pmeta"].get(pid)
        if not m or team != m[2]:
            continue
        tr = team_week.get((team, wk))
        if not tr:
            continue
        d = m[3] in DEFENSE
        s = snaps.setdefault(pid, [0, 0])
        s[0] += r[pc["snaps"]]
        side[pid] = d
    team_snaps = {}
    for (team, wk), tr in team_week.items():
        t = team_snaps.setdefault(team, [0, 0])
        t[0] += tr[tc["plays"]]
        t[1] += tr[tc["opp_plays"]]
    AG = ages()
    cands = []
    for pid, (sn, _) in snaps.items():
        name, _, team, pos = V["pmeta"][pid][:4]
        if pos not in UNIT or tp.get(team, 1) >= 0.45:
            continue
        share = sn / max(1, team_snaps[team][1 if side[pid] else 0])
        a, status = AG.get(pid, (None, None))
        if share < 0.35 or (status and status not in ("ACT",)):
            continue
        cands.append({"id": pid, "name": name, "pos": pos, "team": team, "share": round(share, 3), "age": a})
    print(f"{len(cands)} candidates on {sum(1 for p in tp.values() if p < 0.45)} seller teams")

    no_c = "--no-contracts" in sys.argv
    out = []
    for c in cands:
        k = None if no_c else contract(c["id"])
        if not no_c:
            time.sleep(0.05)
        sal, thru, _ = k or (None, None, None)
        p = tp[c["team"]]
        seller = min(1, (0.45 - p) / 0.35) ** 0.7
        cf = {SEASON: 1.0, SEASON + 1: 0.6}.get(thru, 0.3 if thru else 0.5)
        a = c["age"]
        af = 0.5 if a is None else 1.0 if a >= 30 else 0.85 if a >= 28 else 0.6 if a >= 26 else 0.3
        role = min(1, c["share"] / 0.7)
        worth = 0.6 + 0.4 * min(1, (sal or 0) / 10e6)
        posf = {"QB": 0.45, "RB": 0.7}.get(c["pos"], 1)
        score = seller * cf * af * role * worth * posf
        why = [f"{abbr[c['team']]} {rec.get(c['team'], '')}, {round(100 * p)}% playoff chance"]
        if thru:
            why.append("contract ends after this season" if thru == SEASON else f"signed through {thru}")
        if a:
            why.append(f"age {int(a)}")
        why.append(f"plays {round(100 * c['share'])}% of snaps")
        u = UNIT[c["pos"]]
        fits = []
        for t, pt in tp.items():
            if t == c["team"] or not 0.35 <= pt <= 0.97:
                continue
            need = (rank[u][t] - 1) / 31  # 0 = best unit, 1 = worst
            fits.append((need * (1 - abs(pt - 0.7)), t, need))
        fits = [[abbr[t], f"#{rank[u][t]} {UNIT_TXT[u]}, {round(100 * tp[t])}% playoff chance"] for s, t, n in sorted(fits, reverse=True)[:3]]
        out.append({**c, "age": round(a, 1) if a else None, "salary": sal, "through": thru, "score": round(score, 4), "why": why, "fits": fits})
    out.sort(key=lambda x: -x["score"])
    out = out[:80]
    top = out[0]["score"] if out else 1
    for x in out:
        x["score"] = round(100 * x["score"] / top)
        x["tier"] = "Likely" if x["score"] >= 60 else "Possible" if x["score"] >= 30 else "Long shot"
    data = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "season": SEASON, "deadline": DEADLINE, "sims": SIMS,
            "teams": {abbr[t]: {"id": t.split(":")[1], "p": round(p, 3), "record": rec.get(t, "")} for t, p in tp.items()},
            "players": out}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out)} players -> {OUT}")
    for x in out[:12]:
        print(f"  {x['score']:3} {x['name']} {x['pos']} {abbr[x['team']]} thru {x['through']} ${(x['salary'] or 0) / 1e6:.1f}M age {x['age']} -> {', '.join(f[0] for f in x['fits'])}")


if __name__ == "__main__":
    sys.exit(main())
