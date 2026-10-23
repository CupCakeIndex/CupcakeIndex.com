"""Mock draft: our two-round NFL mock for next spring, and the board the "Be the GM" game drafts from (docs/mock.js).

How it works (free data only: our NFL model and stats, ESPN college rosters, our college stats, Google News):
  1. Draft order: 10,000 simulations of the rest of the NFL season from our win chances. Teams that miss the playoffs
     pick 1-18 by projected wins (fewest first), then playoff teams 19-32. Ties are broken by our power rating.
  2. Team needs: where each unit ranks in our play-by-play numbers (the same units as Trade watch), so a #30 pass
     defense needs a corner. QB is a need only with a weak passing game and no young first-round QB, or an old starter.
  3. Prospects: every FBS junior, senior or grad student (ESPN rosters; a sophomore counts only if the draft
     headlines treat him as a prospect, since redshirt sophomores can declare).
     - Buzz: headlines from the last 30 days naming him next to a draft word (mock draft, big board, first round...),
       from ~125 Google News searches (the draft in general, each position, each big school, each NFL team). This is
       the best public sign of where scouts and analysts have him; our stats can't see film.
     - Production: his 2026 numbers against every FBS player at his position (none for linemen; they ride on buzz).
     - Position value: QBs, edge rushers, tackles and corners go earlier than running backs and linebackers.
     Score = 1.0 x log2(1 + headlines) + 1.2 x production + position value; Group of 5 production counts 60%.
  4. Picks: each team takes the best score left plus a need bonus (+0.9 its biggest need, +0.5 second, +0.25 third);
     a team with its QB (no QB need) takes one only if he's far and away the best left (-3).

Writes docs/data/nfl/mock_draft.json. Usage: python src/mock_draft.py [--no-news]
"""
import datetime as dt
import glob
import html
import json
import math
import os
import random
import re
import sys
import time
from collections import defaultdict

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs", "data")
OUT = os.path.join(DOCS, "nfl", "mock_draft.json")
CACHE = os.path.join(ROOT, "data", "raw", "cfb")
SIMS = 10000
UA = {"User-Agent": "Mozilla/5.0 (compatible; CupcakeIndex/1.0; +https://cupcakeindex.com)"}
P4 = {"SEC", "Big Ten", "Big 12", "ACC"}

# draft positions from ESPN's college ones (refined below from stats and headlines)
POS = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "OT": "OT", "T": "OT", "OL": "OL", "OG": "IOL", "G": "IOL", "C": "IOL",
       "IOL": "IOL", "DE": "EDGE", "EDGE": "EDGE", "DL": "DL", "DT": "DL", "NT": "DL", "LB": "LB", "OLB": "LB", "ILB": "LB", "MLB": "LB",
       "CB": "CB", "DB": "DB", "S": "S", "SAF": "S", "FS": "S", "SS": "S", "NB": "CB"}
# how early a position goes, in score points (a QB at the same grade goes well before a RB)
VALUE = {"QB": 0.9, "EDGE": 0.6, "OT": 0.55, "CB": 0.45, "WR": 0.45, "DL": 0.35, "OL": 0.35, "TE": 0.15, "S": 0.15, "DB": 0.3,
         "IOL": 0.1, "LB": 0.1, "RB": 0.0}
# which team unit each position fixes (the same units as Trade watch)
NEED_OF = {"QB": "QB", "WR": "WR", "TE": "WR", "RB": "RB", "OT": "OL", "OL": "OL", "IOL": "OL", "EDGE": "RUSH", "DL": "RUSH",
           "LB": "RUND", "CB": "COV", "S": "COV", "DB": "COV"}
NEED_TXT = {"QB": "passing offense", "WR": "passing offense", "RB": "run game", "OL": "pass protection", "RUSH": "pass rush",
            "RUND": "run defense", "COV": "pass defense"}
NEED_BONUS = [0.9, 0.5, 0.25]

DRAFT_WORDS = re.compile(r"\bdraft\b|mock|big board|prospects?\b|first[- ]round|1st[- ]round|scouts?\b|draft stock|top \d+ (?:players|prospects)|"
                         r"\bdeclare|senior bowl|\bNo\. ?1 pick|top pick|\bcombine\b", re.I)
