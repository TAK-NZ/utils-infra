# Mobile (Vessel-Based) AEDs — Design Notes

Internal implementation plan for overlaying mobile AEDs on live vessel
positions. Companion to `ABLETECH_PROPOSAL.md`, which is the external-facing
ask. This document is TAK.NZ-internal — Abletech doesn't need to see it, and
none of this can be built until Abletech agrees to add the `mobile`/`mmsi`
fields described in the proposal.

**Status:** design only, nothing implemented.

---

## Problem

A handful of AEDs in the aedlocations.co.nz dataset live aboard vessels
(Fiordland/Doubtful Sound tourism boats, harbour ferries, pilot boats, a lake
steamer, etc.) rather than at a fixed address. Right now they're only
identifiable by free-text pattern matching on the name/address, which is
unreliable — it both misses real cases and false-positives on fixed
buildings on streets like "Ferry Road." A static lat/lon for a boat that
moves around a fiord is often wrong by the time anyone looks at the map.

We've asked Abletech (see proposal) to add two structured fields:
- `mobile: true` — flags the record as vessel-based
- `mmsi` — the vessel's 9-digit Maritime Mobile Service Identity

This doc covers what TAK.NZ does with those fields once they exist.

---

## Why reuse `ais-proxy` instead of building something new

`ais-proxy` already does everything this needs structurally:

- Ingests live NZ-waters AIS data (AISStream WebSocket + Marinesia
  enrichment), keyed by MMSI, refreshed continuously.
- Already validates MMSIs against ITU-assigned Maritime Identification
  Digits (`isValidMMSI()`) — free validation of whatever MMSIs Abletech
  gives us.
- Already has the exact pattern needed: a secondary data source
  (`marinesiaCache`) polled independently and merged into the live
  `vesselCache` record on every update. An "AED aboard this vessel" flag is
  the same shape of problem — a small, slowly-changing lookup table merged
  into fast-changing live position data.
- Already loads small config/lookup JSON from S3 on an hourly cache
  (`loadApiKeys`). That's the natural delivery mechanism here too — no new
  API, no webhook.

Nothing about this needs a new service, a new database, or a new ingestion
path — it's an additional merge step on data ais-proxy is already handling.

---

## Data flow

```
Weekly AED build job (data-packages/infrastructure/aed-locations/build_kmz.py)
  │
  │  filters AEDs where mobile=true AND mmsi passes isValidMMSI()
  ▼
Utils-AIS-Proxy-AED-Vessels.json   (small file: MMSI → AED metadata)
  │
  │  uploaded to S3, same bucket/pattern as Utils-AIS-Proxy-Api-Keys.json
  ▼
ais-proxy  loadAedVessels()   — polled on the existing hourly S3 cache cycle
  │
  │  merged into vesselCache on every AIS update, mirroring marinesiaCache
  ▼
vesselCache entries gain: hasAED, aedName, aedAvailable24h, aedPositionStale
  │
  │  exposed ONLY in /ais-proxy/v2/vessels (v1 AISHub-compatible API unchanged)
  ▼
CoT/style layer (kml-proxy or display-proxy config)
  │
  │  query: properties.hasAED = true → icon override + callsign/label decoration
  ▼
ATAK / CloudTAK — AED icon rendered at the vessel's live position
```

---

## Why this only lands in the v2 API, not v1

