"""Coach profiles for the coach pages: docs/data/coach_profile.json.

Background (every coach with a Wikipedia career list, data/history/wiki_coaches.json from src/coach_tree.py): how
many of his assistant years were on offense, defense or special teams, and his coordinator jobs. Mostly one side =
an "offensive mind" / "defensive mind".

Scheme (current head coaches): his team's real tendencies with him in charge, ranked against the other current
head coaches' teams.
  NFL, 2023 on: nflverse play-by-play (pass rate over expected, no-huddle, 4th-and-short go rate), FTN charting
  (under center, motion, play action, RPOs, screens, blitzes) and NFL Next Gen Stats participation (personnel
  groupings, man/zone, coverage shells, defensive front; 2023-25 so far).
  College, 2024 on: game totals (docs/data/viz/cfb_*.json): pass rate, pace, sacks + tackles for loss.
Tags ("Play-action heavy", "Blitz-heavy") only when a team is near the top or bottom of the league.

    python src/coach_profile.py
"""
import csv
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "docs" / "data" / "coach_profile.json"
NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
FIRST = {"nfl": 2023, "cfb": 2024}
OLD = {"SD": "LAC", "STL": "LA", "OAK": "LV"}

OFF = re.compile(r"offens|quarterback|running back|wide receiver|receivers|tight end|offensive line|passing game|run game|\b(OC|QB|QBs|RB|RBs|WR|WRs|TE|TEs|OL|RGC|PGC)\b", re.I)
DEF = re.compile(r"defens|linebacker|defensive back|secondary|safet|cornerback|defensive line|defensive end|defensive tackle|pass rush|nickel|\b(DC|LB|LBs|DB|DBs|DL|CB|CBs|DE|DT|S)\b", re.I)
ST = re.compile(r"special teams|kicking|\bST\b|\bSTC\b", re.I)


def slug(name):
    import coach_tree
    return coach_tree.slug(name)


# ------------------------------------------------------------------ background: which side of the ball he coached

def background(jobs, now):
    side = Counter()
    coord = []
    seasons = set()  # every season he was an assistant (a job on both sides, or a graduate assistant, counts once)
    for lg, team, y1, y2, role, head in jobs:
        if head:
            continue
        yrs = min(y2, now) - y1 + 1
        seasons |= set(range(y1, min(y2, now) + 1))
        r = role or ""
        o, d, s = bool(OFF.search(r)), bool(DEF.search(r)), bool(ST.search(r))
        if re.search(r"offensive", r, re.I):
            o, d = True, bool(re.search(r"defensive", r, re.I))
        elif re.search(r"defensive", r, re.I):
            o, d = False, True
        for k, on in (("off", o), ("def", d), ("st", s)):
            if on:
                side[k] += yrs
        m = re.search(r"(co-)?(offensive|defensive|special teams) coordinator", r, re.I)
        if m:
            coord.append([m.group(0)[0].upper() + m.group(0)[1:], lg, team, y1, min(y2, now)])
    total = sum(side.values())
    if not total:
        return None
    o, d, s = side["off"], side["def"], side["st"]
    lab = ("off" if o >= 2 * max(d, 1) and o >= 3 else "def" if d >= 2 * max(o, 1) and d >= 3
           else "st" if s >= 2 * max(o, d, 1) else "both")
    coord.sort(key=lambda c: -c[3])
    return {"lab": lab, "yrs": len(seasons), "off": o, "def": d, "st": s, "coord": coord[:3]}


