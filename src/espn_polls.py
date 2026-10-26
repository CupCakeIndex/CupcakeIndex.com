"""AP and Coaches polls from ESPN (free, no key, no monthly limit), so a new poll shows up Sunday night even when
CollegeFootballData is late posting it or has cut us off (429 Too Many Requests, Oct 25-26 2026).

  merge(polls, teams, season)  adds ESPN's latest poll to the CFBD poll list (used by fetch_data.fetch_season)
  python src/espn_polls.py     patches ap_rank in the latest college week file + compare.json, no CFBD needed

ESPN numbers polls like CFBD: the poll released after week N's games is "Week N+1". Team ids match (CFBD team ids
are ESPN ids), so teams are matched by id, never by name."""
import json
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings"
NAMES = {"ap": "AP Top 25", "usa": "Coaches Poll"}  # ESPN poll type -> the CFBD poll title model.ap_ranks looks for


def latest(season):
    """{"week": N, "AP Top 25": {espn_id: rank}, "Coaches Poll": {...}} for ESPN's current regular-season poll, or None."""
    d = requests.get(URL, timeout=30).json()
    out = {}
    for r in d.get("rankings", []):
        name, occ, s = NAMES.get(r.get("type")), r.get("occurrence") or {}, r.get("season") or {}
        if not name or s.get("year") != season or (s.get("type") or {}).get("type") != 2 or occ.get("type") != "week":
            continue  # bowl season / final polls aren't weekly; leave those to CFBD
        out["week"] = int(occ["number"])
        out[name] = {str(x["team"]["id"]): x["current"] for x in r.get("ranks", []) if x.get("current")}
    return out if "week" in out else None


def merge(polls, teams, season):
    """Put ESPN's latest poll into the CFBD-shaped poll list, replacing that week's AP/Coaches if CFBD has them.
    teams: CFBD /teams/fbs rows (id + school). Any ESPN failure leaves the CFBD polls as they were."""
    try:
        p = latest(season)
    except Exception as e:
        print(f"  ESPN polls unavailable ({e!r}); using CFBD's")
        return polls
    if not p:
        return polls
    school = {str(t["id"]): t["school"] for t in teams if t.get("id") is not None}
    new = [{"poll": name, "ranks": [{"rank": rk, "school": school[i]} for i, rk in p[name].items() if i in school]}
           for name in NAMES.values() if name in p]
    for pw in polls:
        if pw.get("week") == p["week"]:
            pw["polls"] = [x for x in pw.get("polls", []) if x.get("poll") not in NAMES.values()] + new
            break
    else:
        polls = polls + [{"season": season, "seasonType": "regular", "week": p["week"], "polls": new}]
        print(f"  added the week {p['week']} AP/Coaches polls from ESPN (CFBD doesn't have them yet)")
    return polls


def patch_published(season=None):
    """Update ap_rank in the latest published college week (and compare.json) from ESPN, for runs where the full
    build couldn't reach CFBD. Only touches it when the poll is the one for that week (released after its games)."""
    index = json.loads((ROOT / "docs/data/index.json").read_text(encoding="utf-8"))
    info = index["leagues"]["cfb"]["latest"]
    season, week = season or info["season"], info["week"]
    p = latest(season)
    if not p or p["week"] != week + 1:
        print(f"ESPN poll is week {p and p['week']}, rankings are week {week}: nothing to patch")
        return
    ap, coaches = p.get("AP Top 25", {}), p.get("Coaches Poll", {})
    f = ROOT / f"docs/data/cfb/{season}/week_{week}.json"
    d = json.loads(f.read_text(encoding="utf-8"))
    ids = {t["team"]: str(t["id"]) for t in d["teams"] if t.get("id") is not None}
    changed = 0
    for t in d["teams"]:
        rk = ap.get(ids.get(t["team"]))
        changed += t.get("ap_rank") != rk
        t["ap_rank"] = rk
    if changed:
        f.write_text(json.dumps(d, separators=(",", ":")), encoding="utf-8")
    cf = ROOT / f"docs/data/cfb/{season}/compare.json"
    if cf.exists():
        c = json.loads(cf.read_text(encoding="utf-8"))
        for team, row in c["teams"].items():
            row["ap"], row["coaches"] = ap.get(ids.get(team)), coaches.get(ids.get(team))
        cf.write_text(json.dumps(c, separators=(",", ":")), encoding="utf-8")
    print(f"Week {week}: AP poll from ESPN, {changed} team(s) changed")


if __name__ == "__main__":
    patch_published(int(sys.argv[1]) if len(sys.argv) > 1 else None)
