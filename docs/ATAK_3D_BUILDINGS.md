# ATAK 3D Buildings — `buildings-proxy` Implementation Guide

Serve NZ building footprints with heights to ATAK as **extruded 3D buildings**, reusing the
`terrain-proxy` pattern in this repo.

The source data is the CC BY 4.0 "Aotearoa NZ Building Heights" PMTiles archive, already hosted by
CloudTAK. ATAK will not read PMTiles and will not read a MapLibre style document, but it *does* have a
live vector-tile renderer that performs terrain-aware polygon extrusion. Reaching it requires a small
proxy that presents the data in the one shape ATAK recognises.

> **Read Phase 0 before writing any code.** The whole design hangs on one unverified assumption. Phase 0
> is a half-day test that either validates it or kills the project before you build infrastructure.

---

## Phase 0 outcome — run on ATAK-CIV 5.5.1.10, device test

**The extrusion assumption is CONFIRMED.** A single-layer `building` MBTiles carrying `render_height`
placed in `atak/imagery/` renders as extruded 3D buildings in Auckland at z16+ when the camera is
pitched. Sections 3–7 rest on a sound foundation.

**A second, unanticipated blocker was found: extrusion and overlay placement are mutually exclusive in
stock ATAK.** The same tileset placed in `atak/grg/` appears in the overlay selector but draws no
buildings at all.

Cause, traced through source and consistent with both device observations. The `overlay` boolean passed
to the vector-tile renderer does exactly two things, and they are coupled:

| `overlay` | Stylesheet loaded (`jglvectortiles.cpp:48-62`) | `building` layer in that style | Background |
|---|---|---|---|
| `false` | `asset:/style/omt/bright/style.json` | `visibility: visible`, `minzoom: 16` | opaque `rgba(230,230,230,1)` cleared over the map (`GLVectorTiles.cpp:760`) |
| `true` | `asset:/style/omt/overlay/style.json` | **`visibility: none`** | not cleared |

`overlay/style.json` is a roads-and-labels style intended to be drawn over satellite imagery: all 20 of
its `fill` layers are hidden, including `background` and `building`. Only `line` (52) and `symbol` (25)
layers are visible. So overlay mode cannot draw an extruded polygon at all, and basemap mode paints an
opaque grey backdrop that occludes whatever is beneath.

There is no escape hatch. The stylesheets are compiled into the APK and cannot be overridden —
`jglvectortiles.cpp:48` declares an `overrideStyle` variable that is never used, and the only related
config option is `vector-tiles.dark-default`.

Further findings that shape Sections 4–7:

- **An MBTiles can never be an overlay.** `MBTilesInfo.get()` parses only `name`, `format` and `json`
  from the metadata table; the MBTiles `type=overlay` row is ignored. This is the unimplemented
  `// XXX - check if marked as overlay` comment in `ImportLayersSort.match()`.
- **The manifest's `"overlay": true` does not reach the renderer.** It is written to the descriptor as
  `extras.put("overlay", "1")` (`StreamingContentDatasetDescriptorSpi.java:105`) and **nothing reads it**.
  `GLVectorTiles.SPI` reads `getLocalData("overlay")` (`:84-85`), which is populated from a *layer*
  attribute (`GLAbstractDataStoreRasterLayer3.java:63-68,149`), and that attribute is set in exactly one
  place in the whole codebase: `GRGMapComponent.java:108`, for the GRG raster layer. The manifest field
  only influences resolver selection during import, not rendering.
- Consequence: §4's `"overlay": true` will not produce an overlay. Whichever data store hosts the
  dataset decides — GRG store means overlay style and invisible buildings, imagery store means basemap
  with a grey backdrop. *(This last step is inference from the call graph, not yet device-tested.)*

**Implication for the project.** Buildings can only be delivered *as a basemap*. That was initially read
as a defeat, because a tileset containing only `building` renders as beige blocks on the opaque grey
stylesheet background. **Phase 0.5 resolved it** — see below. If you ever need buildings drawn over
*imagery* specifically, that remains impossible by this route and the plugin fallback at the end of §2 is
the only option.

---

## Phase 0.5 outcome — merged OMT basemap, confirmed working on device

**Since basemap mode is the only mode available, make the basemap worth having.** Instead of shipping a
tileset containing only `building`, merge the LINZ topographic vector basemap into the *same* tileset.
Basemap mode then stops being a compromise and becomes the goal: roads, water, landuse and labels from
LINZ, with extruded buildings on top, all from one vector tileset in the render path already proven in
Phase 0.

This was built and **confirmed working on device**. It supersedes the `buildings-proxy` design in §§3–6;
read §12 and §13 instead.

Two things had to be solved.

**LINZ uses the Shortbread schema, which ATAK does not recognise.** `GLVectorTiles` holds
`styleSchemas = {"omt", "rbt"}` (`:68-69`). Every Shortbread layer name (`streets`, `land`,
`water_lines`, `contours`, `parcel_boundaries`, ...) counts as a miss, so `Schema.OMT.matches()` returns
false, `autostyle` flips true, no stylesheet loads, and with no stylesheet there are no extrude keys —
losing the styling *and* the 3D. A **schema translation** is therefore required, not merely a merge. The
vocabularies align closely, since both descend from OSM tagging: Shortbread's `kind` values are largely
already valid OMT `class` values.

**LINZ ships the landmass, not the sea.** Its `boundaries` layer is a landmass polygon and the sea is
empty space. OMT is the inverse — the style background *is* land and `water` polygons draw over it. So
the sea has to be synthesised by subtracting the landmass from each tile's extent. Without this,
Wellington Harbour renders as grey land.

Result for a Wellington CBD test area, 1.4 MB, all ten layers OMT-conformant, `layerMiss = 0`,
`layerIntersect = 10`:

| OMT layer | Zooms | From |
|---|---|---|
| `building` | 16 only | nz-building-heights, `render_height` |
| `transportation` | 12-16 | LINZ `streets`, `kind`→`class`, bridge/tunnel→`brunnel` |
| `transportation_name` | 12-16 | LINZ `street_labels` |
| `water` | 12-16 | derived: tile extent minus LINZ landmass |
| `waterway` | 12-16 | LINZ `water_lines`, rivers only |
| `landcover` / `landuse` | 12-16 | LINZ `land`, split on `kind` |
| `place` / `poi` / `park` | 12-16 | LINZ `place_labels` / `pois` / `sites` |

Georeferencing was validated independently of the render: the tallest building came out at 106 m at
-41.28818, 174.77435, which is the Majestic Centre, with the rest of the >75 m cluster along Lambton Quay
and Willis St.

The builder is `scripts/nz-omt-tileset/`, which produces both a 3D-buildings variant and a basemap-only
variant. See that directory's README for the full layer mapping and two tippecanoe traps worth knowing
about.

**What is still lost:** `contours`. OMT has no contour layer, so ATAK cannot style one even if the tiles
carried it. For topographic TAK use that is a genuine gap with no fix on this route.

---

## 1. How ATAK renders 3D buildings

Everything in this section was established by reading ATAK-CIV 5.5.1.10 source
(`/home/ubuntu/GitHub/TAK-NZ/TPC_atak-civ`). File:line references are given so you can re-verify.

The render chain:

```
GLVectorTiles.java              registered globally at map/layer/Layers.java:85
  ↓
jglvectortiles.cpp:44-80        loads a stylesheet from the APK assets:
                                asset:/style/omt/{overlay|dark|bright}/style.json
  ↓
MapBoxGLStyleSheet.cpp:215-216  sets the extrude attribute keys (see below)
  ↓
VectorTile.cpp:182-183          ogrOpts.extrudeHeightField     = stylesheet->getExtrudeHeightKey()
                                ogrOpts.extrudeBaseHeightField = stylesheet->getExtrudeBaseHeightKey()
  ↓
Feature.java:117-118            per-feature  AltitudeMode altitudeMode  +  double extrude
  ↓
GLBatchPolygon / GLBatchLineString   walls, triangulated roof, holes, per-vertex terrain sampling
```

