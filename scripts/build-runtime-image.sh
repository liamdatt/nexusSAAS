#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <github_org> <nexus_sha> [flopro_nexus_version]" >&2
  echo "example: $0 acme 4f0c2a1 0.1.4" >&2
  exit 1
fi

GITHUB_ORG="$1"
NEXUS_SHA="$2"
FLOPRO_NEXUS_VERSION="${3:-}"
IMAGE="ghcr.io/${GITHUB_ORG}/nexus-runtime:${NEXUS_SHA}"

cd /Users/liamdatt/Desktop/saas

BUILD_ARGS=()
if [[ -n "$FLOPRO_NEXUS_VERSION" ]]; then
  BUILD_ARGS+=(--build-arg "FLOPRO_NEXUS_VERSION=${FLOPRO_NEXUS_VERSION}")
fi

echo "building ${IMAGE}"
docker build \
  -f runtime/images/runtime/Dockerfile \
  "${BUILD_ARGS[@]}" \
  -t "${IMAGE}" \
  .

echo "pushing ${IMAGE}"
docker push "${IMAGE}"

echo "done image=${IMAGE}"
