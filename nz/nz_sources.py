"""NZ data sources for the WiSAR pipeline (spike).

Drop-in replacements for pipeline.downloads.{download_dem, download_nlcd,
download_osm_features, download_nhd_features}. Same signatures and return
shapes, so pipeline/*.py is used unmodified.

  DEM        LINZ 1 m LiDAR DEM (COG, EPSG:2193) on public S3, warped to the
             same ~30 m EPSG:4326 grid WiSAR builds. GDAL reads the COG
             overviews, so only a few MB are fetched per run.
  Land cover Landcare Research LCDB v6.0, 2023/24 epoch, as a national 30 m raster built by
             build_lcdb_raster.py. Classes map to impedance through lcdb_friction.toml.
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
from rasterio.warp import transform_bounds
from rasterio.windows import Window, from_bounds

import lcdb_friction
from pipeline.shared import NLCD_IMPEDANCE, WORK_DIR

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
DEM_BASE = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'
DEM_INDEX = os.path.join(DATA, 'dem_1m_index.json')
OSM_GPKG = os.path.join(DATA, 'nz_osm_lines.gpkg')
LCDB_TIF = os.path.join(DATA, 'lcdb_2023_30m.tif')

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

# Register the LCDB classes with the pipeline's shared impedance lookup (in place; pipeline code untouched).
LCDB_META, LCDB_CLASSES = lcdb_friction.register(NLCD_IMPEDANCE)
WINDOW_PAD_CELLS = 4


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
    """Clip the national LCDB raster to bbox and re-code it for the pipeline's cost surface.

    Output values: 100+class (LCDB class), 200+class (wetland-flagged polygon), 100 where no LCDB polygon
    exists (open sea). Written as uint16 in the raster's native CRS (EPSG:2193) with no nodata value, because
    cost_surface.py reprojects it onto the DEM grid and would leave nodata cells at the default impedance.
    """
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'nlcd.tif')
    if not os.path.isfile(LCDB_TIF):
        raise FileNotFoundError(f'LCDB raster not found at {LCDB_TIF}; run nz/build_lcdb_raster.py')
    west, south, east, north = bbox
    with rasterio.open(LCDB_TIF) as src:
        l, b, r, t = transform_bounds('EPSG:4326', src.crs, west, south, east, north, densify_pts=21)
        win = from_bounds(l, b, r, t, src.transform)
        col0 = max(int(math.floor(win.col_off)) - WINDOW_PAD_CELLS, 0)
        row0 = max(int(math.floor(win.row_off)) - WINDOW_PAD_CELLS, 0)
        col1 = min(int(math.ceil(win.col_off + win.width)) + WINDOW_PAD_CELLS, src.width)
        row1 = min(int(math.ceil(win.row_off + win.height)) + WINDOW_PAD_CELLS, src.height)
        if col1 <= col0 or row1 <= row0:
            return None, [{'severity': 'warning', 'source': 'landcover',
                           'message': 'Land cover unavailable: the area is outside the LCDB mainland extent. '
                                      'Analysis proceeded with uniform terrain friction.'}]
        window = Window(col0, row0, col1 - col0, row1 - row0)
        raw = src.read(1, window=window)
        transform = src.window_transform(window)
        crs = src.crs
    sea = raw == lcdb_friction.SEA_RAW
    wet = (raw >= lcdb_friction.WETLAND_BIT) & ~sea
    cls = (raw & (lcdb_friction.WETLAND_BIT - 1)).astype(np.uint16)
    code = np.where(sea, lcdb_friction.CLASS_BASE,
                    np.where(wet, lcdb_friction.WETLAND_BASE + cls, lcdb_friction.CLASS_BASE + cls)).astype(np.uint16)
    warnings = []
    unknown = sorted(int(c) for c in np.unique(cls[~sea]) if int(c) not in LCDB_CLASSES)
    if unknown:
        warnings.append({'severity': 'warning', 'source': 'landcover',
                         'message': f'LCDB classes {unknown} have no friction entry and use the default impedance.'})
    with rasterio.open(output_path, 'w', driver='GTiff', height=code.shape[0], width=code.shape[1], count=1,
                       dtype='uint16', crs=crs, transform=transform, compress='deflate') as dst:
        dst.write(code, 1)
    print(f"  LCDB {LCDB_META['lcdb_version']} {LCDB_META['epoch']}: {code.shape[1]}x{code.shape[0]} cells, "
          f"{100 * sea.mean():.0f}% outside LCDB polygons (sea)")
    return output_path, warnings


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
