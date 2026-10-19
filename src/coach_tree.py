"""Coaching trees and coach photos for the coach pages: docs/data/coach_tree.json.

Who worked under whom comes from each head coach's Wikipedia page (its infobox lists every job: team, years, role).
An assistant job at a team in a season links him to that team's head coach that season, from our own head coach
lists (docs/data/coaches.json: NFL since 1999, college since 1980; plus data/history/cfb_coaches_old.json, the
college coaches 1980-2004 from CollegeFootballData). So a tree shows head coaches only: the ones a coach worked under, and his assistants who went
on to be head coaches. Jobs before those years, or at schools outside FBS, have no head coach to link to.

Pages are cached in data/history/wiki_coaches.json (parsed jobs only) and re-read once a month.
Photos: current head coaches get the team's own staff photo (NFL team site, or the school's site); everyone else gets
ESPN's headshot, otherwise the Wikipedia page's photo, otherwise a staff photo if he's on an NFL staff now. Credited on the page.

    python src/coach_tree.py
"""
import base64
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
from html import unescape
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
OUT = ROOT / "docs" / "data" / "coach_tree.json"
CACHE = ROOT / "data" / "history" / "wiki_coaches.json"
OLD_CFB = ROOT / "data" / "history" / "cfb_coaches_old.json"
API = "https://en.wikipedia.org/w/api.php"
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com; coaching trees)"}
STALE_DAYS = 30
CITY = {"ARI": ["Arizona", "Phoenix", "St. Louis"], "ATL": ["Atlanta"], "BAL": ["Baltimore"], "BUF": ["Buffalo"], "CAR": ["Carolina"],
        "CHI": ["Chicago"], "CIN": ["Cincinnati"], "CLE": ["Cleveland"], "DAL": ["Dallas"], "DEN": ["Denver"], "DET": ["Detroit"],
        "GB": ["Green Bay"], "HOU": ["Houston"], "IND": ["Indianapolis", "Baltimore"], "JAX": ["Jacksonville"], "KC": ["Kansas City"],
        "LV": ["Las Vegas", "Oakland", "Los Angeles"], "LAC": ["Los Angeles", "San Diego"], "LA": ["Los Angeles", "St. Louis"],
        "MIA": ["Miami"], "MIN": ["Minnesota"], "NE": ["New England", "Boston"], "NO": ["New Orleans"], "NYG": ["New York"],
        "NYJ": ["New York"], "PHI": ["Philadelphia"], "PIT": ["Pittsburgh"], "SF": ["San Francisco"], "SEA": ["Seattle"],
        "TB": ["Tampa Bay"], "TEN": ["Tennessee", "Houston"], "WAS": ["Washington"]}
NICK = {"ARI": ["Cardinals"], "ATL": ["Falcons"], "BAL": ["Ravens"], "BUF": ["Bills"], "CAR": ["Panthers"], "CHI": ["Bears"],
        "CIN": ["Bengals"], "CLE": ["Browns"], "DAL": ["Cowboys"], "DEN": ["Broncos"], "DET": ["Lions"], "GB": ["Packers"],
        "HOU": ["Texans"], "IND": ["Colts"], "JAX": ["Jaguars"], "KC": ["Chiefs"], "LV": ["Raiders"], "LAC": ["Chargers"],
        "LA": ["Rams"], "MIA": ["Dolphins"], "MIN": ["Vikings"], "NE": ["Patriots"], "NO": ["Saints"], "NYG": ["Giants"],
        "NYJ": ["Jets"], "PHI": ["Eagles"], "PIT": ["Steelers"], "SF": ["49ers"], "SEA": ["Seahawks"], "TB": ["Buccaneers"],
        "TEN": ["Titans", "Oilers"], "WAS": ["Redskins", "Commanders", "Football Team"]}
