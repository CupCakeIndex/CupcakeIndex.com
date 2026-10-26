"""What the X account costs to run, for the admin tab's cost breakdown: one row per X post and per Claude call.

Rows live in Firestore (fsadmin.py: admin_ledger, readable only by the owner account), never in the public repo:
  kind "x"      : a post on X (X's API charges per post; no link = the cheap price)
  kind "claude" : one Claude API call (model, input/output tokens), what = "check" (check_post.py),
                  "punch_up" or "take" (writer.py)
  kind "check"  : the quality check's verdict on a post (ok / blocked, why, text, a small copy of the picture)
Claude rows start on 2026-10-26; brief.py fills in X rows from the posting log, so earlier posts count too.
"""
import datetime as dt
import hashlib
import secrets

import fsadmin

# $ per million tokens (input, output), Anthropic's list prices (checked Oct 2026)
CLAUDE = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (0.10, 0.50)}
X_POST = 0.015  # X API, per post without a link (X's price list, Oct 2026)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def add(row, doc_id=None):
    row = {"at": now(), **row}
    fsadmin.put("admin_ledger", doc_id or secrets.token_hex(8), row)


def x_post(plain, text="", tweet_id="", date=None, at=None, what="post"):
    """One post on X. The id comes from the day and the posting log's wording (plain), so brief.py's fill-in from the
    posting log never counts it twice; text is the wording that actually went out."""
    date = date or dt.date.today().isoformat()
    when = at or (now() if date == dt.date.today().isoformat() else f"{date}T12:00:00+00:00")
    row = {"at": when, "kind": "x", "what": what or "post", "usd": X_POST, "text": (text or plain)[:300], "timed": bool(at) or date == dt.date.today().isoformat()}
    if tweet_id:  # the fill-in doesn't know the post's id: keep the one post_to_x.py saved
        row["tweet"] = tweet_id
    add(row, "x-" + hashlib.sha1(f"{date}|{plain}".encode()).hexdigest()[:16])


def claude(what, model, usage):
    """Log one Claude call from its response.usage; returns its cost in dollars."""
    i, o = CLAUDE.get(model, CLAUDE["claude-opus-5-5"])
    tin = (usage.input_tokens or 0) + (getattr(usage, "cache_creation_input_tokens", 0) or 0) * 1.25 \
        + (getattr(usage, "cache_read_input_tokens", 0) or 0) * 0.1
    usd = round((tin * i + (usage.output_tokens or 0) * o) / 1e6, 5)
    add({"kind": "claude", "what": what, "model": model, "in": usage.input_tokens, "out": usage.output_tokens, "usd": usd})
    return usd


def month_spend(what=None):
    """Dollars logged this calendar month (UTC), optionally only one kind of Claude call."""
    start = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-01")
    return sum(r.get("usd") or 0 for r in fsadmin.since("admin_ledger", "at", start, ["usd", "what"]) if what is None or r.get("what") == what)
