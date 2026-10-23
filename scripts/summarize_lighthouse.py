#!/usr/bin/env python3
"""Summarize exported navigation LHRs; never fetch, audit, or modify a store."""

import argparse
import json
import math
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


AUDITS = {
    "fcp_ms": "first-contentful-paint",
    "lcp_ms": "largest-contentful-paint",
    "cls": "cumulative-layout-shift",
    "tbt_ms": "total-blocking-time",
    "speed_index_ms": "speed-index",
    "server_response_ms": "server-response-time",
    "transfer_bytes": "total-byte-weight",
}
REQUIRED = {"fcp_ms", "lcp_ms", "cls", "tbt_ms"}
GREEN_AUDITS = ["first-contentful-paint", "largest-contentful-paint", "speed-index", "total-blocking-time", "cumulative-layout-shift"]


def numeric(value):
    return (isinstance(value, (float, int)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def normalize_url(value, *, ignore_preview_theme_id=True):
    if not isinstance(value, str):
        raise ValueError("缺少 URL")
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("需要完整 http(s) URL")
    # Only comparisons between before/after groups may change candidate theme.
    query = [(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
             if not ignore_preview_theme_id or key != "preview_theme_id"]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def parse_fetch_time(value):
    """Validate a timezone-qualified ISO timestamp and return its exact UTC instant.

    Preserve fractional digits separately so equivalent offsets/zero padding are
    deduplicated without floating-point rounding of microsecond timestamps.
    """
    match = re.fullmatch(
        r"(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})T(?P<time>[0-9]{2}:[0-9]{2}:[0-9]{2})"
        r"(?:\.(?P<fraction>[0-9]{1,6}))?(?P<offset>Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])",
        value if isinstance(value, str) else "",
    )
    if not match:
        raise ValueError("fetchTime 必须是带 Z 或 UTC offset 的有效 ISO 时间戳")
    offset = match["offset"]
    if offset == "Z":
        offset = "+00:00"
    try:
        instant = datetime.fromisoformat(f"{match['date']}T{match['time']}{offset}").astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise ValueError("fetchTime 包含无效日期、时间或 UTC offset") from exc
    return instant, (match["fraction"] or "").rstrip("0")


def profile(report):
    settings = report.get("configSettings")
    if not isinstance(settings, dict) or settings.get("formFactor") not in ("mobile", "desktop"):
        raise ValueError("缺少有效 configSettings.formFactor")
    version = report.get("lighthouseVersion")
    if not isinstance(version, str) or not version:
        raise ValueError("缺少 lighthouseVersion")
    mode = report.get("gatherMode", "navigation")
    if mode != "navigation":
        raise ValueError("仅支持 navigation 报告，不能混入 timespan/snapshot")
    return {
        "requested_url": normalize_url(report.get("requestedUrl")),
        "final_url": normalize_url(report.get("finalDisplayedUrl") or report.get("finalUrl")),
        "lighthouse_version": version,
        "config_settings": settings,
        "browser_user_agent": report.get("environment", {}).get("hostUserAgent") or report.get("userAgent"),
    }


def summarize(folder):
    folder = Path(folder)
    if not folder.is_dir():
        raise ValueError(f"不是目录：{folder}")
    paths = sorted(folder.glob("*.json"))
    if len(paths) < 5:
        raise ValueError(f"{folder} 至少需要 5 份独立 Lighthouse JSON；当前 {len(paths)} 份")
    values = {key: [] for key in AUDITS}
    values["performance_score"] = []
    common = None
    common_urls = None
    times = set()
    runs = []
    audit_scores = {key: [] for key in GREEN_AUDITS}
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            report = raw.get("lighthouseResult", raw) if isinstance(raw, dict) else raw
            if not isinstance(report, dict) or not isinstance(report.get("audits"), dict):
                raise ValueError("不是 Lighthouse 报告")
            if report.get("runtimeError"):
                raise ValueError(f"Lighthouse runtimeError：{report['runtimeError']}")
            current = profile(report)
            urls = (
                normalize_url(report.get("requestedUrl"), ignore_preview_theme_id=False),
                normalize_url(report.get("finalDisplayedUrl") or report.get("finalUrl"), ignore_preview_theme_id=False),
            )
            if common_urls is not None and urls != common_urls:
                raise ValueError("混入不同组内 URL（包括 preview_theme_id）；每组必须来自同一页面与主题")
            common_urls = urls
            if common is not None and current != common:
                raise ValueError("混入不同 URL、Lighthouse/浏览器版本或 configSettings")
            common = current
            stamp = report.get("fetchTime")
            instant = parse_fetch_time(stamp)
            if instant in times:
                raise ValueError("重复 fetchTime；不能把同一次报告复制成多个样本")
            times.add(instant)
            score = report.get("categories", {}).get("performance", {}).get("score")
            if not numeric(score) or score > 1:
                raise ValueError("缺少有效 Performance score")
            values["performance_score"].append(score * 100)
            for key, audit_id in AUDITS.items():
                audit = report["audits"].get(audit_id, {})
                value = audit.get("numericValue")
                valid = numeric(value) and audit.get("scoreDisplayMode") not in ("error", "notApplicable")
                if key in REQUIRED and not valid:
                    raise ValueError(f"缺少有效的必要指标：{audit_id}")
                if valid:
                    values[key].append(value)
            for audit_id in GREEN_AUDITS:
                audit = report["audits"].get(audit_id, {})
                audit_score = audit.get("score")
                if numeric(audit_score) and audit_score <= 1 and audit.get("scoreDisplayMode") not in ("error", "notApplicable"):
                    audit_scores[audit_id].append(audit_score)
            runs.append({
                "file": str(path.resolve()), "fetch_time": stamp,
                "requested_url": report.get("requestedUrl"),
                "final_url": report.get("finalDisplayedUrl") or report.get("finalUrl"),
                "warnings": report.get("runWarnings", []),
            })
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError(f"{path.name}: {exc}") from exc
    stats = {}
    for key, samples in values.items():
        stats[key] = {
            "n": len(samples),
            "median": statistics.median(samples) if samples else None,
            "min": min(samples) if samples else None,
            "max": max(samples) if samples else None,
            "complete": len(samples) == len(paths),
        }
    green = {key: {"n": len(samples), "median_score": statistics.median(samples) if len(samples) == len(paths) else None,
                   "green": statistics.median(samples) >= 0.9 if len(samples) == len(paths) else None}
             for key, samples in audit_scores.items()}
    return {"profile": common, "run_count": len(paths), "metrics": stats, "runs": runs,
            "strict_green": {"basis": "median audit score >= 0.9 in the supplied locked Lighthouse version; not a release or field-CWV decision",
                             "audits": green, "all_green": all(v["green"] for v in green.values()) if all(v["green"] is not None for v in green.values()) else None}}


def compare(before, after):
    if before["profile"] != after["profile"]:
        raise ValueError("前后 URL、Lighthouse/浏览器版本或 configSettings 不一致，拒绝自动比较")
    before_times = {parse_fetch_time(run["fetch_time"]) for run in before["runs"]}
    if before_times.intersection(parse_fetch_time(run["fetch_time"]) for run in after["runs"]):
        raise ValueError("前后样本存在重复运行；不能比较同一批报告")
    changes = {}
    for key, old in before["metrics"].items():
        new = after["metrics"][key]
        available = old["complete"] and new["complete"]
        changes[key] = {
            "delta_after_minus_before": new["median"] - old["median"] if available else None,
            "percent_change": (100 * (new["median"] - old["median"]) / old["median"]
                               if available and old["median"] != 0 else None),
        }
    return changes


def display(value):
    return "—" if value is None else f"{value:.3f}".rstrip("0").rstrip(".")


def markdown(result):
    lines = ["# Lighthouse 实验室汇总", ""]
    for label in ("before", "after"):
        group = result.get(label)
        if not group:
            continue
        lines += [f"## {label}（{group['run_count']} 次）", "",
                  "| 指标 | n | 中位数 | 最小值 | 最大值 | 样本完整 |",
                  "| --- | ---: | ---: | ---: | ---: | --- |"]
        for key, val in group["metrics"].items():
            lines.append(f"| {key} | {val['n']} | {display(val['median'])} | "
                         f"{display(val['min'])} | {display(val['max'])} | {val['complete']} |")
        lines.append("")
        green = group.get("strict_green", {})
        lines += ["五项全绿（锁定版本 audit score 中位数）：" + str(green.get("all_green")),
                  "缺少任一项 score 时为未验证；不是发布通过或真实用户 CWV 结论。", ""]
    if "changes" in result:
        lines += ["## 差值（后减前）", "", "| 指标 | 差值 | 变化 % |",
                  "| --- | ---: | ---: |"]
        for key, val in result["changes"].items():
            lines.append(f"| {key} | {display(val['delta_after_minus_before'])} | "
                         f"{display(val['percent_change'])} |")
        lines.append("")
    lines += ["差值不是优化通过判定，也不是显著性或因果证明。", "",
              "TTFB 需按同一测量来源单独核对；server_response_ms 是报告中的旧 server-response-time 审计值。",
              "未采集真实 INP。内容、同意、购物车、App、地区及机器负载仍须人工核对。",
              "原始运行警告保存在 JSON 的 runs[].warnings；存在警告时需复核有效性。"]
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path, help="同页同设备的至少 5 份原始 JSON 目录")
    parser.add_argument("after", type=Path, nargs="?", help="可选的优化后原始 JSON 目录")
    parser.add_argument("--output", type=Path, help="输出汇总 JSON，必须在输入目录外且不能已存在")
    args = parser.parse_args(argv)
    try:
        folders = [p.resolve() for p in (args.before, args.after) if p is not None]
        if args.output and (args.output.exists() or args.output.resolve().parent in folders):
            raise ValueError("输出不能覆盖现有文件，也不能写入原始报告目录")
        result = {
            "schema_version": 1,
            "scope": "navigation_lab_only",
            "before": summarize(args.before),
            "manual_checks_required": ["content", "theme identity", "consent", "cart", "apps",
                                       "locale/currency", "region", "cache", "machine load", "runWarnings"],
            "notes": ["Only preview_theme_id is ignored for URL matching.",
                      "Missing values are null, not zero. TBT is not INP.",
                      "server_response_ms is not silently relabeled as full navigation TTFB.",
                      "No automatic improvement, significance, or release decision is made."],
        }
        if args.after:
            result["after"] = summarize(args.after)
            result["changes"] = compare(result["before"], result["after"])
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.write("\n")
        print(markdown(result))
    except (ValueError, OSError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
