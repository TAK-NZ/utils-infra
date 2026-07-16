/**
 * Local development server for the display-proxy web app.
 *
 * Mimics the CloudFront + Lambda architecture locally:
 *   GET /             → serves index.html
 *   GET /api/cot/*    → tak-cot-proxy Lambda handler (in-process)
 *   GET /api/icons/*  → tak-icon-proxy Lambda handler (in-process)
 *   GET /health       → 200 OK
 *
 * Usage:
 *   node dev-server.mjs [--config /path/to/config.json] [--port 3000]
 *
 * The config file must match Utils-Display-Proxy-Config.sample.json.
 * Copy the sample, fill in a real cloudtak_token and access_keys, then:
 *
 *   cp Utils-Display-Proxy-Config.sample.json Utils-Display-Proxy-Config.local.json
 *   # edit Utils-Display-Proxy-Config.local.json
 *   node dev-server.mjs --config Utils-Display-Proxy-Config.local.json
 *
 * Then open:
 *   http://localhost:3000?key=<your-access-key>&lat=-41.19&lng=174.78&zoom=5.3
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2);
const configIdx  = args.indexOf('--config');
const portIdx    = args.indexOf('--port');
const PORT       = parseInt(portIdx  !== -1 ? args[portIdx  + 1] : (process.env.PORT  || '3000'));
const CONFIG_FILE = configIdx !== -1
    ? path.resolve(args[configIdx + 1])
    : path.join(__dirname, 'Utils-Display-Proxy-Config.local.json');

if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Config file not found: ${CONFIG_FILE}`);
    console.error(`Copy the sample and fill in your credentials:`);
    console.error(`  cp display-proxy/Utils-Display-Proxy-Config.sample.json display-proxy/Utils-Display-Proxy-Config.local.json`);
    process.exit(1);
}

// Set the env var that tells the Lambda handlers to read from a local file
process.env.LOCAL_CONFIG_FILE = CONFIG_FILE;

// ---------------------------------------------------------------------------
// Import Lambda handlers (after setting LOCAL_CONFIG_FILE)
// ---------------------------------------------------------------------------
const { handler: cotHandler  } = await import('./lambdas/tak-cot-proxy/index.mjs');
const { handler: iconHandler } = await import('./lambdas/tak-icon-proxy/index.mjs');

// Contacts WebSocket — maintains live user positions
import { init as initContacts, getFeatures as getContactFeatures } from './lambdas/tak-contacts-ws/index.mjs';
const config_for_ws = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
initContacts(config_for_ws).catch(err => console.warn('[contacts-ws] Init failed:', err.message));

// Build a minimal Lambda-style event from an http.IncomingMessage
function toEvent(req) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const qp  = {};
    url.searchParams.forEach((v, k) => { qp[k] = v; });
    return {
        rawPath:               url.pathname,
        path:                  url.pathname,
        queryStringParameters: qp,
    };
}

// Write a Lambda response object back to the HTTP response
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
    '.css':  'text/css',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Health
    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'local-dev' }));
        return;
    }

    // Config endpoint — exposes layers and iconsets list to frontend
    if (pathname === '/api/config') {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
            iconsets: config.iconsets || [],
            layers: config.layers || [],
            contact_groups: config.contact_groups || {},
        }));
        return;
    }

    // CoT proxy → tak-cot-proxy Lambda
    if (pathname.startsWith('/api/cot/')) {
        // Special case: contacts come from WebSocket, not REST
        if (pathname === '/api/cot/contacts') {
            const fc = getContactFeatures();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(fc));
            return;
        }
        try {
            sendLambdaResponse(await cotHandler(toEvent(req)), res);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Icon proxy → tak-icon-proxy Lambda
    if (pathname.startsWith('/api/icons/')) {
        try {
            sendLambdaResponse(await iconHandler(toEvent(req)), res);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Iconset sprite proxy → CloudTAK /api/iconset/:id/sprite{.json|.png}
    const spriteMatch = pathname.match(/^\/api\/sprite\/([^/]+)\/(sprite(?:@2x)?\.(?:json|png))$/);
    if (spriteMatch) {
        try {
            const config     = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            const baseUrl    = (config.cloudtak_url || '').replace(/\/$/, '');
            const { getSessionJwt } = await import('./lambdas/tak-cot-proxy/index.mjs');
            const token      = await getSessionJwt(config);

            const iconsetId  = decodeURIComponent(spriteMatch[1]);
            const spriteFile = spriteMatch[2];
            const upstream   = `${baseUrl}/api/iconset/${encodeURIComponent(iconsetId)}/${spriteFile}`;

            const upRes = await fetch(upstream, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            });
            if (!upRes.ok) { res.writeHead(upRes.status); res.end(`Upstream: ${upRes.status}`); return; }

            const contentType = spriteFile.endsWith('.json') ? 'application/json' : 'image/png';
            const buffer = Buffer.from(await upRes.arrayBuffer());
            res.writeHead(200, {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(buffer);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(err.message);
        }
        return;
    }

    // Static files
    const filePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fullPath)] || 'application/octet-stream' });
        fs.createReadStream(fullPath).pipe(res);
        return;
    }

    // Fallback → index.html (handles direct page loads with query params)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

server.listen(PORT, () => {
    const config     = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const firstKey   = (config.access_keys || ['demo'])[0];
    const cloudtakUrl = config.cloudtak_url || '(not set)';
    console.log(`\ndisplay-proxy dev server → http://localhost:${PORT}`);
    console.log(`Config:      ${CONFIG_FILE}`);
    console.log(`CloudTAK:    ${cloudtakUrl}`);
    console.log(`Access keys: ${(config.access_keys || []).join(', ')}`);
    console.log(`\nOpen in browser:`);
    console.log(`  http://localhost:${PORT}?key=${firstKey}&lat=-41.19&lng=174.78&zoom=5.3\n`);
});
