"""Check the LINZ waterways: the builder (linz_water_build.py), the merge into the engine's OSM waterways
(nz_sources._add_linz_waterways) and what ends up in the cost surface.
Usage (from the repo root, with the engine's Python environment):  python nz/check_linz_water.py [--real]
Without --real nothing touches the network or the real data directory: every case uses synthetic frames and a temporary
data directory. --real (needs SAR_DATA_DIR holding linz_water.fgb, linz_water_meta.geojson and the OSM files) reads real
areas and checks the merged waterways against the OSM-only ones. Exit status is 1 on any failure.
"""
import contextlib
import io
import json
import os
import sys
import tempfile

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, Polygon

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
import fast_cost_surface as fast  # noqa: E402
import linz_water_build as build  # noqa: E402
import nz_sources  # noqa: E402

RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ('' if ok else f'   {detail}'))
    return bool(ok)


def tiles_frame(kinds, geoms):
    """A frame shaped like what the MVT driver returns: kind plus Multi* geometries in EPSG:3857."""
    return gpd.GeoDataFrame({'kind': kinds}, geometry=geoms, crs='EPSG:3857')


def mline(*coords):
    from shapely.geometry import MultiLineString
    return MultiLineString([coords])


def check_builder():
    base = 19_500_000.0                                                 # about 175 E in EPSG:3857
    lines = tiles_frame(
        ['river', 'stream', 'drain', 'water_race', 'wharf', 'wharf_edge', 'boom', 'marine_farm', 'waterfall', 'flume'],
        [mline((base + i, -5_000_000.0), (base + i + 100, -5_000_100.0)) for i in range(10)])
    out = build.classify_lines(lines)
    check('builder: only watercourse kinds are kept (river, stream, drain, water_race)', len(out) == 4, len(out))
    check('builder: every LINZ line becomes type stream, name empty, EPSG:3857 until combine',
          set(out['type']) == {'stream'} and set(out['name']) == {''} and out.crs.to_epsg() == 3857,
          (set(out['type']), out.crs))
    check('builder: Multi* rows are split into LineStrings', set(out.geom_type) == {'LineString'}, set(out.geom_type))

    square = Polygon([(base, -5e6), (base + 400, -5e6), (base + 400, -5e6 + 400), (base, -5e6 + 400)])
    bowtie = Polygon([(base, -5e6), (base + 400, -5e6 + 400), (base + 400, -5e6), (base, -5e6 + 400)])   # self-crossing
    from shapely.geometry import MultiPolygon
    polys = tiles_frame(['river', 'river', 'water', 'reef', 'stream'],
                        [MultiPolygon([square]), MultiPolygon([bowtie]), MultiPolygon([square]),
                         MultiPolygon([square]), MultiPolygon([square])])
    pout = build.classify_polygons(polys)
    check('builder: only river polygons are kept (lakes, reefs and stream-kind areas are not)',
          len(pout) >= 2 and set(pout['type']) == {'river'}, (len(pout), set(pout['type'])))
    check('builder: a self-crossing river polygon is repaired and still valid',
          bool(pout.geometry.is_valid.all()) and set(pout.geom_type) == {'Polygon'}, set(pout.geom_type))

    both = build.combine(out, pout)
    check('combine: EPSG:4326 and the three engine columns',
          both.crs.to_epsg() == 4326 and list(both.columns) == ['name', 'type', 'geometry'], (both.crs, list(both.columns)))
    lng = both.geometry.iloc[0].bounds[0]
    check('combine: coordinates are degrees near 175 E', 174 < lng < 176, lng)
    dup = build.combine(build.classify_lines(lines.iloc[[0, 0]]), pout.iloc[0:0])
    check('combine: exact duplicate geometries (tile overlap) are dropped', len(dup) == 1, len(dup))
    empty = build.classify_lines(lines.iloc[0:0])
    check('builder: an empty read gives an empty frame without raising', len(empty) == 0)

    meta = build.metadata_geojson('x.mbtiles', 7, pd.Timestamp('2026-10-31T01:02:03Z'), file='water/2026.fgb')
    props = meta['features'][0]['properties']
    check('sidecar: build time, source, count and optional file name',
          props == {'built_at': '2026-10-31T01:02:03Z', 'source': 'x.mbtiles', 'features': 7, 'file': 'water/2026.fgb'}, props)

    # The size guard: a read that returns far too few lines must not become a published file.
    saved = build._read
    build._read = lambda path, layer, zoom, bbox: lines if layer == 'water_lines' else polys
    try:
        with tempfile.TemporaryDirectory() as tmp:
            raised = False
            try:
                build.build_fgb('/nonexistent.mbtiles', os.path.join(tmp, 'x.fgb'))
            except RuntimeError as exc:
                raised = 'refusing' in str(exc)
            check('builder: refuses to write a file when far too few lines were read',
                  raised and not os.path.exists(os.path.join(tmp, 'x.fgb')))
            build.MIN_LINES, saved_min = 3, build.MIN_LINES
            try:
                n_lines, n_polys = build.build_fgb('/nonexistent.mbtiles', os.path.join(tmp, 'ok.fgb'))
            finally:
                build.MIN_LINES = saved_min
            back = pyogrio.read_dataframe(os.path.join(tmp, 'ok.fgb'))
            check('builder: a mixed line and polygon FlatGeobuf round-trips',
                  n_lines == 4 and n_polys >= 2 and len(back) == n_lines + n_polys
                  and set(back.geom_type) == {'LineString', 'Polygon'} and back.crs.to_epsg() == 4326,
                  (n_lines, n_polys, len(back), set(back.geom_type)))
    finally:
        build._read = saved


