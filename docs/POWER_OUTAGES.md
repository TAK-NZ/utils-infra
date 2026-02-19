# Power Outages: NZ Power Outage Data Aggregator

## Overview

Power Outages is a service that scrapes New Zealand Electricity Distribution Board (EDB) websites and converts outage data into a standardized JSON format for integration with TAK (Team Awareness Kit) systems.

**Note**: This service uses a custom NZ-specific data format inspired by standardization concepts, but is not affiliated with or compliant with the ORNL ODIN (Outage Data Initiative Nationwide) standard used in the United States.

## Architecture

```
NZ EDB Websites → Power Outages Service → Standardized JSON → TAK Integration
```

### Components

1. **Power Outages Service**: Scrapes EDB websites, converts to standardized format
2. **TAK ETL Integration**: Consumes outage data, transforms for TAK

### Service Endpoints

- **All Outages**: `/power-outages/outages`
- **Filtered Outages**: `/power-outages/outages?utility=POWERCO_NZ&minCustomers=10&outageType=unplanned`
- **Regional Summary**: `/power-outages/summary`
- **City Aggregation**: `/power-outages/aggregate`
- **Health Check**: `/power-outages/health`
- **Port**: 3000
- **Cache**: 5 minutes (background scraper)
- **Scrape Interval**: Configurable via `SCRAPE_INTERVAL` env var (default: 300000ms / 5 minutes)

### Production Scrapers

- `scrapers/orion.js` - Orion Group outage scraper
- `scrapers/powerco.js` - PowerCo outage scraper
- `scrapers/wellington.js` - Wellington Electricity scraper
- `scrapers/regions.js` - NZ region code mappings (ISO 3166-2:NZ)

### Key Findings

#### Orion Group Analysis
- **Data Source**: JavaScript embedded in outage detail pages
- **Location Data**: Precise coordinates (lat/lng) with centroid and radius
- **Rich Metadata**: Areas, streets, customer counts, timestamps
- **Update History**: Public communications and status changes

#### Raw Data Structure (window.incident)
```javascript
window.incident = {
  IncidentRef: "INCD-27508-P",
  Latitude: -43.7502336688,
  Longitude: 172.6871681114,
  Areas: "Ahuriri, Birdlings Flat, Kaitorete Spit...",
  Streets: "Bayleys Road, Beach Street...",
  TotalNumberOff: 2,
  OutageCause: "Flooding",
  State: "OPEN",  // Filter for active outages only
  EstimatedRestorationTime: "2026-02-20T19:12:00+13:00"
}
```

#### PowerCo Analysis
- **Data Source**: ArcGIS FeatureServer REST API
- **Location Data**: NZTM2000 coordinates (converted to WGS84 using proj4)
- **Customer Count**: `number_of_detail_records` field
- **Outage Type**: Explicit `planned_outage` field (0/1)
- **Metadata**: Feeder, crew status, town, suburb

