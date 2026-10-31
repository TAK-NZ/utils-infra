"""AWS Lambda handler for the TAK-NZ SAR engine.

Routes (an optional /sar prefix is accepted, so the ALB can route by path):
    GET  /health         liveness, no authentication
    POST /travel-time    terrain-aware travel-time isochrones from an Initial Planning Point (IPP)

Request body for /travel-time (JSON):
    {"ipp": {"lat": -40.87, "lng": 175.45}, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10}
radius_km is optional. The analysis radius is at least speed x longest interval + 2 km (as in WiSAR), capped at
MAX_RADIUS_KM.

Event shapes accepted: ALB target group, Lambda Function URL, and direct invoke
({"method": "POST", "path": "/travel-time", "body": {...}} or just the body for /travel-time).
Authentication: HTTP events must carry an x-api-key header matching a key in the config-bucket file named by
SAR_CONFIG_BUCKET / SAR_CONFIG_KEY (see api_keys.py), or SAR_API_KEY for local use. With no valid key configured,
every route except /health is denied. Direct invokes rely on IAM and carry no key.

Dense areas: after the OSM read, density_guard.py estimates whether the request can finish inside the time budget
(SAR_TIME_BUDGET_S, default 45 s) and, if not, answers HTTP 422 straight away with {"code": "area_too_dense", "message",
and "suggested_radius_km" and/or "suggested_max_hours"}. Requests that fit are not changed.

Privacy: the pipeline prints the IPP and bounding box. Its output is captured and discarded; logs hold only
timings, sizes and error classes, never coordinates.
"""
import contextlib
import io
import json
import math
import os
import time
import traceback
import warnings as pywarnings

import api_keys
import density_guard
import nz_sources  # noqa: E402  (importing registers the LCDB codes and sets GDAL read options)
from fast_cost_distance import compute_cost_distance      # same results as the upstream function, about 30x faster
from fast_cost_surface import build_cost_surface           # same results as the upstream function, much faster
from pipeline.outputs import extract_isochrone_polygons
from pipeline.shared import WORK_DIR, get_bbox_from_ipp

# The upstream pipeline buffers lines in degrees on purpose (about 30 m); geopandas warns about it on every run.
pywarnings.filterwarnings('ignore', message='Geometry is in a geographic CRS')

NZ_BOUNDS = {'lat': (-48.0, -33.5), 'lng': (165.5, 179.5)}      # mainland NZ plus margin
MIN_SPEED_KMH, MAX_SPEED_KMH = 0.1, 10.0
MIN_HOURS, MAX_HOURS, MAX_INTERVALS = 0.25, 24.0, 8
MAX_RADIUS_KM = 30.0
MAX_BODY_BYTES = 8192
WATER_REJECT_FRACTION = 0.5                                       # start point mostly sea / lake / estuary
COARSE_CELL_M = 45.0                                              # warn when the grid cap forces cells coarser

ATTRIBUTION = [
    'Land cover: LCDB v6.0 (2023/24), Landcare Research, CC BY 4.0',
    'Elevation: LINZ NZ Elevation (CC BY 4.0); gaps filled with Copernicus GLO-30 DEM',
    'Trails, roads and waterways: (c) OpenStreetMap contributors, ODbL',
    'Method: WiSAR Terrain-Aware Range Rings by J. Weleber (AGPL-3.0), TAK-NZ fork',
]
DISCLAIMER = ('Planning aid only. Travel-time contours show where a person could physically reach at the given '
              'flat-ground speed. They do not show where a person is likely to be. The terrain model is not '
              'validated against New Zealand search and rescue data.')


class ApiError(Exception):
    """`extra` is merged into the JSON error body; `log` goes to the request log line (never coordinates)."""
    def __init__(self, status, message, extra=None, log=None):
        super().__init__(message)
        self.status, self.message, self.extra, self.log = status, message, extra or {}, log


