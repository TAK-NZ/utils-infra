"""TARR (Terrain-Aware Range Rings) logic for the /tarr route: subject distances, calibration multipliers, the plain
Koester circles and the assembly of the ring features. Standard library only, so it imports and is checked anywhere.

What a ring is. Koester (2008) gives, per subject profile, the distances within which 25%, 50% and 75% of subjects were
found (United States records). WiSAR scales them with multipliers fitted to Coconino County, Arizona missions and finds
the area that costs that much to reach over the terrain ("terrain-adjusted"). Nothing here is calibrated for New Zealand:
the response says so, and every terrain ring is accompanied by the plain, multiplier-free Koester circle.

Multipliers. The default is the Arizona set of app/server.py (CALIBRATION_MULTIPLIERS and CALIBRATION_DEFAULT, one value
per profile, used for all three bands). It can be replaced without a code change, first match wins:
    1. environment variable SAR_TARR_MULTIPLIERS (JSON text of at most 4096 characters; for local runs and tests)
    2. the key "tarrMultipliers" of the API-key JSON file in the config bucket (same file, same permissions, cached 5 min)
    3. the built-in Arizona set
    {"label": "Coconino County, Arizona", "default": 1.40, "profiles": {"Hiker": 1.15,
     "Dementia": {"p25": 2.50, "p50": 2.55, "p75": 2.50}}}
A value is a number (all three bands) or {"p25", "p50", "p75"}; each is finite and between 0.1 and 10. A configured set
replaces the built-in one completely. Anything invalid raises ConfigError and is never replaced by the Arizona set.

GeoJSON from the circles is not wrapped at the antimeridian (the engine only accepts start points up to 179.5 E).
"""
import json
import math
import os
import time
from collections import namedtuple
from decimal import ROUND_HALF_UP, Decimal

import api_keys
from tarr_profiles import KOESTER_SOURCE, LPB_DATA  # noqa: F401  (KOESTER_SOURCE is re-exported for the handler)

ARIZONA_REGION = 'Coconino County, Arizona'
# Copied from app/server.py CALIBRATION_MULTIPLIERS / CALIBRATION_DEFAULT; nz/check_tarr.py compares them with that file.
ARIZONA_MULTIPLIERS = {
    'Hiker': 1.15,
    'Skier (Alpine)': 2.15,
    'Dementia': 2.55,
    'Mental Illness': 4.05,
    'Despondent': 1.65,
    'Hunter': 0.80,
    'Child (10-12)': 1.55,
}
ARIZONA_DEFAULT = 1.40
PERCENTS = (25, 50, 75)
BANDS = ('p25', 'p50', 'p75')
COLORS = {25: '#d32f2f', 50: '#f57c00', 75: '#fbc02d'}
RADIUS_MARGIN_KM = 2.0                      # as upstream: calibrated p75 + 2 km
CIRCLE_VERTICES = 72
EARTH_RADIUS_KM = 6371.0088
MIN_MULTIPLIER, MAX_MULTIPLIER = 0.1, 10.0
MAX_ENV_CHARS = 4096
MAX_LABEL_CHARS = 80
DEFAULT_LABEL = 'configured by the operator'
CONFIG_KEY = 'tarrMultipliers'
CACHE_SECONDS = 300


class SelectionError(ValueError):
    """The subject profile, ecoregion or terrain is not valid. The message is shown to the caller."""


class ConfigError(ValueError):
    """The multiplier configuration is invalid. The message is for developers; callers only see a generic failure."""


Calibration = namedtuple('Calibration', 'label source default profiles')   # default: (m25, m50, m75); profiles: {name: (...)}

BUILT_IN = Calibration(ARIZONA_REGION, 'built-in', (ARIZONA_DEFAULT,) * 3,
                       {name: (value,) * 3 for name, value in ARIZONA_MULTIPLIERS.items()})


