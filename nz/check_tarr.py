"""Check the pure logic of the /tarr route: nz/tarr.py and nz/tarr_profiles.py.
Usage (from the repo root):  python3 nz/check_tarr.py        (standard library only; no heavy imports)
Checks:
  a. the Koester table equals the JSON literal in app/static/app.js (profiles, order, rows, numbers);
  b. subject selection: default, exact and fallback rows, and every invalid combination with its exact message;
  c. the built-in multipliers equal CALIBRATION_MULTIPLIERS / CALIBRATION_DEFAULT in app/server.py;
  d. parse_calibration accepts the documented forms and rejects everything else;
  e. load_calibration precedence, fail-closed behaviour and the file cache;
  f. calibrated distances and the analysis radius;
  g. the plain circles; h. the ring features.
Exit status is 1 if anything fails.
"""
import ast
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
sys.path.insert(0, HERE)
import api_keys  # noqa: E402
import tarr  # noqa: E402
import tarr_profiles  # noqa: E402

RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f'   {detail}'))


def raises(exc, fn, *a, message=None, **k):
    try:
        fn(*a, **k)
    except exc as e:
        return message is None or str(e) == message
    return False


def haversine_km(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * tarr.EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def check_table():
    path = os.path.join(ROOT, 'app', 'static', 'app.js')
    with open(path, encoding='utf-8') as fh:
        line = next(l for l in fh if l.strip().startswith('var LPB_DATA='))
    upstream = json.loads(re.match(r'^var LPB_DATA=(.*);$', line.strip()).group(1))
    expected = {name: [(r['eco'], r['terrain'], *r['distances']) for r in rows] for name, rows in upstream.items()}
    ours = tarr_profiles.LPB_DATA
    check('a. Koester table equals app/static/app.js (profiles, order, rows, numbers)',
          list(ours) == list(expected) and all(list(map(tuple, ours[k])) == expected[k] for k in expected))
    check('a. 28 profiles, 72 rows', len(ours) == 28 and sum(len(v) for v in ours.values()) == 72)
    check('a. distances increase in every row', all(r[2] < r[3] < r[4] for v in ours.values() for r in v))
    check('a. every profile has a default row', all(any(r[0] is None and r[1] is None for r in v) for v in ours.values()))


def check_selection():
    r = tarr.resolve_distances('Hiker')
    check('b. Hiker default row', (r['p25'], r['p50'], r['p75'], r['ecoregion'], r['terrain']) == (0.64, 1.77, 3.22, None, None), r)
    r = tarr.resolve_distances('Hiker', 'Dry', 'Mountainous')
    check('b. exact row', (r['p75'], r['ecoregion'], r['terrain']) == (6.44, 'Dry', 'Mountainous'), r)
    r = tarr.resolve_distances('Angler', 'Dry')
    check('b. ecoregion-only row', (r['p25'], r['ecoregion'], r['terrain']) == (3.22, 'Dry', None), r)
    r = tarr.resolve_distances('Hiker', 'Temperate')
    check('b. ecoregion listed with a terrain row only falls back to the default row',
          (r['p25'], r['ecoregion'], r['terrain']) == (0.64, None, None), r)
    r = tarr.resolve_distances('Angler', 'Dry', None)
    check('b. terrain None is the same as absent', r['terrain'] is None)
    cases = [
        ((None,), 'profile is required'),
        ((5,), 'profile is required'),
        (('',), 'profile is required'),
        (('hiker',), 'profile is not a supported subject profile'),
        (('Nobody',), 'profile is not a supported subject profile'),
        (('Hiker', 5), 'ecoregion must be a text value'),
        (('Hiker', None, 5), 'terrain must be a text value'),
        (('Hiker', 'Urban'), 'ecoregion is not available for this profile'),
        (('Hiker', 'temperate'), 'ecoregion is not available for this profile'),
        (('Hiker', None, 'Flat'), 'terrain is not available for this profile and ecoregion'),
        (('Hiker', 'Dry', 'Steep'), 'terrain is not available for this profile and ecoregion'),
        (('Angler', 'Dry', 'Flat'), 'terrain is not available for this profile and ecoregion'),
    ]
    bad = [(args, msg) for args, msg in cases if not raises(tarr.SelectionError, tarr.resolve_distances, *args, message=msg)]
    check(f'b. {len(cases)} invalid selections give the documented message', not bad, bad)
    # every (profile, ecoregion, terrain) the table lists resolves to itself
    exact = all(tarr.resolve_distances(n, e, t)['p50'] == p50 for n, rows in tarr_profiles.LPB_DATA.items()
                for e, t, _, p50, _ in rows)
    check('b. every listed row resolves to itself', exact)


def check_builtin():
    with open(os.path.join(ROOT, 'app', 'server.py'), encoding='utf-8') as fh:
        tree = ast.parse(fh.read())
    values = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id in ('CALIBRATION_MULTIPLIERS', 'CALIBRATION_DEFAULT'):
            values[node.targets[0].id] = ast.literal_eval(node.value)
    check('c. Arizona multipliers equal app/server.py', values.get('CALIBRATION_MULTIPLIERS') == tarr.ARIZONA_MULTIPLIERS
          and values.get('CALIBRATION_DEFAULT') == tarr.ARIZONA_DEFAULT, values)
    check('c. the profile list is the 7 documented profiles', set(tarr.ARIZONA_MULTIPLIERS) <= set(tarr_profiles.LPB_DATA)
          and len(tarr.ARIZONA_MULTIPLIERS) == 7)
    check('c. Hiker is 1.15 for all three bands', tarr.multipliers_for(tarr.BUILT_IN, 'Hiker') == (1.15, 1.15, 1.15, True))
    check('c. an unlisted profile gets 1.40, not profile-specific',
          tarr.multipliers_for(tarr.BUILT_IN, 'Runner') == (1.4, 1.4, 1.4, False))
    check('c. built-in region and source', tarr.BUILT_IN.label == 'Coconino County, Arizona' and tarr.BUILT_IN.source == 'built-in')


def check_parse():
    ok = tarr.parse_calibration
    c = ok('{"label":"Test","default":1.5,"profiles":{"Hiker":1.1,"Dementia":{"p25":2.5,"p50":2.55,"p75":2.5}}}', 'environment')
    check('d. scalar and per-band forms', c.default == (1.5,) * 3 and c.profiles['Hiker'] == (1.1,) * 3
          and c.profiles['Dementia'] == (2.5, 2.55, 2.5) and c.label == 'Test' and c.source == 'environment', c)
    check('d. an object works as well as text', ok({'default': 1}, 'config-file').label is None)
    check('d. limits 0.1 and 10 are accepted', ok({'default': 0.1, 'profiles': {'Hiker': 10}}, 'x').profiles['Hiker'] == (10.0,) * 3)
    bad_inputs = {
        'missing default': {'profiles': {}},
        'bool default': {'default': True},
        'bool in band': {'default': {'p25': 1, 'p50': False, 'p75': 1}},
        'NaN': '{"default": NaN}',
        'Infinity': '{"default": Infinity}',
        'string number': {'default': '1.4'},
        'below 0.1': {'default': 0.05},
        'above 10': {'default': 11},
        'unknown key': {'default': 1, 'extra': 1},
        'unknown profile': {'default': 1, 'profiles': {'Nobody': 1.2}},
        'missing band': {'default': {'p25': 1, 'p50': 1}},
        'extra band': {'default': {'p25': 1, 'p50': 1, 'p75': 1, 'p90': 1}},
        'profiles not an object': {'default': 1, 'profiles': [1]},
        'long label': {'default': 1, 'label': 'x' * 81},
        'label control character': {'default': 1, 'label': 'a\nb'},
        'label not text': {'default': 1, 'label': 5},
        'not JSON': 'not json',
        'JSON but not an object': '[1]',
        'text over 4096 characters': '{"default": 1, "label": "' + 'x' * 4100 + '"}',
    }
    failures = [name for name, raw in bad_inputs.items() if not raises(tarr.ConfigError, ok, raw, 'environment')]
    check(f'd. {len(bad_inputs)} invalid sets raise ConfigError', not failures, failures)
    check('d. a label of exactly 80 characters is accepted', ok({'default': 1, 'label': 'x' * 80}, 'x').label == 'x' * 80)


def check_load():
    good = '{"label":"Env set","default":2.0}'
    saved = api_keys._read_config_file
    reads = []

    def fake_read(bucket, key):
        reads.append((bucket, key))
        return {'apiKeys': {}, 'tarrMultipliers': {'label': 'File set', 'default': 1.2}}
    api_keys._read_config_file = fake_read
    try:
        tarr.reset_cache()
        check('e. nothing configured gives the built-in set', tarr.load_calibration({}) is tarr.BUILT_IN)
        check('e. an empty environment variable counts as not set', tarr.load_calibration({'SAR_TARR_MULTIPLIERS': ''}) is tarr.BUILT_IN)
        both = {'SAR_TARR_MULTIPLIERS': good, 'SAR_CONFIG_BUCKET': 'b', 'SAR_CONFIG_KEY': 'k'}
        c = tarr.load_calibration(both)
        check('e. the environment wins over the file', c.label == 'Env set' and c.source == 'environment' and not reads, (c, reads))
        files = {'SAR_CONFIG_BUCKET': 'b', 'SAR_CONFIG_KEY': 'k'}
        c = tarr.load_calibration(files, now=1000.0)
        check('e. the file wins over the built-in set', c.label == 'File set' and c.source == 'config-file' and len(reads) == 1, (c, reads))
        tarr.load_calibration(files, now=1000.0 + tarr.CACHE_SECONDS - 1)
        check('e. the file is cached for 5 minutes', len(reads) == 1, reads)
        tarr.load_calibration(files, now=1000.0 + tarr.CACHE_SECONDS)
        check('e. the file is read again after 5 minutes', len(reads) == 2, reads)
        check('e. a bad environment value raises and does not fall back',
              raises(tarr.ConfigError, tarr.load_calibration, {'SAR_TARR_MULTIPLIERS': '{"default": 99}', **files}))
        api_keys._read_config_file = lambda b, k: {'apiKeys': {}}
        tarr.reset_cache()
        check('e. a file without tarrMultipliers gives the built-in set', tarr.load_calibration(files, now=1.0) is tarr.BUILT_IN)
        api_keys._read_config_file = lambda b, k: {'tarrMultipliers': {'default': 0}}
        tarr.reset_cache()
        check('e. an invalid tarrMultipliers raises', raises(tarr.ConfigError, tarr.load_calibration, files, now=1.0))

        def boom(b, k):
            raise OSError('secret detail')
        api_keys._read_config_file = boom
        tarr.reset_cache()
        err = _error_of(lambda: tarr.load_calibration(files, now=1.0))
        check('e. an unreadable file raises ConfigError naming only the class',
              isinstance(err, tarr.ConfigError) and 'secret detail' not in str(err) and 'OSError' in str(err), err)
        api_keys._read_config_file = fake_read
        check('e. a failed read is retried on the next call, not cached', tarr.load_calibration(files, now=2.0).label == 'File set')
    finally:
        api_keys._read_config_file = saved
        tarr.reset_cache()


def _error_of(fn):
    try:
        fn()
    except Exception as e:      # noqa: BLE001
        return e
    return None


def check_numbers():
    hiker = tarr.resolve_distances('Hiker')
    m = tarr.multipliers_for(tarr.BUILT_IN, 'Hiker')
    cal = tarr.calibrate(hiker, m)
    check('f. Hiker default row calibrates to 0.736 / 2.036 / 3.703',
          all(abs(a - b) < 1e-9 for a, b in zip(cal, (0.736, 2.036, 3.703))), cal)
    radius, clipped = tarr.analysis_radius(cal[2], 30.0)
    check('f. Hiker radius is p75 + 2 = 5.7 and not clipped', abs(radius - 5.703) < 1e-9 and not clipped, (radius, clipped))
    snow = tarr.resolve_distances('Snowmobiler', 'Temperate', 'Flat')
    cal = tarr.calibrate(snow, tarr.multipliers_for(tarr.BUILT_IN, 'Snowmobiler'))
    check('f. Snowmobiler Temperate Flat is clipped to 30 km', tarr.analysis_radius(cal[2], 30.0) == (30.0, True), cal)
    cfg = tarr.parse_calibration({'default': 1, 'profiles': {'Hunter': {'p25': 3, 'p50': 2, 'p75': 1}}}, 'x')
    check('f. multipliers that reorder the bands are refused',
          raises(tarr.ConfigError, tarr.calibrate, tarr.resolve_distances('Hunter'), tarr.multipliers_for(cfg, 'Hunter')))


def check_circle():
    lat, lng, r = -40.87, 175.45, 3.22
    poly = tarr.circle_polygon(lat, lng, r)
    ring = poly['coordinates'][0]
    check('g. closed ring of 73 positions', poly['type'] == 'Polygon' and len(ring) == 73 and ring[0] == ring[-1], len(ring))
    area2 = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))
    check('g. counter-clockwise (positive signed area)', area2 > 0, area2)
    worst = max(abs(haversine_km(lat, lng, y, x) - r) / r for x, y in ring)
    check('g. every vertex within 0.5% of the radius', worst < 0.005, worst)
    check('g. 5 decimals', all(round(v, 5) == v for pos in ring for v in pos))
    check('g. the first vertex is due north of the centre', ring[0][1] > lat and abs(ring[0][0] - lng) < 1e-4, ring[0])