def osm_waterways(rows):
    n = len(rows)
    return gpd.GeoDataFrame({'type': [r[0] for r in rows], 'name': [''] * n, 'width': [''] * n},
                            geometry=[r[1] for r in rows], crs='EPSG:4326')


def fresh_result(rows):
    return {'trails': None, 'roads': None, 'powerlines': None,
            'waterways': osm_waterways(rows) if rows else nz_sources._empty(['geometry', 'type', 'name', 'width']),
            '_warnings': []}


def write_linz_dir(tmp, features, name=None):
    """A temporary data directory holding a LINZ waterways file and its sidecar. `features`: (type, geometry) rows."""
    frame = gpd.GeoDataFrame({'name': [''] * len(features), 'type': [f[0] for f in features]},
                             geometry=[f[1] for f in features], crs='EPSG:4326')
    pyogrio.write_dataframe(frame, os.path.join(tmp, name or 'linz_water.fgb'), driver='FlatGeobuf',
                            layer='waterways', SPATIAL_INDEX='YES', geometry_type='Unknown')
    meta = build.metadata_geojson('t.mbtiles', len(features), pd.Timestamp('2026-10-31T00:00:00Z'), file=name)
    with open(os.path.join(tmp, 'linz_water_meta.geojson'), 'w') as f:
        json.dump(meta, f)


@contextlib.contextmanager
def data_dir(tmp):
    saved = (nz_sources.DATA_DIR, nz_sources.LINZ_WATER_META)
    nz_sources.DATA_DIR, nz_sources.LINZ_WATER_META = tmp, tmp + '/linz_water_meta.geojson'
    try:
        yield
    finally:
        nz_sources.DATA_DIR, nz_sources.LINZ_WATER_META = saved


def merge(result, bbox):
    """nz_sources._add_linz_waterways with the engine's log line kept out of the check output."""
    with contextlib.redirect_stdout(io.StringIO()):
        nz_sources._add_linz_waterways(result, bbox)


BBOX = (175.40, -40.95, 175.50, -40.85)
INSIDE = LineString([(175.42, -40.90), (175.44, -40.91)])
INSIDE2 = LineString([(175.43, -40.88), (175.45, -40.89)])
OUTSIDE = LineString([(170.0, -45.0), (170.1, -45.1)])
RIVER_POLY = Polygon([(175.46, -40.93), (175.47, -40.93), (175.47, -40.92), (175.46, -40.92)])


