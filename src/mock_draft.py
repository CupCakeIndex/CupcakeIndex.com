"""Mock draft: our two-round NFL mock for next spring, and the board the "Be the GM" game drafts from (docs/mock.js).

How it works (free data only: our NFL model and stats, ESPN college rosters and the public big boards below):
  1. Draft order: 10,000 simulations of the rest of the NFL season from our win chances. Teams that miss the playoffs
     pick 1-18 by projected wins (fewest first), then playoff teams 19-32. Ties are broken by our power rating.
     Who owns each pick (all 7 rounds, for Be the GM): ESPN's transactions feed (2024 on), every trade that moved a pick in
     this draft, replayed oldest first ("Traded X and a 2027 first-round pick to Dallas"), so a pick traded away
     shows up with its new team. Once the season is over and ESPN posts the real order (January), we use that instead:
     every pick, who owns it and where it came from. A new trade shows up the next morning (the job runs every day
     until the draft).
  2. Team needs: where each unit ranks in our play-by-play numbers (the same units as Trade watch), so a #30 pass
     defense needs a corner. QB is a need only with a weak passing game and no young first-round QB, or an old starter.
  3. Prospects: we don't grade them ourselves. The board is a consensus of three public big boards, averaged:
     Tankathon's (tankathon.com/nfl/big_board, ~600 players), DraftTek's (drafttek.com, 600) and ESPN draft analyst
     Jordan Reid's top 50 (ESPN's draft API). A player on only one of the two long boards counts 25 spots worse on the
     other; one missing from Reid's top 50 counts as #51 there (or his average, if that's lower). Every position is
     there, linemen included. Players are matched to ESPN's college rosters (for links, logos and class) by name and school.
  4. Picks: each team takes the best player left by the consensus (score = -2 x ln(consensus rank)) plus a need bonus
     (+0.9 its biggest need, +0.5 second, +0.25 third, about a 1.6x / 1.3x / 1.1x jump in rank);
     a team with its QB (no QB need) takes one only if he's far and away the best left (-3).

Writes docs/data/nfl/mock_draft.json, and docs/data/nfl/mock_pool.json: every other draft-eligible player, so Be the GM
can search for anyone (loaded only when you search). Usage: python src/mock_draft.py [--no-news] (--no-news skips the
ESPN transactions, for testing)
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
# which team unit each position fixes (the same units as Trade watch)
NEED_OF = {"QB": "QB", "WR": "WR", "TE": "WR", "RB": "RB", "OT": "OL", "OL": "OL", "IOL": "OL", "EDGE": "RUSH", "DL": "RUSH",
           "LB": "RUND", "CB": "COV", "S": "COV", "DB": "COV"}
NEED_TXT = {"QB": "passing offense", "WR": "passing offense", "RB": "run game", "OL": "pass protection", "RUSH": "pass rush",
            "RUND": "run defense", "COV": "pass defense"}
NEED_BONUS = [0.9, 0.5, 0.25]

# the boards' position labels -> ours (DraftTek splits the D-line by technique and the O-line by spot)
SRC_POS = {"OT/IOL": "OT", "S/CB": "S", "LB/EDGE": "LB", "OG": "IOL", "OC": "IOL", "C": "IOL", "G": "IOL", "DL1T": "DL", "DL3T": "DL",
           "DL5T": "DL", "DT": "DL", "NT": "DL", "DE": "EDGE", "ILB": "LB", "OLB": "LB", "MLB": "LB", "WRS": "WR", "CBN": "CB",
           "SAF": "S", "FS": "S", "SS": "S"}
BROWSER = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}


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


def fetch(url):
    for _ in range(3):
        try:
            r = requests.get(url, headers=BROWSER, timeout=30)
            if r.ok:
                r.encoding = "utf-8"
                return r
        except requests.RequestException:
            pass
        time.sleep(2)
    return None


def tankathon(year):
    """[(name, position, school)] in Tankathon's big board order, if it's for this draft."""
    r = fetch("https://www.tankathon.com/nfl/big_board")
    if not r or f"{year} NFL Draft" not in r.text:
        return []
    rows = re.findall(r'class="mock-row-name">([^<]+)</div><div class="mock-row-school-position">([^<|]+)\|([^<]+)<', r.text)
    return [(html.unescape(n).strip(), p.strip(), html.unescape(c).strip()) for n, p, c in rows]


def drafttek(year):
    """[(name, position, school, class)] in DraftTek's big board order (4 pages of 150)."""
    out = []
    for page in range(1, 6):
        r = fetch(f"https://www.drafttek.com/{year}-NFL-Draft-Big-Board/Top-NFL-Draft-Prospects-{year}-Page-{page}.asp")
        rows = re.findall(r'<tr data-rank="(\d+)" data-school="([^"]*)" data-pos="([^"]*)">.*?data-label="Prospect">([^<]+)<.*?data-label="Cls">([^<]*)<',
                          r.text, re.S) if r else []
        if not rows:
            break
        out += [(int(k), html.unescape(n).strip(), ps, html.unescape(c), cl.strip()) for k, c, ps, n, cl in rows]
        time.sleep(0.5)
    return [x[1:] for x in sorted(out)]


