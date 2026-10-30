"""Rasterize LCDB v6.0 (2023/24 epoch) to a national 30 m Cloud-Optimized GeoTIFF in EPSG:2193.

Source: Landcare Research LCDB v6.0 mainland NZ, shapefile download from LRIS (CC BY 4.0).
Usage (from the repo root):  python nz/build_lcdb_raster.py [path/to/lcdb-v60-...SHP.zip]

Cell value = Class_2023, plus 128 where Wetland_23 = "yes". 255 = no LCDB polygon (open sea). Every class code
is below 128, so one byte holds both. Takes about 3 minutes and about 3 GB of memory; the result is about 45 MB.
"""
import glob
import os
import subprocess
import sys
import zipfile

DATA = 'data'
EXTRACT = os.path.join(DATA, 'lcdb-v60')
LAYER = 'lcdb-v60-land-cover-database-version-60-mainland-new-zealand'
RAW = os.path.join(DATA, 'lcdb_2023_30m_raw.tif')
OUT = os.path.join(DATA, 'lcdb_2023_30m.tif')
# Extent of the LCDB layer, snapped outwards to the 30 m grid (EPSG:2193).
TE = ['1089990', '4747950', '2089560', '6194250']

zip_path = sys.argv[1] if len(sys.argv) > 1 else (glob.glob(os.path.join(DATA, 'lris-lcdb-v60-*-SHP.zip')) or [None])[0]
shp = os.path.join(EXTRACT, LAYER + '.shp')
if not os.path.isfile(shp):
    if not zip_path:
        sys.exit('LCDB shapefile not found. Download "LCDB v6.0 mainland NZ" (SHP) from lris.scinfo.org.nz and pass the zip path.')
    print(f'extracting {zip_path} -> {EXTRACT}')
    zipfile.ZipFile(zip_path).extractall(EXTRACT)
if os.path.exists(RAW):
    sys.exit(f'{RAW} already exists (an interrupted run?). Delete it and rerun.')

sql = f"SELECT geometry, Class_2023 + 128*(Wetland_23='yes') AS v FROM \"{LAYER}\""
print('rasterizing (about 2-3 minutes)...')
subprocess.run(['gdal_rasterize', '-q', '-dialect', 'SQLite', '-sql', sql, '-a', 'v', '-te', *TE, '-tr', '30', '30',
                '-ot', 'Byte', '-a_nodata', '255', '-init', '255', '-co', 'TILED=YES', '-co', 'BLOCKXSIZE=512',
                '-co', 'BLOCKYSIZE=512', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', '-co', 'BIGTIFF=YES',
                shp, RAW], check=True)
print('converting to COG with mode-resampled overviews...')
subprocess.run(['gdal_translate', '-q', '-of', 'COG', '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2',
                '-co', 'OVERVIEW_RESAMPLING=MODE', '-co', 'BLOCKSIZE=512', RAW, OUT], check=True)
os.remove(RAW)
print(f'built {OUT} ({os.path.getsize(OUT) / 1e6:.0f} MB)')
