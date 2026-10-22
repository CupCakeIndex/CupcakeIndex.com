"""NFL records held by players on our site (player pages show them in gold; the kick chart marks a record kick).

Source: Wikipedia's "List of NFL individual records" and "List of NFL quarterback records" (raw wikitext, which cite
the NFL Record & Fact Book and Pro Football Reference). Each bulleted record looks like
    * '''Longest field goal''': 68 yards, [[Cam Little]] (vs. [[...|Raiders]]), [[...|November 2, 2025]]
We keep records with a few named holders (not "by 19 players"), leave out the unflattering ones (most interceptions
thrown, lowest %, fumbles) and the age / "first to" lists, and match each holder to our ESPN player list by name,
checking the record's years against his career and, for two players with one name, the record's position.

Writes docs/data/nfl/records.json: {"updated", "source", "players": {espn_id: [[record, value, when], ...]}}.
Usage: python src/nfl_records.py
"""
import datetime as dt
import json
import os
import re
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "nfl", "records.json")
PAGES = ["List_of_NFL_individual_records", "List_of_NFL_quarterback_records"]
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com; records for player pages)"}

SKIP_SECTIONS = re.compile(r"age|oldest|youngest|firsts|see also|references|external|wins/losses|losses|starts", re.I)
# records nobody wants in gold on their page
BAD = re.compile(r"lowest|thrown|sacked|fumbles(?!.*(forced|recovered|return))|blocked|losses|lost|negative|safeties allowed", re.I)
MANY = re.compile(r"\bby \d+ players\b|\bby (several|many)\b", re.I)
LINK = re.compile(r"\[\[([^|\]]+)(?:\|([^\]]+))?\]\]")
NOT_PLAYER = re.compile(r"season|\d{4}|^Super Bowl|^List of|Bowl$|Field goal|National Football League|^NFL|"
                        r"(Cardinals|Falcons|Ravens|Bills|Panthers|Bears|Bengals|Browns|Cowboys|Broncos|Lions|Packers|Texans|Colts|"
                        r"Jaguars|Chiefs|Raiders|Chargers|Rams|Dolphins|Vikings|Patriots|Saints|Giants|Jets|Eagles|Steelers|49ers|"
                        r"Seahawks|Buccaneers|Titans|Commanders|Redskins|Oilers)$")
POS_HINT = {"quarterback": "QB", "running back": "RB", "wide receiver": "WR", "tight end": "TE", "placekicker": "K",
            "kicker": "K", "punter": "P", "linebacker": "D", "cornerback": "D", "safety": "D", "defensive end": "D",
            "defensive tackle": "D", "offensive tackle": "O", "guard": "O", "center": "O"}
POS_GROUP = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "PK": "K", "K": "K", "P": "P",
             "LB": "D", "OLB": "D", "ILB": "D", "MLB": "D", "CB": "D", "S": "D", "SAF": "D", "FS": "D", "SS": "D", "DE": "D",
             "DT": "D", "NT": "D", "DL": "D", "EDGE": "D", "DB": "D", "OT": "O", "T": "O", "G": "O", "OG": "O", "C": "O", "OL": "O"}
# who a section's records belong to, to tell two players with one name apart (Lamar Jackson the QB, not the CB)
SECTION_POS = [(r"quarterback|passer|passing|completion", {"QB"}), (r"rushing", {"RB", "QB"}),
               (r"receiv|reception", {"WR", "TE", "RB"}), (r"field goal|points after|extra point|kicks made", {"K"}),
               (r"punting|punts", {"P"}), (r"sacks|tackles|interceptions|fumbles forced|safeties", {"D"})]


def raw(title):
    r = requests.get("https://en.wikipedia.org/w/index.php", params={"title": title, "action": "raw"}, headers=UA, timeout=30)
    r.raise_for_status()
    return r.text


def plain(s):
    """Wikitext to text: refs, templates and links out."""
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    for _ in range(3):
        s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = LINK.sub(lambda m: m.group(2) or m.group(1), s)
    s = re.sub(r"'''?|&nbsp;", " ", s).replace("&ndash;", "–")
    return re.sub(r"\s+", " ", s).strip(" ,;")


