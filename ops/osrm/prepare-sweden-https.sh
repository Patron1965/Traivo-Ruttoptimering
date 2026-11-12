#!/usr/bin/env bash
# External Ubuntu only: protected, temporary acceptance gateway, not production.
set +x
set -euo pipefail
umask 077
fail() { echo "STOP: $*" >&2; exit 1; }
[[ "${1:-}" == "--acceptance-only" && "$#" == 1 ]] || fail "Use --acceptance-only."
[[ -z "${REPL_ID:-}" ]] || fail "Do not run this in Replit."
[[ "$(id -u)" == 0 && "$(hostname -s)" == traivo-osrm-pilot ]] || fail "Unexpected host or user."
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail "Expected Ubuntu 24.04."
for command in nginx openssl python3 docker jq flock ss systemd-run; do
  command -v "$command" >/dev/null || fail "Missing command: $command."
done
if systemctl is-active --quiet nginx || systemctl is-enabled --quiet nginx; then
  fail "Default nginx must remain stopped and not enabled."
fi
if systemctl is-active --quiet certbot.timer || systemctl is-enabled --quiet certbot.timer; then
  fail "Renewal timer unexpectedly active/enabled; inspect before proceeding."
fi
echo "CERTBOT_TIMER_INACTIVE_NOT_ENABLED_CONFIRMED"
ROOT=/srv/traivo-osrm
PILOT="$(readlink -f "$ROOT/current")"
exec 9>"$ROOT/https-prepare.lock"
flock -n 9 || fail "Another HTTPS preparation is running."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is not active."
IMAGE="$(jq -er '.image_digest' "$PILOT/manifest.json")"
SHA="$(jq -er '.source_sha256' "$PILOT/manifest.json")"
[[ "$IMAGE" =~ ^ghcr.io/project-osrm/osrm-backend@sha256:[a-f0-9]{64}$ &&
   "$SHA" =~ ^[a-f0-9]{64}$ ]] || fail "Invalid pinned identity."
DATASET="sweden-${SHA:0:12}-${IMAGE##*:}"
DATA="$ROOT/datasets/$DATASET"
[[ "$(readlink -f "$DATA")" == "$DATA" ]] || fail "Unexpected dataset path."
jq -e --arg dataset "$DATASET" --arg image "$IMAGE" --arg sha "$SHA" \
  '.dataset==$dataset and .image_digest==$image and .source_sha256==$sha and
   .coverage=="sweden_source_no_regional_clip" and .algorithm=="CH" and
   .preparation_only==true and .production_ready==false' "$DATA/manifest.json" >/dev/null || fail "Manifest differs."
docker inspect traivo-osrm-sweden-candidate | jq -e --arg data "$DATA" --arg image "$IMAGE" \
  --arg user "$(id -u osrm):$(id -g osrm)" \
  'length==1 and (.[0] |
   .State.Running==true and .Config.Image==$image and .Config.User==$user and
   .Config.Cmd==["osrm-routed","/data/sweden.osrm","--algorithm","CH","--threads","2",
                 "--verbosity","WARNING","--max-table-size","500","--max-viaroute-size","1000"] and
   .HostConfig.ReadonlyRootfs==true and .HostConfig.LogConfig.Type=="none" and
   (.HostConfig.CapDrop | index("ALL"))!=null and
   any(.HostConfig.SecurityOpt[]?; .=="no-new-privileges" or .=="no-new-privileges:true") and
   .HostConfig.PidsLimit==256 and
   .HostConfig.RestartPolicy.Name=="no" and .HostConfig.Memory==6442450944 and
   .HostConfig.MemorySwap==6442450944 and .HostConfig.NanoCpus==2000000000 and
   .NetworkSettings.Ports["5000/tcp"]==[{"HostIp":"127.0.0.1","HostPort":"5002"}] and
   ([.Mounts[] | select(.Destination=="/data")] |
    length==1 and .[0].Source==$data and .[0].RW==false))' >/dev/null || fail "Candidate protection/binding differs."
