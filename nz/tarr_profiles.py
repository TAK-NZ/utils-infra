"""Koester (2008) Lost Person Behavior distances per subject profile, for the TARR route.
Generated from the `var LPB_DATA=` line of app/static/app.js (not retyped); nz/check_tarr.py re-parses that file and
fails if this table differs from it. Each row is (ecoregion, terrain, p25 km, p50 km, p75 km); None means "any".
Ecoregions: Temperate, Dry, Urban. Terrain: Mountainous, Flat. Every profile has an (None, None) default row.
"""
KOESTER_SOURCE = 'Koester (2008), Lost Person Behavior, via Ferguson (2013), IGT4SAR'

LPB_DATA = {
    'Abduction': [
        (None, None, 0.32, 2.41, 19.31),
    ],
    'Aircraft': [
        (None, None, 0.64, 1.45, 5.95),
    ],
    'Angler': [
        ('Temperate', 'Mountainous', 0.32, 1.45, 5.47),
        ('Temperate', 'Flat', 0.8, 1.61, 5.47),
        ('Dry', None, 3.22, 9.66, 10.46),
        (None, None, 0.8, 1.61, 5.47),
    ],
    'All Terrain Vehicle': [
        (None, None, 1.61, 3.22, 5.63),
    ],
    'Autistic': [
        ('Urban', None, 0.32, 0.97, 3.86),
        (None, None, 0.64, 1.61, 3.7),
    ],
    'Camper': [
        ('Dry', 'Mountainous', 0.64, 1.61, 4.18),
        ('Temperate', 'Mountainous', 0.16, 2.25, 3.06),
        (None, None, 0.16, 1.13, 3.22),
    ],
    'Child (1-3)': [
        ('Dry', None, 0.64, 1.29, 3.86),
        ('Urban', None, 0.16, 0.48, 0.8),
        ('Temperate', 'Mountainous', 0.16, 0.32, 0.97),
        (None, None, 0.16, 0.32, 0.97),
    ],
    'Child (4-6)': [
        ('Dry', None, 0.64, 1.93, 3.22),
        ('Urban', None, 0.1, 0.48, 0.97),
        ('Temperate', 'Mountainous', 0.16, 0.8, 1.45),
        (None, None, 0.16, 0.64, 1.45),
    ],
    'Child (7-9)': [
        ('Dry', None, 0.48, 1.29, 3.22),
        ('Urban', None, 0.16, 0.48, 1.45),
        ('Temperate', 'Mountainous', 0.8, 1.61, 3.22),
        (None, None, 0.16, 0.8, 2.09),
    ],
    'Child (10-12)': [
        ('Dry', None, 0.8, 2.09, 7.24),
        ('Urban', None, 0.32, 1.45, 2.9),
        ('Temperate', 'Mountainous', 0.8, 1.61, 3.22),
        (None, None, 0.48, 1.61, 4.83),
    ],
    'Child (13-15)': [
        ('Dry', None, 2.41, 3.22, 4.83),
        ('Temperate', 'Mountainous', 0.8, 2.09, 4.83),
        (None, None, 0.64, 1.29, 3.22),
    ],
    'Climber': [
        (None, None, 0.16, 1.61, 3.22),
    ],
    'Dementia': [
        ('Dry', 'Mountainous', 0.97, 1.93, 3.06),
        ('Dry', 'Flat', 0.48, 1.61, 3.54),
        ('Urban', None, 0.32, 1.13, 3.22),
        ('Temperate', 'Mountainous', 0.32, 0.8, 1.93),
        (None, None, 0.32, 0.97, 2.41),
    ],
    'Despondent': [
        ('Dry', 'Mountainous', 0.8, 1.61, 3.38),
        ('Dry', 'Flat', 0.48, 1.93, 3.7),
        ('Urban', None, 0.1, 0.48, 1.45),
        ('Temperate', 'Mountainous', 0.32, 1.13, 3.22),
        (None, None, 0.32, 0.8, 2.25),
    ],
    'Gatherer': [
        ('Dry', None, 1.61, 2.57, 5.79),
        (None, None, 1.45, 3.22, 6.44),
    ],
    'Hiker': [
        ('Dry', 'Mountainous', 1.61, 3.22, 6.44),
        ('Dry', 'Flat', 1.29, 2.09, 6.6),
        ('Temperate', 'Mountainous', 1.13, 3.06, 5.79),
        (None, None, 0.64, 1.77, 3.22),
    ],
    'Horseback Rider': [
        (None, None, 0.32, 3.22, 8.05),
    ],
    'Hunter': [
        ('Dry', 'Mountainous', 2.09, 4.83, 8.05),
        ('Dry', 'Flat', 1.61, 3.06, 6.44),
        ('Temperate', 'Mountainous', 0.97, 2.09, 4.83),
        (None, None, 0.64, 1.61, 3.06),
    ],
    'Intellectual Disability': [
        ('Dry', None, 1.13, 4.02, 8.69),
        ('Urban', None, 0.32, 0.8, 3.7),
        ('Temperate', 'Mountainous', 0.64, 1.61, 3.22),
        (None, None, 0.32, 0.97, 2.09),
    ],
    'Mental Illness': [
        ('Urban', None, 0.32, 0.64, 1.45),
        ('Temperate', 'Mountainous', 0.64, 2.25, 8.21),
        (None, None, 0.8, 0.97, 2.25),
    ],
    'Mountain Biker': [
        ('Dry', None, 2.74, 6.44, 13.2),
        (None, None, 3.06, 4.02, 11.27),
    ],
    'Extreme Sport': [
        (None, None, 0.48, 2.57, 5.63),
    ],
    'Runner': [
        (None, None, 1.45, 2.57, 3.38),
    ],
    'Skier (Alpine)': [
        (None, None, 1.13, 2.74, 4.83),
    ],
    'Skier (Nordic)': [
        ('Dry', None, 1.93, 4.35, 6.44),
        (None, None, 1.61, 3.54, 6.44),
    ],
    'Snowboarder': [
        (None, None, 1.61, 3.22, 6.12),
    ],
    'Snowmobiler': [
        ('Dry', None, 1.61, 4.83, 14.0),
        ('Temperate', 'Flat', 1.29, 4.67, 41.04),
        (None, None, 3.22, 6.44, 11.1),
    ],
    'Substance Abuse': [
        (None, None, 0.48, 1.13, 4.18),
    ],
}
