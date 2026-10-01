"""Post today's rendered graphic to X. SAFE BY DEFAULT: does nothing unless switched on.

It only posts when ALL of these are true:
  - env X_POSTING_ENABLED is exactly "true"   (a GitHub repo *variable* Terry sets)
  - X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET are all set (GitHub *secrets*)
  - render.py didn't mark today's post as "skip" (stale or empty data)
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

    print("Tweet text:\n" + meta["text"] + "\nImage: " + meta["image"])
    enabled = os.environ.get("X_POSTING_ENABLED", "").strip().lower() == "true"
    missing = [k for k in SECRETS if not os.environ.get(k)]
    if not enabled:
        print("DRY RUN: posting is off (set the repo variable X_POSTING_ENABLED to true to turn it on).")
        return
    if missing:
        print("DRY RUN: posting is on but these secrets are missing: " + ", ".join(missing))
        return
    if meta.get("skip"):
        print(f"Not posting today: {meta.get('reason') or 'nothing fresh'}.")
        return

    import requests
    from requests_oauthlib import OAuth1
    auth = OAuth1(os.environ["X_API_KEY"], os.environ["X_API_SECRET"],
                  os.environ["X_ACCESS_TOKEN"], os.environ["X_ACCESS_SECRET"])

    with open(meta["image"], "rb") as img:
        r = requests.post(UPLOAD_URL, auth=auth, timeout=60,
                          files={"media": ("card.png", img, "image/png")},
                          data={"media_category": "tweet_image"})
    if r.status_code >= 300:
        sys.exit(f"Media upload failed ({r.status_code}): {r.text[:500]}")
    media_id = (r.json().get("data") or {}).get("id") or r.json().get("media_id_string")
    if not media_id:
        sys.exit(f"Media upload returned no id: {r.text[:500]}")

    r = requests.post(TWEET_URL, auth=auth, timeout=60,
                      json={"text": meta["text"], "media": {"media_ids": [str(media_id)]}})
    if r.status_code >= 300:
        sys.exit(f"Posting failed ({r.status_code}): {r.text[:500]}")
    print("Posted: https://x.com/i/web/status/" + r.json()["data"]["id"])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
