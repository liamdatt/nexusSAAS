# Runner Internal JWT Actions

The control-plane signs runner internal JWTs with action-scoped claims.

Allowed `action` values:

- `provision`
- `start`
- `stop`
- `restart`
- `pair_start`
- `apply_config`
- `whatsapp_disconnect`
- `health`
- `delete`

## Runtime action payload

The following endpoints accept an optional JSON body:

- `POST /internal/tenants/{tenant_id}/start`
- `POST /internal/tenants/{tenant_id}/restart`
- `POST /internal/tenants/{tenant_id}/pair/start`

Payload:

```json
{ "nexus_image": "ghcr.io/<org>/nexus-runtime:<nexus_sha>" }
```

If omitted, runner keeps current behavior and uses the existing tenant compose image.
