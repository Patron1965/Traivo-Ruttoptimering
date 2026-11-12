"""Operator-only, read-only checks. No customer inputs or activation operations."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import ssl
import subprocess
import time

ROOT = Path("/srv/traivo-osrm")
DATASET = "sweden-4b64b0987efc-60a43e45aa42226e76b359ca7308e49be1a41af096bf7b6c9c2a471f0e856078"
IMAGE = "ghcr.io/project-osrm/osrm-backend@sha256:60a43e45aa42226e76b359ca7308e49be1a41af096bf7b6c9c2a471f0e856078"
DATA = ROOT / "datasets" / DATASET
WORK = ROOT / "gateway-prepare/https-candidate"
GATEWAY = "traivo-osrm-https-candidate"
CANDIDATE = "traivo-osrm-sweden-candidate"
CONFIG_SHA256 = "32906679e20d5a6e30593c828732054412eb97f59193b28924fa54332bd7ae15"
MIB = 1024 * 1024
GIB = 1024 * MIB


class SafetyError(Exception):
    """Messages are fixed event codes, never command output or exception prose."""


def require(condition, code):
    if not condition:
        raise SafetyError(code)


def command(args, timeout=30, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    require(not check or result.returncode == 0, "HOST_COMMAND_FAILED")
    require(len(result.stdout) <= 4 * MIB, "HOST_OUTPUT_LIMIT")
    return result


def active(unit):
    return command(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0


def inspect(name):
    entries = json.loads(command(["docker", "inspect", name]).stdout)
    require(len(entries) == 1, "CONTAINER_IDENTITY")
    return entries[0]


def osrm_command(threads=2):
    return ["osrm-routed", "/data/sweden.osrm", "--algorithm", "CH",
            "--threads", str(threads), "--verbosity", "WARNING",
            "--max-table-size", "500", "--max-viaroute-size", "1000"]


def validate_container(entry, directory, port, user, cpu=2, entrypoint=None, command_prefix=()):
    config, host = entry["Config"], entry["HostConfig"]
    require(entry["State"]["Running"] and not entry["State"]["OOMKilled"],
            "CONTAINER_NOT_HEALTHY")
    require(config["Image"] == IMAGE and config["User"] == user and
            config["Cmd"] == [*command_prefix, *osrm_command(cpu)] and
            config.get("Entrypoint") == entrypoint,
            "CONTAINER_COMMAND_OR_IDENTITY")
    require(host["ReadonlyRootfs"] and host["LogConfig"]["Type"] == "none" and
            "ALL" in (host.get("CapDrop") or []) and
            any(value in ("no-new-privileges", "no-new-privileges:true")
                for value in host.get("SecurityOpt") or []) and
            host["Init"] and host["PidsLimit"] == 256 and
            host["Memory"] == 6 * GIB and host["MemorySwap"] == 6 * GIB and
            host["NanoCpus"] == cpu * 1_000_000_000 and
            host["RestartPolicy"]["Name"] == "no",
            "CONTAINER_PROTECTION")
    bindings = {"5000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
    require(host["PortBindings"] == bindings and
            entry["NetworkSettings"]["Ports"].get("5000/tcp") == bindings["5000/tcp"] and
            all(key == "5000/tcp" or not value
                for key, value in entry["NetworkSettings"]["Ports"].items()),
            "CONTAINER_PORT_EXPOSURE")
    mounts = entry["Mounts"]
    data_mounts = [item for item in mounts if item["Destination"] == "/data"]
    require(len(data_mounts) == 1 and data_mounts[0]["Type"] == "bind" and
            data_mounts[0]["Source"] == str(directory) and not data_mounts[0]["RW"] and
            all(item["Destination"] in ("/data", "/tmp") for item in mounts),
            "CONTAINER_DATA_BINDING")


def base_context():
    require(not os.environ.get("REPL_ID") and os.geteuid() == 0 and
            socket.gethostname().split(".")[0] == "traivo-osrm-pilot", "EXPECTED_OPERATOR_HOST")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines()
                   if "=" in line)
    require(release.get("ID", "").strip('"') == "ubuntu" and
            release.get("VERSION_ID", "").strip('"') == "24.04", "EXPECTED_UBUNTU_RELEASE")
    require(DATA.resolve(strict=True) == DATA and (DATA / "sweden.osrm.hsgr").is_file(),
            "PINNED_DATA_DIRECTORY")
    manifest = json.loads((DATA / "manifest.json").read_text())
    require(manifest.get("dataset") == DATASET and manifest.get("image_digest") == IMAGE and
            re.fullmatch("[0-9a-f]{64}", manifest.get("source_sha256", "")) and
            manifest["source_sha256"].startswith("4b64b0987efc") and
            manifest.get("coverage") == "sweden_source_no_regional_clip" and
            manifest.get("algorithm") == "CH" and manifest.get("preparation_only") is True and
            manifest.get("production_ready") is False, "PINNED_MANIFEST")
    pilot = (ROOT / "current").resolve(strict=True)
    require(active("traivo-osrm-ch"), "PILOT_INACTIVE")
    account = pwd.getpwnam("osrm")
    images = json.loads(command(["docker", "image", "inspect", IMAGE]).stdout)
    require(len(images) == 1 and IMAGE in (images[0].get("RepoDigests") or []),
            "PINNED_LOCAL_IMAGE")
    entry = inspect(CANDIDATE)
    validate_container(entry, DATA, 5002, f"{account.pw_uid}:{account.pw_gid}",
                       entrypoint=images[0]["Config"].get("Entrypoint"))
    require(entry["Image"] == images[0]["Id"] and
            entry["Config"].get("Env") == images[0]["Config"].get("Env"), "PINNED_IMAGE_RUNTIME")
    return {"pilot": pilot, "account": account}


def assert_pilot_unchanged(context):
    require((ROOT / "current").resolve(strict=True) == context["pilot"] and
            active("traivo-osrm-ch") and inspect(CANDIDATE)["State"]["Running"],
            "EXISTING_SERVICES_CHANGED")


def protected_file(path):
    value = path.lstat()
    require(path.is_file() and not path.is_symlink() and value.st_uid == 0 and
            value.st_mode & 0o777 == 0o600, "PROTECTED_FILE_PERMISSIONS")
    return path.read_text()


def gateway_token():
    require(WORK.is_dir() and not WORK.is_symlink() and WORK.stat().st_uid == 0 and
            WORK.stat().st_mode & 0o777 == 0o700, "PROTECTED_DIRECTORY_PERMISSIONS")
    raw = protected_file(WORK / "auth-token")
    require(re.fullmatch("[0-9a-f]{64}\n", raw) is not None, "PROTECTED_TOKEN_FORMAT")
    token = raw[:-1]
    expected = ('map $http_authorization $traivo_authorized {\n'
                '  default 0;\n  "Bearer ' + token + '" 1;\n}\n')
    require(protected_file(WORK / "auth-map.conf") == expected, "AUTH_MAP_DIFFERS")
    config = protected_file(WORK / "nginx-https.conf")
    require(hashlib.sha256(config.encode()).hexdigest() == CONFIG_SHA256,
            "GATEWAY_CONFIGURATION_DIFFERS")
    return token


def gateway_properties():
    properties = ("ActiveState", "StandardOutput", "StandardError", "Restart", "MemoryMax",
                  "CPUQuotaPerSecUSec", "TasksMax", "RuntimeMaxUSec", "PrivateTmp", "LimitCORE")
    result = command(["systemctl", "show", GATEWAY,
                      *[f"--property={key}" for key in properties]])
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if values.get("ActiveState") != "active":
        return None
    expected = {"StandardOutput": "null", "StandardError": "null", "Restart": "no",
                "MemoryMax": str(256 * MIB), "CPUQuotaPerSecUSec": "500ms",
                "TasksMax": "32", "RuntimeMaxUSec": "2h", "PrivateTmp": "yes", "LimitCORE": "0"}
    require(all(values.get(key) == value for key, value in expected.items()),
            "GATEWAY_RUNTIME_PROTECTION")
    return values


def no_default_daemons():
    for unit in ("nginx", "certbot.timer"):
        require(not active(unit) and command(["systemctl", "is-enabled", "--quiet", unit],
                                            check=False).returncode != 0,
                "DEFAULT_DAEMON_OR_RENEWAL_ENABLED")


class LocalTLS(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(("127.0.0.1", 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname="osrm.traivo.se")
        except BaseException:
            raw.close()
            raise


def tls_health(token):
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = LocalTLS("osrm.traivo.se", context=context, timeout=10)
    try:
        connection.connect()
        certificate = connection.sock.getpeercert()
        protocol = connection.sock.version()
        connection.request("GET", f"/datasets/{DATASET}/nearest/v1/driving/"
                           "18.0686,59.3293?number=1&radiuses=250",
                           headers={"Authorization": "Bearer " + token})
        response = connection.getresponse()
        body = response.read(65537)
        require(response.status == 200 and len(body) <= 65536 and
                response.getheader("Location") is None and
                response.getheader("X-Traivo-OSRM-Dataset") == DATASET, "TLS_HEALTH_RESPONSE")
        value = json.loads(body)
        require(value.get("code") == "Ok" and len(value.get("waypoints", [])) == 1 and
                0 <= value["waypoints"][0]["distance"] <= 250, "TLS_ROAD_HEALTH")
        return {"tls": protocol,
                "certificate_days_remaining": round(
                    (ssl.cert_time_to_seconds(certificate["notAfter"]) - time.time()) / 86400, 2)}
    finally:
        connection.close()


def log_contains_sensitive_data(message, token):
    return token in message or re.search(
        r"/(?:nearest|table|route)/v1/driving/[-+\d]|"
        r'"(?:coordinates|latitude|longitude|lat|lon)"\s*:|'
        r"(?i:authorization)\s*:|Bearer\s+[0-9a-f]{16}", message) is not None


def audit_logs(token):
    """Bounded two-hour VM journal review; never emit records or their prose."""
    total = 0
    for unit in (GATEWAY, "traivo-osrm-ch", "docker.service"):
        text = command(["journalctl", "--unit=" + unit, "--since=2 hours ago",
                        "--output=json", "--lines=2001", "--no-pager"]).stdout
        lines = text.splitlines()
        require(len(lines) < 2001, "JOURNAL_WINDOW_TRUNCATED")
        for line in lines:
            record = json.loads(line)
            message = record.get("MESSAGE")
            # Non-text/binary MESSAGE fields are not silently skipped.
            require(isinstance(message, str), "JOURNAL_MESSAGE_NOT_TEXT")
            require(not log_contains_sensitive_data(message, token), "SENSITIVE_JOURNAL_RECORD")
        total += len(lines)
    for path in (Path("/var/log/nginx/access.log"), Path("/var/log/nginx/error.log")):
        if not path.exists():
            continue
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 4 * MIB,
                "NGINX_LOG_SCAN_INCOMPLETE")
        require(not log_contains_sensitive_data(path.read_text(), token), "SENSITIVE_NGINX_LOG")
    return {"journal_window_hours": 2, "journal_records_checked": total,
            "sensitive_records_found": False,
            "scope": "selected_VM_units_and_default_nginx_files_not_Replit_or_provider_logs"}


def host_metrics():
    values = dict((line.split(":")[0], line.split(":")[1].strip().split()[0])
                  for line in Path("/proc/meminfo").read_text().splitlines())
    disk = shutil.disk_usage(ROOT)
    stats = json.loads(command(["docker", "stats", "--no-stream", "--format",
                                "{{json .}}", CANDIDATE]).stdout)
    require(re.fullmatch(r"\d+(?:\.\d+)?%", stats["MemPerc"]) is not None, "MEMORY_METRIC_INVALID")
    return {"available_memory_bytes": int(values["MemAvailable"]) * 1024,
            "disk_free_bytes": disk.free, "disk_free_percent": round(100 * disk.free / disk.total, 2),
            "osrm_memory_percent_of_limit": float(stats["MemPerc"][:-1])}


def alarm_codes(metrics, tls, gateway_active):
    result = []
    if not gateway_active:
        result.append("GATEWAY_INACTIVE")
    if metrics["available_memory_bytes"] < 2 * GIB:
        result.append("HOST_MEMORY_LOW")
    if metrics["disk_free_bytes"] < 16 * GIB or metrics["disk_free_percent"] < 10:
        result.append("DISK_SPACE_LOW")
    if metrics["osrm_memory_percent_of_limit"] >= 80:
        result.append("OSRM_MEMORY_HIGH")
    if tls and tls["certificate_days_remaining"] <= 14:
        result.append("CERTIFICATE_EXPIRING")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--audit-read-only", action="store_true")
    modes.add_argument("--health-read-only", action="store_true")
    args = parser.parse_args()
    try:
        context = base_context()
        no_default_daemons()
        token = gateway_token()
        live = gateway_properties() is not None
        tls = tls_health(token) if live else None
        metrics = host_metrics()
        report = {"kind": "preparation_only_no_customer_data", "production_activated": False,
                  "gateway_active": live, "tls": tls, "metrics": metrics,
                  "alarm_codes": alarm_codes(metrics, tls, live)}
        if args.audit_read_only:
            report["logging"] = audit_logs(token)
        assert_pilot_unchanged(context)
        print(json.dumps(report, sort_keys=True))
        return 0 if not report["alarm_codes"] else 1
    except SafetyError as error:
        print(json.dumps({"status": "STOP", "event": str(error)}))
    except Exception as error:
        print(json.dumps({"status": "STOP", "event": "CHECK_FAILED",
                          "error_type": type(error).__name__}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())