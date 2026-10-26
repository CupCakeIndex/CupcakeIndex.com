"""Claude writes the X posts: livelier wording, team @'s and hashtags, and takes angled off the day's news.

Two jobs:
  punch_up(meta)  rewrites a post the other scripts built (post_to_x.py calls it before posting). The numbers
                  can't change: every number in the new text must already be in the old one.
  --take          a new post: today's NFL headlines + where those players and teams rank this season
                  (docs/data/viz). Claude picks the headline and the angle; the numbers must come from the facts.

Needs the GitHub secret ANTHROPIC_API_KEY. Without it (or if Claude's text fails a check) posts still go out:
punch_up() adds the @'s and hashtags itself, and --take exits 1 so the workflow falls back to obscure.py.
Tags come only from handles.py (official team accounts): a guessed @ would tag a stranger, so players never get one.

    python src/social/writer.py --take            # writes out/social/today.json
    python src/social/writer.py --test "text"     # prints a punched-up version (needs the key)
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import handles  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
MODEL = "claude-opus-5-5"
OUT = ROOT / "out" / "social" / "today.json"

STYLE = """Write like a sharp football fan with a stats habit, posting from @CupcakeIndex on X.
- Commit to an opinion and stand behind it. Never end on an either/or question.
- Plain words. No em dashes or en dashes, no colon reveals ("The reason: ..."), no lists of three, no wrap-up line at the end, no stock AI phrasing.
- At most 280 characters, counting every @ and hashtag. No links.
- Tag the official team accounts from the allowed list where a team comes up, and end with one or two hashtags from the allowed list. Never tag a player and never invent a tag.
- Emoji are fine, one at most."""

NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")
TAG = re.compile(r"[@#]\w+")


def nums(text):
    """Every number in the text, tags left out ('@49ers' isn't a stat), commas dropped, trailing .0 ignored."""
    return {n.replace(",", "").removesuffix(".0") for n in NUM.findall(TAG.sub(" ", text or ""))}


def league(meta):
    import feed
    return feed.league_of(meta) or ("nfl" if handles.teams_in(meta.get("text", "")) else "")


def allowed_tags(text, lg):
    """The @'s and hashtags this post may use: its NFL teams' accounts and fan tags, plus the general ones."""
    tags = set(handles.GENERAL)
    if lg == "nfl":  # college teams share NFL nicknames (Pitt Panthers, Boston College Eagles), so only NFL posts get them
        for t in handles.teams_in(text):
            tags.update(handles.NFL[t])
    return tags


def problem(text, allowed, source):
    """Why Claude's text can't go out, or "" if it's fine."""
    from render import x_len
    if not text or not text.strip():
        return "empty"
    if x_len(text) > 280:
        return f"{x_len(text)} characters"
    if "—" in text or "–" in text:
        return "dash"
    if "http" in text.lower() or "www." in text.lower():
        return "link"
    if text.lstrip().startswith("@"):
        return "starts with @ (X would hide it as a reply)"
    bad = [t for t in TAG.findall(text) if t.lower() not in {a.lower() for a in allowed}]
    if bad:
        return "tag not allowed: " + " ".join(bad)
    extra = nums(text) - nums(source)
    if extra:
        return "number not in the facts: " + " ".join(sorted(extra))
    return ""


def ask(system, prompt, schema, effort="medium"):
    """One Claude call with a JSON answer, or None (no key, refused, or any error: the post goes out without it)."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        r = anthropic.Anthropic().messages.create(
            model=MODEL, max_tokens=8000, system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}})
        if r.stop_reason != "end_turn":
            print(f"Claude stopped early ({r.stop_reason}); keeping the original text.")
            return None
        return json.loads(next(b.text for b in r.content if b.type == "text"))
    except Exception as e:
        print(f"Claude call failed ({type(e).__name__}: {e}); keeping the original text.")
        return None


def with_tags(text, lg):
    """The original post plus team @'s and a hashtag, as many as fit in 280."""
    from render import x_len
    teams = handles.teams_in(text) if lg == "nfl" else []
    adds = [handles.NFL[t][0] for t in teams[:2]] + [handles.NFL[t][1] for t in teams[:1]]
    adds.append("#CFB" if lg == "cfb" else "#NFL" if lg == "nfl" else "")
    out = text.rstrip()
    for a in [a for a in adds if a and a.lower() not in text.lower()]:
        if x_len(f"{out} {a}") <= 280:
            out = f"{out}{chr(10) * 2 if out == text.rstrip() else ' '}{a}"
    return out


def punch_up(meta):
    """A better version of meta['text'] for X; never fails (falls back to the original with tags added)."""
    text, lg = meta["text"], league(meta)
    allowed = allowed_tags(text, lg)
    must = "for fun, not betting advice" if "betting advice" in text.lower() else ""
    keep = [k for k in meta.get("keep", []) if k in text]  # words the post asks to keep exactly as written (primetime's "BUT")
    got = ask(STYLE, f"""Rewrite this post so it lands harder and gets people replying. Keep every fact and number exactly as given; add no new numbers or claims.
{f'Keep the words "{must}" in it.' if must else ''}
{''.join(f'Keep the word "{k}" exactly as written, in capitals. ' for k in keep)}
League: {lg.upper() or 'unknown'}
Allowed tags: {' '.join(sorted(allowed))}

Post:
{text}""", {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}, "low")
    new = (got or {}).get("text", "").strip()
    why = problem(new, allowed, text) if new else "no answer"
    if not why and must and must not in new.lower():
        why = "dropped the betting disclaimer"
    if not why and any(k not in new for k in keep):
        why = "dropped " + ", ".join(f'"{k}"' for k in keep if k not in new)
    if why:
        if got:
            print(f"Not using Claude's version ({why}).")
        return with_tags(text, lg)
    return new


# ---- --take: a post angled off today's news ----

BETTING = re.compile(r"\b(odds|spread|betting|bets?|parlay|props?|sportsbook|over/under|moneyline|picks against)\b", re.I)
# (stat, label, higher is better, volume stat that qualifies a player, per position)
P_STATS = {
    "QB": [("pass_yds", "passing yards", 1, "att"), ("pass_td", "TD passes", 1, "att"), ("int", "interceptions thrown", 0, "att"),
           ("pass_epa", "EPA on passes", 1, "att"), ("sacked", "times sacked", 0, "att"), ("rush_yds", "rushing yards by a QB", 1, "att")],
    "RB": [("rush_yds", "rushing yards", 1, "carries"), ("rush_td", "rushing TDs", 1, "carries"),
           ("rush_epa", "EPA on runs", 1, "carries"), ("rec_yds", "receiving yards by a RB", 1, "carries")],
    "WR": [("rec", "catches", 1, "targets"), ("rec_yds", "receiving yards", 1, "targets"), ("rec_td", "TD catches", 1, "targets"),
           ("rec_epa", "EPA as a receiver", 1, "targets"), ("yac", "yards after catch", 1, "targets")],
    "D": [("def_sacks", "sacks", 1, "snaps"), ("tackles", "tackles", 1, "snaps"), ("def_int", "interceptions", 1, "snaps"),
          ("qb_hits", "QB hits", 1, "snaps"), ("tfl", "tackles for loss", 1, "snaps"), ("pd", "passes defended", 1, "snaps")],
}
GROUP = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "WR"}
NOT_D = {"K", "P", "LS", "OT", "OG", "OL", "G", "T", "C"}
T_STATS = [("pts", "points scored", 1), ("opp_pts", "points allowed", 0), ("pass_epa", "EPA passing", 1), ("rush_epa", "EPA running", 1),
           ("opp_epa", "EPA allowed on defense", 0), ("def_sacks", "sacks", 1), ("sacked", "sacks allowed", 0), ("giveaways", "giveaways", 0),
           ("takeaways", "takeaways", 1), ("pen_yds", "penalty yards", 0)]