def check_merge():
    with tempfile.TemporaryDirectory() as tmp, data_dir(tmp):
        result = fresh_result([('stream', INSIDE2)])
        merge(result, BBOX)
        check('merge: no sidecar means nothing changes and no warning',
              len(result['waterways']) == 1 and result['_warnings'] == [], (len(result['waterways']), result['_warnings']))
        check('sidecar: missing gives {} for the LINZ data', nz_sources.linz_water_metadata() == {})

    with tempfile.TemporaryDirectory() as tmp, data_dir(tmp):
        write_linz_dir(tmp, [('stream', INSIDE), ('river', RIVER_POLY), ('stream', OUTSIDE)])
        meta = nz_sources.linz_water_metadata()
        check('sidecar: read back with build time, source and count',
              meta.get('built_at', '').startswith('2026-10-31T00:00:00') and meta.get('features') == 3 and 'file' not in meta, meta)
        result = fresh_result([('river', INSIDE2)])
        merge(result, BBOX)
        w = result['waterways']
        check('merge: OSM waterways stay and the LINZ features inside the box are added (the one outside is not)',
              len(w) == 3 and sorted(w['type']) == ['river', 'river', 'stream'], (len(w), list(w['type'])))
        check('merge: result is a GeoDataFrame in EPSG:4326 with the OSM waterway columns',
              isinstance(w, gpd.GeoDataFrame) and w.crs.to_epsg() == 4326 and set(w.columns) == {'geometry', 'type', 'name', 'width'},
              (type(w), w.crs, list(w.columns)))
        check('merge: LINZ polygons arrive as polygons, lines as lines',
              sorted(w.geom_type) == ['LineString', 'LineString', 'Polygon'], sorted(w.geom_type))
        check('merge: no warning when it works', result['_warnings'] == [], result['_warnings'])

        empty_osm = fresh_result(None)
        merge(empty_osm, BBOX)
        check('merge: an area with no OSM waterways takes the LINZ ones',
              len(empty_osm['waterways']) == 2 and empty_osm['waterways'].crs.to_epsg() == 4326, len(empty_osm['waterways']))

        elsewhere = fresh_result([('stream', INSIDE2)])
        merge(elsewhere, (160.0, -30.0, 160.1, -29.9))
        check('merge: an area with no LINZ features leaves the OSM ones as they were',
              len(elsewhere['waterways']) == 1 and elsewhere['_warnings'] == [], len(elsewhere['waterways']))

    with tempfile.TemporaryDirectory() as tmp, data_dir(tmp):
        write_linz_dir(tmp, [('stream', INSIDE)], name='water/2026.fgb') if os.makedirs(tmp + '/water') is None else None
        result = fresh_result(None)
        merge(result, BBOX)
        check('sidecar: the file name it carries is the file that is read', len(result['waterways']) == 1,
              len(result['waterways']))

    with tempfile.TemporaryDirectory() as tmp, data_dir(tmp):
        write_linz_dir(tmp, [('stream', INSIDE)])
        os.remove(os.path.join(tmp, 'linz_water.fgb'))                  # published sidecar, file missing or unreadable
        result = fresh_result([('stream', INSIDE2)])
        merge(result, BBOX)
        warn = result['_warnings']
        check('failure: unreadable LINZ file leaves the OSM waterways untouched',
              len(result['waterways']) == 1, len(result['waterways']))
        check('failure: and says so in a warning that names the effect',
              len(warn) == 1 and warn[0]['severity'] == 'warning' and warn[0]['source'] == 'linz-water'
              and 'OpenStreetMap alone' in warn[0]['message'], warn)

    with tempfile.TemporaryDirectory() as tmp, data_dir(tmp):
        raised = False
        try:
            nz_sources._data_file('../etc/passwd')
        except ValueError:
            raised = True
        check('sidecar: a file name that escapes the data directory is rejected',
              raised and nz_sources._data_file('a/b.fgb') == tmp + '/a/b.fgb')


def read_array(path):
    with rasterio.open(path) as src:
        return src.read(1)


