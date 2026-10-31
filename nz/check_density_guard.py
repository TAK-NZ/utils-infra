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
    """Random requests with a synthetic count(r) that does NOT follow the area: count = segments * (r / radius) ** p
    with p between 0.4 (a dense isthmus such as central Auckland) and 2.2 (open country). Real data refused a
    suggestion that an area formula had made, so the suggestion is checked against the counter, not a formula."""
    rng = random.Random(7)
    bad = 0
    refused = suggested_r = suggested_h = bare = 0
    for _ in range(n):
        speed = rng.choice([0.5, 1.0, 2.5, 4.0, 7.5, 10.0])
        band = rng.choice([0.5, 1, 2, 4, 8, 12, 24])
        reach = min(speed * band + 2.0, 30.0)
        radius = min(max(rng.uniform(1, 30), reach), 30.0)
        total = int(10 ** rng.uniform(2, 6))
        p = rng.uniform(0.4, 2.2)

        def count(r, total=total, radius=radius, p=p):
            return int(total * (r / radius) ** p)
        segments = count(radius)
        elapsed = rng.uniform(1, 25)
        budget = rng.choice([20.0, 30.0, 45.0, 55.0])
        out = g.assess(elapsed, segments, radius, reach, speed, budget, count)
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

        def fits_at(r):
            return g.estimated_total_seconds(elapsed, count(r)) <= budget
        best = next((k for k in range(math.ceil(radius) - 1, 0, -1) if fits_at(k)), None)     # brute force
        hours = out.get('suggested_max_hours')
        given = out.get('suggested_radius_km')
        if hours is None and given is None:
            bare += 1
            hours_possible = best is not None and best < reach and \
                math.floor(max(best - 2.0, 0) / speed / 0.25) * 0.25 >= 0.25
            if best is not None and (best >= reach or hours_possible):
                bad += 1
                print('FAIL no suggestion although one exists', out, 'best', best, radius, reach)
            continue
        problems = []
        if given is not None:
            suggested_r += 1 if hours is None else 0
            if not (1 <= given < radius and fits_at(given)):
                problems.append('suggested radius does not fit')
            if given != best:
                problems.append(f'suggested radius is not the largest that fits ({best})')
            if hours is None and given < reach:
                problems.append('radius suggestion below the reach')
        if hours is not None:
            suggested_h += 1
            new_reach = hours * speed + 2.0
            if hours < 0.25 or best is None or new_reach > best + 1e-9 or not fits_at(new_reach):
                problems.append('shorter band does not fit')
            if (hours + 0.25) * speed + 2.0 <= best + 1e-9:
                problems.append('shorter band is needlessly short')
            if given is None and radius > reach + 1e-9:
                problems.append('hours-only suggestion although the explicit radius is above the reach')
        if problems:
            bad += 1
            print('FAIL', problems, out, 'radius', radius, 'reach', reach, 'best', best)
    print(f"{'PASS' if bad == 0 else 'FAIL'}  {n} random cases: {refused} refused "
          f"({suggested_r} with a radius, {suggested_h} with shorter hours, {bare} with a generic message), {bad} wrong")
    return bad == 0


def check_light_never_refused():
    # 5,000 segments cost 3 + 0.75 + 1 = 4.75 s, so anything that has used under 40 s of a 45 s budget must pass.
    bad = sum(g.assess(e / 2, 5000, 10, 4, 2.5, 45.0, lambda r: 5000) is not None for e in range(0, 80))
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

    # 4b. the counter agrees exactly with a fresh OSM read at each smaller radius (central Auckland: the count does
    # not follow the area, 113,639 at 10 km against 204,351 at 20 km, which is why a formula was wrong)
    import nz_sources
    from pipeline.shared import get_bbox_from_ipp
    lat0, lng0 = -36.85, 174.76
    with contextlib.redirect_stdout(io.StringIO()):
        full = nz_sources.download_osm_features(get_bbox_from_ipp(lat0, lng0, 30))
        full.pop('_warnings', None)
        counter = g.make_counter(full, lambda r: get_bbox_from_ipp(lat0, lng0, r))
        exact = {r: g.segment_count({k: v for k, v in nz_sources.download_osm_features(get_bbox_from_ipp(lat0, lng0, r)).items()
                                     if not k.startswith('_')}) for r in (5, 10, 20, 27, 30)}
    # Segments that only touch the box edge are counted here and not by the file reader: the count is never lower
    # (the safe direction) and differs by a handful of segments, so allow 0.05% over and no under-count.
    mismatch = {r: (counter(r), e) for r, e in exact.items() if not 0 <= counter(r) - e <= max(10, e * 0.0005)}
    mono = all(counter(r) <= counter(r + 1) for r in range(1, 30))
    good = not mismatch and mono and counter(30) == g.segment_count(full)
    ok &= good
    print(f"{'PASS' if good else 'FAIL'}  counter equals a fresh read at {sorted(exact)} km: "
          f"{ {r: exact[r] for r in sorted(exact)} }" + ('' if not mismatch else f'  mismatches {mismatch}'))

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
