# Weather Proxy Service

The weather-proxy service provides access to real-time weather radar data from multiple providers including RainViewer (public access) and Rainbow.ai (premium access with API key).

## Base URL
```
https://utils.{domain}/weather-radar/
```

## Providers

### RainViewer (Default)
- **Access**: Public (no API key required)
- **Coverage**: Global radar data
- **Update Frequency**: 10 minutes
- **Rate Limit**: 600 requests/minute per IP

### Rainbow.ai (Premium)
- **Access**: Requires API key
- **Coverage**: Enhanced global radar data
- **Layers**: `precip` (default), `precip-global`, `clouds`, `radars` (see [Rainbow.ai Layers](#rainbowai-layers) below)
- **Update Frequency**: 10 minutes
- **Rate Limit**: Based on API key configuration
- **Fallback**: Precipitation layers (`precip`, `precip-global`) automatically fall back to RainViewer if unavailable. `clouds` and `radars` have no RainViewer equivalent, so they return a transparent tile on failure instead

## Endpoints

### Get Weather Radar Tiles
```
GET /weather-radar/{z}/{x}/{y}.png
```

**Parameters:**
- `z` - Zoom level (0-9)
  - RainViewer: native data at z0-7, z8-9 are upscaled from z7
  - Rainbow.ai `precip` / `precip-global`: native data up to z12 (we cap requests at z9)
  - Rainbow.ai `clouds` / `radars`: native data at z0-7, z8-9 are upscaled from z7
- `x` - Tile X coordinate
- `y` - Tile Y coordinate

**Query Parameters:**
- `provider` - Data provider: `rainviewer` (default) or `rainbow`
- `layer` - Rainbow.ai layer: `precip` (default), `precip-global`, `clouds`, or `radars`. Only valid when `provider=rainbow`; RainViewer always serves precipitation radar. See [Rainbow.ai Layers](#rainbowai-layers) below for per-layer parameter support
- `api` - API key (required for Rainbow.ai provider)
- `size` - Tile size: `256` (default) or `512`
- `smooth` - Smoothing: `0` (default, no smoothing) or `1` (smoothed) - RainViewer only
- `snow` - Snow overlay: `0` (default, no snow) or `1` (with snow) - RainViewer only
- `forecast` - Forecast minutes ahead: `0-240` (Rainbow.ai `precip`/`precip-global` only, default: `0`)
- `coverage` - Coverage mask overlay: `0` (default) or `1` (Rainbow.ai `precip`, `precip-global`, `radars` only)
- `use_precip_type` - Precipitation-type visualization instead of reflectivity: `0` (default) or `1` (Rainbow.ai `radars` only)
- `color` - Rainbow.ai color palette code (default: `0`). Accepted values: `0`-`9`, `dbz_u8`. See [Rainbow.ai Colors](#rainbowai-colors) below for what each value renders. Ignored by RainViewer (always renders Universal Blue) and rejected when `layer=clouds` (no color palette for that layer)

**Examples:**
```bash
# Basic radar tile (RainViewer, Universal Blue color scheme)
https://utils.tak.nz/weather-radar/5/10/15.png

# Rainbow.ai provider with API key
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key

# High resolution with smoothing (RainViewer)
https://utils.tak.nz/weather-radar/5/10/15.png?size=512&smooth=1

# Rainbow.ai with the default "Rainbow" palette
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=0

# Rainbow.ai 30-minute forecast
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&forecast=30

# Rainbow.ai 2-hour forecast for flight planning
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&forecast=120

# With snow overlay (RainViewer)
https://utils.tak.nz/weather-radar/5/10/15.png?snow=1

# Rainbow.ai Titan color scheme
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=7

# Rainbow.ai raw dBZ reflectivity values (no color rendering)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=dbz_u8

# All options combined with Rainbow.ai
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&size=512&smooth=1&snow=1&color=7&forecast=60

# Rainbow.ai global precipitation layer
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&layer=precip-global

# Rainbow.ai cloud cover layer (no color/forecast/coverage params)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&layer=clouds

# Rainbow.ai radars layer with precipitation-type visualization
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&layer=radars&use_precip_type=1

# Rainbow.ai precip-global with coverage mask overlay
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&layer=precip-global&coverage=1
```

### Rainbow.ai Layers

The `layer` parameter selects which Rainbow.ai data product to serve. It only applies to `provider=rainbow`; RainViewer has no equivalent for `clouds` or `radars`.

| Layer | Description | Native Zoom | `color` | `forecast` | `coverage` | `use_precip_type` |
|-------|--------------|-------------|---------|-------------|------------|--------------------|
| `precip` (default) | Precipitation map, regional coverage | 0-12 | ✅ | ✅ (0-240 min) | ✅ | ❌ |
| `precip-global` | Precipitation map, global coverage | 0-12 | ✅ | ✅ (0-240 min) | ✅ | ❌ |
| `clouds` | Cloud cover map | 0-7 (upscaled to z9) | ❌ | ❌ | ❌ | ❌ |
| `radars` | Radar reflectivity map | 0-7 (upscaled to z9) | ✅ | ❌ | ✅ | ✅ |

Requesting a parameter that a layer doesn't support returns a `400 Bad Request` (e.g. `?layer=clouds&color=2` or `?layer=precip&use_precip_type=1`).

### Rainbow.ai Colors

The `color` parameter passes Rainbow.ai's own palette codes straight through to their API — no translation. See [doc.rainbow.ai/tile_colors](https://doc.rainbow.ai/tile_colors/) for a visual preview of each option.

| Value | Name | Notes |
|-------|------|-------|
| `0` (default) | Rainbow | Rainbow.ai's default rainbow-style palette |
| `1` | TWC | Inspired by The Weather Channel |
| `2` | Dark Sky | Based on RainViewer's Dark Sky scheme |
| `3` | Meteored | Based on RainViewer's Meteored palette |
| `4` | Nexrad | NEXRAD Level III style from RainViewer |
| `5` | Rainviewer | RainViewer's color palette |
| `6` | Selex | Rainbow @ SELEX-IS palette from RainViewer |
| `7` | Titan | TITAN color scheme from RainViewer |
| `8` | Rainviewer Universal Blue | RainViewer's original palette |
| `9` | Rainviewer TWC | RainViewer's TWC palette |
| `dbz_u8` | Raw dBZ values | Encodes raw reflectivity (-32 to +95 dBZ) in the red channel instead of rendering a color; snow is flagged via the top bit. See Rainbow's docs for the decode formula |

`color` only applies to `provider=rainbow`, and is not accepted for `layer=clouds`. RainViewer ignores `color` entirely — it only renders a single palette (Universal Blue) as of 2025.

### Health Check
```
GET /weather-radar/health
```

Returns service status and cache statistics.

## Rate Limiting
- **RainViewer (Public)**: 600 requests per minute per IP address
- **Rainbow.ai (Premium)**: Custom limits per API key
- **API Key-based**: Custom limits per API key (when configured)
- **Response**: HTTP 429 when exceeded
- **Precedence**: API key limits take precedence over IP limits

## Error Responses

**400 Bad Request** - Invalid parameters
```json
{
  "error": "Invalid parameter",
  "message": "color parameter must be one of: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, dbz_u8 (Rainbow.ai palette codes, see https://doc.rainbow.ai/tile_colors/). Ignored by RainViewer."
}
```

```json
{
  "error": "Invalid parameter",
  "message": "layer=clouds is only supported with provider=rainbow"
}
```

**401 Unauthorized** - Invalid API key or missing API key for Rainbow.ai
```json
{
  "error": "API key required for Rainbow.ai provider",
  "message": "Use ?api=your-key parameter"
}
```

**403 Forbidden** - API key lacks provider access
```json
{
  "error": "Forbidden",
  "message": "API key does not have access to rainbow provider"
}
```

**404 Not Found** - Tile not available
```json
{
  "error": "Tile not found",
  "message": "Weather data not available for this location"
}
```

**429 Too Many Requests** - Rate limit exceeded
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests, please try again later"
}
```

**500 Service Error** - Service unavailable
```json
{
  "error": "Service unavailable",
  "message": "Weather service temporarily unavailable"
}
```

## Integration Notes

- **Caching**: Tiles are cached server-side for 10 minutes (`Cache-Control: max-age=600`), matching provider update frequency. Client polling faster than this (e.g. the display kiosk polls every 5 minutes) reduces the worst-case staleness of displayed data but does not get newer tiles than the last provider update
- **Zoom Limits**: RainViewer natively supports z0-7; zoom levels 8-9 are served by cropping and upscaling the z7 ancestor tile. Rainbow.ai `precip`/`precip-global` support up to z12 natively (requests are capped at z9). Rainbow.ai `clouds`/`radars` natively support z0-7, with z8-9 upscaled the same way as RainViewer
- **Attribution**: Weather data provided by RainViewer.com or Rainbow.ai
- **CORS**: Cross-origin requests are supported
- **Retry Logic**: Service automatically retries failed requests
- **Fallback**: Rainbow.ai `precip`/`precip-global` automatically fall back to RainViewer on failure. `clouds`/`radars` have no RainViewer equivalent and return a transparent tile on failure instead
- **Transparent Tiles**: Returns transparent tiles on data unavailability
- **Provider Selection**: Use `provider` parameter to choose data source
- **Layer Selection**: Use `layer` parameter (Rainbow.ai only) to choose between `precip`, `precip-global`, `clouds`, and `radars`

## API Key Configuration

The weather-proxy service supports two types of API keys:

### RainViewer API Keys (Optional)
For enhanced rate limits with RainViewer provider.

### Premium API Keys (Required for Rainbow.ai)
For access to Rainbow.ai provider with custom rate limits and provider permissions.

**S3 Location**: `s3://{config-bucket}/Utils-Weather-Proxy-Api-Keys.json`

**File Format**:
```json
{
  "rainviewer": {
    "primary": {
      "key": "your-rainviewer-api-key",
      "comment": "RainViewer API key for enhanced limits",
      "rateLimit": 10000,
      "enabled": true
    }
  },
  "apiKeys": {
    "premium-user-1": {
      "key": "user-api-key-1",
      "comment": "Premium user with Rainbow.ai access",
      "rateLimit": 2000,
      "providers": ["rainviewer", "rainbow"],
      "enabled": true
    },
    "basic-user-1": {
      "key": "user-api-key-2",
      "comment": "Basic user - RainViewer only",
      "rateLimit": 1000,
      "providers": ["rainviewer"],
      "enabled": true
    }
  },
  "rainbow": {
    "apiKey": "rainbow-service-api-key",
    "comment": "Rainbow.ai service API key"
  },
  "metadata": {
    "lastUpdated": "2024-01-15T10:30:00Z",
    "updatedBy": "admin@tak.nz",
    "notes": "Rotate keys quarterly"
  }
}
```

**Key Features**:
- **Provider Access Control**: Specify which providers each API key can access
- **Tiered Access**: Different users can have different provider permissions
- **Per-Key Rate Limits**: Individual rate limits for each API key
- **Rainbow.ai Integration**: Service-level API key for Rainbow.ai backend
- **Comments**: Documentation for each key's purpose and limits
- **Enable/Disable**: Control key usage without removing from file
- **Graceful Fallback**: Service continues in public mode if S3 config unavailable

**Usage Examples**:
```bash
# Public access (RainViewer only)
https://utils.tak.nz/weather-radar/5/10/15.png

# Premium access (Rainbow.ai with API key)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=premium-key

# Enhanced RainViewer access with API key
https://utils.tak.nz/weather-radar/5/10/15.png?api=basic-key
```

## Provider Comparison

| Feature | RainViewer | Rainbow.ai |
|---------|------------|------------|
| **Data Source** | Real-time ground radar | Weather model predictions |
| **Detail Level** | High (actual radar) | Lower (modeled data) |
| **Access** | Public | API Key Required |
| **Rate Limit** | 600/min per IP | Custom per key |
| **Coverage** | Global | Enhanced Global |
| **Layers** | Precipitation radar only | `precip`, `precip-global`, `clouds`, `radars` |
| **Native Resolution** | 256x256, 512x512 | 256x256 only |
| **Size Support** | Native 512x512 | Upscaled to 512x512 |
| **Native Zoom** | z0-7 (z8-9 upscaled) | `precip`/`precip-global`: z0-12; `clouds`/`radars`: z0-7 (z8-9 upscaled) |
| **Update Frequency** | 10 minutes | 10 minutes |
| **Fallback** | None | `precip`/`precip-global` fall back to RainViewer; `clouds`/`radars` do not |
| **Cost** | Free | Premium |
| **Forecast Capability** | None | 0-240 minutes ahead (`precip`/`precip-global` only) |
| **Color Schemes** | Universal Blue only, `color` ignored | 10 palettes + raw dBZ, see [Rainbow.ai Colors](#rainbowai-colors) |