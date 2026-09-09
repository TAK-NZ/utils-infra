#!/usr/bin/env python3
"""Generate regional mbtiles and sqlitedb files from LINZ Basemaps API.

Downloads LINZ Topo50 raster tiles (with built-in relief shading) and
packages them into both:
- mbtiles format (industry standard, TMS y-axis)
- sqlitedb format (ATAK native RasterDatabase, XYZ y-axis)

Usage:
    # Single region
    python3 generate-regional-mbtiles.py --region southland --api-key YOUR_LINZ_KEY

    # All regions in parallel
    python3 generate-regional-mbtiles.py --all --parallel 4

    # Custom bounding box
    python3 generate-regional-mbtiles.py --bbox 166.3,-46.7,169.5,-44.5 --name "Southland"

    # Only generate mbtiles (skip sqlitedb)
    python3 generate-regional-mbtiles.py --region southland --format mbtiles

    # Only generate sqlitedb (skip mbtiles)
    python3 generate-regional-mbtiles.py --region southland --format sqlitedb

    # Disable land filtering (include all tiles in bounding box)
    python3 generate-regional-mbtiles.py --region southland --no-land-filter

    # List available regions and tile counts
    python3 generate-regional-mbtiles.py --list-regions
"""

import argparse
import json
import math
import multiprocessing
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.error

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LAND_BOUNDARIES_FILE = os.path.join(SCRIPT_DIR, "nz-land-boundaries.geojson")

REGIONS = {
    "northland":            {"name": "Northland",              "bbox": (172.5, -36.5, 174.9, -34.2)},
    "auckland":             {"name": "Auckland",               "bbox": (173.7, -37.5, 176.1, -35.6)},
    "waikato":              {"name": "Waikato",                "bbox": (174.5, -38.9, 176.3, -36.3)},
    "bay-of-plenty":        {"name": "Bay of Plenty",          "bbox": (175.7, -39.0, 177.4, -37.2)},
    "gisborne":             {"name": "Gisborne",               "bbox": (177.0, -39.1, 178.7, -37.4)},
    "hawkes-bay":           {"name": "Hawke's Bay",            "bbox": (176.0, -40.0, 178.2, -38.4)},
    "taranaki":             {"name": "Taranaki",               "bbox": (173.6, -40.0, 175.2, -38.6)},
    "manawatu-whanganui":   {"name": "Manawatū-Whanganui",    "bbox": (174.6, -40.9, 176.8, -38.2)},
    "wellington":           {"name": "Wellington",             "bbox": (174.5, -41.8, 176.4, -40.5)},
    "nelson-tasman":        {"name": "Nelson Tasman",          "bbox": (171.9, -42.5, 173.7, -40.1)},
    "marlborough":          {"name": "Marlborough",            "bbox": (172.6, -42.7, 174.6, -40.5)},
    "west-coast":           {"name": "West Coast",             "bbox": (167.9, -44.6, 172.8, -40.6)},
    "canterbury":           {"name": "Canterbury",             "bbox": (169.7, -45.1, 173.7, -41.9)},
    "otago":                {"name": "Otago",                  "bbox": (168.0, -46.8, 171.3, -43.6)},
    "southland":            {"name": "Southland",              "bbox": (166.3, -47.4, 169.4, -44.1)},
    "chatham-islands":      {"name": "Chatham Islands",        "bbox": (-177.5, -44.8, -175.4, -43.2)},
    "north-island":         {"name": "North Island",           "bbox": (172.5, -41.8, 178.9, -34.2)},
    "south-island":         {"name": "South Island",           "bbox": (165.5, -47.8, 174.6, -40.1)},
}

TILESETS = {
    "topo-raster": {
        "name": "LINZ Topo50",
        "url": "https://basemaps.linz.govt.nz/v1/tiles/topo-raster/WebMercatorQuad/{z}/{x}/{y}.{fmt}?api={key}",
        "format": "webp",
        "min_zoom": 4,
        "max_zoom": 14,
        "land_filter": True,
        "api_key_env": "LINZ_API_KEY",
        "suffix": "topo",
    },
    "topographic": {
        "name": "LINZ Topographic",
        "url": "https://tiles.demo.tak.nz/styles/topographic/{size}/{z}/{x}/{y}.{fmt}?api={key}",
        "format": "jpeg",
        "min_zoom": 4,
        "max_zoom": 14,
        "land_filter": True,
        "api_key_env": "TILESERVER_API_KEY",
        "suffix": "topographic",
    },
}

