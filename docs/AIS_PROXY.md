# AIS Proxy Service

The ais-proxy service provides AISHub-compatible access to real-time AIS vessel data from AISStream.

## Base URL
```
https://utils.{domain}/ais-proxy/
```

## Endpoints

### Get Vessel Data
```
GET /ais-proxy/ws.php?username={api_key}&latmin={lat}&latmax={lat}&lonmin={lon}&lonmax={lon}
```

**Parameters:**
- `username` - Your API key for authentication
- `latmin` - Minimum latitude (decimal degrees)
- `latmax` - Maximum latitude (decimal degrees)
- `lonmin` - Minimum longitude (decimal degrees)
- `lonmax` - Maximum longitude (decimal degrees)

**Example:**
```bash
# Get vessels in New Zealand waters
https://utils.tak.nz/ais-proxy/ws.php?username=your-api-key&latmin=-48&latmax=-34&lonmin=166&lonmax=179
```

**Response:**
```json
{
  "VESSELS": [
    {
      "MMSI": 123456789,
      "TIME": "2024-01-15 10:30:00 UTC",
      "LONGITUDE": 174.7633,
      "LATITUDE": -36.8485,
      "COG": 45.2,
      "SOG": 12.5,
      "HEADING": 47,
      "NAVSTAT": 0,
      "IMO": 9876543,
      "NAME": "VESSEL NAME",
      "CALLSIGN": "ABC123",
      "TYPE": 70,
      "A": 100,
      "B": 20,
      "C": 15,
      "D": 5,
      "DRAUGHT": 8.5,
      "DEST": "AUCKLAND",
      "ETA": "01/15 14:30"
    }
  ]
}
```

### Upload AIS Data
```
POST /ais-proxy/jsonais/{api_key}
```

Upload AIS data from AIS receivers. Supports multiple formats including AIS-catcher HTTP output modes and JSONAIS protocol.

**Parameters:**
- `api_key` - Your API key embedded in the URL path

**Supported Formats:**

**1. AIS-catcher AISCATCHER format (msgs array):**
```json
{
  "msgs": [
    {
      "mmsi": 123456789,
      "lat": -36.8485,
      "lon": 174.7633,
      "course": 45.2,
      "speed": 12.5,
      "heading": 47,
      "status": 0,
      "rxtime": "20241108221500"
    }
  ]
}
```

**2. AIS-catcher MINIMAL format:**
```json
{
  "mmsi": 123456789,
  "lat": -36.8485,
  "lon": 174.7633,
  "course": 45.2,
  "speed": 12.5,
  "heading": 47,
  "status": 0,
  "rxtime": "20241108221500"
}
```

**3. AIS-catcher APRS format:**
```json
{
  "call": "123456789",
  "lat": -36.8485,
  "lng": 174.7633,
  "course": 45.2,
  "speed": 12.5,
  "heading": 47,
  "status": 0,
  "time": "2024-11-08T22:15:00Z"
}
```

