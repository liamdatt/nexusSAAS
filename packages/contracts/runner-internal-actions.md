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
