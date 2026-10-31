"""MVP buzz: how much people are reading about each NFL star (Wikipedia page views, last 30 days).

The MVP race in Stats > Visualize (docs/viz.js) uses it as a "popularity" factor, like the Heisman race (src/heisman_buzz.py):
voters vote for players they've heard of. We look up the top 32 NFL QBs and the top 48 runners and receivers by yards per
game, find each one's Wikipedia page (it has to be about an NFL player), and count the views.

Writes docs/data/nfl/mvp_buzz.json: {"updated", "season", "days": 30, "views": {player_id: views}}.
Usage: python src/mvp_buzz.py
"""
import datetime as dt
import json
import os
import sys
from urllib.parse import quote

from heisman_buzz import ROOT, get

OUT = os.path.join(ROOT, "docs", "data", "nfl", "mvp_buzz.json")
ROLES = {"QB": "quarterback", "RB": "running back", "FB": "fullback", "WR": "wide receiver", "TE": "tight end"}


def is_him(name, role, s):
    """A Wikipedia summary that's about this NFL player, not someone else with his name."""
    if not s or s.get("type") == "disambiguation":
        return False
    text = f"{s.get('description', '')} {s.get('extract', '')}".lower()
    return ("national football league" in text or "nfl" in text) and (not role or role in text)


def page_for(name, pos):
    """His Wikipedia page title, or None. Common names sit behind "(quarterback)" and the like, so try those first."""
    role = ROLES.get(pos, "")
    summary = lambda t: get("https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(t.replace(" ", "_"), safe=""))
    for title in (f"{name} ({role})" if role else None, f"{name} (American football)", name):
        s = summary(title) if title else None
        if is_him(name, role, s):
            return s.get("titles", {}).get("canonical") or s.get("title")
    found = get("https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=3&srsearch="
                + quote(f"{name} NFL {role}"))
    for hit in (found or {}).get("query", {}).get("search", []):
        if hit["title"].lower().startswith(name.lower()):
            s = summary(hit["title"])
            if is_him(name, role, s):
                return s.get("titles", {}).get("canonical") or s.get("title")
    return None


def views(title, start, end):
    pv = get("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
             f"{quote(title, safe='')}/daily/{start:%Y%m%d}/{end:%Y%m%d}")
    return sum(i["views"] for i in pv["items"]) if pv and pv.get("items") else None


def main():
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "viz", "index.json"), encoding="utf-8"))
    season = max(idx["nfl"])
    d = json.load(open(os.path.join(ROOT, "docs", "data", "viz", f"nfl_{season}.json"), encoding="utf-8"))
    pc, pm = d["pcols"], d["pmeta"]
    ix = {c: i + 3 for i, c in enumerate(pc)}
    tot, att, games = {}, {}, {}
    for r in d["prows"]:
        tot[r[0]] = tot.get(r[0], 0) + r[ix["pass_yds"]] + r[ix["rush_yds"]] + r[ix["rec_yds"]]
        att[r[0]] = att.get(r[0], 0) + r[ix["att"]]
        games[r[0]] = games.get(r[0], 0) + 1
    ok = [k for k in tot if games[k] >= 3 and k in pm]
    per = lambda k: -tot[k] / games[k]
    pool = sorted((k for k in ok if att[k] >= 8 * games[k]), key=per)[:32] + sorted((k for k in ok if att[k] < 8 * games[k]), key=per)[:48]
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=29)
    out = {}
    for k in pool:
        title = page_for(pm[k][0], pm[k][1])
        n = views(title, start, end) if title else None
        if n:
            out[k] = n
    if len(out) < len(pool) / 2:  # Wikipedia having a bad day: keep the last good file
        sys.exit(f"Only {len(out)} of {len(pool)} players found; keeping the old file")
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": dt.date.today().isoformat(), "season": season, "days": 30, "views": out}, f, separators=(",", ":"))
    print(f"{len(out)} of {len(pool)} players have a page -> {OUT}")
    for k, v in sorted(out.items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {pm[k][0]}: {v:,}")


if __name__ == "__main__":
    sys.exit(main())
