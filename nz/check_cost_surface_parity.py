"""Check that nz/fast_cost_surface.py builds exactly the same cost surface as the upstream build_cost_surface.

Usage (from the repo root):  python nz/check_cost_surface_parity.py [N_RANDOM] [--real]

Random cases: small grids with a land cover raster at a different resolution (or none), random trails / roads /
waterways (river and other types) / power lines, some empty or missing, and sometimes NHD-style polygons.
--real: real NZ sites through the real data stages, up to a 30 km stream-dense bush request (needs the data directory).
Outputs are compared as arrays, exactly. Exit status is 1 if anything differs.
"""
import contextlib
import io
import os
import sys
import tempfile
import time

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, Polygon

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
from pipeline.cost_surface import build_cost_surface as upstream  # noqa: E402
from pipeline.shared import NLCD_IMPEDANCE  # noqa: E402

import fast_cost_surface as fast  # noqa: E402
import nz_sources  # noqa: E402,F401  (registers the LCDB codes in NLCD_IMPEDANCE, as in the service)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def read(path):
    with rasterio.open(path) as s:
        return s.read(1)


def lines(rng, n, bounds, kind):
    west, south, east, north = bounds
    geoms, types = [], []
    for _ in range(n):
        k = int(rng.integers(2, 6))
        pts = [(float(rng.uniform(west, east)), float(rng.uniform(south, north))) for _ in range(k)]
        geoms.append(LineString(pts))
        types.append(str(rng.choice(['river', 'stream', 'canal', 'drain', 'ditch'])) if kind == 'water' else 'path')
    cols = {'type': types, 'name': [''] * n}
    if kind == 'water':
        cols['width'] = [''] * n
    return gpd.GeoDataFrame(cols, geometry=geoms, crs='EPSG:4326')


def random_case(rng, tmp):
    h, w = int(rng.integers(20, 90)), int(rng.integers(20, 90))
    px, py = float(rng.uniform(0.0002, 0.0005)), float(rng.uniform(0.0002, 0.0005))
    lat, lng0 = float(rng.uniform(-47, -35)), 175.0
    transform = from_origin(lng0, lat, px, py)
    bounds = (lng0, lat - py * h, lng0 + px * w, lat)
    prof = dict(driver='GTiff', height=h, width=w, count=1, dtype='float32', crs='EPSG:4326', transform=transform)
    dem = os.path.join(tmp, 'dem.tif')
    with rasterio.open(dem, 'w', **prof) as dst:
        dst.write(np.zeros((h, w), 'float32'), 1)

    nlcd = None
    if rng.random() < 0.85:                                   # land cover at a different resolution and extent
        lh, lw = int(h * rng.uniform(0.4, 1.6)) + 2, int(w * rng.uniform(0.4, 1.6)) + 2
        lt = from_origin(lng0 - px, lat + py, px * w * 1.2 / lw, py * h * 1.2 / lh)
        codes = np.array(list(NLCD_IMPEDANCE) + [999, 0], dtype='float32')
        nlcd = os.path.join(tmp, 'lc.tif')
        with rasterio.open(nlcd, 'w', driver='GTiff', height=lh, width=lw, count=1, dtype='float32', crs='EPSG:4326',
                           transform=lt) as dst:
            dst.write(rng.choice(codes, size=(lh, lw)).astype('float32'), 1)

    def maybe(kind, hi):
        r = rng.random()
        if r < 0.15:
            return None
        return lines(rng, 0 if r < 0.3 else int(rng.integers(1, hi)), bounds, kind)
    feats = {'trails': maybe('line', 40), 'roads': maybe('line', 40), 'waterways': maybe('water', 80),
             'powerlines': maybe('line', 6)}
    feats = {k: v for k, v in feats.items() if v is not None}

    nhd = None
    if rng.random() < 0.3:
        polys = []
        for _ in range(int(rng.integers(1, 5))):
            cx, cy = rng.uniform(bounds[0], bounds[2]), rng.uniform(bounds[1], bounds[3])
            r = float(rng.uniform(px * 2, px * 12))
            polys.append(Polygon([(cx - r, cy - r), (cx + r, cy - r), (cx + r, cy + r), (cx - r, cy + r)]))
        nhd = gpd.GeoDataFrame({'impedance': rng.choice([99, 80, 60], size=len(polys))}, geometry=polys, crs='EPSG:4326')
    return dem, nlcd, feats, nhd


