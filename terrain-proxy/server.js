const express = require('express');
const sharp = require('sharp');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'Utils-Terrain-Proxy-Config.json';

let LINZ_API_KEY = process.env.LINZ_API_KEY || 'PLACEHOLDER_API_KEY';

// Cache tiles in memory (elevation data is static). The defaults suit a long-running container. On Lambda, where
// memory is fixed and each environment has its own cache, the stack sets a smaller key limit and an expiry.
const TILE_CACHE_MAX_KEYS = parseInt(process.env.TILE_CACHE_MAX_KEYS, 10) || 50000;
const TILE_CACHE_TTL_SECONDS = parseInt(process.env.TILE_CACHE_TTL_SECONDS, 10) || 0;
const tileCache = new NodeCache({ stdTTL: TILE_CACHE_TTL_SECONDS, maxKeys: TILE_CACHE_MAX_KEYS });

// NodeCache.set() throws once maxKeys is reached. A full cache must only mean "not cached", never a failed tile.
function cacheTile(key, buffer) {
  try {
    tileCache.set(key, buffer);
  } catch {
    /* cache full: serve this tile uncached */
  }
}

const TILE_SIZE = 256;
const MAX_ZOOM = 14;
const NZ_BOUNDS = { minLat: -48.0, maxLat: -34.0, minLon: 166.0, maxLon: 179.0 };

// Load the static manifest template once at startup
const manifestTemplate = fs.readFileSync(
  path.join(__dirname, 't3-taknz.json'),
  'utf8'
);

// Load config from S3 (LINZ API key). Resolves to false when the config could not be read, so that a caller which can
// retry (the Lambda handler) does not keep serving tiles with the placeholder key.
async function loadConfigFromS3() {
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using LINZ_API_KEY from environment');
    return true;
  }
  try {
    const command = new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: CONFIG_KEY });
    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    const config = JSON.parse(body);
    if (config.apikey) {
      LINZ_API_KEY = config.apikey;
      console.log('Loaded LINZ API key from S3 config');
    }
    return true;
  } catch (error) {
    console.error('Failed to load config from S3:', error.message);
    return false;
  }
}

// Loads everything the routes need before the first request: the LINZ API key and the geoid model. Rejects when the
// config cannot be read; lambda.js then answers 503 and tries again on the next request.
async function prepare() {
  if (!(await loadConfigFromS3())) {
    throw new Error('Could not load the terrain proxy config from S3');
  }
  loadGeoidModel();
}

// --- Coordinate conversion ---

function lonToMercatorX(lon, zoom) {
  return ((lon + 180) / 360) * (TILE_SIZE * Math.pow(2, zoom));
}

function latToMercatorY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return ((1 - mercN / Math.PI) / 2) * (TILE_SIZE * Math.pow(2, zoom));
}

// EPSG:4326 quadtree: 2 tiles wide at z=0 (360°), 1 tile tall (180°)
function tileToLatLonBounds(z, x, y) {
  const numTilesX = 2 * Math.pow(2, z);
  const numTilesY = Math.pow(2, z);
  return {
    latMin: 90 - ((y + 1) / numTilesY) * 180,
    latMax: 90 - (y / numTilesY) * 180,
    lonMin: (x / numTilesX) * 360 - 180,
    lonMax: ((x + 1) / numTilesX) * 360 - 180,
  };
}

function tileOverlapsNZ(z, x, y) {
  const b = tileToLatLonBounds(z, x, y);
  return b.lonMax > NZ_BOUNDS.minLon && b.lonMin < NZ_BOUNDS.maxLon &&
         b.latMax > NZ_BOUNDS.minLat && b.latMin < NZ_BOUNDS.maxLat;
}

function getMercatorTilesForBounds(bounds, mercZoom) {
  const xMin = Math.floor(lonToMercatorX(bounds.lonMin, mercZoom) / TILE_SIZE);
  const xMax = Math.floor(lonToMercatorX(bounds.lonMax, mercZoom) / TILE_SIZE);
  const yMin = Math.floor(latToMercatorY(bounds.latMax, mercZoom) / TILE_SIZE);
  const yMax = Math.floor(latToMercatorY(bounds.latMin, mercZoom) / TILE_SIZE);
  const maxTile = Math.pow(2, mercZoom) - 1;
  const tiles = [];
  for (let ty = Math.max(0, yMin); ty <= Math.min(maxTile, yMax); ty++) {
    for (let tx = Math.max(0, xMin); tx <= Math.min(maxTile, xMax); tx++) {
      tiles.push({ x: tx, y: ty, z: mercZoom });
    }
  }
  return tiles;
}