# --------------------------------------------------------------------------------------------------------------
# Subject distances
# --------------------------------------------------------------------------------------------------------------
def resolve_distances(profile, ecoregion=None, terrain=None):
    """Validate the selection and return the Koester row: {'p25', 'p50', 'p75', 'ecoregion', 'terrain'} (km, uncalibrated).
    The row is the exact (ecoregion, terrain), else (ecoregion, any terrain), else the profile's default row; the
    ecoregion and terrain returned are those of the row actually used (None for a default row)."""
    if not isinstance(profile, str) or not profile:
        raise SelectionError('profile is required')
    rows = LPB_DATA.get(profile)
    if rows is None:
        raise SelectionError('profile is not a supported subject profile')
    for value, name in ((ecoregion, 'ecoregion'), (terrain, 'terrain')):
        if value is not None and not isinstance(value, str):
            raise SelectionError(f'{name} must be a text value')
    if ecoregion is not None and not any(r[0] == ecoregion for r in rows):
        raise SelectionError('ecoregion is not available for this profile')
    if terrain is not None and not any(r[0] == ecoregion and r[1] == terrain for r in rows):
        raise SelectionError('terrain is not available for this profile and ecoregion')
    for want in ((ecoregion, terrain), (ecoregion, None), (None, None)):
        for eco, ter, p25, p50, p75 in rows:
            if (eco, ter) == want:
                return {'p25': p25, 'p50': p50, 'p75': p75, 'ecoregion': eco, 'terrain': ter}
    raise SelectionError('profile is not a supported subject profile')       # unreachable: every profile has a default row


# --------------------------------------------------------------------------------------------------------------
# Multipliers
# --------------------------------------------------------------------------------------------------------------
def _multiplier(value, where):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or not MIN_MULTIPLIER <= value <= MAX_MULTIPLIER:
        raise ConfigError(f'{where} must be a number between {MIN_MULTIPLIER:g} and {MAX_MULTIPLIER:g}')
    return float(value)


def _bands(value, where):
    if isinstance(value, dict):
        if set(value) != set(BANDS):
            raise ConfigError(f'{where} must have exactly p25, p50 and p75')
        return tuple(_multiplier(value[b], f'{where}.{b}') for b in BANDS)
    return (_multiplier(value, where),) * 3


def parse_calibration(raw, source):
    """Validate a multiplier set (JSON text or an already parsed object) and return a Calibration. Raises ConfigError."""
    if isinstance(raw, str):
        if len(raw) > MAX_ENV_CHARS:
            raise ConfigError(f'multiplier text is longer than {MAX_ENV_CHARS} characters')
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ConfigError('multiplier text is not valid JSON') from None
    if not isinstance(raw, dict):
        raise ConfigError('multiplier set must be a JSON object')
    unknown = set(raw) - {'label', 'default', 'profiles'}
    if unknown:
        raise ConfigError('multiplier set has an unknown key')
    if 'default' not in raw:
        raise ConfigError('multiplier set needs a default')
    label = raw.get('label')
    if label is not None and (not isinstance(label, str) or len(label) > MAX_LABEL_CHARS
                              or any(ord(c) < 32 for c in label)):
        raise ConfigError(f'label must be text of at most {MAX_LABEL_CHARS} characters')
    profiles = raw.get('profiles', {})
    if not isinstance(profiles, dict):
        raise ConfigError('profiles must be an object')
    parsed = {}
    for name, value in profiles.items():
        if name not in LPB_DATA:
            raise ConfigError('profiles has an unknown profile name')
        parsed[name] = _bands(value, 'profiles value')
    return Calibration(label or None, source, _bands(raw['default'], 'default'), parsed)


_file_cache = {'loaded_at': None, 'value': None}


def load_calibration(environ=None, now=None):
    """The multiplier set in force (see the module docstring for the precedence). Raises ConfigError."""
    environ = os.environ if environ is None else environ
    text = environ.get('SAR_TARR_MULTIPLIERS')
    if text:
        return parse_calibration(text, 'environment')
    bucket, key = environ.get('SAR_CONFIG_BUCKET'), environ.get('SAR_CONFIG_KEY')
    if not (bucket and key):
        return BUILT_IN
    now = time.time() if now is None else now
    loaded_at = _file_cache['loaded_at']
    if loaded_at is None or now - loaded_at >= CACHE_SECONDS:
        try:
            config = api_keys._read_config_file(bucket, key)
        except Exception as e:      # noqa: BLE001 - fail closed; callers log the class name only
            raise ConfigError(f'config file could not be read ({type(e).__name__})') from None
        raw = config.get(CONFIG_KEY) if isinstance(config, dict) else None
        _file_cache.update(loaded_at=now, value=None if raw is None else parse_calibration(raw, 'config-file'))
    return _file_cache['value'] or BUILT_IN


def reset_cache():
    _file_cache.update(loaded_at=None, value=None)


def multipliers_for(calibration, profile):
    """(m25, m50, m75, profile_specific). A profile that is not listed uses the set's default."""
    if profile in calibration.profiles:
        return (*calibration.profiles[profile], True)
    return (*calibration.default, False)


