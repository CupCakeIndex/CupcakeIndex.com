"""Deep cuts for Stats > Visualize (NFL): super specific player stats per game from nflverse play-by-play, added to
docs/data/viz/nfl_<season>.json by viz_data.py (xcols + a sparse list on each player row; the page expands it).

Run stops, stuffs, short-yardage stops, 3rd-down stops, red-zone stops, plus offense cuts (deep balls, 3rd-down
conversions, goal-line carries, clutch EPA). extra() gives each player a role (EDGE, IDL, LB, CB, S, QB, RB, WR, TE),
his year in the league and draft slot, so the page can show things like "run stops by rookie linebackers".

A "stop" = the offense failed on that play: it gained under 40% of the yards needed on 1st down, under 60% on 2nd,
or didn't convert on 3rd/4th (the usual success-rate rule, close to PFF's "run stop"). Fumbles lost count as stops.
Everyone credited with the tackle (solo or assisted) gets the stop.
"""
import csv
import gzip
from collections import defaultdict
from datetime import datetime

import requests

from viz_data import NFLV, RAW, season_now

XCOLS = [
    # defense (tackles, sacks, TFL, hits, PD, INTs are already in the chart data)
    "run_tkl", "run_stop", "run_tkl_yds", "stuff", "sy_tkl", "sy_stop", "pass_tkl", "pass_stop", "third_stop", "rz_stop",
    "third_sacks", "ff", "fr",
    # running
    "rush_succ", "rush_stuffed", "rush_10", "sy_carries", "sy_conv", "rz_carries", "gl_carries", "gl_td",
    # receiving
    "deep_tgt", "deep_rec", "rec_20", "third_tgt", "third_conv", "rz_tgt", "rz_rec_td",
    # passing
    "dropbacks", "hit", "deep_att", "deep_cmp", "deep_yds", "third_db", "third_db_conv", "clutch_db", "clutch_epa", "rz_att", "rz_pass_td",
]


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def ids(row, *cols):
    out = []
    for c in cols:
        v = row.get(c)
        if v and v != "NA" and v not in out:
            out.append(v)
    return out


TACKLERS = ["solo_tackle_1_player_id", "solo_tackle_2_player_id", "assist_tackle_1_player_id", "assist_tackle_2_player_id",
            "assist_tackle_3_player_id", "assist_tackle_4_player_id", "tackle_with_assist_1_player_id", "tackle_with_assist_2_player_id",
            "tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id"]


def failed(row):
    """The offense lost the play (a 'stop' for whoever made the tackle)."""
    if row.get("fumble_lost") == "1" or row.get("interception") == "1":
        return True
    if row.get("touchdown") == "1" or row.get("first_down") == "1":
        return False
    down, togo, gain = int(f(row["down"])), f(row["ydstogo"]), f(row["yards_gained"])
    need = {1: 0.4, 2: 0.6}.get(down, 1.0) * togo
    return gain < need


def role(p):
    pff, ngs, pos = p.get("pff_position", ""), p.get("ngs_position", ""), p.get("position", "")
    if pff == "ED" or ngs == "EDGE" or (not pff and not ngs and pos in ("DE", "OLB")):
        return "EDGE"
    if pff == "DI" or ngs == "INTERIOR_LINE" or pos in ("DT", "NT", "DL", "DE"):
        return "IDL"
    if pos in ("LB", "ILB", "MLB", "OLB"):
        return "LB"
    if pff == "CB" or ngs in ("CB", "SLOT_CB") or pos == "CB":
        return "CB"
    if pos in ("SAF", "S", "FS", "SS", "DB"):
        return "S"
    if pos == "FB":
        return "RB"
    return pos if pos in ("QB", "RB", "WR", "TE") else ""


def pbp(season):
    fp = RAW / "nfl" / f"pbp_{season}.csv.gz"
    if not fp.exists() or (season == season_now() and fp.stat().st_mtime < datetime.now().timestamp() - 6 * 3600):
        r = requests.get(f"{NFLV}/pbp/play_by_play_{season}.csv.gz", timeout=600)
        r.raise_for_status()
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_bytes(r.content)
    with gzip.open(fp, "rt", encoding="utf-8", newline="") as fh:
        yield from csv.DictReader(fh)


