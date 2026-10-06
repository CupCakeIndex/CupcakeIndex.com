"""Every X post, saved on the site too: docs/data/takes.json (the Takes page, and the Takes tab on team and player pages).

post_to_x.py calls add() right after a post goes out. Each post gets its time, text, card picture (a smaller JPEG copy
in docs/takes/) and the teams and players it's about, so a team or player page can show the posts about them.
save_log.sh commits the file and pictures with the posting log.

Left out: breaking news (the News tab already has it), app tips, and the betting hot takes (anything that says
"betting advice"): Terry's rule is no betting-style numbers from the site itself.

    python src/social/feed.py --test out/social/today.json   # what add() would save, without saving
    python src/social/feed.py --merge OTHER.json              # save_log.sh: two posts at once
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "docs" / "data" / "takes.json"
PICS = ROOT / "docs" / "takes"
KEEP = 300          # posts kept on the site (about two months)
PIC_WIDTH = 720     # the X card is 1200 wide; this is plenty for a phone and keeps the repo small
SKIP_DAYS = {"news", "app_tip"}


def load(path=OUT):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"teams": {}, "players": {}, "items": []}


def save(d):
    d["items"] = sorted(d["items"], key=lambda x: x["time"], reverse=True)[:KEEP]
    used_t = {k for it in d["items"] for k in it.get("teams", [])}
    used_p = {k for it in d["items"] for k in it.get("players", [])}
    d["teams"] = {k: v for k, v in d["teams"].items() if k in used_t}
    d["players"] = {k: v for k, v in d["players"].items() if k in used_p}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(d, indent=1, ensure_ascii=False), encoding="utf-8")
    # pictures of posts that fell off the end
    keep = {Path(it["image"]).name for it in d["items"] if it.get("image")}
    for f in PICS.glob("*.jpg"):
        if f.name not in keep:
            f.unlink()


def league_of(meta):
    if meta.get("league") in ("cfb", "nfl"):
        return meta["league"]
    s = " ".join(str(meta.get(k) or "") for k in ("day", "stat", "key")).lower()
    return "cfb" if "cfb" in s or "college" in s else "nfl" if "nfl" in s else ""


def nfl_players():
    """[(regex, key, name)] for current NFL players, longest name first. Names two players share are left out."""
    try:
        rows = json.loads((ROOT / "docs" / "data" / "players_nfl.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    yr = max((r[4] for r in rows), default=0)
    names = {}
    for name, pid, _pos, _first, last in rows:
        if last >= yr - 1 and " " in name:
            names.setdefault(name, []).append(pid)
    out = [(re.compile(r"(?<![\w'])" + re.escape(n) + r"(?![\w'])"), f"nfl:{ids[0]}", n) for n, ids in names.items() if len(ids) == 1]
    return sorted(out, key=lambda x: -len(x[2]))


def tags(meta, lg):
    """-> (teams {key: {name, short, logo}}, players {key: name}) this post is about."""
    sys.path.insert(0, str(ROOT / "src"))
    import news
    teams, pats = news.build_teams()
    text = meta.get("text", "")
    tk = news.tag_teams(text, lg, pats)
    players = dict(meta.get("players") or {})          # obscure.py: the leader on the card
    if lg != "cfb":
        s = text
        for rx, key, name in nfl_players():
            if rx.search(s):
                players.setdefault(key, name)
                s = rx.sub(" ", s)
    return {k: {x: teams[k][x] for x in ("name", "short", "logo")} for k in tk if k in teams}, players


def picture(src, stamp):
    """A smaller JPEG copy of the card in docs/takes/; returns its path on the site."""
    if not src or not os.path.exists(src):
        return None
    from PIL import Image
    PICS.mkdir(parents=True, exist_ok=True)
    im = Image.open(src).convert("RGB")
    if im.width > PIC_WIDTH:
        im = im.resize((PIC_WIDTH, round(im.height * PIC_WIDTH / im.width)), Image.LANCZOS)
    name = f"{stamp}.jpg"
    im.save(PICS / name, "JPEG", quality=80, optimize=True, progressive=True)
    return f"takes/{name}"


def entry(meta, tweet_id=None, dry=False):
    if meta.get("skip") or not meta.get("text") or meta.get("day") in SKIP_DAYS:
        return None
    if "betting advice" in meta["text"].lower():
        return None
    now = dt.datetime.now(dt.timezone.utc)
    lg = league_of(meta)
    teams, players = tags(meta, lg)
    lg = lg or next((k.split(":")[0] for k in [*teams, *players]), "")
    stamp = now.strftime("%Y%m%d-%H%M%S")
    return {"id": str(tweet_id or stamp), "time": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "league": lg, "stat": meta.get("stat") or meta.get("day") or "", "text": " ".join(meta["text"].split()),
            "image": (meta.get("image") or None) if dry else picture(meta.get("image"), stamp),
            "x": f"https://x.com/i/web/status/{tweet_id}" if tweet_id else "",
            "teams": list(teams), "players": list(players)}, teams, players


def add(meta, tweet_id=None):
    got = entry(meta, tweet_id)
    if not got:
        return
    it, teams, players = got
    d = load()
    d["items"] = [x for x in d["items"] if x["id"] != it["id"]] + [it]
    d["teams"].update(teams)
    d["players"].update(players)
    save(d)
    print(f"Saved to the Takes page ({len(it['teams'])} team(s), {len(it['players'])} player(s))")


def merge(other_path):
    """Add the posts from another copy of the file that this one is missing (save_log.sh)."""
    d, o = load(), load(other_path)
    have = {x["id"] for x in d["items"]}
    d["items"] += [x for x in o["items"] if x["id"] not in have]
    d["teams"] = {**o.get("teams", {}), **d["teams"]}
    d["players"] = {**o.get("players", {}), **d["players"]}
    save(d)


def backfill():
    """One time: the posts already in data/social/posted.json (a date but no time or picture saved back then)."""
    sys.path.insert(0, str(ROOT / "src"))
    import news
    teams, pats = news.build_teams()
    import posted
    d = load()
    have = {x["id"] for x in d["items"]}
    for i, r in enumerate(posted.load()):
        meta = {"day": r.get("stat", ""), "stat": r.get("stat", ""), "key": r.get("key", ""), "text": r.get("text", "")}
        if not meta["text"] or "betting advice" in meta["text"].lower() or r.get("stat", "").startswith(("news", "app_tip", "tip")):
            continue
        rid = f"old-{r['date']}-{i}"
        if rid in have:
            continue
        lg = league_of(meta)
        tk = [k for k in news.tag_teams(meta["text"], lg, pats) if k in teams]
        pl = {}
        if lg != "cfb":
            s = meta["text"]
            for rx, key, name in nfl_players():
                if rx.search(s):
                    pl.setdefault(key, name)
                    s = rx.sub(" ", s)
        lg = lg or next((k.split(":")[0] for k in [*tk, *pl]), "")
        d["items"].append({"id": rid, "time": f"{r['date']}T12:00:{i % 60:02d}Z", "date_only": True, "league": lg, "stat": meta["stat"],
                           "text": " ".join(meta["text"].split()), "image": None, "x": "", "teams": tk, "players": list(pl)})
        d["teams"].update({k: {x: teams[k][x] for x in ("name", "short", "logo")} for k in tk})
        d["players"].update(pl)
    save(d)
    print(f"{len(d['items'])} posts on the Takes page")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) == 3 and sys.argv[1] == "--merge":
        merge(sys.argv[2])
    elif sys.argv[1:] == ["--backfill"]:
        backfill()
    elif len(sys.argv) == 3 and sys.argv[1] == "--test":
        with open(sys.argv[2], encoding="utf-8") as f:
            print(json.dumps(entry(json.load(f), dry=True), indent=1, ensure_ascii=False))
    else:
        print(__doc__)
