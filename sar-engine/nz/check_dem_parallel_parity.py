"""Check that the parallel elevation reads give exactly the same DEM as reading the sheets one after another.

Usage (from the repo root):  python nz/check_dem_parallel_parity.py

For several areas (including ones where the LINZ 1 m DEM has holes and the Copernicus fill is used, and a 30 km area
spanning nine overlapping sheets) it builds the DEM with nz_sources.download_dem and again with a sequential reference
that applies the same sources in the same order, and compares the two arrays exactly. Needs internet access (it reads
the public LINZ and Copernicus buckets). Exit status is 1 if anything differs.
"""
import math
import os
import sys
import tempfile
import time

import numpy as np
import rasterio
from rasterio.transform import from_bounds as transform_from_bounds

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
import nz_sources as n  # noqa: E402
from pipeline.shared import get_bbox_from_ipp  # noqa: E402


def sequential_reference(bbox):
    """The elevation algorithm with every read done one at a time, in order (the behaviour before the parallel reads)."""
    west, south, east, north = bbox
    w_px, h_px = n._grid_size(bbox)
    transform = transform_from_bounds(west, south, east, north, w_px, h_px)
    dem = np.full((h_px, w_px), n.NODATA, dtype=np.float32)
    level = n._linz_overview_level(n.cell_size_m(bbox))
    for sheet in n._linz_sheets(bbox):
        n._warp_into(f'/vsicurl/{n.LINZ_DEM_BASE}{sheet}.tiff', dem, transform, overview_level=level, src_nodata=n.NODATA)
    holes = dem <= -1000
    if holes.any():
        cop = np.full_like(dem, n.NODATA)
        for url in n._copernicus_tiles(bbox):
            try:
                n._warp_into('/vsicurl/' + url, cop, transform)
            except rasterio.errors.RasterioIOError:
                pass
        have = cop > -1000
        overlap = ~holes & have
        offset = float(np.median(cop[overlap] - dem[overlap])) if overlap.sum() > 500 else 0.0
        fill = holes & have
        dem[fill] = cop[fill] - offset
    return dem


SITES = [('bush (Tararua), 8 km', -40.87, 175.45, 8),
         ('Southland, 10 km (Copernicus fill)', -45.50, 169.28, 10),
         ('Arthurs Pass, 12 km', -42.94, 171.56, 12),
         ('Fiordland coast, 25 km (sea and fill)', -44.67, 167.93, 25),
         ('bush (Tararua), 30 km - nine sheets', -40.87, 175.45, 30),
         ('Southland, 30 km (large fill)', -45.50, 169.28, 30),
         ('Wellington coast, 15 km (sea)', -41.29, 174.78, 15)]

if __name__ == '__main__':
    ok_all = True
    with tempfile.TemporaryDirectory() as tmp:
        for label, lat, lng, radius in SITES:
            bbox = get_bbox_from_ipp(lat, lng, radius)
            t = time.time(); ref = sequential_reference(bbox); t_seq = time.time() - t
            t = time.time()
            path, _ = n.download_dem(bbox, os.path.join(tmp, 'dem.tif'))
            t_par = time.time() - t
            with rasterio.open(path) as s:
                got = s.read(1)
            same = np.array_equal(ref, got)
            ok_all &= same
            print(f"{'PASS' if same else 'FAIL'}  {label:<42} sequential {t_seq:5.1f}s -> parallel {t_par:4.1f}s ({t_seq / t_par:3.1f}x)"
                  f" | identical: {same}" + ('' if same else f'  ({int((ref != got).sum())} cells differ)'))
    print('ALL CHECKS PASSED' if ok_all else 'CHECKS FAILED')
    sys.exit(0 if ok_all else 1)