def calibrate(distances, multipliers):
    """Koester distances times the multipliers, 3 decimals: (c25, c50, c75). The bands must stay in order."""
    # Decimal, so 1.77 x 1.15 = 2.0355 rounds to 2.036 as written, not to 2.035 through binary floating point.
    out = tuple(float((Decimal(str(distances[b])) * Decimal(str(m))).quantize(Decimal('0.001'), rounding=ROUND_HALF_UP))
                for b, m in zip(BANDS, multipliers[:3]))
    if not out[0] <= out[1] <= out[2]:
        raise ConfigError('calibrated distances are not in increasing order')
    return out


def analysis_radius(c75, max_radius_km):
    """(radius km, clipped): calibrated p75 + 2 km as upstream, at most max_radius_km."""
    radius = c75 + RADIUS_MARGIN_KM
    return (max_radius_km, True) if radius > max_radius_km else (radius, False)


def calibration_texts(calibration):
    """(note, warning message, attribution line) for a response. Plain wording: no claim about New Zealand."""
    if calibration.label:
        region = calibration.label
        note = f'Multipliers were fitted to search records from {region}. They are not calibrated for New Zealand.'
        warning = f'Ring distances were scaled by multipliers fitted to {region}. They are not calibrated for New Zealand.'
    else:
        region = DEFAULT_LABEL
        note = 'Multipliers were set in the engine configuration. They are not calibrated for New Zealand.'
        warning = ('Ring distances were scaled by multipliers set in the engine configuration. '
                   'They are not calibrated for New Zealand.')
    return note, warning, f'Calibration multipliers: WiSAR, {region} (not calibrated for New Zealand)'


# --------------------------------------------------------------------------------------------------------------
# Rings
# --------------------------------------------------------------------------------------------------------------
def circle_polygon(lat, lng, radius_km, vertices=CIRCLE_VERTICES):
    """Spherical circle around (lat, lng) as a GeoJSON Polygon: closed, counter-clockwise, 5 decimals. The first
    vertex is due north of the centre."""
    phi, lam, delta = math.radians(lat), math.radians(lng), radius_km / EARTH_RADIUS_KM
    ring = []
    for i in range(vertices):
        theta = -2.0 * math.pi * i / vertices                    # bearing decreases: counter-clockwise on a map
        phi2 = math.asin(math.sin(phi) * math.cos(delta) + math.cos(phi) * math.sin(delta) * math.cos(theta))
        lam2 = lam + math.atan2(math.sin(theta) * math.sin(delta) * math.cos(phi),
                                math.cos(delta) - math.sin(phi) * math.sin(phi2))
        ring.append([round(math.degrees(lam2), 5), round(math.degrees(phi2), 5)])
    ring.append(list(ring[0]))
    return {'type': 'Polygon', 'coordinates': [ring]}


def build_features(lat, lng, distances, calibrated, multipliers, upstream):
    """Ring features in draw order (first = bottom): plain 75, terrain 75, plain 50, terrain 50, plain 25, terrain 25.
    `upstream` is the FeatureCollection of pipeline.outputs.extract_contour_polygons; rings are matched by
    properties.percentile ('25%', '50%', '75%'). Returns (features, missing_percents): a terrain ring the pipeline did
    not produce is left out and reported, the plain circle is always present."""
    by_percent = {}
    for f in (upstream or {}).get('features', []):
        by_percent[(f.get('properties') or {}).get('percentile')] = f
    features, missing = [], []
    for percent in reversed(PERCENTS):
        band = f'p{percent}'
        index = PERCENTS.index(percent)
        koester = distances[band]
        circle = circle_polygon(lat, lng, koester)
        top = circle['coordinates'][0][0]
        features.append({
            'type': 'Feature', 'geometry': circle,
            'properties': {'kind': 'plain', 'percent': percent, 'label': f'Koester {percent}%, plain circle',
                           'color': COLORS[percent], 'koester_km': koester, 'distance_km': koester,
                           'label_lat': top[1], 'label_lng': top[0]}})
        found = by_percent.get(f'{percent}%')
        if not found or not found.get('geometry'):
            missing.append(percent)
            continue
        props = found.get('properties') or {}
        features.append({
            'type': 'Feature', 'geometry': found['geometry'],
            'properties': {'kind': 'terrain', 'percent': percent, 'label': f'Koester {percent}%, terrain-adjusted',
                           'color': COLORS[percent], 'koester_km': koester, 'distance_km': calibrated[index],
                           'threshold_m': round(calibrated[index] * 1000, 3), 'multiplier': multipliers[index],
                           'label_lat': props.get('label_lat', round(lat, 5)),
                           'label_lng': props.get('label_lng', round(lng, 5))}})
    return features, sorted(missing)
