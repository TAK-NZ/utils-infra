/**
 * tak-cot-proxy Lambda
 *
 * Proxies CloudTAK CoT feature endpoints to the browser, injecting the
 * Bearer token from S3 config. Returns GeoJSON FeatureCollections.
 *
 * Routes (mapped by CloudFront behaviours):
 *   GET /api/cot/acft      → CloudTAK /api/connection/{acft_connection_id}/feature
 *   GET /api/cot/vessels   → CloudTAK /api/connection/{vessels_connection_id}/feature
 *   GET /api/cot/personnel → CloudTAK /api/profile/feature
 *
 * Query string:
 *   ?key=<access-key>   required — validated against config.access_keys
 *
 * S3 config shape (Utils-Display-Proxy-Config.json):
 * {
 *   "cloudtak_url":   "https://map.demo.tak.nz",
 *   "cloudtak_token": "etl.<jwt>",
 *   "access_keys":    ["<token>"],
 *   "connections": {
 *     "acft":      3,
 *     "vessels":   7
 *   }
 * }
 */

const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY    = process.env.CONFIG_KEY || 'Utils-Display-Proxy-Config.json';
const CONFIG_TTL_MS = 5 * 60 * 1000;  // re-read config every 5 minutes

// Session JWT cache — exchanged from the ETL token, expires in 16h
let sessionJwt       = null;
let sessionExpiresAt = 0;

let cachedConfig    = null;
let configLoadedAt  = 0;

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
async function getConfig() {
    const now = Date.now();
    if (cachedConfig && (now - configLoadedAt) < CONFIG_TTL_MS) {
        return cachedConfig;
    }

    // Local dev: read from a local file instead of S3
    if (process.env.LOCAL_CONFIG_FILE) {
        const { readFileSync } = await import('fs');
        cachedConfig   = JSON.parse(readFileSync(process.env.LOCAL_CONFIG_FILE, 'utf8'));
        configLoadedAt = now;
        return cachedConfig;
    }

    // Production: read from S3 (lazy import so local dev doesn't need the SDK)
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3   = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' });
    const res  = await s3.send(new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: CONFIG_KEY }));
    const body = await res.Body.transformToString();
    cachedConfig   = JSON.parse(body);
    configLoadedAt = now;
    return cachedConfig;
}

// ---------------------------------------------------------------------------
// Session JWT — exchange ETL token for a session JWT before it expires.
// The session JWT lasts 16h; refresh 30 minutes before expiry.
// ---------------------------------------------------------------------------
export async function getSessionJwt(config) {
    const now = Date.now();
    if (sessionJwt && now < sessionExpiresAt - 30 * 60 * 1000) {
        return sessionJwt;
    }

    const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/api/login/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: config.cloudtak_token }),
        signal:  AbortSignal.timeout(10000),
    });

    if (!res.ok) {
        throw new Error(`Token exchange failed: ${res.status}`);
    }

    const data     = await res.json();
    sessionJwt     = data.token;

    // Decode exp from JWT payload (middle segment)
    const payload  = JSON.parse(Buffer.from(sessionJwt.split('.')[1], 'base64').toString());
    sessionExpiresAt = (payload.exp || (Date.now() / 1000 + 16 * 3600)) * 1000;

    return sessionJwt;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
