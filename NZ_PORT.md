# NZ port of WiSAR (TAK-NZ)

This is TAK-NZ's fork of [WiSAR Terrain-Aware Range Rings](https://github.com/clptak/WiSAR-Terrain-Aware-Range-Rings)
by Jamie F. Weleber (AGPL-3.0). The goal is a backend for the
[`cloudtak-plugin-sar`](https://github.com/TAK-NZ/cloudtak-plugin-sar) CloudTAK plugin that runs on New Zealand data
and is deployed as a container-image AWS Lambda from [`utils-infra`](https://github.com/TAK-NZ/utils-infra).

Branch policy: `main` mirrors upstream (`git fetch upstream`). NZ work happens on `nz-port` and its successors.
The upstream `app/pipeline/` package is deliberately **not modified**; everything NZ-specific lives in `nz/`, so
upstream changes merge without conflicts.

## What is here

| Path | Purpose |
|---|---|
| `nz/nz_sources.py` | Drop-in replacements for the four US data functions in `app/pipeline/downloads.py` (DEM, land cover, OSM, hydrology). |
| `nz/build_dem_index.py` | Indexes the LINZ 1 m DEM STAC sheets so a bounding box maps to COG URLs. |
| `nz/build_osm_lines.py` | Filters the Geofabrik NZ extract to a GeoPackage of trails, roads, waterways and power lines. |
| `nz/run_spike.py` | Runs the unmodified pipeline against NZ data, with per-stage timing and peak memory. |
| `nz/report.py` | Renders the ring-area comparison and an overview map. |

Run from the repository root, with `data/` holding the downloaded sources (git-ignored) and the upstream
requirements installed (`app/requirements.txt`, plus `matplotlib` for `report.py`).

## Data sources

| Data | Source | Licence / attribution |
|---|---|---|
| Elevation | LINZ NZ Elevation, 1 m LiDAR DEM (COG, EPSG:2193), public S3 bucket `nz-elevation` | LINZ open data, attribution required. Confirm the exact terms on the dataset page. |
| Land cover | **Interim:** ESA WorldCover 2021. **Target:** Landcare Research LCDB v6.0 (2023/24 epoch) | WorldCover CC BY 4.0. LCDB CC BY 4.0, attribute Landcare Research. |
| Trails, roads, waterways, power lines | OpenStreetMap via the Geofabrik NZ extract | ODbL, attribute OpenStreetMap contributors. |
| Hydrology | None (no NHD equivalent). Lakes and sea come from land cover, streams and rivers from OSM waterways. | |

## Spike results (October 2026)

The unmodified pipeline ran end to end on NZ data. Test sites were arbitrary; the results are **not validated**.

| Case | Grid | Total | Cost-distance | Peak memory |
|---|---|---|---|---|
| 8 km radius | 533x529 | 10-11 s | 4 s | 330-360 MB |
| 15 km radius | about 1000x1000 | 23-26 s | 15 s | 400-450 MB |
| 22 km radius, stream-dense bush | 1000x993 | 30 s | 14 s | 473 MB |

The pipeline caps the grid at 1000x1000, so runtime stays near 30 s for any radius (cells coarsen beyond about
15 km). gdalwarp adds up to about 210 MB in a separate process. Cold-start time on Lambda is not yet measured.

## Known gaps

- **Calibration.** WiSAR's per-band multipliers (1.05 / 1.35 / 1.80) come from Coconino County, Arizona. With them,
  calibrated ring areas ranged from 0.28x to 2.3x the plain Koester circle depending on terrain (steep bush vs flat
  farmland). There is no NZ incident data yet, so NZ output must not be presented as 25/50/75% containment. Plan:
  ship Travel Time mode first, keep TARR multipliers configurable with a default of 1.0, show the plain Koester
  circle beside the terrain-aware ring, and label it as uncalibrated.
- **Land cover.** WorldCover cannot separate indigenous forest, scrub, tussock and so on, so 79% of one bush test
  area got a single friction value. LCDB v6.0 replaces it, with a reviewed LCDB-class-to-friction table in config.
- **DEM coverage.** The LINZ 1 m DEM does not necessarily cover all of NZ. Gaps are unmapped; the national 8 m DEM is
  the planned fallback.
- **OSM tag sets** are WiSAR's US ones. Every `highway=track`, `service` road and power line becomes a friction-1.0
  corridor, which includes farm tracks and distribution lines in NZ.
- **WorldCover** handling in `nz_sources.py` supports a single 3x3 degree tile per request.

## Planned next steps

1. LCDB v6.0 to a national 30 m raster (with a wetland flag) and a reviewed friction table.
2. Lambda handler and Dockerfile (container image), Travel Time mode first.
3. Scheduled weekly OSM refresh to S3 in a format suited to range reads (FlatGeobuf or partitioned GeoParquet).
4. Deploy from `utils-infra`; relay through the TAK-NZ CloudTAK fork.