NFL_FULL = {f"{c} {n}": ab for ab in CITY for c in CITY[ab] for n in NICK[ab]}  # "Oakland Raiders" -> LV
ROLE = {"GA": "Graduate assistant", "DC": "Defensive coordinator", "OC": "Offensive coordinator", "AHC": "Assistant head coach",
        "ST": "Special teams", "STC": "Special teams coordinator", "QB": "Quarterbacks", "RB": "Running backs", "WR": "Wide receivers",
        "TE": "Tight ends", "OL": "Offensive line", "DL": "Defensive line", "LB": "Linebackers", "DB": "Defensive backs",
        "CB": "Cornerbacks", "S": "Safeties", "SA": "Student assistant", "RC": "Recruiting coordinator", "co-DC": "Co-defensive coordinator",
        "co-OC": "Co-offensive coordinator", "ILB": "Inside linebackers", "OLB": "Outside linebackers", "DE": "Defensive ends", "DT": "Defensive tackles"}


# Titles won as a head coach before our game data starts (NFL 1999, college 2006): Super Bowls I-XXXIII and
# national titles through 2005 (both teams in a split year; before 1980 only for coaches who show up in the trees). Later titles come from our own data (coaches.json "tiy").
TITLES_BEFORE = {
    "nfl": {"Vince Lombardi": [1966, 1967], "Weeb Ewbank": [1968], "Hank Stram": [1969], "Don McCafferty": [1970],
            "Tom Landry": [1971, 1977], "Don Shula": [1972, 1973], "Chuck Noll": [1974, 1975, 1978, 1979], "John Madden": [1976],
            "Tom Flores": [1980, 1983], "Bill Walsh": [1981, 1984, 1988], "Joe Gibbs": [1982, 1987, 1991], "Mike Ditka": [1985],
            "Bill Parcells": [1986, 1990], "George Seifert": [1989, 1994], "Jimmy Johnson": [1992, 1993], "Barry Switzer": [1995],
            "Mike Holmgren": [1996], "Mike Shanahan": [1997, 1998]},
    "cfb": {"Bear Bryant": [1961, 1964, 1965, 1973, 1978, 1979], "Johnny Majors": [1976], "Vince Dooley": [1980], "Danny Ford": [1981], "Joe Paterno": [1982, 1986], "Howard Schnellenberger": [1983],
            "LaVell Edwards": [1984], "Barry Switzer": [1974, 1975, 1985], "Jimmy Johnson": [1987], "Lou Holtz": [1988],
            "Dennis Erickson": [1989, 1991], "Bill McCartney": [1990], "Bobby Ross": [1990], "Don James": [1991],
            "Gene Stallings": [1992], "Bobby Bowden": [1993, 1999], "Tom Osborne": [1994, 1995, 1997], "Steve Spurrier": [1996],
            "Lloyd Carr": [1997], "Phillip Fulmer": [1998], "Bob Stoops": [2000], "Larry Coker": [2001], "Jim Tressel": [2002],
            "Nick Saban": [2003], "Pete Carroll": [2003, 2004], "Mack Brown": [2005]},
}


# a "(KY)" after a school is its state, not a role (GA and DE are left out: graduate assistant, defensive ends)
STATES = set("AL AK AZ AR CA CO CT FL HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OR PA RI SC SD "
             "TN TX UT VT VA WA WV WI WY".split())


def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]", "", s.replace("–", " ").replace("-", " ")).strip()


def api(**kw):
    url = API + "?" + urllib.parse.urlencode({"format": "json", "formatversion": 2, **kw})
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 * (i + 1))
    return {}


# ------------------------------------------------------------------ teams: Wikipedia link -> our team

def team_maps():
    teams = json.loads((ROOT / "docs" / "data" / "teams.json").read_text(encoding="utf-8"))
    full, by_mascot = {}, defaultdict(list)
    for t in teams["cfb"]:
        full[norm(f"{t['name']} {t.get('mascot') or ''}")] = t["name"]
        full[norm(t["name"])] = t["name"]
        by_mascot[norm(t.get("mascot") or "")].append(t["name"])
    return full, by_mascot


