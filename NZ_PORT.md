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
docker run -p 9000:8080 -v /path/to/data:/data:ro -e SAR_DATA_DIR=/data -e SAR_API_KEY=changeme sar-engine
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

All with the Lambda image under the Runtime Interface Emulator, limited to 1 CPU and 2 GB, data on local disk,
unvalidated test sites. **Not yet measured:** a real Lambda cold start, and S3 read latency.

| Case | Time | Notes |
|---|---|---|
| Tararua bush, 10 km radius | 10 s | cost-distance 7 s |
| Southland, 10 km, 37% Copernicus fill | 13 s | |
| 30 km radius (maximum), 60 m cells | 38 s | grid is capped at 1000 x 1000 cells |
| Peak container memory | 348 MiB | across all runs |

The monthly refresh, run inside the Lambda image against the real Geofabrik download, took 73 s and published 971,529
features (it needs about 1.6 GB of memory and 1 GB of `/tmp`).

Over HTTP range requests, a FlatGeobuf bounding-box read fetched 1.8 MB in 53 requests for an 8 km bush area, 2.7 MB
for a 60 km mountain area, and 43.5 MB in 152 requests for a dense 40 km urban area (local emulation, not S3).

### Two bugs only the real runtime exposed

- The Lambda base image lacks `libexpat`, which the rasterio and pyogrio wheels need (import failure). The Dockerfile
  installs it.
- The Lambda Python image ships boto3, and rasterio then builds a boto3-backed session on every `rasterio.Env` entry.
  The upstream cost-surface code enters one per stream (about 1,100 per run), which added about 25 s (`cost_surface`
  27 s against 1.5 s elsewhere). `nz_sources.py` hides boto3 from rasterio; GDAL still reads role credentials from the
  environment for `/vsis3/` paths. Re-check this if the base image or rasterio changes.

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
2. Measure a real Lambda cold start and S3 read times (not yet measured). The HTTP function is configured for 2 GB and a
   55 s timeout, under the ALB's 60 s idle timeout; the 30 km case took 38 s locally.
3. The `/api/sar/*` relay in the TAK-NZ CloudTAK fork, and the plugin itself.
4. TARR mode, once there is a defensible calibration.
