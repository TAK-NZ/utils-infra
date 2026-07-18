/**
 * tak-icon-proxy Lambda
 *
 * Proxies CloudTAK iconset icon requests from the browser, injecting the
 * Bearer token. Responses are cached at CloudFront for 7 days — icons
 * are immutable once created.
 *
 * Route (mapped by CloudFront behaviour):
 *   GET /api/icons/{iconset-uid}/{path...}
 *     → GET https://map.tak.nz/api/iconset/{iconset-uid}/icon/{path...}
 *
 * Query string:
 *   ?key=<access-key>   required — validated against config.access_keys
 *
 * The icon field on a CloudTAK feature is "<iconset-uid>/<path/to/icon.png>".
 * The frontend encodes the whole value and calls /api/icons/<encoded-value>.
 * This Lambda decodes it and splits on the first "/" to get iconset UID + path.
 */

const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY    = process.env.CONFIG_KEY || 'Utils-Display-Proxy-Config.json';
const CONFIG_TTL_MS = 5 * 60 * 1000;

// Session JWT cache — exchanged from the ETL token, expires in 16h
let sessionJwt       = null;
let sessionExpiresAt = 0;

let cachedConfig   = null;
let configLoadedAt = 0;

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
async function getSessionJwt(config) {
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

function isAuthorised(config, key) {
    if (!key) return false;
    return Array.isArray(config.access_keys) && config.access_keys.includes(key);
}

function errorResponse(statusCode, message) {
    return {
        statusCode,
        headers: {
            'Content-Type':                'text/plain',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               'no-store',
        },
        body: message,
    };
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
        return errorResponse(500, 'Configuration unavailable');
    }

    if (!isAuthorised(config, key)) {
        return errorResponse(401, 'Invalid or missing key');
    }

    // Extract the icon path from the URL:
    //   /api/icons/<encoded-icon-value>
    // The encoded icon value is the full "iconset-uid/path/to/icon.png" encoded
    // as a single URI component by the frontend.
    const PREFIX = '/api/icons/';
    if (!path.startsWith(PREFIX)) {
        return errorResponse(404, 'Not found');
    }

    const encodedIcon = path.slice(PREFIX.length);
    let iconValue;
    try {
        iconValue = decodeURIComponent(encodedIcon);
    } catch {
        return errorResponse(400, 'Invalid icon path encoding');
    }

    // Split into iconset UID and icon name at the first "/"
    const slashIdx = iconValue.indexOf('/');
    if (slashIdx === -1) {
        return errorResponse(400, 'Icon path must be <iconset-uid>/<icon-name>');
    }
    const iconsetUid = iconValue.slice(0, slashIdx);
    const iconName   = iconValue.slice(slashIdx + 1);  // may contain subdirectories

    const baseUrl    = (config.cloudtak_url || '').replace(/\/$/, '');
    const token      = await getSessionJwt(config);

    // CloudTAK iconset icon endpoint — icon name must be URL-encoded
    const upstream = `${baseUrl}/api/iconset/${encodeURIComponent(iconsetUid)}/icon/${encodeURIComponent(iconName)}`;

    let upstreamRes;
    try {
        upstreamRes = await fetch(upstream, {
            headers: { Authorization: `Bearer ${token}` },
            signal:  AbortSignal.timeout(8000),
        });
    } catch (err) {
        console.error('CloudTAK icon fetch error:', err);
        return errorResponse(502, 'Upstream fetch failed');
    }

    if (upstreamRes.status === 404) {
        return errorResponse(404, 'Icon not found');
    }

    if (!upstreamRes.ok) {
        console.error(`CloudTAK icon endpoint returned ${upstreamRes.status}`);
        return errorResponse(502, `Upstream error ${upstreamRes.status}`);
    }

    // Forward the PNG body as base64
    const contentType = upstreamRes.headers.get('content-type') || 'image/png';

    // CloudTAK returns JSON with a base64 data URI in the "data" field
    let base64;
    if (contentType.includes('application/json')) {
        const json = await upstreamRes.json();
        if (json.data && json.data.startsWith('data:')) {
            // Extract base64 from data URI: "data:image/png;base64,<data>"
            base64 = json.data.split(',')[1];
        } else {
            return errorResponse(502, 'Unexpected icon response format');
        }
    } else {
        // Raw binary response (unlikely but handle it)
        const buffer = await upstreamRes.arrayBuffer();
        base64 = Buffer.from(buffer).toString('base64');
    }

    return {
        statusCode: 200,
        headers: {
            'Content-Type':                contentType,
            'Cache-Control':               'public, max-age=604800, immutable',  // 7 days
            'Access-Control-Allow-Origin': '*',
        },
        body:            base64,
        isBase64Encoded: true,
    };
}
