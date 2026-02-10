#!/usr/bin/env sh
set -eu

export PATH="/root/.local/bin:${PATH}"

mkdir -p "${NEXUS_CONFIG_DIR:-/data/config}"
mkdir -p "${NEXUS_DATA_DIR:-/data/state}"
mkdir -p "${NEXUS_PROMPTS_DIR:-/data/config/prompts}"
mkdir -p "${NEXUS_SKILLS_DIR:-/data/config/skills}"

# Onboard prepares bridge runtime assets and installs bridge dependencies.
if [ ! -f "${NEXUS_DATA_DIR:-/data/state}/.onboarded" ]; then
  nexus onboard --non-interactive --yes || true
  touch "${NEXUS_DATA_DIR:-/data/state}/.onboarded"
fi

exec nexus start
