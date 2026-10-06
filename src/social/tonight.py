"""Weeknight game-day post for X: Monday/Thursday night NFL, Tuesday-Friday college (MACtion and friends).

Saturday and Sunday already have game-day posts (render.py). This one runs Monday-Friday afternoons and
only posts when there are games tonight: today's games come from ESPN's scoreboard, the win chances from
our model's predictions in the latest rankings file (matched by ESPN game id). Win chances only, no lines.

    python src/social/tonight.py                    # today (US Eastern)
    python src/social/tonight.py --date 2026-10-01  # pretend it's another day
"""
import argparse
import datetime as dt
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import (vary, ACCENT, BOTTOM, INK, LINE, MUTED, PAD, ROOT, TOP, W, canvas, chance, chip, fit, font,  # noqa: E402
                    is_stale, latest, short, tweet)

ESPN = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"}
try:
    from zoneinfo import ZoneInfo
    EASTERN = ZoneInfo("America/New_York")
except Exception:  # Windows without tz data: daylight time is close enough for a local test
    EASTERN = dt.timezone(dt.timedelta(hours=-4))
SHOWS = {("nfl", 0): "Monday Night Football", ("nfl", 3): "Thursday Night Football"}


def tonight_games(league, day):
    """Today's games (not started yet) that our model has a prediction for: [(prediction, team rows, kickoff)]."""
    params = {"dates": day.strftime("%Y%m%d")}
    if league == "cfb":
        params["groups"] = 80  # FBS
    try:
        events = requests.get(ESPN[league], params=params, timeout=30).json().get("events", [])
    except (requests.RequestException, ValueError) as e:
        print(f"{league}: ESPN scoreboard unavailable ({e})")
        return [], None
    cur, _, _ = latest(league)
    rank = {t["team"]: t for t in cur["teams"]}
    preds = {str(p["espn_id"]): p for p in cur.get("predictions", [])}
    out = []
    for e in events:
        p = preds.get(str(e["id"]))
        if not p or p["home"] not in rank or p["away"] not in rank or e["status"]["type"]["state"] != "pre":
            continue
        kick = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(EASTERN)
        out.append((p, rank, kick))
    return out, cur


def card(day):
    games, curs = [], {}
    for lg in ("nfl", "cfb"):
        g, cur = tonight_games(lg, day)
        games += [(lg,) + x for x in g]
        if cur:
            curs[lg] = cur
    if not games:
        return None
    # NFL first, then the best college matchups (by our rankings)
    games.sort(key=lambda x: (x[0] != "nfl", max(x[2][x[1]["home"]]["power_rank"], x[2][x[1]["away"]]["power_rank"])))
    games = games[:6]
    leagues = sorted({g[0] for g in games}, key=lambda lg: lg != "nfl")
    show = SHOWS.get((games[0][0], day.weekday()))
    title = show or ("Weeknight football" if len(leagues) > 1 or games[0][0] == "cfb" else "Tonight in the NFL")
    img, d = canvas(leagues[0], f"{day:%A} · tonight", title, "Our model's win chances for tonight's games.")
    row_h = (BOTTOM - TOP - 10) // 6
    name_w = 360
    bx0, bx1 = PAD + 70 + name_w + 20, W - PAD - 70 - name_w - 20
    for i, (lg, p, rank, kick) in enumerate(games):
        a, h = rank[p["away"]], rank[p["home"]]
        cy = TOP + i * row_h + row_h // 2
        if i:
            d.line((PAD, TOP + i * row_h, W - PAD, TOP + i * row_h), fill=LINE)
        hp = p["home_win_prob"]
        chip(img, d, a, PAD, cy - 24, 48)
        d.text((PAD + 64, cy - 14), fit(d, short(a["team"], lg), font(26, "Bold"), name_w), font=font(26, "Bold"), fill=INK, anchor="lm")
        d.text((PAD + 64, cy + 18), f"#{a['power_rank']} · {a['record']}", font=font(18), fill=MUTED, anchor="lm")
        chip(img, d, h, W - PAD - 48, cy - 24, 48)
        d.text((W - PAD - 64, cy - 14), fit(d, "@ " + short(h["team"], lg), font(26, "Bold"), name_w), font=font(26, "Bold"), fill=INK, anchor="rm")
        d.text((W - PAD - 64, cy + 18), f"#{h['power_rank']} · {h['record']}", font=font(18), fill=MUTED, anchor="rm")
        split = bx0 + int((bx1 - bx0) * (1 - hp))
        bt, bb = cy - 6, cy + 14
        d.rectangle((bx0, bt, split, bb), fill=ACCENT if hp < 0.5 else (64, 64, 70))
        d.rectangle((split, bt, bx1, bb), fill=ACCENT if hp >= 0.5 else (64, 64, 70))
        d.text((bx0, bt - 8), chance(1 - hp), font=font(20, "Bold"), fill=INK if hp < 0.5 else MUTED, anchor="lb")
        d.text((bx1, bt - 8), chance(hp), font=font(20, "Bold"), fill=INK if hp >= 0.5 else MUTED, anchor="rb")
        d.text(((bx0 + bx1) // 2, bb + 8), f"{kick:%-I:%M %p} ET" if os.name != "nt" else f"{kick:%I:%M %p} ET".lstrip("0"),
               font=font(16, "Bold"), fill=MUTED, anchor="mt")
    lg, p, rank, kick = games[0]
    fav = p["home"] if p["home_win_prob"] >= 0.5 else p["away"]
    pr = max(p["home_win_prob"], 1 - p["home_win_prob"])
    matchup = f"{short(p['away'], lg)} @ {short(p['home'], lg)}"
    if len(games) == 1:
        text = f"{show or 'Tonight'}: {matchup}. Our model likes {short(fav, lg)} at {chance(pr)}. " + vary(["No cupcakes were harmed in this graphic.", "Who you got?", "Upset pick goes in the replies.", "Snacks ready?"], matchup)
    else:
        close = min(games[1:], key=lambda x: abs(x[1]["home_win_prob"] - 0.5))  # a different game than the headliner
        flip = f" Coin flip of the night: {short(close[1]['away'], close[0])} @ {short(close[1]['home'], close[0])}."             if abs(close[1]["home_win_prob"] - 0.5) <= 0.1 else ""
        text = (f"{show or 'Weeknight football'}: {len(games)} games tonight. Headliner: {matchup}, our model likes "
                f"{short(fav, lg)} at {chance(pr)}.{flip}")
    stale = any(is_stale(c, day) for c in curs.values())
    return img, text, stale


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="YYYY-MM-DD (default: today, US Eastern)")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    day = dt.date.fromisoformat(a.date) if a.date else (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).date()
    os.makedirs(a.out, exist_ok=True)
    png = os.path.join(a.out, "tonight.png")
    made = card(day)
    if made:
        img, text, stale = made
        img.convert("RGB").save(png, optimize=True)
        text = tweet(text, "", with_link=False)  # never a link (Terry's rule)
        meta = {"day": "tonight", "stat": f"tonight-{day.isoformat()}", "image": png, "text": text,
                "skip": stale, "reason": "rankings data is stale" if stale else ""}
    else:
        meta = {"day": "tonight", "image": png, "text": "", "skip": True, "reason": f"no games tonight ({day:%A})"}
    print(("SKIP: " + meta["reason"]) if meta["skip"] else f"{png}\n   {meta['text']}")
    for name in ("tonight.json", "today.json"):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
