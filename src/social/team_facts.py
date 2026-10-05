""""Just the Facts" for every college team: plain, true stats from our game history (same data and cupcake
rule as the cupcake stat posts). Written to docs/data/cfb/facts.json; team pages show them.
Also writes docs/data/cfb/shame.json for the Hall of Shame page (write_shame).

Each fact: {"big": short headline number, "label": what it is, "detail": the receipt (date, score, opponent)}.
A team only gets the facts that say something (no "0 straight wins over cupcakes").

    python src/social/team_facts.py      # needs data/history/cfb (cupcake_history.py)
"""
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cupcake_stats as C  # noqa: E402

OUT = HERE.parent.parent / "docs" / "data" / "cfb" / "facts.json"
SHAME = OUT.with_name("shame.json")


def rec(w, l):
    return f"{w}-{l}"


def since(dr):
    return f". Since then: {rec(dr['since_w'], dr['since_l'])}" if dr["since_w"] + dr["since_l"] else ""


def game_line(g):
    return f"{C.when(g['d'])}: {'W' if g['won'] else 'L'} {C.score(g)} {C.where(g)}"


def facts_for(team, start, upcoming, share_avg):
    tstart = C.team_start(team, start)
    gs = C.games_of(team, since=tstart)
    if len(gs) < 8:
        return []
    out = []

    # 1. cupcakes: current winning streak against them, or the last time one beat this team
    cups = [g for g in gs if g["cup"]]
    streak = 0
    for g in reversed(cups):
        if not g["won"]:
            break
        streak += 1
    last_loss = next((g for g in reversed(cups) if not g["won"]), None)
    if streak >= 5:
        out.append({"big": str(streak), "label": "straight wins over cupcakes",
                    "detail": f"Last loss to one: {game_line(last_loss)}" if last_loss else f"No losses to a cupcake since at least {tstart}"})
    elif last_loss:
        out.append({"big": C.when(last_loss["d"]).split(",")[0] + "," + C.when(last_loss["d"]).split(",")[1],
                    "label": "last loss to a cupcake", "detail": game_line(last_loss)})

    # 2. on the road against ranked teams
    dr = C.drought(gs, lambda g: g["loc"] == "A" and g["opp_ap"], tstart)
    if dr["n"]:
        if dr["last"]:
            out.append({"big": str(dr["last"]["season"]), "label": "last road win over a ranked team",
                        "detail": game_line(dr["last"]) + since(dr)})
        else:
            out.append({"big": rec(0, dr["since_l"]), "label": "on the road vs ranked teams",
                        "detail": f"No road wins over a ranked team since at least {tstart}"})

    # 3. against top-10 teams
    dr = C.drought(gs, lambda g: g["opp_ap"] and g["opp_ap"] <= 10, tstart)
    if dr["n"]:
        if dr["last"]:
            out.append({"big": str(dr["last"]["season"]), "label": "last win over a top-10 team",
                        "detail": game_line(dr["last"]) + since(dr)})
        else:
            out.append({"big": rec(0, dr["since_l"]), "label": "vs top-10 teams",
                        "detail": f"No wins over a top-10 team since at least {tstart}"})

    # 4. the split: cupcakes vs ranked teams, all-time in our data
    rk = [g for g in gs if g["opp_ap"]]
    cw, cl = sum(g["won"] for g in cups), sum(not g["won"] for g in cups)
    rw, rl = sum(g["won"] for g in rk), sum(not g["won"] for g in rk)
    if cups and rk:
        out.append({"big": f"{rec(cw, cl)} / {rec(rw, rl)}", "label": f"vs cupcakes / vs ranked teams since {tstart}",
                    "detail": f"{round(100 * cw / len(cups))}% against cupcakes, {round(100 * rw / len(rk))}% against ranked teams"})

    # 5. how much of the schedule has been cupcakes, next to the FBS average
    share = len(cups) / len(gs)
    out.append({"big": f"{round(100 * share)}%", "label": f"of games against cupcakes since {tstart}",
                "detail": f"The average FBS team: {round(100 * share_avg)}%." + (" More padded than most." if share > share_avg * 1.25
                          else " Less padded than most." if share < share_avg * 0.75 else "")})

    # 6. next opponent: the series in our data
    nxt = upcoming.get(team)
    if nxt:
        opp, loc = nxt
        vs = [g for g in gs if g["opp"] == opp]
        if vs:
            w, l = sum(g["won"] for g in vs), sum(not g["won"] for g in vs)
            last_w = next((g for g in reversed(vs) if g["won"]), None)
            out.append({"big": rec(w, l), "label": f"vs {opp} since {tstart} (next opponent)",
                        "detail": f"Last meeting: {game_line(vs[-1])}" + ("" if (last_w is vs[-1] or not last_w) else f". Last win: {C.when(last_w['d'])}")
                        + ("" if last_w else f". No wins since at least {tstart}")})
    return out


def write_shame(teams, start, today):
    """Hall of Shame numbers: every team's cupcake share since `start` (who pads the most), and the worst losses
    TO a cupcake (ranked teams first, then by margin). Same cupcake rule as everything else."""
    padded, losses = [], []
    for t in teams:
        tstart = C.team_start(t, start)
        gs = C.games_of(t, since=tstart)
        if len(gs) < 8:
            continue
        cups = [g for g in gs if g["cup"]]
        rk = [g for g in gs if g["opp_ap"]]
        padded.append({"team": t, "since": tstart, "games": len(gs), "cups": len(cups),
                       "cw": sum(g["won"] for g in cups), "cl": sum(not g["won"] for g in cups),
                       "rw": sum(g["won"] for g in rk), "rl": sum(not g["won"] for g in rk)})
        losses += [{"team": t, "opp": g["opp"], "d": g["d"], "season": g["season"], "score": C.score(g), "loc": g["loc"],
                    "our_ap": g["our_ap"], "margin": g["them"] - g["us"]} for g in cups if not g["won"]]
    padded.sort(key=lambda r: -r["cups"] / r["games"])
    losses.sort(key=lambda g: (g["our_ap"] or 99, -g["margin"], g["d"]))
    SHAME.write_text(json.dumps({"updated": today, "since": start, "padded": padded, "losses": losses[:40]},
                                separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"Hall of Shame: {len(padded)} teams, {len(losses)} cupcake losses -> {SHAME.name}")


def main():
    start = C.first_season()
    hs = C.history()
    if not hs or start is None or start > 2010:
        sys.exit("Game history is incomplete: run cupcake_history.py first.")
    cur = hs[max(hs)]
    today = dt.date.today().isoformat()
    upcoming = {}
    for x in cur["games"]:  # each team's next game
        if x["hp"] is None and x["d"] and x["d"] >= today:
            for t, o in ((x["h"], x["a"]), (x["a"], x["h"])):
                upcoming.setdefault(t, (o, x))
    upcoming = {t: (o, x) for t, (o, x) in upcoming.items()}
    teams = cur["fbs"]
    shares = []
    for t in teams:
        gs = C.games_of(t, since=C.team_start(t, start))
        if len(gs) >= 8:
            shares.append(sum(1 for g in gs if g["cup"]) / len(gs))
    avg = sum(shares) / len(shares)
    out = {"updated": today, "since": start, "teams": {}}
    for t in teams:
        f = facts_for(t, start, upcoming, avg)
        if f:
            out["teams"][t] = f
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(out['teams'])} teams -> {OUT.relative_to(HERE.parent.parent)} ({OUT.stat().st_size // 1024} KB)")
    write_shame(teams, start, today)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
