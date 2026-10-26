"""Each NFL team's starting QB from its own team site's depth chart -> data/raw/nfl/qb1.json.

nflverse's schedule names the expected starters, but it can lag an injury (it still listed Jalen Hurts for the Eagles'
Monday night game after Tanner McKee had taken over), and a QB on IR isn't on the weekly injury report either. The team
sites (all 32 run the same NFL club-site template, /team/depth-chart) update their depth chart as soon as the team
does. nfl_model.load_games uses this QB1 for games that haven't been played. A site that can't be read is skipped,
so that team keeps nflverse's starter.

    python src/nfl_depth.py
"""
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "nfl" / "qb1.json"
SITES = {"ARI": "azcardinals.com", "ATL": "atlantafalcons.com", "BAL": "baltimoreravens.com", "BUF": "buffalobills.com",
         "CAR": "panthers.com", "CHI": "chicagobears.com", "CIN": "bengals.com", "CLE": "clevelandbrowns.com",
         "DAL": "dallascowboys.com", "DEN": "denverbroncos.com", "DET": "detroitlions.com", "GB": "packers.com",
         "HOU": "houstontexans.com", "IND": "colts.com", "JAX": "jaguars.com", "KC": "chiefs.com", "LV": "raiders.com",
         "LAC": "chargers.com", "LA": "therams.com", "MIA": "miamidolphins.com", "MIN": "vikings.com", "NE": "patriots.com",
         "NO": "neworleanssaints.com", "NYG": "giants.com", "NYJ": "newyorkjets.com", "PHI": "philadelphiaeagles.com",
         "PIT": "steelers.com", "SF": "49ers.com", "SEA": "seahawks.com", "TB": "buccaneers.com",
         "TEN": "tennesseetitans.com", "WAS": "commanders.com"}


def qb1(page):
    """The first name in the depth chart's QB row (some sites put the jersey number first), or None."""
    row = re.search(r">\s*QB\s*</t[dh]>(.*?)</tr>", page, re.S | re.I)
    if not row:
        return None
    for cell in re.findall(r"<td[^>]*>(.*?)</td>", row.group(1), re.S):
        name = re.sub(r"^\d+\s+", "", " ".join(html.unescape(re.sub(r"<[^>]+>", " ", cell)).split()))
        if re.search(r"[A-Za-z]{2,} [A-Za-z]", name):
            return name
    return None


def refresh():
    have = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    got = {}
    for team, site in SITES.items():
        try:
            r = requests.get(f"https://www.{site}/team/depth-chart", headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
            name = qb1(r.text) if r.ok else None
        except requests.RequestException:
            name = None
        if name:
            got[team] = name
        else:
            print(f"{team}: no QB1 from {site}")
    if len(got) < 16:  # the template changed: keep the old file rather than half a list
        print(f"Only {len(got)} team sites read; leaving {OUT.name} alone.")
        return have.get("qb1", {})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "qb1": got}, indent=1), encoding="utf-8")
    return got


if __name__ == "__main__":
    for t, n in sorted(refresh().items()):
        print(t, n)
