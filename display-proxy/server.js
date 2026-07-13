'use strict';

const http             = require('http');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { chromium }     = require('playwright');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT         = process.env.PORT        || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY    = process.env.CONFIG_KEY  || 'Utils-Display-Proxy-Config.json';
const AWS_REGION    = process.env.AWS_REGION  || 'ap-southeast-2';

const BOUNDARY      = 'mjpegframe';
const CONFIG_POLL_MS = 5 * 60 * 1000;   // re-read S3 config every 5 minutes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let config          = null;   // loaded from S3
let currentFrame    = null;   // Buffer — latest JPEG frame
let lastFrameTime   = null;
let browserLoop     = null;   // BrowserLoop instance
const clients       = new Set();

const s3 = new S3Client({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// S3 config loader
// ---------------------------------------------------------------------------

async function loadConfig() {
    if (!CONFIG_BUCKET) {
        console.warn('CONFIG_BUCKET not set — using defaults (for local dev)');
        return {
            cloudtak_url:         'https://map.demo.tak.nz',
            cloudtak_token:       process.env.CLOUDTAK_TOKEN || '',
            display_url_params:   '/',
            viewport_width:       1920,
            viewport_height:      1080,
            jpeg_quality:         80,
            initial_wait_ms:      15000,
            access_keys:          ['demo'],
        };
    }

    console.log(`Loading config from s3://${CONFIG_BUCKET}/${CONFIG_KEY}`);
    const res = await s3.send(new GetObjectCommand({
        Bucket: CONFIG_BUCKET,
        Key:    CONFIG_KEY,
    }));

    const body = await res.Body.transformToString();
    const cfg  = JSON.parse(body);
    console.log('Config loaded from S3');
    return cfg;
}

// ---------------------------------------------------------------------------
// Browser / CDP screencast loop
// ---------------------------------------------------------------------------

class BrowserLoop {
    constructor(cfg) {
        this.cfg     = cfg;
        this.browser = null;
        this.running = false;
    }

    loginUrl() {
        // Same approach as screenshot-loop.cjs — construct full login URL
        const base    = this.cfg.cloudtak_url.replace(/\/$/, '');
        const token   = encodeURIComponent(this.cfg.cloudtak_token);
        const redirect = encodeURIComponent(this.cfg.display_url_params || '/');
        return `${base}/login?token=${token}&redirect=${redirect}`;
    }

    async start() {
        this.running = true;
        console.log('Launching headless Chromium…');

        this.browser = await chromium.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const context = await this.browser.newContext();
        this.page     = await context.newPage();

        await this.page.setViewportSize({
            width:  this.cfg.viewport_width  || 1920,
            height: this.cfg.viewport_height || 1080,
        });

        const loginUrl = this.loginUrl();
        console.log(`Navigating to ${this.cfg.cloudtak_url}…`);
        await this.page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 90000 });

        const waitMs = this.cfg.initial_wait_ms || 15000;
        console.log(`Waiting ${waitMs / 1000}s for map tiles and icons…`);
        await new Promise(r => setTimeout(r, waitMs));

        console.log('Starting CDP screencast…');
        this.cdp = await context.newCDPSession(this.page);

        await this.cdp.send('Page.startScreencast', {
            format:        'jpeg',
            quality:       this.cfg.jpeg_quality || 80,
            maxWidth:      this.cfg.viewport_width  || 1920,
            maxHeight:     this.cfg.viewport_height || 1080,
            everyNthFrame: 1,
        });

        this.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
            currentFrame  = Buffer.from(data, 'base64');
            lastFrameTime = new Date();

            // Ack so Chrome continues sending frames
            await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

            // Push to all connected MJPEG clients
            pushFrame(currentFrame);
        });

        this.browser.on('disconnected', () => {
            if (!this.running) return;
            console.error('Browser disconnected — restarting in 5s…');
            this.browser = null;
            setTimeout(() => this.start(), 5000);
        });

        console.log('Screencast running.');
    }

    async stop() {
        this.running = false;
        if (this.cdp) {
            await this.cdp.send('Page.stopScreencast').catch(() => {});
            this.cdp = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
    }
}

// ---------------------------------------------------------------------------
// MJPEG push to connected clients
// ---------------------------------------------------------------------------

function pushFrame(frame) {
    const header = Buffer.from(
        `--${BOUNDARY}\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${frame.length}\r\n` +
        `\r\n`
    );
    const packet = Buffer.concat([header, frame, Buffer.from('\r\n')]);

    for (const res of clients) {
        try {
            res.write(packet);
        } catch {
            clients.delete(res);
        }
    }
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function isAuthorised(key) {
    if (!config || !config.access_keys || config.access_keys.length === 0) return false;
    return config.access_keys.includes(key);
}

// ---------------------------------------------------------------------------
// HTML wrapper page
// ---------------------------------------------------------------------------

function buildPage(key) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>CloudTAK Live Display</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; background:#000; overflow:hidden; }
    img { width:100vw; height:100vh; object-fit:contain; display:block; }
  </style>
</head>
<body>
  <img src="/stream?key=${key}" alt="CloudTAK Live Display"/>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
    const parsed   = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const key      = parsed.searchParams.get('key');

    // Health — no auth
    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status:     'ok',
            stream:     currentFrame ? 'ready' : 'initialising',
            lastFrame:  lastFrameTime,
            clients:    clients.size,
        }));
        return;
    }

    // Auth required for all other endpoints
    if (!isAuthorised(key)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing key' }));
        return;
    }

    // GET /view — HTML wrapper (browser / AbleSign web page mode)
    if (pathname === '/view') {
        const html = buildPage(key);
        res.writeHead(200, {
            'Content-Type':  'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
    }

    // GET /stream — MJPEG stream (AbleSign image URL mode, or <img> src)
    if (pathname === '/stream') {
        res.writeHead(200, {
            'Content-Type':  `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-store',
            'Connection':    'keep-alive',
            'Pragma':        'no-cache',
        });

        clients.add(res);
        console.log(`[${new Date().toISOString()}] Client connected (${clients.size} total)`);

        // Send current frame immediately — no waiting for next capture
        if (currentFrame) {
            pushFrame(currentFrame);
        }

        req.on('close', () => {
            clients.delete(res);
            console.log(`[${new Date().toISOString()}] Client disconnected (${clients.size} total)`);
        });

        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
    // Load initial config
    config = await loadConfig();

    // Poll S3 for config changes every 5 minutes
    // If config changes, restart the browser loop with new settings
    setInterval(async () => {
        try {
            const newConfig = await loadConfig();
            const changed   =
                newConfig.cloudtak_url      !== config.cloudtak_url      ||
                newConfig.cloudtak_token    !== config.cloudtak_token    ||
                newConfig.display_url_params !== config.display_url_params ||
                newConfig.viewport_width    !== config.viewport_width    ||
                newConfig.viewport_height   !== config.viewport_height;

            config = newConfig;

            if (changed && browserLoop) {
                console.log('Config changed — restarting browser loop…');
                await browserLoop.stop();
                browserLoop = new BrowserLoop(config);
                await browserLoop.start();
            }
        } catch (err) {
            console.error('Failed to reload config from S3:', err.message);
        }
    }, CONFIG_POLL_MS);

    // Start browser loop
    browserLoop = new BrowserLoop(config);
    await browserLoop.start();

    // Start HTTP server
    server.listen(PORT, () => {
        console.log(`display-proxy listening on port ${PORT}`);
        console.log(`  /view?key=<token>   — HTML wrapper`);
        console.log(`  /stream?key=<token> — MJPEG stream`);
        console.log(`  /health             — health check`);
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
