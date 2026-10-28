#!/usr/bin/env bash
# Fails if a build would pick up VITE_CREATURE_COUNT. Any build honours it when it is set at build
# time (ADR 0016 §10), so the release workflow runs this before building the published installer.
# Vite reads it from the environment and from the .env files next to the app's vite.config.ts.
set -euo pipefail

if [ -n "${VITE_CREATURE_COUNT+set}" ]; then
  echo "::error::VITE_CREATURE_COUNT is set in the environment; a release build must not override the creature count"
  exit 1
fi
if grep -l "VITE_CREATURE_COUNT" apps/desktop/.env* 2>/dev/null; then
  echo "::error::The .env files above set VITE_CREATURE_COUNT; a release build must not override the creature count"
  exit 1
fi
echo "VITE_CREATURE_COUNT is unset"
