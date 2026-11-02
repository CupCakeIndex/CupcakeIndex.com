"""Picks of the Week (Play > Picks of the Week): NFL tickets built from lines players have cleared recently -> docs/data/parlays.json.

A line is the lowest, 2nd lowest or middle number from a player's last 5 games, rounded down to 5. Its chance is how often
lines of the same kind hit in past seasons, grouped by stat, games cleared, opponent defense tier and boom-or-bust
(src/picks_table.json, rebuilt by --train). Riskier tickets use harder lines, not more legs: 2 to 5 legs, one per team.

The news changes tickets through the week. Run by .github/workflows/parlays.yml:
  - dropped: Out, Doubtful, Questionable, IR or suspended; traded or cut; a QB who lost the job; receivers whose QB changed
  - chance moved, by amounts measured on 2016-2025 games (NEWS below): wind, freezing cold, key defenders out or back
Injuries come from the nfl.com report (docs/data/nfl_injuries.json) when it covers this week, then ESPN. QB1 comes from
team sites (nfl_depth.py), rosters from ESPN, weather from Open-Meteo, stats and schedule from nflverse.
If rosters or injuries can't be read, the old file stays. Pays are estimates: no feed has real prices for these lines.

    python src/picks.py                  # this week's tickets
    python src/picks.py --train          # rebuild src/picks_table.json from 2012-2025 (run once a year)
    python src/picks.py --replay 8       # what last week's tickets would have done (no news, stats through week 7)
"""
import csv
import json
import random
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
RAW = ROOT / "data" / "raw" / "picks"
TABLE = ROOT / "src" / "picks_table.json"
OUT = ROOT / "docs" / "data" / "parlays.json"
INJ = ROOT / "docs" / "data" / "nfl_injuries.json"
NFLV = "https://github.com/nflverse/nflverse-data/releases/download"
GAMES = "https://github.com/nflverse/nfldata/raw/master/data/games.csv"
ET = ZoneInfo("America/New_York")
FIX = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS"}
ESPN_T = {"WAS": "WSH", "LA": "LAR"}
CUT = .955     # estimated book price per leg, about a 4.5% cut
LEVELS = {"1.5": 2, "2": 3, "3": 3, "5": 4, "10": 5}  # slider level: legs on the ticket
MIN_P = .5     # no leg under a coin flip
# stat: (player column, team column the defense allowed, smallest line, positions)
STATS = {"pass": ("passing_yards", "passing_yards", 150, ("QB",)), "rush": ("rushing_yards", "rushing_yards", 15, ("QB", "RB")),
         "rec": ("receiving_yards", "passing_yards", 15, ("RB", "WR", "TE"))}
# Change in hit rate, measured on 54,402 legs 2016-2025 and rounded toward zero. One key defender out moved nothing.
NEWS = {"wind15": {"pass": -.12, "rec": -.05}, "wind10": {"pass": -.03}, "cold": {"pass": -.05, "rec": -.05},
        "two_out": {"pass": .05}, "back": {"rush": -.03}}
DROP = {"out", "doubtful", "questionable", "injured reserve", "ir", "suspension", "suspended", "pup", "physically unable to perform"}
DEF = ("DL", "LB", "DB")

fx = lambda t: FIX.get(t, t)


