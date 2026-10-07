"""Concept art for a 16-bit live field skin (behind-the-offense camera). Original pixel art, drawn here pixel by pixel:
no assets from any real game. Run:  python make_concepts.py   ->  sprite_sheet.png, scene_snap.png, scene_pass.png

Sprites are 16x24 (the dive is 24x16), drawn as text grids and colored per team at draw time:
  k outline  H helmet  h helmet shade  W helmet stripe  F facemask  s skin  J jersey  j jersey shade
  P pants  p pants shade  S socks  B shoes  b ball  w laces  . clear
Offense is seen from behind (number on the back), defense from the front (number on the chest).
"""
import random
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
random.seed(7)

SPRITES = {
    "back_stand": """
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
....kHhHWHHk....
....kkHHWHkk....
.....kssssk.....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
.kJjJJJJJJJJjJk.
.kskJJJJJJJJksk.
.kskJJJJJJJJksk.
.kk.kJJJJJJk.kk.
....kPPPPPPk....
....kPPPPPPk....
....kPPkkPPk....
....kPPk.kPPk...
....kPpk.kpPk...
....kSSk.kSSk...
....kSSk.kSSk...
....kSSk.kSSk...
...kBBBk.kBBBk..
...kkkk...kkkk..
................""",
    "back_run_a": """
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
....kHhHWHHk....
....kkHHWHkk....
.....kssssk.....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
kskJJJJJJJJJjJk.
kskJJJJJJJJJJsk.
.kkJJJJJJJJJJsk.
...kJJJJJJJJkkk.
....kPPPPPPk....
....kPPPPPPk....
...kPPPkkPPPk...
..kPPPk..kPPk...
..kPpk....kPPk..
..kSSk.....kSSk.
.kSSk......kSSk.
.kSSk.......kBBk
kBBBk.......kkk.
kkkk............
................""",
    "back_run_b": """
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
....kHhHWHHk....
....kkHHWHkk....
.....kssssk.....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
.kJjJJJJJJJJJksk
.ksJJJJJJJJJJksk
.ksJJJJJJJJJJkk.
.kkkJJJJJJJJk...
....kPPPPPPk....
....kPPPPPPk....
...kPPPkkPPPk...
...kPPk..kPPPk..
..kPPk....kpPk..
.kSSk.....kSSk..
.kSSk......kSSk.
kBBk.......kSSk.
.kkk.......kBBBk
............kkkk
................""",
    "front_stand": """
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
....kHFFFFHk....
....kFsssFHk....
....kkFssFkk....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
.kJjJJJJJJJJjJk.
.kskJJJJJJJJksk.
.kskJJJJJJJJksk.
.kk.kJJJJJJk.kk.
....kPPPPPPk....
....kPPPPPPk....
....kPPkkPPk....
....kPPk.kPPk...
....kPpk.kpPk...
....kSSk.kSSk...
....kSSk.kSSk...
....kSSk.kSSk...
...kBBBk.kBBBk..
...kkkk...kkkk..
................""",
    "front_run_a": """
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
....kHFFFFHk....
....kFsssFHk....
....kkFssFkk....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
kskJJJJJJJJJjJk.
kskJJJJJJJJJJsk.
.kkJJJJJJJJJJsk.
...kJJJJJJJJkkk.
....kPPPPPPk....
....kPPPPPPk....
...kPPPkkPPPk...
..kPPPk..kPPk...
..kPpk....kPPk..
..kSSk.....kSSk.
.kSSk......kSSk.
.kSSk.......kBBk
kBBBk.......kkk.
kkkk............
................""",
    "line_back": """
................
................
................
................
................
................
................
......kkkk......
.....kHHWHk.....
....kHHHWHHk....
..kkkkHHWHkkkk..
.kJJJJJJJJJJJJk.
kJjJJJJJJJJJJjJk
kJjJJJJJJJJJJjJk
kskJJJJJJJJJJksk
kskkJJJJJJJJkksk
kss.kPPPPPPk.ssk
.kk.kPPPPPPk.kk.
...kPPPkkPPPk...
..kPPPk..kPPPk..
..kSSk....kSSk..
..kSSk....kSSk..
.kBBBk....kBBBk.
.kkkk......kkkk.""",
    "line_front": """
................
................
................
................
................
................
................
......kkkk......
.....kHHWHk.....
....kHFFFFHk....
..kkkFsssFHkkk..
.kJJJkFssFkJJJk.
kJjJJJJJJJJJJjJk
kJjJJJJJJJJJJjJk
kskJJJJJJJJJJksk
kskkJJJJJJJJkksk
kss.kPPPPPPk.ssk
.kk.kPPPPPPk.kk.
...kPPPkkPPPk...
..kPPPk..kPPPk..
..kSSk....kSSk..
..kSSk....kSSk..
.kBBBk....kBBBk.
.kkkk......kkkk.""",
    "qb_throw": """
............kbbk
......kkkk..kbwk
.....kHHWHk.ksk.
....kHHHWHHkksk.
....kHhHWHHk.sk.
....kkHHWHkk.sk.
.....kssssk.kJk.
..kkkJJJJJJkJJk.
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJJk..
.kJjJJJJJJJJJk..
.kskJJJJJJJJk...
.kskJJJJJJJJk...
.kk.kPPPPPPk....
....kPPPPPPk....
....kPPkkPPk....
...kPPk..kPPk...
...kPpk...kPPk..
...kSSk....kSSk.
...kSSk....kSSk.
...kSSk....kSSk.
..kBBBk...kBBBk.
..kkkk....kkkk..
................""",
    "celebrate": """
.ksk........ksk.
.ksk........ksk.
.kJk.kkkk...kJk.
.kJkkHHWHk..kJk.
.kJkHHHWHHk.kJk.
..kkHhHWHHkkk...
....kkHHWHkk....
.....kssssk.....
..kkkJJJJJJkkk..
.kJJJJJJJJJJJJk.
.kJjJJJJJJJJjJk.
.kJjJJJJJJJJjJk.
..kJJJJJJJJJJk..
...kJJJJJJJJk...
....kPPPPPPk....
....kPPPPPPk....
....kPPkkPPk....
....kPPk.kPPk...
....kSSk.kSSk...
....kSSk.kSSk...
....kSSk.kSSk...
...kBBBk.kBBBk..
...kkkk...kkkk..
................""",
    "dive": """
........................
........................
..............kkkk......
.kkk.........kHHWHk.....
kBBkkkkkkkkkkHHHWHHk....
kSSSSPPPPPJJJJJHFFFHk...
kSSSSPPPPPJJJJJJFssFHksk
.kkkkPPpPPJJjJJJkkkkksskk
....kkkkkkJJjJJJJJJJJsk..
.........kkkkkkkkkkkkk...
........................
........................
........................
........................
........................
........................""",
}
DIGITS = {  # 3x5 jersey numbers
    "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"], "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"], "4": ["101", "101", "111", "001", "001"], "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"], "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
}
BIG = {  # 5x7 HUD font
    "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"], "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"], "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"], "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"], "G": ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"], "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"], "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"], "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
    " ": ["00000"] * 7, "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"], "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
}

