# Staging Validation Checklist

Run this in order on staging after deploy.

## Network and Connectivity

1. Both VPS instances are attached to the same Hetzner Cloud Network (`10.0.0.0/16`).
2. From VPS1, `curl http://<VPS2_PRIVATE_IP>:8000/healthz` returns success.
3. From VPS2, `redis-cli -h <VPS1_PRIVATE_IP> ping` returns `PONG`.
4. Runner port `8000` is not exposed on the public internet.

## Release Pinning

1. Coolify services (`web`, `control-plane`) use `:<SAAS_SHA>` image tags.
2. Runner service uses `IMAGE_TAG=<SAAS_SHA>`.
3. `NEXUS_IMAGE` is pinned to `ghcr.io/<org>/nexus-runtime:<NEXUS_SHA>` across control-plane and runner.

## Auth and Tenant

1. Signup succeeds.
2. Login succeeds.
3. Tenant setup succeeds.
4. Second tenant setup for same user returns conflict.

## Runtime Lifecycle

1. Tenant enters `pending_pairing`.
2. `POST /runtime/start` transitions to `running`.
3. `POST /runtime/stop` transitions to `paused`.
4. `POST /runtime/restart` transitions back to `running`.

## WhatsApp Pairing/Event Path

1. Pair start emits `whatsapp.qr` to browser websocket.
2. Pair completion emits `whatsapp.connected`.
3. Disconnect emits `whatsapp.disconnected`.

## Config Revisions

1. Config patch creates a new active revision.
2. Prompt update creates new revision and remains active after restart.
3. Skill update creates new revision and remains active after restart.

## Isolation and Recovery

1. Cross-tenant status/config/events are denied.
2. Runner restart reconciles existing running tenants.
3. Control-plane restart resumes websocket event fanout.
4. Coolify restart/redeploy of control-plane preserves DB state and restarts app cleanly.

## Backups

1. Control backup script runs and creates postgres dump.
2. Worker backup script runs and archives tenant metadata/config plus `tenant_*_session` and `tenant_*_state` volumes.
3. Restore drill succeeds for one tenant.
