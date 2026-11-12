"""Install an operator public key through an explicitly approved rescue reboot.

No password authentication is enabled. The only filesystem writes on the
installed OS are its root authorized_keys and permissions on that key directory.
"""
import argparse
import base64
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, **kwargs)
    if result.returncode:
        raise RuntimeError("Command failed: " + args[0])
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--expected-host-fingerprint")
    parser.add_argument("--confirm-rescue-reboot", action="store_true", required=True)
    args = parser.parse_args()
    owner_key = args.public_key.strip()
    if "\n" in owner_key or len(owner_key.split()) < 2:
        raise ValueError("One OpenSSH public key required")
    if owner_key.split()[0] != "ssh-ed25519":
        raise ValueError("An Ed25519 public key is required")
    base64.b64decode(owner_key.split()[1], validate=True)
    token = os.environ["HETZNER_API_TOKEN"]
    server_id, firewall_id = 168381559, 11721721
    expected_manifest = json.loads(
        Path("docs/osrm-pilot-evidence/manifest.json").read_text()
    )
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
            with urllib.request.urlopen(request, timeout=30) as response:
                return {} if response.status == 204 else json.load(response)
        except urllib.error.HTTPError as error:
            # Never print API response bodies: rescue responses contain passwords.
            raise RuntimeError(f"Hetzner API HTTP {error.code} for {path}") from None

    def wait_action(action):
        for _ in range(120):
            current = api("actions/" + str(action["id"]))["action"]
            if current["status"] == "success":
                return
            if current["status"] == "error":
                raise RuntimeError("Hetzner action failed")
            time.sleep(2)
        raise RuntimeError("Hetzner action deadline exceeded")

    def act(path, body=None):
        result = api(path, "POST", {} if body is None else body)
        if "action" in result:
            wait_action(result["action"])
        for action in result.get("actions", []):
            wait_action(action)

    server = api(f"servers/{server_id}")["server"]
    assert server["name"] == "traivo-osrm-pilot"
    assert server["public_net"]["ipv4"]["ip"] == "95.217.182.169"
    assert server["status"] == "running" and not server["rescue_enabled"]
    assert not server["volumes"], "Unexpected attached volumes"
    assert any(f["id"] == firewall_id and f["status"] == "applied"
               for f in server["public_net"]["firewalls"])
    original_rules = api(f"firewalls/{firewall_id}")["firewall"]["rules"]
    with urllib.request.urlopen("https://api.ipify.org", timeout=20) as response:
        egress = str(ipaddress.IPv4Address(response.read().decode().strip()))
    temporary_rules = original_rules + [{
        "direction": "in", "protocol": "tcp", "port": "22",
        "source_ips": [egress + "/32"],
        "description": "Temporary approved operator-key recovery",
    }]
    work = Path(tempfile.mkdtemp(prefix="traivo-operator-recovery-"))
    os.chmod(work, 0o700)
    (work / "original-firewall.json").write_text(json.dumps(original_rules))
    (work / "operator.pub").write_text(owner_key + "\n")
    run(["ssh-keygen", "-lf", str(work / "operator.pub")])
    identity = work / "identity"
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "",
         "-C", "traivo-operator-recovery-temporary", "-f", str(identity)])
    temporary_key = identity.with_suffix(".pub").read_text().strip()
    key_id = None
    temporary_installed = False
    rescue_enabled = False
    native_known_hosts = work / "native-known-hosts"
    rescue_known_hosts = work / "rescue-known-hosts"

    def ssh(command, native=False):
        return subprocess.run([
            "ssh", "-4", "-i", str(identity), "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5", "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=" + ("yes" if native else "accept-new"),
            "-o", "UserKnownHostsFile=" + str(native_known_hosts if native else rescue_known_hosts),
            "root@95.217.182.169", command,
        ], capture_output=True, text=True, timeout=45)

    def ready(native=False):
        command = ("test -e /srv/traivo-osrm/current/manifest.json && echo NATIVE_READY"
                   if native else
                   "test ! -e /srv/traivo-osrm/current && test -b /dev/sda1 "
                   "&& command -v python3 >/dev/null && echo RESCUE_READY")
        for _ in range(120):
            result = ssh(command, native)
            if result.returncode == 0:
                return
            if not native:
                # Initial TOFU is isolated to rescue; native identity is pinned
                # from the installed OS's public host key before leaving rescue.
                rescue_known_hosts.unlink(missing_ok=True)
            time.sleep(2)
        raise RuntimeError("SSH readiness deadline exceeded")

    def python_remote(code, native=False):
        encoded = base64.b64encode(code.encode()).decode()
        result = ssh("python3 -c \"import base64;exec(base64.b64decode('" + encoded + "'))\"",
                     native)
        if result.returncode:
            raise RuntimeError("Remote recovery/check step failed: " + result.stderr[-1000:])
        return result.stdout

    try:
        key_id = api("ssh_keys", "POST", {
            "name": "traivo-recovery-" + work.name[-8:], "public_key": temporary_key,
        })["ssh_key"]["id"]
        act(f"firewalls/{firewall_id}/actions/set_rules", {"rules": temporary_rules})
        print("PHASE: boot approved rescue environment", flush=True)
        act(f"servers/{server_id}/actions/enable_rescue",
            {"type": "linux64", "ssh_keys": [key_id]})
        rescue_enabled = True
        act(f"servers/{server_id}/actions/reboot")
        ready()
        print("PHASE: verify installed disk and append operator key", flush=True)
        payload = repr({
            "owner": owner_key, "temporary": temporary_key,
            "expected_host_fingerprint": args.expected_host_fingerprint,
            "manifest": {k: expected_manifest[k] for k in
                         ("dataset", "source_sha256", "image_digest", "profile", "bbox")},
        })
        mounted = python_remote("""
import base64,hashlib,json,os,pathlib,subprocess
payload = """ + payload + """
root=pathlib.Path('/mnt/traivo-operator-target')
root.mkdir(exist_ok=True)
subprocess.run(['mount','-o','ro','/dev/sda1',str(root)],check=True)
try:
    release=(root/'etc/os-release').read_text()
    assert 'ID=ubuntu' in release and 'VERSION_ID="24.04"' in release
    # Resolve the installed absolute symlink relative to its own root.
    current=root/'srv/traivo-osrm/current'
    target=os.readlink(current)
    data=root/target.lstrip('/') if target.startswith('/') else current.parent/target
    manifest=json.loads((data/'manifest.json').read_text())
    assert all(manifest[k]==v for k,v in payload['manifest'].items())
    host=(root/'etc/ssh/ssh_host_ed25519_key.pub').read_text().split()
    fingerprint='SHA256:'+base64.b64encode(
        hashlib.sha256(base64.b64decode(host[1],validate=True)).digest()
    ).decode().rstrip('=')
    if payload['expected_host_fingerprint']:
        assert fingerprint==payload['expected_host_fingerprint'], 'Native SSH host identity mismatch'
    subprocess.run(['mount','-o','remount,rw',str(root)],check=True)
    directory=root/'root/.ssh'
    directory.mkdir(exist_ok=True,mode=0o700)
    os.chown(directory,0,0);os.chmod(directory,0o700)
    path=directory/'authorized_keys'
    lines=path.read_text().splitlines() if path.exists() else []
    for key in (payload['owner'],payload['temporary']):
        if not any(line.split()[:2]==key.split()[:2] for line in lines):
            lines.append(key)
    with path.open('w') as f:
        f.write('\\n'.join(lines)+'\\n');f.flush();os.fsync(f.fileno())
    os.chown(path,0,0);os.chmod(path,0o600)
    print(json.dumps({'operator_key_installed':True,'host_key':' '.join(host[:2]),
                      'host_fingerprint':fingerprint,
                      'dataset_unchanged':True}))
finally:
    subprocess.run(['sync'],check=True)
    subprocess.run(['umount',str(root)],check=True)
""")
        mounted = json.loads(mounted)
        temporary_installed = True
        native_known_hosts.write_text("95.217.182.169 " + mounted["host_key"] + "\n")
        print("Native host fingerprint verified: " + mounted["host_fingerprint"], flush=True)
        print("PHASE: return to normal boot and verify OSRM", flush=True)
        act(f"servers/{server_id}/actions/disable_rescue")
        rescue_enabled = False
        act(f"servers/{server_id}/actions/reboot")
        ready(native=True)
        print(python_remote("""
import json,pathlib,subprocess,time,urllib.request
owner=""" + repr(owner_key) + """
path=pathlib.Path('/root/.ssh/authorized_keys')
assert any(line.split()[:2]==owner.split()[:2] for line in path.read_text().splitlines())
subprocess.run(['sshd','-t'],check=True)
settings=subprocess.check_output(['sshd','-T'],text=True)
assert 'passwordauthentication no' in settings
assert 'kbdinteractiveauthentication no' in settings
assert 'permitrootlogin without-password' in settings
for attempt in range(60):
    try:
        with urllib.request.urlopen('http://127.0.0.1:5000/nearest/v1/driving/11.9746,57.7089',timeout=5) as r:
            assert json.load(r)['code']=='Ok'
        break
    except Exception:
        time.sleep(2)
else:raise RuntimeError('OSRM recovery failed')
assert subprocess.check_output(['systemctl','is-active','traivo-osrm-ch'],text=True).strip()=='active'
assert subprocess.check_output(['systemctl','is-enabled','traivo-osrm-ch'],text=True).strip()=='enabled'
print(json.dumps({'operator_key_installed':True,'osrm_healthy_after_reboot':True,
                  'ssh_password_authentication_disabled':True,'native_host_key_pinned':True}))
""", native=True), flush=True)
    finally:
        cleanup_ok = True
        if temporary_installed:
            try:
                python_remote("""
from pathlib import Path
temporary=""" + repr(temporary_key.split()[:2]) + """
p=Path('/root/.ssh/authorized_keys')
rows=p.read_text().splitlines()
p.write_text('\\n'.join(r for r in rows if r.split()[:2]!=temporary)+'\\n')
assert not any(r.split()[:2]==temporary for r in p.read_text().splitlines())
""", native=True)
            except Exception:
                cleanup_ok = False
                print("CLEANUP NEEDS ATTENTION: temporary key retained; recovery files protected in " +
                      str(work), flush=True)
        if rescue_enabled:
            act(f"servers/{server_id}/actions/disable_rescue")
            act(f"servers/{server_id}/actions/reboot")
        act(f"firewalls/{firewall_id}/actions/set_rules", {"rules": original_rules})
        assert api(f"firewalls/{firewall_id}")["firewall"]["rules"] == original_rules
        if key_id is not None:
            api(f"ssh_keys/{key_id}", "DELETE")
        if cleanup_ok:
            shutil.rmtree(work)
        print("Temporary firewall access and provider key removed.", flush=True)
        if not cleanup_ok:
            raise RuntimeError("Temporary installed key cleanup incomplete")


if __name__ == "__main__":
    main()