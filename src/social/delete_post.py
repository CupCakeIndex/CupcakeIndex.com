"""Take one of our X posts down, and optionally drop its row from the posting log so it can go out again (corrected).

    python src/social/delete_post.py https://x.com/i/web/status/2114770499767058902 --key primetime-401873009
    (delete_post.yml: Actions tab > "Delete an X post" > Run workflow)
"""
import argparse
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import posted  # noqa: E402

SECRETS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("post", help="the post's link or number")
    ap.add_argument("--key", help="posting-log key to forget (for example primetime-401873009), so the post can be redone")
    ap.add_argument("--forget-only", action="store_true", help="only drop the key from the log (the workflow's commit step)")
    a = ap.parse_args()
    if a.forget_only:
        return forget(a.key)
    m = re.search(r"(\d{10,})\D*$", a.post)
    if not m:
        sys.exit(f"Couldn't find a post number in {a.post!r}")
    from requests_oauthlib import OAuth1
    r = requests.delete(f"https://api.x.com/2/tweets/{m.group(1)}", auth=OAuth1(*(os.environ[k] for k in SECRETS)), timeout=60)
    if r.status_code >= 300 or not r.json().get("data", {}).get("deleted"):
        sys.exit(f"X didn't delete it ({r.status_code}): {r.text[:300]}")
    print(f"Deleted post {m.group(1)}")


def forget(key):
    """Drop the key's rows from the log. Not through save_log.sh: its merge would add the row right back."""
    rows = posted.load()
    keep = [p for p in rows if p.get("key") != key]
    posted.save(keep)
    print(f"Dropped {len(rows) - len(keep)} posting-log row(s) with key {key}")


if __name__ == "__main__":
    main()
