#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <github_org> <nexus_repo> <nexus_sha> [runtime_tag]" >&2
  echo "example: $0 acme acme/NEXUS 4f0c2a1 4f0c2a1-r1" >&2
  exit 1
fi

GITHUB_ORG="$1"
NEXUS_REPO="$2"
NEXUS_SHA="$3"
RUNTIME_TAG="${4:-${NEXUS_SHA}}"
IMAGE="ghcr.io/${GITHUB_ORG}/nexus-runtime:${RUNTIME_TAG}"

cd /Users/liamdatt/Desktop/saas

BUILD_ARGS=(
  --build-arg "NEXUS_GIT_REPO=${NEXUS_REPO}"
  --build-arg "NEXUS_SHA=${NEXUS_SHA}"
)

echo "building ${IMAGE}"
docker build \
  -f runtime/images/runtime/Dockerfile \
  "${BUILD_ARGS[@]}" \
  -t "${IMAGE}" \
  .

echo "pushing ${IMAGE}"
docker push "${IMAGE}"

echo "done image=${IMAGE}"
