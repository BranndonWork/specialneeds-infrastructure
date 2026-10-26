#!/usr/bin/env python3
"""
Mirror Coolify application env vars and the Django image tag from Box A to Box B.

Runs on Box B from cron. Reads /root/standby/sync.json:

{
  "primary_api": "http://10.100.0.3:8000/api/v1",
  "primary_token_file": "/root/standby/coolify_a.token",
  "standby_api": "http://localhost:8000/api/v1",
  "standby_token_file": "/root/standby/coolify_b.token",
  "telegram_env_file": "/root/standby/telegram.env",
  "apps": [
    {"name": "django", "primary_uuid": "...", "standby_uuid": "...", "deploy_on_image_change": true,
     "skip_keys": ["COMPOSE_PROFILES", "POSTGRES_LISTEN_IP"],
     "skip_prefixes": ["SERVICE_FQDN_", "SERVICE_URL_"],
     "pin": {"SN_READ_ONLY": "1"}}
  ]
}

Values stay in memory. Logs carry key names only. Any failure goes to Telegram.
"""

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG_PATH = "/root/standby/sync.json"
LOG_PATH = "/root/standby/sync.log"
DEPLOY_TIMEOUT_S = 900

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("standby-sync")


class Coolify:
    def __init__(self, base, token_file):
        self.base = base.rstrip("/")
        with open(token_file) as handle:
            self.token = handle.read().strip()

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.base}/{path.lstrip('/')}",
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"{method} {path} -> {error.code}: {error.read().decode()[:300]}") from error

    def envs(self, app_uuid):
        rows = self.call("GET", f"applications/{app_uuid}/envs")
        return {row["key"]: row for row in rows if not row.get("is_preview")}

    def bulk_update(self, app_uuid, rows):
        return self.call("PATCH", f"applications/{app_uuid}/envs/bulk", {"data": rows})

    def deploy(self, app_uuid):
        result = self.call("POST", f"deploy?uuid={app_uuid}")
        return result["deployments"][0]["deployment_uuid"]

    def deployment_status(self, deployment_uuid):
        return self.call("GET", f"deployments/{deployment_uuid}")["status"]


def wanted_value(row):
    return row.get("real_value") if row.get("real_value") is not None else row.get("value")


def desired_rows(primary_rows, app):
    rows = []
    for key, row in primary_rows.items():
        if key in app.get("skip_keys", []) or key in app.get("pin", {}):
            continue
        if any(key.startswith(prefix) for prefix in app.get("skip_prefixes", [])):
            continue
        rows.append(
            {
                "key": key,
                "value": wanted_value(row),
                "is_preview": False,
                "is_build_time": bool(row.get("is_buildtime")),
                "is_literal": bool(row.get("is_literal")),
                "is_multiline": bool(row.get("is_multiline")),
                "is_shown_once": False,
            }
        )
    for key, value in app.get("pin", {}).items():
        rows.append({"key": key, "value": value, "is_preview": False, "is_build_time": True, "is_literal": False, "is_multiline": False, "is_shown_once": False})
    return rows


def changed_rows(rows, standby_rows):
    out = []
    for row in rows:
        current = standby_rows.get(row["key"])
        if current is None or wanted_value(current) != row["value"]:
            out.append(row)
    return out


def wait_for_deploy(standby, deployment_uuid):
    deadline = time.time() + DEPLOY_TIMEOUT_S
    while time.time() < deadline:
        status = standby.deployment_status(deployment_uuid)
        if status in ("finished", "failed", "cancelled-by-user"):
            return status
        time.sleep(10)
    return "timeout"


def telegram(config, text):
    env = {}
    try:
        with open(config["telegram_env_file"]) as handle:
            for line in handle:
                if "=" in line and not line.startswith("#"):
                    key, value = line.rstrip("\n").split("=", 1)
                    env[key] = value
        body = urllib.parse.urlencode({"chat_id": env["TELEGRAM_CHAT_ID"], "text": text}).encode()
        urllib.request.urlopen(f"https://api.telegram.org/bot{env['TELEGRAM_BOT_TOKEN']}/sendMessage", body, timeout=20)
    except Exception as error:  # noqa: BLE001
        log.error("telegram failed: %s", error)


def sync_app(primary, standby, app):
    primary_rows = primary.envs(app["primary_uuid"])
    standby_rows = standby.envs(app["standby_uuid"])
    rows = changed_rows(desired_rows(primary_rows, app), standby_rows)
    if not rows:
        log.info("%s: in sync (%d keys)", app["name"], len(standby_rows))
        return None
    standby.bulk_update(app["standby_uuid"], rows)
    keys = sorted(row["key"] for row in rows)
    log.info("%s: updated %d keys: %s", app["name"], len(keys), ", ".join(keys))
    image_changed = "IMAGE_TAG" in keys
    if image_changed and app.get("deploy_on_image_change"):
        deployment = standby.deploy(app["standby_uuid"])
        status = wait_for_deploy(standby, deployment)
        log.info("%s: deploy %s -> %s", app["name"], deployment, status)
        if status != "finished":
            raise RuntimeError(f"{app['name']} standby deploy {status}")
    return keys


def main():
    with open(CONFIG_PATH) as handle:
        config = json.load(handle)
    primary = Coolify(config["primary_api"], config["primary_token_file"])
    standby = Coolify(config["standby_api"], config["standby_token_file"])
    failures = []
    for app in config["apps"]:
        try:
            sync_app(primary, standby, app)
        except Exception as error:  # noqa: BLE001
            log.error("%s: %s", app["name"], error)
            failures.append(f"{app['name']}: {error}")
    if failures:
        telegram(config, "Standby sync failed on Box B:\n" + "\n".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