#### Standardized Output Format (Multi-Utility)
Production service returns standardized JSON format with multi-utility support:
```json
{
  "version": "1.0",
  "timestamp": "2026-02-18T08:00:00.000Z",
  "summary": {
    "totalUtilities": 2,
    "totalOutages": 375,
    "totalCustomersAffected": 1249
  },
  "utilities": [
    {"name": "Orion Group", "id": "ORION_NZ", "status": "ok", "outageCount": 2},
    {"name": "PowerCo", "id": "POWERCO_NZ", "status": "ok", "outageCount": 373}
  ],
  "outages": [
    {
      "outageId": "INCD-27508-P",
      "utility": {"name": "Orion Group", "id": "ORION_NZ"},
      "region": "Canterbury",
      "regionCode": "NZ-CAN",
      "outageStart": "2026-02-17T03:05:10",
      "estimatedRestoration": "2026-02-20T19:12:00+13:00",
      "cause": "Flooding",
      "status": "active",
      "customersAffected": 2,
      "location": {
        "coordinates": {"latitude": -43.7502336688, "longitude": 172.6871681114},
        "areas": ["Ahuriri", "Birdlings Flat"],
        "streets": ["Bayleys Road", "Beach Street"]
      }
    },
    {
      "outageId": "JE26008296",
      "utility": {"name": "PowerCo", "id": "POWERCO_NZ"},
      "region": "Manawatu-Whanganui",
      "regionCode": "NZ-MWT",
      "outageStart": "2026-02-16T10:22:00.000Z",
      "estimatedRestoration": null,
      "cause": "Strong Wind",
      "status": "active",
      "outageType": "unplanned",
      "customersAffected": 8,
      "crewStatus": "Site made safe - restoration in progress",
      "location": {
        "coordinates": {"latitude": -40.18, "longitude": 175.32},
        "areas": ["Santoft", "Bulls"],
        "streets": []
      },
      "metadata": {
        "feeder": "LAKE ALICE",
        "lastUpdate": "2026-02-18T06:44:00.421Z"
      }
    }
  ]
}
```

## Benefits of Standardized Format

1. **Standardization** - Consistent format across all NZ EDBs
2. **NZ-Specific** - Uses ISO 3166-2:NZ region codes and NZ geography
3. **TAK Integration** - Direct feed into situational awareness displays
4. **Scalability** - Easy to add more EDB sources
5. **Rich Metadata** - Includes crew status, feeder info, and detailed locations

## Technical Stack

## Usage

### API Endpoints

#### Health Check
```bash
curl https://utils.tak.nz/power-outages/health
```

Response includes scrape status:
```json
{
  "status": "ok",
  "uptime": 3600,
  "lastScrape": "2026-02-18T08:00:00.000Z",
  "nextScrape": "2026-02-18T08:05:00.000Z",
  "scrapeInterval": "300s",
  "isScraping": false
}
```

#### Get All Outages
```bash
curl https://utils.tak.nz/power-outages/outages
```

#### Filter by Utility
```bash
# Orion Group only
curl https://utils.tak.nz/power-outages/outages?utility=ORION_NZ

# PowerCo only
curl https://utils.tak.nz/power-outages/outages?utility=POWERCO_NZ
```

#### Filter by Outage Type
```bash
# Unplanned outages only
curl https://utils.tak.nz/power-outages/outages?outageType=unplanned

# Planned outages only
curl https://utils.tak.nz/power-outages/outages?outageType=planned
```

#### Filter by Customer Impact
```bash
# Major outages (10+ customers)
curl https://utils.tak.nz/power-outages/outages?minCustomers=10

# Critical outages (50+ customers)
curl https://utils.tak.nz/power-outages/outages?minCustomers=50
```

#### Filter by Region
```bash
# Canterbury region (by name)
curl https://utils.tak.nz/power-outages/outages?region=Canterbury

# Canterbury region (by ISO code)
curl https://utils.tak.nz/power-outages/outages?regionCode=NZ-CAN

# Bay of Plenty region
curl https://utils.tak.nz/power-outages/outages?regionCode=NZ-BOP
```

#### Combined Filters
```bash
# PowerCo major unplanned outages
curl 'https://utils.tak.nz/power-outages/outages?utility=POWERCO_NZ&outageType=unplanned&minCustomers=10'
```

#### Regional Summary
```bash
# Aggregated view by region/town
curl https://utils.tak.nz/power-outages/summary

# Summary for specific utility
curl https://utils.tak.nz/power-outages/summary?utility=POWERCO_NZ
```

#### City-Level Aggregation
```bash
# Aggregate outages by city with centroid coordinates
curl https://utils.tak.nz/power-outages/aggregate

# Aggregate PowerCo outages only
curl https://utils.tak.nz/power-outages/aggregate?utility=POWERCO_NZ

# Aggregate unplanned outages
curl https://utils.tak.nz/power-outages/aggregate?outageType=unplanned
```