The final stage is the reason this approach is worth the effort:
`GLBatchLineString.extrudeGeometry()` samples `view.getTerrainMeshElevation(lat, lng)` for **every
vertex** and re-extrudes when the terrain version changes, and `GLPolyline` draws the footprint ring
clamped-to-ground so it is not clipped by terrain. Building heights therefore end up correct relative to
whatever DTED the device actually holds. (The Cesium 3D Tiles route, which ATAK also supports, cannot do
this — `Cesium3DTilesModelInfoSpi.java:141` hardcodes `altitudeMode = Absolute`, so a tileset never
reconciles with device terrain. That is why we are not using 3D Tiles.)

### Two hardcoded constraints

**Constraint 1 — the attribute names are fixed.** `MapBoxGLStyleSheet.cpp:215-216`, `// XXX -` comment
and all:

```cpp
ss->setExtrudeHeightKey("render_height");
ss->setExtrudeBaseHeightKey("render_min_height");
```

These are the OpenMapTiles conventions. They are not read from the style JSON. The source archive's
attributes (`height_m`, `height_max_m`, `roof_p90`, `ground_m`) will be silently ignored.

**Constraint 2 — the tileset must be detected as OpenMapTiles.** In `GLVectorTiles.java`, `autostyle`
is set to `!Objects.equals(style, "omt")`. When `autostyle` is true no stylesheet is loaded, and with no
stylesheet there are no extrude keys — you get flat 2D fills. Detection is
`Schema.OMT.matches(yourSchema, true)` (`Schema.java:210-227`), which reduces to:

```
return layerIntersect > 0 && layerMiss == 0;
```

iterating over **your** layers, where a layer is a "miss" if its name is not one of OMT's 17 known
layer names, and an "intersect" if it shares at least one field name with OMT's expected field set for
that layer.

This is permissive in our favour. A tileset containing exactly one layer named `building` carrying a
`render_height` field gives `layerMiss = 0` and `layerIntersect = 1`, so it matches. OMT's expected
`building` fields are `render_height`, `render_min_height`, `hide_3d`, `colour` (`Schema.java:103`) —
the presence of `hide_3d` confirms this is a deliberately 3D-aware schema.

**Net requirement:** the tiles ATAK receives must contain a layer named `building` whose polygons carry
`render_height` (metres, absolute building height) and optionally `render_min_height` (metres, base
offset for overhangs — use `0`).

### Consequence: styling is not ours

Colour, opacity and zoom cutoffs come from the OMT style compiled into ATAK's APK. There are **no**
`fill-extrusion` layers in the bundled styles — extrusion is driven entirely by the two attribute keys
above, applied at feature-parse time.

Three style variants ship in the APK, and which one loads is decided by the `overlay` flag, not by us:

| Variant | `building` layer | Notes |
|---|---|---|
| `bright` | `type: fill`, `minzoom: 16`, `visibility: visible`, beige (`#f2eae2`→`#dfdbd7`) | loaded when `overlay == false` |
| `dark` | `minzoom: 12`, visible | only when `vector-tiles.dark-default` is set, and still only if `overlay == false` |
| `overlay` | **`visibility: none`** | loaded whenever `overlay == true`; every `fill` layer is hidden |

`building-top` is `visibility: none` in `bright` and `overlay` alike.

So expect: extruded buildings in ATAK's beige, appearing at z16 and above, **and only in basemap mode**.
We cannot change that without forking ATAK. Do not promise stakeholders the blue height-ramp from the
CloudTAK web map. See the Phase 0 outcome block at the top of this document — the overlay variant hiding
`building` is what makes overlay placement impossible via this route.

---

## 2. Phase 0 — de-risk first (do this before anything else)

**Claim to test:** a vector tileset presenting a `building` layer with `render_height` causes ATAK to
draw extruded 3D buildings.

This was traced through source but **never executed** — ATAK cannot be built or run in the analysis
environment. If it is wrong, Sections 3–7 are wasted work.

Cheapest possible test, no infrastructure:

1. Take a small extract — one city block of Auckland CBD is plenty.
2. Produce an MBTiles with a single layer named `building`, polygons carrying `render_height`
   (integer/float metres) and `render_min_height` (0):
   ```
   tippecanoe -o buildings-test.mbtiles -Z14 -z16 -l building --no-tile-compression block.geojson
   ```
3. Ensure the MBTiles `metadata` table has `format=pbf` and a `json` value whose `vector_layers`
   contains `{"id":"building","fields":{"render_height":"Number","render_min_height":"Number"}}`.
   `MBTilesContainer.java:271` infers `content=vector` from this; `GLVectorTiles.getSchema()` reads
   `vector_layers` out of the `json` metadata row.
4. Copy to **`/sdcard/atak/imagery/`** (`adb push buildings-test.mbtiles /sdcard/atak/imagery/`), restart
   ATAK, then select it as a **basemap** — not an overlay. Two traps here, both established during the
   Phase 0 run:
   - Copy the file manually. Do **not** drop it in `atakdata/` or use Import Manager: `.mbtiles` is
     registered to two resolvers with different destinations and `ImportFilesTask.sort()` breaks on the
     first match, so `ImportMVTResolver` (`ImportFilesTask.java:423` → `atak/overlays/`) can claim it
     ahead of `ImportLayersResolver` (`:469` → `atak/imagery/`) and route it into the static-feature
     path, which never reaches the extrusion renderer.
   - It will only ever appear as a basemap. `atak/imagery/` is correct; `atak/grg/` yields an overlay
     entry that draws nothing. See the outcome block at the top for why.
5. Tilt the camera. **`fill-extrusion`-style geometry only reads as 3D when the camera is pitched** — at
   nadir you will see flat footprints and wrongly conclude failure. Note also
   `GLBatchLineString.isExtruded()` returns false when nadir-clamp is enabled.

**Pass:** buildings have visible walls and roofs at z16+ when tilted. Proceed.
**Fail:** stop and report. Fallback is a custom ATAK plugin that inserts `Polygon` features with
`altitudeMode = ClampToGround` and `extrude = height` directly — same extrusion engine, full control over
styling and zoom, but it is a plugin to write and maintain.

Record the outcome at the top of this document before continuing.

---

## 3. Architecture

> **Superseded by §11.** Sections 3–6 describe a dedicated `buildings-proxy` that rewrites MVT at
> runtime. Phase 0.5 removed the need for it: the Shortbread→OMT translation is now a build step
> (`scripts/nz-omt-tileset/`) and the result is served by the existing `tileserver-gl`. Kept for the
> reasoning, which still explains *why* the attribute rewrite is needed at all.

```
                    ┌──────────────────────────────────────────────┐
   ATAK device      │ 1. GET /buildings/bld-taknz-manifest.json    │
                    │      ?api=<key>                              │
                    │    → StreamingTiles sidecar, {BASE_URL} and  │
                    │      {API_KEY} substituted per request       │
                    │                                              │
                    │ 2. GET /buildings/{z}/{x}/{y}.mvt?api=<key>  │
                    │    → OMT-conformant MVT                      │
                    └───────────────────┬──────────────────────────┘
                                        │
                          buildings-proxy (ECS Fargate)
                                        │
                    ┌───────────────────┴──────────────────────────┐
                    │ NodeCache lookup (stdTTL 0 — data is static) │
                    │ on miss: fetch upstream tile                 │
                    │          decode MVT                          │
                    │          rename layer  → "building"          │
                    │          rename height → "render_height"     │
                    │          re-encode, cache, serve             │
                    └───────────────────┬──────────────────────────┘
                                        │
                    upstream: CloudTAK PMTiles service, or the
                    PMTiles archive read directly from S3
```