def fmt(v):
    return f"{v:,.1f}" if isinstance(v, float) and v != int(v) else f"{int(round(v)):,}"


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def ranked(rows, label, who, unit, both):
    """Facts for the subjects in `who` that are top 5 or bottom 3 in this stat. rows: {id: (name, value)}.
    Worded as most/fewest (highest/lowest for EPA) so a low rank never reads as a good one. Bottom 3 only when
    `both`: last in EPA or most picks says something, fewest sacks by a cornerback doesn't."""
    most, fewest = ("highest", "lowest") if "EPA" in label else ("most", "fewest")
    vals, n, out = [v for _, v in rows.values()], len(rows), []
    for pid in who:
        if pid not in rows:
            continue
        name, v = rows[pid]
        tied = " (tied)" if vals.count(v) > 1 else ""
        for word, rank, best in ((most, 1 + sum(x > v for x in vals), max), (fewest, 1 + sum(x < v for x in vals), min)):
            if rank <= (5 if word == most else 3 if both else 0):
                lead = next(nm for nm, x in rows.values() if x == best(vals))
                place = "the" if rank == 1 else f"the {ordinal(rank)}"
                out.append((pid, f"{name}: {fmt(v)} {label}, {place} {word} of {n} {unit} this season{tied}"
                                 + ("" if rank == 1 else f"; {lead} has {fmt(best(vals))}")))
                break
    return out