# ------------------------------------------------------------------ NFL team tendencies

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def nfl_team_seasons(seasons):
    """{(team, season): {stat: [numerator, denominator]}} for the regular season."""
    from deep_stats import pbp
    from viz_data import nflverse_csv
    T = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    for y in seasons:
        plays = {}  # (game, play) -> (offense, defense, pass?, down)
        for r in pbp(y):
            if r.get("season_type") != "REG" or r.get("play_type") not in ("pass", "run", "punt", "field_goal"):
                continue
            off, de = OLD.get(r["posteam"], r["posteam"]), OLD.get(r["defteam"], r["defteam"])
            S, D = T[(off, y)], T[(de, y)]
            pt, down, togo, yl = r["play_type"], num(r.get("down")), num(r.get("ydstogo")), num(r.get("yardline_100"))
            if down == 4 and togo is not None and togo <= 2 and yl is not None and yl <= 60 and r.get("qb_kneel") != "1":
                S["go4"][0] += pt in ("pass", "run")  # 4th and 1-2 past his own 40: went for it, or punted / kicked
                S["go4"][1] += 1
            if pt not in ("pass", "run") or r.get("qb_kneel") == "1" or r.get("qb_spike") == "1":
                continue
            plays[(r["game_id"], str(int(num(r["play_id"]))))] = (off, de, pt == "pass", down)
            oe = num(r.get("pass_oe"))
            if oe is not None:
                S["proe"][0] += oe
                S["proe"][1] += 1
            S["nohuddle"][0] += r.get("no_huddle") == "1"
            S["nohuddle"][1] += 1
        try:
            ftn = nflverse_csv(f"{NFLV}/ftn_charting/ftn_charting_{y}.csv", f"ftn_charting_{y}.csv")
        except Exception:
            ftn = []
        for r in ftn:
            p = plays.get((r["nflverse_game_id"], str(int(num(r["nflverse_play_id"]) or 0))))
            if not p:
                continue
            off, de, is_pass, _ = p
            S, D = T[(off, y)], T[(de, y)]
            if r.get("qb_location") in ("U", "S", "P"):
                S["center"][0] += r["qb_location"] == "U"
                S["center"][1] += 1
            S["motion"][0] += r.get("is_motion") in ("TRUE", "1", "True")
            S["motion"][1] += 1
            S["rpo"][0] += r.get("is_rpo") in ("TRUE", "1", "True")
            S["rpo"][1] += 1
            if is_pass:
                S["pa"][0] += r.get("is_play_action") in ("TRUE", "1", "True")
                S["pa"][1] += 1
                S["screen"][0] += r.get("is_screen_pass") in ("TRUE", "1", "True")
                S["screen"][1] += 1
                b = num(r.get("n_blitzers"))
                if b is not None:
                    D["blitz"][0] += b > 0
                    D["blitz"][1] += 1
        try:
            part = nflverse_csv(f"{NFLV}/pbp_participation/pbp_participation_{y}.csv", f"pbp_participation_{y}.csv")
        except Exception:
            part = []  # not published yet for this season
        for r in part:
            p = plays.get((r["nflverse_game_id"], str(int(num(r["play_id"]) or 0))))
            if not p:
                continue
            off, de, is_pass, down = p
            S, D = T[(off, y)], T[(de, y)]
            pers = dict((k, int(v)) for v, k in re.findall(r"(\d+) ([A-Z]+)", r.get("offense_personnel") or ""))
            if pers:
                g = f"{pers.get('RB', 0) + pers.get('FB', 0)}{pers.get('TE', 0)}"
                S["pers:" + g][0] += 1
                S["heavy"][0] += pers.get("TE", 0) >= 2
                S["heavy"][1] += 1
            mz = r.get("defense_man_zone_type")
            if mz in ("MAN_COVERAGE", "ZONE_COVERAGE"):
                D["man"][0] += mz == "MAN_COVERAGE"
                D["man"][1] += 1
            cv = r.get("defense_coverage_type")
            if cv and cv.startswith("COVER_"):
                D["cov:" + cv[6:]][0] += 1
                D["cov"][1] += 1
            dp = dict((k, int(v)) for v, k in re.findall(r"(\d+) ([A-Z]+)", r.get("defense_personnel") or ""))
            if dp and down in (1, 2):
                D["dl"][0] += dp.get("DE", 0) + dp.get("DT", 0) + dp.get("NT", 0)
                D["dl"][1] += 1
        print(f"  {y}: {len(plays)} plays, FTN {len(ftn)}, participation {len(part)}")
    return T


