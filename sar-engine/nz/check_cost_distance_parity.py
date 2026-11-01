"""Check that nz/fast_cost_distance.py gives the same answers as the upstream pure-Python Dijkstra.

Usage (from the repo root):  python nz/check_cost_distance_parity.py [N_RANDOM_GRIDS] [--real]

Random grids: small DEM / friction rasters with NaN and out-of-range elevations, the odd friction values the pipeline
sanitises (<= 0, nodata), non-square cells and random IPPs, compared with and without `limit`.
--real: real NZ sites, run through the actual pipeline stages (needs the data directory), compared cell by cell and
as final isochrone GeoJSON. The upstream side takes several seconds per site.
Exit status is 1 if anything differs beyond float32 rounding.
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
from pipeline.cost_distance import compute_cost_distance as upstream  # noqa: E402

import fast_cost_distance as fast  # noqa: E402

RTOL = 2e-7          # float32 rounding of values that agree to ~1e-12 can differ by one unit in the last place
FRICTIONS = [1.0, 1.05, 1.10, 1.15, 1.25, 1.50, 1.60, 1.80, 3.00, 50.0]


def read(path):
    with rasterio.open(path) as s:
        return s.read(1).astype(np.float64)


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


def compare(a, b):
    """(identical reachability, max relative difference over cells both reached)."""
    ra, rb = a != -9999, b != -9999
    both = ra & rb
    rel = np.abs(a[both] - b[both]) / np.maximum(np.abs(a[both]), 1e-9) if both.any() else np.zeros(1)
    return bool((ra == rb).all()), float(rel.max())


def random_case(rng, tmp):
    h, w = int(rng.integers(6, 48)), int(rng.integers(6, 48))
    lat = float(rng.uniform(-47, -35))
    px, py = float(rng.uniform(0.0002, 0.0005)), float(rng.uniform(0.0002, 0.0005))     # non-square cells
    transform = from_origin(175.0, lat, px, py)
    y, x = np.mgrid[0:h, 0:w]
    dem = (200 + 150 * np.sin(x / rng.uniform(3, 9)) + 120 * np.cos(y / rng.uniform(3, 9))
           + rng.normal(0, 8, (h, w))).astype(np.float32)
    dem[rng.random((h, w)) < 0.06] = -9999                       # unknown elevation (becomes NaN)
    dem[rng.random((h, w)) < 0.01] = 20000                       # out of range (becomes NaN)
    fric = rng.choice(FRICTIONS, size=(h, w)).astype(np.float32)
    fric[rng.random((h, w)) < 0.02] = -9999                      # sanitised to 50
    fric[rng.random((h, w)) < 0.01] = 0                          # sanitised to 50
    prof = dict(driver='GTiff', height=h, width=w, count=1, dtype='float32', crs='EPSG:4326', transform=transform,
                nodata=-9999)
    paths = {}
    for name, arr in (('dem', dem), ('cost', fric)):
        paths[name] = os.path.join(tmp, f'{name}.tif')
        with rasterio.open(paths[name], 'w', **prof) as dst:
            dst.write(arr, 1)
    # Upstream converts the IPP to a cell with round() on the pixel's top-left-corner coordinate, which is half a cell
    # off: an IPP in the second half of the last row or column rounds to one past the grid and is rejected. The pipeline
    # always pads the grid around the IPP, so this cannot happen in use; keep the random IPPs in the interior.
    row_i, col_i = int(rng.integers(1, h - 1)), int(rng.integers(1, w - 1))
    lng_ipp = 175.0 + px * (col_i + float(rng.uniform(0.0, 1.0)))
    lat_ipp = lat - py * (row_i + float(rng.uniform(0.0, 1.0)))
    return paths, lat_ipp, lng_ipp


def run_random(n):
    rng = np.random.default_rng(20261030)
    worst, bad, with_limit = 0.0, 0, 0
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(n):
            paths, lat, lng = random_case(rng, tmp)
            ref = read(quiet(upstream, paths['cost'], lat, lng, paths['dem'], os.path.join(tmp, 'ref.tif')))
            got = read(quiet(fast.compute_cost_distance, paths['cost'], lat, lng, paths['dem'], os.path.join(tmp, 'got.tif')))
            same, rel = compare(ref, got)
            worst = max(worst, rel)
            ok = same and rel <= RTOL
            # with a limit: everything within it must match; everything beyond must be unreachable
            finite = ref[ref != -9999]
            if len(finite) > 3:
                limit = float(np.quantile(finite, rng.uniform(0.1, 0.9)))
                lim = read(quiet(fast.compute_cost_distance, paths['cost'], lat, lng, paths['dem'],
                                 os.path.join(tmp, 'lim.tif'), limit=limit))
                within = (ref != -9999) & (ref <= limit * (1 - 1e-6))
                beyond = (ref == -9999) | (ref > limit * (1 + 1e-6))
                ok_lim = bool(((lim != -9999) | ~within).all()) and bool((lim[beyond] == -9999).all())
                if within.any():
                    ok_lim &= float((np.abs(lim[within] - ref[within]) / np.maximum(ref[within], 1e-9)).max()) <= RTOL
                ok &= ok_lim
                with_limit += 1
            if not ok:
                bad += 1
                print(f'  MISMATCH case {i}: same reachability={same} max rel diff={rel:.2e}')
    # an IPP outside the raster must be rejected the same way by both
    with tempfile.TemporaryDirectory() as tmp:
        paths, lat, lng = random_case(rng, tmp)
        errs = []
        for fn in (upstream, fast.compute_cost_distance):
            try:
                quiet(fn, paths['cost'], lat + 5.0, lng, paths['dem'], os.path.join(tmp, 'x.tif'))
                errs.append('no error')
            except ValueError as e:
                errs.append(str(e))
        if errs[0] != errs[1] or errs[0] == 'no error':
            bad += 1
            print(f'  MISMATCH on an IPP outside the raster: upstream={errs[0]!r} fast={errs[1]!r}')
        else:
            print(f'IPP outside raster: both raise ValueError({errs[0]!r})')
    print(f'random grids : {n - bad}/{n} identical, {with_limit} also checked with a limit, worst relative difference {worst:.2e}')
    return bad == 0


def run_real():
    import nz_sources
    from pipeline.cost_surface import build_cost_surface
    from pipeline.outputs import extract_isochrone_polygons
    from pipeline.shared import get_bbox_from_ipp
    sites = [('bush (Tararua), 8 km', -40.87, 175.45, 8, 2.0, [1, 2, 4]),
             ('Southland, 10 km, Copernicus fill', -45.50, 169.28, 10, 2.0, [1, 2, 4]),
             ('urban coast (Wellington), 3 km', -41.2850, 174.7790, 3, 3.0, [1, 2]),
             ('Arthurs Pass, 12 km', -42.94, 171.56, 12, 3.0, [1, 3])]
    ok_all = True
    for label, lat, lng, radius, speed, bands in sites:
        bbox = get_bbox_from_ipp(lat, lng, max(radius, speed * max(bands) + 2.0))
        dem, _ = quiet(nz_sources.download_dem, bbox)
        lc, _ = quiet(nz_sources.download_nlcd, bbox)
        osm = quiet(nz_sources.download_osm_features, bbox)
        osm.pop('_warnings', None)
        nhd, _ = nz_sources.download_nhd_features(bbox)
        cost = quiet(build_cost_surface, dem, lc, osm, nhd_features=nhd)
        t = time.time(); ref_p = quiet(upstream, cost, lat, lng, dem); t_up = time.time() - t
        t = time.time(); got_p = quiet(fast.compute_cost_distance, cost, lat, lng, dem); t_fast = time.time() - t
        limit = max(bands) * speed * 1000.0
        t = time.time(); lim_p = quiet(fast.compute_cost_distance, cost, lat, lng, dem, limit=limit); t_lim = time.time() - t
        ref, got, lim = read(ref_p), read(got_p), read(lim_p)
        same, rel = compare(ref, got)
        # the contours are what callers receive: they must be identical with and without the limit
        c_ref = quiet(extract_isochrone_polygons, ref_p, speed, bands)
        c_fast = quiet(extract_isochrone_polygons, got_p, speed, bands)
        c_lim = quiet(extract_isochrone_polygons, lim_p, speed, bands)
        same_contours = json.dumps(c_ref, sort_keys=True) == json.dumps(c_fast, sort_keys=True)
        same_limited = json.dumps(c_ref, sort_keys=True) == json.dumps(c_lim, sort_keys=True)
        ok = same and rel <= RTOL and same_contours and same_limited
        ok_all &= ok
        print(f"{'PASS' if ok else 'FAIL'}  {label:<36} {ref.shape[1]}x{ref.shape[0]} cells | upstream {t_up:5.1f}s -> fast {t_fast:4.1f}s"
              f" (with limit {t_lim:4.1f}s, {100 * (lim != -9999).mean():.0f}% of cells searched) | max rel diff {rel:.1e}"
              f" | contours identical: {same_contours} / with limit: {same_limited}")
    return ok_all


if __name__ == '__main__':
    n = int(next((a for a in sys.argv[1:] if a.isdigit()), 150))
    ok = run_random(n)
    if '--real' in sys.argv:
        ok &= run_real()
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    sys.exit(0 if ok else 1)
