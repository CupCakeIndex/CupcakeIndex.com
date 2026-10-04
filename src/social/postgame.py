"""Postgame "big game" posts for X: after a batch of games, the best individual stat line (if any is big enough)
gets a card with an action shot from that game and his line, and one post.

What counts: a monster line, e.g. 400 passing yards (450 in college), 175 rushing or receiving (college 225 / 200),
3+ total TDs (college 4), 3 sacks, 2 picks. Only the best one per run; each player/game posts once.
Action shot: a still from one of the game's ESPN highlight clips that names the player; else a recap photo whose
caption names him; else his headshot.

    python src/social/postgame.py                       # games that finished in the last 9 hours, both leagues
    python src/social/postgame.py --league nfl --hours 72 --out DIR   # test on older games

Runs from .github/workflows/postgame.yml after each window of games. No link, 280 characters max.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import obscure as O
import posted
import render as R
from render import ROOT, hex_rgb, tweet

W, H = 1600, 900
SITE = {"nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
        "cfb": "https://site.api.espn.com/apis/site/v2/sports/football/college-football"}
# a line is "big" when any of these is reached (ratio >= 1); the best line is the one with the most big-ish numbers
BIG = {"nfl": {"pass_yds": 400, "pass_td": 5, "rush_yds": 175, "rush_td": 3, "rec_yds": 175, "rec_td": 3, "rec": 13,
               "scrim": 225, "tds": 3, "sacks": 3, "def_int": 2, "tackles": 16},
       "cfb": {"pass_yds": 450, "pass_td": 6, "rush_yds": 225, "rush_td": 4, "rec_yds": 200, "rec_td": 3, "rec": 14,
               "scrim": 275, "tds": 4, "sacks": 3, "def_int": 2, "tackles": 17}}
HEAD = {"pass_yds": "PASSING YARDS", "pass_td": "PASSING TDS", "rush_yds": "RUSHING YARDS", "rush_td": "RUSHING TDS",
        "rec_yds": "RECEIVING YARDS", "rec_td": "RECEIVING TDS", "rec": "CATCHES", "scrim": "YARDS FROM SCRIMMAGE",
        "tds": "TOUCHDOWNS", "sacks": "SACKS", "def_int": "INTERCEPTIONS", "tackles": "TACKLES"}


def num(v):
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return 0.0


def lines(summary):
    """Every player's line in a game: {athlete id: {name, team id, pic, stats...}} from the ESPN box score."""
    out = {}
    for side in (summary.get("boxscore") or {}).get("players", []):
        tid = str(side["team"]["id"])
        for c in side.get("statistics", []):
            keys = c.get("keys") or []
            for a in c.get("athletes", []):
                ath = a["athlete"]
                p = out.setdefault(str(ath["id"]), {"id": str(ath["id"]), "name": ath.get("displayName", ""), "last": ath.get("lastName", ""),
                                                    "tid": tid, "pic": (ath.get("headshot") or {}).get("href"), "s": {}})
                st = dict(zip(keys, a.get("stats", [])))
                s = p["s"]
                if c["name"] == "passing":
                    s["cmp_att"] = st.get("completions/passingAttempts", "")
                    s["pass_yds"], s["pass_td"], s["int_thrown"] = num(st.get("passingYards")), num(st.get("passingTouchdowns")), num(st.get("interceptions"))
                elif c["name"] == "rushing":
                    s["car"], s["rush_yds"], s["rush_td"] = num(st.get("rushingAttempts")), num(st.get("rushingYards")), num(st.get("rushingTouchdowns"))
                elif c["name"] == "receiving":
                    s["rec"], s["rec_yds"], s["rec_td"], s["long"] = num(st.get("receptions")), num(st.get("receivingYards")), num(st.get("receivingTouchdowns")), num(st.get("longReception"))
                elif c["name"] == "defensive":
                    s["tackles"], s["sacks"], s["def_td"] = num(st.get("totalTackles")), num(st.get("sacks")), num(st.get("defensiveTouchdowns"))
                elif c["name"] == "interceptions":
                    s["def_int"] = num(st.get("interceptions"))
    for p in out.values():
        s = p["s"]
        s["scrim"] = s.get("rush_yds", 0) + s.get("rec_yds", 0)
        s["tds"] = s.get("rush_td", 0) + s.get("rec_td", 0)
    return out


