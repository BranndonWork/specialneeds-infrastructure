# Warm standby scripts

Source for the scripts that run on the two Hetzner boxes to keep Box B (the read-only
standby) following Box A (the primary). Installed copies live in `/root/standby/` on each
box. Edit here, copy with `scp`, never edit on the box. The design and the failover rules
are in `docs/specialneeds-infrastructure/cloudflare-tunnel-runbook.md` (Standby) and the
database side in `docs/specialneeds-api/production-database.md` (Streaming standby).

| File | Runs on | Purpose |
|---|---|---|
| `primary_enable_replication.sh` | Box A, once | Creates the `replicator` role, the `box_b` physical slot, caps slot WAL at 8 GB and adds the `pg_hba` line for 10.100.0.2. Live reload, no restart. Idempotent. |
| `install_gate_on_primary.sh` | Box A, once | Adds Box B's ssh public key to `authorized_keys` with `box_b_gate.sh` as its forced command. |
| `box_b_gate.sh` | Box A | The forced command. Box B may only ask for a Meilisearch snapshot, its size, and its bytes. Everything else is refused. |
| `seed_standby.sh` | Box B | `pg_basebackup` from the primary into the Postgres app's empty volume, password file placed in the volume, then a Coolify deploy. Used for the first seed and for a re-seed after the slot was lost. |
| `sync_from_primary.py` | Box B, cron every 5 min | Copies application env vars from Box A's Coolify to Box B's Coolify by API over the private network, pins the standby-only keys, and when `IMAGE_TAG` changes redeploys the Django app on Box B. Alerts on Telegram when the sync fails. |
| `sync.json` | Box B | The app pairs, skipped keys and pinned keys the sync uses. |
| `standby_health.py` | Box B, cron every 5 min | Alerts on Telegram once when replication stops streaming or the Meilisearch snapshot passes 36 hours old, and once more when each clears. |
| `meili_refresh.sh` | Box B, cron 04:00 ET | Asks Box A for a Meilisearch snapshot through the gate, streams it to `/root/standby/meili/`, stops the standby Meilisearch, empties its volume, extracts the snapshot tar into it and starts it again. |

Secrets on Box B, all `0600` in `/root/standby/`, none in this repo: `coolify_a.token`
(read and read:sensitive on Box A), `coolify_b.token` (root on Box B), `pgpass`,
`telegram.env`, `id_box_b` (the ssh key the gate accepts), and one Coolify deploy key per
service repo.

The base install for a new standby box is `ansible/playbooks/standby-base.yml`.
