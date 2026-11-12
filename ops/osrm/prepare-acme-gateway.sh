#!/usr/bin/env bash
# External Ubuntu host only. Temporary certificate challenge server; no OSRM proxy.
set -euo pipefail
fail() { echo "STOP: $*" >&2; exit 1; }
[[ "${1:-}" == "--prepare-only" && "$#" == 1 ]] || fail "Use --prepare-only."
[[ -z "${REPL_ID:-}" ]] || fail "Do not run this in Replit."
[[ "$(id -u)" == 0 && "$(hostname -s)" == traivo-osrm-pilot ]] || fail "Unexpected host or user."
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail "Expected Ubuntu 24.04."
for command in nginx certbot docker flock curl ss systemd-run; do
  command -v "$command" >/dev/null || fail "Missing command: $command."
done
if systemctl is-active --quiet nginx || systemctl is-enabled --quiet nginx; then
  fail "Default nginx must remain stopped and disabled."
fi
if systemctl is-active --quiet certbot.timer || systemctl is-enabled --quiet certbot.timer; then
  fail "Default renewal timer must remain stopped and disabled during preparation."
fi
ROOT=/srv/traivo-osrm
PILOT="$(readlink -f "$ROOT/current")"
exec 9>"$ROOT/acme-prepare.lock"
flock -n 9 || fail "Another preparation is running."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is not active."
[[ "$(docker inspect traivo-osrm-sweden-candidate --format '{{.State.Running}}')" == true ]] || fail "Sweden candidate is not running."
[[ -z "$(ss -H -ltn '( sport = :80 or sport = :443 )')" ]] || fail "HTTP or HTTPS port is already occupied."
UNIT=traivo-osrm-acme-candidate
[[ "$(systemctl show "$UNIT" -p LoadState --value)" == not-found ]] || fail "Existing challenge unit must be inspected first."
WORK="$ROOT/gateway-prepare"
[[ ! -e "$WORK" ]] || fail "Preparation directory exists; refusing replacement."
install -d -m 755 "$WORK" "$WORK/acme-webroot/.well-known/acme-challenge"
cat >"$WORK/nginx-acme.conf" <<'NGINX'
user www-data;
worker_processes 1;
pid /run/traivo-osrm-acme-candidate.pid;
error_log /dev/null;
events { worker_connections 64; }
http {
  access_log off;
  server_tokens off;
  default_type text/plain;
  client_max_body_size 1k;
  client_body_buffer_size 1k;
  large_client_header_buffers 2 8k;
  client_header_timeout 5s;
  client_body_timeout 5s;
  send_timeout 10s;
  keepalive_timeout 0;
  reset_timedout_connection on;
  server {
    listen 0.0.0.0:80 default_server;
    server_name osrm.traivo.se;
    if ($host != osrm.traivo.se) { return 404; }
    location ^~ /.well-known/acme-challenge/ {
      root /srv/traivo-osrm/gateway-prepare/acme-webroot;
      autoindex off;
      limit_except GET { deny all; }
      try_files $uri =404;
    }
    location / { return 404; }
  }
}
NGINX
chmod 644 "$WORK/nginx-acme.conf"
nginx -t -c "$WORK/nginx-acme.conf"
printf 'TRAIVO_ACME_PROBE\n' >"$WORK/acme-webroot/.well-known/acme-challenge/traivo-probe"
systemd-run --quiet --unit="$UNIT" --property=Type=exec --property=Restart=no \
  --property=RuntimeMaxSec=7200 --property=MemoryMax=128M --property=CPUQuota=25% \
  --property=TasksMax=32 --property=LimitCORE=0 --property=PrivateTmp=true \
  --property=StandardOutput=null --property=StandardError=null \
  /usr/sbin/nginx -c "$WORK/nginx-acme.conf" -g 'daemon off;'
ready=false
for attempt in $(seq 1 10); do
  if [[ "$(curl --max-time 2 -fsS -H 'Host: osrm.traivo.se' 'http://127.0.0.1/.well-known/acme-challenge/traivo-probe' 2>/dev/null)" == TRAIVO_ACME_PROBE ]]; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || fail "Challenge server is not ready; inspect unit state. Do not rerun."
for path in / /table/v1/driving/18.0686,59.3293 /healthz; do
  [[ "$(curl --max-time 2 -sS -o /dev/null -w '%{http_code}' -H 'Host: osrm.traivo.se' "http://127.0.0.1$path")" == 404 ]] || fail "Non-challenge request was not rejected."
done
[[ "$(curl --max-time 2 -sS -o /dev/null -w '%{http_code}' -H 'Host: invalid.example' 'http://127.0.0.1/.well-known/acme-challenge/traivo-probe')" == 404 ]] || fail "Wrong Host was not rejected."
[[ "$(readlink -f "$ROOT/current")" == "$PILOT" ]] || fail "Pilot binding changed."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is no longer active."
[[ "$(docker inspect traivo-osrm-sweden-candidate --format '{{.State.Running}}')" == true ]] || fail "Sweden candidate is no longer running."
echo "HTTP_ACME_CANDIDATE_READY_NO_OSRM_ACCESS"
echo "Temporary unit expires in two hours. Firewall, HTTPS and production settings unchanged."
ss -ltn '( sport = :80 or sport = :443 )'