Note: The aggregate endpoint returns the same format as `/power-outages/outages` but with city-level aggregation. Each "outage" represents all outages in a city, with centroid coordinates and combined customer counts.

### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|----------|
| `utility` | string | Filter by utility ID | `ORION_NZ`, `POWERCO_NZ` |
| `minCustomers` | integer | Minimum customers affected | `10`, `50`, `100` |
| `region` | string | Filter by region name | `Canterbury`, `Auckland` |
| `regionCode` | string | Filter by ISO 3166-2:NZ code | `NZ-CAN`, `NZ-BOP` |
| `outageType` | string | Filter by outage type | `planned`, `unplanned` |

### Response Format

#### Outages Endpoint
```json
{
  "version": "1.0",
  "timestamp": "2026-02-18T08:00:00.000Z",
  "lastScrape": "2026-02-18T07:58:30.000Z",
  "summary": {
    "totalUtilities": 2,
    "totalOutages": 15,
    "totalCustomersAffected": 247
  },
  "utilities": [
    {"name": "Orion Group", "id": "ORION_NZ", "status": "ok", "outageCount": 2, "lastUpdate": "2026-02-18T07:58:30.000Z"},
    {"name": "PowerCo", "id": "POWERCO_NZ", "status": "ok", "outageCount": 373, "lastUpdate": "2026-02-18T07:58:31.000Z"}
  ],
  "outages": [...]
}
```

#### Summary Endpoint
```json
{
  "version": "1.0",
  "timestamp": "2026-02-18T08:00:00.000Z",
  "totalOutages": 375,
  "totalCustomersAffected": 1247,
  "byRegion": [
    {
      "region": "Bulls",
      "outageCount": 12,
      "customersAffected": 156,
      "utilities": ["PowerCo"]
    }
  ]
}
```

#### Aggregate Endpoint (Drop-in Replacement)
```json
{
  "version": "1.0",
  "timestamp": "2026-02-18T08:00:00.000Z",
  "lastScrape": "2026-02-18T07:58:30.000Z",
  "summary": {
    "totalUtilities": 2,
    "totalOutages": 120,
    "totalCustomersAffected": 1247
  },
  "utilities": [
    {"name": "PowerCo", "id": "POWERCO_NZ", "status": "ok", "outageCount": 373, "lastUpdate": "2026-02-18T07:58:31.000Z"}
  ],
  "outages": [
    {
      "outageId": "AGG-POWERCO_NZ-Marton",
      "utility": {"name": "PowerCo", "id": "POWERCO_NZ"},
      "region": "Manawatu-Whanganui",
      "regionCode": "NZ-MWT",
      "outageStart": "2026-02-16T10:22:00.000Z",
      "estimatedRestoration": null,
      "cause": "Site Investigation Underway, Strong Wind",
      "status": "active",
      "outageType": "unplanned",
      "customersAffected": 150,
      "location": {
        "coordinates": {"latitude": -40.4523, "longitude": 174.0456},
        "areas": ["Marton"]
      },
      "metadata": {
        "aggregationType": "by-city",
        "outageCount": 33,
        "outageIds": ["JE26008369", "JE26008449", "..."]
      }
    }
  ]
}
```

### Local Development
```bash
# Install dependencies
npm install

# Run server
node server.js

# Test locally
curl http://localhost:3000/odin/outages
```

## Data Sources

### Implementation Difficulty Rating

| Utility | Difficulty | Data Quality | API Type | Notes |
|---------|-----------|--------------|----------|-------|
| Wellington Electricity | ⭐⭐⭐ Easy | Excellent | Clean JSON REST API | Best implementation - public API with complete data |
| EA Networks | ⭐⭐⭐ Easy | Excellent | Clean JSON REST API | Vercel-hosted API with GeoJSON polygons |
| PowerCo | ⭐⭐ Moderate | Excellent | ArcGIS FeatureServer | Standard GIS API, coordinate conversion required |
| Orion Group | ⭐ Moderate | Excellent | Embedded JavaScript | Data in `window.allOutages` object, requires parsing |
| Aurora Energy | ⭐ Moderate | Good | HTML data attributes | Coordinates in data-latitude/longitude, no customer counts |
| Vector Limited | ❌ Not Feasible | N/A | Address-based only | React SPA with no bulk outage API - address lookup only |

