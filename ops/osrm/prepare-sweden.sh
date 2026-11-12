#!/usr/bin/env bash
# External Ubuntu pilot host only. Stages CH road data; never activates it.
set -euo pipefail
fail() { echo "STOP: $*" >&2; exit 1; }
[[ "${1:-}" == "--prepare-only" && "$#" == 1 ]] || fail "Use --prepare-only."
[[ -z "${REPL_ID:-}" ]] || fail "Do not run this in Replit."
[[ "$(id -u)" == 0 ]] || fail "Run as root on the external pilot host."
[[ "$(hostname -s)" == traivo-osrm-pilot ]] || fail "Unexpected host."
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail "Expected Ubuntu 24.04."
for command in jq docker flock sha256sum; do
  command -v "$command" >/dev/null || fail "Missing command: $command."
done
ROOT=/srv/traivo-osrm
SOURCE="$ROOT/downloads/sweden-latest.osm.pbf"
PILOT="$(readlink -f "$ROOT/current")"
[[ -d "$PILOT" && -s "$SOURCE" ]] || fail "Missing pilot or Sweden source."
exec 9>"$ROOT/prepare-sweden.lock"
flock -n 9 || fail "Another Sweden preparation is running."
IMAGE="$(jq -er '.image_digest' "$PILOT/manifest.json")"
SHA="$(jq -er '.source_sha256' "$PILOT/manifest.json")"
[[ "$IMAGE" =~ ^ghcr.io/project-osrm/osrm-backend@sha256:[a-f0-9]{64}$ ]] || fail "Invalid image digest."
[[ "$SHA" =~ ^[a-f0-9]{64}$ ]] || fail "Invalid source checksum."
[[ "$(sha256sum "$SOURCE" | cut -d' ' -f1)" == "$SHA" ]] || fail "Source checksum differs."
[[ "$(docker inspect traivo-osrm-ch --format '{{.Config.Image}}')" == "$IMAGE" ]] || fail "Pilot image differs."
docker image inspect "$IMAGE" >/dev/null
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is not active."
NAME=traivo-osrm-sweden-preprocess
[[ -z "$(docker ps -a --filter "name=^/$NAME$" --format '{{.Names}}')" ]] || fail "An earlier preprocessing container exists; inspect before retrying."
[[ "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 13631488 ]] || fail "Need at least 13 GiB available memory."
disk_kib() { df --output=avail -k "$ROOT" | tail -1 | tr -d ' '; }
[[ "$(disk_kib)" -ge 83886080 ]] || fail "Need at least 80 GiB available disk."
UID_OSRM="$(id -u osrm)"
GID_OSRM="$(id -g osrm)"
DATASET="sweden-${SHA:0:12}-${IMAGE##*:}"
DATA="$ROOT/datasets/$DATASET"
[[ ! -e "$DATA" ]] || fail "Candidate exists; refusing replacement. Inspect before retrying."
mkdir -m 755 "$DATA"
cp --reflink=auto "$SOURCE" "$DATA/sweden.osm.pbf"
[[ "$(sha256sum "$DATA/sweden.osm.pbf" | cut -d' ' -f1)" == "$SHA" ]] || fail "Copied source checksum differs."
chown -R "$UID_OSRM:$GID_OSRM" "$DATA"
BUILD_PID=
WATCH_PID=
cleanup() {
  [[ -z "$WATCH_PID" ]] || { kill "$WATCH_PID" 2>/dev/null || :; wait "$WATCH_PID" 2>/dev/null || :; }
  if [[ -n "$BUILD_PID" ]]; then
    docker stop -t 15 "$NAME" >/dev/null 2>&1 || :
    wait "$BUILD_PID" 2>/dev/null || :
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
build() {
  echo "PHASE: $1"
  shift
  docker run --rm --pull=never --name "$NAME" --network none \
    --user "$UID_OSRM:$GID_OSRM" --read-only --cap-drop=ALL \
    --security-opt=no-new-privileges --pids-limit=256 \
    --memory=12g --memory-swap=12g --cpus=2 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    -v "$DATA:/data" "$IMAGE" "$@" &
  BUILD_PID=$!
  (
    trap - EXIT INT TERM
    while kill -0 "$BUILD_PID" 2>/dev/null; do
      if [[ "$(disk_kib)" -lt 20971520 ]]; then
        echo "STOP: Free disk below 20 GiB." >&2
        touch "$DATA/capacity-aborted"
        docker stop -t 15 "$NAME" >/dev/null
        exit 1
      fi
      sleep 5
    done
  ) &
  WATCH_PID=$!
  local status=0
  wait "$BUILD_PID" || status=$?
  kill "$WATCH_PID" 2>/dev/null || :
  wait "$WATCH_PID" 2>/dev/null || :
  BUILD_PID=
  WATCH_PID=
  [[ "$status" == 0 && ! -e "$DATA/capacity-aborted" ]] || fail "Build failed; candidate kept for inspection. Pilot unchanged."
  [[ "$(disk_kib)" -ge 20971520 ]] || fail "Insufficient disk after build."
}
build extraction osrm-extract -p /opt/car.lua /data/sweden.osm.pbf --threads 2
build contraction osrm-contract /data/sweden.osrm --threads 2
[[ "$(readlink -f "$ROOT/current")" == "$PILOT" ]] || fail "Pilot binding changed during preparation."
systemctl is-active --quiet traivo-osrm-ch || fail "Pilot is no longer active."
jq --arg dataset "$DATASET" --arg built "$(date -u +%FT%TZ)" \
  '. + {dataset:$dataset,built_at:$built,coverage:"sweden_source_no_regional_clip",
        bbox:null,algorithm:"CH",preparation_only:true,production_ready:false}' \
  "$PILOT/manifest.json" >"$DATA/manifest.json"
chown "$UID_OSRM:$GID_OSRM" "$DATA/manifest.json"
echo "SWEDEN_PREPARED_NOT_ACTIVATED"
du -sh "$DATA"
echo "Candidate: $DATA"
