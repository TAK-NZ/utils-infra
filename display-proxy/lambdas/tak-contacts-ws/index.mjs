/**
 * tak-contacts-ws — WebSocket client for CloudTAK contacts/user positions.
 *
 * Maintains a persistent WebSocket connection to CloudTAK, collecting live
 * position updates from online TAK users (contacts). Exposes the current
 * set of contacts as a GeoJSON FeatureCollection via getFeatures().
 *
 * Usage:
 *   import { init, getFeatures, destroy } from './lambdas/tak-contacts-ws/index.mjs';
 *   await init(config);      // starts WebSocket
 *   const fc = getFeatures(); // returns current contacts GeoJSON
 *   destroy();               // closes WebSocket
 */

import WebSocket from 'ws';

let ws = null;
let reconnectTimer = null;
let config = null;
let sessionJwt = null;
let sessionExpiresAt = 0;

// In-memory store of contacts: Map<uid, GeoJSON Feature>
const contacts = new Map();

// TAK group name → color mapping (same as CloudTAK)
const GROUP_COLORS = {
    'Yellow':     '#f59f00',
    'Orange':     '#f76707',
    'Magenta':    '#ea4c89',
    'Red':        '#d63939',
    'Maroon':     '#bd081c',
    'Purple':     '#ae3ec9',
    'Dark Blue':  '#0054a6',
    'Blue':       '#4299e1',
    'Cyan':       '#17a2b8',
    'Teal':       '#0ca678',
    'Green':      '#74b816',
    'Dark Green': '#2fb344',
    'Brown':      '#dc4e41',
    'White':      '#ffffff',
};

// ---------------------------------------------------------------------------
// Session JWT (same logic as cot-proxy)
// ---------------------------------------------------------------------------
async function getToken() {
    const now = Date.now();
    if (sessionJwt && now < sessionExpiresAt - 30 * 60 * 1000) {
        return sessionJwt;
    }

    const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/login/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.cloudtak_token }),
        signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);

    const data = await res.json();
    sessionJwt = data.token;
    const payload = JSON.parse(Buffer.from(sessionJwt.split('.')[1], 'base64').toString());
    sessionExpiresAt = (payload.exp || (Date.now() / 1000 + 16 * 3600)) * 1000;
    return sessionJwt;
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------
async function connect() {
    if (ws) {
        try { ws.close(); } catch(e) {}
        ws = null;
    }

    const token = await getToken();
    const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
    // Derive the WebSocket connection username from the JWT
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const connection = payload.email || payload.id || 'admin';

    const wsUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://')
        + `/api?format=geojson&connection=${encodeURIComponent(connection)}&token=${token}`;

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log('[contacts-ws] Connected');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'cot' && msg.data) {
                const feat = msg.data;
                const props = feat.properties || {};
                // Only store features that have a group (= TAK users/contacts)
                if (props.group && feat.geometry) {
                    // Map group name to marker color (same as CloudTAK)
                    const groupName = typeof props.group === 'object' ? props.group.name : props.group;
                    props['marker-color'] = GROUP_COLORS[groupName] || '#ffffff';
                    props['group-name'] = groupName || '';
                    contacts.set(feat.id || props.callsign || JSON.stringify(feat.geometry.coordinates), feat);
                }
            }
        } catch(e) { /* ignore parse errors */ }
    });

    ws.on('close', () => {
        console.log('[contacts-ws] Disconnected, reconnecting in 5s...');
        ws = null;
        scheduleReconnect();
    });

    ws.on('error', (err) => {
        console.error('[contacts-ws] Error:', err.message);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            await connect();
        } catch (err) {
            console.error('[contacts-ws] Reconnect failed:', err.message);
            scheduleReconnect();
        }
    }, 5000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function init(cfg) {
    config = cfg;
    await connect();
}

export function getFeatures() {
    const now = Date.now();
    const features = [];

    for (const [id, feat] of contacts) {
        // Remove stale contacts (> 5 minutes old)
        const stale = feat.properties && feat.properties.stale;
        if (stale && new Date(stale).getTime() < now) {
            contacts.delete(id);
            continue;
        }
        features.push(feat);
    }

    return {
        type: 'FeatureCollection',
        features: features,
    };
}

export function destroy() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }
}
