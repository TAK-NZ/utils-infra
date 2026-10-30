"""NZ data sources for the WiSAR pipeline (spike).

Drop-in replacements for pipeline.downloads.{download_dem, download_nlcd,
download_osm_features, download_nhd_features}. Same signatures and return
shapes, so pipeline/*.py is used unmodified.

  DEM        LINZ 1 m LiDAR DEM (COG, EPSG:2193) on public S3, warped to the
             same ~30 m EPSG:4326 grid WiSAR builds. GDAL reads the COG
             overviews, so only a few MB are fetched per run.
  Land cover ESA WorldCover 2021 10 m (STAND-IN for LCDB v5, which needs a
             LINZ/Koordinates login). Reclassified onto the NLCD codes that
             pipeline.cost_surface already understands.
  OSM        Geofabrik NZ extract, pre-filtered to a GeoPackage by
             build_osm_lines.py, read by bbox.
  Hydrology  No NHD equivalent. Lakes/sea come from land cover; rivers and
             streams come from the OSM waterways layer.
"""
import json
import math
import os
import subprocess
import time

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.windows import from_bounds

from pipeline.shared import WORK_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
DEM_BASE = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'
DEM_INDEX = os.path.join(DATA, 'dem_1m_index.json')
OSM_GPKG = os.path.join(DATA, 'nz_osm_lines.gpkg')
WC_BASE = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'

GDAL_ENV = dict(os.environ,
                GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tiff,.tif',
                VSI_CACHE='TRUE',
                GDAL_HTTP_MAX_RETRY='3')

# Same tag sets as WiSAR tools/build_osm_cache.py.
TRAIL_TAGS = {'path', 'footway', 'track', 'bridleway', 'cycleway'}
ROAD_TAGS = {'residential', 'tertiary', 'secondary', 'primary', 'trunk',
             'motorway', 'unclassified', 'service'}
WATERWAY_TAGS = {'stream', 'river', 'canal', 'drain', 'ditch'}
POWER_TAGS = {'line', 'minor_line'}

# ESA WorldCover class -> NLCD code understood by cost_surface.NLCD_IMPEDANCE.
# Native bush and scrub are not separable in WorldCover (both "tree"/"shrub"),
# which is the main reason to replace this with LCDB.
WORLDCOVER_TO_NLCD = {
    10: 42,   # tree cover       -> evergreen forest (impedance 50, friction 1.8)
    20: 52,   # shrubland        -> shrub/scrub      (45, 1.6)
    30: 71,   # grassland        -> grassland        (20, 1.15)
    40: 82,   # cropland         -> cultivated crops (30, 1.25)
    50: 23,   # built-up         -> developed medium (15, 1.10)
    60: 31,   # bare / sparse    -> barren           (30, 1.25)
    70: 31,   # snow and ice     -> barren (NOT 12: that triggers water dilation)
    80: 11,   # permanent water  -> open water       (99, barrier)
    90: 90,   # herbaceous wetland -> woody wetland  (80, 3.0)
    95: 90,   # mangroves        -> wetland
    100: 72,  # moss and lichen  -> sedge/alpine     (45)
}


def _grid_size(bbox, pixel_size=30, max_px=1000):
    """Mirror of the grid logic in pipeline.downloads.download_dem."""
    west, south, east, north = bbox
    mid = (south + north) / 2
    w_m = (east - west) * 111320 * math.cos(math.radians(mid))
    h_m = (north - south) * 110540
    w, h = max(int(w_m / pixel_size), 1), max(int(h_m / pixel_size), 1)
    if w > max_px or h > max_px:
        s = max_px / max(w, h)
        w, h = int(w * s), int(h * s)
    return w, h


def download_dem(bbox, output_path=None):
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'dem.tif')
    west, south, east, north = bbox
    index = json.load(open(DEM_INDEX))
    sheets = [i for i, (w, s, e, n) in index.items()
              if west <= e and east >= w and south <= n and north >= s]
    if not sheets:
        raise RuntimeError('No LINZ 1 m DEM sheet covers this area.')
    w_px, h_px = _grid_size(bbox)
    print(f"  LINZ DEM: {len(sheets)} sheet(s) {sheets}, output {w_px}x{h_px}")
    srcs = [f'/vsicurl/{DEM_BASE}{s}.tiff' for s in sheets]
    cmd = ['gdalwarp', '-q', '-overwrite', '-t_srs', 'EPSG:4326',
           '-te', str(west), str(south), str(east), str(north),
           '-ts', str(w_px), str(h_px), '-r', 'average', '-ot', 'Float32',
           '-dstnodata', '-9999', '-co', 'COMPRESS=DEFLATE', *srcs, output_path]
    subprocess.run(cmd, check=True, env=GDAL_ENV)
    return output_path, []


