"""Portal watch: college players most likely to enter the transfer portal, and the schools they'd fit. The college
version of Trade watch (src/trade_watch.py), with the reasons players actually transfer in place of contracts.

How it works (free data only: our college stats, ESPN rosters, our models, Google News):
  1. Rosters (ESPN): every FBS player's position and class. Seniors and grad students are mostly out of eligibility.
  2. Role, from our weekly stats (share of his team's attempts / carries / targets, his production vs every FBS player
     at his position):
       moving up     a standout at a Group of 5 school (top quarter at his position); bigger programs recruit them
       wants snaps   a backup (under 35% of the work) who's efficient with what he gets; QBs, RBs, WRs and TEs only,
                     since our defensive numbers can't tell a backup from a starter
       starter       everyone else with a real role; starters leave too, mostly after a coaching change
  3. Situation: his coach's chance of being out (our Hot seat model; a new coach sets off transfers) and his team's bowl
     chance (10,000 simulations of the rest of the season from our win chances; a lost season frees players up).
  4. Portal talk: headlines from the last 3 weeks naming him next to a portal word. Players who say they'll redshirt and
     transfer (a mid-season move since the 4-game redshirt rule) are tagged Announced and go to the top.
  5. Score = situation x role x class x position, plus talk on its own: 0.35 x log2(1 + headlines).
  6. Best fits: for a mover-up, Power 4 teams whose unit at his position ranks low; for anyone else, any FBS team with a
     weak unit there; plus headlines that name him with a school.

Writes docs/data/cfb/portal_watch.json. Usage: python src/portal_watch.py [--no-talk]
"""
import datetime as dt
import glob
import json
import math
import os
import random
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trade_watch import name_rx  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs", "data")
OUT = os.path.join(DOCS, "cfb", "portal_watch.json")
CACHE = os.path.join(ROOT, "data", "raw", "cfb")
WINDOW = "2027-01-02"  # the January window's expected first day; update when the NCAA posts the 2027 dates
SIMS = 10000
UA = {"User-Agent": "CupcakeIndex/1.0 (https://cupcakeindex.com)"}
P4 = {"SEC", "Big Ten", "Big 12", "ACC"}
GROUP = {"QB": "QB", "RB": "RB", "FB": "RB", "WR": "WR", "TE": "TE", "OT": "OL", "OG": "OL", "G": "OL", "T": "OL", "C": "OL", "OL": "OL", "IOL": "OL",
         "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL", "EDGE": "DL", "LB": "LB", "OLB": "LB", "ILB": "LB", "MLB": "LB",
         "CB": "DB", "S": "DB", "SAF": "DB", "FS": "DB", "SS": "DB", "DB": "DB", "NB": "DB"}
UNIT = {"QB": "PASS", "WR": "PASS", "TE": "PASS", "RB": "RUN", "OL": "RUN", "DL": "RUND", "LB": "RUND", "DB": "PASSD"}
UNIT_TXT = {"PASS": "passing offense", "RUN": "run game", "RUND": "run defense", "PASSD": "pass defense"}
CLASS = {"FR": 0.8, "SO": 1.0, "JR": 0.9, "SR": 0.4, "GR": 0.2}
CLASS_TXT = {"FR": "Freshman", "SO": "Sophomore", "JR": "Junior", "SR": "Senior", "GR": "Grad student"}
POSF = {"QB": 1.25, "RB": 1.0, "WR": 1.0, "TE": 0.9, "OL": 0.9, "DL": 0.9, "LB": 0.9, "DB": 0.9}


def latest_week(season):
    files = glob.glob(os.path.join(DOCS, "cfb", str(season), "week_*.json"))
    return max(files, key=lambda p: int(re.findall(r"(\d+)\.json", p)[0]))


