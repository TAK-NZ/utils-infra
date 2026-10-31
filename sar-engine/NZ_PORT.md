# NZ port of WiSAR (TAK-NZ)

This is TAK-NZ's fork of [WiSAR Terrain-Aware Range Rings](https://github.com/clptak/WiSAR-Terrain-Aware-Range-Rings)
by Jamie F. Weleber (AGPL-3.0). It is the backend for the
[`cloudtak-plugin-sar`](https://github.com/TAK-NZ/cloudtak-plugin-sar) CloudTAK plugin: terrain-aware travel-time
contours from New Zealand data, packaged as a container-image AWS Lambda for deployment from
[`utils-infra`](https://github.com/TAK-NZ/utils-infra).

Branch policy: `main` mirrors upstream (`git fetch upstream`). NZ work happens on `nz-port` and its successors.
The upstream `app/pipeline/` package is deliberately **not modified**; everything NZ-specific lives in `nz/`, so
upstream changes merge without conflicts. The Flask app (`app/server.py`, `app/static/`) is not used by the Lambda.

## What is here

| Path | Purpose |
|---|---|
| `nz/handler.py` | Lambda handler: routing, authentication, input validation, the travel-time and TARR analyses. |
| `nz/tarr.py`, `nz/tarr_profiles.py` | TARR logic (subject selection, multiplier configuration, plain circles, ring features; standard library only) and the Koester table generated from `app/static/app.js`. |
| `nz/check_tarr.py`, `nz/check_tarr_handler.py` | Checks for the above: pure logic (also runs under plain `python3`), and the handler with the heavy stages stubbed (`--real` runs a bush site through the real data). |
| `nz/nz_sources.py` | Replacements for the four US data functions in `app/pipeline/downloads.py` (elevation, land cover, OSM, hydrology), plus the start-point water check. |
| `nz/lcdb_friction.toml`, `nz/lcdb_friction.py` | LCDB class to terrain impedance (reviewed table with a rationale per class), and the loader that registers it with the pipeline. `python nz/lcdb_friction.py` prints the table with the resulting friction. |
| `nz/osm_tags.py` | OSM tag sets used by the builder and the runtime. |
| `nz/api_keys.py` | API keys from a JSON file in the config bucket (16-character minimum, disabled entries ignored, fails closed). |
| `nz/osm_build.py` | Builds the OSM FlatGeobuf from a PBF using only pyogrio, so no `ogr2ogr`/`osmium` is needed. Shared by the builder and the refresh. |
| `nz/osm_refresh.py` | Scheduled Lambda: downloads the Geofabrik extract, builds, uploads under a dated key, then switches the pointer sidecar. |
| `nz/dem_1m_index.json` | Sheet bounding boxes of the LINZ 1 m DEM (bundled in the image). |
| `nz/build_lcdb_raster.py` | LCDB v6.0 shapefile to a national 30 m COG (about 45 MB, 3 minutes). |
| `nz/build_osm_lines.py` | Command-line build of the same FlatGeobuf plus the pointer sidecar, for local use (about 30 s). |
| `nz/linz_water_build.py`, `nz/build_linz_water.py` | Build the optional LINZ waterways FlatGeobuf (streams and river areas) from the LINZ vector-tile MBTiles that utils-infra stores; the second is the command-line wrapper (about 1 minute, 1 GB). |
| `nz/check_linz_water.py` | Checks for the LINZ waterways: builder, merge and its fallback, and the friction that reaches the cost surface (`--real` reads real areas). |
| `nz/build_dem_index.py` | Regenerates `dem_1m_index.json` from the LINZ STAC collection. |
| `nz/check_dem_coverage.py` | Samples random land points to estimate 1 m DEM coverage. |
| `nz/run_spike.py`, `nz/report.py` | Run the pipeline on a site with timings; render ring-area comparison maps. |
| `Dockerfile.lambda`, `nz/requirements-lambda.txt` | The Lambda container image. |

## Running it

```
docker build -f Dockerfile.lambda -t sar-engine .
docker run -p 9000:8080 -v /path/to/data:/data:ro -e SAR_DATA_DIR=/data -e SAR_API_KEY=local-dev-key-0123456789 sar-engine
```

| Variable | Meaning |
|---|---|
| `SAR_DATA_DIR` | Directory (or GDAL path such as `/vsis3/bucket/prefix`) holding `lcdb_2023_30m.tif`, `nz_osm_meta.geojson` and the OSM FlatGeobuf the sidecar names. Not baked into the image. |
| `SAR_CONFIG_BUCKET`, `SAR_CONFIG_KEY` | S3 object holding the API keys (`{"apiKeys": {"name": {"key": "...", "enabled": true}}}`). Cached for five minutes. |
| `SAR_API_KEY` | A single key for local use (16 characters or more). |
| `SAR_TARR_MULTIPLIERS` | Optional JSON replacing the TARR multipliers (see TARR below). |

With no valid key configured, every route except `/health` is denied. Direct (IAM-authorised) invokes do not use keys.

The OSM refresh runs from the same image with the command `osm_refresh.lambda_handler`, and reads `SAR_DATA_BUCKET` and
`SAR_DATA_PREFIX`. `{"dry_run": true}` builds and validates without uploading.

### API

An optional `/sar` path prefix is accepted so an ALB can route by path. Events from an ALB, a Function URL or a direct
invoke are all understood.

- `GET /health` returns `{"status": "ok", ...}` without authentication.
- `POST /travel-time` takes
  `{"ipp": {"lat": -40.87, "lng": 175.45}, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10}`
  (`radius_km` optional) and returns GeoJSON `contours`, `parameters`, `bbox`, `warnings`, `data` versions,
  `attribution`, a `disclaimer` and per-stage `timings_s`.
- `POST /tarr` takes
  `{"ipp": {"lat": -40.87, "lng": 175.45}, "profile": "Hiker", "ecoregion": "Dry", "terrain": "Mountainous"}`
  (`ecoregion` and `terrain` optional) and returns `mode: "tarr"`, GeoJSON `contours`, `parameters`, `calibration`,
  `bbox`, `warnings`, `data`, `attribution`, a `disclaimer` and `timings_s`. See TARR below.

Limits: IPP inside mainland NZ and on land (a start in the sea or a lake returns 422), speed 0.1 to 10 km/h, 1 to 8
intervals of 0.25 to 24 h, radius at most 30 km, body at most 8 KB. The pipeline prints the IPP, so its output is
discarded; logs hold timings, sizes and error classes, never coordinates.

**Dense-area guard.** After the OSM read, `density_guard.py` counts the trail, road and power-line segments and
estimates the total time (`time used so far + 3 s + 0.15 ms x segments + 1 s`). If that exceeds the budget
(`SAR_TIME_BUDGET_S`, default 45 s; a cold start adds up to about 10 s before the handler runs, under a 55 s function
timeout and the 60 s ALB limit), the request ends at once with HTTP 422:

```json
{"status": "error", "code": "area_too_dense",
 "message": "This area has too much road and trail data to analyse within the time limit. Try a radius of 29 km or less.",
 "suggested_radius_km": 29}
```

The suggested radius is the largest whole kilometre whose segments, counted exactly from the data already in memory,
fit the budget. It is counted rather than calculated from the area because segment counts do not follow the area:
central Auckland has 113,752 segments within 10 km and 204,689 within 20 km, and a first version that scaled by area
suggested a 27 km radius that the real handler then refused.

When the radius is held up by the longest time band (speed x band + 2 km), the body carries `suggested_max_hours`
instead, or as well as `suggested_radius_km` when an explicit radius is also too large; with no workable suggestion the
message says to move the start point or shorten the bands. A request that fits is not changed in any way (the check
compares contours with the guard on and off). The cost model has four measurements behind it, so treat the threshold as
a calibrated guess. `check_density_guard.py [N] [--real]` holds the measurements, checks the decision and every
suggestion on random inputs, and with `--real` runs the handler end to end.

### TARR (Terrain-Aware Range Rings)
The 28 subject profiles and their Koester (2008) 25/50/75% distances (via Ferguson 2013, IGT4SAR) are in
`nz/tarr_profiles.py`, generated from `app/static/app.js`; `check_tarr.py` re-parses that file and fails if they differ.
`ecoregion` (Temperate, Dry, Urban) and `terrain` (Mountainous, Flat) pick a row as in the upstream UI: the exact
row, else the ecoregion's row, else the profile's default row. A combination the profile does not list is a 400.

The route uses the same NZ stages as `/travel-time` (LCDB, LINZ elevation, OSM; one shared function in the handler).
Per request: the Koester distances are multiplied by the calibration multipliers; the analysis radius is the
calibrated 75% distance + 2 km (as upstream), clipped to the 30 km limit with a `limits` warning; cost distance is
searched up to the calibrated 75% distance; the upstream `extract_contour_polygons` cuts the three rings. The start-point
water rejection and the dense-area estimate are the same as for travel time. A refusal has no suggestion fields, because
the caller has no radius or band to change: the message says to move the start point or pick a profile with a shorter
search distance.

The response has six features, largest first: for each percent a plain Koester circle (72-vertex spherical circle,
uncalibrated, no multiplier) and the terrain-adjusted ring above it. Rings are named by distance and source, for
example `Koester 50%, terrain-adjusted` and `Koester 50%, plain circle`. `calibration` reports the region, where the
multipliers came from (`built-in`, `environment`, `config-file`), whether the profile had its own multiplier, the
multiplier per band, `calibrated_for_nz: false` and a note; `parameters` has the Koester row used, the calibrated
distances and the radius. Every response carries a `calibration` warning and a disclaimer saying the percentages are
not New Zealand containment probabilities. A terrain ring that produced no polygon is left out with an info warning;
the plain circle is always present.

**Multipliers.** The default is the Arizona set of `app/server.py` (`CALIBRATION_MULTIPLIERS`, `CALIBRATION_DEFAULT`):
Hiker 1.15, Skier (Alpine) 2.15, Dementia 2.55, Mental Illness 4.05, Despondent 1.65, Hunter 0.80, Child (10-12) 1.55,
every other profile 1.40, one value for all three bands. Replace them without a code change, first match wins:
`SAR_TARR_MULTIPLIERS` (JSON, at most 4096 characters, for local runs), then the key `tarrMultipliers` in the
config-bucket JSON file that holds the API keys (same permissions, same 5-minute cache), then the built-in set.
```json
{"label": "Coconino County, Arizona", "default": 1.40,
 "profiles": {"Hiker": 1.15, "Dementia": {"p25": 2.50, "p50": 2.55, "p75": 2.50}}}
```
A value is a number or `{p25, p50, p75}`, each between 0.1 and 10; `default` is required; profile names must exist; a
configured set replaces the built-in set completely. Anything invalid fails closed: every `/tarr` request answers 500 and
the log gets `{"event":"tarr_calibration_invalid","error":"ConfigError"}`, with no fallback to the Arizona set.
`/travel-time` is not affected.

## Data sources

| Data | Source | Licence / attribution |
|---|---|---|
| Elevation | LINZ NZ Elevation 1 m LiDAR DEM (COG, EPSG:2193), public S3 bucket `nz-elevation`; gaps filled from Copernicus GLO-30 (public S3 `copernicus-dem-30m`) | LINZ: CC BY 4.0 (per the STAC collection). Copernicus: see its licence terms; credit the Copernicus programme. |
| Land cover | Landcare Research LCDB v6.0, 2023/24 epoch (LRIS shapefile download) | CC BY 4.0, attribute Landcare Research. |
| Trails, roads, waterways, transmission lines | OpenStreetMap via the Geofabrik NZ extract | ODbL, attribute OpenStreetMap contributors. |
| Streams and river areas (optional) | LINZ Basemaps topographic vector tiles (`water_lines`, `water_polygons`), read from the MBTiles that utils-infra keeps as `linz-vector-tiles.mbtiles`. Added to the OSM waterways when published. | CC BY 4.0, attribute LINZ (Toitu Te Whenua). |
| Hydrology | None (no NHD equivalent). Lakes and sea come from land cover, streams and rivers from OSM waterways and, when published, LINZ. | |

OSM differs from WiSAR in one way: only `power=line` (transmission) is burned in as a cleared corridor. NZ `minor_line`
is mostly pole wiring along roads and through paddocks. This removed about 97% of "power line corridors" near Masterton.

### LINZ waterways (optional)

OSM has far fewer streams than LINZ in the backcountry. On 30 m cells at five walking-track areas (Tararua, Tongariro,
Routeburn, Abel Tasman, Arthurs Pass) LINZ had 1.4 to 5 times as many stream cells at four of them and about the same at
Tongariro; 82 to 100 % of OSM's stream cells had a LINZ stream within one cell. In a 30 km request the OSM snapshot holds
539 waterways in Westland and 6,397 in the Tararua; merged with LINZ it is 11,002 and 22,761.

How it works. `nz/build_linz_water.py` reads the `water_lines` and `water_polygons` layers of the LINZ MBTiles at zoom 12
(the stream network is already complete there and it is 6,000 tiles, not 519,000) and writes `linz_water.fgb` plus
`linz_water_meta.geojson` in the same layout as the OSM snapshot. `nz_sources.download_osm_features` then appends those
features to the `waterways` frame, so the cost-surface code is unchanged. Every LINZ line is typed `stream` (impedance 40,
friction 1.60) and every `river` polygon `river` (impedance 60, friction 3.00). LINZ cannot say which lines are rivers
(926,949 of 931,487 line fragments are `kind=river`), so the engine's river-versus-stream split comes from the polygons and
from the OSM waterways kept alongside. The cost surface takes the maximum friction of whatever covers a cell, so a stream
present in both sources costs no more than in one, and an OSM river line over a LINZ stream stays at the river value.

- **Switch.** The sidecar `linz_water_meta.geojson` is the switch. Without it the engine behaves as before, with no warning
  and no change to the response. Delete it to go back to OSM alone. Publish `linz_water.fgb` first, then the sidecar.
- **If the file cannot be read** the request carries on with OSM waterways and adds a `warning` (`source: linz-water`) that
  streams come from OpenStreetMap alone.
- **Response.** When in use, `data.linz_waterways_built_at` is set and the attribution list gains a LINZ line before the
  method line (CC BY 4.0).
- **Refresh.** Stream data changes slowly, so there is no schedule: rebuild by hand when utils-infra's monthly tile update
  has run and you want the new tiles.
- **Not counted by the dense-area guard.** Waterways are rasterized in batched calls and cost about 0.08 ms each; the worst
  30 km areas seen have about 24,000 (Urewera, 23,771; Tararua, 22,761), which added 1.3 s to the cost surface in the
  Tararua 30 km request.

Measured effect (engine run end to end on the local data, LINZ off against on): the cost-surface cells that change are 0.8
to 2.3 % of the grid and every one rises. Ring and contour areas move by 0.5 % or less: Canterbury plains 2 h 92.62 to
92.50 km2, Central Otago 1 h 14.07 to 14.01, Arthurs Pass 4 h 20.37 to 20.35; Tararua TARR, Westland, Auckland and the
Tararua 30 km request are unchanged to two decimals. The reason is that a stream burns at friction 1.60, which is below
the 1.80 that indigenous forest and scrub already have, so in bush the added streams change nothing; they only slow cells
in open ground. The change is therefore about completeness of the data, not a visible shift in the rings. Cost-surface
time rose 0.02 to 1.3 s and peak memory 4 to 65 MB; the fast and upstream cost surfaces stay cell-for-cell identical on
real data (`check_cost_surface_parity.py --real`, including 22,761 waterways at 30 km).

### Elevation coverage

Sampling 600 random land points found 1 m DEM data at 86%: **96% in the North Island, 77% in the South Island**. The
misses cluster in Southland, Fiordland and south Otago. Where a request has holes, the engine fills them from
Copernicus GLO-30 (a 30 m surface model that includes tree canopy), removes the median offset where the two overlap,
and tells the caller when the filled share exceeds 1%. In a Southland test (37% filled) slopes across the seam were
consistent (median 13.7 degrees at the seam, between the 12.6 and 16.3 degree interiors).

## Measurements

**On real AWS Lambda** (Test environment in us-west-2, 2 GB, through the public ALB, October 2026; unvalidated test sites;
data read from S3). Warm unless stated:

| Request | Time | Peak memory |
|---|---|---|
| Bush, 8 km radius | 2.3 s | 0.6 GB |
| Bush, 16 km | 7 s | |
| Bush, 30 km (the maximum, 60 m cells) | 14 s | 1.1 GB |
| Southland, 30 km | 13 s | |
| Wellington, 30 km | 19 s | 1.3 GB |
| Auckland, 10 km | 26 s | |
| **Auckland, 30 km** | **50 s** | 1.6 GB |
| Cold first request, bush 8 km | 12 s | |
| Cold, bush 30 km | 19 s | |
| **Cold, Auckland 30 km** | **63 s** | |

- **Backcountry is comfortable.** Every backcountry location surveyed has under 6,000 trail and road segments within 20 km,
  and a cold 30 km request takes 19 s.
- **Dense cities are the slow path.** The cost surface scales with the number of trail and road segments: about 5 s at
  12,000 segments, 11 s at 50,000 (Wellington), 17 s at 114,000 (central Auckland, 10 km) and 38 to 40 s at about 250,000
  (central Auckland, 30 km). `rasterize` converts every polygon to a Python dictionary first, which dominates. A cold
  central-Auckland request at 30 km exceeds the ALB's 60 s and would fail for a client. Central Christchurch is next
  worst. Not optimised, because search and rescue starts are overwhelmingly outside city cores.
- **Cold starts** now add little for backcountry requests (12 s for a small one). Provisioned concurrency is not needed
  for rare use. The very first request after deploying a new image has been slower (46 to 60 s earlier, before these
  changes), because the image is fetched lazily.
- **Test is in us-west-2 and the LINZ elevation bucket is in Sydney**, so the elevation stage includes a trans-Pacific round
  trip on every request. A deployment in ap-southeast-2 should be faster on that stage; not measured.
- **The monthly refresh** takes about 100 s on Lambda (3 GB, 2 GB `/tmp`) and builds 971,529 features.

Local figures (Lambda image under the Runtime Interface Emulator, data on local disk) are lower than the real ones and
should not be used for sizing.

### The speed-ups

All of these replace upstream functions with drop-ins in `nz/`, and each has a checker that compares against the upstream
or previous behaviour. Run them from the repository root.

| Module | What it changes | Checker |
|---|---|---|
| `fast_cost_distance.py` | Upstream's pure-Python Dijkstra (22 s at 12 km on Lambda, timeout at 16 km and more) becomes scipy's compiled one on a sparse graph, with a search `limit` at the longest time band cropped to the proven reach. | `check_cost_distance_parity.py [N] [--real]` |
| `fast_cost_surface.py` | Upstream burns OSM streams one `rasterize` call each (about 6,400 for a 30 km bush request, 9 of 12 s). All streams go in two calls, which gives the same result because a cell takes the maximum of the covering values. Trails, roads and power lines are burned in batches of 5,000 combined with `np.maximum`, which bounds memory (one call over central Auckland's segments held 1.3 GB). | `check_cost_surface_parity.py [N] [--real]` |
| `nz_sources.download_dem` | The nine LINZ sheets of a 30 km request, and the Copernicus tiles, are read in parallel and laid on the grid in the original order. The sheets overlap by thousands of cells where adjacent surveys disagree by metres, so the order must be kept. | `check_dem_parallel_parity.py` |

What the checks showed. Random grids with NaN and out-of-range elevations and sanitised friction values, and real sites
through the real pipeline, give identical arrays and byte-identical contours; the cost-surface checker runs every random
input at four batch sizes (1, 3, 7 and 5,000) so the batching really executes. Each checker was also run against
deliberately broken versions of the code (a formula constant, a swapped impedance, overwriting instead of combining
batches, reversing the merge order) and failed, so they can catch regressions. The responses of six requests across NZ
were byte-identical before and after all three changes.

Two upstream quirks are kept so results stay comparable. The IPP is converted to a cell by rounding the pixel's corner
coordinate, which is half a cell off and can reject an IPP in the last row or column of the grid (the pipeline pads the
grid, so this cannot occur). Upstream's waterway loop aborts at the first stream with a missing geometry; the fast version
skips it, and the data the service reads never has missing geometries.

### Bugs only the real runtime exposed

- The Lambda base image lacks `libexpat`, which the rasterio and pyogrio wheels need (import failure). The Dockerfile
  installs it.
- The Lambda Python image ships boto3, and rasterio then builds a boto3-backed session on every `rasterio.Env` entry.
  The upstream cost-surface code enters one per stream (about 1,100 per run), which added about 25 s (`cost_surface`
  27 s against 1.5 s elsewhere). `nz_sources.py` hides boto3 from rasterio; GDAL still reads role credentials from the
  environment for `/vsis3/` paths. Re-check this if the base image or rasterio changes.

- **Files only root could read.** The first deployed image returned 502 on every request: its files were mode 600
  because the build checkout had a restrictive umask, and Lambda runs the code as an unprivileged user. The Dockerfile now
  sets the modes and imports the code as uid 1000 during the build, so the build fails instead.
- **Silent empty OSM build.** GDAL's OSM driver spills temp files into the current directory, which is read-only on
  Lambda (`/var/task`), and the SQL read swallowed the error and returned zero rows. `osm_build` now reads from a
  temporary directory and raises on an empty result; the refresh's minimum-feature check had already refused to publish.

Test with `--user 1000:1000 --read-only` and only `/tmp` writable. A root-run test hid both bugs.

## Known gaps

- **Not calibrated, and TARR is now implemented anyway (decision changed).** The earlier decision was to leave TARR
  out until there was NZ incident data, and if it was added, to default the multipliers to 1.0. WiSAR's multipliers come
  from Coconino County, Arizona; applied to NZ test sites they gave ring areas from 0.28x to 2.3x the plain Koester
  circle depending on terrain, and there is still no NZ incident data. The decision was changed at the owner's request:
  start from the Arizona per-profile multipliers of `app/server.py` so NZ rings are comparable with the reference tool
  (`sar.weleber.net`) that planners already know, instead of an invented 1.0 that would be no more NZ-valid. What keeps
  this honest: every response says the multipliers are not calibrated for New Zealand (`calibration`, a `calibration`
  warning, the disclaimer, the attribution); the multiplier used is reported; the percentages are explicitly not NZ
  containment probabilities; the plain Koester circle is drawn beside each terrain ring so users see how far terrain
  moved it; and the multipliers are configurable engine-side (see TARR), so an NZ set or 1.0 is a configuration change.
  Observed with the Arizona Hiker multiplier (1.15) on a steep bush site in the Tararua Range, the terrain-adjusted
  rings covered about 10% of the area of the plain circles (75%: 3 km2 against 32.6 km2), and at a second backcountry site (39.0 S, 176.0 E) about
  15%: terrain, not the multiplier, shrinks them. The reference site now uses a per-band set (for example Hiker
  1.00 / 1.10 / 1.40, default 1.05 / 1.35 / 1.80) applied in the browser, which is why the engine accepts per-band
  values; the single `server.py` values were used as instructed.
- **Travel time is not likelihood.** Contours show where a person could physically reach at the given flat-ground
  speed. They say nothing about where a person is likely to be.
- **Friction table is expert judgement** (`nz/lcdb_friction.toml`), accepted for v1, not measured NZ travel speeds. It
  matters less than it looks: swapping land-cover datasets moved ring areas by 0-4% on the test sites, because slope
  (Tobler's function applies a factor of about 5-8 at 30 degrees; designed for walking on tracks) dominates.
- **LCDB limits.** No understory detail (all indigenous forest gets one value). Cells with no LCDB polygon are treated
  as sea (barrier). Chatham Islands are not covered.
- **LINZ waterways are an addition, not a replacement, and are not validated on the ground.** They agree with OSM
  where both have a stream, but nothing here says which source is right where they differ. Fences, which LINZ also has,
  are deliberately not used (the model has no per-crossing cost, and the friction multiplier would depend on the cell size).
- **OSM.** Every `highway=track` and `service` road is a friction-1.0 corridor, which includes farm tracks. The snapshot is
  refreshed monthly (about 1% of relevant ways change per month, extrapolated from a measured 0.21% over 5 days) and its
  age is reported (warning after 45 days).
- **Dense urban areas are slower** (Auckland waterfront: 21 s on a laptop-class CPU) because of OSM feature counts.
- **Runtime dependency on LINZ and Copernicus S3 buckets** for elevation. An outage there fails the analysis.

## Next steps

1. Deploy via [`utils-infra`](https://github.com/TAK-NZ/utils-infra) (branch `feat/sar-engine`, see its `docs/SAR_ENGINE.md`): upload
   `lcdb_2023_30m.tif` to the artifacts bucket, enable the feature, run the first OSM refresh. It reuses the existing
   artifacts bucket under a `sar-engine/` prefix and refreshes OSM monthly.
2. Dense city cores (central Auckland, and to a lesser extent Christchurch) are slow at large radii because of the
   trail and road burn-in (see Measurements). The dense-area guard (see API) now refuses what cannot finish in time with
   a suggested smaller radius. Its threshold still needs calibrating on the deployed Lambda, and the slowness itself is
   unchanged: replacing `rasterize` for lines with a faster approach is the only way to remove it.
3. The `/api/sar/*` relay in the TAK-NZ CloudTAK fork, and the plugin itself.
4. NZ calibration of the TARR multipliers (replace the Arizona default through `SAR_TARR_MULTIPLIERS` or `tarrMultipliers`, and set `calibrated_for_nz` only when real NZ data exist).
