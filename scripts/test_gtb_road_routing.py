"""Synthetic regression checks; never substitutes for the live source/export verification."""
import contextlib
import io
import random
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import gtb_optimize_route_files as runner
import gtb_road_provider as provider
from gtb_road_order import directed_two_opt, nearest_order, optimize, relocate, score


class RoadOrderTests(unittest.TestCase):
    def test_binary_baseline_reuses_exact_directed_matrix_and_rejects_trailing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            matrix = Path(directory) / "matrix.f64le"
            output = Path(directory) / "result.json"
            payload = struct.pack("<9d", 0, 10, 20, 900, 0, 30, 800, 40, 0)
            matrix.write_bytes(payload)
            command = [sys.executable, str(Path(__file__).with_name("gtb_road_order.py")),
                       "--matrix", str(matrix), "--width", "3", "--output", str(output)]
            subprocess.run(command, check=True, capture_output=True)
            result = json.loads(output.read_text())
            self.assertEqual(result["matrixSha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(set(result["order"]), {1, 2})
            self.assertEqual(result["distanceMeters"], 40)
            matrix.write_bytes(payload + b"x")
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_directed_orders_preserve_all_nodes_and_improve_nearest_start(self):
        for seed in range(12):
            randomizer = random.Random(seed)
            matrix = [[0 if i == j else randomizer.random() * 100 + 1 for j in range(20)] for i in range(20)]
            with contextlib.redirect_stdout(io.StringIO()):
                result = optimize(matrix)
            self.assertEqual(set(result), set(range(1, 20)))
            self.assertEqual(len(result), 19)
            self.assertLessEqual(score(result, matrix), score(nearest_order(matrix), matrix) + 1e-8)

    def test_open_score_has_no_depot_return(self):
        matrix = [[0, 10, 20], [900, 0, 30], [800, 40, 0]]
        self.assertEqual(score([1, 2], matrix), 40)

    def test_local_search_does_not_apply_symmetric_cost_formula(self):
        matrix = [[0, 1, 4, 9], [7, 0, 1, 2], [6, 100, 0, 1], [6, 1, 2, 0]]
        order = [1, 2, 3]
        neighbors = [[1, 2, 3], [2, 3], [1, 3], [1, 2]]
        for improve in [relocate, directed_two_opt]:
            self.assertLessEqual(score(improve(order, matrix, neighbors), matrix), score(order, matrix))


class ProviderTests(unittest.TestCase):
    def test_ch_correction_is_narrow(self):
        point = (11.5, 58)
        self.assertEqual(provider.valid_cost(-0.2, 0, point, point), (0, 0, True))
        for distance, duration, destination in [(None, 0, point), (-0.6, 0, point),
                                                (-0.2, 1, point), (-0.2, 0, (11.6, 58))]:
            with self.assertRaises(RuntimeError):
                provider.valid_cost(distance, duration, point, destination)

    def test_requested_coordinate_snap_is_checked(self):
        with self.assertRaises(RuntimeError):
            provider.assert_snaps([(11.5, 58)], [{"location": [11.6, 58]}])
        with self.assertRaises(RuntimeError):
            provider.assert_snaps([(11.5, 58)], [])

    def test_complete_cross_block_matrix_and_cache_identity(self):
        points = [(11.5 + i * 0.00001, 58) for i in range(5)]
        indices = {point: i for i, point in enumerate(points)}

        def table(selected, source_indices, destination_indices):
            sources = [indices[selected[i]] for i in source_indices]
            destinations = [indices[selected[i]] for i in destination_indices]
            costs = [[0 if a == b else 100 * a + b + 1 for b in destinations] for a in sources]
            return {"code": "Ok", "distances": costs, "durations": costs,
                    "sources": [{"location": list(selected[i])} for i in source_indices],
                    "destinations": [{"location": list(selected[i])} for i in destination_indices]}

        with tempfile.TemporaryDirectory() as cache, patch.object(provider, "BLOCK_SIZE", 2), \
                patch.object(provider, "request_table", side_effect=table), contextlib.redirect_stdout(io.StringIO()):
            distance, duration, manifest = provider.build_matrix(points, cache, {"synthetic": True})
            self.assertEqual(manifest["table_requests"], 9)
            self.assertEqual(distance[3][1], 302)
            self.assertEqual(distance[1][3], 104)
            self.assertEqual(duration[4][4], 0)
            cached, _, _ = provider.build_matrix(points, cache, {"synthetic": True})
            self.assertEqual(cached, distance)
            with self.assertRaises(RuntimeError):
                provider.build_matrix(points, cache, {"synthetic": "changed"})

    def test_geometry_chunks_overlap_without_extra_terminal_leg(self):
        points = [(11.5 + i * 0.00001, 58) for i in range(52)]
        calls = []

        def response(url, timeout):
            encoded = url.split("/driving/")[1].split("?")[0]
            selected = [list(map(float, item.split(","))) for item in encoded.split(";")]
            calls.append(selected)
            body = {"code": "Ok", "waypoints": [{"location": p} for p in selected],
                    "routes": [{"geometry": {"coordinates": selected},
                                "legs": [{"distance": 10, "duration": 2} for _ in selected[1:]]}]}
            import json
            return contextlib.closing(io.BytesIO(json.dumps(body).encode()))

        with patch.object(runner.urllib.request, "urlopen", side_effect=response):
            result = runner.road_geometry(points)
        self.assertEqual(len(result["legs"]), 51)
        self.assertEqual(result["distance_meters"], 510)
        self.assertEqual(calls[0][-1], calls[1][0])
        self.assertEqual(result["geometry"][-1], list(points[-1]))

    def test_invalid_table_distance_requires_verified_road_route_not_clamping(self):
        points = [(11.5, 58), (11.5001, 58)]

        def table(selected, sources, destinations):
            return {"code": "Ok", "distances": [[0, -2], [5, 0]], "durations": [[0, 1], [1, 0]],
                    "sources": [{"location": list(p)} for p in selected],
                    "destinations": [{"location": list(p)} for p in selected]}

        with tempfile.TemporaryDirectory() as cache, patch.object(provider, "request_table", side_effect=table), \
                patch.object(provider, "verified_pair_cost", return_value=(6.5, 2)) as verify, \
                contextlib.redirect_stdout(io.StringIO()):
            distance, duration, manifest = provider.build_matrix(points, cache, {"synthetic": True})
            self.assertEqual(distance[0][1], 6.5)
            self.assertEqual(duration[0][1], 2)
            self.assertEqual(manifest["verified_route_repairs"], 1)
            verify.assert_called_once_with(points[0], points[1])


if __name__ == "__main__":
    unittest.main()