def check_cost_surface():
    """LINZ streams burn at impedance 40 (friction 1.60) and river areas at 60 (friction 3.00); trails still win; where
    an OSM river line and a LINZ stream overlap the harder one stands."""
    h, w = 40, 60
    px = 0.0003
    west, north = 175.0, -41.0
    transform = from_origin(west, north, px, px)
    with tempfile.TemporaryDirectory() as tmp:
        dem = os.path.join(tmp, 'dem.tif')
        with rasterio.open(dem, 'w', driver='GTiff', height=h, width=w, count=1, dtype='float32', crs='EPSG:4326',
                           transform=transform) as dst:
            dst.write(np.zeros((h, w), 'float32'), 1)

        def lat(row):
            return north - (row + 0.5) * px

        def lng(col):
            return west + (col + 0.5) * px

        stream = LineString([(lng(5), lat(5)), (lng(25), lat(5))])               # LINZ stream, row 5
        river_area = Polygon([(lng(30), lat(10)), (lng(40), lat(10)), (lng(40), lat(15)), (lng(30), lat(15))])
        both_osm = LineString([(lng(5), lat(20)), (lng(25), lat(20))])             # OSM river line, row 20
        both_linz = LineString([(lng(5), lat(20)), (lng(25), lat(20))])            # LINZ stream over the same cells
        trail = LineString([(lng(12), lat(1)), (lng(12), lat(9))])                 # crosses the row-5 stream
        waterways = osm_waterways([('stream', stream), ('river', river_area), ('river', both_osm), ('stream', both_linz)])
        feats = {'trails': gpd.GeoDataFrame({'type': ['path'], 'name': ['']}, geometry=[trail], crs='EPSG:4326'),
                 'roads': None, 'powerlines': None, 'waterways': waterways}
        with contextlib.redirect_stdout(io.StringIO()):
            out = fast.build_cost_surface(dem, None, feats, output_path=os.path.join(tmp, 'cs.tif'))
        cs = read_array(out)
        base = cs[0, 50]                                                              # plain ground with no land cover
        check('cost surface: a LINZ stream cell has friction 1.60 and is above plain ground',
              abs(cs[5, 20] - 1.60) < 1e-6 and cs[5, 20] > base, (cs[5, 20], base))
        check('cost surface: a river polygon area is friction 3.00 across its interior',
              abs(cs[12, 35] - 3.0) < 1e-6 and abs(cs[11, 33] - 3.0) < 1e-6, (cs[12, 35], cs[11, 33]))
        check('cost surface: an OSM river line over a LINZ stream stays at the river value (maximum, not sum)',
              abs(cs[20, 15] - 3.0) < 1e-6, cs[20, 15])
        check('cost surface: a trail crossing the stream stays friction 1.00', abs(cs[5, 12] - 1.0) < 1e-6, cs[5, 12])


def check_real():
    from pipeline.shared import get_bbox_from_ipp
    sites = [('Tararua bush, 30 km', -40.87, 175.45, 30), ('Westland, 20 km', -43.30, 170.70, 20),
             ('Auckland, 20 km', -36.85, 174.76, 20)]
    meta = nz_sources.linz_water_metadata()
    check('real: the LINZ sidecar is readable', bool(meta) and meta.get('features', 0) > 800_000, meta)
    for label, lat, lng, radius in sites:
        bbox = get_bbox_from_ipp(lat, lng, radius)
        with contextlib.redirect_stdout(io.StringIO()):
            merged = nz_sources.download_osm_features(bbox)
            saved = nz_sources.LINZ_WATER_META
            nz_sources.LINZ_WATER_META = '/nonexistent/linz_water_meta.geojson'
            try:
                only_osm = nz_sources.download_osm_features(bbox)
            finally:
                nz_sources.LINZ_WATER_META = saved
        n_merged, n_osm = len(merged['waterways']), len(only_osm['waterways'])
        added = n_merged - n_osm
        check(f'real: {label}: merged {n_merged} waterways = {n_osm} OSM + {added} LINZ',
              added > 0 and not [x for x in merged['_warnings'] if x['source'] == 'linz-water']
              and len(merged['trails']) == len(only_osm['trails']) and len(merged['roads']) == len(only_osm['roads']))
        check(f'real: {label}: waterway types are all burned by the engine (stream 40, river 60, others 40)',
              set(merged['waterways']['type']) <= {'stream', 'river', 'canal', 'drain', 'ditch'},
              set(merged['waterways']['type']))
        check(f'real: {label}: trails, roads and power lines are untouched by the merge',
              len(merged['powerlines']) == len(only_osm['powerlines']))


def main():
    check_builder()
    check_merge()
    check_cost_surface()
    if '--real' in sys.argv:
        if not os.environ.get('SAR_DATA_DIR'):
            print('FAIL  --real needs SAR_DATA_DIR')
            return 1
        check_real()
    ok = all(RESULTS)
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