// --- LINZ tile fetching ---

// A LINZ tile that could not be obtained for a reason other than "there is no data here": a bad or expired API key,
// rate limiting, a LINZ outage, a timeout, or an unreadable tile. The route answers these with 503 and no-store, because
// a tile built without the data would be wrong, and a cached wrong tile stays wrong for the cache's lifetime.
class TileSourceError extends Error {}

// HTTP statuses that mean LINZ has no elevation data for a tile (open ocean, outside coverage). Such a tile is
// elevation 0 by design. Every other non-OK status is a failure. Comma separated; override with LINZ_NO_DATA_STATUSES.
const LINZ_NO_DATA_STATUSES = new Set(
  (process.env.LINZ_NO_DATA_STATUSES || '404')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isInteger)
);

// Resolves to the tile, or null when LINZ has no data for it. Rejects with TileSourceError when it could not be fetched.
async function fetchLinzTile(z, x, y) {
  const cacheKey = `linz-${z}-${x}-${y}`;
  const cached = tileCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://basemaps.linz.govt.nz/v1/tiles/elevation/WebMercatorQuad/${z}/${x}/${y}.png?pipeline=terrain-rgb&api=${LINZ_API_KEY}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'terrain-proxy/1.0 (TAK-NZ)' },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (LINZ_NO_DATA_STATUSES.has(res.status)) return null;
      throw new TileSourceError(`LINZ tile ${z}/${x}/${y} returned HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    cacheTile(cacheKey, buffer);
    return buffer;
  } catch (error) {
    if (error instanceof TileSourceError) throw error;
    // Not error.message alone for a timeout: it is just "This operation was aborted". The URL (which holds the API
    // key) is never logged.
    const reason = error.name === 'AbortError' ? 'timed out' : `failed (${error.message})`;
    throw new TileSourceError(`LINZ tile ${z}/${x}/${y} ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Elevation encoding ---

// Mapbox Terrain-RGB → meters
function terrainRgbToElevation(r, g, b) {
  return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

// Meters → Mapbox Terrain-RGB encoding (same as LINZ source and TAK Bathy)
// Decode formula: elevation = -10000 + (R * 65536 + G * 256 + B) * 0.1
function elevationToTakRgb(elevation) {
  const encoded = Math.round((elevation + 10000) / 0.1);
  const clamped = Math.max(0, Math.min(16777215, encoded));
  const r = (clamped >> 16) & 0xFF;
  const g = (clamped >> 8) & 0xFF;
  const b = clamped & 0xFF;
  return { r, g, b };
}

// --- NZGeoid2016 geoid model ---

let geoidGrid = null;
let geoidMeta = null;

function loadGeoidModel() {
  if (geoidGrid) return;
  const gtxPath = path.join(__dirname, 'NZGeoid2016.gtx');
  const buf = fs.readFileSync(gtxPath);
  const latMin = buf.readDoubleBE(0);
  const lonMin = buf.readDoubleBE(8);
  const dlat = buf.readDoubleBE(16);
  const dlon = buf.readDoubleBE(24);
  const nrows = buf.readInt32BE(32);
  const ncols = buf.readInt32BE(36);
  geoidMeta = { latMin, lonMin, dlat, dlon, nrows, ncols };
  geoidGrid = buf.subarray(44);
  console.log(`Geoid model loaded: ${nrows}x${ncols}, lat ${latMin} to ${latMin + (nrows-1)*dlat}, lon ${lonMin} to ${lonMin + (ncols-1)*dlon}`);
}

function getGeoidSeparation(lat, lon) {
  if (!geoidGrid) loadGeoidModel();
  const { latMin, lonMin, dlat, dlon, nrows, ncols } = geoidMeta;
  let adjLon = lon < 0 ? lon + 360 : lon;
  const row = (lat - latMin) / dlat;
  const col = (adjLon - lonMin) / dlon;
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  if (r0 < 0 || r0 >= nrows - 1 || c0 < 0 || c0 >= ncols - 1) return 0;
  // Bilinear interpolation
  const fr = row - r0;
  const fc = col - c0;
  const v00 = geoidGrid.readFloatBE((r0 * ncols + c0) * 4);
  const v01 = geoidGrid.readFloatBE((r0 * ncols + c0 + 1) * 4);
  const v10 = geoidGrid.readFloatBE(((r0 + 1) * ncols + c0) * 4);
  const v11 = geoidGrid.readFloatBE(((r0 + 1) * ncols + c0 + 1) * 4);
  return v00 * (1-fr) * (1-fc) + v01 * (1-fr) * fc + v10 * fr * (1-fc) + v11 * fr * fc;
}

// --- Sea-level tile (singleton) ---

let seaLevelTile = null;
async function getSeaLevelTile() {
  if (seaLevelTile) return seaLevelTile;
  const tak = elevationToTakRgb(0);
  const px = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
  for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
    px[i * 4] = tak.r;
    px[i * 4 + 1] = tak.g;
    px[i * 4 + 2] = tak.b;
    px[i * 4 + 3] = 255;
  }
  seaLevelTile = await sharp(px, {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  }).png({ compressionLevel: 9 }).toBuffer();
  return seaLevelTile;
}

// --- Core tile generation ---

async function generateTerrainTile(z, x, y) {
  const cacheKey = `tak-${z}-${x}-${y}`;
  const cached = tileCache.get(cacheKey);
  if (cached) return cached;

  const bounds = tileToLatLonBounds(z, x, y);

  if (!tileOverlapsNZ(z, x, y)) {
    const tile = await getSeaLevelTile();
    cacheTile(cacheKey, tile);
    return tile;
  }

  // Pick a Mercator zoom that gives enough resolution
  const mercZoom = Math.min(z + 1, 18);
  const mercTiles = getMercatorTilesForBounds(bounds, mercZoom);
  if (mercTiles.length === 0) return getSeaLevelTile();

  // Fetch all needed LINZ tiles in parallel. Wait for all of them, so the ones that did arrive are cached and a retry
  // only has to fetch the ones that failed. If any failed, the output tile cannot be built correctly: throw, so it is
  // neither cached nor served. (A source tile with no data, null, is fine: that area is elevation 0.)
  const results = await Promise.allSettled(
    mercTiles.map(async (t) => ({ ...t, data: await fetchLinzTile(t.z, t.x, t.y) }))
  );
  const failure = results.find((r) => r.status === 'rejected');
  if (failure) throw failure.reason;
  const fetched = results.map((r) => r.value);

  // Decode source tiles into raw pixel arrays
  const srcMap = new Map();
  const undecodable = [];
  for (const t of fetched) {
    if (!t.data) continue;
    try {
      const { data, info } = await sharp(t.data).raw().toBuffer({ resolveWithObject: true });
      srcMap.set(`${t.z}-${t.x}-${t.y}`, {
        pixels: data, width: info.width, height: info.height, channels: info.channels,
        tileX: t.x, tileY: t.y,
      });
    } catch {
      // Do not keep an unreadable tile in the cache, or every retry would fail on it. Check all of them first, so one
      // retry is enough when several are unreadable.
      tileCache.del(`linz-${t.z}-${t.x}-${t.y}`);
      undecodable.push(`${t.z}/${t.x}/${t.y}`);
    }
  }
  if (undecodable.length > 0) {
    throw new TileSourceError(`LINZ tile(s) could not be decoded: ${undecodable.join(', ')}`);
  }

  // Every source tile had no data (open ocean): the whole output tile is elevation 0
  if (srcMap.size === 0) return getSeaLevelTile();

  // Sample elevation for each output pixel
  const out = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);

  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const lon = bounds.lonMin + ((px + 0.5) / TILE_SIZE) * (bounds.lonMax - bounds.lonMin);
      const lat = bounds.latMax - ((py + 0.5) / TILE_SIZE) * (bounds.latMax - bounds.latMin);

      const mercPx = lonToMercatorX(lon, mercZoom);
      const mercPy = latToMercatorY(lat, mercZoom);
      const srcTX = Math.floor(mercPx / TILE_SIZE);
      const srcTY = Math.floor(mercPy / TILE_SIZE);

      let elevation = 0;
      const src = srcMap.get(`${mercZoom}-${srcTX}-${srcTY}`);
      if (src) {
        const lx = Math.max(0, Math.min(src.width - 1, Math.floor(mercPx - srcTX * TILE_SIZE)));
        const ly = Math.max(0, Math.min(src.height - 1, Math.floor(mercPy - srcTY * TILE_SIZE)));
        const idx = (ly * src.width + lx) * src.channels;
        elevation = terrainRgbToElevation(src.pixels[idx], src.pixels[idx + 1], src.pixels[idx + 2]);

        // NZVD2016 → HAE using NZGeoid2016 geoid model (bilinear interpolation)
        elevation += getGeoidSeparation(lat, lon);
      }

      const tak = elevationToTakRgb(elevation);
      const oi = (py * TILE_SIZE + px) * 4;
      out[oi] = tak.r;
      out[oi + 1] = tak.g;
      out[oi + 2] = tak.b;
      out[oi + 3] = 255;
    }
  }

  const pngBuffer = await sharp(out, {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  }).png({ compressionLevel: 6 }).toBuffer();

  cacheTile(cacheKey, pngBuffer);
  return pngBuffer;
}

