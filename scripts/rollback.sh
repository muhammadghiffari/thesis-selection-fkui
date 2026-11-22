#!/usr/bin/env bash
# Rollback: restore the previous image + pre-deploy backup.
# Usage: ./scripts/rollback.sh [previous-commit-or-tag] [backup-dir]
#   1. ./scripts/backup.sh BEFORE the deploy (so this has something to restore)
#   2. On failure: ./scripts/rollback.sh <previous git sha> <backup dir from step 1>
#
# Order matters: code goes back first, THEN data — migrations are forward-only
# (Drizzle), so a data restore must match the old image's schema. If the deploy
# included a migration you cannot roll forward, stop and restore data fully.
set -euo pipefail
PREV="${1:?usage: ./scripts/rollback.sh <previous-commit> [backup-dir]}"
BACKUP="${2:-}"
git fetch --tags --quiet 2>/dev/null || true
echo "[rollback] checking out $PREV"
git checkout "$PREV" --quiet || git switch --detach "$PREV"
echo "[rollback] rebuilding stack at $PREV"
docker compose down
docker compose up -d --build
echo "[rollback] waiting for health…"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3000/api/health >/dev/null 2>&1; then echo "[rollback] API healthy"; break; fi
  sleep 2
  if [ "$i" = "30" ]; then echo "[rollback] API never became healthy — investigate before restoring data"; exit 1; fi
done
if [ -n "$BACKUP" ]; then
  echo "[rollback] restoring postgres from $BACKUP/postgres.sql.gz (code already at $PREV)"
  docker compose exec -T postgres sh -c "gunzip -c > /tmp/restore.sql" < "$BACKUP/postgres.sql.gz"
  docker compose exec -T postgres sh -c "psql -U postgres -d thesis_selection < /tmp/restore.sql"
  echo "[rollback] data restored"
fi
echo "[rollback] verify: curl -s http://localhost:3000/api/health"
