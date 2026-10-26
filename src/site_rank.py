"""Our power ranking exactly as the website shows it (docs/app.js composite + headToHead), for the X posts
(src/social/render.py) and Cupcake Analyst (src/analyst_data.py). Keep in step with app.js."""


def site_rank(week_json, info):
    """Re-rank teams the way the website does (app.js composite + headToHead): the Default weights blend of factor
    scores, inverted factors counting as 100 - score, then the head-to-head swaps. Stored as power_rank so every
    card matches the site."""
    w, inv = info["default_weights"], {f["key"] for f in info["factors"] if f.get("invert")}
    total = sum(w.values())
    val = lambda t, k: 100 - (50 if t["scores"].get(k) is None else t["scores"][k]) if k in inv else (50 if t["scores"].get(k) is None else t["scores"][k])
    comp = {t["team"]: sum(x * val(t, k) for k, x in w.items()) / total if total else t["scores"]["power"] for t in week_json["teams"]}
    order = sorted(week_json["teams"], key=lambda t: (-comp[t["team"]], -t["rating"]))
    for i, t in enumerate(head_to_head(order, comp, week_json.get("league", "cfb"))):
        t["power_rank"] = i + 1
    return week_json


H2H_GAP, H2H_BAD = 5, {"cfb": 50, "nfl": 24}  # same as app.js


def head_to_head(order, comp, lg):
    """app.js headToHead: a team that beat another (more wins than losses against it) moves right above it if its
    blended score is within H2H_GAP, it has no bad loss, and it wouldn't pass a team that beat it. One pass from the top down; each team moves at most once."""
    net, bad = {}, set()
    for t in order:
        for g in t.get("schedule") or []:
            if g.get("result") not in ("W", "L"):
                continue
            if g["result"] == "L" and (g.get("fcs") or (g.get("opp_rank") or 999) > H2H_BAD.get(lg, 50)):
                bad.add(t["team"])
            k = (t["team"], g["opp"])
            net[k] = net.get(k, 0) + (1 if g["result"] == "W" else -1)
    out, moved, i = list(order), set(), 0
    while i < len(out):
        L = out[i]
        for j in range(i + 1, len(out)):
            W = out[j]
            if W["team"] in moved or W["team"] in bad or not net.get((W["team"], L["team"]), 0) > 0 or comp[L["team"]] - comp[W["team"]] > H2H_GAP:
                continue
            if any(net.get((X["team"], W["team"]), 0) > 0 for X in out[i:j]):  # would pass a team that beat it
                continue
            moved.add(W["team"])
            out.pop(j)
            out.insert(i, W)
            i += 1  # L is now one spot lower; carry on below it
            break
        i += 1
    return out
