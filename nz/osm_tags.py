"""OSM tag sets used to classify line features. Same values as WiSAR tools/build_osm_cache.py.
Single source of truth for build_osm_lines.py (builder) and nz_sources.py (runtime)."""
TRAIL_TAGS = {'path', 'footway', 'track', 'bridleway', 'cycleway'}
ROAD_TAGS = {'residential', 'tertiary', 'secondary', 'primary', 'trunk',
             'motorway', 'unclassified', 'service'}
WATERWAY_TAGS = {'stream', 'river', 'canal', 'drain', 'ditch'}
# Differs from WiSAR (which also takes 'minor_line'): in NZ, minor_line is mostly pole-mounted distribution wiring
# along roads and through paddocks, with no cleared corridor. Only transmission lines (power=line) are burned in
# as ~40 m travel corridors.
POWER_TAGS = {'line'}
CATEGORIES = ('trails', 'roads', 'waterways', 'powerlines')
