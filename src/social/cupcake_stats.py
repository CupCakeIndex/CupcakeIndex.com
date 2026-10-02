"""Cupcake stat posts for X: droughts and résumés only our model can make (QBgami-style, but ours).

Built on our own game history (cupcake_history.py) and the site's latest rankings file. "Cupcake" means
exactly what it means on the rankings page (same model, same rule). Every claim says how far back the data
goes, so we never call something a "first ever" that we can't back up.

The stats (college unless it says NFL):
  bully_drought   ranked teams that keep beating cupcakes but can't win on the road against ranked teams
  week_drought    this week's games: the longest drought the matchup puts on the line (vs this opponent,
                  on the road vs a ranked team, vs a top-10 team, at this stadium)
  soft_unbeaten   the softest N-0 start since <year>: the combined record of the FBS teams an unbeaten team beat
  top25_test      how often a typical top-25 team would match this team's record against its schedule
  nfl_top8_test   the same for the NFL (typical top-8 team)

DRAFT MODE: nothing posts unless you tick "Post to X" when you run the workflow.

    python src/social/cupcake_stats.py --all          # every stat that has something to say -> out/social/cupcake/
    python src/social/cupcake_stats.py                # the best one -> out/social/today.json
    python src/social/cupcake_stats.py --stat week_drought
"""
import argparse
import datetime as dt
import json
import os
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import obscure as O  # noqa: E402  (card + site themes + latest rankings file)
from render import ROOT, tweet, x_len  # noqa: E402
import model  # noqa: E402
import posted  # noqa: E402
from cupcake_history import OUT as HIST, cfg as cfb_cfg  # noqa: E402

TODAY = dt.date.today()
ALLOW_PARTIAL = False  # --test: also use seasons built without every piece (local checks only, never for posting)
YRS = 1.0  # --test shrinks the "years since" minimums so a short local history still exercises the code


# ------------------------------------------------------------------ history
_H = {}


def history():
    """All seasons on disk: {season: data}, oldest first. Seasons missing pieces are flagged, not hidden."""
    if not _H:
        for f in sorted(HIST.glob("*.json")):
            d = json.loads(f.read_text(encoding="utf-8"))
            _H[d["season"]] = d
    return _H


def first_season():
    """The first season of an unbroken, complete run up to today (claims only go back this far)."""
    hs = history()
    years = sorted(hs)
    if not years:
        return None
    first = years[-1]
    for y in reversed(years[:-1]):
        if y != first - 1 or (hs[y].get("partial") and not ALLOW_PARTIAL):
            break
        first = y
    return first


def team_start(team, start):
    """First season (at or after `start`) of an unbroken run of seasons this team appears in. Teams that moved up
    to FBS or changed names aren't in the early files, so a "since at least <year>" claim starts here instead."""
    seasons = sorted(y for y, d in history().items() if y >= start)
    first = None
    for y in reversed(seasons):
        if not any(team in (x["h"], x["a"]) for x in history()[y]["games"]):
            break
        first = y
    return first or start


def is_cup(season, team, opp):
    """Was `opp` a cupcake for `team` that season (same rule as the site)?"""
    d = history()[season]
    R, fbs = d["ratings"], set(d["fbs"])
    tr = R.get(team)
    if tr is None:
        return False
    low = opp not in fbs
    orr = R.get(opp)
    if orr is None:
        return low  # a lower-division team with no rating: always a cupcake
    return model.cupcake_weight(tr, orr, low, cfb_cfg()) > 0


def games_of(team, since=None, done=True):
    """A team's games, oldest first, from its point of view."""
    out = []
    for season, d in history().items():
        if since and season < since:
            continue
        for x in d["games"]:
            if team not in (x["h"], x["a"]) or (done and x["hp"] is None):
                continue
            home = x["h"] == team
            us, them = (x["hp"], x["ap"]) if home else (x["ap"], x["hp"])
            opp = x["a"] if home else x["h"]
            out.append({"season": season, "d": x["d"], "opp": opp, "loc": "N" if x["n"] else ("H" if home else "A"),
                        "us": us, "them": them, "won": us is not None and us > them, "post": x["p"],
                        "opp_ap": x["ar"] if home else x["hr"], "our_ap": x["hr"] if home else x["ar"],
                        "cup": is_cup(season, team, opp) if us is not None else None})
    return out