### Why rewrite in the proxy rather than re-tile

The obvious alternative is to re-run tippecanoe with the attributes renamed and publish a second
archive. Rewriting in the proxy is better here:

- **One source of truth.** The PMTiles archive stays byte-identical to what CloudTAK already serves, and
  the CloudTAK web map keeps the real field names (`height_m`, `roof_p90`, `flagged`) for its
  `fill-extrusion` styling. No divergence, no re-sync when the upstream archive is refreshed (the
  filename is timestamped — `buildings-20260810T1048` — so refreshes are expected).
- **No lossy round-trip.** Re-tiling from the finished PMTiles means `tippecanoe-decode` →
  GeoJSONSeq → re-tile of 3.17 M polygons, which re-quantises geometry that has already been simplified
  once.
- Cost is a decode/encode per **uncached** tile only, and tiles are permanently cacheable.

If the rewrite turns out too slow, the fallback is a one-off offline re-tile — but start with the proxy.

---

## 4. Deliverable 1 — the manifest

ATAK parses this with `takkernel/.../map/formats/cdn/StreamingTiles.java`. It is the same class that
already consumes `terrain-proxy/t3-taknz.json`; `content` is just a field on it (`"terrain"`,
`"imagery"`, or `"vector"`).

Create `buildings-proxy/bld-taknz.json`:

```json
{
  "schema": "4.0.0",
  "title": "NZ Building Heights 3D",
  "content": "vector",
  "mimeType": "application/vnd.mapbox-vector-tile",
  "downloadable": true,
  "overlay": false,
  "refreshInterval": 0,
  "isQuadtree": true,
  "numLevels": 17,
  "srs": "EPSG:3857",
  "url": "{BASE_URL}/buildings/{$z}/{$x}/{$y}.mvt?api={API_KEY}",
  "bounds": {
    "minX": 167.3899549,
    "minY": -46.908979,
    "maxX": 178.548196,
    "maxY": -34.426026
  },
  "attribution": "Building heights © Atman Dhruva, CC BY 4.0. Derived from LINZ LiDAR, CC BY 4.0.",
  "metadata": {
    "json": "{\"vector_layers\":[{\"id\":\"building\",\"fields\":{\"render_height\":\"Number\",\"render_min_height\":\"Number\"}}]}",
    "dataSource": "Aotearoa NZ Building Heights",
    "coverage": "New Zealand"
  }
}
```

Field notes, each tied to parser behaviour:

| Field | Why this value |
|---|---|
| `schema` `"4.0.0"` | Must be `MAJOR.MINOR.PATCH` for any major > 1 (`StreamingTiles.java` rejects otherwise), and major ≤ 5. Major ≥ 4 enables the **implicit tile grid**: given `isQuadtree`, `numLevels` and a recognised `srs`, ATAK builds the grid from `TileGrid.WebMercator` itself, so there are no hand-written resolutions to get wrong. Prefer this over the explicit `tileMatrix` array that `t3-taknz.json` uses. Major ≥ 3 also makes `StreamingContentDatasetDescriptorSpi` validate that the client can actually be constructed, which surfaces errors early. |
| `content` `"vector"` | Gates `GLVectorTiles.isCompatible()`. `StreamingTileClient.java:340-346,366-371` merges this into the metadata map that check reads. |
| `srs` `"EPSG:3857"` | Web mercator. `TileGrid.WebMercator` (`TileGrid.java:36-45`) has origin `(-20037508.34279, 20037508.34279)`, level-0 resolution `OSMUtils.mapnikTileResolution(0)`, 256 px tiles. **This differs from `t3-taknz.json`, which is `EPSG:4326`** — do not copy that value across. |
| `numLevels` `17` | Levels 0–16 inclusive; the archive's maxzoom is 16. |
| `url` | `{$z}/{$x}/{$y}` is ATAK's template notation (note the `$`), matching `t3-taknz.json`. `{BASE_URL}` and `{API_KEY}` are substituted by the proxy per request. |
| *(no `invertYAxis`)* | Default `false` = standard XYZ with row 0 at the top, which is what the archive uses (verified by computing tile indices for known Auckland coordinates). Setting it forces schema 5. |
| `metadata.json` | A **string** containing JSON — `StreamingTiles` reads `metadata` as `Map<String,String>`. `GLVectorTiles.getSchema()` parses this string and pulls `vector_layers` to build the schema that `Schema.OMT.matches()` tests. Getting this wrong is the most likely cause of "renders flat" — see §8. |
| `overlay` | ~~`true`~~ — **do not set this to `true`.** Phase 0 established that this field never reaches the renderer (`StreamingContentDatasetDescriptorSpi.java:105` writes it, nothing reads it), and that anything which *does* put the renderer in overlay mode loads `asset:/style/omt/overlay/style.json`, where the `building` layer is `visibility: none`. Set `false` and accept basemap placement, or take the plugin route. See the Phase 0 outcome block. |

---

## 5. Deliverable 2 — the `buildings-proxy` service

Model on `terrain-proxy/`: `Dockerfile`, `package.json`, `server.js`, plus the manifest template.

### Routes

```
GET /buildings/bld-taknz-manifest.json?api=<key>   → manifest, {BASE_URL}/{API_KEY} substituted
GET /buildings/health                              → status + cache stats
GET /buildings/{z}/{x}/{y}.mvt?api=<key>           → OMT-conformant vector tile
```

### Manifest endpoint

Copy `terrain-proxy/server.js:283-297` essentially verbatim — it is already the right shape:

```js
app.get('/buildings/bld-taknz-manifest.json', (req, res) => {
  const apiKey = req.query.api;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required', message: 'Use ?api=your-key' });
  }
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${protocol}://${req.get('host')}`;
  const manifest = manifestTemplate
    .replace('{BASE_URL}', baseUrl)
    .replace('{API_KEY}', apiKey);
  res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
  res.send(manifest);
});
```

Minting the credential into the URL at fetch time — rather than storing a URL with a token baked into
it — is the important property. See `CloudTAK/UPSTREAM-BUG-REPORT-BASEMAP-TOKEN.md` for the upstream bug
that the stored-token approach caused; this pattern structurally avoids it, and avoids expiry.

### Tile endpoint and the MVT rewrite

New dependencies (none are currently in `terrain-proxy/package.json`):

```
@mapbox/vector-tile   decode
pbf                   protobuf plumbing
vt-pbf                re-encode
pmtiles               only if reading the archive directly from S3
```

Rewrite sketch — treat as pseudocode, not tested:

```js
const { VectorTile } = require('@mapbox/vector-tile');
const Pbf = require('pbf');
const vtpbf = require('vt-pbf');

const SOURCE_LAYER = 'buildings';   // layer name inside the source archive
const TARGET_LAYER = 'building';    // name ATAK's OMT schema requires

