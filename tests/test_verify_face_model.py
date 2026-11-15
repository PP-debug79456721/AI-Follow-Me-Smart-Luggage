"""
Tests for the input checks and profiles of tools/verify_face_model.py.

Run from the repository root (Python standard library only):

    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests/test_verify_face_model.py

No model file, numpy, onnx or onnxruntime is needed: every check tested
here runs before the model is opened, and the tool imports numpy / onnx
only when it actually inspects a model. No inference is run.
"""

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOL = ROOT / "tools" / "verify_face_model.py"
MANIFEST = ROOT / "models" / "manifest.json"
MISSING_MODEL = str(ROOT / "tests" / "no-such-model.onnx")


def load_tool():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("verify_face_model", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_tool(*args):
    result = subprocess.run(
        [sys.executable, "-B", str(TOOL), "--model", MISSING_MODEL, *args],
        capture_output=True, text=True, cwd=ROOT, timeout=60,
    )
    return result.returncode, result.stdout + result.stderr


class PreprocessingArgs(unittest.TestCase):

    def test_function_rejects_non_finite_and_zero(self):
        check = load_tool().preprocessing_arg_error
        for mean, std in [
            (float("nan"), 128.0), (float("inf"), 128.0), (float("-inf"), 128.0),
            (127.5, float("nan")), (127.5, float("inf")), (127.5, float("-inf")),
            (127.5, 0.0), (127.5, -0.0),
        ]:
            with self.subTest(mean=mean, std=std):
                self.assertIsNotNone(check(mean, std))

    def test_function_accepts_every_profile_and_sweep_setting(self):
        tool = load_tool()
        for name, profile in tool.PROFILES.items():
            with self.subTest(profile=name):
                self.assertIsNone(tool.preprocessing_arg_error(profile["mean"], profile["std"]))
                for _, mean, std, _ in tool.sweep_settings(profile):
                    self.assertIsNone(tool.preprocessing_arg_error(mean, std))

    def test_cli_refuses_bad_values_before_opening_the_model(self):
        for args, message in [
            (["--mean", "nan"], "--mean must be a finite number"),
            (["--mean=-inf"], "--mean must be a finite number"),
            (["--std", "inf"], "--std must be a finite number"),
            (["--std=-inf"], "--std must be a finite number"),
            (["--std", "nan"], "--std must be a finite number"),
            (["--std", "0"], "--std must not be 0."),
        ]:
            with self.subTest(args=args):
                code, output = run_tool(*args)
                self.assertEqual(code, 2, output)
                self.assertIn(message, output)
                self.assertNotIn("model file not found", output)

    def test_cli_valid_values_reach_the_model_check(self):
        for args in (
            [],                                                  # sface defaults
            ["--mean", "0", "--std", "1"],                       # sface, explicit raw
            ["--profile", "arcface-garavv"],                     # legacy defaults
            ["--profile", "arcface-garavv", "--mean", "0", "--std", "255"],
        ):
            with self.subTest(args=args):
                code, output = run_tool(*args)
                self.assertEqual(code, 2, output)
                self.assertIn("model file not found", output)


class SFaceProfile(unittest.TestCase):

    def setUp(self):
        self.tool = load_tool()
        self.sface = self.tool.PROFILES["sface"]

    def test_sface_is_the_default_profile(self):
        self.assertEqual(self.tool.DEFAULT_PROFILE, "sface")

    def test_sface_profile_values(self):
        self.assertEqual(self.sface["model"], "models/face/face_recognition_sface_2021dec.onnx")
        self.assertEqual(self.sface["input_name"], "data")
        self.assertEqual(self.sface["output_name"], "fc1")
        self.assertEqual(self.sface["layout"], "NCHW")
        self.assertEqual(self.sface["embedding_dim"], 128)
        self.assertEqual(self.sface["color"], "RGB")
        self.assertEqual((self.sface["mean"], self.sface["std"]), (0.0, 1.0))
        self.assertEqual(self.sface["graph_normalization"], (127.5, 128.0))

    def test_sface_profile_matches_the_manifest_face_entry(self):
        face = json.loads(MANIFEST.read_text(encoding="utf-8"))["models"]["face"]
        self.assertEqual(face["file"], self.sface["model"])
        self.assertEqual(face["input"]["name"], self.sface["input_name"])
        self.assertEqual(face["input"]["layout"], self.sface["layout"])
        self.assertEqual(face["input"]["shape"], [1, 3, 112, 112])
        self.assertEqual(face["input"]["colorOrder"], self.sface["color"])
        self.assertEqual(face["output"]["name"], self.sface["output_name"])
        self.assertEqual(face["output"]["shape"], [1, self.sface["embedding_dim"]])

    def test_model_layout_detects_nchw_and_nhwc(self):
        self.assertEqual(self.tool.model_layout([1, 3, 112, 112]), "NCHW")
        self.assertEqual(self.tool.model_layout(["N", 112, 112, 3]), "NHWC")
        self.assertIsNone(self.tool.model_layout([1, 3, 224, 224]))
        self.assertIsNone(self.tool.model_layout([1, 128]))

    def test_sweep_for_sface_only_compares_color_on_raw_pixels(self):
        settings = self.tool.sweep_settings(self.sface)
        self.assertEqual(sorted(c for c, _, _, _ in settings), ["BGR", "RGB"])
        for _, mean, std, _ in settings:
            self.assertEqual((mean, std), (0.0, 1.0))

    def test_sweep_for_legacy_arcface_keeps_three_normalizations(self):
        settings = self.tool.sweep_settings(self.tool.PROFILES["arcface-garavv"])
        self.assertEqual(len(settings), 6)


class DoubleNormalization(unittest.TestCase):

    def setUp(self):
        self.tool = load_tool()

    def test_function_refuses_normalizing_before_a_normalizing_graph(self):
        check = self.tool.double_normalization_error
        graph = (127.5, 128.0)
        self.assertIsNone(check(0.0, 1.0, graph))
        for mean, std in [(127.5, 128.0), (127.5, 127.5), (0.0, 255.0), (0.0, 2.0), (1.0, 1.0)]:
            with self.subTest(mean=mean, std=std):
                self.assertIn("double normalization", check(mean, std, graph))
        self.assertIsNone(check(127.5, 128.0, None))       # graph does not normalize

    def test_cli_refuses_arcface_normalization_with_sface(self):
        for args in (
            ["--mean", "127.5", "--std", "128"],
            ["--std", "127.5"],
            ["--mean", "0", "--std", "255"],
            ["--profile", "sface", "--mean", "127.5"],
        ):
            with self.subTest(args=args):
                code, output = run_tool(*args)
                self.assertEqual(code, 2, output)
                self.assertIn("double normalization", output)
                self.assertNotIn("model file not found", output)

    def test_graph_normalization_is_detected_from_the_first_nodes(self):
        # The exact pattern read from face_recognition_sface_2021dec.onnx.
        nodes = [
            {"op": "Sub", "inputs": ["data", "scalar_op1"], "outputs": ["_minusscalar0"]},
            {"op": "Mul", "inputs": ["_minusscalar0", "scalar_op2"], "outputs": ["_mulscalar0"]},
        ]
        found = self.tool.graph_input_normalization(nodes, {"scalar_op1": 127.5, "scalar_op2": 0.0078125}, "data")
        self.assertEqual(found, (127.5, 128.0))

    def test_graph_without_normalization_is_reported_as_none(self):
        detect = self.tool.graph_input_normalization
        self.assertIsNone(detect([{"op": "Transpose", "inputs": ["input_1"], "outputs": ["t"]},
                                  {"op": "Conv", "inputs": ["t", "w"], "outputs": ["c"]}], {}, "input_1"))
        self.assertIsNone(detect([], {}, "data"))
        # Sub on another tensor than the input does not count.
        self.assertIsNone(detect([{"op": "Sub", "inputs": ["x", "c"], "outputs": ["s"]},
                                  {"op": "Mul", "inputs": ["s", "k"], "outputs": ["m"]}],
                                 {"c": 127.5, "k": 0.0078125}, "data"))

    def test_profile_problems_flag_every_mismatch(self):
        sface = self.tool.PROFILES["sface"]
        check = self.tool.profile_problems
        self.assertEqual(check(sface, "data", "fc1", "NCHW", 128, (127.5, 128.0)), [])
        problems = check(sface, "input_1", "embedding", "NHWC", 512, None)
        text = " | ".join(problems)
        for expected in ("input name", "output name", "layout NHWC", "embedding length 512", "inside the graph"):
            self.assertIn(expected, text)
        legacy = self.tool.PROFILES["arcface-garavv"]
        self.assertIn("double normalization", " ".join(check(legacy, "input_1", "embedding", "NHWC", 512, (127.5, 128.0))))


if __name__ == "__main__":
    unittest.main()
