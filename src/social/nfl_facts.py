""""Just the Facts" for every NFL team: true stats from every game since 1999 (nflverse's free game file).
Written to docs/data/nfl/facts.json; NFL team pages show them, same as college (team_facts.py).

The NFL has no AP poll, so the college facts get NFL stand-ins:
  (cupcakes: no longer shown; the NFL uses strength of schedule. Kept here for reference)
  cupcakes          the NFL cupcake rule from the site (clearly bad AND 5+ points worse), with each past season's
                    ratings from its scores (our power rating, scores only) and the site's own ratings this season
  "ranked" teams    teams with a winning record going into the game
  "top-10" teams    our top 10 by rating: that season's final ratings, or today's for this season
plus the playoff record, prime-time record, and the series with the next opponent.
Relocated teams are one franchise: Oakland/Las Vegas Raiders, San Diego/LA Chargers, St. Louis/LA Rams.

    python src/social/nfl_facts.py            # uses the cached games file (the weekly job refreshes it)
    python src/social/nfl_facts.py --refresh  # download a fresh copy first
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import model  # noqa: E402
import nfl_data  # noqa: E402

OUT = HERE.parent.parent / "docs" / "data" / "nfl" / "facts.json"
FIRST = 1999
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA"}  # old abbreviation -> today's
OLD_NAME = {"OAK": "Oakland", "SD": "San Diego", "STL": "St. Louis"}
POST = {"WC", "DIV", "CON", "SB"}
ROUND = {"WC": "Wild Card round", "DIV": "Divisional round", "CON": "conference title game", "SB": "Super Bowl"}


def cfg():
    with open(HERE.parent / "config.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)["nfl"]["model"]


def when(d):
    d = dt.date.fromisoformat(d)
    return f"{d:%b} {d.day}, {d.year}"


def rec(w, l, t=0):
    return f"{w}-{l}" + (f"-{t}" if t else "")


def load(refresh=False):
    rows = nfl_data._csv(nfl_data.GAMES_URL, "games.csv", refresh)
    teams = {r["team_abbr"]: r["team_name"] for r in nfl_data._csv(nfl_data.TEAMS_URL, "teams.csv", False)}
    return rows, teams


def season_ratings(rows, c):
    """Each season's power rating from its regular-season scores (same solver as the site, scores only)."""
    by = {}
    for r in rows:
        if r["game_type"] == "REG" and r["home_score"] != "":
            by.setdefault(int(r["season"]), []).append(r)
    out = {}
    for season, gs in by.items():
        teams = sorted({FRANCHISE.get(t, t) for r in gs for t in (r["home_team"], r["away_team"])})
        games = [{"hnode": FRANCHISE.get(r["home_team"], r["home_team"]), "anode": FRANCHISE.get(r["away_team"], r["away_team"]),
                  "hp": int(r["home_score"]), "ap": int(r["away_score"]), "done": True, "neutral": r["location"] == "Neutral"} for r in gs]
        out[season] = model.power_ratings(teams, games, c)
    return out


def site_ratings(names):
    """This season's ratings from the site's latest rankings file: {season: {abbr: rating}} (empty if missing)."""
    try:
        sys.path.insert(0, str(HERE))
        from render import latest
        cur, _, _ = latest("nfl")
    except Exception as e:
        print(f"(site ratings unavailable, using scores only: {e!r})")
        return {}
    abbr = {n: a for a, n in names.items()}
    return {cur["season"]: {abbr[t["team"]]: t["rating"] for t in cur["teams"] if t["team"] in abbr}}


def team_games(rows, R, c):
    """Every finished game from each team's point of view, oldest first, with the context the facts need."""
    seasons = sorted({int(r["season"]) for r in rows})
    top10 = {s: set(sorted(R.get(s, {}), key=lambda t: -R[s][t])[:10]) for s in seasons}
    out, record = {}, {}
    for r in sorted(rows, key=lambda r: (r["gameday"], r["game_id"])):
        if r["home_score"] == "":
            continue
        s = int(r["season"])
        h, a = FRANCHISE.get(r["home_team"], r["home_team"]), FRANCHISE.get(r["away_team"], r["away_team"])
        hp, ap = int(r["home_score"]), int(r["away_score"])
        rec_before = {t: tuple(record.get((s, t), (0, 0, 0))) for t in (h, a)}
        for me, opp, us, them, loc, raw in ((h, a, hp, ap, "N" if r["location"] == "Neutral" else "H", r["home_team"]),
                                            (a, h, ap, hp, "N" if r["location"] == "Neutral" else "A", r["away_team"])):
            ow, ol, ot = rec_before[opp]
            tr, orr = R.get(s, {}).get(me), R.get(s, {}).get(opp)
            out.setdefault(me, []).append({
                "season": s, "d": r["gameday"], "opp": opp, "loc": loc, "us": us, "them": them,
                "won": us > them, "tie": us == them, "post": r["game_type"], "raw": raw,
                "opp_winning": ow > ol, "opp_rec": rec(ow, ol, ot), "opp_top10": opp in top10[s],
                "cup": tr is not None and orr is not None and model.cupcake_weight(tr, orr, False, c) > 0,
                "night": (r["gametime"] or "00:00") >= "19:00"})
        if r["game_type"] == "REG":
            for t, us, them in ((h, hp, ap), (a, ap, hp)):
                w, l, t_ = record.get((s, t), (0, 0, 0))
                record[(s, t)] = (w + (us > them), l + (us < them), t_ + (us == them))
    return out


def where(g, names):
    opp = names.get(g["opp"], g["opp"])
    return ("at " if g["loc"] == "A" else "vs. ") + opp


