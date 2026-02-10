# Coolify Deploy (VPS1 Control Node)

This mode replaces `deploy/control-vps/docker-compose.yml`.

- VPS1 runs Coolify + Postgres + Redis + Control Plane + Web.
- VPS2 runs `deploy/worker-vps/docker-compose.yml` (runner only).
- Private traffic runs over Hetzner Cloud Network (`10.0.0.0/16`).

## Required Prerequisites

- Debian on VPS1 and VPS2.
- Both VPS attached to the same Hetzner Cloud Network.
- Private IP examples:
  - VPS1: `10.0.0.10`
  - VPS2: `10.0.0.20`
- Firewall rules:
  - VPS1 public: allow `80`, `443`, `22`
  - VPS1 private: allow `6379` only from VPS2 private IP
  - VPS2 private: allow `8000` only from VPS1 private IP
  - VPS2 public: do not expose `8000`

## Service Images

- `ghcr.io/<org>/nexus-control-plane:<SAAS_SHA>`
- `ghcr.io/<org>/nexus-web:<SAAS_SHA>`
- `ghcr.io/<org>/nexus-runtime:<NEXUS_SHA>` (referenced via env; consumed by runner)

## Coolify Services

Create these services in one Coolify project/environment:

1. `postgres` (persistent volume, internal networking)
2. `redis` (persistent volume, publish host port 6379 only if needed for VPS2 access)
3. `control-plane` (image deploy)
4. `web` (image deploy)

Use env templates from this folder:

- `control-plane.env.example`
- `web.env.example`

## Control-Plane Notes

- `CONTROL_AUTO_CREATE_SCHEMA=false`
- Startup command in image already runs:
  - `alembic upgrade head`
  - then `uvicorn ...`
- Set `RUNNER_BASE_URL` to `http://<VPS2_PRIVATE_IP>:8000`
- Set `REDIS_URL` to either:
  - `redis://127.0.0.1:6379/0` (if using host networking path), or
  - Coolify service DNS URL when both are on same docker network

## Web Notes

- Set `NEXT_PUBLIC_CONTROL_API_BASE=https://<CONTROL_API_HOST>`

## Verification

From VPS1:

```bash
curl -fsS http://<VPS2_PRIVATE_IP>:8000/healthz
```

From VPS2:

```bash
redis-cli -h <VPS1_PRIVATE_IP> ping
```

Expected output: `PONG`

## GitHub Actions Secrets (Worker Deploy Jobs)

`/Users/liamdatt/Desktop/saas/.github/workflows/build-and-deploy.yml` requires:

- `STAGING_WORKER_VPS_HOST`
- `STAGING_WORKER_VPS_USER`
- `STAGING_WORKER_VPS_SSH_KEY`
- `STAGING_WORKER_VPS_SSH_PASSPHRASE`
- `PRODUCTION_WORKER_VPS_HOST`
- `PRODUCTION_WORKER_VPS_USER`
- `PRODUCTION_WORKER_VPS_SSH_KEY`
- `PRODUCTION_WORKER_VPS_SSH_PASSPHRASE`

Control-plane and web deploys are updated through Coolify (not SSH jobs).

Set these as GitHub **Secrets** (not Variables), preferably under matching
Environment scopes:

- `staging` environment: `STAGING_WORKER_VPS_*`
- `production` environment: `PRODUCTION_WORKER_VPS_*`

## Runtime Build (Pinned)

Build and push runtime image with a pinned tag:

```bash
cd /Users/liamdatt/Desktop/saas
./scripts/build-runtime-image.sh <github_org> <nexus_sha> [flopro_nexus_version]
```

Do not use `latest`.
