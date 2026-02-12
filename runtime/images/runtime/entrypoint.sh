#!/usr/bin/env sh
set -eu

export PATH="/root/.local/bin:${PATH}"

CONFIG_DIR="${NEXUS_CONFIG_DIR:-/data/config}"
DATA_DIR="${NEXUS_DATA_DIR:-/data/state}"
PROMPTS_DIR="${NEXUS_PROMPTS_DIR:-/data/config/prompts}"
SKILLS_DIR="${NEXUS_SKILLS_DIR:-/data/config/skills}"
BRIDGE_DIR="${NEXUS_BRIDGE_DIR:-${DATA_DIR}/bridge}"
ONBOARDED_MARKER="${DATA_DIR}/.onboarded"
BRIDGE_TSX_BIN="${BRIDGE_DIR}/node_modules/.bin/tsx"
BRIDGE_DOTENV_PKG="${BRIDGE_DIR}/node_modules/dotenv/package.json"
BRIDGE_SERVER_TS="${BRIDGE_DIR}/src/server.ts"
BRIDGE_PACKAGE_JSON="${BRIDGE_DIR}/package.json"

bridge_ready() {
  if [ ! -d "${BRIDGE_DIR}" ]; then
    return 1
  fi
  if [ ! -f "${BRIDGE_PACKAGE_JSON}" ]; then
    return 1
  fi
  if [ ! -f "${BRIDGE_SERVER_TS}" ]; then
    return 1
  fi
  if [ ! -f "${BRIDGE_DOTENV_PKG}" ]; then
    return 1
  fi
  if [ -x "${BRIDGE_TSX_BIN}" ]; then
    return 0
  fi
  command -v tsx >/dev/null 2>&1
}

mkdir -p "${CONFIG_DIR}"
mkdir -p "${DATA_DIR}"
mkdir -p "${PROMPTS_DIR}"
mkdir -p "${SKILLS_DIR}"

needs_onboard=0
if [ ! -f "${ONBOARDED_MARKER}" ]; then
  needs_onboard=1
elif ! bridge_ready; then
  echo "[nexus] onboarding marker exists but bridge dependencies are missing; rerunning onboarding..."
  needs_onboard=1
fi

# Onboard prepares bridge runtime assets and installs bridge dependencies.
if [ "${needs_onboard}" -eq 1 ]; then
  echo "[nexus] running onboarding bootstrap..."
  if nexus onboard --non-interactive --yes; then
    touch "${ONBOARDED_MARKER}"
  else
    echo "[nexus] onboarding failed; refusing to start runtime."
    exit 1
  fi
fi

if ! bridge_ready; then
  echo "[nexus] bridge runtime dependencies are still missing after onboarding; refusing to start runtime."
  exit 1
fi

exec nexus start
