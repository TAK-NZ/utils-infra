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
GET /terrain/t3-taknz-elevation-manifest.json
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
Add as a terrain source using the manifest URL. An API key is required, and the manifest carries it into the tile URLs:
```
https://terrain.{domain}/terrain/t3-taknz-elevation-manifest.json?api=your-key
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
- Tiles are sent with `Cache-Control: public, max-age=86400, immutable`, so CloudFront and clients cache them for 24 hours (elevation data is static)
- Sea-level tiles (outside NZ, or open ocean where LINZ has no data) are generated once and reused
- LINZ source tiles are cached separately from output tiles
- Each Lambda execution environment also keeps an in-memory cache (at most 1000 entries, expiring after an hour). It is not shared between environments, so a burst of uncached tiles can make more LINZ requests than a single long-running server did.

### When LINZ cannot supply a tile

A terrain tile is built from one or more LINZ source tiles. The proxy never substitutes made-up elevation for source data it failed to get, because clients would treat it as real elevation and caches would keep it.

| LINZ response | Result |
|---------------|--------|
| Tile returned | Used |
| No data (HTTP `404`) | Treated as elevation 0 m, which is correct for open ocean. The output tile is still a normal, cacheable `200` |
| Anything else: bad or expired API key (`400`/`401`/`403`), rate limiting (`429`), LINZ errors (`5xx`), timeout, network error, unreadable tile | The whole output tile fails with `503`, `Cache-Control: no-store` and `Retry-After: 5` (`500` for an unexpected internal error). Source tiles that did arrive stay cached, so a retry only refetches the missing ones |

CloudFront caches a `5xx` response for only a few seconds (its default), so a client can retry almost immediately. Each failure is logged with the LINZ status (never the URL, which holds the API key). If a bad key starts producing `503`s for ocean or coastal tiles, check the config object in S3.

If LINZ turns out to signal "no data" with a status other than `404`, set `LINZ_NO_DATA_STATUSES` (for example `404,410`) rather than changing the code.

## Architecture

terrain-proxy runs as an AWS Lambda function, not an ECS container. The request path is:

```
TAK client -> CloudFront (API key check, tile cache) -> ALB (host header rule) -> Lambda (container image)
```

- `server.js` is the Express app. `lambda.js` is the Lambda entry point: it adapts ALB events with [`serverless-http`](https://github.com/dougmoscrop/serverless-http) and returns PNG tiles base64 encoded, as the ALB requires. `node server.js` still runs the same app as a plain server for local development.
- The first request in each execution environment loads the LINZ API key from S3 and the geoid model. If the S3 read fails, that request gets a `503` and the next request tries again.
- The ALB target group has no health check (Lambda targets have none by default). `/terrain/health` is still served, through CloudFront.
- The CDK construct is `lib/constructs/terrain-proxy.ts`. The ALB rule, CloudFront distribution, certificate and DNS records keep the resource IDs they had when this ran on ECS.

### Deployment settings

`terrainProxy` in `cdk.json` (per environment):

| Setting | Description |
|---------|-------------|
| `enabled` | Deploys the function, ALB rule, CloudFront distribution and DNS records |
| `hostname` | Hostname label under the hosted zone, for example `terrain` |
| `priority` | ALB listener rule priority; must be unique (terrain is `5`) |
| `imageTag` | Version label. The build workflows push `utils-terrain-proxy-<imageTag>` and skip the build if that tag already exists in ECR, so **bump it whenever `terrain-proxy/` changes** |
| `memorySize` | Function memory in MB (1024). Lambda scales CPU with memory, and a tile is mostly CPU work |
| `timeoutSeconds` | Function timeout (30). Must stay below the 60 s ALB idle timeout |
| `reservedConcurrency` | Optional cap on parallel executions, to limit how hard a burst of uncached tiles hits the LINZ API |

The image is built from `terrain-proxy/Dockerfile` (Lambda Node.js 24 base image). With `usePreBuiltImages=true` (CI, prod) the build workflows push it to ECR and pass the tag in `imageTagsJson["terrain-proxy"]`. With `usePreBuiltImages=false` the deploy builds it; use `BUILDX_NO_DEFAULT_ATTESTATIONS=1`, because Lambda rejects images with attestation manifests.

Do not also list `terrain-proxy` under `containers`: the stack refuses to synthesize with both.

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

The `CONFIG_BUCKET` and `CONFIG_KEY` environment variables are set automatically by CDK. The function can read that one object and nothing else in the config bucket.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port (only used by `node server.js`, not on Lambda) | `3000` |
| `CONFIG_BUCKET` | S3 bucket for config file | Set by CDK |
| `CONFIG_KEY` | S3 key for config file | `Utils-Terrain-Proxy-Config.json` |
| `LINZ_API_KEY` | LINZ Basemaps API key (fallback if S3 not configured) | Required |
| `AWS_REGION` | AWS region for S3 access (set by Lambda) | `ap-southeast-2` |
| `LINZ_NO_DATA_STATUSES` | Comma-separated LINZ HTTP statuses that mean "no elevation data here" (treated as 0 m). Every other non-OK status is a failure (`503`) | `404` |
| `TILE_CACHE_MAX_KEYS` | Maximum entries in the in-memory tile cache (CDK sets `1000` on Lambda) | `50000` |
| `TILE_CACHE_TTL_SECONDS` | Expiry of cache entries in seconds, 0 for none (CDK sets `3600` on Lambda) | `0` |
