#!/usr/bin/env bash
# Run only on the external Ubuntu pilot host, never in the Replit workspace.
set -euo pipefail
test "$(id -u)" = 0
test -z "${REPL_ID:-}"
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 24.04
VERSION="${OSRM_VERSION:-v26.10.0}"
IMAGE_TAG="$VERSION-amd64-debian"
ROOT=/srv/traivo-osrm
test ! -e "$ROOT/current" || { echo "Existing dataset: refusing replacement"; exit 1; }
test "$(df --output=avail -k / | tail -1)" -gt 40000000
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io osmium-tool curl ca-certificates jq python3 time
systemctl enable --now docker
id osrm >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin osrm
install -d -m 755 "$ROOT/downloads" "$ROOT/datasets"

echo "PHASE: secure SSH"
cat >/etc/ssh/sshd_config.d/00-traivo-pilot.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
systemctl reload ssh

echo "PHASE: pinned OSRM image"
docker pull "ghcr.io/project-osrm/osrm-backend:$IMAGE_TAG"
IMAGE="$(docker image inspect "ghcr.io/project-osrm/osrm-backend:$IMAGE_TAG" --format '{{index .RepoDigests 0}}')"
[[ "$IMAGE" =~ ^ghcr.io/project-osrm/osrm-backend@sha256:[a-f0-9]{64}$ ]]
docker run --rm "$IMAGE" osrm-routed --version
docker run --rm "$IMAGE" osrm-routed --help >"$ROOT/routed-help.txt"

echo "PHASE: Sweden source download and checksum"
cd "$ROOT/downloads"
SOURCE=https://download.geofabrik.de/europe/sweden-latest.osm.pbf
curl --fail --location --retry 3 --dump-header source-headers.txt -o sweden-latest.osm.pbf "$SOURCE"
curl --fail --location --retry 3 -o sweden-latest.osm.pbf.md5 "$SOURCE.md5"
EXPECTED="$(awk 'NR==1 {print $1}' sweden-latest.osm.pbf.md5)"
[[ "$EXPECTED" =~ ^[a-f0-9]{32}$ ]]
test "$(md5sum sweden-latest.osm.pbf | cut -d' ' -f1)" = "$EXPECTED"
SHA="$(sha256sum sweden-latest.osm.pbf | cut -d' ' -f1)"
DATASET="$(date -u +%Y%m%d)-${SHA:0:12}"
DATA="$ROOT/datasets/$DATASET"
install -d -m 755 "$DATA/ch" "$DATA/mld"
# Regional pilot with a broad margin, not a customer-drawn district boundary.
# Sweden-only source: this does NOT claim Danish/Norwegian or Nordic coverage.
osmium extract --bbox=11.0,56.0,14.5,59.5 --strategy=complete_ways \
  sweden-latest.osm.pbf --output="$DATA/ch/pilot.osm.pbf"
osmium fileinfo "$DATA/ch/pilot.osm.pbf" >"$DATA/source-info.txt"
chown -R osrm:osrm "$DATA"
UID_OSRM="$(id -u osrm)"
GID_OSRM="$(id -g osrm)"
run_build() {
  /usr/bin/time -v docker run --rm --user "$UID_OSRM:$GID_OSRM" \
    --memory=12g --memory-swap=12g --cpus=3.5 --cap-drop=ALL \
    --security-opt=no-new-privileges -v "$1:/data" "$IMAGE" "${@:2}"
}
echo "PHASE: extraction"
run_build "$DATA/ch" osrm-extract -p /opt/car.lua /data/pilot.osm.pbf --threads 4
cp -a --reflink=auto "$DATA/ch/." "$DATA/mld/"
echo "PHASE: CH preprocessing"
run_build "$DATA/ch" osrm-contract /data/pilot.osrm --threads 4
echo "PHASE: MLD preprocessing"
run_build "$DATA/mld" osrm-partition /data/pilot.osrm --threads 4
run_build "$DATA/mld" osrm-customize /data/pilot.osrm --threads 4

jq -n --arg version "$VERSION" --arg image "$IMAGE" --arg source "$SOURCE" \
  --arg sha "$SHA" --arg dataset "$DATASET" --arg built "$(date -u +%FT%TZ)" \
  '{osrm_version:$version,image_digest:$image,source_url:$source,source_sha256:$sha,
    dataset:$dataset,built_at:$built,profile:"car",bbox:[11.0,56.0,14.5,59.5],
    algorithm:"CH",production_ready:false,
    attribution:"© OpenStreetMap contributors; source Geofabrik, ODbL"}' >"$DATA/manifest.json"
chown osrm:osrm "$DATA/manifest.json"
ln -s "$DATA" "$ROOT/current"
for ALGORITHM in ch mld; do
  PORT=5000
  test "$ALGORITHM" = ch || PORT=5001
  cat >"/etc/systemd/system/traivo-osrm-$ALGORITHM.service" <<EOF
[Unit]
Description=Traivo internal OSRM $ALGORITHM pilot
Requires=docker.service
After=docker.service network-online.target
[Service]
Restart=on-failure
RestartSec=10
TimeoutStartSec=180
TimeoutStopSec=45
ExecStartPre=-/usr/bin/docker rm -f traivo-osrm-$ALGORITHM
ExecStart=/usr/bin/docker run --rm --init --name traivo-osrm-$ALGORITHM --user $UID_OSRM:$GID_OSRM --read-only --cap-drop=ALL --security-opt=no-new-privileges --memory=8g --memory-swap=8g --cpus=3.5 --tmpfs /tmp:rw,noexec,nosuid,size=64m -p 127.0.0.1:$PORT:5000 -v $DATA/$ALGORITHM:/data:ro $IMAGE osrm-routed /data/pilot.osrm --algorithm $ALGORITHM --threads 4 --verbosity WARNING --max-table-size 500 --max-viaroute-size 1000
ExecStop=/usr/bin/docker stop -t 30 traivo-osrm-$ALGORITHM
[Install]
WantedBy=multi-user.target
EOF
done
systemctl daemon-reload
systemctl enable --now traivo-osrm-ch
for _ in $(seq 1 90); do
  if curl -fsS 'http://127.0.0.1:5000/nearest/v1/driving/11.9746,57.7089' | jq -e '.code=="Ok"' >/dev/null; then
    echo "OSRM_INSTALLATION_READY"
    cat "$DATA/manifest.json"
    exit 0
  fi
  sleep 2
done
echo "CH service failed readiness"
exit 1