def to_team(target, maps):
    """('nfl', 'WAS') / ('cfb', 'Georgia') / None from a link target like 'Georgia Bulldogs football' or 'Washington Redskins'."""
    full, by_mascot = maps
    t = target.strip()
    if t.lower().endswith(" football"):
        base = norm(t[:-9])
        if base in full:
            return "cfb", full[base]
        for k in sorted(full, key=len, reverse=True):  # "Miami Hurricanes" -> "Miami"
            if base.startswith(k + " ") and len(k) > 3:
                rest = base[len(k) + 1:]
                if any(norm(rest) == m for m in by_mascot):
                    return "cfb", full[k]
        for m, schools in by_mascot.items():  # "Louisiana-Monroe Warhawks" -> UL Monroe (only one FBS school is the Warhawks)
            if m and len(schools) == 1 and base.endswith(" " + m) and any(w in base.split() for w in norm(schools[0]).split() if len(w) > 3):
                return "cfb", schools[0]
        return None
    t = re.sub(r"\s*\(.*\)$", "", t)  # "Houston Oilers (1960-1996)" style link targets
    return ("nfl", NFL_FULL[t]) if t in NFL_FULL else None


# ------------------------------------------------------------------ parsing a coach's jobs from his infobox

def years_of(s, now):
    s = re.sub(r"\{\{\s*(?:nfly|nfl year|nfl season)\s*\|\s*(\d{4})\s*\|\s*(\d{2,4})\s*\}\}",
               lambda m: f"{m.group(1)}–{m.group(2) if len(m.group(2)) == 4 else m.group(1)[:2] + m.group(2)}", s, flags=re.I)
    s = re.sub(r"\{\{\s*(?:nfly|nfl year|nfl season)\s*\|\s*(\d{4})\s*\}\}", r"\1", s, flags=re.I)
    m = re.search(r"(\d{4})\s*(?:[–—-]|&ndash;)\s*(\d{4}|present)", s)
    if m:
        return int(m.group(1)), now if m.group(2) == "present" else int(m.group(2))
    m = re.search(r"\b(19\d\d|20\d\d)\b", s)
    return (int(m.group(1)), int(m.group(1))) if m else None


