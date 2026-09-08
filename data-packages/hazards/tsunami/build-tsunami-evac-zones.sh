#!/usr/bin/env bash
#
# build-tsunami-evac-zones.sh
# ---------------------------
# End-to-end: fetch the NEMA national tsunami evacuation-zone layer, simplify +
# style it into a single KMZ, wrap it as a TAK Mission Package, and upload it to
# CloudTAK as "Hazards - NZ - Tsunami Evacuation Zones".
#
# The source ArcGIS service is only ever read.
#
# Config comes from data-packages/hazards/tsunami/.env (git-ignored). Copy the
# template:
#   cp data-packages/hazards/tsunami/.env.example data-packages/hazards/tsunami/.env
#
# Usage:
#   bash data-packages/hazards/tsunami/build-tsunami-evac-zones.sh
#   DRY_RUN=1 bash .../build-tsunami-evac-zones.sh    # build KMZ + package, no upload
#   KEEP_WORK=1 bash .../build-tsunami-evac-zones.sh  # keep intermediate files
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
# The packaging tool lives with the flooding pipeline.
CREATE_PKG="$SCRIPT_DIR/../flooding/create_tak_package.py"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found. Copy .env.example to .env and fill it in." >&2
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${SOURCE_URL:?SOURCE_URL missing in .env}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_WORK="${KEEP_WORK:-0}"
PKG_NAME="Hazards - NZ - Tsunami Evacuation Zones"

for tool in python3 ogr2ogr; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found on PATH." >&2; exit 1; }
done

WORK="$SCRIPT_DIR/work"
mkdir -p "$WORK"
KMZ="$WORK/NZ-Tsunami-Evacuation-Zones.kmz"

echo "=========================================================="
echo " Tsunami evacuation-zone package builder"
echo "   Source : $SOURCE_URL"
echo "   Package: $PKG_NAME"
echo "   Dry run: $([[ "$DRY_RUN" == "1" ]] && echo yes || echo no)"
echo "=========================================================="

# --- 1. Build the styled, simplified KMZ --------------------------------
keep_flag=()
[[ "$KEEP_WORK" == "1" ]] && keep_flag=(--keep-work)
# Geometry simplify tolerance in degrees. Default ~0.0001° (≈11 m) keeps the
# file small; set SIMPLIFY_DEG=0 for full-accuracy (unsimplified) geometry.
SIMPLIFY_DEG="${SIMPLIFY_DEG:-0.0001}"
python3 "$SCRIPT_DIR/build_kmz.py" \
    --source-url "$SOURCE_URL" \
    --out "$KMZ" \
    --simplify-deg "$SIMPLIFY_DEG" \
    --doc-name "NZ Tsunami Evacuation Zones" \
    "${keep_flag[@]}"

# --- 2. Package + upload -------------------------------------------------
upload_flags=()
if [[ "$DRY_RUN" == "1" ]]; then
    echo "(dry run — building package only, no upload)"
else
    : "${CLOUDTAK_URL:?CLOUDTAK_URL missing in .env}"
    : "${CLOUDTAK_TOKEN:?CLOUDTAK_TOKEN missing in .env}"
    # --replace deletes any existing same-named package first, so re-running
    # refreshes the national package rather than creating a duplicate.
    upload_flags=(--upload --replace --url "$CLOUDTAK_URL" --token "$CLOUDTAK_TOKEN")
    [[ -n "${CLOUDTAK_CHANNELS:-}" ]] && upload_flags+=(--channels "$CLOUDTAK_CHANNELS")
fi

python3 "$CREATE_PKG" "$KMZ" \
    --output "$WORK/${PKG_NAME}.zip" \
    --name "$PKG_NAME" \
    --keywords Hazards NZ Tsunami "Evacuation Zones" NEMA \
    "${upload_flags[@]}"

# --- 3. Cleanup ----------------------------------------------------------
if [[ "$KEEP_WORK" == "1" ]]; then
    echo "KEEP_WORK=1 — left intermediate files in $WORK"
else
    rm -rf "$WORK"
fi

echo "Done."