def when(d):
    d = dt.date.fromisoformat(d)
    return f"{d:%b} {d.day}, {d.year}"


def years_ago(d):
    return (TODAY - dt.date.fromisoformat(d)).days / 365.25


def score(g):
    return f"{g['us']}-{g['them']}"


def where(g, rank=True):
    r = f"No. {g['opp_ap']} " if rank and g["opp_ap"] else ""
    return ("at " if g["loc"] == "A" else "vs. ") + r + g["opp"]


def drought(gs, match, start):
    """Last win among games matching `match`, and the W-L since. None if the team never had a game like it."""
    hits = [g for g in gs if match(g)]
    wins = [g for g in hits if g["won"]]
    last = wins[-1] if wins else None
    after = hits[hits.index(last) + 1:] if last else hits
    return {"last": last, "since_w": sum(g["won"] for g in after), "since_l": sum(not g["won"] for g in after),
            "years": years_ago(last["d"]) if last else TODAY.year - start + 0.5, "n": len(hits)}


# ------------------------------------------------------------------ stats
STATS = {}


def stat(key):
    def wrap(fn):
        STATS[key] = fn
        return fn
    return wrap


def subjects(league="cfb"):
    ts, by, wk = O.teams(league)
    return ts, by


def fact(league, rows, title, sub, unit, text, big=None, big_unit=None, score_=0.0):
    if not rows:
        return None
    return {"league": league, "kind": "team", "rows": rows[:5], "title": title, "sub": sub, "unit": unit, "text": text,
            "question": None, "hot": False, "tag": "CUPCAKE STATS", "big": big, "big_unit": big_unit or "", "score": score_}


@stat("bully_drought")
def _():
    start = first_season()
    ts, by = subjects("cfb")
    cands = []
    for t in ts:
        if not (t.get("ap_rank") or t["power_rank"] <= 25):
            continue
        tstart = team_start(t["team"], start)
        gs = games_of(t["team"], since=tstart)
        streak = 0
        for g in reversed(gs):  # consecutive wins over cupcakes, newest first (other games don't break it)
            if not g["cup"]:
                continue
            if not g["won"]:
                break
            streak += 1
        dr = drought(gs, lambda g: g["loc"] == "A" and g["opp_ap"], tstart)
        if streak < 8 or dr["years"] < 3 * YRS or dr["since_l"] < 3:
            continue
        cands.append((t, dr, streak, tstart))
    cands.sort(key=lambda c: (-c[1]["years"], -c[2]))
    if not cands:
        return None
    t, dr, streak, start = cands[0]
    last = dr["last"]
    tail = (f"its last one came {when(last['d'])}, {score(last)} {where(last)}." if last
            else f"it hasn't won one since at least {start}, as far back as our data goes.")
    text = (f"{t['team']} has won {streak} straight games against cupcakes. On the road against ranked teams, it's "
            f"0-{dr['since_l']}: {tail}")
    rows = [(c[0], c[1]["years"], f"0-{c[1]['since_l']} since {c[1]['last']['d'][:4] if c[1]['last'] else c[3]}") for c in cands]
    big = f"0-{dr['since_l']}"
    unit = f"on the road vs ranked teams since {last['d'][:4] if last else start}"
    return fact("cfb", rows, "Bullies at home, lost on the road", "Ranked teams that keep beating cupcakes: record in road games against ranked teams since their last win",
                "road games vs ranked teams since the last win", text, big, unit, dr["years"] + streak / 10)


def week_games(days=8):
    """This week's college games (not played yet), from the current season's history file."""
    cur = history().get(max(history())) if history() else None
    if not cur:
        return []
    end = TODAY + dt.timedelta(days=days)
    return [x for x in cur["games"] if x["hp"] is None and x["d"] and TODAY <= dt.date.fromisoformat(x["d"]) <= end]