# --------------------------------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------------------------------
def _number(value, name, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(400, f'{name} must be a number')
    if not math.isfinite(value) or not lo <= value <= hi:
        raise ApiError(400, f'{name} must be between {lo:g} and {hi:g}')
    return float(value)


def parse_travel_time(body):
    if not isinstance(body, dict):
        raise ApiError(400, 'Request body must be a JSON object')
    ipp = body.get('ipp')
    if not isinstance(ipp, dict):
        raise ApiError(400, 'ipp {lat, lng} is required')
    lat = _number(ipp.get('lat'), 'ipp.lat', *NZ_BOUNDS['lat'])
    lng = _number(ipp.get('lng'), 'ipp.lng', *NZ_BOUNDS['lng'])
    speed = _number(body.get('speed_kmh'), 'speed_kmh', MIN_SPEED_KMH, MAX_SPEED_KMH)
    raw = body.get('intervals_hours')
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_INTERVALS:
        raise ApiError(400, f'intervals_hours must be a list of 1 to {MAX_INTERVALS} numbers')
    intervals = sorted({_number(h, 'intervals_hours[]', MIN_HOURS, MAX_HOURS) for h in raw})
    radius = body.get('radius_km')
    radius = None if radius is None else _number(radius, 'radius_km', 1.0, MAX_RADIUS_KM)
    return lat, lng, speed, intervals, radius


# --------------------------------------------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------------------------------------------
def _clear_work_dir():
    """Remove last run's intermediate files (flat directory; plain file removal only)."""
    for entry in os.scandir(WORK_DIR):
        if entry.is_file():
            os.remove(entry.path)


def run_travel_time(lat, lng, speed_kmh, intervals, radius_km):
    if nz_sources.water_fraction_at(lat, lng) >= WATER_REJECT_FRACTION:
        raise ApiError(422, 'The start point is in the sea or open water. Move it onto land.')
    timings, warnings = {}, []
    t_all = time.time()
    reach = speed_kmh * max(intervals) + 2.0
    radius = max(radius_km or 0.0, reach)
    if radius > MAX_RADIUS_KM:
        warnings.append({'severity': 'warning', 'source': 'limits',
                         'message': f'The longest contour could extend about {reach:.0f} km on flat open ground, '
                                    f'beyond the {MAX_RADIUS_KM:.0f} km analysis limit. Contours are clipped at '
                                    f'{MAX_RADIUS_KM:.0f} km from the start point.'})
        radius = MAX_RADIUS_KM
    bbox = get_bbox_from_ipp(lat, lng, radius)
    cell_m = nz_sources.cell_size_m(bbox)
    if cell_m > COARSE_CELL_M:
        warnings.append({'severity': 'info', 'source': 'resolution',
                         'message': f'Large area: the grid is limited to 1000 x 1000 cells, so cells are about '
                                    f'{cell_m:.0f} m. Narrow trails are represented less precisely.'})

    def stage(name, fn, *a, **k):
        t = time.time()
        out = fn(*a, **k)
        timings[name] = round(time.time() - t, 2)
        return out

    _clear_work_dir()
    dem_path, w = stage('elevation', nz_sources.download_dem, bbox)
    warnings += w
    lc_path, w = stage('land_cover', nz_sources.download_nlcd, bbox)
    warnings += w
    osm = stage('osm', nz_sources.download_osm_features, bbox)
    warnings += osm.pop('_warnings', [])
    nhd, w = stage('hydrology', nz_sources.download_nhd_features, bbox)
    warnings += w
    # Refuse now, with a smaller radius or shorter band that should fit, rather than run for a minute and fail.
    refusal = density_guard.assess(time.time() - t_all, density_guard.segment_count(osm), radius, reach, speed_kmh,
                                   density_guard.budget_seconds(),
                                   density_guard.make_counter(osm, lambda r: get_bbox_from_ipp(lat, lng, r)))
    if refusal:
        suggestions = {k: refusal[k] for k in ('suggested_radius_km', 'suggested_max_hours') if k in refusal}
        raise ApiError(422, refusal['message'], extra={'code': 'area_too_dense', **suggestions},
                       log={k: refusal[k] for k in ('estimated_s', 'budget_s', 'segments')})
    cost_path = stage('cost_surface', build_cost_surface, dem_path, lc_path, osm, nhd_features=nhd)
    # Contours are cut at the longest time band, so cells costing more than that are never used: stop searching there.
    cd_path = stage('cost_distance', compute_cost_distance, cost_path, lat, lng, dem_path,
                    limit=max(intervals) * speed_kmh * 1000.0)
    contours = stage('contours', extract_isochrone_polygons, cd_path, speed_kmh, intervals)
    if len(contours['features']) < len(intervals):
        warnings.append({'severity': 'info', 'source': 'contours',
                         'message': 'Some time bands produced no contour (too short to leave the start cell, or '
                                    'blocked by water).'})
    timings['total'] = round(time.time() - t_all, 2)
    meta = nz_sources.osm_metadata()
    return {
        'status': 'ok',
        'mode': 'travel-time',
        'contours': contours,
        'parameters': {'speed_kmh': speed_kmh, 'intervals_hours': intervals, 'radius_km': round(radius, 2),
                       'cell_size_m': round(cell_m, 1)},
        'bbox': {'west': bbox[0], 'south': bbox[1], 'east': bbox[2], 'north': bbox[3]},
        'warnings': warnings,
        'data': {'land_cover': f"LCDB {nz_sources.LCDB_META['lcdb_version']} {nz_sources.LCDB_META['epoch']}",
                 'elevation': 'LINZ 1 m LiDAR DEM, Copernicus GLO-30 where missing',
                 'osm_built_at': meta.get('built_at')},
        'attribution': ATTRIBUTION,
        'disclaimer': DISCLAIMER,
        'timings_s': timings,
    }


# --------------------------------------------------------------------------------------------------------------
# Routing and event adapters
# --------------------------------------------------------------------------------------------------------------
def handle(method, path, headers, body, authenticated):
    """Return (status, payload dict). `authenticated` is True for IAM-authorised direct invokes."""
    route = path.rstrip('/') or '/'
    if route.startswith('/sar/') or route == '/sar':
        route = route[4:] or '/'
    if route == '/health':
        return 200, {'status': 'ok', 'service': 'sar-engine', 'lcdb': nz_sources.LCDB_META['lcdb_version']}
    if route != '/travel-time':
        raise ApiError(404, 'Not found')
    if method != 'POST':
        raise ApiError(405, 'Use POST')
    if not authenticated and not api_keys.is_authorized(headers.get('x-api-key', '')):
        raise ApiError(401, 'Unauthorized')
    args = parse_travel_time(body)
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):           # discard the pipeline's prints (they contain the IPP)
        payload = run_travel_time(*args)
    return 200, payload


