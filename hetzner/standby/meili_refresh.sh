#!/bin/bash
# Runs on Box B nightly. Asks Box A for a fresh Meilisearch snapshot, streams it over the
# private network, then replaces the standby's database with it. A snapshot is a plain tar
# of the database directory, so it is extracted straight into the volume while the container
# is stopped. Search on Box B is down for about a minute, and Box B serves no traffic unless
# the primary is already gone.
set -euo pipefail

MEILI_APP="3zzgdp7y0re7mgdjledkipkm"
VOLUME="/var/lib/docker/volumes/${MEILI_APP}_meilisearch-data/_data"
SNAPSHOT_DIR="/root/standby/meili"
SNAPSHOT="$SNAPSHOT_DIR/data.ms.snapshot"
KEY="/root/standby/id_box_b"
PRIMARY="root@10.100.0.3"
LOG="/root/standby/meili_refresh.log"
TELEGRAM_ENV="/root/standby/telegram.env"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

alert() {
  # shellcheck disable=SC1090
  source "$TELEGRAM_ENV"
  curl -s -o /dev/null --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=Standby Meilisearch refresh failed on Box B: $1" \
    "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" || true
}

fail() { log "FAILED: $1"; alert "$1"; exit 1; }

container() { docker ps -a --format '{{.Names}}' | grep "^meilisearch-${MEILI_APP}" | head -1; }

ssh_primary() { ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$PRIMARY" "$@"; }

mkdir -p "$SNAPSHOT_DIR"
log "asking primary for a snapshot"
ssh_primary snapshot >> "$LOG" 2>&1 || fail "snapshot on primary did not succeed"

expected=$(ssh_primary snapshot-size) || fail "could not read snapshot size"
ssh_primary cat-snapshot > "$SNAPSHOT.tmp" || fail "snapshot transfer failed"
actual=$(stat -c %s "$SNAPSHOT.tmp")
[ "$actual" = "$expected" ] || fail "snapshot size mismatch ($actual vs $expected bytes)"
tar -tf "$SNAPSHOT.tmp" > /dev/null || fail "snapshot is not a readable tar"
mv "$SNAPSHOT.tmp" "$SNAPSHOT"
log "snapshot received ($actual bytes)"

name=$(container)
[ -n "$name" ] || fail "no meilisearch container on this box"
docker stop "$name" > /dev/null
# MEILI_DB_PATH is the volume root, so the whole volume is the database.
find "$VOLUME" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xf "$SNAPSHOT" -C "$VOLUME" || fail "snapshot extract failed"
docker start "$name" > /dev/null

for _ in $(seq 1 120); do
  if docker exec "$name" curl -sf localhost:7700/health > /dev/null 2>&1; then
    indexes=$(docker exec "$name" sh -c 'curl -sf -H "Authorization: Bearer $MEILI_MASTER_KEY" localhost:7700/stats' \
      | grep -o '"numberOfDocuments":[0-9]*' | wc -l)
    [ "$indexes" -gt 0 ] || fail "meilisearch healthy but imported no indexes"
    log "import complete, $indexes indexes present"
    exit 0
  fi
  sleep 5
done
fail "meilisearch not healthy 10 minutes after import"
