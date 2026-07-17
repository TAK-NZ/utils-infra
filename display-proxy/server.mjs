/**
 * display-proxy production server.
 *
 * Single container serving:
 *   GET /                    → index.html (SPA)
 *   GET /api/config          → public config (layers, iconsets)
 *   GET /api/cot/contacts    → live contacts from WebSocket
 *   GET /api/cot/:layerId    → CoT features from CloudTAK REST API
 *   GET /api/icons/*         → icon proxy to CloudTAK
 *   GET /api/sprite/:id/*    → iconset sprite proxy to CloudTAK
 *   GET /static/*            → static assets (sprites, logo)
 *   GET /health              → health check
 *
 * Configuration is loaded from:
 *   - S3 (CONFIG_BUCKET + CONFIG_KEY env vars) in production
 *   - Local file (LOCAL_CONFIG_FILE env var or --config flag) in dev
 *
 * Usage:
 *   node server.mjs [--config /path/to/config.json] [--port 3000]
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI args / env
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2);
const configIdx  = args.indexOf('--config');
const portIdx    = args.indexOf('--port');
const PORT       = parseInt(portIdx !== -1 ? args[portIdx + 1] : (process.env.PORT || '3000'));

// Config file path (local dev or container with mounted config)
const CONFIG_FILE = configIdx !== -1
    ? path.resolve(args[configIdx + 1])
    : process.env.LOCAL_CONFIG_FILE || path.join(__dirname, 'config.json');

// For S3-based config (production), set these env vars:
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY    = process.env.CONFIG_KEY || 'Utils-Display-Proxy-Config.json';
const CONFIG_TTL_MS = 60 * 1000; // re-read config every 60s

let cachedConfig = null;
let configLoadedAt = 0;

async function getConfig() {
    const now = Date.now();
    if (cachedConfig && (now - configLoadedAt) < CONFIG_TTL_MS) return cachedConfig;

    if (fs.existsSync(CONFIG_FILE)) {
        cachedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        configLoadedAt = now;
        return cachedConfig;
    }

    if (CONFIG_BUCKET) {
        const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
        const res = await s3.send(new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: CONFIG_KEY }));
        const body = await res.Body.transformToString();
        cachedConfig = JSON.parse(body);
        configLoadedAt = now;
        return cachedConfig;
    }

    throw new Error('No config available. Set CONFIG_BUCKET or provide --config / LOCAL_CONFIG_FILE');
}

// Ensure config is available at startup
const startupConfig = await getConfig();

// Set LOCAL_CONFIG_FILE for the Lambda-style handlers
if (fs.existsSync(CONFIG_FILE)) {
    process.env.LOCAL_CONFIG_FILE = CONFIG_FILE;
}

// ---------------------------------------------------------------------------
// Import handlers
// ---------------------------------------------------------------------------
const { handler: cotHandler, getSessionJwt } = await import('./lambdas/tak-cot-proxy/index.mjs');
const { handler: iconHandler } = await import('./lambdas/tak-icon-proxy/index.mjs');
import { init as initContacts, getFeatures as getContactFeatures } from './lambdas/tak-contacts-ws/index.mjs';

// Start contacts WebSocket
initContacts(startupConfig).catch(err => console.warn('[contacts-ws] Init failed:', err.message));

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function toEvent(req) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const qp = {};
    url.searchParams.forEach((v, k) => { qp[k] = v; });
    return { rawPath: url.pathname, path: url.pathname, queryStringParameters: qp };
}

function sendLambdaResponse(lambdaRes, res) {
    const headers = { 'Access-Control-Allow-Origin': '*', ...(lambdaRes.headers || {}) };
    res.writeHead(lambdaRes.statusCode || 200, headers);
    if (lambdaRes.isBase64Encoded) {
        res.end(Buffer.from(lambdaRes.body, 'base64'));
    } else {
        res.end(lambdaRes.body ?? '');
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.json': 'application/json',
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    try {
        // Health check (unauthenticated — required for ALB/ECS health checks)
        if (pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }

        // -------------------------------------------------------------------
        // Auth: validate ?key= on page and API data requests.
        // Static assets, /api/config, and sprite proxies are exempt — they
        // contain no sensitive data and are fetched without query params.
        // -------------------------------------------------------------------
        if (!pathname.startsWith('/static/') && pathname !== '/api/config' && !pathname.startsWith('/api/sprite/') && pathname !== '/favicon.ico') {
            const config = await getConfig();
            const queryKey = url.searchParams.get('key') || '';
            if (!queryKey || !Array.isArray(config.access_keys) || !config.access_keys.includes(queryKey)) {
                res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!DOCTYPE html><html><head><title>Access Denied</title></head><body style="background:#111;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Access Denied</h1><p style="color:#888">A valid <code>?key=</code> parameter is required.</p></div></body></html>');
                return;
            }
        }

        // Public config (layers, iconsets — no secrets)
        if (pathname === '/api/config') {
            const cfg = await getConfig();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
            res.end(JSON.stringify({ iconsets: cfg.iconsets || [], layers: cfg.layers || [], contact_groups: cfg.contact_groups || {}, view_loop: cfg.view_loop || [], overlays: cfg.overlays || [] }));
            return;
        }

        // CoT endpoints
        if (pathname.startsWith('/api/cot/')) {
            if (pathname === '/api/cot/contacts') {
                const fc = getContactFeatures();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(fc));
                return;
            }
            sendLambdaResponse(await cotHandler(toEvent(req)), res);
            return;
        }

        // Icon proxy
        if (pathname.startsWith('/api/icons/')) {
            sendLambdaResponse(await iconHandler(toEvent(req)), res);
            return;
        }

        // Iconset sprite proxy
        const spriteMatch = pathname.match(/^\/api\/sprite\/([^/]+)\/(sprite(?:@2x)?\.(?:json|png))$/);
        if (spriteMatch) {
            const config = await getConfig();
            const baseUrl = (config.cloudtak_url || '').replace(/\/$/, '');
            const token = await getSessionJwt(config);
            const iconsetId = decodeURIComponent(spriteMatch[1]);
            const spriteFile = spriteMatch[2];
            const upstream = `${baseUrl}/api/iconset/${encodeURIComponent(iconsetId)}/${spriteFile}`;

            const upRes = await fetch(upstream, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            });
            if (!upRes.ok) { res.writeHead(upRes.status); res.end(`Upstream: ${upRes.status}`); return; }

            const contentType = spriteFile.endsWith('.json') ? 'application/json' : 'image/png';
            const buffer = Buffer.from(await upRes.arrayBuffer());
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
            res.end(buffer);
            return;
        }

        // Static files
        const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
        const fullPath = path.join(__dirname, filePath);

        // Favicon
        if (pathname === '/favicon.ico') {
            const faviconPath = path.join(__dirname, 'static', 'tak-nz-logo.svg');
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
            fs.createReadStream(faviconPath).pipe(res);
            return;
        }

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const ext = path.extname(fullPath);
            const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
            fs.createReadStream(fullPath).pipe(res);
            return;
        }

        // Fallback → index.html
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);

    } catch (err) {
        console.error(`[${pathname}]`, err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    }
});

server.listen(PORT, () => {
    console.log(`display-proxy → http://0.0.0.0:${PORT}`);
    console.log(`Config: ${fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : 'S3 (' + CONFIG_BUCKET + '/' + CONFIG_KEY + ')'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
});
