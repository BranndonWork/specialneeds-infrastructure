"""Read or update the Hetzner Cloud firewall rules for the SpecialNeeds server.

Usage:
  hcloud_fw.py show
  hcloud_fw.py apply <rules.json>

The token comes from HETZNER_API_TOKEN in the environment. Nothing prints it.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.hetzner.cloud/v1"
TOKEN = os.environ["HETZNER_API_TOKEN"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=HEADERS)
    try:
        return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {e.read()[:400].decode()}")


def show():
    for server in call("GET", "/servers")["servers"]:
        ipv4 = server["public_net"]["ipv4"]["ip"]
        names = [f["id"] for f in server["public_net"]["firewalls"]]
        print(f"server {server['id']} {server['name']} {ipv4} firewalls={names}")
    for fw in call("GET", "/firewalls")["firewalls"]:
        applied = [a.get("server", {}).get("id") for a in fw["applied_to"]]
        print(f"firewall {fw['id']} {fw['name']} applied_to={applied}")
        for rule in fw["rules"]:
            print(f"  {rule['direction']:3} {rule['protocol']:4} {rule.get('port', ''):>5} from {rule['source_ips']}")


def apply(path):
    fw_id = int(sys.argv[3])
    rules = json.load(open(path))
    res = call("POST", f"/firewalls/{fw_id}/actions/set_rules", {"rules": rules})
    print("actions:", [(a["command"], a["status"]) for a in res["actions"]])


if __name__ == "__main__":
    if sys.argv[1] == "show":
        show()
    elif sys.argv[1] == "apply":
        apply(sys.argv[2])
