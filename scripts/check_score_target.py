#!/usr/bin/env python3
"""Check a Lighthouse laboratory score target using existing independent reports."""

import argparse
import json
import math
import re
import sys
from pathlib import Path

from summarize_lighthouse import compare, summarize


DEVICE_PRESETS = {"mobile": {"minimum": 75, "target": 80},
                  "desktop": {"minimum": 85, "target": 90}}
THROTTLING_FIELDS = {
    "simulate": {"rttMs": 0, "throughputKbps": 0, "cpuSlowdownMultiplier": 1},
    "devtools": {"requestLatencyMs": 0, "downloadThroughputKbps": 0,
                 "uploadThroughputKbps": 0, "cpuSlowdownMultiplier": 1},
}


def validate_profile_evidence(summary):
    """Require explicit browser and throttling evidence, beyond matching profiles.

    Field definitions: https://github.com/GoogleChrome/lighthouse/blob/main/types/lhr/settings.d.ts
    Zero devtools network values disable throttling; provided ignores these values:
    https://github.com/GoogleChrome/lighthouse/blob/main/core/lib/emulation.js
    """
    profile = summary["profile"]
    user_agent = profile["browser_user_agent"]
    if (not isinstance(user_agent, str) or not user_agent.strip()
            or not re.search(r"\b(?:HeadlessChrome|Chrome|Chromium)/\d+(?:\.\d+){1,3}\b", user_agent)):
        raise ValueError("缺少有效浏览器 UA：需要包含 Chrome/HeadlessChrome/Chromium 版本的 hostUserAgent 或 userAgent")
    settings = profile["config_settings"]
    method = settings.get("throttlingMethod")
    if method not in ("simulate", "devtools", "provided"):
        raise ValueError("缺少或不支持 throttlingMethod；必须明确为 simulate、devtools 或 provided")
    if method == "provided":
        return ["provided throttling does not encode the actual externally controlled network/CPU conditions; Lighthouse ignores throttling parameters for this method. Matching JSON configuration cannot establish a controlled environment, so manual review is required."]
    throttling = settings.get("throttling")
    if not isinstance(throttling, dict):
        raise ValueError(f"{method} 缺少明确的 throttling 配置")
    for field, lower_bound in THROTTLING_FIELDS[method].items():
        value = throttling.get(field)
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value < lower_bound
                or (field == "throughputKbps" and value == 0)):
            raise ValueError(f"{method} 缺少或无效 throttling.{field}")
    return []


def validate_thresholds(minimum, target):
    values = (minimum, target)
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) for value in values):
        raise ValueError("评分阈值必须为有限数字")
    if not 0 <= minimum <= target <= 100:
        raise ValueError("评分阈值必须满足 0 <= minimum <= target <= 100")


def check_score_target(before, after, minimum=None, target=None):
    """Return a lab-only decision; warning-bearing evidence never passes."""
    before_summary = summarize(before)
    after_summary = summarize(after)
    changes = compare(before_summary, after_summary)
    review_reasons = validate_profile_evidence(before_summary)
    # compare() has already required identical configuration and browser UA.
    validate_profile_evidence(after_summary)
    device = after_summary["profile"]["config_settings"]["formFactor"]
    defaults = DEVICE_PRESETS[device]
    sources = {"minimum": "device-default" if minimum is None else "user",
               "target": "device-default" if target is None else "user"}
    minimum = defaults["minimum"] if minimum is None else minimum
    target = defaults["target"] if target is None else target
    validate_thresholds(minimum, target)
    score = after_summary["metrics"]["performance_score"]
    checks = {
        "every_after_run_meets_minimum": score["min"] >= minimum,
        "after_median_meets_target": score["median"] >= target,
    }
    warnings = [
        {"group": group, "file": run["file"], "warnings": run["warnings"]}
        for group, summary in (("before", before_summary), ("after", after_summary))
        for run in summary["runs"] if run["warnings"]
    ]
    if warnings:
        review_reasons.append("One or more supplied Lighthouse reports contain runWarnings; review the original warnings before accepting the score evidence.")
    thresholds_met = all(checks.values())
    passed = thresholds_met and not review_reasons
    return {
        "schema_version": 1,
        "scope": "navigation_lab_score_target_only",
        "status": "review-required" if review_reasons else "passed" if passed else "failed",
        "score_target_met": passed,
        "device": device,
        "preset": {"name": device, "defaults": dict(defaults), "sources": sources,
                   "basis": "Project acceptance defaults, not a Lighthouse standard: mobile 75 minimum / 80 median; desktop 85 minimum / 90 median."},
        "thresholds": {"minimum_each_after_run": minimum, "target_after_median": target},
        "checks": checks,
        "before": before_summary,
        "after": after_summary,
        "changes": changes,
        "run_warnings": warnings,
        "review_reasons": review_reasons,
        "notes": [
            "Scores come directly from categories.performance.score in supplied reports, multiplied by 100; no metric weights are recomputed.",
            "Threshold comparisons use unrounded values. Every after run must meet the minimum and the after median must meet the target.",
            "Each group requires at least five independent navigation reports with matching URL, device, Lighthouse/browser version and configuration; before and after runs cannot overlap.",
            "Only preview_theme_id is ignored when matching URLs. Theme identity and comparable test conditions require manual verification.",
            "Any non-empty runWarnings in either group requires review and prevents a passing decision.",
            "Explicit browser UA and applicable throttling fields are required. Matching these report fields does not prove identical hardware, machine load, physical network, consent or cache conditions.",
            "provided throttling always requires review because its actual network and CPU conditions are external to the report configuration; included throttling numbers do not establish applied limits.",
            "This is a laboratory score threshold only: it does not establish functional or visual acceptance, field CWV, statistical significance, causality, or future performance guarantees.",
        ],
    }


def validate_output(output, before, after):
    """Reject existing destinations and every path within either report directory."""
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError("输出不能覆盖任何现有文件或符号链接")
    destination = output.resolve()
    if any(destination.is_relative_to(Path(folder).resolve()) for folder in (before, after)):
        raise ValueError("输出不能写入原始报告目录或其子目录")
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True, help="至少 5 份优化前原始 Lighthouse JSON 的目录")
    parser.add_argument("--after", type=Path, required=True, help="至少 5 份优化后原始 Lighthouse JSON 的目录")
    parser.add_argument("--minimum", type=float, help="优化后每次最低分；按报告设备默认 mobile 75、desktop 85")
    parser.add_argument("--target", type=float, help="优化后中位数目标；按报告设备默认 mobile 80、desktop 90")
    parser.add_argument("--output", type=Path, help="可选：输入目录之外的全新 JSON 文件")
    args = parser.parse_args(argv)
    try:
        output = validate_output(args.output, args.before, args.after) if args.output else None
        result = check_score_target(args.before, args.after, args.minimum, args.target)
        payload = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if output:
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("x", encoding="utf-8") as stream:
                stream.write(payload)
        print(payload, end="")
        return 0 if result["score_target_met"] else 3
    except (ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
