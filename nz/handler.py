"""AWS Lambda handler for the TAK-NZ SAR engine.

Routes (an optional /sar prefix is accepted, so the ALB can route by path):
    GET  /health         liveness, no authentication
    POST /travel-time    terrain-aware travel-time isochrones from an Initial Planning Point (IPP)
    POST /tarr           Terrain-Aware Range Rings: Koester subject-distance rings, terrain-adjusted, plus plain circles

Request body for /travel-time (JSON):
    {"ipp": {"lat": -40.87, "lng": 175.45}, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10}
radius_km is optional. The analysis radius is at least speed x longest interval + 2 km (as in WiSAR), capped at
MAX_RADIUS_KM.

Request body for /tarr (JSON):
    {"ipp": {"lat": -40.87, "lng": 175.45}, "profile": "Hiker", "ecoregion": "Dry", "terrain": "Mountainous"}
ecoregion and terrain are optional. The Koester distances come from tarr_profiles.py, are scaled by multipliers that
default to the WiSAR Coconino County, Arizona set (configurable, see tarr.py; they are NOT calibrated for New Zealand,
and the response says so), and the analysis radius is the calibrated 75% distance + 2 km, capped at MAX_RADIUS_KM.
Each terrain-adjusted ring is returned together with the plain Koester circle.

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
import tarr
import nz_sources  # noqa: E402  (importing registers the LCDB codes and sets GDAL read options)
from fast_cost_distance import compute_cost_distance      # same results as the upstream function, about 30x faster
from fast_cost_surface import build_cost_surface           # same results as the upstream function, much faster
from pipeline.outputs import extract_contour_polygons, extract_isochrone_polygons
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
DISCLAIMER_TARR = ('Planning aid only. The ring percentages come from Koester (2008) United States search records, '
                   'scaled by multipliers fitted to Coconino County, Arizona missions. They are not calibrated for New '
                   'Zealand and are not New Zealand containment probabilities. The terrain model is not validated '
                   'against New Zealand search and rescue data.')
GENERIC_FAILURE = 'Analysis failed. Try again, or try a smaller area.'
TARR_DENSE_MESSAGE = ('This area has too much road and trail data to analyse within the time limit. Move the start '
                      'point, or choose a subject profile with a shorter search distance.')
WATER_MESSAGE = 'The start point is in the sea or open water. Move it onto land.'


class ApiError(Exception):
    """`extra` is merged into the JSON error body; `log` goes to the request log line (never coordinates);
    `log_event` is written as a log line of its own (a dict of plain fields such as an event name and an error class)."""
    def __init__(self, status, message, extra=None, log=None, log_event=None):
        super().__init__(message)
        self.status, self.message, self.extra, self.log, self.log_event = status, message, extra or {}, log, log_event


# --------------------------------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------------------------------
def _number(value, name, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(400, f'{name} must be a number')
    if not math.isfinite(value) or not lo <= value <= hi:
        raise ApiError(400, f'{name} must be between {lo:g} and {hi:g}')
    return float(value)


def _parse_ipp(body):
    if not isinstance(body, dict):
        raise ApiError(400, 'Request body must be a JSON object')
    ipp = body.get('ipp')
    if not isinstance(ipp, dict):
        raise ApiError(400, 'ipp {lat, lng} is required')
    lat = _number(ipp.get('lat'), 'ipp.lat', *NZ_BOUNDS['lat'])
    lng = _number(ipp.get('lng'), 'ipp.lng', *NZ_BOUNDS['lng'])
    return lat, lng


def parse_travel_time(body):
    lat, lng = _parse_ipp(body)
    speed = _number(body.get('speed_kmh'), 'speed_kmh', MIN_SPEED_KMH, MAX_SPEED_KMH)
    raw = body.get('intervals_hours')
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_INTERVALS:
        raise ApiError(400, f'intervals_hours must be a list of 1 to {MAX_INTERVALS} numbers')
    intervals = sorted({_number(h, 'intervals_hours[]', MIN_HOURS, MAX_HOURS) for h in raw})
    radius = body.get('radius_km')
    radius = None if radius is None else _number(radius, 'radius_km', 1.0, MAX_RADIUS_KM)
    return lat, lng, speed, intervals, radius


def parse_tarr(body):
    """(lat, lng, profile, ecoregion, terrain). The subject selection is validated against the Koester table."""
    lat, lng = _parse_ipp(body)
    profile, ecoregion, terrain = body.get('profile'), body.get('ecoregion'), body.get('terrain')
    try:
        tarr.resolve_distances(profile, ecoregion, terrain)
    except tarr.SelectionError as e:
        raise ApiError(400, str(e)) from None
    return lat, lng, profile, ecoregion, terrain


# --------------------------------------------------------------------------------------------------------------
# Analysis
# --------------------------------------------------------------------------------------------------------------
def _clear_work_dir():
    """Remove last run's intermediate files (flat directory; plain file removal only)."""
    for entry in os.scandir(WORK_DIR):
        if entry.is_file():
            os.remove(entry.path)


