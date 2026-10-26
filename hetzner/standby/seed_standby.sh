#!/bin/bash
# Run on Box B. Seeds (or re-seeds) the standby Postgres volume from the primary over the
# Hetzner private network, then deploys the Postgres app through Coolify so it starts as a
# hot standby streaming from slot box_b.
#
# Needs /root/standby/pgpass (10.100.0.3:5432:*:replicator:<password>) and
# /root/standby/coolify_b.token. Refuses to run while the volume holds data; to re-seed,
# stop the Postgres app in Coolify and empty the volume first.
#
# pg_basebackup -R records the passfile path it was given, so the password file is copied
# into the data volume and primary_conninfo is pointed at it. Nothing outside the volume is
# needed at runtime, and Coolify redeploys leave postgresql.auto.conf alone.
set -euo pipefail

APP="${STANDBY_POSTGRES_APP:-16ofcqlg8eiajbyek49d7ipc}"
PRIMARY_IP="${PRIMARY_IP:-10.100.0.3}"
VOL="${APP}_postgres-data"
DATA="/var/lib/docker/volumes/$VOL/_data"
TOKEN=$(cat /root/standby/coolify_b.token)
API="localhost:8000/api/v1"

count=$(ls -A "$DATA" | wc -l)
[ "$count" = "0" ] || { echo "volume not empty ($count entries), refusing to seed" >&2; exit 1; }

echo "pg_basebackup from $PRIMARY_IP (slot box_b)"
docker run --rm \
  -v "$VOL:/var/lib/postgresql/data" \
  -v /root/standby/pgpass:/pgpass:ro -e PGPASSFILE=/pgpass \
  postgres:17-alpine \
  pg_basebackup -h "$PRIMARY_IP" -p 5432 -U replicator -D /var/lib/postgresql/data -R -S box_b -X stream -c fast --no-password

install -o 70 -g 70 -m 0600 /root/standby/pgpass "$DATA/pgpass"
python3 - "$DATA/postgresql.auto.conf" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read().replace("passfile=''/pgpass''", "passfile=''/var/lib/postgresql/data/pgpass''")
open(path, "w").write(text)
PY
grep -q "passfile=''/var/lib/postgresql/data/pgpass''" "$DATA/postgresql.auto.conf" || { echo "primary_conninfo not rewritten" >&2; exit 1; }
echo "seeded $(du -sh "$DATA" | cut -f1)"

dep=$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" "$API/deploy?uuid=$APP" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["deployments"][0]["deployment_uuid"])')
echo "coolify deployment $dep"
for _ in $(seq 1 60); do
  status=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/deployments/$dep" | python3 -c 'import sys, json; print(json.load(sys.stdin).get("status"))')
  case "$status" in finished|failed|cancelled-by-user) echo "deployment $status"; break ;; esac
  sleep 5
done

sleep 10
PG=$(docker ps --filter "name=postgres-$APP" --format '{{.Names}}' | head -1)
docker exec "$PG" psql -U postgres -tAc "select 'in_recovery=' || pg_is_in_recovery(), 'receiver=' || coalesce((select status from pg_stat_wal_receiver), 'none'), 'lag=' || coalesce((now() - pg_last_xact_replay_timestamp())::text, 'n/a')"
