"""Check nz/handler.py routes with the heavy stages replaced by recording stubs.
Usage (from the repo root, with the engine's Python environment):  python nz/check_tarr_handler.py [--real]
What it does: imports the real handler (and so the real validation, routing, authentication, density guard and
response assembly), then replaces the data reads, the cost surface, the cost distance and the contour extraction by
fakes that record their arguments. Nothing touches the network or the data directory. Exit status is 1 on any failure.
--real (needs SAR_DATA_DIR pointing at the LCDB raster and OSM FlatGeobuf, and network access to the LINZ elevation
bucket): runs /tarr through the real pipeline for a bush site and checks the rings.
"""
import contextlib
import io
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
os.environ['SAR_API_KEY'] = KEY = 'check-tarr-handler-0123456789'
os.environ.pop('SAR_CONFIG_BUCKET', None)
os.environ.pop('SAR_TIME_BUDGET_S', None)
os.environ.pop('SAR_TARR_MULTIPLIERS', None)

import handler  # noqa: E402
import nz_sources  # noqa: E402
from pipeline.shared import get_bbox_from_ipp  # noqa: E402

LAT, LNG = -40.87, 175.45
CALLS = []
RESULTS = []


class FakeBounds:
    def __init__(self, arr):
        self.arr = arr

    def to_numpy(self):
        return self.arr


class FakeLines:
    """Stands in for a GeoDataFrame of line segments: only len() and geometry.bounds.to_numpy() are used."""
    def __init__(self, arr):
        self.arr = arr
        self.geometry = type('G', (), {'bounds': FakeBounds(arr)})()

    def __len__(self):
        return len(self.arr)


def spread_lines(n, lat, lng, half_width_km=30.0):
    """n tiny boxes spread evenly across a 60 km strip through the point (count grows about linearly with radius)."""
    west, _, east, _ = get_bbox_from_ipp(lat, lng, half_width_km)
    xs = np.linspace(west, east, n)
    return FakeLines(np.column_stack([xs, np.full(n, lat), xs, np.full(n, lat)]))


STATE = {'osm_lines': None, 'water': 0.0, 'rings': None, 'linz': {}}


def install_stubs():
    def record(name, ret):
        def fake(*a, **k):
            CALLS.append((name, a, k))
            return ret(*a, **k) if callable(ret) else ret
        return fake
    nz_sources.water_fraction_at = record('water', lambda lat, lng: STATE['water'])
    nz_sources.cell_size_m = record('cell_size', 12.5)
    nz_sources.download_dem = record('dem', ('/tmp/dem.tif', []))
    nz_sources.download_nlcd = record('lc', ('/tmp/lc.tif', []))
    nz_sources.download_osm_features = record(
        'osm', lambda bbox: {'trails': STATE['osm_lines'] or FakeLines(np.zeros((10, 4))),
                             'roads': None, 'powerlines': None, '_warnings': []})
    nz_sources.download_nhd_features = record('nhd', ('NHD', []))
    nz_sources.osm_metadata = record('meta', {'built_at': '2026-10-03T14:00:00+00:00'})
    # Not recorded, so the stage orders below stay as they were. {} means the LINZ waterways are not published.
    nz_sources.linz_water_metadata = lambda: STATE['linz']
    handler.build_cost_surface = record('cost_surface', '/tmp/cost.tif')
    handler.compute_cost_distance = record('cost_distance', '/tmp/cd.tif')
    handler.extract_isochrone_polygons = record(
        'isochrones', lambda path, speed, intervals: {
            'type': 'FeatureCollection',
            'features': [{'type': 'Feature', 'properties': {'hours': h}, 'geometry': None} for h in intervals]})
    if hasattr(handler, 'extract_contour_polygons'):
        handler.extract_contour_polygons = record('contours', lambda path, c25, c50, c75: STATE['rings'](c25, c50, c75))


def square(lat, lng, half):
    ring = [[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half], [lng - half, lat + half],
            [lng - half, lat - half]]
    return {'type': 'Polygon', 'coordinates': [ring]}


def fake_rings(c25, c50, c75, skip=()):
    out = []
    for label, half in (('25%', 0.01), ('50%', 0.02), ('75%', 0.04)):
        if label in skip:
            continue
        out.append({'type': 'Feature', 'geometry': square(LAT, LNG, half),
                    'properties': {'percentile': label, 'threshold_m': {'25%': c25, '50%': c50, '75%': c75}[label] * 1000,
                                   'color': '#000000', 'label_lat': LAT + 0.001, 'label_lng': LNG + 0.001}})
    return {'type': 'FeatureCollection', 'features': out}


