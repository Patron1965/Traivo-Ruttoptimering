#!/usr/bin/env bash
set -euo pipefail
if [[ "${REPLIT_DEPLOYMENT:-}" == "1" ]]; then
  echo "Development-only road-data preparation is not permitted in a deployment." >&2
  exit 1
fi
directory=".cache/district-road"
mkdir -p "$directory"
# Refuse concurrent rebuilds and never replace files served by a running OSRM.
exec 9>"$directory/prepare.lock"
flock -n 9 || { echo "Road preparation is already running." >&2; exit 1; }
if curl --silent --max-time 2 http://127.0.0.1:5001/nearest/v1/driving/11.82,58.07 >/dev/null; then
  echo "Stop district-private-osrm before rebuilding its dataset." >&2
  exit 1
fi
if [[ ! -s "$directory/sweden.osm.pbf" ]]; then
  curl -fL --retry 2 --max-time 300 \
    https://download.geofabrik.de/europe/sweden-latest.osm.pbf \
    -o "$directory/sweden.osm.pbf.download"
  mv "$directory/sweden.osm.pbf.download" "$directory/sweden.osm.pbf"
fi
# Broad west-Sweden extract provides a connected road network around the approved
# Stenungsund sample. This does not claim nationwide road coverage.
osmium extract -b 11.0,57.3,12.8,58.7 -s complete_ways \
  "$directory/sweden.osm.pbf" -o "$directory/west-sweden.osm.pbf" --overwrite
profile="$(dirname "$(dirname "$(command -v osrm-routed)")")/share/osrm/profiles/car.lua"
osrm-extract -p "$profile" "$directory/west-sweden.osm.pbf" --threads 4
osrm-contract "$directory/west-sweden.osrm" --threads 4
sha256sum "$directory/sweden.osm.pbf" "$directory/west-sweden.osm.pbf" \
  > "$directory/dataset-sha256.txt"