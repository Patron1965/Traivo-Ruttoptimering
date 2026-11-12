"""Synthetic safety checks; no provider calls and no database operations."""
import copy
import math
import tempfile
import unittest

from gtb_recheck_geocodes import exact_candidates
from gtb_revise_stenungsund import BUFFER_METERS, geography, strict_cost
from gtb_stenungsund_30km import assessment
from gtb_tjorn_5km import MARGIN
from gtb_road_provider import build_matrix


class RevisionTests(unittest.TestCase):
    def setUp(self):
        self.record = {"Adress": "Stora Askerön 752", "Ort": "Askerön", "Postnummer": "472 98"}
        self.result = {
            "types": ["street_address"], "formatted_address": "St Askerön 752, 471 75 Askerön, Sverige",
            "place_id": "synthetic", "address_components": [
                {"long_name": "Stora Askerön", "types": ["route"]},
                {"long_name": "752", "types": ["street_number"]},
                {"long_name": "Askerön", "types": ["postal_town"]},
                {"long_name": "471 75", "types": ["postal_code"]},
                {"long_name": "Sverige", "types": ["country"]}],
            "geometry": {"location": {"lat": 58.08, "lng": 11.77}, "location_type": "ROOFTOP"}}

    def candidates(self, results=None):
        return exact_candidates(self.record, {"results": results or [self.result]})

    def test_postcode_difference_is_not_an_address_conflict(self):
        self.assertEqual(len(self.candidates()), 1)

    def test_different_house_is_not_accepted(self):
        self.result["address_components"][1]["long_name"] = "753"
        self.assertEqual(self.candidates(), [])

    def test_different_locality_is_not_accepted(self):
        self.result["address_components"][2]["long_name"] = "Göteborg"
        self.assertEqual(self.candidates(), [])

    def test_partial_is_not_accepted(self):
        self.result["partial_match"] = True
        self.assertEqual(self.candidates(), [])

    def test_approximate_area_is_not_accepted(self):
        self.result["geometry"]["location_type"] = "APPROXIMATE"
        self.assertEqual(self.candidates(), [])

    def test_two_distinct_exact_positions_remain_ambiguous(self):
        other = copy.deepcopy(self.result)
        other["geometry"]["location"]["lat"] += 0.001
        self.assertEqual(len(self.candidates([self.result, other])), 2)

    def test_identical_positions_are_not_duplicated(self):
        self.assertEqual(len(self.candidates([self.result, copy.deepcopy(self.result)])), 1)

    def test_negative_costs_are_not_clamped(self):
        with self.assertRaises(RuntimeError):
            strict_cost(-0.1, 0, [11, 58], [11, 58])

    def test_nonfinite_costs_fail_closed(self):
        with self.assertRaises(RuntimeError):
            strict_cost(math.nan, 1, [11, 58], [11, 58])

    def test_margin_is_ten_km(self):
        self.assertEqual(BUFFER_METERS, 10000)
        square = [[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]
        self.assertTrue(geography.inside_polygon((50, 50), square))
        self.assertFalse(geography.inside_polygon((101, 50), square))
        self.assertAlmostEqual(geography.boundary_distance((10100, 50), square, 0), 10000)
        self.assertGreater(geography.boundary_distance((10101, 50), square, 0), 10000)

    def test_new_query_cannot_erase_old_ambiguity(self):
        other = copy.deepcopy(self.result)
        other["geometry"]["location"]["lat"] += 0.001
        record = {**self.record, "Källrad": 2}
        key = "Stora Askerön 752, 472 98, Askerön"
        evidence = {key: {"results": [self.result, other]}}
        fresh = {"Stora Askerön 752, Askerön, Sverige": {"results": [self.result]}}
        chosen, note, _ = assessment(record, evidence, fresh, {})
        self.assertIsNone(chosen)
        self.assertIn("flera", note)

    def test_previous_verified_position_is_preserved(self):
        record = {**self.record, "Källrad": 2}
        key = "Stora Askerön 752, 472 98, Askerön"
        evidence = {key: {"results": [self.result]}}
        chosen, note, _ = assessment(record, evidence, {}, {2: (11.77, 58.08)})
        self.assertEqual(chosen["longitude"], 11.77)
        self.assertIn("bevarad", note)

    def test_previous_position_must_match_original_address_evidence(self):
        record = {**self.record, "Källrad": 2}
        key = "Stora Askerön 752, 472 98, Askerön"
        evidence = {key: {"results": [self.result]}}
        with self.assertRaises(RuntimeError):
            assessment(record, evidence, {}, {2: (12.0, 59.0)})

    def test_fresh_exact_match_can_resolve_old_partial(self):
        partial = copy.deepcopy(self.result)
        partial["partial_match"] = True
        record = {**self.record, "Källrad": 2}
        key = "Stora Askerön 752, 472 98, Askerön"
        evidence = {key: {"results": [partial]}}
        fresh = {"Stora Askerön 752, Askerön, Sverige": {"results": [self.result]}}
        chosen, _, _ = assessment(record, evidence, fresh, {})
        self.assertEqual(chosen["longitude"], 11.77)

    def test_tjorn_margin_is_five_km(self):
        self.assertEqual(MARGIN, 5000)

    def test_raw_matrix_cache_must_match_exact_coordinate_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                build_matrix([[11, 58], [11.01, 58.01]], directory,
                             {"synthetic": True}, "/tmp/blocks-wrong-fingerprint")


if __name__ == "__main__":
    unittest.main()
