#!/usr/bin/env bash
#
# Builds the ATAK OpenMapTiles-conformant NZ vector basemap as a single MBTiles.
#
# Two variants:
#   with 3D buildings     pass --heights <nz-building-heights.pmtiles>
#   without 3D buildings  omit --heights
#
# Optionally also embeds a `housenumber` layer:
#   pass --addresses to include LINZ address points (adds ~60MB uncompressed
#   nationally; off by default -- see the "why housenumbers are opt-in" note
#   further down and the --addresses entry in usage()).
#
# The building layer (and the housenumber layer, when requested) is tiled in a
# SEPARATE pass at z16 only, then joined. Two reasons: ATAK's bundled OMT style
# hides `building`/`housenumber` below z16/z18 respectively, evaluated against
# map zoom rather than tile zoom, so lower/literal-z18 tiles would be dead
# weight or would strand the layer with no basemap underneath; and setting a
# per-feature tippecanoe.minzoom instead triggers large `dropped_by_rate`
# counts that discard ~99% of the features (confirmed for buildings).
#
# Requires: tippecanoe + tile-join (apt install tippecanoe), node >= 22, and
#           `npm install` having been run in this directory.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LINZ=""
HEIGHTS=""
ADDRESSES=0
OUT=""
BBOX=""                            # empty = whole LINZ archive
MINZOOM=0
MAXZOOM=16
WORKDIR=""
KEEP_WORK=0

usage() {
  cat <<'EOF'
usage: build.sh --linz <linz.mbtiles> [--heights <heights.pmtiles>] [options]

  --linz PATH       LINZ topographic MBTiles, Shortbread schema        [required]
  --heights PATH    nz-building-heights.pmtiles. Omit to build the
                    basemap WITHOUT 3D buildings.
  --addresses       also embed a `housenumber` layer from LINZ address
                    points. Off by default: ATAK's bundled OMT style only
                    draws housenumbers above map zoom 18 (an extremely tight
                    zoom, closer to "read individual letterboxes" than
                    normal navigation), so the payoff is narrow. Adds
                    ~60MB uncompressed nationally -- cheap, but not free,
                    and not worth it if nobody will zoom in that far.
  --out PATH        output MBTiles  [default: nz-omt-buildings.mbtiles
                    with --heights, otherwise nz-omt.mbtiles]
  --bbox W,S,E,N    restrict to an area. DEFAULT IS THE WHOLE LINZ ARCHIVE,
                    which is what you want: a lon/lat bbox cannot express a
                    region crossing the antimeridian, and the archive does
                    cross it (Chatham Islands sit near 176.5W). A hardcoded
                    NZ bbox silently drops the Chathams, the subantarctic
                    islands and the Realm territories, for a saving of only
                    0.7% -- those tiles are nearly all empty ocean.
  --minzoom N       [default: 0, matches manifest numLevels 17]
  --maxzoom N       [default: 16]
  --workdir DIR     scratch dir for intermediates [default: mktemp]
  --keep-work       do not delete the scratch dir on success

examples:
  # national, with 3D buildings
  ./build.sh --linz linz-vector-tiles.mbtiles \
             --heights ../../../CloudTAK/data/nz-building-heights.pmtiles

  # national, with 3D buildings AND housenumbers
  ./build.sh --linz linz-vector-tiles.mbtiles \
             --heights ../../../CloudTAK/data/nz-building-heights.pmtiles \
             --addresses

  # national, no buildings
  ./build.sh --linz linz-vector-tiles.mbtiles

  # quick Wellington smoke test
  ./build.sh --linz linz-vector-tiles.mbtiles \
             --heights ../../../CloudTAK/data/nz-building-heights.pmtiles \
             --bbox 174.765,-41.305,174.800,-41.270 --minzoom 12 \
             --out wellington-omt.mbtiles
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --linz)     LINZ="$2"; shift 2 ;;
    --heights)  HEIGHTS="$2"; shift 2 ;;
    --addresses) ADDRESSES=1; shift ;;
    --out)      OUT="$2"; shift 2 ;;
    --bbox)     BBOX="$2"; shift 2 ;;
    --minzoom)  MINZOOM="$2"; shift 2 ;;
    --maxzoom)  MAXZOOM="$2"; shift 2 ;;
    --workdir)  WORKDIR="$2"; shift 2 ;;
    --keep-work) KEEP_WORK=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

[[ -n "$LINZ" ]] || { echo "error: --linz is required" >&2; usage; exit 1; }
[[ -f "$LINZ" ]] || { echo "error: no such file: $LINZ" >&2; exit 1; }
if [[ -n "$HEIGHTS" && ! -f "$HEIGHTS" ]]; then
  echo "error: no such file: $HEIGHTS" >&2; exit 1
fi

for tool in tippecanoe tile-join node sqlite3; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH" >&2; exit 1; }
done
[[ -d "$HERE/node_modules" ]] || { echo "error: run 'npm install' in $HERE first" >&2; exit 1; }

if [[ -z "$OUT" ]]; then
  if [[ -n "$HEIGHTS" ]]; then OUT="nz-omt-buildings.mbtiles"; else OUT="nz-omt.mbtiles"; fi
fi

if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$(mktemp -d -t nz-omt-XXXXXX)"
  CLEANUP=1
else
  mkdir -p "$WORKDIR"
  CLEANUP=0
fi
[[ "$KEEP_WORK" == "1" ]] && CLEANUP=0

echo "=============================================================="
echo " LINZ source : $LINZ"
echo " heights     : ${HEIGHTS:-<none, building layer will be omitted>}"
echo " addresses   : $([[ "$ADDRESSES" == "1" ]] && echo "included (housenumber layer)" || echo "<omitted, pass --addresses to include>")"
echo " bbox        : ${BBOX:-<whole LINZ archive>}"
echo " zooms       : $MINZOOM..$MAXZOOM"
echo " output      : $OUT"
echo " workdir     : $WORKDIR"
echo "=============================================================="

