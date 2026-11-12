"""Offline retention regressions; all files are synthetic and temporary."""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from district_cache import cache_lock, cleanup_expired, RETENTION, save

NOW = dt.datetime(2026, 10, 4, 12, tzinfo=dt.timezone.utc)
SCRIPTS = Path(__file__).resolve().parent


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"NODE_ENV": "test", "REPLIT_DEPLOYMENT": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def seed(self, verified_at):
        provider = {"accepted": True, "verifiedAt": verified_at,
                    "latitude": 58.1, "longitude": 11.8, "placeId": "synthetic", "locationType": "ROOFTOP"}
        self.write("geocoding-state.json", {"calls": 595, "approvedCallLimit": 1000,
                   "audit": {"reservedFailures": 3}, "results": {
                       "Synthetic 1": provider, "Synthetic 2": {"accepted": False, "reason": "reserved_or_failed"}}})
        self.write("real-stenungsund-500.json", {"source": "synthetic.xlsx", "sourceSha256": "sha",
                   "sheet": "Stenungsund", "calls": 595, "coordinateExpiryDays": 30,
                   "rows": [{**provider, "sourceRowNumber": 42, "objectNumber": "object",
                             "address": "Synthetic 1", "original": {"Objektid": "object", "Lat": "source-owned"}}]})
        for name in ("synthetic.xlsx", "stenungsund-500-loop.csv", "stenungsund-500-loop.xlsx",
                     "real-acceptance-summary.json", "dataset-sha256.txt", "west-sweden.osrm.hsgr"):
            (self.root / name).write_bytes(b"original bytes")
        for name in ("stenungsund-500-loop.geojson", "actual-loop-preview.png"):
            (self.root / name).write_bytes(b"derived coordinates")

    def clean(self):
        with cache_lock(self.root):
            return cleanup_expired(self.root, NOW)

    def test_exact_boundary_and_preservation(self):
        self.seed((NOW - RETENTION).isoformat())
        preserved = {p.name: p.read_bytes() for p in self.root.iterdir()
                     if p.name not in ("geocoding-state.json", "real-stenungsund-500.json",
                                       "stenungsund-500-loop.geojson", "actual-loop-preview.png")}
        self.assertEqual(self.clean(), 2)
        state = self.read("geocoding-state.json")
        self.assertEqual(state["calls"], 595)
        self.assertEqual(state["approvedCallLimit"], 1000)
        self.assertEqual(state["audit"], {"reservedFailures": 3})
        self.assertEqual(state["results"]["Synthetic 2"], {"accepted": False, "reason": "reserved_or_failed"})
        self.assertEqual(state["results"]["Synthetic 1"]["reason"], "expired_requires_new_approval")
        sample = self.read("real-stenungsund-500.json")
        self.assertEqual(sample["sourceSha256"], "sha")
        self.assertEqual(sample["rows"][0]["original"], {"Objektid": "object", "Lat": "source-owned"})
        self.assertEqual(sample["rows"][0]["sourceRowNumber"], 42)
        for name, data in preserved.items():
            self.assertEqual((self.root / name).read_bytes(), data)
        for name in ("latitude", "longitude", "placeId", "locationType"):
            self.assertNotIn(name, state["results"]["Synthetic 1"])
            self.assertNotIn(name, sample["rows"][0])
        self.assertFalse((self.root / "stenungsund-500-loop.geojson").exists())
        self.assertFalse((self.root / "actual-loop-preview.png").exists())
        after = (self.root / "geocoding-state.json").read_bytes()
        self.assertEqual(self.clean(), 0)
        self.assertEqual((self.root / "geocoding-state.json").read_bytes(), after)

    def test_one_microsecond_before_boundary_is_intact(self):
        self.seed((NOW - RETENTION + dt.timedelta(microseconds=1)).isoformat())
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.assertEqual(self.clean(), 0)
        for name, data in before.items():
            self.assertEqual((self.root / name).read_bytes(), data)

    def test_bad_missing_naive_and_future_times_are_scrubbed(self):
        for timestamp in ("invalid", None, "2026-10-03T00:00:00", (NOW + dt.timedelta(seconds=1)).isoformat()):
            with self.subTest(timestamp=timestamp):
                self.seed(timestamp)
                self.assertEqual(self.clean(), 2)
        self.seed((NOW - RETENTION).isoformat())
        sample = self.read("real-stenungsund-500.json")
        del sample["rows"][0]["verifiedAt"]
        self.write("real-stenungsund-500.json", sample)
        self.assertEqual(self.clean(), 2)

    def test_mixed_ages_preserve_fresh_provider_result(self):
        self.seed((NOW - RETENTION).isoformat())
        state = self.read("geocoding-state.json")
        state["results"]["fresh"] = {"accepted": True, "verifiedAt": NOW.isoformat(), "latitude": 58, "longitude": 12}
        self.write("geocoding-state.json", state)
        self.clean()
        self.assertEqual(self.read("geocoding-state.json")["results"]["fresh"], state["results"]["fresh"])

    def test_crash_temporaries_are_removed_without_budget_reset(self):
        self.seed((NOW - RETENTION).isoformat())
        for name in ("geocoding-state.tmp", "real-stenungsund-500.tmp"):
            (self.root / name).write_text("broken private partial write")
        self.clean()
        self.assertEqual(self.read("geocoding-state.json")["calls"], 595)
        self.assertFalse((self.root / "geocoding-state.tmp").exists())
        self.assertFalse((self.root / "real-stenungsund-500.tmp").exists())

    def test_invalid_journal_is_not_replaced(self):
        for value in ({"results": {}}, {"calls": -1, "results": {}}, {"calls": True, "results": {}}):
            self.write("geocoding-state.json", value)
            before = (self.root / "geocoding-state.json").read_bytes()
            with self.assertRaises(RuntimeError):
                self.clean()
            self.assertEqual((self.root / "geocoding-state.json").read_bytes(), before)

    def test_symlink_targets_are_never_changed(self):
        target = self.root / "source.xlsx"
        target.write_bytes(b"original")
        (self.root / "geocoding-state.json").symlink_to(target)
        with self.assertRaises(RuntimeError):
            self.clean()
        self.assertEqual(target.read_bytes(), b"original")

    def test_symlink_temp_is_not_overwritten(self):
        target = self.root / "source.xlsx"
        target.write_bytes(b"original")
        (self.root / "geocoding-state.tmp").symlink_to(target)
        with cache_lock(self.root), self.assertRaises(RuntimeError):
            save(self.root / "geocoding-state.json", {"calls": 595})
        self.assertEqual(target.read_bytes(), b"original")

    def test_production_is_refused(self):
        with patch.dict(os.environ, {"REPLIT_DEPLOYMENT": "1"}), self.assertRaises(RuntimeError):
            self.clean()
        with patch.dict(os.environ, {"NODE_ENV": "production"}), self.assertRaises(RuntimeError):
            self.clean()

    def test_geocoding_refuses_expired_tombstones_without_network_or_budget_change(self):
        self.seed((NOW - RETENTION).isoformat())
        self.clean()
        original = (self.root / "geocoding-state.json").read_bytes()
        code = """import sys, runpy, types, os; from pathlib import Path
sys.path.insert(0, sys.argv[1])
import district_cache
district_cache.ROOT = Path(sys.argv[2])
# Synthetic workbook reader: never reads any actual uploaded workbook.
class Sheet:
 def iter_rows(self, **kwargs):
  return iter([('Fastighetsadress','Fastighetspostadress','Objektid'), ('Synthetic 1','Stenungsund','object')])
sys.modules['openpyxl'] = types.SimpleNamespace(load_workbook=lambda *a, **k: {'Stenungsund': Sheet()})
import glob, urllib.request
glob.glob = lambda pattern: ['synthetic.xlsx']
def forbidden(*args, **kwargs):
 raise AssertionError('No network calls permitted in this test')
urllib.request.urlopen = forbidden
runpy.run_path(str(Path(district_cache.__file__).parent / 'district-geocode.py'), run_name='__main__')
"""
        child = self.child(code, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _, error = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 1)
        self.assertIn("new explicit approval", error)
        self.assertEqual((self.root / "geocoding-state.json").read_bytes(), original)

    def test_periodic_cleanup_skips_active_lock_then_retries(self):
        self.seed((NOW - RETENTION).isoformat())
        # Two iterations of the actual watch entrypoint, with controlled time.
        code = """import sys, runpy, time; from pathlib import Path
sys.path.insert(0, sys.argv[1])
import district_cache
district_cache.ROOT = Path(sys.argv[2])
lease = district_cache.cache_lock(district_cache.ROOT)
lease.__enter__()
count = 0
def tick(seconds):
 global count
 assert seconds == 60
 count += 1
 if count == 1:
  assert 'latitude' in district_cache.json.loads((district_cache.ROOT/'geocoding-state.json').read_text())['results']['Synthetic 1']
  lease.__exit__(None, None, None)
 else:
  raise SystemExit(0)
time.sleep = tick
sys.argv = ['retention', '--watch']
runpy.run_path(str(Path(district_cache.__file__).parent / 'district-cache-retention.py'), run_name='__main__')
"""
        child = self.child(code, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        _, error = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(self.read("geocoding-state.json")["calls"], 595)
        self.assertNotIn("latitude", self.read("geocoding-state.json")["results"]["Synthetic 1"])

    def child(self, code, *arguments, **kwargs):
        return subprocess.Popen([sys.executable, "-c", code, str(SCRIPTS), str(self.root), *arguments],
                                env=os.environ.copy(), **kwargs)

    def test_parallel_geocoding_and_cleanup_are_excluded(self):
        self.seed((NOW - RETENTION).isoformat())
        code = """import sys; from pathlib import Path
sys.path.insert(0, sys.argv[1])
from district_cache import cache_lock
with cache_lock(Path(sys.argv[2])):
 print('LOCKED', flush=True)
 sys.stdin.read()
"""
        child = self.child(code, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline(), "LOCKED\n")
            before = (self.root / "geocoding-state.json").read_bytes()
            with self.assertRaises(BlockingIOError):
                self.clean()
            self.assertEqual((self.root / "geocoding-state.json").read_bytes(), before)
        finally:
            child.communicate("", timeout=5)
        self.assertEqual(self.clean(), 2)

    def test_acceptance_lease_holds_until_eof_and_cleans_on_release(self):
        # An acceptance process lives in TS; exercise its actual Python protocol,
        # with synthetic time advanced while the lease is held.
        self.seed(dt.datetime.now(dt.timezone.utc).isoformat())
        code = """import sys, runpy; from pathlib import Path
sys.path.insert(0, sys.argv[1])
import district_cache
district_cache.ROOT = Path(sys.argv[2])
sys.argv = ['retention', '--hold-lock']
runpy.run_path(str(Path(district_cache.__file__).parent / 'district-cache-retention.py'), run_name='__main__')
"""
        child = self.child(code, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline(), "LOCKED\n")
            with self.assertRaises(BlockingIOError):
                self.clean()
            # Simulate passage of 30 days, not a concurrent application write.
            self.seed((dt.datetime.now(dt.timezone.utc) - RETENTION).isoformat())
        finally:
            output, error = child.communicate("", timeout=5)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(self.read("geocoding-state.json")["calls"], 595)
        self.assertNotIn("latitude", self.read("geocoding-state.json")["results"]["Synthetic 1"])

    def test_db_cleanup_lease_never_changes_cache_or_budget(self):
        self.seed((dt.datetime.now(dt.timezone.utc) - RETENTION).isoformat())
        preserved = {p.name: p.read_bytes() for p in self.root.iterdir()}
        code = """import sys, runpy; from pathlib import Path
sys.path.insert(0, sys.argv[1])
import district_cache
district_cache.ROOT = Path(sys.argv[2])
sys.argv = ['retention', '--hold-lock-only']
runpy.run_path(str(Path(district_cache.__file__).parent / 'district-cache-retention.py'), run_name='__main__')
"""
        child = self.child(code, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline(), "LOCKED\n")
            with self.assertRaises(BlockingIOError):
                self.clean()
        finally:
            output, error = child.communicate("", timeout=5)
        self.assertEqual(child.returncode, 0, error)
        for name, data in preserved.items():
            self.assertEqual((self.root / name).read_bytes(), data, name)

    def test_killed_holder_releases_kernel_lock(self):
        code = """import sys; from pathlib import Path
sys.path.insert(0, sys.argv[1])
from district_cache import cache_lock
with cache_lock(Path(sys.argv[2])):
 print('LOCKED', flush=True)
 sys.stdin.read()
"""
        child = self.child(code, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline(), "LOCKED\n")
            child.kill()
            child.communicate(timeout=5)
            self.assertEqual(self.clean(), 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    def test_surviving_node_worker_keeps_acceptance_lease_after_parent_kill(self):
        self.seed(dt.datetime.now(dt.timezone.utc).isoformat())
        # Exercise Node's actual extra-stdio inheritance used by startWorker.
        holder_code = """import sys, runpy; from pathlib import Path
sys.path.insert(0, sys.argv[1])
import district_cache
district_cache.ROOT = Path(sys.argv[2])
sys.argv = ['retention', '--hold-lock']
runpy.run_path(str(Path(district_cache.__file__).parent / 'district-cache-retention.py'), run_name='__main__')
"""
        node_code = """
import { spawn } from 'node:child_process';
const lease = spawn(process.argv[1], ['-c', process.argv[2], process.argv[3], process.argv[4]],
                    {stdio:['pipe','pipe','ignore']});
lease.stdout.once('data', () => {
  spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'],
        {stdio:['ignore','ignore','ignore',lease.stdin]});
  console.log('WORKER');
});
setTimeout(()=>process.exit(2),10000);
"""
        parent = subprocess.Popen(["node", "--input-type=module", "-e", node_code,
                                   sys.executable, holder_code, str(SCRIPTS), str(self.root)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(parent.stdout.readline(), "WORKER\n")
            parent.kill()
            parent.communicate(timeout=5)
            with self.assertRaises(BlockingIOError):
                self.clean()
            deadline = time.monotonic() + 5
            while True:
                try:
                    self.clean()
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        self.fail("Lease not released after surviving worker ended")
                    time.sleep(0.05)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()