def links(s):
    """[(target, display)] for [[target|display]] links in s."""
    return [(m.group(1).strip(), (m.group(2) or m.group(1)).strip()) for m in re.finditer(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]", s)]


def plain(s):
    s = re.sub(r"\[\[(?:[^\]|]+\|)?([^\]]+)\]\]", r"\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s.replace("'''", "").replace("''", "")).strip()


def role_text(r):
    parts = [p.strip() for p in re.split(r"[/,]", r) if p.strip()]
    return " / ".join(ROLE.get(p, ROLE.get(p.upper(), p)) for p in parts)


def field(wt, name):
    """The raw value of an infobox field (up to the next top-level | field)."""
    m = re.search(r"\n\s*\|\s*" + re.escape(name) + r"\s*=(.*?)(?=\n\s*\|\s*[A-Za-z_]+\d*\s*=|\n\}\})", wt, re.S)
    return m.group(1) if m else ""


def parse_jobs(wt, maps, now):
    """[[lg, team, y1, y2, role, head]] for every job we can place (FBS college or NFL)."""
    jobs, seen = [], {}  # seen: display text -> link target, for later lines that name the team without a link

    def place(text):
        for tgt, disp in links(text):
            seen[norm(disp)] = tgt
            tm = to_team(tgt, maps)
            if tm:
                return tm
        head = plain(re.split(r"\(", text)[0])
        tgt = seen.get(norm(head))
        return to_team(tgt, maps) if tgt else None

    if re.search(r"\|\s*coach_team\d+\s*=", wt, re.I):  # {{Infobox college coach}}: coach_yearsN / coach_teamN = Team (ROLE)
        for i in range(1, 60):
            team, yrs = field(wt, f"coach_team{i}"), field(wt, f"coach_years{i}")
            if not team:
                continue
            y = years_of(yrs, now)
            tm = place(team)
            roles = re.findall(r"\(([^()]*)\)", plain(team))
            roles = [r for r in roles if r.strip() not in STATES]  # "Hart County HS (KY)": a state, not a role
            role = roles[-1].strip() if roles else ""
            head = not role or bool(re.search(r"\b(HC|head coach)\b", role, re.I)) and not re.search(r"assistant|associate|AHC|interim", role, re.I)  # interim: a game or two, not a mentor
            if tm and y:
                jobs.append([tm[0], tm[1], y[0], y[1], "Head coach" if head else role_text(plain(role)), head])
        return jobs
    raw = field(wt, "pastcoaching") or field(wt, "coaching")
    raw = re.sub(r"\{\{\s*ubl\s*\|", "", raw, flags=re.I)
    cur = None
    for line in raw.splitlines():
        line = line.strip().rstrip("}")
        if not line.startswith("*"):
            continue
        depth = len(line) - len(line.lstrip("*"))
        body = line.lstrip("*").strip()
        if depth == 1:
            parts = re.split(r"<br\s*/?>", body, maxsplit=1)
            tm, y = place(parts[0]), years_of(parts[0], now)
            role = plain(parts[1]) if len(parts) > 1 else ""
            cur = (tm, y)
            if tm and y and role:
                head = bool(re.search(r"\bhead coach\b", role, re.I)) and not re.search(r"assistant|associate|interim", role, re.I)
                jobs.append([tm[0], tm[1], y[0], y[1], role, head])
        elif cur and cur[0]:
            y = years_of(body, now) or cur[1]
            role = plain(re.sub(r"\([^)]*\d{4}[^)]*\)|\{\{[^}]*\}\}", "", body))
            if y and role:
                head = bool(re.search(r"\bhead coach\b", role, re.I)) and not re.search(r"assistant|associate|interim", role, re.I)
                jobs.append([cur[0][0], cur[0][1], y[0], y[1], role, head])
    return jobs


# ------------------------------------------------------------------ fetching pages (cached)

def is_coach_page(wt):
    return bool(re.search(r"\{\{\s*Infobox (college coach|gridiron football biography|NFL biography|American football biography|NFL coach)", wt, re.I))


def fetch(titles):
    """{asked title: (page title, wikitext, photo url)} for up to 50 titles."""
    d = api(action="query", prop="revisions|pageimages", rvprop="content", rvslots="main", piprop="thumbnail",
            pithumbsize=240, redirects=1, titles="|".join(titles))
    q = d.get("query", {})
    back = {}
    for r in q.get("normalized", []) + q.get("redirects", []):
        back[r["to"]] = back.get(r["from"], r["from"])
    out = {}
    for p in q.get("pages", []):
        wt = (p.get("revisions") or [{}])[0].get("slots", {}).get("main", {}).get("content", "")
        asked = p["title"]
        while asked in back:
            asked = back[asked]
        out[asked] = (p["title"], wt, (p.get("thumbnail") or {}).get("source", ""))
    return out


def search(name):
    d = api(action="query", list="search", srsearch=f'"{name}" football coach', srlimit=3)
    return [r["title"] for r in d.get("query", {}).get("search", [])]


def resolve(names, known, maps, now, cache):
    """Fill cache[name] = {title, img, jobs, t} for names not cached in the last STALE_DAYS days."""
    today = time.time()
    todo = [n for n in names if n not in cache or today - cache[n].get("t", 0) > STALE_DAYS * 86400]
    print(f"  wikipedia: {len(todo)} of {len(names)} coaches to read")

    def good(name, wt):
        if not is_coach_page(wt):
            return None
        jobs = parse_jobs(wt, maps, now)
        mine = known.get(name, set())
        cur = to_team(re.sub(r"[\[\]]", "", field(wt, "current_team").split("|")[0]).strip(), maps) if field(wt, "current_team") else None
        return jobs if not mine or cur in mine or any((j[0], j[1]) in mine for j in jobs) else None

    for suffix in ("", " (American football)", " (American football coach)", " (football coach)", " (coach)"):
        if not todo:
            break
        left = []
        for i in range(0, len(todo), 50):
            batch = todo[i:i + 50]
            got = fetch([n + suffix for n in batch])
            for n in batch:
                title, wt, img = got.get(n + suffix, ("", "", ""))
                jobs = good(n, wt) if wt else None
                if jobs is not None:
                    cache[n] = {"title": title, "img": img, "jobs": jobs, "t": today}
                else:
                    left.append(n)
            time.sleep(0.5)
        todo = left
    for n in todo[:150]:  # last resort: search, and take the first result that's this coach
        for title in search(n):
            got = fetch([title])
            _, wt, img = got.get(title, ("", "", ""))
            jobs = good(n, wt) if wt else None
            if jobs is not None and norm(n).split()[-1] in norm(title):
                cache[n] = {"title": title, "img": img, "jobs": jobs, "t": today}
                break
        else:
            cache[n] = {"title": "", "img": "", "jobs": [], "t": today}  # not found: try again next month
        time.sleep(0.3)


# ------------------------------------------------------------------ head coaches by team and season

INTERIM = 0.4  # coached under 40% of a team's games that season = an interim stint, not that season's head coach


def head_coaches(C):
    """{(lg, team, season): head coaches}. Interim stints (Darrell Bevell's 5 games for Detroit in 2020) don't count:
    a coach fired midseason and the one who finished the year both do, if each had 40%+ of the games."""
    games = defaultdict(dict)  # (lg, team, season) -> {coach: games}
    for lg in ("nfl", "cfb"):
        for c in (C.get(lg) or {}).get("coaches", []):
            for s in c.get("sea", []):
                games[(lg, s[1], s[0])][c["n"]] = sum(s[2:7])
    staff = ROOT / "data" / "history" / "cfb_coaches.json"
    for f in (staff, OLD_CFB):
        if f.exists():
            for team, years in json.loads(f.read_text(encoding="utf-8")).items():
                for y, people in years.items():
                    for name, n in people:
                        games[("cfb", team, int(y))].setdefault(name, n)
    hc = defaultdict(set)
    for k, by in games.items():
        total = sum(by.values())
        hc[k] = {n for n, g in by.items() if total == 0 or g >= INTERIM * total}
    return hc


def old_cfb():
    """College head coaches 1980-2004 from CollegeFootballData (once; needs CFBD_API_KEY)."""
    if OLD_CFB.exists() or not os.environ.get("CFBD_API_KEY"):
        return
    import fetch_data
    raw = fetch_data._get("/coaches", minYear=1980, maxYear=2004)
    g = lambda o, *ks: next((o[k] for k in ks if o.get(k) is not None), None)
    out = defaultdict(lambda: defaultdict(list))
    for c in raw:
        name = f"{g(c, 'firstName', 'first_name') or ''} {g(c, 'lastName', 'last_name') or ''}".strip()
        for s in g(c, "seasons") or []:
            if g(s, "school") and g(s, "year"):
                out[g(s, "school")][str(g(s, "year"))].append([name, int(g(s, "games") or 0)])
    OLD_CFB.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  college head coaches 1980-2004: {sum(len(v) for v in out.values())} school-seasons")


def espn_nfl():
    """{coach name: headshot url} for this season's NFL head coaches."""
    base = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"

    def get(u):
        try:
            with urllib.request.urlopen(urllib.request.Request(u.replace("http://", "https://"), headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as r:
                return json.load(r)
        except Exception:
            return {}

    yr = datetime.now().year if datetime.now().month >= 3 else datetime.now().year - 1

    def team(i):
        refs = get(f"{base}/seasons/{yr}/teams/{i}/coaches").get("items", [])
        c = get(refs[0]["$ref"]) if refs else {}
        return (f"{c.get('firstName', '')} {c.get('lastName', '')}".strip(), (c.get("headshot") or {}).get("href", "")) if c else None

    with ThreadPoolExecutor(8) as ex:
        return {n: h for n, h in filter(None, ex.map(team, list(range(1, 31)) + [33, 34])) if h}


# ------------------------------------------------------------------ backup photos: the teams' own sites
# When ESPN and Wikipedia have no photo (Liam Coen has neither), the team's official staff headshot.

NFL_SITES = ("azcardinals atlantafalcons baltimoreravens buffalobills panthers chicagobears bengals clevelandbrowns dallascowboys "
             "denverbroncos detroitlions packers houstontexans colts jaguars chiefs raiders chargers therams miamidolphins vikings "
             "patriots neworleanssaints giants newyorkjets philadelphiaeagles steelers 49ers seahawks buccaneers tennesseetitans "
             "commanders").split()


def page(url):
    for i in range(2):  # a busy site gets a second try
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            time.sleep(2)
    return ""


NFL_SITE_TEAM = dict(zip(NFL_SITES, "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LA MIA MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WAS".split()))


def nfl_sites():
    """{norm(name): (photo url, site, team, job title)} for every coach card on the 32 team sites, head coaches and assistants alike."""
    def one(d):
        h = page(f"https://www.{d}.com/team/coaches-roster/") or page(f"https://www.{d}.com/team/coaches/")
        out, jobs = {}, {}
        for card in h.split("d3-o-person-card")[1:]:
            img = re.search(r'https://static\.clubs\.nfl\.com/image/(upload|private)/[^"\s]*?/([a-z0-9_-]+)/([a-z0-9]+)\.(jpg|png)', card)
            t = re.search(r'__title">\s*(?:<a[^>]*>)?\s*([^<]+?)\s*<', card)
            role = re.search(r'__roofline">\s*([^<]+?)\s*<', card)
            if t:
                jobs[norm(unescape(t.group(1)))] = (NFL_SITE_TEAM[d], " ".join(unescape(role.group(1)).split()) if role else "")
            if img and t:  # square crop around the face from the same image server
                out[norm(unescape(t.group(1)))] = (f"https://static.clubs.nfl.com/image/{img.group(1)}/c_thumb,g_face,w_240,h_240/f_auto/{img.group(2)}/{img.group(3)}.{img.group(4)}", f"{d}.com")
        return out, jobs
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(one, NFL_SITES))
    return {k: v for r, _ in res for k, v in r.items()}, {k: v for _, j in res for k, v in j.items()}


def school_sites(teams):
    """{school: athletics site host} from Wikidata's official website for '<School> <Mascot> football' (or the athletics page)."""
    T = {t["name"]: t for t in json.loads((ROOT / "docs" / "data" / "teams.json").read_text(encoding="utf-8"))["cfb"]}
    ask = {}
    for s in teams:
        if s in T:
            ask[f"{s} {T[s].get('mascot') or ''} football".replace("  ", " ")] = s
            ask[f"{s} {T[s].get('mascot') or ''}".strip()] = s
    qid = {}
    titles = list(ask)
    for i in range(0, len(titles), 50):
        d = api(action="query", prop="pageprops", ppprop="wikibase_item", redirects=1, titles="|".join(titles[i:i + 50]))
        q = d.get("query", {})
        back = {r["to"]: r["from"] for r in q.get("normalized", []) + q.get("redirects", [])}
        for p in q.get("pages", []):
            asked = p["title"]
            while asked in back:
                asked = back[asked]
            if (p.get("pageprops") or {}).get("wikibase_item") and asked in ask:
                qid[asked] = p["pageprops"]["wikibase_item"]
    sites = {}
    ids = list(set(qid.values()))
    for i in range(0, len(ids), 50):
        url = "https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({"action": "wbgetentities", "ids": "|".join(ids[i:i + 50]), "props": "claims", "format": "json"})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                ents = json.load(r).get("entities", {})
        except Exception:
            continue
        for e, v in ents.items():
            for c in v.get("claims", {}).get("P856", []):
                u = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value", "")
                if u:
                    sites[e] = urllib.parse.urlparse(u).netloc.lower().removeprefix("www.")
                    if u.startswith("https"):
                        break
    out = {}
    for title in sorted(qid, key=lambda t: not t.endswith(" football")):  # the football page first
        if qid[title] in sites:
            out.setdefault(ask[title], sites[qid[title]])
    return out


def college_sites(coaches):
    """{coach name: (photo url, site)} for current college head coaches, from their bio on the school's site (SIDEARM sites:
    /sports/football/coaches links each bio, and the bio's share image is the staff headshot; WMT sites link it from the roster)."""
    hosts = school_sites({tm for _, tm in coaches})

    def one(c):
        n, tm = c
        host = hosts.get(tm)
        if not host:
            return None
        h = page(f"https://{host}/sports/football/coaches")
        bio = next((m.group(1) for m in re.finditer(r'''href=["'](/sports/football/roster/coaches/[^"']+)["'][^>]*>\s*(?:<[^>]+>\s*)*([^<]+)<''', h)
                    if norm(unescape(m.group(2))) == norm(n) or f"/coaches/{slug(n)}/" in m.group(1)), None)
        if not bio:  # the other big platform (WMT: Nebraska, Texas A&M...): the roster page links /roster/season/2026/staff/<name>
            h = page(f"https://{host}/sports/football/roster/")
            m = re.search(r'''href=["']((?:https://[^/"']+)?/sports/football/roster/(?:season/\d+/staff|coach)/%s/?)["']''' % re.escape(slug(n)), h)
            bio = m and urllib.parse.urlparse(m.group(1)).path
        b = page(f"https://{host}{bio}") if bio else ""
        img = re.search(r'''og:image["']\s+content=["']([^"']+)["']''', b)
        if not img or "/logos/" in img.group(1):
            return None
        u = unescape(img.group(1))
        if "/imgproxy/" in u:  # WMT: the original photo's address is the last part of the link, base64-encoded
            try:
                enc = u.rsplit("/", 1)[1].split(".")[0]
                src = base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4)).decode()
            except Exception:
                return None
            return (n, (src, host)) if src.startswith("https://") else None
        src = urllib.parse.parse_qs(urllib.parse.urlparse(u).query).get("url", [u])[0]  # images.sidearmdev.com/resize?url=...
        src = urllib.parse.urljoin(f"https://{host}/", src.split("?")[0])
        # resized, not cropped: these are tall portraits, and the page's circle keeps the top (its "smart" crop cut off heads)
        return n, ("https://images.sidearmdev.com/resize?" + urllib.parse.urlencode({"url": src, "width": 240, "type": "jpeg"}), host)
    with ThreadPoolExecutor(8) as ex:
        return dict(filter(None, ex.map(one, coaches)))