NFL_STATS = [  # key, label, how to show it, side
    ("proe", "Pass rate over expected", "pts", "off"), ("center", "Under center", "pct", "off"), ("pa", "Play action (of dropbacks)", "pct", "off"),
    ("motion", "Pre-snap motion", "pct", "off"), ("rpo", "RPOs", "pct", "off"), ("screen", "Screens (of dropbacks)", "pct", "off"),
    ("nohuddle", "No-huddle", "pct", "off"), ("heavy", "2+ tight ends on the field", "pct", "off"),
    ("go4", "Goes for it on 4th & 1–2 (past his own 40)", "pct", "game"),
    ("blitz", "Blitz rate (of dropbacks)", "pct", "def"), ("man", "Man coverage", "pct", "def"), ("dl", "Down linemen (1st/2nd down)", "avg", "def"),
]
NFL_TAGS = [  # key, top-N tag, bottom-N tag
    ("proe", "Pass-first", "Run-first"), ("center", "Lots of under-center snaps", "Shotgun-heavy"), ("pa", "Play-action heavy", None),
    ("motion", "Lots of pre-snap motion", "Little motion"), ("rpo", "RPO-heavy", None), ("screen", "Screen-happy", None),
    ("nohuddle", "Up-tempo (no-huddle)", None), ("heavy", "Heavy personnel (2+ TEs)", None),
    ("go4", "Aggressive on 4th down", "Conservative on 4th down"), ("blitz", "Blitz-heavy", "Rarely blitzes"),
    ("man", "Man coverage", "Zone coverage"),
]


def rank_all(vals):
    """vals {coach: value} -> {coach: rank} (1 = highest)."""
    order = sorted((v, k) for k, v in vals.items() if v is not None)[::-1]
    return {k: i + 1 for i, (v, k) in enumerate(order)}


def nfl_profiles(C, now):
    cur = [c for c in C["nfl"]["coaches"] if c["on"]]
    seasons = list(range(FIRST["nfl"], now + 1))
    T = nfl_team_seasons(seasons)
    agg = {}
    for c in cur:
        ys = sorted({s[0] for s in c.get("sea", []) if s[1] == c["tm"] and s[0] in seasons})
        A = defaultdict(lambda: [0.0, 0.0])
        for y in ys:
            for k, (a, b) in T.get((c["tm"], y), {}).items():
                A[k][0] += a
                A[k][1] += b
        agg[c["n"]] = (ys, A)
    out = {}
    vals = {}
    for key, *_ in NFL_STATS:
        vals[key] = {n: (A[key][0] / A[key][1] if A[key][1] else None) for n, (ys, A) in agg.items()}
    ranks = {k: rank_all(v) for k, v in vals.items()}
    for n, (ys, A) in agg.items():
        if not ys:
            continue
        st = []
        for key, label, fmt, side in NFL_STATS:
            v = vals[key][n]
            if v is not None:
                st.append([key, label, round(v * (1 if fmt in ("pts", "avg") else 100), 1), fmt, side, ranks[key].get(n), len(ranks[key])])
        pers = Counter({k[5:]: a for k, (a, b) in A.items() if k.startswith("pers:")})
        tot_p = sum(pers.values())
        covs = Counter({k[4:]: a for k, (a, b) in A.items() if k.startswith("cov:")})
        tot_c = sum(covs.values())
        tags = []
        for key, top, bottom in NFL_TAGS:
            r, N = ranks[key].get(n), len(ranks[key])
            if r and top and r <= 5:
                tags.append([top, key])
            elif r and bottom and r > N - 5:
                tags.append([bottom, key])
        if tot_p and sum(v for k, v in pers.items() if k[0] == "2") >= 0.2 * tot_p:
            tags.append(["Uses a fullback (21/22 personnel)", "pers"])  # Shanahan: few 2-TE sets, but a fullback, not a spread
        elif tot_p and pers.get("11", 0) >= 0.75 * tot_p:
            tags.append(["Lives in 11 personnel (3 WRs)", "pers"])
        dl = vals["dl"][n]
        if dl is not None:
            tags.append(["3-man front" if dl < 3.4 else "4-man front" if dl >= 3.7 else "Mixed fronts", "dl"])
        out[slug(n)] = {"lg": "nfl", "seasons": ys, "stats": st, "tags": tags,
                        "pers": [[k, round(100 * v / tot_p)] for k, v in pers.most_common(3)] if tot_p else [],
                        "cov": [[k, round(100 * v / tot_c)] for k, v in covs.most_common(3)] if tot_c else []}
    return out


