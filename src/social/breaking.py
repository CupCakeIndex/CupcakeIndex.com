"""Breaking news posts for X: the biggest football headlines, as soon as the hourly news job sees them.

Reads docs/data/news.json (written by src/news.py from ESPN, CBS, Yahoo, Pro Football Talk and On3 feeds),
picks at most ONE fresh headline that is real news (season-ending injury, coach fired or hired, trade,
big contract, retirement, suspension) and writes a text-only post that credits the source:

    🚨 Saints release QB Derek Carr (via ESPN)

Strict on purpose: no rumors, no questions, no "could/should" columns, no odds, no other sports, no recruiting.
Never the same story twice (posted.json keys: the article link, plus team + kind for 2 days so ESPN and PFT
writing up the same thing don't both go out), and at most MAX_PER_DAY a day. No link in the post (Terry's rule).
X's free API can't read other accounts, so this can't mirror Schefter or Underdog directly; the feeds are
where their reports show up a few minutes later.

    python src/social/breaking.py            # -> out/social/today.json (or nothing, if there's no news)
    python src/social/breaking.py --list     # every headline that would qualify (testing)
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import posted
from render import DATA, ROOT, tweet

MAX_PER_DAY = 3        # only big news (Terry, Oct 6: posts like "WVU releases updated depth chart" are dumb)
FRESH_HOURS = 3        # older than this isn't breaking any more
SOURCES = {"ESPN", "CBS Sports", "Yahoo Sports", "Pro Football Talk", "On3"}  # news desks, not opinion blogs

# (kind, headline pattern). First match wins. kind_of() then keeps only the big ones.
KINDS = [
    ("injury", r"\b(out for (the )?(rest of the )?season|season-ending|torn (ACL|Achilles)|tore (his |an )?(ACL|Achilles)|to IR\b|on injured reserve)"),
    ("coach", r"\b(fired|fires|parts ways|hired|hires|names .{0,40}(head coach|coordinator)|new head coach|resigns|steps down)\b"),
    ("trade", r"\b(traded|trade for|trades? .{0,40}\bto\b|acquire[sd]?|deal sends)\b"),
    ("contract", r"\b(signs?|agrees?|lands?|gets?)\b.{0,60}\b(extension|contract|deal)\b|\bmega-deal\b|\brecord deal\b"),
    ("retire", r"\b(retires|retiring|announces (his )?retirement)\b"),
    ("suspended", r"\b(suspended|suspends|suspension)\b"),
    ("released", r"\b(release|released|releases|waived|waives|cuts)\b"),
]
COORD = re.compile(r"\b(coordinator|OC|DC|assistant|position coach|special teams|interim)\b", re.I)  # head coaches only
QB = re.compile(r"\b(QB|quarterback)\b")
# a star (one of the most-rostered NFL players) hurt or back: smaller news, but it's what people want first
STAR_INJURY = (r"\b(injur\w*|week to week|week-to-week|ruled out|won't play|will miss|to miss|carted|surgery|MRI|concussion|"
               r"hamstring|ankle|knee|groin|activated|returns? to practice|designated to return)\b")
STARS = 80
NOT_NEWS = re.compile(
    r"\?|\b(rumou?rs?|could|should|would|might|may|if|why|how|what|who|which|deadline|grades?|candidates?|targets?|"
    r"ideas?|mock|rankings?|best|worst|predictions?|(expert|staff|our|week \d+) picks|odds|bets?|betting|fantasy|start|sit|waiver wire|"
    r"practice squad|recruit\w*|commit\w*|offer|visit|transfer portal|basketball|baseball|softball|volleyball|soccer|"
    r"hockey|podcast|takeaways|winners|losers|film|watch|live|updates?|tracker|reaction|reacts|"
    r"jersey|number|hall of fame|anniversary|on this day|catch|here's|know|depth chart|polls?|ratings|instead|cautionary|"
    r"lessons?|column|opinion|analysis|notebook|observations|thoughts|explained|breakdown)\b|--", re.I)


def star_names():
    """The NFL's most-rostered skill players (ESPN fantasy), full names. Empty if ESPN can't be reached."""
    try:
        import obscure
        return [p["name"] for p in obscure.nfl_players()[:STARS]]
    except Exception as e:  # no stars list: the big-news kinds still work
        print(f"(no star list: {e!r})")
        return []


def kind_of(title, stars=()):
    """Only big news: a head coach hired or fired, or a star (or any QB) traded, hurt, cut, signed, suspended or retiring."""
    if NOT_NEWS.search(title):
        return None
    star = any(n in title for n in stars) or bool(QB.search(title))
    k = next((k for k, pat in KINDS if re.search(pat, title, re.I)), None)
    if k == "coach":
        return None if COORD.search(title) else k
    if k == "trade":
        return k if star or re.search(r"\b(first-round|blockbuster)\b", title, re.I) else None
    if k:
        return k if star else None
    if re.search(STAR_INJURY, title, re.I) and any(n in title for n in stars):
        return "star"
    return None


def candidates(hours=FRESH_HOURS, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        items = json.load(open(os.path.join(DATA, "news.json"), encoding="utf-8"))["items"]
    except (OSError, ValueError, KeyError):
        return []
    out, stars = [], None
    for it in items:
        when = dt.datetime.fromisoformat(it["published"].replace("Z", "+00:00"))
        if now - when > dt.timedelta(hours=hours):
            continue
        if stars is None and it.get("league") == "nfl":
            stars = star_names()
        k = kind_of(it["title"], stars or ())
        if it["source"] in SOURCES and k and it.get("teams") and now - when <= dt.timedelta(hours=hours):
            out.append(it | {"kind": k})
    return sorted(out, key=lambda x: x["published"])  # oldest fresh one first: news goes out in the order it broke


def text_for(it):
    t = re.sub(r"\s+", " ", it["title"]).strip().rstrip(".")
    return tweet(f"🚨 {t} (via {it['source']})", "", with_link=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="print every qualifying headline, post nothing")
    ap.add_argument("--hours", type=float, default=FRESH_HOURS)
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    cands = candidates(a.hours)
    if a.list:
        for it in cands:
            print(f"[{it['kind']}] {it['source']} {it['published']} {it['teams']}\n   {text_for(it)}")
        print(f"{len(cands)} qualifying headline(s) in the last {a.hours:g} hours")
        return
    today = dt.date.today().isoformat()
    sent_today = sum(1 for p in posted.load() if p.get("date") == today and str(p.get("stat", "")).startswith("news-"))
    if sent_today >= MAX_PER_DAY:
        print(f"Already {sent_today} news posts today; that's the cap.")
        return
    recent = posted.recent_stats(2)
    for it in cands:
        stat = f"news-{it['kind']}-{it['teams'][0]}"  # same team, same kind of story, within 2 days = the same news
        meta = {"day": "news", "stat": stat, "key": "news:" + it["url"].split("?")[0], "image": None,
                "text": text_for(it), "skip": False, "reason": ""}
        if stat in recent or posted.repeat(meta):
            print(f"skip (already covered): {it['title']}")
            continue
        os.makedirs(a.out, exist_ok=True)
        with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=1, ensure_ascii=False)
        print(f"[{it['kind']}] {meta['text']}")
        return
    print("No breaking news this hour.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
