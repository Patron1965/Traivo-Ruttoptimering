import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import link_common_contract as cgi


def submission(**overrides):
    values = {
        "report": {
            "kind": "preparation_only_no_customer_data",
            "production_activated": False,
            "gateway_active": False,
            "alarm_codes": ["GATEWAY_INACTIVE"],
        },
        "sender": "TestSender",
        "recipient": "+46700000000",
        "platform_id": "test-platform",
        "platform_partner_id": "test-partner",
    }
    values.update(overrides)
    return cgi.build_test_submission(**values)


class CommonContractTests(unittest.TestCase):
    def test_uses_assigned_cgi_path_not_mylink_or_double_sms_prefix(self):
        request = submission()
        self.assertEqual(request["url"], "https://n-eu.linkmobility.io/sms/send")
        self.assertEqual(request["method"], "POST")
        self.assertFalse(request["sending_enabled"])
        self.assertNotIn("Authorization", request)

    def test_documented_single_recipient_body(self):
        body = submission()["body"]
        self.assertEqual(body["sourceTON"], "ALPHANUMERIC")
        self.assertEqual(body["destinationTON"], "MSISDN")
        self.assertEqual(body["dcs"], "GSM")
        self.assertEqual(body["platformId"], "test-platform")
        self.assertEqual(body["platformPartnerId"], "test-partner")
        self.assertLessEqual(len(body["userData"]), 160)
        self.assertIn("PROV", body["userData"])
        self.assertNotIn("recipient", body)
        self.assertNotIn("content", body)

    def test_no_dlr_endpoint_premium_charge_or_scheduled_send(self):
        body = submission()["body"]
        self.assertFalse(body["useDeliveryReport"])
        self.assertFalse(body["ignoreResponse"])
        self.assertEqual(body["tariff"], 0)
        self.assertEqual(body["customParameters"], {"obfuscate": "true"})
        self.assertNotIn("deliveryReportGates", body)

    def test_no_global_provider_or_secret_access_needed(self):
        with patch.dict(os.environ, {"SMS_PROVIDER": "twilio"}, clear=True):
            request = submission()
            self.assertEqual(os.environ["SMS_PROVIDER"], "twilio")
            self.assertFalse(request["sending_enabled"])

    def test_invalid_sender_and_multiple_recipients_fail_with_fixed_errors(self):
        for field, values in (
            ("sender", ["1Sender", "x", "TooLongSenderName", "a\nprivate-input"]),
            ("recipient", ["0700000000", "+46700000000,+46700000001", ["private-input"]]),
        ):
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(cgi.ContractError) as error:
                        submission(**{field: value})
                    self.assertNotIn("private-input", str(error.exception))

    def test_account_ids_are_required_without_guessing_or_coercion(self):
        for field in ("platform_id", "platform_partner_id"):
            for value in ("", " private-input", "private-input\n", None, 0):
                with self.subTest(field=field, value=value):
                    with self.assertRaises(cgi.ContractError) as error:
                        submission(**{field: value})
                    self.assertEqual(str(error.exception), "INVALID_ACCOUNT_ID")


if __name__ == "__main__":
    unittest.main()