def espn_board(year):
    """[(rank, name, position, school id, college player id)] from ESPN's draft prospects (Jordan Reid's board)."""
    out, page = [], 1
    while True:
        r = fetch(f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{year}/draft/athletes?limit=100&page={page}")
        if not r:
            break
        d = r.json()
        for it in d.get("items", []):
            a = fetch(it["$ref"].replace("http://", "https://"))
            if not a:
                continue
            a = a.json()
            rk = next((x["value"] for x in a.get("attributes", []) if x.get("name") == "overall"), 0)
            pid = next((m.group(1) for l in a.get("links", []) for m in [re.search(r"/id/(\d+)", l.get("href", ""))] if m), None)
            sid = re.search(r"colleges/(\d+)", (a.get("college") or {}).get("$ref", ""))
            if rk:
                out.append((int(rk), a.get("displayName", ""), (a.get("position") or {}).get("abbreviation", ""), sid.group(1) if sid else "", pid))
        if page >= d.get("pageCount", 1):
            break
        page += 1
    return sorted(out)


def sch_key(name):
    """'Miami (FL)' / 'Miami' -> 'miami'; 'Mississippi St.' -> 'mississippist'"""
    n = re.sub(r"\(.*?\)", "", name.lower()).replace("state", "st").replace("&", "")
    return re.sub(r"[^a-z]", "", n)


TX_VERBS = r"Acquired|Traded|Received|Signed|Released|Waived|Placed|Activated|Claimed|Re-signed|Agreed|Reinstated|Promoted|Elevated|Designated|Exercised|Terminated|Suspended|Restructured|Recalled|Converted|Announced"
ROUNDS = {"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3, "fourth": 4, "4th": 4, "fifth": 5, "5th": 5,
          "sixth": 6, "6th": 6, "seventh": 7, "7th": 7}
NROUNDS = 7
# conditions ESPN's wording leaves out: (from, to, round) -> which of the giver's picks moves
# Jets/Cowboys, Nov 4 2025 (Quinnen Williams): the Jets get the earlier of Dallas's own first and the one from Green Bay
CONDITIONS = {("DAL", "NYJ", 1): "earlier"}


def pick_trades(year, alias, by_id):
    """[(date, round, from abbr, to abbr)] for every pick of `year` that changed hands, from
    ESPN's NFL transactions (each trade is listed by both teams; kept once)."""
    team_rx = sorted(alias, key=len, reverse=True)
    def team_in(text):
        for nm in team_rx:
            if re.search(rf"\b{re.escape(nm)}\b", text):
                return alias[nm]
        return None
    def rounds_in(part):
        out = []
        for m in re.finditer(rf"{year}\s+((?:(?:first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|[4-7]th)(?:-round)?[,\s]*(?:and\s+)?)+)", part):
            out += [ROUNDS[w] for w in re.findall(r"first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|[4-7]th", m.group(1))]
        return out
    seen, out = [], []
    for season in range(year - 3, year):
        page, pages = 1, 1
        while page <= pages:
            try:
                r = requests.get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/transactions",
                                 params={"season": season, "limit": 1000, "page": page}, timeout=30).json()
            except (requests.RequestException, ValueError):
                break
            pages = r.get("pageCount", 1)
            page += 1
            for t in r.get("transactions", []):
                me, day = by_id.get(str(t.get("team", {}).get("id"))), t["date"][:10]  # ESPN's abbreviations differ (LAR vs LA)
                for sent in re.split(rf"\.\s+(?=(?:{TX_VERBS})\b)", t.get("description", "")):
                    if str(year) not in sent or not re.search(r"\b(first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|[4-7]th)\b", sent):
                        continue
                    # Traded <give> to Y (in exchange) for <get> | Acquired <get> from Y (in exchange) for <give> | Received <get> from (a trade with) Y
                    m = re.match(r"Traded\s+(.*?)\s+to\s+(.*?)\s+(?:in exchange\s+)?for\s+(.*)", sent) or re.match(r"Traded\s+(.*?)\s+to\s+(.*)()", sent)
                    if m:
                        give, other, get = m.group(1), m.group(2), m.group(3)
                    else:
                        m = re.match(r"(?:Acquired|Received)\s+(.*?)\s+from\s+(?:a trade with\s+)?(.*?)(?:\s+(?:in exchange\s+)?for\s+(.*)|$)", sent)
                        if not m:
                            continue
                        get, other, give = m.group(1), m.group(2), m.group(3) or ""
                    y = team_in(other)
                    if not y or not me or y == me:
                        continue
                    for rnd in rounds_in(give):
                        out.append((day, rnd, me, y))
                    for rnd in rounds_in(get):
                        out.append((day, rnd, y, me))
            time.sleep(0.2)
    kept = []
    for d, rnd, a, b in sorted(out):
        dd = dt.date.fromisoformat(d)
        if any(x[1:] == (rnd, a, b) and abs((dt.date.fromisoformat(x[0]) - dd).days) <= 10 for x in kept):
            continue  # the other team's entry for the same trade
        kept.append((d, rnd, a, b))
    return kept