def download_nlcd(bbox, output_path=None):
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'nlcd.tif')
    west, south, east, north = bbox
    # WorldCover tiles are 3x3 degrees named by their south-west corner.
    tiles = set()
    for lat in (south, north):
        for lng in (west, east):
            tl = int(math.floor(lat / 3) * 3)
            tg = int(math.floor(lng / 3) * 3)
            tiles.add(f"{'S' if tl < 0 else 'N'}{abs(tl):02d}{'E' if tg >= 0 else 'W'}{abs(tg):03d}")
    if len(tiles) > 1:
        # Keep the spike simple; the production code would mosaic via a VRT.
        raise NotImplementedError(f'bbox spans WorldCover tiles {sorted(tiles)}')
    tile = tiles.pop()
    url = f'/vsicurl/{WC_BASE}ESA_WorldCover_10m_2021_v200_{tile}_Map.tif'
    with rasterio.Env(**{k: GDAL_ENV[k] for k in
                         ('GDAL_DISABLE_READDIR_ON_OPEN', 'CPL_VSIL_CURL_ALLOWED_EXTENSIONS')}):
        with rasterio.open(url) as src:
            win = from_bounds(west, south, east, north, src.transform).round_offsets().round_lengths()
            # Read at the DEM's pixel count (overview-backed), majority-like via
            # nearest on an overview; cost_surface then reprojects nearest onto the DEM grid.
            data = src.read(1, window=win)
            profile = src.profile.copy()
            transform = src.window_transform(win)
    out = np.zeros_like(data)
    for wc, nlcd in WORLDCOVER_TO_NLCD.items():
        out[data == wc] = nlcd
    out[out == 0] = 250  # nodata, as in NLCD
    profile.update(driver='GTiff', height=out.shape[0], width=out.shape[1],
                   transform=transform, nodata=250, compress='deflate',
                   tiled=False, count=1)
    for k in ('blockxsize', 'blockysize'):
        profile.pop(k, None)
    with rasterio.open(output_path, 'w', **profile) as dst:
        dst.write(out, 1)
    print(f"  WorldCover {tile}: {out.shape[1]}x{out.shape[0]} source cells")
    return output_path, []


def _empty(cols):
    return gpd.GeoDataFrame(columns=cols, geometry='geometry', crs='EPSG:4326')


def download_osm_features(bbox):
    result = {
        'trails': _empty(['geometry', 'type', 'name']),
        'roads': _empty(['geometry', 'type', 'name']),
        'waterways': _empty(['geometry', 'type', 'name', 'width']),
        'powerlines': _empty(['geometry', 'type', 'name']),
        '_warnings': [],
    }
    gdf = gpd.read_file(OSM_GPKG, layer='lines', bbox=tuple(bbox))
    if len(gdf) == 0:
        return result
    gdf['name'] = gdf['name'].fillna('').astype(str)
    tags = gdf['other_tags'].fillna('')
    gdf['_power'] = tags.str.extract(r'"power"=>"([^"]*)"', expand=False)
    gdf['_width'] = tags.str.extract(r'"width"=>"([^"]*)"', expand=False).fillna('')
    trails = gdf['highway'].isin(TRAIL_TAGS)
    roads = gdf['highway'].isin(ROAD_TAGS) & ~trails
    water = gdf['waterway'].isin(WATERWAY_TAGS) & ~trails & ~roads
    power = gdf['_power'].isin(POWER_TAGS) & ~trails & ~roads & ~water
    for key, mask, col in (('trails', trails, 'highway'), ('roads', roads, 'highway'),
                           ('waterways', water, 'waterway'), ('powerlines', power, '_power')):
        sub = gdf.loc[mask, ['geometry', 'name', col]].rename(columns={col: 'type'})
        if key == 'waterways':
            sub['width'] = gdf.loc[mask, '_width']
        if len(sub):
            result[key] = sub.set_crs('EPSG:4326', allow_override=True)
    print(f"  OSM: {len(result['trails'])} trails, {len(result['roads'])} roads, "
          f"{len(result['waterways'])} waterways, {len(result['powerlines'])} power lines")
    return result


def download_nhd_features(bbox):
    return _empty(['geometry', 'type', 'ftype', 'name', 'impedance']), [{
        'severity': 'info', 'source': 'nhd',
        'message': 'No NHD equivalent for NZ; water from land cover and OSM waterways.'}]
