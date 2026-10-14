"""College availability (injury) reports: SEC, ACC, Big 12, Big Ten and MAC.

Those conferences publish player availability reports for conference games through one vendor, HD Intelligence; the
conference sites embed its public viewer, which loads the reports from the endpoints below (no key). Each player gets
a status per report (initial, updates, game day): Out, Doubtful, Questionable, Probable, Available...
Not an official API: if it changes or goes away, everything here returns nothing and the model goes on without it.

Used by the weekly job (src/run_weekly.py):
  - adjustments to the expected margin, tested on 2025-26 conference games (379 with reports on both sides, 26 with
    a starting QB out): the starting QB (the team's passing leader, from ESPN) listed Out or Doubtful costs 5 points,
    and every other new absence (not out the week before) 0.25 points (Questionable 0.3 of that, Doubtful 0.75):
    avg miss 11.69 -> 11.56, Brier 0.1873 -> 0.1853
  - docs/data/cfb/<season>/injuries.json for the site (team page, game page, Stats > Injuries)
"""
import json
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://app.hdintelligence.com/api/"
CONFS = {"SEC": "SEC", "ACC": "ACC", "B12": "Big 12", "B10": "Big Ten", "MAC": "MAC"}
FIX = {"San Jose State": "San José State"}  # their name -> ours (CFBD)
WEIGHT = {"Out": 1.0, "Out - (1st Half)": 0.5, "Out (1st Half)": 0.5, "Doubtful": 0.75, "Game Time Decision": 0.4, "Questionable": 0.3}
QB_OUT, NEW_ABSENCE = 5.0, 0.25  # points (see above)
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/college-football"


def _post(path, conf):
    body = json.dumps({"sport": "Football", "organization": conf, "conference": conf}).encode()
    req = urllib.request.Request(API + path, data=body, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0",
                                                                 "Origin": "https://app.hdintelligence.com"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read())


def _get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        return json.loads(r.read())


def _final(r):
    """The latest status a player had for that game (game day if it's out, else the last update)."""
    for k in ("Game Day", "Gameday", "Update 2", "Friday", "Update 1", "Thursday", "Initial"):
        v = (r.get(k) or "").strip()
        if v and "pending" not in v.lower():
            return v
    return ""


def _name(s):
    return (s or "").strip()


def _opp(s):
    s = (s or "").strip()
    for p in ("at ", "vs. ", "vs "):
        if s.startswith(p):
            s = s[len(p):]
    return FIX.get(s, s)


def fetch(season):
    """{(team, week): {"opp": name, "players": {name: {"n": "#4", "s": status, "pos": "QB" or ""}}}} for this season."""
    reports, pos = {}, {}
    for conf in CONFS:
        try:
            rows = _post("get-archive-public", conf).get("data") or []
        except Exception as e:
            print(f"  injuries: {conf} archive unavailable ({e.__class__.__name__})")
            continue
        for r in rows:
            try:
                if int(r["Week"].split()[3]) != season:
                    continue
            except (KeyError, IndexError, ValueError):
                continue
            team = FIX.get(r.get("TeamDisplay") or r.get("Team"), r.get("TeamDisplay") or r.get("Team"))
            g = reports.setdefault((team, int(r["WeekNum"])), {"opp": _opp(r.get("OpponentDisplay") or r.get("Opponent")), "players": {}})
            g["players"][_name(r["Player"])] = {"n": r.get("Number") or "", "s": _final(r), "pos": ""}
        try:  # the current reports list positions ("QB #1 Name")
            for rep in (_post("get-publish-public", conf) or {}).values():
                for gm in rep.get("games") or []:
                    for row in gm.get("rows") or []:
                        parts = (row.get("name") or "").split(" ", 2)
                        if len(parts) == 3 and parts[1].startswith("#"):
                            pos[_name(parts[2])] = parts[0]
        except Exception:
            pass
    for g in reports.values():
        for name, p in g["players"].items():
            p["pos"] = pos.get(name, "")
    return reports