**4. JSONAIS protocol format (for other software compatibility):**
```json
{
  "protocol": "jsonais",
  "encodetime": "20241108221500",
  "groups": [
    {
      "path": [{"name": "RECEIVER", "url": "http://example.com/"}],
      "msgs": [
        {
          "msgtype": "18",
          "mmsi": 123456789,
          "lat": -36.8485,
          "lon": 174.7633,
          "course": 45.2,
          "speed": 12.5,
          "heading": 47,
          "status": 0,
          "rxtime": "20241108221500"
        }
      ]
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "processed": 1,
  "errors": 0,
  "total": 1,
  "clientId": "j3k4",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Client Status
```
GET /ais-proxy/status?username={api_key}
```

View status of all AIS upload clients that have provided data in the last 24 hours.

**Response:**
```json
{
  "activeClients": [
    {
      "clientId": "j3k4",
      "lastSeen": "2024-01-15T10:30:00.000Z",
      "totalMessages": 1250,
      "lastMessageCount": 15,
      "hoursAgo": 0.5
    }
  ],
  "totalActiveClients": 1,
  "timeWindow": "24 hours",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Health Check
```
GET /ais-proxy/health
```

Returns service status and configuration information.

## Rate Limiting
- **Query endpoints**: 600 requests per minute per IP address (default)
- **Upload endpoints**: 100 uploads per minute per API key
- **API Key-based**: Custom limits per API key (when configured)
- **Response**: HTTP 429 when exceeded

## Error Responses

**Invalid API Key or Missing Parameters:**
```json
{
  "ERROR": true
}
```

**Rate Limit Exceeded:**
```json
{
  "ERROR": true,
  "MESSAGE": "API key rate limit exceeded (1000/min)"
}
```

## API Key Configuration

The ais-proxy service loads API keys from S3 for user authentication and AISStream connectivity.

### AISStream Configuration

**S3 Location**: `s3://{config-bucket}/Utils-AIS-Proxy-Api-Keys.json`

**File Format:**
```json
{
  "aisstream": {
    "primary": {
      "key": "your-aisstream-api-key-here",
      "comment": "Primary AISStream API key",
      "enabled": true
    },
    "backup": {
      "key": "your-backup-aisstream-key-here",
      "comment": "Backup AISStream API key",
      "enabled": false
    }
  },

  "aisProviders": ["aisstream", "openwaters"],
  "openwaters": {
    "primary": {
      "key": "your-open-waters-personal-token-here",
      "comment": "Open Waters AIS personal token",
      "enabled": true
    }
  },
  "users": {
    "primary": {
      "key": "user-api-key-1",
      "comment": "Primary user API key - high rate limit",
      "rateLimit": 10000,
      "enabled": true
    },
    "secondary": {
      "key": "user-api-key-2",
      "comment": "Secondary user API key - lower limits",
      "rateLimit": 1000,
      "enabled": true
    },
    "development": {
      "key": "dev-api-key",
      "comment": "Development/testing key",
      "rateLimit": 500,
      "enabled": false
    }
  },
  "metadata": {
    "lastUpdated": "2024-01-15T10:30:00Z",
    "updatedBy": "admin@tak.nz",
    "notes": "Rotate keys quarterly"
  }
}
```

**Key Features:**
- **AISStream Keys**: Primary/backup keys for connecting to AISStream service
- **Upstream Providers (`aisProviders`)**: Array of `"aisstream"` and/or `"openwaters"`. Every listed provider is connected at the same time and their data is merged into one vessel set. Default (setting missing) is `["aisstream"]`. The older single value `"aisProvider": "openwaters"` is still read when `aisProviders` is absent. Both providers use the aisstream.io protocol; `openwaters` connects to `wss://ais.openwaters.io/v0/stream` using the token in `openwaters.primary.key` (or `openwaters.backup.key`). The config is cached for up to an hour and checked every 5 minutes, so adding or removing a provider takes effect without a restart (within about an hour).
- **Merging**: Messages are applied in provider-timestamp order. An older report never overwrites the position of a newer one, whichever provider delivered it.
- **Class A/B Stability**: Open Waters sends Class B vessels that were relayed through aggregators as Class A `PositionReport` messages with placeholder values (communication state 0, heading 511, navigational status 15). Once any Class B message (18, 19 or 24) has been seen for a vessel, it stays Class B and its navigational status stays empty. The flag is kept in the identity store, so it survives cache expiry. A vessel that is only ever seen through such a feed cannot be identified as Class B and is reported as Class A.
- **Vessel Names**: Names come from AIS static data first, then the provider's `MetaData.ShipName` (`nameSource: "ais-metadata"`), then Marinesia and the identity store. A name already known is never replaced.
- **Comparing Providers**: `/ais-proxy/v2/health` returns `providerStats` per source (`aisstream`, `openwaters`, and `upload` for client uploads): messages and messages/minute, unique vessels in the window (`?window=minutes`, default 60, max 360), `exclusiveVessels` (seen by that source only), `namedVessels`, and accepted vs stale position updates. Each vessel in `/ais-proxy/v2/vessels` has `providers` (all sources that delivered it) and `lastProvider`. Stale-update counts include duplicates of the same report from the other provider, so read them as indicative.
- **Open Waters Limits**: A personal token allows 2 concurrent streams, 50 messages/s per stream and a 400 sq° subscribed area (the NZ box is ~182 sq°). The proxy uses one stream per environment. A rolling ECS deployment briefly runs two tasks, and sharing one token across environments adds to that, so a separate token per environment is safer.
- **User Keys**: Individual API keys for service users with custom rate limits
- **Per-Key Rate Limits**: Individual rate limits for each user API key
- **Enable/Disable**: Control key usage without removing from file
- **Graceful Fallback**: Service continues in public mode if S3 config unavailable



## Integration Notes

- **Data Sources**: 
  - Real-time AIS data from AISStream or Open Waters WebSocket (selected by `aisProviders`, run side by side)
- **Coverage**: New Zealand waters (configurable bounding box)
- **Caching**: Vessel data cached in memory with 1-hour expiration
- **Persistence**: Cache persisted to disk for service restarts
- **Compatibility**: AISHub-compatible API format (vessels only, no navigation aids)
- **WebSocket**: Maintains persistent connection to AISStream
- **Reconnection**: Automatic reconnection on connection loss
- **Filtering**: Navigation aids are automatically filtered out to maintain AISHub compatibility
- **Name Lookup**: Class B vessel names enhanced via VesselFinder API when not available from AIS
- **Class B Static Data**: Processes AIS Message Type 24 for Class B vessel names and types

## Data Fields

Each vessel record includes:
- **MMSI**: Maritime Mobile Service Identity
- **TIME**: Last update timestamp (UTC)
- **LONGITUDE/LATITUDE**: Current position
- **COG**: Course over ground (degrees)
- **SOG**: Speed over ground (knots)
- **HEADING**: True heading (degrees)
- **NAVSTAT**: Navigational status code
- **IMO**: International Maritime Organization number
- **NAME**: Vessel name
- **CALLSIGN**: Radio call sign
- **TYPE**: Vessel type code
- **A/B/C/D**: Vessel dimensions (meters)
- **DRAUGHT**: Maximum draught (meters)
- **DEST**: Destination
- **ETA**: Estimated time of arrival