def alb(path, body, key=KEY, method='POST'):
    headers = {'x-api-key': key} if key else {}
    return {'httpMethod': method, 'path': path, 'headers': headers, 'body': json.dumps(body),
            'requestContext': {'elb': {}}}


def call(event, **state):
    """Return (status, parsed body, captured stdout). Stages are stubs, so stdout holds the handler's log lines.
    Keyword arguments override the stub state for this call (for example linz={...})."""
    CALLS.clear()
    STATE.update(osm_lines=None, water=0.0, rings=fake_rings, linz={})
    STATE.update(state)
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        resp = handler.lambda_handler(event, None)
    return resp['statusCode'], json.loads(resp['body']), sink.getvalue()


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f'   {detail}'))
    return bool(ok)


def stage_names():
    return [c[0] for c in CALLS]


TT_BODY = {'ipp': {'lat': LAT, 'lng': LNG}, 'speed_kmh': 2.5, 'intervals_hours': [1, 2, 4], 'radius_km': 12}


def check_travel_time():
    status, body, out = call(alb('/sar/travel-time', TT_BODY))
    check('travel-time: 200 and mode', status == 200 and body.get('mode') == 'travel-time', (status, body))
    check('travel-time: top-level keys', set(body) == {
        'status', 'mode', 'contours', 'parameters', 'bbox', 'warnings', 'data', 'attribution', 'disclaimer',
        'timings_s'}, sorted(body))
    check('travel-time: stage order', stage_names() == [
        'water', 'cell_size', 'dem', 'lc', 'osm', 'nhd', 'cost_surface', 'cost_distance', 'isochrones', 'meta'],
        stage_names())
    bbox = get_bbox_from_ipp(LAT, LNG, 12)
    by_name = {c[0]: c for c in CALLS}
    check('travel-time: stage arguments',
          by_name['dem'][1] == (bbox,) and by_name['lc'][1] == (bbox,) and by_name['osm'][1] == (bbox,)
          and by_name['nhd'][1] == (bbox,)
          and by_name['cost_surface'][1][:3] == ('/tmp/dem.tif', '/tmp/lc.tif', by_name['cost_surface'][1][2])
          and by_name['cost_surface'][2] == {'nhd_features': 'NHD'}
          and by_name['cost_distance'][1] == ('/tmp/cost.tif', LAT, LNG, '/tmp/dem.tif')
          and by_name['cost_distance'][2] == {'limit': 4 * 2.5 * 1000.0}
          and by_name['isochrones'][1] == ('/tmp/cd.tif', 2.5, [1.0, 2.0, 4.0]), CALLS)
    check('travel-time: parameters', body['parameters'] == {
        'speed_kmh': 2.5, 'intervals_hours': [1.0, 2.0, 4.0], 'radius_km': 12.0, 'cell_size_m': 12.5}, body['parameters'])
    check('travel-time: log has no coordinates', '-40.87' not in out and '175.45' not in out, out)

    status, body, _ = call(alb('/travel-time', TT_BODY))
    check('travel-time: also served without /sar prefix', status == 200)

    CALLS.clear()
    STATE.update(osm_lines=None, water=0.9, rings=fake_rings)
    with contextlib.redirect_stdout(io.StringIO()):
        resp = handler.lambda_handler(alb('/sar/travel-time', TT_BODY), None)
    body = json.loads(resp['body'])
    check('travel-time: start point in water gives 422', resp['statusCode'] == 422 and body['message'] ==
          'The start point is in the sea or open water. Move it onto land.' and stage_names() == ['water'], body)

    CALLS.clear()
    STATE.update(osm_lines=spread_lines(400_000, LAT, LNG), water=0.0, rings=fake_rings)
    dense = dict(TT_BODY, radius_km=30)
    with contextlib.redirect_stdout(io.StringIO()):
        resp = handler.lambda_handler(alb('/sar/travel-time', dense), None)
    body = json.loads(resp['body'])
    check('travel-time: dense area gives 422 area_too_dense with a suggestion',
          resp['statusCode'] == 422 and body.get('code') == 'area_too_dense'
          and ('suggested_radius_km' in body or 'suggested_max_hours' in body) and 'cost_surface' not in stage_names(),
          body)

    status, body, _ = call(alb('/sar/travel-time', TT_BODY, key=''))
    check('travel-time: missing key gives 401', status == 401 and body['message'] == 'Unauthorized', body)
    status, body, _ = call(alb('/sar/travel-time', TT_BODY, key='wrong-key-0123456789ab'))
    check('travel-time: wrong key gives 401', status == 401, body)
    status, body, _ = call(alb('/sar/travel-time', TT_BODY, method='GET'))
    check('travel-time: GET gives 405', status == 405 and body['message'] == 'Use POST', body)
    status, body, _ = call(alb('/sar/nothing', TT_BODY))
    check('unknown path gives 404', status == 404 and body['message'] == 'Not found', body)
    status, body, _ = call(alb('/health', {}, key='', method='GET'))
    check('health answers without a key', status == 200 and body.get('service') == 'sar-engine', body)
    status, body, _ = call(alb('/sar/travel-time', dict(TT_BODY, speed_kmh=99)))
    check('travel-time: invalid speed gives 400', status == 400 and body['message'] == 'speed_kmh must be between 0.1 and 10', body)


