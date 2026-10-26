"""NFL record leaderboards for Stats > Records, and the "who's behind him" view from a player's records (live.js).

Source: Wikipedia's career leader lists ("List of NFL career rushing touchdowns leaders"...), the dual-threat
quarterback records (QB rushing, career and season) and the 2,000-yard / 5,000-yard clubs. Editors update them
weekly during the season ("Through Week 7 of the 2026 season"), and they cite the NFL Record & Fact Book and Pro
Football Reference, same as src/nfl_records.py. We read the rendered tables, so templates and footnotes are already
resolved, and match each player to our ESPN player list by name (with the years he played) for a link.

Two checks keep the numbers right (Terry: "find a reliable way to source the nfl records"):
  - Active players' career totals come from ESPN's career stats (regular season, updated after every game), not the
    list, which editors bring up to date about once a week. ESPN and the lists agreed on every one checked
    (Allen 87 QB rushing TDs, Henry 129 rushing TDs, Oct 2026).
  - Retired players' totals never change, so once we have one we keep it: if a list's number for a retired player
    changes later (a bad edit), the old number stays and the run prints a warning.

Writes docs/data/nfl/record_boards.json:
  {"updated", "boards": {key: {"title", "kind": "career"|"season", "unit", "through", "page", "rows": [...]}},
   "records": {record name in records.json: board key}}
  a row: {"rank", "name", "value", "active", "id" (ESPN id or null), "season" (season boards)}
Usage: python src/record_boards.py
"""
import datetime as dt
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "nfl" / "record_boards.json"
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com; record leaderboards)"}
DT = "List_of_dual-threat_quarterback_records"
TOP = 25  # rows kept per board (season clubs keep every row: they're short)
ESPN = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/{}/stats"
# career boards ESPN can refresh: board -> (ESPN stat category, stat name). All-purpose yards and QB wins stay as listed.
LIVE = {"pass_yds": ("passing", "passingYards"), "pass_td": ("passing", "passingTouchdowns"), "completions": ("passing", "completions"),
        "rush_yds": ("rushing", "rushingYards"), "rush_td": ("rushing", "rushingTouchdowns"), "rush_att": ("rushing", "rushingAttempts"),
        "rec": ("receiving", "receptions"), "rec_yds": ("receiving", "receivingYards"), "rec_td": ("receiving", "receivingTouchdowns"),
        "scoring": ("scoring", "totalPoints"), "sacks": ("defensive", "sacks"), "ints": ("defensive", "interceptions"),
        "qb_rush_td": ("rushing", "rushingTouchdowns"), "qb_rush_yds": ("rushing", "rushingYards"), "qb_rush_att": ("rushing", "rushingAttempts")}

