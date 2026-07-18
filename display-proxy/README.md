# display-proxy

A web-based Common Operational Picture (COP) display for TAK.NZ. Shows live aircraft, vessel, and contact positions from CloudTAK on a MapLibre GL map with a status info panel.

Designed for display screens (Fire TV, AbleSign, kiosk browsers) but works in any modern browser.

## Architecture

Single Node.js HTTP server that:
- Serves the static web app (index.html + sprites)
- Proxies CloudTAK connection feature APIs (aircraft, vessels)
- Maintains a WebSocket to CloudTAK for live contact/user positions
- Proxies iconset sprites from CloudTAK
- Reads configuration from S3 (production) or a local JSON file (dev)

## Quick Start (Local Development)

```bash
# 1. Copy and fill in the config
cp Utils-Display-Proxy-Config.sample.json Utils-Display-Proxy-Config.local.json
# Edit Utils-Display-Proxy-Config.local.json with your CloudTAK credentials

# 2. Install dependencies
npm install

# 3. Run the dev server
npm run dev

# 4. Open in browser
open "http://localhost:3000?key=<your-access-key>&lat=-41.19&lng=174.78&zoom=5.3"
```

## Configuration

Configuration is a JSON file (`Utils-Display-Proxy-Config.json` in S3, or a local file for dev).

```json
{
    "cloudtak_url": "https://map.demo.tak.nz",
    "cloudtak_token": "etl.<your-token>",
    "access_keys": ["<browser-access-key>"],
    "layers": [
        { "id": "contacts", "label": "Contacts" },
        { "id": "acft",     "label": "Aircraft",  "connection": 3 },
        { "id": "vessels",  "label": "Vessels",   "connection": 7 }
    ],
    "contact_groups": {
        "Purple": "National Emergency Management Agency (NEMA)",
        "Red":    "Fire and Emergency New Zealand (FENZ)",
        "Blue":   "New Zealand Police",
        "Brown":  "New Zealand Defence Force (NZDF)"
    },
    "iconsets": [
        "66f14976-4b62-4023-8edb-d8d2ebeaa336"
    ],
    "filters": {
        "acft": [
            "properties.metadata.group != \"None\"",
            "properties.metadata.dbFlags % 2 != 0"
        ],
        "vessels": [
            "properties.metadata.TYPE = 51",
            "$contains(properties.metadata.COT_TYPE, \"a-f-S-X-L\")"
        ]
    }
}
```

### Layers

Each layer entry defines a data source displayed on the map:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier. Used in the API path (`/api/cot/<id>`) and filter keys. |
| `label` | No | Display name shown in the info panel. Defaults to `id`. |
| `connection` | No | CloudTAK connection ID. Omit for the special `contacts` layer. |

The `contacts` layer is special — it gets its data from a live WebSocket connection rather than the REST API.

### Filters

Filters are defined per-layer as string expressions. A feature passes if **any** filter matches (OR logic).

Supported syntax:
- `path.to.field == value` — equality
- `path.to.field != value` — inequality
- `path.to.field > value` — greater than (also `<`, `>=`, `<=`)
- `path.to.field % divisor != remainder` — modulo
- `$contains(path.to.field, "substring")` — substring match

Values can be numbers, quoted strings (`"text"`), `null`, `true`, `false`. If a field is undefined/missing, comparisons against concrete values return false.

### Contact Groups

Maps TAK group color names to organisation display names shown in the info panel. Only groups with online users are displayed, sorted by count descending.

### Iconsets

Array of CloudTAK iconset UUIDs. Their spritesheets are loaded as additional MapLibre sprites, enabling custom icons for features that have a `properties.icon` field.

## URL Parameters

### Query Parameters (page load)

| Param | Default | Description |
|-------|---------|-------------|
| `key` | (required) | Access key for API authentication |
| `lat` | `-41.28` | Initial latitude |
| `lng` | `174.77` | Initial longitude |
| `zoom` | `5` | Initial zoom level |
| `locked` | `true` | Disable map interaction (`false` to enable pan/zoom) |

### Hash Parameters (fly-to without reload)

Change the URL hash to smoothly animate the map to a new position without reloading:

```
http://localhost:3000?key=...#lat=-36.85&lng=174.76&zoom=10
```

All hash parameters are optional — omit any to keep the current value:
- `#zoom=12` — zoom in without changing position
- `#lat=-45&lng=168` — fly to location keeping current zoom
- `#lat=-41.19&lng=174.78&zoom=5` — fly to exact view

The animation takes approximately 3 seconds. You can trigger it programmatically:

```javascript
// From browser console or external script
window.location.hash = 'lat=-45.03&lng=168.66&zoom=10';
```

This enables remote control of the display view — an external system can update the hash via any mechanism that modifies the browser URL (e.g. a signage management system, a bookmarklet, or a simple redirect).

## Deployment

### Local / Docker

```bash
docker build -t display-proxy .
docker run -p 3000:3000 \
  -e LOCAL_CONFIG_FILE=/app/config.json \
  -v ./config.json:/app/config.json:ro \
  display-proxy
```

### AWS ECS Fargate (via CDK)

The container is deployed as part of the utils-infra ECS cluster with hostname-based routing. Configuration is read from S3.

Environment variables:
- `CONFIG_BUCKET` — S3 bucket containing the config file
- `CONFIG_KEY` — S3 key (default: `Utils-Display-Proxy-Config.json`)
- `PORT` — HTTP port (default: `3000`)

The CDK stack entry in `cdk.json`:
```json
"display-proxy": {
  "enabled": true,
  "hostname": "display",
  "healthCheckPath": "/health",
  "port": 3000,
  "cpu": 256,
  "memory": 512,
  "priority": 6,
  "imageTag": "v1.0.0"
}
```

## Refresh Behaviour

- **Aircraft / Vessels**: polled every 10 seconds via REST API
- **Contacts**: received in real-time via WebSocket, served to browser every 10 seconds
- **Expired features**: filtered out both server-side and client-side based on the `stale` timestamp
- **Clock**: updates every second (NZST)

## Info Panel

The right 1/4 of the screen shows:
- TAK.NZ logo + "Common Operational Picture" heading
- Contact groups with colored dots and online count (sorted by count)
- Layer feature counts (Aircraft, Vessels)
- Total feature count
- Live clock with date (NZST)
