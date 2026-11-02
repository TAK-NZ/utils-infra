# AIS Proxy API v2

Enhanced AIS vessel data API with additional fields and metadata.

## Overview

The v2 API provides the same vessel data as the AISHub-compatible v1 API, but with:
- Enhanced vessel information (rate of turn, position accuracy, etc.)
- Metadata about data quality and coverage
- Modern JSON structure with camelCase fields
- Better error handling and status codes

## Endpoints

### GET /ais-proxy/v2/vessels

Returns vessel data with enhanced information and metadata.

**Parameters:**
- `username` (required) - API key for authentication
- `latmin` (optional) - Minimum latitude (default: -48.0)
- `latmax` (optional) - Maximum latitude (default: -34.0)
- `lonmin` (optional) - Minimum longitude (default: 166.0)
- `lonmax` (optional) - Maximum longitude (default: 179.0)
- `include` (optional) - What to include: `vessels` (default), `navigation-aids`, or `all`

**Response:**
```json
{
  "vessels": [
    {
      "mmsi": 123456789,
      "time": "2025-01-02T21:33:00Z",
      "longitude": 174.7633,
      "latitude": -36.8485,
      "cog": 45.2,
      "sog": 12.5,
      "heading": 46,
      "navstat": 0,
      "imo": 9876543,
      "name": "VESSEL NAME",
      "callsign": "ABCD",
      "type": 70,
      "dimensions": {
        "a": 100,
        "b": 20,
        "c": 10,
        "d": 5
      },
      "draught": 8.5,
      "destination": "AUCKLAND",
      "eta": "01/15 14:30",
      "rateOfTurn": -5.2,
      "positionAccuracy": true,
      "timestamp": 45,
      "messageType": "PositionReport",
      "valid": true,
      "lastUpdate": "2025-01-02T21:33:15.123Z",
      "category": "vessel",
      "nameSource": "ais",
      "providers": ["aisstream", "openwaters"],
      "lastProvider": "openwaters",
      "enrichedData": null
    }
  ],
  "metadata": {
    "totalCount": 150,
    "categories": {
      "vessels": 145,
      "navigationAids": 5
    },
    "vesselTypes": {
      "classA": 120,
      "classB": 25,
      "navigationAids": 5,
      "other": 0
    },
    "filters": {
      "applied": "vessels",
      "available": ["vessels", "navigation-aids", "all"]
    },
    "boundingBox": {
      "minLatitude": -48.0,
      "maxLatitude": -34.0,
      "minLongitude": 166.0,
      "maxLongitude": 179.0
    },
    "dataFreshness": {
      "oldestUpdate": "2025-01-02T20:33:00.000Z",
      "newestUpdate": "2025-01-02T21:33:15.123Z"
    },
    "generatedAt": "2025-01-02T21:33:16.000Z",
    "apiVersion": "2.0"
  }
}
```

### GET /ais-proxy/v2/health

Enhanced health check with detailed statistics.

**Response:**
```json
{
  "status": "ok",
  "apiVersion": "2.0",
  "uptime": 3600.5,
  "vessels": {
    "total": 150,
    "classA": 120,
    "classB": 25,
    "other": 5
  },
  "dataFreshness": {
    "oldestUpdate": "2025-01-02T20:33:00.000Z",
    "newestUpdate": "2025-01-02T21:33:15.123Z"
  },
  "configuration": {
    "userKeysConfigured": 5,
    "aisstreamKeyConfigured": true,
    "publicMode": false,
    "configBucket": true,
    "debugMode": false
  },
  "websocket": {
    "connected": true,
    "reconnectAttempts": 0
  },
  "timestamp": "2025-01-02T21:33:16.000Z"
}
```

## Enhanced Fields

The v2 API includes additional fields not available in the AISHub-compatible v1 API:

### Position Data
- `rateOfTurn` - Rate of turn in degrees per minute
- `positionAccuracy` - GPS position accuracy (true = high accuracy)
- `timestamp` - AIS message timestamp (seconds in minute)

### Message Information
- `messageType` - Type of AIS message received
- `valid` - Message validity flag
- `lastUpdate` - When this vessel was last updated in our cache
- `nameSource` - Source of vessel name: `"ais"` (from AIS static data), `"ais-metadata"` (provider `ShipName` on position reports), `"marinesia"`/`"lookup"` (from external API), `"identity-cache"` (previously learned), or `null` (no name)
- `providers` - Sources that have delivered this vessel: `"aisstream"`, `"openwaters"`, `"upload"`
- `lastProvider` - Source of the most recent accepted update
- `enrichedData` - Additional data from external lookup (only present when `nameSource` is `"lookup"`)

### Structured Data
- `dimensions` - Vessel dimensions as an object instead of separate A/B/C/D fields

## Error Responses

The v2 API uses proper HTTP status codes:

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

**429 Rate Limited:**
```json
{
  "error": "Rate limit exceeded",
  "message": "Rate limit exceeded (600/min)"
}
```

## Data Types

The API tracks and reports different maritime objects:

### Vessels
- **Class A** - Commercial vessels with full AIS transponders (includes vessel names)
- **Class B** - Smaller vessels with simplified AIS transponders (names and additional data looked up via external API when missing)

### Enhanced Lookup Data

When vessel data is enriched via external lookup (`nameSource: "lookup"`), additional fields are available:

```json
{
  "mmsi": 512011206,
  "name": "IKA MA",
  "type": 70,
  "nameSource": "lookup",
  "enrichedData": {
    "country": "New Zealand",
    "grossTonnage": 1250,
    "deadweight": 2000,
    "yearBuilt": 2010,
    "typeText": "Cargo ship"
  }
}
```

**Enriched Fields:**
- `country` - Vessel flag state
- `grossTonnage` - Gross tonnage (GT)
- `deadweight` - Deadweight tonnage (DWT)
- `yearBuilt` - Year of construction
- `typeText` - Human-readable vessel type

### Navigation Aids
- **Lighthouses** - Fixed navigation beacons
- **Buoys** - Floating navigation markers
- **Offshore Platforms** - Fixed maritime structures
- **Other Navigation Infrastructure** - Beacons, markers, etc.

## Filtering

Use the `include` parameter to control what data is returned:

**Examples:**
```bash
# Get only vessels (default)
/ais-proxy/v2/vessels?username=key&include=vessels

# Get only navigation aids
/ais-proxy/v2/vessels?username=key&include=navigation-aids

# Get everything
/ais-proxy/v2/vessels?username=key&include=all
```

**Easy Identification:**
Each item includes a `category` field:
- `"vessel"` - Moving vessels (Class A/B)
- `"navigation-aid"` - Fixed maritime infrastructure

**Client-side Filtering:**
```javascript
// Filter to vessels only
const vessels = data.vessels.filter(item => item.category === 'vessel');

// Filter to navigation aids only
const navAids = data.vessels.filter(item => item.category === 'navigation-aid');
```

## Migration from v1

Key differences when migrating from v1 to v2:

1. **Field Names**: Changed to camelCase (e.g., `MMSI` → `mmsi`)
2. **Response Structure**: Vessels are in a `vessels` array with `metadata`
3. **Error Handling**: Uses HTTP status codes instead of `ERROR: true`
4. **Enhanced Data**: Additional fields for position accuracy, rate of turn, etc.
5. **Dimensions**: Grouped into a `dimensions` object

## Rate Limiting

Same rate limiting as v1 API, but with better error messages and HTTP status codes.

## Authentication

Uses the same API key system as v1, but with improved error responses.