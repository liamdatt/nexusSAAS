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

mkdir -p "${CONFIG_DIR}"
mkdir -p "${DATA_DIR}"
mkdir -p "${PROMPTS_DIR}"
mkdir -p "${SKILLS_DIR}"

needs_onboard=0
if [ ! -f "${ONBOARDED_MARKER}" ]; then
  needs_onboard=1
elif [ ! -x "${BRIDGE_TSX_BIN}" ]; then
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

exec nexus start