def espn_order(year, by_id):
    """[[owner, original team, round]] for every pick from ESPN's draft page once the real order is out, else None."""
    try:
        r = requests.get("https://site.api.espn.com/apis/site/v2/sports/football/nfl/draft", params={"season": year}, timeout=30).json()
    except (requests.RequestException, ValueError):
        return None
    ab_of = {str(t.get("id")): by_id.get(str(t.get("id"))) for t in r.get("teams", [])}
    espn_ab = {str(t.get("abbreviation", "")).upper(): by_id.get(str(t.get("id"))) for t in r.get("teams", [])}
    picks = sorted((p for p in r.get("picks", []) if 1 <= (p.get("round") or 0) <= NROUNDS), key=lambda p: p.get("overall", 999))
    if len(picks) < 64 or not all(ab_of.get(str(p.get("teamId"))) for p in picks):
        return None
    out = []
    for p in picks:
        own = ab_of[str(p["teamId"])]
        m = re.search(r"From\s+([A-Z]{2,3})", p.get("tradeNote") or "")
        out.append([own, espn_ab.get(m.group(1), m.group(1)) if m else own, p["round"]])
    return out


def owners(order, trades):
    """[[owner, original team, round]] for all 7 rounds (no compensatory picks until the real order is out): each team's
    own pick at its spot, then the trades replayed in order."""
    slot = {(r, ab): (r - 1) * 32 + i for r in range(1, NROUNDS + 1) for i, ab in enumerate(order)}
    own = {k: k[1] for k in slot}
    for d, rnd, a, b in trades:
        mine = sorted((k for k, o in own.items() if k[0] == rnd and o == a), key=lambda k: slot[k])
        if not mine:
            print(f"  ! {d}: {a} traded a round-{rnd} pick it doesn't own; skipped")
            continue
        cond = CONDITIONS.get((a, b, rnd))
        k = mine[0] if cond == "earlier" else mine[-1] if cond == "later" else ((rnd, a) if (rnd, a) in mine else mine[0])
        own[k] = b
    out = [None] * len(slot)
    for k, n in slot.items():
        out[n] = [own[k], k[1], k[0]]
    return out


