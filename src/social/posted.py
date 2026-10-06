"""What the X account has already posted, so the posts never repeat themselves.

data/social/posted.json is a list of {date, stat, key, text}, newest last. post_to_x.py adds a line after every
successful post; the workflows commit the file back to the repo so the next run can see it.

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
    if similar(meta.get("text")):
        return "the same post (with different numbers) went out in the last 30 days"
    if meta.get("key") and meta["key"] in recent_keys(60):
        return f"already posted about {meta['key']}"
    return ""


def add(meta):
    rows = load()
    row = {"date": dt.date.today().isoformat(), "stat": meta.get("stat") or meta.get("day"), "text": meta.get("text", "")}
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
