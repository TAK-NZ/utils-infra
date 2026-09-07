# NZ Tsunami Evacuation Zones

Pipeline that turns the national tsunami evacuation-zone dataset into a single
styled KMZ and publishes it to CloudTAK as one Data Package.

Source: **NEMA "Aotearoa Tsunami Evacuation Zones (public)"** ArcGIS Feature
Service — the national dataset behind the
[getready.govt.nz tsunami map](https://getready.govt.nz/emergency/tsunami/tsunami-evacuation-zones).
It aggregates zones supplied by regional CDEM groups and councils. The source
service is only ever read.

> Attribution: *Copyright National Emergency Management Agency. Contains data
> sourced from CDEM Groups and Councils. Crown Copyright Reserved.* Zone
> definitions differ between regions (each region's assessment was commissioned
> independently); the dataset carries a per-feature `Source` credit.

---

## Contents

```
data-packages/hazards/tsunami/
├── build-tsunami-evac-zones.sh   # End-to-end orchestrator (start here)
├── build_kmz.py                  # Fetch + simplify + style the NEMA layer into a KMZ
├── .env.example                  # Config template — copy to .env and fill in
└── README.md                     # This file
```

`work/`, the built `*.kmz` and the packaged `*.zip` are generated at runtime and
git-ignored.

---

## What it produces

A single national package named, per the repo
[naming schema](../../NAMING-SCHEMA.md):

```
Hazards - NZ - Tsunami Evacuation Zones
```

Each polygon is styled by its evacuation-zone class using the official NEMA
colours (semi-transparent fill + outline):

| Zone | Colour |
|------|--------|
| Red | red |
| Orange | orange |
| Yellow | yellow |
| Purple | purple |
| Blue Inundation | light blue |

Only the real evacuation-zone classes are included: **Red, Orange, Yellow,
Purple, Blue Inundation**. The source layer also contains large non-evacuation
"background" polygons (`Inland`, `Marine`, `Undetermined`, `Outside Inland`,
`Safe`, `Between Inundation and Safe`) that together make up ~95% of the layer's
area but carry no evacuation meaning — these are filtered out at the query level
(see `--where` in `build_kmz.py`). Dropping them is both more correct as an
evacuation overlay and the main reason the file is small.

Feature geometry is also simplified (default `~0.0001°`, roughly 11 m) to keep
the KMZ small enough for on-device use. Combined, the zone filter + simplify
take the raw ~105 MB layer down to a ~7 MB KMZ with no meaningful loss at map
scale.

To include everything (all background classes) instead, pass `--where "1=1"` to
`build_kmz.py`.

---

## Prerequisites

- **AWS CLI** not required (source is an HTTP ArcGIS service).
- **Python 3.9+** with `requests` (`pip install requests`).
- **GDAL / ogr2ogr** (`apt install gdal-bin`).
- A CloudTAK API token (`etl.<jwt>`) from `POST /api/profile/token`.

---

## Configuration

```bash
cp data-packages/hazards/tsunami/.env.example data-packages/hazards/tsunami/.env
$EDITOR data-packages/hazards/tsunami/.env
```

| Variable | Description |
|----------|-------------|
| `SOURCE_URL` | NEMA ArcGIS FeatureServer layer URL (default in `.env.example`). |
| `CLOUDTAK_URL` | CloudTAK base URL (e.g. `https://map.demo.tak.nz`). |
| `CLOUDTAK_TOKEN` | CloudTAK API token (`etl.<jwt>`). Secret. |
| `CLOUDTAK_CHANNELS` | TAK channel to assign (e.g. `XtraTools - Data Packages`). |

`.env` is git-ignored so the CloudTAK URL and token never enter the repo.

---

## Running

```bash
# Build the KMZ, package it, and upload to CloudTAK
bash data-packages/hazards/tsunami/build-tsunami-evac-zones.sh

# Build the KMZ + package but skip upload (inspect the result)
DRY_RUN=1 bash data-packages/hazards/tsunami/build-tsunami-evac-zones.sh

# Keep the intermediate work/ files (KMZ, GeoJSON) for debugging
KEEP_WORK=1 bash data-packages/hazards/tsunami/build-tsunami-evac-zones.sh
```

The orchestrator:

1. Pages through the NEMA layer as ESRI JSON (all ~3,500 features, EPSG:4326).
2. Converts + simplifies to one GeoJSON via `ogr2ogr`.
3. Emits a styled KML (one shared style per zone class) and zips it to a KMZ.
4. Wraps the KMZ in a TAK Mission Package (via the flooding pipeline's
   `create_tak_package.py`) and uploads it to CloudTAK.

---

## Notes

- The layer covers all NZ regions plus Chatham Islands and an "Area Outside
  Region" class. It is published as a single national package rather than split
  per region.
- To tune the on-device size vs. fidelity trade-off, adjust `--simplify-deg` in
  `build-tsunami-evac-zones.sh` (larger = smaller file, coarser outlines).