def _stage(timings, name, fn, *a, **k):
    t = time.time()
    out = fn(*a, **k)
    timings[name] = round(time.time() - t, 2)
    return out


def _read_and_solve(lat, lng, radius, guard, limit_m, warnings, timings, t_all):
    """The stages both routes share: read the four data sets for the area, run the dense-area guard, build the cost
    surface and solve cost distance from the start point. `guard(osm, elapsed_s)` returns an ApiError to refuse the
    request or None; `limit_m` stops the search at the largest distance the caller uses. Appends to `warnings` and
    `timings`. Returns (bbox, cell size in metres, path of the cost-distance raster)."""
    bbox = get_bbox_from_ipp(lat, lng, radius)
    cell_m = nz_sources.cell_size_m(bbox)
    if cell_m > COARSE_CELL_M:
        warnings.append({'severity': 'info', 'source': 'resolution',
                         'message': f'Large area: the grid is limited to 1000 x 1000 cells, so cells are about '
                                    f'{cell_m:.0f} m. Narrow trails are represented less precisely.'})
    _clear_work_dir()
    dem_path, w = _stage(timings, 'elevation', nz_sources.download_dem, bbox)
    warnings += w
    lc_path, w = _stage(timings, 'land_cover', nz_sources.download_nlcd, bbox)
    warnings += w
    osm = _stage(timings, 'osm', nz_sources.download_osm_features, bbox)
    warnings += osm.pop('_warnings', [])
    nhd, w = _stage(timings, 'hydrology', nz_sources.download_nhd_features, bbox)
    warnings += w
    # Refuse now, with a smaller radius or shorter band that should fit, rather than run for a minute and fail.
    refusal = guard(osm, time.time() - t_all)
    if refusal:
        raise refusal
    cost_path = _stage(timings, 'cost_surface', build_cost_surface, dem_path, lc_path, osm, nhd_features=nhd)
    # Contours are cut at the longest distance, so cells costing more than that are never used: stop searching there.
    cd_path = _stage(timings, 'cost_distance', compute_cost_distance, cost_path, lat, lng, dem_path, limit=limit_m)
    return bbox, cell_m, cd_path


def run_travel_time(lat, lng, speed_kmh, intervals, radius_km):
    if nz_sources.water_fraction_at(lat, lng) >= WATER_REJECT_FRACTION:
        raise ApiError(422, WATER_MESSAGE)
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

    def guard(osm, elapsed):
        refusal = density_guard.assess(elapsed, density_guard.segment_count(osm), radius, reach, speed_kmh,
                                       density_guard.budget_seconds(),
                                       density_guard.make_counter(osm, lambda r: get_bbox_from_ipp(lat, lng, r)))
        if not refusal:
            return None
        suggestions = {k: refusal[k] for k in ('suggested_radius_km', 'suggested_max_hours') if k in refusal}
        return ApiError(422, refusal['message'], extra={'code': 'area_too_dense', **suggestions},
                        log={k: refusal[k] for k in ('estimated_s', 'budget_s', 'segments')})

    bbox, cell_m, cd_path = _read_and_solve(lat, lng, radius, guard, max(intervals) * speed_kmh * 1000.0,
                                            warnings, timings, t_all)
    contours = _stage(timings, 'contours', extract_isochrone_polygons, cd_path, speed_kmh, intervals)
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
        'data': _data_versions(meta),
        'attribution': ATTRIBUTION,
        'disclaimer': DISCLAIMER,
        'timings_s': timings,
    }


def _data_versions(meta):
    return {'land_cover': f"LCDB {nz_sources.LCDB_META['lcdb_version']} {nz_sources.LCDB_META['epoch']}",
            'elevation': 'LINZ 1 m LiDAR DEM, Copernicus GLO-30 where missing',
            'osm_built_at': meta.get('built_at')}


def _tarr_guard(osm, elapsed):
    """The same time estimate as the travel-time guard. There is no radius or band for the caller to change, so a
    refusal carries no suggestion."""
    segments = density_guard.segment_count(osm)
    budget = density_guard.budget_seconds()
    estimated = density_guard.estimated_total_seconds(elapsed, segments)
    if estimated <= budget:
        return None
    return ApiError(422, TARR_DENSE_MESSAGE, extra={'code': 'area_too_dense'},
                    log={'estimated_s': round(estimated, 1), 'budget_s': budget, 'segments': int(segments)})