def shade(rgb, f):
    return tuple(max(0, min(255, int(c * f))) for c in rgb)

def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

# two sample teams, in real team colors (colors only: no logos, no names on the art)
RED = {"H": hexrgb("#AA0000"), "W": (255, 255, 255), "J": hexrgb("#AA0000"), "P": hexrgb("#B3995D"), "S": hexrgb("#AA0000"), "N": (255, 255, 255)}
BLUE = {"H": hexrgb("#003594"), "W": hexrgb("#FFD100"), "J": (240, 240, 240), "P": (240, 240, 240), "S": hexrgb("#003594"), "N": hexrgb("#003594")}

def palette(team, skin=(198, 134, 94)):
    return {"k": (16, 16, 20), "H": team["H"], "h": shade(team["H"], 1.35), "W": team["W"], "F": (170, 170, 178), "s": skin,
            "J": team["J"], "j": shade(team["J"], 0.78), "P": team["P"], "p": shade(team["P"], 0.78), "S": team["S"],
            "B": (24, 24, 24), "b": (122, 70, 30), "w": (255, 255, 255)}

SKINS = [(198, 134, 94), (141, 85, 54), (224, 172, 135), (92, 58, 38)]

def sprite(name, team, number=None, skin=None):
    rows = [r for r in SPRITES[name].strip("\n").split("\n")]
    w, h = max(len(r) for r in rows), len(rows)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pal = palette(team, skin or SKINS[0])
    for y, r in enumerate(rows):
        for x, c in enumerate(r):
            if c in pal:
                img.putpixel((x, y), pal[c] + (255,))
    if number is not None and name not in ("dive", "line_back", "line_front"):
        digits = str(number)
        top = 8 if name != "celebrate" else 10
        x0 = 8 - (len(digits) * 4 - 1) // 2
        for i, d in enumerate(digits):
            for yy, row in enumerate(DIGITS[d]):
                for xx, bit in enumerate(row):
                    if bit == "1":
                        img.putpixel((x0 + i * 4 + xx, top + yy), team["N"] + (255,))
    return img

