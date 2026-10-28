"""Nicknames and other names NFL players go by -> docs/data/player_aliases.json.

So the Analyst finds Jacory Croskey-Merritt when someone asks about "Bill", and player pages can show the nickname.
Sources, all free: Wikidata links ESPN player ids to Wikipedia articles (and lists some nicknames, P1449); the
article's first line gives the nickname the way it's written in print (Jacory "Bill" Croskey-Merritt); nflverse's
players file gives the name a player goes by when it differs from his given first name (William -> Bill).
Nicknames for every NFL player the site's search knows; other names for players in our stats (2022 on).
Run by .github/workflows/viz.yml (Mondays).

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
# well-known media and meme nicknames Wikipedia's first line doesn't carry. Add more here. "Name|POS" when the name is
# shared (five Chris Johnsons); otherwise the player with that name and the longest career gets it.
KNOWN = {
    # current players
    "Christian McCaffrey": ["CMC", "Run CMC"], "Jaxon Smith-Njigba": ["JSN", "Emerald City Route Artist"], "Amon-Ra St. Brown": ["ARSB", "Sun God"],
    "Marquise Brown": ["Hollywood"], "Marvin Harrison Jr.": ["MHJ"], "Brian Thomas Jr.": ["BTJ"], "Kenneth Walker III": ["KW3"],
    "A.J. Brown": ["AJB"], "Travis Etienne": ["ETN"], "Aidan Hutchinson": ["Hutch"], "Jonathan Taylor": ["JT"],
    "Patrick Mahomes": ["Showtime"], "Justin Jefferson": ["JJettas"], "Jayden Daniels": ["JD5"], "Derrick Henry": ["King Henry", "The King"],
    "Tyreek Hill": ["Cheetah"], "Jahmyr Gibbs": ["Sonic"], "David Montgomery": ["Knuckles"], "Joe Burrow": ["Joe Brrr", "Joey B", "Joe Shiesty"],
    "Trevor Lawrence": ["Sunshine"], "Jameis Winston": ["Famous Jameis"], "Brock Purdy": ["Mr. Irrelevant"], "DeVonta Smith": ["Slim Reaper"],
    "Maxx Crosby": ["Mad Maxx"], "Tyrann Mathieu": ["Honey Badger"], "Darius Slay": ["Big Play Slay"], "DeAndre Hopkins": ["Nuk"],
    "Davante Adams": ["Tae"], "Brian Robinson Jr.": ["B-Rob"], "Aaron Rodgers": ["A-Rod"], "Russell Wilson": ["Russ", "DangeRuss"],
    "Ezekiel Elliott": ["Zeke"], "Odell Beckham Jr.": ["OBJ"], "Gardner Minshew": ["Minshew Mania"], "Michael Thomas|WR": ["Can't Guard Mike"],
    "Leonard Fournette": ["Playoff Lenny", "Lombardi Lenny"], "Jarvis Landry": ["Juice"], "Aaron Donald": ["AD"],
    "Ryan Fitzpatrick": ["Fitzmagic"], "Tom Brady": ["TB12"],
    # all-time (search and player pages cover every NFL player)
    "Chris Johnson|RB": ["CJ2K"], "Calvin Johnson": ["Megatron"], "Marshawn Lynch": ["Beast Mode"], "Rob Gronkowski": ["Gronk"],
    "Walter Payton": ["Sweetness"], "Deion Sanders": ["Prime Time", "Neon Deion"], "Jerome Bettis": ["The Bus"],
    "LaDainian Tomlinson": ["LT"], "Lawrence Taylor": ["LT"], "Adrian Peterson|RB": ["All Day", "AD"], "Chad Johnson": ["Ochocinco"],
    "Terrell Owens": ["T.O."], "Peyton Manning": ["The Sheriff"], "Joe Montana": ["Joe Cool"], "Darrelle Revis": ["Revis Island"],
    "Antonio Brown": ["AB"], "Brian Dawkins": ["Weapon X"], "Reggie White": ["Minister of Defense"], "Earl Campbell": ["The Tyler Rose"],
    "Ken Stabler": ["The Snake"], "Joe Namath": ["Broadway Joe"], "Johnny Manziel": ["Johnny Football"], "William Perry": ["The Refrigerator", "Fridge"],
    "Joe Greene": ["Mean Joe Greene"], "Christian Okoye": ["The Nigerian Nightmare"], "Brian Bosworth": ["The Boz"], "Larry Fitzgerald": ["Fitz"],
    "Bo Jackson": ["Bo Knows"], "Michael Irvin": ["The Playmaker"], "Randy Moss": ["Super Freak"], "Steve Smith": ["Agent 89"],
}
QUOTED = re.compile(r'["“]([^"”]{2,25})["”]')


def all_players():
    """every NFL player the site's search knows (docs/data/players_nfl.json: [name, espn id, pos, first year, last year])"""
    try:
        return json.load(open(ROOT / "docs" / "data" / "players_nfl.json", encoding="utf-8"))
    except (OSError, ValueError):
        return []


