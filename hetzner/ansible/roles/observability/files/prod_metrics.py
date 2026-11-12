"""Production host, container and Celery queue readings, printed as JSON lines for Vector.

Runs as the `sn-metrics` container next to Vector. Every minute it prints one sample:
one `host` record (CPU, load, memory, disk), one `container` record per container (state,
health, image, CPU and memory), and one `queues` record (the Celery queue lengths). Between
samples it prints an `event` record for each container start, stop, death, OOM kill and
health change. Vector sends these lines to the `prod_metrics` stream in OpenObserve.

Read-only: the Docker socket is mounted read-only and only GETs are sent on it, and Redis
gets SELECT and LLEN. /proc/stat, /proc/loadavg and /proc/meminfo in a container show the
host's numbers, and statvfs("/") shows the disk the Docker root sits on.
"""

import http.client
import json
import os
import socket
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone

DOCKER_SOCKET = "/var/run/docker.sock"
REDIS_HOST = os.environ.get("REDIS_HOST", "sn-redis")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
CELERY_BROKER_DB = 2
CELERY_QUEUES = ("high_priority", "medium_priority", "low_priority", "celery")
INTERVAL_SECONDS = int(os.environ.get("INTERVAL_SECONDS", "60"))
EVENT_ACTIONS = {"create", "start", "restart", "stop", "die", "kill", "oom", "destroy", "health_status"}
_print_lock = threading.Lock()


def emit(record):
    with _print_lock:
        sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def utc_iso(seconds=None):
    moment = datetime.fromtimestamp(seconds, timezone.utc) if seconds is not None else datetime.now(timezone.utc)
    return moment.isoformat(timespec="seconds")


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=30):
        super().__init__("docker", timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(DOCKER_SOCKET)


def docker_get(path):
    connection = DockerConnection()
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"docker GET {path} -> {response.status}")
        return json.loads(body)
    finally:
        connection.close()


def redis_command(sock, *parts):
    payload = f"*{len(parts)}\r\n" + "".join(f"${len(str(p))}\r\n{p}\r\n" for p in parts)
    sock.sendall(payload.encode())
    line = b""
    while not line.endswith(b"\r\n"):
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("redis closed the connection")
        line += chunk
    text = line.decode().strip()
    if text.startswith("-"):
        raise RuntimeError(f"redis: {text[1:]}")
    return int(text[1:]) if text.startswith(":") else text[1:]


def queue_lengths():
    with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=10) as sock:
        redis_command(sock, "SELECT", CELERY_BROKER_DB)
        return {queue: redis_command(sock, "LLEN", queue) for queue in CELERY_QUEUES}


def cpu_times():
    fields = open("/proc/stat").readline().split()[1:]
    user, nice, system, idle, iowait, irq, softirq, steal = (int(v) for v in fields[:8])
    return {"user": user + nice, "system": system + irq + softirq, "idle": idle, "iowait": iowait, "steal": steal}


def procs_running():
    for line in open("/proc/stat"):
        if line.startswith("procs_running"):
            return int(line.split()[1])
    return None


def cpu_percentages(before, after):
    total = sum(after.values()) - sum(before.values())
    if total <= 0:
        return {}
    pct = {name: round(100 * (after[name] - before[name]) / total, 1) for name in after}
    return {
        "cpu_busy_pct": round(100 - pct["idle"], 1),
        "user_pct": pct["user"],
        "system_pct": pct["system"],
        "iowait_pct": pct["iowait"],
        "steal_pct": pct["steal"],
    }


def memory():
    values = {}
    for line in open("/proc/meminfo"):
        name, _, rest = line.partition(":")
        values[name] = int(rest.split()[0])
    total, available = values["MemTotal"] // 1024, values["MemAvailable"] // 1024
    return {"mem_total_mb": total, "mem_used_mb": total - available, "mem_available_mb": available}


