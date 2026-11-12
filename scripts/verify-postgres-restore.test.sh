#!/usr/bin/env bash
set -euo pipefail

for name in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name krävs för restore-säkerhetstestet." >&2
    exit 2
  fi
done

target_db="restore_safety_${RANDOM}_$$"
work_dir="$(mktemp -d)"
passphrase_file="$work_dir/passphrase"
trap 'dropdb --if-exists --force "$target_db" >/dev/null 2>&1 || true; rm -rf "$work_dir"' EXIT
printf '%s' "test-only-passphrase" >"$passphrase_file"
chmod 600 "$passphrase_file"

database_url() {
  DATABASE_NAME="$1" node -e '
    const env = process.env;
    const url = new URL("postgresql://placeholder");
    url.username = env.PGUSER;
    url.password = env.PGPASSWORD;
    url.hostname = env.PGHOST;
    url.port = env.PGPORT;
    url.pathname = `/${env.DATABASE_NAME}`;
    process.stdout.write(url.href);
  '
}

source_url="$(database_url "$PGDATABASE")"
createdb "$target_db"
target_url="$(database_url "$target_db")"

existing_evidence="$work_dir/existing-evidence"
mkdir "$existing_evidence"
if SOURCE_DATABASE_URL="$source_url" \
  TARGET_DATABASE_URL="$target_url" \
  RESTORE_BACKUP_PASSPHRASE_FILE="$passphrase_file" \
  RESTORE_EVIDENCE_DIR="$existing_evidence" \
  RESTORE_SYSTEM_VERSION="test" \
  RESTORE_OPERATOR="test" \
  RESTORE_RECOVERY_POINT_UTC="$(date -u +%FT%TZ)" \
  bash scripts/verify-postgres-restore.sh >"$work_dir/reuse.log" 2>&1; then
  echo "En befintlig beviskatalog accepterades felaktigt." >&2
  exit 1
fi
grep -q "finns redan" "$work_dir/reuse.log"

psql "dbname=$target_db" -Xv ON_ERROR_STOP=1 -qc "create schema occupied"
if SOURCE_DATABASE_URL="$source_url" \
  TARGET_DATABASE_URL="$target_url" \
  RESTORE_BACKUP_PASSPHRASE_FILE="$passphrase_file" \
  RESTORE_EVIDENCE_DIR="$work_dir/non-public-evidence" \
  RESTORE_SYSTEM_VERSION="test" \
  RESTORE_OPERATOR="test" \
  RESTORE_RECOVERY_POINT_UTC="$(date -u +%FT%TZ)" \
  bash scripts/verify-postgres-restore.sh >"$work_dir/non-public.log" 2>&1; then
  echo "Ett mål med ett icke-publikt användarschema accepterades felaktigt." >&2
  exit 1
fi
grep -q "inte tom" "$work_dir/non-public.log"

if TARGET_DATABASE_URL="$target_url" \
  RESTORE_EXPECTED_DATABASE_NAME="fel_databas" \
  bash scripts/verify-restored-runtime.sh >"$work_dir/identity.log" 2>&1; then
  echo "Runtime-testet accepterade fel databasidentitet." >&2
  exit 1
fi
grep -q "Fel testdatabas" "$work_dir/identity.log"

echo "Restore-säkerhetstester godkända."