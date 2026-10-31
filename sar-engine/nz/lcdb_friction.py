"""LCDB class -> impedance table loader for the WiSAR cost surface.

The unmodified pipeline converts land-cover codes to impedance through the shared dict
pipeline.shared.NLCD_IMPEDANCE. register() adds synthetic codes for LCDB to that same dict, in place:

    100 + class      LCDB class (100 = sea / outside the LCDB polygons, via class 0)
    200 + class      LCDB class on a wetland-flagged polygon (impedance raised to the wetland floor)

These do not collide with real NLCD codes (all below 100). Run `python nz/lcdb_friction.py` to print the
table with the friction multiplier each row ends up with, for review.
"""
import os
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(HERE, 'lcdb_friction.toml')

CLASS_BASE = 100
WETLAND_BASE = 200
SEA_RAW = 255          # nodata in the national LCDB raster: no polygon here
WETLAND_BIT = 128      # raster value = class + 128 on wetland-flagged polygons


def load_table(path=TABLE_PATH):
    with open(path, 'rb') as f:
        raw = tomllib.load(f)
    classes = {int(k): v for k, v in raw['classes'].items()}
    meta = raw['meta']
    for cls, row in classes.items():
        if not 0 <= row['impedance'] <= 99:
            raise ValueError(f"LCDB class {cls}: impedance {row['impedance']} outside 0-99")
        if cls >= WETLAND_BIT:
            raise ValueError(f'LCDB class {cls} does not fit the raster encoding (must be < 128)')
    return meta, classes


def friction_for(impedance):
    """Mirror of app/pipeline/cost_surface.py, Sub-step E (impedance -> friction). Review tool only:
    the pipeline itself does this conversion; this copy is not used for analysis."""
    bins = [(1, 1.00), (5, 1.00), (10, 1.05), (15, 1.10), (20, 1.15), (25, 1.15), (30, 1.25),
            (35, 1.50), (45, 1.60), (55, 1.80), (85, 3.00)]
    if impedance > 85:
        return 50.0
    for upper, value in bins:
        if impedance <= upper:
            return value
    return 1.15


def register(nlcd_impedance, path=TABLE_PATH):
    """Add the LCDB codes to the pipeline's NLCD_IMPEDANCE dict (in place). Returns (meta, classes)."""
    meta, classes = load_table(path)
    floor = meta['wetland_floor_impedance']
    for cls, row in classes.items():
        nlcd_impedance[CLASS_BASE + cls] = row['impedance']
        nlcd_impedance[WETLAND_BASE + cls] = max(row['impedance'], floor)
    nlcd_impedance[CLASS_BASE] = meta['sea_impedance']      # class 0 and cells with no polygon
    nlcd_impedance[WETLAND_BASE] = meta['sea_impedance']
    return meta, classes


if __name__ == '__main__':
    meta, classes = load_table()
    print(f"LCDB v{meta['lcdb_version']} {meta['epoch']}   wetland floor impedance {meta['wetland_floor_impedance']} "
          f"(friction {friction_for(meta['wetland_floor_impedance']):.2f})   sea {meta['sea_impedance']}")
    print(f"{'class':>5}  {'impedance':>9}  {'friction':>8}  name")
    for cls in sorted(classes):
        r = classes[cls]
        print(f"{cls:>5}  {r['impedance']:>9}  {friction_for(r['impedance']):>8.2f}  {r['name']}")