CERT=/etc/letsencrypt/live/osrm.traivo.se
[[ -s "$CERT/fullchain.pem" && -s "$CERT/privkey.pem" ]] || fail "Certificate files missing."
[[ "$(stat -L -c '%u:%a' "$CERT/privkey.pem")" == 0:600 ]] || fail "Private-key permissions differ."
openssl x509 -checkend 604800 -noout -in "$CERT/cert.pem" >/dev/null || fail "Certificate expires within seven days."
[[ -z "$(ss -H -ltn 'sport = :443')" ]] || fail "HTTPS port is occupied."
UNIT=traivo-osrm-https-candidate
[[ "$(systemctl show "$UNIT" -p LoadState --value)" == not-found ]] || fail "Existing HTTPS unit must be inspected."
WORK="$ROOT/gateway-prepare/https-candidate"
[[ -d "$ROOT/gateway-prepare" && ! -e "$WORK" ]] || fail "Unexpected or existing preparation directory."
install -d -m 700 "$WORK"
python3 - "$WORK" "$DATASET" <<'PY'
import os
import secrets
import sys
from pathlib import Path

os.umask(0o077)
work, dataset = Path(sys.argv[1]), sys.argv[2]
token = secrets.token_hex(32)
with (work / "auth-token").open("x") as file:
    file.write(token + "\n")
with (work / "auth-map.conf").open("x") as file:
    file.write('map $http_authorization $traivo_authorized {\n'
               '  default 0;\n  "Bearer ' + token + '" 1;\n}\n')
configuration = r"""user www-data;
worker_processes 1;
pid /run/traivo-osrm-https-candidate.pid;
error_log /dev/null;
events { worker_connections 128; }
http {
  access_log off;
  server_tokens off;
  default_type application/json;
  map_hash_bucket_size 128;
  include __WORK__/auth-map.conf;
  limit_conn_zone $server_name zone=traivo_osrm_connections:64k;
  client_max_body_size 1k;
  client_body_buffer_size 1k;
  large_client_header_buffers 2 32k;
  client_header_timeout 5s;
  client_body_timeout 5s;
  send_timeout 120s;
  keepalive_timeout 0;
  reset_timedout_connection on;
  server {
    listen 0.0.0.0:443 ssl default_server;
    server_name osrm.traivo.se;
    ssl_certificate /etc/letsencrypt/live/osrm.traivo.se/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/osrm.traivo.se/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305;
    ssl_session_tickets off;
    ssl_session_cache shared:TRAIVO_OSRM_TLS:1m;
    ssl_session_timeout 10m;
    add_header X-Traivo-OSRM-Dataset "__DATASET__" always;
    if ($host != osrm.traivo.se) { return 404; }
    location ~ ^/datasets/__DATASET__/(nearest|table|route)/v1/driving/ {
      if ($traivo_authorized = 0) { return 401; }
      if ($request_method != GET) { return 405; }
      limit_conn traivo_osrm_connections 8;
      limit_conn_status 429;
      rewrite ^/datasets/__DATASET__/(.*)$ /$1 break;
      proxy_pass http://127.0.0.1:5002;
      proxy_http_version 1.1;
      proxy_pass_request_headers off;
      proxy_pass_request_body off;
      proxy_set_header Host 127.0.0.1;
      proxy_set_header Connection "";
      proxy_set_header Content-Length "";
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_max_temp_file_size 0;
      proxy_next_upstream off;
      proxy_connect_timeout 3s;
      proxy_send_timeout 10s;
      proxy_read_timeout 120s;
    }
    location / { return 404; }
  }
}
"""
with (work / "nginx-https.conf").open("x") as file:
    file.write(configuration.replace("__WORK__", str(work)).replace("__DATASET__", dataset))
PY
nginx -t -c "$WORK/nginx-https.conf"
systemd-run --quiet --unit="$UNIT" --property=Type=exec --property=Restart=no \
  --property=RuntimeMaxSec=7200 --property=MemoryMax=256M --property=CPUQuota=50% \
  --property=TasksMax=32 --property=LimitCORE=0 --property=PrivateTmp=true \
  --property=StandardOutput=null --property=StandardError=null \
  /usr/sbin/nginx -c "$WORK/nginx-https.conf" -g 'daemon off;'
