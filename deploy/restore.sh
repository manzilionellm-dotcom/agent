#!/usr/bin/env bash
# Restaure la mémoire depuis un dump : bash deploy/restore.sh backups/manzi-2026-09-20.sql.gz
set -euo pipefail
DUMP="${1:?chemin du dump .sql.gz}"
docker compose stop orchestrator
gunzip -c "$DUMP" | docker compose exec -T db psql -U manzi -d manzi
docker compose start orchestrator
echo "restauré depuis $DUMP"
