"""What the X account has already posted, so the posts never repeat themselves.

data/social/posted.json is a list of {date, stat, key, text}, newest last. post_to_x.py adds a line after every
successful post; the workflows commit the file back to the repo so the next run can see it.

over_cap() keeps it to at most DAILY_CAP posts a day, best kinds first.

Three kinds of repeat are blocked:
  - the exact same text (X rejects those anyway)
  - the same post with only the numbers changed ("Alabama at 70%" one day, "Alabama at 62%" the next):
    that's how the Alabama game-day card and the Pitt Bully went out twice
  - the same story under a different wording: posts can carry a `key` (a game id, a news story, a player),
    and a key is only used once
"""
import datetime as dt
import json
import re
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent.parent / "data" / "social" / "posted.json"
KEEP = 400  # plenty: about six months of posts
SIMILAR_DAYS = 30


def load():
    try:
        return json.loads(LOG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def _since(days):
    cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    return [p for p in load() if p.get("date", "") >= cutoff]


def recent_stats(days):
    """Stat keys posted in the last `days` days."""
    return {p.get("stat") for p in _since(days) if p.get("stat")}


def recent_keys(days):
    return {p.get("key") for p in _since(days) if p.get("key")}


def shape(text):
    """The text with numbers and punctuation taken out: two posts with the same shape say the same thing."""
    t = re.sub(r"\d+(\.\d+)?", "#", (text or "").lower())
    return " ".join(re.sub(r"[^\w#]+", " ", t).split())


def seen(text):
    """Exactly this text was posted before."""
    t = " ".join((text or "").split())
    return any(" ".join(p.get("text", "").split()) == t for p in load())


def similar(text, days=SIMILAR_DAYS):
    """This text, or the same post with different numbers, went out in the last `days` days."""
    s = shape(text)
    return bool(s) and any(shape(p.get("text", "")) == s for p in _since(days))


def repeat(meta):
    """Why this post would be a repeat, or "" if it's new."""
    if seen(meta.get("text")):
        return "this exact text was already posted"
    if similar(meta.get("text")) and not meta.get("weekly"):  # weekly posts (one per week by key) may share a leader
        return "the same post (with different numbers) went out in the last 30 days"
    if meta.get("key") and meta["key"] in recent_keys(60):
        return f"already posted about {meta['key']}"
    return ""


# At most 6 posts a day (Terry, Oct 26; it was about 4 from Oct 21), and the best kinds win. Posts go out at fixed times, so a
# post can't bump one that already went: instead the lesser kinds stop earlier, which leaves room for the
# better ones still to come that day. Counted per US Eastern day.
DAILY_CAP = 6  # hard max: nothing posts once 6 went out today
TIER_LIMIT = {1: DAILY_CAP, 2: DAILY_CAP - 1, 3: DAILY_CAP - 2}  # tier 3 posts only while fewer than 4 went out today
TIER1 = ("mon", "tue", "wed", "thu", "fri", "sat", "sun", "bully", "pace_", "news-")  # the daily post, Bully, records, big news
TIER2 = ("tonight", "hot_", "weekly_", "nfl_injuries", "take", "series_week", "nfl_series_week", "week_drought",
         "top10_drought", "cupcake_streak", "nfl_easiest_left", "nfl_toughest_left", "cfb_easiest_left", "cfb_toughest_left")


def eastern_day(when=None):
    when = when or dt.datetime.now(dt.timezone.utc)
    return (when - dt.timedelta(hours=4 if 3 <= when.month <= 10 else 5)).date().isoformat()  # close enough for counting


def today_count():
    """Posts that went out today (US Eastern). Old rows have no time, so they count by their (UTC) date."""
    today = eastern_day()
    n = 0
    for p in load():
        at = p.get("at")
        day = eastern_day(dt.datetime.fromisoformat(at)) if at else p.get("date")
        n += day == today
    return n


def tier(meta):
    """1 = always goes (up to the hard limit), 2 = good, 3 = filler (deep-cut stats, app tips, player game lines)."""
    if meta.get("tier"):
        return meta["tier"]
    s = str(meta.get("stat") or meta.get("day") or "")
    if s.startswith(TIER1) or meta.get("day") in TIER1:
        return 1
    if s.startswith(TIER2):
        return 2
    return 3


def over_cap(meta):
    """Why this post would go over today's limit, or "" if there's room."""
    n, t = today_count(), tier(meta)
    if n >= TIER_LIMIT[t]:
        return f"{n} posts already went out today; tier {t} posts stop at {TIER_LIMIT[t]}"
    return ""


def add(meta):
    rows = load()
    row = {"date": dt.date.today().isoformat(), "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes"),
           "stat": meta.get("stat") or meta.get("day"), "text": meta.get("text", "")}
    if meta.get("key"):
        row["key"] = meta["key"]
    rows.append(row)
    save(rows)


def save(rows):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows[-KEEP:], indent=1, ensure_ascii=False), encoding="utf-8")


def merge(other_path):
    """Add the rows from another copy of the log that this one is missing (save_log.sh: two posts at once)."""
    rows = load()
    have = {(r.get("date"), r.get("text")) for r in rows}
    try:
        extra = json.loads(Path(other_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        extra = []
    rows += [r for r in extra if (r.get("date"), r.get("text")) not in have]
    rows.sort(key=lambda r: r.get("date", ""))  # stable: same-day rows keep their order
    save(rows)


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == "--merge":
        merge(sys.argv[2])
