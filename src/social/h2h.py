"""Last 5 meetings for every pair of teams, for the game page ("Last 5 meetings" card).

NFL: nflverse games since 1999 (same cached file as nfl_facts.py; Oakland/San Diego/St. Louis count as today's teams).
College: our game history since 1979 (data/history/cfb, from cupcake_history.py), FBS and FCS opponents both.
Written to docs/data/nfl/h2h.json and docs/data/cfb/h2h/<first letter>.json: {"Team A|Team B" (sorted): [[date, home, away, home pts, away pts, note], ...]}
newest first, plus each pair's all-time record in the data ("rec": {"Team A|Team B": [A wins, B wins, ties]}).

    python src/social/h2h.py
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import nfl_facts as NF  # noqa: E402

ROOT = HERE.parent.parent
KEEP = 5
NFL_ROUND = {"WC": "Wild Card", "DIV": "Divisional", "CON": "Conf. title", "SB": "Super Bowl"}


def build(games, out_path, split=False):
    """games: (date, home, away, hp, ap, note), any order. split: one file per first letter of the pair key
    (out_path is then a folder: h2h/a.json holds every pair whose first team starts with A)."""
    pairs, rec = {}, {}
    for g in sorted(games, key=lambda g: g[0], reverse=True):
        a, b = sorted((g[1], g[2]))
        k = f"{a}|{b}"
        pairs.setdefault(k, [])
        if len(pairs[k]) < KEEP:
            pairs[k].append(list(g) if g[5] else list(g[:5]))
        r = rec.setdefault(k, [0, 0, 0])
        win = g[1] if g[3] > g[4] else g[2] if g[4] > g[3] else None
        r[0 if win == a else 1 if win == b else 2] += 1
    groups = {}
    for k in pairs:
        groups.setdefault(letter(k) if split else "", []).append(k)
    if split:
        out_path.mkdir(parents=True, exist_ok=True)
    for grp, keys in groups.items():
        f = out_path / f"{grp}.json" if split else out_path
        f.write_text(json.dumps({"games": {k: pairs[k] for k in keys}, "rec": {k: rec[k] for k in keys}},
                                separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(pairs)} pairs -> {out_path.relative_to(ROOT)} ({len(groups)} file(s))")


def letter(key):
    """File group for a pair key (the site's game page does the same: first letter, a-z, else "0")."""
    c = key[:1].lower()
    return c if "a" <= c <= "z" else "0"


def nfl():
    rows, abbr_name = NF.load()
    names = {t: n for t, n in abbr_name.items() if t not in NF.FRANCHISE}
    full = lambda t: names.get(NF.FRANCHISE.get(t, t), t)
    games = []
    for r in rows:
        if r["home_score"] == "" or r["away_score"] == "":
            continue
        notes = [NFL_ROUND[r["game_type"]]] if r["game_type"] in NFL_ROUND else []
        if r["location"] == "Neutral":
            notes.append("neutral site")
        notes += [f"as the {NF.OLD_NAME[t]} {full(t).split()[-1]}" for t in (r["home_team"], r["away_team"]) if t in NF.OLD_NAME]
        games.append((r["gameday"], full(r["home_team"]), full(r["away_team"]), int(r["home_score"]), int(r["away_score"]), ", ".join(notes)))
    build(games, ROOT / "docs" / "data" / "nfl" / "h2h.json")


def cfb():
    games = []
    for f in sorted((ROOT / "data" / "history" / "cfb").glob("*.json")):
        for x in json.loads(f.read_text(encoding="utf-8"))["games"]:
            if x.get("hp") is None or x.get("ap") is None or not x.get("d"):
                continue
            notes = (["bowl/playoff"] if x.get("p") else []) + (["neutral site"] if x.get("n") else [])
            games.append((x["d"], x["h"], x["a"], x["hp"], x["ap"], ", ".join(notes)))
    build(games, ROOT / "docs" / "data" / "cfb" / "h2h", split=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    nfl()
    cfb()
