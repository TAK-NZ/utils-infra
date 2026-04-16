# Terrain Proxy API

TAK terrain tile proxy that serves LINZ NZ elevation data in TAK-compatible Mapbox Terrain-RGB format with high-accuracy geoid correction.

## Overview

TAK clients (ATAK/WinTAK) use terrain tiles for 3D rendering, line-of-sight analysis, viewsheds, and elevation profiles. This service converts LINZ elevation data (Mapbox Terrain-RGB in EPSG:3857) into TAK-compatible terrain tiles (EPSG:4326 quadtree) with proper vertical datum conversion using the NZGeoid2016 geoid model.

Compared to the global TAK Bathy terrain dataset, this service provides:
- **Higher resolution** — LINZ LiDAR-derived elevation vs global SRTM/GEBCO
- **More zoom levels** — 14 levels (z0–z13) vs 10 levels
- **Accurate geoid correction** — NZGeoid2016 model vs global EGM96/EGM2008
- **NZ-specific accuracy** — within ~15m of true summit elevations vs ~50m+

## Endpoints

### Terrain Manifest
```
GET /terrain/manifest.json
```
Returns the TAK terrain tile descriptor. Point your TAK server or client at this URL to load NZ terrain.

### Terrain Tiles
```
GET /terrain/{z}/{x}/{y}.png
```
Returns a 256×256 RGBA PNG terrain tile with elevation encoded in RGB channels.

| Parameter | Description |
|-----------|-------------|
| `z` | Zoom level (0–13) |
| `x` | Tile X coordinate (EPSG:4326 quadtree) |
| `y` | Tile Y coordinate (EPSG:4326 quadtree) |

### Health Check
```
GET /terrain/health
```

## TAK Configuration

### ATAK / WinTAK
Add as a terrain source using the manifest URL:
```
https://utils.{domain}/terrain/manifest.json
```

### TAK Server
Add to the TAK Server terrain sources configuration pointing to the manifest URL.

## Technical Details

### Coordinate System
- **Input (LINZ)**: EPSG:3857 (Web Mercator), Mapbox Terrain-RGB encoding
- **Output (TAK)**: EPSG:4326 (WGS84 Geographic), Mapbox Terrain-RGB encoding

### Elevation Encoding

Both input and output use **Mapbox Terrain-RGB** encoding (compatible with ATAK and TAK Bathy):
```
height = -10000 + (R × 65536 + G × 256 + B) × 0.1
```

Output tiles are **RGBA PNG** with alpha channel set to 255 (fully opaque), matching the format used by TAK Bathy.

### Vertical Datum Conversion

- **LINZ source**: NZVD2016 (orthometric, relative to mean sea level)
- **TAK output**: HAE (Height Above Ellipsoid, WGS84)
- **Geoid model**: [NZGeoid2016](https://www.geodesy.linz.govt.nz/download/nzgeoid/nzgeoid2016/) — the authoritative NZ quasigeoid model from LINZ
- **Interpolation**: Bilinear interpolation on the 1-arcminute geoid grid
- **Accuracy**: Sub-meter geoid correction across all of NZ

The geoid separation varies significantly across NZ:

| Location | Geoid Separation |
|----------|----------------:|
| Cape Reinga | 39.4m |
| Auckland | 34.5m |
| Wellington | 13.1m |
| Christchurch | 12.0m |
| Queenstown | 8.1m |
| Invercargill | 4.4m |

### Coverage
- **Area**: New Zealand (166°E to 179°E, 48°S to 34°S)
- **Resolution**: Up to ~19m per pixel at max zoom (comparable to SRTM 1-arc-second)
- **Outside NZ**: Returns sea-level (0m HAE) tiles

### Caching
- Tiles are cached for 24 hours (elevation data is static)
- Sea-level tiles are generated once and reused
- LINZ source tiles are cached separately from output tiles

## Data Source

[LINZ NZ Elevation](https://basemaps.linz.govt.nz/) — Terrain-RGB tiles derived from NZ LiDAR and 8m DEM data.

[NZGeoid2016](https://www.linz.govt.nz/guidance/geodetic-system/coordinate-systems-used-new-zealand/vertical-datums/gravity-and-geoid/new-zealand-quasigeoid-2016-nzgeoid2016) — NZ quasigeoid model (GTX format, 15MB, 1-arcminute grid).

© LINZ CC BY 4.0

## Configuration

### S3 Config (Recommended)
The LINZ API key is loaded from S3 at startup:

**S3 Key**: `Utils-Terrain-Proxy-Config.json`

**Format**:
```json
{
  "apikey": "your-linz-api-key"
}
```

The `CONFIG_BUCKET` and `CONFIG_KEY` environment variables are set automatically by CDK.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `CONFIG_BUCKET` | S3 bucket for config file | Set by CDK |
| `CONFIG_KEY` | S3 key for config file | `Utils-Terrain-Proxy-Config.json` |
| `LINZ_API_KEY` | LINZ Basemaps API key (fallback if S3 not configured) | Required |
| `AWS_REGION` | AWS region for S3 access | `ap-southeast-2` |
