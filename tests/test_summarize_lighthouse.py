"""Synthetic test fixtures only; these values are not store measurements."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from summarize_lighthouse import compare, main, summarize


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def reports(self, name="before", theme="1", shift=0, offset=0):
        folder = self.root / name
        folder.mkdir()
        for index, lcp in enumerate([1000, 2000, 3000, 4000, 10000]):
            report = {
                "gatherMode": "navigation", "lighthouseVersion": "test-fixture",
                "fetchTime": f"2026-09-16T00:{index + offset:02d}:00Z",
                "requestedUrl": f"https://example.test/products/a?preview_theme_id={theme}&pb=0",
                "finalDisplayedUrl": f"https://example.test/products/a?preview_theme_id={theme}&pb=0",
                "userAgent": "synthetic-browser",
                "configSettings": {"formFactor": "mobile", "throttlingMethod": "simulate"},
                "categories": {"performance": {"score": 0.6}},
                "runWarnings": [],
                "audits": {key: {"numericValue": value} for key, value in {
                    "first-contentful-paint": 500,
                    "largest-contentful-paint": lcp + shift,
                    "cumulative-layout-shift": 0,
                    "total-blocking-time": 0,
                    "total-byte-weight": 200000,
                }.items()},
            }
            (folder / f"run-{index}.json").write_text(json.dumps(report), encoding="utf-8")
        return folder

    def mutate(self, folder, change):
        path = folder / "run-0.json"
        report = json.loads(path.read_text())
        change(report)
        path.write_text(json.dumps(report))

    def test_median_range_missing_and_true_zero(self):
        result = summarize(self.reports())
        self.assertEqual(result["metrics"]["lcp_ms"]["median"], 3000)
        self.assertEqual(result["metrics"]["lcp_ms"]["max"], 10000)
        self.assertEqual(result["metrics"]["cls"]["median"], 0)
        self.assertIsNone(result["metrics"]["server_response_ms"]["median"])

    def test_valid_theme_comparison_and_zero_denominator(self):
        before = summarize(self.reports())
        after = summarize(self.reports("after", theme="2", shift=-500, offset=10))
        result = compare(before, after)
        self.assertEqual(result["lcp_ms"]["delta_after_minus_before"], -500)
        self.assertIsNone(result["cls"]["percent_change"])
        self.assertIsNone(result["server_response_ms"]["delta_after_minus_before"])

    def test_insufficient_samples(self):
        folder = self.reports()
        (folder / "run-0.json").unlink()
        with self.assertRaisesRegex(ValueError, "至少需要 5"):
            summarize(folder)

    def test_mixed_device_or_page_or_version_rejected(self):
        changes = [
            lambda r: r["configSettings"].update(formFactor="desktop"),
            lambda r: r.update(requestedUrl="https://example.test/collections/b"),
            lambda r: r.update(lighthouseVersion="another-version"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                folder = self.reports(f"group-{index}")
                self.mutate(folder, change)
                with self.assertRaisesRegex(ValueError, "混入不同"):
                    summarize(folder)

    def test_runtime_error_and_missing_required_metric(self):
        for index, change in enumerate([
            lambda r: r.update(runtimeError={"code": "NO_FCP"}),
            lambda r: r["audits"].pop("largest-contentful-paint"),
            lambda r: r["audits"]["largest-contentful-paint"].update(numericValue=float("nan")),
        ]):
            with self.subTest(index=index):
                folder = self.reports(f"bad-{index}")
                self.mutate(folder, change)
                with self.assertRaises(ValueError):
                    summarize(folder)

    def test_duplicate_and_overlapping_runs(self):
        before = summarize(self.reports())
        with self.assertRaisesRegex(ValueError, "重复运行"):
            compare(before, before)
        folder = self.reports("duplicate")
        self.mutate(folder, lambda r: r.update(fetchTime="2026-09-16T00:01:00Z"))
        with self.assertRaisesRegex(ValueError, "重复 fetchTime"):
            summarize(folder)

    def test_partial_optional_metric_never_compared(self):
        folder = self.reports()
        self.mutate(folder, lambda r: r["audits"].update({"server-response-time": {"numericValue": 80}}))
        before = summarize(folder)
        after = summarize(self.reports("after", offset=10))
        self.assertEqual(before["metrics"]["server_response_ms"]["n"], 1)
        self.assertFalse(before["metrics"]["server_response_ms"]["complete"])
        self.assertIsNone(compare(before, after)["server_response_ms"]["delta_after_minus_before"])

    def test_different_comparison_config_rejected(self):
        before = summarize(self.reports())
        after = summarize(self.reports("after", offset=10))
        after["profile"]["config_settings"]["throttlingMethod"] = "provided"
        with self.assertRaisesRegex(ValueError, "拒绝自动比较"):
            compare(before, after)

    def test_cli_output_and_no_clobber(self):
        folder = self.reports()
        output = self.root / "summary.json"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(main([str(folder), "--output", str(output)]), 0)
            content = output.read_text()
            self.assertEqual(main([str(folder), "--output", str(output)]), 2)
            self.assertEqual(output.read_text(), content)
            self.assertEqual(main([str(folder), "--output", str(folder / "summary.json")]), 2)
        self.assertEqual(json.loads(content)["before"]["run_count"], 5)

    def test_psi_wrapper_and_warnings_preserved(self):
        folder = self.reports()
        self.mutate(folder, lambda r: r.update(runWarnings=["synthetic warning"]))
        for path in folder.glob("*.json"):
            data = json.loads(path.read_text())
            path.write_text(json.dumps({"lighthouseResult": data}))
        self.assertEqual(summarize(folder)["runs"][0]["warnings"], ["synthetic warning"])

    def scored_reports(self):
        folder = self.reports()
        for index, path in enumerate(sorted(folder.glob("*.json"))):
            report = json.loads(path.read_text())
            report["audits"]["speed-index"] = {"numericValue": 1000 + index * 100}
            for key in ("first-contentful-paint", "largest-contentful-paint", "speed-index",
                        "total-blocking-time", "cumulative-layout-shift"):
                report["audits"][key]["score"] = 0.9
            path.write_text(json.dumps(report))
        return folder

    def test_speed_index_and_green_boundary_are_report_scores(self):
        result = summarize(self.scored_reports())
        self.assertEqual(result["metrics"]["speed_index_ms"]["median"], 1200)
        self.assertTrue(result["strict_green"]["all_green"])
        self.assertEqual(result["strict_green"]["audits"]["speed-index"]["median_score"], 0.9)

    def test_missing_one_score_cannot_claim_all_green(self):
        folder = self.scored_reports()
        self.mutate(folder, lambda r: r["audits"]["speed-index"].pop("score"))
        result = summarize(folder)
        self.assertIsNone(result["strict_green"]["all_green"])
        self.assertIsNone(result["strict_green"]["audits"]["speed-index"]["green"])
        self.assertEqual(result["metrics"]["speed_index_ms"]["n"], 5)

    def test_non_green_median_cannot_be_hidden_by_overall_score(self):
        folder = self.scored_reports()
        for path in folder.glob("*.json"):
            report = json.loads(path.read_text())
            report["categories"]["performance"]["score"] = 1
            report["audits"]["speed-index"]["score"] = 0.89
            path.write_text(json.dumps(report))
        result = summarize(folder)
        self.assertFalse(result["strict_green"]["all_green"])


if __name__ == "__main__":
    unittest.main()
