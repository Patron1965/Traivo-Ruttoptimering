#!/usr/bin/env bash
# Explicit opt-in only: never uses the workspace database or active workflows.
set -euo pipefail
cd "$(dirname "$0")/.."
for executable in initdb pg_ctl pnpm; do
  command -v "$executable" >/dev/null || { echo "Missing prerequisite: $executable" >&2; exit 1; }
done
mkdir -p .cache
root="$(mktemp -d "$PWD/.cache/db-disconnect.XXXXXX")"
cleanup() {
  pg_ctl -D "$root/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$root/socket"
initdb -D "$root/data" -U disconnect_test --auth=trust --no-locale >"$root/init.log"
# No TCP listener: this disposable cluster is reachable only via its private socket.
pg_ctl -D "$root/data" -l "$root/server.log" -o "-k $root/socket -c listen_addresses='' -c max_connections=10" -w start >/dev/null
env -u DATABASE_URL -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE \
  DISCONNECT_TEST_SOCKET="$root/socket/.s.PGSQL.5432" \
  NODE_ENV=test \
  pnpm --filter @workspace/api-server exec tsx --test integration-tests/database-disconnect.test.ts
