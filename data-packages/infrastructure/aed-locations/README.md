# AED Locations (NZ)

Pipeline that turns the live AED (Automated External Defibrillator) location
list into a single styled KMZ and publishes it to CloudTAK as one Data
Package.

Source: **[aedlocations.co.nz](https://aedlocations.co.nz)**, via an
unauthenticated MapMySites API endpoint discovered by inspecting the site's
JS bundle. The source API is only ever read.

---

## STATUS: pending Abletech approval for redistribution

This pulls from an **undocumented, reverse-engineered API with no published
terms of use**. Abletech operates aedlocations.co.nz; TAK.NZ has proposed
polling and redistributing this data via TAK, but that has **not yet been
confirmed**.

**Do not schedule this pipeline.** Run it manually only, and only against a
demo/private CloudTAK instance, until approval is confirmed. There is
deliberately no GitHub Actions workflow for this dataset (unlike some other
`data-packages/` pipelines) — that's intentional, not an oversight.

Once approved, the intended production cadence is a **weekly poll** — AED
install locations rarely change day to day. See "Update frequency, measured"
below for why weekly (not less often) is the right cadence once this is
scheduled.

---

## Contents

```
data-packages/infrastructure/aed-locations/
├── build-aed-locations.sh   # End-to-end orchestrator (start here)
├── build_kmz.py              # Fetch the AED list and write a KMZ
├── aed.png                   # AED marker icon, bundled into the KMZ
├── MOBILE_AED_DESIGN.md      # Design notes for vessel-based AEDs (future work)
├── .env.example               # Config template — copy to .env and fill in
└── README.md                 # This file
```

`work/`, the built `*.kmz` and the packaged `*.zip` are generated at runtime
and git-ignored.

---

## What it produces

A single national package named, per the repo
[naming schema](../../NAMING-SCHEMA.md):

```
Infrastructure - NZ - AED Locations
```

One Placemark per AED, each with:

- Location clamped to ground (the source provides no altitude data)
- The bundled `aed.png` marker icon, via a single shared KML `Style`
  (defining one inline style per placemark broke rendering in Google Earth
  once the AED count passed a few thousand — it silently falls back to
  default markers)
- A popup with the site name, address, 24/7-availability, and the source
  AED id for traceability

---

## Prerequisites

- **AWS CLI** not required (source is a plain HTTP JSON feed).
- **Python 3.9+** with `requests` (`pip install requests`) — needed for upload only.
- A CloudTAK API token (`etl.<jwt>`) from `POST /api/profile/token`.

---

## Configuration

```bash
cp data-packages/infrastructure/aed-locations/.env.example \
   data-packages/infrastructure/aed-locations/.env
$EDITOR data-packages/infrastructure/aed-locations/.env
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
bash data-packages/infrastructure/aed-locations/build-aed-locations.sh

# Build the KMZ + package but skip upload (inspect the result)
DRY_RUN=1 bash data-packages/infrastructure/aed-locations/build-aed-locations.sh

# Keep the intermediate work/ files (KMZ) for debugging
KEEP_WORK=1 bash data-packages/infrastructure/aed-locations/build-aed-locations.sh
```

The orchestrator:

1. Fetches the current AED list (currently ~18,000 entries nationally,
   covering mainland NZ + Stewart Island) and writes a styled KMZ
   (`build_kmz.py`).
2. Wraps the KMZ in a TAK Mission Package (via the flooding pipeline's shared
   `create_tak_package.py`) and uploads it to CloudTAK.
3. `--replace` deletes any existing same-named package first, so re-running
   refreshes the package rather than creating a duplicate.

---

## Update frequency, measured

Compared the KMZ built 2026-09-09 against the live source one week later
(2026-09-17), by matching each AED's source id:

| Metric | Count |
|---|---|
| Total then | 17,865 |
| Total now | 17,976 |
| Added | 160 |
| Removed | 49 |
| Common ids | 17,816 |
| — of which, name changed | 39 |
| — of which, coordinates moved | 21 |
| — of which, address likely changed | 14 |

About 1.5% of records changed in some way (added, removed, or edited) in one
week — additions and removals dominate, with a smaller but real amount of
in-place editing (school renames, "Countdown → Woolworths" rebrand, cabinet
relocations, typo fixes). This confirms the data moves enough that a static,
never-refreshed snapshot goes visibly stale within days, and supports a
**weekly** poll once scheduling is approved — daily would be overkill for
this rate of change, and monthly would let a meaningful fraction of
additions/removals go unreflected for weeks.

---

## Mobile (vessel-based) AEDs

A handful of AEDs live aboard vessels rather than at a fixed address. See
[`MOBILE_AED_DESIGN.md`](MOBILE_AED_DESIGN.md) for the design (not yet
implemented) to overlay those on live AIS vessel positions via `ais-proxy`,
once Abletech agrees to add the structured `mobile`/`mmsi` fields that design
depends on.

---

## Notes

- No altitude/elevation data is provided by the source, so placemarks use
  `clampToGround`.
