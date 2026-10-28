"""Nicknames and other names NFL players go by -> docs/data/player_aliases.json.

So the Analyst finds Jacory Croskey-Merritt when someone asks about "Bill", and player pages can show the nickname.
Sources, all free: Wikidata links ESPN player ids to Wikipedia articles (and lists some nicknames, P1449); the
article's first line gives the nickname the way it's written in print (Jacory "Bill" Croskey-Merritt); nflverse's
players file gives the name a player goes by when it differs from his given first name (William -> Bill).
Only players in our NFL stats (docs/data/viz, 2022 on). Run by .github/workflows/viz.yml (Mondays).

    {"updated": "...", "players": {"4575131": {"name": "Jacory Croskey-Merritt", "nick": ["Bill"], "also": []}}}
nick: real nicknames (shown on the player page). also: other forms of his name, for search only.
"""
import csv
import glob
import io
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "player_aliases.json"
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com)"}
SPARQL = """SELECT ?espn ?title ?nick WHERE { ?p wdt:P3686 ?espn.
  OPTIONAL { ?a schema:about ?p; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title. }
  OPTIONAL { ?p wdt:P1449 ?nick. FILTER(LANG(?nick) = "en") } }"""
NFLV_PLAYERS = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
# well-known media and meme nicknames Wikipedia's first line doesn't carry (add more here; matched to our players by name)
KNOWN = {"Christian McCaffrey": ["CMC"], "Jaxon Smith-Njigba": ["JSN", "Emerald City Route Artist"], "Amon-Ra St. Brown": ["ARSB", "Sun God"],
         "Marquise Brown": ["Hollywood"], "Marvin Harrison Jr.": ["MHJ"], "Brian Thomas Jr.": ["BTJ"], "Kenneth Walker III": ["KW3"],
         "A.J. Brown": ["AJB"], "Travis Etienne": ["ETN"], "Aidan Hutchinson": ["Hutch"], "Jonathan Taylor": ["JT"],
         "Christian Watson": ["Big Dog"], "Patrick Mahomes": ["Showtime"], "Justin Jefferson": ["JJettas"], "Saquon Barkley": ["Kong"]}
QUOTED = re.compile(r'["“]([^"”]{2,25})["”]')


def our_players():
    out = {}
    for f in sorted(glob.glob(str(ROOT / "docs" / "data" / "viz" / "nfl_20*.json"))):
        if int(Path(f).stem[4:]) >= 2022:
            out.update({pid: m[0] for pid, m in json.load(open(f, encoding="utf-8")).get("pmeta", {}).items()})
    return out


def wiki_intros(titles):
    """title -> the article's first sentence, 20 at a time (the API's limit for intros)."""
    out = {}
    for i in range(0, len(titles), 20):
        for wait in (1, 5, 20, 60, None):  # Wikipedia answers 429 when we go too fast: back off and retry
            r = requests.get("https://en.wikipedia.org/w/api.php", headers=UA, timeout=30, params={
                "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "exsentences": 1, "redirects": 1,
                "titles": "|".join(titles[i:i + 20]), "format": "json", "formatversion": 2, "maxlag": 5})
            if r.ok and r.text.startswith("{") and "error" not in r.json():
                break
            if wait is None:
                print(f"  ! Wikipedia batch {i // 20} skipped ({r.status_code})")
                break
            time.sleep(wait)
        q = r.json().get("query", {}) if r.ok and r.text.startswith("{") else {}
        back = {x["to"]: x["from"] for x in q.get("redirects", []) + q.get("normalized", [])}
        for p in q.get("pages", []):
            out[back.get(p["title"], p["title"])] = p.get("extract", "")
        time.sleep(1)
    return out


def nick_from_intro(text, name):
    """'Jacory "Bill" Croskey-Merritt (born April 12, 2001) is...' -> ["Bill"]. Only quotes inside the name, before '('."""
    head = text.split("(")[0][:80]
    last = name.split()[-1].lower()
    if last not in head.lower():
        return []
    return [q.strip() for q in QUOTED.findall(head) if q.strip().lower() not in name.lower()]


def just_initials(nick, name):
    """'A. J.' for A.J. Brown is how Wikipedia spells his name, not a nickname."""
    letters = lambda x: re.sub(r"[^a-z]", "", x.lower())
    return letters(nick) == letters(name.split()[0])


def main():
    ours = our_players()
    print(f"{len(ours)} NFL players in our stats")
    r = requests.get("https://query.wikidata.org/sparql", params={"query": SPARQL}, headers={**UA, "Accept": "text/csv"}, timeout=120)
    r.raise_for_status()
    titles, nicks = {}, {}
    for row in csv.DictReader(io.StringIO(r.text)):
        if row["espn"] in ours:
            if row.get("title"):
                titles[row["espn"]] = row["title"]
            if row.get("nick"):
                nicks.setdefault(row["espn"], set()).add(row["nick"].strip())
    print(f"Wikidata: {len(titles)} with a Wikipedia article, {len(nicks)} with a listed nickname")
    intro = wiki_intros(sorted(set(titles.values())))
    for pid, t in titles.items():
        for n in nick_from_intro(intro.get(t, ""), ours[pid]):
            nicks.setdefault(pid, set()).add(n)
    by_name = {v.lower(): k for k, v in ours.items()}
    for name, nk in KNOWN.items():
        if name.lower() in by_name:
            nicks.setdefault(by_name[name.lower()], set()).update(nk)
    # the name he goes by vs his given first name (nflverse): search both
    also = {}
    pr = requests.get(NFLV_PLAYERS, headers=UA, timeout=120)
    for row in csv.DictReader(io.StringIO(pr.text)):
        pid = row.get("espn_id", "").split(".")[0]
        if pid not in ours:
            continue
        for first in {row.get("first_name"), row.get("common_first_name"), row.get("football_name")} - {None, ""}:
            full = f"{first} {row['last_name']}"
            if full.lower() != ours[pid].lower():
                also.setdefault(pid, set()).add(full)
    players = {}
    for pid in sorted(set(nicks) | set(also), key=int):
        nk = sorted(n for n in nicks.get(pid, ()) if n.lower() not in ours[pid].lower().split() and not just_initials(n, ours[pid]))
        al = sorted(a for a in also.get(pid, ()) if a not in nk)
        if nk or al:
            players[pid] = {"name": ours[pid], "nick": nk, "also": al}
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "players": players},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"player_aliases.json: {sum(1 for p in players.values() if p['nick'])} nicknames, {sum(1 for p in players.values() if p['also'])} other names")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