def run_random(n):
    """Each random case is built with the normal batch size and again with tiny batches (1, 3, 7 segments), because the
    random cases have far fewer segments than one real batch and would otherwise never exercise the batching."""
    rng = np.random.default_rng(20261031)
    bad, burned_cells, water_cells, runs = 0, 0, 0, 0
    default_batch = fast.BURN_BATCH
    try:
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(n):
                dem, nlcd, feats, nhd = random_case(rng, tmp)
                ref = read(quiet(upstream, dem, nlcd, feats, nhd_features=nhd, output_path=os.path.join(tmp, 'ref.tif')))
                for batch in (default_batch, 1, 3, 7):
                    fast.BURN_BATCH = batch
                    got = read(quiet(fast.build_cost_surface, dem, nlcd, feats, nhd_features=nhd, output_path=os.path.join(tmp, 'got.tif')))
                    runs += 1
                    if not np.array_equal(ref, got):
                        bad += 1
                        print(f'  MISMATCH case {i} (batch {batch}): {int((ref != got).sum())} of {ref.size} cells differ')
                burned_cells += int((ref == 1.0).sum())
                water_cells += int(((ref >= 1.5) & (ref <= 3.0)).sum())
    finally:
        fast.BURN_BATCH = default_batch
    print(f'random cases : {n} inputs x 4 batch sizes = {runs - bad}/{runs} identical '
          f'({burned_cells} trail cells and {water_cells} high-friction cells compared)')
    return bad == 0


def run_real():
    from pipeline.shared import get_bbox_from_ipp
    sites = [('bush (Tararua), 8 km', -40.87, 175.45, 8),
             ('Southland, 10 km', -45.50, 169.28, 10),
             ('urban coast (Wellington), 3 km', -41.2850, 174.7790, 3),
             ('Arthurs Pass, 12 km', -42.94, 171.56, 12),
             ('bush (Tararua), 30 km - 6,400 streams', -40.87, 175.45, 30),
             ('urban (Auckland), 20 km', -36.85, 174.76, 20)]
    ok_all = True
    for label, lat, lng, radius in sites:
        bbox = get_bbox_from_ipp(lat, lng, radius)
        dem, _ = quiet(nz_sources.download_dem, bbox)
        lc, _ = quiet(nz_sources.download_nlcd, bbox)
        osm = quiet(nz_sources.download_osm_features, bbox)
        osm.pop('_warnings', None)
        nhd, _ = nz_sources.download_nhd_features(bbox)
        t = time.time(); ref_p = quiet(upstream, dem, lc, osm, nhd_features=nhd, output_path='/tmp/cs_ref.tif'); t_up = time.time() - t
        t = time.time(); got_p = quiet(fast.build_cost_surface, dem, lc, osm, nhd_features=nhd, output_path='/tmp/cs_got.tif'); t_fast = time.time() - t
        ref, got = read(ref_p), read(got_p)
        ok = np.array_equal(ref, got)
        ok_all &= ok
        print(f"{'PASS' if ok else 'FAIL'}  {label:<40} {ref.shape[1]}x{ref.shape[0]} cells, {len(osm['waterways'])} streams | "
              f"upstream {t_up:5.1f}s -> fast {t_fast:4.1f}s | arrays identical: {ok}"
              + ('' if ok else f'  ({int((ref != got).sum())} cells differ)'))
    return ok_all


if __name__ == '__main__':
    n = int(next((a for a in sys.argv[1:] if a.isdigit()), 150))
    ok = run_random(n)
    if '--real' in sys.argv:
        ok &= run_real()
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    sys.exit(0 if ok else 1)
