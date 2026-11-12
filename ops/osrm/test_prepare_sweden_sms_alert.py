import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import prepare_sweden_sms_alert as sms


def report(codes=None, gateway_active=False):
    return {
        "kind": "preparation_only_no_customer_data",
        "production_activated": False,
        "gateway_active": gateway_active,
        "alarm_codes": ["GATEWAY_INACTIVE"] if codes is None else codes,
    }


class SmsDraftTests(unittest.TestCase):
    def test_gateway_expiry_is_not_presented_as_production_failure(self):
        draft = sms.build_draft(report())
        self.assertIn("PROV", draft["message"])
        self.assertIn("tidsgrans?", draft["message"])
        self.assertFalse(draft["sending_enabled"])
        self.assertFalse(draft["production_activated"])
        self.assertFalse(draft["delivery_verified"])
        self.assertFalse(draft["source_freshness_verified"])
        self.assertEqual(draft["provider_protocol"], "link_common_cgi")
        self.assertIn("contracted_api_access", draft["pending_requirements"])

    def test_every_alarm_combination_is_one_gsm7_segment(self):
        codes = list(sms.ALARM_LABELS)
        for mask in range(1 << len(codes)):
            selected = [code for index, code in enumerate(codes) if mask & (1 << index)]
            draft = sms.build_draft(report(selected, "GATEWAY_INACTIVE" not in selected))
            self.assertLessEqual(len(draft["message"]), 160)
            self.assertTrue(draft["message"].isascii())
            self.assertEqual(draft["gsm7_segments"], 1)

    def test_alarm_order_is_stable(self):
        self.assertEqual(sms.build_draft(report(list(sms.ALARM_LABELS))),
                         sms.build_draft(report(list(reversed(sms.ALARM_LABELS)))))

    def test_unknown_duplicate_and_non_string_codes_are_rejected(self):
        for codes in (["private-input"], [12], ["GATEWAY_INACTIVE"] * 2, None):
            value = report()
            value["alarm_codes"] = codes
            with self.subTest(codes=codes), self.assertRaises(sms.DraftError):
                sms.build_draft(value)

    def test_untrusted_metadata_never_enters_the_draft(self):
        value = report()
        value["metrics"] = {"unexpected_text": "private-input"}
        value["logging"] = {"unexpected_text": "private-input"}
        self.assertNotIn("private-input", json.dumps(sms.build_draft(value)))

    def test_invalid_phase_unknown_fields_and_inconsistent_gateway_stop(self):
        cases = [
            {**report(), "production_activated": True},
            {**report(), "production_activated": 0},
            {**report(), "kind": "production"},
            {**report(), "coordinates": "private-input"},
            {**report(), "gateway_active": "false"},
            report([], False),
            report(["GATEWAY_INACTIVE"], True),
            {"status": "STOP", "event": "private-input"},
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(sms.DraftError):
                sms.build_draft(value)

    def test_cli_cannot_send_or_change_the_global_sms_provider(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"SMS_PROVIDER": "twilio"}), \
                patch.object(socket, "create_connection") as network, \
                contextlib.redirect_stdout(output):
            result = sms.main(["--prepare-only"], io.BytesIO(json.dumps(report()).encode()))
            self.assertEqual(os.environ["SMS_PROVIDER"], "twilio")
            network.assert_not_called()
        self.assertEqual(result, 0)
        self.assertFalse(json.loads(output.getvalue())["sending_enabled"])

    def test_cli_errors_are_bounded_and_never_echo_input(self):
        cases = [
            (["--send", "private-input"], b""),
            (["--prepare-only"], b'{"private-input"'),
            (["--prepare-only"], b"private-input" * sms.MAX_INPUT_BYTES),
            (["--prepare-only"], json.dumps(report(["private-input"])).encode()),
        ]
        for argv, raw in cases:
            with self.subTest(argv=argv):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = sms.main(argv, io.BytesIO(raw))
                self.assertEqual(result, 1)
                self.assertNotIn("private-input", output.getvalue())
                self.assertEqual(json.loads(output.getvalue())["status"], "STOP")


if __name__ == "__main__":
    unittest.main()
