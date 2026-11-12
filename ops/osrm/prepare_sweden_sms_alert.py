"""Offline-only OSRM SMS draft. No credentials, network, scheduler or sending."""
import json
import string
import sys

MAX_INPUT_BYTES = 65536
ALARM_LABELS = {
    "GATEWAY_INACTIVE": "HTTPS avstangd (tidsgrans?)",
    "CERTIFICATE_EXPIRING": "certifikat snart utganget",
    "HOST_MEMORY_LOW": "lite RAM",
    "OSRM_MEMORY_HIGH": "hog OSRM-last",
    "DISK_SPACE_LOW": "lite disk",
}
REPORT_KEYS = {
    "kind", "production_activated", "gateway_active", "tls", "metrics",
    "alarm_codes", "logging",
}


class DraftError(Exception):
    """Fixed codes only; never include input, credentials or exception prose."""


def build_draft(report):
    if (not isinstance(report, dict) or set(report) - REPORT_KEYS or
            report.get("kind") != "preparation_only_no_customer_data" or
            report.get("production_activated") is not False or
            type(report.get("gateway_active")) is not bool):
        raise DraftError("INVALID_PREPARATION_REPORT")
    codes = report.get("alarm_codes")
    if (not isinstance(codes, list) or len(codes) > len(ALARM_LABELS) or
            any(not isinstance(code, str) or code not in ALARM_LABELS for code in codes)):
        raise DraftError("INVALID_ALARM_CODES")
    if len(set(codes)) != len(codes):
        raise DraftError("DUPLICATE_ALARM_CODES")
    if ("GATEWAY_INACTIVE" in codes) == report["gateway_active"]:
        raise DraftError("GATEWAY_STATE_INCONSISTENT")
    # Stable labels only. Never interpolate metrics, logs, URLs or error messages.
    ordered = [code for code in ALARM_LABELS if code in codes]
    summary = "; ".join(ALARM_LABELS[code] for code in ordered)
    if not summary:
        summary = "inga larm i angivet provunderlag"
    message = "Traivo OSRM PROV: " + summary + ". Ingen aktivering."
    # This restricted alphabet is entirely GSM-7 single-septet characters.
    allowed = set(string.ascii_letters + string.digits + " .:;()-?")
    if len(message) > 160 or any(character not in allowed for character in message):
        raise DraftError("SMS_SEGMENT_LIMIT")
    return {
        "kind": "osrm_sms_draft_only",
        "provider": "linkmobility",
        "provider_protocol": "link_common_cgi",
        "message": message,
        "alarm_codes": ordered,
        "gsm7_segments": 1,
        "sending_enabled": False,
        "production_activated": False,
        "delivery_verified": False,
        "source_freshness_verified": False,
        "pending_requirements": [
            "contracted_api_access", "approved_sender", "recipient",
            "approved_sms_cost", "explicit_send_approval",
        ],
    }


def main(argv=None, stream=None):
    try:
        if (sys.argv[1:] if argv is None else argv) != ["--prepare-only"]:
            raise DraftError("PREPARATION_ONLY_REQUIRED")
        raw = (sys.stdin.buffer if stream is None else stream).read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise DraftError("INPUT_LIMIT")
        draft = build_draft(json.loads(raw))
        print(json.dumps(draft, sort_keys=True))
        return 0
    except DraftError as error:
        event = str(error)
    except Exception:
        event = "INVALID_INPUT"
    print(json.dumps({"status": "STOP", "event": event, "sending_enabled": False}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
