#!/usr/bin/env python3
"""Generate LINZ Marine Charts mbtiles file from LINZ Basemaps API.

Uses a tiered approach:
- z4-z8: Full EEZ coverage (overview navigation, shipping lanes)
- z9-z12: Coastal areas only (harbours, approaches, nearshore)

The coastal filter uses NZ territorial authority boundaries with a buffer
to include port approaches and nearshore waters.

Usage:
    # Generate NZ marine charts (tiered)
    python3 generate-marine-mbtiles.py --api-key YOUR_LINZ_KEY

    # Full EEZ at all zooms (no coastal filter)
    python3 generate-marine-mbtiles.py --api-key YOUR_LINZ_KEY --no-coastal-filter

    # Custom area
    python3 generate-marine-mbtiles.py --api-key YOUR_LINZ_KEY --bbox 174.0,-42.0,176.0,-40.0

    # Show tile count estimate
    python3 generate-marine-mbtiles.py --dry-run
"""

import argparse
import json
import math
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LAND_BOUNDARIES_FILE = os.path.join(SCRIPT_DIR, "nz-land-boundaries.geojson")

BASE_URL = "https://basemaps.linz.govt.nz/v1/tiles/charts/WebMercatorQuad"
TILE_FORMAT = "webp"
DEFAULT_MIN_ZOOM = 1
DEFAULT_MAX_ZOOM = 14
COASTAL_ZOOM_THRESHOLD = 10  # z10-z12 uses coastal filter (50km buffer)
HARBOUR_ZOOM_THRESHOLD = 13  # z13-z14 uses harbour filter (15km buffer)

# NZ EEZ (from LINZ 200 Mile Exclusive Economic Zone Outer Limits)
# 160.61°E to 188.80°E (171.2°W), 55.95°S to 25.89°S
# Split at antimeridian
NZ_MARITIME_BBOX_WEST = (160.0, -56.0, 180.0, -25.0)  # 160°E to 180°
NZ_MARITIME_BBOX_EAST = (-180.0, -56.0, -171.0, -25.0)  # 180° to 171°W

# Buffers around land for tiered coastal filtering
COASTAL_BUFFER_DEG = 0.5   # ~50km for z10-z12
HARBOUR_BUFFER_DEG = 0.15  # ~15km for z13-z14

# Land boundary data
_land_polygons = None
_land_bboxes = None


def load_land_boundaries():
    global _land_polygons, _land_bboxes
    if _land_polygons is not None:
        return
    with open(LAND_BOUNDARIES_FILE) as f:
        data = json.load(f)
    _land_polygons = []
    _land_bboxes = []
    for feat in data["features"]:
        geom = feat["geometry"]
        rings = []
        if geom["type"] == "MultiPolygon":
            for poly in geom["coordinates"]:
                rings.append(poly[0])
        elif geom["type"] == "Polygon":
            rings.append(geom["coordinates"][0])
        for ring in rings:
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            _land_bboxes.append((min(lons), min(lats), max(lons), max(lats)))
            _land_polygons.append(ring)


def point_in_ring(x, y, ring):
    n = len(ring)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def is_near_land(lon, lat, buffer=COASTAL_BUFFER_DEG):
    load_land_boundaries()
    for i, ring in enumerate(_land_polygons):
        bb = _land_bboxes[i]
        if lon < bb[0] - buffer or lon > bb[2] + buffer or lat < bb[1] - buffer or lat > bb[3] + buffer:
            continue
        if point_in_ring(lon, lat, ring):
            return True
    return False


def tile_corners(z, x, y):
    n = 2.0 ** z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return [(lon_w, lat_n), (lon_e, lat_n), (lon_e, lat_s), (lon_w, lat_s)]