def tarr_body(**over):
    body = {'ipp': {'lat': LAT, 'lng': LNG}, 'profile': 'Hiker'}
    body.update(over)
    return body


@contextlib.contextmanager
def env(**values):
    old = {k: os.environ.get(k) for k in values}
    os.environ.update({k: v for k, v in values.items() if v is not None})
    for k, v in values.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def check_tarr():
    status, body, out = call(alb('/sar/tarr', tarr_body()))
    check('tarr: 200 and mode', status == 200 and body.get('mode') == 'tarr', (status, body))
    check('tarr: top-level keys', set(body) == {
        'status', 'mode', 'contours', 'parameters', 'calibration', 'bbox', 'warnings', 'data', 'attribution',
        'disclaimer', 'timings_s'}, sorted(body))
    check('tarr: stage order', stage_names() == [
        'water', 'cell_size', 'dem', 'lc', 'osm', 'nhd', 'cost_surface', 'cost_distance', 'contours', 'meta'], stage_names())
    by_name = {c[0]: c for c in CALLS}
    bbox = get_bbox_from_ipp(LAT, LNG, 3.703 + 2.0)
    check('tarr: data reads use radius = calibrated p75 + 2 km', all(by_name[n][1] == (bbox,) for n in ('dem', 'lc', 'osm', 'nhd')),
          bbox)
    check('tarr: cost-distance limit is the calibrated p75 in metres', by_name['cost_distance'][2] == {'limit': 3703.0},
          by_name['cost_distance'])
    check('tarr: contours are cut at the calibrated distances',
          by_name['contours'][1] == ('/tmp/cd.tif', 0.736, 2.036, 3.703), by_name['contours'])
    check('tarr: parameters', body['parameters'] == {
        'profile': 'Hiker', 'ecoregion': None, 'terrain': None,
        'koester_km': {'p25': 0.64, 'p50': 1.77, 'p75': 3.22},
        'calibrated_km': {'p25': 0.736, 'p50': 2.036, 'p75': 3.703}, 'radius_km': 5.7, 'cell_size_m': 12.5}, body['parameters'])
    check('tarr: calibration', body['calibration'] == {
        'region': 'Coconino County, Arizona', 'source': 'built-in', 'profile_specific': True,
        'multiplier': {'p25': 1.15, 'p50': 1.15, 'p75': 1.15}, 'calibrated_for_nz': False,
        'note': 'Multipliers were fitted to search records from Coconino County, Arizona. They are not calibrated for '
                'New Zealand.'}, body['calibration'])
    feats = body['contours']['features']
    check('tarr: six features in draw order', [(f['properties']['kind'], f['properties']['percent']) for f in feats] == [
        ('plain', 75), ('terrain', 75), ('plain', 50), ('terrain', 50), ('plain', 25), ('terrain', 25)])
    check('tarr: ring names say distance and source', [f['properties']['label'] for f in feats] == [
        'Koester 75%, plain circle', 'Koester 75%, terrain-adjusted', 'Koester 50%, plain circle',
        'Koester 50%, terrain-adjusted', 'Koester 25%, plain circle', 'Koester 25%, terrain-adjusted'])
    check('tarr: always-present calibration warning', body['warnings'] == [
        {'severity': 'warning', 'source': 'calibration', 'message': 'Ring distances were scaled by multipliers fitted to '
         'Coconino County, Arizona. They are not calibrated for New Zealand.'}], body['warnings'])
    check('tarr: attribution lines', body['attribution'] == handler.ATTRIBUTION + [
        'Subject distances: Koester (2008), Lost Person Behavior, via Ferguson (2013), IGT4SAR',
        'Calibration multipliers: WiSAR, Coconino County, Arizona (not calibrated for New Zealand)'], body['attribution'])
    check('tarr: disclaimer says not calibrated and not containment probabilities',
          'not calibrated for New Zealand' in body['disclaimer'] and 'not New Zealand containment probabilities' in body['disclaimer'])
    check('tarr: timings include contours and rings', {'contours', 'rings', 'total', 'cost_distance'} <= set(body['timings_s']))
    check('tarr: log has no coordinates', '-40.87' not in out and '175.45' not in out, out)
    status, body, _ = call(alb('/tarr', tarr_body()))
    check('tarr: also served without /sar prefix', status == 200)

    # a profile that is not listed in the multiplier set uses the default
    status, body, _ = call(alb('/sar/tarr', tarr_body(profile='Runner')))
    check('tarr: unlisted profile uses 1.40 and says so', status == 200 and body['calibration']['profile_specific'] is False
          and body['calibration']['multiplier'] == {'p25': 1.4, 'p50': 1.4, 'p75': 1.4}, body.get('calibration'))
    # ecoregion and terrain pick the Koester row
    status, body, _ = call(alb('/sar/tarr', tarr_body(ecoregion='Dry', terrain='Mountainous')))
    check('tarr: ecoregion and terrain select the row', status == 200 and body['parameters']['koester_km'] ==
          {'p25': 1.61, 'p50': 3.22, 'p75': 6.44} and body['parameters']['ecoregion'] == 'Dry', body.get('parameters'))
    status, body, _ = call(alb('/sar/tarr', tarr_body(ecoregion=None, terrain=None)))
    check('tarr: null ecoregion and terrain are accepted', status == 200)

    # clipped at the 30 km limit
    status, body, _ = call(alb('/sar/tarr', tarr_body(profile='Snowmobiler', ecoregion='Temperate', terrain='Flat')))
    by_name = {c[0]: c for c in CALLS}
    limit_warning = [w for w in body.get('warnings', []) if w['source'] == 'limits']
    check('tarr: radius clipped to 30 km with a limits warning', status == 200 and body['parameters']['radius_km'] == 30.0
          and len(limit_warning) == 1 and limit_warning[0]['severity'] == 'warning'
          and by_name['dem'][1] == (get_bbox_from_ipp(LAT, LNG, 30.0),), (status, body.get('warnings')))
    check('tarr: the search limit is still the calibrated p75', by_name['cost_distance'][2] == {'limit': 57456.0},
          by_name['cost_distance'])

    # a ring the pipeline did not produce
    CALLS.clear()
    STATE.update(osm_lines=None, water=0.0, rings=lambda a, b, c: fake_rings(a, b, c, skip=('50%',)))
    with contextlib.redirect_stdout(io.StringIO()):
        resp = handler.lambda_handler(alb('/sar/tarr', tarr_body()), None)
    body = json.loads(resp['body'])
    notes = [w for w in body['warnings'] if w['source'] == 'contours']
    check('tarr: a missing ring gives an info note and leaves five features',
          resp['statusCode'] == 200 and len(body['contours']['features']) == 5 and len(notes) == 1
          and notes[0]['severity'] == 'info' and notes[0]['message'].endswith('Missing: 50%.'), body['warnings'])

    # invalid bodies
    bad = [
        (tarr_body(profile=None), 'profile is required'),
        ({'ipp': {'lat': LAT, 'lng': LNG}}, 'profile is required'),
        (tarr_body(profile=7), 'profile is required'),
        (tarr_body(profile='Nobody'), 'profile is not a supported subject profile'),
        (tarr_body(ecoregion=3), 'ecoregion must be a text value'),
        (tarr_body(terrain=3), 'terrain must be a text value'),
        (tarr_body(ecoregion='Urban'), 'ecoregion is not available for this profile'),
        (tarr_body(terrain='Flat'), 'terrain is not available for this profile and ecoregion'),
        (tarr_body(ecoregion='Dry', terrain='Flat', profile='Angler'), 'terrain is not available for this profile and ecoregion'),
        ({'profile': 'Hiker'}, 'ipp {lat, lng} is required'),
        (tarr_body(ipp={'lat': 10, 'lng': LNG}), 'ipp.lat must be between -48 and -33.5'),
        (tarr_body(ipp={'lat': LAT, 'lng': 10}), 'ipp.lng must be between 165.5 and 179.5'),
        (tarr_body(ipp={'lat': 'x', 'lng': LNG}), 'ipp.lat must be a number'),
        ([1], 'Request body must be a JSON object'),
    ]
    wrong = []
    for body_in, message in bad:
        status, body, _ = call(alb('/sar/tarr', body_in))
        if not (status == 400 and body == {'status': 'error', 'message': message} and not CALLS):
            wrong.append((body_in, status, body))
    check(f'tarr: {len(bad)} invalid bodies give the documented 400 and run no stage', not wrong, wrong)
    status, body, _ = call(alb('/sar/tarr', tarr_body(radius_km=99, speed_kmh=99)))
    check('tarr: unknown keys are ignored', status == 200)

    status, body, _ = call(alb('/sar/tarr', tarr_body(), key=''))
    check('tarr: missing key gives 401', status == 401 and not CALLS, body)
    status, body, _ = call(alb('/sar/tarr', tarr_body(), method='GET'))
    check('tarr: GET gives 405', status == 405, body)
    status, body, _ = call(alb('/sar/tarr', 'not an object', key=KEY))
    check('tarr: a body that is not an object gives 400', status == 400, body)

    # water
    CALLS.clear()
    STATE.update(osm_lines=None, water=0.9, rings=fake_rings)
    with contextlib.redirect_stdout(io.StringIO()):
        resp = handler.lambda_handler(alb('/sar/tarr', tarr_body()), None)
    body = json.loads(resp['body'])
    check('tarr: start point in water gives 422 before any data is read', resp['statusCode'] == 422 and body == {
        'status': 'error', 'message': 'The start point is in the sea or open water. Move it onto land.'}
        and stage_names() == ['water'], body)

    # dense area: same estimate as travel time, no suggestion fields
    with env(SAR_TIME_BUDGET_S='5'):
        CALLS.clear()
        STATE.update(osm_lines=spread_lines(400_000, LAT, LNG), water=0.0, rings=fake_rings)
        with contextlib.redirect_stdout(io.StringIO()):
            resp = handler.lambda_handler(alb('/sar/tarr', tarr_body()), None)
        body = json.loads(resp['body'])
    check('tarr: dense area gives 422 area_too_dense with no suggestion', resp['statusCode'] == 422 and body == {
        'status': 'error', 'code': 'area_too_dense', 'message': handler.TARR_DENSE_MESSAGE} and 'cost_surface' not in stage_names(),
          body)

    # multiplier configuration
    per_band = json.dumps({'label': 'Test set', 'default': 1.0,
                           'profiles': {'Hiker': {'p25': 1.0, 'p50': 1.10, 'p75': 1.40}}})
    with env(SAR_TARR_MULTIPLIERS=per_band):
        status, body, _ = call(alb('/sar/tarr', tarr_body()))
        terrain = [f['properties'] for f in body['contours']['features'] if f['properties']['kind'] == 'terrain']
    check('tarr: configured per-band multipliers are used and reported',
          status == 200 and body['calibration']['source'] == 'environment' and body['calibration']['region'] == 'Test set'
          and body['calibration']['multiplier'] == {'p25': 1.0, 'p50': 1.1, 'p75': 1.4}
          and body['parameters']['calibrated_km'] == {'p25': 0.64, 'p50': 1.947, 'p75': 4.508}
          and [t['multiplier'] for t in terrain] == [1.4, 1.1, 1.0] and body['parameters']['radius_km'] == 6.51
          and any('Test set' in line for line in body['attribution']), body.get('calibration'))
    with env(SAR_TARR_MULTIPLIERS='{"default": 99}'):
        status, body, out = call(alb('/sar/tarr', tarr_body()))
        tt_status, _, _ = call(alb('/sar/travel-time', TT_BODY))
    check('tarr: a bad multiplier set fails closed with a generic 500 and a log line', status == 500 and body == {
        'status': 'error', 'message': 'Analysis failed. Try again, or try a smaller area.'}
        and '{"event":"tarr_calibration_invalid","error":"ConfigError"}' in out,
          (status, body, out))
    check('tarr: ... and travel-time is unaffected', tt_status == 200)

    # direct invoke, no key
    CALLS.clear()
    STATE.update(osm_lines=None, water=0.0, rings=fake_rings)
    with contextlib.redirect_stdout(io.StringIO()):
        payload = handler.lambda_handler({'method': 'POST', 'path': '/tarr', 'body': tarr_body()}, None)
    check('tarr: direct invoke works without a key', payload.get('mode') == 'tarr' and len(payload['contours']['features']) == 6)
    with contextlib.redirect_stdout(io.StringIO()):
        payload = handler.lambda_handler({'method': 'POST', 'path': '/sar/tarr', 'body': {'ipp': {'lat': LAT, 'lng': LNG}}}, None)
    check('tarr: direct invoke reports validation errors', payload.get('statusCode') == 400 and payload['message'] == 'profile is required', payload)


