"""NZ data sources for the WiSAR pipeline.

Drop-in replacements for pipeline.downloads.{download_dem, download_nlcd, download_osm_features,
download_nhd_features}: same signatures and return shapes, so app/pipeline/ is used unmodified.

  Elevation  LINZ 1 m LiDAR DEM (COG, EPSG:2193, public S3), read from the COG overviews and averaged onto the
             pipeline's ~30 m EPSG:4326 grid. Holes (the 1 m DEM does not cover all of NZ, mostly the far south)
             are filled from Copernicus GLO-30 (public S3), offset-corrected where the two overlap.
  Land cover Landcare Research LCDB v6.0, 2023/24, as a national 30 m COG built by build_lcdb_raster.py.
             Classes map to impedance through lcdb_friction.toml.
  OSM        Geofabrik NZ extract filtered to a FlatGeobuf by build_osm_lines.py, read by bounding box.
  LINZ water Streams and river polygons from the LINZ Basemaps vector tiles, built to a FlatGeobuf by
             build_linz_water.py. Optional: used only when its sidecar is published, and added to the OSM waterways.
  Hydrology  No NHD equivalent. Lakes and sea come from land cover; rivers and streams from OSM and LINZ waterways.

Data location: SAR_DATA_DIR (default: <repo>/data). It can be a local directory or a GDAL virtual path such as
/vsis3/bucket/prefix, and must hold lcdb_2023_30m.tif and nz_osm_meta.geojson, plus the OSM FlatGeobuf the sidecar names. It may also hold
linz_water_meta.geojson and linz_water.fgb (the LINZ waterways); without the sidecar they are not used.
"""
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window, from_bounds

import rasterio.session

import lcdb_friction
from osm_tags import CATEGORIES
from pipeline.shared import NLCD_IMPEDANCE, WORK_DIR

# The Lambda Python image ships boto3, and rasterio then builds a boto3-backed session on EVERY rasterio.Env entry.
# The upstream cost-surface code enters one Env per stream (about 1,100 per run), which cost ~25 s of botocore
# overhead in the Lambda runtime (measured: cost_surface 27 s there against 1.5 s elsewhere). With boto3 hidden,
# rasterio uses a dummy session, and GDAL reads the role credentials for /vsis3/ paths from the environment itself.
rasterio.session.boto3 = None

# Remote-read tuning. Set before the first open: rasterio and pyogrio each bundle a GDAL that reads these from
# the process environment.
for _k, _v in {'GDAL_DISABLE_READDIR_ON_OPEN': 'EMPTY_DIR',
               'CPL_VSIL_CURL_ALLOWED_EXTENSIONS': '.tif,.tiff,.fgb,.geojson',
               'GDAL_HTTP_MAX_RETRY': '3', 'GDAL_HTTP_RETRY_DELAY': '1', 'GDAL_HTTP_TIMEOUT': '30',
               'VSI_CACHE': 'TRUE', 'VSI_CACHE_SIZE': '67108864'}.items():
    os.environ.setdefault(_k, _v)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('SAR_DATA_DIR') or os.path.join(HERE, '..', 'data')
LCDB_TIF = DATA_DIR + '/lcdb_2023_30m.tif'
DEFAULT_OSM_FGB = 'nz_osm.fgb'                                    # used when the sidecar names no file
OSM_META = DATA_DIR + '/nz_osm_meta.geojson'
DEFAULT_LINZ_WATER_FGB = 'linz_water.fgb'                         # used when the LINZ sidecar names no file
LINZ_WATER_META = DATA_DIR + '/linz_water_meta.geojson'          # present only when the LINZ waterways are published
DEM_INDEX = os.path.join(HERE, 'dem_1m_index.json')            # bundled with the code
LINZ_DEM_BASE = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'
COPERNICUS_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com/'
OSM_STALE_DAYS = 45                                            # the snapshot is refreshed monthly (WiSAR uses 14 for weekly)
NODATA = -9999.0
WINDOW_PAD_CELLS = 4

# Register the LCDB classes with the pipeline's shared impedance lookup (in place; pipeline code untouched).
LCDB_META, LCDB_CLASSES = lcdb_friction.register(NLCD_IMPEDANCE)
_DEM_SHEETS = None


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


def cell_size_m(bbox):
    """Approximate ground size of one grid cell (metres) for the pipeline grid over bbox."""
    w_px, _ = _grid_size(bbox)
    mid = (bbox[1] + bbox[3]) / 2
    return (bbox[2] - bbox[0]) * 111320 * math.cos(math.radians(mid)) / w_px