def passing_leaders(teams, season):
    """{team: passing leader's name} from ESPN (this season so far), for the FBS teams named."""
    try:
        lst = _get(f"{ESPN}/teams?groups=80&limit=1000")["sports"][0]["leagues"][0]["teams"]  # a smaller limit skips teams
    except Exception:
        return {}
    ids = {}
    for t in lst:
        ids.setdefault(t["team"]["location"], t["team"]["id"])

    def one(team):
        tid = ids.get(team) or ids.get({"San José State": "San Jose State"}.get(team, ""))
        if not tid:
            return team, None
        try:
            d = _get(f"{CORE}/seasons/{season}/types/2/teams/{tid}/leaders")
            cat = next(c for c in d["categories"] if c["name"] == "passingYards")
            return team, _get(cat["leaders"][0]["athlete"]["$ref"]).get("displayName")
        except Exception:
            return team, None
    with ThreadPoolExecutor(12) as ex:
        return {t: n for t, n in ex.map(one, sorted(teams)) if n}


norm = lambda s: "".join(ch for ch in (s or "").lower() if ch.isalnum())


class Reports:
    """Lookups for the model and the game notes (team names are ours, i.e. CFBD's)."""

    def __init__(self, season, offline=False):
        self.season = season
        self.reps = {} if offline else fetch(season)
        self.qbs = passing_leaders({t for t, _ in self.reps}, season) if self.reps else {}
        print(f"  injuries: {len(self.reps)} college team reports, {len(self.qbs)} starting QBs")

    def _rep(self, team, week, opp=None):
        r = self.reps.get((team, week))
        if r and (opp is None or r["opp"] == opp):
            return r
        if opp:  # week numbers can differ by one around week 0 / byes: match on the opponent instead
            for w in (week - 1, week + 1):
                r = self.reps.get((team, w))
                if r and r["opp"] == opp:
                    return r
        return None

    def qb_out(self, team, week, opp=None):
        r, q = self._rep(team, week, opp), norm(self.qbs.get(team))
        if not r or not q:
            return None
        return next((n for n, p in r["players"].items() if norm(n) == q and WEIGHT.get(p["s"], 0) >= 0.75), None)

    def new_load(self, team, week, opp=None):
        r = self._rep(team, week, opp)
        if not r:
            return 0.0
        prev = (self.reps.get((team, week - 1)) or {}).get("players", {})
        return sum(WEIGHT.get(p["s"], 0) for n, p in r["players"].items() if prev.get(n, {}).get("s") != "Out")

    def adjust(self, x):
        """Points to add to the home side's expected margin for game x (model.py format)."""
        m = 0.0
        for team, opp, sign in ((x["home"], x["away"], 1), (x["away"], x["home"], -1)):
            if self._rep(team, x["week"], opp):
                m -= sign * ((QB_OUT if self.qb_out(team, x["week"], opp) else 0) + NEW_ABSENCE * self.new_load(team, x["week"], opp))
        return m

    def out(self, team, season, week):
        """Players listed Out or Doubtful for the game page notes ("AK Dear (#0)"), starting QB first."""
        r = self.reps.get((team, week))
        if not r:
            return []
        qb = self.qb_out(team, week)
        lst = [f"{n} ({p['pos'] + ' ' if p['pos'] else ''}{p['n']})".replace(" )", ")") for n, p in r["players"].items()
               if WEIGHT.get(p["s"], 0) >= 0.75]
        return sorted(lst, key=lambda s: not (qb and s.startswith(qb)))

    def save(self, path):
        """docs/data/cfb/<season>/injuries.json: every report this season, for the site."""
        weeks = defaultdict(dict)
        for (team, wk), r in self.reps.items():
            lst = [[n, p["n"], p["pos"], p["s"]] for n, p in r["players"].items() if WEIGHT.get(p["s"], 0) > 0]
            weeks[str(wk)][team] = {"opp": r["opp"], "qb": self.qbs.get(team), "players": lst}
        if not weeks:
            return
        path.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "season": self.season,
                                    "conferences": list(CONFS.values()), "weeks": weeks}, separators=(",", ":")), encoding="utf-8")