# the word(s) right before a name in a headline ("Alabama EDGE ...", "OT ..."): abbreviations are case-sensitive, so the
# "s" in "Renner's" isn't a safety. Only used to split ESPN's broad OL / DL / DB.
HINT = [(re.compile(r"(?:\b(?:EDGE|Edge|DE)|\b(?i:edge rusher|pass rusher|defensive end))\s*$"), "EDGE"),
        (re.compile(r"(?:\b(?:OT)|\b(?i:offensive tackle|left tackle|right tackle))\s*$"), "OT"),
        (re.compile(r"(?:\b(?:IOL|OG)|\b(?i:guard|center))\s*$"), "IOL"),
        (re.compile(r"(?:\b(?:DT|IDL)|\b(?i:defensive tackle|nose tackle))\s*$"), "DL"),
        (re.compile(r"(?:\b(?:CB)|\b(?i:cornerback))\s*$"), "CB"),
        (re.compile(r"(?:\b(?:S)|\b(?i:safety))\s*$"), "S")]
SPLIT = {"OL": {"OT", "IOL"}, "DL": {"EDGE", "DL"}, "DB": {"CB", "S"}}


def latest_week(season):
    files = glob.glob(os.path.join(DOCS, "nfl", str(season), "week_*.json"))
    return max(files, key=lambda p: int(re.findall(r"(\d+)\.json", p)[0]))


def project(teams):
    """{team: (projected wins, playoff chance)} from SIMS runs of the remaining games (our model's win chances)."""
    games, seen = [], set()
    for t in teams:
        for g in t["schedule"]:
            if g.get("upcoming") and g.get("win_prob") is not None and g["espn_id"] not in seen:
                seen.add(g["espn_id"])
                games.append((t["team"], g["opp"], g["win_prob"]))
    names = [t["team"] for t in teams]
    conf = {t["team"]: t["conference"].split()[0] for t in teams}
    div = {t["team"]: t["conference"] for t in teams}
    w0 = {t["team"]: t["wins"] + 0.5 * t.get("ties", 0) for t in teams}
    made, wins = dict.fromkeys(names, 0), dict.fromkeys(names, 0.0)
    rnd = random.Random(7)
    for _ in range(SIMS):
        w = dict(w0)
        for a, b, p in games:
            w[a if rnd.random() < p else b] += 1
        key = {n: w[n] + rnd.random() * 1e-3 for n in names}
        for cf in ("AFC", "NFC"):
            mine = [n for n in names if conf[n] == cf]
            champs = {max((n for n in mine if div[n] == d), key=key.get) for d in {div[n] for n in mine}}
            wild = sorted((n for n in mine if n not in champs), key=key.get, reverse=True)[:3]
            for n in champs | set(wild):
                made[n] += 1
        for n in names:
            wins[n] += w[n]
    return {n: (wins[n] / SIMS, made[n] / SIMS) for n in names}


def unit_ranks(V):
    """{unit: {team key: rank 1 (best)..32}} from this season's per-play numbers (same as Trade watch)."""
    tc = {c: i + 3 for i, c in enumerate(V["tcols"])}
    T = {}
    for r in V["trows"]:
        s = T.setdefault(r[0], {})
        for c, i in tc.items():
            s[c] = s.get(c, 0) + (r[i] or 0)

    def per(a, b):
        return lambda s: s[a] / s[b] if s.get(b) else 0
    metric = {"QB": (per("pass_epa", "att"), 1), "WR": (per("pass_epa", "att"), 1), "RB": (per("rush_epa", "carries"), 1),
              "OL": (per("sacked", "att"), -1), "RUSH": (per("def_sacks", "opp_att"), 1),
              "RUND": (lambda s: s["opp_rush_yds"] / max(1, s["opp_plays"] - s["opp_att"]), -1), "COV": (per("opp_pass_yds", "opp_att"), -1)}
    return {u: {k: i + 1 for i, k in enumerate(sorted(T, key=lambda k: -sign * f(T[k])))} for u, (f, sign) in metric.items()}


def qb_need(V, rank, usual):
    """{team key: True} when a team should look at a QB: a weak passing game without a young first-round starter,
    or an old starter on a team that isn't passing well. The starter is our rankings' usual QB (so a backup filling
    in for an injury doesn't count), else whoever threw the most."""
    pc = {c: i + 3 for i, c in enumerate(V["pcols"])}
    att = defaultdict(lambda: defaultdict(float))
    for r in V["prows"]:
        att[r[2]][r[0]] += r[pc["att"]] or 0
    out = {}
    for team, by in att.items():
        qb = max(by, key=by.get)
        named = [p for p in by if (V["pmeta"].get(p) or [""])[0] == usual.get(team)]
        m = V["pmeta"].get(named[0] if named else qb) or []
        yrs = m[4] if len(m) > 4 and isinstance(m[4], int) else 5
        first = len(m) > 5 and str(m[5]).startswith("R1")
        r = rank["QB"].get(team, 16)
        young_star = first and yrs <= 10  # a first-round starter in his first 10 years: the franchise QB
        out[team] = (r >= 18 and not young_star) or (yrs >= 14 and r >= 10)
    return out