DEFAULT_TILESET = "topo-raster"
DEFAULT_TILE_SIZE = 256
REQUEST_DELAY = 0

# Land boundary data loaded from GeoJSON (derived from Stats NZ Territorial Authority 2025)
# Used for filtering out pure-ocean tiles to reduce download size.
_land_polygons = None
_land_bboxes = None

# Buffer in degrees around land polygons — tiles within this distance are included.
# ~0.05 degrees ≈ ~5km, enough to capture coastal tiles.
LAND_BUFFER_DEG = 0.05


def load_land_boundaries():
    """Load NZ land boundary polygons from GeoJSON file."""
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


def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)


def tile_center(z, x, y):
    """Return (lon, lat) of the center of a tile."""
    n = 2.0 ** z
    lon = (x + 0.5) / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n)))
    return (lon, math.degrees(lat_rad))


def tile_corners(z, x, y):
    """Return the four corners of a tile as (lon, lat) tuples."""
    n = 2.0 ** z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return [(lon_w, lat_n), (lon_e, lat_n), (lon_e, lat_s), (lon_w, lat_s)]


def is_tile_near_land(z, x, y):
    """Check if a tile overlaps any land polygon.
    
    Tests tile corners against land polygons AND checks if any land polygon
    bbox overlaps the tile bbox (handles large tiles that contain land entirely).
    """
    load_land_boundaries()
    corners = tile_corners(z, x, y)
    # Check if any tile corner is on land
    for lon, lat in corners:
        if is_near_land(lon, lat):
            return True
    # Check if any land polygon bbox overlaps the tile bbox
    lons = [c[0] for c in corners]
    lats = [c[1] for c in corners]
    tile_bb = (min(lons), min(lats), max(lons), max(lats))
    for bb in _land_bboxes:
        if (bb[0] <= tile_bb[2] and bb[2] >= tile_bb[0] and
                bb[1] <= tile_bb[3] and bb[3] >= tile_bb[1]):
            return True
    return False


def point_in_ring(x, y, ring):
    """Ray casting algorithm for point-in-polygon test."""
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


def is_near_land(lon, lat):
    """Check if a coordinate is near any NZ land polygon using GeoJSON boundaries."""
    load_land_boundaries()
    buf = LAND_BUFFER_DEG
    for i, ring in enumerate(_land_polygons):
        bb = _land_bboxes[i]
        if lon < bb[0] - buf or lon > bb[2] + buf or lat < bb[1] - buf or lat > bb[3] + buf:
            continue
        if point_in_ring(lon, lat, ring):
            return True
    return False


def count_tiles(bbox, min_zoom, max_zoom, use_land_filter=True):
    total = 0
    for z in range(min_zoom, max_zoom + 1):
        x_min, y_min = deg2num(bbox[3], bbox[0], z)
        x_max, y_max = deg2num(bbox[1], bbox[2], z)
        if not use_land_filter or z < 6:
            total += (x_max - x_min + 1) * (y_max - y_min + 1)
        else:
            for x in range(x_min, x_max + 1):
                for y in range(y_min, y_max + 1):
                    if is_tile_near_land(z, x, y):
                        total += 1
    return total


def init_mbtiles(db_path, name, bbox, min_zoom, max_zoom, tile_size, tile_format="webp"):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.execute("CREATE UNIQUE INDEX tiles_idx ON tiles (zoom_level, tile_column, tile_row)")
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute("CREATE UNIQUE INDEX metadata_idx ON metadata (name)")
    metadata = [
        ("name", name),
        ("format", tile_format),
        ("bounds", ",".join(str(b) for b in bbox)),
        ("center", f"{(bbox[0]+bbox[2])/2},{(bbox[1]+bbox[3])/2},{min_zoom}"),
        ("minzoom", str(min_zoom)),
        ("maxzoom", str(max_zoom)),
        ("type", "baselayer"),
        ("description", f"{name} - LINZ Topo50 with relief shading ({tile_size}px)"),
        ("attribution", "LINZ CC BY 4.0"),
        ("version", "1.3"),
    ]
    for k, v in metadata:
        db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (k, v))
    db.commit()
    return db


def insert_mbtiles(db, z, x, y, data):
    tms_y = (2 ** z - 1) - y
    db.execute(
        "INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)",
        (z, x, tms_y, data),
    )