def known_ids(names):
    """KNOWN's "Name" / "Name|POS" -> espn id: among same-named players, the one at that position with the longest career."""
    by = {}
    for p in all_players():
        by.setdefault(p[0].lower(), []).append(p)
    for pid, nm in names.items():  # players only in our stats files
        by.setdefault(nm.lower(), []).append([nm, pid, "", 0, 0])
    out = {}
    for key, nk in KNOWN.items():
        name, _, pos = key.partition("|")
        c = [p for p in by.get(name.lower(), []) if not pos or p[2] == pos]
        if c:
            best = max(c, key=lambda p: ((p[4] or 0) - (p[3] or 0), p[4] or 0))
            out.setdefault(best[1], set()).update(nk)
        else:
            print(f"  ! KNOWN: no player named {key}")
    return out


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
        if i % 400 == 0:
            print(f"  articles {i}/{len(titles)}", flush=True)
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


NICKNAMED = re.compile(r'(?:nicknamed|nickname[sd]?(?: is| was| of)?|known (?:to fans )?as|dubbed)[^"“.]{0,40}((?:["“][^"”]{2,30}["”](?:,? (?:and|or) |, )?)+)', re.I)


def wiki_nicknamed():
    """title -> nicknames from every NFL player article that says he's nicknamed something (a Wikipedia search per 500
    articles; the snippet around the word has the name: 'nicknamed "King Henry"'). How we catch the popular ones."""
    out = {}
    for words in ("nicknamed", "nickname"):
        for off in range(0, 10000, 500):
            for wait in (2, 10, 30, None):
                r = requests.get("https://en.wikipedia.org/w/api.php", headers=UA, timeout=60, params={
                    "action": "query", "list": "search", "srsearch": f'{words} hastemplate:"Infobox NFL biography"', "srlimit": 500,
                    "sroffset": off, "srprop": "snippet", "format": "json", "formatversion": 2, "maxlag": 5})
                if r.ok and r.text.startswith("{") and "query" in r.json():
                    break
                if wait is None:
                    print(f"  ! Wikipedia search {words} {off} skipped ({r.status_code})")
                    return out
                time.sleep(wait)
            q = r.json()
            for x in q["query"]["search"]:
                snip = re.sub(r"<[^>]+>", "", x.get("snippet", "")).replace("&quot;", '"')
                for m in NICKNAMED.finditer(snip):
                    out.setdefault(x["title"], set()).update(n.strip() for n in re.findall(r'["“]([^"”]{2,30})["”]', m.group(1)))
            if "continue" not in q:
                break
            time.sleep(1)
    return out


def nick_from_intro(text, name):
    """'Jacory "Bill" Croskey-Merritt (born April 12, 2001) is...' -> ["Bill"]. Only quotes inside the name, before '('."""
    head = text.split("(")[0][:80]
    last = name.split()[-1].lower()
    if last not in head.lower():
        return []
    return [q.strip() for q in QUOTED.findall(head) if q.strip().lower() not in name.lower()]


