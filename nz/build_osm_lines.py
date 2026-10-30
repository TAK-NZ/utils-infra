"""Filter the Geofabrik NZ PBF to the line features the pipeline uses -> GeoPackage (RTree-indexed)."""
import subprocess, sys, time, os
src = 'data/new-zealand-latest.osm.pbf'
dst = 'data/nz_osm_lines.gpkg'
tmp = dst + '.tmp'
if os.path.exists(tmp): os.remove(tmp)
hw = "','".join(['path','footway','track','bridleway','cycleway','residential','tertiary','secondary','primary','trunk','motorway','unclassified','service'])
ww = "','".join(['stream','river','canal','drain','ditch'])
sql = (f"SELECT name, highway, waterway, other_tags FROM lines WHERE highway IN ('{hw}') "
       f"OR waterway IN ('{ww}') OR other_tags LIKE '%\"power\"=>\"line\"%' OR other_tags LIKE '%\"power\"=>\"minor_line\"%'")
t = time.time()
subprocess.run(['ogr2ogr', '-f', 'GPKG', tmp, src, '-sql', sql, '-nln', 'lines', '-lco', 'SPATIAL_INDEX=YES',
                '--config', 'OSM_MAX_TMPFILE_SIZE', '2000'], check=True)
os.replace(tmp, dst)
print(f'built {dst} ({os.path.getsize(dst)/1e6:.0f} MB) in {time.time()-t:.0f}s')
