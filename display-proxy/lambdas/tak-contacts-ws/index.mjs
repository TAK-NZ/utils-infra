/**
 * tak-contacts-ws — WebSocket client for CloudTAK contacts/user positions.
 *
 * Maintains a persistent WebSocket connection to CloudTAK, collecting live
 * position updates from online TAK users (contacts). Exposes the current
 * set of contacts as a GeoJSON FeatureCollection via getFeatures().
 *
 * Optionally filters contacts by channel subscription — only contacts
 * subscribed (with write/IN permission) to specified channels are included.
 *
 * Usage:
 *   import { init, getFeatures, destroy } from './lambdas/tak-contacts-ws/index.mjs';
 *   await init(config);      // starts WebSocket + subscription polling
 *   const fc = getFeatures(); // returns current contacts GeoJSON
 *   destroy();               // closes WebSocket
 */

import WebSocket from 'ws';

let ws = null;
let reconnectTimer = null;
let subscriptionTimer = null;
let config = null;
let sessionJwt = null;
let sessionExpiresAt = 0;

// In-memory store of contacts: Map<uid, GeoJSON Feature>
const contacts = new Map();

// Subscription lookup: Map<clientUid, Set<channelName>> — channels with IN direction
const subscriptionMap = new Map();

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
// Subscription polling — fetches channel memberships from REST API
// ---------------------------------------------------------------------------
const SUBSCRIPTION_POLL_MS = 60 * 1000; // poll every 60 seconds

async function pollSubscriptions() {
    try {
        const token = await getToken();
        const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
        const res = await fetch(`${baseUrl}/api/marti/subscription`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            console.warn('[contacts-ws] Subscription poll failed:', res.status);
            return;
        }

        const data = await res.json();
        const subs = data.data || data.items || data;
        if (!Array.isArray(subs)) return;

        // Rebuild the subscription map
        subscriptionMap.clear();
        for (const sub of subs) {
            const uid = sub.clientUid || sub.callsign || '';
            if (!uid) continue;
            const groups = sub.groups || [];
            const inChannels = new Set();
            for (const g of groups) {
                if (g.direction === 'IN' && g.active) {
                    inChannels.add(g.name);
                }
            }
            if (inChannels.size > 0) {
                subscriptionMap.set(uid, inChannels);
            }
            // Also index by callsign if different from clientUid
            if (sub.callsign && sub.callsign !== uid) {
                subscriptionMap.set(sub.callsign, inChannels);
            }
            // Also index by username for matching
            if (sub.username) {
                subscriptionMap.set(sub.username, inChannels);
            }
        }

        console.log(`[contacts-ws] Subscription poll: ${subscriptionMap.size} entries`);
    } catch (err) {
        console.warn('[contacts-ws] Subscription poll error:', err.message);
    }
}

function startSubscriptionPolling() {
    pollSubscriptions(); // initial poll
    subscriptionTimer = setInterval(pollSubscriptions, SUBSCRIPTION_POLL_MS);
}

// ---------------------------------------------------------------------------
// Channel filter — checks if a contact is allowed based on config
// ---------------------------------------------------------------------------
function isContactAllowed(feat) {
    const requiredChannels = config.contact_channels && config.contact_channels.require_any;
    if (!requiredChannels || !Array.isArray(requiredChannels) || requiredChannels.length === 0) {
        return true; // no filter configured — show all
    }

    const uid = feat.id || '';
    const callsign = (feat.properties && feat.properties.callsign) || '';

    // Look up this contact's channels by uid, callsign, or any matching key
    const channels = subscriptionMap.get(uid) || subscriptionMap.get(callsign);
    if (!channels) {
        return false; // not found in subscription data — hide
    }

    // Check if the contact is subscribed to any of the required channels
    return requiredChannels.some(ch => channels.has(ch));
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
                // Store contacts (features with a group property)
                if (props.group && feat.geometry) {
                    const groupName = typeof props.group === 'object' ? props.group.name : props.group;
                    props['marker-color'] = GROUP_COLORS[groupName] || '#ffffff';
                    props['group-name'] = groupName || '';
                    contacts.set(feat.id || props.callsign || JSON.stringify(feat.geometry.coordinates), feat);
                }
                // Store features for WebSocket-based layers (matched by ID prefix)
                for (const [prefix, store] of wsLayers) {
                    if (feat.id && feat.id.startsWith(prefix)) {
                        store.set(feat.id, feat);
                        break;
                    }
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
    startSubscriptionPolling();
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
        // Apply channel filter
        if (!isContactAllowed(feat)) continue;

        features.push(feat);
    }

    return {
        type: 'FeatureCollection',
        features: features,
    };
}

export function destroy() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (subscriptionTimer) { clearInterval(subscriptionTimer); subscriptionTimer = null; }
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }
}
