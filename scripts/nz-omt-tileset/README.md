# nz-omt-tileset

Offline builder for the ATAK vector basemap: LINZ topographic tiles translated
from the Shortbread schema into OpenMapTiles, optionally merged with the
`nz-building-heights` archive so ATAK renders **extruded 3D buildings**.

Produces two basemap variants, **both of which now include a `building` layer**:

| Variant | Command | `building` layer |
|---|---|---|
| with 3D buildings | pass `--heights` | from `nz-building-heights`, carries `render_height` -> ATAK extrudes them |
| basemap only | omit `--heights` | from LINZ's own `buildings` layer, flat 2D outlines, no `render_height` -> ATAK draws them flat |

`build.sh` also accepts `--addresses`, which adds a `housenumber` layer from
LINZ address points. **It renders nothing under ATAK's bundled OMT style.**
ATAK's bundled `dark` style has no `housenumber` layer at all, and even in
`bright`/`overlay` it needs `minzoom: 18` — evaluated against camera zoom, not
tile zoom — which in practice never renders on device with the *bundled*
style. It still isn't passed by `build.sh`'s own examples or the CI workflow
by default, and still adds ~60MB uncompressed nationally, so keep it opt-in
unless you're deploying the custom style below alongside it.

**It does render with the custom style — confirmed on device.** [`omt-linz-style.json`](omt-linz-style.json)
(see "Custom style" further down) now includes a `housenumber` layer at
`minzoom: 16` — the tile zoom the layer is actually stored at, not the
bundled style's camera-zoom-18 gate. Uploaded via ATAK 5.8's "Set Layer
Style", this bypasses the bundled style's minzoom entirely. Confirmed
working: both the flat `building` outlines and `housenumber` labels render
correctly on device, tested against a Wellington CBD extract built with
`--addresses` and no `--heights`.

Background and the ATAK source references behind every constraint here are in
[`ATAK_3D_BUILDINGS.md`](../../docs/ATAK_3D_BUILDINGS.md).

## Why a translation is required

ATAK recognises only two vector tile schemas. `GLVectorTiles` holds
`styleSchemas = {"omt", "rbt"}`, and detection runs through
`Schema.OMT.matches(schema, true)`, which reduces to
`layerIntersect > 0 && layerMiss == 0`. Every Shortbread layer name
(`streets`, `land`, `water_lines`, ...) counts as a miss, so the match fails,
`autostyle` flips to true, no stylesheet loads, and with no stylesheet there are
no extrude attribute keys. You lose the styling *and* the 3D.

So every layer emitted must be one of OMT's 16 names, and the building polygons
must carry `render_height` — the only attribute ATAK extrudes from
(`MapBoxGLStyleSheet.cpp:215-216`).

## Prerequisites

```bash
sudo apt-get install -y tippecanoe    # provides tippecanoe + tile-join
npm install                           # in this directory
```

Node 22+ is required (the scripts use the built-in `node:sqlite`).

Inputs:

```bash
# LINZ topographic vector tiles, Shortbread schema, z0-15
# (replace 123456789012 with your AWS account ID; the region matches your base-infra stack)
aws s3 cp s3://tak-demo-baseinfra-us-west-2-123456789012-artifacts/linz-vector-tiles.mbtiles .

# building heights, PMTiles, z4-16 (only needed for the 3D variant)
#   public/nz-building-heights.pmtiles in the CloudTAK assets buckets
```

## Usage

```bash
# national, with 3D buildings  -> nz-omt-buildings.mbtiles
./build.sh --linz linz-vector-tiles.mbtiles \
           --heights ../../../CloudTAK/data/nz-building-heights.pmtiles

# national, basemap only       -> nz-omt.mbtiles
./build.sh --linz linz-vector-tiles.mbtiles

# quick Wellington CBD smoke test, 3D buildings (a few minutes)
./build.sh --linz linz-vector-tiles.mbtiles \
           --heights ../../../CloudTAK/data/nz-building-heights.pmtiles \
           --bbox 174.765,-41.295,174.790,-41.275 --minzoom 12 \
           --out wellington-omt.mbtiles

# quick Wellington CBD smoke test, basemap only (flat building outlines +
# housenumbers, for testing the custom style's housenumber layer)
./build.sh --linz linz-vector-tiles.mbtiles \
           --bbox 174.765,-41.295,174.790,-41.275 --minzoom 12 \
           --addresses \
           --out wellington-omt-basemap.mbtiles
```

Run `./build.sh --help` for all options.

## Expected output size

Measured, national, z0-16, uncompressed tiles:

| Variant | Size |
|---|---|
| with 3D buildings (`nz-omt-buildings.mbtiles`) | **2.3 GB** |
| basemap only (`nz-omt.mbtiles`) | **2.1 GB** |