function toOmt(buf, z, x, y) {
  const tile = new VectorTile(new Pbf(buf));
  const src = tile.layers[SOURCE_LAYER];
  if (!src) return null;

  const features = [];
  for (let i = 0; i < src.length; i++) {
    const f = src.feature(i).toGeoJSON(x, y, z);
    const p = f.properties || {};
    // height_m is the primary; fall back through the archive's other height fields
    const h = p.height_m ?? p.height_max_m ?? p.roof_p90;
    if (h == null) continue;                 // no height → nothing to extrude
    // if (p.flagged === 1) continue;        // optional: drop flagged geometry
    f.properties = {
      render_height: Math.round(Number(h) * 10) / 10,
      render_min_height: 0
    };
    features.push(f);
  }
  if (!features.length) return null;

  return vtpbf.fromGeojsonVt(
    { [TARGET_LAYER]: { features } },
    { version: 2, extent: 4096 }
  );
}
```

Points to get right:

- **Only emit `render_height` / `render_min_height`.** Every extra attribute is a field ATAK's schema
  matcher will see. Keeping the property bag minimal keeps `layerIntersect > 0, layerMiss = 0` true.
- **Exactly one layer, named `building`.** Any second layer whose name is not one of OMT's 17 makes
  `layerMiss > 0` and the whole tileset stops matching — extrusion silently switches off.
- **Source layer name is `buildings`** (plural), confirmed from the archive's own TileJSON
  (`vector_layers: ["buildings"]`). The target must be `building` (singular) to match OMT.
- **`toGeoJSON` → `fromGeojsonVt` is a re-projection round-trip.** Verify geometry lands in the right
  place at several zooms. If precision is a problem, rewrite the protobuf keys/values in place instead of
  going via GeoJSON — more code, no requantisation.
- **Tile compression.** Source PMTiles tiles are gzipped MVT. Decompress before decode; decide
  deliberately whether to serve gzipped (and set `Content-Encoding`) or plain.
- **Cache after rewrite, not before** — the expensive step is the transform, and `NodeCache` with
  `stdTTL: 0` is already the terrain-proxy pattern for static data. Sizes to expect (measured on the
  source archive): z12 ≈ 936 KB, z13 ≈ 841 KB, z14 ≈ 131 KB, z15 ≈ 35 KB, z16 ≈ 10.5 KB. Note the
  inversion — low zooms are the heavy ones. Set `maxKeys` with that in mind; `terrain-proxy` uses
  50 000, which would be far too much memory here.
- **Bounds rejection.** Reject out-of-NZ and out-of-range z/x/y early, as
  `terrain-proxy/server.js:315-330` does, so cache and upstream aren't polluted by scans.

### Upstream options

1. **Proxy the CloudTAK PMTiles service.** `https://tiles.map.<domain>/tiles/public/nz-building-heights/tiles/{z}/{x}/{y}.mvt?token=<jwt>`.
   Simple, but couples this service to CloudTAK availability and needs a CloudTAK token minted and
   rotated server-side.
2. **Read the PMTiles from S3 directly** with the `pmtiles` npm package over ranged GETs. The archive is
   at `public/nz-building-heights.pmtiles` in the CloudTAK assets buckets
   (`tak-demo-cloudtak-ap-southeast-2-123456789012-assets` for Demo/SYD, where `123456789012`
   is your AWS account ID). No cross-service dependency and
   no token. `terrain-proxy` already carries `@aws-sdk/client-s3` and an S3 config-load pattern
   (`server.js:31-47`), so the plumbing is familiar; you would need a task-role grant for the CloudTAK
   bucket, which is in a **different AWS account** — that is the main wrinkle. Either add a bucket policy
   granting the utils task role read access, or copy the archive into this stack's artifacts bucket
   (already granted at `lib/utils-infra-stack.ts:246-257`).

**Recommendation: option 2 via a copy into the artifacts bucket.** It removes the cross-account grant and
the CloudTAK runtime dependency, and the archive is a static 1.14 GB object refreshed rarely. Mirror the
existing `update-linz-tiles.yml` workflow for the refresh.

---

## 6. Deliverable 3 — CDK and CI wiring

Follow `terrain-proxy` exactly; it is the closest analogue (own hostname + CloudFront + API-key auth).

1. **`cdk.json`** — add to `context.<env>.containers` for both `dev-test` and `prod`:
   ```json
   "buildings-proxy": {
     "enabled": true,
     "hostname": "buildings",
     "healthCheckPath": "/buildings/health",
     "port": 3000,
     "cpu": 512,
     "memory": 1024,
     "priority": 7,
     "imageTag": "v1.0.0"
   }
   ```
   Pick a `priority` not already taken (terrain-proxy is 5). Consider more memory than terrain-proxy
   given the low-zoom tile sizes above.

2. **`lib/utils-infra-stack.ts`** — add a `containerName === 'buildings-proxy'` branch alongside the
   existing ones at **line ~326** for env vars (`CONFIG_BUCKET`, `CONFIG_KEY`
   `Utils-Buildings-Proxy-Config.json`, `S3_BUCKET` if reading the archive from artifacts), and a second
   branch at **line ~412** if it needs its own CloudFront distribution, mirroring the terrain block at
   lines 412-450.

3. **CloudFront + API-key auth.** `lib/constructs/terrain-cloudfront.ts` is the template, including the
   CloudFront Function that validates `?api=` and exempts the health path (line ~83). The ALB construct
   supports both host-header (`lib/constructs/alb.ts:209`) and path-pattern
   (`lib/constructs/alb.ts:190`) rules; `api-auth.ts:31-35` adds host-header auth rules.

4. **Workflows.** Add `buildings-proxy/**` to the `paths:` triggers in `demo-build.yml` (line ~11 has
   `terrain-proxy/**`) and `production-build.yml`. Image build and deploy need no further change — both
   workflows enumerate enabled containers straight out of `cdk.json`:
   ```bash
   CONTAINERS=$(jq -r '.context["dev-test"].containers | to_entries[] | select(.value.enabled == true) | .key' cdk.json)
   ```

5. **`Dockerfile`** — copy `terrain-proxy/Dockerfile` and change only the `HEALTHCHECK` path to
   `/buildings/health`. `node:24-alpine`, `npm ci --omit=dev`, non-root `nodejs:1001`, `EXPOSE 3000`.
   Note `terrain-proxy` needs `sharp`; this service does not, so the image should be smaller.

6. **README.md** — add a `### buildings-proxy` section matching the existing service entries (path,
   health check, parameters, docs link), and a `docs/BUILDINGS_PROXY.md`.

---

## 7. Deliverable 4 — getting the manifest onto devices

`ATAK_IMPORT_PLUGIN.md` in this repo already specifies a plugin with `GrgXmlImportResolver` and
`TerrainJsonImportResolver`. This needs a **third** resolver, because vector manifests are consumed by a
different subsystem than terrain manifests:

| Manifest | `content` | Consumed by | Destination on device |
|---|---|---|---|
| `t3-*.json` | `terrain` | `TiledElevationSources.java:92` | root `atak/` |
| `bld-*.json` | `vector` | `StreamingContentDatasetDescriptorSpi` (imagery scanner) | `imagery/mobile/mapsources/` |

`StreamingContentDatasetDescriptorSpi.probe()` accepts only `imagery` and `vector`; terrain never reaches
it. So a `BuildingsJsonImportResolver` must match `bld-*.json` containing `"content": "vector"` and route
to `imagery/mobile/mapsources/`, following the naming convention already established in
`ATAK_IMPORT_PLUGIN.md` (filename prefix disambiguates intent, enforced by the packaging scripts).

**This is the easiest thing to get wrong.** Reusing the terrain resolver's destination puts the file in
root `atak/`, where nothing will ever look at it, and the failure is completely silent.

Until the plugin ships, sideload the manifest to `imagery/mobile/mapsources/` manually for testing.

---

## 8. Verification checklist

Work top to bottom; each step isolates a different failure.

1. `GET /buildings/health` → 200.
2. `GET /buildings/bld-taknz-manifest.json?api=<key>` → valid JSON; `url` contains the real host and key
   with **no leftover `{BASE_URL}`/`{API_KEY}`** placeholders and exactly one `?`.
