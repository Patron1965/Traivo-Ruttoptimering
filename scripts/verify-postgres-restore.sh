#!/usr/bin/env bash
set -euo pipefail

required=(
  SOURCE_DATABASE_URL
  TARGET_DATABASE_URL
  RESTORE_BACKUP_PASSPHRASE_FILE
  RESTORE_EVIDENCE_DIR
  RESTORE_SYSTEM_VERSION
  RESTORE_OPERATOR
  RESTORE_RECOVERY_POINT_UTC
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name måste anges." >&2
    exit 2
  fi
done

if [[ ! -r "$RESTORE_BACKUP_PASSPHRASE_FILE" ]]; then
  echo "RESTORE_BACKUP_PASSPHRASE_FILE måste vara en läsbar fil." >&2
  exit 2
fi

if [[ -e "$RESTORE_EVIDENCE_DIR" ]]; then
  echo "RESTORE_EVIDENCE_DIR finns redan. Ange en ny katalog så tidigare bevis inte skrivs över." >&2
  exit 2
fi
mkdir -p "$RESTORE_EVIDENCE_DIR"
chmod 700 "$RESTORE_EVIDENCE_DIR"

plain_dump="$(mktemp)"
trap 'rm -f "$plain_dump"' EXIT
chmod 600 "$plain_dump"

with_connection() {
  local raw_url="$1"
  shift
  local -a parts
  mapfile -d '' -t parts < <(
    CONNECTION_URL="$raw_url" node -e '
      const url = new URL(process.env.CONNECTION_URL);
      const values = [
        url.hostname,
        url.port || "5432",
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
        decodeURIComponent(url.pathname.slice(1)),
        url.searchParams.get("sslmode") || "require",
      ];
      process.stdout.write(values.join("\0") + "\0");
    '
  )
  PGHOST="${parts[0]}" \
    PGPORT="${parts[1]}" \
    PGUSER="${parts[2]}" \
    PGPASSWORD="${parts[3]}" \
    PGDATABASE="${parts[4]}" \
    PGSSLMODE="${parts[5]}" \
    "$@"
}

source_db="$(with_connection "$SOURCE_DATABASE_URL" psql -XAtqc 'select current_database()')"
target_db="$(with_connection "$TARGET_DATABASE_URL" psql -XAtqc 'select current_database()')"
source_server="$(with_connection "$SOURCE_DATABASE_URL" psql -XAtqc "select inet_server_addr()::text || ':' || inet_server_port()")"
target_server="$(with_connection "$TARGET_DATABASE_URL" psql -XAtqc "select inet_server_addr()::text || ':' || inet_server_port()")"

if [[ "$source_db" == "$target_db" && "$source_server" == "$target_server" ]]; then
  echo "Källa och mål är samma databas. Återställningen avbryts." >&2
  exit 3
fi

target_objects="$(with_connection "$TARGET_DATABASE_URL" psql -XAtqc "
  with extension_objects as (
    select d.classid, d.objid
    from pg_depend d
    where d.refclassid = 'pg_extension'::regclass
      and d.deptype = 'e'
  ),
  user_relations as (
    select c.oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join extension_objects e
      on e.classid = 'pg_class'::regclass and e.objid = c.oid
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_toast'
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and e.objid is null
  ),
  user_functions as (
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join extension_objects e
      on e.classid = 'pg_proc'::regclass and e.objid = p.oid
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_toast'
      and e.objid is null
  ),
  user_types as (
    select t.oid
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    left join extension_objects e
      on e.classid = 'pg_type'::regclass and e.objid = t.oid
    where n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_toast'
      and t.typtype in ('c', 'd', 'e', 'r')
      and e.objid is null
  ),
  extra_schemas as (
    select n.oid
    from pg_namespace n
    left join extension_objects e
      on e.classid = 'pg_namespace'::regclass and e.objid = n.oid
    where n.nspname not in ('public', 'pg_catalog', 'information_schema')
      and n.nspname !~ '^pg_toast'
      and e.objid is null
  )
  select
    (select count(*) from user_relations) +
    (select count(*) from user_functions) +
    (select count(*) from user_types) +
    (select count(*) from extra_schemas)
")"
if [[ "$target_objects" != "0" ]]; then
  echo "Måldatabasen är inte tom. Återställningen avbryts." >&2
  exit 3
fi

started_at="$(date -u +%FT%TZ)"
started_epoch="$(date -u -d "$started_at" +%s)"
recovery_point_epoch="$(date -u -d "$RESTORE_RECOVERY_POINT_UTC" +%s)"
actual_rpo_seconds="$((started_epoch - recovery_point_epoch))"
if ((actual_rpo_seconds < 0 || actual_rpo_seconds > 86400)); then
  echo "RPO-målet 24 timmar överskreds eller återställningspunkten ligger i framtiden." >&2
  exit 5
fi

with_connection "$SOURCE_DATABASE_URL" pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$plain_dump"

openssl enc -aes-256-cbc -salt -pbkdf2 \
  -in "$plain_dump" \
  -out "$RESTORE_EVIDENCE_DIR/backup.dump.enc" \
  -pass "file:$RESTORE_BACKUP_PASSPHRASE_FILE"
chmod 600 "$RESTORE_EVIDENCE_DIR/backup.dump.enc"

openssl enc -d -aes-256-cbc -pbkdf2 \
  -in "$RESTORE_EVIDENCE_DIR/backup.dump.enc" \
  -pass "file:$RESTORE_BACKUP_PASSPHRASE_FILE" |
  with_connection "$TARGET_DATABASE_URL" pg_restore \
    --exit-on-error \
    --no-owner \
    --no-acl \
    --dbname="$target_db"

count_sql="select tablename, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I','public',tablename), false, true, '')))[1]::text::bigint from pg_tables where schemaname='public' order by tablename"
with_connection "$SOURCE_DATABASE_URL" psql -XAt -F '|' -c "$count_sql" >"$RESTORE_EVIDENCE_DIR/source-row-counts.txt"
with_connection "$TARGET_DATABASE_URL" psql -XAt -F '|' -c "$count_sql" >"$RESTORE_EVIDENCE_DIR/restored-row-counts.txt"
diff -u \
  "$RESTORE_EVIDENCE_DIR/source-row-counts.txt" \
  "$RESTORE_EVIDENCE_DIR/restored-row-counts.txt" \
  >"$RESTORE_EVIDENCE_DIR/row-count-diff.txt"

with_connection "$TARGET_DATABASE_URL" psql -XAt -F '|' -c \
  "select role, count(*) from users group by role order by role" \
  >"$RESTORE_EVIDENCE_DIR/restored-role-counts.txt"

for role in admin dispatcher driver viewer; do
  if ! grep -q "^${role}|" "$RESTORE_EVIDENCE_DIR/restored-role-counts.txt"; then
    echo "Den återställda databasen saknar rollen $role." >&2
    exit 4
  fi
done

finished_at="$(date -u +%FT%TZ)"
finished_epoch="$(date -u -d "$finished_at" +%s)"
actual_rto_seconds="$((finished_epoch - started_epoch))"
if ((actual_rto_seconds > 7200)); then
  echo "RTO-målet 2 timmar överskreds." >&2
  exit 5
fi
archive_sha256="$(sha256sum "$RESTORE_EVIDENCE_DIR/backup.dump.enc" | cut -d' ' -f1)"
table_count="$(wc -l <"$RESTORE_EVIDENCE_DIR/source-row-counts.txt" | tr -d ' ')"

cat >"$RESTORE_EVIDENCE_DIR/restore-metadata.json" <<EOF
{
  "schemaVersion": 1,
  "startedAt": "$started_at",
  "finishedAt": "$finished_at",
  "recoveryPointUtc": "$RESTORE_RECOVERY_POINT_UTC",
  "actualRpoSeconds": $actual_rpo_seconds,
  "rpoTargetSeconds": 86400,
  "actualRtoSeconds": $actual_rto_seconds,
  "rtoTargetSeconds": 7200,
  "rpoTargetMet": true,
  "rtoTargetMet": true,
  "systemVersion": "$RESTORE_SYSTEM_VERSION",
  "operator": "$RESTORE_OPERATOR",
  "sourceDatabaseIdentifier": "$source_server/$source_db",
  "targetDatabaseIdentifier": "$target_server/$target_db",
  "encryptedArchiveSha256": "$archive_sha256",
  "publicTableCount": $table_count,
  "rowCountsMatch": true,
  "requiredRolesPresent": true
}
EOF

(
  cd "$RESTORE_EVIDENCE_DIR"
  sha256sum \
    backup.dump.enc \
    restore-metadata.json \
    restored-role-counts.txt \
    restored-row-counts.txt \
    row-count-diff.txt \
    source-row-counts.txt >SHA256SUMS
)

echo "Isolerad återställning och datakontroll godkänd: $RESTORE_EVIDENCE_DIR"