Buildings are under 10% of the file; the basemap dominates. z16 is the largest
single slice (790 MB) even though it carries no new detail, being overzoomed from
LINZ's z15 maximum — it cannot be dropped because buildings only draw at z16.

`--addresses` adds **~61 MB uncompressed** nationally (measured: 2,590,884
address points, tiled at z16, max tile 141.8 KB, no density dropping needed).
Off by default — see "Housenumbers — invisible under the bundled style,
renders under the custom style" below for why.

The basemap-only variant's `building` layer (LINZ outlines, no `render_height`)
adds a modest amount too — see "Buildings without `--heights`" below.

## Coverage

By default **every tile in the LINZ archive** is processed. Do not add a bbox
unless you specifically want a subset. A lon/lat bbox cannot express a region
crossing the antimeridian, and this archive crosses it — its z15 tile columns run
89..32719 (lon -179.02 to 179.47), latitudes -8.53 to -52.62.

A hardcoded `166.0,-47.6,179.2,-34.0` silently dropped 4.1% of the archive: the
Chatham Islands (~17,600 z15 tiles), Auckland Islands, Snares, Campbell Island,
and the Realm territories (Niue, Tokelau, Cook Islands). Including all of it costs
**+0.7%** — those tiles average ~390 bytes versus 2.5 KB for mainland tiles,
because ocean is nearly free in vector tiles.

The building heights archive covers only lon 167.39..178.55, lat -46.91..-34.43,
so the Chathams get basemap but no 3D buildings. The builder reads that range from
the PMTiles header rather than guessing.

Allow ~30 GB of scratch space for the intermediate GeoJSON, and several hours
for a national run.

## What the pipeline does

1. **`translate.js`** streams every LINZ tile at the source zoom, maps Shortbread
   layers and `kind` values onto OMT layers and `class` values, and emits
   newline-delimited GeoJSON with a per-feature `tippecanoe.layer` member.
   `building` comes from one of two mutually exclusive passes: with
   `--heights`, it walks the PMTiles archive at z16 and emits `building`
   features carrying `render_height`/`render_min_height`; without `--heights`,
   it instead reads LINZ's own `buildings` layer once (at LINZ's own source
   maxzoom) and emits `building` features carrying only `name` (no height —
   flat outlines). With `--addresses` it also reads LINZ's `addresses` layer
   once and emits `housenumber` features carrying only `housenumber`.
2. **`build.sh`** splits base, building and (if requested) address features into
   separate tippecanoe passes, and joins the results with `tile-join`.
3. **`verify.js`** checks the result against what ATAK enforces: `format=pbf`,
   `layerMiss == 0`, `layerIntersect > 0`, `building.render_height` /
   `housenumber.housenumber` present when those layers exist, and reports tile
   sizes and compression state.

### Non-obvious details

**Buildings and housenumbers are each tiled separately, at z16 only** —
whichever of the two `building` sources is active (heights archive or LINZ's
own outlines) and `housenumber` alike. ATAK's bundled OMT style sets
`building` to `minzoom: 16` and `housenumber` to `minzoom: 18` — but those
minzooms are evaluated against the camera's current map zoom, not the tile
pyramid's zoom, the same way `building` at z16 already renders once the
camera passes z16 via the renderer's own overzoom scaling. So `housenumber`
features must live in the z16 tiles too, not in tiles literally named
z17/z18 — a literal z18 tile would carry no roads or water underneath and the
basemap would appear to vanish at that zoom, the same failure mode buildings
would have hit if tiled naively.

The obvious alternative for either layer — a per-feature `tippecanoe.minzoom` —
is a trap: it makes tippecanoe report large `dropped_by_rate` counts and discard
about 99% of the features (confirmed for buildings: 13,345 in, 90 surviving, in
testing). Hence the separate-pass-at-z16-only structure for both.

**`water` is synthesised.** LINZ ships the landmass as a `boundaries` polygon and
leaves the sea as empty space. OMT is the inverse: the style background is land
and `water` polygons draw on top. So the translator subtracts the landmass from
each tile's extent to produce the sea. Without this, Wellington Harbour renders
as grey land.

## Layer mapping