def square(lat, lng, half):
    return {'type': 'Polygon', 'coordinates': [[[lng - half, lat - half], [lng + half, lat - half], [lng + half, lat + half],
                                                [lng - half, lat + half], [lng - half, lat - half]]]}


def fake_upstream(lat, lng, skip=()):
    feats = [{'type': 'Feature', 'geometry': square(lat, lng, h),
              'properties': {'percentile': p, 'threshold_m': 1.0, 'color': '#fff', 'label_lat': 1.5, 'label_lng': 2.5}}
             for p, h in (('25%', 0.01), ('50%', 0.02), ('75%', 0.04)) if p not in skip]
    return {'type': 'FeatureCollection', 'features': feats}


def check_features():
    lat, lng = -40.87, 175.45
    d = tarr.resolve_distances('Hiker')
    m = tarr.multipliers_for(tarr.BUILT_IN, 'Hiker')[:3]
    cal = tarr.calibrate(d, m)
    feats, missing = tarr.build_features(lat, lng, d, cal, m, fake_upstream(lat, lng))
    order = [(f['properties']['kind'], f['properties']['percent']) for f in feats]
    check('h. draw order and count', order == [('plain', 75), ('terrain', 75), ('plain', 50), ('terrain', 50), ('plain', 25),
                                              ('terrain', 25)] and missing == [], order)
    t50 = feats[3]['properties']
    p50 = feats[2]['properties']
    check('h. terrain properties', t50 == {'kind': 'terrain', 'percent': 50, 'label': 'Koester 50%, terrain-adjusted',
                                           'color': '#f57c00', 'koester_km': 1.77, 'distance_km': 2.036, 'threshold_m': 2036.0,
                                           'multiplier': 1.15, 'label_lat': 1.5, 'label_lng': 2.5}, t50)
    check('h. plain properties', set(p50) == {'kind', 'percent', 'label', 'color', 'koester_km', 'distance_km', 'label_lat',
                                             'label_lng'} and p50['label'] == 'Koester 50%, plain circle'
          and p50['distance_km'] == p50['koester_km'] == 1.77, p50)
    check('h. plain and terrain of one percent share the colour',
          all(feats[i]['properties']['color'] == feats[i + 1]['properties']['color'] == tarr.COLORS[feats[i]['properties']['percent']]
              for i in (0, 2, 4)))
    check('h. the plain circle label point is the top of the circle',
          p50['label_lat'] > lat and abs(haversine_km(lat, lng, p50['label_lat'], p50['label_lng']) - 1.77) < 0.01)
    feats, missing = tarr.build_features(lat, lng, d, cal, m, fake_upstream(lat, lng, skip=('50%',)))
    kinds = [(f['properties']['kind'], f['properties']['percent']) for f in feats]
    check('h. a missing 50% ring is reported and its plain circle remains',
          missing == [50] and ('plain', 50) in kinds and ('terrain', 50) not in kinds and len(feats) == 5, (kinds, missing))
    feats, missing = tarr.build_features(lat, lng, d, cal, m, {'type': 'FeatureCollection', 'features': []})
    check('h. no terrain rings at all leaves the three plain circles', missing == [25, 50, 75] and len(feats) == 3)
    note, warning, line = tarr.calibration_texts(tarr.BUILT_IN)
    check('h. Arizona texts', note == 'Multipliers were fitted to search records from Coconino County, Arizona. They are not '
          'calibrated for New Zealand.' and warning == 'Ring distances were scaled by multipliers fitted to Coconino County, '
          'Arizona. They are not calibrated for New Zealand.' and line == 'Calibration multipliers: WiSAR, Coconino County, '
          'Arizona (not calibrated for New Zealand)', (note, warning, line))


def main():
    check_table()
    check_selection()
    check_builtin()
    check_parse()
    check_load()
    check_numbers()
    check_circle()
    check_features()
    ok = all(RESULTS)
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
