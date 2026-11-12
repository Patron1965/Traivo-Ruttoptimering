#!/usr/bin/env bash
set -euo pipefail
if [[ "${REPLIT_DEPLOYMENT:-}" == "1" ]]; then
  echo "Development-only OSRM must not run in a published deployment." >&2
  exit 1
fi
dataset=".cache/district-road/west-sweden.osrm"
[[ -f "$dataset.hsgr" ]] || { echo "Prepared CH dataset is missing." >&2; exit 1; }
# Same approved native CH dataset and loopback address. The supervisor attests
# every response and exits on dataset replacement; no coordinate logging.
exec python scripts/district-osrm-gateway.py