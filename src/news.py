"""Collect football headlines from public RSS/Atom feeds into docs/data/news.json for the News tab.

Browsers can't read most publishers' feeds directly (CORS), so a GitHub Action runs this hourly and
commits the result. We keep only what a feed reader shows: headline, a short plain-text summary,
the link back to the publisher, the source name and a thumbnail if the feed provides one.
Each headline is tagged with the teams it mentions so the site can filter by team.

Usage: python src/news.py            (writes docs/data/news.json)
"""
import html
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
import xml.etree.ElementTree as ET

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "news.json"
UA = "Mozilla/5.0 (compatible; CupcakeIndexNews/1.0; +https://cupcakeindex.com)"
TIMEOUT = (6, 15)    # connect, read seconds
MAX_ITEMS = 150
DAYS = 7
SUMMARY_LEN = 200
# sportsbook ads and sign-up promos, plus other sports that leak into the football feeds
SKIP = re.compile(r"\b(promos?|promo codes?|bonus(es)?|sportsbooks?|betting apps?|CFL|MLB|NBA|NHL|WNBA|MLS)\b|"
                  r"\b(Braves|Phillies|Yankees|Dodgers|Mets)\b", re.I)

# (source shown on the site, league, feed url). Every url here was checked with a real fetch.
FEEDS = [
    ("ESPN", "nfl", "https://www.espn.com/espn/rss/nfl/news"),
    ("ESPN", "cfb", "https://www.espn.com/espn/rss/ncf/news"),
    ("CBS Sports", "nfl", "https://www.cbssports.com/rss/headlines/nfl/"),
    ("CBS Sports", "cfb", "https://www.cbssports.com/rss/headlines/college-football/"),
    ("Yahoo Sports", "nfl", "https://sports.yahoo.com/nfl/rss/"),
    ("Yahoo Sports", "cfb", "https://sports.yahoo.com/college-football/rss/"),
    ("Pro Football Talk", "nfl", "https://www.nbcsports.com/profootballtalk.rss"),
    ("SB Nation", "nfl", "https://www.sbnation.com/rss/nfl/index.xml"),
    ("SB Nation", "cfb", "https://www.sbnation.com/rss/college-football/index.xml"),
    ("On3", "cfb", "https://www.on3.com/feed/"),
]
# Checked 2026-10-01 and left out: Sports Illustrated and Bleacher Report (no public feed, 404),
# NFL.com (malformed XML), USA Today (402), 247Sports (403).

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}


# ------------------------------------------------------------------ text helpers
def plain(s, limit=None):
    """HTML -> plain text, whitespace collapsed, optionally cut at a word boundary."""
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,.;:-") + "…"
    return s


def parse_date(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)          # RSS: "Tue, 30 Sep 2026 14:02:00 GMT"
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))  # Atom: ISO 8601
        except ValueError:
            return None
    d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    # ESPN labels Eastern times "EST" all year; in summer they are really EDT (an hour earlier in UTC)
    if s.endswith(" EST") and _us_dst(d):
        d -= timedelta(hours=1)
    return d


def _us_dst(d):
    """True between the 2nd Sunday of March and the 1st Sunday of November (US daylight time)."""
    def sunday(month, n):
        first = datetime(d.year, month, 1, tzinfo=timezone.utc)
        return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    return sunday(3, 2) <= d < sunday(11, 1)


def safe_url(u):
    u = (u or "").strip()
    return u if u.startswith("https://") or u.startswith("http://") else ""


def url_key(u):
    """Same article, different tracking params -> same key."""
    p = urlsplit(u)
    return urlunsplit((p.scheme, p.netloc.lower().removeprefix("www."), p.path.rstrip("/"), "", ""))


def title_key(t):
    return re.sub(r"[^a-z0-9]+", "", t.lower())


# ------------------------------------------------------------------ feed parsing (RSS 2.0 and Atom)
def _text(el, path):
    x = el.find(path, NS)
    return (x.text or "") if x is not None else ""


