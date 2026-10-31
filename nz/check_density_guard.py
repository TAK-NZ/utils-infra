"""Check nz/density_guard.py.
Usage (from the repo root):  python nz/check_density_guard.py [N_RANDOM] [--real]

Always:
  1. the cost model against the measurements it was fitted to (it must not fall below the slowest, most important one);
  2. random inputs: the guard refuses exactly when the estimate exceeds the budget, a refusal always carries a message,
     and every suggestion, when applied, fits the budget under the model (suggested radius or shorter longest band);
  3. a request with too few segments is never refused, whatever the time already used (up to the budget).
--real (needs the data directory and network access to the LINZ elevation bucket):
  4. a bush request gives byte-identical contours with the guard on and with it effectively off (budget 1e9 s);
  5. central Auckland at 30 km is refused through the real handler with HTTP 422 and a JSON body that has the code,
     the message and a suggestion, and logs no coordinates; the suggested radius then runs to completion inside the
     budget.
Exit status is 1 if anything fails.
"""
import contextlib
import io
import json
import math
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app'))
sys.path.insert(0, os.path.dirname(__file__))
import density_guard as g  # noqa: E402

# (trail + road + power-line segments, measured cost-surface seconds) on the 2 GB Lambda
MEASURED = [(12_000, 5.0), (50_000, 11.0), (113_639, 17.55), (250_000, 38.7)]


def check_model():
    ok = True
    for segments, seconds in MEASURED:
        model = g.COST_SURFACE_BASE_S + g.SECONDS_PER_SEGMENT * segments
        good = abs(model - seconds) <= 3.0 and (segments < 200_000 or model >= seconds)
        ok &= good
        print(f"{'PASS' if good else 'FAIL'}  model {model:5.1f}s vs measured {seconds:5.1f}s at {segments:>7,} segments")
    return ok


def check_random(n):
    rng = random.Random(7)
    bad = 0
    refused = suggested_r = suggested_h = bare = 0
    for _ in range(n):
        speed = rng.choice([0.5, 1.0, 2.5, 4.0, 7.5, 10.0])
        hours = rng.choice([0.5, 1, 2, 4, 8, 12, 24])
        reach = speed * hours + g.RADIUS_MARGIN_KM
        radius = max(rng.uniform(1, 30), reach)
        radius = min(radius, 30.0)
        reach = min(reach, 30.0)
        segments = int(10 ** rng.uniform(2, 6))
        elapsed = rng.uniform(1, 25)
        budget = rng.choice([20.0, 30.0, 45.0, 55.0])
        out = g.assess(elapsed, segments, radius, reach, speed, budget)
        fits = g.estimated_total_seconds(elapsed, segments) <= budget
        if fits != (out is None):
            bad += 1
            print('FAIL decision', elapsed, segments, budget, out)
            continue
        if out is None:
            continue
        refused += 1
        if not out.get('message'):
            bad += 1
            print('FAIL no message', out)
        # Apply the suggestion the way the engine would: the radius used is max(radius given, speed x band + 2 km).
        # A caller who follows a hours-only suggestion keeps their radius only when it was not above the bands' reach.
        hours = out.get('suggested_max_hours')
        given = out.get('suggested_radius_km')
        if hours is None and given is None:
            bare += 1
            continue
        new_reach = (hours * speed + g.RADIUS_MARGIN_KM) if hours is not None else reach
        new_radius = max(given if given is not None else (radius if radius > reach + 1e-9 else 0), new_reach)
        if hours is not None and given is None and radius > reach + 1e-9:
            bad += 1
            print('FAIL hours-only suggestion although the explicit radius is above the reach', out, radius, reach)
        scaled = segments * (new_radius / radius) ** 2          # segments grow with area
        suggestion_ok = (new_radius <= radius + 1e-9 and (hours is None or hours >= g.MIN_HOURS)
                         and (given is None or given >= 1)
                         and g.estimated_total_seconds(elapsed, scaled) <= budget)
        if hours is None:
            suggested_r += 1
            suggestion_ok &= given >= reach
        else:
            suggested_h += 1
        if not suggestion_ok:
            bad += 1
            print('FAIL suggestion does not fit', out, radius, reach, segments)
        # Tight, not just safe: within about 1 km of the largest radius the model allows, and one 0.25 h step more
        # would already need more than the largest whole-km radius that fits.
        allowed = (budget - elapsed - g.COST_SURFACE_BASE_S - g.AFTER_COST_SURFACE_S) / g.SECONDS_PER_SEGMENT
        exact_fit = radius * math.sqrt(allowed / segments)
        too_small = (given is not None and given <= exact_fit - 1 - 1e-9) or \
                    (hours is not None and (hours + 0.25) * speed + g.RADIUS_MARGIN_KM <= math.floor(exact_fit))
        if too_small:
            bad += 1
            print('FAIL suggestion is needlessly small', out, 'exact fit', round(exact_fit, 2), radius, reach)
    print(f"{'PASS' if bad == 0 else 'FAIL'}  {n} random cases: {refused} refused "
          f"({suggested_r} with a radius, {suggested_h} with shorter hours, {bare} with a generic message), {bad} wrong")
    return bad == 0


