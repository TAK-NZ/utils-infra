"""Fast anisotropic cost-distance: a drop-in for app/pipeline/cost_distance.compute_cost_distance.

The upstream function runs Dijkstra's algorithm in pure Python (heapq, one cell and eight neighbours at a time). On a
Lambda vCPU that took 22 s for a 12 km radius and did not finish at 16 km. This module computes the SAME edge costs
(Tobler's hiking function, cross-slope penalty, 3-D surface distance, mean friction of the two cells) with numpy for
every edge at once, builds the 8-connected graph as a sparse matrix, and runs scipy's compiled Dijkstra on it.

Differences from upstream, both safe:
  * `limit` (optional): cells whose cost-distance exceeds it are returned as unreachable (-9999 in the raster), as
    upstream would leave them effectively out of any contour thresholded at or below `limit`. Because every edge costs
    at least 0.84 x (smallest friction) per metre of horizontal travel, no cell farther than limit / that can be
    within the limit, so the search is cropped to that window around the IPP. This is exact, not an approximation.
  * Print output is reduced (the handler discards it anyway).
If the DEM and cost surface differ in shape (the pipeline never produces that), it falls back to the upstream code.

Verified against upstream by nz/check_cost_distance_parity.py (random grids with NaN cells, and real NZ sites).
"""
import math
import os

import numpy as np
import rasterio
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from pipeline.shared import WORK_DIR

# Tobler's hiking function at the optimal slope (-0.05): 6 km/h. Flat-ground pace is normalised against it.
_PEAK_SPEED = 6.0
_FLAT_SPEED = 6.0 * math.exp(-3.5 * abs(0.05))
# Lowest possible Tobler factor (flat_speed / peak_speed). Cross-slope >= 1, surface distance >= horizontal distance.
_MIN_TOBLER = _FLAT_SPEED / _PEAK_SPEED


def _edge_costs(elev, friction, src, dst, horiz):
    """Cost of moving from every cell in `src` to its neighbour in `dst` (both are slice tuples of equal shape)."""
    e_here, e_there = elev[src], elev[dst]
    missing = np.isnan(e_here) | np.isnan(e_there)
    diff = np.where(missing, 0.0, e_there - e_here)                 # elev_diff (0 where either elevation is unknown)
    dh_dx = diff / horiz                                           # directional slope, positive = uphill
    surface = np.sqrt(horiz * horiz + diff * diff)                 # 3-D surface distance
    tobler = _FLAT_SPEED / (6.0 * np.exp(-3.5 * np.abs(dh_dx + 0.05)))
    cross = 1.0 + 0.3 * np.minimum(np.abs(diff) / horiz, 1.0)      # cross-slope penalty
    avg_friction = (friction[src] + friction[dst]) / 2.0
    return tobler * cross * avg_friction * surface


def _directions(h, w):
    """The eight neighbour moves as (drow, dcol, source slices, destination slices)."""
    out = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            src = (slice(max(0, -dr), h - max(0, dr)), slice(max(0, -dc), w - max(0, dc)))
            dst = (slice(src[0].start + dr, src[0].stop + dr), slice(src[1].start + dc, src[1].stop + dc))
            out.append((dr, dc, src, dst))
    return out


