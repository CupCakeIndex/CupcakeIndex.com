"""Alerts (web push) for phones and browsers that turned them on in Settings > Alerts.

Each device that turns alerts on saves a document in Firestore at push/<id> (docs/push.js): its push address
(endpoint + keys), the teams it follows ("cfb:333", "nfl:8") and the alerts it wants (topics). This script reads
them with the Firebase service-account key and sends the alerts through Apple/Google/Mozilla's push services.
Free: it runs on GitHub Actions, not Firebase Cloud Functions (those need the paid Blaze plan, which we never use).

    python src/push.py auto                       # push.yml, every 15 min: final scores (+ the Saturday Pick'em reminder)
    python src/push.py finals                     # final scores for followed teams, games that ended since the last run
    python src/push.py picks [--force]            # "Pick'em locks in 2 hours" (Saturday 9-11 PM Eastern only, unless --force)
    python src/push.py post --meta out/social/today.json   # Bully of the Week / breaking news, from the X post just made
    python src/push.py test                       # a test alert to every device (Actions > Alerts > Run workflow)
    python src/push.py list                       # how many devices have alerts on (and for what)

Secrets (GitHub > Settings > Secrets and variables > Actions):
    VAPID_PRIVATE_KEY         the private half of the push key (the public half is VAPID in docs/push.js)
    FIREBASE_SERVICE_ACCOUNT  the JSON key from Firebase console > Project settings > Service accounts
Without them it says so and does nothing, so the workflows never fail over it.

Every alert has a key (a game id, a week's Bully, a news story) and a key only goes out once (data/push/sent.json,
committed by src/push_save.sh). Dead devices (uninstalled app, alerts turned off in phone settings) get a 404/410
from the push service and their document is deleted.
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "data" / "push" / "sent.json"
PROJECT = "cupcake-index"
DOCS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football"}
ET = ZoneInfo("America/New_York")
KEEP_DAYS = 45
MAX_NEWS_PER_DAY = 3   # breaking news alerts: fewer than the X posts (6), a phone buzzing is more annoying than a tweet
FINAL_HOURS = 8        # a game that ended longer ago than this is old news (first run, or GitHub skipped runs)


# ---------- the sent log ----------
def load_log():
    try:
        return json.loads(LOG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_log(rows):
    cutoff = (dt.date.today() - dt.timedelta(days=KEEP_DAYS)).isoformat()
    rows = [r for r in rows if r.get("date", "") >= cutoff]
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def merge(other):
    """push_save.sh: our log + the one on main (another job may have pushed in between)."""
    rows, seen = load_log(), {r["key"] for r in load_log()}
    try:
        theirs = json.loads(Path(other).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        theirs = []
    rows += [r for r in theirs if r.get("key") not in seen]
    save_log(sorted(rows, key=lambda r: r.get("date", "")))


# ---------- Firestore (the devices) ----------
def session():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw or not os.environ.get("VAPID_PRIVATE_KEY", "").strip():
        return None
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    creds = service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=["https://www.googleapis.com/auth/datastore"])
    return AuthorizedSession(creds)


def strings(v):
    return [x.get("stringValue", "") for x in v.get("arrayValue", {}).get("values", [])]


def devices(s):
    out, token = [], None
    while True:
        r = s.get(f"{DOCS}/push", params={"pageSize": 300, **({"pageToken": token} if token else {})}, timeout=30)
        r.raise_for_status()
        j = r.json()
        for d in j.get("documents", []):
            f = d.get("fields", {})
            keys = f.get("keys", {}).get("mapValue", {}).get("fields", {})
            out.append({"id": d["name"].rsplit("/", 1)[1],
                        "endpoint": f.get("endpoint", {}).get("stringValue", ""),
                        "keys": {k: keys.get(k, {}).get("stringValue", "") for k in ("p256dh", "auth")},
                        "teams": set(strings(f.get("teams", {}))),
                        "topics": set(strings(f.get("topics", {})))})
        token = j.get("nextPageToken")
        if not token:
            return out


def send(s, targets, alert):
    """alert: {title, body, url, tag}. Returns how many devices got it."""
    from pywebpush import WebPushException, webpush
    ok = 0
    for d in targets:
        try:
            webpush(subscription_info={"endpoint": d["endpoint"], "keys": d["keys"]},
                    data=json.dumps(alert, ensure_ascii=False),
                    vapid_private_key=os.environ["VAPID_PRIVATE_KEY"].strip(),
                    vapid_claims={"sub": "https://cupcakeindex.com"},
                    ttl=6 * 3600, timeout=20)
            ok += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # this device is gone: forget it
                s.delete(f"{DOCS}/push/{d['id']}", timeout=20)
                print(f"   removed a dead device ({code})")
            else:
                print(f"   push failed ({code}): {str(e)[:160]}")
        except Exception as e:  # one bad device never stops the rest
            print(f"   push failed: {str(e)[:160]}")
    return ok


def deliver(s, items):
    """items: [(key, topic, teams or None, alert)]. Sends the ones not sent before, logs them all."""
    log = load_log()
    done = {r["key"] for r in log}
    new = [it for it in items if it[0] not in done]
    if not new:
        print("Nothing new to send.")
        return
    devs = devices(s)
    for key, topic, teams, alert in new:
        targets = [d for d in devs if topic in d["topics"] and (teams is None or d["teams"] & teams)]
        n = send(s, targets, alert) if targets else 0
        print(f"[{key}] {alert['title']} | {alert['body']} -> {n} of {len(targets)} device(s)")
        log.append({"date": dt.date.today().isoformat(), "key": key, "topic": topic, "sent": n})
    save_log(log)


# ---------- what to send ----------
def finals():
    now = dt.datetime.now(dt.timezone.utc)
    items = []
    for lg, base in ESPN.items():
        days = {(now - dt.timedelta(hours=h)).strftime("%Y%m%d") for h in (0, 12)}
        for day in days:
            q = {"dates": day, **({"groups": 80, "limit": 400} if lg == "cfb" else {})}
            try:
                events = requests.get(f"{base}/scoreboard", params=q, timeout=30).json().get("events", [])
            except (requests.RequestException, ValueError) as e:
                print(f"{lg} scores unavailable: {e}")
                continue
            for e in events:
                st = e.get("status", {}).get("type", {})
                start = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
                # kicked off 2.5-8.5 hours ago (a game runs ~3-4) = it ended recently, not yesterday
                if not st.get("completed") or not dt.timedelta(hours=2.5) <= now - start <= dt.timedelta(hours=FINAL_HOURS + 0.5):
                    continue
                c = e["competitions"][0]["competitors"]
                if len(c) != 2:
                    continue
                c = sorted(c, key=lambda x: -int(x.get("score") or 0))
                win, lose = c
                name = lambda x: x["team"].get("shortDisplayName") or x["team"].get("displayName")
                rec = lambda x: next((r["summary"] for r in x.get("records", []) if r.get("type") in ("total", None)), "")
                tie = win.get("score") == lose.get("score")
                ot = " (OT)" if "OT" in (st.get("shortDetail") or "") else ""
                title = f"FINAL{ot}: {name(win)} {win.get('score')}, {name(lose)} {lose.get('score')}"
                body = (f"{name(win)} and {name(lose)} tie." if tie else
                        f"{name(win)}{f' ({rec(win)})' if rec(win) else ''} beat {name(lose)}{f' ({rec(lose)})' if rec(lose) else ''}.")
                teams = {f"{lg}:{x['team']['id']}" for x in c}
                items.append((f"final:{lg}:{e['id']}", "final", teams,
                              {"title": title, "body": body + " Tap for the box score.", "url": f"/#/game/{e['id']}?league={lg}",
                               "tag": f"final-{e['id']}"}))
    return items


def picks(force=False):
    now = dt.datetime.now(ET)
    if not force and not (now.weekday() == 5 and 21 <= now.hour <= 22):  # Saturday 9-11 PM Eastern; picks lock at 11:59
        return []
    return [(f"picks:{now.date().isoformat()}", "picks", None,
             {"title": "Pick'em locks tonight", "body": "Your picks lock at 11:59 PM Eastern. Get them in!", "url": "/#/picks", "tag": "picks"})]


def from_post(meta_path):
    """Bully of the Week (bully.yml, social.yml Thursdays) or breaking news (news.yml), from the X post's meta."""
    try:
        m = json.loads(Path(meta_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if m.get("skip") or not m.get("text"):
        return []
    text = " ".join(m["text"].split())
    day = m.get("day") or m.get("stat") or ""
    if day in ("bully_cfb", "thu"):
        lg = "cfb" if day == "bully_cfb" else "nfl"
        return [(m.get("key") or f"bully:{lg}:{dt.date.today().isocalendar()[1]}", "bully", None,
                 {"title": f"{'College' if lg == 'cfb' else 'NFL'} Bully of the Week", "body": text,
                  "url": f"/#/rankings?league={lg}", "tag": f"bully-{lg}"})]
    if day == "news":  # breaking.py
        today = dt.date.today().isoformat()
        if sum(1 for r in load_log() if r.get("topic") == "news" and r.get("date") == today) >= MAX_NEWS_PER_DAY:
            print("Already sent the most news alerts for today.")
            return []
        return [(m.get("key") or f"news:{text[:80]}", "news", None,
                 {"title": "Breaking", "body": text.lstrip("🚨 "), "url": "/#/news", "tag": "news"})]
    return []


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["auto", "finals", "picks", "post", "test", "list", "merge"])
    ap.add_argument("--meta", help="post: the X post's meta file (out/social/today.json)")
    ap.add_argument("--force", action="store_true", help="picks: send the reminder whatever the time")
    ap.add_argument("--file", help="merge: the other copy of the sent log")
    ap.add_argument("--dry", action="store_true", help="show what would be sent, send nothing")
    a = ap.parse_args()
    if a.what == "merge":
        return merge(a.file)

    if a.what == "post":
        items = from_post(a.meta) if a.meta else []
    elif a.what in ("auto", "finals", "picks"):
        items = (finals() if a.what != "picks" else []) + (picks(a.force) if a.what != "finals" else [])
    else:
        items = []
    if a.dry:
        done = {r["key"] for r in load_log()}
        for key, topic, teams, alert in items:
            print(f"{'(sent before) ' if key in done else ''}[{key}] {topic} {sorted(teams) if teams else 'everyone'}\n   {alert['title']}\n   {alert['body']}")
        return

    s = session()
    if s is None:
        print("Alerts aren't set up yet (VAPID_PRIVATE_KEY / FIREBASE_SERVICE_ACCOUNT secrets missing). Nothing sent.")
        return
    if a.what == "list":
        devs = devices(s)
        print(f"{len(devs)} device(s) with alerts on")
        for t in ("final", "bully", "picks", "news"):
            print(f"   {t}: {sum(t in d['topics'] for d in devs)}")
        return
    if a.what == "test":
        devs = devices(s)
        n = send(s, devs, {"title": "Cupcake Index test alert", "body": "If you can read this, alerts work. 🧁", "url": "/#/settings", "tag": "test"})
        print(f"Test alert sent to {n} of {len(devs)} device(s)")
        return
    deliver(s, items)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