| LINZ / Shortbread | → OMT layer | Notes |
|---|---|---|
| `streets` | `transportation` | `kind`→`class`; bridge/tunnel→`brunnel`; already-valid OMT classes |
| `street_polygons` (roads) | `transportation` | non-aeroway `kind` values only; see aeroway row below |
| `street_polygons` (`kind=runway`/`taxiway`) | `aeroway` | runway/taxiway footprints — see "Aerodromes" below |
| `ferries` | `transportation` | forced to `class=ferry` |
| `street_labels` | `transportation_name` | needs `name` |
| `water_polygons` | `water` | `kind`→`class` |
| `water_lines` | `waterway` | river/stream/canal/ditch/drain only; `wharf_edge` has no OMT class |
| `land` | `landcover` or `landuse` | split on `kind`; forest/scrub→`wood` |
| `sites` | `park` | sports_field/park→`class=public_park` |
| `place_labels` (`place` set) | `place` | settlements/administrative areas; `label`→`name`, `place`→`class` |
| `place_labels` (`water` set) | `water_name` | bays/seas/inlets — see "place_labels is three layers" below |
| `place_labels` (`natural=peak`) | dropped | see below — no bundled style renders this layer at all |
| `pois` | `poi` | `building`/`amenity`/`historic`/`man_made`→`class` |
| `public_transport` (`kind=aerodrome`/`helipad`) | `poi` | `class=airfield`/`class=heliport` — see "Aerodromes" below |
| `boundaries` | consumed | subtracted from tile extent to derive `water` |
| `buildings` | `building` | **with `--heights`**: replaced entirely by the heights archive footprints, which carry `render_height`. **without `--heights`**: LINZ's own footprints are used instead, as flat outlines (no `render_height` — see "Buildings without `--heights`" below) |
| `addresses` | opt-in via `--addresses` | → `housenumber`; off by default — see "Housenumbers are opt-in" below |
| `contours` | dropped | **no OMT contour layer exists** — a real loss for TAK use, and unfixable via this route |
| `parcel_boundaries`, `pier_lines`, `aerialways`, `dam_lines` | dropped | no OMT equivalent (`aerialways` here means cable cars/ski tows, not airport aeroways) |

Only about 16% of source coordinates survive. Of what is dropped, `contours` is
roughly 48% and `parcel_boundaries` 25%.

### `place_labels` is really three unrelated layers

LINZ's Shortbread `place_labels` mixes settlements (`place=town/city/...`),
marine named features (`water=bay/sea/...`), and summits (`natural=peak`) in one
layer. An earlier version of this translator sent every row through
`class: p.place || 'suburb'`, which meant every bay and mountain-peak label in
the country was silently mislabelled as an OMT `place` with `class=suburb`. Fixed
now: `place` rows go to `place`, `water` rows go to `water_name` (which renders —
confirmed present in all three bundled style variants), and `natural=peak` rows
are dropped deliberately, not by omission: none of the bundled OMT style
variants (bright/dark/overlay) carry *any* paint rule for the `mountain_peak`
source-layer. It isn't hidden by a `visibility: none`; the layer is entirely
absent from the style's `layers` array. Populating OMT's `mountain_peak` layer
would be silently invisible on every variant, so there's nothing to route peaks
to without forking ATAK.

### Aerodromes

Confirmed against `-45.53292764868991, 167.65260115490457` (Manapouri
Aerodrome), which was missing before this fix. LINZ carries the runway geometry
under `street_polygons` (`kind=runway`/`taxiway`) and the named point under
`public_transport` (`kind=aerodrome`/`helipad`) — two layers this translator did
not previously read.

Runway/taxiway polygons go to OMT's `aeroway` layer, which every bundled style
variant renders as a filled area plus casing/centre lines from minzoom 4
(`aeroway-area`, `aeroway-runway`, `aeroway-taxiway`).

The named aerodrome/helipad point does **not** go to OMT's `aerodrome_label`
layer, even though that looks like the obvious destination. Every bundled style
variant filters `aerodrome_label` on `has iata`, and LINZ carries no IATA codes
— routing there would parse fine and render nothing. Instead it goes to `poi`
with `class=airfield` / `class=heliport`, which have real icons in the bundled
sprite sheet (`airfield_11/15`, `heliport_11/15`) and actually draw.

### Buildings without `--heights`: flat outlines from LINZ, not omitted

Earlier versions of this builder dropped the `building` layer entirely for
the basemap-only variant — LINZ's own `buildings` layer was in the "no OMT
equivalent" drop list, on the reasoning that it would be replaced by the
heights archive. That reasoning only holds when `--heights` is actually
given. Omitting `--heights` meant the basemap-only variant carried no
building outlines at all, even though LINZ's own `buildings` layer (polygons,
`building`/`kind`/`name`/`store_item`/`use` attributes, no height field) was
right there in the source and perfectly capable of drawing outlines.

