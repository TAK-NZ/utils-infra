#!/usr/bin/env bash
#
# process-flood-hazard-maps.sh
# ----------------------------
# End-to-end pipeline that turns the per-region flood-hazard source zips in S3
# into coloured overlays and uploads them to CloudTAK as Data Packages, one
# package per catchment map.
#
# For each region it:
#   1. Downloads   <Region>_0C.zip from the source S3 bucket (read-only).
#   2. Extracts    only the hmax/ (water-depth) GeoTIFFs.
#   3. Converts    each GeoTIFF to a coloured RGBA EPSG:4326 overlay.
#   4. Packages    each overlay into a TAK Mission Package and uploads it to
#                  CloudTAK named "Hazards - <Region> - Flood - <Map> (100yr)".
#   5. Cleans up   every interim file for that region before moving to the next,
#                  so peak local disk use stays to roughly one region at a time.
#
# The S3 source is only ever read (aws s3 ls / cp). It is never modified.
#
# Configuration comes from flooding/.env (git-ignored). Copy the template:
#   cp flooding/.env.example flooding/.env  &&  $EDITOR flooding/.env
#
# Usage (run from the repo root or anywhere — paths are resolved to this script):
#   bash flooding/process-flood-hazard-maps.sh                 # all regions
#   bash flooding/process-flood-hazard-maps.sh Nelson Tasman   # named regions only
#   DRY_RUN=1 bash flooding/process-flood-hazard-maps.sh       # build but don't upload
#   KEEP_WORK=1 bash flooding/process-flood-hazard-maps.sh     # keep interim files
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve paths and load configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: $ENV_FILE not found." >&2
    echo "       Copy the template and fill it in:" >&2
    echo "         cp flooding/.env.example flooding/.env" >&2
    exit 1
fi

# Load .env. `set -a` exports every assignment so child processes inherit them.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# --- Validate required configuration ---------------------------------------
missing=()
for var in SOURCE_BUCKET SOURCE_PREFIX AWS_PROFILE AWS_REGION CLOUDTAK_URL CLOUDTAK_TOKEN; do
    if [[ -z "${!var:-}" ]]; then
        missing+=("$var")
    fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ERROR: missing required config in $ENV_FILE: ${missing[*]}" >&2
    exit 1
fi

# Normalise: ensure the prefix ends with a single slash, strip trailing slash on URL.
SOURCE_PREFIX="${SOURCE_PREFIX%/}/"
CLOUDTAK_URL="${CLOUDTAK_URL%/}"

# Channels may be empty; pass through verbatim (may contain spaces).
CLOUDTAK_CHANNELS="${CLOUDTAK_CHANNELS:-}"

DRY_RUN="${DRY_RUN:-0}"
KEEP_WORK="${KEEP_WORK:-0}"

WORK_DIR="$SCRIPT_DIR/work"

AWS=(aws --profile "$AWS_PROFILE" --region "$AWS_REGION")
S3_BASE="s3://${SOURCE_BUCKET}/${SOURCE_PREFIX}"

# ---------------------------------------------------------------------------
# Preflight — required tools
# ---------------------------------------------------------------------------
for tool in aws unzip python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required tool '$tool' not found on PATH." >&2
        exit 1
    fi
done

echo "=========================================================="
echo " Flood hazard-map pipeline"
echo "   Source : ${S3_BASE}"
echo "   Target : ${CLOUDTAK_URL}"
echo "   Channel: ${CLOUDTAK_CHANNELS:-<none>}"
echo "   Dry run: $([[ "$DRY_RUN" == "1" ]] && echo yes || echo no)"
echo "=========================================================="

# ---------------------------------------------------------------------------
# Determine the list of regions to process
# ---------------------------------------------------------------------------
# Region source objects are named "<Region>_0C.zip". If region names are passed
# on the command line we process just those; otherwise we list the bucket.
declare -a REGIONS=()

