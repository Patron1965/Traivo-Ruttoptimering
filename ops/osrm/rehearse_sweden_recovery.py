"""Isolated artifact-copy recovery rehearsal; not a VM-backup restore or activation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import time
import urllib.request
from uuid import uuid4

from sweden_operations import (
    DATA, GIB, IMAGE, ROOT, SafetyError, assert_pilot_unchanged,
    base_context, command, inspect, osrm_command, require, validate_container,
)

TIMEOUT_ENTRYPOINT = ["/usr/bin/timeout", "--signal=TERM", "--kill-after=10s", "240s"]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as file:
        while block := file.read(1024 * 1024):
            value.update(block)
    return value.digest()


def copy_artifacts(source, target, uid, gid):
    files = sorted(source.glob("sweden.osrm*"))
    require(len(files) >= 8 and (source / "sweden.osrm.hsgr") in files,
            "RECOVERY_ARTIFACT_SET_INCOMPLETE")
    for file in files:
        require(re.fullmatch(r"sweden\.osrm(?:\.[A-Za-z0-9_]+)*", file.name) is not None and
                file.is_file() and not file.is_symlink(), "RECOVERY_ARTIFACT_UNSAFE")
    total = sum(file.stat().st_size for file in files)
    require(shutil.disk_usage(ROOT).free >= total + 16 * GIB, "RECOVERY_DISK_HEADROOM")
    target.mkdir(mode=0o700)
    os.chown(target, uid, gid)
    for file in files:
        before = digest(file)
        restored = target / file.name
        shutil.copyfile(file, restored)
        os.chmod(restored, 0o600)
        os.chown(restored, uid, gid)
        require(before == digest(restored) == digest(file), "RECOVERY_ARTIFACT_DIGEST")
    return {"artifact_files": len(files), "artifact_bytes": total, "byte_identical_copy": True}


def public_road_probe():
    # These are public control coordinates, not uploaded customer locations.
    for lng, lat in ((18.0686, 59.3293), (20.2253, 67.8558), (13.0038, 55.6050)):
        with urllib.request.urlopen(
            f"http://127.0.0.1:5003/nearest/v1/driving/{lng},{lat}?number=1&radiuses=250",
            timeout=5,
        ) as response:
            body = response.read(65537)
        require(len(body) <= 65536, "RECOVERY_RESPONSE_SIZE")
        value = json.loads(body)
        require(value.get("code") == "Ok" and len(value.get("waypoints", [])) == 1 and
                0 <= value["waypoints"][0]["distance"] <= 250, "RECOVERY_ROAD_HEALTH")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rehearsal-only", action="store_true", required=True)
    parser.parse_args()
    operation = uuid4().hex
    name = "traivo-osrm-recovery-" + operation
    work = ROOT / ("recovery-probe-" + operation)
    cid = None
    work_created = False
    success = False
    report = {"kind": "isolated_stateless_artifact_recovery_not_VM_backup_restore",
              "production_activated": False}
    # SIGTERM and Ctrl+C enter finally; the container also has its own 240s timeout.
    def interrupted(_signum, _frame):
        raise SafetyError("RECOVERY_INTERRUPTED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        context = base_context()
        require(not list(ROOT.glob("recovery-probe-*")) and not command(
            ["docker", "ps", "-aq", "--filter", "label=traivo.osrm.rehearsal"]).stdout.strip(),
            "PREVIOUS_REHEARSAL_REQUIRES_INSPECTION")
        available = next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines()
                         if line.startswith("MemAvailable:"))
        require(int(available) * 1024 >= 7 * GIB, "RECOVERY_MEMORY_HEADROOM")
        with socket.socket() as test:
            test.bind(("127.0.0.1", 5003))
        work.mkdir(mode=0o700)
        work_created = True
        target = work / "data"
        account = context["account"]
        started = time.monotonic()
        report.update(copy_artifacts(DATA, target, account.pw_uid, account.pw_gid))
        command(["docker", "run", "--detach", "--pull=never", "--restart=no",
                 "--log-driver=none", "--init", "--name", name,
                 "--label", "traivo.osrm.rehearsal=" + operation,
                 "--cidfile", str(work / "container-id"),
                 "--user", f"{account.pw_uid}:{account.pw_gid}", "--read-only", "--cap-drop=ALL",
                 "--security-opt=no-new-privileges", "--pids-limit=256",
                 "--memory=6g", "--memory-swap=6g", "--cpus=1",
                 "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                 "--publish", "127.0.0.1:5003:5000", "--volume", str(target) + ":/data:ro",
                 "--entrypoint", TIMEOUT_ENTRYPOINT[0], IMAGE,
                 *TIMEOUT_ENTRYPOINT[1:], *osrm_command(1)], timeout=60)
        cid = (work / "container-id").read_text().strip()
        require(re.fullmatch("[0-9a-f]{64}", cid) is not None, "RECOVERY_CONTAINER_ID")
        last_error = None
        for _ in range(30):
            entry = inspect(cid)
            validate_container(entry, target, 5003, f"{account.pw_uid}:{account.pw_gid}",
                               cpu=1, entrypoint=[TIMEOUT_ENTRYPOINT[0]],
                               command_prefix=TIMEOUT_ENTRYPOINT[1:])
            try:
                public_road_probe()
                last_error = None
                break
            except (OSError, SafetyError) as error:
                last_error = error
                time.sleep(1)
        require(last_error is None, "RECOVERY_STARTUP_FAILED")
        assert_pilot_unchanged(context)
        report.update({"public_controls": 3, "seconds": round(time.monotonic() - started, 3),
                       "existing_services_unchanged": True, "container_timeout_seconds": 240})
        success = True
    except SafetyError as error:
        report.update({"status": "STOP", "event": str(error)})
    except Exception as error:
        report.update({"status": "STOP", "event": "RECOVERY_FAILED",
                       "error_type": type(error).__name__})
    finally:
        try:
            # A failed docker run can have created a container before returning.
            if cid is None and work_created and (work / "container-id").is_file():
                candidate_id = (work / "container-id").read_text().strip()
                if re.fullmatch("[0-9a-f]{64}", candidate_id):
                    cid = candidate_id
            if cid:
                entry = inspect(cid)
                require(entry["Name"] == "/" + name and
                        (entry["Config"].get("Labels") or {}).get("traivo.osrm.rehearsal") == operation,
                        "RECOVERY_CLEANUP_OWNERSHIP")
                command(["docker", "rm", "--force", cid], timeout=30)
            if work_created:
                require(work.parent == ROOT and work.name == "recovery-probe-" + operation and
                        not work.is_symlink(), "RECOVERY_CLEANUP_PATH")
                shutil.rmtree(work)
            report["own_artifacts_cleaned"] = True
        except Exception:
            success = False
            report.update({"status": "STOP", "event": "RECOVERY_CLEANUP_INCOMPLETE",
                           "own_artifacts_cleaned": False, "rehearsal_name": name,
                           "rehearsal_directory": str(work)})
    print(json.dumps(report, sort_keys=True))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())