def run_real():
    """Through the real handler and data: a bush site, Hiker. Needs SAR_DATA_DIR and network access."""
    import time
    from shapely.geometry import shape
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        t = time.time()
        resp = handler.lambda_handler(alb('/sar/tarr', tarr_body()), None)
        took = time.time() - t
    body = json.loads(resp['body'])
    check(f'real: Hiker at a bush site answers 200 in {took:.1f}s', resp['statusCode'] == 200 and body.get('mode') == 'tarr',
          (resp['statusCode'], body.get('message')))
    if resp['statusCode'] != 200:
        return
    feats = body['contours']['features']
    check('real: six features', len(feats) == 6, [f['properties']['label'] for f in feats])
    terrain = {f['properties']['percent']: shape(f['geometry']) for f in feats if f['properties']['kind'] == 'terrain'}
    plain = {f['properties']['percent']: shape(f['geometry']) for f in feats if f['properties']['kind'] == 'plain'}
    check('real: terrain ring areas grow 25 < 50 < 75', len(terrain) == 3 and terrain[25].area < terrain[50].area < terrain[75].area,
          {k: v.area for k, v in terrain.items()})
    bb = body['bbox']
    inside = all(bb['west'] <= g.bounds[0] and g.bounds[2] <= bb['east'] and bb['south'] <= g.bounds[1] and g.bounds[3] <= bb['north']
                 for g in terrain.values())
    check('real: every terrain ring lies inside the response bbox', inside, (bb, {k: v.bounds for k, v in terrain.items()}))
    print('      terrain/plain area ratio:', {k: round(terrain[k].area / plain[k].area, 2) for k in terrain if k in plain},
          'timings', body['timings_s'])
    printed = sink.getvalue()
    check('real: the log lines contain no coordinates', '-40.87' not in printed and '175.45' not in printed, printed[:300])