def norm(name):
    """'Kenyatta Jackson Jr.' -> 'kenyatta jackson' (what a headline will match)."""
    n = re.sub(r"[.'’]", "", name.lower())
    n = re.sub(r"\s+(jr|sr|ii|iii|iv|v)$", "", n.strip())
    return re.sub(r"[^a-z\s-]", "", n).strip()


def main():
    viz = json.load(open(os.path.join(DOCS, "viz", "index.json")))
    season, cfb_season = max(viz["nfl"]), max(viz["cfb"])
    year = season + 1
    if dt.date.today() > dt.date(year, 5, 5):
        print(f"The {year} draft is done; keeping the last mock until next season starts.")
        return
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
    alias = {}
    for k, v in V["teams"].items():
        full, ab = v[0], v[1]
        mascot, loc = full.split()[-1], " ".join(full.split()[:-1])
        alias[full] = alias[mascot] = ab
        if loc in ("New York", "Los Angeles"):
            alias[f"{'NY' if loc == 'New York' else 'LA'} {mascot}"] = ab
        else:
            alias[loc] = ab
    by_id = {k.split(":")[1]: v[1] for k, v in V["teams"].items()}
    trades = [] if "--no-news" in sys.argv else pick_trades(year, alias, by_id)
    real = espn_order(year, by_id)
    slots = real or owners([abbr[by_name[n]] for n in order], trades)
    if real:  # the real order: round 1's original teams, in order
        ab_name = {abbr[by_name[n]]: n for n in order}
        order = [ab_name[o] for _, o in real[:32] if o in ab_name]
        print("Using ESPN's real draft order")
    print(f"{len(trades)} pick trades: " + ", ".join(f"R{r} {a}->{b}" for _, r, a, b in trades))

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

    # 3. prospects: the consensus of the public big boards
    cfb_teams = json.load(open(os.path.join(DOCS, "teams.json"), encoding="utf-8"))["cfb"]
    school = {str(t["id"]): t for t in cfb_teams}
    sid_of = {sch_key(t["name"]): str(t["id"]) for t in cfb_teams}
    R = rosters(cfb_teams, cfb_season)
    T, K, E = tankathon(year), drafttek(year), espn_board(year)
    print(f"boards: Tankathon {len(T)}, DraftTek {len(K)}, ESPN {len(E)}")
    if len(T) < 200 and len(K) < 200:
        raise SystemExit("Neither long big board came back; keeping the last mock.")
    by_norm = defaultdict(list)
    for pid, (nm, pos, cls, sid) in R.items():
        by_norm[norm(nm)].append(pid)
    P = {}  # norm name -> what we know
    for src, rows in ((0, T), (1, K)):
        for k, row in enumerate(rows):
            nm, ps, sch = row[:3]
            e = P.setdefault(norm(nm), {"name": nm, "pos": SRC_POS.get(ps, ps), "school": sch, "ranks": [None, None, None], "cls": ""})
            if e["ranks"][src] is None:
                e["ranks"][src] = k + 1
            if src == 1:
                e["cls"] = e["cls"] or re.sub(r"^R", "", row[3]).replace("RS", "")
    for rk, nm, ps, sid, pid in E:
        e = P.setdefault(norm(nm), {"name": nm, "pos": SRC_POS.get(ps, ps), "school": school.get(sid, {}).get("name", ""), "ranks": [None, None, None], "cls": ""})
        e["ranks"][2], e["espn"] = rk, (sid, pid)
    board, used = [], set()
    for key, e in P.items():
        t, d, r = e["ranks"]
        if t is None and d is None:
            continue  # only on Reid's top 50 would be odd; skip
        t, d = (t if t is not None else d + 25), (d if d is not None else t + 25)
        base = (t + d) / 2
        cons = (t + d + (r if r is not None else max(51, base))) / 3
        sid = (e.get("espn") or ("", ""))[0] or sid_of.get(sch_key(e["school"]), "")
        pid = (e.get("espn") or ("", None))[1]
        if not pid or pid not in R:  # match to the college roster by name + school
            cands = [x for x in by_norm.get(key, []) if sch_key(school.get(R[x][3], {}).get("name", "~")) == sch_key(e["school"]) or R[x][3] == sid]
            pid = cands[0] if len(cands) == 1 else None
        if pid in used:
            pid = None
        if pid:
            used.add(pid)
            sid = R[pid][3]
        cls = (R[pid][2] if pid else "") or e["cls"]
        board.append({"id": pid, "name": e["name"], "pos": e["pos"], "sid": sid, "school": school[sid]["name"] if sid in school else e["school"],
                      "cls": cls, "src": e["ranks"], "cons": round(cons, 1), "score": round(-2 * math.log(cons), 3)})
    board.sort(key=lambda b: b["cons"])
    board = board[:400]
    print(f"matched to ESPN rosters: {sum(1 for b in board if b['id'])} of {len(board)}")
    on_board = {b["id"] for b in board if b["id"]}
    pool = []
    for pid, (nm, pos, cls, sid) in R.items():
        if pos in ("PK", "K", "P", "LS", "") or sid not in school or pid in on_board or cls not in ("SO", "JR", "SR", "GR"):
            continue
        p4 = school[sid]["group"] in P4 or school[sid]["name"] == "Notre Dame"
        pool.append([pid, nm, POS.get(pos, pos), sid, school[sid]["name"], cls, (0 if p4 else 1, cls != "SR", nm)])
    pool = [x[:6] for x in sorted(pool, key=lambda x: x[6])]

    # 4. picks: two rounds in the same order
    before = {ab: list(v) for ab, v in needs.items()}  # what the page shows and Be the GM starts from
    left = list(range(len(board)))
    picks = []
    first_two = [x for x in slots if x[2] <= 2]
    for rnd in (1, 2):
        for slot, n in enumerate(order):
            ab, orig, _ = first_two[(rnd - 1) * 32 + slot]
            nd = [u for u, _ in needs[ab]]
            def fit(i):
                u = NEED_OF.get(board[i]["pos"])
                return board[i]["score"] + (NEED_BONUS[nd.index(u)] if u in nd else 0) - (3.0 if u == "QB" and "QB" not in nd else 0)
            best = max(left, key=fit)
            left.remove(best)
            u = NEED_OF.get(board[best]["pos"])
            mine = [r for x, r in needs[ab] if x == u]
            why = f"#{best + 1} on the consensus board" + (f"; their {NEED_TXT[u]} ranks #{mine[0]} of 32" if mine else "; best player left")
            picks.append([(rnd - 1) * 32 + slot + 1, ab, best, why, orig])
            # a team that just took a QB doesn't need another
            if u == "QB":
                needs[ab] = [x for x in needs[ab] if x[0] != "QB"] or needs[ab]

    team_out = {abbr[by_name[n]]: {"name": n, "record": rec[n], "wins": round(proj[n][0], 1), "playoff": round(proj[n][1], 2),
                                   "needs": [[u, r, NEED_TXT[u]] for u, r in before[abbr[by_name[n]]]], "id": by_name[n].split(":")[1]}
                for n in order}
    out = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "season": season, "year": year, "sims": SIMS,
           "sources": [["Tankathon", "https://www.tankathon.com/nfl/big_board", len(T)], ["DraftTek", f"https://www.drafttek.com/{year}-NFL-Draft-Big-Board/Top-NFL-Draft-Prospects-{year}-Page-1.asp", len(K)],
                       ["ESPN (Jordan Reid)", "https://www.espn.com/nfl/draft/bestavailable", len(E)]], "order": [abbr[by_name[n]] for n in order], "slots": slots, "real_order": bool(real),
           "trades": [[d, r, a, b] for d, r, a, b in trades], "teams": team_out, "board": board, "picks": picks,
           "need_of": NEED_OF, "need_bonus": NEED_BONUS}
    json.dump(out, open(OUT, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    json.dump({"updated": out["updated"], "cols": ["id", "name", "pos", "sid", "school", "cls"], "players": pool},
              open(os.path.join(DOCS, "nfl", "mock_pool.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print(f"{len(pool)} more eligible players in mock_pool.json")
    print(f"order: {', '.join(out['order'][:10])}...")
    for pk, ab, i, why, orig in picks[:32]:
        b = board[i]
        print(f"{pk:>2}. {ab:<4} {b['name']} ({b['pos']}, {b['school']}, {b['cls']}) boards {b['src']} | {why}")


if __name__ == "__main__":
    main()