def season_facts(players, teams):
    """{subject id: [fact text]} for the headline players and teams, from the latest NFL season in docs/data/viz."""
    path = max((ROOT / "docs" / "data" / "viz").glob("nfl_*.json"))
    d = json.loads(path.read_text(encoding="utf-8"))
    pc, tc = {c: i + 3 for i, c in enumerate(d["pcols"])}, {c: i + 3 for i, c in enumerate(d["tcols"])}
    facts = {}

    tot, games = {}, {}
    for r in d["prows"]:
        t = tot.setdefault(r[0], {c: 0.0 for c in pc})
        for c, i in pc.items():
            if isinstance(r[i], (int, float)):
                t[c] += r[i]
        games[r[0]] = games.get(r[0], 0) + 1
    for grp, stats in P_STATS.items():
        ids = [p for p in tot if p in d["pmeta"] and GROUP.get(d["pmeta"][p][1], "D" if d["pmeta"][p][1] not in NOT_D else "") == grp]
        for key, label, hi, vol in stats:
            top = max((tot[p][vol] for p in ids), default=0)
            pool = {p: (d["pmeta"][p][0], round(tot[p][key], 1)) for p in ids if top and tot[p][vol] >= 0.4 * top}
            for pid, f in ranked(pool, label, players, {"QB": "QBs", "RB": "running backs", "WR": "receivers", "D": "defenders"}[grp],
                                 not hi or "EPA" in label):
                facts.setdefault(f"p{pid}", []).append(f)

    tt = {}
    for r in d["trows"]:
        t = tt.setdefault(r[0], {"w": 0, "l": 0, "giveaways": 0.0, "takeaways": 0.0, **{k: 0.0 for k, _, _ in T_STATS if k in tc}})
        for k in t:
            if k in tc and isinstance(r[tc[k]], (int, float)):
                t[k] += r[tc[k]]
        t["giveaways"] += (r[tc["int"]] or 0) + (r[tc["fum_lost"]] or 0)
        t["takeaways"] += (r[tc["def_int"]] or 0) + (r[tc["def_fr"]] or 0)
        if r[tc["pts"]] != r[tc["opp_pts"]]:
            t["w" if r[tc["pts"]] > r[tc["opp_pts"]] else "l"] += 1
    for tid in teams:
        if tid in tt:
            name = d["teams"][tid][0]
            facts.setdefault(f"t{tid}", []).append(f"{name}: {tt[tid]['w']}-{tt[tid]['l']} this season")
    for key, label, hi in T_STATS:
        pool = {t: (d["teams"][t][0], round(v[key], 1)) for t, v in tt.items() if key in v}
        for tid, f in ranked(pool, label, teams, "teams", True):
            facts.setdefault(f"t{tid}", []).append(f)
    return facts, d["season"]


def headlines(hours=36):
    news = json.loads((ROOT / "docs" / "data" / "news.json").read_text(encoding="utf-8"))
    cut = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).isoformat()
    return [it for it in news["items"] if it.get("league") == "nfl" and it.get("published", "") >= cut
            and not BETTING.search(it["title"] + " " + (it.get("summary") or ""))]