def grade(p, league):
    """(score, headline key) — score >= 1 on the headline means it's a big game."""
    r = {k: p["s"].get(k, 0) / v for k, v in BIG[league].items()}
    if p["s"].get("pass_yds", 0) >= 100:  # a QB's rushing/receiving TDs aren't "touchdowns" here; his passing TDs carry it
        r["tds"] = 0
    top = max(r, key=r.get)
    return (r[top] + 0.35 * sum(v for k, v in r.items() if k != top and v >= 0.5), top) if r[top] >= 1 else (0, None)


def tiles(s):
    """The stat boxes on the card, by role: [(label, value)]."""
    f = lambda v: f"{v:,.0f}" if v == int(v) else f"{v:.1f}"
    if s.get("pass_yds", 0) >= 100:
        t = [("C/ATT", s.get("cmp_att", "")), ("YDS", f(s["pass_yds"])), ("TD", f(s.get("pass_td", 0))), ("INT", f(s.get("int_thrown", 0)))]
        if s.get("rush_yds", 0) >= 40 or s.get("rush_td", 0):
            t.append(("RUSH", f"{f(s['rush_yds'])}" + (f" · {f(s['rush_td'])} TD" if s.get("rush_td") else "")))
        return t
    if s.get("sacks", 0) >= 2 or s.get("def_int", 0) >= 2 or s.get("tackles", 0) >= 12:
        return [(k, f(s.get(x, 0))) for k, x in (("TACKLES", "tackles"), ("SACKS", "sacks"), ("INT", "def_int"), ("DEF TD", "def_td"))]
    if s.get("rush_yds", 0) >= s.get("rec_yds", 0):
        t = [("CAR", f(s.get("car", 0))), ("YDS", f(s["rush_yds"])), ("TD", f(s.get("rush_td", 0)))]
        if s.get("rec_yds", 0) >= 30:
            t.append(("REC YDS", f(s["rec_yds"])))
        return t
    return [("REC", f(s.get("rec", 0))), ("YDS", f(s["rec_yds"])), ("TD", f(s.get("rec_td", 0))), ("LONG", f(s.get("long", 0)))]


def phrase(s):
    """The stat line in words: '11 catches, 247 yards, 3 TDs'."""
    n = lambda v, one, many: f"{v:,.0f} {one if v == 1 else many}" if v == int(v) else f"{v:.1f} {many}"
    if s.get("pass_yds", 0) >= 100:
        out = [f"{s.get('cmp_att', '')} for {s['pass_yds']:,.0f} yards", n(s.get("pass_td", 0), "TD", "TDs")]
        if s.get("int_thrown"):
            out.append(n(s["int_thrown"], "INT", "INTs"))
        if s.get("rush_yds", 0) >= 40 or s.get("rush_td"):
            out.append(f"plus {s['rush_yds']:,.0f} rushing yards" + (f" and {n(s['rush_td'], 'rushing TD', 'rushing TDs')}" if s.get("rush_td") else ""))
        return ", ".join(out)
    if s.get("sacks", 0) >= 2 or s.get("def_int", 0) >= 2 or s.get("tackles", 0) >= 12:
        return ", ".join(x for x in [n(s.get("tackles", 0), "tackle", "tackles"), s.get("sacks") and n(s["sacks"], "sack", "sacks"),
                                     s.get("def_int") and n(s["def_int"], "interception", "interceptions")] if x)
    if s.get("rush_yds", 0) >= s.get("rec_yds", 0):
        out = [n(s.get("car", 0), "carry", "carries"), f"{s['rush_yds']:,.0f} yards", n(s.get("rush_td", 0), "TD", "TDs")]
        if s.get("rec_yds", 0) >= 30:
            out.append(f"plus {n(s.get('rec', 0), 'catch', 'catches')} for {s['rec_yds']:,.0f}")
        return ", ".join(out)
    return ", ".join([n(s.get("rec", 0), "catch", "catches"), f"{s['rec_yds']:,.0f} yards", n(s.get("rec_td", 0), "TD", "TDs")])


def action_shot(summary, p):
    """A photo of him from this game: a recap photo whose caption names him (real game photography), else a still
    from a highlight clip that names him (bottom trimmed: TV tickers live there), else None (headshot card)."""
    last = re.escape(p["last"] or p["name"].split()[-1])
    named = lambda t: bool(re.search(rf"\b{last}\b", t or "", re.I))
    vids = [v for v in summary.get("videos") or [] if named(v.get("headline")) and v.get("thumbnail")]
    vids.sort(key=lambda v: not re.search(r"touchdown|td\b|score", v.get("headline", ""), re.I))  # a scoring play first
    pics = []
    for a in [summary.get("article") or {}, *((summary.get("news") or {}).get("articles") or [])]:
        pics += [(i["url"], False) for i in a.get("images", []) if i.get("url") and named(i.get("caption"))]
    pics += [(v["thumbnail"], True) for v in vids]
    for u, still in pics:
        im = O.image(u)
        if im and im.width >= 500:
            return im.crop((0, 0, im.width, round(im.height * 0.8))) if still else im
    return None