# --------------------------------------------------------------------------------------------------------------
# Elevation
# --------------------------------------------------------------------------------------------------------------
def _linz_sheets(bbox):
    global _DEM_SHEETS
    if _DEM_SHEETS is None:
        with open(DEM_INDEX) as f:
            _DEM_SHEETS = json.load(f)
    west, south, east, north = bbox
    return sorted(i for i, (w, s, e, n) in _DEM_SHEETS.items()
                  if west <= e and east >= w and south <= n and north >= s)


def _linz_overview_level(cell_m):
    """LINZ sheets carry overviews at 2, 4, ..., 128x. Use the coarsest one that is still finer than the target cell."""
    factors = [2, 4, 8, 16, 32, 64, 128]
    ok = [i for i, f in enumerate(factors) if f <= cell_m / 1.5]
    return ok[-1] if ok else None


def _warp_into(url, dst, transform, overview_level=None, src_nodata=None):
    """Reproject one raster (averaging) into dst in place. Pixels with no source data are left untouched."""
    kwargs = {'overview_level': overview_level} if overview_level is not None else {}
    with rasterio.open(url, **kwargs) as src:
        reproject(source=rasterio.band(src, 1), destination=dst, dst_transform=transform, dst_crs='EPSG:4326',
                  src_nodata=src_nodata, dst_nodata=NODATA, resampling=Resampling.average, init_dest_nodata=False)


MAX_READ_THREADS = 8


def _read_parts(urls, transform, shape, overview_level=None, src_nodata=None, skip_missing=False):
    """Warp each raster into its own array, concurrently. Returns the arrays in the order of `urls`.

    Reading the DEM is dominated by waiting for the network: every request to the (distant) bucket costs a round trip
    and the sheets are independent, so they are fetched in parallel threads. Each thread opens its own dataset.
    With skip_missing, a raster that does not exist yields None (open ocean has no Copernicus tile).
    """
    def one(url):
        part = np.full(shape, NODATA, dtype=np.float32)
        try:
            _warp_into(url, part, transform, overview_level=overview_level, src_nodata=src_nodata)
        except rasterio.errors.RasterioIOError:
            if skip_missing:
                return None
            raise
        return part
    if len(urls) <= 1:
        return [one(u) for u in urls]
    with ThreadPoolExecutor(min(len(urls), MAX_READ_THREADS)) as pool:
        return list(pool.map(one, urls))


def _apply_in_order(dem, parts):
    """Lay the parts onto dem in order: a later part overwrites an earlier one wherever it has data.

    This is exactly what warping the rasters one after another into a shared array does (the LINZ sheets overlap by a
    few thousand cells at their edges and adjacent surveys can disagree by metres, so the order matters).
    """
    for part in parts:
        if part is not None:
            written = part != NODATA
            dem[written] = part[written]


def _copernicus_tiles(bbox):
    west, south, east, north = bbox
    for lat in range(math.floor(south), math.floor(north) + 1):
        for lng in range(math.floor(west), math.floor(east) + 1):
            tag = f"{'S' if lat < 0 else 'N'}{abs(lat):02d}_00_{'E' if lng >= 0 else 'W'}{abs(lng):03d}_00"
            yield f'{COPERNICUS_BASE}Copernicus_DSM_COG_10_{tag}_DEM/Copernicus_DSM_COG_10_{tag}_DEM.tif'


