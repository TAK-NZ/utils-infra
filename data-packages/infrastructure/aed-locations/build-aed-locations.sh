#!/usr/bin/env bash
#
# build-aed-locations.sh
# ------------------------
# End-to-end: fetch the current AED location list from aedlocations.co.nz,
# build a styled KMZ, wrap it as a TAK Mission Package, and upload it to
# CloudTAK as "Infrastructure - NZ - AED Locations".
#
# PENDING ABLETECH APPROVAL -- see README.md in this directory before
# running this against anything other than a private/demo CloudTAK
# instance. Do NOT wire this into a scheduler (GitHub Actions or otherwise)
# until that approval is confirmed -- run manually only.
#
# Config comes from data-packages/infrastructure/aed-locations/.env
# (git-ignored). Copy the template:
#   cp data-packages/infrastructure/aed-locations/.env.example \
#      data-packages/infrastructure/aed-locations/.env
#
# Usage:
#   bash data-packages/infrastructure/aed-locations/build-aed-locations.sh
#   DRY_RUN=1 bash .../build-aed-locations.sh    # build KMZ + package, no upload
#   KEEP_WORK=1 bash .../build-aed-locations.sh  # keep intermediate files
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
# The packaging tool lives with the flooding pipeline -- shared across every
# data-packages pipeline, not flooding-specific.
CREATE_PKG="$SCRIPT_DIR/../../hazards/flooding/create_tak_package.py"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found. Copy .env.example to .env and fill it in." >&2
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

DRY_RUN="${DRY_RUN:-0}"
KEEP_WORK="${KEEP_WORK:-0}"
PKG_NAME="Infrastructure - NZ - AED Locations"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: 'python3' not found on PATH." >&2; exit 1; }

WORK="$SCRIPT_DIR/work"
mkdir -p "$WORK"
KMZ="$WORK/AED-Locations.kmz"

echo "=========================================================="
echo " AED locations package builder"
echo "   Package: $PKG_NAME"
echo "   Dry run: $([[ "$DRY_RUN" == "1" ]] && echo yes || echo no)"
echo "=========================================================="

# --- 1. Build the KMZ -----------------------------------------------------
python3 "$SCRIPT_DIR/build_kmz.py" \
    --out "$KMZ" \
    --doc-name "AED Locations (NZ)"

# --- 2. Package + upload ---------------------------------------------------
upload_flags=()
if [[ "$DRY_RUN" == "1" ]]; then
    echo "(dry run -- building package only, no upload)"
else
    : "${CLOUDTAK_URL:?CLOUDTAK_URL missing in .env}"
    : "${CLOUDTAK_TOKEN:?CLOUDTAK_TOKEN missing in .env}"
    # --replace deletes any existing same-named package first, so re-running
    # refreshes the package rather than creating a duplicate.
    upload_flags=(--upload --replace --url "$CLOUDTAK_URL" --token "$CLOUDTAK_TOKEN")
    [[ -n "${CLOUDTAK_CHANNELS:-}" ]] && upload_flags+=(--channels "$CLOUDTAK_CHANNELS")
fi

python3 "$CREATE_PKG" "$KMZ" \
    --output "$WORK/${PKG_NAME}.zip" \
    --name "$PKG_NAME" \
    --keywords Infrastructure NZ AED Defibrillator Medical \
    "${upload_flags[@]}"

# --- 3. Cleanup --------------------------------------------------------------
if [[ "$KEEP_WORK" == "1" ]]; then
    echo "KEEP_WORK=1 -- left intermediate files in $WORK"
else
    rm -rf "$WORK"
fi

echo "Done."
