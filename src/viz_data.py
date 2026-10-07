"""Game-by-game team and player stats for Stats > Visualize (docs/viz.js): docs/data/viz/<league>_<season>.json.

NFL: nflverse (free, no key; built from the NFL's official play-by-play): team and player stats per week, with EPA.
College: CollegeFootballData.com (CFBD_API_KEY): team box scores, PPA (college EPA) and success rate per game
(garbage time left out, the usual way), player box scores per game, and each player's season PPA.

Every number is stored as a raw count per game ("passing yards", "pass attempts", "EPA total"), never a rate, so the
page can add up any range of weeks and divide (yards per attempt = sum of yards / sum of attempts). check() compares
the season totals with ESPN's, so a bad source shows up in the log.

    python src/viz_data.py                    # this season, both leagues (weekly.yml)
    python src/viz_data.py --league nfl --season 2025
    python src/viz_data.py --check            # just compare what's on disk with ESPN
About 3 CFBD calls per week of the season (free plan: 1,000 a month); finished seasons are built once and kept.
"""
import argparse
import csv
import io
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "viz"
RAW = ROOT / "data" / "raw"
NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
FIRST = {"nfl": 2022, "cfb": 2024}   # oldest season kept (history for line charts across seasons)


def season_now():
    t = date.today()
    return t.year if t.month >= 8 else t.year - 1


def n(x):
    try:
        v = float(x)
        return int(v) if v.is_integer() else round(v, 2)
    except (TypeError, ValueError):
        return 0


def site_teams():
    return json.loads((ROOT / "docs" / "data" / "teams.json").read_text(encoding="utf-8"))


MUST = {"tcols": ["pts", "att", "cmp", "pass_yds", "rush_yds", "carries"],
        "pcols": ["cmp", "att", "pass_yds", "pass_td", "carries", "rush_yds", "rec", "rec_yds", "tackles"]}


