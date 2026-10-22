"""How our stats work, for Cupcake Analyst's "how_we_count" lookup (analyst/index.html), so a reply about OUR stat
says what it really counts instead of guessing.

GLOSSARY is written from the code that builds each stat (file named in "src"); keep it in step when a rule changes.
build() adds the model's factor help (model.py) and every Stats > Visualize stat label (docs/viz.js).
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GLOSSARY = {
    "points erased by penalties": {
        "counts": "Scores taken off the board by the SCORING team's own accepted foul on the scoring play itself: the play-by-play says "
                  "\"TOUCHDOWN NULLIFIED\", \"FIELD GOAL IS GOOD, NULLIFIED\" or \"SAFETY NULLIFIED\". Any foul type counts (holding, offensive "
                  "pass interference, illegal formation, illegal use of hands...). TD = 6, FG = 3, safety = 2. The player charged is the one "
                  "flagged on that play.",
        "doesnt_count": "Offsetting penalties (the down is replayed). A defensive foul on a made field goal (the kicking team chose the yards). "
                        "Fouls earlier in the drive. Defensive fouls like DPI that HELPED a score (that's the other team's foul). Points the "
                        "drive scored later anyway are not subtracted.",
        "src": "src/deep_stats.py (tp_ptsnull, pn_ptsnull); every play is listed in the rare_plays lookup (type wiped_score)"},
    "penalties": {"counts": "Accepted penalties only (declined and offsetting don't count), by nflverse penalty type, charged to the flagged player "
                            "and his team; also split by the unit (offense, defense, special teams).", "src": "src/deep_stats.py"},
    "success rate": {"counts": "A play is a success if it gains 40%+ of the yards needed on 1st down, 60%+ on 2nd, or converts on 3rd/4th. Lost fumbles are failures.",
                     "src": "src/deep_stats.py failed()"},
    "run stop": {"counts": "A defender credited with a tackle (solo or assisted) on a run that failed by the success-rate rule. Close to PFF's run stop.",
                 "src": "src/deep_stats.py"},
    "stuff": {"counts": "A run that gained 0 yards or lost yards. Defender stuffs: he made the tackle. RB stuffed %: his carries that gained 0 or less.",
              "src": "src/deep_stats.py"},
    "short yardage": {"counts": "3rd or 4th down with 2 or fewer yards to go; converted = a success by the success-rate rule.", "src": "src/deep_stats.py"},
    "3rd down (player)": {"counts": "QB 3rd-down conversion % and receiver 3rd-down numbers include 4th downs too (down 3 or later).", "src": "src/deep_stats.py"},
    "red zone": {"counts": "Plays snapped at the opponent's 20 or closer. Goal line = the 5 or closer.", "src": "src/deep_stats.py"},
    "clutch": {"counts": "QB dropbacks in the 4th quarter or overtime with the score within 8 points (one score).", "src": "src/deep_stats.py"},
    "deep / short throws": {"counts": "Deep = 20+ air yards. Short (pass defense) = 5 air yards or less. Air yards = how far past the line of scrimmage the ball was thrown.",
                            "src": "src/deep_stats.py"},
    "big plays": {"counts": "Runs and catches of 10+, 20+ or 40+ yards, by yards gained on the play.", "src": "src/deep_stats.py"},
    "EPA": {"counts": "Expected points added (nflverse model): how much a play changed the expected points of the drive, based on down, distance and field position. Per dropback = his passes, sacks and scrambles.",
            "src": "nflverse play-by-play"},
    "CPOE": {"counts": "Completion % over expected (nflverse): actual completions minus the expected rate for each throw (depth, distance, location). +5 = 5 points better than expected.",
             "src": "nflverse play-by-play"},
    "pressure / bad throws (QB)": {"counts": "Times pressured and bad throws are Pro Football Reference charting (via nflverse), so they can differ a bit from PFF or NGS.",
                                   "src": "nflverse PFR advanced stats"},
    "blitz": {"counts": "FTN charting (via nflverse): a dropback is a blitz when 5+ rushed or a linebacker or DB blitzed. Charting services define this differently, so a few % gap vs PFF is normal.",
              "src": "src/deep_stats.py (FTN)"},
    "offensive line on-field numbers": {"counts": "Pressure %, sack % and yards per run on plays the lineman was on the field for (nflverse participation, 2022+). They are his LINE's results with him out there, NOT pressures or sacks he allowed himself (no free source charts that).",
                                        "src": "src/viz_data.py OL_ON"},
    "defender pressures / hurries / coverage": {"counts": "Pro Football Reference charting via nflverse (pressures, hurries, targets and yards allowed in coverage, missed tackles). Charting, so other services may count a few differently.",
                                                "src": "nflverse PFR advanced stats"},
    "frauds / over-achievers": {"counts": "Skill players vs ESPN's weekly projections in the games they played: weighted % below (frauds) or above (over-achievers) their projection.",
                                "src": "src/site_tabs.py"},
    "injuries (% healthy)": {"counts": "Every team's health weighted by who is hurt (a starting QB counts about 10x a punter). Out/IR = all of his value, Doubtful 3/4, Questionable 1/4.",
                             "src": "src/site_tabs.py"},
    "season pace": {"counts": "His per-game average x a full regular season (17 NFL, 12 college). Assumes he plays every game left.", "src": "docs/live.js Projected tab"},
    "heisman race": {"counts": "Production per game vs his position (QBs: pass + rush yards, 20 per TD, minus 45 per INT; others: rush + rec yards, 20 per TD), each game weighted by the opponent's strength, 100 = 10th best at his position; then times team success, popularity (Wikipedia views, 30 days) and position (QB x1.1, RB x0.85).",
                     "src": "docs/viz.js heisGame"},
    "trade watch": {"counts": "0-100 score from the team's playoff chance (10,000 simulations), contract ending soon, age, role (snap share), value and trade headlines in the last 2 weeks. QBs and RBs count less. Best fits = contenders weak at his position. No cap-space data.",
                    "src": "src/trade_watch.py"},
    "coach score": {"counts": "0-100 (50 = average head coach): 35% wins over expected, 30% record vs winning teams (short records pulled toward average), 15% postseason wins per season, 10% team lift (vs the year before he arrived), 10% cupcake padding (share of wins vs losing teams, and FCS teams in college; counts against him). Hot seat = this season vs expectations, the program's usual standard and recent seasons.",
                    "src": "docs/coaches.js, src/coaches.py"},
    "records (gold tags)": {"counts": "The NFL's official individual records (Wikipedia list), only flattering ones, refreshed weekly.", "src": "src/nfl_records.py"},
    "our rankings": {"counts": "The site's # is the Default blend of the factor scores plus head-to-head results. See the model factors below for what each score means.",
                     "src": "src/site_rank.py, src/model.py"},
}


def build():
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from model import FACTORS, NFL_HELP
    out = {"how_we_count": GLOSSARY,
           "model_factors": {"college": {k: help_ for k, _, help_ in FACTORS}, "nfl": {**{k: help_ for k, _, help_ in FACTORS}, **NFL_HELP}}}
    # every Stats > Visualize stat: ["key", "Label (often with its rule)", ...]
    with open(os.path.join(ROOT, "docs", "viz.js"), encoding="utf-8") as f:
        js = f.read()
    labels = {}
    for k, label in re.findall(r'\["([a-z][a-z0-9_]*)", "([^"]{6,200})", \(', js):
        labels.setdefault(k, label)
    out["visualize_stats"] = labels
    return out
