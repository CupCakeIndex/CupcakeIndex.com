"""Post a reviewed thread to X: data/threads/<name>/thread.json ({"posts": [{"text", "image"}]}) plus its pictures.

Each post replies to the one before it. Same switch and keys as post_to_x.py (X_POSTING_ENABLED + the four X secrets);
without them it only prints what it would post. No links, 280 characters max, checked before anything goes out.

Never leaves half a thread: after the first post it reads how many posts X says are left for the next 24 hours. If
there isn't room for the rest, it deletes that first post and stops, and the log says when to try again.
Each post is added to the posting log (posted.py), so the daily posts know about it.

    python src/social/post_thread.py data/threads/2026-10-06-new-features
    (thread.yml: Actions tab > "Post a thread" > Run workflow)
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import x_len

UPLOAD_URL = "https://api.x.com/2/media/upload"
TWEET_URL = "https://api.x.com/2/tweets"
SECRETS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]


def left_today(r):
    """Posts X says the account has left in its 24-hour window (None if it didn't say)."""
    vals = [r.headers.get(h) for h in ("x-user-limit-24hour-remaining", "x-app-limit-24hour-remaining")]
    vals = [int(v) for v in vals if v and v.isdigit()]
    return min(vals) if vals else None


def reset_at(r):
    v = r.headers.get("x-user-limit-24hour-reset") or r.headers.get("x-app-limit-24hour-reset")
    return datetime.fromtimestamp(int(v), timezone.utc).strftime("%b %d %H:%M UTC") if v and v.isdigit() else "later"


def main():
    folder = sys.argv[1]
    with open(os.path.join(folder, "thread.json"), encoding="utf-8") as f:
        posts = json.load(f)["posts"]
    for i, p in enumerate(posts, 1):  # check everything before posting anything
        if x_len(p["text"]) > 280:
            sys.exit(f"Post {i} is {x_len(p['text'])} characters (over 280). Nothing posted.")
        if "http" in p["text"] or ".com" in p["text"]:
            sys.exit(f"Post {i} has a link (Terry's rule: no links). Nothing posted.")
        if p.get("image") and not os.path.exists(os.path.join(folder, p["image"])):
            sys.exit(f"Post {i}: picture {p['image']} is missing. Nothing posted.")
        print(f"--- {i}/{len(posts)} ({x_len(p['text'])} chars, {p.get('image') or 'no picture'})\n{p['text']}")

    if os.environ.get("X_POSTING_ENABLED", "").strip().lower() != "true" or any(not os.environ.get(k) for k in SECRETS):
        print("\nDRY RUN: posting is off or the X keys are missing. Nothing posted.")
        return

    import requests
    from requests_oauthlib import OAuth1
    import posted
    auth = OAuth1(*(os.environ[k] for k in SECRETS))
    prev, first = None, None
    for i, p in enumerate(posts, 1):
        body = {"text": p["text"]}
        if p.get("image"):
            with open(os.path.join(folder, p["image"]), "rb") as img:
                r = requests.post(UPLOAD_URL, auth=auth, timeout=120, files={"media": (p["image"], img, "image/png")},
                                  data={"media_category": "tweet_image"})
            if r.status_code >= 300:
                sys.exit(f"Picture {i} upload failed ({r.status_code}): {r.text[:300]}" + (f"\nThread so far: https://x.com/i/web/status/{first}" if first else ""))
            body["media"] = {"media_ids": [str((r.json().get("data") or {}).get("id") or r.json().get("media_id_string"))]}
        if prev:
            body["reply"] = {"in_reply_to_tweet_id": prev}
        r = requests.post(TWEET_URL, auth=auth, timeout=60, json=body)
        if r.status_code >= 300:
            sys.exit(f"Post {i} failed ({r.status_code}): {r.text[:300]}" + (f"\nThread so far: https://x.com/i/web/status/{first}" if first else ""))
        prev = r.json()["data"]["id"]
        print(f"Posted {i}/{len(posts)}: https://x.com/i/web/status/{prev}")
        if i == 1:
            first = prev
            room = left_today(r)
            print(f"X says {room if room is not None else 'an unknown number of'} post(s) left in the next 24 hours")
            if room is not None and room < len(posts) - 1:
                d = requests.delete(f"{TWEET_URL}/{first}", auth=auth, timeout=60)
                sys.exit(f"Not enough room today for the other {len(posts) - 1} posts ({room} left), so the first post was "
                         f"{'deleted' if d.status_code < 300 else 'NOT deleted (delete it by hand)'}. Try again after {reset_at(r)}.")
        posted.add({"stat": f"thread:{os.path.basename(folder)}:{i}", "text": p["text"]})
        time.sleep(3)
    print(f"\nThread is up: https://x.com/i/web/status/{first}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