def bowl_chances(teams):
    """{team: chance of 6+ wins} from SIMS runs of the remaining games (our win chances)."""
    games, seen = [], set()
    for t in teams:
        for g in t["schedule"]:
            if g.get("upcoming") and g.get("win_prob") is not None and g["espn_id"] not in seen:
                seen.add(g["espn_id"])
                games.append((t["team"], g["opp"], g["win_prob"]))
    w0 = {t["team"]: t["wins"] for t in teams}
    hit = dict.fromkeys(w0, 0)
    rnd = random.Random(7)
    for _ in range(SIMS):
        w = dict(w0)
        for a, b, p in games:
            if rnd.random() < p:
                w[a] += 1
            elif b in w:
                w[b] += 1
        for n in w0:
            hit[n] += w[n] >= 6
    return {n: hit[n] / SIMS for n in w0}


def rosters(team_ids, season):
    """{espn player id: (position group, position, class, jersey)} for every FBS roster (ESPN), cached for 3 days."""
    f = os.path.join(CACHE, f"rosters_{season}.json")
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 3 * 86400:
        return json.load(open(f, encoding="utf-8"))
    out = {}
    for tid in team_ids:
        for _ in range(3):
            try:
                r = requests.get(f"https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{tid}/roster", timeout=20)  # this host refuses our UA string
                if r.ok:
                    for grp in r.json().get("athletes", []):
                        for a in grp.get("items", []):
                            pos = (a.get("position") or {}).get("abbreviation", "")
                            cls = (a.get("experience") or {}).get("abbreviation", "")
                            out[str(a["id"])] = [GROUP.get(pos, ""), pos, cls, a.get("jersey", "")]
                    break
            except requests.RequestException:
                pass
            time.sleep(1)
        time.sleep(0.1)
    if len(out) < 1000:
        raise SystemExit(f"Only {len(out)} roster players came back from ESPN; not saving.")
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(f, "w", encoding="utf-8"))
    return out


TALK = re.compile(r"transfer portal|\bportal\b|\btransfer(s|ring|red)?\b|redshirt|leav(e|es|ing) the (program|team)|step(s|ping)? away|"
                  r"no longer (with|on) the team|part(s|ed)? ways|depart(s|ure|ing)?\b|dismiss", re.I)
# he's the one leaving: his name, then (within a few words) the move. "ESPN star implores Arch Manning to enter the portal" is a pitch.
SAID_VERB = (r"(?:enters?|entered|entering|is entering|has entered|will enter|to enter|plans to enter|intends to enter|intentions to enter|"
             r"will transfer|plans to transfer|intends to transfer|to transfer|leaves (?:the )?program|leaving (?:the )?program|will redshirt|to redshirt)")
MAYBE = re.compile(r"\?|\b(could|might|should|would|if|candidates?|predict\w*|watch list|names to watch|possible|possibility|potential|rumou?rs?|"
                   r"implores?|urges?|floats?|options?|destinations?|landing|emerging|odds|why|how)\b", re.I)


def said_he_leaves(titles, name):
    n = name_rx(name).pattern
    rx = re.compile(rf"{n}(?:'s|’s)?,?\s+(?:[\w,'’-]+\s+){{0,6}}?{SAID_VERB}\b", re.I)
    hits = [t for t in titles if rx.search(t) and not MAYBE.search(t) and TALK.search(t)]
    return hits if len(hits) >= 2 else []  # two outlets saying it, not one pitch


def headlines(schools):
    """Portal-ish headlines from the last 21 days: [(title, link)], deduped."""
    import html
    qs = ["college football transfer portal", "transfer portal quarterback", "enter the transfer portal football",
          "redshirt transfer portal football", "plans to transfer football", "college football player leaves team"]
    qs += [f"{s} football transfer portal" for s in schools]
    seen, out = set(), []
    for q in qs:
        try:
            r = requests.get("https://news.google.com/rss/search", params={"q": f"{q} when:21d", "hl": "en-US", "gl": "US", "ceid": "US:en"},
                             headers={"User-Agent": "Mozilla/5.0 (compatible; CupcakeIndex/1.0; +https://cupcakeindex.com)"}, timeout=20)
            r.raise_for_status()
            r.encoding = "utf-8"
        except requests.RequestException:
            continue
        for item in re.findall(r"<item>(.*?)</item>", r.text, re.S):
            t = re.search(r"<title>(.*?)</title>", item, re.S)
            l = re.search(r"<link>(.*?)</link>", item, re.S)
            if not t:
                continue
            title = html.unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))).strip()
            title = re.sub(r"\s+-\s+[^-]+$", "", title)
            k = title.lower()
            if k in seen or not TALK.search(title):
                continue
            seen.add(k)
            out.append((title, html.unescape(l.group(1).strip()) if l else ""))
        time.sleep(0.3)
    return out


