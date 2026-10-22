"""Heisman buzz: how much people are reading about each college star (Wikipedia page views, last 30 days).

The Heisman race in Stats > Visualize (docs/viz.js) uses it as a "popularity" factor: voters vote for players they've heard
of. Free and open (Wikimedia's pageviews API). We look up the top 70 college QBs and top 90 runners and receivers by
yards per game, find each one's Wikipedia page (it has to be about a football player at his school), and count the views.
No page = little buzz (the model treats that as a small number of views, not zero).

Writes docs/data/cfb/heisman_buzz.json: {"updated", "season", "days": 30, "views": {espn_id: views}}.
Usage: python src/heisman_buzz.py
"""
import datetime as dt
import json
import os
import sys
import time
from urllib.parse import quote

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "cfb", "heisman_buzz.json")
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com; Heisman race popularity)"}


def get(url):
    for i in range(5):
        time.sleep(0.15)  # Wikipedia rate-limits fast callers (429)
        try:
            r = requests.get(url, headers=UA, timeout=20)
            if r.status_code == 404:
                return None
            if r.ok:
                return r.json()
            print(f"  {r.status_code} {url[-60:]}", file=sys.stderr)
        except requests.RequestException:
            pass
        time.sleep(2 * (i + 1))
    return None


def page_for(name, school):
    """His Wikipedia page title, or None: "(American football)" first, then the plain name; it must be about football."""
    for title in (f"{name} (American football)", name):
        s = get("https://en.wikipedia.org/api/rest_v1/page/summary/" + quote(title.replace(" ", "_"), safe=""))
        if not s or s.get("type") == "disambiguation":
            continue
        text = f"{s.get('description', '')} {s.get('extract', '')}".lower()
        if "football" in text and (school.lower() in text or "college football" in text or "quarterback" in text
                                   or "running back" in text or "wide receiver" in text):
            return s.get("titles", {}).get("canonical") or s.get("title")
    return None


def main():
    idx = json.load(open(os.path.join(ROOT, "docs", "data", "viz", "index.json"), encoding="utf-8"))
    season = max(idx["cfb"])
    d = json.load(open(os.path.join(ROOT, "docs", "data", "viz", f"cfb_{season}.json"), encoding="utf-8"))
    pc, pm, teams = d["pcols"], d["pmeta"], d["teams"]
    ix = {c: i + 3 for i, c in enumerate(pc)}
    tot, att, games = {}, {}, {}
    for r in d["prows"]:
        tot[r[0]] = tot.get(r[0], 0) + r[ix["pass_yds"]] + r[ix["rush_yds"]] + r[ix["rec_yds"]]
        att[r[0]] = att.get(r[0], 0) + r[ix["att"]]
        games[r[0]] = games.get(r[0], 0) + 1
    # QBs and everyone else apart (passing yards would crowd every receiver out): the top 70 QBs, the top 90 others
    ok = [k for k in tot if games[k] >= 3 and k in pm]
    qb = [k for k in ok if att[k] >= 8 * games[k]]
    rest = [k for k in ok if att[k] < 8 * games[k]]
    per = lambda k: -tot[k] / games[k]
    pool = sorted(qb, key=per)[:70] + sorted(rest, key=per)[:90]
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=29)
    views = {}
    for k in pool:
        name, _, team = pm[k]
        title = page_for(name, teams.get(team, [""])[0])
        if not title:
            continue
        pv = get("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
                 f"{quote(title, safe='')}/daily/{start:%Y%m%d}/{end:%Y%m%d}")
        if pv and pv.get("items"):
            views[k] = sum(i["views"] for i in pv["items"])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"updated": dt.date.today().isoformat(), "season": season, "days": 30, "views": views}, f, separators=(",", ":"))
    top = sorted(views.items(), key=lambda kv: -kv[1])[:10]
    print(f"{len(views)} of {len(pool)} players have a page -> {OUT}")
    for k, v in top:
        print(f"  {pm[k][0]}: {v:,}")


if __name__ == "__main__":
    sys.exit(main())
