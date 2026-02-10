# Nexus SaaS v1 (Control/Runner Two-Box)

Monorepo for Nexus SaaS with a strict split between:

- Control node (`apps/web`, `services/control-plane`, Postgres, Redis, Coolify or Traefik)
- Worker node (`services/runner`, Docker Engine, tenant runtime containers)

## Repository Layout

- `/Users/liamdatt/Desktop/saas/apps/web` - Next.js dashboard for auth, tenant setup, runtime controls, QR/events, and config editors.
- `/Users/liamdatt/Desktop/saas/services/control-plane` - FastAPI API for auth, tenancy, revisions, runner orchestration, websocket fanout.
- `/Users/liamdatt/Desktop/saas/services/runner` - FastAPI internal worker for tenant compose lifecycle and bridge event forwarding.
- `/Users/liamdatt/Desktop/saas/runtime/templates` - tenant compose and runtime env templates.
- `/Users/liamdatt/Desktop/saas/runtime/images/runtime` - prebuilt Nexus runtime image definition.
- `/Users/liamdatt/Desktop/saas/packages/contracts` - shared schema/docs for events and internal actions.
- `/Users/liamdatt/Desktop/saas/deploy/local` - local full-system smoke stack.
- `/Users/liamdatt/Desktop/saas/deploy/coolify-vps1` - control-node deploy assets for Coolify mode.
- `/Users/liamdatt/Desktop/saas/deploy/control-vps` - control-node compose deploy assets (legacy/optional mode).
- `/Users/liamdatt/Desktop/saas/deploy/worker-vps` - worker-node deploy assets.

## Control Plane API (`/v1`)

- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /tenants/setup`
- `GET /tenants/{tenant_id}/status`
- `POST /tenants/{tenant_id}/runtime/start`
- `POST /tenants/{tenant_id}/runtime/stop`
- `POST /tenants/{tenant_id}/runtime/restart`
- `POST /tenants/{tenant_id}/whatsapp/pair/start`
- `POST /tenants/{tenant_id}/whatsapp/disconnect`
- `GET /tenants/{tenant_id}/config`
- `PATCH /tenants/{tenant_id}/config`
- `GET /tenants/{tenant_id}/prompts`
- `PUT /tenants/{tenant_id}/prompts/{name}`
- `GET /tenants/{tenant_id}/skills`
- `PUT /tenants/{tenant_id}/skills/{skill_id}`
- `GET /events/ws` (websocket)

## Runner Internal API (`/internal`, private only)

- `POST /internal/tenants/{tenant_id}/provision`
- `POST /internal/tenants/{tenant_id}/start`
- `POST /internal/tenants/{tenant_id}/stop`
- `POST /internal/tenants/{tenant_id}/restart`
- `POST /internal/tenants/{tenant_id}/pair/start`
- `POST /internal/tenants/{tenant_id}/apply-config`
- `POST /internal/tenants/{tenant_id}/whatsapp/disconnect`
- `GET /internal/tenants/{tenant_id}/health`
- `DELETE /internal/tenants/{tenant_id}`

All `/internal/*` calls require signed JWT from control-plane with tenant/action scope.

## Local Commands

### Full stack smoke run

```bash
cd /Users/liamdatt/Desktop/saas
./scripts/local-up.sh
./scripts/local-logs.sh
./scripts/local-down.sh
```

### Web only

```bash
cd /Users/liamdatt/Desktop/saas/apps/web
npm install
npm run dev
```

### Control-plane only

```bash
cd /Users/liamdatt/Desktop/saas/services/control-plane
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 9000
```

### Runner only

```bash
cd /Users/liamdatt/Desktop/saas/services/runner
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Migrations

Alembic migrations live in:

- `/Users/liamdatt/Desktop/saas/services/control-plane/alembic`

Run latest migration:

```bash
cd /Users/liamdatt/Desktop/saas/services/control-plane
alembic upgrade head
```

## Deployment

- Worker workflow: `/Users/liamdatt/Desktop/saas/.github/workflows/build-and-deploy.yml`
- Runtime build workflow: `/Users/liamdatt/Desktop/saas/.github/workflows/build-runtime-image.yml`
- Staging deploy happens on `main` push for worker rollout (build + VPS2 staged rollout).
- Production promotion is manual (`workflow_dispatch`) with explicit pinned `image_tag` for worker rollout.
- VPS1 (web/control-plane/postgres/redis) is managed by Coolify in this deployment model.

Environment examples:

- `/Users/liamdatt/Desktop/saas/deploy/coolify-vps1/control-plane.env.example`
- `/Users/liamdatt/Desktop/saas/deploy/coolify-vps1/web.env.example`
- `/Users/liamdatt/Desktop/saas/deploy/control-vps/.env.example`
- `/Users/liamdatt/Desktop/saas/deploy/worker-vps/.env.example`

Build and push pinned runtime image:

```bash
cd /Users/liamdatt/Desktop/saas
./scripts/build-runtime-image.sh <github_org> <nexus_sha> [flopro_nexus_version]
```

## Runtime Version Pinning Policy

Deployment must use pinned image tags (SHA-like tags), never floating `latest`:

- `IMAGE_TAG=sha-REPLACE_WITH_COMMIT`
- `NEXUS_IMAGE=ghcr.io/<org>/nexus-runtime:sha-REPLACE_WITH_COMMIT`

## Backup Scripts

- Control node: `/Users/liamdatt/Desktop/saas/deploy/control-vps/backup-control.sh`
- Worker node: `/Users/liamdatt/Desktop/saas/deploy/worker-vps/backup-worker.sh`