def download_tiles(databases, url_template, api_key, bbox, min_zoom, max_zoom,
                   tile_size, tile_format="webp", label="", use_land_filter=True):
    total_tiles = count_tiles(bbox, min_zoom, max_zoom, False)
    downloaded = 0
    skipped_land = 0
    skipped_ocean = 0
    failed = 0
    start_time = time.time()
    processed = 0

    for z in range(min_zoom, max_zoom + 1):
        x_min, y_min = deg2num(bbox[3], bbox[0], z)
        x_max, y_max = deg2num(bbox[1], bbox[2], z)

        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                # Land polygon filter (skip for z4-z5 where tile count is negligible)
                if use_land_filter and z >= 6:
                    if not is_tile_near_land(z, x, y):
                        skipped_land += 1
                        continue

                url = url_template.format(z=z, x=x, y=y, fmt=tile_format, key=api_key, size=tile_size)
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "mbtiles-generator/1.0"})
                    data = urllib.request.urlopen(req, timeout=30).read()

                    for fmt, db, insert_fn in databases:
                        insert_fn(db, z, x, y, data)
                    downloaded += 1
                    processed += 1
                except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                    failed += 1
                    processed += 1
                    print(f"\n[{label}] Failed z{z}/{x}/{y}: {e}")

                elapsed = time.time() - start_time
                rate = processed / elapsed if elapsed > 0 else 0
                remaining = total_tiles - processed
                eta = remaining / rate if rate > 0 else 0
                sys.stdout.write(
                    f"\r[{label}] z{z}: {downloaded} saved, {skipped_ocean} ocean, "
                    f"{skipped_land} land-filtered, {failed} failed "
                    f"({processed}/{total_tiles}, {rate:.1f} t/s, ETA {eta/60:.0f}m)  "
                )
                sys.stdout.flush()
                time.sleep(REQUEST_DELAY)

        for _, db, _ in databases:
            db.commit()

    print(f"\n[{label}] Done: {downloaded} saved, {skipped_ocean} ocean, "
          f"{skipped_land} land-filtered, {failed} failed")
    return downloaded, failed, skipped_ocean, skipped_land


def generate_region(region_key, args):
    """Generate tile databases for a single region. Designed to run in a worker process."""
    region = REGIONS[region_key]
    name = region["name"]
    bbox = region["bbox"]
    formats = args.formats
    use_land_filter = args.use_land_filter

    total = count_tiles(bbox, args.min_zoom, args.max_zoom, False)
    fmt_str = " + ".join(formats)
    filters = "land+ocean" if use_land_filter else "ocean only"
    print(f"[{name}] Starting: {total} tiles, z{args.min_zoom}-z{args.max_zoom}, "
          f"formats: {fmt_str}, filters: {filters}")

    databases = []
    output_files = []

    suffix = args.tileset_suffix

    if "mbtiles" in formats:
        path = os.path.join(args.output_dir, f"{region_key}-{suffix}.mbtiles")
        db = init_mbtiles(path, name, bbox, args.min_zoom, args.max_zoom, args.tile_size, args.tile_format)
        databases.append(("mbtiles", db, insert_mbtiles))
        output_files.append(path)



    downloaded, failed, skipped_ocean, skipped_land = download_tiles(
        databases, args.url_template, args.api_key,
        bbox, args.min_zoom, args.max_zoom, args.tile_size,
        tile_format=args.tile_format, label=name, use_land_filter=use_land_filter,
    )

    for _, db, _ in databases:
        db.close()

    total_size = 0
    for path in output_files:
        size_mb = os.path.getsize(path) / (1024 * 1024)
        total_size += size_mb
        print(f"[{name}] Output: {path} ({size_mb:.1f} MB)")

    return region_key, downloaded, failed, skipped_ocean, skipped_land, total_size


def _worker(task):
    """Multiprocessing wrapper."""
    return generate_region(task[0], task[1])