def is_tile_near_coast(z, x, y, buffer=COASTAL_BUFFER_DEG):
    """Check if any corner of a tile is within buffer degrees of land."""
    load_land_boundaries()
    corners = tile_corners(z, x, y)
    for lon, lat in corners:
        if is_near_land(lon, lat, buffer):
            return True
    # Also check if any land bbox overlaps the tile bbox (for large tiles containing land)
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    tile_bb = (min(lons) - buffer, min(lats) - buffer,
               max(lons) + buffer, max(lats) + buffer)
    for bb in _land_bboxes:
        if (bb[0] <= tile_bb[2] and bb[2] >= tile_bb[0] and
                bb[1] <= tile_bb[3] and bb[3] >= tile_bb[1]):
            return True
    return False


def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)


def count_tiles(bboxes, min_zoom, max_zoom, use_coastal_filter):
    total = 0
    for bbox in bboxes:
        for z in range(min_zoom, max_zoom + 1):
            x_min, y_min = deg2num(bbox[3], bbox[0], z)
            x_max, y_max = deg2num(bbox[1], bbox[2], z)
            if not use_coastal_filter or z < COASTAL_ZOOM_THRESHOLD:
                total += (x_max - x_min + 1) * (y_max - y_min + 1)
            # Can't efficiently pre-count filtered tiles, skip for estimate
    return total


def init_mbtiles(db_path, name, bounds, min_zoom, max_zoom):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.execute("CREATE UNIQUE INDEX tiles_idx ON tiles (zoom_level, tile_column, tile_row)")
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute("CREATE UNIQUE INDEX metadata_idx ON metadata (name)")
    for k, v in [
        ("name", name),
        ("format", TILE_FORMAT),
        ("bounds", bounds),
        ("center", "174.0,-41.0,6"),
        ("minzoom", str(min_zoom)),
        ("maxzoom", str(max_zoom)),
        ("type", "baselayer"),
        ("description", f"{name} - LINZ Nautical Charts"),
        ("attribution", "LINZ CC BY 4.0"),
        ("version", "1.3"),
    ]:
        db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (k, v))
    db.commit()
    return db


def download_tiles(db, bboxes, api_key, min_zoom, max_zoom, use_coastal_filter):
    # Count tiles for progress (approximate for filtered)
    total_unfiltered = 0
    for bbox in bboxes:
        for z in range(min_zoom, max_zoom + 1):
            x_min, y_min = deg2num(bbox[3], bbox[0], z)
            x_max, y_max = deg2num(bbox[1], bbox[2], z)
            total_unfiltered += (x_max - x_min + 1) * (y_max - y_min + 1)

    downloaded = 0
    filtered = 0
    failed = 0
    processed = 0
    start = time.time()

    for bbox in bboxes:
        for z in range(min_zoom, max_zoom + 1):
            x_min, y_min = deg2num(bbox[3], bbox[0], z)
            x_max, y_max = deg2num(bbox[1], bbox[2], z)

            for x in range(x_min, x_max + 1):
                for y in range(y_min, y_max + 1):
                    # Tiered coastal filter for high zoom levels
                    if use_coastal_filter and z >= HARBOUR_ZOOM_THRESHOLD:
                        if not is_tile_near_coast(z, x, y, HARBOUR_BUFFER_DEG):
                            filtered += 1
                            continue
                    elif use_coastal_filter and z >= COASTAL_ZOOM_THRESHOLD:
                        if not is_tile_near_coast(z, x, y, COASTAL_BUFFER_DEG):
                            filtered += 1
                            continue

                    url = f"{BASE_URL}/{z}/{x}/{y}.{TILE_FORMAT}?api={api_key}"
                    try:
                        req = urllib.request.Request(url, headers={"User-Agent": "marine-mbtiles/1.0"})
                        data = urllib.request.urlopen(req, timeout=30).read()
                        tms_y = (2 ** z - 1) - y
                        db.execute(
                            "INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)",
                            (z, x, tms_y, data),
                        )
                        downloaded += 1
                    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                        failed += 1
                        print(f"\nFailed z{z}/{x}/{y}: {e}")

                    processed += 1
                    elapsed = time.time() - start
                    rate = processed / elapsed if elapsed > 0 else 0
                    # Estimate remaining (approximate since we don't know filtered count ahead)
                    sys.stdout.write(
                        f"\rz{z}: {downloaded} saved, {filtered} coastal-filtered, "
                        f"{failed} failed ({rate:.1f} t/s)  "
                    )
                    sys.stdout.flush()

            db.commit()

    return downloaded, filtered, failed


