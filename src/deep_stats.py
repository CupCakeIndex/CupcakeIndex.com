"""Deep cuts (Stats > Deep cuts, docs/deep.js): super specific NFL player stats from nflverse play-by-play.
docs/data/deep/nfl_<season>.json: one row per player with season totals (raw counts, so the page can divide).

Run stops, stuffs, short-yardage stops, 3rd-down stops, red-zone stops, plus offense cuts (deep balls, 3rd-down
conversions, goal-line carries, clutch EPA). Every player carries a role (EDGE, IDL, LB, CB, S, QB, RB, WR, TE)
and his year in the league, so the page can show things like "run stops by rookie linebackers".

A "stop" = the offense failed on that play: it gained under 40% of the yards needed on 1st down, under 60% on 2nd,
or didn't convert on 3rd/4th (the usual success-rate rule, close to PFF's "run stop"). Fumbles lost count as stops.
Everyone credited with the tackle (solo or assisted) gets the stop.

    python src/deep_stats.py                  # this season (and any missing past season since FIRST)
    python src/deep_stats.py --season 2025
"""
import argparse
import csv
import gzip
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from viz_data import NFLV, RAW, nflverse_csv, season_now  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "deep"
FIRST = 2024

COLS = [
    # defense
    "d_snaps", "tkl", "run_tkl", "run_stop", "run_tkl_yds", "stuff", "sy_tkl", "sy_stop", "pass_tkl", "pass_stop",
    "third_stop", "rz_stop", "tfl", "sacks", "third_sacks", "qb_hits", "pd", "ints", "ff", "fr",
    # running
    "o_snaps", "carries", "rush_yds", "rush_succ", "rush_stuffed", "rush_10", "rush_td", "rush_epa", "sy_carries", "sy_conv",
    "rz_carries", "gl_carries", "gl_td",
    # receiving
    "targets", "rec", "rec_yds", "rec_td", "yac", "deep_tgt", "deep_rec", "rec_20", "third_tgt", "third_conv", "rz_tgt", "rz_rec_td", "rec_epa",
    # passing
    "dropbacks", "att", "cmp", "pass_yds", "pass_td", "int", "sacked", "hit", "deep_att", "deep_cmp", "deep_yds",
    "third_db", "third_db_conv", "clutch_db", "clutch_epa", "pass_epa", "rz_att", "rz_pass_td", "games",
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


def build(season):
    S = defaultdict(lambda: defaultdict(float))
    team = defaultdict(Counter)
    games = defaultdict(set)
    weeks = 0
    for row in pbp(season):
        if row.get("season_type") != "REG" or row.get("two_point_attempt") == "1":
            continue
        pt = row.get("play_type")
        if pt not in ("run", "pass") or not row.get("down") or row["down"] == "NA":
            continue
        weeks = max(weeks, int(f(row["week"])))
        off, dfn = row["posteam"], row["defteam"]
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
                s = S[p]
                team[p][dfn] += 1
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
            S[p]["tfl"] += 1
        for p in ids(row, "sack_player_id"):
            S[p]["sacks"] += 1
            S[p]["third_sacks"] += late
        for p in ids(row, "half_sack_1_player_id", "half_sack_2_player_id"):
            S[p]["sacks"] += 0.5
            S[p]["third_sacks"] += 0.5 * late
        for p in ids(row, "qb_hit_1_player_id", "qb_hit_2_player_id"):
            S[p]["qb_hits"] += 1
        for p in ids(row, "pass_defense_1_player_id", "pass_defense_2_player_id"):
            S[p]["pd"] += 1
        for p in ids(row, "interception_player_id"):
            S[p]["ints"] += 1
        for p in ids(row, "forced_fumble_player_1_player_id", "forced_fumble_player_2_player_id"):
            if row.get("forced_fumble_player_1_team") != off:
                S[p]["ff"] += 1
        if row.get("fumble_lost") == "1":
            for p in ids(row, "fumble_recovery_1_player_id"):
                S[p]["fr"] += 1

        # ---- running (designed runs and scrambles; kneels are their own play type)
        if run:
            for p in ids(row, "rusher_player_id"):
                s = S[p]
                team[p][off] += 1
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
            s = S[p]
            team[p][off] += 1
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
            s = S[p]
            c = row.get("complete_pass") == "1"
            team[p][off] += 1
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

    if not S:
        print(f"  no {season} play-by-play yet")
        return

    # snaps and games, from nflverse snap counts (keyed by Pro Football Reference id)
    players = {p["gsis_id"]: p for p in nflverse_csv(f"{NFLV}/players/players.csv", "players.csv")}
    by_pfr = {p["pfr_id"]: g for g, p in players.items() if p.get("pfr_id")}
    try:
        snaps = nflverse_csv(f"{NFLV}/snap_counts/snap_counts_{season}.csv", f"snap_counts_{season}.csv")
    except requests.HTTPError:
        snaps = []
    for r in snaps:
        g = by_pfr.get(r["pfr_player_id"])
        if g and r.get("game_type") == "REG":
            S[g]["d_snaps"] += f(r["defense_snaps"])
            S[g]["o_snaps"] += f(r["offense_snaps"])
            if f(r["defense_snaps"]) or f(r["offense_snaps"]):
                games[g].add(r["game_id"])

    meta, rows = {}, []
    for g, s in S.items():
        p = players.get(g)
        if not p:
            continue
        rl = role(p)
        if not rl:
            continue
        s["games"] = len(games[g])
        if not any(s[c] for c in COLS if c not in ("d_snaps", "o_snaps", "games")):
            continue
        rk = p.get("rookie_season") or p.get("draft_year")
        yr = season - int(rk) + 1 if rk and rk.isdigit() else 0
        rnd = p.get("draft_round")
        draft = f"R{rnd} #{p['draft_pick']}" if rnd and rnd.isdigit() and int(p.get("draft_year") or 0) == int(rk or -1) else "UDFA"
        tm = team[g].most_common(1)[0][0] if team[g] else p.get("latest_team", "")
        meta[g] = [p["display_name"], rl, tm, max(yr, 0), draft, p.get("espn_id") or "", p.get("college_name") or ""]
        rows.append([g] + [round(s[c], 2) if isinstance(s[c], float) and not s[c].is_integer() else int(s[c]) for c in COLS])

    OUT.mkdir(parents=True, exist_ok=True)
    d = {"season": season, "weeks": weeks, "cols": COLS, "players": meta, "rows": rows,
         "updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
    fo = OUT / f"nfl_{season}.json"
    fo.write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  {fo.name}: {len(rows)} players through week {weeks}, {fo.stat().st_size // 1024} KB")
    seasons = sorted(int(x.stem.split("_")[1]) for x in OUT.glob("nfl_*.json"))
    (OUT / "index.json").write_text(json.dumps({"nfl": seasons}), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int)
    a = ap.parse_args()
    seasons = [a.season] if a.season else [s for s in range(FIRST, season_now() + 1)
                                           if s == season_now() or not (OUT / f"nfl_{s}.json").exists()]
    for s in seasons:
        print(f"deep cuts nfl {s}")
        build(s)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
