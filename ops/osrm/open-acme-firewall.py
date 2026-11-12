"""Add one approved IPv4 challenge or authenticated HTTPS rule, preserving access."""
import argparse
import ipaddress
import json
import os
import socket
import time
import urllib.error
import urllib.request


def approved_rules(original, authenticated_https=False):
    if len(original) != (2 if authenticated_https else 1):
        raise RuntimeError("Unexpected rules; inspect before modifying the firewall.")
    ssh = original[0]
    if (ssh.get("direction"), ssh.get("protocol"), ssh.get("port")) != ("in", "tcp", "22"):
        raise RuntimeError("Expected the existing restricted SSH rule.")
    sources = ssh.get("source_ips", [])
    if len(sources) != 1:
        raise RuntimeError("Expected one previously approved operator network.")
    network = ipaddress.ip_network(sources[0])
    if network.version != 4 or network.prefixlen != 32 or not network.network_address.is_global:
        raise RuntimeError("Operator access is not a restricted public IPv4 host.")
    if authenticated_https:
        challenge = original[1]
        expected_challenge = {
            "direction": "in", "protocol": "tcp", "port": "80",
            "source_ips": ["0.0.0.0/0"],
            "description": "Approved ACME-only HTTP preparation",
        }
        if any(challenge.get(key) != value for key, value in expected_challenge.items()):
            raise RuntimeError("Existing certificate challenge rule differs.")
    return original + [{
        "direction": "in",
        "protocol": "tcp",
        "port": "443" if authenticated_https else "80",
        "source_ips": ["0.0.0.0/0"],
        "description": ("Approved token-protected HTTPS acceptance"
                        if authenticated_https else "Approved ACME-only HTTP preparation"),
    }]


def main():
    parser = argparse.ArgumentParser()
    confirmation = parser.add_mutually_exclusive_group(required=True)
    confirmation.add_argument("--confirm-approved-acme-only", action="store_true")
    confirmation.add_argument("--confirm-approved-authenticated-https", action="store_true")
    args = parser.parse_args()
    token = os.environ["HETZNER_API_TOKEN"]
    original_dns = socket.getaddrinfo
    socket.getaddrinfo = lambda host, port, family=0, type=0, proto=0, flags=0: (
        original_dns(host, port, socket.AF_INET, type, proto, flags)
    )

    def api(path, method="GET", body=None):
        request = urllib.request.Request(
            "https://api.hetzner.cloud/v1/" + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Hetzner API HTTP {error.code}; response body suppressed.") from None

    server = api("servers/168381559")["server"]
    if (server["name"] != "traivo-osrm-pilot" or server["status"] != "running"
            or server["rescue_enabled"] or server["public_net"]["ipv4"]["ip"] != "95.217.182.169"
            or server["server_type"]["name"] != "ccx23"
            or server["location"]["name"] != "hel1"
            or server["public_net"]["firewalls"] != [{"id": 11721721, "status": "applied"}]):
        raise RuntimeError("Unexpected server identity, location, type or firewall binding.")
    firewall = api("firewalls/11721721")["firewall"]
    if (firewall["name"] != "traivo-osrm-pilot-locked"
            or firewall["applied_to"] != [{"type": "server", "server": {"id": 168381559}}]):
        raise RuntimeError("Firewall is not exclusive to the approved host.")
    original = firewall["rules"]
    expected = approved_rules(original, args.confirm_approved_authenticated_https)
    if api("firewalls/11721721")["firewall"]["rules"] != original:
        raise RuntimeError("Firewall changed during preparation; refusing replacement.")
    result = api("firewalls/11721721/actions/set_rules", "POST", {"rules": expected})
    actions = list(result.get("actions", []))
    if "action" in result:
        actions.append(result["action"])
    if not actions:
        raise RuntimeError("Missing action confirmation; inspect actual rules before retrying.")
    deadline = time.monotonic() + 90
    for action in actions:
        while time.monotonic() < deadline:
            state = api("actions/" + str(action["id"]))["action"]["status"]
            if state == "success":
                break
            if state == "error":
                raise RuntimeError("Firewall action failed; inspect actual rules before retrying.")
            time.sleep(2)
        else:
            raise RuntimeError("Firewall action deadline exceeded; inspect before retrying.")
    actual = api("firewalls/11721721")["firewall"]["rules"]
    if len(actual) != len(expected) or actual[:-1] != original:
        raise RuntimeError("Post-change verification failed; inspect without automatic rollback.")
    added = actual[-1]
    if any(added.get(key) != value for key, value in expected[-1].items()):
        raise RuntimeError("Added rule verification failed.")
    if args.confirm_approved_authenticated_https:
        print("AUTHENTICATED_HTTPS_FIREWALL_VERIFIED_EXISTING_ACCESS_UNCHANGED")
        print("Only IPv4 TCP 443 added. OSRM ports remain blocked.")
    else:
        print("ACME_HTTP_ONLY_FIREWALL_VERIFIED_SSH_UNCHANGED")
        print("Only IPv4 TCP 80 added. TCP 443 and OSRM ports remain blocked.")


if __name__ == "__main__":
    main()