#!/usr/bin/env sh
set -eu

: "${BACKUP_DIR:=/opt/nexus/backups/worker}"
: "${TENANT_ROOT:=/opt/nexus/tenants}"

stamp="$(date +%Y%m%d_%H%M%S)"
out_dir="${BACKUP_DIR}/${stamp}"
mkdir -p "$out_dir"
mkdir -p "$out_dir/volumes"

if [ -d "$TENANT_ROOT" ]; then
  tar -czf "$out_dir/tenants_config.tar.gz" -C "$TENANT_ROOT" .
else
  tar -czf "$out_dir/tenants_config.tar.gz" --files-from /dev/null
  echo "tenant_root_missing=$TENANT_ROOT"
fi

docker volume ls --format '{{.Name}}' \
  | grep -E '^tenant_.*_(session|state)$' \
  | while IFS= read -r vol; do
      [ -n "$vol" ] || continue
      docker run --rm \
        -v "${vol}:/volume:ro" \
        -v "${out_dir}/volumes:/backup" \
        busybox sh -c "tar -czf /backup/${vol}.tar.gz -C /volume ."
    done || true

echo "backup_complete=$out_dir"
