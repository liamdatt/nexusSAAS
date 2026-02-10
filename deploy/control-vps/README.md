# Control VPS Deploy (Compose Mode)

Compose stack for VPS-1 (public control node):

- Traefik
- Postgres
- Redis
- Control-plane
- Web

If you are using Coolify on VPS1, use `/Users/liamdatt/Desktop/saas/deploy/coolify-vps1/README.md` instead of this compose stack.

## Required Pinning

Use pinned image tags only (no `latest`):

- `IMAGE_TAG=sha-REPLACE_WITH_COMMIT`
- `NEXUS_IMAGE=ghcr.io/<org>/nexus-runtime:sha-REPLACE_WITH_COMMIT`

## Staging Deploy

```bash
cd /opt/nexus/deploy/control-vps
docker compose --env-file .env pull control-plane web
docker compose --env-file .env up -d control-plane web
```

## Production Deploy

Use the same image tag that passed staging.

```bash
cd /opt/nexus/deploy/control-vps
docker compose --env-file .env pull control-plane web
docker compose --env-file .env up -d control-plane web
```

## Nightly Backup

```bash
0 2 * * * /opt/nexus/deploy/control-vps/backup-control.sh >> /var/log/nexus-backup.log 2>&1
```