// --- Routes ---

// TAK terrain manifest — serves t3-taknz.json with {BASE_URL} replaced
app.get('/terrain/t3-taknz-elevation-manifest.json', (req, res) => {
  const apiKey = req.query.api;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required', message: 'Use ?api=your-key' });
  }

  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;
  const manifest = manifestTemplate
    .replace('{BASE_URL}', baseUrl)
    .replace('{API_KEY}', apiKey);

  res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
  res.send(manifest);
});

// Health check
app.get('/terrain/health', (req, res) => {
  res.json({
    status: 'ok',
    cache_keys: tileCache.keys().length,
    linz_api_configured: LINZ_API_KEY !== 'PLACEHOLDER_API_KEY',
    config_source: CONFIG_BUCKET ? 'S3' : 'environment',
    config_bucket: !!CONFIG_BUCKET,
    coverage: NZ_BOUNDS,
    max_zoom: MAX_ZOOM,
    tile_size: TILE_SIZE,
  });
});

// Terrain tile endpoint
app.get('/terrain/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  if (isNaN(z) || isNaN(x) || isNaN(y)) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }
  if (z < 0 || z >= MAX_ZOOM) {
    return res.status(400).json({ error: `Zoom must be 0-${MAX_ZOOM - 1}` });
  }

  const maxX = 2 * Math.pow(2, z) - 1;
  const maxY = Math.pow(2, z) - 1;
  if (x < 0 || x > maxX || y < 0 || y > maxY) {
    return res.status(400).json({ error: 'Tile coordinates out of range' });
  }

  try {
    const tile = await generateTerrainTile(z, x, y);
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-Terrain-Source': 'LINZ NZ Elevation',
    });
    res.send(tile);
  } catch (error) {
    // Never answer with a made-up (sea-level) tile: a client would take it for real elevation, and a cache would keep
    // it. An error is not cached for long (CloudFront holds 5xx responses for seconds), and the client can retry.
    console.error(`Error generating terrain tile ${z}/${x}/${y}:`, error.message);
    const sourceProblem = error instanceof TileSourceError;
    res.status(sourceProblem ? 503 : 500).set({
      'Cache-Control': 'no-store',
      ...(sourceProblem ? { 'Retry-After': '5' } : {}),
    }).json({
      error: sourceProblem ? 'Elevation source temporarily unavailable' : 'Failed to generate terrain tile',
    });
  }
});

// Only listen when run directly (not when required for testing)
if (require.main === module) {
  loadConfigFromS3().then(() => {
    loadGeoidModel();
    app.listen(PORT, () => {
      console.log(`Terrain proxy running on port ${PORT}`);
      console.log(`LINZ API key: ${LINZ_API_KEY !== 'PLACEHOLDER_API_KEY' ? 'configured' : 'NOT SET'}`);
      console.log(`Config source: ${CONFIG_BUCKET ? 'S3' : 'environment'}`);
      console.log(`Coverage: NZ (${NZ_BOUNDS.minLat}° to ${NZ_BOUNDS.maxLat}°, ${NZ_BOUNDS.minLon}° to ${NZ_BOUNDS.maxLon}°)`);
      console.log(`Max zoom: ${MAX_ZOOM - 1} (${MAX_ZOOM} levels), Tile size: ${TILE_SIZE}px`);
    });
  });
}

module.exports = app;
// Used by lambda.js. (Not named "init": Express apps already have an init() method.)
module.exports.prepare = prepare;
