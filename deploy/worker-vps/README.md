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

`NEXUS_IMAGE` must reference a runtime image built from the intended NEXUS git commit.  
For same-commit rebuilds, use a suffix tag (for example `<nexus_sha>-r1`) and repin to that exact tag.

## Required Environment Semantics

- `CONTROL_PRIVATE_IP` is host IP only (for example `10.0.0.2`).
- `REDIS_URL` is the full credentialed URL (for example `redis://default:<password>@10.0.0.2:6379/0`).
- Runner must always consume `REDIS_URL` directly. Do not derive it from `CONTROL_PRIVATE_IP`.

Known bad examples:

- `CONTROL_PRIVATE_IP=default:<password>@10.0.0.2`
- `REDIS_URL=default:<password>@10.0.0.2`

Known good example:

- `REDIS_URL=redis://default:<password>@10.0.0.2:6379/0`

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
redis-cli -u "$REDIS_URL" ping

# Effective runner env should include a credentialed REDIS_URL.
docker compose --env-file .env config | rg -n "REDIS_URL|CONTROL_PRIVATE_IP"
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
