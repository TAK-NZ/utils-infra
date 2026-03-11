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
- **Update Frequency**: 10 minutes
- **Rate Limit**: Based on API key configuration
- **Fallback**: Automatically falls back to RainViewer if unavailable

## Endpoints

### Get Weather Radar Tiles
```
GET /weather-radar/{z}/{x}/{y}.png
```

**Parameters:**
- `z` - Zoom level (0-9)
  - RainViewer: native data at z0-7, z8-9 are upscaled from z7
  - Rainbow.ai: native data at all zoom levels
- `x` - Tile X coordinate
- `y` - Tile Y coordinate

**Query Parameters:**
- `provider` - Data provider: `rainviewer` (default) or `rainbow`
- `api` - API key (required for Rainbow.ai provider)
- `size` - Tile size: `256` (default) or `512`
- `smooth` - Smoothing: `0` (default, no smoothing) or `1` (smoothed)
- `snow` - Snow overlay: `0` (default, no snow) or `1` (with snow)
- `forecast` - Forecast minutes ahead: `0-240` (Rainbow.ai only, default: `0`)
- `color` - Color scheme: `0-8, 10` (default: `2`)
  - `0` - dBZ values with automatic MetService color mapping
  - `1` - Original RainViewer
  - `2` - Universal Blue (default)
  - `3` - TITAN
  - `4` - The Weather Channel
  - `5` - Meteored
  - `6` - NEXRAD Level-III
  - `7` - RAINBOW @ SELEX-SI
  - `8` - Dark Sky
  - `10` - Rainbow.ai native color scheme (Rainbow.ai only)

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

# Original RainViewer color scheme
https://utils.tak.nz/weather-radar/5/10/15.png?color=1

# NEXRAD Level-III color scheme
https://utils.tak.nz/weather-radar/5/10/15.png?color=6

# Rainbow.ai native color scheme (premium only)
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&color=10

# All options combined with Rainbow.ai
https://utils.tak.nz/weather-radar/5/10/15.png?provider=rainbow&api=your-key&size=512&smooth=1&snow=1&color=0&forecast=60
```

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
  "message": "color parameter must be 0-8, 10 (0=MetService, 1-8=RainViewer schemes, 10=Rainbow.ai native)"
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

### Provider-Specific Color Schemes (color=1-8)

#### RainViewer Color Schemes
RainViewer uses numeric color schemes (1-8):
- **1**: Original RainViewer colors
- **2**: Universal Blue (default) - widely compatible
- **3**: TITAN - high contrast for severe weather
- **4**: The Weather Channel - familiar TV weather colors
- **5**: Meteored - European weather service style
- **6**: NEXRAD Level-III - US National Weather Service standard
- **7**: RAINBOW @ SELEX-SI - radar manufacturer colors
- **8**: Dark Sky - minimalist dark theme

#### Smart Color Mapping
Our service provides **intelligent color mapping** to ensure consistent visual experience across providers:

| Our Color | Description | RainViewer | Rainbow.ai | Visual Result |
|-----------|-------------|------------|------------|---------------|
| `0` | MetService colors | `color=0` + processing | `color=dbz_u8` + processing | Identical NZ colors |
| `1` | Original | `color=1` | `color=5` (RainViewer) | Similar original style |
| `2` | Universal Blue | `color=2` | `color=8` (RV Universal Blue) | Identical blue theme |
| `3` | TITAN | `color=3` | `color=7` (Titan) | Identical high contrast |
| `4` | Weather Channel | `color=4` | `color=1` (TWC) | Similar TV weather style |
| `5` | Meteored | `color=5` | `color=3` (Meteored) | Identical European style |
| `6` | NEXRAD Level-III | `color=6` | `color=4` (Nexrad) | Identical US weather service |
| `7` | RAINBOW @ SELEX-SI | `color=7` | `color=6` (Selex) | Identical radar manufacturer |
| `8` | Dark Sky | `color=8` | `color=2` (Dark Sky) | Identical minimalist theme |
| `10` | Rainbow.ai native | `color=2` (fallback) | `color=0` (Rainbow) | Rainbow.ai's unique palette |

**Benefits:**
- **Consistent UX**: Same color parameter gives visually similar results
- **Provider Transparency**: Users don't need to know provider differences
- **Best Match**: Automatically selects the closest visual equivalent
- **Fallback Safe**: Graceful handling of unsupported combinations

For detailed specifications:
- [RainViewer Color Schemes](https://www.rainviewer.com/api/color-schemes.html)
- [Rainbow.ai Color Options](https://doc.rainbow.ai/tile_colors/)

## Integration Notes

- **Caching**: Tiles are cached for 10 minutes
- **Zoom Limits**: RainViewer natively supports z0-7; zoom levels 8-9 are served by cropping and upscaling the z7 ancestor tile. Rainbow.ai supports all zoom levels natively
- **Attribution**: Weather data provided by RainViewer.com or Rainbow.ai
- **CORS**: Cross-origin requests are supported
- **Retry Logic**: Service automatically retries failed requests
- **Fallback**: Rainbow.ai automatically falls back to RainViewer on failure
- **Transparent Tiles**: Returns transparent tiles on data unavailability
- **Provider Selection**: Use `provider` parameter to choose data source

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
| **Native Resolution** | 256x256, 512x512 | 256x256 only |
| **Size Support** | Native 512x512 | Upscaled to 512x512 |
| **Update Frequency** | 10 minutes | 10 minutes |
| **Fallback** | None | Falls back to RainViewer |
| **Cost** | Free | Premium |
| **MetService Colors** | ✅ | ✅ |
| **Forecast Capability** | None | 0-240 minutes ahead |
| **Color Schemes** | Numeric (0-8) | Numeric (0-8, 10) |
| **Color System** | RainViewer native | 0=dbz_u8, 1-8=numeric, 10=native |