# LINZ's own deepest zoom. Every output zoom at or below this is built from the
# matching LINZ zoom, so we inherit LINZ's per-zoom generalisation instead of
# re-simplifying z15 detail all the way down to z0. That matters for two reasons:
#
#   quality -- tippecanoe's low-zoom thinning is density-based, not semantic, so
#              it may drop a motorway and keep a farm track.
#   feasibility -- re-tiling the whole country from z15 detail puts ~3.4M
#              features into tile 0/0/0, which blows tippecanoe's 500 KB and
#              200k-feature limits outright ("No zoom levels were successfully
#              written").
#
# Output zooms deeper than this are overzoomed from it (LINZ stops at 15, but
# ATAK's OMT style only draws `building` at z16+, so z16 base coverage is
# required or roads and water vanish exactly where buildings appear).
LINZ_MAX="$(sqlite3 "$LINZ" "select value from metadata where name='maxzoom'")"
[[ -n "$LINZ_MAX" ]] || { echo "error: could not read maxzoom from $LINZ" >&2; exit 1; }
echo " LINZ maxzoom: $LINZ_MAX"

PARTS=()

echo
echo "[1/3] translating and tiling base layers, one zoom at a time ..."
for (( z=MINZOOM; z<=MAXZOOM; z++ )); do
  if (( z <= LINZ_MAX )); then
    SRC_Z="$z"; NOTE="native"
  else
    SRC_Z="$LINZ_MAX"; NOTE="overzoomed from z$LINZ_MAX"
  fi

  GJ="$WORKDIR/base-z$z.geojsonl"
  MB="$WORKDIR/base-z$z.mbtiles"

  echo
  echo "  --- z$z ($NOTE) ---"
  node "$HERE/translate.js" --linz "$LINZ" ${BBOX:+--bbox "$BBOX"} \
       --linz-zoom "$SRC_Z" --only linz > "$GJ"

  if [[ ! -s "$GJ" ]]; then
    echo "      no features at z$z, skipping"
    rm -f "$GJ"
    continue
  fi

  # -Z z -z z keeps basezoom == maxzoom == minzoom, which also means tippecanoe
  # never applies its drop-rate ladder. --drop-densest-as-needed is a safety net
  # for any single tile that still overflows; it is a no-op when nothing does.
  # --no-tile-compression matches what is verified on-device for sideloaded
  # MBTiles; tiles served over HTTP may be gzipped instead, since ATAK's tile
  # client uses OkHttp and decompresses transparently.
  tippecanoe -o "$MB" \
    -Z "$z" -z "$z" \
    --no-tile-compression \
    --drop-densest-as-needed \
    --progress-interval=10 \
    --force \
    "$GJ"

  PARTS+=("$MB")
  rm -f "$GJ"   # reclaim scratch space as we go
done

echo
echo "[2/4] translating and tiling buildings ..."
if [[ -n "$HEIGHTS" ]]; then
  GJ="$WORKDIR/bldg.geojsonl"
  node "$HERE/translate.js" --linz "$LINZ" --heights "$HEIGHTS" ${BBOX:+--bbox "$BBOX"} \
       --only heights > "$GJ"
  if [[ -s "$GJ" ]]; then
    echo "      $(wc -l < "$GJ") building features"
    # buildings live only at MAXZOOM: the bundled OMT style hides `building`
    # below z16, so lower zooms would be dead weight
    tippecanoe -o "$WORKDIR/bldg.mbtiles" \
      -Z "$MAXZOOM" -z "$MAXZOOM" \
      --no-tile-compression \
      --drop-densest-as-needed \
      --progress-interval=10 \
      --force \
      "$GJ"
    PARTS+=("$WORKDIR/bldg.mbtiles")
    rm -f "$GJ"
  else
    echo "      no building features found"
  fi
else
  echo "      skipped (no --heights given)"
fi

echo
echo "[3/4] translating and tiling addresses ..."
if [[ "$ADDRESSES" == "1" ]]; then
  GJ="$WORKDIR/addr.geojsonl"
  node "$HERE/translate.js" --linz "$LINZ" --addresses ${BBOX:+--bbox "$BBOX"} \
       --only addresses > "$GJ"
  if [[ -s "$GJ" ]]; then
    echo "      $(wc -l < "$GJ") address features"
    # Same reasoning as buildings: `housenumber` only draws above map zoom 18
    # in ATAK's bundled style, evaluated against camera zoom not tile zoom, so
    # it must be STORED at MAXZOOM (z16, where the rest of the basemap lives)
    # and rely on the renderer's own overzoom scaling past z18.
    tippecanoe -o "$WORKDIR/addr.mbtiles" \
      -Z "$MAXZOOM" -z "$MAXZOOM" \
      --no-tile-compression \
      --drop-densest-as-needed \
      --progress-interval=10 \
      --force \
      "$GJ"
    PARTS+=("$WORKDIR/addr.mbtiles")
    rm -f "$GJ"
  else
    echo "      no address features found"
  fi
else
  echo "      skipped (pass --addresses to include)"
fi

echo
echo "[4/4] joining ${#PARTS[@]} parts ..."
rm -f "$OUT"
tile-join -o "$OUT" --no-tile-compression --force "${PARTS[@]}"

echo
echo "=============================================================="
echo " built: $OUT  ($(du -h "$OUT" | cut -f1))"
node "$HERE/verify.js" "$OUT" || true
echo "=============================================================="

if [[ "$CLEANUP" == "1" ]]; then
  rm -rf "$WORKDIR"
else
  echo "intermediates kept in $WORKDIR"
fi