def text(img, s, x, y, color, scale=1, shadow=None):
    d = ImageDraw.Draw(img)
    for i, ch in enumerate(s.upper()):
        g = BIG.get(ch, BIG[" "])
        for yy, row in enumerate(g):
            for xx, bit in enumerate(row):
                if bit == "1":
                    px, py = x + (i * 6 + xx) * scale, y + yy * scale
                    if shadow:
                        d.rectangle([px + scale, py + scale, px + 2 * scale - 1, py + 2 * scale - 1], fill=shadow)
                    d.rectangle([px, py, px + scale - 1, py + scale - 1], fill=color)

def up(img, k):
    return img.resize((img.width * k, img.height * k), Image.NEAREST)

# ------------------------------------------------------------------ sprite sheet
poses = [("back_stand", "STAND"), ("back_run_a", "RUN 1"), ("back_run_b", "RUN 2"), ("qb_throw", "THROW"), ("line_back", "OL"),
         ("celebrate", "TD"), ("front_stand", "D STAND"), ("front_run_a", "D RUN"), ("line_front", "DL"), ("dive", "DIVE")]
cell_w, cell_h = 46, 34
sheet = Image.new("RGB", (cell_w * len(poses) + 8, cell_h * 2 + 32), (14, 16, 20))
text(sheet, "CUPCAKE INDEX  16-BIT CONCEPT", 4, 3, (255, 107, 44))
for row, (team, num) in enumerate(((RED, 85), (BLUE, 12))):
    for i, (name, label) in enumerate(poses):
        sp = sprite(name, team, num, SKINS[(i + row) % len(SKINS)])
        x = 4 + i * cell_w + (cell_w - sp.width) // 2
        y = 14 + row * cell_h + (26 - sp.height)
        sheet.paste(sp, (x, y), sp)
