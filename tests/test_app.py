"""The shared ACEUIAppLoader test kit (appkit.py in the loader repo) plus the widget's own contract."""
import json
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOADER = os.environ.get("ACE_LOADER_DIR") or os.path.join(os.path.dirname(ROOT), "ACEUIAppLoader")
sys.path.insert(0, os.path.join(LOADER, "tools"))

from appkit import AppTests  # noqa: E402

APP = os.path.join(ROOT, "betterdeltabar")
JS = os.path.join(APP, "betterdeltabar.js")
CSS = os.path.join(APP, "betterdeltabar.css")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Tests(AppTests):
    ROOT = ROOT
    MIN_CASES = 113
    HOT_PATH = ("// ---- rendering", "// ---- lifecycle")


class WidgetContractTests(unittest.TestCase):
    """What the widget promises beyond the kit's rules."""

    def setUp(self):
        self.js = read(JS)
        self.css = read(CSS)

    def test_draws_with_transforms_text_and_classes_only(self):
        # rebuilding geometry per frame crashed the game inside Renoir (PedalGraph's first build);
        # the bar and the trace are fixed elements scaled by transform
        self.assertIn("scaleX(", self.js)
        self.assertIn("scaleY(", self.js)
        self.assertEqual(self.js.count("root.innerHTML = markup()"), 1, "markup built once, at attach")

    def test_the_trend_is_sampled_at_a_fixed_rate_through_the_library(self):
        self.assertIn("ACEUIAppLoader.loop.sampler(", self.js)
        self.assertIn("ACEUIAppLoader.loop.advance(", self.js)
        self.assertIn("ACEUIAppLoader.loop.reset(", self.js, "a stall or a missing delta forgets the ring")

    def test_options_go_through_the_loader(self):
        self.assertEqual(self.js.count("settings.define("), 1, "one declaration, at script load")
        self.assertIn("me.scaleSpec(", self.js, "the panel scale is the loader's shared spec")
        self.assertIn("me.scale(root", self.js, "and the loader applies it")
        self.assertIn("settings.onChange(me.name", self.js, "changes reach the live widget")
        self.assertIn("unsubscribeSettings()", self.js, "and detach lets go of the listener")
        self.assertNotIn("localStorage", self.js)

    def test_the_sentinel_and_the_sign_convention_are_the_games(self):
        # int32 max is what the stock ks-delta treats as "no delta"; positive is time lost
        self.assertIn("const NO_DELTA_MS = 2147483647;", self.js)
        self.assertIn("delta_time_ms_ui", self.js)
        self.assertIn("delta_time_ms", self.js)

    def test_every_class_the_script_writes_is_in_the_stylesheet(self):
        for cls in ("bd-gain", "bd-lose", "bd-flat", "bd-strong", "bd-faster", "bd-slower", "bd-noref", "bd-invalid",
                    "bd-hasdriver", "bd-top-on", "bd-pred-faster", "bd-pred-slower", "bd-compact", "bd-faster-left", "bd-noarrows", "bd-nooptimal",
                    "bd-nobest", "bd-nolast", "bd-nopred", "bd-notrace", "bd-noinvalid", "bd-hide-noref", "bd-narrow", "bd-wide",
                    "bd-num-overall", "bd-num-white", "bd-bar-trend", "bd-bg-light", "bd-bg-none"):
            self.assertIn("." + cls, self.css, cls)

    def test_lengths_inside_the_panel_are_em(self):
        # every length inside the panel is em, so one font-size on the root scales it all
        inside = self.css[self.css.index(".ace-betterdeltabar .bd-top"):]
        self.assertNotIn("rem", inside, "lengths inside the panel must be em, not rem, or the scale option skips them")

    def test_no_calc(self):
        rules = re.sub(r"/\*.*?\*/", "", self.css, flags=re.S)
        self.assertNotIn("calc(", rules, "Cohtml did not apply a calc mixing % and px (PedalGraph); none here")

    def test_the_stock_colours(self):
        self.assertIn("#44ea78", self.css.lower())
        self.assertIn("#ff1418", self.css.lower())


class ReasonTableTests(unittest.TestCase):
    """The reasons the widget can name are the game's own enum (PenaltySystem.proto), checked against the ACEGameInternals copy when it is beside this repo."""

    PROTO = os.path.join(os.path.dirname(ROOT), "ACEGameInternals", "proto", "0.9.1-release.6", "PenaltySystem.proto")

    def keys(self):
        table = re.search(r"const REASONS = \{(.*?)\};", read(JS), re.S).group(1)
        return re.findall(r"(InvestigationType_\w+):", table)

    def test_every_enum_member_is_in_the_table(self):
        if not os.path.isfile(self.PROTO):
            self.skipTest("no ACEGameInternals checkout beside this repo")
        enum = re.search(r"enum InvestigationType \{(.*?)\}", read(self.PROTO), re.S).group(1)
        members = re.findall(r"(InvestigationType_\w+)\s*=", enum)
        self.assertTrue(len(members) >= 20, members)
        for member in members:
            self.assertIn(member, self.keys(), member + " is in the game's enum but not in REASONS")

    def test_every_penalty_type_of_the_game_is_covered(self):
        """The script names the types that void a lap; the harness must exercise every other member of the game's enum as a non-invalidation."""
        if not os.path.isfile(self.PROTO):
            self.skipTest("no ACEGameInternals checkout beside this repo")
        enum = re.search(r"enum PenaltyType \{(.*?)\}", read(self.PROTO), re.S).group(1)
        members = re.findall(r"(PenaltyType_\w+)\s*=", enum)
        self.assertTrue(len(members) >= 15, members)
        js = read(JS)
        harness = read(os.path.join(ROOT, "tests", "widget", "harness.html"))
        invalidating = re.findall(r'const INVALID\w*_TYPE = "(PenaltyType_\w+)"', js)
        self.assertEqual(sorted(invalidating), ["PenaltyType_InvalidLap", "PenaltyType_InvalidNextLap"])
        for member in members:
            if member not in invalidating:
                self.assertIn('"' + member + '"', harness, member + " is in the game's enum but the harness never sends it")

    def test_the_table_has_no_duplicates_and_english_words(self):
        keys = self.keys()
        self.assertEqual(len(keys), len(set(keys)))
        for value in re.findall(r'InvestigationType_\w+: "([^"]+)"', read(JS)):
            self.assertRegex(value, r"^[A-Z][A-Za-z ]+$", value)


class ReadmeTests(unittest.TestCase):
    """The README is the release page: it has to say which version it describes and show pictures that exist."""

    def setUp(self):
        self.readme = read(os.path.join(ROOT, "README.md"))
        self.version = json.loads(read(os.path.join(APP, "app.json")))["version"]

    def test_it_states_the_version_of_app_json(self):
        self.assertIn(self.version, self.readme, "the README's version must be app.json's")

    def test_every_picture_it_promises_is_actually_there(self):
        for src in re.findall(r'src="(docs/images/[^"]+)"', self.readme):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, src)), src)

    def test_it_installs_the_way_the_release_zip_is_built(self):
        self.assertIn("Saved Games\\ACE", self.readme)
        self.assertIn("releases/latest", self.readme, "it points at the download")


if __name__ == "__main__":
    unittest.main()
