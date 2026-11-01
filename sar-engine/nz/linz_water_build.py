"""Build the engine's LINZ waterways FlatGeobuf from the LINZ Basemaps topographic vector tiles (MBTiles).

Why a second waterway source: OSM maps fewer streams than LINZ in the New Zealand backcountry. Measured on 30 m cells at
five backcountry sites, LINZ had 1.4 to 5 times as many stream cells at four of them (about the same at Tongariro), and
82 to 100 % of OSM's stream cells had a LINZ stream within one cell. The engine burns waterways into the cost surface
as friction, so a stream that is missing from the data is missing friction.

Input: the Shortbread-schema MBTiles that utils-infra stores as linz-vector-tiles.mbtiles (layers water_lines and
water_polygons, EPSG:3857 tiles read through GDAL's MVT driver). Output: one FlatGeobuf layer `waterways` in EPSG:4326
with the columns the engine already uses for OSM waterways, so the cost-surface code needs no new inputs:

    type  'stream' (burned at impedance 40) for every LINZ line, 'river' (impedance 60) for river polygons
    name  empty string (LINZ names are not used by the engine)
    geometry  LineString for lines, Polygon for river polygons

LINZ labels almost every watercourse `river` (926,949 of 931,487 line fragments at z12), so its line kind cannot
separate rivers from streams the way OSM's waterway tag does. Lines therefore all count as streams, and the rivers that
are wide enough to be mapped as areas come from the polygons.

Zoom 12 is enough: the stream network is already complete there. In six test areas the merged line length at z12 was 3 to
18 % above z15 (the lower zoom is less detailed, not missing streams), and z12 is 6,000 tiles instead of 519,000.
Reading all of NZ takes about 20 s and 1 GB.

Kept line kinds: river, stream, drain, water_race (a man-made channel). Left out: wharf, wharf_edge, boom, marine_farm
(not watercourses), waterfall (a drop on a line already present) and flume (an elevated channel).
Lakes and the sea are not taken from here: they come from land cover (LCDB), as before.
"""
import os

import geopandas as gpd
import pandas as pd
import pyogrio
import shapely
from pyproj import Transformer

ZOOM = 12
LAYER = 'waterways'
LINE_KINDS = {'river', 'stream', 'drain', 'water_race'}
POLYGON_KINDS = {'river'}
# Mainland NZ plus a margin (handler.NZ_BOUNDS is lat -48..-33.5, lng 165.5..179.5). The MBTiles also covers the
# wider Pacific, which the engine refuses to analyse.
BBOX_4326 = (165.0, -48.5, 179.9, -33.0)
# NZ has about 860,000 line fragments at z12. A file far below that means the tiles were not read properly.
MIN_LINES = 200_000


def _bbox_3857(bbox):
    t = Transformer.from_crs(4326, 3857, always_xy=True)
    west, south = t.transform(bbox[0], bbox[1])
    east, north = t.transform(bbox[2], bbox[3])
    return west, south, east, north


def _read(mbtiles_path, layer, zoom, bbox):
    # The MVT driver reports EPSG:3857 and filters by a bounding box in that CRS.
    return pyogrio.read_dataframe(mbtiles_path, layer=layer, bbox=_bbox_3857(bbox), ZOOM_LEVEL=str(zoom))


def _explode(frame, geometry_type):
    """One row per LineString / Polygon (the tiles hold Multi* geometries), dropping empty and other-typed parts."""
    frame = frame.explode(index_parts=False, ignore_index=True)
    return frame[frame.geom_type == geometry_type]


def _rows(frame, waterway_type):
    """Engine columns (name, type, geometry) for the rows of `frame`."""
    n = len(frame)
    return gpd.GeoDataFrame({'name': [''] * n, 'type': [waterway_type] * n}, geometry=list(frame.geometry), crs=frame.crs)


def classify_lines(frame):
    """LINZ water_lines rows -> engine waterway rows (type 'stream'). Pure function of the frame."""
    frame = frame[frame['kind'].isin(LINE_KINDS)]
    frame = _explode(frame, 'LineString')
    frame = frame[~frame.geometry.is_empty]
    return _rows(frame, 'stream')


def classify_polygons(frame):
    """LINZ water_polygons rows -> engine waterway rows (type 'river'). Invalid polygons are repaired first, because
    the cost surface buffers every geometry and buffering an invalid one can fail or drop it."""
    frame = frame[frame['kind'].isin(POLYGON_KINDS)]
    frame = frame.assign(geometry=shapely.make_valid(frame.geometry.values))
    frame = _explode(frame, 'Polygon')
    frame = frame[~frame.geometry.is_empty]
    return _rows(frame, 'river')


def combine(lines, polygons):
    """Merge, project to EPSG:4326 and drop exact duplicate geometries (tile overlap)."""
    frame = pd.concat([lines, polygons], ignore_index=True)
    frame = gpd.GeoDataFrame(frame, geometry='geometry', crs=lines.crs).to_crs('EPSG:4326')
    frame = frame[~frame.geometry.to_wkb().duplicated()]
    return frame.reset_index(drop=True)[['name', 'type', 'geometry']]


def metadata_geojson(source_name, feature_count, built_at, file=None):
    """The build-info sidecar: a one-point GeoJSON read through GDAL, so it works for local paths and /vsis3/ alike.
    Its presence is what switches the LINZ waterways on, and `file` (optional) names the FlatGeobuf to read."""
    props = {'built_at': built_at.strftime('%Y-%m-%dT%H:%M:%SZ'), 'source': source_name, 'features': feature_count}
    if file:
        props['file'] = file
    return {'type': 'FeatureCollection', 'features': [{
        'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [0, 0]}, 'properties': props}]}


def build_fgb(mbtiles_path, out_path, zoom=ZOOM, bbox=BBOX_4326):
    """Read the tiles, classify, and write the FlatGeobuf. Returns (line count, polygon count)."""
    mbtiles_path, out_path = os.path.abspath(mbtiles_path), os.path.abspath(out_path)
    lines = classify_lines(_read(mbtiles_path, 'water_lines', zoom, bbox))
    polygons = classify_polygons(_read(mbtiles_path, 'water_polygons', zoom, bbox))
    if len(lines) < MIN_LINES:
        raise RuntimeError(f'Only {len(lines)} LINZ stream lines read at z{zoom} (expected 800,000 or more); '
                           f'refusing to write a LINZ waterway file')
    frame = combine(lines, polygons)
    # Lines and polygons share one layer, so the geometry type has to be declared as mixed.
    pyogrio.write_dataframe(frame, out_path, driver='FlatGeobuf', layer=LAYER, SPATIAL_INDEX='YES',
                            geometry_type='Unknown')
    return int((frame.geom_type == 'LineString').sum()), int((frame.geom_type == 'Polygon').sum())
