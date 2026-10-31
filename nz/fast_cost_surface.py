"""Fast cost surface: a drop-in for app/pipeline/cost_surface.build_cost_surface.

Everything here is the upstream function, line for line, EXCEPT the OSM waterway burn-in (sub-step C) and the batching
of the trail, road and power-line burn-in (sub-step B), which bounds memory in dense cities. Upstream makes one
`rasterize` call per stream, and each call allocates a full grid and is followed by several full-grid mask operations. A
30 km bush request has about 6,400 streams, so that single loop took about 9 of the function's 12 seconds.

Here all stream buffers are rasterized in two calls (rivers, value 60; everything else, value 40). That gives the same
result: upstream raises each cell to the maximum of the values of the streams covering it, and the only two values are 60
and 40, so "max over covering streams" is "60 if any river covers it, else 40 if any other stream does".

Known difference, harmless in practice: upstream aborts the whole waterway loop at the first stream whose geometry is
None (it raises inside the loop and the exception handler swallows the rest); this skips such a stream and continues.
The FlatGeobuf data the service reads never has missing geometries.

Verified against upstream by nz/check_cost_surface_parity.py (random inputs, and real sites up to 30 km).
"""
import os

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.warp import Resampling, reproject
from scipy.ndimage import binary_dilation

from pipeline.shared import NLCD_IMPEDANCE, WORK_DIR, repair_geometry


# rasterize() turns every polygon into a Python dictionary of coordinates before handing it to GDAL, so one call over
# the ~200,000 trail and road segments of central Auckland held about 1.3 GB at once and was killed on a 2 GB Lambda.
# Burning in batches and combining them with np.maximum gives exactly the same raster with a bounded footprint.
BURN_BATCH = 5000


def _burn_lines(geoms, shape, transform):
    """Raster of 1s where any of the (already buffered) geometries covers a cell, rasterized in bounded batches."""
    shapes = [(geom, 1) for geom in geoms if geom is not None and not geom.is_empty]
    burned = np.zeros(shape, dtype=np.uint8)
    for start in range(0, len(shapes), BURN_BATCH):
        burned = np.maximum(burned, rasterize(shapes[start:start + BURN_BATCH], out_shape=shape, transform=transform,
                                              fill=0, dtype=np.uint8))
    return burned


def _burn_waterways(waterways, shape, transform):
    """Impedance contributed by OSM waterways: 60 where a river covers the cell, else 40 where any other stream does."""
    height, width = shape
    buffered = waterways.geometry.buffer(0.0001)
    is_river = (waterways['type'] == 'river').to_numpy()
    combined = np.zeros(shape, dtype=np.uint8)
    for value, pick in ((60, is_river), (40, ~is_river)):
        shapes = [(geom, value) for geom, keep in zip(buffered, pick)
                  if keep and geom is not None and not geom.is_empty]
        # Batched like the trail burn: with the LINZ streams added a 30 km request can hold tens of thousands of
        # waterways, and rasterize() holds every shape as a Python dictionary at once. Same raster, bounded memory.
        for start in range(0, len(shapes), BURN_BATCH):
            combined = np.maximum(combined, rasterize(shapes[start:start + BURN_BATCH], out_shape=(height, width),
                                                      transform=transform, fill=0, dtype=np.uint8))
    return combined


