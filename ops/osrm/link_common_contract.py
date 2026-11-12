"""Pure Common/CGI test-request construction. No credentials, network or sending.

Reference: LINK Mobility SMS REST API MT and Delivery Reports, version 2.8.
Never log a runtime request body: it includes the recipient and account IDs.
"""
import re

from prepare_sweden_sms_alert import build_draft

CGI_BASE_URL = "https://n-eu.linkmobility.io/sms"
CGI_SEND_URL = CGI_BASE_URL + "/send"


class ContractError(Exception):
    """Fixed event codes, never account values or recipient details."""


def account_id(value):
    if (not isinstance(value, str) or not value or len(value) > 128 or
            value != value.strip() or any(ord(character) < 32 for character in value)):
        raise ContractError("INVALID_ACCOUNT_ID")
    return value


def build_test_submission(report, sender, recipient, platform_id, platform_partner_id):
    draft = build_draft(report)
    if not isinstance(sender, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{1,10}", sender):
        raise ContractError("INVALID_SENDER")
    if not isinstance(recipient, str) or not re.fullmatch(r"\+[1-9][0-9]{7,14}", recipient):
        raise ContractError("INVALID_RECIPIENT")
    return {
        "url": CGI_SEND_URL,
        "method": "POST",
        "sending_enabled": False,
        # Transport must add authentication securely after separate approval.
        # No credentials are accepted by this offline builder.
        "body": {
            "source": sender,
            "sourceTON": "ALPHANUMERIC",
            "destination": recipient,
            "destinationTON": "MSISDN",
            "dcs": "GSM",
            "userData": draft["message"],
            "platformId": account_id(platform_id),
            "platformPartnerId": account_id(platform_partner_id),
            "useDeliveryReport": False,
            "ignoreResponse": False,
            # Prevent premium charging of the handset owner.
            # This does NOT mean sending is free under the supplier agreement.
            "tariff": 0,
            "customParameters": {"obfuscate": "true"},
        },
    }
