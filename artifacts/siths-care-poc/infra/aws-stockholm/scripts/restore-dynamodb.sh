#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_TABLE:?Set SOURCE_TABLE}"
: "${RESTORE_TIME:?Set RESTORE_TIME in ISO-8601 format}"
: "${RESTORE_TABLE:?Set a new, approved restore table name}"
: "${EXPECTED_AWS_ACCOUNT_ID:?Set EXPECTED_AWS_ACCOUNT_ID}"
REGION="${AWS_REGION:-eu-north-1}"

[[ "$REGION" == "eu-north-1" ]] || { echo "BLOCKED: wrong region" >&2; exit 1; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$EXPECTED_AWS_ACCOUNT_ID" ]] || {
  echo "BLOCKED: wrong AWS account" >&2; exit 1
}

aws dynamodb restore-table-to-point-in-time \
  --region "$REGION" \
  --source-table-name "$SOURCE_TABLE" \
  --target-table-name "$RESTORE_TABLE" \
  --restore-date-time "$RESTORE_TIME"

echo "Restore requested into $RESTORE_TABLE. Do not cut over until validation and dual approval are recorded."