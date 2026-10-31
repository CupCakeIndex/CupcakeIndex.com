"""Quality check: Claude looks at a post's finished picture and text right before it goes out, and stops it if
something's wrong (Terry, Oct 26: "checks posts before they go out").

It checks:
  - the picture: the right player or team is in the photo (not a field-goal wide shot, a crowd, an ad or a blurry
    frame), logos and colors match the teams named, nothing cut off or garbled
  - the facts: every number and claim in the text agrees with the picture and the facts the post was built from
  - freshness: the last two days of headlines about the teams in it (a starter who's out, a game that moved)
  - Terry's rules: no betting numbers of our own (win chances are fine; books' lines only as a labeled "for fun"
    comparison), no link, at most 280 characters, no em or en dashes
If only the picture is the problem and the post has a plainer back-up card (meta["fallback_image"]), that card is
checked instead. If the check itself fails (no key, API down), the post is skipped (Terry's choice): one missed
post beats a bad one.

Cost: about 2 cents a check on Claude Opus 5.5 at low effort, with the picture shrunk to 1092 px. To stay under $5 a
month (Terry), the checks switch to Claude Sonnet 5.5 (half the price) once this month's checks reach $4.50.
Every check is logged with its cost (ledger.py), and the admin tab shows them.

    python src/social/check_post.py --meta out/social/today.json   # check a rendered post (needs ANTHROPIC_API_KEY)
"""
import argparse
import base64
import datetime as dt
import io
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = Path(__file__).resolve().parent.parent.parent
MODEL, CHEAP = "claude-opus-5-5", "claude-sonnet-5-5"
MONTH_CAP = 4.50  # checks this month past this: CHEAP model for the rest of the month

RULES = """You check posts for @CupcakeIndex, a college football and NFL power-rankings account on X, right before they go out.
Block a post only for a real problem a reader would notice or be misled by:
- picture: the photo doesn't show the player or team the post is about (a kicker's field goal for a defensive back's
  card, a crowd, an empty field, an ad, a press conference of someone else), it's badly blurry, a logo or team color
  belongs to a different team, or text on the card is cut off, overlapping or garbled
- facts: a number or claim in the text disagrees with the card or with the facts given, a team or player is named wrong,
  or the post says something the recent headlines show is no longer true (a starter who is out, a game that moved)
- rules: the account's own betting numbers (its own spread, model line or odds; a win chance or percent is fine, and
  sportsbook lines are fine only labeled "for fun, not betting advice"), a link, an em dash or en dash
A number next to a team on a card is our own Cupcake Index ranking unless it's labeled AP or Coaches. Ours is meant to
differ from the polls in headlines, so that alone is never a problem (Oct 31 2026: game day was blocked for Georgia #7 vs AP No. 3).
Opinions, hot takes, team tags, hashtags and jokes are fine. Don't block for style. When unsure, pass it.
problem: "image" if only the picture is wrong, "text" if only the text is, "both", or "none"."""

SCHEMA = {"type": "object", "properties": {
    "ok": {"type": "boolean"},
    "problem": {"type": "string", "enum": ["none", "image", "text", "both"]},
    "reason": {"type": "string"}},
    "required": ["ok", "problem", "reason"], "additionalProperties": False}


def headlines(text, hours=48):
    """Recent headlines (docs/data/news.json, the hourly news job) that name a team in the post."""
    try:
        news = json.loads((ROOT / "docs" / "data" / "news.json").read_text(encoding="utf-8")).get("items", [])
        teams = json.loads((ROOT / "docs" / "data" / "teams.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    names = set()
    for lg in ("cfb", "nfl"):
        for t in teams.get(lg, []):
            for k in ("school", "name", "mascot"):
                n = (t.get(k) or "").strip()
                if len(n) > 3 and re.search(rf"\b{re.escape(n)}\b", text):
                    names.add(n)
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).isoformat()
    hits = [i for i in news if i.get("published", "") >= cutoff[:19]
            and any(re.search(rf"\b{re.escape(n)}\b", f"{i.get('title', '')} {i.get('summary', '')}") for n in names)]
    return [f"- {i['published'][:16]} {i['title']}: {(i.get('summary') or '')[:200]}" for i in hits[:12]]


def image_block(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    if im.width > 1092:  # about 900 tokens; plenty to read the card
        im = im.resize((1092, round(im.height * 1092 / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(buf.getvalue()).decode()}}


def ask(meta, image):
    """Claude's verdict as {ok, problem, reason}. Raises if there's no answer."""
    import anthropic
    import ledger
    try:
        model = CHEAP if ledger.month_spend("check") >= MONTH_CAP else MODEL
    except Exception as e:  # can't read this month's total: the regular model, still logged
        print(f"Couldn't read this month's check spending ({e}); using {MODEL}.")
        model = MODEL
    news = headlines(meta.get("text", ""))
    facts = meta.get("facts") or meta.get("reason") or ""
    prompt = (f"Today is {dt.date.today():%A, %B %d, %Y}. Post text:\n{meta['text']}\n\n"
              + (f"Facts the post was built from:\n{facts}\n\n" if facts else "")
              + ("Headlines from the last two days about these teams:\n" + "\n".join(news) + "\n\n" if news else "No recent headlines about these teams.\n\n")
              + ("The card that goes with it is attached." if image else "Text-only post, no picture."))
    content = ([image_block(image)] if image else []) + [{"type": "text", "text": prompt}]
    args = dict(model=model, max_tokens=4000, system=RULES, messages=[{"role": "user", "content": content}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}})
    client = anthropic.Anthropic()
    try:  # if the model declines, the API retries it on a fallback model inside the same call
        r = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **args)
    except anthropic.BadRequestError as e:
        print(f"Fallback option not accepted ({e.message[:120]}); checking without it.")
        r = client.messages.create(**args)
    ledger.claude("check", r.model or model, r.usage)
    if r.stop_reason != "end_turn":
        raise RuntimeError(f"the check stopped early ({r.stop_reason})")
    return json.loads(next(b.text for b in r.content if b.type == "text"))


def check(meta):
    """(ok, reason). Picks the back-up card when only the picture failed. Logs every verdict for the admin tab."""
    import fsadmin
    import ledger
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False, "the quality check couldn't run (no ANTHROPIC_API_KEY)"
    image = meta.get("image") or None
    try:
        v = ask(meta, image)
        if not v["ok"] and v["problem"] == "image" and meta.get("fallback_image"):
            print(f"Picture problem ({v['reason']}); checking the back-up card.")
            first = v["reason"]
            image = meta["image"] = meta["fallback_image"]
            v = ask(meta, image)
            if v["ok"]:
                v["reason"] = f"used the back-up card: {first}"
    except Exception as e:
        v = {"ok": False, "problem": "check", "reason": f"the quality check couldn't run ({type(e).__name__}: {str(e)[:150]})"}
    row = {"kind": "check", "what": str(meta.get("stat") or meta.get("day") or ""), "usd": 0, "ok": v["ok"],
           "problem": v["problem"], "reason": v["reason"], "text": meta.get("text", "")[:300]}
    try:
        if image:
            row["img"] = fsadmin.picture(image)
        ledger.add(row)
    except Exception as e:
        print(f"Couldn't log the check: {e}")
    return v["ok"], v["reason"]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--meta", default=os.path.join(ROOT, "out", "social", "today.json"))
    a = ap.parse_args()
    m = json.loads(Path(a.meta).read_text(encoding="utf-8"))
    ok, why = check(m)
    print(("PASS" if ok else "BLOCK") + f": {why}")
