"""Extra information for the NFL model (src/nfl_model.py), each one kept only because the backtest got better:

  1. QB quality: who's actually starting, rated by EPA per dropback (career so far, shrunk toward a backup's level),
     compared with the QB the team's rating was built on.
  2. Injuries: starters listed Out or Doubtful on the final injury report, weighted by how much they play
     (snap share so far this season). QBs are left to (1).
  3. Weather (predicted scores only): wind and cold at outdoor stadiums.

All from nflverse (free): play-by-play, injury reports, snap counts, players. Cached in data/raw/nfl.
"""
import csv
import gzip
import json
import math
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nfl"
NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
MOVED = {"OAK": "LV", "SD": "LAC", "STL": "LA"}
team = lambda t: MOVED.get(t, t)


def _fetch(url, name, refresh=False):
    f = RAW / name
    if refresh or not f.exists():
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen(url, timeout=60) as r:
                f.write_bytes(r.read())
        except Exception as e:  # keep the old copy (or go without) if nflverse is down
            print(f"  warning: couldn't download {name} ({e})")
    return f if f.exists() else None


def _rows(f):
    if not f:
        return []
    op = gzip.open if f.suffix == ".gz" else open
    with op(f, "rt", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ 1. QB quality
def qb_games(seasons, refresh_last=False):
    """{season: [(week, game_id, team, qb_id, dropbacks, epa)]} from play-by-play, cached in qb_games_<season>.json."""
    out = {}
    for s in seasons:
        cache = RAW / f"qb_games_{s}.json"
        last = s == max(seasons)
        if cache.exists() and not (last and refresh_last):
            out[s] = json.loads(cache.read_text(encoding="utf-8"))
            continue
        f = RAW / f"pbp_{s}.csv.gz"
        if last and refresh_last or not f.exists():
            _fetch(f"{NFLV}/pbp/play_by_play_{s}.csv.gz", f.name, refresh=True)
        if not f.exists():
            continue
        agg = defaultdict(lambda: [0, 0.0])
        with gzip.open(f, "rt", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if r.get("season_type") != "REG" or r.get("qb_dropback") != "1" or not r.get("id"):
                    continue
                e = _num(r.get("qb_epa"))
                if e is None:
                    continue
                k = (int(r["week"]), r["game_id"], team(r["posteam"]), r["id"])
                agg[k][0] += 1
                agg[k][1] += e
        rows = [[*k, n, round(e, 3)] for k, (n, e) in sorted(agg.items())]
        cache.write_text(json.dumps(rows), encoding="utf-8")
        out[s] = rows
    return out


SUMMARY = ROOT / "data" / "history" / "nfl_qb_seasons.json"


def qb_summary(seasons):
    """{qb id: {season: [dropbacks, epa]}} for finished seasons, kept in the repo (small) so the weekly job doesn't
    need 20 years of play-by-play. A missing season is built from play-by-play (downloaded if needed) and saved."""
    data = json.loads(SUMMARY.read_text(encoding="utf-8")) if SUMMARY.exists() else {}
    have = {s for v in data.values() for s in v}
    missing = [s for s in seasons if str(s) not in have]
    for s, rows in qb_games(missing).items():
        for _, _, _, q, dn, de in rows:
            n, e = data.setdefault(q, {}).get(str(s), [0, 0.0])
            data[q][str(s)] = [n + dn, round(e + de, 3)]
    if missing:
        SUMMARY.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return {q: {s: v for s, v in by.items() if int(s) in seasons} for q, by in data.items()}


class QBs:
    """QB ratings (EPA per dropback) as of any game. Unknown or barely-played QBs sit near a backup's level."""

    def __init__(self, seasons, refresh_last=False, prior=-0.08, prior_n=250, season_decay=0.7, summary=False):
        """summary=True (the weekly job): seasons before the last come from data/history/nfl_qb_seasons.json."""
        seasons = list(seasons)
        self.prior, self.prior_n, self.decay = prior, prior_n, season_decay
        self.by = defaultdict(lambda: defaultdict(list))  # qb -> season -> [(week, dropbacks, epa)]
        self.team = defaultdict(list)                     # (team, season) -> [(week, qb, dropbacks)]
        if summary:
            for q, by_s in qb_summary(seasons[:-1]).items():
                for s, (n, e) in by_s.items():
                    self.by[q][int(s)].append((99, n, e))
            seasons = seasons[-1:]
        self.games = qb_games(seasons, refresh_last)
        for s, rows in self.games.items():
            for wk, _, t, q, dn, de in rows:
                self.by[q][s].append((wk, dn, de))
                self.team[(t, s)].append((wk, q, dn))

    def value(self, qb, season, week):
        n = e = 0.0
        for s, lst in self.by.get(qb, {}).items() if qb else ():
            if s > season:
                continue
            w = self.decay ** (season - s)
            for wk, dn, de in lst:
                if s < season or wk < week:
                    n += w * dn
                    e += w * de
        return (e + self.prior * self.prior_n) / (n + self.prior_n)

    def usual(self, tm, season, week):
        """The QB with the most dropbacks for this team this season before `week` (plus last season's early on)."""
        c = defaultdict(float)
        for wk, q, dn in self.team.get((tm, season), []):
            if wk < week:
                c[q] += dn
        if sum(c.values()) < 60:
            for wk, q, dn in self.team.get((tm, season - 1), []):
                c[q] += dn * 0.5
        return max(c, key=c.get) if c else None


# ------------------------------------------------------------------ 2. injuries
POS_W = {"QB": 0.0, "OL": 1.0, "T": 1.0, "G": 1.0, "C": 1.0, "OT": 1.0, "OG": 1.0, "WR": 1.0, "TE": 0.8, "RB": 0.6, "FB": 0.2,
         "DE": 1.0, "DT": 0.9, "NT": 0.9, "DL": 0.9, "LB": 0.8, "ILB": 0.8, "OLB": 1.0, "MLB": 0.8, "CB": 1.1, "S": 0.8,
         "SS": 0.8, "FS": 0.8, "DB": 1.0, "K": 0.0, "P": 0.0, "LS": 0.0}
STATUS_W = {"Out": 1.0, "Doubtful": 0.9, "Questionable": 0.2}


def players_map():
    """pfr id -> gsis id."""
    f = _fetch(f"{NFLV}/players/players.csv", "players.csv")
    return {r["pfr_id"]: r["gsis_id"] for r in _rows(f) if r.get("pfr_id") and r.get("gsis_id")}


def injury_loads(season, refresh=False, pfr2gsis=None, names=None, outs=None):
    """{(team, week): snap-weighted share of the lineup missing} (about 1.0 = one full-time starter out).
    names: optional dict filled with (team, week) -> ["T.Smith (OT)", ...] for regulars (60%+ of snaps) listed Out/Doubtful.
    outs: optional dict filled with the same load counting only players listed Out or Doubtful (carried into next week)."""
    inj = _rows(_fetch(f"{NFLV}/injuries/injuries_{season}.csv", f"injuries_{season}.csv", refresh))
    snaps = _rows(_fetch(f"{NFLV}/snap_counts/snap_counts_{season}.csv", f"snap_counts_{season}.csv", refresh))
    if not inj or not snaps:
        return {}
    pfr2gsis = pfr2gsis if pfr2gsis is not None else players_map()
    share = defaultdict(list)  # gsis -> [(week, snap share)] this season
    for r in snaps:
        if r.get("game_type", "REG") != "REG":
            continue
        g = pfr2gsis.get(r["pfr_player_id"])
        pct = max(_num(r.get("offense_pct")) or 0, _num(r.get("defense_pct")) or 0)
        if g:
            share[g].append((int(r["week"]), pct))
    load = defaultdict(float)
    for r in inj:
        if r.get("game_type", "REG") != "REG":
            continue
        sw = STATUS_W.get((r.get("report_status") or "").strip(), 0)
        pw = POS_W.get(r.get("position") or "", 0.7)
        if not sw or not pw:
            continue
        wk = int(r["week"])
        prev = [p for w, p in share.get(r["gsis_id"], []) if w < wk]
        if not prev:
            continue
        avg = sum(prev) / len(prev)
        load[(team(r["team"]), wk)] += sw * pw * avg
        if outs is not None and sw >= 0.9:
            outs[(team(r["team"]), wk)] = outs.get((team(r["team"]), wk), 0.0) + sw * pw * avg
        if names is not None and sw >= 0.9 and avg >= 0.6:
            names.setdefault((team(r["team"]), wk), []).append(f"{r.get('full_name') or r['gsis_id']} ({r.get('position') or '?'})")
    return dict(load)


# ------------------------------------------------------------------ 3. weather (predicted scores only)
# Wind lowers scoring at outdoor stadiums. Cold didn't help in the backtest, and weather didn't help win chances.
WEATHER = {"wind": 0.3, "wind_from": 5}  # points off the total per mph of wind past 5 mph (chosen on 2013-2019)
# Outdoor home stadiums (domes and retractable roofs left out): latitude, longitude
STADIUMS = {"BAL": (39.278, -76.623), "BUF": (42.774, -78.787), "CAR": (35.226, -80.853), "CHI": (41.862, -87.617),
            "CIN": (39.095, -84.516), "CLE": (41.506, -81.699), "DEN": (39.744, -105.020), "GB": (44.501, -88.062),
            "JAX": (30.324, -81.637), "KC": (39.049, -94.484), "MIA": (25.958, -80.239), "NE": (42.091, -71.264),
            "NYG": (40.813, -74.074), "NYJ": (40.813, -74.074), "PHI": (39.901, -75.168), "PIT": (40.447, -80.016),
            "SF": (37.403, -121.970), "SEA": (47.595, -122.332), "TB": (27.976, -82.503), "TEN": (36.166, -86.771),
            "WAS": (38.908, -76.864)}


def weather_points(x, W=WEATHER):
    """Points to add to the predicted total for wind (outdoor games with a wind number; else 0)."""
    if x.get("roof") not in ("outdoors", "open") or x.get("wind") is None:
        return 0.0
    return -W["wind"] * max(0.0, x["wind"] - W["wind_from"])


def forecast_wind(x):
    """Forecast wind (mph) at kickoff for an upcoming game at an outdoor home stadium, from Open-Meteo (free, no key)."""
    ll = STADIUMS.get(x["home"])
    if not ll or x["neutral"] or x.get("roof") != "outdoors" or not x.get("gameday"):
        return None
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        ko = datetime.fromisoformat(f"{x['gameday']}T{x.get('gametime') or '13:00'}").replace(tzinfo=ZoneInfo("America/New_York"))
        utc = ko.astimezone(ZoneInfo("UTC"))
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={ll[0]}&longitude={ll[1]}&hourly=wind_speed_10m"
               f"&wind_speed_unit=mph&timezone=UTC&start_date={utc:%Y-%m-%d}&end_date={utc:%Y-%m-%d}")
        with urllib.request.urlopen(url, timeout=20) as r:
            h = json.loads(r.read())["hourly"]
        return float(h["wind_speed_10m"][utc.hour])
    except Exception as e:  # no forecast yet (about 2 weeks out) or the service is down: no weather adjustment
        print(f"  weather: none for {x['away']} at {x['home']} ({e.__class__.__name__})")
        return None


QB_OUT = {"injured reserve", "out", "suspended", "physically unable to perform", "doubtful", "reserve/covid-19", "non-football injury"}


def _plain(name):
    """'Michael Penix Jr.' -> 'michael penix' (ESPN and nflverse spell suffixes and dots differently)."""
    words = "".join(c for c in (name or "").lower() if c.isalnum() or c == " ").split()
    return " ".join(w for w in words if w not in ("jr", "sr", "ii", "iii", "iv"))


def fix_upcoming_qbs(games):
    """nflverse lists a projected starter for next week's games that can be stale (Jalen Hurts, on injured reserve,
    was still listed for Week 7 of 2026 after Tanner McKee had started Week 6). For each game of the next week,
    ESPN's game page lists both teams' injuries: a listed QB who is out, doubtful or on a reserve list is replaced
    by the team's most recent other starter (the backup who just played), so the model applies its QB change.
    First, though, the team's own site: ESPN didn't list Hurts either, but the Eagles' depth chart had McKee at QB1
    (src/nfl_depth.py, Terry: "pull from the team's site"). Changes games in place; returns the notes it printed."""
    left = [x for x in games if not x["done"] and x.get("espn")]
    if not left:
        return []
    week = min(x["week"] for x in left)
    played = sorted((x for x in games if x["done"]), key=lambda x: (x["season"], x["week"]))
    notes = []
    try:
        import nfl_depth
        qb1 = nfl_depth.refresh()
    except Exception as e:  # team sites down: ESPN's list below still runs
        print(f"  QB check: team sites skipped ({e.__class__.__name__})")
        qb1 = {}
    ids = {_plain(g.get(f"{s}qb")): g.get(f"{s}qb_id") for g in played for s in "ha" if g.get(f"{s}qb")}
    for x in (x for x in left if x["week"] == week):
        for side, team in (("h", x["home"]), ("a", x["away"])):
            new = qb1.get(team)
            if new and x.get(f"{side}qb") and _plain(new) != _plain(x[f"{side}qb"]):
                msg = f"  QB check: {team}: the team site's depth chart has {new} at QB1, not {x[f'{side}qb']}"
                x[f"{side}qb"], x[f"{side}qb_id"] = new, ids.get(_plain(new))
                print(msg)
                notes.append(msg)
    for x in (x for x in left if x["week"] == week):
        try:
            url = f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={x['espn']}"
            with urllib.request.urlopen(url, timeout=20) as r:
                inj = json.loads(r.read()).get("injuries", [])
        except Exception as e:  # ESPN down: keep nflverse's names
            print(f"  QB check: skipped {x['away']} at {x['home']} ({e.__class__.__name__})")
            continue
        out = {_plain(i.get("athlete", {}).get("displayName")) for t in inj for i in t.get("injuries", [])
               if i.get("athlete", {}).get("position", {}).get("abbreviation") == "QB" and (i.get("status") or "").lower() in QB_OUT}
        for side, team in (("h", x["home"]), ("a", x["away"])):
            qb = x.get(f"{side}qb")
            if not qb or _plain(qb) not in out:
                continue
            new = None  # the most recent starter for this team who isn't on the out list
            for g in reversed(played):
                s = "h" if g["home"] == team else "a" if g["away"] == team else None
                if s and g.get(f"{s}qb") and _plain(g[f"{s}qb"]) not in out:
                    new = (g[f"{s}qb"], g.get(f"{s}qb_id"))
                    break
            x[f"{side}qb"], x[f"{side}qb_id"] = new or ("Backup QB", None)
            msg = f"  QB check: {team}: {qb} is listed out on ESPN, expecting {x[f'{side}qb']}"
            print(msg)
            notes.append(msg)
    return notes


class Features:
    """Everything the model can use beyond scores and EPA, for the given seasons."""

    def __init__(self, seasons, refresh_last=False, live=False):
        """live=True (the weekly job): one season, past QB seasons from the summary file."""
        seasons = list(seasons)
        self.qbs = QBs(range(min(seasons) - 6, max(seasons) + 1), refresh_last, summary=live)
        pm = players_map()
        self.names = {}  # season -> {(team, week): regulars listed Out/Doubtful}, for the game page notes
        self.outs = {}   # season -> {(team, week): load from Out/Doubtful only}
        self.inj = {s: injury_loads(s, refresh_last and s == max(seasons), pm, self.names.setdefault(s, {}), self.outs.setdefault(s, {}))
                    for s in seasons}
        self.last = {s: max((w for _, w in self.inj[s]), default=0) for s in seasons}  # newest week with a report

    def _carry(self, tm, season, week):
        """A week with no report yet (the next game, before teams publish one): the team's last report, so a player
        who was out stays out until a new report says otherwise (Jalen Hurts, 2026 Week 7)."""
        if week <= self.last.get(season, 0):
            return None
        wks = [w for t, w in self.outs.get(season, {}) if t == tm and w < week]
        return max(wks) if wks and max(wks) >= week - 2 else None

    def out(self, tm, season, week):
        got = self.names.get(season, {}).get((tm, week))
        if got is None and (w := self._carry(tm, season, week)):
            return [f"{n[:-1]}, out last game)" if n.endswith(")") else f"{n} (out last game)" for n in self.names.get(season, {}).get((tm, w), [])]
        return got or []

    def injury(self, tm, season, week):
        got = self.inj.get(season, {}).get((tm, week))
        if got is None and (w := self._carry(tm, season, week)):
            return self.outs[season].get((tm, w), 0.0)
        return got or 0.0