def games(league, hours):
    """Finished games that kicked off in the last `hours` hours."""
    now = dt.datetime.now(dt.timezone.utc)
    days = {(now - dt.timedelta(hours=h)).strftime("%Y%m%d") for h in (0, hours, hours / 2)}
    out = {}
    for d in days:
        q = f"dates={d}" + ("&groups=80&limit=400" if league == "cfb" else "")
        for e in O._session.get(f"{SITE[league]}/scoreboard?{q}", timeout=30).json().get("events", []):
            start = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
            if e["status"]["type"].get("completed") and now - start <= dt.timedelta(hours=hours):
                out[e["id"]] = e
    return list(out.values())


def best(leagues, hours):
    done = {x.get("stat") for x in posted.load()}
    picks = []
    for lg in leagues:
        for e in games(lg, hours):
            s = O._session.get(f"{SITE[lg]}/summary?event={e['id']}", timeout=30).json()
            comp = s["header"]["competitions"][0]
            for p in lines(s).values():
                sc, top = grade(p, lg)
                key = f"biggame:{lg}:{e['id']}:{p['id']}"
                if sc and key not in done:
                    picks.append((sc, lg, p, top, comp, s, key))
    picks.sort(key=lambda x: -x[0])
    return picks


def card(lg, p, top, comp, photo, theme):
    T = {k: hex_rgb(v) for k, v in O.THEMES[theme].items() if isinstance(v, str) and v.startswith("#")}
    F = lambda size, weight="Regular": O.font_for(theme, size, weight)
    me = next(c for c in comp["competitors"] if str(c["team"]["id"]) == p["tid"])
    opp = next(c for c in comp["competitors"] if c is not me)
    team_col = hex_rgb("#" + (me["team"].get("color") or "555555"), (90, 90, 96))
    img = Image.new("RGBA", (W, H), T["bg"] + (255,))
    # the action shot fills the left side and fades into the background under the stats
    if photo:
        ph = photo.convert("RGBA")
        sc = max(1060 / ph.width, H / ph.height)
        ph = ph.resize((round(ph.width * sc), round(ph.height * sc)), Image.LANCZOS)
        ph = ph.crop(((ph.width - 1060) // 2, (ph.height - H) // 2, (ph.width - 1060) // 2 + 1060, (ph.height - H) // 2 + H))
        fade = Image.new("L", (1060, H), 255)
        fd = ImageDraw.Draw(fade)
        for x in range(700, 1060):
            fd.line((x, 0, x, H), fill=round(255 * (1 - (x - 700) / 360) ** 1.6))
        ph.putalpha(fade)
        img.alpha_composite(ph, (0, 0))
        tint = Image.new("RGBA", (W, 160), (0, 0, 0, 0))  # dark band at the top so the brand reads on any photo
        td = ImageDraw.Draw(tint)
        for y in range(160):
            td.line((0, y, 1060, y), fill=(0, 0, 0, round(150 * (1 - y / 160))))
        img.alpha_composite(tint, (0, 0))
    else:
        head = O.image(p.get("pic"))
        ImageDraw.Draw(img).rectangle((0, 0, 700, H), fill=O.mix(team_col, T["bg"], 0.5))
        if head:
            head.thumbnail((640, 640), Image.LANCZOS)
            img.alpha_composite(head, ((700 - head.width) // 2, H - head.height))
    d = ImageDraw.Draw(img)
    d.rectangle((0, H - 10, 1060, H), fill=team_col)
    bf = F(26, "Bold")
    d.text((48, 40), ">", font=bf, fill=T["accent"])
    d.text((76, 40), "CUPCAKE", font=bf, fill=(255, 255, 255))
    d.text((76 + d.textlength("CUPCAKE", font=bf), 40), "_INDEX", font=bf, fill=T["accent"])
    d.text((48, 76), "cupcakeindex.com", font=F(18), fill=(225, 225, 225))

    x0, xr = 900, W - 60
    tag_f = F(20, "Bold")
    x = x0
    for label, solid in ((lg.upper(), False), ("BIG GAME", True)):
        tw = d.textlength(label, font=tag_f)
        if solid:
            d.rectangle((x, 44, x + tw + 28, 80), fill=T["accent"])
            d.text((x + 14, 49), label, font=tag_f, fill=T["bg"])
        else:
            d.rectangle((x, 44, x + tw + 28, 80), outline=T["accent"], width=2)
            d.text((x + 14, 49), label, font=tag_f, fill=T["accent"])
        x += tw + 40
    y = 110
    nf = F(54, "ExtraBold")
    for ln in O.wrap(d, p["name"], nf, xr - x0, 2):
        d.text((x0, y), ln, font=nf, fill=T["ink"])
        y = d.textbbox((x0, y), ln, font=nf)[3] + 10
    d.text((x0, y + 4), f"{me['team'].get('abbreviation', '')}", font=F(22, "Bold"), fill=T["muted"])
    y += 44
    won = me.get("winner")
    final = f"{'W' if won else 'L'} {me.get('score')}-{opp.get('score')} {'vs' if me.get('homeAway') == 'home' else '@'} {opp['team'].get('abbreviation', '')} · FINAL"
    d.text((x0, y), final, font=F(22, "Bold"), fill=T["accent"] if won else T["muted"])
    y += 64
    big = f"{p['s'][top]:,.0f}" if p["s"][top] == int(p["s"][top]) else f"{p['s'][top]:.1f}"
    bigf = F(150, "ExtraBold")
    d.text((x0, y), big, font=bigf, fill=T["accent"])
    by = d.textbbox((x0, y), big, font=bigf)[3]
    d.text((x0, by + 12), HEAD[top], font=F(22, "Bold"), fill=T["muted"])
    y = by + 70
    ts = tiles(p["s"])
    tw = (xr - x0 - 12 * (len(ts) - 1)) / len(ts)
    for i, (lab, val) in enumerate(ts):
        tx = x0 + i * (tw + 12)
        d.rectangle((tx, y, tx + tw, y + 104), fill=T["panel"], outline=T["line"], width=2)
        d.text((tx + tw / 2, y + 40), R.fit(d, str(val), F(36, "ExtraBold"), tw - 16), font=F(36, "ExtraBold"), fill=T["ink"], anchor="mm")
        d.text((tx + tw / 2, y + 80), lab, font=F(16, "Bold"), fill=T["muted"], anchor="mm")
    R.draw_motto(d, xr, H - 60, 17, T["ink"], T["muted"], T["accent"], right=True, font_for=F)
    return img


def make(pick, out, theme=None):
    sc, lg, p, top, comp, s, key = pick
    me = next(c for c in comp["competitors"] if str(c["team"]["id"]) == p["tid"])
    opp = next(c for c in comp["competitors"] if c is not me)
    nm = lambda c: c["team"].get("location") if lg == "cfb" else c["team"].get("name") or c["team"].get("displayName")
    res = f"{'win over' if me.get('winner') else 'loss to'} {nm(opp)}"
    text = f"{p['name']} ({me['team'].get('abbreviation', '')}) went off: {phrase(p['s'])} in {nm(me)}'s {me.get('score')}-{opp.get('score')} {res}."
    theme = theme or O.random.choice(list(O.THEMES))
    os.makedirs(out, exist_ok=True)
    png = os.path.join(out, f"postgame-{lg}-{p['id']}.png")
    card(lg, p, top, comp, action_shot(s, p), theme).convert("RGB").save(png, optimize=True)
    return {"day": "postgame", "stat": key, "theme": theme, "image": png, "text": tweet(text, "", with_link=False), "skip": False, "reason": ""}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--league", choices=["both", "nfl", "cfb"], default="both")
    ap.add_argument("--hours", type=float, default=9, help="games that kicked off this many hours ago or less")
    ap.add_argument("--theme", choices=["random", *O.THEMES], default="random")
    ap.add_argument("--top", type=int, default=1, help="render the best N (tests); only the best one becomes today.json")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "social"))
    a = ap.parse_args()
    picks = best(["nfl", "cfb"] if a.league == "both" else [a.league], a.hours)
    if not picks:
        print("No big games this time. Nothing to post.")
        return
    for i, pk in enumerate(picks[:a.top]):
        m = make(pk, a.out, None if a.theme == "random" else a.theme)
        print(f"[{pk[1]} {pk[0]:.2f}] {m['image']} ({len(m['text'])} chars)\n   {m['text']}")
        if i == 0:
            with open(os.path.join(a.out, "today.json"), "w", encoding="utf-8") as fh:
                json.dump(m, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
