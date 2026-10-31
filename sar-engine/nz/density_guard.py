"""Dense-area guard: refuse a request early when it cannot finish inside the time budget.

Why: the cost-surface stage burns every trail, road and power-line segment into the grid, and its time grows with the
number of segments (about 5 s at 12,000, 17 s at 114,000, 39 s at 250,000, measured on Lambda). Central Auckland at
30 km has about 250,000 segments, so the whole request takes 48 to 63 s and can hit the load balancer's 60 s limit,
which gives the caller a generic failure after a minute. This module answers the same request in under 12 s with a
clear message and a smaller radius or shorter time band that fits.

How: after the OSM read (so the segments are already counted for free) and before the cost surface, estimate

    total = time used so far + COST_SURFACE_BASE_S + SECONDS_PER_SEGMENT * segments + AFTER_COST_SURFACE_S

and refuse when it exceeds the budget. A request that passes is untouched: the guard only reads counts.

The suggestion is found by COUNTING, not by a formula. Segment counts do not follow the area: central Auckland, on an
isthmus, has 113,639 segments within 10 km and 204,351 within 20 km, so halving the radius removes far fewer segments
than the area would suggest (a formula suggested 27 km and the real handler refused it). The OSM data for the full
radius is already in memory, so for each smaller candidate radius the segments whose envelopes meet its bounding box
are counted exactly (`make_counter`), and the largest whole-kilometre radius that fits is suggested.

The cost model is a straight line fitted by eye to four real measurements (12k, 50k, 114k and 250k segments). It sits
within 3 s of all four and, at the top where the decision matters, about 2 s above the measurement. Four points is
thin: treat the threshold as a calibrated guess and re-measure if the engine or the Lambda size changes.
nz/check_density_guard.py holds the measurements and fails if the model drifts away from them.

The budget is for the handler (not including container start). A cold start can add up to about 10 s before the
handler runs, so the default of 45 s leaves room under a 55 s function timeout and the 60 s load balancer limit.
Raise it with SAR_TIME_BUDGET_S only together with those two limits.
"""
import math
import os

import numpy as np

COST_SURFACE_BASE_S = 3.0
SECONDS_PER_SEGMENT = 0.00015          # 0.15 ms per trail, road or power-line segment
AFTER_COST_SURFACE_S = 1.0             # cost-distance plus contours (0.1 to 0.8 s measured)
DEFAULT_BUDGET_S = 45.0
MIN_HOURS = 0.25                       # keep equal to handler.MIN_HOURS
HOURS_STEP = 0.25
RADIUS_MARGIN_KM = 2.0                 # the engine analyses at least speed x longest band + this (handler.run_travel_time)
COUNTED_KEYS = ('trails', 'roads', 'powerlines')     # waterways are rasterized in two cheap calls and not counted


def budget_seconds():
    """Time budget in seconds; SAR_TIME_BUDGET_S overrides the default. Anything not a positive number is ignored."""
    try:
        value = float(os.environ.get('SAR_TIME_BUDGET_S', ''))
    except ValueError:
        return DEFAULT_BUDGET_S
    return value if math.isfinite(value) and value > 0 else DEFAULT_BUDGET_S


def segment_count(osm):
    """Segments the cost surface will burn in: trails, roads and power lines."""
    return sum(len(osm[key]) for key in COUNTED_KEYS if osm.get(key) is not None)


def make_counter(osm, bbox_for_radius):
    """Return count(radius_km): segments whose envelope meets the bounding box of that radius.

    `bbox_for_radius(r)` gives (west, south, east, north). Segments that only touch the box edge are counted here and
    not by the FlatGeobuf reader, so the count can exceed a fresh read by a handful of segments (2 to 4 of 100,000 in
    central Auckland) and is never lower. That is the safe direction, and it is far too small to move a decision.
    """
    parts = [osm[key].geometry.bounds.to_numpy() for key in COUNTED_KEYS
             if osm.get(key) is not None and len(osm[key]) > 0]
    bounds = np.concatenate(parts) if parts else np.zeros((0, 4))

    def count(radius_km):
        west, south, east, north = bbox_for_radius(radius_km)
        return int(((bounds[:, 0] <= east) & (bounds[:, 2] >= west) & (bounds[:, 1] <= north) & (bounds[:, 3] >= south)).sum())
    return count


def estimated_total_seconds(elapsed_s, segments):
    return elapsed_s + COST_SURFACE_BASE_S + SECONDS_PER_SEGMENT * segments + AFTER_COST_SURFACE_S


def _largest_fitting_radius(elapsed_s, radius_km, budget_s, count):
    """Largest whole-km radius below `radius_km` whose exact segment count fits, or None. Counts never fall as the
    radius grows, so the first candidate that fits, searching down from the top, is the largest."""
    candidate = math.ceil(radius_km) - 1
    while candidate >= 1:
        if estimated_total_seconds(elapsed_s, count(candidate)) <= budget_s:
            return candidate
        candidate -= 1
    return None


def assess(elapsed_s, segments, radius_km, reach_km, speed_kmh, budget_s, count):
    """Return None when the request fits, else a dict describing the refusal.

    `segments` is the count at `radius_km`, the radius actually used (already raised to `reach_km`, which is speed x
    longest band + 2 km). `count(r)` gives the exact segment count for a smaller radius r (see `make_counter`).
    The dict has 'message', 'estimated_s', 'budget_s', 'segments', and optionally 'suggested_radius_km' (lowering the
    radius is enough) and/or 'suggested_max_hours' (the longest band has to shrink because it holds the radius up).
    """
    estimated = estimated_total_seconds(elapsed_s, segments)
    if estimated <= budget_s:
        return None
    prefix = 'This area has too much road and trail data to analyse within the time limit. '
    out = {'estimated_s': round(estimated, 1), 'budget_s': budget_s, 'segments': int(segments),
           'message': prefix + 'Try a smaller area: move the start point or shorten the time bands.'}
    fit_km = _largest_fitting_radius(elapsed_s, radius_km, budget_s, count)
    if fit_km is None:
        return out
    if fit_km >= reach_km:
        out['suggested_radius_km'] = fit_km
        out['message'] = prefix + f'Try a radius of {fit_km} km or less.'
        return out
    # The radius used is at least speed x longest band + 2 km, so a radius that fits is below what the bands need:
    # the longest band has to shrink as well.
    hours = math.floor(max(fit_km - RADIUS_MARGIN_KM, 0) / speed_kmh / HOURS_STEP) * HOURS_STEP
    if hours >= MIN_HOURS:
        out['suggested_max_hours'] = hours
        text = f'Shorten the longest time band to {hours:g} hours or less at {speed_kmh:g} km/h, or use a lower speed'
        if radius_km > reach_km + 1e-9:
            # An explicit radius above the bands' reach would keep the area too large: it must come down too.
            out['suggested_radius_km'] = fit_km
            text += f', and use a radius of {fit_km} km or less'
        out['message'] = prefix + text + '.'
    return out