def n(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def name_key(s):
    s = re.sub(r"[^a-z ]", "", (s or "").lower())
    return re.sub(r"\s+(jr|sr|ii|iii|iv|v)$", "", s).strip()


def rows(url, name, fresh=False):
    RAW.mkdir(parents=True, exist_ok=True)
    fp = RAW / name
    if fresh or not fp.exists():
        urllib.request.urlretrieve(url, fp)
    with open(fp, encoding="utf8", newline="") as f:
        return list(csv.DictReader(f))


class Season:
    """One season's games and weekly stats."""

    def __init__(self, y, sched, fresh=False):
        self.y = y
        self.opp, self.team, self.games = {}, {}, {}
        self.player = defaultdict(list)
        for g in sched:
            if g["game_type"] == "REG" and int(g["season"]) == y:
                w, h, a = int(g["week"]), fx(g["home_team"]), fx(g["away_team"])
                self.opp[(w, h)], self.opp[(w, a)] = a, h
                self.games[(w, h)] = self.games[(w, a)] = g
        for r in rows(f"{NFLV}/stats_team/stats_team_week_{y}.csv", f"team_{y}.csv", fresh):
            if r["season_type"] == "REG":
                self.team[(int(r["week"]), fx(r["team"]))] = r
        for r in rows(f"{NFLV}/stats_player/stats_player_week_{y}.csv", f"player_{y}.csv", fresh):
            if r["season_type"] == "REG":
                self.player[r["player_id"]].append(r)
        for L in self.player.values():
            L.sort(key=lambda r: int(r["week"]))
        self._tier = {}

    def tiers(self, w, kind):
        """{team: 0 tough, 1 middle, 2 soft} from what each defense allowed before week w (3+ games)."""
        if (w, kind) not in self._tier:
            col, tot = STATS[kind][1], {}
            for (wk, t), _ in self.team.items():
                o = self.team.get((wk, self.opp.get((wk, t))))
                if wk < w and o:
                    a = tot.setdefault(t, [0, 0]); a[0] += n(o[col]); a[1] += 1
            rate = {t: v[0] / v[1] for t, v in tot.items() if v[1] >= 3}
            s = sorted(rate, key=rate.get)
            self._tier[(w, kind)] = {t: min(2, 3 * i // max(1, len(s))) for i, t in enumerate(s)}
        return self._tier[(w, kind)]

    def key_defenders(self, w, t):
        """A team's top 2 defenders by production through week w-1 (3+ games): [(name, games missed of the last 4)]."""
        tot, seen, names = defaultdict(float), defaultdict(set), {}
        for pid, L in self.player.items():
            for r in L:
                wk = int(r["week"])
                if wk < w and fx(r["team"]) == t and r.get("position_group") in DEF:
                    tot[pid] += 4 * n(r.get("def_sacks")) + 4 * n(r.get("def_interceptions")) + 1.5 * n(r.get("def_pass_defended")) + 1.5 * n(r.get("def_tackles_for_loss")) + .25 * n(r.get("def_tackles_solo"))
                    seen[pid].add(wk); names[pid] = r.get("player_display_name")
        top = sorted((p for p in tot if len(seen[p]) >= 3), key=lambda p: -tot[p] / len(seen[p]))[:2]
        played = sorted({wk for (wk, tt) in self.team if tt == t and wk < w})[-4:]
        return [(names[p], sum(k not in seen[p] for k in played)) for p in top]


def lines(L, kind):
    """The lines a player's last 5 games offer: [(games cleared, line, boom or bust)]."""
    col, _, floor, _ = STATS[kind]
    last = sorted(n(x[col]) for x in L[-5:])
    wild = last[4] / max(last[2], 1) > 1.8
    out = [(c, int(v // 5 * 5), wild) for c, v in ((5, last[0]), (4, last[1]), (3, last[2]))]
    return [x for x in out if x[1] >= floor]


def key(kind, cleared, tier, wild):
    return f"{kind}|{cleared}|{tier}|{int(wild)}"


def leg_candidates(S, w, tab):
    """Every line for week w from stats before it. Chance comes from tab; nothing here uses week w's results."""
    out = []
    for pid, L0 in S.player.items():
        L = [r for r in L0 if int(r["week"]) < w]
        if len(L) < 5 or int(L[-1]["week"]) < w - 2:
            continue
        r, t = L[-1], fx(L[-1]["team"])
        o = S.opp.get((w, t))
        if not o:
            continue
        for kind, st in STATS.items():
            if (r.get("position") or "") not in st[3]:
                continue
            T = S.tiers(w, kind).get(o)
            if T is None:
                continue
            for cleared, line, wild in lines(L, kind):
                a = tab.get(key(kind, cleared, T, wild))
                if a and a[1] >= 30:
                    out.append({"name": r.get("player_display_name") or r.get("player_name"), "pid": pid, "team": t, "opp": o, "pos": r.get("position"), "kind": kind,
                                "line": line, "cleared": cleared, "tier": T, "wild": wild, "p": a[0] / a[1], "notes": []})
    return out


def usable(x):
    return not x["wild"] and x["tier"] >= 1 and x["p"] >= MIN_P


def want(target, k):
    return CUT / target ** (1 / k)  # the chance each leg needs so the ticket pays the target after the cut


def tickets(pool, level, count):
    """Ticket `count` start further down the list, so tickets differ. One leg per team, since teammates rise and fall together."""
    target, k = float(level), LEVELS[level]
    q = want(target, k)
    pool = sorted((x for x in pool if x["p"] <= q + .04), key=lambda x: abs(x["p"] - q))
    res = []
    for start in range(count):
        pick, teams, mult = [], set(), 1.0
        for x in pool[start * k:]:
            if x["team"] in teams:
                continue
            pick.append(x); teams.add(x["team"]); mult /= x["p"]
            if len(pick) == k:
                break
        if len(pick) == k and mult * CUT ** k >= target * .85:
            res.append({"legs": pick, "fair": mult, "pays": mult * CUT ** k, "chance": 1 / mult})
    return res


def actual(S, pid, w, kind):
    """A player's real number in week w, or None without a game."""
    for r in S.player[pid]:
        if int(r["week"]) == w:
            return n(r[STATS[kind][0]])
    return None


# ---------------------------------------------------------------- history
class Blank:
    """Stands in for the chance table while it is being built."""

    def get(self, _):
        return [1, 99]


def train():
    sched = rows(GAMES, "games.csv", True)
    seasons = {y: Season(y, sched) for y in range(2012, 2026)}
    legs = []
    for y, S in seasons.items():
        for w in range(6, 19):
            for kind_key in leg_candidates(S, w, Blank()):
                v = actual(S, kind_key["pid"], w, kind_key["kind"])
                if v is not None:
                    kind_key.update(y=y, w=w, hit=v >= kind_key["line"], k=key(kind_key["kind"], kind_key["cleared"], kind_key["tier"], kind_key["wild"]))
                    legs.append(kind_key)
    test = []
    for y in range(2016, 2026):  # each season's chances come only from the seasons before it
        tab = defaultdict(lambda: [0, 0])
        for L in legs:
            if L["y"] < y:
                tab[L["k"]][0] += L["hit"]; tab[L["k"]][1] += 1
        for L in legs:
            if L["y"] == y and tab[L["k"]][1] >= 30:
                L["p"] = tab[L["k"]][0] / tab[L["k"]][1]
                test.append(L)
    weeks = defaultdict(list)
    for L in test:
        if usable(L):
            weeks[(L["y"], L["w"])].append(L)
    bt = {}
    for level in LEVELS:
        T = [t for pool in weeks.values() for t in tickets(pool, level, 3)]
        won = [all(x["hit"] for x in t["legs"]) for t in T]
        bt[level] = {"hit": round(100 * sum(won) / len(T), 1), "n": len(T), "legs": LEVELS[level], "said": round(100 * sum(t["chance"] for t in T) / len(T), 1),
                     "roi": round(100 * sum((t["pays"] if h else 0) - 1 for t, h in zip(T, won)) / len(T))}
    full = defaultdict(lambda: [0, 0])
    for L in legs:
        full[L["k"]][0] += L["hit"]; full[L["k"]][1] += 1
    TABLE.write_text(json.dumps({"table": full, "backtest": bt}, indent=0), encoding="utf8")
    print(bt)


# ---------------------------------------------------------------- this week's news
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        return json.loads(r.read())


def rosters(teams):
    """{name key: (team, ESPN id)}. Raises if most teams can't be read."""
    seen = {}
    ok = 0
    for t in teams:
        try:
            d = get(f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{ESPN_T.get(t, t).lower()}/roster")
        except Exception as e:  # noqa: BLE001
            print(f"roster {t}: {e}")
            continue
        ok += 1
        for grp in d.get("athletes", []):
            for a in grp.get("items", []):
                seen[name_key(a.get("fullName") or a.get("displayName"))] = (t, a.get("id"))
    if ok < 30:
        raise RuntimeError(f"only {ok} rosters read")
    return seen


def injuries(week, nick_to_team):
    """{name key: (status, injury)} for players who shouldn't be on a ticket. nfl.com's report wins for teams it covers this week."""
    out, covered = {}, set()
    try:
        rep = json.loads(INJ.read_text(encoding="utf8"))
    except (OSError, ValueError):
        rep = {}
    if rep.get("week") == week:
        for nick, v in rep.get("teams", {}).items():
            covered.add(nick_to_team.get(nick))
            for p in v["players"]:
                if p[4].lower() in DROP:
                    out[name_key(p[0])] = (p[4], p[2])
    for tm in get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries")["injuries"]:
        t = fx(tm.get("abbreviation") or "") or None
        t = nick_to_team.get((tm.get("displayName") or "").split(" ")[-1], t)
        for i in tm.get("injuries", []):
            st = (i.get("status") or "").lower()
            lasting = st in ("injured reserve", "suspension", "physically unable to perform")
            if st in DROP and (t not in covered or lasting):
                out.setdefault(name_key(i["athlete"]["displayName"]), (i.get("status"), ""))
    return out


def weather(g):
    """(wind mph, temp F) forecast at kickoff for an open-air game, else (None, None)."""
    from nfl_features import STADIUMS
    ll = STADIUMS.get(fx(g["home_team"]))
    if not ll or g.get("roof") != "outdoors" or g.get("location") == "Neutral":
        return None, None
    utc = kick(g).astimezone(timezone.utc)
    try:
        h = get(f"https://api.open-meteo.com/v1/forecast?latitude={ll[0]}&longitude={ll[1]}&hourly=wind_speed_10m,temperature_2m"
                f"&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&start_date={utc:%Y-%m-%d}&end_date={utc:%Y-%m-%d}")["hourly"]
        return float(h["wind_speed_10m"][utc.hour]), float(h["temperature_2m"][utc.hour])
    except Exception:  # noqa: BLE001 - too far out or the service is down: no change
        return None, None


def kick(g):
    return datetime.fromisoformat(f"{g['gameday']}T{g.get('gametime') or '13:00'}").replace(tzinfo=ET)


def apply_news(S, w, cand, roster, hurt, qb1):
    """Drops or adjusts each line for the news. Returns the lines that came off, each with its reason."""
    keep, off = [], []
    wx, defs, starters = {}, {}, {}
    now_out = lambda nm, t: name_key(nm) in hurt or roster.get(name_key(nm), (None,))[0] != t
    for x in cand:
        t, nk = x["team"], name_key(x["name"])
        L = [r for r in S.player[x["pid"]] if int(r["week"]) < w][-5:]
        why = None
        if nk in hurt:
            why = f"{hurt[nk][0]}" + (f" ({hurt[nk][1].lower()})" if hurt[nk][1] else "")
        elif nk not in roster:
            why = "no longer on a roster"
        elif roster[nk][0] != t:
            why = f"now with {roster[nk][0]}, so recent games don't count"
        elif x["pos"] == "QB" and t in qb1 and name_key(qb1[t]) != nk:
            why = f"{qb1[t]} is listed as the starter"
        elif x["kind"] == "rec" and t in qb1 and name_key(qb1[t]) not in hurt:  # a hurt QB1 isn't taking over
            if t not in starters:
                att = defaultdict(float)
                for pid, PL in S.player.items():
                    for r in PL:
                        if fx(r["team"]) == t and int(r["week"]) >= w - 5:
                            att[r.get("player_display_name")] += n(r.get("attempts"))
                starters[t] = max(att, key=att.get) if att else None
            if starters[t] and name_key(starters[t]) != name_key(qb1[t]):
                why = f"{qb1[t]} takes over at QB for {starters[t]}"
        if why:
            off.append({**x, "why": why})
            continue
        x["id"] = roster[nk][1]
        g = S.games[(w, t)]
        gid = g["game_id"]
        if gid not in wx:
            wx[gid] = weather(g)
        wind, temp = wx[gid]
        d = 0.0
        if wind is not None and wind >= 15:
            d += NEWS["wind15"].get(x["kind"], 0)
        elif wind is not None and wind >= 10:
            d += NEWS["wind10"].get(x["kind"], 0)
        if temp is not None and temp < 32 and (wind is None or wind < 15):
            d += NEWS["cold"].get(x["kind"], 0)
        if d or (wind is not None and wind >= 15):
            x["notes"].append(f"{wind:.0f} mph wind, {temp:.0f}°F forecast")
        o = x["opp"]
        if o not in defs:
            defs[o] = S.key_defenders(w, o)
        top = defs[o]
        gone = [nm for nm, _ in top if now_out(nm, o)]
        back = [nm for nm, miss in top if miss >= 2 and nm not in gone]
        if gone:
            x["notes"].append(", ".join(gone) + (" out" if len(gone) == 1 else " both out") + f" for {o}")
        if back:
            x["notes"].append(", ".join(back) + f" back for {o}")
        if len(gone) >= 2:
            d += NEWS["two_out"].get(x["kind"], 0)
        if back:
            d += NEWS["back"].get(x["kind"], 0)
        x["p"] = round(min(.9, x["p"] + d), 4)
        keep.append(x)
    return keep, off


def week_now(sched, y, now):
    """The first week with 3+ games still to play, so the page moves on once only Monday night is left."""
    left = [int(g["week"]) for g in sched if g["game_type"] == "REG" and g["season"] == str(y) and kick(g) > now]
    weeks = sorted(set(left))
    return next((w for w in weeks if left.count(w) >= 3), weeks[-1] if weeks else None)


def build():
    now = datetime.now(timezone.utc)
    y = now.year if now.month >= 3 else now.year - 1
    sched = rows(GAMES, "games.csv", True)
    w = week_now(sched, y, now)
    if not w:
        return print("No games left this season.")
    S = Season(y, sched, True)
    saved = json.loads(TABLE.read_text(encoding="utf8"))
    nick = {}
    teams = sorted({t for (_, t) in S.team})
    for tm in get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams")["sports"][0]["leagues"][0]["teams"]:
        nick[tm["team"]["name"]] = fx(tm["team"]["abbreviation"])
    try:
        roster, hurt = rosters(teams), injuries(w, nick)
    except Exception as e:  # noqa: BLE001 - old tickets beat tickets that ignore the news
        return print(f"News unavailable, keeping the old file: {e}")
    import nfl_depth
    qb1 = nfl_depth.refresh() or {}
    cand = [x for x in leg_candidates(S, w, saved["table"]) if kick(S.games[(w, x["team"])]) > now]
    pool, off = apply_news(S, w, cand, roster, hurt, qb1)
    pool = [x for x in pool if usable(x)]
    for x in pool:
        g = S.games[(w, x["team"])]
        x.update(day=kick(g).strftime("%a"), kick=kick(g).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), away=fx(g["away_team"]) == x["team"],
                 prime=g["gametime"] >= "19:30" or g["weekday"] in ("Monday", "Thursday"))
    slim = lambda t: {"pays": round(t["pays"], 1), "chance": round(t["chance"], 3), "legs": [{k: l[k] for k in ("name", "id", "team", "opp", "kind", "line", "cleared", "tier", "day", "away", "notes")} | {"p": round(l["p"], 3)} for l in t["legs"]]}
    data = {"season": y, "week": w, "levels": {k: [slim(t) for t in tickets(pool, k, 3)] for k in LEVELS},
            "prime": {k: [slim(t) for t in tickets([x for x in pool if x["prime"]], k, 1)] for k in LEVELS}, "backtest": saved["backtest"]}
    old = json.loads(OUT.read_text(encoding="utf8")) if OUT.exists() else {}
    seen = {c["k"]: c for c in old.get("changes", [])} if old.get("week") == w else {}
    was = {f'{l["name"]}|{l["kind"]}' for lv in ("levels", "prime") for ts in old.get(lv, {}).values() for t in ts for l in t["legs"]} if old.get("week") == w else set()
    stamp = now.strftime("%Y-%m-%dT%H:%MZ")
    best = {}
    for x in sorted(off, key=lambda x: x["p"]):
        if not x["wild"] and x["tier"] >= 1 and x["p"] >= .6:
            best[x["name"]] = x
    for nm, x in best.items():
        k = f'{nm}|{x["why"]}'
        if k not in seen and (f'{nm}|{x["kind"]}' in was or not old or old.get("week") != w):
            seen[k] = {"k": k, "name": nm, "team": x["team"], "why": x["why"], "at": stamp}
    data["changes"] = sorted(seen.values(), key=lambda c: c["at"], reverse=True)[:12]
    if {k: v for k, v in old.items() if k != "updated"} == data:
        return print("No change.")
    data = {"updated": stamp, **data}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf8")
    print(f"Week {w}: {len(pool)} usable lines, {len(off)} off for news, {len(data['changes'])} changes listed")


def replay(w):
    """What week w's tickets would have done. Stats stop before week w; the chance table only uses 2012-2025.
    Old injury reports aren't saved, so a player who ended up not playing comes off his ticket, as a book would void him."""
    now = datetime.now(timezone.utc)
    y = now.year if now.month >= 3 else now.year - 1
    sched = rows(GAMES, "games.csv", True)
    S = Season(y, sched, True)
    tab = json.loads(TABLE.read_text(encoding="utf8"))["table"]
    pool = [x for x in leg_candidates(S, w, tab) if usable(x)]
    tot = {}
    for level in LEVELS:
        print(f"\n{level}x")
        wins, staked, back = 0, 0, 0.0
        for t in tickets(pool, level, 3) + tickets([x for x in pool if S.games[(w, x["team"])]["gametime"] >= "19:30" or S.games[(w, x["team"])]["weekday"] in ("Monday", "Thursday")], level, 1):
            res, pays = [], t["pays"]
            ok, pending = True, False
            for x in t["legs"]:
                g = S.games[(w, x["team"])]
                v = actual(S, x["pid"], w, x["kind"])
                if v is None and g["home_score"] == "":
                    pending = True; res.append(f'{x["name"]} {x["line"]}+ {x["kind"]} NOT PLAYED YET')
                elif v is None:
                    pays /= (CUT / x["p"]); res.append(f'{x["name"]} {x["line"]}+ {x["kind"]} VOID (didn\'t play)')
                else:
                    ok = ok and v >= x["line"]; res.append(f'{x["name"]} {x["line"]}+ {x["kind"]}: {int(v)} {"HIT" if v >= x["line"] else "MISS"}')
            word = "PENDING" if pending and ok else "WON" if ok else "LOST"
            print(f"  {word} pays {pays:.1f}x, said {t['chance']:.0%}: " + "; ".join(res))
            if word != "PENDING":
                staked += 1; back += pays if ok else 0; wins += ok
        tot[level] = (wins, staked, round(back - staked, 2))
        print(f"  {wins} of {staked} won, ${(back - staked) * 10:+.0f} on $10 a ticket")
    return tot


if __name__ == "__main__":
    if "--train" in sys.argv:
        train()
    elif "--replay" in sys.argv:
        for wk in sys.argv[sys.argv.index("--replay") + 1].split(","):
            print(f"\n=== Week {wk} ===")
            replay(int(wk))
    else:
        build()
