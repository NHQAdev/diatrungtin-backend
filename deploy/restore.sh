#!/usr/bin/env bash
# Restore a backup made by backup.sh. THIS REPLACES THE CURRENT DATA.
# Usage: ./restore.sh /var/backups/diatrungtin/db-YYYYMMDD-HHMMSS.dump [/var/backups/diatrungtin/uploads-YYYYMMDD-HHMMSS.tgz]
set -euo pipefail
cd "$(dirname "$0")"

DB_DUMP="${1:?Usage: ./restore.sh <db-*.dump> [uploads-*.tgz]}"
UPLOADS_TGZ="${2:-}"
[ -f "$DB_DUMP" ] || { echo "Not found: $DB_DUMP"; exit 1; }

echo "This will REPLACE the current database${UPLOADS_TGZ:+ and uploaded images} with:"
echo "  $DB_DUMP ${UPLOADS_TGZ}"
read -r -p "Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

# Stop the API so nobody writes while restoring.
docker compose stop api

docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$DB_DUMP"

if [ -n "$UPLOADS_TGZ" ]; then
  docker run --rm -v diatrungtin_uploads:/data -v "$(cd "$(dirname "$UPLOADS_TGZ")" && pwd)":/backup alpine \
    sh -c "find /data -mindepth 1 -delete && tar -xzf /backup/$(basename "$UPLOADS_TGZ") -C /data && chown -R 1000:1000 /data"
fi

docker compose start api
echo "Restore finished. Check: curl https://\$API_DOMAIN/health/ready"