def solve(elev, friction, row, col, cell_x_m, cell_y_m, limit=None):
    """Cost-distance (terrain-equivalent metres) from cell (row, col) to every cell; unreachable = inf.

    elev: float64 array (NaN = unknown), friction: float64 array, same shape.
    """
    height, width = friction.shape
    dist_full = np.full((height, width), np.inf, dtype=np.float64)

    r0, r1, c0, c1 = 0, height, 0, width
    if limit is not None:
        lower_bound = _MIN_TOBLER * float(friction.min())          # cost per metre of horizontal travel, at best
        if lower_bound > 0:
            reach = limit / lower_bound
            half_c = int(math.ceil(reach / cell_x_m)) + 1
            half_r = int(math.ceil(reach / cell_y_m)) + 1
            r0, r1 = max(0, row - half_r), min(height, row + half_r + 1)
            c0, c1 = max(0, col - half_c), min(width, col + half_c + 1)
    elev_w, fric_w = elev[r0:r1, c0:c1], friction[r0:r1, c0:c1]
    h, w = fric_w.shape

    diag_m = math.sqrt(cell_x_m ** 2 + cell_y_m ** 2)
    horiz_for = {(-1, -1): diag_m, (-1, 0): cell_y_m, (-1, 1): diag_m, (0, -1): cell_x_m,
                 (0, 1): cell_x_m, (1, -1): diag_m, (1, 0): cell_y_m, (1, 1): diag_m}
    ids = np.arange(h * w, dtype=np.int32).reshape(h, w)
    rows, cols, weights = [], [], []
    for dr, dc, src, dst in _directions(h, w):
        rows.append(ids[src].ravel())
        cols.append(ids[dst].ravel())
        weights.append(_edge_costs(elev_w, fric_w, src, dst, horiz_for[(dr, dc)]).ravel())
    graph = csr_matrix((np.concatenate(weights), (np.concatenate(rows), np.concatenate(cols))), shape=(h * w, h * w))

    source = (row - r0) * w + (col - c0)
    kwargs = {}
    if limit is not None:
        kwargs['limit'] = limit * (1.0 + 1e-9) + 1e-6              # keep cells exactly at the limit
    dist = dijkstra(graph, directed=True, indices=source, **kwargs)
    dist_full[r0:r1, c0:c1] = dist.reshape(h, w)
    return dist_full


def compute_cost_distance(cost_surface_path, ipp_lat, ipp_lng, dem_path, output_path=None, limit=None):
    """Same contract as pipeline.cost_distance.compute_cost_distance, plus the optional `limit` (see module docstring)."""
    if output_path is None:
        output_path = os.path.join(WORK_DIR, 'cost_distance.tif')

    with rasterio.open(cost_surface_path) as src:
        friction = src.read(1).astype(np.float64)
        transform, crs, nodata = src.transform, src.crs, src.nodata
        height, width = friction.shape
    with rasterio.open(dem_path) as dem_src:
        if (dem_src.height, dem_src.width) != (height, width):
            from pipeline.cost_distance import compute_cost_distance as upstream   # shapes differ: use the original
            return upstream(cost_surface_path, ipp_lat, ipp_lng, dem_path, output_path)
        dem = dem_src.read(1).astype(np.float64)
    dem[dem < -1000] = np.nan
    dem[dem > 10000] = np.nan

    col, row = ~transform * (ipp_lng, ipp_lat)
    row, col = int(round(row)), int(round(col))
    if row < 0 or row >= height or col < 0 or col >= width:
        raise ValueError("IPP falls outside raster extent")

    center_lat = (transform[5] + transform[5] + transform[4] * height) / 2
    cell_x_m = abs(transform[0]) * 111320 * math.cos(math.radians(center_lat))
    cell_y_m = abs(transform[4]) * 110540

    friction[friction <= 0] = 50.0
    friction[np.isnan(friction)] = 50.0
    if nodata is not None:
        friction[friction == nodata] = 50.0

    print(f"  Fast cost-distance on {width}x{height} grid"
          + (f" (limit {limit:.0f})" if limit is not None else "") + "...")
    dist = solve(dem, friction, row, col, cell_x_m, cell_y_m, limit)
    reached = int(np.isfinite(dist).sum())
    print(f"  Cost-distance complete. {reached} cells reached.")

    profile = {'driver': 'GTiff', 'dtype': 'float32', 'width': width, 'height': height,
               'count': 1, 'crs': crs, 'transform': transform, 'nodata': -9999}
    dist_out = dist.astype(np.float32)
    dist_out[dist_out == np.inf] = -9999
    with rasterio.open(output_path, 'w', **profile) as dst:
        dst.write(dist_out, 1)
    return output_path