@stat("week_drought")
def _():
    start = first_season()
    ts, by = subjects("cfb")
    found = []
    for x in week_games():
        for team, opp, loc, opp_ap in ((x["a"], x["h"], "N" if x["n"] else "A", x["hr"]), (x["h"], x["a"], "N" if x["n"] else "H", x["ar"])):
            if team not in by:
                continue
            start = team_start(team, first_season())
            gs = games_of(team, since=start)
            day = dt.date.fromisoformat(x["d"]).strftime("%A")
            nxt = f"{day}: {'at' if loc == 'A' else 'vs.'} {'No. ' + str(opp_ap) + ' ' if opp_ap else ''}{opp}."
            opts = []
            dr = drought(gs, lambda g: g["opp"] == opp, start)
            if dr["n"] and dr["since_l"] >= 3 and dr["years"] >= 5 * YRS:
                lead = (f"{team} has lost {dr['since_l']} straight to {opp}. Last win: {when(dr['last']['d'])}, {score(dr['last'])}."
                        if dr["last"] else f"{team} is 0-{dr['since_l']} against {opp} since at least {start}.")
                opts.append((dr, lead, f"lost {dr['since_l']} in a row"))
            if loc == "A" and opp_ap:
                dr = drought(gs, lambda g: g["loc"] == "A" and g["opp_ap"], start)
                if dr["since_l"] >= 3 and dr["years"] >= 4 * YRS:
                    lead = (f"{team} hasn't won a road game against a ranked team since {when(dr['last']['d'])} ({score(dr['last'])} {where(dr['last'])}). It's 0-{dr['since_l']} since."
                            if dr["last"] else f"{team} hasn't won a road game against a ranked team since at least {start} (0-{dr['since_l']}).")
                    opts.append((dr, lead, f"0-{dr['since_l']} at ranked"))
            if opp_ap and opp_ap <= 10:
                dr = drought(gs, lambda g: g["opp_ap"] and g["opp_ap"] <= 10, start)
                if dr["since_l"] >= 3 and dr["years"] >= 4 * YRS:
                    lead = (f"{team} hasn't beaten a top-10 team since {when(dr['last']['d'])} ({score(dr['last'])} {where(dr['last'])}). It's 0-{dr['since_l']} since."
                            if dr["last"] else f"{team} hasn't beaten a top-10 team since at least {start} (0-{dr['since_l']}).")
                    opts.append((dr, lead, f"0-{dr['since_l']} vs top 10"))
            if loc == "A":
                dr = drought(gs, lambda g: g["opp"] == opp and g["loc"] == "A", start)
                if dr["n"] and dr["since_l"] >= 3 and dr["years"] >= 8 * YRS:
                    lead = (f"{team} hasn't won at {opp} since {when(dr['last']['d'])} ({score(dr['last'])}). It's 0-{dr['since_l']} there since."
                            if dr["last"] else f"{team} is 0-{dr['since_l']} at {opp} since at least {start}.")
                    opts.append((dr, lead, f"0-{dr['since_l']} at {opp}"))
            for dr, lead, lab in opts:
                found.append((by[team], dr, lead + " " + nxt, lab))
    if not found:
        return None
    found.sort(key=lambda f: -(f[1]["years"] + f[1]["since_l"] / 10))
    seen, rows = set(), []
    for t, dr, _, lab in found:  # one row per team on the card
        if t["team"] not in seen:
            seen.add(t["team"])
            rows.append((t, dr["years"], lab))
    t, dr, text, lab = found[0]
    since = dr["last"]["d"][:4] if dr["last"] else f"{start}"
    return fact("cfb", rows, "On the line this week", "The longest droughts this week's games could end (our data goes back to " + str(start) + ")",
                "years since the last win", text, since, "last time it happened" if dr["last"] else "not since at least", dr["years"])


