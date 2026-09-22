"""
render_states.py - the widget in every state, both layouts side by side, on one sheet.

    python tools/render_states.py            -> dev/states.png

Renders dev/preview.html headless once per state and layout (the preview's URL flags force
the state: see the top of that file), crops the widget out of each and lays the crops out in
two columns, full on the left and compact on the right, so the two layouts can be compared
line by line: same figures, same colours, same chevron sides, same tags, and only the cells,
trace and tick differing. This is the consistency check the layouts are held to; run it
after any change to the stylesheet or the render code and look at the sheet.

Needs a Chromium-based browser (found the way the test kit finds one) and the loader repo
beside this one, for its headless helper. The game's font shows when tools/preview_fonts.py
has copied it into dev/fonts/.
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIAppLoader")
sys.path.insert(0, os.path.join(LOADER, "tools"))

import headless  # noqa: E402

URL = "file:///" + os.path.join(ROOT, "dev", "preview.html").replace("\\", "/")
OUT = os.path.join(ROOT, "dev", "states.png")
PROFILE = os.path.join(ROOT, "dev", ".states-profile")
# the widget sits at left 34% / top 8% of a 1600x900 stage, rendered at 2x: this crop holds both layouts
CROP = (1000, 60, 2200, 420)
BUDGET_MS = 2500
SHEET_SCALE = 0.5

# (label, flags). hold=N starts the scripted lap N seconds in: 8 is inside corner one (losing),
# 22 is after corner two (gaining, lap up), 40 late in the lap with the trace half full.
STATES = [
    ("no reference", "noref,hold=25"),
    ("losing (corner one)", "hold=8"),
    ("gaining, lap up", "hold=22"),
    ("gaining + cut notice", "hold=22,cut"),
    ("no ref + cut + driver", "noref,hold=25,cut,driver"),
    ("flag up from the start (pit exit): no tag", "hold=22,flag"),
    ("faster side left, losing", "hold=8,set:fasterSide=left"),
    ("faster side left, gaining", "hold=22,set:fasterSide=left"),
    ("background light", "hold=8,set:background=light"),
    ("background none", "hold=8,set:background=none"),
    ("trace on, last lap on", "hold=40,set:showTrace=true,set:showLast=true"),
    ("narrow", "hold=8,set:width=narrow"),
    ("wide", "hold=8,set:width=wide"),
    ("number colour overall", "hold=22,set:numberColour=overall"),
    ("bar colour trend", "hold=22,set:barColour=trend"),
    ("no chevrons, no driver, decimals 2", "hold=22,driver,set:showArrows=false,set:showDriver=false,set:decimals=2"),
    ("hide until a reference lap (nothing to see)", "noref,hold=25,set:hideWithoutReference=true"),
]


def shot(browser, flags, out):
    cmd = [browser, "--headless=new", "--disable-gpu", "--no-first-run", "--allow-file-access-from-files",
           f"--user-data-dir={PROFILE}", "--window-size=1600,900", "--force-device-scale-factor=2",
           f"--virtual-time-budget={BUDGET_MS}", f"--screenshot={out}", URL + "#shot,solo,reset," + flags]
    subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return Image.open(out).crop(CROP)


def main():
    browser = headless.find_browser()
    if not browser:
        raise SystemExit("no Chromium-based browser found (set ACE_BROWSER)")
    rows = []
    for label, flags in STATES:
        pair = []
        for layout in ("full", "compact"):
            out = os.path.join(PROFILE, f"{layout}-{len(rows)}.png")
            os.makedirs(PROFILE, exist_ok=True)
            pair.append(shot(browser, layout + "," + flags, out))
        rows.append((label, pair))
        print("rendered", label)
    w, h = int((CROP[2] - CROP[0]) * SHEET_SCALE), int((CROP[3] - CROP[1]) * SHEET_SCALE)
    sheet = Image.new("RGB", (2 * w + 60, len(rows) * (h + 26) + 40), (30, 32, 34))
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 10), "FULL", fill=(220, 220, 220))
    draw.text((40 + w, 10), "COMPACT", fill=(220, 220, 220))
    for i, (label, pair) in enumerate(rows):
        y = 30 + i * (h + 26)
        for j, im in enumerate(pair):
            sheet.paste(im.resize((w, h), Image.LANCZOS), (20 + j * (w + 20), y))
        draw.text((20, y + h + 2), label, fill=(200, 200, 200))
    sheet.save(OUT)
    swept = headless.sweep_orphans()
    print("wrote", OUT, sheet.size, f"({swept} leaked browser process(es) swept)")


if __name__ == "__main__":
    main()
