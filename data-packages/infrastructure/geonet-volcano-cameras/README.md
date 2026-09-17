# GeoNet Volcano Cameras

Pipeline that turns the live GeoNet volcano camera list into a single styled
KMZ and publishes it to CloudTAK as one Data Package.

Source: **GeoNet volcano cameras API** (`https://images.geonet.org.nz/volcano/cameras/all.json`)
— the same feed behind the
[GeoNet volcano cameras page](https://www.geonet.org.nz/volcano/cameras). The
source API is only ever read.

Camera images are referenced by URL, not embedded — ATAK and Google Earth
fetch the current image from GeoNet at display time. The KMZ only needs to be
rebuilt when cameras are added, moved, or removed, not when a camera's image
changes.

---

## Contents

```
data-packages/infrastructure/geonet-volcano-cameras/
├── build-geonet-volcano-cameras.sh   # End-to-end orchestrator (start here)
├── build_kmz.py                      # Fetch the camera list + icon and write a KMZ
├── .env.example                      # Config template — copy to .env and fill in
└── README.md                        # This file
```

`work/`, the built `*.kmz` and the packaged `*.zip` are generated at runtime and
git-ignored.

---

## What it produces

A single national package named, per the repo
[naming schema](../../NAMING-SCHEMA.md):

```
Infrastructure - NZ - Volcano Cameras (GeoNet)
```

One Placemark per camera, each with:

- Location at the camera's actual altitude (absolute altitude mode)
- The NZEM CCTV camera icon (bundled inside the KMZ, fetched from the
  [`iconset-nzem-symbology`](https://github.com/TAK-NZ/iconset-nzem-symbology) repo)
- A popup description with an inline live image, volcano name, azimuth,
  height, and a link back to the GeoNet camera page

---

## Prerequisites

- **AWS CLI** not required (source is a plain HTTP JSON feed).
- **Python 3.9+** with `requests` (`pip install requests`) — needed for upload only.
- A CloudTAK API token (`etl.<jwt>`) from `POST /api/profile/token`.

---

## Configuration

```bash
cp data-packages/infrastructure/geonet-volcano-cameras/.env.example \
   data-packages/infrastructure/geonet-volcano-cameras/.env
$EDITOR data-packages/infrastructure/geonet-volcano-cameras/.env
```

| Variable | Description |
|----------|-------------|
| `CLOUDTAK_URL` | CloudTAK base URL (e.g. `https://map.demo.tak.nz`). |
| `CLOUDTAK_TOKEN` | CloudTAK API token (`etl.<jwt>`). Secret. |
| `CLOUDTAK_CHANNELS` | TAK channel to assign (e.g. `XtraTools - Data Packages`). |

`.env` is git-ignored so the CloudTAK URL and token never enter the repo.

---

## Running

```bash
# Build the KMZ, package it, and upload to CloudTAK
bash data-packages/infrastructure/geonet-volcano-cameras/build-geonet-volcano-cameras.sh

# Build the KMZ + package but skip upload (inspect the result)
DRY_RUN=1 bash data-packages/infrastructure/geonet-volcano-cameras/build-geonet-volcano-cameras.sh

# Keep the intermediate work/ files (KMZ) for debugging
KEEP_WORK=1 bash data-packages/infrastructure/geonet-volcano-cameras/build-geonet-volcano-cameras.sh
```

The orchestrator:

1. Fetches the current camera list and icon, and writes a styled KMZ
   (`build_kmz.py`).
2. Wraps the KMZ in a TAK Mission Package (via the flooding pipeline's shared
   `create_tak_package.py`) and uploads it to CloudTAK.
3. `--replace` deletes any existing same-named package first, so re-running
   refreshes the package rather than creating a duplicate.

---

## Notes

- Cameras are deduplicated by id — some appear under more than one volcano in
  the source feed.
- This dataset moved here from `kml/geonet-volcano-cameras/`. The old
  directory uploaded a bare KMZ directly (not wrapped in a TAK Mission
  Package) under the name `GeoNet Volcano Cameras` on channel
  `UTL - Utilities`, and had a live API token committed to the script as a
  default value — none of the old files were ever committed to git, but
  treat that token as compromised regardless. This pipeline replaces all of
  that: proper Mission Package wrapping (matching every other pipeline under
  `data-packages/`), the new name/channel, and a git-ignored `.env` for
  secrets.
- Static-ish data (cameras rarely change). Re-run and re-upload manually when
  GeoNet adds/removes a camera; no scheduled polling is set up for this
  dataset.
