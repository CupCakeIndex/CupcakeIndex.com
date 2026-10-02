"""What the X account has already posted, so the stat posts never repeat themselves.

data/social/posted.json is a list of {date, stat, text}, newest last. post_to_x.py adds a line after every
successful post; the workflows commit the file back to the repo so the next run can see it.
"""
import datetime as dt
import json
from pathlib import Path

LOG = Path(__file__).resolve().parent.parent.parent / "data" / "social" / "posted.json"
KEEP = 400  # plenty: about six months of posts


def load():
    try:
        return json.loads(LOG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def recent_stats(days):
    """Stat keys posted in the last `days` days."""
    cutoff = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    return {p.get("stat") for p in load() if p.get("date", "") >= cutoff and p.get("stat")}


def seen(text):
    """Exactly this text was posted before (X rejects exact repeats anyway)."""
    t = " ".join((text or "").split())
    return any(" ".join(p.get("text", "").split()) == t for p in load())


def add(meta):
    rows = load()
    rows.append({"date": dt.date.today().isoformat(), "stat": meta.get("stat") or meta.get("day"), "text": meta.get("text", "")})
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows[-KEEP:], indent=1, ensure_ascii=False), encoding="utf-8")