def main():
    viz = json.load(open(os.path.join(DOCS, "viz", "index.json")))
    season = max(viz["cfb"])
    rk = json.load(open(latest_week(season), encoding="utf-8"))
    bowl = bowl_chances(rk["teams"])
    rinfo = {t["team"]: t for t in rk["teams"]}
    V = json.load(open(os.path.join(DOCS, "viz", f"cfb_{season}.json"), encoding="utf-8"))
    teams = {k: v for k, v in V["teams"].items() if v[0] in rinfo}  # FBS teams we rank
    name = {k: v[0] for k, v in teams.items()}
    conf = {k: v[3] for k, v in teams.items()}
    p4 = {k for k in teams if conf[k] in P4 or name[k] == "Notre Dame"}
    coaches = json.load(open(os.path.join(DOCS, "coaches.json"), encoding="utf-8"))["cfb"]["coaches"]
    seat = {c["tm"]: (c["n"], c["hs"]["p"]) for c in coaches if c.get("on") and c.get("hs")}

    # team totals and units, ranked 1 (best) .. N
    tc = {c: i + 3 for i, c in enumerate(V["tcols"])}
    T = {}
    for r in V["trows"]:
        if r[0] not in teams:
            continue
        s = T.setdefault(r[0], {"g": 0})
        s["g"] += 1
        for c, i in tc.items():
            s[c] = s.get(c, 0) + (r[i] or 0)
    metric = {"PASS": (lambda s: s["pass_yds"] / max(1, s["att"]), 1), "RUN": (lambda s: s["rush_yds"] / max(1, s["carries"]), 1),
              "RUND": (lambda s: s["opp_rush_yds"] / s["g"], -1), "PASSD": (lambda s: s["opp_pass_yds"] / s["g"], -1)}
    rank = {u: {k: i + 1 for i, k in enumerate(sorted(T, key=lambda k: -sign * f(T[k])))} for u, (f, sign) in metric.items()}
    NT = len(T)
    rating = {k: rinfo[name[k]]["rating"] for k in T}
    rmin, rmax = min(rating.values()), max(rating.values())

    # players on their current team
    pc = {c: i + 3 for i, c in enumerate(V["pcols"])}
    P = {}
    for r in V["prows"]:
        pid, team = r[0], r[2]
        m = V["pmeta"].get(pid)
        if not m or team != m[2] or team not in teams:
            continue
        s = P.setdefault(pid, {"g": 0})
        s["g"] += 1
        for c, i in pc.items():
            s[c] = s.get(c, 0) + (r[i] or 0)
    dtk = {}
    for pid, s in P.items():
        t = V["pmeta"][pid][2]
        dtk[t] = dtk.get(t, 0) + s.get("tackles", 0)
    R = rosters(sorted({k.split(":")[1] for k in teams}), season)
    print(f"{len(R)} roster players, {len(P)} with stats")

    def vol(g, s):
        if g == "QB":
            return s["pass_yds"] + s["rush_yds"]
        if g == "RB":
            return s["rush_yds"] + s["rec_yds"]
        if g in ("WR", "TE"):
            return s["rec_yds"]
        return s["tackles"] + 2 * s["tfl"] + 3 * s["def_sacks"] + 2 * s["pd"] + 4 * s["def_int"] + s["qb_hits"]

    def share(g, s, t):
        tt = T[t]
        return {"QB": s["att"] / max(1, tt["att"]), "RB": s["carries"] / max(1, tt["carries"]), "WR": s["targets"] / max(1, tt["att"]),
                "TE": s["targets"] / max(1, tt["att"])}.get(g, s["tackles"] / max(1, dtk.get(t, 1)) * 11)

    def eff(g, s):
        if g == "QB":
            return s["pass_yds"] / s["att"] if s["att"] >= 15 else None
        if g == "RB":
            return s["rush_yds"] / s["carries"] if s["carries"] >= 15 else None
        if g in ("WR", "TE"):
            return s["rec_yds"] / s["targets"] if s["targets"] >= 10 else None
        return None

    rows = []
    for pid, s in P.items():
        g, pos, cls, jersey = (R.get(pid) or ["", "", "", ""])
        if not g:
            continue
        rows.append({"id": pid, "name": V["pmeta"][pid][0], "g": g, "pos": pos, "cls": cls, "team": V["pmeta"][pid][2], "s": s,
                     "vol": vol(g, s), "share": share(g, s, V["pmeta"][pid][2]), "eff": eff(g, s)})
    # percentiles within each position group (players with half the games of the busiest)
    for gname in {r["g"] for r in rows}:
        grp = [r for r in rows if r["g"] == gname]
        mg = max(r["s"]["g"] for r in grp)
        q = sorted(r["vol"] for r in grp if r["s"]["g"] >= mg / 2)
        e = sorted(r["eff"] for r in grp if r["eff"] is not None)
        for r in grp:
            r["vpct"] = sum(1 for x in q if x <= r["vol"]) / max(1, len(q))
            r["epct"] = sum(1 for x in e if x <= r["eff"]) / max(1, len(e)) if r["eff"] is not None else None

    cache = os.environ.get("PW_NEWS_CACHE")
    if cache and os.path.exists(cache):
        news = json.load(open(cache, encoding="utf-8"))
    else:
        news = [] if "--no-talk" in sys.argv else headlines(sorted(name.values()))
        if cache:
            json.dump(news, open(cache, "w", encoding="utf-8"))
    print(f"{len(news)} portal headlines")

    # the schools a headline names, longest name first, so "Ohio State" isn't also "Ohio"
    by_len = sorted(T, key=lambda k: -len(name[k]))
    rx_school = {k: re.compile(rf"(?<!\w){re.escape(name[k])}(?!\w)") for k in T}
    memo = {}

    def schools_in(title):
        if title not in memo:
            taken, hit = [], set()
            for k in by_len:
                for m in rx_school[k].finditer(title):
                    if not any(a <= m.start() < b for a, b in taken):
                        taken.append((m.start(), m.end()))
                        hit.add(k)
            memo[title] = hit
        return memo[title]

    out = []
    for r in rows:
        t, g, s = r["team"], r["g"], r["s"]
        talk = [h for h in news if name_rx(r["name"]).search(h[0])] if len(r["name"]) > 7 else []
        said_t = set(said_he_leaves([h[0] for h in talk], r["name"]))
        said = [h for h in talk if h[0] in said_t]
        up = max(0, (r["vpct"] - 0.75) / 0.25) if t not in p4 else 0
        snaps = 0
        if g in ("QB", "RB", "WR", "TE") and r["share"] < 0.35 and r["epct"] is not None and r["epct"] >= 0.5:
            snaps = (1 - r["share"] / 0.35) * r["epct"]
        starter = 0.3 if (r["share"] >= 0.35 or r["vpct"] >= 0.5) else 0.1
        role = max(up, snaps, starter)
        kind = "up" if role == up and up > 0 else "snaps" if role == snaps and snaps > 0 else "starter"
        coach, hp = seat.get(name[t], (None, 0.1))
        bp = bowl.get(name[t], 0.5)
        sit = (0.6 + 0.8 * hp) * (1 + 0.3 * (1 - bp))
        clsf = CLASS.get(r["cls"], 0.6)
        posf = POSF.get(g, 0.9)
        deal = sit * role * clsf * posf
        tk = 0.35 * math.log2(1 + len(talk))
        score = deal + tk + (2 if said else 0)
        if score < 0.15 and not talk:
            continue
        why = []
        if said:
            why.append("says he'll transfer")
        elif talk:
            why.append(f"{len(talk)} portal headline{'s' if len(talk) > 1 else ''} in 3 weeks")
        if kind == "up":
            why.append(f"top {max(1, round(100 * (1 - r['vpct'])))}% of FBS {g}s at a Group of 5 school")
        elif kind == "snaps":
            why.append(f"a backup ({round(100 * r['share'])}% of the work) who's been efficient")
        if hp >= 0.35:
            why.append(f"coach {round(100 * hp)}% likely out")
        if bp < 0.5:
            why.append(f"{round(100 * bp)}% bowl chance")
        if r["cls"] in CLASS_TXT:
            why.append(CLASS_TXT[r["cls"]].lower())
        u = UNIT.get(g)
        fits = []
        if u:
            for k in T:
                if k == t or (kind == "up" and k not in p4):
                    continue
                linked = sum(1 for h in talk if k in schools_in(h[0]))
                need = (rank[u][k] - 1) / (NT - 1)
                pull = (rating[k] - rmin) / max(1e-9, rmax - rmin)
                fits.append((need * (0.4 + 0.6 * pull if kind == "up" else 0.7 + 0.3 * pull) + 0.6 * math.log2(1 + linked), k, linked))
            fits = [[k.split(":")[1], f"#{rank[u][k]} {UNIT_TXT[u]} of {NT}" + (f", {n} headline{'s' if n > 1 else ''} link{'' if n > 1 else 's'} them" if n else ""), n]
                    for _, k, n in sorted(fits, reverse=True)[:3]]
        out.append({"id": r["id"], "name": r["name"], "pos": r["pos"] or g, "group": g, "cls": r["cls"], "team": t.split(":")[1], "kind": kind,
                    "share": round(r["share"], 3), "pct": round(r["vpct"], 2), "games": s["g"], "said": bool(said), "talk": len(talk),
                    "story": list((said or talk)[0]) if talk else None, "stories": [list(h) for h in (said + [x for x in talk if x not in said])[:8]],
                    "score": round(score, 4), "why": why, "fits": fits,
                    "parts": {"talk": round(min(1, tk / 1.6), 2), "coach": round(hp, 2), "bowl": round(bp, 2), "role": round(role, 2),
                              "cls": clsf, "position": posf, "deal": round(deal, 3)}})
    out.sort(key=lambda x: -x["score"])
    out = out[:100]
    top = max((x["score"] for x in out if not x["said"]), default=1)
    for x in out:
        x["tier"] = "Announced" if x["said"] else "Likely" if x["score"] >= 0.6 * top else "Possible" if x["score"] >= 0.3 * top else "Long shot"
        x["score"] = min(100, round(100 * x["score"] / top))
    # each team: its units from worst to best, the listed players it'd go after, and its own players at risk
    team_view = {}
    for k in T:
        needs = sorted(UNIT_TXT, key=lambda u: -rank[u][k])
        tg = []
        for i, x in enumerate(out):
            if x["team"] == k.split(":")[1] or x["group"] not in UNIT or (x["kind"] == "up" and k not in p4):
                continue
            u = UNIT[x["group"]]
            linked = next((f[2] for f in x["fits"] if f[0] == k.split(":")[1]), 0)
            tg.append((x["score"] * (0.25 + (rank[u][k] - 1) / (NT - 1)) + 30 * math.log2(1 + linked), i, u))
        tg.sort(reverse=True)
        team_view[k] = {"needs": [[UNIT_TXT[u], rank[u][k]] for u in needs], "targets": [[i, f"their {UNIT_TXT[u]} ranks #{rank[u][k]} of {NT}"] for _, i, u in tg[:10]]}
    data = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "season": season, "window": WINDOW, "sims": SIMS, "n": NT,
            "teams": {k.split(":")[1]: {"name": name[k], "conf": conf[k], "p4": k in p4, "record": rinfo[name[k]]["record"], "bowl": round(bowl.get(name[k], 0), 3),
                                        "coach": seat.get(name[k], [None])[0], "seat": round(seat.get(name[k], (None, 0))[1], 3), **team_view[k]} for k in T},
            "players": out}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out)} players -> {OUT} ({os.path.getsize(OUT) // 1024} KB)")
    for x in out[:15]:
        print(f"  {x['score']:3} {x['tier']:9} talk {x['talk']:2} {x['name']} {x['pos']} {x['cls']} {data['teams'][x['team']]['name']} {x['kind']} -> {', '.join(data['teams'][f[0]]['name'] for f in x['fits'])}")


if __name__ == "__main__":
    sys.exit(main())
