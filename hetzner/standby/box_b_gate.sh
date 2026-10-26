#!/bin/bash
# Installed on Box A as the forced command for Box B's ssh key. Box B may only ask for a
# fresh Meilisearch snapshot and stream it. Anything else is refused.
#
#   command="/root/standby/box_b_gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 ...
set -euo pipefail

MEILI_APP="rmrho2eqjylh9ct5ddunm8t3"
# Meilisearch names the file after its data directory, so a snapshot of /meili_data lands here.
SNAPSHOT="/var/lib/docker/volumes/${MEILI_APP}_meilisearch-data/_data/snapshots/meili_data.snapshot"

meili_container() {
  docker ps --format '{{.Names}}' | grep "^meilisearch-${MEILI_APP}" | head -1
}

meili_api() {
  # The master key stays inside the container's environment.
  docker exec "$(meili_container)" sh -c "curl -s $1 -H \"Authorization: Bearer \$MEILI_MASTER_KEY\" localhost:7700$2"
}

take_snapshot() {
  task=$(meili_api "-X POST" /snapshots | sed -E 's/.*"taskUid":([0-9]+).*/\1/')
  [[ "$task" =~ ^[0-9]+$ ]] || { echo "snapshot task not created" >&2; exit 1; }
  for _ in $(seq 1 240); do
    status=$(meili_api "" "/tasks/$task" | sed -E 's/.*"status":"([a-z]+)".*/\1/')
    case "$status" in
      succeeded) echo "snapshot task $task succeeded"; exit 0 ;;
      failed|canceled) echo "snapshot task $task $status" >&2; exit 1 ;;
    esac
    sleep 5
  done
  echo "snapshot task $task timed out" >&2
  exit 1
}

case "${SSH_ORIGINAL_COMMAND:-}" in
  snapshot) take_snapshot ;;
  cat-snapshot) exec cat "$SNAPSHOT" ;;
  snapshot-size) stat -c %s "$SNAPSHOT" ;;
  *) echo "denied: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2; exit 1 ;;
esac