def disk():
    stat = os.statvfs("/")
    total, available = stat.f_blocks * stat.f_frsize, stat.f_bavail * stat.f_frsize
    used = total - stat.f_bfree * stat.f_frsize
    return {"disk_used_pct": round(100 * used / (used + available)), "disk_avail_mb": available // (1024 * 1024)}


def load():
    one, five, fifteen = (float(v) for v in open("/proc/loadavg").read().split()[:3])
    return {"load_1m": one, "load_5m": five, "load_15m": fifteen}


def health_of(container):
    status = container.get("Status", "")
    for word in ("unhealthy", "health: starting", "healthy"):
        if f"({word})" in status:
            return word.replace("health: ", "")
    return None


def container_cpu_pct(stats, previous):
    usage = stats["cpu_stats"]["cpu_usage"]["total_usage"]
    system = stats["cpu_stats"].get("system_cpu_usage")
    cpus = stats["cpu_stats"].get("online_cpus") or 1
    if previous is None or system is None or system <= previous[1]:
        return None, (usage, system)
    return round(100 * cpus * (usage - previous[0]) / (system - previous[1]), 2), (usage, system)


def container_memory(stats):
    memory_stats = stats.get("memory_stats") or {}
    usage, limit = memory_stats.get("usage"), memory_stats.get("limit")
    if not usage or not limit:
        return None, None
    used = usage - (memory_stats.get("stats") or {}).get("inactive_file", 0)
    return round(used / 1048576, 1), round(100 * used / limit, 2)


def sample(previous_cpu, previous_container_cpu):
    sampled_at = utc_iso()
    host_cpu = cpu_times()
    record = {"kind": "host", "sample": sampled_at, **load(), **memory(), **disk(), "run_queue": procs_running()}
    if previous_cpu is not None:
        record.update(cpu_percentages(previous_cpu, host_cpu))
    emit(record)

    container_cpu = {}
    for container in docker_get("/containers/json?all=1"):
        name = container["Names"][0].lstrip("/")
        row = {
            "kind": "container", "sample": sampled_at, "name": name, "state": container["State"],
            "health": health_of(container), "status": container["Status"],
            "created": utc_iso(container["Created"]), "image": container["Image"],
        }
        if container["State"] == "running":
            stats = docker_get(f"/containers/{container['Id']}/stats?stream=false&one-shot=true")
            row["cpu_pct"], container_cpu[container["Id"]] = container_cpu_pct(stats, previous_container_cpu.get(container["Id"]))
            row["mem_mb"], row["mem_pct"] = container_memory(stats)
        emit(row)

    try:
        emit({"kind": "queues", "sample": sampled_at, **queue_lengths()})
    except (OSError, RuntimeError) as exc:
        emit({"kind": "queues", "sample": sampled_at, "error": str(exc)})
    return host_cpu, container_cpu


def watch_events():
    """Print each container lifecycle event as it happens. Reconnects when the stream drops."""
    filters = urllib.parse.quote(json.dumps({"type": ["container"]}))
    while True:
        connection = DockerConnection(timeout=None)
        try:
            connection.request("GET", f"/events?filters={filters}")
            response = connection.getresponse()
            for line in response:
                event = json.loads(line)
                action = event.get("Action", "").split(":")[0]
                if action not in EVENT_ACTIONS:
                    continue
                attributes = (event.get("Actor") or {}).get("Attributes") or {}
                emit({
                    "kind": "event", "time": utc_iso(event.get("time")), "action": event.get("Action"),
                    "name": attributes.get("name"), "image": attributes.get("image"),
                    "exit_code": attributes.get("exitCode"),
                })
        except Exception as exc:
            emit({"kind": "event", "time": utc_iso(), "action": "watch_error", "error": str(exc)[:500]})
        finally:
            connection.close()
        time.sleep(5)


def main():
    threading.Thread(target=watch_events, daemon=True).start()
    previous_cpu, previous_container_cpu = None, {}
    while True:
        started = time.monotonic()
        try:
            previous_cpu, previous_container_cpu = sample(previous_cpu, previous_container_cpu)
        except Exception as exc:
            emit({"kind": "error", "sample": utc_iso(), "error": str(exc)[:500]})
        time.sleep(max(1, INTERVAL_SECONDS - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
