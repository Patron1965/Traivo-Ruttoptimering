#!/usr/bin/env bash
set -euo pipefail

# Replit runs this after a task merge to apply the Drizzle source of truth to
# the development database. Production receives the same schema through the
# managed Publish database diff; never point this command at production.
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push-force