# key: (title, kind, unit, page, section path that must appear (None = first table), value column header)
BOARDS = {
    "pass_yds": ("Passing yards", "career", "yds", "List_of_NFL_career_passing_yards_leaders", None, r"^Yds|yards"),
    "pass_td": ("Passing touchdowns", "career", "TD", "List_of_NFL_career_passing_touchdowns_leaders", None, r"^TDs?$|touchdowns"),
    "completions": ("Completions", "career", "", "List_of_NFL_career_passing_completions_leaders", None, r"^Comp|completions"),
    "rush_yds": ("Rushing yards", "career", "yds", "List_of_NFL_career_rushing_yards_leaders", None, r"^Yds|yards"),
    "rush_td": ("Rushing touchdowns", "career", "TD", "List_of_NFL_career_rushing_touchdowns_leaders", None, r"touchdowns|^TDs?$"),
    "rush_att": ("Rushing attempts", "career", "", "List_of_NFL_career_rushing_attempts_leaders", None, r"^Att|attempts"),
    "rec": ("Receptions", "career", "", "List_of_NFL_career_receptions_leaders", None, r"^Rec|receptions"),
    "rec_yds": ("Receiving yards", "career", "yds", "List_of_NFL_career_receiving_yards_leaders", None, r"^Yds|yards"),
    "rec_td": ("Receiving touchdowns", "career", "TD", "List_of_NFL_career_receiving_touchdowns_leaders", None, r"touchdowns|^TDs?$"),
    "all_purpose": ("All-purpose yards", "career", "yds", "List_of_NFL_career_all-purpose_yards_leaders", None, r"^Total|^Yds|all-purpose"),
    "scoring": ("Points", "career", "pts", "List_of_NFL_career_scoring_leaders", None, r"^Pts|points"),
    "sacks": ("Sacks", "career", "", "List_of_NFL_career_sacks_leaders", None, r"^Sacks?$"),
    "ints": ("Interceptions", "career", "", "List_of_NFL_career_interceptions_leaders", None, r"^Int|interceptions"),
    "qb_wins": ("Quarterback wins", "career", "", "List_of_NFL_career_quarterback_wins_leaders", None, r"^W(ins)?$|wins"),
    "qb_rush_td": ("QB rushing touchdowns", "career", "TD", DT, ("National Football League", "Career records", "Rushing touchdowns"), r"TDs?$|touchdowns"),
    "qb_rush_yds": ("QB rushing yards", "career", "yds", DT, ("National Football League", "Career records", "Rushing yards"), r"^Yds|yards"),
    "qb_rush_att": ("QB rushing attempts", "career", "", DT, ("National Football League", "Career records", "Rushing attempts"), r"^Att|attempts"),
    "qb_rush_td_season": ("QB rushing touchdowns", "season", "TD", DT, ("National Football League", "Single-season", "Rushing touchdowns"), r"TDs?$|touchdowns"),
    "qb_rush_yds_season": ("QB rushing yards", "season", "yds", DT, ("National Football League", "Single-season", "Rushing yards"), r"^Yds|yards"),
    "qb_rush_att_season": ("QB rushing attempts", "season", "", DT, ("National Football League", "Single-season", "Rushing attempts"), r"^Att|attempts"),
    "rush_yds_season": ("Rushing yards (2,000-yard seasons)", "season", "yds", "2,000-yard_club", None, r"^Yds$"),
    "pass_yds_season": ("Passing yards (5,000-yard seasons)", "season", "yds", "List_of_NFL_quarterbacks_with_5,000_passing_yards_in_a_season", None, r"^Yds|yards"),
}
# record names in docs/data/nfl/records.json -> the board that ranks it (records with no board stay plain text)
RECORDS = {
    "Most passing yards, career": "pass_yds", "Most passing touchdowns, career": "pass_td", "Most pass completions, career": "completions",
    "Most rushing yards, career": "rush_yds", "Most rushing touchdowns, career": "rush_td", "Most rushing attempts, career": "rush_att",
    "Most pass receptions, career": "rec", "Most receiving yards, career": "rec_yds", "Most receiving touchdowns, career": "rec_td",
    "Most points scored, career": "scoring", "Most sacks, career": "sacks", "Most interceptions, career": "ints",
    "Most rushing touchdowns by a quarterback, career": "qb_rush_td", "Most rushing yards by a quarterback, career": "qb_rush_yds",
    "Most rushing attempts by a quarterback, career": "qb_rush_att", "Most rushing touchdowns by a quarterback, season": "qb_rush_td_season",
    "Most rushing yards by a quarterback, season": "qb_rush_yds_season", "Most rushing attempts by a quarterback, season": "qb_rush_att_season",
    "Most rushing yards, season": "rush_yds_season", "Most passing yards, season": "pass_yds_season",
}