def download_dem(bbox, output_path=None):
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'dem.tif')
    west, south, east, north = bbox
    w_px, h_px = _grid_size(bbox)
    transform = transform_from_bounds(west, south, east, north, w_px, h_px)
    dem = np.full((h_px, w_px), NODATA, dtype=np.float32)
    warnings = []

    sheets = _linz_sheets(bbox)
    level = _linz_overview_level(cell_size_m(bbox))
    _apply_in_order(dem, _read_parts([f'/vsicurl/{LINZ_DEM_BASE}{sheet}.tiff' for sheet in sheets], transform,
                                     (h_px, w_px), overview_level=level, src_nodata=NODATA))
    print(f"  LINZ DEM: {len(sheets)} sheet(s), overview level {level}, grid {w_px}x{h_px}")

    holes = dem <= -1000
    if holes.any():
        cop = np.full_like(dem, NODATA)
        # a tile that does not exist (open ocean) is skipped
        _apply_in_order(cop, _read_parts(['/vsicurl/' + u for u in _copernicus_tiles(bbox)], transform, (h_px, w_px),
                                         skip_missing=True))
        have = cop > -1000
        overlap = ~holes & have
        # Heights are orthometric in both models but on different geoids, and Copernicus is a surface model
        # (canopy included). Remove the median offset where they overlap so the seam is not a cliff.
        offset = float(np.median(cop[overlap] - dem[overlap])) if overlap.sum() > 500 else 0.0
        fill = holes & have
        dem[fill] = cop[fill] - offset
        land_fill = float((fill & (cop > 1.0)).sum()) / dem.size   # Copernicus is ~0 m over the sea
        print(f"  Copernicus fill: {100 * land_fill:.1f}% of cells, offset {offset:+.1f} m")
        if land_fill > 0.01:
            warnings.append({
                'severity': 'warning', 'source': 'elevation',
                'message': f'{100 * land_fill:.0f}% of this area has no LINZ 1 m LiDAR elevation and uses the '
                           f'Copernicus GLO-30 surface model instead. It includes tree canopy and is coarser, so '
                           f'slopes in that part are less reliable.'})
    if not sheets and not (dem > -1000).any():
        raise RuntimeError('No elevation data covers this area.')

    with rasterio.open(output_path, 'w', driver='GTiff', height=h_px, width=w_px, count=1, dtype='float32',
                       crs='EPSG:4326', transform=transform, nodata=NODATA, compress='deflate') as dst:
        dst.write(dem, 1)
    return output_path, warnings


# --------------------------------------------------------------------------------------------------------------
# Land cover
# --------------------------------------------------------------------------------------------------------------
def download_nlcd(bbox, output_path=None):
    """Clip the national LCDB raster to bbox and re-code it for the pipeline's cost surface.

    Output values: 100+class (LCDB class), 200+class (wetland-flagged polygon), 100 where no LCDB polygon
    exists (open sea). Written as uint16 in the raster's native CRS (EPSG:2193) with no nodata value, because
    cost_surface.py reprojects it onto the DEM grid and would leave nodata cells at the default impedance.
    """
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'nlcd.tif')
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


# --------------------------------------------------------------------------------------------------------------
# OpenStreetMap
# --------------------------------------------------------------------------------------------------------------
def _empty(cols):
    return gpd.GeoDataFrame(columns=cols, geometry='geometry', crs='EPSG:4326')


def _sidecar(path):
    """Read a build-info sidecar (a one-point GeoJSON, readable from any GDAL path), or {} if it is missing."""
    try:
        row = pyogrio.read_dataframe(path).iloc[0]
        # pyogrio parses datetime-looking strings into pandas Timestamps; hand back plain Python values.
        meta = {'built_at': row['built_at'].isoformat(), 'source': str(row['source']), 'features': int(row['features'])}
        if 'file' in row and str(row['file']):
            meta['file'] = str(row['file'])
        return meta
    except Exception:
        return {}


def _data_file(name):
    if name.startswith('/') or '..' in name.split('/'):
        raise ValueError('data file name in a sidecar is not a relative path')
    return f'{DATA_DIR}/{name}'


def osm_metadata():
    """Build info written by build_osm_lines.py, or {}."""
    return _sidecar(OSM_META)


def osm_fgb_path(meta=None):
    """Path of the current OSM snapshot. The sidecar names it, so the scheduled refresh can publish a new snapshot
    under a new key and switch to it with one small write; readers never see a half-written file."""
    return _data_file((meta if meta is not None else osm_metadata()).get('file') or DEFAULT_OSM_FGB)


def linz_water_metadata():
    """Build info written by build_linz_water.py, or {} when the LINZ waterways are not published. The sidecar is
    what switches the data on: delete it to go back to OSM waterways alone."""
    return _sidecar(LINZ_WATER_META)


def linz_water_features(bbox, meta=None):
    """LINZ streams (type 'stream') and river polygons (type 'river') inside bbox as a GeoDataFrame with the OSM
    waterway columns (geometry, type, name, width), or None when the LINZ waterways are not published.
    Raises when they are published but cannot be read; the caller decides what to do about it."""
    meta = meta if meta is not None else linz_water_metadata()
    if not meta:
        return None
    gdf = gpd.read_file(_data_file(meta.get('file') or DEFAULT_LINZ_WATER_FGB), bbox=tuple(bbox), engine='pyogrio')
    out = gdf[['geometry', 'type']].copy().set_crs('EPSG:4326', allow_override=True)
    out['name'] = ''
    out['width'] = ''
    return out[['geometry', 'type', 'name', 'width']]


