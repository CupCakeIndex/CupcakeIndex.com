"""Generate a fake season in CFBD's JSON format so the model can be tested offline.

Writes data/raw/1989 and data/raw/1990. Plants two teams to check the model:
  "Cupcake U"  - average talent, schedule of FCS + bottom-tier teams, goes undefeated by blowouts
  "Gauntlet St"- elite team with a brutal schedule
Then run:  python src/run_weekly.py --season 1990 --offline
"""
import json
import random
from math import erf, sqrt
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
random.seed(7)


def phi(x):
    return 0.5 * (1 + erf(x / sqrt(2)))


def season(year, strength, fcs, weeks=12):
    fbs = list(strength)
    games, adv, gid = [], [], year * 10000
    for w in range(1, weeks + 1):
        pool = fbs[:]
        random.shuffle(pool)
        pairs = []
        for special in ("Cupcake U", "Gauntlet St"):
            if special not in pool:
                continue
            pool.remove(special)
            if special == "Cupcake U":
                opp = random.choice(fcs) if w in (1, 2, 4, 9) else min(pool, key=lambda t: strength[t] + random.random())
            else:
                opp = max(pool, key=lambda t: strength[t] + random.random() * 3)
            if opp in pool:
                pool.remove(opp)
            pairs.append((special, opp))
        while len(pool) >= 2:
            a = pool.pop()
            b = random.choice(fcs) if w in (1, 2) and random.random() < 0.4 else pool.pop()
            pairs.append((a, b))
        for a, b in pairs:
            gid += 1
            h, aw = (a, b) if random.random() < 0.5 else (b, a)
            sh, sa = strength.get(h, -25), strength.get(aw, -25)
            margin = sh - sa + 2.5 + random.gauss(0, 14)
            hp = max(0, round(24 + margin / 2 + random.gauss(0, 4)))
            ap = max(0, round(hp - margin))
            if hp == ap:
                hp += 3
            games.append({
                "id": gid, "season": year, "week": w, "seasonType": "regular", "completed": True,
                "neutralSite": False, "startDate": f"{year}-09-{w:02d}T19:00:00Z",
                "homeTeam": h, "homeClassification": "fbs" if h in strength else "fcs", "homePoints": hp,
                "awayTeam": aw, "awayClassification": "fbs" if aw in strength else "fcs", "awayPoints": ap,
                "homePostgameWinProbability": round(phi((hp - ap) / 10 + random.gauss(0, 0.5)), 3),
            })
            for t, o, s_t, s_o in ((h, aw, sh, sa), (aw, h, sa, sh)):
                op = 0.2 * (s_t - s_o) / 14 + random.gauss(0, 0.1)
                adv.append({"gameId": gid, "season": year, "week": w, "team": t, "opponent": o,
                            "offense": {"ppa": 0.1 + op / 2, "successRate": 0.42 + op / 8},
                            "defense": {"ppa": 0.1 - op / 2, "successRate": 0.42 - op / 8}})
    # add an unplayed next-week slate so predictions have something to show
    return games, adv


def write(year, name, data):
    f = RAW / str(year) / f"{name}.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data))


def main():
    confs = ["ACC", "Big Ten", "Big 12", "SEC", "AAC", "MWC", "Sun Belt", "MAC", "CUSA"]
    names = [f"Team {i:03d}" for i in range(128)] + ["Cupcake U", "Gauntlet St"]
    base = {t: random.gauss(0, 10) for t in names}
    base["Cupcake U"], base["Gauntlet St"] = 2.0, 20.0
    fcs = [f"FCS {i}" for i in range(24)]
    for year, drift in ((1989, 0), (1990, 1)):
        strength = {t: v + drift * random.gauss(0, 4) for t, v in base.items()}
        games, adv = season(year, strength, fcs)
        # Brand-name AP poll: ranks by record, ignoring schedule
        rec = {t: 0 for t in names}
        for x in games:
            wnr = x["homeTeam"] if x["homePoints"] > x["awayPoints"] else x["awayTeam"]
            if wnr in rec:
                rec[wnr] += 1
        ap = sorted(names, key=lambda t: -(rec[t] + strength[t] / 100))[:25]
        write(year, "teams_fbs", [{"school": t, "conference": confs[i % len(confs)], "logos": []}
                                  for i, t in enumerate(names)])
        write(year, "games", games)
        write(year, "advanced_games", adv)
        write(year, "rankings", [{"season": year, "week": 13, "polls": [
            {"poll": "AP Top 25", "ranks": [{"rank": i + 1, "school": t} for i, t in enumerate(ap)]}]}])
        write(year, "talent", [{"year": year, "team": t, "talent": 700 + strength[t] * 5} for t in names])
        write(year, "returning", [{"season": year, "team": t, "percentPPA": random.random()} for t in names])
        write(year, "calendar", [])
    print("fake data written to", RAW)


if __name__ == "__main__":
    main()
