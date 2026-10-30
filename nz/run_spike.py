"""Run the unmodified WiSAR pipeline against NZ data (run from the repo root). Usage:
   nz/run_spike.py LABEL LAT LNG P25 P50 P75 [RADIUS_KM]   (percentiles are calibrated km, as run_analysis expects)
"""
import json, os, resource, shutil, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
import pipeline, pipeline.outputs as outputs
import nz_sources

timings = {}
def timed(name, fn):
    def wrapper(*a, **k):
        t = time.time(); r = fn(*a, **k); timings[name] = round(time.time() - t, 2); return r
    return wrapper

# Swap the four US data sources; everything else in pipeline/ is untouched.
outputs.download_dem = timed('dem', nz_sources.download_dem)
outputs.download_nlcd = timed('landcover', nz_sources.download_nlcd)
outputs.download_osm_features = timed('osm', nz_sources.download_osm_features)
outputs.download_nhd_features = timed('hydro', nz_sources.download_nhd_features)
outputs.build_cost_surface = timed('cost_surface', outputs.build_cost_surface)
outputs.compute_cost_distance = timed('cost_distance', outputs.compute_cost_distance)
outputs.compute_jacobs_masks = timed('jacobs_masks', outputs.compute_jacobs_masks)
outputs.extract_contour_polygons = timed('contours', outputs.extract_contour_polygons)

label, lat, lng, p25, p50, p75 = sys.argv[1], *map(float, sys.argv[2:7])
radius = float(sys.argv[7]) if len(sys.argv) > 7 else p75 + 2.0
t0 = time.time()
res = outputs.run_analysis(lat, lng, p25, p50, p75, radius_km=radius)
total = round(time.time() - t0, 2)
import rasterio
with rasterio.open(res['cost_distance_path']) as s:
    grid = (s.width, s.height)
peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
peak_child_mb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
summary = dict(label=label, ipp=[lat, lng], radius_km=radius, grid=grid, total_s=total, stages_s=timings,
               peak_rss_mb=round(peak_mb), peak_gdalwarp_rss_mb=round(peak_child_mb),
               warnings=[w['message'] for w in res['warnings']])
os.makedirs('results', exist_ok=True)
json.dump(res['contour_geojson'], open(f'results/{label}.geojson', 'w'))
json.dump(summary, open(f'results/{label}.summary.json', 'w'), indent=1)
for k in ('dem_path', 'cost_surface_path', 'cost_distance_path'):
    shutil.copy(res[k], f'results/{label}.{k[:-5]}.tif')
print('\nSUMMARY', json.dumps(summary, indent=1))