def write(lg, season, d):
    # a column that's zero for everyone means the source changed its format (college C/ATT once read as 0-0): stop, keep the old file
    for cols, rows in (("tcols", "trows"), ("pcols", "prows")):
        for c in MUST[cols]:
            i = d[cols].index(c) + 3
            if d[rows] and not any(r[i] for r in d[rows]):
                raise RuntimeError(f"{lg} {season}: '{c}' is 0 for every row; not saving")
    OUT.mkdir(parents=True, exist_ok=True)
    d.update({"league": lg, "season": season, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")})
    f = OUT / f"{lg}_{season}.json"
    f.write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  {f.name}: {len(d['trows'])} team games, {len(d['prows'])} player games, {f.stat().st_size // 1024} KB")
    index()


def index():
    files = sorted(OUT.glob("*_*.json"))
    seasons = defaultdict(list)
    for f in files:
        lg, s = f.stem.split("_")
        seasons[lg].append(int(s))
    (OUT / "index.json").write_text(json.dumps({k: sorted(v) for k, v in seasons.items()}), encoding="utf-8")


# ------------------------------------------------------------------ NFL (nflverse)
_fresh = set()  # downloaded this run


def nflverse_csv(path, cache):
    f = RAW / "nfl" / cache
    live = cache.endswith(f"{season_now()}.csv") or cache in ("games.csv", "players.csv", "teams.csv")  # still changing
    if not f.exists() or (live and cache not in _fresh):
        _fresh.add(cache)
        r = requests.get(path, timeout=300)
        r.raise_for_status()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(r.content)
    return list(csv.DictReader(io.StringIO(f.read_text(encoding="utf-8"))))


TEAM_COLS_NFL = ["pts", "opp_pts", "plays", "cmp", "att", "pass_yds", "pass_td", "int", "sacked", "carries", "rush_yds", "rush_td",
                 "pass_epa", "rush_epa", "first_downs", "fum_lost", "def_sacks", "def_int", "def_fr", "pen", "pen_yds",
                 "opp_plays", "opp_pass_yds", "opp_rush_yds", "opp_epa", "opp_first_downs", "fg_made", "fg_att"]
PLAYER_COLS = ["cmp", "att", "pass_yds", "pass_td", "int", "sacked", "carries", "rush_yds", "rush_td", "rec", "targets", "rec_yds",
               "rec_td", "tackles", "def_sacks", "tfl", "qb_hits", "pd", "def_int", "fg_made", "fg_att"]
PLAYER_COLS_NFL = PLAYER_COLS + ["pass_epa", "rush_epa", "rec_epa", "air_yds", "yac", "ppr", "snaps", "left"]  # left: 1 = gone by halftime


def early_exits(season):
    """{(gsis id, game id)} for players who had a pass, run or target in the first half and none after halftime:
    hurt (or benched) by halftime. From nflverse play-by-play. Players who only came in later (relief QBs) aren't in it."""
    import gzip
    f = RAW / "nfl" / f"pbp_{season}.csv.gz"
    if not f.exists() or season == season_now():
        r = requests.get(f"{NFLV}/pbp/play_by_play_{season}.csv.gz", timeout=600)
        r.raise_for_status()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(r.content)
    first, second = set(), set()
    with gzip.open(f, "rt", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("season_type") != "REG":
                continue
            half = first if n(row.get("qtr")) <= 2 else second
            for c in ("passer_player_id", "rusher_player_id", "receiver_player_id"):
                if row.get(c) and row[c] != "NA":
                    half.add((row[c], row["game_id"]))
    return first - second


def nfl(season):
    teams = nflverse_csv(f"{NFLV}/stats_team/stats_team_week_{season}.csv", f"stats_team_week_{season}.csv")
    games = [g for g in nflverse_csv("https://github.com/nflverse/nfldata/raw/master/data/games.csv", "games.csv") if g["season"] == str(season)]
    if not teams:
        print(f"  no NFL team stats for {season} yet")
        return
    # nflverse abbreviations (LA, WAS...) -> the site's teams (ESPN ids) by full name
    nv = {r["team_abbr"]: r["team_name"] for r in nflverse_csv("https://github.com/nflverse/nflverse-pbp/raw/master/teams_colors_logos.csv", "teams.csv")}
    by_name = {t["name"]: t for t in site_teams()["nfl"]}
    key = {a: f"nfl:{by_name[nm]['id']}" for a, nm in nv.items() if nm in by_name}
    tmeta = {f"nfl:{t['id']}": [t["name"], t["abbr"], t["color"], t["group"]] for t in by_name.values()}

    score = {}
    for g in games:
        if g["home_score"] != "":
            score[(g["game_id"], g["home_team"])] = (n(g["home_score"]), n(g["away_score"]))
            score[(g["game_id"], g["away_team"])] = (n(g["away_score"]), n(g["home_score"]))
    rows = {(r["game_id"], r["team"]): r for r in teams if r["season_type"] == "REG"}  # regular season only, like ESPN's season totals
    trows = []
    for (gid, tm), r in rows.items():
        o = rows.get((gid, r["opponent_team"]), {})
        f = lambda x, k: n(x.get(k))
        pts, opp = score.get((gid, tm), (0, 0))
        trows.append([key.get(tm, tm), int(r["week"]), key.get(r["opponent_team"], r["opponent_team"]),
                      pts, opp, f(r, "attempts") + f(r, "carries") + f(r, "sacks_suffered"), f(r, "completions"), f(r, "attempts"),
                      f(r, "passing_yards"), f(r, "passing_tds"), f(r, "passing_interceptions"), f(r, "sacks_suffered"),
                      f(r, "carries"), f(r, "rushing_yards"), f(r, "rushing_tds"), f(r, "passing_epa"), f(r, "rushing_epa"),
                      f(r, "passing_first_downs") + f(r, "rushing_first_downs"),
                      f(r, "sack_fumbles_lost") + f(r, "rushing_fumbles_lost") + f(r, "receiving_fumbles_lost"),
                      f(r, "def_sacks"), f(r, "def_interceptions"), f(r, "fumble_recovery_opp"), f(r, "penalties"), f(r, "penalty_yards"),
                      f(o, "attempts") + f(o, "carries") + f(o, "sacks_suffered"), f(o, "passing_yards"), f(o, "rushing_yards"),
                      round(f(o, "passing_epa") + f(o, "rushing_epa"), 2), f(o, "passing_first_downs") + f(o, "rushing_first_downs"),
                      f(r, "fg_made"), f(r, "fg_att")])

    try:
        pl = nflverse_csv(f"{NFLV}/stats_player/stats_player_week_{season}.csv", f"stats_player_week_{season}.csv")
    except requests.HTTPError:
        pl = []
    espn = {r["gsis_id"]: r["espn_id"] for r in nflverse_csv(f"{NFLV}/players/players.csv", "players.csv") if r.get("espn_id")}
    try:
        gone = early_exits(season)
    except Exception as e:  # no play-by-play: nobody marked, the option just does nothing
        print(f"  ! play-by-play unavailable ({e}); early exits not marked")
        gone = set()
    # snaps per player per game (nflverse snap counts, from Pro Football Reference): offense + defense snaps, and the
    # share of his side's snaps. A regular (usually 60%+ of the snaps) who played under half of them in a game left early.
    from statistics import median
    ids = {r["pfr_id"]: (r.get("espn_id") or r["gsis_id"]) for r in nflverse_csv(f"{NFLV}/players/players.csv", "players.csv") if r.get("pfr_id")}
    try:
        sc = nflverse_csv(f"{NFLV}/snap_counts/snap_counts_{season}.csv", f"snap_counts_{season}.csv")
    except requests.HTTPError:
        sc = []
    snap = {}
    for r in sc:
        pid = ids.get(r["pfr_player_id"])
        if r.get("game_type") == "REG" and pid:
            snap[(pid, int(r["week"]))] = (n(r["offense_snaps"]) + n(r["defense_snaps"]), max(n(r["offense_pct"]), n(r["defense_pct"])))
    shares = defaultdict(list)
    for (pid, _w), (_s, pct) in snap.items():
        if pct > 0:
            shares[pid].append(pct)
    usual = {pid: median(v) for pid, v in shares.items() if len(v) >= 2}
    pmeta, prows = {}, []
    for r in pl:
        if r["season_type"] != "REG":
            continue
        f = lambda k: n(r.get(k))
        vals = [f("completions"), f("attempts"), f("passing_yards"), f("passing_tds"), f("passing_interceptions"), f("sacks_suffered"),
                f("carries"), f("rushing_yards"), f("rushing_tds"), f("receptions"), f("targets"), f("receiving_yards"), f("receiving_tds"),
                f("def_tackles_solo") + f("def_tackle_assists"), f("def_sacks"), f("def_tackles_for_loss"), f("def_qb_hits"), f("def_pass_defended"),
                f("def_interceptions"), f("fg_made"), f("fg_att"), f("passing_epa"), f("rushing_epa"), f("receiving_epa"),
                f("receiving_air_yards"), f("receiving_yards_after_catch"), f("fantasy_points_ppr")]
        if not any(vals):
            continue
        pid = espn.get(r["player_id"]) or r["player_id"]
        pmeta[pid] = [r["player_display_name"], r["position"], key.get(r["team"], r["team"])]
        wk = int(r["week"])
        snaps, pct = snap.get((pid, wk), (0, None))
        left = (r["position"] == "QB" and (r["player_id"], r.get("game_id")) in gone) \
            or (pct is not None and usual.get(pid, 0) >= 0.6 and pct < 0.5)  # QBs: no plays after halftime; others: a regular under half the snaps
        prows.append([pid, wk, key.get(r["team"], r["team"])] + vals + [snaps, 1 if left else 0])
    print(f"  {sum(x[-1] for x in prows)} player games left early (QBs by play-by-play, others by snaps); snaps for {sum(1 for x in prows if x[-2])} of {len(prows)}")
    write("nfl", season, {"teams": tmeta, "tcols": TEAM_COLS_NFL, "trows": trows, "pcols": PLAYER_COLS_NFL, "pmeta": pmeta, "prows": prows})


# ------------------------------------------------------------------ college (CFBD)
TEAM_COLS_CFB = ["pts", "opp_pts", "plays", "cmp", "att", "pass_yds", "pass_td", "int", "carries", "rush_yds", "rush_td", "first_downs",
                 "fum_lost", "third_conv", "third_att", "def_sacks", "def_int", "tfl", "pen", "pen_yds", "opp_yds", "opp_pass_yds", "opp_rush_yds",
                 "adv_plays", "epa", "succ", "pass_plays", "pass_epa", "rush_plays", "rush_epa", "def_adv_plays", "def_epa", "def_succ"]


def cfbd(path, cache, refresh, **params):
    sys.path.insert(0, str(ROOT / "src"))
    from fetch_data import cached
    return cached(params.get("year"), cache, path, refresh, **params)


def split(s):
    """'20-31' or '20/31' -> (20, 31). (CFBD writes team stats with a dash, player C/ATT and FG with a slash.)"""
    try:
        a, b = str(s).replace("/", "-").split("-")[:2]
        return n(a), n(b)
    except ValueError:
        return 0, 0


def cfb(season):
    cur = season == season_now()
    played = lambda gs: [g for g in gs if (g.get("homePoints") if "homePoints" in g else g.get("home_points")) is not None]
    done = played(cfbd("/games", "games", cur, year=season, seasonType="regular"))
    if not done:
        print(f"  no college games played in {season} yet")
        return
    weeks = sorted({g["week"] for g in done})
    # bowls and the playoff count, like every college season total (ESPN's too): one "Bowls" week after the last regular week
    post = played(cfbd("/games", "games_post", cur, year=season, seasonType="postseason"))
    done += post
    plan = [("regular", w, w) for w in weeks] + [("postseason", w, weeks[-1] + w) for w in sorted({g["week"] for g in post})]
    fbs = {t["id"]: t for t in site_teams()["cfb"]}
    tmeta = {f"cfb:{i}": [t["name"], t.get("abbr") or t["name"], t["color"], t["group"]] for i, t in fbs.items()}
    pts = {}
    for g in done:
        hp, ap = g.get("homePoints", g.get("home_points")), g.get("awayPoints", g.get("away_points"))
        hi, ai = g.get("homeId", g.get("home_id")), g.get("awayId", g.get("away_id"))
        pts[(g["id"], hi)] = (hp, ap, ai)
        pts[(g["id"], ai)] = (ap, hp, hi)
    adv = {}
    for a in cfbd("/stats/game/advanced", "advanced_games", cur, year=season, seasonType="regular", excludeGarbageTime="true") +             (cfbd("/stats/game/advanced", "advanced_games_post", cur, year=season, seasonType="postseason", excludeGarbageTime="true") if post else []):
        adv[(a.get("gameId") or a.get("game_id"), a["team"])] = a
    name_id = {t["name"]: i for i, t in fbs.items()}
    name_id.update({t["school"]: t["id"] for t in cfbd("/teams/fbs", "teams_fbs", cur, year=season) if t.get("school")})

    trows, prows, pmeta = [], [], {}
    for stype, w, wk in plan:
        tag = "" if stype == "regular" else "post_"
        last = cur and (stype == "postseason" or w >= weeks[-1] - 1)  # this week and last week can still change
        box = cfbd("/games/teams", f"games_teams_{tag}w{w}", last, year=season, week=w, seasonType=stype)
        for g in box:
            gid = g["id"]
            sides = g["teams"]
            for me, op in ((sides[0], sides[1]), (sides[1], sides[0])) if len(sides) == 2 else ():
                tid = me.get("teamId", me.get("school_id"))
                if tid not in fbs:
                    continue
                st = {s["category"]: s["stat"] for s in me["stats"]}
                ost = {s["category"]: s["stat"] for s in op["stats"]}
                cmp_, att = split(st.get("completionAttempts"))
                pen, pen_yds = split(st.get("totalPenaltiesYards"))
                t3, a3 = split(st.get("thirdDownEff"))
                p, o, oid = pts.get((gid, tid), (n(me.get("points")), n(op.get("points")), op.get("teamId")))
                school = me.get("team", me.get("school"))
                a = adv.get((gid, school), {})
                off, de = a.get("offense") or {}, a.get("defense") or {}
                pp, rp = off.get("passingPlays") or {}, off.get("rushingPlays") or {}
                plays = n(off.get("plays"))
                trows.append([f"cfb:{tid}", wk, f"cfb:{oid}", n(p), n(o), att + n(st.get("rushingAttempts")), cmp_, att,
                              n(st.get("netPassingYards")), n(st.get("passingTDs")), n(st.get("interceptions")), n(st.get("rushingAttempts")),
                              n(st.get("rushingYards")), n(st.get("rushingTDs")), n(st.get("firstDowns")), n(st.get("fumblesLost")), t3, a3,
                              n(st.get("sacks")), n(st.get("passesIntercepted")), n(st.get("tacklesForLoss")), pen, pen_yds,
                              n(ost.get("totalYards")), n(ost.get("netPassingYards")), n(ost.get("rushingYards")),
                              plays, round(n(off.get("totalPPA")), 2), round(n(off.get("successRate")) * plays, 2),
                              # pass/rush play counts aren't given: their share of plays comes from totalPPA / ppa
                              round(n(pp.get("totalPPA")) / n(pp.get("ppa")), 0) if n(pp.get("ppa")) else 0, round(n(pp.get("totalPPA")), 2),
                              round(n(rp.get("totalPPA")) / n(rp.get("ppa")), 0) if n(rp.get("ppa")) else 0, round(n(rp.get("totalPPA")), 2),
                              n(de.get("plays")), round(n(de.get("totalPPA")), 2), round(n(de.get("successRate")) * n(de.get("plays")), 2)])

        for g in cfbd("/games/players", f"games_players_{tag}w{w}", last, year=season, week=w, seasonType=stype):
            for tm in g["teams"]:
                tid = tm.get("teamId") or name_id.get(tm.get("team", tm.get("school")))
                if tid not in fbs:
                    continue
                me = defaultdict(lambda: [0] * len(PLAYER_COLS))
                for c in tm["categories"]:
                    for ty in c["types"]:
                        for at in ty["athletes"]:
                            pid = str(at["id"])
                            if not pid or pid.startswith("-"):  # team totals
                                continue
                            pmeta.setdefault(pid, [at["name"], "", f"cfb:{tid}"])
                            v, s = me[pid], at["stat"]
                            k = (c["name"], ty["name"])
                            if k == ("passing", "C/ATT"):
                                v[0], v[1] = split(s)
                            elif k == ("passing", "YDS"): v[2] = n(s)
                            elif k == ("passing", "TD"): v[3] = n(s)
                            elif k == ("passing", "INT"): v[4] = n(s)
                            elif k == ("rushing", "CAR"): v[6] = n(s)
                            elif k == ("rushing", "YDS"): v[7] = n(s)
                            elif k == ("rushing", "TD"): v[8] = n(s)
                            elif k == ("receiving", "REC"): v[9] = n(s)
                            elif k == ("receiving", "YDS"): v[11] = n(s)
                            elif k == ("receiving", "TD"): v[12] = n(s)
                            elif k == ("defensive", "TOT"): v[13] = n(s)
                            elif k == ("defensive", "SACKS"): v[14] = n(s)
                            elif k == ("defensive", "TFL"): v[15] = n(s)
                            elif k == ("defensive", "QB HUR"): v[16] = n(s)
                            elif k == ("defensive", "PD"): v[17] = n(s)
                            elif k == ("interceptions", "INT"): v[18] = n(s)
                            elif k == ("kicking", "FG"):
                                v[19], v[20] = split(str(s).replace("/", "-"))
                for pid, v in me.items():
                    if any(v):
                        prows.append([pid, wk, f"cfb:{tid}"] + v)

    # season PPA per player (CFBD only gives it for a whole season): added to each player's info
    pppa = {}
    for r in cfbd("/ppa/players/season", "ppa_players_season", cur, year=season, excludeGarbageTime="true", threshold=0):
        pid = str(r["id"])
        if pid in pmeta:
            pmeta[pid][1] = r.get("position") or ""
            avg, tot = r.get("averagePPA") or {}, r.get("totalPPA") or {}
            pppa[pid] = [round(n(tot.get("all")), 2), round(n(tot.get("pass")), 2), round(n(tot.get("rush")), 2), n(r.get("countablePlays"))]
    write("cfb", season, {"bowls": weeks[-1] + 1 if post else None, "teams": tmeta, "tcols": TEAM_COLS_CFB, "trows": trows, "pcols": PLAYER_COLS, "pmeta": pmeta, "prows": prows,
                          "pseason_cols": ["epa", "pass_epa", "rush_epa", "epa_plays"], "pseason": pppa})


# ------------------------------------------------------------------ the accuracy check
def check(lg, season):
    """Season totals vs ESPN's for a few teams: points, passing yards, rushing yards. Prints any gap over 2%."""
    f = OUT / f"{lg}_{season}.json"
    if not f.exists():
        return
    d = json.loads(f.read_text(encoding="utf-8"))
    c = {k: i + 3 for i, k in enumerate(d["tcols"])}
    sport = "nfl" if lg == "nfl" else "college-football"
    tot = defaultdict(lambda: defaultdict(float))
    for r in d["trows"]:
        for k in ("pts", "pass_yds", "rush_yds"):
            tot[r[0]][k] += r[c[k]]
    sample = sorted(tot, key=lambda k: -tot[k]["pts"])[:8]
    bad = 0
    for key in sample:
        tid = key.split(":")[1]
        try:
            j = requests.get(f"https://site.api.espn.com/apis/site/v2/sports/football/{sport}/teams/{tid}/statistics?season={season}", timeout=20).json()
            s = {}
            for cat in j["results"]["stats"]["categories"]:  # the same name shows up in several groups: the first one is the team's
                for x in cat["stats"]:
                    if x.get("value") is not None:
                        s.setdefault(x["name"], float(str(x["value"])))
        except Exception as e:
            print(f"  ESPN check skipped for {key}: {e}")
            continue
        want = {"pts": s.get("totalPoints"), "pass_yds": s.get("netPassingYards") if lg == "cfb" else s.get("passingYards"), "rush_yds": s.get("rushingYards")}
        for k, w in want.items():
            have = tot[key][k]
            if w and abs(have - w) / w > 0.02:
                bad += 1
                print(f"  ! {d['teams'].get(key, [key])[0]} {k}: ours {have:g}, ESPN {w:g}")
    print(f"  check {lg} {season}: {len(sample)} teams vs ESPN, {bad} gap(s) over 2%")

    # players: the top 5 passers, rushers and receivers on ESPN's leaderboard, stat by stat
    pc = {k: i + 3 for i, k in enumerate(d["pcols"])}
    ptot = defaultdict(lambda: defaultdict(float))
    for r in d["prows"]:
        for k in pc:
            ptot[r[0]][k] += r[pc[k]]
    CATS = {"passing": ("passing.passingYards", {"completions": "cmp", "passingAttempts": "att", "passingYards": "pass_yds", "passingTouchdowns": "pass_td", "interceptions": "int"}),
            "rushing": ("rushing.rushingYards", {"rushingAttempts": "carries", "rushingYards": "rush_yds", "rushingTouchdowns": "rush_td"}),
            "receiving": ("receiving.receivingYards", {"receptions": "rec", "receivingYards": "rec_yds", "receivingTouchdowns": "rec_td"})}
    pbad = checked = 0
    for cat, (sort, names) in CATS.items():
        try:
            j = requests.get(f"https://site.web.api.espn.com/apis/common/v3/sports/football/{sport}/statistics/byathlete",
                             params={"category": f"offense:{cat}", "sort": f"{sort}:desc", "limit": 5, "season": season, "seasontype": 2}, timeout=20).json()
            cols = next(c["names"] for c in j["categories"] if c["name"] == cat)
        except Exception as e:
            print(f"  ESPN player check skipped for {cat}: {e}")
            continue
        for a in j.get("athletes", []):
            pid, who = str(a["athlete"]["id"]), a["athlete"]["displayName"]
            vals = dict(zip(cols, next(c["totals"] for c in a["categories"] if c["name"] == cat)))
            if pid not in ptot:
                pbad += 1
                print(f"  ! {who} ({cat} leader on ESPN) isn't in our data")
                continue
            checked += 1
            for en, ours in names.items():
                want, have = n(str(vals.get(en, "0")).replace(",", "")), ptot[pid][ours]
                if abs(have - want) > max(2, 0.02 * abs(want)):
                    pbad += 1
                    print(f"  ! {who} {ours}: ours {have:g}, ESPN {want:g}")
    print(f"  check {lg} {season}: {checked} leading players vs ESPN, {pbad} gap(s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--league", choices=["nfl", "cfb", "all"], default="all")
    ap.add_argument("--season", type=int)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    for lg in (["nfl", "cfb"] if a.league == "all" else [a.league]):
        seasons = [a.season] if a.season else [s for s in range(FIRST[lg], season_now() + 1)
                                                 if s == season_now() or not (OUT / f"{lg}_{s}.json").exists()]
        for s in seasons:
            if not a.check:
                print(f"{lg} {s}")
                try:
                    (nfl if lg == "nfl" else cfb)(s)
                except SystemExit as e:  # no CFBD key
                    print(f"  skipped: {str(e).splitlines()[0]}")
                    continue
            check(lg, s)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