def per_game(season):
    """{(gsis id, week): {column: value}} for the regular season."""
    S = defaultdict(lambda: defaultdict(float))
    for row in pbp(season):
        if row.get("season_type") != "REG" or row.get("two_point_attempt") == "1":
            continue
        pt = row.get("play_type")
        if pt not in ("run", "pass") or not row.get("down") or row["down"] == "NA":
            continue
        wk = int(f(row["week"]))
        off = row["posteam"]
        down, togo, gain, yl = int(f(row["down"])), f(row["ydstogo"]), f(row["yards_gained"]), f(row["yardline_100"])
        epa, lost = f(row["epa"]), failed(row)
        late = down >= 3
        short = late and togo <= 2
        rz = yl <= 20
        sacked = row.get("sack") == "1"
        run = pt == "run"

        # ---- defense: tacklers on this play
        if not (row.get("interception") == "1" or row.get("fumble_lost") == "1"):  # after a turnover the offense makes the tackles
            for p in ids(row, *TACKLERS):
                s = S[p, wk]
                s["tkl"] += 1
                if run:
                    s["run_tkl"] += 1
                    s["run_tkl_yds"] += gain
                    s["run_stop"] += lost
                    s["stuff"] += gain <= 0
                    if short:
                        s["sy_tkl"] += 1
                        s["sy_stop"] += lost
                elif row.get("complete_pass") == "1":
                    s["pass_tkl"] += 1
                    s["pass_stop"] += lost
                if late and lost:
                    s["third_stop"] += 1
                if rz and lost:
                    s["rz_stop"] += 1
        for p in ids(row, "tackle_for_loss_1_player_id", "tackle_for_loss_2_player_id"):
            S[p, wk]["tfl"] += 1
        for p in ids(row, "sack_player_id"):
            S[p, wk]["sacks"] += 1
            S[p, wk]["third_sacks"] += late
        for p in ids(row, "half_sack_1_player_id", "half_sack_2_player_id"):
            S[p, wk]["sacks"] += 0.5
            S[p, wk]["third_sacks"] += 0.5 * late
        for p in ids(row, "qb_hit_1_player_id", "qb_hit_2_player_id"):
            S[p, wk]["qb_hits"] += 1
        for p in ids(row, "pass_defense_1_player_id", "pass_defense_2_player_id"):
            S[p, wk]["pd"] += 1
        for p in ids(row, "interception_player_id"):
            S[p, wk]["ints"] += 1
        for p in ids(row, "forced_fumble_player_1_player_id", "forced_fumble_player_2_player_id"):
            if row.get("forced_fumble_player_1_team") != off:
                S[p, wk]["ff"] += 1
        if row.get("fumble_lost") == "1":
            for p in ids(row, "fumble_recovery_1_player_id"):
                S[p, wk]["fr"] += 1

        # ---- running (designed runs and scrambles; kneels are their own play type)
        if run:
            for p in ids(row, "rusher_player_id"):
                s = S[p, wk]
                s["carries"] += 1
                s["rush_yds"] += f(row["rushing_yards"])
                s["rush_succ"] += not lost
                s["rush_stuffed"] += gain <= 0
                s["rush_10"] += gain >= 10
                s["rush_td"] += row.get("rush_touchdown") == "1"
                s["rush_epa"] += epa
                if short:
                    s["sy_carries"] += 1
                    s["sy_conv"] += not lost
                if rz:
                    s["rz_carries"] += 1
                if yl <= 5:
                    s["gl_carries"] += 1
                    s["gl_td"] += row.get("rush_touchdown") == "1"
            continue

        # ---- passing
        deep = f(row["air_yards"]) >= 20
        for p in ids(row, "passer_player_id"):
            s = S[p, wk]
            s["dropbacks"] += 1
            s["pass_epa"] += epa
            s["sacked"] += sacked
            s["hit"] += sacked or row.get("qb_hit") == "1"
            if late:
                s["third_db"] += 1
                s["third_db_conv"] += not lost
            if row.get("qtr") in ("4", "5") and abs(f(row["score_differential"])) <= 8:
                s["clutch_db"] += 1
                s["clutch_epa"] += epa
            if row.get("pass_attempt") == "1" and not sacked:
                c = row.get("complete_pass") == "1"
                s["att"] += 1
                s["cmp"] += c
                s["pass_yds"] += f(row["passing_yards"])
                s["pass_td"] += row.get("pass_touchdown") == "1"
                s["int"] += row.get("interception") == "1"
                if deep:
                    s["deep_att"] += 1
                    s["deep_cmp"] += c
                    s["deep_yds"] += f(row["passing_yards"])
                if rz:
                    s["rz_att"] += 1
                    s["rz_pass_td"] += row.get("pass_touchdown") == "1"
        for p in ids(row, "receiver_player_id"):
            if sacked:
                continue
            s = S[p, wk]
            c = row.get("complete_pass") == "1"
            s["targets"] += 1
            s["rec"] += c
            s["rec_yds"] += f(row["receiving_yards"])
            s["rec_td"] += row.get("pass_touchdown") == "1"
            s["yac"] += f(row["yards_after_catch"]) if c else 0
            s["rec_epa"] += epa
            s["rec_20"] += c and gain >= 20
            if deep:
                s["deep_tgt"] += 1
                s["deep_rec"] += c
            if late:
                s["third_tgt"] += 1
                s["third_conv"] += c and not lost
            if rz:
                s["rz_tgt"] += 1
                s["rz_rec_td"] += row.get("pass_touchdown") == "1"

    return {k: {c: (round(v, 2) if not float(v).is_integer() else int(v)) for c, v in d.items() if v and c in XCOLS} for k, d in S.items()}


def extra(p, season):
    """[role, year in the league (1 = rookie), drafted ("R1 #7" or "UDFA")] for a players.csv row."""
    rk = p.get("rookie_season") or p.get("draft_year")
    yr = season - int(rk) + 1 if rk and rk.isdigit() else 0
    rnd = p.get("draft_round")
    draft = f"R{rnd} #{p['draft_pick']}" if rnd and rnd.isdigit() and (p.get("draft_year") or "") == (rk or "x") else "UDFA"
    return [role(p), max(yr, 0), draft]