def check_light_never_refused():
    # 5,000 segments cost 3 + 0.75 + 1 = 4.75 s, so anything that has used under 40 s of a 45 s budget must pass.
    bad = sum(g.assess(e / 2, 5000, 10, 4, 2.5, 45.0) is not None for e in range(0, 80))
    print(f"{'PASS' if bad == 0 else 'FAIL'}  a light request (5,000 segments) is never refused while time remains")
    return bad == 0


def event(body, key):
    return {'httpMethod': 'POST', 'path': '/sar/travel-time', 'headers': {'x-api-key': key},
            'body': json.dumps(body), 'requestContext': {'elb': {}}}


def run_real():
    os.environ['SAR_API_KEY'] = key = 'check-density-guard-0123456789'
    import handler
    ok = True

    def call(body):
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink):
            t = time.time()
            resp = handler.lambda_handler(event(body, key), None)
            took = time.time() - t
        return resp, json.loads(resp['body']), took, sink.getvalue()

    # 4. guard on versus effectively off: identical contours for a bush request
    bush = {'ipp': {'lat': -40.87, 'lng': 175.45}, 'speed_kmh': 2.5, 'intervals_hours': [1, 2, 4], 'radius_km': 12}
    os.environ.pop('SAR_TIME_BUDGET_S', None)
    _, on, _, _ = call(bush)
    os.environ['SAR_TIME_BUDGET_S'] = '1e9'
    _, off, _, _ = call(bush)
    os.environ.pop('SAR_TIME_BUDGET_S', None)
    same = on.get('contours') == off.get('contours') and on.get('status') == 'ok'
    ok &= same
    print(f"{'PASS' if same else 'FAIL'}  bush 12 km: contours identical with the guard on and off")

    # 5. dense city: refused, then the suggestion runs inside the budget
    auckland = {'ipp': {'lat': -36.85, 'lng': 174.76}, 'speed_kmh': 2.5, 'intervals_hours': [1, 2, 4], 'radius_km': 30}
    resp, body, took, printed = call(auckland)
    refused = resp['statusCode'] == 422 and body.get('code') == 'area_too_dense' and body.get('message')
    ok &= bool(refused)
    print(f"{'PASS' if refused else 'FAIL'}  Auckland 30 km refused in {took:.1f}s: HTTP {resp['statusCode']} {body}")
    leaked = any(s in resp['body'] or s in printed for s in ('-36.85', '174.76'))
    ok &= not leaked
    print(f"{'PASS' if not leaked else 'FAIL'}  the refusal and the log line contain no coordinates")
    radius = body.get('suggested_radius_km')
    if radius:
        auckland['radius_km'] = radius
        resp, body2, took, _ = call(auckland)
        fits = resp['statusCode'] == 200 and took <= g.budget_seconds()
        ok &= fits
        print(f"{'PASS' if fits else 'FAIL'}  suggested radius {radius} km: HTTP {resp['statusCode']} in {took:.1f}s "
              f"(budget {g.budget_seconds():g}s), timings {body2.get('timings_s')}")
    else:
        ok = False
        print('FAIL  no suggested_radius_km in the Auckland refusal')
    return ok


if __name__ == '__main__':
    n = int(next((a for a in sys.argv[1:] if a.isdigit()), 20000))
    ok = check_model()
    ok &= check_random(n)
    ok &= check_light_never_refused()
    if '--real' in sys.argv:
        ok &= run_real()
    print('ALL CHECKS PASSED' if ok else 'CHECKS FAILED')
    sys.exit(0 if ok else 1)
