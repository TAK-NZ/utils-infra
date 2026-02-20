# TLC Locality Discovery - Implementation Summary

## Results

✅ **Successfully implemented automated locality discovery**

### Coverage Improvement

- **Previous (manual)**: 28 localities from outage system
- **Current (automated)**: 211 localities from OpenStreetMap
- **Improvement**: 7.5x more complete coverage

## Implementation

### Script Created
`tools/generate-tlc-localities.js` - Automated locality discovery tool

### Process
1. Fetches TLC boundary from ENA network boundaries KML (557 polygon points)
2. Queries OpenStreetMap Overpass API for all places within boundary
3. Generates complete `scrapers/tlc-localities.js` with coordinates and regions

### Usage

```bash
# Regenerate locality mapping
npm run generate-tlc-localities

# Or directly
node tools/generate-tlc-localities.js
```

## Generated File

`scrapers/tlc-localities.js` now contains:
- 211 localities with precise coordinates
- Automatic region assignment (Waikato / Manawatu-Whanganui)
- Same helper functions (getCoordinates, getRegion, etc.)
- Fallback for unknown localities

## Sample Localities Discovered

Beyond the original 28, now includes:
- Kākahi, Ōwhango, Piopio, Benneydale
- Kinloch, Awakino, Ōngarue, Horopito
- Ski field areas: Iwikau Village, Turoa facilities
- Rural communities and settlements throughout King Country

## Maintenance

### When to Regenerate
- TLC expands service area
- New communities established
- Annual refresh recommended

### Dependencies
- `xml2js`: KML parsing
- `node-fetch`: API requests
- OpenStreetMap Overpass API (free, no key required)

## Benefits

✅ Complete coverage of TLC service area
✅ Proactive (not reactive to outages)
✅ Automated and reproducible
✅ No runtime dependencies (static mapping)
✅ Future-proof against new outages
