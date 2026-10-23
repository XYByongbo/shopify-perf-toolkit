"""Synthetic fixtures only: none of these values are store measurements."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from check_score_target import check_score_target, main


class ScoreTargetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def reports(self, name, scores, offset=0, device="mobile"):
        folder = self.root / name
        folder.mkdir()
        for index, score in enumerate(scores):
            report = {
                "gatherMode": "navigation", "lighthouseVersion": "synthetic-test-fixture",
                "fetchTime": f"2026-10-16T00:{offset + index:02d}:00Z",
                "requestedUrl": "https://example.test/products/a?preview_theme_id=1",
                "finalDisplayedUrl": "https://example.test/products/a?preview_theme_id=1",
                "userAgent": "Mozilla/5.0 (Synthetic test fixture) HeadlessChrome/130.0.0.0 Safari/537.36",
                "environment": {
                    "hostUserAgent": "Mozilla/5.0 (Synthetic test fixture) HeadlessChrome/130.0.0.0 Safari/537.36",
                    "networkUserAgent": "Mozilla/5.0 (Synthetic test fixture) Chrome/130.0.0.0 Safari/537.36",
                    "benchmarkIndex": 1000,
                },
                "configSettings": {"formFactor": device, "throttlingMethod": "simulate",
                                   "throttling": {"rttMs": 150, "throughputKbps": 1638.4,
                                                  "cpuSlowdownMultiplier": 4}},
                "categories": {"performance": {"score": score / 100}},
                "runWarnings": [],
                "audits": {key: {"numericValue": value} for key, value in {
                    "first-contentful-paint": 1000, "largest-contentful-paint": 2000,
                    "cumulative-layout-shift": 0.05, "total-blocking-time": 100,
                }.items()},
            }
            (folder / f"run-{index}.json").write_text(json.dumps(report), encoding="utf-8")
        return folder

    def groups(self, scores=(75, 79, 80, 81, 85), device="mobile"):
        return (self.reports("before", [50] * 5, device=device),
                self.reports("after", scores, offset=10, device=device))

    def mutate_groups(self, before, after, change):
        for folder in (before, after):
            for index in range(5):
                self.mutate(folder, change, index)

    def mutate(self, folder, change, index=0):
        path = folder / f"run-{index}.json"
        report = json.loads(path.read_text())
        change(report)
        path.write_text(json.dumps(report), encoding="utf-8")

    def cli(self, before, after, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(["--before", str(before), "--after", str(after), *map(str, extra)])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_exact_75_minimum_and_80_median_pass(self):
        before, after = self.groups()
        result = check_score_target(before, after)
        self.assertTrue(result["score_target_met"])
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["after"]["metrics"]["performance_score"],
                         {"n": 5, "median": 80, "min": 75, "max": 85, "complete": True})
        self.assertEqual(result["changes"]["performance_score"]["delta_after_minus_before"], 30)
        self.assertEqual(result["scope"], "navigation_lab_score_target_only")
        self.assertEqual(result["device"], "mobile")
        self.assertEqual(result["preset"]["defaults"], {"minimum": 75, "target": 80})
        self.assertEqual(result["preset"]["sources"], {"minimum": "device-default", "target": "device-default"})

    def test_desktop_defaults_are_85_minimum_and_90_median(self):
        before, after = self.groups([85, 89, 90, 91, 95], device="desktop")
        result = check_score_target(before, after)
        self.assertTrue(result["score_target_met"])
        self.assertEqual(result["device"], "desktop")
        self.assertEqual(result["thresholds"], {"minimum_each_after_run": 85, "target_after_median": 90})
        self.assertEqual(result["preset"]["defaults"], {"minimum": 85, "target": 90})
        self.assertEqual(json.loads(self.cli(before, after)[1])["device"], "desktop")

    def test_desktop_does_not_pass_mobile_defaults(self):
        before, after = self.groups(device="desktop")
        result = check_score_target(before, after)
        self.assertFalse(result["score_target_met"])
        custom = check_score_target(before, after, minimum=75, target=80)
        self.assertTrue(custom["score_target_met"])
        self.assertEqual(custom["preset"]["sources"], {"minimum": "user", "target": "user"})
        self.assertEqual(self.cli(before, after, "--minimum", "75", "--target", "80")[0], 0)

    def test_single_threshold_override_keeps_other_device_default(self):
        before, after = self.groups([85, 90, 92, 95, 98], device="desktop")
        result = check_score_target(before, after, target=92)
        self.assertEqual(result["thresholds"], {"minimum_each_after_run": 85, "target_after_median": 92})
        self.assertEqual(result["preset"]["sources"], {"minimum": "device-default", "target": "user"})
        self.assertTrue(result["score_target_met"])

    def test_missing_ua_and_throttling_does_not_pass_even_when_consistent(self):
        before, after = self.groups([80] * 5)
        def remove_evidence(report):
            report.pop("userAgent")
            report.pop("environment")
            report["configSettings"] = {"formFactor": "mobile"}
        self.mutate_groups(before, after, remove_evidence)
        with self.assertRaisesRegex(ValueError, "UA"):
            check_score_target(before, after)
        code, stdout, _ = self.cli(before, after)
        self.assertEqual((code, stdout), (2, ""))

    def test_missing_blank_or_placeholder_browser_ua_rejected(self):
        before, after = self.groups()
        for ua in (None, "", "   ", 123, "synthetic-browser", "Chrome/no-version"):
            with self.subTest(ua=ua):
                def replace_ua(report):
                    report.pop("environment", None)
                    report["userAgent"] = ua
                self.mutate_groups(before, after, replace_ua)
                with self.assertRaisesRegex(ValueError, "UA"):
                    check_score_target(before, after)

    def test_valid_top_level_ua_fallback_and_host_ua_supported(self):
        before, after = self.groups()
        self.mutate_groups(before, after, lambda report: report.pop("environment"))
        self.assertTrue(check_score_target(before, after)["score_target_met"])
        def use_host(report):
            report["environment"] = {"hostUserAgent": report.pop("userAgent")}
        self.mutate_groups(before, after, use_host)
        self.assertTrue(check_score_target(before, after)["score_target_met"])

    def test_explicit_supported_throttling_method_required(self):
        before, after = self.groups()
        for method in (None, "", "external", True):
            with self.subTest(method=method):
                self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttlingMethod=method))
                with self.assertRaisesRegex(ValueError, "throttlingMethod"):
                    check_score_target(before, after)

    def test_simulate_requires_its_network_and_cpu_fields(self):
        before, after = self.groups()
        valid = {"rttMs": 150, "throughputKbps": 1638.4, "cpuSlowdownMultiplier": 4}
        invalid_configs = [None, {}, {"rttMs": 150}, {**valid, "rttMs": -1},
                           {**valid, "throughputKbps": 0}, {**valid, "rttMs": True},
                           {**valid, "cpuSlowdownMultiplier": 0.5},
                           {**valid, "throughputKbps": float("inf")}]
        for throttling in invalid_configs:
            with self.subTest(throttling=throttling):
                self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttling=throttling))
                with self.assertRaises(ValueError):
                    check_score_target(before, after)

    def test_devtools_requires_its_own_fields_and_accepts_explicit_zero_network(self):
        before, after = self.groups()
        self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttlingMethod="devtools"))
        with self.assertRaisesRegex(ValueError, "requestLatencyMs"):
            check_score_target(before, after)
        valid = {"requestLatencyMs": 150, "downloadThroughputKbps": 1500,
                 "uploadThroughputKbps": 750, "cpuSlowdownMultiplier": 4}
        for field in valid:
            bad = {key: value for key, value in valid.items() if key != field}
            self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttling=bad))
            with self.assertRaisesRegex(ValueError, field):
                check_score_target(before, after)
        self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttling=valid))
        self.assertTrue(check_score_target(before, after)["score_target_met"])
        unthrottled = {key: 0 if key != "cpuSlowdownMultiplier" else 1 for key in valid}
        self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttling=unthrottled))
        self.assertTrue(check_score_target(before, after)["score_target_met"])

    def test_provided_cannot_claim_external_environment_is_locked(self):
        before, after = self.groups()
        self.mutate_groups(before, after, lambda report: report["configSettings"].update(throttlingMethod="provided"))
        result = check_score_target(before, after)
        self.assertEqual(result["status"], "review-required")
        self.assertFalse(result["score_target_met"])
        self.assertTrue(all(result["checks"].values()))
        self.assertIn("externally controlled", result["review_reasons"][0])
        self.assertEqual(self.cli(before, after)[0], 3)

    def test_minimum_failure_is_not_rounded_up(self):
        result = check_score_target(*self.groups([74.99999, 80, 80, 85, 90]))
        self.assertFalse(result["score_target_met"])
        self.assertFalse(result["checks"]["every_after_run_meets_minimum"])
        self.assertTrue(result["checks"]["after_median_meets_target"])
        self.assertEqual(result["status"], "failed")

    def test_median_failure_is_not_rounded_up(self):
        result = check_score_target(*self.groups([75, 78, 79.99999, 85, 90]))
        self.assertFalse(result["score_target_met"])
        self.assertTrue(result["checks"]["every_after_run_meets_minimum"])
        self.assertFalse(result["checks"]["after_median_meets_target"])

    def test_report_category_score_is_used_without_reweighting_metrics(self):
        before, after = self.groups([10] * 5)
        for index in range(5):
            self.mutate(after, lambda report: report["audits"].update({
                "first-contentful-paint": {"numericValue": 0, "score": 1},
                "largest-contentful-paint": {"numericValue": 0, "score": 1},
                "cumulative-layout-shift": {"numericValue": 0, "score": 1},
                "total-blocking-time": {"numericValue": 0, "score": 1},
            }), index=index)
        result = check_score_target(before, after)
        self.assertEqual(result["after"]["metrics"]["performance_score"]["median"], 10)
        self.assertFalse(result["score_target_met"])

    def test_warnings_in_either_group_require_review_even_with_passing_scores(self):
        before, after = self.groups()
        for folder in (before, after):
            with self.subTest(folder=folder.name):
                self.mutate(folder, lambda report: report.update(runWarnings=["synthetic warning"]))
                result = check_score_target(before, after)
                self.assertEqual(result["status"], "review-required")
                self.assertFalse(result["score_target_met"])
                self.assertTrue(all(result["checks"].values()))
                self.assertEqual(result["run_warnings"][0]["group"], folder.name)
                self.assertEqual(self.cli(before, after)[0], 3)
                self.mutate(folder, lambda report: report.update(runWarnings=[]))

    def test_invalid_thresholds_rejected_by_function_and_cli(self):
        before, after = self.groups()
        for minimum, target in [(-1, 80), (81, 80), (75, 101), (float("nan"), 80),
                                (75, float("inf")), (True, 80), (75, "80")]:
            with self.subTest(minimum=minimum, target=target):
                with self.assertRaises(ValueError):
                    check_score_target(before, after, minimum, target)
        for minimum, target in [("nan", "80"), ("75", "inf"), ("81", "80")]:
            self.assertEqual(self.cli(before, after, "--minimum", minimum, "--target", target)[0], 2)

    def test_valid_custom_threshold_boundaries(self):
        before, after = self.groups([0] * 5)
        self.assertTrue(check_score_target(before, after, 0, 0)["score_target_met"])
        for index in range(5):
            self.mutate(after, lambda report: report["categories"]["performance"].update(score=1), index)
        self.assertTrue(check_score_target(before, after, 100, 100)["score_target_met"])

    def test_missing_empty_or_insufficient_reports_rejected(self):
        before, after = self.groups()
        empty = self.root / "empty"
        empty.mkdir()
        for bad in (empty, self.root / "missing"):
            with self.assertRaises(ValueError):
                check_score_target(before, bad)
            code, stdout, _ = self.cli(before, bad)
            self.assertEqual(code, 2)
            self.assertEqual(stdout, "")
        (after / "run-0.json").unlink()
        with self.assertRaisesRegex(ValueError, "至少需要 5"):
            check_score_target(before, after)

    def test_corrupt_and_non_report_files_rejected(self):
        before, after = self.groups()
        path = after / "run-0.json"
        for text in ("{broken", "{}", "[]", '{"score_target_met": true}'):
            with self.subTest(text=text):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    check_score_target(before, after)
                self.assertEqual(self.cli(before, after)[0], 2)

    def test_invalid_report_scores_and_runtime_errors_rejected(self):
        before, after = self.groups()
        path = after / "run-0.json"
        original = path.read_text()
        changes = [
            lambda report: report["categories"]["performance"].pop("score"),
            lambda report: report["categories"]["performance"].update(score=float("nan")),
            lambda report: report["categories"]["performance"].update(score=1.01),
            lambda report: report.update(runtimeError={"code": "SYNTHETIC_ERROR"}),
            lambda report: report["audits"].pop("largest-contentful-paint"),
        ]
        for change in changes:
            path.write_text(original)
            self.mutate(after, change)
            with self.assertRaises(ValueError):
                check_score_target(before, after)

    def test_duplicates_within_and_across_groups_rejected(self):
        before, after = self.groups()
        with self.assertRaisesRegex(ValueError, "重复运行"):
            check_score_target(before, before)
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T00:11:00Z"))
        with self.assertRaisesRegex(ValueError, "重复 fetchTime"):
            check_score_target(before, after)
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T00:00:00Z"))
        with self.assertRaisesRegex(ValueError, "重复运行"):
            check_score_target(before, after)

    def test_invalid_or_timezone_free_fetch_times_cannot_pass(self):
        before, after = self.groups()
        for stamp in ("not-a-date", "2026-10-16", "2026-10-16T00:10:00",
                      "2026-02-30T00:10:00Z", "2026-10-16T25:10:00Z",
                      "2026-10-16T00:60:00Z", "2026-10-16T00:10:00+24:00",
                      "2026-10-16T00:10:00+01:60", "2026-10-16 00:10:00Z",
                      "2026-10-16T00:10:00Z ", "0000-10-16T00:10:00Z",
                      "2026-10-16t00:10:00z", "2026-10-16T00:10:00.1234567Z", None, 123):
            with self.subTest(stamp=stamp):
                self.mutate(after, lambda report: report.update(fetchTime=stamp))
                with self.assertRaisesRegex(ValueError, "fetchTime"):
                    check_score_target(before, after)
                code, stdout, _ = self.cli(before, after)
                self.assertEqual((code, stdout), (2, ""))
        for index in range(5):
            self.mutate(after, lambda report, index=index: report.update(fetchTime=f"not-a-date-{index}"), index)
        with self.assertRaisesRegex(ValueError, "fetchTime"):
            check_score_target(before, after)

    def test_iso_utc_and_offset_fetch_times_preserve_original_evidence(self):
        before, after = self.groups()
        stamps = ["2026-10-16T00:10:00.123Z", "2026-10-16T08:11:00.123+08:00",
                  "2026-10-15T17:12:00.123-07:00", "2026-10-16T00:13:00.123+00:00",
                  "2026-10-16T00:14:00.123456Z"]
        for index, stamp in enumerate(stamps):
            self.mutate(after, lambda report, stamp=stamp: report.update(fetchTime=stamp), index)
        result = check_score_target(before, after)
        self.assertTrue(result["score_target_met"])
        self.assertEqual([run["fetch_time"] for run in result["after"]["runs"]], stamps)

    def test_equivalent_utc_offset_and_fraction_forms_are_duplicate_samples(self):
        before, after = self.groups()
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T08:11:00.000+08:00"))
        with self.assertRaisesRegex(ValueError, "重复 fetchTime"):
            check_score_target(before, after)
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-15T17:00:00.000000-07:00"))
        with self.assertRaisesRegex(ValueError, "重复运行"):
            check_score_target(before, after)

    def test_timestamp_fraction_precision_is_not_rounded_into_duplicates(self):
        before, after = self.groups()
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T00:10:00.000001Z"), 0)
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T00:10:00.000002Z"), 1)
        self.assertTrue(check_score_target(before, after)["score_target_met"])
        self.mutate(after, lambda report: report.update(fetchTime="2026-10-16T08:10:00.000001+08:00"), 1)
        with self.assertRaisesRegex(ValueError, "重复 fetchTime"):
            check_score_target(before, after)

    def test_preview_theme_must_be_consistent_within_each_group(self):
        before, after = self.groups()
        for field in ("requestedUrl", "finalDisplayedUrl"):
            with self.subTest(field=field):
                self.mutate(after, lambda report: report.update({field: "https://example.test/products/a?preview_theme_id=2"}))
                with self.assertRaisesRegex(ValueError, "组内 URL"):
                    check_score_target(before, after)
                self.mutate(after, lambda report: report.update({field: "https://example.test/products/a?preview_theme_id=1"}))

    def test_before_after_may_change_preview_theme_but_not_other_url_parameters(self):
        before, after = self.groups()
        for index in range(5):
            self.mutate(after, lambda report: report.update(
                requestedUrl="https://example.test/products/a?preview_theme_id=2",
                finalDisplayedUrl="https://example.test/products/a?preview_theme_id=2"), index)
        self.assertTrue(check_score_target(before, after)["score_target_met"])
        for index in range(5):
            self.mutate(after, lambda report: report.update(
                requestedUrl="https://example.test/products/a?preview_theme_id=2&variant=123",
                finalDisplayedUrl="https://example.test/products/a?preview_theme_id=2&variant=123"), index)
        with self.assertRaisesRegex(ValueError, "拒绝自动比较"):
            check_score_target(before, after)

    def test_mixed_url_device_and_lighthouse_config_rejected(self):
        before, after = self.groups()
        path = after / "run-0.json"
        original = path.read_text()
        for change in (
            lambda report: report.update(requestedUrl="https://example.test/other"),
            lambda report: report["configSettings"].update(formFactor="desktop"),
            lambda report: report["configSettings"].update(throttlingMethod="provided"),
            lambda report: report.update(lighthouseVersion="different-version"),
        ):
            path.write_text(original)
            self.mutate(after, change)
            with self.assertRaisesRegex(ValueError, "混入不同"):
                check_score_target(before, after)

    def test_consistent_but_different_before_after_profile_rejected(self):
        before, after = self.groups()
        for index in range(5):
            self.mutate(after, lambda report: report["configSettings"].update(formFactor="desktop"), index)
        with self.assertRaisesRegex(ValueError, "拒绝自动比较"):
            check_score_target(before, after)

    def test_cli_prints_json_without_creating_files(self):
        before, after = self.groups()
        original_files = set(self.root.rglob("*"))
        code, stdout, stderr = self.cli(before, after)
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(json.loads(stdout)["score_target_met"])
        self.assertEqual(set(self.root.rglob("*")), original_files)

    def test_cli_failure_exit_and_saved_result(self):
        before, after = self.groups([74, 80, 80, 85, 90])
        output = self.root / "results" / "target.json"
        code, stdout, stderr = self.cli(before, after, "--output", output)
        self.assertEqual((code, stderr), (3, ""))
        self.assertEqual(json.loads(output.read_text()), json.loads(stdout))
        self.assertFalse(json.loads(stdout)["score_target_met"])

    def test_existing_output_never_overwritten(self):
        before, after = self.groups()
        output = self.root / "result.json"
        output.write_text("preserve existing content")
        code, stdout, _ = self.cli(before, after, "--output", output)
        self.assertEqual((code, stdout), (2, ""))
        self.assertEqual(output.read_text(), "preserve existing content")

    def test_input_directory_and_any_child_output_rejected(self):
        before, after = self.groups()
        for folder in (before, after):
            for output in (folder, folder / "result.json", folder / "nested" / "deeper" / "result.json"):
                with self.subTest(output=output):
                    self.assertEqual(self.cli(before, after, "--output", output)[0], 2)
            self.assertFalse((folder / "nested").exists())
            self.assertFalse((folder / "result.json").exists())

    def test_symlink_input_alias_and_dangling_output_rejected(self):
        before, after = self.groups()
        alias = self.root / "alias"
        alias.symlink_to(after, target_is_directory=True)
        self.assertEqual(self.cli(before, after, "--output", alias / "nested" / "result.json")[0], 2)
        dangling = self.root / "dangling.json"
        dangling.symlink_to(self.root / "missing-target.json")
        self.assertEqual(self.cli(before, after, "--output", dangling)[0], 2)
        self.assertTrue(dangling.is_symlink())
        self.assertFalse((self.root / "missing-target.json").exists())

    def test_invalid_input_does_not_create_output(self):
        before, after = self.groups()
        (after / "run-0.json").write_text("{}")
        output = self.root / "new" / "result.json"
        self.assertEqual(self.cli(before, after, "--output", output)[0], 2)
        self.assertFalse(output.parent.exists())

    def test_executable_cli_and_required_arguments(self):
        before, after = self.groups()
        script = Path(__file__).resolve().parents[1] / "scripts" / "check_score_target.py"
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, str(script), "--before", str(before),
                                 "--after", str(after)], capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["score_target_met"])
        missing = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, env=environment)
        self.assertEqual(missing.returncode, 2)
        self.assertEqual(missing.stdout, "")


if __name__ == "__main__":
    unittest.main()
