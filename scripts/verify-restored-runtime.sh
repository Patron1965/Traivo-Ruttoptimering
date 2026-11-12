#!/usr/bin/env bash
set -euo pipefail

required=(TARGET_DATABASE_URL RESTORE_EXPECTED_DATABASE_NAME)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name måste anges." >&2
    exit 2
  fi
done

actual_database="$(
  CONNECTION_URL="$TARGET_DATABASE_URL" node -e '
    const { spawnSync } = require("node:child_process");
    const url = new URL(process.env.CONNECTION_URL);
    const result = spawnSync(
      "psql",
      ["-XAtqc", "select current_database()"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PGHOST: url.hostname,
          PGPORT: url.port || "5432",
          PGUSER: decodeURIComponent(url.username),
          PGPASSWORD: decodeURIComponent(url.password),
          PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
          PGSSLMODE: url.searchParams.get("sslmode") || "require",
        },
      },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.status || 1);
    }
    process.stdout.write(result.stdout.trim());
  '
)"

if [[ "$actual_database" != "$RESTORE_EXPECTED_DATABASE_NAME" ]]; then
  echo "Fel testdatabas: förväntade $RESTORE_EXPECTED_DATABASE_NAME men nådde $actual_database." >&2
  exit 3
fi

echo "Verifierad isolerad testdatabas: $actual_database"
DATABASE_URL="$TARGET_DATABASE_URL" pnpm run test:tenant-isolation
DATABASE_URL="$TARGET_DATABASE_URL" \
  pnpm --filter @workspace/api-server exec tsx --test --test-force-exit \
    src/ws-auth.test.ts \
    src/middleware/logout-authorization.test.ts