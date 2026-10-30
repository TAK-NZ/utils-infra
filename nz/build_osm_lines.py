"""Filter the Geofabrik NZ PBF to the line features the pipeline uses -> FlatGeobuf (command-line build).

Usage (from the repo root):  python nz/build_osm_lines.py [path/to/new-zealand-latest.osm.pbf]
Download: https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf (about 400 MB, refreshed daily).

Output data/nz_osm.fgb plus data/nz_osm_meta.geojson (the build time and source, which the service uses to warn when
the snapshot is stale), in the layout the service reads with SAR_DATA_DIR=data. Takes under a minute and about 1.6 GB
of memory. The scheduled refresh (osm_refresh.py) uses the same build code, so the two cannot drift apart.
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import osm_build

src = sys.argv[1] if len(sys.argv) > 1 else 'data/new-zealand-latest.osm.pbf'
dst = 'data/nz_osm.fgb'
# The temp name must keep the .fgb extension: GDAL treats an unknown extension as a directory output.
tmp = 'data/nz_osm.tmp.fgb'
if os.path.exists(tmp):
    sys.exit(f'{tmp} exists (an interrupted run?). Delete it and rerun.')

t = time.time()
n = osm_build.build_fgb(src, tmp)
os.replace(tmp, dst)
with open('data/nz_osm_meta.geojson', 'w') as f:
    json.dump(osm_build.metadata_geojson(os.path.basename(src), n, datetime.now(timezone.utc)), f)
print(f'built {dst} ({os.path.getsize(dst) / 1e6:.0f} MB, {n} features) in {time.time() - t:.0f}s')