@stat("soft_unbeaten")
def _():
    start = first_season()
    hs = history()
    if not hs or start is None:
        return None
    cur_season = max(hs)
    ts, by = subjects("cfb")

    def records(season, upto):
        """Every team's W-L in games on or before `upto` that season."""
        rec = {}
        for x in hs[season]["games"]:
            if x["hp"] is None or x["d"] > upto:
                continue
            for t, w in ((x["h"], x["hp"] > x["ap"]), (x["a"], x["ap"] > x["hp"])):
                r = rec.setdefault(t, [0, 0])
                r[0 if w else 1] += 1
        return rec

    def resume(season, team, n):
        """If the team started n-0: (beaten FBS opponents' W, L, FCS wins, date of win n) as of that date."""
        gs = [g for g in games_of(team, since=season) if g["season"] == season and not g["post"]][:n]
        if len(gs) < n or not all(g["won"] for g in gs):
            return None
        rec = records(season, gs[-1]["d"])
        fbs = set(hs[season]["fbs"])
        w = l = fcs = 0
        for g in gs:
            if g["opp"] in fbs:
                ow, ol = rec.get(g["opp"], [0, 0])
                w, l = w + ow, l + ol - 1  # leave out the loss to us
            else:
                fcs += 1
        return w, l, fcs, gs[-1]["d"]

    cands = []
    for t in ts:
        if t["losses"] or t["wins"] < 4:
            continue
        r = resume(cur_season, t["team"], t["wins"])
        if r and r[0] + r[1]:
            cands.append((t, r))
    if not cands:
        return None
    pct = lambda r: r[0] / (r[0] + r[1]) if r[0] + r[1] else 1.0
    cands.sort(key=lambda c: (pct(c[1]), -c[1][2]))
    t, r = cands[0]
    n = t["wins"]
    # the last season (before this one) with an n-0 start at least this soft
    prev = None
    for season in sorted(hs, reverse=True):
        if season == cur_season or season < start:
            continue
        for team in hs[season]["fbs"]:
            pr = resume(season, team, n)
            if pr and pr[0] + pr[1] and (pct(pr), -pr[2]) <= (pct(r), -r[2]):
                if not prev or pr[3] > prev[2][3]:
                    prev = (season, team, pr)
        if prev:
            break
    fcs = f" (plus {r[2]} FCS)" if r[2] else ""
    since = (f"That's the softest {n}-0 start since {prev[1]} in {prev[0]} ({prev[2][0]}-{prev[2][1]})." if prev
             else f"That's the softest {n}-0 start in our data, which goes back to {start}.")
    text = f"{t['team']} is {n}-0. The FBS teams it has beaten are a combined {r[0]}-{r[1]}{fcs}. {since}"
    rows = [(c[0], -pct(c[1]), f"{c[1][0]}-{c[1][1]}" + (f" +{c[1][2]} FCS" if c[1][2] else "")) for c in cands]
    return fact("cfb", rows, f"Softest {n}-0 since {prev[0]}" if prev else f"Softest {n}-0 we can find", "Unbeaten teams, by the combined record of the FBS teams they've beaten",
                "combined record of FBS teams beaten", text, f"{r[0]}-{r[1]}", "combined record of the FBS teams beaten",
                (TODAY.year - prev[0]) if prev else TODAY.year - start)


def at_least(ps, k):
    """Chance of winning at least k of these games (each p = chance to win)."""
    dist = [1.0]
    for p in ps:
        nd = [0.0] * (len(dist) + 1)
        for i, q in enumerate(dist):
            nd[i] += q * (1 - p)
            nd[i + 1] += q * p
        dist = nd
    return sum(dist[k:])


