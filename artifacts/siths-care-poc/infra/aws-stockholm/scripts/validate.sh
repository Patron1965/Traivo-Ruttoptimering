#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if command -v terraform >/dev/null 2>&1; then
  iac_cli="terraform"
elif command -v tofu >/dev/null 2>&1; then
  iac_cli="tofu"
else
  echo "BLOCKED: neither terraform nor tofu is installed; fmt/validate was not executed." >&2
  exit 2
fi
"$iac_cli" fmt -check -recursive
"$iac_cli" init -backend=false
"$iac_cli" validate