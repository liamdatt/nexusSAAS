#!/usr/bin/env sh
set -eu

: "${BACKUP_DIR:=/opt/nexus/backups/control}"
: "${POSTGRES_DB:=nexus}"
: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

stamp="$(date +%Y%m%d_%H%M%S)"
out_dir="${BACKUP_DIR}/${stamp}"
mkdir -p "$out_dir"

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" > "$out_dir/postgres.sql"

echo "backup_complete=$out_dir"
