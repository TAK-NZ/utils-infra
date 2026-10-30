"""Estimate how much of NZ land the LINZ 1 m DEM covers, by sampling random land points.

Usage (from the repo root):  python nz/check_dem_coverage.py [N_POINTS]
Needs nz/dem_1m_index.json (build_dem_index.py) and data/lcdb_2023_30m.tif (build_lcdb_raster.py). Reads one pixel
per point from the public LINZ COGs, so it needs internet access and takes a few minutes for 600 points.
Water classes (lake, river, estuary) are excluded: a missing DEM value over open water is not a coverage gap.
"""
import json
import os
import random
import subprocess
import sys

import numpy as np
import rasterio
from rasterio.warp import transform

N = int(sys.argv[1]) if len(sys.argv) > 1 else 600
BASE = 'https://nz-elevation.s3-ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193/'
VRT = 'data/dem_1m.vrt'
os.environ.update(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tiff,.tif')

if not os.path.isfile(VRT):
    ids = sorted(json.load(open('nz/dem_1m_index.json')))
    with open('data/dem_1m_sheets.txt', 'w') as f:
        f.write('\n'.join(f'/vsicurl/{BASE}{i}.tiff' for i in ids))
    print(f'building {VRT} from {len(ids)} sheets...')
    subprocess.run(['gdalbuildvrt', '-q', '-input_file_list', 'data/dem_1m_sheets.txt', VRT], check=True)

random.seed(11)
with rasterio.open('data/lcdb_2023_30m.tif') as lc:
    ov = lc.overviews(1)[3]                                   # ~240 m cells: cheap to scan
    arr = lc.read(1, out_shape=(lc.height // ov, lc.width // ov))
    cls = np.where(arr == 255, 255, arr & 127)
    land = np.argwhere((cls != 255) & ~np.isin(cls, (0, 20, 21, 22)))
    pick = land[np.random.default_rng(11).choice(len(land), N, replace=False)]
    xs = [lc.transform.c + (c + 0.5) * ov * lc.transform.a for r, c in pick]
    ys = [lc.transform.f + (r + 0.5) * ov * lc.transform.e for r, c in pick]
    classes = [int(cls[r, c]) for r, c in pick]

ok = []
with rasterio.open(VRT) as dem:
    for i, v in enumerate(dem.sample(list(zip(xs, ys)), 1)):
        ok.append(bool(v[0] > -1000))
        if (i + 1) % 100 == 0:
            print(f'  {i + 1}/{N} sampled', flush=True)
ok = np.array(ok)
lng, lat = transform('EPSG:2193', 'EPSG:4326', xs, ys)
print(f'\nland points with 1 m DEM data: {ok.sum()}/{N} = {100 * ok.mean():.1f}%')
print('by island half (lat > -41.5 = North Island and top of South):')
north = np.array(lat) > -41.5
for name, m in (('North Island', north), ('South Island + Stewart', ~north)):
    print(f'  {name:<24} {ok[m].sum()}/{m.sum()} = {100 * ok[m].mean():.1f}%')
miss = [(round(la, 2), round(lo, 2), c) for la, lo, c, o in zip(lat, lng, classes, ok) if not o]
print(f'missing points (lat, lng, LCDB class), first 40 of {len(miss)}:')
for m in sorted(miss)[:40]:
    print('  ', m)