def download_osm_features(bbox):
    result = {
        'trails': _empty(['geometry', 'type', 'name']),
        'roads': _empty(['geometry', 'type', 'name']),
        'waterways': _empty(['geometry', 'type', 'name', 'width']),
        'powerlines': _empty(['geometry', 'type', 'name']),
        '_warnings': [],
    }
    meta = osm_metadata()
    gdf = gpd.read_file(osm_fgb_path(meta), bbox=tuple(bbox), engine='pyogrio')
    if len(gdf):
        gdf['name'] = gdf['name'].fillna('').astype(str)
        gdf = gdf.set_crs('EPSG:4326', allow_override=True)
        for cat in CATEGORIES:
            sub = gdf.loc[gdf['cat'] == cat, ['geometry', 'type', 'name']].copy()
            if cat == 'waterways':
                sub['width'] = ''
            if len(sub):
                result[cat] = sub
    _add_linz_waterways(result, bbox)
    built = meta.get('built_at')
    age_days = None
    if built:
        age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(built)).total_seconds() / 86400
    if age_days is None or age_days > OSM_STALE_DAYS:
        when = 'at an unknown date' if age_days is None else f'{age_days:.0f} days ago'
        result['_warnings'].append({
            'severity': 'warning', 'source': 'osm',
            'message': f'Trail and road data may be out of date: the OpenStreetMap snapshot was built {when}. '
                       f'Recently mapped or rerouted tracks may be missing.'})
    print(f"  OSM: {len(result['trails'])} trails, {len(result['roads'])} roads, "
          f"{len(result['waterways'])} waterways, {len(result['powerlines'])} power lines")
    return result


def _add_linz_waterways(result, bbox):
    """Add the LINZ streams and river polygons to result['waterways'] when they are published.

    Both sources are kept: OSM adds canals and typed rivers (burned harder than streams), LINZ adds the many streams OSM
    has not mapped. The cost surface takes the maximum friction of whatever covers a cell, so a stream in both sources
    costs no more than in one. If the LINZ file cannot be read the request carries on with OSM alone and says so.
    """
    try:
        linz = linz_water_features(bbox)
    except Exception as exc:
        print(f"  LINZ waterways unreadable ({type(exc).__name__}); using OSM waterways only")
        result['_warnings'].append({
            'severity': 'warning', 'source': 'linz-water',
            'message': 'LINZ stream data could not be read, so streams come from OpenStreetMap alone. Small streams '
                       'may be missing and travel may look faster than it is.'})
        return
    if linz is None or len(linz) == 0:
        return
    osm_water = result['waterways']
    merged = linz if len(osm_water) == 0 else pd.concat([osm_water, linz], ignore_index=True)
    result['waterways'] = gpd.GeoDataFrame(merged, geometry='geometry', crs='EPSG:4326')
    print(f"  LINZ: {len(linz)} stream and river features added")


def download_nhd_features(bbox):
    return _empty(['geometry', 'type', 'ftype', 'name', 'impedance']), []


# --------------------------------------------------------------------------------------------------------------
# Start-point check
# --------------------------------------------------------------------------------------------------------------
WATER_CLASSES = (0, 20, 22)          # Not land, Lake or Pond, Estuarine Open Water (rivers are crossable banks)


def water_fraction_at(lat, lng, half_cells=2):
    """Fraction of the (2*half_cells+1)^2 LCDB cells around a point that are sea or open water.

    Cells with no LCDB polygon count as sea. Used to reject a start point that is not on land; the window
    (about 150 m) tolerates a point that lands on the water side of a shoreline by a cell or two.
    """
    from rasterio.warp import transform as warp_transform
    with rasterio.open(LCDB_TIF) as src:
        xs, ys = warp_transform('EPSG:4326', src.crs, [lng], [lat])
        row, col = src.index(xs[0], ys[0])
        size = 2 * half_cells + 1
        raw = src.read(1, window=Window(col - half_cells, row - half_cells, size, size), boundless=True,
                       fill_value=lcdb_friction.SEA_RAW)
    cls = np.where(raw == lcdb_friction.SEA_RAW, lcdb_friction.SEA_RAW, raw & (lcdb_friction.WETLAND_BIT - 1))
    return float(np.isin(cls, WATER_CLASSES + (lcdb_friction.SEA_RAW,)).mean())