LINZ_META = {'built_at': '2026-10-31T00:00:00+00:00', 'source': 'linz-vector-tiles.mbtiles', 'features': 5}


def check_linz_water():
    """The LINZ waterways are credited and versioned only when they are published."""
    off_status, off, _ = call(alb('/sar/travel-time', TT_BODY))
    check('linz off: no LINZ attribution line, none in data versions',
          off_status == 200 and off['attribution'] == handler.ATTRIBUTION and 'linz_waterways_built_at' not in off['data'],
          (off['attribution'], off['data']))
    status, body, _ = call(alb('/sar/travel-time', TT_BODY), linz=LINZ_META)
    attribution = body['attribution']
    check('linz on, travel-time: credited before the method line, other lines unchanged',
          status == 200 and attribution == handler.ATTRIBUTION[:-1] + [handler.LINZ_WATER_ATTRIBUTION]
          + handler.ATTRIBUTION[-1:] and 'CC BY 4.0' in handler.LINZ_WATER_ATTRIBUTION, attribution)
    check('linz on, travel-time: build date in the data versions',
          body['data'].get('linz_waterways_built_at') == LINZ_META['built_at']
          and body['data']['osm_built_at'] == '2026-10-03T14:00:00+00:00', body['data'])
    status, body, _ = call(alb('/sar/tarr', tarr_body()), linz=LINZ_META)
    check('linz on, tarr: credited, with the Koester and calibration lines after it',
          status == 200 and handler.LINZ_WATER_ATTRIBUTION in body['attribution'][:-2]
          and body['attribution'][-2].startswith('Subject distances:')
          and body['data'].get('linz_waterways_built_at') == LINZ_META['built_at'], body.get('attribution'))


def main():
    if '--real' in sys.argv:
        check_real = True
        if not os.environ.get('SAR_DATA_DIR'):
            print('FAIL  --real needs SAR_DATA_DIR')
            return 1
    else:
        check_real = False
        install_stubs()
        check_travel_time()
        check_tarr()
        check_linz_water()
    if check_real:
        run_real()
    ok = all(RESULTS)
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
