#!/bin/sh
set -eu

snapshot_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$snapshot_dir"
}

trap cleanup EXIT HUP INT TERM

# Snapshot the complete generated trees, including untracked files. The
# validation must compare codegen with the working tree as it was before
# generation, rather than with HEAD: feature work may intentionally include
# generated files that are not committed yet.
mkdir -p "$snapshot_dir/api-client-react" "$snapshot_dir/api-zod"
cp -a lib/api-client-react/src/generated/. "$snapshot_dir/api-client-react"
cp -a lib/api-zod/src/generated/. "$snapshot_dir/api-zod"

pnpm --filter @workspace/api-spec run codegen

# A successful codegen check means generation is deterministic from the
# current working tree. Comparing the complete trees catches additions,
# deletions, and edits without masking untracked generated output.
if ! diff -ruN "$snapshot_dir/api-client-react" lib/api-client-react/src/generated ||
  ! diff -ruN "$snapshot_dir/api-zod" lib/api-zod/src/generated; then
  echo "API codegen changed generated output; regenerate and review the drift." >&2
  exit 1
fi