def main():
    C = json.loads((ROOT / "docs" / "data" / "coaches.json").read_text(encoding="utf-8"))
    now = datetime.now().year
    maps = team_maps()
    try:
        old_cfb()
    except SystemExit:
        pass
    hc = head_coaches(C)
    known = defaultdict(set)  # coach -> (lg, team) he was head coach of (to check we found the right Wikipedia page)
    for (lg, team, y), names in hc.items():
        for n in names:
            known[n].add((lg, team))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    names = sorted({c["n"] for lg in ("nfl", "cfb") for c in (C.get(lg) or {}).get("coaches", [])})
    resolve(names, known, maps, now, cache)
    # head coaching jobs from the pages themselves reach back before our lists (Belichick's Browns, Parcells' Giants)
    def add_heads():
        for n, w in cache.items():
            for lg, team, y1, y2, role, head in w.get("jobs", []):
                if head:
                    for y in range(y1, min(y2, now) + 1):
                        hc[(lg, team, y)].add(n)
    add_heads()

    # edges: an assistant job at a team in a season -> that season's head coach(es) there
    def edges_for(people):
        E = defaultdict(lambda: {"y": set(), "role": ""})
        for n in people:
            for lg, team, y1, y2, role, head in (cache.get(n) or {}).get("jobs", []):
                if head:
                    continue
                for y in range(y1, min(y2, now) + 1):
                    for m in hc.get((lg, team, y), ()):
                        if m != n:
                            e = E[(m, n, lg, team)]
                            e["y"].add(y)
                            e["role"] = role
        return E
    E = edges_for(names)
    # one more round: mentors we only know from the head coach lists (older college coaches) get their pages too
    extra = sorted({m for (m, _, _, _) in E if m not in cache})
    if extra:
        resolve(extra, known, maps, now, cache)
        add_heads()
        E = edges_for(sorted(set(names) | set(extra)))
    # a coaching tree is assistants who became head coaches later: drop jobs taken after 3+ seasons as a head coach
    # (Wade Phillips under McVay isn't McVay's tree; Saban, one year at Toledo, under Belichick is Belichick's)
    head_years = defaultdict(set)
    for (lg, team, y), ns in hc.items():
        for n in ns:
            head_years[n].add(y)
    E = {k: e for k, e in E.items() if k[1] in head_years and sum(y < min(e["y"]) for y in head_years[k[1]]) < 3}  # and he was a real head coach somewhere
    CACHE.write_text(json.dumps(cache, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    espn = espn_nfl()
    everyone = sorted(set(names) | {m for (m, _, _, _) in E} | {p for (_, p, _, _) in E})
    # the team's staff photo comes first for current head coaches (Terry's pick: newest, and the same look for everyone);
    # for anyone else only when ESPN and Wikipedia have none (a retired coach may share a name with someone on a staff now)
    nopic = {n for n in everyone if not espn.get(n) and not (cache.get(n) or {}).get("img")}
    now_job = {c["n"]: (lg, c["tm"]) for lg in ("nfl", "cfb") for c in (C.get(lg) or {}).get("coaches", []) if c.get("on")}
    won = {(lg, c["n"]): c["c"].get("tiy", []) for lg in ("nfl", "cfb") for c in (C.get(lg) or {}).get("coaches", []) if c.get("c")}
    nfl, staff = nfl_sites()
    site = {n: nfl[norm(n)] for n in everyone if norm(n) in nfl and (now_job.get(n, ("",))[0] == "nfl" or n in nopic)}
    site.update(college_sites([(n, tm) for n, (lg, tm) in now_job.items() if lg == "cfb" and n not in site]))
    # a team site that didn't answer this run: keep the staff photo we had last time
    prev = json.loads(OUT.read_text(encoding="utf-8")).get("people", {}) if OUT.exists() else {}
    for n in everyone:
        q = prev.get(slug(n)) or {}
        if n not in site and isinstance(q.get("cr"), str) and (n in now_job or n in nopic):
            site[n] = (q["img"], q["cr"])
    people = {}
    for n in everyone:
        w = cache.get(n) or {}
        p = {"n": n}
        if n in site:
            p["img"], p["cr"] = site[n]  # the team's own staff photo: credit the site
        elif espn.get(n) or w.get("img"):
            p["img"] = espn.get(n) or w["img"]
            if not espn.get(n):
                p["cr"] = 1  # photo from Wikipedia: credit it
        if n in now_job:
            p["job"] = list(now_job[n])  # head coach right now: [league, team] (for site search)
        elif norm(n) in staff and staff[norm(n)][1]:
            p["asst"] = ["nfl", *staff[norm(n)]]  # on an NFL staff now (not head coach): [league, team, job title]
        tr = {lg: sorted(set(TITLES_BEFORE[lg].get(n, [])) | set(won.get((lg, n), []))) for lg in ("nfl", "cfb")}
        if tr["nfl"] or tr["cfb"]:
            p["tr"] = {lg: ys for lg, ys in tr.items() if ys}  # titles as a head coach: {"cfb": [2003, 2009, ...]}
        if w.get("title"):
            p["w"] = w["title"]
        people[slug(n)] = p
    edges = sorted([[slug(m), slug(p), lg, team, min(e["y"]), max(e["y"]), e["role"]] for (m, p, lg, team), e in E.items()],
                   key=lambda e: (e[0], e[4]))
    found = sum(1 for n in names if (cache.get(n) or {}).get("title"))
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                               "from": {"nfl": 1999, "cfb": 1980 if OLD_CFB.exists() else 2005},
                               "people": people, "edges": edges}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  coach trees: {found} of {len(names)} head coaches found on Wikipedia, {len(edges)} mentor links, "
          f"{sum(1 for p in people.values() if p.get('img'))} photos; {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
