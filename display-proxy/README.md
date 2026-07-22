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
| `icon` | No | Iconset icon path for the layer (shown in info panel and highlight card). |
| `count_geometry` | No | If set, only count features with this geometry type (e.g. `"Point"`, `"Polygon"`) to avoid double-counting polygon + centroid pairs. |

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

### Highlight

The `highlight` array configures a rotating feature-highlight mode. When enabled, the display cycles through features from specified layers, showing a detail card as a floating overlay on the map and optionally flying to each feature's location.

```json
{
    "highlight": [
        {
            "layer": "ema",
            "priority": 1,
            "dwell": 10,
            "fit_polygon": true,
            "template": "{{metadata.headline}}\nArea: {{metadata.areaDesc}}"
        },
        {
            "layer": "quakes",
            "priority": 4,
            "dwell": 15,
            "zoom": 8,
            "template": "Magnitude: {{metadata.magnitude|fixed:1}} (Intensity: {{metadata.intensity}})\nLocation: {{metadata.locality}}\n{{time|date}} ({{time|ago}})"
        }
    ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `layer` | Yes | Layer ID to source features from (must match a layer in `layers`). |
| `priority` | No | Sort order — lower numbers appear first. Default `99`. |
| `dwell` | No | Seconds to display each feature before advancing. Default `10`. |
| `zoom` | No | Zoom level to fly to when highlighting a point feature. Default `9`. |
| `fit_polygon` | No | If `true`, fit the map to the associated polygon's bounding box instead of flying to a fixed zoom. Used for area-based features like weather warnings. |
| `include_lines` | No | If `true`, include LineString features (using their midpoint for the highlight ring and fitBounds for navigation). Default `false`. |
| `template` | No | Template string for the detail card body. Supports `{{field}}` and `{{metadata.field}}` placeholders with optional format modifiers. Defaults to `{{callsign}}`. |

Features are sorted geographically north-to-south (descending latitude) within each priority layer.

### Template Modifiers

Templates support pipe-based format modifiers:

| Modifier | Input | Example Output |
|----------|-------|----------------|
| `fixed:N` | number | `{{metadata.magnitude\|fixed:1}}` → `6.3` |
| `round` | number | `{{metadata.depth\|round}}` → `52` |
| `date` | ISO string | `{{time\|date}}` → `16 Jul 2026, 21:14` (NZ 24h) |
| `ago` | ISO string | `{{time\|ago}}` → `6d ago`, `45min ago`, `just now` |
| `upper` | string | `{{metadata.severity\|upper}}` → `SEVERE` |
| `lower` | string | `{{metadata.event\|lower}}` → `snow` |

## URL Parameters

### Query Parameters (page load)

| Param | Default | Description |
|-------|---------|-------------|
| `key` | (required) | Access key for API authentication |
| `lat` | `-41.28` | Initial latitude |
| `lng` | `174.77` | Initial longitude |
| `zoom` | `5` | Initial zoom level |
| `locked` | `true` | Disable map interaction (`false` to enable pan/zoom) |
| `loop` | `false` | Enable view loop animation (cycles through `view_loop` waypoints) |
| `highlight` | `false` | Enable highlight mode. Values: `true` or `static` (stay in place with halo), `zoom` (fly to each feature). Mutually exclusive with `loop`. |

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

## Highlight Mode

Highlight mode cycles through active events/features and displays a detail card as a semi-transparent floating overlay in the lower-right corner of the map. An animated pulsing ring marks the current feature on the map.

There are two sub-modes controlled by the `highlight` query parameter:

| Value | Behaviour |
|-------|-----------|
| `true` or `static` | Animated pulsing ring on the feature's location; map does not move. |
| `zoom` | Animated fly-to each feature's location (or `fitBounds` to the polygon when `fit_polygon` is set), with distance-based animation speed. Includes animated pulsing ring. |

The highlight cycle:
1. Builds a list of features from configured highlight layers (Points, and LineStrings if `include_lines` is set), sorted by priority then geographically north-to-south.
2. Shows each feature for `dwell` seconds, rendering the template into the overlay card.
3. Progress pips at the bottom of the card show position in the cycle.
4. Fly-to speed scales with distance (1.5s for nearby features, up to 5s for far ones).
5. If no features are available, a placeholder message is shown and the system retries every 5 seconds.

Example URL for zoom-mode highlights:
```
http://localhost:3000?key=<key>&highlight=zoom&lat=-41.19&lng=174.78&zoom=5.3
```
