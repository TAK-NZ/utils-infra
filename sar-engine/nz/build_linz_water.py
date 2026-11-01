"""Extract the LINZ streams and river polygons the pipeline uses from the LINZ vector-tile MBTiles -> FlatGeobuf.
Usage (from the repo root):  python nz/build_linz_water.py path/to/linz-vector-tiles.mbtiles
The MBTiles is the one utils-infra keeps in the artifacts bucket (s3://<artifacts-bucket>/linz-vector-tiles.mbtiles, about
3 GB, refreshed monthly by its update-linz-tiles workflow). Output data/linz_water.fgb plus data/linz_water_meta.geojson,
in the layout the service reads with SAR_DATA_DIR=data. Takes under a minute and about 1 GB of memory.
To publish: upload linz_water.fgb first, then linz_water_meta.geojson (the sidecar's presence switches the data on):
  aws s3 cp data/linz_water.fgb s3://<artifacts-bucket>/sar-engine/linz_water.fgb
  aws s3 cp data/linz_water_meta.geojson s3://<artifacts-bucket>/sar-engine/linz_water_meta.geojson
To switch it off again, delete linz_water_meta.geojson. Stream data changes slowly, so there is no schedule.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import linz_water_build

if len(sys.argv) != 2:
    sys.exit(__doc__)
src = sys.argv[1]
dst = 'data/linz_water.fgb'
# The temp name must keep the .fgb extension: GDAL treats an unknown extension as a directory output.
tmp = 'data/linz_water.tmp.fgb'
if os.path.exists(tmp):
    sys.exit(f'{tmp} exists (an interrupted run?). Delete it and rerun.')
t = time.time()
lines, polygons = linz_water_build.build_fgb(src, tmp)
os.replace(tmp, dst)
with open('data/linz_water_meta.geojson', 'w') as f:
    json.dump(linz_water_build.metadata_geojson(os.path.basename(src), lines + polygons, datetime.now(timezone.utc)), f)
print(f'built {dst} ({os.path.getsize(dst) / 1e6:.0f} MB, {lines} stream lines + {polygons} river polygons) '
      f'in {time.time() - t:.0f}s')
