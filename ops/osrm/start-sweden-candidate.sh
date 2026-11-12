#!/usr/bin/env bash
# External Ubuntu host only: temporary internal acceptance service, not production.
set -euo pipefail
fail() { echo "STOP: $*" >&2; exit 1; }
[[ "${1:-}" == "--acceptance-only" && "$#" == 1 ]] || fail "Use --acceptance-only."
[[ -z "${REPL_ID:-}" ]] || fail "Do not run this in Replit."
[[ "$(id -u)" == 0 && "$(hostname -s)" == traivo-osrm-pilot ]] || fail "Unexpected host or user."
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail "Expected Ubuntu 24.04."
for command in jq docker flock curl ss; do
  command -v "$command" >/dev/null || fail "Missing command: $command."
done
ROOT=/srv/traivo-osrm
PILOT="$(readlink -f "$ROOT/current")"
exec 9>"$ROOT/sweden-candidate.lock"
flock -n 9 || fail "Another candidate start is running."
[[ "$(systemctl show traivo-osrm-sweden-build -p SubState --value)" == exited &&
   "$(systemctl show traivo-osrm-sweden-build -p Result --value)" == success &&
   "$(systemctl show traivo-osrm-sweden-build -p ExecMainStatus --value)" == 0 ]] || fail "Build is not successfully finished."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is not active."
IMAGE="$(jq -er '.image_digest' "$PILOT/manifest.json")"
SHA="$(jq -er '.source_sha256' "$PILOT/manifest.json")"
[[ "$IMAGE" =~ ^ghcr.io/project-osrm/osrm-backend@sha256:[a-f0-9]{64}$ &&
   "$SHA" =~ ^[a-f0-9]{64}$ ]] || fail "Invalid pinned identity."
DATASET="sweden-${SHA:0:12}-${IMAGE##*:}"
DATA="$ROOT/datasets/$DATASET"
[[ "$(readlink -f "$DATA")" == "$DATA" && -s "$DATA/sweden.osrm.hsgr" ]] || fail "Missing CH candidate."
jq -e --arg dataset "$DATASET" --arg image "$IMAGE" --arg sha "$SHA" \
  '.dataset==$dataset and .image_digest==$image and .source_sha256==$sha and
   .coverage=="sweden_source_no_regional_clip" and .algorithm=="CH" and
   .preparation_only==true and .production_ready==false' "$DATA/manifest.json" >/dev/null || fail "Candidate manifest differs."
[[ "$(docker inspect traivo-osrm-ch --format '{{.Config.Image}}')" == "$IMAGE" ]] || fail "Pilot image differs."
docker image inspect "$IMAGE" >/dev/null
[[ "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 7340032 ]] || fail "Need 7 GiB available memory."
[[ -z "$(ss -H -ltn 'sport = :5002')" ]] || fail "Candidate port is occupied."
NAME=traivo-osrm-sweden-candidate
[[ -z "$(docker ps -a --filter "name=^/$NAME$" --format '{{.Names}}')" ]] || fail "Candidate container exists; inspect before retrying."
docker run --detach --pull=never --restart=no --log-driver=none --init --name "$NAME" \
  --user "$(id -u osrm):$(id -g osrm)" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=256 --memory=6g --memory-swap=6g --cpus=2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m -p 127.0.0.1:5002:5000 -v "$DATA:/data:ro" \
  "$IMAGE" osrm-routed /data/sweden.osrm --algorithm CH --threads 2 --verbosity WARNING \
  --max-table-size 500 --max-viaroute-size 1000 >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if curl --max-time 2 -fsS 'http://127.0.0.1:5002/nearest/v1/driving/18.0686,59.3293?number=1&radiuses=200' 2>/dev/null |
      jq -e '.code=="Ok" and (.waypoints|length)==1 and (.waypoints[0].distance|type)=="number" and .waypoints[0].distance<=200' >/dev/null; then
    ready=true
    break
  fi
  [[ "$(docker inspect "$NAME" --format '{{.State.Running}}')" == true ]] || break
  sleep 2
done
[[ "$ready" == true ]] || fail "Candidate not ready; inspect its exit/OOM state. No automatic restart or replacement."
[[ "$(readlink -f "$ROOT/current")" == "$PILOT" ]] || fail "Pilot binding changed."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is no longer active."
echo "SWEDEN_INTERNAL_CANDIDATE_READY_NOT_ACTIVATED"
docker stats --no-stream --format '{{.Name}} memory={{.MemUsage}} cpu={{.CPUPerc}}' "$NAME" traivo-osrm-ch
df -h "$ROOT"
free -h
