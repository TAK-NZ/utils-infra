"""Dense-area guard: refuse a request early when it cannot finish inside the time budget.

Why: the cost-surface stage burns every trail, road and power-line segment into the grid, and its time grows with the
number of segments (about 5 s at 12,000, 17 s at 114,000, 39 s at 250,000, measured on Lambda). Central Auckland at
30 km has about 250,000 segments, so the whole request takes 48 to 63 s and can hit the load balancer's 60 s limit,
which gives the caller a generic failure after a minute. This module answers the same request in under 10 s with a
clear message and a smaller radius or shorter time band that should fit.

How: after the OSM read (so the segments are already counted for free) and before the cost surface, estimate

    total = time used so far + COST_SURFACE_BASE_S + SECONDS_PER_SEGMENT * segments + AFTER_COST_SURFACE_S

and refuse when it exceeds the budget. A request that passes is untouched: the guard only reads counts.

The cost model is a straight line fitted by eye to four real measurements (12k, 50k, 114k and 250k segments). It sits
within 3 s of all four, a little above the middle two and at the top, where the decision matters, about 2 s above the
measurement. Four points is thin: treat the threshold as a calibrated guess and re-measure if the engine or the Lambda
size changes. nz/check_density_guard.py holds the measurements and fails if the model drifts away from them.

The budget is for the handler (not including container start). A cold start can add up to about 10 s before the
handler runs, so the default of 45 s leaves room under a 55 s function timeout and the 60 s load balancer limit.
Raise it with SAR_TIME_BUDGET_S only together with those two limits.
"""
import math
import os

COST_SURFACE_BASE_S = 3.0
SECONDS_PER_SEGMENT = 0.00015          # 0.15 ms per trail, road or power-line segment
AFTER_COST_SURFACE_S = 1.0             # cost-distance plus contours (0.1 to 0.8 s measured)
DEFAULT_BUDGET_S = 45.0
MIN_SUGGESTED_SEGMENTS = 5000          # below this the budget is spent before the cost surface: no useful suggestion
MIN_HOURS = 0.25                       # keep equal to handler.MIN_HOURS
HOURS_STEP = 0.25
RADIUS_MARGIN_KM = 2.0                 # the engine analyses at least speed x longest band + this (handler.run_travel_time)


def budget_seconds():
    """Time budget in seconds; SAR_TIME_BUDGET_S overrides the default. Anything not a positive number is ignored."""
    try:
        value = float(os.environ.get('SAR_TIME_BUDGET_S', ''))
    except ValueError:
        return DEFAULT_BUDGET_S
    return value if math.isfinite(value) and value > 0 else DEFAULT_BUDGET_S


def segment_count(osm):
    """Segments the cost surface will burn in: trails, roads and power lines (waterways are cheap and not counted)."""
    return sum(len(osm[key]) for key in ('trails', 'roads', 'powerlines') if osm.get(key) is not None)


def estimated_total_seconds(elapsed_s, segments):
    return elapsed_s + COST_SURFACE_BASE_S + SECONDS_PER_SEGMENT * segments + AFTER_COST_SURFACE_S


def assess(elapsed_s, segments, radius_km, reach_km, speed_kmh, budget_s):
    """Return None when the request fits, else a dict describing the refusal.

    radius_km is the radius actually used (already raised to `reach_km`, which is speed x longest band + 2 km).
    The dict has 'message', optionally 'suggested_radius_km' (when lowering the radius is enough) or
    'suggested_max_hours' (when the radius is held up by the longest time band), and 'estimated_s' for logging.
    """
    estimated = estimated_total_seconds(elapsed_s, segments)
    if estimated <= budget_s:
        return None
    headroom = budget_s - elapsed_s - COST_SURFACE_BASE_S - AFTER_COST_SURFACE_S
    allowed = headroom / SECONDS_PER_SEGMENT
    prefix = 'This area has too much road and trail data to analyse within the time limit. '
    out = {'estimated_s': round(estimated, 1), 'budget_s': budget_s, 'segments': int(segments),
           'message': prefix + 'Try a smaller area: move the start point or shorten the time bands.'}
    if allowed < MIN_SUGGESTED_SEGMENTS or segments <= 0:
        return out
    # Segments grow roughly with area, so the radius that fits scales with the square root of the segment ratio.
    fit_km = math.floor(radius_km * math.sqrt(allowed / segments))
    if fit_km >= reach_km and fit_km >= 1:
        out['suggested_radius_km'] = fit_km
        out['message'] = prefix + f'Try a radius of {fit_km} km or less.'
        return out
    # The radius used is at least speed x longest band + 2 km, so a radius that fits is below what the bands need:
    # the longest band has to shrink as well.
    hours = math.floor(max(fit_km - RADIUS_MARGIN_KM, 0) / speed_kmh / HOURS_STEP) * HOURS_STEP
    if fit_km >= 1 and hours >= MIN_HOURS:
        out['suggested_max_hours'] = hours
        text = f'Shorten the longest time band to {hours:g} hours or less at {speed_kmh:g} km/h, or use a lower speed'
        if radius_km > reach_km + 1e-9:
            # An explicit radius above the bands' reach would keep the area too large: it must come down too.
            out['suggested_radius_km'] = fit_km
            text += f', and use a radius of {fit_km} km or less'
        out['message'] = prefix + text + '.'
    return out