Fixed: when `--heights` is omitted, `translate.js --only buildings` reads
LINZ's `buildings` layer once (same MAXZOOM-only pass structure as
`--heights`/`--addresses`, for the same reason — ATAK's bundled style hides
`building` below map zoom 16, evaluated against camera zoom not tile zoom) and
emits `building` features carrying only `name`. No `render_height` — LINZ's
layer has no height attribute — so `Schema.OMT.matches()` still passes
(`layerIntersect` only needs the layer name plus *any* shared field; `building`
requires none in particular), but ATAK draws these as **flat 2D fills**, not
extrusions. That is the intended and only possible outcome without a heights
source: `MapBoxGLStyleSheet.cpp:215-216` extrudes only from `render_height`.
**Confirmed on device**, against a Wellington CBD extract sideloaded as a
basemap: flat building outlines render correctly.

When `--heights` *is* given, this LINZ pass is skipped entirely and the
heights archive remains the sole source of `building` — the two are never
merged into one tileset.

### Housenumbers — invisible under the bundled style, renders under the custom style

`--addresses` embeds LINZ's `addresses` layer (2,590,884 points nationally) as
OMT's `housenumber` layer, carrying only the `housenumber` field. This was
built and included in production builds for a while, then removed after
device testing showed it renders nothing **under ATAK's bundled style**.

Reason: `housenumber` is `minzoom: 18` in both bundled `bright` and `overlay`
styles (`dark` has no `housenumber` layer at all), and that minzoom is
evaluated against the camera's current map zoom — closer to "read individual
letterboxes" than any navigation zoom a user actually reaches. Confirmed on
device: with `--addresses` included but no custom style applied, no
housenumbers were ever visible. It also isn't free — ~61 MB uncompressed
nationally (measured: 2,590,884 address points, tiled at z16, max tile
141.8 KB) for a layer that doesn't draw under the bundled style.

That constraint is baked into the APK's compiled stylesheets and cannot be
changed from the tileset side — but ATAK 5.8's "Set Layer Style" upload
bypasses the bundled stylesheet entirely for whichever layer it's applied to.
`omt-linz-style.json` now defines its own `housenumber` layer at `minzoom: 16`
(the tile zoom the layer is actually stored at), not the bundled style's
camera-zoom-18 gate. **Confirmed working on device**: build with
`--addresses`, then upload `omt-linz-style.json` via Set Layer Style — see
"Custom style" below for how to apply it.

The `--addresses` flag is still off by default in `build.sh`'s own examples
and `.github/workflows/update-linz-tiles.yml`/`offline-maps/user-data.sh`,
since it only pays off when the custom style is actually deployed alongside
it.

## Deploying the result

Two delivery paths, both documented in
[`ATAK_3D_BUILDINGS.md`](../../docs/ATAK_3D_BUILDINGS.md):

- **Sideload** — push the `.mbtiles` to `/sdcard/atak/imagery/` and select it as
  a **basemap** (not an overlay). Verified working on ATAK-CIV 5.5.1.10.
- **Serve** — put the file on the tileserver-gl EFS volume, add a `data` entry to
  `tileserver-gl/config.json`, and hand ATAK a `StreamingTiles` manifest.

## Custom style: LINZ colours instead of ATAK's bundled OMT palette

ATAK 5.8 (confirmed by the user; not present in the 5.5.1.10 source this repo
otherwise cites) added a per-layer "Set Layer Style" option under the
hamburger menu → Imagery, which accepts an uploaded Mapbox/MapLibre-format
`style.json` and applies it to that vector layer, overriding the bundled
`bright`/`dark`/`overlay` stylesheet.

[`omt-linz-style.json`](omt-linz-style.json) uses that mechanism to recreate
LINZ's own topographic palette (colours lifted from
`tileserver-gl/topographic-style.json`, LINZ's actual production raster
style) against the OMT schema this builder emits, rather than ATAK's default
beige/grey OMT look. Each layer's `filter` matches the exact `class`/`kind`
values `translate.js` writes for that OMT layer — see the "Layer mapping"
table above for the correspondence.

To use it: select the streamed or sideloaded vector layer in ATAK, open **Set
Layer Style**, and upload `omt-linz-style.json`.

**Known limitation, not fixed by this style document:** switching a layer to
ATAK's own offline/download-for-cache mode currently renders a blank map
regardless of which style is active — this is a gap in ATAK's own vector-tile
caching (`OSMDroidTileContainer`/`GeoPackageTileContainer` both explicitly
reject `content: "vector"` sources when creating an offline cache), not
something a style document can work around. Streamed-online and
sideloaded-`.mbtiles` both continue to work normally; only the
download-to-cache path for a *streamed* source is affected.

## Licensing

Both sources are CC BY 4.0 and attribution is required. Carry it in the manifest
`attribution` field, and in the MBTiles `attribution` metadata for sideloaded
copies:

- LINZ Basemaps topographic — CC BY 4.0, Land Information New Zealand
- Aotearoa NZ Building Heights, Atman Dhruva, derived from LINZ LiDAR — CC BY 4.0
