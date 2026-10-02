"""Football trading card releases for the News tab: docs/data/cards.json.

Read once a day from Midwest Cards' public release calendar (https://www.midwestcards.com/release-calendar,
allowed by their robots.txt). Keeps football sets only, folds the box versions of a set (Hobby Box, Mega Box,
Blaster...) into one entry with its earliest date, and keeps sets released in the last 30 days too, so the
News tab can show "just dropped" alongside the countdown to the next one. No prices.

    python src/cards.py
"""
import datetime as dt
import html
import json
import re
from pathlib import Path

import requests

URL = "https://www.midwestcards.com/release-calendar"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "cards.json"
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
BOX = re.compile(r"\s+(?:(?:hobby|jumbo|mega|blaster|value|retail|hanger|fotl|first off the line|choice|h2|monster|cello|fat|super|"
                 r"breaker'?s? delight|tin|collector|sapphire|compact|lite|mini)\s*)*(?:box|pack|case|tin)(?:\s*\(.*\))?$", re.I)


def lines():
    r = requests.get(URL, timeout=60, headers={"User-Agent": "CupcakeIndexBot/1.0 (+https://cupcakeindex.com)"})
    r.raise_for_status()
    s = re.sub(r"<(script|style).*?</\1>", "", r.text, flags=re.S | re.I)
    return [ln.strip() for ln in html.unescape(re.sub(r"<[^>]+>", "\n", s)).split("\n") if ln.strip()]


def parse(ls, today):
    """[(date, brand, product)] for football products, in calendar order (dates carry forward)."""
    out, cur, year = [], None, today.year
    for i, ln in enumerate(ls):
        m = re.match(r"^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$", ln)
        if m:
            year = int(m.group(2))
            continue
        m = re.match(r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2})$", ln)
        if m:
            cur = dt.date(year, MONTHS[m.group(1).lower()], int(m.group(2)))
            continue
        if cur and "football" in ln.lower() and re.match(r"^\d{4}", ln) and len(ln) < 120:
            brand = ls[i - 1] if i and not re.match(r"^(Pre-order|Image coming soon|\$)", ls[i - 1], re.I) else ""
            out.append((cur, brand, ln))
    return out


def main():
    today = dt.date.today()
    sets = {}
    for d, brand, product in parse(lines(), today):
        name = BOX.sub("", product).strip()
        fmt_name = name
        # one entry for school-by-school packs (Onit Athlete lists every university separately)
        m = re.match(r"^(\d{4} .+?) (?:The )?(?:University of |)[A-Z][\w .&'-]*?(?:State )?(?:University )?Football (\w+ Edition)$", name)
        if "University" in name and m:
            name = f"{m.group(1).split(' Black')[0]} college team packs"
        s = sets.setdefault(name, {"set": name, "brand": brand, "date": d, "formats": set()})
        s["date"] = min(s["date"], d)
        fmt = product[len(fmt_name):].strip()
        if fmt:
            s["formats"].add(fmt)
    keep = [s for s in sets.values() if s["date"] >= today - dt.timedelta(days=30)]
    keep.sort(key=lambda s: s["date"])
    # the calendar parks "date to be announced" items on its last date: several sets sharing it = TBA, not a real date
    last = keep[-1]["date"] if keep else None
    tba = last if last and sum(s["date"] == last for s in keep) >= 3 else None
    data = {"updated": today.isoformat(), "source": URL, "source_name": "Midwest Cards release calendar",
            "releases": [{"set": s["set"], "brand": s["brand"], "date": s["date"].isoformat(), "tba": s["date"] == tba,
                          "formats": sorted(s["formats"])} for s in keep]}
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    up = [r for r in data["releases"] if r["date"] >= today.isoformat() and not r["tba"]]
    print(f"{len(data['releases'])} football sets ({len(up)} upcoming) -> {OUT.name}; next: {up[0]['set'] + ' ' + up[0]['date'] if up else 'none'}")


if __name__ == "__main__":
    main()
