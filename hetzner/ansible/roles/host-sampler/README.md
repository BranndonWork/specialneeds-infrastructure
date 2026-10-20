# host-sampler

The production host's CPU, memory and disk signals for the prod-triage stream (#899). It replaces the laptop watcher's SSH checks for those three, so the durable prod-triage worker sees them in the same input as everything else.

## Runbook

`host-sampler.service` runs `/opt/host-sampler/host_sampler.py`, a stdlib Python loop under systemd. Every 15 seconds it reads host CPU busy from `/proc/stat`, MemAvailable from `/proc/meminfo` and used space on `/` the way `df` reports it. A check that stays out of range for its samples in a row is appended to `HOST_SAMPLER_OUTPUT` as one JSON line in the prod-triage backlog shape: `{"ts": "2026-10-20T12:00:00+00:00", "trips": [{"check": "host_cpu", "kind": "cpu", "value": 95.5, "threshold": 85, "minutes_in_a_row": 2}]}`. While a check stays out of range it posts again every minute, the same cadence as the watcher's one line per tripped minute. Once it recovers, its next trip posts at once.

| Check | Kind | Trips when | Samples in a row |
|---|---|---|---|
| `host_cpu` | `cpu` | busy above 85% | 8 (2 minutes) |
| `mem_available` | `memory` | below 400 MB | 4 (1 minute) |
| `disk` | `disk` | `/` above 85% used | 1 |

The threshold values and check names match `specialneeds-services/prod-triage/config.toml` and the watcher's checks. Memory needs a minute in a row here, where the watcher trips on one reading. The watcher's `load_1m` and per-container CPU checks are not sampled here. They need their own source before the watcher retires.

To change a threshold, edit its `Environment=` line in `files/host-sampler.service` and rerun the playbook. Thresholds are whole numbers. On the host itself, run `systemctl edit host-sampler` and then `systemctl restart host-sampler`. Set the output path in `HOST_SAMPLER_OUTPUT` at deploy time. Its default, `/var/log/prod-triage/stream.jsonl`, is a placeholder until the stream's real location is decided. To stop it, run `systemctl stop host-sampler`. To keep it off across reboots, run `systemctl disable --now host-sampler`. Its own errors, including a failed write to the stream, go to `journalctl -u host-sampler`.

## Deploy

The role has its own playbook and is not in `site.yml`, so a routine bring-up never starts it:

```bash
ansible-playbook playbooks/host-sampler.yml --limit box-a --check   # dry run first
ansible-playbook playbooks/host-sampler.yml --limit box-a
```

## Tests

```bash
python3 -m unittest discover -s hetzner/ansible/roles/host-sampler/tests
```
