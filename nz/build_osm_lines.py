"""Filter the Geofabrik NZ PBF to the line features the pipeline uses -> FlatGeobuf.

Usage (from the repo root):  python nz/build_osm_lines.py [path/to/new-zealand-latest.osm.pbf]
Download: https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf (about 400 MB, refreshed daily).

Output data/nz_osm.fgb (plus data/nz_osm_meta.geojson with the build time) has columns cat (trails | roads | waterways | powerlines), type (the OSM tag value) and name.
FlatGeobuf carries a packed spatial index, so a bounding-box query reads only the index nodes and features it needs,
including over HTTP / S3 range requests. Takes under a minute and about 1.3 GB of memory.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

from osm_tags import POWER_TAGS, ROAD_TAGS, TRAIL_TAGS, WATERWAY_TAGS

src = sys.argv[1] if len(sys.argv) > 1 else 'data/new-zealand-latest.osm.pbf'
dst = 'data/nz_osm.fgb'
# The temp name must keep the .fgb extension: GDAL treats an unknown extension as a directory output.
tmp = 'data/nz_osm.tmp.fgb'
if os.path.exists(tmp):
    sys.exit(f'{tmp} exists (an interrupted run?). Delete it and rerun.')


def in_list(col, tags):
    return f"{col} IN ({','.join(repr(t) for t in sorted(tags))})"


power = ' OR '.join(f"other_tags LIKE '%\"power\"=>\"{t}\"%'" for t in sorted(POWER_TAGS))
# Precedence trails > roads > waterways > power lines, as in WiSAR's build_osm_cache.py.
sql = (
    "SELECT geometry, name, cat, CASE cat WHEN 'trails' THEN highway WHEN 'roads' THEN highway "
    "WHEN 'waterways' THEN waterway ELSE 'line' END AS type "
    "FROM (SELECT geometry, name, highway, waterway, other_tags, CASE "
    f"WHEN {in_list('highway', TRAIL_TAGS)} THEN 'trails' "
    f"WHEN {in_list('highway', ROAD_TAGS)} THEN 'roads' "
    f"WHEN {in_list('waterway', WATERWAY_TAGS)} THEN 'waterways' "
    f"WHEN {power} THEN 'powerlines' END AS cat FROM lines) WHERE cat IS NOT NULL"
)
t = time.time()
subprocess.run(['ogr2ogr', '-f', 'FlatGeobuf', tmp, src, '-dialect', 'SQLite', '-sql', sql, '-nln', 'lines',
                '--config', 'OSM_MAX_TMPFILE_SIZE', '2000'], check=True)
os.replace(tmp, dst)
n = int(subprocess.run(['ogrinfo', '-so', dst, 'lines'], capture_output=True, text=True, check=True).stdout
        .split('Feature Count:')[1].split()[0])
# FlatGeobuf cannot carry metadata, so the build time goes in a one-point GeoJSON next to it. The service reads
# it to warn when the snapshot is stale.
meta = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [0, 0]},
        'properties': {'built_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                       'source': os.path.basename(src), 'features': n}}]}
with open('data/nz_osm_meta.geojson', 'w') as f:
    json.dump(meta, f)
print(f'built {dst} ({os.path.getsize(dst) / 1e6:.0f} MB, {n} features) in {time.time() - t:.0f}s')
