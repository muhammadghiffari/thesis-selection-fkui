#!/usr/bin/env bash
# Backup: PostgreSQL logical dump + Redis RDB snapshot.
# Usage: ./scripts/backup.sh [output-dir]
#   output-dir defaults to ./backups/<UTC-timestamp>
set -euo pipefail
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-./backups/$TS}"
mkdir -p "$OUT"
echo "[backup] dumping postgres → $OUT/postgres.sql.gz"
docker compose exec -T postgres pg_dump -U postgres -d thesis_selection | gzip > "$OUT/postgres.sql.gz"
echo "[backup] snapshotting redis → $OUT/redis.rdb"
docker compose exec -T redis redis-cli BGSAVE >/dev/null || true
sleep 2
docker compose exec -T redis cat /data/dump.rdb > "$OUT/redis.rdb" 2>/dev/null || docker compose cp redis:/data/dump.rdb "$OUT/redis.rdb" || true
ls -lh "$OUT"
echo "[backup] done. Keep this directory until the next release is verified."
