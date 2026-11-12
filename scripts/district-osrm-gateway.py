"""Development-only native OSRM supervisor with immutable dataset attestation.

Loopback gateway retains the approved 5001 address. Its child binds 5003.
No coordinates, URLs or response bodies are written to logs or disk.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / ".cache/district-road/west-sweden.osrm"
MANIFEST = DATASET.parent / "bulk-provider-identity.json"


def attest_dataset(dataset=DATASET):
    binary = Path(shutil.which("osrm-routed") or "")
    if not binary.is_file():
        raise RuntimeError("Native OSRM binary is unavailable.")
    profile = binary.parent.parent / "share/osrm/profiles/car.lua"
    files = sorted(dataset.parent.glob(dataset.name + ".*")) + [profile, binary.resolve()]
    if not Path(str(dataset) + ".hsgr").is_file() or not profile.is_file():
        raise RuntimeError("Prepared CH dataset or car profile is unavailable.")
    digest = hashlib.sha256()
    signatures = {}
    for file in files:
        if file.is_symlink() or not file.is_file():
            raise RuntimeError("OSRM dataset must consist of regular files.")
        stat = file.stat()
        signatures[file] = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        digest.update(file.name.encode())
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    digest.update(b"CH:car:driving")
    return "osrm-ch-car-" + digest.hexdigest(), signatures


def unchanged(signatures):
    try:
        return all(not file.is_symlink() and
                   (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) == expected
                   for file, expected in signatures.items() for s in [file.stat()])
    except OSError:
        return False


def owns_listener(pid, port):
    """Verify Linux socket ownership, not merely that some server answers."""
    try:
        sockets = set()
        for entry in Path(f"/proc/{pid}/fd").iterdir():
            try:
                sockets.add(os.readlink(entry))
            except FileNotFoundError:
                pass  # Iterating /proc/fd itself briefly opens a descriptor.
        for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
            fields = line.split()
            address, state, inode = fields[1], fields[3], fields[9]
            if address == f"0100007F:{port:04X}" and state == "0A":
                return f"socket:[{inode}]" in sockets
    except OSError:
        return False
    return False


def main():
    if (os.environ.get("REPLIT_DEPLOYMENT") == "1" or
            os.environ.get("NODE_ENV") == "production"):
        raise RuntimeError("Native district gateway is development-only.")
    identity, signatures = attest_dataset()
    child = subprocess.Popen([
        "osrm-routed", str(DATASET), "--algorithm", "CH", "--ip", "127.0.0.1",
        "--port", "5003", "--threads", "4", "--max-table-size", "1000",
        "--max-viaroute-size", "750", "--verbosity", "NONE",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stop = threading.Event()
    slots = threading.BoundedSemaphore(2)
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_args: stop.set())

    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if (not self.path.startswith(("/table/v1/driving/", "/route/v1/driving/"))
                    or len(self.path) > 65536):
                self.send_error(400, "Unsupported request")
                return
            if child.poll() is not None or not owns_listener(child.pid, 5003) or not unchanged(signatures):
                self.send_error(503, "Road dataset unavailable")
                stop.set()
                return
            if not slots.acquire(blocking=False):
                self.send_error(429, "Road capacity busy")
                return
            connection = http.client.HTTPConnection("127.0.0.1", 5003, timeout=25)
            try:
                connection.request("GET", self.path)
                response = connection.getresponse()
                body = response.read(64 * 1024 * 1024 + 1)
                if len(body) > 64 * 1024 * 1024 or not owns_listener(child.pid, 5003) or not unchanged(signatures):
                    self.send_error(503, "Road dataset changed or response too large")
                    if not unchanged(signatures):
                        stop.set()
                    return
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("x-osrm-dataset-id", identity)
                self.end_headers()
                self.wfile.write(body)
            except (OSError, http.client.HTTPException):
                if not self.wfile.closed:
                    try:
                        self.send_error(503, "Road service unavailable")
                    except OSError:
                        pass
            finally:
                connection.close()
                slots.release()

    server = None
    try:
        # No existing native process may occupy the child's port. Prove that
        # this child remains alive before attesting responses from its socket.
        for _ in range(100):
            if child.poll() is not None:
                raise RuntimeError("Native OSRM failed to start.")
            try:
                if not owns_listener(child.pid, 5003):
                    time.sleep(0.1)
                    continue
                connection = http.client.HTTPConnection("127.0.0.1", 5003, timeout=1)
                connection.request("GET", "/route/v1/driving/11.8,57.7;11.8,57.7")
                response = connection.getresponse()
                response.read()
                connection.close()
                time.sleep(0.1)
                if child.poll() is not None or not owns_listener(child.pid, 5003):
                    raise RuntimeError("Native OSRM port belongs to another process.")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Native OSRM did not become ready.")
        server = ThreadingHTTPServer(("127.0.0.1", 5001), Gateway)
        server.daemon_threads = True
        if not unchanged(signatures):
            raise RuntimeError("Dataset changed during startup.")
        temporary = MANIFEST.with_suffix(".tmp")
        temporary.write_text(json.dumps({
            "serverId": "shared", "datasetIdentity": identity,
            "maxTableCoordinates": 500, "bulkApproved": True,
            "algorithm": "CH", "profile": "car",
        }))
        temporary.replace(MANIFEST)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print("Development district OSRM ready with immutable CH/car dataset.", flush=True)
        while not stop.wait(1):
            if child.poll() is not None or not unchanged(signatures):
                stop.set()
    finally:
        if server:
            server.shutdown()
            server.server_close()
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


if __name__ == "__main__":
    main()
