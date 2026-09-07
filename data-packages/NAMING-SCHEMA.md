# Data Package Naming Schema

This document defines how TAK Data Packages published to CloudTAK / TAK server
are named and organised, so they sort predictably and read clearly on ATAK.

## Why this matters

- ATAK lists packages **alphabetically by name**, so the leading tokens decide
  how packages cluster in the list.
- On ATAK, users see **only the package name** — keywords/tags are not shown on
  the device (though CloudTAK does show them). The name must therefore carry the
  information a responder needs to find and identify a layer.
- Responders are usually anchored either to a **region** (their incident area) or
  to a **capability** (e.g. "where are the AEDs"). The schema groups by category
  first, then region, so both mental models are served.

## The grammar

```
<Category> - <Region> - <Type> - <Detail> (<Qualifier>)
```

- **Category** — top-level grouping key (see below). Always present.
- **Region** — NZ region name, or `NZ` for nationwide datasets. Always present.
- **Type** — the concrete kind of layer (e.g. `Flood`, `Tsunami`, `Fire Stations`).
- **Detail** — the specific subject (e.g. a catchment name). Omitted when the
  Type already fully identifies the layer.
- **(Qualifier)** — optional trailing scenario/version, e.g. `(100yr)`, `(2026)`.

Segments that do not apply are dropped (no empty ` -  - ` gaps).

## Categories

| Category | Use for |
|----------|---------|
| `Hazards` | Things that threaten — flood maps, tsunami evacuation zones, etc. |
| `Infrastructure` | Response-relevant physical assets/networks — AED locations, fire stations, huts, campsites, monitoring cameras. |
| `Reference` | Administrative / geographic boundaries and static reference data — EEZ, lines-company boundaries. |
| `Events` | Time-bound event overlays — e.g. an airshow map for a specific year. |

## Region token

- Region-scoped datasets use the NZ region name, e.g. `Nelson`, `Canterbury`,
  `Manawatu-Whanganui`, `West Coast`, `Hawke's Bay`.
- Nationwide datasets use `NZ`.

## Keywords (CloudTAK tags)

The name is deliberately short; richer metadata lives in keywords, which CloudTAK
displays and can filter on. Every package carries keywords covering, at minimum,
its category, region, and type, plus any useful descriptors (source agency,
scenario, theme). All packages are assigned to the `XtraTools - Data Packages` channel.

## Immutability constraint

CloudTAK package **names cannot be changed after upload**. The package API
supports listing, metadata read, upload, metadata PATCH (channels / keywords /
expiration only), and delete — but not renaming and not content download.

Therefore **renaming a package means delete + re-upload** under the new name,
which requires the original source file. Keep the source packages under
`data-packages/` so any package can be rebuilt and re-published.

## Current mapping

| Category | Region | ATAK name | Source |
|----------|--------|-----------|--------|
| Hazards | Nelson | `Hazards - Nelson - Flood - Nelson (100yr)` | S3 flood pipeline |
| Hazards | Nelson | `Hazards - Nelson - Flood - Waimea (100yr)` | S3 flood pipeline |
| Hazards | Nelson | `Hazards - Nelson - Flood - Wakapuaka (100yr)` | S3 flood pipeline |
| Hazards | Nelson | `Hazards - Nelson - Flood - Whangamoa (100yr)` | S3 flood pipeline |
| Hazards | NZ | `Hazards - NZ - Tsunami Evacuation Zones` | `data-packages/hazards/tsunami/` (NEMA ArcGIS) |
| Infrastructure | NZ | `Infrastructure - NZ - AED Locations` | `kml/aed-locations/` |
| Infrastructure | NZ | `Infrastructure - NZ - Fire Stations (FENZ)` | `data-packages/infrastructure/` |
| Infrastructure | NZ | `Infrastructure - NZ - Volcano Cameras (GeoNet)` | `kml/geonet-volcano-cameras/` |
| Infrastructure | NZ | `Infrastructure - NZ - Campsites (DOC)` | `data-packages/infrastructure/` |
| Infrastructure | NZ | `Infrastructure - NZ - Huts (DOC)` | `data-packages/infrastructure/` |
| Reference | NZ | `Reference - NZ - Lines Company Boundaries` | `data-packages/reference/` |
| Reference | NZ | `Reference - NZ - EEZ Boundary` | `data-packages/reference/` |
| Events | Otago | `Events - Otago - Warbirds over Wanaka (2026)` | event overlay (not yet applied — see note) |

> **Warbirds over Wanaka** currently remains under its original name
> (`Warbirds over Wanaka 2026.kmz`) on the `Regions - All of New Zealand`
> channel. It is an event overlay managed separately from the
> `XtraTools - Data Packages` channel and was left unchanged. If it is later
> folded into this schema,
> the target name is `Events - Otago - Warbirds over Wanaka (2026)`.

## Directory layout

```
data-packages/
├── NAMING-SCHEMA.md            # this file
├── hazards/
│   └── flooding/               # S3-driven flood hazard-map pipeline
├── infrastructure/             # source packages for national infrastructure layers
└── reference/                  # source packages for reference/boundary layers
```
