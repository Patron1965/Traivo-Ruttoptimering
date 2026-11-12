#!/usr/bin/env bash
set -euo pipefail

: "${EXPECTED_AWS_ACCOUNT_ID:?Set EXPECTED_AWS_ACCOUNT_ID}"
REGION="${AWS_REGION:-eu-north-1}"
[[ "$REGION" == "eu-north-1" ]] || { echo "BLOCKED: AWS_REGION must be eu-north-1" >&2; exit 1; }

actual_account="$(aws sts get-caller-identity --query Account --output text)"
[[ "$actual_account" == "$EXPECTED_AWS_ACCOUNT_ID" ]] || {
  echo "BLOCKED: active account is not the dedicated expected account" >&2
  exit 1
}

for service_region in \
  "$(aws ecs list-clusters --region "$REGION" --query 'clusterArns[0]' --output text)" \
  "$(aws dynamodb list-tables --region "$REGION" --query 'TableNames[0]' --output text)" \
  "$(aws secretsmanager list-secrets --region "$REGION" --query 'SecretList[0].ARN' --output text)"; do
  [[ "$service_region" != "None" ]] || { echo "BLOCKED: expected regional resource missing" >&2; exit 1; }
done

echo "Regional API checks passed for account $actual_account in $REGION."
echo "BLOCKED until a human reviews global DNS, support access, subprocessors, backups and exported evidence."