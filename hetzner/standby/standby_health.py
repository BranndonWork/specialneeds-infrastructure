#!/usr/bin/env python3
"""
Watch the standby itself. Runs on Box B from cron every five minutes.

Two conditions, each alerting once on Telegram when it starts and once when it clears:
  replication  Postgres on Box B has no streaming WAL receiver (slot lost, primary down,
               or the standby was promoted by mistake).
  snapshot     The Meilisearch snapshot pulled from Box A is older than 36 hours, so the
               nightly refresh has missed at least one night.

State between runs lives in /root/standby/health_state.json. Telegram credentials come from
the same sync.json the env sync uses.
"""

import json
import os
import subprocess
import sys
import time

from sync_from_primary import CONFIG_PATH, telegram

STATE_PATH = "/root/standby/health_state.json"
SNAPSHOT_PATH = "/root/standby/meili/data.ms.snapshot"
SNAPSHOT_MAX_AGE_S = 36 * 3600
POSTGRES_APP = "16ofcqlg8eiajbyek49d7ipc"


def postgres_container():
    names = subprocess.run(
        ["docker", "ps", "--filter", f"name=postgres-{POSTGRES_APP}", "--format", "{{.Names}}"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    return names[0] if names else None


def replication_problem():
    name = postgres_container()
    if not name:
        return "no Postgres container running on Box B"
    query = "select pg_is_in_recovery(), coalesce((select status from pg_stat_wal_receiver), 'none')"
    result = subprocess.run(
        ["docker", "exec", name, "sh", "-c", f'psql -U "$POSTGRES_USER" -d postgres -tAc "{query}"'],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return f"psql failed on the standby: {result.stderr.strip()[:200]}"
    in_recovery, receiver = result.stdout.strip().split("|")
    if in_recovery != "t":
        return "standby Postgres is not in recovery, it has been promoted"
    if receiver != "streaming":
        return f"WAL receiver status is {receiver}, replication from Box A has stopped"
    return None


def snapshot_problem():
    if not os.path.exists(SNAPSHOT_PATH):
        return "no Meilisearch snapshot has ever been pulled"
    age_h = (time.time() - os.path.getmtime(SNAPSHOT_PATH)) / 3600
    if age_h > SNAPSHOT_MAX_AGE_S / 3600:
        return f"Meilisearch snapshot is {age_h:.0f} hours old"
    return None


def load_state():
    try:
        with open(STATE_PATH) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def main():
    with open(CONFIG_PATH) as handle:
        config = json.load(handle)
    state = load_state()
    problems = {"replication": replication_problem(), "snapshot": snapshot_problem()}
    for check, problem in problems.items():
        was_failing = bool(state.get(check))
        if problem and not was_failing:
            telegram(config, f"Standby Box B: {problem}")
        if not problem and was_failing:
            telegram(config, f"Standby Box B: {check} recovered")
        state[check] = problem
    with open(STATE_PATH, "w") as handle:
        json.dump(state, handle)
    for check, problem in problems.items():
        print(f"{check}: {problem or 'ok'}")
    sys.exit(1 if any(problems.values()) else 0)


if __name__ == "__main__":
    main()