def main():
    parser = argparse.ArgumentParser(description="Generate LINZ Marine Charts mbtiles")
    parser.add_argument("--api-key", help="LINZ Basemaps API key (or set LINZ_API_KEY env var)")
    parser.add_argument("--bbox", help="Custom bbox: west,south,east,north (default: NZ maritime area)")
    parser.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    parser.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    parser.add_argument("--output", default="nz-marine-charts.mbtiles")
    parser.add_argument("--name", default="NZ Marine Charts")
    parser.add_argument("--no-coastal-filter", dest="use_coastal_filter", action="store_false",
                        default=True, help="Download all tiles (no coastal filter at high zooms)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("LINZ_API_KEY")
    if not api_key and not args.dry_run:
        parser.error("--api-key is required (or set LINZ_API_KEY env var)")

    if args.bbox:
        coords = tuple(float(x) for x in args.bbox.split(","))
        if len(coords) != 4:
            parser.error("--bbox must have 4 values: west,south,east,north")
        bboxes = [coords]
        bounds_str = args.bbox
    else:
        bboxes = [NZ_MARITIME_BBOX_WEST, NZ_MARITIME_BBOX_EAST]
        bounds_str = "160.0,-56.0,189.0,-25.0"

    total = count_tiles(bboxes, args.min_zoom, args.max_zoom, False)
    eez_low = count_tiles(bboxes, args.min_zoom, min(args.max_zoom, COASTAL_ZOOM_THRESHOLD - 1), False)
    coastal_tiles = count_tiles(bboxes, COASTAL_ZOOM_THRESHOLD, min(args.max_zoom, HARBOUR_ZOOM_THRESHOLD - 1), False)
    harbour_tiles = count_tiles(bboxes, HARBOUR_ZOOM_THRESHOLD, args.max_zoom, False) if args.max_zoom >= HARBOUR_ZOOM_THRESHOLD else 0

    print(f"NZ Marine Charts: z{args.min_zoom}-z{args.max_zoom}")
    print(f"  z{args.min_zoom}-z{COASTAL_ZOOM_THRESHOLD-1} (full EEZ): {eez_low} tiles")
    print(f"  z{COASTAL_ZOOM_THRESHOLD}-z{min(args.max_zoom, HARBOUR_ZOOM_THRESHOLD-1)} (coastal ~50km): {coastal_tiles} unfiltered, ~{int(coastal_tiles * 0.3)} est.")
    if harbour_tiles:
        print(f"  z{HARBOUR_ZOOM_THRESHOLD}-z{args.max_zoom} (harbour ~15km): {harbour_tiles} unfiltered, ~{int(harbour_tiles * 0.1)} est.")
    if args.use_coastal_filter:
        est = eez_low + int(coastal_tiles * 0.3) + int(harbour_tiles * 0.1)
        print(f"  Estimated total: ~{est} tiles")
    else:
        print(f"  Total (no filter): {total} tiles")
    print(f"  Output: {args.output}")

    if args.dry_run:
        if args.use_coastal_filter:
            est = eez_low + int(coastal_tiles * 0.3) + int(harbour_tiles * 0.1)
        else:
            est = total
        print(f"\n  Estimated time at 30 t/s: {est/30/60:.0f} minutes")
        return

    print()

    db = init_mbtiles(args.output, args.name, bounds_str, args.min_zoom, args.max_zoom)

    start = time.time()
    downloaded, filtered, failed = download_tiles(
        db, bboxes, api_key, args.min_zoom, args.max_zoom, args.use_coastal_filter
    )
    db.close()

    elapsed = time.time() - start
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"\n\nDone: {downloaded} saved, {filtered} coastal-filtered, "
          f"{failed} failed, {elapsed/60:.1f} minutes")
    print(f"Output: {args.output} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
