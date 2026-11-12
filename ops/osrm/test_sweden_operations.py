import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import sweden_operations as ops
import rehearse_sweden_recovery as recovery


def container_fixture():
    return {
        "State": {"Running": True, "OOMKilled": False},
        "Config": {"Image": ops.IMAGE, "User": "1001:1001",
                   "Cmd": ops.osrm_command(), "Entrypoint": None},
        "HostConfig": {"ReadonlyRootfs": True, "LogConfig": {"Type": "none"}, "CapDrop": ["ALL"],
                       "SecurityOpt": ["no-new-privileges:true"], "Init": True, "PidsLimit": 256,
                       "Memory": 6 * ops.GIB, "MemorySwap": 6 * ops.GIB,
                       "NanoCpus": 2_000_000_000, "RestartPolicy": {"Name": "no"},
                       "PortBindings": {"5000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5002"}]}},
        "NetworkSettings": {"Ports": {
            "5000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5002"}]}},
        "Mounts": [{"Destination": "/data", "Type": "bind", "Source": str(ops.DATA), "RW": False}],
    }


class OperationsTests(unittest.TestCase):
    def test_pinned_gateway_hash_matches_actual_preparer(self):
        source = Path(__file__).with_name("prepare-sweden-https.sh").read_text()
        template = source.split('configuration = r"""', 1)[1].split('"""', 1)[0]
        value = template.replace("__WORK__", str(ops.WORK)).replace("__DATASET__", ops.DATASET)
        self.assertEqual(hashlib.sha256(value.encode()).hexdigest(), ops.CONFIG_SHA256)

    def test_expected_container_is_accepted(self):
        ops.validate_container(container_fixture(), ops.DATA, 5002, "1001:1001")

    def test_each_unsafe_container_change_fails(self):
        mutations = [
            ("HostConfig", "ReadonlyRootfs", False), ("HostConfig", "MemorySwap", 0),
            ("HostConfig", "NanoCpus", 4_000_000_000),
            ("HostConfig", "LogConfig", {"Type": "json-file"}),
            ("HostConfig", "RestartPolicy", {"Name": "always"}),
            ("HostConfig", "PortBindings", {"5000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5002"}]}),
            ("Config", "Image", "unpinned:latest"), ("Config", "User", "0:0"),
            ("Config", "Cmd", ["osrm-routed"]), ("State", "OOMKilled", True),
        ]
        for section, key, value in mutations:
            with self.subTest(section=section, key=key):
                entry = container_fixture()
                entry[section][key] = value
                with self.assertRaises(ops.SafetyError):
                    ops.validate_container(entry, ops.DATA, 5002, "1001:1001")

    def test_foreign_or_writable_mount_is_rejected(self):
        for mutation in ({"RW": True}, {"Source": "/srv/customer-records"}):
            entry = container_fixture()
            entry["Mounts"][0].update(mutation)
            with self.assertRaises(ops.SafetyError):
                ops.validate_container(entry, ops.DATA, 5002, "1001:1001")

    def test_complete_recovery_timeout_argv_is_required(self):
        entry = container_fixture()
        entry["Config"]["Entrypoint"] = [recovery.TIMEOUT_ENTRYPOINT[0]]
        entry["Config"]["Cmd"] = [*recovery.TIMEOUT_ENTRYPOINT[1:], *ops.osrm_command(1)]
        entry["HostConfig"]["NanoCpus"] = 1_000_000_000
        for bindings in (entry["HostConfig"]["PortBindings"], entry["NetworkSettings"]["Ports"]):
            bindings["5000/tcp"][0]["HostPort"] = "5003"
        kwargs = {"cpu": 1, "entrypoint": [recovery.TIMEOUT_ENTRYPOINT[0]],
                  "command_prefix": recovery.TIMEOUT_ENTRYPOINT[1:]}
        ops.validate_container(entry, ops.DATA, 5003, "1001:1001", **kwargs)
        entry["Config"]["Cmd"] = ops.osrm_command(1)
        with self.assertRaises(ops.SafetyError):
            ops.validate_container(entry, ops.DATA, 5003, "1001:1001", **kwargs)

    def test_sensitive_messages_are_detected_without_printing_them(self):
        token = "a" * 64  # Synthetic, never a credential.
        messages = [token, "/route/v1/driving/18.0,59.0",
                    "/table/v1/driving/-18,59", '{"latitude":59}',
                    "Authorization: hidden", "Bearer " + "b" * 64]
        for message in messages:
            self.assertTrue(ops.log_contains_sensitive_data(message, token))
        self.assertFalse(ops.log_contains_sensitive_data("Started service; dataset sha256:" + "c" * 64,
                                                        token))

    def test_truncated_and_binary_journal_scans_fail_closed(self):
        for value in ("\n".join('{"MESSAGE":"safe"}' for _ in range(2001)),
                      '{"MESSAGE":[65,66]}'):
            result = type("Result", (), {"stdout": value})()
            with patch.object(ops, "command", return_value=result):
                with self.assertRaises(ops.SafetyError):
                    ops.audit_logs("a" * 64)

    def test_alarm_threshold_boundaries(self):
        healthy = {"available_memory_bytes": 2 * ops.GIB, "disk_free_bytes": 16 * ops.GIB,
                   "disk_free_percent": 10, "osrm_memory_percent_of_limit": 79.9}
        self.assertEqual(ops.alarm_codes(healthy, {"certificate_days_remaining": 14.1}, True), [])
        unsafe = dict(healthy, available_memory_bytes=2 * ops.GIB - 1,
                      disk_free_bytes=16 * ops.GIB - 1, osrm_memory_percent_of_limit=80)
        self.assertEqual(set(ops.alarm_codes(unsafe, {"certificate_days_remaining": 14}, False)),
                         {"GATEWAY_INACTIVE", "HOST_MEMORY_LOW", "DISK_SPACE_LOW",
                          "OSRM_MEMORY_HIGH", "CERTIFICATE_EXPIRING"})

    def test_only_osrm_artifacts_are_copied(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            for suffix in ("hsgr", "names", "ramIndex", "fileIndex", "edges", "nodes", "geometry", "properties"):
                (source / ("sweden.osrm." + suffix)).write_bytes(b"public road fixture")
            (source / "auth-token").write_text("excluded")
            (source / "customer.xlsx").write_text("excluded")
            target = root / "copy"
            usage = type("Usage", (), {"free": 32 * ops.GIB})()
            with patch.object(recovery, "ROOT", root), \
                 patch.object(recovery.shutil, "disk_usage", return_value=usage), \
                 patch.object(recovery.os, "chown"):
                result = recovery.copy_artifacts(source, target, os.getuid(), os.getgid())
            self.assertEqual(result["artifact_files"], 8)
            self.assertTrue(result["byte_identical_copy"])
            self.assertFalse((target / "auth-token").exists())
            self.assertFalse((target / "customer.xlsx").exists())

    def test_symlink_artifact_is_rejected_before_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            for index in range(8):
                (source / ("sweden.osrm.f" + str(index))).write_bytes(b"x")
            (source / "sweden.osrm.hsgr").symlink_to(source / "sweden.osrm.f0")
            with self.assertRaises(ops.SafetyError):
                recovery.copy_artifacts(source, root / "copy", 0, 0)

    def test_workspace_execution_is_refused_before_commands(self):
        with patch.dict(os.environ, {"REPL_ID": "workspace"}), \
             patch.object(ops, "command") as mocked:
            with self.assertRaisesRegex(ops.SafetyError, "EXPECTED_OPERATOR_HOST"):
                ops.base_context()
            mocked.assert_not_called()

    def recovery_main_case(self, fail_after_create=False, foreign_cleanup_owner=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entry = {}
            removed = []
            read_text = Path.read_text

            def read(path, *args, **kwargs):
                if str(path) == "/proc/meminfo":
                    return "MemAvailable: 8388608 kB\n"
                return read_text(path, *args, **kwargs)

            def copied(_source, target, _uid, _gid):
                target.mkdir()
                return {"artifact_files": 8, "byte_identical_copy": True}

            def execute(args, **_kwargs):
                if args[:2] == ["docker", "run"]:
                    cid_path = Path(args[args.index("--cidfile") + 1])
                    cid_path.write_text("f" * 64)
                    operation = args[args.index("--label") + 1].split("=", 1)[1]
                    entry.update(container_fixture())
                    entry["Name"] = "/" + args[args.index("--name") + 1]
                    entry["Config"]["Labels"] = {
                        "traivo.osrm.rehearsal": "foreign" if foreign_cleanup_owner else operation}
                    entry["Config"]["Entrypoint"] = [recovery.TIMEOUT_ENTRYPOINT[0]]
                    entry["Config"]["Cmd"] = [*recovery.TIMEOUT_ENTRYPOINT[1:], *ops.osrm_command(1)]
                    entry["HostConfig"]["NanoCpus"] = 1_000_000_000
                    entry["Mounts"][0]["Source"] = str(cid_path.parent / "data")
                    for binding in (entry["HostConfig"]["PortBindings"], entry["NetworkSettings"]["Ports"]):
                        binding["5000/tcp"][0]["HostPort"] = "5003"
                    if fail_after_create:
                        raise ops.SafetyError("HOST_COMMAND_FAILED")
                elif args[:3] == ["docker", "rm", "--force"]:
                    removed.append(args[3])
                return SimpleNamespace(stdout="", returncode=0)

            output = io.StringIO()
            with patch.object(recovery, "ROOT", root), \
                 patch.object(recovery, "base_context", return_value={"account": SimpleNamespace(pw_uid=1001, pw_gid=1001)}), \
                 patch.object(recovery, "assert_pilot_unchanged"), \
                 patch.object(recovery, "copy_artifacts", side_effect=copied), \
                 patch.object(recovery, "command", side_effect=execute), \
                 patch.object(recovery, "inspect", side_effect=lambda _cid: entry), \
                 patch.object(recovery, "public_road_probe"), \
                 patch.object(recovery.socket, "socket"), \
                 patch.object(recovery.signal, "signal"), \
                 patch.object(Path, "read_text", read), \
                 patch.object(sys, "argv", ["recovery", "--rehearsal-only"]), \
                 contextlib.redirect_stdout(output):
                status = recovery.main()
            return status, json.loads(output.getvalue()), removed, len(list(root.iterdir()))

    def test_successful_recovery_cleans_only_its_own_artifacts(self):
        status, report, removed, remaining = self.recovery_main_case()
        self.assertEqual(status, 0)
        self.assertTrue(report["own_artifacts_cleaned"])
        self.assertEqual(removed, ["f" * 64])
        self.assertEqual(remaining, 0)

    def test_failed_start_still_cleans_container_created_before_cli_failure(self):
        status, report, removed, remaining = self.recovery_main_case(fail_after_create=True)
        self.assertEqual(status, 1)
        self.assertEqual(report["event"], "HOST_COMMAND_FAILED")
        self.assertTrue(report["own_artifacts_cleaned"])
        self.assertEqual(removed, ["f" * 64])
        self.assertEqual(remaining, 0)

    def test_foreign_cleanup_owner_is_never_removed(self):
        status, report, removed, remaining = self.recovery_main_case(foreign_cleanup_owner=True)
        self.assertEqual(status, 1)
        self.assertEqual(report["event"], "RECOVERY_CLEANUP_INCOMPLETE")
        self.assertFalse(report["own_artifacts_cleaned"])
        self.assertEqual(removed, [])
        self.assertEqual(remaining, 1)


if __name__ == "__main__":
    unittest.main()