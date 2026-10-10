"""The site's live Stats tabs, worked out in Python for Cupcake Analyst (src/analyst_data.py).

A claude.ai page can't reach ESPN, so the numbers the site computes in the browser are snapshotted here with the same
math as docs/live.js:
  injuries(): Stats > Injuries, every NFL team's "% healthy" (live.js injData; the in-game play-by-play part is left out)
  frauds():   Stats > Frauds / Over-achievers, players vs ESPN's weekly projections (live.js frPlayers)
"""
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl"
H = {"User-Agent": "Mozilla/5.0 (CupcakeIndex analyst snapshot)"}


def get(url, **kw):
    r = requests.get(url, headers={**H, **kw.pop("headers", {})}, timeout=30, **kw)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------- Injuries (live.js INJ_* and injData)
INJ_W = {"qb": 10, "lt": 3, "rt": 3, "lg": 2, "c": 2, "rg": 2, "wr": 3, "te": 2, "rb": 2, "fb": 0.5, "lde": 3, "rde": 3, "de": 3, "ldt": 2.5, "rdt": 2.5,
         "nt": 2.5, "dt": 2.5, "wlb": 2, "slb": 2, "olb": 2.5, "lilb": 2, "rilb": 2, "mlb": 2, "lb": 2, "lcb": 3, "rcb": 3, "cb": 3, "nb": 1.5,
         "ss": 2, "fs": 2, "s": 2, "pk": 1, "p": 0.5}
INJ_POS_W = {"QB": 10, "OT": 3, "T": 3, "G": 2, "OG": 2, "C": 2, "WR": 3, "TE": 2, "RB": 2, "FB": 0.5, "DE": 3, "EDGE": 3, "DT": 2.5, "NT": 2.5,
             "LB": 2, "OLB": 2.5, "ILB": 2, "MLB": 2, "CB": 3, "S": 2, "SS": 2, "FS": 2, "DB": 2, "PK": 1, "K": 1, "P": 0.5}
INJ_STARTS = 5


def inj_hit(st):
    st = st or ""
    if re.search(r"out|injured reserve|suspen|physically unable|non-football", st, re.I):
        return 1
    if re.search(r"doubtful", st, re.I):
        return 0.75
    if re.search(r"questionable|day-to-day", st, re.I):
        return 0.25
    return 0


def _team(t, yr, starts):
    idof = lambda i: (re.search(r"/id/(\d+)", " ".join(l.get("href", "") for l in (i.get("athlete") or {}).get("links", []))) or [None, ""])[1]
    injs = t.get("injuries") or []
    missing = {idof(i) for i in injs if inj_hit(i.get("status")) >= 0.75} - {""}
    reported = {idof(i) for i in injs}
    try:
        dc = get(f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{yr}/teams/{t['id']}/depthcharts")
    except Exception:
        dc = {}
    try:
        ro = get(f"{SITE}/teams/{t['id']}/roster")
        groups = ro.get("athletes") or []
        people = [a for g in groups for a in g.get("items", [])] if groups and "items" in groups[0] else groups
    except Exception:
        people = []
    extra = []  # long-term IR the league report leaves out
    for a in people:
        st = ((a.get("injuries") or [{}])[0]).get("status", "")
        if inj_hit(st) > 0 and str(a.get("id")) not in reported:
            extra.append({"id": str(a["id"]), "name": a.get("fullName") or a.get("displayName", ""), "pos": (a.get("position") or {}).get("abbreviation", ""), "status": st})
            if inj_hit(st) >= 0.75:
                missing.add(str(a["id"]))
    slot, seen, total = {}, set(), 0.0
    for it in dc.get("items", []):
        for k, v in (it.get("positions") or {}).items():
            if k not in INJ_W:
                continue
            spots = {}
            for a in v.get("athletes", []):
                m = re.search(r"athletes/(\d+)", (a.get("athlete") or {}).get("$ref", ""))
                if m:
                    spots.setdefault(a.get("slot") or 1, []).append((a.get("rank") or 99, m[1]))
            for sl, lst in spots.items():
                if (k, sl) in seen:
                    continue
                seen.add((k, sl))
                total += INJ_W[k]
                filled = False
                for depth, (_r, pid) in enumerate(sorted(lst), 1):
                    is_key, old = not filled, slot.get(pid)
                    if pid not in missing:
                        filled = True
                    if not old or (is_key and not old["key"]) or (not old["key"] and depth < old["depth"]):
                        slot[pid] = {"spot": k, "depth": depth, "key": is_key}

    def weight(pid, pos):
        s, regular = slot.get(pid), starts.get(pid, 0) >= INJ_STARTS
        if s and (s["key"] or regular):
            return INJ_W[s["spot"]], True
        if regular:
            return INJ_POS_W.get(pos, 2), True
        return (INJ_W[s["spot"]] * (0.15 if s["depth"] == 2 else 0.05) if s else INJ_POS_W.get(pos, 1) * 0.3), False

    hurt = []
    for i in injs:
        if inj_hit(i.get("status")) <= 0:
            continue
        a = i.get("athlete") or {}
        pos = (a.get("position") or {}).get("abbreviation", "")
        w, key = weight(idof(i), pos)
        hurt.append({"name": a.get("displayName", ""), "pos": pos, "status": i.get("status"), "key": key, "lost": round(w * inj_hit(i.get("status")), 2), "w": w,
                     "note": i.get("shortComment") or ""})
    for p in extra:
        w, key = weight(p["id"], p["pos"])
        hurt.append({"name": p["name"], "pos": p["pos"], "status": p["status"], "key": key, "lost": round(w * inj_hit(p["status"]), 2), "w": w,
                     "note": "On injured reserve" if re.search("injured reserve", p["status"], re.I) else ""})
    hurt.sort(key=lambda h: -h["lost"])
    lost = sum(h["lost"] for h in hurt)
    health = max(0, min(100, 100 * (1 - lost / total))) if total else 100
    return {"team": t.get("displayName", ""), "health": round(health, 1), "key_out": sum(1 for h in hurt if h["key"] and h["lost"] >= 0.75 * h["w"]),
            "on_report": len(hurt), "hurt": [{k: v for k, v in h.items() if k != "w" and v not in ("", None)} for h in hurt[:14]]}


def injuries():
    """{as_of, teams: [{team, health, rank (1 = most banged up), key_out, on_report, hurt: [...]}]}"""
    rep = get(f"{SITE}/injuries")
    yr = (rep.get("season") or {}).get("year") or date.today().year
    starts = json.loads((ROOT / "docs" / "data" / "nfl_starts.json").read_text(encoding="utf-8")).get("players", {})
    with ThreadPoolExecutor(8) as ex:
        teams = list(ex.map(lambda t: _team(t, yr, starts), rep.get("injuries") or []))
    teams.sort(key=lambda t: t["health"])
    for i, t in enumerate(teams, 1):
        t["rank_most_hurt"] = i
    return {"as_of": date.today().isoformat(), "teams": teams}


# ---------------------------------------------------------------- Frauds (live.js FR_* and frPlayers)
FR_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}
FR_KEYS = {
    "QB": [["Pass yds", ["3"], 0.4, 10, False], ["Pass TD", ["4"], 0.3, 0, False], ["INT", ["20"], 0.15, 0, True], ["Rush yds", ["24"], 0.15, 10, False]],
    "RB": [["Rush yds", ["24"], 0.5, 10, False], ["Rec yds", ["42"], 0.3, 10, False], ["TD", ["25", "43"], 0.2, 0, False]],
    "WR": [["Rec", ["53"], 0.3, 1, False], ["Rec yds", ["42"], 0.5, 10, False], ["TD", ["25", "43"], 0.2, 0, False]],
}
FR_KEYS["TE"] = FR_KEYS["WR"]
FR_MIN_GAMES, FR_MIN_PTS = 2, 8


