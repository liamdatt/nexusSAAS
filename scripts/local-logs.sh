#!/usr/bin/env bash
set -euo pipefail
cd /Users/liamdatt/Desktop/saas
docker compose -f deploy/local/docker-compose.yml logs -f --tail=200
