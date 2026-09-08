#!/usr/bin/env bash
#
# build-catchment-index.sh
# ------------------------
# Build a single KMZ that outlines every flood-map catchment (the data-coverage
# footprint of each hmax raster) labelled "<Region> - <Catchment>", so users can
# quickly locate a catchment by name. Published as one national package:
#
#   Hazards - NZ - Flood Map Catchments
#
# It reads the same per-region source zips as the flood pipeline (read-only) and
# uses gdal_footprint to derive each catchment outline (reprojected to WGS84).
#
# Config comes from data-packages/hazards/flooding/.env (shared with the flood
# pipeline).
#
# Usage:
#   bash data-packages/hazards/flooding/build-catchment-index.sh                # all regions
#   bash data-packages/hazards/flooding/build-catchment-index.sh Nelson Otago   # named regions
#   DRY_RUN=1 bash ...   # build KMZ + package, no upload
#   KEEP_WORK=1 bash ... # keep intermediates
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
CREATE_PKG="$SCRIPT_DIR/create_tak_package.py"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found (copy .env.example)." >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${SOURCE_BUCKET:?}"; : "${SOURCE_PREFIX:?}"; : "${AWS_PROFILE:?}"; : "${AWS_REGION:?}"
SOURCE_PREFIX="${SOURCE_PREFIX%/}/"
DRY_RUN="${DRY_RUN:-0}"
KEEP_WORK="${KEEP_WORK:-0}"
PKG_NAME="Hazards - NZ - Flood Map Catchments"
# Simplify tolerance for footprint outlines (degrees, ~0.0005° ≈ 55m). These are
# locator outlines, so coarse is fine and keeps the file small.
SIMPLIFY_DEG="${SIMPLIFY_DEG:-0.0005}"

for tool in aws unzip gdal_footprint ogr2ogr python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: '$tool' not found." >&2; exit 1; }
done

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")
S3_BASE="s3://${SOURCE_BUCKET}/${SOURCE_PREFIX}"
WORK="$SCRIPT_DIR/catchment-work"
rm -rf "$WORK"; mkdir -p "$WORK/footprints"

echo "=========================================================="
echo " Flood-map catchment index builder"
echo "   Source : ${S3_BASE}"
echo "   Package: ${PKG_NAME}"
echo "   Dry run: $([[ "$DRY_RUN" == "1" ]] && echo yes || echo no)"
echo "=========================================================="

# --- Determine regions -----------------------------------------------------
declare -a REGIONS=()
if [[ $# -gt 0 ]]; then
    REGIONS=("$@")
else
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        key="$(sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} +[0-9:]+ +[0-9]+ +//' <<<"$line")"
        [[ "$key" == *_0C.zip ]] || continue
        REGIONS+=("${key%_0C.zip}")
    done < <("${AWS[@]}" s3 ls "$S3_BASE" || true)
fi
echo "Regions: ${REGIONS[*]}"

# --- Per region: extract hmax, footprint each catchment --------------------
extract_location() {
    # <MapName> from filename: token(s) before _<digits>y, underscores -> spaces
    local base="$1"
    if [[ "$base" =~ ^(.*)_[0-9]+y ]]; then
        echo "${BASH_REMATCH[1]//_/ }"
    else
        echo "${base//_/ }"
    fi
}

for region in "${REGIONS[@]}"; do
    echo ""
    echo "----- $region -----"
    rdir="$WORK/$region"
    mkdir -p "$rdir/hmax"
    zip_key="${region}_0C.zip"
    echo "  downloading ${zip_key} …"
    if ! "${AWS[@]}" s3 cp "${S3_BASE}${zip_key}" "$rdir/$zip_key" --only-show-errors; then
        echo "  WARNING: download failed for $region — skipping." >&2
        continue
    fi
    unzip -o -j "$rdir/$zip_key" '*/hmax/*.tif' -d "$rdir/hmax" >/dev/null 2>&1 || true

    for tif in "$rdir"/hmax/*.tif; do
        [[ -e "$tif" ]] || continue
        base="$(basename "$tif" .tif)"
        loc="$(extract_location "$base")"
        fp="$WORK/footprints/$(printf '%s' "${region}__${base}" | tr -c 'A-Za-z0-9._-' '_').geojson"
        # Footprint of valid data, reprojected to WGS84.
        if gdal_footprint -t_srs EPSG:4326 "$tif" "$fp" >/dev/null 2>&1; then
            # Tag each feature with region + catchment via a sidecar json we merge later.
            python3 - "$fp" "$region" "$loc" <<'PY'
import json, sys
path, region, loc = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
for f in d.get("features", []):
    f.setdefault("properties", {})
    f["properties"] = {"Region": region, "Catchment": loc,
                       "Label": f"{region} - {loc}"}
json.dump(d, open(path, "w"))
PY
            echo "    footprint: $region - $loc"
        else
            echo "    WARNING: footprint failed for $base" >&2
        fi
    done

    # Free the region's rasters/zip immediately (peak disk = one region).
    rm -rf "$rdir"
done

# --- Merge footprints, simplify, style into KMZ ----------------------------
echo ""
echo "Merging footprints → styled KMZ …"
python3 "$SCRIPT_DIR/build_catchment_kmz.py" \
    --footprints-dir "$WORK/footprints" \
    --out "$WORK/NZ-Flood-Map-Catchments.kmz" \
    --simplify-deg "$SIMPLIFY_DEG" \
    --doc-name "NZ Flood Map Catchments"

# --- Package + upload ------------------------------------------------------
upload_flags=()
if [[ "$DRY_RUN" == "1" ]]; then
    echo "(dry run — building package only, no upload)"
else
    : "${CLOUDTAK_URL:?}"; : "${CLOUDTAK_TOKEN:?}"
    upload_flags=(--upload --replace --url "$CLOUDTAK_URL" --token "$CLOUDTAK_TOKEN")
    [[ -n "${CLOUDTAK_CHANNELS:-}" ]] && upload_flags+=(--channels "$CLOUDTAK_CHANNELS")
fi

python3 "$CREATE_PKG" "$WORK/NZ-Flood-Map-Catchments.kmz" \
    --output "$WORK/${PKG_NAME}.zip" \
    --name "$PKG_NAME" \
    --keywords Hazards NZ Flood Catchments Index \
    "${upload_flags[@]}"

if [[ "$KEEP_WORK" == "1" ]]; then
    echo "KEEP_WORK=1 — left intermediates in $WORK"
else
    rm -rf "$WORK"
fi
echo "Done."
