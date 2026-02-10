# Local Full-Stack Smoke Environment

This stack runs all core services for local end-to-end validation:

- Postgres
- Redis
- Runner
- Control-plane
- Web dashboard

## Prerequisites

- Docker Engine with `docker compose`
- Access to a valid `ghcr.io/<org>/nexus-runtime:<sha>` image, or build your own runtime image and set that tag in `deploy/local/docker-compose.yml`.

## Start

```bash
cd /Users/liamdatt/Desktop/saas
docker compose -f deploy/local/docker-compose.yml up -d --build
```

## Stop

```bash
cd /Users/liamdatt/Desktop/saas
docker compose -f deploy/local/docker-compose.yml down
```

## Smoke sequence

1. Open `http://localhost:3000`.
2. Sign up and create tenant.
3. Confirm tenant transitions to `pending_pairing`.
4. Trigger Pair WhatsApp and verify QR event appears.
5. Apply config changes and verify `config.applied` event.
6. Stop/start tenant and verify state transitions.
