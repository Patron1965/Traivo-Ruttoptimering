"""Host-local service safety checks. Does not configure production or credentials."""
import json
import math
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5000"
ROOT = Path("/srv/traivo-osrm")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return json.load(response)


def main():
    points = json.loads((ROOT / "public-test-points.json").read_text())
    coords = ";".join(f"{p[0]:.6f},{p[1]:.6f}" for p in points)
    path = "/table/v1/driving/" + coords + "?annotations=distance,duration"
    started = time.monotonic()
    matrix = get(path)
    assert matrix["code"] == "Ok"
    for key in ("distances", "durations"):
        assert len(matrix[key]) == 500
        assert all(len(row) == 500 and
                   all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0
                       for x in row) for row in matrix[key])
    direct_seconds = time.monotonic() - started
    del matrix
    limited = False
    try:
        get("/table/v1/driving/" + coords + f";{points[0][0]:.6f},{points[0][1]:.6f}" +
            "?annotations=distance,duration")
    except urllib.error.HTTPError as error:
        body = json.load(error)
        limited = error.code == 400 and body.get("code") == "TooBig"
    assert limited, "Requests beyond the configured matrix cap were not rejected"
    canceled = subprocess.run(
        ["curl", "--silent", "--output", "/dev/null", "--max-time", "0.001", BASE + path],
        capture_output=True, timeout=5,
    )
    assert canceled.returncode == 28, "Client deadline did not cancel its HTTP request"
    time.sleep(0.2)
    assert get("/nearest/v1/driving/11.9746,57.7089")["code"] == "Ok"
    processes = subprocess.check_output(
        ["docker", "top", "traivo-osrm-ch", "-eo", "pid,comm"], text=True
    ).splitlines()
    # --init makes Docker's State.Pid point to tini, not the OSRM process.
    pid = next(line.split()[0] for line in processes[1:]
               if line.split()[1] == "osrm-routed")
    rss = [line for line in Path(f"/proc/{pid}/status").read_text().splitlines()
           if line.startswith(("VmRSS:", "VmHWM:"))]
    result = {
        "direct_500_by_500_distance_duration_seconds": round(direct_seconds, 3),
        "501_point_table_rejected": True,
        "client_http_deadline_canceled": True,
        "healthy_after_client_cancellation": True,
        "cancellation_scope": "HTTP client only; does not prove server computation interruption",
        "server_rss": rss,
        "ch_enabled_on_boot": subprocess.check_output(
            ["systemctl", "is-enabled", "traivo-osrm-ch"], text=True
        ).strip(),
        "mld_comparison_service_stopped": subprocess.run(
            ["systemctl", "is-active", "--quiet", "traivo-osrm-mld"]
        ).returncode != 0,
    }
    (ROOT / "runtime-checks.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()