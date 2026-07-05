#!/bin/bash

# API Health Monitor
# Detects Traefik routing failures and auto-restarts if needed

HEALTH_URL="https://api.specialneeds.com/health/?simple=true"
TIMEOUT=10
FAILURE_THRESHOLD=5
STATE_FILE="/tmp/search_monitor_state"
COOLDOWN_FILE="/tmp/traefik_last_restart"
COOLDOWN_MINUTES=60

# Initialize state file if it doesn't exist
if [ ! -f "$STATE_FILE" ]; then
    echo "0" > "$STATE_FILE"
fi

# Check cooldown - don't restart Traefik more than once per hour
check_cooldown() {
    if [ -f "$COOLDOWN_FILE" ]; then
        last_restart=$(cat "$COOLDOWN_FILE")
        current_time=$(date +%s)
        time_diff=$((current_time - last_restart))
        cooldown_seconds=$((COOLDOWN_MINUTES * 60))

        if [ $time_diff -lt $cooldown_seconds ]; then
            echo "[$(date)] Still in cooldown period. Last restart was $((time_diff / 60)) minutes ago."
            return 1
        fi
    fi
    return 0
}

# Get current failure count
failure_count=$(cat "$STATE_FILE")

# Test the health endpoint
echo "[$(date)] Testing health endpoint..."
response=$(curl -s -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$HEALTH_URL" 2>&1)

if [ "$response" = "200" ]; then
    echo "[$(date)] ✓ Health endpoint healthy (HTTP 200)"
    echo "0" > "$STATE_FILE"
    exit 0
fi

# Request failed
echo "[$(date)] ✗ Health endpoint failed (HTTP $response)"
failure_count=$((failure_count + 1))
echo "[$(date)] Traefik routing issue (failure $failure_count/$FAILURE_THRESHOLD)"
echo "$failure_count" > "$STATE_FILE"

# Check if we've hit the threshold
if [ $failure_count -ge $FAILURE_THRESHOLD ]; then
    echo "[$(date)] ⚠️  THRESHOLD REACHED: $failure_count consecutive failures"

    if ! check_cooldown; then
        echo "[$(date)] Skipping restart due to cooldown"
        exit 0
    fi

    echo "[$(date)] 🔄 Restarting coolify-proxy..."
    docker restart coolify-proxy

    date +%s > "$COOLDOWN_FILE"
    echo "0" > "$STATE_FILE"

    echo "[$(date)] ✓ Traefik restarted successfully"
else
    echo "[$(date)] Waiting for more failures before restarting ($failure_count/$FAILURE_THRESHOLD)"
fi

exit 0