### Production (Implemented)
- **Orion Group** ✅ - Canterbury region (⭐ Moderate)
  - URL: `https://www.oriongroup.co.nz/outages-and-support/outages`
  - Format: JavaScript `window.allOutages` object embedded in page
  - Location: Precise coordinates with areas/streets
  - Customer Count: `TotalNumberOff` field
  - Outage Type: Inferred from cause
  - Filter: State='OPEN' for active outages only
  - Scrape: Background every 5 minutes
  - **Rating**: Requires HTML parsing and JavaScript extraction

- **PowerCo** ✅ - Central North Island (⭐⭐ Moderate)
  - URL: `https://outages.powerco.co.nz/server/rest/services/Hosted/Outages/FeatureServer/1`
  - Format: ArcGIS FeatureServer REST API
  - Location: NZTM2000 coordinates (converted to WGS84)
  - Customer Count: `number_of_detail_records` field
  - Outage Type: `planned_outage` field (0=unplanned, 1=planned)
  - Metadata: Feeder name, crew status, last update
  - Scrape: Background every 5 minutes
  - **Rating**: Standard GIS API, requires coordinate system conversion

- **Wellington Electricity** ✅ - Wellington region (⭐⭐⭐ Easy)
  - URL: `https://www.welectricity.co.nz/api/outages`
  - Format: Clean JSON REST API
  - Location: WGS84 coordinates with street-level detail
  - Customer Count: `customers_affected` field
  - Outage Type: Inferred from description
  - Metadata: Fault time, estimated recovery, street details
  - Scrape: Background every 5 minutes
  - **Rating**: Best implementation - public API with complete data, no authentication required

- **EA Networks** ✅ - Canterbury/East Coast (⭐⭐⭐ Easy)
  - URL: `https://outages-eanetworks-co-nz.vercel.app/api/get-outages?tab=current`
  - Format: Clean JSON REST API
  - Location: WGS84 coordinates with GeoJSON polygons
  - Customer Count: `current_affected_customers` and `total_affected_customers` fields
  - Outage Type: `outage_type` field (PLANNED_OUTAGE vs unplanned)
  - Metadata: Incident ID, energization status, street details
  - Scrape: Background every 5 minutes
  - **Rating**: Excellent API - Vercel-hosted with complete data, no authentication required

- **Aurora Energy** ✅ - Otago/Southland (⭐ Moderate)
  - URL: `https://www.auroraenergy.co.nz/power-outages`
  - Format: HTML with data attributes
  - Location: WGS84 coordinates in `data-latitude`/`data-longitude` attributes
  - Customer Count: Not available
  - Outage Type: Status class (status-planned/status-unplanned)
  - Metadata: Incident ID, town, suburbs, time off/on
  - Scrape: Background every 5 minutes
  - **Rating**: HTML parsing required, coordinates available, no customer counts

### Not Feasible
- **Vector Limited** ❌ - Auckland region
  - URL: `https://www.vector.co.nz/outages`
  - Format: React SPA (Single Page Application)
  - **Issue**: No public API for bulk outage data
  - **Limitation**: Address-based lookup only - users must enter their address to check for outages
  - **Impact**: Cannot scrape Auckland region (600K customers, 1/3 of NZ population)
  - **Alternative**: Would require building address database and querying individually (impractical)

### To Be Implemented
- **Horizon Energy** ❌ - Taranaki (Not Feasible - CloudFlare bot protection)
- **Electricity Invercargill** - Southland

## License

AGPL-3.0-only - Copyright (C) 2025 Team Awareness Kit New Zealand (TAK.NZ)