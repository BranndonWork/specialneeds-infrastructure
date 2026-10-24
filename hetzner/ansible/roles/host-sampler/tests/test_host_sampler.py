import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "files"))

import host_sampler as hs  # noqa: E402

START = datetime(2026, 10, 20, 12, 0, 0, tzinfo=timezone.utc)
INTERVAL = 15


def build_tracker(cpu_samples=8, mem_samples=4, repeat_minutes=15):
    checks = [
        hs.ThresholdCheck("host_cpu", "cpu", 85, cpu_samples, above=True),
        hs.ThresholdCheck("mem_available", "memory", 400, mem_samples, above=False),
        hs.ThresholdCheck("disk", "disk", 85, 1, above=True),
    ]
    return hs.ThresholdTracker(checks, INTERVAL, repeat_minutes)


def feed_samples(t, values, samples):
    """Feed the same readings `samples` times, 15 s apart, and collect every trip."""
    trips = []
    for i in range(samples):
        trips += t.observe(values, START + timedelta(seconds=INTERVAL * i))
    return trips


CALM = {"host_cpu": 20.0, "mem_available": 3000, "disk": 40.0}


class SustainedThresholdTest(unittest.TestCase):
    def test_cpu_over_the_line_for_fewer_samples_than_needed_posts_nothing(self):
        self.assertEqual(feed_samples(build_tracker(), {**CALM, "host_cpu": 95.0}, 7), [])

    def test_cpu_over_the_line_for_the_needed_samples_trips_once(self):
        trips = feed_samples(build_tracker(), {**CALM, "host_cpu": 95.0}, 8)
        self.assertEqual([trip["check"] for trip in trips], ["host_cpu"])

    def test_one_calm_sample_resets_the_streak(self):
        t = build_tracker()
        hot = {**CALM, "host_cpu": 95.0}
        trips = feed_samples(t, hot, 7) + t.observe(CALM, START) + feed_samples(t, hot, 7)
        self.assertEqual(trips, [])

    def test_memory_trips_when_available_stays_below_the_line(self):
        trips = feed_samples(build_tracker(), {**CALM, "mem_available": 300}, 4)
        self.assertEqual([trip["check"] for trip in trips], ["mem_available"])

    def test_memory_exactly_at_the_line_is_in_range(self):
        self.assertEqual(feed_samples(build_tracker(), {**CALM, "mem_available": 400}, 10), [])


class SingleReadingThresholdTest(unittest.TestCase):
    def test_disk_trips_on_the_first_reading_over_the_line(self):
        trips = build_tracker().observe({**CALM, "disk": 90.0}, START)
        self.assertEqual([trip["check"] for trip in trips], ["disk"])

    def test_disk_exactly_at_the_line_is_in_range(self):
        self.assertEqual(build_tracker().observe({**CALM, "disk": 85.0}, START), [])


class RepeatTest(unittest.TestCase):
    def test_a_check_that_stays_out_of_range_posts_again_after_the_repeat_interval(self):
        t = build_tracker(repeat_minutes=15)
        full = {**CALM, "disk": 90.0}
        self.assertEqual(len(t.observe(full, START)), 1)
        self.assertEqual(t.observe(full, START + timedelta(minutes=14, seconds=59)), [])
        self.assertEqual(len(t.observe(full, START + timedelta(minutes=15))), 1)

    def test_a_check_that_recovers_and_trips_again_posts_at_once(self):
        t = build_tracker()
        full = {**CALM, "disk": 90.0}
        t.observe(full, START)
        t.observe(CALM, START + timedelta(seconds=15))
        self.assertEqual(len(t.observe(full, START + timedelta(seconds=30))), 1)


class RecordFormatTest(unittest.TestCase):
    def test_a_trip_carries_exactly_the_backlog_trip_fields(self):
        trips = feed_samples(build_tracker(), {**CALM, "host_cpu": 95.5}, 8)
        self.assertEqual(
            trips,
            [{"check": "host_cpu", "kind": "cpu", "value": 95.5, "threshold": 85, "minutes_in_a_row": 2}],
        )

    def test_a_single_reading_trip_counts_one_minute(self):
        trips = build_tracker().observe({**CALM, "disk": 90.0}, START)
        self.assertEqual(trips[0]["minutes_in_a_row"], 1)

    def test_stream_line_is_ts_to_the_second_and_trips(self):
        line = hs.build_stream_line(START.replace(microsecond=123456), [{"check": "disk"}])
        self.assertEqual(line, {"ts": "2026-10-20T12:00:00+00:00", "trips": [{"check": "disk"}]})

    def test_append_writes_one_json_line_per_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nested" / "stream.jsonl"
            hs.append(path, {"ts": "a", "trips": []})
            hs.append(path, {"ts": "b", "trips": []})
            lines = path.read_text().splitlines()
        self.assertEqual([json.loads(line)["ts"] for line in lines], ["a", "b"])


class ReadingParsersTest(unittest.TestCase):
    def test_cpu_busy_is_the_non_idle_share_between_two_proc_stat_samples(self):
        prev = "cpu  100 0 100 700 100 0 0 0 0 0\n"
        cur = "cpu  200 0 200 800 100 0 0 0 0 0\n"
        self.assertEqual(hs.compute_cpu_busy_pct(hs.parse_proc_stat(prev), hs.parse_proc_stat(cur)), 66.7)

    def test_mem_available_is_read_from_meminfo_in_mb(self):
        meminfo = "MemTotal:       16000000 kB\nMemAvailable:     409600 kB\n"
        self.assertEqual(hs.parse_mem_available_mb(meminfo), 400)


if __name__ == "__main__":
    unittest.main()
