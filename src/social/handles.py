"""Official NFL team X accounts and fan hashtags, for tagging teams in posts (writer.py).

Only these handles may appear in a post: a wrong @ tags a stranger, so players are never tagged.
Keyed by the team's full name as the site writes it (docs/data/viz teams).
"""
import re

NFL = {
    "Arizona Cardinals": ("@AZCardinals", "#BirdCityFootball"),
    "Atlanta Falcons": ("@AtlantaFalcons", "#DirtyBirds"),
    "Baltimore Ravens": ("@Ravens", "#RavensFlock"),
    "Buffalo Bills": ("@BuffaloBills", "#BillsMafia"),
    "Carolina Panthers": ("@Panthers", "#KeepPounding"),
    "Chicago Bears": ("@ChicagoBears", "#DaBears"),
    "Cincinnati Bengals": ("@Bengals", "#RuleTheJungle"),
    "Cleveland Browns": ("@Browns", "#DawgPound"),
    "Dallas Cowboys": ("@dallascowboys", "#DallasCowboys"),
    "Denver Broncos": ("@Broncos", "#BroncosCountry"),
    "Detroit Lions": ("@Lions", "#OnePride"),
    "Green Bay Packers": ("@packers", "#GoPackGo"),
    "Houston Texans": ("@HoustonTexans", "#WeAreTexans"),
    "Indianapolis Colts": ("@Colts", "#ForTheShoe"),
    "Jacksonville Jaguars": ("@Jaguars", "#DUUUVAL"),
    "Kansas City Chiefs": ("@Chiefs", "#ChiefsKingdom"),
    "Las Vegas Raiders": ("@Raiders", "#RaiderNation"),
    "Los Angeles Chargers": ("@chargers", "#BoltUp"),
    "Los Angeles Rams": ("@RamsNFL", "#RamsHouse"),
    "Miami Dolphins": ("@MiamiDolphins", "#FinsUp"),
    "Minnesota Vikings": ("@Vikings", "#SKOL"),
    "New England Patriots": ("@Patriots", "#ForeverNE"),
    "New Orleans Saints": ("@Saints", "#WhoDat"),
    "New York Giants": ("@Giants", "#TogetherBlue"),
    "New York Jets": ("@nyjets", "#JetUp"),
    "Philadelphia Eagles": ("@Eagles", "#FlyEaglesFly"),
    "Pittsburgh Steelers": ("@steelers", "#HereWeGo"),
    "San Francisco 49ers": ("@49ers", "#FTTB"),
    "Seattle Seahawks": ("@Seahawks", "#GoHawks"),
    "Tampa Bay Buccaneers": ("@Buccaneers", "#GoBucs"),
    "Tennessee Titans": ("@Titans", "#TitanUp"),
    "Washington Commanders": ("@Commanders", "#RaiseHTTR"),
}
# hashtags any post may use
GENERAL = {"#NFL", "#CFB", "#CollegeFootball", "#TNF", "#SNF", "#MNF", "#NFLDraft", "#FantasyFootball", "#CFBPlayoff"}


# short names headlines use
ALIASES = {"bucs": "Tampa Bay Buccaneers", "niners": "San Francisco 49ers", "pats": "New England Patriots",
           "jags": "Jacksonville Jaguars", "phins": "Miami Dolphins", "bolts": "Los Angeles Chargers"}


def nickname(full):
    """'San Francisco 49ers' -> '49ers' (every NFL nickname is unique)."""
    return full.rsplit(" ", 1)[-1]


def teams_in(text):
    """NFL teams named in a piece of text, by full name, nickname or a common short name."""
    low = text.lower()
    words = set(re.findall(r"[a-z0-9]+", low))
    return [t for t in NFL if t.lower() in low or nickname(t).lower() in words
            or any(a in words for a, full in ALIASES.items() if full == t)]
