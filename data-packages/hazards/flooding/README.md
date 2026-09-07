# Flood Hazard Map Overlays

Pipeline for turning NIWA 1% AEP (100-year) flood-depth GeoTIFFs into coloured
RGBA overlays and publishing them to CloudTAK as Data Packages, one package per
catchment map.

Source data: [NIWA Canterbury 1% AEP Flood Maps](https://www.arcgis.com/apps/dashboards/8c1db2b8e37841f29a57a38675388897#)

The per-region source archives live in S3 and are treated as **read-only** — the
pipeline only ever downloads from them. Generated overlays and packages are
interim artifacts, cleaned up after each region, and are never committed
(see `.gitignore`).

---

## Contents

```
data-packages/hazards/flooding/
├── process-flood-hazard-maps.sh    # End-to-end orchestrator (start here)
├── geotiff_to_flood_overlay.py     # Converts a flood-depth GeoTIFF to a coloured RGBA overlay
├── create_tak_package.py           # Builds TAK Mission Package ZIPs and uploads them to CloudTAK
├── .env.example                    # Config template — copy to .env and fill in
└── README.md                       # This file
```

`work/`, `overlays/`, `packages/` and downloaded `*.zip` / `*.tif` files are
generated at runtime and git-ignored.

---

## Prerequisites

- **AWS CLI v2**, configured with a profile that can read the source bucket.
- **Python 3.9+** with:
  - GDAL (`python3 -c "from osgeo import gdal"`) — `apt install python3-gdal`
  - NumPy — `apt install python3-numpy`
  - Requests (upload only) — `pip install requests`
- **unzip** and **bash**.
- A CloudTAK API token in the `etl.<jwt>` format, from `POST /api/profile/token`.

---

## Configuration

All configuration lives in `data-packages/hazards/flooding/.env`, which is
git-ignored so bucket names, the AWS profile, the CloudTAK URL and the API token
never enter the repository.

```bash
cp data-packages/hazards/flooding/.env.example data-packages/hazards/flooding/.env
$EDITOR data-packages/hazards/flooding/.env
```

| Variable            | Description                                                        |
|---------------------|--------------------------------------------------------------------|
| `SOURCE_BUCKET`     | S3 bucket holding the per-region source zips.                      |
| `SOURCE_PREFIX`     | Key prefix for the source zips (e.g. `flood-hazard-map-source/`).  |
| `AWS_PROFILE`       | AWS profile used to read the source bucket.                        |
| `AWS_REGION`        | Region of the source bucket (e.g. `ap-southeast-2`).               |
| `CLOUDTAK_URL`      | CloudTAK base URL (e.g. `https://map.demo.tak.nz`).                |
| `CLOUDTAK_TOKEN`    | CloudTAK API token (`etl.<jwt>`). Secret — rotate if leaked.       |
| `CLOUDTAK_CHANNELS` | TAK channel(s) to assign packages to (e.g. `XtraTools - Data Packages`). |

---

## Source data layout

The source bucket holds one zip per region, named `<Region>_0C.zip`. Each
archive contains two variants per catchment:

```
<Region> Region/
├── hmax/     <Map>_100y_<duration>_0c_Inundation_Floodmap_hmax.tif    # max water depth
└── humax/    <Map>_100y_<duration>_0c_Inundation_Floodmap_humax.tif   # max depth × velocity
```

The pipeline uses the **`hmax` (water depth)** variant only.

---

## Running the pipeline

From the repo root (or anywhere — paths resolve relative to the script):

```bash
# Process every region found in the source bucket
bash data-packages/hazards/flooding/process-flood-hazard-maps.sh

# Process only named regions
bash data-packages/hazards/flooding/process-flood-hazard-maps.sh Nelson Tasman

# Build packages but skip the upload (useful for a dry check)
DRY_RUN=1 bash data-packages/hazards/flooding/process-flood-hazard-maps.sh

# Keep the interim work/ files instead of cleaning up (for debugging)
KEEP_WORK=1 bash data-packages/hazards/flooding/process-flood-hazard-maps.sh
```

For each region the script:

1. **Downloads** `<Region>_0C.zip` from S3 (read-only).
2. **Extracts** the `hmax/` GeoTIFFs.
3. **Converts** each to a coloured RGBA overlay reprojected to EPSG:4326.
4. **Packages** each overlay into a TAK Mission Package and uploads it to CloudTAK.
5. **Cleans up** all interim files for that region before moving to the next, so
   peak local disk stays to roughly one region at a time.

A summary at the end reports regions processed, packages built, and any failures.

---

## Package naming

Each catchment map is published as its own Data Package named:

```
Hazards - <Region> - Flood - <Map Name> (100yr)
```

For example `Hazards - Nelson - Flood - Waimea (100yr)`. The `<Map Name>`
is the catchment name taken from the filename (the token before `_100y`, with
underscores turned into spaces, e.g. `North_Banks_Peninsula` → `North Banks Peninsula`).
This follows the repo-wide package naming schema — see
[`../../NAMING-SCHEMA.md`](../../NAMING-SCHEMA.md).

Each package is tagged with the keywords `Hazards`, `Flood`, `100y Inundation`,
`<Region>`, and `<Map Name>`, and assigned to the channel(s) in `CLOUDTAK_CHANNELS`.

---

## Colour scale

Flood depth is rendered using the NIWA depth palette:

| Depth   | Colour           | RGB            |
|---------|------------------|----------------|
| > 4 m   | Deep navy        | (9, 9, 145)    |
| 3–4 m   | Dark blue        | (18, 61, 184)  |
| 2–3 m   | Medium blue      | (31, 131, 224) |
| 1–2 m   | Light blue       | (104, 198, 232)|
| 0–1 m   | Pale cyan-blue   | (182, 237, 240)|
| No data | Transparent      | —              |

---

## Running individual steps

The orchestrator wraps the two Python tools, which can also be run directly.

### Convert a single GeoTIFF

```bash
python3 data-packages/hazards/flooding/geotiff_to_flood_overlay.py input_hmax.tif output_overlay.tif
```

Produces a DEFLATE-compressed, tiled (256×256) RGBA GeoTIFF in EPSG:4326.
A `.png` output extension yields a plain PNG plus a `.pgw` world file instead.

### Build / upload packages manually

```bash
python3 data-packages/hazards/flooding/create_tak_package.py \
    --input-dir data-packages/hazards/flooding/work/<Region>/overlays \
    --one-per-file \
    --output-dir data-packages/hazards/flooding/work/<Region>/packages \
    --upload \
    --url "$CLOUDTAK_URL" \
    --token "$CLOUDTAK_TOKEN" \
    --channels "XtraTools - Data Packages" \
    --name "Hazards - <Region> - Flood - {location} (100yr)" \
    --keywords Hazards "<Region>" Flood "{location}" "100y Inundation"
```

The `{location}` placeholder is replaced per file with the catchment name.

---

## Notes

- Output GeoTIFFs are reprojected from NZTM2000 (EPSG:2193) to WGS 84 (EPSG:4326),
  which CloudTAK's ingestion pipeline requires.
- CloudTAK keyword handling has quirks (keywords and channels are applied as
  query parameters on upload); see the header of `create_tak_package.py` for detail.

---

## Run status

The 16 NZ regional source archives are staged in the demo artifacts bucket under
`flood-hazard-map-source/` and processed by this pipeline:

| Region | Region | Region | Region |
|--------|--------|--------|--------|
| Auckland | Bay of Plenty | Canterbury | Gisborne |
| Hawke's Bay | Manawatu-Whanganui | Marlborough | Nelson |
| Northland | Otago | Southland | Taranaki |
| Tasman | Waikato | Wellington | West Coast |

Pipeline last validated end-to-end against the demo CloudTAK
(`https://map.demo.tak.nz`, channel `XtraTools - Data Packages`) with the **Nelson** region:
download → extract `hmax` → convert → package → upload → cleanup all succeeded,
and the four Nelson catchments (Nelson, Waimea, Wakapuaka, Whangamoa) appeared in
CloudTAK named `Hazards - Nelson - Flood - <Map> (100yr)` with the
expected keywords and channel.

To publish (or re-publish) all regions:

```bash
cp data-packages/hazards/flooding/.env.example data-packages/hazards/flooding/.env
# fill in CLOUDTAK_TOKEN etc.
bash data-packages/hazards/flooding/process-flood-hazard-maps.sh
```

Re-running a region uploads a fresh package; CloudTAK does not de-duplicate by
name, so remove the previous entries first if you are replacing existing maps.