def main():
    parser = argparse.ArgumentParser(description="Generate regional tile databases from tileserver-gl")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--region", choices=list(REGIONS.keys()), help="Single predefined region")
    group.add_argument("--regions", nargs="+", choices=list(REGIONS.keys()), help="Multiple regions")
    group.add_argument("--all", action="store_true", help="Generate all regions")
    group.add_argument("--bbox", help="Custom bounding box: west,south,east,north")
    group.add_argument("--list-regions", action="store_true", help="List available regions")

    parser.add_argument("--name", help="Region name (required with --bbox)")
    parser.add_argument("--tileset", default=DEFAULT_TILESET, choices=list(TILESETS.keys()),
                        help=f"Tileset to download (default: {DEFAULT_TILESET})")
    parser.add_argument("--api-key", help="API key (or set LINZ_API_KEY / TILESERVER_API_KEY env var)")
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE, choices=[256, 512])
    parser.add_argument("--tile-format", default=None, choices=["png", "jpeg", "webp"],
                        help="Tile image format (default: from tileset config)")
    parser.add_argument("--min-zoom", type=int, default=None)
    parser.add_argument("--max-zoom", type=int, default=None)
    parser.add_argument("--output-dir", default=".", help="Output directory (default: current dir)")
    parser.add_argument("--parallel", type=int, default=1, help="Number of parallel downloads (default: 1)")

    parser.add_argument("--no-land-filter", dest="use_land_filter", action="store_false",
                        default=True, help="Disable land polygon filtering (download all tiles in bbox)")
    args = parser.parse_args()

    args.formats = ["mbtiles"]

    # Apply tileset defaults
    ts = TILESETS[args.tileset]
    if args.tile_format is None:
        args.tile_format = ts["format"]
    if args.min_zoom is None:
        args.min_zoom = ts["min_zoom"]
    if args.max_zoom is None:
        args.max_zoom = ts["max_zoom"]
    if not args.use_land_filter:
        pass  # explicit --no-land-filter overrides
    else:
        args.use_land_filter = ts["land_filter"]
    args.url_template = ts["url"]
    args.tileset_suffix = ts["suffix"]

    if args.list_regions:
        print(f"Available regions (z{args.min_zoom}-z{args.max_zoom}):\n")
        for key, val in REGIONS.items():
            tiles_total = count_tiles(val["bbox"], args.min_zoom, args.max_zoom, False)
            print(f"  {key:25s} {val['name']:25s} {tiles_total:>6} tiles")
        total = sum(count_tiles(r["bbox"], args.min_zoom, args.max_zoom, False)
                    for r in REGIONS.values())
        print(f"\n  {'TOTAL':25s} {'':25s} {total:>6} tiles")
        if args.use_land_filter:
            print(f"\n  Note: land filter will reduce tile counts during download.")
        return

    api_key = args.api_key or os.environ.get(ts["api_key_env"])
    if not api_key:
        parser.error(f"--api-key is required (or set {ts['api_key_env']} env var)")
    args.api_key = api_key

    os.makedirs(args.output_dir, exist_ok=True)

    if args.bbox:
        if not args.name:
            parser.error("--name is required when using --bbox")
        bbox = tuple(float(x) for x in args.bbox.split(","))
        if len(bbox) != 4:
            parser.error("--bbox must have 4 values: west,south,east,north")
        slug = args.name.lower().replace(" ", "-")
        REGIONS[slug] = {"name": args.name, "bbox": bbox}
        region_keys = [slug]
    elif args.all:
        region_keys = list(REGIONS.keys())
    elif args.regions:
        region_keys = args.regions
    elif args.region:
        region_keys = [args.region]
    else:
        parser.error("One of --region, --regions, --all, or --bbox is required")

    total_tiles = sum(count_tiles(REGIONS[k]["bbox"], args.min_zoom, args.max_zoom, False)
                      for k in region_keys)
    fmt_str = " + ".join(args.formats)
    filters = "land+ocean" if args.use_land_filter else "ocean only"
    print(f"Generating {len(region_keys)} region(s), {total_tiles} total tiles, "
          f"formats: {fmt_str}, filters: {filters}, parallel={args.parallel}\n")

    if args.parallel > 1 and len(region_keys) > 1:
        workers = min(args.parallel, len(region_keys))
        with multiprocessing.Pool(workers) as pool:
            results = pool.map(_worker, [(k, args) for k in region_keys])
    else:
        results = [generate_region(k, args) for k in region_keys]

    print("\n=== Summary ===")
    total_size = 0
    for region_key, downloaded, failed, skipped_ocean, skipped_land, size_mb in results:
        status = "✓" if failed == 0 else f"✗ ({failed} failed)"
        skipped = skipped_ocean + skipped_land
        print(f"  {REGIONS[region_key]['name']:25s} {downloaded:>6} saved  "
              f"{skipped:>5} skipped  {size_mb:>8.1f} MB  {status}")
        total_size += size_mb
    print(f"  {'TOTAL':25s} {'':>6}                 {total_size:>8.1f} MB")


if __name__ == "__main__":
    main()