def rosters(teams, season):
    """{espn id: [name, ESPN position, class, school id]} for every FBS roster, cached for 3 days."""
    f = os.path.join(CACHE, f"draft_rosters_{season}.json")
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 3 * 86400:
        return json.load(open(f, encoding="utf-8"))
    out = {}
    for t in teams:
        for _ in range(3):
            try:
                r = requests.get(f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{t['id']}/roster", timeout=20)
                if r.ok:
                    for grp in r.json().get("athletes", []):
                        for a in grp.get("items", []):
                            out[str(a["id"])] = [a.get("displayName") or a.get("fullName", ""), (a.get("position") or {}).get("abbreviation", ""),
                                                 (a.get("experience") or {}).get("abbreviation", ""), str(t["id"])]
                    break
            except requests.RequestException:
                pass
            time.sleep(1)
        time.sleep(0.1)
    if len(out) < 5000:
        raise SystemExit(f"Only {len(out)} roster players came back from ESPN; not saving.")
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(f, "w", encoding="utf-8"))
    return out


def headlines(schools, nfl_teams, year):
    """Draft headlines from the last 30 days: [(title, link)], deduped."""
    qs = [f"{year} NFL mock draft", f"{year} NFL Draft prospects", f"{year} NFL Draft big board", f"{year} NFL Draft rankings",
          f"{year} NFL Draft first round", f"{year} NFL Draft stock", f"{year} NFL Draft risers fallers", f"{year} NFL Draft top prospects",
          f"{year} NFL Draft Senior Bowl", f"{year} NFL Draft declare"]
    qs += [f"{year} NFL Draft {p}" for p in ("quarterback", "running back", "wide receiver", "tight end", "offensive tackle", "interior offensive line",
                                              "edge rusher", "defensive tackle", "linebacker", "cornerback", "safety")]
    qs += [f"{s} {year} NFL Draft" for s in schools]
    qs += [f"{t} {year} mock draft" for t in nfl_teams]
    seen, out = set(), []
    for q in qs:
        try:
            r = requests.get("https://news.google.com/rss/search", params={"q": f"{q} when:30d", "hl": "en-US", "gl": "US", "ceid": "US:en"},
                             headers=UA, timeout=20)
            r.raise_for_status()
            r.encoding = "utf-8"
        except requests.RequestException:
            continue
        for item in re.findall(r"<item>(.*?)</item>", r.text, re.S):
            t = re.search(r"<title>(.*?)</title>", item, re.S)
            l = re.search(r"<link>(.*?)</link>", item, re.S)
            if not t:
                continue
            title = html.unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))).strip()
            title = re.sub(r"\s+-\s+[^-]+$", "", title)  # " - Source"
            k = title.lower()
            if k in seen or not DRAFT_WORDS.search(title):
                continue
            seen.add(k)
            out.append((title, html.unescape(l.group(1).strip()) if l else ""))
        time.sleep(0.3)
    return out


def norm(name):
    """'Kenyatta Jackson Jr.' -> 'kenyatta jackson' (what a headline will match)."""
    n = re.sub(r"[.'’]", "", name.lower())
    n = re.sub(r"\s+(jr|sr|ii|iii|iv|v)$", "", n.strip())
    return re.sub(r"[^a-z\s-]", "", n).strip()


def production(V):
    """{player id: (coarse group, 0..1 percentile among FBS players at that group)} from this season's per-game numbers."""
    pc = {c: i + 3 for i, c in enumerate(V["pcols"])}
    tot, games = defaultdict(lambda: defaultdict(float)), defaultdict(int)
    for r in V["prows"]:
        for c, i in pc.items():
            tot[r[0]][c] += r[i] or 0
        games[r[0]] += 1
    f = {  # (who counts, per-game number)
        "QB": (lambda s: s["att"] >= 60, lambda s, g: (s["pass_yds"] + 20 * s["pass_td"] - 45 * s["int"] + s["rush_yds"]) / g),
        "RB": (lambda s: s["carries"] >= 30, lambda s, g: (s["rush_yds"] + s["rec_yds"] + 20 * (s["rush_td"] + s["rec_td"])) / g),
        "WR": (lambda s: s["rec"] >= 8, lambda s, g: (s["rec_yds"] + 20 * s["rec_td"]) / g),
        "DL": (lambda s: s["tackles"] + s["def_sacks"] > 3, lambda s, g: (4 * s["def_sacks"] + 2 * s["tfl"] + 1.5 * s["qb_hits"] + 0.3 * s["tackles"]) / g),
        "LB": (lambda s: s["tackles"] >= 10, lambda s, g: (s["tackles"] + 3 * s["tfl"] + 4 * s["def_sacks"] + 3 * s["pd"] + 6 * s["def_int"]) / g),
        "DB": (lambda s: s["tackles"] + s["pd"] >= 6, lambda s, g: (4 * s["pd"] + 8 * s["def_int"] + 0.4 * s["tackles"]) / g),
    }
    return tot, games, f