# ------------------------------------------------------------------ college: game totals

def cfb_profiles(C, now):
    cur = [c for c in C["cfb"]["coaches"] if c["on"]]
    T = defaultdict(lambda: defaultdict(float))
    names = {}
    for y in range(FIRST["cfb"], now + 1):
        f = ROOT / "docs" / "data" / "viz" / f"cfb_{y}.json"
        if not f.exists():
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        cols = d["tcols"]
        names.update({k: v[0] for k, v in d["teams"].items()})
        for row in d["trows"]:
            S = T[(d["teams"].get(row[0], [row[0]])[0], y)]
            vals = dict(zip(cols, row[3:]))
            S["g"] += 1
            for k in ("plays", "att", "carries", "def_sacks", "tfl"):
                S[k] += vals.get(k) or 0
    stats = {}
    for c in cur:
        ys = sorted({s[0] for s in c.get("sea", []) if s[1] == c["tm"] and s[0] >= FIRST["cfb"]})
        A = defaultdict(float)
        for y in ys:
            for k, v in T.get((c["tm"], y), {}).items():
                A[k] += v
        if A["g"]:
            stats[c["n"]] = (ys, {"pass": A["att"] / max(1, A["att"] + A["carries"]), "pace": A["plays"] / A["g"], "havoc": (A["def_sacks"] + A["tfl"]) / A["g"]})
    labels = [("pass", "Pass rate (passes of all plays)", "pct", "off", "Pass-heavy", "Run-heavy"),
              ("pace", "Plays per game", "avg", "off", "Up-tempo", "Slow pace"),
              ("havoc", "Sacks + tackles for loss per game", "avg", "def", "Disruptive defense", None)]
    ranks = {k: rank_all({n: s[k] for n, (ys, s) in stats.items()}) for k, *_ in labels}
    out = {}
    for n, (ys, s) in stats.items():
        N = len(stats)
        st, tags = [], []
        for k, label, fmt, side, top, bottom in labels:
            v = s[k] * (100 if fmt == "pct" else 1)
            st.append([k, label, round(v, 1), fmt, side, ranks[k][n], N])
            if top and ranks[k][n] <= 15:
                tags.append([top, k])
            elif bottom and ranks[k][n] > N - 15:
                tags.append([bottom, k])
        out[slug(n)] = {"lg": "cfb", "seasons": ys, "stats": st, "tags": tags, "pers": [], "cov": []}
    return out


def main():
    C = json.loads((ROOT / "docs" / "data" / "coaches.json").read_text(encoding="utf-8"))
    wiki = json.loads((ROOT / "data" / "history" / "wiki_coaches.json").read_text(encoding="utf-8"))
    now = max(s[0] for c in C["nfl"]["coaches"] for s in c.get("sea", []))
    prof = {}
    for name, w in wiki.items():
        b = background(w.get("jobs", []), now)
        if b:
            prof[slug(name)] = {"bg": b}
    scheme = {}
    try:
        scheme.update(nfl_profiles(C, now))
    except Exception as e:  # noqa: BLE001 - keep the backgrounds even if a download fails
        print(f"  NFL schemes skipped: {e}")
    try:
        scheme.update(cfb_profiles(C, now))
    except Exception as e:  # noqa: BLE001
        print(f"  college schemes skipped: {e}")
    for k, v in scheme.items():
        prof.setdefault(k, {})["scheme"] = v
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                               "first": FIRST, "coaches": prof}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    labs = Counter(p["bg"]["lab"] for p in prof.values() if "bg" in p)
    print(f"  coach profiles: {sum('bg' in p for p in prof.values())} backgrounds {dict(labs)}, {len(scheme)} schemes; {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
