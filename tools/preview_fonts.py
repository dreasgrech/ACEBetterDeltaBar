"""
preview_fonts.py - copy the game's UI fonts next to dev/preview.html, so the preview and its
screenshots use the typeface the widget has in game (Rajdhani, via --font-family-main)
instead of a system stand-in.

    python tools/preview_fonts.py

Reads them out of the installed game's content.kspkg with ACEGameInternals' kspkg reader
(clone that repo beside this one, or set ACE_INTERNALS_DIR). The files land in dev/fonts/,
which is ignored by git: they are the game's, not this repo's, and the preview falls back to
a system font when they are missing.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTERNALS = os.environ.get("ACE_INTERNALS_DIR") or os.path.join(os.path.dirname(ROOT), "ACEGameInternals")
LOADER = os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIAppLoader")
sys.path.insert(0, os.path.join(INTERNALS, "tools"))
sys.path.insert(0, os.path.join(LOADER, "tools"))

import kspkg  # noqa: E402
import _repos  # noqa: E402

OUT = os.path.join(ROOT, "dev", "fonts")
# the weights ui.css maps rajdhani to, plus the tabular numerals the stock timers use
FONTS = (
    "rajdhani-regular.ttf",
    "rajdhani-medium.ttf",
    "rajdhani-semibold.ttf",
    "rajdhani-bold.ttf",
    "rajdhani-numerals-mono-bold.ttf",
)


def main():
    pkg = os.path.join(_repos.game_dir(), "content.kspkg")
    entries = kspkg.read_entries(pkg)
    by_name = {os.path.basename(k).lower(): k for k in entries if k.lower().startswith("uiresources\\fonts\\")}
    os.makedirs(OUT, exist_ok=True)
    for name in FONTS:
        key = by_name.get(name)
        if not key:
            print(f"missing in package: {name}")
            continue
        data = kspkg.extract(pkg, key, entries)
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print(f"{name}: {len(data)} bytes")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
