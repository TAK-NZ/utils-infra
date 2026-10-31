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
| `nz/handler.py` | Lambda handler: routing, authentication, input validation, the travel-time analysis. |
| `nz/nz_sources.py` | Replacements for the four US data functions in `app/pipeline/downloads.py` (elevation, land cover, OSM, hydrology), plus the start-point water check. |
| `nz/lcdb_friction.toml`, `nz/lcdb_friction.py` | LCDB class to terrain impedance (reviewed table with a rationale per class), and the loader that registers it with the pipeline. `python nz/lcdb_friction.py` prints the table with the resulting friction. |
| `nz/osm_tags.py` | OSM tag sets used by the builder and the runtime. |
| `nz/api_keys.py` | API keys from a JSON file in the config bucket (16-character minimum, disabled entries ignored, fails closed). |
| `nz/osm_build.py` | Builds the OSM FlatGeobuf from a PBF using only pyogrio, so no `ogr2ogr`/`osmium` is needed. Shared by the builder and the refresh. |
| `nz/osm_refresh.py` | Scheduled Lambda: downloads the Geofabrik extract, builds, uploads under a dated key, then switches the pointer sidecar. |
| `nz/dem_1m_index.json` | Sheet bounding boxes of the LINZ 1 m DEM (bundled in the image). |
| `nz/build_lcdb_raster.py` | LCDB v6.0 shapefile to a national 30 m COG (about 45 MB, 3 minutes). |
| `nz/build_osm_lines.py` | Command-line build of the same FlatGeobuf plus the pointer sidecar, for local use (about 30 s). |
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

Limits: IPP inside mainland NZ and on land (a start in the sea or a lake returns 422), speed 0.1 to 10 km/h, 1 to 8
intervals of 0.25 to 24 h, radius at most 30 km, body at most 8 KB. The pipeline prints the IPP, so its output is
discarded; logs hold timings, sizes and error classes, never coordinates.

## Data sources

| Data | Source | Licence / attribution |
|---|---|---|
| Elevation | LINZ NZ Elevation 1 m LiDAR DEM (COG, EPSG:2193), public S3 bucket `nz-elevation`; gaps filled from Copernicus GLO-30 (public S3 `copernicus-dem-30m`) | LINZ: CC BY 4.0 (per the STAC collection). Copernicus: see its licence terms; credit the Copernicus programme. |
| Land cover | Landcare Research LCDB v6.0, 2023/24 epoch (LRIS shapefile download) | CC BY 4.0, attribute Landcare Research. |
| Trails, roads, waterways, transmission lines | OpenStreetMap via the Geofabrik NZ extract | ODbL, attribute OpenStreetMap contributors. |
| Hydrology | None (no NHD equivalent). Lakes and sea come from land cover, streams and rivers from OSM waterways. | |

OSM differs from WiSAR in one way: only `power=line` (transmission) is burned in as a cleared corridor. NZ `minor_line`
is mostly pole wiring along roads and through paddocks. This removed about 97% of "power line corridors" near Masterton.

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

- **Not calibrated.** WiSAR's percentile multipliers (1.05 / 1.35 / 1.80) come from Coconino County, Arizona. Applied
  to NZ test sites they gave ring areas from 0.28x to 2.3x the plain Koester circle depending on terrain. There is no
  NZ incident data, so TARR (percentile) mode is **not implemented**; only Travel Time mode is. When TARR mode is
  added: multipliers configurable with a default of 1.0, the plain Koester circle shown beside the terrain-aware ring,
  and no 25/50/75% containment claim.
- **Travel time is not likelihood.** Contours show where a person could physically reach at the given flat-ground
  speed. They say nothing about where a person is likely to be.
- **Friction table is expert judgement** (`nz/lcdb_friction.toml`), accepted for v1, not measured NZ travel speeds. It
  matters less than it looks: swapping land-cover datasets moved ring areas by 0-4% on the test sites, because slope
  (Tobler's function applies a factor of about 5-8 at 30 degrees; designed for walking on tracks) dominates.
- **LCDB limits.** No understory detail (all indigenous forest gets one value). Cells with no LCDB polygon are treated
  as sea (barrier). Chatham Islands are not covered.
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
   trail and road burn-in (see Measurements). Either cap the radius when the start is in a dense area, warn the caller, or
   replace `rasterize` for lines with a faster approach.
3. The `/api/sar/*` relay in the TAK-NZ CloudTAK fork, and the plugin itself.
4. TARR mode, once there is a defensible calibration.