for i, (_, label) in enumerate(poses):  # pose names under the columns
    text(sheet, label, 4 + i * cell_w + (cell_w - len(label) * 6) // 2, 14 + 2 * cell_h + 4, (160, 166, 176))
up(sheet, 5).save(OUT / "sprite_sheet.png")

# ------------------------------------------------------------------ field scenes (256x224, like a 16-bit console screen)
W, H = 256, 224

def field(yard_lines_y, los_y):
    img = Image.new("RGB", (W, H), (46, 140, 52))
    px = img.load()
    for y in range(H):
        band = (y // 28) % 2  # mowed stripes
        for x in range(W):
            n = random.random()
            g = (52, 150, 58) if band else (44, 132, 50)
            if n < 0.18:
                g = shade(g, 1.12)
            elif n < 0.30:
                g = shade(g, 0.9)
            px[x, y] = g
    d = ImageDraw.Draw(img)
    for y in yard_lines_y:
        d.line([(0, y), (W, y)], fill=(236, 240, 236))
    for y0, y1 in zip(yard_lines_y, yard_lines_y[1:]):  # hash marks between lines
        for k in range(1, 5):
            yy = y0 + (y1 - y0) * k // 5
            for hx in (88, 166):
                d.line([(hx, yy), (hx + 4, yy)], fill=(236, 240, 236))
            for sx in (6, W - 11):
                d.line([(sx, yy), (sx + 5, yy)], fill=(236, 240, 236))
    for i, y in enumerate(yard_lines_y[1::2]):  # yard numbers on both sides, rotated look: just stacked digits
        num = str([40, 30, 20, 10][i % 4])
        text(img, num, 18, y - 4, (236, 240, 236))
        text(img, num, W - 30, y - 4, (236, 240, 236))
    d.line([(0, los_y), (W, los_y)], fill=(80, 140, 255))  # line of scrimmage (blue)
    return img

def hud(img, banner, clock):
    d = ImageDraw.Draw(img)
    d.rectangle([6, 8, 6 + len(banner) * 12 + 6, 26], fill=(10, 10, 14))
    text(img, banner, 10, 11, (255, 255, 255), scale=2, shadow=(0, 0, 0))
    d.rectangle([6, 27, 6 + len(banner) * 12 + 6, 29], fill=(200, 16, 32))
    d.rectangle([W - 34, 8, W - 6, 26], fill=(10, 10, 14))
    text(img, clock, W - 31, 11, (255, 209, 0), scale=2)

def put(img, sp, x, y):  # x,y = feet center
    img.paste(sp, (x - sp.width // 2, y - sp.height), sp)

lines = [40, 72, 104, 136, 168, 200]
snap = field(lines, 150)
# defense (front view, facing the camera)
for x, y in [(70, 92), (186, 92)]:                     # safeties deep
    put(snap, sprite("front_stand", RED, random.choice([20, 31, 42]), random.choice(SKINS)), x, y)
for x in (96, 128, 160):                                # linebackers
    put(snap, sprite("front_stand", RED, random.choice([51, 54, 56]), random.choice(SKINS)), x, 124)
for x in (30, 226):                                     # corners
    put(snap, sprite("front_stand", RED, random.choice([21, 24]), random.choice(SKINS)), x, 128)
for x in (100, 119, 138, 157):                          # defensive line
    put(snap, sprite("line_front", RED, None, random.choice(SKINS)), x, 149)
# offense (back view)
for x in (98, 113, 128, 143, 158):                      # offensive line
    put(snap, sprite("line_back", BLUE, None, random.choice(SKINS)), x, 172)
put(snap, sprite("back_stand", BLUE, 87, SKINS[1]), 176, 172)   # tight end
put(snap, sprite("back_stand", BLUE, 16, SKINS[2]), 128, 186)   # QB under center
put(snap, sprite("back_stand", BLUE, 30, SKINS[1]), 128, 214)   # RB
for x, n in ((22, 11), (234, 81)):                      # wide receivers
    put(snap, sprite("back_stand", BLUE, n, SKINS[3]), x, 172)
hud(snap, "1ST AND 10", "31")
up(snap, 4).save(OUT / "scene_snap.png")

# a play in progress: QB throwing, receiver running deep, a corner diving
play = field(lines, 150)
for x in (100, 119, 138, 157):
    put(play, sprite("line_front", RED, None, random.choice(SKINS)), x, 158)
for x in (98, 113, 128, 143, 158):
    put(play, sprite("line_back", BLUE, None, random.choice(SKINS)), x, 172)
put(play, sprite("qb_throw", BLUE, 16, SKINS[2]), 128, 200)
put(play, sprite("back_run_a", BLUE, 81, SKINS[3]), 206, 84)
put(play, sprite("front_run_a", RED, 24, SKINS[1]), 214, 64)
put(play, sprite("dive", RED, None, SKINS[0]), 184, 104)
put(play, sprite("back_run_b", BLUE, 11, SKINS[3]), 46, 112)
put(play, sprite("front_stand", RED, 21, SKINS[2]), 56, 96)
for x in (96, 160):
    put(play, sprite("front_run_a", RED, random.choice([51, 54]), random.choice(SKINS)), x, 140)
d = ImageDraw.Draw(play)  # the ball in the air, with a dotted arc
for t in range(0, 11):
    x = 134 + (204 - 134) * t / 10
    y = 172 + (70 - 172) * t / 10 - 26 * (1 - (2 * t / 10 - 1) ** 2)
    if t % 2 == 0:
        d.point((int(x), int(y)), fill=(255, 255, 255))
d.ellipse([168, 104, 172, 107], fill=(122, 70, 30), outline=(16, 16, 20))
hud(play, "2ND AND 6", "18")
up(play, 4).save(OUT / "scene_pass.png")
print("saved:", ", ".join(p.name for p in OUT.glob("*.png")))