def main():
    viz = json.load(open(os.path.join(DOCS, "viz", "index.json")))
    season, cfb_season = max(viz["nfl"]), max(viz["cfb"])
    year = season + 1
    rk = json.load(open(latest_week(season), encoding="utf-8"))
    V = json.load(open(os.path.join(DOCS, "viz", f"nfl_{season}.json"), encoding="utf-8"))
    by_name = {v[0]: k for k, v in V["teams"].items()}
    abbr = {k: v[1] for k, v in V["teams"].items()}

    # 1. order
    proj = project(rk["teams"])
    rating = {t["team"]: t.get("rating", 0) for t in rk["teams"]}
    rec = {t["team"]: t["record"] for t in rk["teams"]}
    names = [t["team"] for t in rk["teams"] if t["team"] in by_name]
    out_ = sorted((n for n in names if proj[n][1] < 0.5), key=lambda n: (proj[n][0], rating[n]))
    in_ = sorted((n for n in names if proj[n][1] >= 0.5), key=lambda n: (proj[n][0], rating[n]))
    order = out_ + in_

    # 2. needs
    rank = unit_ranks(V)
    qbn = qb_need(V, rank, {by_name[t["team"]]: t.get("usual_qb") for t in rk["teams"] if t["team"] in by_name})
    needs = {}
    for n in order:
        k = by_name[n]
        units = sorted((u for u in ("WR", "RB", "OL", "RUSH", "RUND", "COV")), key=lambda u: -rank[u][k])
        if qbn.get(k):
            units = ["QB"] + units
        needs[abbr[k]] = [[u, rank["QB" if u == "QB" else u][k]] for u in units[:3]]

    # 3. prospects
    cfb_teams = json.load(open(os.path.join(DOCS, "teams.json"), encoding="utf-8"))["cfb"]
    school = {str(t["id"]): t for t in cfb_teams}
    R = rosters(cfb_teams, cfb_season)
    C = json.load(open(os.path.join(DOCS, "viz", f"cfb_{cfb_season}.json"), encoding="utf-8"))
    tot, games, F = production(C)
    group_of = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "WR", "OL": None, "DL": "DL", "LB": "LB", "DB": "DB"}
    pct = {}
    for g, (ok, val) in F.items():
        ids = [p for p, (nm, pos, cls, sid) in R.items() if group_of.get(POS.get(pos, pos) if pos not in ("DL", "DB", "OL") else pos) == g
               and p in tot and ok(tot[p])]
        vals = sorted((val(tot[p], games[p]), p) for p in ids)
        for i, (_, p) in enumerate(vals):
            pct[p] = (i + 0.5) / len(vals)

    cache = os.environ.get("MD_NEWS_CACHE")  # testing: reuse one fetch of the headlines
    if cache and os.path.exists(cache):
        titles = json.load(open(cache, encoding="utf-8"))
    else:
        titles = [] if "--no-news" in sys.argv else headlines(
            [t["name"] for t in cfb_teams if t["group"] in P4 or t["name"] == "Notre Dame"], [v[0] for v in V["teams"].values()], year)
        if cache:
            json.dump(titles, open(cache, "w", encoding="utf-8"))
    print(f"{len(titles)} draft headlines")
    by_norm = defaultdict(list)
    for pid, (nm, pos, cls, sid) in R.items():
        if pos in ("PK", "K", "P", "LS", "ATH", ""):
            continue
        by_norm[norm(nm)].append(pid)
    hits, hint, sample = defaultdict(int), defaultdict(lambda: defaultdict(int)), {}
    for title, link in titles:
        words = re.findall(r"[A-Za-z][A-Za-z.'’-]*", title)
        found = set()
        for n in (3, 2):
            for i in range(len(words) - n + 1):
                key = norm(" ".join(words[i:i + n]))
                if key not in by_norm:
                    continue
                cands = by_norm[key]
                if len(cands) > 1:  # two players with the same name: the one whose school is in the headline, else a Power 4 one
                    named = [p for p in cands if school.get(R[p][3], {}).get("name", "~") in title]
                    cands = named or [p for p in cands if school.get(R[p][3], {}).get("group") in P4][:1] or cands[:1]
                for p in cands[:1]:
                    sch = school.get(R[p][3], {})
                    if p in found or (sch.get("group") not in P4 and sch.get("name") != "Notre Dame" and sch.get("name", "~") not in title):
                        continue
                    found.add(p)
                    hits[p] += 1
                    sample.setdefault(p, [title, link])
                    before = title[:title.lower().find(words[i].lower())]
                    for rx, ps in HINT:
                        if rx.search(before):
                            hint[p][ps] += 1
    board = []
    for pid, (nm, pos, cls, sid) in R.items():
        if pos in ("PK", "K", "P", "LS", "ATH", "") or sid not in school:
            continue
        h = hits.get(pid, 0)
        if cls not in ("JR", "SR", "GR") and not (cls == "SO" and h >= 3):
            continue
        dp = POS.get(pos, pos)
        s = tot.get(pid, {})
        hs = {k: v for k, v in hint.get(pid, {}).items() if k in SPLIT.get(dp, ())}
        if hs:
            dp = max(hs, key=hs.get)
        elif dp == "DL" and s and (s["def_sacks"] + 0.5 * s["qb_hits"]) >= 0.45 * max(1, s["tfl"] + 1):
            dp = "EDGE"  # pressure more than run stops: an edge rusher
        elif dp == "DB" and s:
            dp = "CB" if s["pd"] >= 0.12 * max(1, s["tackles"]) else "S"
        p4 = school[sid]["group"] in P4 or school[sid]["name"] == "Notre Dame"
        prod = pct.get(pid, 0.35 if dp in ("OT", "IOL", "OL") else 0.0) * (1 if p4 else 0.6)
        score = 1.0 * math.log2(1 + h) + 1.2 * prod + VALUE.get(dp, 0)
        if h == 0 and score < 1.6:
            continue
        board.append({"id": pid, "name": nm, "pos": dp, "sid": sid, "school": school[sid]["name"], "cls": cls, "buzz": h,
                      "prod": round(prod, 2), "score": round(score, 3), "story": sample.get(pid)})
    board.sort(key=lambda b: -b["score"])
    board = board[:160]

    # 4. picks: two rounds in the same order
    before = {ab: list(v) for ab, v in needs.items()}  # what the page shows and Be the GM starts from
    left = list(range(len(board)))
    picks = []
    for rnd in (1, 2):
        for slot, n in enumerate(order):
            ab = abbr[by_name[n]]
            nd = [u for u, _ in needs[ab]]
            def fit(i):
                u = NEED_OF.get(board[i]["pos"])
                return board[i]["score"] + (NEED_BONUS[nd.index(u)] if u in nd else 0) - (3.0 if u == "QB" and "QB" not in nd else 0)
            best = max(left, key=fit)
            left.remove(best)
            u = NEED_OF.get(board[best]["pos"])
            mine = [r for x, r in needs[ab] if x == u]
            why = f"#{best + 1} on our board" + (f"; their {NEED_TXT[u]} ranks #{mine[0]} of 32" if mine else "; best player left")
            picks.append([(rnd - 1) * 32 + slot + 1, ab, best, why])
            # a team that just took a QB doesn't need another
            if u == "QB":
                needs[ab] = [x for x in needs[ab] if x[0] != "QB"] or needs[ab]

    team_out = {abbr[by_name[n]]: {"name": n, "record": rec[n], "wins": round(proj[n][0], 1), "playoff": round(proj[n][1], 2),
                                   "needs": [[u, r, NEED_TXT[u]] for u, r in before[abbr[by_name[n]]]], "id": by_name[n].split(":")[1]}
                for n in order}
    out = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "season": season, "year": year, "sims": SIMS,
           "headlines": len(titles), "order": [abbr[by_name[n]] for n in order], "teams": team_out, "board": board, "picks": picks,
           "value": VALUE, "need_of": NEED_OF, "need_bonus": NEED_BONUS}
    json.dump(out, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print(f"order: {', '.join(out['order'][:10])}...")
    for pk, ab, i, why in picks[:32]:
        b = board[i]
        print(f"{pk:>2}. {ab:<4} {b['name']} ({b['pos']}, {b['school']}, {b['cls']}) buzz {b['buzz']} prod {b['prod']} | {why}")


if __name__ == "__main__":
    main()
