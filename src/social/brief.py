"""The admin tab's post calendar: this week's scheduled X posts, with a preview of each of today's (Terry, Oct 26:
"a brief for what's going to be posted that day ... each entry clickable so I can preview the post").

Every morning (brief.yml) this makes today's posts the same way the posting jobs will, without posting anything,
and saves the week into Firestore (fsadmin.py: admin_brief/<date>, readable only by the owner account; never in
the public repo). Posts that depend on what happens later (big games, records, news) show as "only if" slots; the
admin tab fills in what actually went out, and what the quality check stopped, from the cost log (ledger.py).
It also copies this month's posts from the posting log into the cost log, so the X cost counts posts from before
the log existed.

    python src/social/brief.py                 # build and save today's brief
    python src/social/brief.py --date 2026-10-27
    python src/social/brief.py --check         # also run the quality check on each preview (costs ~2 cents each)
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fsadmin  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
ET, UTC = ZoneInfo("America/New_York"), dt.timezone.utc
SEASON = {8, 9, 10, 11, 12, 1}
SEPT_ON = {9, 10, 11, 12, 1}

# Each scheduled post, copied from the workflow crons (UTC): (id, kind, title, what it is, UTC hh:mm, cron weekdays
# (0 = Sunday) or None for every day, months, day-of-month rule, preview command or None, only-if)
# kind sets the color: daily, stat, cup, night, tip, game
SLOTS = [
    ("daily", "daily", "Daily post", "Rankings, résumés, Bully or game day (by weekday)", "15:07", None, SEASON, None,
     ["render.py"], False),
    ("stat1", "stat", "Stat / hot take", "Or a take on the day's NFL news, when Claude finds a good one", "17:02", None, SEASON, None,
     ["obscure.py", "--stat", "rotate"], False),
    ("stat2", "stat", "Stat / hot take", "The next stat in the rotation after 1 PM's", "23:02", None, SEASON, None,
     ["obscure.py", "--stat", "rotate"], False),
    ("injuries", "stat", "NFL injury report", "Most banged-up teams, after Friday's final reports", "14:30", {6}, SEPT_ON, None,
     ["obscure.py", "--stat", "nfl_injuries"], False),
    ("frauds", "stat", "NFL Fraud watch", "Weekly, vs ESPN's projections", "18:17", {3}, SEPT_ON, None,
     ["obscure.py", "--stat", "weekly_frauds"], False),
    ("overach", "stat", "NFL Over-achievers", "Weekly", "18:17", {4}, SEPT_ON, None,
     ["obscure.py", "--stat", "weekly_overachievers"], False),
    # cupcake_stats.yml tries these in order; the first one with something new to say posts
    ("cup_wk", "cup", "Cupcake stat", "The strongest one not posted yet", "19:03", {1, 2, 3, 4, 5}, SEASON, None,
     [["cupcake_stats.py", "--stat", "best"]], True),
    ("cup_sat", "cup", "Cupcake stat", "This week's college droughts, before kickoff", "13:30", {6}, SEASON, None,
     [["cupcake_stats.py", "--stat", k] for k in ("week_drought", "series_week", "top10_drought", "best")], True),
    ("cup_sun", "cup", "Cupcake stat", "This week's NFL series and droughts", "13:30", {0}, SEASON, None,
     [["cupcake_stats.py", "--stat", k] for k in ("nfl_series_week", "nfl_playoff_drought", "nfl_primetime_record", "best")], True),
    ("prime", "night", "Prime-time matchup", "Offense + Defense radars, when there's a key night game", "20:00", None, SEASON, None,
     ["primetime.py"], True),
    ("tip", "tip", "Home screen tip", "Plus the stat of the day", "20:04", None, None, "every3", ["app_tip.py"], False),
    ("tonight", "night", "Weeknight game day", "Tonight's games, when there are any", "21:30", {1, 2, 3, 4, 5}, SEASON, None,
     ["tonight.py"], True),
    ("big1", "game", "Big game", "A huge game from today's afternoon games", "21:30", {6, 0}, SEASON, None, None, True),
    ("big2", "game", "Big game", "From the evening games", "01:03", {0, 1}, SEASON, None, None, True),
    ("big3", "game", "Big game", "From the late games", "05:03", {0, 1, 2, 5}, SEASON, None, None, True),
    # these three keep the same Eastern time all year, so the workflows have a summer and a winter cron
    ("pace_cfb", "game", "Historic pace", "College, if someone is near a record", "03:30", {0}, {8, 9, 10}, None, None, True),
    ("pace_cfb", "game", "Historic pace", "College, if someone is near a record", "04:30", {0}, {11, 12, 1}, None, None, True),
    ("pace_nfl", "game", "Historic pace", "NFL, if someone is near a record", "03:45", {1}, {9, 10}, None, None, True),
    ("pace_nfl", "game", "Historic pace", "NFL, if someone is near a record", "04:45", {1}, {11, 12, 1}, None, None, True),
    ("bully", "daily", "College Bully of the Week", "After Saturday's games", "03:41", {0}, {8, 9, 10}, None, None, False),
    ("bully", "daily", "College Bully of the Week", "After Saturday's games", "04:41", {0}, {11, 12, 1}, None, None, False),
]


def occurrences(day):
    """[(slot, kickoff time in Eastern)] for one Eastern date, earliest first."""
    out = []
    for utc_day in (day - dt.timedelta(days=1), day, day + dt.timedelta(days=1)):
        for s in SLOTS:
            sid, kind, title, sub, hm, dows, months, rule, cmd, maybe = s
            h, m = map(int, hm.split(":"))
            t = dt.datetime(utc_day.year, utc_day.month, utc_day.day, h, m, tzinfo=UTC)
            if months and t.month not in months:
                continue
            if dows is not None and (t.weekday() + 1) % 7 not in dows:
                continue
            if rule == "every3" and (t.day - 1) % 3:
                continue
            local = t.astimezone(ET)
            if local.date() == day:
                out.append((s, local))
    return sorted(out, key=lambda x: x[1])


def preview(cmd, out, when, maybe=False):
    """Run a post maker into its own folder; {status, text, img, reason}. cmd can be a list of commands to try in
    order (the first one that makes a post wins). An "only if" slot that makes nothing is "skip", not an error."""
    os.makedirs(out, exist_ok=True)
    meta_path = Path(out) / "today.json"
    for c in (cmd if isinstance(cmd[0], list) else [cmd]):
        meta_path.unlink(missing_ok=True)
        args = [sys.executable, str(ROOT / "src" / "social" / c[0]), *c[1:], "--out", out]
        if c[0] in ("primetime.py", "tonight.py", "render.py"):
            args += ["--date", when.date().isoformat()]
        try:
            r = subprocess.run(args, capture_output=True, text=True, timeout=600, encoding="utf-8", errors="replace")
        except subprocess.TimeoutExpired:
            return {"status": "error", "reason": "the preview took too long"}
        if meta_path.exists():
            break
    if not meta_path.exists():
        tail = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or ["no output"]
        if maybe:
            return {"status": "skip", "reason": tail[0][:200]}
        return {"status": "error", "reason": f"the preview failed: {tail[0][:200]}"}
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("skip"):
        return {"status": "skip", "reason": meta.get("reason") or "nothing to post", "meta": meta}
    got = {"status": "planned", "text": meta.get("text", ""), "meta": meta}
    if meta.get("image") and os.path.exists(meta["image"]):
        got["img"] = fsadmin.picture(meta["image"], 560)
    return got


def fill_x_costs(day):
    """This month's posts from the posting log into the cost log (same ids as post_to_x.py, so nothing counts twice)."""
    import ledger
    rows = json.loads((ROOT / "data" / "social" / "posted.json").read_text(encoding="utf-8"))
    month = day.strftime("%Y-%m")
    done = {r.get("_id"): 1 for r in fsadmin.since("admin_ledger", "at", month + "-01", ["at"])}  # already logged: leave alone
    n = 0
    for r in rows:
        if str(r.get("date", "")).startswith(month) and r.get("text"):
            if not done.get("x-" + ledger.hashlib.sha1(f"{r['date']}|{r['text']}".encode()).hexdigest()[:16]):
                ledger.x_post(r["text"], r["text"], "", date=r["date"], at=r.get("at"), what=str(r.get("stat") or "post"))
                n += 1
    print(f"Cost log: {n} new posts from the posting log")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="YYYY-MM-DD (default: today, Eastern)")
    ap.add_argument("--check", action="store_true", help="also run the quality check on each preview")
    ap.add_argument("--out", default=str(ROOT / "out" / "brief"))
    a = ap.parse_args()
    today = dt.date.fromisoformat(a.date) if a.date else dt.datetime.now(ET).date()
    monday = today - dt.timedelta(days=today.weekday())
    for i in range(7):
        day = monday + dt.timedelta(days=i)
        if day < today:
            continue  # earlier days keep the brief they had
        slots, made = [], {}  # made: slot id -> the preview's post (stat2 leaves out what stat1 picked)
        for (sid, kind, title, sub, *_rest), when in occurrences(day):
            cmd, maybe = _rest[-2], _rest[-1]
            row = {"id": sid, "t": when.strftime("%H:%M"), "kind": kind, "title": title, "sub": sub, "maybe": maybe,
                   "status": "scheduled"}
            if day == today and cmd:
                if sid == "stat2":  # the evening run's own rotation slot, after the 1 PM one
                    cmd = cmd + ["--at", when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M")]
                    cmd += ["--skip", made["stat1"]["stat"]] if made.get("stat1", {}).get("stat") else []
                got = preview(cmd, os.path.join(a.out, sid), when, maybe)
                meta = got.pop("meta", None)
                made[sid] = meta or {}
                row.update(got)
                if a.check and meta and got["status"] == "planned":
                    import check_post
                    ok, why = check_post.check(meta)
                    row["check"] = ("PASS: " if ok else "BLOCK: ") + why
                print(f"{when:%I:%M %p} {title}: {row['status']} {row.get('reason') or row.get('text', '')[:100]}")
            slots.append(row)
        fsadmin.put("admin_brief", day.isoformat(), {"date": day.isoformat(), "built": dt.datetime.now(UTC).isoformat(timespec="minutes"),
                                                     "preview": day == today, "slots": slots})
    try:
        fill_x_costs(today)
    except Exception as e:
        print(f"Couldn't fill in the X costs: {e}")
    print("Brief saved" + (" to Firestore" if fsadmin.session() else " locally (out/admin, no key)"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