python3 - "$WORK" "$DATASET" <<'PY'
import http.client
import json
import re
import socket
import ssl
import sys
import time
from pathlib import Path

stage = "credential permissions"
try:
    work, dataset = Path(sys.argv[1]), sys.argv[2]
    token_path = work / "auth-token"
    if token_path.stat().st_uid != 0 or token_path.stat().st_mode & 0o077:
        raise ValueError("Unexpected permissions")
    token = token_path.read_text().strip()
    if not re.fullmatch("[0-9a-f]{64}", token):
        raise ValueError("Unexpected token format")
    original_dns = socket.getaddrinfo
    def local_dns(host, port, family=0, type=0, proto=0, flags=0):
        return original_dns("127.0.0.1" if host == "osrm.traivo.se" else host,
                            port, family, type, proto, flags)
    socket.getaddrinfo = local_dns
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    def probe(path, credential=None, method="GET", host="osrm.traivo.se"):
        connection = http.client.HTTPSConnection("osrm.traivo.se", context=context, timeout=10)
        try:
            connection.connect()
            protocol = connection.sock.version()
            headers = {"Host": host}
            if credential is not None:
                headers["Authorization"] = "Bearer " + credential
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
            body = response.read(65537)
            if len(body) > 65536 or response.getheader("Location") is not None:
                raise ValueError("Unexpected response size or redirect")
            return response.status, response.getheader("X-Traivo-OSRM-Dataset"), body, protocol
        finally:
            connection.close()
    path = "/datasets/" + dataset + "/nearest/v1/driving/18.0686,59.3293?number=1&radiuses=200"
    stage = "verified TLS startup and missing-token rejection"
    for attempt in range(10):
        try:
            result = probe(path)
            break
        except OSError:
            if attempt == 9:
                raise
            time.sleep(1)
    assert result[0] == 401 and result[1] == dataset
    stage = "wrong-token rejection"
    wrong_token = ("0" if token[0] != "0" else "1") + token[1:]
    assert probe(path, wrong_token)[0] == 401
    stage = "authenticated version-bound Stockholm nearest"
    status, identity, body, protocol = probe(path, token)
    assert status == 200 and identity == dataset and protocol in ("TLSv1.2", "TLSv1.3")
    point = json.loads(body)
    assert point["code"] == "Ok" and len(point["waypoints"]) == 1
    assert 0 <= point["waypoints"][0]["distance"] <= 200
    stage = "unversioned path rejection"
    assert probe("/nearest/v1/driving/18.0686,59.3293", token)[0] == 404
    stage = "wrong Host rejection"
    assert probe(path, token, host="invalid.example")[0] == 404
    stage = "write-method rejection"
    assert probe(path, token, method="POST")[0] == 405
    print("INTERNAL_TLS_AUTH_DATASET_BINDING_VERIFIED")
    print("TLS protocol: " + protocol)
except Exception as error:
    # Never emit exception prose, response bodies, headers, tokens or request URLs.
    raise SystemExit("STOP: " + stage + " failed (" + type(error).__name__ +
                     "). Inspect without rerunning or dumping configuration.")
PY
[[ "$(readlink -f "$ROOT/current")" == "$PILOT" ]] || fail "Pilot binding changed."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is no longer active."
[[ "$(docker inspect traivo-osrm-sweden-candidate --format '{{.State.Running}}')" == true ]] || fail "Sweden candidate is no longer running."
echo "SWEDEN_HTTPS_CANDIDATE_READY_NOT_ACTIVATED"
echo "Base URL: https://osrm.traivo.se/datasets/$DATASET"
echo "Credential remains in a root-only file. Do not paste it into chat or dump nginx configuration."
echo "Temporary HTTPS unit expires in two hours. Firewall and Traivo configuration unchanged."
ss -ltn '( sport = :80 or sport = :443 or sport = :5000 or sport = :5002 )'