def take():
    import feed
    import posted
    names = feed.nfl_players()
    used = posted.recent_keys(14)
    items, facts, hl_subjects = [], {}, {}
    for it in headlines():
        txt = it["title"] + " " + (it.get("summary") or "")
        players = {key.split(":")[1] for rx, key, _ in names if rx.search(txt)}
        items.append((it, players, set(it.get("teams") or [])))
    if not items:
        sys.exit("No fresh NFL headlines to build a take on.")
    facts, season = season_facts(set().union(*(p for _, p, _ in items)), set().union(*(t for _, _, t in items)))
    lines, fid, by_id = [], 0, {}
    for i, (it, players, teams) in enumerate(items):
        subj = [f"p{p}" for p in players] + [f"t{t}" for t in teams]
        fl = [(s, f) for s in subj for f in facts.get(s, [])]
        if not fl or any(f"take:{s}" in used for s in subj[:1]):
            continue
        lines.append(f"\nHEADLINE h{i}: {it['title']}" + (f"\n  ({it['summary'][:300]})" if it.get("summary") else ""))
        for s, f in fl:
            fid += 1
            by_id[f"f{fid}"] = (s, f)
            lines.append(f"  f{fid}: {f}")
        hl_subjects[f"h{i}"] = (it, subj)
        if len(hl_subjects) >= 12:
            break
    if not hl_subjects:
        sys.exit("No headline had a player or team with a standout stat.")
    allowed = set(handles.GENERAL)
    for it, _ in hl_subjects.values():
        allowed |= allowed_tags(it["title"], "nfl")
    for s, f in by_id.values():
        allowed |= allowed_tags(f, "nfl")
    schema = {"type": "object", "properties": {"candidates": {"type": "array", "items": {"type": "object", "properties": {
        "text": {"type": "string"}, "headline_id": {"type": "string"}, "fact_ids": {"type": "array", "items": {"type": "string"}}},
        "required": ["text", "headline_id", "fact_ids"], "additionalProperties": False}}},
        "required": ["candidates"], "additionalProperties": False}
    got = ask(STYLE, f"""Here are today's NFL headlines, each with stats from the {season} season about the players and teams in it.
Write 3 posts, best first, each from a different headline. Each one ties the news to a stat that makes people think twice about the story, then takes a side. Use only numbers from the facts you cite or the headline itself; season ranks are this season only.
Allowed tags: {' '.join(sorted(allowed))}
{chr(10).join(lines)}""", schema)
    if not got:
        sys.exit("No take from Claude.")
    for c in got.get("candidates", []):
        hid, text = c.get("headline_id"), (c.get("text") or "").strip()
        cited = [by_id[f] for f in c.get("fact_ids", []) if f in by_id]
        if hid not in hl_subjects or not cited:
            print(f"Skipping a take (no headline or facts cited): {text}")
            continue
        it, subj = hl_subjects[hid]
        source = " ".join([it["title"], it.get("summary") or "", str(season)] + [f for _, f in cited])
        why = problem(text, allowed, source)
        meta = {"text": text, "image": None, "skip": False, "reason": "", "league": "nfl", "stat": "take",
                "key": f"take:{cited[0][0]}"}
        why = why or posted.repeat(meta)
        if why:
            print(f"Skipping a take ({why}): {text}")
            continue
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({**meta, "written": True}, indent=1), encoding="utf-8")
        print(f"Take on \"{it['title']}\":\n{text}")
        return
    sys.exit("None of Claude's takes passed the checks.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--take", action="store_true")
    ap.add_argument("--test", help="punch up this text and print it")
    ap.add_argument("--league", default="")
    ap.add_argument("--facts", action="store_true", help="print the --take facts without calling Claude")
    a = ap.parse_args()
    if a.test:
        print(punch_up({"text": a.test, "league": a.league}))
    elif a.facts:
        import feed
        names = feed.nfl_players()
        hs = headlines()
        ps = {k.split(":")[1] for it in hs for rx, k, _ in names if rx.search(it["title"] + " " + (it.get("summary") or ""))}
        f, _ = season_facts(ps, {t for it in hs for t in it.get("teams") or []})
        for s, fl in f.items():
            print(s, *fl, sep="\n  ")
    elif a.take:
        take()