class Tables(HTMLParser):
    """Every wikitable on a page, with the headings above it and its cells (rowspan/colspan filled in).
    A cell is {"text", "link" (first /wiki/ link), "active" (the light-teal background the lists use for active players;
    not the * mark, which some lists use for other things)}."""

    def __init__(self):
        super().__init__()
        self.heads, self.tables, self.stack = [], [], []  # heads: [(level, text)]; stack: open tables (nested ones skipped)
        self.cell = self.row = None
        self.hlevel, self.htext, self.skip = None, "", 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("style", "script") or "reference" in (a.get("class") or "") or tag == "sup" and "reference" in (a.get("class") or ""):
            self.skip += 1
            return
        if re.fullmatch(r"h[2-5]", tag):
            self.hlevel, self.htext = int(tag[1]), ""
        elif tag == "table":
            self.stack.append({"wiki": "wikitable" in (a.get("class") or ""), "rows": [], "heads": [t for _, t in self.heads], "spans": {}})
        elif not self.stack or not self.stack[-1]["wiki"] or len(self.stack) > 1:
            return
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            style = (a.get("style") or "").lower()
            self.cell = {"text": "", "link": None, "active": "cfecec" in style, "th": tag == "th",
                         "rs": int(re.sub(r"\D", "", a.get("rowspan") or "1") or 1), "cs": int(re.sub(r"\D", "", a.get("colspan") or "1") or 1)}
        elif tag == "a" and self.cell is not None and not self.cell["link"] and (a.get("href") or "").startswith("/wiki/"):
            self.cell["link"] = a["href"][6:]
        elif tag == "br" and self.cell is not None:
            self.cell["text"] += " "

    def handle_endtag(self, tag):
        if tag in ("style", "script", "sup") and self.skip:
            self.skip -= 1
            return
        if self.hlevel and tag == f"h{self.hlevel}":
            self.heads = [h for h in self.heads if h[0] < self.hlevel] + [(self.hlevel, self.htext.strip())]
            self.hlevel = None
        elif tag == "table" and self.stack:
            t = self.stack.pop()
            if t["wiki"] and not self.stack:
                self.tables.append({"heads": t["heads"], "rows": t["rows"]})
        elif tag in ("td", "th") and self.cell is not None and self.row is not None:
            c = self.cell
            c["text"] = re.sub(r"\s+", " ", c["text"]).strip()
            self.row.append(c)
            self.cell = None
        elif tag == "tr" and self.row is not None and self.stack:
            self.stack[-1]["rows"].append(self._fill(self.stack[-1], self.row))
            self.row = None

    def _fill(self, t, row):
        """Place a row's cells around the ones still spanning down from rows above."""
        out, spans, col = [], t["spans"], 0
        cells = list(row)
        while cells or col in spans:
            if col in spans:
                c, left = spans[col]
                out.append(c)
                spans[col] = (c, left - 1)
                if left - 1 <= 0:
                    del spans[col]
                col += 1
                continue
            c = cells.pop(0)
            for _ in range(c["cs"]):
                out.append(c)
                if c["rs"] > 1:
                    spans[col] = (c, c["rs"] - 1)
                col += 1
        return out

    def handle_data(self, data):
        if self.skip:
            return
        if self.hlevel:
            self.htext += data
        if self.cell is not None:
            self.cell["text"] += data


def page_html(title):
    r = requests.get("https://en.wikipedia.org/w/api.php", headers=UA, timeout=60, params={
        "action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": 2, "redirects": 1})
    r.raise_for_status()
    return r.json()["parse"]["text"]


def through(html):
    """"Through Week 7 of the 2026 season" when the page says so (when it was last brought up to date)."""
    m = re.search(r"[Tt]hrough (?:the )?(?:end of )?(?:Week \d+[^.<]*?|the )?\d{4}(?: NFL)? season", re.sub(r"<[^>]+>", "", html))
    return re.sub(r"\s+", " ", m.group(0)).strip() if m else None


def num(s):
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", s or "")
    return float(m.group(0).replace(",", "")) if m else None


OTHER = re.compile(r"postseason|playoff|historical|single-game|reign|progression", re.I)  # tables that aren't the regular-season list


def board(tables, section, value_re, season=False):
    """Rows from every table under `section` (all of its headings) that has Player + value columns. Long lists come
    split up ("at least 1,000 receptions", "at least 900"), so the tables are added together, minus playoff/history ones."""
    out, seen = [], set()
    for t in tables:
        if section and not all(any(s.lower() in h.lower() for h in t["heads"]) for s in section):
            continue
        if any(OTHER.search(h) for h in t["heads"][-1:]):
            continue
        rows = [r for r in t["rows"] if r]
        hdr = next((r for r in rows if all(c["th"] for c in r) and len(r) > 2), None)
        if not hdr:
            continue
        names = [c["text"].replace("­", "") for c in hdr]
        pcol = next((i for i, n in enumerate(names) if re.search(r"^(Player|Name|Quarterback|Running back)", n, re.I)), None)
        vcol = next((i for i, n in enumerate(names) if re.search(value_re, n, re.I) and i != pcol), None)
        scol = next((i for i, n in enumerate(names) if re.fullmatch(r"Season|Year", n, re.I)), None) if season else None
        if pcol is None or vcol is None:
            continue
        for r in rows[rows.index(hdr) + 1:]:
            if len(r) <= max(pcol, vcol) or all(c["th"] for c in r):
                continue
            p, v = r[pcol], num(r[vcol]["text"])
            name = re.sub(r"[*^†‡§#+¤]|\(.*?\)|\[.*?\]", "", p["text"]).strip()
            if v is None or not name or re.search(r"\d", name):
                continue
            row = {"name": name, "value": int(v) if v == int(v) else v, "active": p["active"], "link": p["link"]}
            if scol is not None and scol < len(r):
                yr = re.search(r"(19|20)\d\d", r[scol]["text"])
                row["season"] = int(yr.group(0)) if yr else None
            if (name, row.get("season")) not in seen:
                seen.add((name, row.get("season")))
                out.append(row)
        if section and out:  # a section names one table
            break
    return out


