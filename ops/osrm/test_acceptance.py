import importlib.util
import math
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location("acceptance", Path(__file__).with_name("acceptance.py"))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class AcceptanceProtocolTests(unittest.TestCase):
    def test_separate_source_destination_blocks_conserve_all_cells(self):
        points = [(12.0, 57.7), (12.1, 57.8), (12.2, 57.9)]
        calls = []

        def response(base, path, timeout=120):
            parsed = urlsplit(path)
            coords = [tuple(map(float, xy.split(",")))
                      for xy in parsed.path.rsplit("/", 1)[1].split(";")]
            args = parse_qs(parsed.query)
            src = [int(x) for x in args["sources"][0].split(";")]
            dst = [int(x) for x in args["destinations"][0].split(";")]
            calls.append((src, dst, len(coords)))
            matrix = [[0 if coords[i] == coords[j] else
                       math.dist(coords[i], coords[j]) * 10000 +
                       (10 if coords[i][0] < coords[j][0] else 30)
                       for j in dst] for i in src]
            return {"code": "Ok", "distances": matrix, "durations": matrix}, 0.001

        with patch.object(acceptance, "request", side_effect=response):
            result = acceptance.table("http://unused", points, block_size=2, workers=1)
        self.assertEqual(result["pairs"], 9)
        self.assertEqual(result["block_requests"], 4)
        self.assertIn(([0, 1], [2], 3), calls)
        self.assertIn(([0], [1, 2], 3), calls)

    def test_null_road_cost_fails_instead_of_becoming_straight_line(self):
        body = {"code": "Ok", "distances": [[None]], "durations": [[0]]}
        with patch.object(acceptance, "request", return_value=(body, 0.001)):
            with self.assertRaisesRegex(AssertionError, "Missing or invalid"):
                acceptance.table("http://unused", [(12, 57)])

    def test_incomplete_geometry_fails(self):
        body = {"code": "Ok", "waypoints": [{}],
                "routes": [{"geometry": {"coordinates": [[12, 57], [12.1, 57.1]]}}]}
        with patch.object(acceptance, "request", return_value=(body, 0.001)):
            with self.assertRaises(AssertionError):
                acceptance.geometry("http://unused", [(12, 57), (12.1, 57.1)])


if __name__ == "__main__":
    unittest.main()