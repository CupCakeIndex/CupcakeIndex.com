"""Post today's rendered graphic to X. SAFE BY DEFAULT: does nothing unless switched on.

It only posts when ALL of these are true:
  - env X_POSTING_ENABLED is exactly "true"   (a GitHub repo *variable* Terry sets)
  - X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET are all set (GitHub *secrets*)
  - render.py didn't mark today's post as "skip" (stale or empty data)
  - it isn't a repeat (posted.py: same text, the same post with new numbers, or the same story key)
  - today isn't full (posted.over_cap: at most 6 posts a day, the lesser kinds stop first)
  - the quality check passes (check_post.py: Claude looks at the picture and text; if it can't run, no post)
If ANTHROPIC_API_KEY is set, writer.py has Claude punch up the wording first (same numbers, plus team @'s and
hashtags); without it the original text goes out with the @'s and hashtags added.
Otherwise it prints what it WOULD have posted and exits 0.

Uses the X API v2: POST /2/media/upload (the old v1.1 upload endpoint was retired in 2025),
then POST /2/tweets, both signed with OAuth 1.0a user keys ("Keys and tokens" in the X dev console).

    python src/social/post_to_x.py --meta out/social/today.json
"""
import argparse
import json
import os
import sys

UPLOAD_URL = "https://api.x.com/2/media/upload"
TWEET_URL = "https://api.x.com/2/tweets"
SECRETS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", default=os.path.join("out", "social", "today.json"))
    a = ap.parse_args()
    with open(a.meta, encoding="utf-8") as f:
        meta = json.load(f)

    print("Tweet text:\n" + meta["text"] + "\nImage: " + (meta.get("image") or "none (text-only post)"))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if meta.get("skip"):
        print(f"Not posting today: {meta.get('reason') or 'nothing fresh'}.")
        return
    import posted
    why = posted.repeat(meta)
    if why:
        print(f"Not posting: {why} (see data/social/posted.json).")
        return
    full = posted.over_cap(meta)
    if full:
        print(f"Not posting: {full}.")
        return
    plain = dict(meta)  # the log keeps the original wording, so repeats are still caught tomorrow
    if not meta.get("written"):  # writer.py --take posts are Claude's already
        import writer
        meta["text"] = writer.punch_up(meta)
        if meta["text"] != plain["text"]:
            print("As posted (writer.py):\n" + meta["text"])
    # last line of defense: the account isn't verified, so X rejects anything over 280
    from render import x_len
    if x_len(meta["text"]) > 280:
        sys.exit(f"Refusing to post: {x_len(meta['text'])} characters is over X's 280 limit.")
    enabled = os.environ.get("X_POSTING_ENABLED", "").strip().lower() == "true"
    missing = [k for k in SECRETS if not os.environ.get(k)]
    if not enabled:
        print("DRY RUN: posting is off (set the repo variable X_POSTING_ENABLED to true to turn it on).")
        return
    if missing:
        print("DRY RUN: posting is on but these secrets are missing: " + ", ".join(missing))
        return
    # Claude looks at the finished picture and text; a bad post (wrong photo, wrong fact, stale news) doesn't go out
    import check_post
    ok, why = check_post.check(meta)
    if not ok:
        print(f"Not posting: the quality check stopped it ({why}).")
        return
    print(f"Quality check passed: {why}")

    import requests
    from requests_oauthlib import OAuth1
    auth = OAuth1(os.environ["X_API_KEY"], os.environ["X_API_SECRET"],
                  os.environ["X_ACCESS_TOKEN"], os.environ["X_ACCESS_SECRET"])

    body = {"text": meta["text"]}
    if meta.get("image"):  # news posts are text only
        with open(meta["image"], "rb") as img:
            r = requests.post(UPLOAD_URL, auth=auth, timeout=60,
                              files={"media": ("card.png", img, "image/png")},
                              data={"media_category": "tweet_image"})
        if r.status_code >= 300:
            sys.exit(f"Media upload failed ({r.status_code}): {r.text[:500]}")
        media_id = (r.json().get("data") or {}).get("id") or r.json().get("media_id_string")
        if not media_id:
            sys.exit(f"Media upload returned no id: {r.text[:500]}")
        body["media"] = {"media_ids": [str(media_id)]}

    r = requests.post(TWEET_URL, auth=auth, timeout=60, json=body)
    if r.status_code >= 300:
        sys.exit(f"Posting failed ({r.status_code}): {r.text[:500]}")
    tid = r.json()["data"]["id"]
    print("Posted: https://x.com/i/web/status/" + tid)
    posted.add(plain)  # the workflow commits this so the next run knows
    try:  # the admin tab's cost breakdown
        import ledger
        ledger.x_post(plain["text"], meta["text"], tid, what=str(meta.get("stat") or meta.get("day") or "post"))
    except Exception as e:
        print(f"Couldn't log the cost: {e}")
    try:  # the Takes page on the site; never fails the post over it
        import feed
        feed.add(meta, tid)
    except Exception as e:
        print(f"Couldn't add it to the Takes page: {e}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
