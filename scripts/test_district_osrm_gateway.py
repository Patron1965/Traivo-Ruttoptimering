import importlib.util
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("district_gateway", Path(__file__).with_name("district-osrm-gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class AttestationTests(unittest.TestCase):
    def test_dataset_profile_and_binary_identity_and_change_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "bin/osrm-routed"
            profile = root / "share/osrm/profiles/car.lua"
            binary.parent.mkdir()
            profile.parent.mkdir(parents=True)
            binary.write_bytes(b"synthetic-osrm-binary")
            profile.write_bytes(b"synthetic-car-profile")
            dataset = root / "test.osrm"
            graph = Path(str(dataset) + ".hsgr")
            graph.write_bytes(b"synthetic-road-graph")
            geometry = Path(str(dataset) + ".geometry")
            geometry.write_bytes(b"synthetic-road-geometry")
            with patch.object(gateway.shutil, "which", return_value=str(binary)):
                first, signatures = gateway.attest_dataset(dataset)
                self.assertTrue(gateway.unchanged(signatures))
                self.assertEqual(first, gateway.attest_dataset(dataset)[0])
                geometry.write_bytes(b"changed-road-geometry")
                self.assertFalse(gateway.unchanged(signatures))
                self.assertNotEqual(first, gateway.attest_dataset(dataset)[0])
                graph.unlink()
                graph.symlink_to(geometry)
                with self.assertRaisesRegex(RuntimeError, "regular files"):
                    gateway.attest_dataset(dataset)

    def test_gateway_refuses_production_before_starting_a_process(self):
        for flag in ("REPLIT_DEPLOYMENT", "NODE_ENV"):
            value = "1" if flag == "REPLIT_DEPLOYMENT" else "production"
            with patch.dict(os.environ, {flag: value}), patch.object(gateway.subprocess, "Popen") as spawn:
                with self.assertRaisesRegex(RuntimeError, "development-only"):
                    gateway.main()
                spawn.assert_not_called()

    def test_listener_is_bound_to_the_owned_process(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            self.assertTrue(gateway.owns_listener(os.getpid(), port))
            self.assertFalse(gateway.owns_listener(99999999, port))


if __name__ == "__main__":
    unittest.main()
