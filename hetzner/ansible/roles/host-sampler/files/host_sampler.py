#!/usr/bin/env python3
"""Samples host CPU busy, available memory and disk used for the prod-triage stream.

A check trips once it has been out of range for its number of samples in a row, and the trip
is appended as one JSON line in the prod-triage backlog shape:
{"ts": ..., "trips": [{"check", "kind", "value", "threshold", "minutes_in_a_row"}]}.
A check that stays out of range posts again once its repeat interval has passed.
Stdlib only, so it runs on the host's system python3.
"""

import json
import math
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


@dataclass
class ThresholdCheck:
    name: str
    kind: str
    threshold: int
    samples_needed: int
    above: bool

    def out_of_range(self, value: float) -> bool:
        return value > self.threshold if self.above else value < self.threshold


class ThresholdTracker:
    """Counts each check's out-of-range streak and decides when a trip posts."""

    def __init__(self, checks: list[ThresholdCheck], interval_seconds: int, repeat_minutes: int):
        self.checks = checks
        self.interval_seconds = interval_seconds
        self.repeat = timedelta(minutes=repeat_minutes)
        self.streaks = {check.name: 0 for check in checks}
        self.last_posted: dict[str, datetime] = {}

    def observe(self, values: dict, now: datetime) -> list[dict]:
        return [trip for check in self.checks if (trip := self._observe_one(check, values[check.name], now))]

    def _observe_one(self, check: ThresholdCheck, value: float, now: datetime) -> dict | None:
        if not check.out_of_range(value):
            self.streaks[check.name] = 0
            self.last_posted.pop(check.name, None)
            return None
        self.streaks[check.name] += 1
        if self.streaks[check.name] < check.samples_needed:
            return None
        last = self.last_posted.get(check.name)
        if last and now - last < self.repeat:
            return None
        self.last_posted[check.name] = now
        return self._build_trip(check, value)

    def _build_trip(self, check: ThresholdCheck, value: float) -> dict:
        minutes = math.ceil(self.streaks[check.name] * self.interval_seconds / 60)
        return {"check": check.name, "kind": check.kind, "value": value, "threshold": check.threshold, "minutes_in_a_row": minutes}


def build_stream_line(now: datetime, trips: list[dict]) -> dict:
    return {"ts": now.astimezone(timezone.utc).isoformat(timespec="seconds"), "trips": trips}


def append(path: Path, line: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        stream.write(json.dumps(line) + "\n")


def parse_proc_stat(text: str) -> tuple[int, int]:
    """Returns total and idle jiffies; guest time is already counted inside user."""
    fields = [int(field) for field in text.splitlines()[0].split()[1:9]]
    idle = fields[3] + fields[4]
    return sum(fields), idle


def compute_cpu_busy_pct(prev: tuple[int, int], cur: tuple[int, int]) -> float:
    total = cur[0] - prev[0]
    idle = cur[1] - prev[1]
    return round(100 * (total - idle) / total, 1) if total else 0.0


def parse_mem_available_mb(text: str) -> int:
    for line in text.splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise ValueError("MemAvailable missing from /proc/meminfo")


def read_disk_used_pct(path: str) -> float:
    """Used share the way df reports it: blocks reserved for root count as neither used nor free."""
    stat = os.statvfs(path)
    used = stat.f_blocks - stat.f_bfree
    usable = used + stat.f_bavail
    return round(100 * used / usable, 1) if usable else 0.0


def _read_env(name: str, default: str) -> str:
    return os.environ.get(f"HOST_SAMPLER_{name}", default)


def load_checks_from_env() -> list[ThresholdCheck]:
    return [
        ThresholdCheck("host_cpu", "cpu", int(_read_env("CPU_BUSY_PCT", "85")), int(_read_env("CPU_SAMPLES", "8")), above=True),
        ThresholdCheck("mem_available", "memory", int(_read_env("MEM_AVAILABLE_MB", "400")), int(_read_env("MEM_SAMPLES", "4")), above=False),
        ThresholdCheck("disk", "disk", int(_read_env("DISK_USED_PCT", "85")), 1, above=True),
    ]


def main() -> None:
    interval = int(_read_env("INTERVAL_SECONDS", "15"))
    output = Path(_read_env("OUTPUT", "/var/log/prod-triage/stream.jsonl"))
    disk_path = _read_env("DISK_PATH", "/")
    tracker = ThresholdTracker(load_checks_from_env(), interval, int(_read_env("REPEAT_MINUTES", "1")))
    prev_cpu = parse_proc_stat(Path("/proc/stat").read_text())
    while True:
        time.sleep(interval)
        cur_cpu = parse_proc_stat(Path("/proc/stat").read_text())
        values = {
            "host_cpu": compute_cpu_busy_pct(prev_cpu, cur_cpu),
            "mem_available": parse_mem_available_mb(Path("/proc/meminfo").read_text()),
            "disk": read_disk_used_pct(disk_path),
        }
        prev_cpu = cur_cpu
        now = datetime.now(timezone.utc)
        trips = tracker.observe(values, now)
        if not trips:
            continue
        # A full disk is the trip most likely to make this write fail. Crashing would restart the
        # process every few seconds and reset every streak, so log it to the journal and keep sampling.
        try:
            append(output, build_stream_line(now, trips))
        except OSError as error:
            print(f"could not append to {output}: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
