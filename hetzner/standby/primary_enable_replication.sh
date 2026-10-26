#!/bin/bash
# Run on Box A (the primary). Prepares Postgres for the Box B streaming replica
# without a restart: a replication role, a physical slot, a WAL retention cap and
# the pg_hba line for Box B's private IP. Idempotent. The replicator password is
# generated into /root/standby/replicator.pw (0600) and never printed.
set -euo pipefail
umask 077

STANDBY_IP="10.100.0.2"
SLOT="box_b"
PW_FILE="/root/standby/replicator.pw"
VOLUME_DATA="/var/lib/docker/volumes/7am8hsrbbn0okss6mtb7lqpk_postgres-data/_data"

mkdir -p /root/standby
[ -s "$PW_FILE" ] || openssl rand -hex 24 > "$PW_FILE"

container=$(docker ps --format '{{.Names}}' | grep -E '^(sn-postgres|postgres-7am8hsrbbn0okss6mtb7lqpk)' | head -1)
[ -n "$container" ] || { echo "postgres container not found" >&2; exit 1; }

{
  printf "\\\\set pw '%s'\n" "$(cat "$PW_FILE")"
  cat <<SQL
SELECT format('CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'replicator') \\gexec
SELECT pg_create_physical_replication_slot('$SLOT')
WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '$SLOT');
ALTER SYSTEM SET max_slot_wal_keep_size = '8GB';
SELECT pg_reload_conf();
SQL
} | docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -q

hba="$VOLUME_DATA/pg_hba.conf"
line="host replication replicator $STANDBY_IP/32 scram-sha-256"
grep -qxF "$line" "$hba" || echo "$line" >> "$hba"
docker exec "$container" psql -U postgres -tAc "SELECT pg_reload_conf()" > /dev/null

echo "container: $container"
docker exec "$container" psql -U postgres -tAc \
  "SELECT 'role ' || rolname || ' replication=' || rolreplication FROM pg_roles WHERE rolname = 'replicator';
   SELECT 'slot ' || slot_name || ' active=' || active FROM pg_replication_slots;
   SELECT 'max_slot_wal_keep_size=' || current_setting('max_slot_wal_keep_size');"
grep -n "replication replicator" "$hba"
