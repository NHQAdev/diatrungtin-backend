#!/usr/bin/env bash
# Daily backup: database dump + uploaded images, kept for KEEP_DAYS days.
# Run from cron on the VPS (see docs/DEPLOY.md). Copy BACKUP_DIR off the server too.
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/diatrungtin}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 1. Database: custom-format dump (compressed, restorable with pg_restore).
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$BACKUP_DIR/db-$STAMP.dump.partial"
mv "$BACKUP_DIR/db-$STAMP.dump.partial" "$BACKUP_DIR/db-$STAMP.dump"

# 2. Uploaded images (Docker volume "diatrungtin_uploads"), read-only.
docker run --rm -v diatrungtin_uploads:/data:ro -v "$BACKUP_DIR":/backup alpine \
  tar -czf "/backup/uploads-$STAMP.tgz" -C /data .

# 3. Remove backups older than KEEP_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'uploads-*.tgz' \) -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) backup ok: db-$STAMP.dump uploads-$STAMP.tgz"