def build_cost_surface(dem_path, nlcd_path, osm_features, nhd_features=None, output_path=None):
    """Same contract as pipeline.cost_surface.build_cost_surface."""
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'cost_surface.tif')
    with rasterio.open(dem_path) as dem_src:
        dem_transform = dem_src.transform
        dem_crs = dem_src.crs
        dem_width = dem_src.width
        dem_height = dem_src.height

    # --- Sub-step A: Reclassify NLCD to impedance (unchanged) ---
    if nlcd_path and os.path.exists(nlcd_path):
        try:
            with rasterio.open(nlcd_path) as nlcd_src:
                nlcd_resampled = np.zeros((dem_height, dem_width), dtype=np.float32)
                reproject(source=rasterio.band(nlcd_src, 1), destination=nlcd_resampled,
                          src_transform=nlcd_src.transform, src_crs=nlcd_src.crs,
                          dst_transform=dem_transform, dst_crs=dem_crs, resampling=Resampling.nearest)
            impedance = np.full_like(nlcd_resampled, 30.0)
            for nval, ival in NLCD_IMPEDANCE.items():
                impedance[nlcd_resampled == nval] = float(ival)
            water_mask = (nlcd_resampled == 11) | (nlcd_resampled == 12)
            if np.any(water_mask):
                water_dilated = binary_dilation(water_mask, iterations=1)
                impedance[(water_dilated) & (impedance < 90)] = 99.0
        except Exception as e:
            print(f"  NLCD reclassify failed: {e}. Using uniform.")
            impedance = np.full((dem_height, dem_width), 20.0, dtype=np.float32)
    else:
        impedance = np.full((dem_height, dem_width), 20.0, dtype=np.float32)

    # --- Sub-step B: Burn in trails, roads, and power line corridors (unchanged) ---
    trail_mask = np.zeros((dem_height, dem_width), dtype=np.uint8)
    for label, gdf in [('trails', osm_features.get('trails')), ('roads', osm_features.get('roads'))]:
        if gdf is not None and len(gdf) > 0:
            try:
                buffered = gdf.geometry.buffer(0.0003)  # ~30m buffer
                trail_mask = np.maximum(trail_mask, _burn_lines(buffered, (dem_height, dem_width), dem_transform))
            except Exception as e:
                print(f"  Warning burning {label}: {e}")
    powerlines_gdf = osm_features.get('powerlines')
    if powerlines_gdf is not None and len(powerlines_gdf) > 0:
        try:
            buffered = powerlines_gdf.geometry.buffer(0.0004)  # ~40m buffer for ROW
            trail_mask = np.maximum(trail_mask, _burn_lines(buffered, (dem_height, dem_width), dem_transform))
        except Exception as e:
            print(f"  Warning burning power lines: {e}")

    impedance[trail_mask == 1] = 1.0

    # --- Sub-step C: Burn in OSM waterways (CHANGED: two rasterize calls instead of one per stream) ---
    waterways = osm_features.get('waterways')
    if waterways is not None and len(waterways) > 0:
        try:
            burned = _burn_waterways(waterways, (dem_height, dem_width), dem_transform)
            wmask = (burned > 0) & (trail_mask == 0)
            impedance[wmask] = np.maximum(impedance[wmask], burned[wmask].astype(np.float32))
        except Exception as e:
            print(f"  Warning burning waterways: {e}")

    # --- Sub-step D: Burn in NHD water features (unchanged; the NZ service passes none) ---
    if nhd_features is not None and len(nhd_features) > 0:
        try:
            for _, row in nhd_features.iterrows():
                geom = row.geometry
                if geom is None or geom.is_empty:
                    continue
                geom = repair_geometry(geom)
                if geom is None or geom.is_empty:
                    continue
                imp_val = row.get('impedance', 99)
                try:
                    burned = rasterize([(geom, imp_val)], out_shape=(dem_height, dem_width), transform=dem_transform,
                                       fill=0, dtype=np.uint8)
                    nhd_mask = (burned > 0) & (trail_mask == 0)
                    impedance[nhd_mask] = np.maximum(impedance[nhd_mask], burned[nhd_mask].astype(np.float32))
                except Exception:
                    pass
        except Exception as e:
            print(f"  Warning: NHD burn-in failed: {e}")

    # --- Sub-step E: Convert impedance to friction multipliers (unchanged) ---
    friction = np.where(impedance <= 1, 1.00, 1.15)
    friction = np.where((impedance > 1) & (impedance <= 5), 1.00, friction)
    friction = np.where((impedance > 5) & (impedance <= 10), 1.05, friction)
    friction = np.where((impedance > 10) & (impedance <= 15), 1.10, friction)
    friction = np.where((impedance > 15) & (impedance <= 20), 1.15, friction)
    friction = np.where((impedance > 20) & (impedance <= 25), 1.15, friction)
    friction = np.where((impedance > 25) & (impedance <= 30), 1.25, friction)
    friction = np.where((impedance > 30) & (impedance <= 35), 1.50, friction)
    friction = np.where((impedance > 35) & (impedance <= 45), 1.60, friction)
    friction = np.where((impedance > 45) & (impedance <= 55), 1.80, friction)
    friction = np.where((impedance > 55) & (impedance <= 85), 3.00, friction)
    friction = np.where(impedance > 85, 50.00, friction)
    friction = np.clip(friction, 1.00, 50.00)
    cost_surface = friction

    profile = {'driver': 'GTiff', 'dtype': 'float32', 'width': dem_width, 'height': dem_height,
               'count': 1, 'crs': dem_crs, 'transform': dem_transform, 'nodata': -9999}
    with rasterio.open(output_path, 'w', **profile) as dst:
        cs = cost_surface.astype(np.float32)
        cs[np.isnan(cs)] = -9999
        dst.write(cs, 1)
    return output_path
