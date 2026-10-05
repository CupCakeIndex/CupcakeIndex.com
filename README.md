# The Cupcake Index (CFB + NFL)

Weekly college football and NFL power rankings based on who you played and how you played, not on brand name.
Every Monday morning GitHub rebuilds the rankings and updates the website automatically. Your PC doesn't need to be on.

## One-time setup (~15 minutes)

### 1. Get a free data key
1. Go to <https://collegefootballdata.com/key> and enter your email.
2. The key arrives by email. Keep it handy.

### 2. Put the project on GitHub
1. Create a free account at <https://github.com> if you don't have one.
2. Click **+** (top right) → **New repository**. Name it `PowerRankings`, set it to **Public**, and **don't** add a README. Click **Create repository**.
3. Tell Claude the repository URL. It will push the code for you (a GitHub sign-in window may pop up once).

### 3. Give GitHub your data key
1. In the repo, go to **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Name: `CFBD_API_KEY`. Secret: paste your key. Click **Add secret**.

### 4. Turn on the website
1. **Settings** → **Pages**.
2. Under "Build and deployment", set Source to **Deploy from a branch**, Branch to **main**, and folder to **/docs**. Click **Save**.
3. Add the custom domain `cupcakeindex.com` there too. The site is at <https://cupcakeindex.com>.

### 5. Run it the first time
1. Go to the **Actions** tab. If asked, click **I understand my workflows, go ahead and enable them**.
2. Click **Weekly rankings** → **Run workflow** → **Run workflow**.
3. After about a minute, refresh your site.

That's it. From now on it runs every Monday at 9am Eastern from August through January, and again on Tuesday to pick up Monday Night Football and stat corrections.

## Using the site
- **CFB / NFL** toggle at the top right.
- **Sliders** change how much each factor counts. The rankings re-sort instantly, and your settings are remembered on that device (separately for each league).
- **Click a column header** (PWR, RES, EFF, CUP, …) to sort by that factor, high to low. Click again for low to high, and a third time to go back to your blend. **Record** and **AP** sort the same way. On phones, use the "Rank by" dropdown.
- **Cupcake (CUP):** higher = softer schedule. It counts against a team.
- **Clear all** sets every slider to 0. **Reset** restores the defaults.
- **Presets**: *Who'd you beat* (pure résumé), *Who'd win* (predictive), *Hot right now* (recent form).
- **Click a team** to see why it's ranked where it is: its schedule, cupcake games, and luck.
- **Overrated / Underrated** tags mark teams the AP poll ranks 10+ spots differently from the model.
- **Next week's picks** compares the model's spread with the sportsbooks' spreads and tracks its record straight up and against the spread. College lines come from DraftKings, Bovada, and ESPN Bet. NFL lines come from DraftKings plus the market consensus.
- **NFL QB flags:** ⚠ marks games where someone other than the team's usual starter played or is listed to start. The rating doesn't adjust for QB changes, so treat flagged picks with caution.
- To share a team, copy the link while its panel is open.

## Scores, stats, standings (live)
The **Scores**, **Stats**, **Standings**, game, player and team pages load straight from ESPN's public data feed in the visitor's browser. No key or server is needed, and they refresh automatically during live games. ESPN doesn't officially document this feed, so if a page ever breaks, ESPN probably changed something. The rankings are unaffected either way.

## Tweaking the model
The numbers in `src/config.yaml` are plain-English settings (margin cap, how bad FCS teams are assumed to be, default slider positions). Edit them on GitHub (click the file → pencil icon → **Commit changes**), then press **Run workflow** again.

## Running it on this PC (optional)
```powershell
pip install -r requirements.txt
$env:CFBD_API_KEY = "your-key"
python src/run_weekly.py              # current season
python src/run_weekly.py --season 2025  # any past season
python src/run_weekly.py --league nfl   # one league only
```
Then double-click `preview.bat` to view it in your browser.

## Files
| File | What it does |
|---|---|
| `src/fetch_data.py` | College data from CollegeFootballData.com (key required) |
| `src/nfl_data.py` | NFL data from nflverse, plus DraftKings lines from ESPN (no key needed) |
| `src/model.py` | All ranking math |
| `src/run_weekly.py` | Runs everything and writes `docs/data/` |
| `docs/` | The website |
| `.github/workflows/weekly.yml` | The Monday schedule |
| `tests/make_fake_data.py` | Fake season for testing without a key |

Worked on from a Windows 11 VM as of 2026-10-04 (moved from the work laptop).