if [[ $# -gt 0 ]]; then
    REGIONS=("$@")
    echo "Processing ${#REGIONS[@]} region(s) from arguments: ${REGIONS[*]}"
else
    echo "Listing regions under ${S3_BASE} …"
    # `aws s3 ls` prints "<date> <time> <size> <key>". The key can contain
    # spaces and apostrophes (e.g. "Bay of Plenty_0C.zip", "Hawke's Bay_0C.zip"),
    # so we must NOT split on whitespace — strip the first three columns and
    # keep the rest of the line verbatim as the key.
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        # Strip the leading "YYYY-MM-DD  HH:MM:SS   <size>  " columns (spacing
        # between them varies), leaving the key verbatim — which may contain
        # spaces and apostrophes.
        key="$(sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} +[0-9:]+ +[0-9]+ +//' <<<"$line")"
        [[ "$key" == *_0C.zip ]] || continue
        region="${key%_0C.zip}"
        REGIONS+=("$region")
    done < <("${AWS[@]}" s3 ls "$S3_BASE" || true)

    if [[ ${#REGIONS[@]} -eq 0 ]]; then
        echo "ERROR: no <Region>_0C.zip objects found under ${S3_BASE}" >&2
        exit 1
    fi
    echo "Found ${#REGIONS[@]} region(s): ${REGIONS[*]}"
fi

# ---------------------------------------------------------------------------
# Per-region processing
# ---------------------------------------------------------------------------
total_uploaded=0
declare -a failed_regions=()

process_region() {
    local region="$1"
    local region_work="$WORK_DIR/$region"
    local zip_key="${region}_0C.zip"
    local zip_local="$region_work/${zip_key}"

    echo ""
    echo "----------------------------------------------------------"
    echo " Region: $region"
    echo "----------------------------------------------------------"

    rm -rf "$region_work"
    mkdir -p "$region_work/hmax" "$region_work/overlays"

    # --- 1. Download the source zip (read-only copy from S3) ---------------
    echo "  [1/5] Downloading s3://${SOURCE_BUCKET}/${SOURCE_PREFIX}${zip_key} …"
    if ! "${AWS[@]}" s3 cp "${S3_BASE}${zip_key}" "$zip_local" --only-show-errors; then
        echo "  ERROR: download failed for $region — skipping." >&2
        return 1
    fi

    # --- 2. Extract only the hmax/ GeoTIFFs --------------------------------
    # Zip layout: "<Region> Region/hmax/<Map>_100y_..._hmax.tif"
    # -j junks the internal paths so everything lands flat in hmax/.
    echo "  [2/5] Extracting hmax GeoTIFFs …"
    if ! unzip -o -j "$zip_local" '*/hmax/*.tif' -d "$region_work/hmax" >/dev/null; then
        echo "  ERROR: no hmax/*.tif found in $zip_key — skipping." >&2
        return 1
    fi

    local tif_count
    tif_count=$(find "$region_work/hmax" -maxdepth 1 -name '*.tif' | wc -l | tr -d ' ')
    if [[ "$tif_count" -eq 0 ]]; then
        echo "  ERROR: extraction produced no .tif files for $region — skipping." >&2
        return 1
    fi
    echo "        $tif_count hmax GeoTIFF(s)."

    # --- 3. Convert each GeoTIFF to a coloured overlay ---------------------
    echo "  [3/5] Converting to coloured EPSG:4326 overlays …"
    local tif base
    for tif in "$region_work"/hmax/*.tif; do
        base="$(basename "$tif" .tif)"
        python3 "$SCRIPT_DIR/geotiff_to_flood_overlay.py" \
            "$tif" "$region_work/overlays/${base}_overlay.tif" \
            | sed 's/^/        /'
    done

    # --- 4. Package + upload each overlay ----------------------------------
    # create_tak_package.py fills {location} with the map name (token before
    # _100y). The region is baked into the name/keywords for this invocation.
    echo "  [4/5] Packaging and uploading to CloudTAK …"
    local upload_flags=()
    if [[ "$DRY_RUN" == "1" ]]; then
        echo "        (dry run — building packages only, no upload)"
    else
        # --replace makes re-runs idempotent: any existing package with the
        # same name is deleted before the new one is uploaded, so re-running a
        # region refreshes rather than duplicates its maps.
        upload_flags=(--upload --replace --url "$CLOUDTAK_URL" --token "$CLOUDTAK_TOKEN")
        if [[ -n "$CLOUDTAK_CHANNELS" ]]; then
            upload_flags+=(--channels "$CLOUDTAK_CHANNELS")
        fi
    fi

    python3 "$SCRIPT_DIR/create_tak_package.py" \
        --input-dir "$region_work/overlays" \
        --one-per-file \
        --output-dir "$region_work/packages" \
        --name "Hazards - ${region} - Flood - {location} (100yr)" \
        --keywords Hazards "$region" Flood "{location}" "100y Inundation" \
        "${upload_flags[@]}" \
        | sed 's/^/        /'
    # ${PIPESTATUS[0]} is create_tak_package.py's exit code (the pipe through
    # sed would otherwise mask it). Non-zero => at least one upload failed, so
    # this region is a failure rather than a silent partial success.
    local pkg_status="${PIPESTATUS[0]}"

    local pkg_count
    pkg_count=$(find "$region_work/packages" -maxdepth 1 -name '*.zip' 2>/dev/null | wc -l | tr -d ' ')
    total_uploaded=$((total_uploaded + pkg_count))

    if [[ "$pkg_status" -ne 0 ]]; then
        echo "  ERROR: packaging/upload reported failures for $region (exit $pkg_status)." >&2
        [[ "$KEEP_WORK" != "1" ]] && rm -rf "$region_work"
        return 1
    fi

    # --- 5. Clean up interim files for this region -------------------------
    if [[ "$KEEP_WORK" == "1" ]]; then
        echo "  [5/5] KEEP_WORK=1 — leaving interim files in $region_work"
    else
        echo "  [5/5] Cleaning up interim files for $region …"
        rm -rf "$region_work"
    fi

    echo "  Done: $region ($pkg_count package(s))."
    return 0
}

for region in "${REGIONS[@]}"; do
    if ! process_region "$region"; then
        failed_regions+=("$region")
    fi
done

# Remove the top-level work dir if empty and not explicitly kept.
if [[ "$KEEP_WORK" != "1" ]]; then
    rmdir "$WORK_DIR" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=========================================================="
echo " Summary"
echo "   Regions processed : $(( ${#REGIONS[@]} - ${#failed_regions[@]} )) / ${#REGIONS[@]}"
echo "   Packages built    : $total_uploaded"
if [[ ${#failed_regions[@]} -gt 0 ]]; then
    echo "   FAILED regions    : ${failed_regions[*]}"
fi
echo "=========================================================="

if [[ ${#failed_regions[@]} -gt 0 ]]; then
    exit 1
fi
