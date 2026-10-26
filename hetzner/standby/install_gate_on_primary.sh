#!/bin/bash
# Run on Box A. Installs box_b_gate.sh as the forced command for Box B's public key.
# Idempotent: the key line is added once. The public key is Box B's /root/standby/id_box_b.pub.
set -euo pipefail

GATE="/root/standby/box_b_gate.sh"
BOX_B_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIfnX+nJKPfkET7ZmqKfsn+egkoEWp/v7YNhVdkFd0fl box-b standby to primary"
AUTH="/root/.ssh/authorized_keys"

chmod 700 "$GATE"
line="command=\"$GATE\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $BOX_B_PUBKEY"
grep -qF "box-b standby to primary" "$AUTH" || echo "$line" >> "$AUTH"
echo "gate installed, key lines for box-b: $(grep -c 'box-b standby to primary' "$AUTH")"
