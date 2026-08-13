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
- `color` - Color scheme (default: `2`)
  - `0` - dBZ values with automatic MetService color mapping (both providers; not applicable to `layer=clouds`)
  - `2` - Universal Blue (default, RainViewer's only supported scheme)
  - `1, 3-8` - Additional schemes (Rainbow.ai only; mapped to Universal Blue on RainViewer)
  - `10` - Rainbow.ai native color scheme (Rainbow.ai only)
  - Not accepted at all when `layer=clouds` (Rainbow.ai's clouds layer has no color palette)

  > **Note**: As of 2025, RainViewer only supports color scheme `2` (Universal Blue). Color values `1, 3-8` are still accepted but will render as Universal Blue when using the RainViewer provider. These schemes remain fully functional with the Rainbow.ai provider.

**Examples:**
```bash
# Basic radar tile (RainViewer, Universal Blue color scheme)
https://utils.tak.nz/weather-radar/5/10/15.png

# Rainbow.ai provider with API key
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key

# High resolution with smoothing (RainViewer)
https://utils.tak.nz/weather-radar/5/10/15.png?size=512&smooth=1

# Rainbow.ai with MetService colors
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=0

# Rainbow.ai 30-minute forecast
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&forecast=30

# Rainbow.ai 2-hour forecast for flight planning
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&forecast=120

# With snow overlay (RainViewer)
https://utils.tak.nz/weather-radar/5/10/15.png?snow=1

# MetService colors (dBZ values with NZ-style colors)
https://utils.tak.nz/weather-radar/5/10/15.png?color=0

# Universal Blue color scheme (RainViewer's only supported scheme)
https://utils.tak.nz/weather-radar/5/10/15.png?color=2

# NEXRAD Level-III color scheme (Rainbow.ai only, falls back to Universal Blue on RainViewer)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=6

# Rainbow.ai native color scheme (premium only)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=10

# All options combined with Rainbow.ai
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&size=512&smooth=1&snow=1&color=0&forecast=60

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

Requesting a parameter that a layer doesn't support returns a `400 Bad Request` (e.g. `?layer=clouds&color=0` or `?layer=precip&use_precip_type=1`).

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
  "message": "color parameter must be 0-8, 10 (0=MetService, 2=Universal Blue, 1/3-8=Rainbow.ai only, 10=Rainbow.ai native)"
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

## Color Schemes

The weather-proxy service supports multiple color schemes for radar visualization:

### MetService Colors (color=0)
When using `color=0`, the service automatically applies New Zealand MetService-style colors to dBZ radar data, providing a familiar look for New Zealand users. This works with both providers:
- **RainViewer**: Uses RainViewer's dBZ color scheme (color=0) and applies MetService colors
- **Rainbow.ai**: Fetches raw dBZ data (`color=dbz_u8`) and applies MetService color mapping

### Provider-Specific Color Schemes

#### RainViewer Color Schemes
As of 2025, RainViewer only supports a single color scheme:
- **2**: Universal Blue - the only available RainViewer color scheme

All other color values (1, 3-8) are accepted for backward compatibility but will render as Universal Blue when using the RainViewer provider.

#### Rainbow.ai Color Schemes
Rainbow.ai continues to support multiple color schemes via the smart mapping below.

#### Smart Color Mapping
Our service provides **intelligent color mapping** to ensure consistent visual experience across providers:

| Our Color | Description | RainViewer | Rainbow.ai | Visual Result |
|-----------|-------------|------------|------------|---------------|
| `0` | MetService colors | Universal Blue + processing | `color=dbz_u8` + processing | Identical NZ colors |
| `1` | Original | Universal Blue | `color=5` (RainViewer) | Original style (Rainbow.ai only) |
| `2` | Universal Blue | Universal Blue | `color=8` (RV Universal Blue) | Identical blue theme |
| `3` | TITAN | Universal Blue | `color=7` (Titan) | High contrast (Rainbow.ai only) |
| `4` | Weather Channel | Universal Blue | `color=1` (TWC) | TV weather style (Rainbow.ai only) |
| `5` | Meteored | Universal Blue | `color=3` (Meteored) | European style (Rainbow.ai only) |
| `6` | NEXRAD Level-III | Universal Blue | `color=4` (Nexrad) | US weather service (Rainbow.ai only) |
| `7` | RAINBOW @ SELEX-SI | Universal Blue | `color=6` (Selex) | Radar manufacturer (Rainbow.ai only) |
| `8` | Dark Sky | Universal Blue | `color=2` (Dark Sky) | Minimalist theme (Rainbow.ai only) |
| `10` | Rainbow.ai native | Universal Blue (fallback) | `color=0` (Rainbow) | Rainbow.ai's unique palette |

**Benefits:**
- **Consistent UX**: Same color parameter gives visually similar results
- **Provider Transparency**: Users don't need to know provider differences
- **Best Match**: Automatically selects the closest visual equivalent
- **Fallback Safe**: Graceful handling of unsupported combinations

For detailed specifications:
- [RainViewer Color Schemes](https://www.rainviewer.com/api/color-schemes.html)
- [Rainbow.ai Color Options](https://doc.rainbow.ai/tile_colors/)

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
| **MetService Colors** | ✅ | ✅ (not applicable to `clouds`) |
| **Forecast Capability** | None | 0-240 minutes ahead (`precip`/`precip-global` only) |
| **Color Schemes** | Universal Blue only (color=2) | Numeric (0-8, 10) |
| **Color System** | Single scheme (Universal Blue) | 0=dbz_u8, 1-8=numeric, 10=native |