"""Alerts (web push) for phones and browsers that turned them on in Settings > Alerts.

Each device that turns alerts on saves a document in Firestore at push/<id> (docs/push.js): its push address
(endpoint + keys), the teams it follows ("cfb:333", "nfl:8") and the alerts it wants (topics). This script reads
them with the Firebase service-account key and sends the alerts through Apple/Google/Mozilla's push services.
Free: it runs on GitHub Actions, not Firebase Cloud Functions (those need the paid Blaze plan, which we never use).

Alerts for the teams you follow (push.yml, every 5 minutes during the season):
    start   "Kickoff soon": ~15 minutes before the game (or at kickoff, if GitHub ran late)
    score   every score change: "Alabama touchdown · ALA 14, AUB 7 · 4:12 - 2nd" (extra points ride along with the next update)
    final   the final score and both records
For everyone who wants them: bully (Bully of the Week, from the X post), picks (Saturday-night Pick'em reminder), news.

    python src/push.py auto                       # push.yml: game alerts + the Saturday Pick'em reminder
    python src/push.py auto --dry                 # what it would send right now (every game, not just followed ones)
    python src/push.py picks --force              # the Pick'em reminder, whatever the time
    python src/push.py post --meta out/social/today.json   # Bully of the Week / breaking news, from the X post just made
    python src/push.py test                       # a test alert to every device (Actions > Alerts > Run workflow)
    python src/push.py announce                   # the new-features alert in ANNOUNCE below, once, to every device
    python src/push.py list                       # how many devices have alerts on (and for what)

Secrets (GitHub > Settings > Secrets and variables > Actions):
    VAPID_PRIVATE_KEY         the private half of the push key (the public half is VAPID in docs/push.js)
    FIREBASE_SERVICE_ACCOUNT  the JSON key from Firebase console > Project settings > Service accounts
Without them it says so and does nothing, so the workflows never fail over it.

Every alert has a key (a game + score, a week's Bully, a news story) and a key only goes out once. The keys sent
live in one Firestore document (pushstate/log, unreadable from the site), so nothing gets committed to the repo.
Dead devices (uninstalled app, alerts turned off in phone settings) get a 404/410 from the push service and their
document is deleted. Free-plan budget: each run that has a followed game going reads every device once
(50,000 reads a day free), so this is comfortable up to roughly 150 devices.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from zoneinfo import ZoneInfo

import requests

PROJECT = "cupcake-index"
DOCS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
STATE = f"{DOCS}/pushstate/log"
ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football"}
ET = ZoneInfo("America/New_York")
KEEP_DAYS = 21
MAX_NEWS_PER_DAY = 3      # breaking news alerts: same as the X posts (breaking.py: big news only, 3 a day)
FINAL_HOURS = 8           # a game that kicked off longer ago than this is old news (GitHub skipped runs)
SOON_MIN = 20             # "Kickoff soon" when the game starts within this many minutes
GAME_TOPICS = ("start", "score", "final")
# New-features alert (Actions > Alerts > Run workflow > announce). Each key goes out once; change the key for the next one.
ANNOUNCE = {"key": "announce:2026-10-06-visualize", "title": "New: make your own charts",
            "body": "Stats > Visualize: chart any stat, any team or player, any weeks. EPA, depth chart roles (WR1, WR2...), radar profiles and more.",
            "url": "/#/stats?show=visualize", "tag": "announce"}


# ---------- the sent log (one Firestore document) ----------
def fid(key, kind="k"):
    """Firestore field name for a key (plain letters/digits, so no quoting in field paths)."""
    return kind + hashlib.sha1(key.encode()).hexdigest()[:20]


class Log:
    """{field: "YYYY-MM-DD|extra"}. Saved with an update mask, so two jobs saving at once never erase each other."""
    def __init__(self, s):
        self.s, self.new, self.today = s, {}, dt.date.today().isoformat()
        self.f = {}
        if s is not None:
            r = s.get(STATE, timeout=30)
            if r.status_code != 404:
                r.raise_for_status()
                self.f = {k: v.get("stringValue", "") for k, v in r.json().get("fields", {}).items()}

    def _get(self, field):
        return self.new.get(field) or self.f.get(field)

    def has(self, key):
        return bool(self._get(fid(key)))

    def add(self, key, extra=""):
        self.new[fid(key)] = f"{self.today}|{extra}"

    def count_today(self, extra):
        return sum(1 for v in {**self.f, **self.new}.values() if v == f"{self.today}|{extra}")

    def last_score(self, game):
        v = self._get(fid(game, "s"))
        return v.split("|", 1)[1] if v else None

    def set_score(self, game, score):
        self.new[fid(game, "s")] = f"{self.today}|{score}"

    def save(self):
        if self.s is None:
            return
        cutoff = (dt.date.today() - dt.timedelta(days=KEEP_DAYS)).isoformat()
        old = [k for k, v in self.f.items() if v[:10] < cutoff and k not in self.new]  # in the mask, not the body = deleted
        fields = list(self.new) + old
        for i in range(0, len(fields), 100):
            chunk = fields[i:i + 100]
            body = {"fields": {k: {"stringValue": self.new[k]} for k in chunk if k in self.new}}
            r = self.s.patch(STATE, params=[("updateMask.fieldPaths", k) for k in chunk], json=body, timeout=30)
            r.raise_for_status()


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
                    ttl=alert.get("ttl", 6 * 3600), timeout=20)
            ok += 1
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # this device is gone: forget it
                s.delete(f"{DOCS}/push/{d['id']}", timeout=20)
                d["gone"] = True
                print(f"   removed a dead device ({code})")
            else:
                print(f"   push failed ({code}): {str(e)[:160]}")
        except Exception as e:  # one bad device never stops the rest
            print(f"   push failed: {str(e)[:160]}")
    return ok


def deliver(s, devs, log, items):
    """items: [(key, topic, teams or None, alert, extra)]. Sends the ones not sent before and logs them."""
    new = [it for it in items if not log.has(it[0])]
    if not new:
        print("Nothing new to send.")
    for key, topic, teams, alert, extra in new:
        targets = [d for d in devs if not d.get("gone") and topic in d["topics"] and (teams is None or d["teams"] & teams)]
        n = send(s, targets, alert) if targets else 0
        print(f"[{key}] {alert['title']} | {alert['body']} -> {n} of {len(targets)} device(s)")
        log.add(key, extra)
    log.save()


# ---------- games ----------
def scoreboard():
    """Today's and yesterday's games (UTC dates, so late-night games are included), both leagues."""
    now = dt.datetime.now(dt.timezone.utc)
    out = []
    for lg, base in ESPN.items():
        seen = set()
        for day in {(now - dt.timedelta(hours=h)).strftime("%Y%m%d") for h in (0, 12)}:
            q = {"dates": day, **({"groups": 80, "limit": 400} if lg == "cfb" else {})}
            try:
                events = requests.get(f"{base}/scoreboard", params=q, timeout=30).json().get("events", [])
            except (requests.RequestException, ValueError) as e:
                print(f"{lg} scores unavailable: {e}")
                continue
            for e in events:
                if e["id"] not in seen and len(e["competitions"][0]["competitors"]) == 2:
                    seen.add(e["id"])
                    out.append((lg, e))
    return out


def live_window(lg, e, now):
    """Is anything about this game worth an alert right now? (cheap check before reading Firestore)"""
    st = e["status"]["type"]
    start = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
    if st.get("state") == "pre":
        return dt.timedelta(0) <= start - now <= dt.timedelta(minutes=SOON_MIN)
    if st.get("state") == "in":
        return True
    return bool(st.get("completed")) and now - start <= dt.timedelta(hours=FINAL_HOURS)


def game_items(games, followed, log):
    """followed: the set of "lg:id" anyone follows (None = every game, for --dry)."""
    now = dt.datetime.now(dt.timezone.utc)
    items = []
    for lg, e in games:
        if not live_window(lg, e, now):
            continue
        comp = e["competitions"][0]
        c = comp["competitors"]                       # ESPN lists home first
        teams = {f"{lg}:{x['team']['id']}" for x in c}
        if followed is not None and not teams & followed:
            continue
        st, gid = e["status"]["type"], f"{lg}:{e['id']}"
        name = lambda x: x["team"].get("shortDisplayName") or x["team"].get("displayName")
        abbr = lambda x: x["team"].get("abbreviation") or name(x)
        rec = lambda x: next((r["summary"] for r in x.get("records", []) if r.get("type") in ("total", None)), "")
        pts = lambda x: int(x.get("score") or 0)
        home, away = c[0], c[1]
        url, tag = f"/#/game/{e['id']}?league={lg}", f"game-{e['id']}"
        tv = ", ".join(n for b in comp.get("broadcasts", []) for n in b.get("names", []))
        start = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))

        # kickoff: ~15 minutes before, or at kickoff if the run before was skipped
        if st.get("state") == "pre" or (st.get("state") == "in" and now - start <= dt.timedelta(minutes=30)):
            soon = st.get("state") == "pre"
            t = start.astimezone(ET)
            when = f"{t.hour % 12 or 12}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'} ET" if soon else ""
            channel = f"on {tv}" if tv else ""
            line1 = " ".join(x for x in (when, channel) if x)
            recs = " · ".join(f"{name(x)} {rec(x)}" for x in (away, home) if rec(x))
            items.append((f"start:{gid}", "start", teams,
                          {"title": f"{'Kickoff soon' if soon else 'Kickoff'}: {name(away)} at {name(home)}",
                           "body": " · ".join(x for x in (line1[:1].upper() + line1[1:], recs) if x),
                           "url": url, "tag": tag, "ttl": 1800}, ""))

        # score changes while it's on
        if st.get("state") == "in":
            cur = f"{pts(home)}-{pts(away)}"
            last = log.last_score(gid) or "0-0"
            if cur != last:
                lh, la = (int(x) for x in last.split("-"))
                dh, da = pts(home) - lh, pts(away) - la
                if dh + da != 1:  # a lone extra point rides along with the next update
                    rh, ra = (d if d >= 2 else 0 for d in (dh, da))  # a leftover extra point doesn't count as "scoring"
                    scorer = home if rh > 0 and ra <= 0 else away if ra > 0 and rh <= 0 else None
                    kind = {3: "field goal", 6: "touchdown", 7: "touchdown", 8: "touchdown"}.get(max(rh, ra)) if scorer else None
                    title = f"{name(scorer)} {kind}" if kind else f"{name(scorer)} scores" if scorer else "Score update"
                    if dh < 0 or da < 0:
                        title = "Score update"  # a score taken off the board (review)
                    items.append((f"score:{gid}:{cur}", "score", teams,
                                  {"title": title, "body": f"{abbr(away)} {pts(away)}, {abbr(home)} {pts(home)} · {st.get('shortDetail', '')}",
                                   "url": url, "tag": tag, "ttl": 1800}, ""))
                    log.set_score(gid, cur)

        # the final
        if st.get("completed"):
            win, lose = sorted(c, key=lambda x: -pts(x))
            tie = pts(win) == pts(lose)
            ot = " (OT)" if "OT" in (st.get("shortDetail") or "") else ""
            body = (f"{name(win)} and {name(lose)} tie." if tie else
                    f"{name(win)}{f' ({rec(win)})' if rec(win) else ''} beat {name(lose)}{f' ({rec(lose)})' if rec(lose) else ''}.")
            items.append((f"final:{gid}", "final", teams,
                          {"title": f"FINAL{ot}: {name(win)} {pts(win)}, {name(lose)} {pts(lose)}",
                           "body": body + " Tap for the box score.", "url": url, "tag": tag}, ""))
    return items


def picks(force=False):
    now = dt.datetime.now(ET)
    if not force and not (now.weekday() == 5 and 21 <= now.hour <= 22):  # Saturday 9-11 PM Eastern; picks lock at 11:59
        return []
    return [(f"picks:{now.date().isoformat()}", "picks", None,
             {"title": "Pick'em locks tonight", "body": "Your picks lock at 11:59 PM Eastern. Get them in!", "url": "/#/picks", "tag": "picks"}, "")]


def from_post(meta_path, log):
    """Bully of the Week (bully.yml, social.yml Thursdays) or breaking news (news.yml), from the X post's meta."""
    try:
        with open(meta_path, encoding="utf-8") as f:
            m = json.load(f)
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
                  "url": f"/#/rankings?league={lg}", "tag": f"bully-{lg}"}, "")]
    if day == "news":  # breaking.py
        if log.count_today("news") >= MAX_NEWS_PER_DAY:
            print("Already sent the most news alerts for today.")
            return []
        return [(m.get("key") or f"news:{text[:80]}", "news", None,
                 {"title": "Breaking", "body": text.lstrip("🚨 "), "url": "/#/news", "tag": "news"}, "news")]
    return []


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["auto", "picks", "post", "test", "list", "announce"])
    ap.add_argument("--meta", help="post: the X post's meta file (out/social/today.json)")
    ap.add_argument("--force", action="store_true", help="picks: send the reminder whatever the time")
    ap.add_argument("--dry", action="store_true", help="show what would be sent, send nothing")
    a = ap.parse_args()

    s = None if a.dry else session()
    if s is None and not a.dry:
        print("Alerts aren't set up yet (VAPID_PRIVATE_KEY / FIREBASE_SERVICE_ACCOUNT secrets missing). Nothing sent.")
        return
    if a.what == "announce":  # everyone with alerts on, whatever topics they picked; only once per key
        log, devs = Log(s), devices(s)
        if log.has(ANNOUNCE["key"]):
            print(f"Already sent {ANNOUNCE['key']}. Change the key in ANNOUNCE to send a new one.")
            return
        alert = {k: v for k, v in ANNOUNCE.items() if k != "key"}
        print(f"{alert['title']} | {alert['body']} -> {send(s, devs, alert)} of {len(devs)} device(s)")
        log.add(ANNOUNCE["key"])
        log.save()
        return
    if a.what in ("list", "test"):
        devs = devices(s)
        if a.what == "list":
            print(f"{len(devs)} device(s) with alerts on")
            for d in devs:  # which push service (web.push.apple.com = iPhone/Mac Safari, fcm = Chrome/Android, windows/mozilla = Edge/Firefox), never the address itself
                host = d["endpoint"].split("/")[2] if d["endpoint"].count("/") > 2 else "?"
                print(f"   {host}: teams {len(d['teams'])}, alerts {', '.join(sorted(d['topics'])) or 'none'}")
            for t in (*GAME_TOPICS, "bully", "picks", "news"):
                print(f"   {t}: {sum(t in d['topics'] for d in devs)}")
        else:
            n = send(s, devs, {"title": "Cupcake Index test alert", "body": "If you can read this, alerts work. 🧁", "url": "/#/settings", "tag": "test"})
            print(f"Test alert sent to {n} of {len(devs)} device(s)")
        return

    devs, log, items = [], Log(None), []
    if a.what == "auto":
        games = scoreboard()
        now = dt.datetime.now(dt.timezone.utc)
        hot = [g for g in games if live_window(*g, now)]
        print(f"{len(games)} games today, {len(hot)} starting soon, on or just finished")
        if hot or picks(a.force):
            if s is not None:
                devs, log = devices(s), Log(s)
            followed = None if a.dry else {t for d in devs if d["topics"] & set(GAME_TOPICS) for t in d["teams"]}
            items = (game_items(hot, followed, log) if followed is None or followed else []) + picks(a.force)
    elif a.what == "picks":
        items = picks(a.force)
        if s is not None:
            devs, log = devices(s), Log(s)
    elif a.what == "post":
        if s is not None:
            log = Log(s)
        items = from_post(a.meta, log) if a.meta else []
        if items and s is not None:
            devs = devices(s)

    if a.dry:
        for key, topic, teams, alert, _ in items:
            print(f"[{key}] {topic} {sorted(teams) if teams else 'everyone'}\n   {alert['title']}\n   {alert['body']}")
        return
    if items:
        deliver(s, devs, log, items)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