`ais-proxy`'s v1 endpoint (`/ais-proxy/ws.php`) is AISHub-compatible and used
by other consumers who expect the standard AISHub field set. `CALLSIGN` in
particular is real data (the vessel's actual radio call sign) — mutating it
to append "(AED)" would corrupt a field other integrations may rely on being
accurate.

The AED flag is new, TAK.NZ-specific metadata, so it belongs in the v2 API
(`/ais-proxy/v2/vessels`) as additional fields, the same way `rateOfTurn`,
`positionAccuracy`, and `enrichedData` were added in v2 without touching v1.
Icon swap and label decoration (e.g. appending "AED" to a displayed callsign)
happen at the CoT/style layer, not inside ais-proxy — consistent with how
every other layer in this system separates raw data from presentation (see
`kml-proxy/DESIGN.md`'s query/style pattern).

---

## Persistent lookup table (not a one-time merge)

Vessels are evicted from `vesselCache` after 6 hours with no AIS traffic
(`VESSEL_CACHE_TTL`) and recreated fresh on the next `PositionReport`. If the
AED flag were only applied once at merge time, it would silently disappear
the next time a flagged vessel drops off and reconnects.

Fix: keep the MMSI → AED metadata list as its own persistent map
(`aedVesselCache`, loaded from S3), and re-merge it into the vessel record
on every touch — inside `processAISMessage()` and `pollMarinesia()`, the same
places `marinesiaCache` is already merged in today. This makes the AED flag
durable across cache evictions without needing to special-case vessel
lifecycle handling.

---

## Decision: stale-position semantics

The general 6-hour `vesselCache` TTL is tuned for "is this vessel worth
keeping in memory," not "is this position safe to send a bystander to." A
5-hour-old position in the wrong fiord is actively worse than showing
nothing. This needs its own, tighter threshold.

**Decision — two tiers, using a new `aedPositionStale` field:**

| Position age | Behaviour |
|---|---|
| < 15 minutes | Live. Render AED icon at current position, no warning. |
| 15 min – 6 hours (cache TTL) | Stale. Still render at last-known position, but set `aedPositionStale: true` (+ age) so the CoT layer can show "position may be outdated (Xh ago)" rather than presenting it as current. |
| > 6 hours / evicted from cache | Unknown. No live position exists — falls through to the static-KMZ fallback (below), not a moving marker with no data. |

15 minutes is deliberately generous rather than tight: Fiordland's terrain
causes genuine AIS propagation gaps for vessels that are still very much
underway and transmitting — a 20-minute gap there is normal, not a sign the
transponder is off. The goal is to distinguish "genuinely off/out of range"
from "briefly line-of-sight blocked by a mountain," and 15 minutes is a
reasonable line without being so generous it hides real disappearances.

---

## Decision: fallback when there's no valid, trackable MMSI

Not every mobile AED will have a usable MMSI — some vessels (small water
taxis, private boats) may not carry AIS at all, per the caveat already in
the proposal doc.

**Decision:** exclude an AED from the static weekly KMZ only if it has
`mobile: true` **and** an MMSI that passes `isValidMMSI()`. Everything else
— `mobile: true` with a missing, blank, or invalid MMSI — stays in the
static KMZ at whatever coordinate Abletech provides, with the popup text
explicit that the position may be inaccurate (mirroring the disclaimer
pattern already used for entries like "TSS Earnslaw - Mobile - Lake
Whakatipu" in the current dataset).

This keeps the rule purely mechanical — no need to guess which vessels
currently have live signal, no risk of a vessel silently vanishing from the
map because AIS data happens to be unavailable at build time. Whether the
vessel is *currently* reachable via AIS is a runtime concern handled by the
stale/unknown tiers above, not a build-time exclusion decision.

---

## Health/visibility

Add a small block to `/ais-proxy/v2/health` mirroring the existing
`marinesia` block, for operational visibility:

```json
"aedVessels": {
  "configured": 12,
  "currentlyLive": 9,
  "stale": 2,
  "unknown": 1,
  "lastConfigPoll": "2026-08-11T03:00:00.000Z"
}
```

---

## Implementation checklist (once Abletech confirms the fields)

1. `data-packages/infrastructure/aed-locations/build_kmz.py` — split output: AEDs with `mobile: true` +
   valid MMSI excluded from `AED-Locations.kmz`; everything else (including
   mobile-but-no-valid-MMSI) stays in. Write `Utils-AIS-Proxy-AED-Vessels.json`
   (MMSI → name, availability) as a new weekly-job artifact.
2. Upload that JSON to the S3 location `ais-proxy` will poll (new key
   alongside `Utils-AIS-Proxy-Api-Keys.json`).
3. `ais-proxy/server.js`:
   - `loadAedVessels()` — S3 poll, same caching pattern as `loadApiKeys()`
   - `aedVesselCache` — persistent MMSI → AED metadata map
   - Merge into `vesselCache` entries inside `processAISMessage()` and
     `pollMarinesia()`, computing `aedPositionStale` from position age
   - Add `hasAED` / `aedName` / `aedAvailable24h` / `aedPositionStale` to
     the v2 response only (`/ais-proxy/v2/vessels`); v1 untouched
   - Add `aedVessels` block to `/ais-proxy/v2/health`
4. CoT/style layer — new query rule (`properties.hasAED = true`) for icon
   override + label decoration, following the existing `kml-proxy`
   query/style pattern used for NZTA/avalanche/etc.
5. Update `docs/AIS_PROXY_V2.md` with the new fields once shipped.
