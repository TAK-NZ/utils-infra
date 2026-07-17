# Multi-Tenant Per-Key Configuration

This document describes how to expand the display-proxy to support multiple independent configurations, each tied to a separate API key. Each key can have its own CloudTAK instance, token, layers, filters, styles, overlays, and view loop.

## Current Architecture

- Single flat config file with one `cloudtak_url`, one `cloudtak_token`, one set of layers/filters/styles.
- `access_keys` is an array of valid keys — all keys see the same data.
- One WebSocket connection for contacts.
- One session JWT cache (single variable).

## Target Architecture

Each API key maps to an isolated "display" configuration. Keys sharing the same CloudTAK instance and token share underlying connections to avoid waste.

## Config Structure

```json
{
  "displays": {
    "key-abc123": {
      "label": "National EOC Display",
      "cloudtak_url": "https://map.demo.tak.nz",
      "cloudtak_token": "etl.eyJ...",
      "layers": [
        { "id": "acft", "label": "Aircraft", "connection": 3 },
        { "id": "vessels", "label": "Vessels", "connection": 7 }
      ],
      "filters": {
        "acft": ["properties.metadata.group != \"None\""]
      },
      "styles": {
        "acft": { "point": { "icon": "..." } }
      },
      "overlays": [
        { "id": "weather-radar", "name": "Weather Radar", "url": "...", "opacity": 0.6 }
      ],
      "view_loop": [
        { "lat": -41.19, "lng": 174.78, "zoom": 5.3, "time": 10 }
      ],
      "contact_groups": { "Blue": "NZ Police", "Red": "FENZ" },
      "iconsets": ["bb4df0a6-..."]
    },
    "key-def456": {
      "label": "Regional Fire Display",
      "cloudtak_url": "https://map.prod.tak.nz",
      "cloudtak_token": "etl.eyJ...",
      "layers": [
        { "id": "fires", "label": "FIRMS Fire Detection", "connection": 12 }
      ],
      "filters": {},
      "styles": {},
      "overlays": [],
      "view_loop": [],
      "contact_groups": {},
      "iconsets": []
    }
  }
}
```

Backward compatibility: if the config has no `displays` key, treat the entire config as a single display and accept any key in `access_keys` (current behaviour).

## Changes Required

### 1. server.mjs

**Auth check:**
```js
// Before: config.access_keys.includes(key)
// After:
function getDisplayConfig(config, key) {
  if (config.displays && config.displays[key]) return config.displays[key];
  // Backward compat: flat config with access_keys array
  if (Array.isArray(config.access_keys) && config.access_keys.includes(key)) return config;
  return null;
}
```

**`/api/config` endpoint:** Accept `?key=` and return only that key's public fields (layers, iconsets, contact_groups, view_loop, overlays).

**Contacts WebSocket:** Start one connection per unique `cloudtak_url + cloudtak_token` pair, not per key. Multiple keys pointing to the same CloudTAK instance share the connection.

### 2. lambdas/tak-cot-proxy/index.mjs

**Pass display config into handler:** The handler currently reads a global config. Change it to accept the resolved display config (or the key) so it uses the correct token, layers, filters, and styles.

```js
// Option A: pass resolved config directly
export async function handler(event, displayConfig) { ... }

// Option B: pass key, let handler resolve
export async function handler(event) {
  const key = event.queryStringParameters?.key;
  const displayConfig = getDisplayConfig(await getConfig(), key);
  ...
}
```

**Session JWT cache:** Change from a single variable to a Map keyed by ETL token:

```js
const sessionJwts = new Map(); // Map<etlToken, { jwt, expiresAt }>

export async function getSessionJwt(displayConfig) {
  const etlToken = displayConfig.cloudtak_token;
  const cached = sessionJwts.get(etlToken);
  if (cached && Date.now() < cached.expiresAt - 30 * 60 * 1000) {
    return cached.jwt;
  }
  // Exchange token...
  sessionJwts.set(etlToken, { jwt: newJwt, expiresAt });
  return newJwt;
}
```

### 3. lambdas/tak-contacts-ws/index.mjs

**Multiple WebSocket connections:** One per unique `cloudtak_url + cloudtak_token` combination.

```js
// Map<connectionKey, { ws, contacts, config }>
const connections = new Map();

function connectionKey(cfg) {
  return `${cfg.cloudtak_url}|${cfg.cloudtak_token}`;
}

export async function initAll(displays) {
  const seen = new Set();
  for (const [key, cfg] of Object.entries(displays)) {
    const ck = connectionKey(cfg);
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (!connections.has(ck)) {
      connections.set(ck, { ws: null, contacts: new Map(), config: cfg });
      await connect(ck);
    }
  }
  // Tear down connections no longer referenced by any display
  for (const ck of connections.keys()) {
    if (!seen.has(ck)) { destroy(ck); connections.delete(ck); }
  }
}

export function getFeatures(displayConfig) {
  const ck = connectionKey(displayConfig);
  const conn = connections.get(ck);
  if (!conn) return { type: 'FeatureCollection', features: [] };
  // Filter by contact_groups if the display config limits them
  ...
}
```

### 4. index.html

Minimal change — it already passes `?key=` on all fetch calls. Ensure `/api/config` includes the key:

```js
// Currently:
fetch('/api/config')
// Change to:
fetch('/api/config?key=' + accessKey)
```

## Implementation Order

1. **Config loading + backward compat** — `getDisplayConfig()` function with fallback to flat format.
2. **Auth + /api/config** — key-based config resolution in server.mjs.
3. **cot-proxy** — per-display token cache and layer/filter/style resolution.
4. **contacts-ws** — shared connections with reference counting.
5. **Testing** — run two keys pointing to different (or same) CloudTAK instances side by side.

## Edge Cases

- **Config reload:** When the 60s TTL expires and config is re-read, new keys become active immediately. Removed keys get 403 on next request. WebSocket connections for removed tokens are torn down on next `initAll()` pass.
- **Token expiry:** Each ETL token has its own session JWT lifecycle. If a token is rotated in config, the old session JWT expires naturally (16h) and the new one is exchanged on next request.
- **Shared connections:** If 5 keys use the same CloudTAK URL + token, they share one WS connection and one session JWT. The contacts store is shared — filtering by `contact_groups` config determines which groups each display shows.
- **Memory:** Each connection maintains its own contacts Map. With ~100 contacts per instance and 3-4 unique instances, memory is negligible.

## Estimated Effort

~4 hours for a working implementation, assuming familiarity with the codebase. The majority of time goes into the contacts-ws shared connection logic and testing the backward-compatible config detection.