def frauds():
    """{season, players: [{name, pos, team, games, score (% below ESPN's projections; negative = beating them), stats: [...]}]}"""
    t = date.today()
    y = t.year if t.month >= 9 else t.year - 1
    base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{y}"
    cur = (get(base).get("currentScoringPeriod") or {}).get("id") or 18
    weeks = list(range(1, min(cur, 18) + 1))
    flt = {"players": {"filterSlotIds": {"value": [0, 2, 4, 6]}, "limit": 350, "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                       "filterStatsForSourceIds": {"value": [0, 1]}, "filterStatsForSplitTypeIds": {"value": [1]}, "filterStatsForScoringPeriodIds": {"value": weeks}}}
    data = get(f"{base}/segments/0/leaguedefaults/3?view=kona_player_info", headers={"X-Fantasy-Filter": json.dumps(flt)})
    teams = {str(x["id"]): (x.get("abbrev") or "").upper() for x in get(f"{base}?view=proTeamSchedules_wl").get("settings", {}).get("proTeams", [])}
    out = []
    for row in data.get("players", []):
        p = row.get("player") or {}
        pos = FR_POS.get(p.get("defaultPositionId"))
        if not pos or not p.get("proTeamId"):
            continue
        st = [s for s in p.get("stats", []) if s.get("seasonId") == y and s.get("statSplitTypeId") == 1]
        proj = {s["scoringPeriodId"]: s for s in st if s.get("statSourceId") == 1}
        games = [s for s in st if s.get("statSourceId") == 0 and (s.get("stats") or {}).get("210") and s["scoringPeriodId"] in proj]
        n = len(games)
        if n < FR_MIN_GAMES or sum(proj[g["scoringPeriodId"]].get("appliedTotal") or 0 for g in games) / n < FR_MIN_PTS:
            continue
        ssum = lambda s, ids: sum((s.get("stats") or {}).get(k, 0) for k in ids)
        score = wsum = 0.0
        cells = []
        for label, ids, w, mn, worse in FR_KEYS[pos]:
            act = sum(ssum(g, ids) for g in games) / n
            exp = sum(ssum(proj[g["scoringPeriodId"]], ids) for g in games) / n
            if exp > 0 and exp >= mn:
                score += w * max(-1, min(1, ((act - exp) if worse else (exp - act)) / exp))
                wsum += w
                cells.append({"stat": label, "per_game": round(act, 1), "projected": round(exp, 1)})
        if wsum:
            out.append({"name": p.get("fullName", ""), "pos": pos, "team": teams.get(str(p["proTeamId"]), ""), "games": n,
                        "score": round(100 * score / wsum), "injury": p.get("injuryStatus") if p.get("injuryStatus") not in (None, "ACTIVE") else None, "stats": cells})
    out.sort(key=lambda x: -x["score"])
    return {"season": y, "through_week": cur - 1, "players": [{k: v for k, v in x.items() if v is not None} for x in out]}