def records(text):
    """[(section, record title, value, [(holder link target, holder name, detail text)])]"""
    out, section = [], ""
    # holders listed on their own ":" lines under the record belong to it
    text = re.sub(r"\n:(?=\s*\[\[)", "; ", text)
    for line in text.splitlines():
        h = re.match(r"^(=+)\s*(.*?)\s*\1\s*$", line)
        if h:
            if len(h.group(1)) == 2:
                section = h.group(2)
            continue
        m = re.match(r"^\*\s*'''(.+?)''':\s*(.*)$", line)
        if not m or SKIP_SECTIONS.search(section):
            continue
        title = plain(m.group(1))
        rest = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->", "", m.group(2))
        if BAD.search(title) or MANY.search(rest) or "most recently" in rest:
            continue
        first = rest.find("[[")
        if first < 0:
            continue
        value = plain(rest[:first]).rstrip(" ,(")
        # holders: each player link, with the text up to the next player link (dates, years, the game)
        body = rest[first:]
        links = [lm for lm in LINK.finditer(body) if not NOT_PLAYER.search(lm.group(1))]
        holders = []
        for i, lm in enumerate(links):
            end = links[i + 1].start() if i + 1 < len(links) else len(body)
            name = re.sub(r"\s*\(.*\)$", "", lm.group(2) or lm.group(1)).strip()
            holders.append((lm.group(1), name, plain(body[lm.end():end]).strip(" ,;()")))
        if holders and value and len(holders) <= 4:
            out.append((section, title, value, holders))
    return out


def key(name):
    """Name to match on: "T. J. Watt" = "T.J. Watt" = "tj watt"."""
    n = re.sub(r"\b(\w)\.\s*", r"\1", name)
    return re.sub(r"[.'’]", "", n).lower().strip()


def main():
    players = json.load(open(os.path.join(ROOT, "docs", "data", "players_nfl.json"), encoding="utf-8"))
    by_name = {}
    for name, pid, pos, y0, y1 in players:
        by_name.setdefault(key(name), []).append((pid, pos, y0, y1))
    found, seen, year = {}, set(), dt.date.today().year
    for page in PAGES:
        for section, title, value, holders in records(raw(page)):
            if page.endswith("quarterback_records") and re.search(r"Playing|Rushing|Sacks|Tackles", section) \
                    and not re.search(r"quarterback|QB|pass", title, re.I):
                title += " (QB)"
            if (title, value) in seen:  # both pages list a few
                continue
            seen.add((title, value))
            for target, name, detail in holders:
                cands = by_name.get(key(name), [])
                hint = re.search(r"\(([^)]*)\)", target)
                want = next((p for k, p in POS_HINT.items() if hint and k in hint.group(1).lower()), None)
                if want:
                    cands = [c for c in cands if POS_GROUP.get(c[1], c[1]) == want]
                if len(cands) > 1:  # two players with that name: the one who plays the record's position
                    ctx = f"{page} {section} {title}"
                    groups = set().union(*[g for r, g in SECTION_POS if re.search(r, ctx, re.I)])
                    if page.endswith("quarterback_records"):
                        groups = {"QB"}
                    if groups:
                        cands = [c for c in cands if POS_GROUP.get(c[1], c[1]) in groups] or cands
                yrs = [int(y) for y in re.findall(r"\b(19[2-9]\d|20[0-3]\d)\b", detail)] + ([year] if "present" in detail else [])
                if yrs:  # his career has to overlap the record's years
                    cands = [c for c in cands if c[2] - 1 <= max(yrs) and c[3] + 1 >= min(yrs)]
                if len(cands) != 1:
                    continue  # not on our site, or still two: better none than the wrong one
                when = re.sub(r"^\(?\s*(vs\.?|at)\s+[^)]*\)\s*,?", "", detail).strip(" ,()")
                if "(" not in when:
                    when = when.replace(")", "")
                mine = found.setdefault(cands[0][0], [])
                if not any(r[1] == value and r[0].replace(" (QB)", "") == title.replace(" (QB)", "") for r in mine):
                    mine.append([title, value, when[:60]])
    data = {"updated": dt.date.today().isoformat(), "source": "Wikipedia: List of NFL individual records / quarterback records",
            "players": found}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{sum(len(v) for v in found.values())} records held by {len(found)} players -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
