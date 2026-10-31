"""Check nz/handler.py routes with the heavy stages replaced by recording stubs.
Usage (from the repo root, with the engine's Python environment):  python nz/check_tarr_handler.py
What it does: imports the real handler (and so the real validation, routing, authentication, density guard and
response assembly), then replaces the data reads, the cost surface, the cost distance and the contour extraction by
fakes that record their arguments. Nothing touches the network or the data directory. Exit status is 1 on any failure.
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


STATE = {'osm_lines': None, 'water': 0.0, 'rings': None}


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


def call(event):
    """Return (status, parsed body, captured stdout). Stages are stubs, so stdout holds the handler's log lines."""
    CALLS.clear()
    STATE.update(osm_lines=None, water=0.0, rings=fake_rings)
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


def main():
    install_stubs()
    check_travel_time()
    ok = all(RESULTS)
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