function isAuthorised(config, key) {
    if (!key) return false;
    return Array.isArray(config.access_keys) && config.access_keys.includes(key);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function jsonResponse(statusCode, body, extraHeaders = {}) {
    return {
        statusCode,
        headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               statusCode === 200 ? 'public, max-age=30' : 'no-store',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    };
}

// ---------------------------------------------------------------------------
// Feature filtering — applies config-defined filters to features.
//
// Filters are string expressions in the form:
//   "path.to.field op value"
//
// Supported operators: ==, !=, >, <, >=, <=, %
// The % operator is modulo: "path % divisor != remainder"
//
// Values can be: numbers, quoted strings, null, true, false
// If a path resolves to undefined, comparisons against non-null values
// will fail (feature excluded), except != which passes.
//
// All filters must pass (AND logic).
// ---------------------------------------------------------------------------
function getNestedValue(obj, dotPath) {
    const parts = dotPath.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function parseFilterValue(raw) {
    if (raw === 'null') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Quoted string
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    // Number
    const num = Number(raw);
    if (!isNaN(num)) return num;
    // Fallback: treat as string
    return raw;
}

function parseFilter(expr) {
    // Handle $contains(path, value) expressions
    const containsMatch = expr.match(/^\$contains\(\s*(.+?)\s*,\s*(.+?)\s*\)$/);
    if (containsMatch) {
        return {
            type: 'contains',
            path: containsMatch[1].trim(),
            value: parseFilterValue(containsMatch[2].trim())
        };
    }
    // Handle modulo expressions: "path % divisor op value"
    const modMatch = expr.match(/^(.+?)\s+%\s+(\S+)\s+(==|!=|>|<|>=|<=)\s+(.+)$/);
    if (modMatch) {
        return {
            type: 'modulo',
            path: modMatch[1].trim(),
            divisor: parseFilterValue(modMatch[2]),
            op: modMatch[3],
            value: parseFilterValue(modMatch[4])
        };
    }
    // Standard expressions: "path op value"
    const stdMatch = expr.match(/^(.+?)\s+(==|!=|>=|<=|>|<|=)\s+(.+)$/);
    if (stdMatch) {
        return {
            type: 'compare',
            path: stdMatch[1].trim(),
            op: stdMatch[2] === '=' ? '==' : stdMatch[2],
            value: parseFilterValue(stdMatch[3])
        };
    }
    console.warn('Unparseable filter expression:', expr);
    return null;
}

function evaluateComparison(actual, op, value) {
    // When comparing against a concrete value, treat undefined/null as "no data"
    // so that != comparisons don't accidentally pass for missing fields.
    if (actual === undefined || actual === null) {
        if (op === '==' && (value === null || value === undefined)) return true;
        if (op === '!=' && (value === null || value === undefined)) return false;
        // Missing field doesn't satisfy any comparison against a concrete value
        return false;
    }
    switch (op) {
        case '==':  return actual === value;
        case '!=':  return actual !== value;
        case '>':   return actual > value;
        case '<':   return actual < value;
        case '>=':  return actual >= value;
        case '<=':  return actual <= value;
        default:    return true;
    }
}

function evaluateFilter(feature, parsed) {
    if (!parsed) return true;
    const actual = getNestedValue(feature, parsed.path);
    if (parsed.type === 'contains') {
        if (actual == null) return false;
        if (typeof actual === 'string') return actual.includes(parsed.value);
        if (Array.isArray(actual)) return actual.includes(parsed.value);
        return false;
    }
    if (parsed.type === 'modulo') {
        if (actual == null || typeof actual !== 'number') return false;
        const modResult = actual % parsed.divisor;
        return evaluateComparison(modResult, parsed.op, parsed.value);
    }
    // Standard compare
    return evaluateComparison(actual, parsed.op, parsed.value);
}

function applyFilters(feature, filters) {
    if (!filters || !Array.isArray(filters) || filters.length === 0) return true;
    // OR logic: feature passes if ANY filter matches
    return filters.some(function(filterExpr) {
        if (typeof filterExpr === 'string') {
            return evaluateFilter(feature, parseFilter(filterExpr));
        }
        // Legacy object format support
        if (typeof filterExpr === 'object' && filterExpr.path) {
            const actual = getNestedValue(feature, filterExpr.path);
            return evaluateComparison(actual, filterExpr.op, filterExpr.value);
        }
        return true;
    });
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event) {
    const path  = event.rawPath || event.path || '';
    const query = event.queryStringParameters || {};
    const key   = query.key || '';

    let config;
    try {
        config = await getConfig();
    } catch (err) {
        console.error('Failed to load config:', err);
        return jsonResponse(500, { error: 'Configuration unavailable' });
    }

    // Auth
    if (!isAuthorised(config, key)) {
        return jsonResponse(401, { error: 'Invalid or missing key' });
    }

    const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
    const token   = await getSessionJwt(config);
    const layers  = config.layers || [];
    // Support legacy "connections" format
    const conns   = config.connections || {};

    // Resolve the upstream CloudTAK endpoint from the request path
    // Path format: /api/cot/<layerId>
    const layerName = path.split('/').pop();
    let upstream;

    // First check new "layers" config format
    const layerDef = layers.find(l => l.id === layerName);
    if (layerDef && layerDef.connection != null) {
        upstream = `${baseUrl}/api/connection/${layerDef.connection}/feature`;
    } else if (conns[layerName]) {
        // Legacy "connections" object format
        upstream = `${baseUrl}/api/connection/${conns[layerName]}/feature`;
    } else if (layerName === 'personnel') {
        upstream = `${baseUrl}/api/profile/feature`;
    } else {
        return jsonResponse(404, { error: `Unknown layer: ${layerName}` });
    }

    // Fetch all pages from CloudTAK
    const PAGE_LIMIT = 1000;
    let allFeatures = [];
    let page = 0;
    let total = Infinity;

    while (allFeatures.length < total) {
        const sep = upstream.includes('?') ? '&' : '?';
        const pagedUrl = `${upstream}${sep}limit=${PAGE_LIMIT}&page=${page}`;

        let upstreamRes;
        try {
            upstreamRes = await fetch(pagedUrl, {
                headers: { Authorization: `Bearer ${token}` },
                signal:  AbortSignal.timeout(10000),
            });
        } catch (err) {
            console.error('CloudTAK fetch error:', err);
            return jsonResponse(502, { error: 'Upstream fetch failed', detail: err.message });
        }

        if (!upstreamRes.ok) {
            console.error(`CloudTAK returned ${upstreamRes.status} for ${pagedUrl}`);
            const body = await upstreamRes.text().catch(() => '');
            console.error(`Response body: ${body.slice(0, 200)}`);
            return jsonResponse(502, { error: `Upstream error ${upstreamRes.status}` });
        }

        let data;
        try {
            data = await upstreamRes.json();
        } catch (err) {
            return jsonResponse(502, { error: 'Invalid JSON from upstream' });
        }

        // CloudTAK returns { total, items: [...] }
        const items = Array.isArray(data.items) ? data.items
                    : Array.isArray(data.features) ? data.features : [];
        total = data.total != null ? data.total : items.length;
        allFeatures = allFeatures.concat(items);

        // Safety: stop if we got no items (avoid infinite loop)
        if (items.length === 0) break;
        page++;
    }

    const fc = {
        type: 'FeatureCollection',
        features: allFeatures.filter(function(f) {
            // Server-side stale filtering — only return non-expired features
            var stale = f.properties && f.properties.stale;
            if (!stale) return true;
            return new Date(stale).getTime() > Date.now();
        }).filter(function(f) {
            // Apply config-defined filters for this layer
            return applyFilters(f, config.filters && config.filters[layerName]);
        }),
    };

    return jsonResponse(200, fc);
}
