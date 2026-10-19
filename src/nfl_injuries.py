"""The NFL's official injury report (nfl.com/injuries, the same report each team site shows) -> docs/data/nfl_injuries.json.

ESPN's injury feed lags the official game statuses (Trey Amos stayed "Injured Reserve" on ESPN after Washington
listed him Questionable), so the site's Injuries views use this report's game status when a team's game hasn't
been played yet. Run every 10 minutes by .github/workflows/nfl_injuries.yml. Browsers can't read nfl.com directly (CORS).
If the page changes or can't be read, the old file is left alone and the site falls back to ESPN.
"""
import html
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "nfl_injuries.json"
URL = "https://www.nfl.com/injuries/"
ET = ZoneInfo("America/New_York")
MONTHS = {m: i + 1 for i, m in enumerate(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
                                          "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"])}


def text(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse(page):
    m = re.search(r"Week (\d+) of the (\d{4}) Season", page)
    week, season = (int(m.group(1)), int(m.group(2))) if m else (None, datetime.now().year)
    teams, day, clock = {}, None, None
    # walk the page in order: day headings, kickoff times, then a team name followed by its table
    tok = re.compile(r'<h2[^>]*>\s*([A-Z]+DAY), ([A-Z]+) (\d+)[A-Z]*\s*</h2>'
                     r'|date-time">([^<]*)</span>\s*<span class="nfl-c-matchup-strip__date-timezone">([^<]*)'
                     r'|section-sub-title"><span>([^<]*)</span>(?:(?!section-sub-title).)*?(<tbody>.*?</tbody>|</table>)', re.S)
    for t in tok.finditer(page):
        if t.group(1):
            mon = MONTHS[t.group(2)]
            day = (season + (mon < 8), mon, int(t.group(3)))  # Jan/Feb games belong to the season that started before
        elif t.group(4):
            hm = datetime.strptime(t.group(4).strip(), "%I:%M %p")
            clock = (hm.hour, hm.minute)
        elif t.group(6) and day and clock:
            kick = datetime(*day, *clock, tzinfo=ET).astimezone(timezone.utc)
            players = []
            for row in re.findall(r"<tr>(.*?)</tr>", t.group(7), re.S):
                cells = [text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
                if len(cells) == 5 and cells[0]:
                    players.append(cells)  # name, position, injury, practice status, game status ("" = no designation)
            teams[text(t.group(6))] = {"kickoff": kick.strftime("%Y-%m-%dT%H:%MZ"), "players": players}
    return {"season": season, "week": week, "teams": teams}


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            data = parse(r.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - keep the old file
        print(f"NFL injury report unavailable: {e}")
        return
    if len(data["teams"]) < 10:
        print(f"NFL injury report: only {len(data['teams'])} teams parsed, keeping the old file")
        return
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    if {k: v for k, v in old.items() if k != "updated"} == data:
        print("NFL injury report unchanged")
        return
    data = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), **data}
    OUT.write_text(json.dumps(data, separators=(",", ":")))
    print(f"NFL injury report: week {data['week']}, {len(data['teams'])} teams")


if __name__ == "__main__":
    main()
