# Worker VPS Deploy

Compose stack for VPS-2 (private worker node):

- Runner
- Tenant runtime containers managed by runner

## Required Network

Runner must be reachable only via private Hetzner Cloud Network IP. Do not expose runner public ingress.

## Required Pinning

Use pinned image tags only (no `latest`):

- `IMAGE_TAG=sha-REPLACE_WITH_COMMIT`
- `NEXUS_IMAGE=ghcr.io/<org>/nexus-runtime:sha-REPLACE_WITH_COMMIT`

## Staging Deploy

```bash
docker network create runner_internal || true
cd /opt/nexus/deploy/worker-vps
docker compose --env-file .env pull runner
docker compose --env-file .env up -d runner
```

Connectivity checks:

```bash
# On VPS1 (Coolify node)
curl -fsS http://<VPS2_PRIVATE_IP>:8000/healthz

# On VPS2 (runner node)
redis-cli -h <VPS1_PRIVATE_IP> ping
```

## Production Deploy

Use the same image tag that passed staging.

```bash
cd /opt/nexus/deploy/worker-vps
docker compose --env-file .env pull runner
docker compose --env-file .env up -d runner
```

## Nightly Backup

```bash
15 2 * * * /opt/nexus/deploy/worker-vps/backup-worker.sh >> /var/log/nexus-backup.log 2>&1
```

`backup-worker.sh` captures:

- `/opt/nexus/tenants` metadata/config files
- all `tenant_*_session` and `tenant_*_state` Docker volumes