def _image(el, body):
    for path in ("media:content", "media:thumbnail", "media:group/media:content", "media:group/media:thumbnail"):
        for m in el.findall(path, NS):
            url, kind = m.get("url"), (m.get("type") or m.get("medium") or "image")
            if url and ("image" in kind or kind == "image"):
                return safe_url(url)
    for enc in el.findall("enclosure"):
        if (enc.get("type") or "").startswith("image") and enc.get("url"):
            return safe_url(enc.get("url"))
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)", body or "")
    return safe_url(html.unescape(m.group(1))) if m else ""


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    if root.tag.endswith("rss") or root.find("channel") is not None:
        for it in root.iter("item"):
            body = _text(it, "description") or _text(it, "content:encoded")
            out.append({
                "title": _text(it, "title"),
                "url": _text(it, "link") or _text(it, "guid"),
                "published": _text(it, "pubDate") or _text(it, "{http://purl.org/dc/elements/1.1/}date"),
                "summary": body,
                "image": _image(it, body + _text(it, "content:encoded")),
            })
    else:
        for it in root.iter("{http://www.w3.org/2005/Atom}entry"):
            link = ""
            for ln in it.findall("atom:link", NS):
                if ln.get("rel", "alternate") == "alternate":
                    link = ln.get("href", "")
                    break
            body = _text(it, "atom:summary") or _text(it, "atom:content")
            out.append({
                "title": _text(it, "atom:title"),
                "url": link,
                "published": _text(it, "atom:published") or _text(it, "atom:updated"),
                "summary": body,
                "image": _image(it, _text(it, "atom:content") or body),
            })
    return out


def fetch(feed):
    source, lg, url = feed
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"}, timeout=TIMEOUT)
        r.raise_for_status()
        return feed, parse_feed(r.content), None
    except Exception as e:  # one bad feed never stops the others
        return feed, [], f"{type(e).__name__}: {e}"[:160]


# ------------------------------------------------------------------ team tagging
def _latest_week(lg):
    weeks = sorted((ROOT / "docs" / "data" / lg).glob("*/week_*.json"),
                   key=lambda p: (int(p.parent.name), int(p.stem.split("_")[1])))
    return json.loads(weeks[-1].read_text(encoding="utf-8")) if weeks else {"teams": []}


def _espn_teams(sport):
    try:
        r = requests.get(f"https://site.web.api.espn.com/apis/site/v2/sports/football/{sport}/teams?limit=1000",
                         headers={"User-Agent": UA}, timeout=TIMEOUT)
        r.raise_for_status()
        return [t["team"] for t in r.json()["sports"][0]["leagues"][0]["teams"]]
    except Exception as e:
        print(f"  ! ESPN team list ({sport}) failed: {e}")
        return []


def build_teams():
    """-> (teams {key: {name, lg, id, logo}}, patterns [(phrase, key, kind)]).

    kind "full" = full name ("Ohio State Buckeyes"), always trusted.
    kind "nick" = NFL nickname ("Chiefs"); only trusted on NFL headlines.
    kind "school"/"mascot" = college school name ("Ohio State") or a mascot only one FBS team uses
    ("Buckeyes"); only trusted on college headlines.
    """
    teams, pats = {}, []
    espn_nfl = {t["displayName"]: t for t in _espn_teams("nfl")}
    for t in _latest_week("nfl")["teams"]:
        e = espn_nfl.get(t["team"])
        if not e:
            continue
        key = f"nfl:{e['id']}"
        teams[key] = {"name": e["displayName"], "short": e["name"], "lg": "nfl", "id": str(e["id"]), "logo": t.get("logo") or ""}
        pats += [(e["displayName"], key, "full"), (e["name"], key, "nick")]

    espn_cfb = {str(t["id"]): t for t in _espn_teams("college-football")}
    fbs = [t for t in _latest_week("cfb")["teams"] if t.get("id") is not None]
    mascots = {}
    for t in fbs:
        e = espn_cfb.get(str(t["id"]))
        if e and e.get("name"):
            mascots.setdefault(e["name"], []).append(str(t["id"]))
    nfl_nicks = {v["short"] for v in teams.values()}
    for t in fbs:
        tid = str(t["id"])
        key = f"cfb:{tid}"
        e = espn_cfb.get(tid, {})
        teams[key] = {"name": t["team"], "short": t["team"], "lg": "cfb", "id": tid, "logo": t.get("logo") or ""}
        if e.get("displayName"):
            pats.append((e["displayName"], key, "full"))
        for school in {t["team"], e.get("location") or t["team"]}:
            pats.append((school, key, "school"))
        m = e.get("name")
        if m and len(mascots.get(m, [])) == 1 and m not in nfl_nicks:
            pats.append((m, key, "mascot"))
    # longest phrase first, so "Michigan State" wins over "Michigan" and "Red Raiders" over "Raiders"
    pats.sort(key=lambda p: -len(p[0]))
    return teams, [(re.compile(r"(?<![\w&])" + re.escape(p) + r"(?![\w&])"), key, kind) for p, key, kind in pats]