3. `GET /buildings/14/16146/10257.mvt?api=<key>` → 200, `application/vnd.mapbox-vector-tile`. Decode it
   and assert: exactly one layer, named `building`; features carry `render_height` and
   `render_min_height`; **no other properties**.
4. Geometry check: decode a z16 tile over central Auckland and confirm footprints land on the right
   buildings, not offset or scaled — this catches `toGeoJSON`/`fromGeojsonVt` round-trip errors.
5. Second-request latency on the same tile should collapse to cache-hit speed.
6. On device: manifest in `imagery/mobile/mapsources/`, layer appears in Layers/Overlay Manager.
7. **Tilt the camera at z16+.** Buildings should have walls and roofs. Flat fills = the schema match
   failed; go to step 8.
8. If flat: the `metadata.json` string in the manifest is the first suspect. It must parse, and its
   `vector_layers[].fields` must include `render_height` so that `Schema.OMT.matches()` returns true and
   `autostyle` becomes false. Confirm no extra non-OMT layer names have crept into the tiles.

---

## 9. Source data reference

| Property | Value |
|---|---|
| Source | "Aotearoa NZ Building Heights", Atman Dhruva — derived from LINZ LiDAR |
| Licence | CC BY 4.0 (attribution is **required** — carry it in the manifest `attribution` field) |
| Archive | `nz-building-heights.pmtiles`, 1,143,287,793 bytes, PMTiles spec v3 |
| Location | `public/nz-building-heights.pmtiles` in the CloudTAK assets buckets (us-west-2 + ap-southeast-2) |
| Tile format | MVT, gzipped |
| Zoom | 4–16 |
| Bounds | `167.3899549,-46.908979 → 178.548196,-34.426026` |
| Content | 347,418 tiles, 3,172,034 polygons |
| Layer name | `buildings` (plural) — verified via the archive's TileJSON `vector_layers` |
| Attributes | `height_m`, `height_max_m`, `roof_p90`, `ground_m`, `flagged`, `peak_unverified`, `lidar_year` |
| Tiling | `tippecanoe -Z4 -z16 --drop-densest-as-needed -M 1500000 -l buildings` |
| Filename note | Upstream is timestamped (`buildings-20260810T1048.pmtiles`) — expect periodic refreshes |

---

## 10. Risks and open questions

- ~~**Unverified core assumption.**~~ **RESOLVED — extrusion confirmed on device.** See the Phase 0
  outcome block at the top.
- **Basemap only.** The blocker that replaced it: extrusion works solely in basemap mode, because the
  `overlay` style variant hides every `fill` layer including `building`. Buildings drawn over imagery is
  not achievable through the vector-tile route at all. Resolve this before building `buildings-proxy` —
  if overlay placement is required, go straight to the plugin fallback in §2.
- **Opaque grey backdrop.** Basemap mode clears the surface to the stylesheet background,
  `rgba(230,230,230,1)` (`GLVectorTiles.cpp:758-765`). Because our tileset has only a `building` layer,
  every other layer in the OMT style has no data to draw, so the result is buildings on flat grey — no
  roads, water or imagery.
- **Zoom 16 floor.** ATAK's bundled OMT style sets `building` to `minzoom: 16`, so buildings only appear
  when quite far in. Not adjustable without forking ATAK. Confirm this is acceptable operationally
  before building.
- **Appearance is fixed** to ATAK's beige OMT fill. Do not promise the CloudTAK web styling.
- **Deprecation watch.** `GLExtrude` is marked `@DeprecatedApi(forRemoval = true, removeAt = "5.6")`.
  The `Feature.extrude` API and `GLBatchPolygon` extrusion are *not* deprecated, but re-test on the next
  ATAK major.
- **Cross-account S3** if reading the archive directly from CloudTAK's bucket (your CloudTAK
  account for Demo/SYD) — the recommendation in §5 is to copy into this stack's artifacts bucket instead.
- **Memory sizing.** Low-zoom tiles are ~900 KB each; do not copy `terrain-proxy`'s `maxKeys: 50000`.
- **Refresh workflow** for a new upstream archive vintage is not designed yet; mirror
  `update-linz-tiles.yml`.

---

## 11. Revised architecture — serve the merged tileset from `tileserver-gl`

**This supersedes §§3–6.** Do not build `buildings-proxy`. Serve the merged tileset from the existing
`tileserver-gl` container instead. The runtime rewrite in §5 is unnecessary: once the Shortbread→OMT
translation is a build step (§ `scripts/nz-omt-tileset/`), what reaches the device is already
OMT-conformant, so serving it is a byte passthrough.

### Why `tileserver-gl` is the right home

The decisive point is that it is already sitting on this data. `tileserver-gl/topographic-style.json`
declares its source as `mbtiles://./tiles/linz-vector-tiles.mbtiles` — the same archive the builder
consumes.

The surrounding infrastructure also already exists:

| Piece | Where |
|---|---|
| EFS access point `/tiles`, mounted read-only at `/data/tiles` | `utils-infra-stack.ts:141-152`, `container-service.ts:294-296` |
| S3 artifacts read, commented "S3 permissions for MBTiles download (tileserver-gl)" | `utils-infra-stack.ts:252-263` |
| hostname `tiles`, `?api=` auth, CloudFront, ALB priority 4 | `cdk.json` context, `api-auth.ts` |
| ECR lifecycle rule `utils-tileserver-gl-` | `base-infra/lib/constructs/services.ts:36` |