_careers = {}


def espn_career(pid):
    """{category: {stat: number}} career regular-season totals from ESPN, or {} if it can't be read."""
    if pid not in _careers:
        try:
            d = requests.get(ESPN.format(pid), headers=UA, timeout=30).json()
            _careers[pid] = {c["name"]: {n: num(v) for n, v in zip(c.get("names", []), c.get("totals") or [])} for c in d.get("categories", [])}
        except Exception as e:
            print(f"  ESPN career stats for {pid} unavailable ({e!r}); keeping the list's number")
            _careers[pid] = {}
    return _careers[pid]


def key(name):
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", name.lower()))


def main():
    players = json.loads((ROOT / "docs" / "data" / "players_nfl.json").read_text(encoding="utf-8"))
    by_name = {}
    for name, pid, pos, y0, y1 in players:
        by_name.setdefault(key(name), []).append((pid, pos, y0, y1))
    year = dt.date.today().year if dt.date.today().month >= 8 else dt.date.today().year - 1
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))["boards"]
    except (OSError, ValueError, KeyError):
        old = {}
    pages, out = {}, {}
    for k, (title, kind, unit, page, section, value_re) in BOARDS.items():
        try:
            if page not in pages:
                html = page_html(page)
                p = Tables()
                p.feed(html)
                pages[page] = (p.tables, through(html))
            tables, thru = pages[page]
        except Exception as e:  # one page down: keep the rest
            print(f"  {k}: {page} unavailable ({e!r})")
            continue
        rows = board(tables, section, value_re, kind == "season")
        if len(rows) < 5:
            print(f"  {k}: only {len(rows)} rows found, skipped")
            continue
        kept = {(r["name"], r.get("season")): r["value"] for r in old.get(k, {}).get("rows", []) if not r.get("active")}
        for r in rows:
            cands = by_name.get(key(r["name"]), [])
            if len(cands) > 1 and r.get("season"):
                cands = [c for c in cands if c[2] <= r["season"] <= c[3]]
            if len(cands) > 1:
                cands = [c for c in cands if r["active"] == (c[3] >= year)] or cands
            r["id"] = cands[0][0] if len(cands) == 1 else None
            r["active"] = kind == "career" and bool(r["active"] or (r["id"] and cands[0][3] >= year))
            r.pop("link", None)
            if r["active"] and r["id"] and k in LIVE:  # live total from ESPN
                v = espn_career(r["id"]).get(LIVE[k][0], {}).get(LIVE[k][1])
                if v is not None and v >= r["value"] * 0.9:  # a far smaller number means the wrong player or a bad read
                    r["value"] = int(v) if v == int(v) else v
            elif not r["active"] and kept.get((r["name"], r.get("season")), r["value"]) != r["value"]:
                print(f"  warning: {k}: list now says {r['name']} {r['value']}, we had {kept[(r['name'], r.get('season'))]}; keeping ours")
                r["value"] = kept[(r["name"], r.get("season"))]
        rows.sort(key=lambda r: -r["value"])  # season clubs are listed by year; rank them by the number
        if kind == "career" or len(rows) > 40:
            rows = rows[:TOP]
        prev, rank = None, 0
        for i, r in enumerate(rows):
            rank = rank if r["value"] == prev else i + 1  # ties share a rank, like the lists do
            prev, r["rank"] = r["value"], rank
        out[k] = {"title": title, "kind": kind, "unit": unit, "through": thru, "page": page, "rows": rows}
        print(f"  {k}: {len(rows)} rows, #1 {rows[0]['name']} {rows[0]['value']}")
    if len(out) < len(BOARDS) // 2:
        sys.exit(f"Only {len(out)} of {len(BOARDS)} boards built; keeping the old file")
    data = {"updated": dt.date.today().isoformat(), "boards": out, "records": {r: b for r, b in RECORDS.items() if b in out}}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out)} boards -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