def tag_teams(text, lg, patterns):
    """Team keys mentioned in text. Matched spans are blanked so shorter names can't re-match inside them."""
    found, s = [], text
    for rx, key, kind in patterns:
        if kind == "nick" and lg == "cfb":
            continue
        if kind in ("school", "mascot") and lg == "nfl":
            continue
        hit = False
        for m in rx.finditer(s):
            hit = True
            s = s[: m.start()] + " " * (m.end() - m.start()) + s[m.end():]
        if hit and key not in found:
            found.append(key)
    return found


# ------------------------------------------------------------------ main
def main():
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=DAYS)
    teams, patterns = build_teams()
    print(f"Tagging against {len(teams)} teams")

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, FEEDS))

    feeds, seen_url, seen_title = [], set(), set()
    for (source, lg, url), raw, err in results:
        if err:
            print(f"  ! {source} ({lg}): {err}")
            continue
        items = []
        for r in raw:
            title, link = plain(r["title"]), safe_url(r["url"])
            when = parse_date(r["published"])
            if not title or not link or not when or when < cutoff or when > now + timedelta(hours=1):
                continue
            if SKIP.search(title):
                continue
            uk, tk = url_key(link), title_key(title)
            if uk in seen_url or tk in seen_title:
                continue
            summary = plain(r["summary"], SUMMARY_LEN)
            if title_key(summary) == tk:
                summary = ""
            seen_url.add(uk)
            seen_title.add(tk)
            items.append({
                "title": title, "url": link, "source": source, "league": lg,
                "published": when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "summary": summary, "image": r["image"],
                "teams": tag_teams(f"{title} . {plain(r['summary'])}", lg, patterns),
            })
        print(f"  {source} ({lg}): {len(raw)} in feed, {len(items)} new in last {DAYS} days")
        feeds.append(sorted(items, key=lambda x: x["published"], reverse=True))

    # take the newest from every feed in turn, so one busy feed can't crowd out the rest
    trimmed = []
    for i in range(max(map(len, feeds), default=0)):
        trimmed += [f[i] for f in feeds if i < len(f)]
    trimmed = sorted(trimmed[:MAX_ITEMS], key=lambda x: x["published"], reverse=True)
    used = {k for it in trimmed for k in it["teams"]}
    out = {
        "updated": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "teams": {k: v for k, v in teams.items() if k in used},
        "items": trimmed,
    }
    if not trimmed:
        print("No headlines fetched; keeping the old file")
        return
    try:  # unchanged headlines -> leave the file alone, so the hourly job doesn't commit a new timestamp
        old = json.loads(OUT.read_text(encoding="utf-8"))
        if old.get("items") == out["items"] and old.get("teams") == out["teams"]:
            print("No new headlines")
            return
    except (OSError, ValueError):
        pass
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {len(trimmed)} headlines ({sum(1 for i in trimmed if i['teams'])} tagged with a team) to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