# what a Wikipedia snippet calls a "nickname" that isn't one: plays, games, rules, eras, a duo or a whole unit
NOT_A_NICK = re.compile(r"\b(rule|game|play|catch|reception|deflection|kick|sack|comeback|block|drive|triplets|boogeymen|era|trade|bowl|season|draft|team|defense|offense|line|running)\b| and |&", re.I)


BLOCKED = {"jew"}  # snippet fragments that read as slurs (Jerry Jeudy's pronunciation guide). Never shown.


def clean_nicks(nicks, name):
    """trim stray punctuation, drop non-nicknames and his own name, one copy each ("Honey Badger" = "the Honey Badger")"""
    out = {}
    for n in nicks:
        n = n.strip().rstrip(".,;:").strip()
        bare = re.sub(r"^the ", "", n, flags=re.I)
        parts = [w.lower() for w in re.split(r"[ -]", name) if w]
        if len(n) < 2 or NOT_A_NICK.search(n) or name.lower() in n.lower():  # "King Henry" stays, "Tyrann Mathieu" (his name) goes
            continue
        if not (bare[:1].isupper() or bare[:1].isdigit()):  # "the roll", "catch of the year": a phrase, not a name
            continue
        if any(w.startswith(bare.lower()) and w != bare.lower() for w in parts):  # a cut-off piece of his own name (pronunciation guides)
            continue
        if all(w.lower() in parts for w in bare.split()) or bare.lower() in BLOCKED:  # just his name again ("Sauce Sauce"), or a slur
            continue
        key = re.sub(r"^the ", "", n.lower())
        if key not in out or out[key].lower().startswith("the "):
            out[key] = n
    return sorted(out.values())


def just_initials(nick, name):
    """'A. J.' for A.J. Brown is how Wikipedia spells his name, not a nickname."""
    letters = lambda x: re.sub(r"[^a-z]", "", x.lower())
    return letters(nick) == letters(name.split()[0])


def main():
    ours = our_players()
    recent = set(ours)  # 2022 on: these also get their other names (William -> Bill) for search
    ours = {**{p[1]: p[0] for p in all_players()}, **ours}  # nicknames: every NFL player the site knows
    print(f"{len(recent)} NFL players in our stats, {len(ours)} all-time")
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
    found = wiki_nicknamed()
    for pid, t in titles.items():
        for n in found.get(t, ()):
            if len(n.split()) <= 4 and not re.search(r"\d{4}|[()]", n):  # a nickname, not a quote or a team name
                nicks.setdefault(pid, set()).add(n)
    print(f"Wikipedia search: {len(found)} articles mention a nickname")
    for pid, nk in known_ids(ours).items():  # hand list, all-time players too
        nicks.setdefault(pid, set()).update(nk)
        ours.setdefault(pid, next((p[0] for p in all_players() if p[1] == pid), pid))
    # the name he goes by vs his given first name (nflverse): search both
    also = {}
    pr = requests.get(NFLV_PLAYERS, headers=UA, timeout=120)
    for row in csv.DictReader(io.StringIO(pr.text)):
        pid = row.get("espn_id", "").split(".")[0]
        if pid not in recent:
            continue
        for first in {row.get("first_name"), row.get("common_first_name"), row.get("football_name")} - {None, ""}:
            full = f"{first} {row['last_name']}"
            if full.lower() != ours[pid].lower():
                also.setdefault(pid, set()).add(full)
    players = {}
    for pid in sorted(set(nicks) | set(also), key=int):
        nk = [n for n in clean_nicks(nicks.get(pid, ()), ours[pid]) if n.lower() not in ours[pid].lower().split() and not just_initials(n, ours[pid])]
        al = sorted(a for a in also.get(pid, ()) if a not in nk)
        if nk or al:
            players[pid] = {"name": ours[pid], "nick": nk, "also": al}
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "players": players},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"player_aliases.json: {sum(1 for p in players.values() if p['nick'])} nicknames, {sum(1 for p in players.values() if p['also'])} other names")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