def line(g, names, note=None):
    """'Jan 19, 2003: W 41-24 vs. Tennessee Titans (AFC title game, as the Oakland Raiders)'"""
    notes = [note] if note else []
    if g["raw"] in OLD_NAME:
        notes.append(f"as the {OLD_NAME[g['raw']]} {names.get(FRANCHISE[g['raw']], '').split()[-1]}")
    res = "W" if g["won"] else "T" if g["tie"] else "L"
    return f"{when(g['d'])}: {res} {g['us']}-{g['them']} {where(g, names)}" + (f" ({', '.join(notes)})" if notes else "")


def drought(gs, match):
    hits = [g for g in gs if match(g)]
    wins = [g for g in hits if g["won"]]
    last = wins[-1] if wins else None
    after = hits[hits.index(last) + 1:] if last else hits
    return last, sum(g["won"] for g in after), sum(not g["won"] and not g["tie"] for g in after), len(hits)


def facts_for(team, gs, names, upcoming):
    out = []
    since = lambda w, l: f". Since then: {rec(w, l)}" if w + l else ""
    # 1. cupcakes: dropped Oct 2026 (the NFL side of the site uses strength of schedule, not cupcakes)
    cups = []
    streak = 0
    for g in reversed(cups):
        if not g["won"]:
            break
        streak += 1
    last_loss = next((g for g in reversed(cups) if not g["won"]), None)
    if streak >= 5:
        out.append({"big": str(streak), "label": "straight wins over cupcakes",
                    "detail": f"Last loss to one: {line(last_loss, names)}" if last_loss else f"No losses to a cupcake since at least {FIRST}"})
    elif last_loss:
        out.append({"big": when(last_loss["d"]).rsplit(",", 1)[0] + "," + when(last_loss["d"]).rsplit(",", 1)[1],
                    "label": "last loss to a cupcake", "detail": line(last_loss, names)})
    # 2. on the road against winning teams (going into the game)
    last, w, l, n = drought(gs, lambda g: g["loc"] == "A" and g["opp_winning"])
    if n:
        out.append({"big": str(last["season"]), "label": "last road win over a team with a winning record",
                    "detail": f"{line(last, names)} ({last['opp_rec']} going in){since(w, l)}"} if last else
                   {"big": rec(0, l), "label": "on the road vs teams with a winning record", "detail": f"No such win since at least {FIRST}"})
    # 3. against top-10 teams (our ratings: final for past seasons, today's for this one)
    last, w, l, n = drought(gs, lambda g: g["opp_top10"])
    if n:
        out.append({"big": str(last["season"]), "label": "last win over a top-10 team", "detail": line(last, names) + since(w, l)} if last else
                   {"big": rec(0, l), "label": "vs top-10 teams", "detail": f"No wins over a top-10 team since at least {FIRST}"})
    # 4. playoffs
    po = [g for g in gs if g["post"] in POST]
    pw, pl = sum(g["won"] for g in po), sum(not g["won"] for g in po)
    last_w = next((g for g in reversed(po) if g["won"]), None)
    if po:
        out.append({"big": rec(pw, pl), "label": f"in the playoffs since {FIRST}",
                    "detail": f"Last playoff win: {line(last_w, names, ROUND[last_w['post']])}" if last_w else f"No playoff wins since at least {FIRST}"})
    else:
        out.append({"big": "0", "label": f"playoff games since {FIRST}", "detail": "Hasn't made the playoffs in our data"})
    # 5. prime time
    nt = [g for g in gs if g["night"] and g["post"] == "REG"]
    if len(nt) >= 10:
        nw, nl = sum(g["won"] for g in nt), sum(not g["won"] and not g["tie"] for g in nt)
        recent = nt[-10:]
        out.append({"big": rec(nw, nl), "label": f"in prime time since {FIRST}",
                    "detail": f"{round(100 * nw / len(nt))}% wins. Last 10 prime-time games: {rec(sum(g['won'] for g in recent), sum(not g['won'] and not g['tie'] for g in recent))}"})
    # 6. next opponent
    nxt = upcoming.get(team)
    if nxt:
        vs = [g for g in gs if g["opp"] == nxt]
        if vs:
            w, l = sum(g["won"] for g in vs), sum(not g["won"] and not g["tie"] for g in vs)
            lw = next((g for g in reversed(vs) if g["won"]), None)
            out.append({"big": rec(w, l), "label": f"vs {names.get(nxt, nxt)} since {FIRST} (next opponent)",
                        "detail": f"Last meeting: {line(vs[-1], names)}" + ("" if (lw is vs[-1] or not lw) else f". Last win: {when(lw['d'])}")
                        + ("" if lw else f". No wins since at least {FIRST}")})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    rows, abbr_name = load(a.refresh)
    names = {t: n for t, n in abbr_name.items() if t not in FRANCHISE}
    c = cfg()
    R = {**season_ratings(rows, c), **site_ratings(names)}
    games = team_games(rows, R, c)
    today = dt.date.today().isoformat()
    upcoming = {}
    for r in sorted(rows, key=lambda r: r["gameday"]):
        if r["home_score"] == "" and r["gameday"] >= today:
            for t, o in ((r["home_team"], r["away_team"]), (r["away_team"], r["home_team"])):
                upcoming.setdefault(FRANCHISE.get(t, t), FRANCHISE.get(o, o))
    out = {"updated": today, "since": FIRST, "teams": {}}
    for t, gs in games.items():
        if t in names:
            out["teams"][names[t]] = facts_for(t, gs, names, upcoming)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(out['teams'])} teams -> {OUT.relative_to(HERE.parent.parent)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