def top_test(league):
    ts, by = subjects(league)
    bench = "top-25" if league == "cfb" else "top-8"
    cands = []
    for t in ts:
        played = [s for s in t["schedule"] if s.get("result") and s.get("difficulty") is not None]
        # college: unbeaten teams only (a 3-1 team matching a top-25 team isn't much of a story); NFL: one loss is fine
        if len(played) < 3 or t["losses"] > (0 if league == "cfb" else 1) or not (t.get("ap_rank") or t["power_rank"] <= (25 if league == "cfb" else 10)):
            continue
        p = at_least([1 - s["difficulty"] for s in played], t["wins"])
        cands.append((t, p))
    cands = sorted([c for c in cands if c[1] >= 0.6], key=lambda c: (c[0]["losses"], -c[1]))  # unbeaten teams first
    if not cands:
        return None
    t, p = cands[0]
    better = "" if t["losses"] == 0 else " or better"
    who = f"The {t['team']} are" if league == "nfl" else f"{t['team']} is"
    text = (f"{who} {t['record']}. Hand that same schedule to a typical {bench} team and our model says it goes "
            f"{t['record']}{better} {round(p * 100)}% of the time.")
    rows = [(c[0], c[1], f"{round(c[1] * 100)}%") for c in cands]
    return fact(league, rows, "Would anyone good do this?", f"How often a typical {bench} team matches each record against the same schedule",
                f"chance a typical {bench} team does it too", text, f"{round(p * 100)}%", f"of typical {bench} teams go {t['record']}{better}", p * 10)


@stat("top25_test")
def _():
    return top_test("cfb")


@stat("nfl_top8_test")
def _():
    return top_test("nfl")


# ------------------------------------------------------------------ driver
def make(key, out, theme=None):
    f = STATS[key]()
    if not f:
        return None
    theme = theme or random.choice(list(O.THEMES))
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"cupcake-{key}.png")
    O.card(f, theme).convert("RGB").save(png, optimize=True)
    text = tweet(f["text"], "", with_link=False)  # never a link (Terry's rule)
    meta = {"day": "cupcake", "stat": key, "theme": theme, "image": png, "text": text, "score": round(f["score"], 2),
            "draft": True, "skip": False, "reason": ""}
    with open(os.path.join(out, f"cupcake-{key}.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1, ensure_ascii=False)
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stat", default="best", help="a stat key, or best (default)")
    ap.add_argument("--theme", choices=["random", *O.THEMES], default="random")
    ap.add_argument("--all", action="store_true", help="render every stat (drafts to review)")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    ap.add_argument("--test", action="store_true", help="local check: use partial seasons too (never post these)")
    a = ap.parse_args()
    global ALLOW_PARTIAL, YRS
    ALLOW_PARTIAL, YRS = a.test, (0.1 if a.test else 1.0)
    if a.stat not in STATS and a.stat != "best":
        sys.exit(f"Unknown stat '{a.stat}'. Pick one of: {', '.join(STATS)}")
    print(f"History: {sorted(history())} (claims go back to {first_season()})")
    if not a.test and (first_season() or 9999) > 2010:
        sys.exit("Game history is incomplete (needs every season back to at least 2010): not making a post. "
                 "Run cupcake_history.py first (the workflow does).")
    keys = list(STATS) if (a.all or a.stat == "best") else [a.stat]
    out = os.path.join(a.out, "cupcake") if a.all else a.out
    made = []
    for key in keys:
        try:
            m = make(key, out, None if a.theme == "random" else a.theme)
        except Exception as e:  # one stat failing shouldn't stop the rest
            print(f"[{key}] failed: {e!r}")
            m = None
        if m:
            made.append(m)
            print(f"[{key}] {m['theme']} score {m['score']} ({x_len(m['text'])} chars)\n   {m['text']}")
        else:
            print(f"[{key}] nothing to say right now")
    if not made:
        sys.exit("No cupcake stat had anything to say.")
    if a.all:
        with open(os.path.join(out, "drafts.md"), "w", encoding="utf-8") as fh:
            fh.write("\n\n".join(f"## {m['stat']}\n![]({os.path.basename(m['image'])})\n\n{m['text']}" for m in made))
    fresh = [m for m in made if not posted.seen(m["text"]) and m["stat"] not in posted.recent_stats(3)] or         [m for m in made if not posted.seen(m["text"])]
    if not fresh:
        sys.exit("Everything we have to say was already posted.")
    best = max(fresh, key=lambda m: m["score"])
    if a.all:  # drafts only: the post comes from a separate --stat run
        return
    with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
        json.dump(best, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