`WORKDIR` is `/data`, so `mbtiles://./tiles/...` resolves to the EFS mount. Per the
[tileserver-gl endpoint docs](https://github.com/maptiler/tileserver-gl/blob/master/docs/endpoints.rst),
source data is served at `/data/{id}/{z}/{x}/{y}.pbf` as a passthrough of the stored blob, so OMT layer
names and `render_height` arrive byte-identical at near-zero CPU — unlike the raster path, which needs
Xvfb and is why that container is sized 2048/4096.

### Changes required — implemented

1. ~~Place the built `.mbtiles` on the same EFS volume as `linz-vector-tiles.mbtiles`.~~ Done via
   `cdk.json`'s existing `mbtilesMulti` mechanism — `nz-omt.mbtiles` and `nz-omt-buildings.mbtiles` were
   added alongside `linz-vector-tiles.mbtiles` in both `dev-test` and `prod` contexts. The `tile-downloader`
   init container fetches all four files from the artifacts bucket onto the shared EFS volume before
   `tileserver-gl` starts.
2. ~~Add a `data` section to `tileserver-gl/config.json`~~ Done:
   ```json
   "data": {
     "nz-omt": { "mbtiles": "./tiles/nz-omt.mbtiles" },
     "nz-omt-buildings": { "mbtiles": "./tiles/nz-omt-buildings.mbtiles" }
   }
   ```
   Verified against a real `maptiler/tileserver-gl:latest` container (not just read from docs): `/data/{id}.json`
   returns correct TileJSON with the real `vector_layers`, and `/data/{id}/{z}/{x}/{y}.pbf` returns a
   real gzipped MVT tile.
3. ~~Host a `StreamingTiles` manifest~~ Done — added to `terrain-proxy`, not a new service. See §12 Path B.
4. ~~A refresh workflow to rebuild and land the file~~ Done, then moved. Originally
   `update-linz-tiles.yml` gained `build-nz-omt-tilesets` (demo) and `build-nz-omt-tilesets-prod` (prod)
   jobs running monthly. Those jobs were removed and folded into the annual EC2 build in `offline-maps/`
   instead — see "Where the refresh runs now" below.

No new hostname, ALB priority, CloudFront distribution or container was needed — confirmed as designed.

### Where the refresh runs now

The NZ OMT vector basemap build moved from a monthly GitHub Actions job to the same manually-launched,
annual EC2 instance that builds the other large offline map files (`offline-maps/`, see that folder's
README). It's step 6 in `offline-maps/user-data.sh`.

Two real reasons for the move, not just consolidation for its own sake:

- **Disk space.** Standard GitHub-hosted runners guarantee only ~14 GB free disk (72 GB total, 50+ GB
  consumed by preinstalled tooling). Measured peak usage for this build was close to that ceiling: 3.0 GB
  LINZ source + 1.1 GB heights source + up to 2.3 GB of tippecanoe scratch + two ~2.2-2.4 GB output files
  — roughly 9-10 GB peak, needing an explicit "free disk space" step to survive reliably. The EC2 instance
  has a properly-sized real volume instead of scraping together headroom.
- **No `apt`/`tippecanoe` package on Amazon Linux.** The GitHub runner installed tippecanoe via
  `apt-get install tippecanoe` (Ubuntu). The EC2 instance runs Amazon Linux 2023, which has no tippecanoe
  package at all — `offline-maps/user-data.sh` builds it from source (`felt/tippecanoe`, the actively
  maintained fork; upstream `mapbox/tippecanoe` is unmaintained) as part of its dependency-install step.

Tradeoff accepted deliberately: refresh cadence for the vector basemap dropped from monthly to annual.
The building-heights PMTiles was already not re-fetched by any automation (uploaded once, manually — its
source has no fixed refresh schedule), so this brings the vector basemap's cadence roughly in line with
the other input it already depends on, rather than being the odd one out at a faster cadence for no
strong reason.

### Compression: prefer gzipped tiles when serving

`StreamingTileClient.getTileData()` builds its request through `HttpClientBuilder`, and
`HttpClientBuilder._impl = OkHttpClientBuilder`. OkHttp negotiates and decompresses gzip transparently,
so gzipped `.pbf` over HTTP is fine and the wire saving is free.

This is a real advantage of serving over sideloading. For a **sideloaded** MBTiles, gzip support depends
on GDAL's MVT driver auto-detecting it — GDAL 3.8.4 does, but ATAK bundles its own build, so it is
unverified there. Over HTTP the question does not arise. Measured ratio on the merged tileset is **1.75x**,
not the ~3x typical of text formats, because MVT is already delta-encoded varints.

### The one thing `tileserver-gl` cannot do — and where to put it

`/data/{id}.json` is TileJSON, **not** a `StreamingTiles` manifest. ATAK needs `schema`,
`content: "vector"`, `numLevels`, `srs` and the `metadata.json` string carrying `vector_layers`, plus
per-request `{API_KEY}` substitution.

**Recommendation: add the endpoint to `terrain-proxy`.** It is already the service that hands ATAK a
`StreamingTiles` manifest — `t3-taknz.json`, served with `{BASE_URL}`/`{API_KEY}` substitution at
`terrain-proxy/server.js:283-297`. It is an express app with the S3 config loader, its own hostname,
CloudFront and `?api=` auth already wired. The marginal cost is roughly fifteen lines and no new
infrastructure. A dedicated service would need a container, an ECR lifecycle rule, an ALB priority,
possibly a CloudFront distribution and a build/deploy path — all for one nearly-static endpoint.

**The one non-obvious change:** `terrain-proxy` substitutes `{BASE_URL}` with *its own* host
(`req.get('host')`). The vector manifest's `url` must point at the **tileserver-gl** host, not
terrain-proxy's, so it needs a separate `TILES_BASE_URL` supplied via env var from `cdk.json` context.
Reusing `{BASE_URL}` here is the most likely thing to get wrong, and the failure is a manifest that looks
valid but whose tile URL 404s.

Do **not** serve the manifest from tileserver-gl's static `/files/{filename}` endpoint. It cannot do
per-request substitution, so the API key would have to be baked in — which is exactly the stored-token
failure mode described in `CloudTAK/UPSTREAM-BUG-REPORT-BASEMAP-TOKEN.md`.

Split it into its own service only if you do not want the basemap manifest's availability tied to the
terrain service.

### National size — measured

Built with `scripts/nz-omt-tileset/`, z0-16, uncompressed tiles:

| Variant | File | Tile payload |
|---|---|---|
| with 3D buildings | **2.3 GB** | 1922 MB |
| basemap only | **2.1 GB** | 1742 MB |

Per-zoom payload for the 3D variant, and the max single tile at each zoom:

| Zoom | Tiles | Max tile | Payload |
|---|---|---|---|
| z0-8 | 252 | 441 KB | 11 MB |
| z9 | 255 | 459 KB | 22 MB |
| z10 | 682 | 450 KB | 44 MB |
| z11 | 2,058 | 365 KB | 89 MB |
| z12 | 6,829 | 170 KB | 126 MB |
| z13 | 24,132 | 80 KB | 173 MB |
| z14 | 89,710 | 36 KB | 252 MB |
| z15 | 341,997 | 14 KB | 416 MB |
| z16 | 1,299,208 | 28 KB | 790 MB |

Three observations.

**Buildings are only ~180 MB of it,** under 10%. The basemap dominates, so the feature that started this
exercise is nearly free.

**z16 is the largest slice at 790 MB despite carrying no new information,** being overzoomed from LINZ's
z15 maximum. It cannot be dropped: buildings only draw at z16, and a z16 tile containing only `building`
would make roads and water vanish at exactly that zoom.

**Low zooms are thinned.** `--drop-densest-as-needed` fired at z9 and z10, dropping 454k and 769k
features because those tiles wanted 714 KB and 1.1 MB against tippecanoe's 500 KB limit. That is normal
generalisation at those scales. z15 and z16 lost only sub-pixel `tiny_polygons`, so full detail survives
where it matters.

### Coverage — use the whole archive, not a bbox

The builder defaults to processing **every tile in the LINZ archive** rather than a lon/lat bbox, and it
should stay that way. A bbox cannot express a region crossing the antimeridian, and this archive does
cross it: its z15 tile columns run 89..32719, i.e. lon -179.02 to 179.47, with latitudes from -8.53 to
-52.62.

An earlier hardcoded `166.0,-47.6,179.2,-34.0` silently dropped 21,382 z15 tiles (4.1% of the archive):

| Region | Approx. position | z15 tiles dropped |
|---|---|---|
| Chatham Islands | 176.5W, 44S | ~17,600 |
| Auckland Islands | 166E, 51S | 1,283 |
| Snares / southern Stewart | 168E, 48S | 691 |
| Campbell Island | 169E, 53S | 259 |
| Niue, Tokelau, Cook Islands (Realm) | 158-172W, 9-21S | ~900 |

The cost of including all of it is **+18 MB gzipped, or +0.7%**. Those tiles average ~390 bytes each
versus 2.5 KB for mainland tiles, because in vector tiles ocean is nearly free — the archive simply holds
little or nothing where there is no land.

Note the **building heights archive does not cover the Chathams.** Its bounds are lon 167.39..178.55, lat
-46.91..-34.43, and a scan of z16 tiles around Waitangi returns none. So the Chathams get basemap but
never 3D buildings from this source. The builder now derives the buildings scan range from the PMTiles
header rather than a guessed box, which is both correct and ~40% fewer lookups.

### Risks to weigh

- **Coupling.** `tileserver-gl` is the heaviest container and the only one running a headless renderer; an
  OOM there would take the ATAK vector endpoint with it. This is the same exposure already accepted for
  the raster basemaps ATAK consumes via `tiles.<domain>`.
- **EFS throughput is `BURSTING`** and this adds random reads against a ~1.6 GB SQLite file. Note the
  existing raster rendering reads that same archive considerably harder — it reads vector tiles *and*
  rasterises — so vector passthrough is strictly lighter on a proven path.
- **`Dockerfile` pins `maptiler/tileserver-gl:latest`.** Worth pinning for reproducibility, though that is
  independent of this change.

---

## 12. Configuring ATAK to consume it

Two delivery paths. Path A is verified on device; Path B is the deployable form.

### Path A — sideload (offline, verified)

```bash
adb push nz-omt-buildings.mbtiles /sdcard/atak/imagery/
```

Restart ATAK, then select it as a **basemap** — not an overlay. Tilt the camera at z16+ to see extrusion;
at nadir you get flat footprints regardless (`GLBatchLineString.isExtruded()` returns false when
nadir-clamp is on).

Two traps, both established the hard way:

- **`atak/imagery/` is the correct directory.** `atak/grg/` yields an overlay entry that draws nothing,
  because the GRG layer sets the overlay attribute (`GRGMapComponent.java:108`) which loads
  `omt/overlay/style.json`, where `building` is `visibility: none`.
- **Copy the file manually.** Do not drop it in `atakdata/` or use Import Manager. `.mbtiles` is
  registered to two resolvers with different destinations and `ImportFilesTask.sort()` breaks on the
  first match, so `ImportMVTResolver` (`:423` → `atak/overlays/`) can claim it ahead of
  `ImportLayersResolver` (`:469` → `atak/imagery/`) and route it into the static-feature path, which
  never reaches the extrusion renderer.

### Path B — streamed from `tileserver-gl`, delivered via `tileserver-helper` maps package

**Superseded design note:** an earlier version of this section had `terrain-proxy` serve these
manifests at request time, substituting `{TILES_BASE_URL}`/`{API_KEY}` per request (mirroring the
terrain manifest pattern). That's unnecessary complexity for this case: every other map source in
`tileserver-helper/` (14 raster `customMapSource` XML files) already bakes its API key into the URL at
**package-build time** via `build-maps.sh`/`build-maps-package.sh`'s `sed` substitution, not at
request time. There's no reason the two vector manifests should be the odd ones out routed through a
live service. They are now plain `StreamingTiles` JSON templates living alongside the raster XML
templates, substituted the same way, with no terrain-proxy involvement at all — `terrain-proxy/server.js`
no longer references `TILES_BASE_URL` or these manifests.

Two templates, numbered to continue the existing `tileserver-helper` convention (`01`-`33` are the
raster sources documented in `tileserver-helper/maps(-package)/template/*.xml`):

| Template | Number/title | Tileserver data id | Contents |
|---|---|---|---|
| `LINZ-Topographic-Vector.json` | `91 - TAK.NZ - LINZ Topographic (Vector)` | `nz-omt` | full basemap, no buildings |
| `LINZ-Topographic-Vector-3D.json` | `92 - TAK.NZ - LINZ Topographic w/ 3D buildings (Vector)` | `nz-omt-buildings` | full basemap + 3D buildings |

Both templates exist in two places, mirroring every other map source here:

- `tileserver-helper/maps/template/` — for `build-maps.sh` (Device Profile / manual single-file install)
- `tileserver-helper/maps-package/template/` — for `build-maps-package.sh` (one combined Mission
  Package zip), and both are now listed in `maps-package/template/MANIFEST/MissionPackageManifest.xml`

The buildings variant (`LINZ-Topographic-Vector-3D.json`):

```json
{
  "schema": "4.0.0",
  "title": "92 - TAK.NZ - LINZ Topographic w/ 3D buildings (Vector)",
  "content": "vector",
  "mimeType": "application/vnd.mapbox-vector-tile",
  "downloadable": true,
  "overlay": false,
  "refreshInterval": 0,
  "isQuadtree": true,
  "numLevels": 17,
  "srs": "EPSG:3857",
  "url": "https://tiles.{{DOMAIN}}/data/nz-omt-buildings/{$z}/{$x}/{$y}.pbf?api={{API_KEY}}",
  "bounds": { "minX": 166.0, "minY": -47.6, "maxX": 179.2, "maxY": -34.0 },
  "attribution": "Topographic data © LINZ, CC BY 4.0. Building heights © Atman Dhruva, CC BY 4.0, derived from LINZ LiDAR.",
  "metadata": {
    "styleSchema": "omt",
    "json": "{\"vector_layers\":[{\"id\":\"building\",\"fields\":{\"render_height\":\"Number\",\"render_min_height\":\"Number\"}},{\"id\":\"transportation\",\"fields\":{\"class\":\"String\"}},{\"id\":\"water\",\"fields\":{\"class\":\"String\"}}]}",
    "dataSource": "LINZ Basemaps topographic + Aotearoa NZ Building Heights",
    "coverage": "New Zealand"
  }
}
```

`{{DOMAIN}}` and `{{API_KEY}}` are the same template placeholders every raster `customMapSource` XML
here already uses — substituted at build time by `build-maps.sh`/`build-maps-package.sh`'s `sed`
pipeline, which now globs `*.json` alongside `*.xml`. The basemap-only variant
(`LINZ-Topographic-Vector.json`) is identical except `title`, `url` (`nz-omt` id), `attribution` (LINZ
credit only), and a `metadata.json` with no `building` layer.

Field notes beyond those in §4:

| Field | Why |
|---|---|
| `overlay` `false` | Mandatory. `true` loads `omt/overlay/style.json`, which hides every `fill` layer including `building`. See the Phase 0 outcome block. |
| `numLevels` `17` | Levels 0–16. Both tilesets are built with `--minzoom 0` to match, or ATAK requests low-zoom tiles that 404. |
| `srs` `"EPSG:3857"` | Web mercator. **Differs from `t3-taknz.json`, which is `EPSG:4326`** — do not copy that across. |
| `metadata.styleSchema` `"omt"` | Belt and braces. `GLVectorTiles.getSchema():331` short-circuits on this and returns `Schema.OMT` without inspecting `vector_layers`, so the stylesheet loads even if a non-OMT layer ever creeps into the tiles. Manifest `metadata` entries reach that map via `StreamingTileClient.getMetadata()`. |
| `metadata.json` | Still required, and still a **string** containing JSON. It only needs enough layers to be representative; `building.render_height` is the one that matters for the buildings variant. |

**Delivery, three ways** (same options every other map source in `tileserver-helper` already supports):

1. **Mission Package via Device Profile** (recommended for fleet rollout) — `build-maps-package.sh`
   produces one combined zip containing all 16 sources (14 raster + these 2 vector). Upload that zip's
   file via `PUT /Marti/api/device/profile/<profile>/file?filename=profile.zip`, or upload it as a
   regular Data Package (`POST /Marti/sync/missionupload`, or via CloudTAK's data package UI). No
   import plugin is required for this: confirmed by reading
   `MissionPackageEventHandler2.importFile()` (`atak/.../missionpackage/event/MissionPackageEventHandler2.java`),
   which runs every extracted file through the exact same `ImportResolver.match()` chain a manual
   sideload uses — the `content: "vector"` JSON is recognized identically whether it arrives loose or
   inside a Mission Package. The `ATAK_IMPORT_PLUGIN.md` "third resolver" concern only applied to
   *manual* placement, not Mission Package delivery, and is moot for this path.
2. **Device Profile, single file** — `build-maps.sh` produces standalone files (both `.xml` and `.json`
   now); PUT each individually per the existing instructions it prints.
3. **Manual sideload** — copy either `.json` file to `/sdcard/atak/imagery/mobile/mapsources/` and
   restart ATAK. That directory is ensured at `ATAKActivity.java:810`, and `ImageryScanner` passes
   children of `imagery/mobile` through generic null-hint resolution (`:166`), which reaches
   `StreamingContentDatasetDescriptorSpi`. This differs from `t3-taknz.json` (terrain), which goes to
   the **root** `atak/` because terrain is consumed by `TiledElevationSources.java:92` instead — reusing
   the terrain destination puts the file where nothing will look at it, and the failure is silent.

**Verified so far:** tileserver-gl `data` ids (`nz-omt`, `nz-omt-buildings`) confirmed working against a
real `maptiler/tileserver-gl:latest` container — TileJSON and tile fetches both return correct data, and
a streamed-online manifest of this same shape (previously served by terrain-proxy, before this
delivery-mechanism change) was confirmed rendering correctly on-device.

**Not yet device-verified.** The specific combination of maps-package-delivered `.json` template +
build-time `{{DOMAIN}}`/`{{API_KEY}}` substitution + `imagery/mobile/mapsources/` placement has not been
exercised end to end since this change. The manifest *shape* is unchanged from the version that was
device-verified; only how it reaches the device changed (static template + build script, vs. a live
service). Re-run the verification order below before relying on this in production.

### Verification order

1. `GET /health` on the tileserver → 200.
2. `GET /data/nz-omt-buildings.json` (or `/data/nz-omt.json`) on the tileserver → TileJSON listing the OMT
   layers for that variant.
3. `GET /data/nz-omt-buildings/16/64583/41033.pbf` → decode and assert exactly the expected OMT layer
   names, and that `building` features carry `render_height` and nothing else.
4. Run `build-maps.sh` or `build-maps-package.sh` and inspect the output `.json` files: no leftover
   `{{DOMAIN}}`/`{{API_KEY}}` placeholders, exactly one `?` in `url`, and the host in `url` is the
   **tileserver**, matching whatever `--domain` was passed.
5. On device: file in `imagery/mobile/mapsources/` (manual) or delivered via Mission Package/Device
   Profile, layer appears in Layers.
6. Select as basemap, **tilt at z16+** (buildings variant only). Roads and water should render in OMT
   styling with extruded beige buildings on top. Flat fills mean the schema match failed — go to §8 step 8.

### Known limitation: ATAK's own offline-cache mode does not work for this content type

Switching either vector layer to ATAK's built-in offline/download-for-cache mode currently produces a
blank map, confirmed by reading both candidate cache backends in ATAK-CIV 5.5.1.10:
`OSMDroidTileContainer.isCompatible()` and `GeoPackageTileContainer.isCompatible()`
(`takkernel/.../map/layer/raster/{osm,gpkg}/*.java`) both explicitly reject a source whose
`content` metadata is `"vector"` — `StreamingTileClient.SPI.create()`'s `openOrCreateCompatibleContainer()`
call therefore finds no compatible cache format, and the resulting offline layer has nowhere to store
tiles. This is a gap in ATAK's own vector-tile caching, not fixable from a manifest or style document.
Streamed-online use and Path A (sideloaded `.mbtiles`) are both unaffected — only the
download-to-offline-cache action on a *streamed* vector source hits this.

---

## 13. Reference index

ATAK-CIV 5.5.1.10 — `/home/ubuntu/GitHub/TAK-NZ/TPC_atak-civ`:

| Path | Relevance |
|---|---|
| `takkernel/.../map/formats/cdn/StreamingTiles.java` | Manifest schema and parser — authoritative field list |
| `takkernel/.../map/formats/cdn/StreamingContentDatasetDescriptorSpi.java` | Accepts `imagery`/`vector`; builds the dataset descriptor |
| `takkernel/.../map/formats/cdn/StreamingTileClient.java:340-371` | Merges `content` into the metadata `GLVectorTiles` checks |
| `takkernel/.../map/layer/feature/vectortiles/GLVectorTiles.java` | Live renderer; `isCompatible()`, `getSchema()`, `autostyle` logic |
| `takkernel/.../map/layer/feature/vectortiles/Schema.java:90-118,210-227` | OMT layer/field table and the `matches()` arithmetic |
| `takkernel/.../jni/jglvectortiles.cpp:44-80` | Stylesheet loaded from APK assets only — no custom style possible |
| `takkernel/.../cpp/formats/mbtiles/MapBoxGLStyleSheet.cpp:215-216` | The hardcoded `render_height` / `render_min_height` keys |
| `takkernel/.../cpp/formats/mbtiles/VectorTile.cpp:182-183` | Where extrude keys become OGR field lookups |
| `takkernel/.../map/layer/feature/Feature.java:117-118` | Per-feature `altitudeMode` + `extrude` |
| `takkernel/.../geometry/opengl/GLBatchLineString.java:787-833` | Terrain sampling and per-vertex extrusion |
| `takkernel/.../map/layer/raster/tilematrix/TileGrid.java:36-45` | `TileGrid.WebMercator` origin/resolution |
| `takkernel/.../map/layer/Layers.java:85-94` | Registration of `GLVectorTiles`, tile clients and containers |
| `takkernel/.../map/layer/raster/tilematrix/MBTilesContainer.java:271` | Infers `content=vector` from MBTiles metadata |
| `atak/.../android/elev/tiles/TiledElevationSources.java:92` | Terrain-only consumer — why `bld-*.json` needs a different directory |

This repo:

| Path | Relevance |
|---|---|
| `scripts/nz-omt-tileset/` | Offline builder for the merged OMT tileset, both variants (§11, §12) |
| `scripts/nz-omt-tileset/omt-linz-style.json` | LINZ-colour Mapbox/MapLibre style document for ATAK's "Set Layer Style" upload feature (ATAK 5.6+) |
| `scripts/phase0-buildings-extract.js` | Phase 0 single-area buildings extract |
| `tileserver-gl/config.json` | `data` section exposing `/data/{id}/{z}/{x}/{y}.pbf` for `nz-omt` and `nz-omt-buildings` |
| `tileserver-gl/topographic-style.json` | Already sources `mbtiles://./tiles/linz-vector-tiles.mbtiles`; also the colour reference for `omt-linz-style.json` |
| `cdk.json` `mbtilesMulti` (both envs) | Adds `nz-omt.mbtiles` / `nz-omt-buildings.mbtiles` to the EFS-download list |
| `lib/utils-infra-stack.ts:141-152,252-263` | EFS access point + S3 artifacts read for tileserver-gl |
| `lib/constructs/container-service.ts:294-296` | EFS mounted read-only at `/data/tiles` |
| `lib/constructs/cloudfront.ts` (`/data/*` behavior) | `?api=` auth extended to tileserver-gl's raw vector data endpoints, not just `/styles/*` |
| `tileserver-helper/maps/template/LINZ-Topographic-Vector.json` | `91` — StreamingTiles manifest, basemap-only, single-file/Device-Profile template |
| `tileserver-helper/maps/template/LINZ-Topographic-Vector-3D.json` | `92` — StreamingTiles manifest, 3D buildings, single-file/Device-Profile template |
| `tileserver-helper/maps-package/template/LINZ-Topographic-Vector.json` | Same as above, packaged variant |
| `tileserver-helper/maps-package/template/LINZ-Topographic-Vector-3D.json` | Same as above, packaged variant |
| `tileserver-helper/maps-package/template/MANIFEST/MissionPackageManifest.xml` | Lists both new `.json` templates alongside the 14 raster sources |
| `tileserver-helper/build-maps.sh` | Now globs `*.json` alongside `*.xml` when substituting `{{DOMAIN}}`/`{{API_KEY}}` |
| `tileserver-helper/build-maps-package.sh` | Same glob change, for the combined Mission Package zip |
| `offline-maps/user-data.sh` (step 6) | NZ OMT vector basemap build, moved here from `update-linz-tiles.yml`'s old monthly jobs -- now annual |
| `ATAK_IMPORT_PLUGIN.md` | Import-resolver plugin design; **not required** for Mission-Package-delivered vector manifests — see Path B above |