def run_tarr(lat, lng, profile, ecoregion, terrain):
    if nz_sources.water_fraction_at(lat, lng) >= WATER_REJECT_FRACTION:
        raise ApiError(422, WATER_MESSAGE)
    try:
        calibration = tarr.load_calibration()
        distances = tarr.resolve_distances(profile, ecoregion, terrain)
        m25, m50, m75, profile_specific = tarr.multipliers_for(calibration, profile)
        multipliers = (m25, m50, m75)
        calibrated = tarr.calibrate(distances, multipliers)
    except tarr.ConfigError as e:
        # Fail closed: a broken multiplier set never falls back to the Arizona set. Only the error class is logged.
        raise ApiError(500, GENERIC_FAILURE,
                       log_event={'event': 'tarr_calibration_invalid', 'error': type(e).__name__}) from None
    note, calibration_warning, calibration_line = tarr.calibration_texts(calibration)
    timings, warnings = {}, [{'severity': 'warning', 'source': 'calibration', 'message': calibration_warning}]
    t_all = time.time()
    radius, clipped = tarr.analysis_radius(calibrated[2], MAX_RADIUS_KM)
    if clipped:
        warnings.append({'severity': 'warning', 'source': 'limits',
                         'message': f'The calibrated Koester 75% distance of {calibrated[2]:.1f} km plus '
                                    f'{tarr.RADIUS_MARGIN_KM:g} km goes beyond the {MAX_RADIUS_KM:.0f} km analysis '
                                    f'limit. Terrain-adjusted rings are clipped at {MAX_RADIUS_KM:.0f} km from the '
                                    f'start point.'})
    bbox, cell_m, cd_path = _read_and_solve(lat, lng, radius, _tarr_guard, calibrated[2] * 1000.0,
                                            warnings, timings, t_all)
    upstream = _stage(timings, 'contours', extract_contour_polygons, cd_path, *calibrated)
    features, missing = _stage(timings, 'rings', tarr.build_features, lat, lng, distances, calibrated, multipliers,
                               upstream)
    if missing:
        warnings.append({'severity': 'info', 'source': 'contours',
                         'message': 'Some terrain-adjusted rings produced no contour (too small to leave the start '
                                    'cell, or blocked by water). Missing: ' + ', '.join(f'{p}%' for p in missing) + '.'})
    timings['total'] = round(time.time() - t_all, 2)
    meta = nz_sources.osm_metadata()
    return {
        'status': 'ok',
        'mode': 'tarr',
        'contours': {'type': 'FeatureCollection', 'features': features},
        'parameters': {'profile': profile, 'ecoregion': distances['ecoregion'], 'terrain': distances['terrain'],
                       'koester_km': {b: distances[b] for b in tarr.BANDS},
                       'calibrated_km': dict(zip(tarr.BANDS, calibrated)),
                       'radius_km': round(radius, 2), 'cell_size_m': round(cell_m, 1)},
        'calibration': {'region': calibration.label or tarr.DEFAULT_LABEL, 'source': calibration.source,
                        'profile_specific': profile_specific, 'multiplier': dict(zip(tarr.BANDS, multipliers)),
                        'calibrated_for_nz': False, 'note': note},
        'bbox': {'west': bbox[0], 'south': bbox[1], 'east': bbox[2], 'north': bbox[3]},
        'warnings': warnings,
        'data': _data_versions(meta),
        'attribution': ATTRIBUTION + [f'Subject distances: {tarr.KOESTER_SOURCE}', calibration_line],
        'disclaimer': DISCLAIMER_TARR,
        'timings_s': timings,
    }


ROUTES = {'/travel-time': (parse_travel_time, run_travel_time), '/tarr': (parse_tarr, run_tarr)}


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
    if route not in ROUTES:
        raise ApiError(404, 'Not found')
    if method != 'POST':
        raise ApiError(405, 'Use POST')
    if not authenticated and not api_keys.is_authorized(headers.get('x-api-key', '')):
        raise ApiError(401, 'Unauthorized')
    parse, run = ROUTES[route]
    args = parse(body)
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):           # discard the pipeline's prints (they contain the IPP)
        payload = run(*args)
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
        if e.log_event:
            _log(**e.log_event)
    except Exception as e:                                      # noqa: BLE001 - never leak internals to the caller
        _log(event='error', request_id=request_id, error=type(e).__name__, trace=traceback.format_exc(limit=6))
        status, payload = 500, {'status': 'error', 'message': GENERIC_FAILURE}
    _log(event='request', request_id=request_id, status=status, duration_s=round(time.time() - started, 2),
         timings_s=payload.get('timings_s'), warnings=len(payload.get('warnings', [])) if status == 200 else None,
         density_guard=guard_log)
    if not is_http:
        return payload if status == 200 else {'statusCode': status, **payload}
    return {'statusCode': status, 'statusDescription': f'{status} {"OK" if status == 200 else "Error"}',
            'isBase64Encoded': False, 'headers': {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
            'body': json.dumps(payload, separators=(',', ':'))}