def _log(**fields):
    print(json.dumps(fields, separators=(',', ':')))


def lambda_handler(event, context):
    started = time.time()
    request_id = getattr(context, 'aws_request_id', None)
    is_http = isinstance(event, dict) and ('httpMethod' in event or 'requestContext' in event)
    guard_log = None
    try:
        if is_http:
            ctx = event.get('requestContext') or {}
            method = (event.get('httpMethod') or (ctx.get('http') or {}).get('method') or 'GET').upper()
            path = event.get('path') or event.get('rawPath') or '/'
            headers = {str(k).lower(): str(v) for k, v in (event.get('headers') or {}).items()}
            raw = event.get('body') or ''
            if event.get('isBase64Encoded'):
                import base64
                raw = base64.b64decode(raw).decode('utf-8', 'replace')
            if len(raw.encode()) > MAX_BODY_BYTES:
                raise ApiError(413, 'Request body too large')
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                raise ApiError(400, 'Request body is not valid JSON')
            authenticated = False
        else:   # direct invoke: IAM is the gate
            event = event if isinstance(event, dict) else {}
            method = str(event.get('method', 'POST')).upper()
            path = str(event.get('path', '/travel-time'))
            body = event['body'] if 'body' in event else {k: v for k, v in event.items() if k not in ('method', 'path')}
            headers, authenticated = {}, True
        status, payload = handle(method, path, headers, body, authenticated)
    except ApiError as e:
        status, payload = e.status, {'status': 'error', 'message': e.message, **e.extra}
        guard_log = e.log
    except Exception as e:                                      # noqa: BLE001 - never leak internals to the caller
        _log(event='error', request_id=request_id, error=type(e).__name__, trace=traceback.format_exc(limit=6))
        status, payload = 500, {'status': 'error', 'message': 'Analysis failed. Try again, or try a smaller area.'}
    _log(event='request', request_id=request_id, status=status, duration_s=round(time.time() - started, 2),
         timings_s=payload.get('timings_s'), warnings=len(payload.get('warnings', [])) if status == 200 else None,
         density_guard=guard_log)
    if not is_http:
        return payload if status == 200 else {'statusCode': status, **payload}
    return {'statusCode': status, 'statusDescription': f'{status} {"OK" if status == 200 else "Error"}',
            'isBase64Encoded': False, 'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
            'body': json.dumps(payload, separators=(',', ':'))}
