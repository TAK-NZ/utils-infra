const express = require('express');
const sharp = require('sharp');
const NodeCache = require('node-cache');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes cache
const pathCache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache
const rateLimitCache = new NodeCache({ stdTTL: 60 }); // 1 minute for rate limiting
const apiKeyCache = new NodeCache({ stdTTL: 3600 }); // 1 hour for API keys

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-Weather-Proxy-Api-Keys.json';
const MAX_ZOOM_LEVEL = 9;
const RAINVIEWER_MAX_ZOOM = 7; // RainViewer only supports zoom 0-7, higher zooms are upscaled
const RAINBOW_LAYER_MAX_ZOOM = 7; // Rainbow.ai clouds/radars only support zoom 0-7, higher zooms are upscaled; precip/precip-global support native zoom up to 12
const RAINBOW_LAYERS = ['precip', 'precip-global', 'clouds', 'radars'];
const RATE_LIMIT_PER_MINUTE = 600; // RainViewer allows 600 requests per minute
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Rainbow.ai publishes one map snapshot per layer every 10 minutes (epoch seconds, multiple of 600)
// and keeps tiles available for 2 hours behind the latest one.
const RAINBOW_TILES_BASE = 'https://api.rainbow.ai/tiles/v1';
const SNAPSHOT_STEP_S = 600;
const SNAPSHOT_WINDOW_S = 7200; // oldest snapshot (before the layer's latest) that is still served
const SNAPSHOT_MAX_FUTURE_S = 600; // a snapshot reported this far ahead of our clock is still believable
const SNAPSHOT_CACHE_TTL_S = 60; // how long a layer's latest snapshot is reused
const SNAPSHOT_FAILURE_CACHE_TTL_S = 15; // how long the clock-based fallback is reused after a failed lookup
const SNAPSHOT_FETCH_TIMEOUT_MS = 5000;
const SNAPSHOT_STEP_BACK_MAX = 2; // extra 10-minute steps tried when a derived snapshot has no tile yet
const STALE_TILE_CACHE_TTL_S = 60; // proxy cache lifetime of a tile served from an older snapshot than requested

// Coverage boundaries (approximate global coverage)
const COVERAGE_BOUNDS = {
  minLat: -85,
  maxLat: 85,
  minLng: -180,
  maxLng: 180
};

// Rate limiting middleware
function rateLimit(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const key = `rate_${clientIp}`;
  const current = rateLimitCache.get(key) || 0;
  
  if (current >= RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests, please try again later'
    });
  }
  
  rateLimitCache.set(key, current + 1);
  next();
}

// API key-specific rate limiting
function checkApiKeyRateLimit(apiKey, rateLimit) {
  if (!rateLimit) return { allowed: true };
  
  const key = `api_rate_${apiKey}`;
  const current = rateLimitCache.get(key) || 0;
  
  if (current >= rateLimit) {
    return { 
      allowed: false, 
      message: `API key rate limit exceeded (${rateLimit}/min)` 
    };
  }
  
  rateLimitCache.set(key, current + 1);
  return { allowed: true };
}

// Validate tile coordinates
function validateTileCoordinates(z, x, y) {
  const zoom = parseInt(z);
  const tileX = parseInt(x);
  const tileY = parseInt(y);
  
  if (isNaN(zoom) || isNaN(tileX) || isNaN(tileY)) {
    return { valid: false, error: 'Invalid tile coordinates: must be numbers' };
  }
  
  if (zoom < 0 || zoom > MAX_ZOOM_LEVEL) {
    return { valid: false, error: `Invalid zoom level: must be 0-${MAX_ZOOM_LEVEL}` };
  }
  
  const maxTile = Math.pow(2, zoom) - 1;
  if (tileX < 0 || tileX > maxTile || tileY < 0 || tileY > maxTile) {
    return { valid: false, error: `Invalid tile coordinates for zoom ${zoom}` };
  }
  
  return { valid: true, zoom, tileX, tileY };
}

// Load API keys from S3
async function loadApiKeys() {
  const cached = apiKeyCache.get('keys');
  if (cached) return cached;
  
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using public mode');
    const config = { rainviewer: {}, _publicMode: true };
    apiKeyCache.set('keys', config);
    return config;
  }
  
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY
    });
    
    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    const keys = JSON.parse(body);
    
    apiKeyCache.set('keys', keys);
    return keys;
  } catch (error) {
    console.error('Failed to load API keys from S3:', error.message);
    const config = { rainviewer: {}, _publicMode: true };
    apiKeyCache.set('keys', config);
    return config;
  }
}

// Validate API key from request
async function validateApiKey(providedKey) {
  if (!providedKey) return { valid: false, reason: 'No API key provided' };
  
  const keys = await loadApiKeys();
  
  // If in public mode (no config file), accept any API key
  if (keys._publicMode) {
    return { valid: true, keyName: 'public', rateLimit: null, providers: ['rainviewer', 'rainbow'] };
  }
  
  // Check both rainviewer and general API keys
  const allKeys = { ...keys.rainviewer, ...keys.apiKeys };
  
  for (const [keyName, keyConfig] of Object.entries(allKeys)) {
    if (keyConfig.enabled && keyConfig.key === providedKey) {
      return { 
        valid: true, 
        keyName, 
        rateLimit: keyConfig.rateLimit,
        providers: keyConfig.providers || ['rainviewer']
      };
    }
  }
  
  return { valid: false, reason: 'Invalid API key' };
}

// Retry with exponential backoff
async function retryWithBackoff(fn, retries = MAX_RETRIES, shouldRetry = () => true) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1 || !shouldRetry(error)) throw error;
      const delay = RETRY_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

app.use(express.json());
app.set('trust proxy', true);



// Get latest radar path from RainViewer
async function getLatestPath() {
    // Note: Make sure to rename `timestampCache` to `pathCache` at the top of your file:
    // const pathCache = new NodeCache({ stdTTL: 300 });
    const cached = pathCache.get('latest');
    if (cached) return cached;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
        const response = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
            signal: controller.signal,
            headers: { 'User-Agent': 'weather-proxy/1.0' }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`RainViewer API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Grab the path hash from the last element in the past array
        const latest = data.radar.past[data.radar.past.length - 1];
        
        pathCache.set('latest', latest.path);
        return latest.path;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Failed to get path from RainViewer:', error.message);
        // Fallbacks using math no longer work with hashes, so we must throw
        throw new Error('Could not retrieve latest radar path');
    }
}

// Generic tile upscaling: derive a target-zoom tile by fetching its native-zoom ancestor
// (the closest zoom level the upstream provider actually supports), then cropping out
// the quadrant that corresponds to the requested tile and resizing it back up.
// fetchNativeTile(nativeZoom, ancestorX, ancestorY) must resolve to a 256x256 PNG buffer.
async function upscaleTile(fetchNativeTile, nativeMaxZoom, z, x, y, size) {
  const zoomDiff = z - nativeMaxZoom;
  const scale = Math.pow(2, zoomDiff);
  const ancestorX = Math.floor(x / scale);
  const ancestorY = Math.floor(y / scale);

  const ancestorBuffer = await fetchNativeTile(nativeMaxZoom, ancestorX, ancestorY);

  const cropSize = Math.floor(256 / scale);
  const offsetX = (x % scale) * cropSize;
  const offsetY = (y % scale) * cropSize;

  return await sharp(ancestorBuffer)
    .extract({ left: offsetX, top: offsetY, width: cropSize, height: cropSize })
    .resize(size, size, { kernel: 'nearest' })
    .png()
    .toBuffer();
}

// Identify the image format from its leading bytes so Content-Type matches the real body.
// Rainbow.ai serves some layers (e.g. clouds) as WebP; anything unrecognised is labelled PNG as before.
function sniffImageContentType(buffer) {
  if (buffer && buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer && buffer.length >= 12 &&
      buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buffer && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'image/png';
}

// Clock-based guess of the newest snapshot: the last fully elapsed 10-minute step
function computedSnapshot(nowSeconds) {
  return Math.floor(nowSeconds / SNAPSHOT_STEP_S) * SNAPSHOT_STEP_S - SNAPSHOT_STEP_S;
}

// A snapshot reported by Rainbow.ai must be an integer on a 10-minute boundary close to our clock
function isSaneSnapshot(value, nowSeconds) {
  return Number.isInteger(value) &&
    value % SNAPSHOT_STEP_S === 0 &&
    value <= nowSeconds + SNAPSHOT_MAX_FUTURE_S &&
    value >= nowSeconds - SNAPSHOT_WINDOW_S;
}

// Error for a tile the upstream does not have (yet). Only this kind of error triggers a step back.
function tileNotFoundError() {
  const error = new Error('Tile not found');
  error.tileNotFound = true;
  return error;
}

// Weather provider abstraction layer
class WeatherProvider {
  async getTile(z, x, y, options) {
    throw new Error('getTile must be implemented by subclass');
  }
  
  async getLatestTimestamp() {
    throw new Error('getLatestTimestamp must be implemented by subclass');
  }
  
  async getLatestPath() {
    throw new Error('getLatestPath must be implemented by subclass');
  }
}

// RainViewer provider implementation
class RainViewerProvider extends WeatherProvider {
  async getTile(z, x, y, options) {
    // Upscale from z=7 ancestor for zoom levels 8-9
    if (z > RAINVIEWER_MAX_ZOOM) {
      return await this.getUpscaledTile(z, x, y, options);
    }
    
    return await this.fetchTile(z, x, y, options);
  }
  
  async getUpscaledTile(z, x, y, options) {
    const { size = 256 } = options;
    return await upscaleTile(
      (nativeZoom, ax, ay) => this.fetchTile(nativeZoom, ax, ay, { ...options, size: 256 }),
      RAINVIEWER_MAX_ZOOM,
      z, x, y, size
    );
  }
  
  async fetchTile(z, x, y, options) {
    const { smooth = 0, size = 256, snow = 0 } = options;
    
    return await retryWithBackoff(async () => {
      // Fetch the new path hash instead of the timestamp
      const path = await this.getLatestPath();
      
      // RainViewer only supports a single color scheme (Universal Blue) as of 2025;
      // the `color` param is a Rainbow.ai-only concept and has no effect here.
      const url = `https://tilecache.rainviewer.com${path}/${size}/${z}/${x}/${y}/2/${smooth}_${snow}.png`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'weather-proxy/1.0',
            'Attribution': 'Weather data provided by RainViewer.com'
          }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('Tile not found');
          } else if (response.status === 429) {
            throw new Error('Rate limit exceeded');
          } else if (response.status >= 500) {
            throw new Error(`Server error: ${response.status}`);
          } else {
            throw new Error(`API error: ${response.status}`);
          }
        }
        
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    });
  }
  
  // Update this wrapper function to point to our new global getLatestPath()
  async getLatestPath() {
    return await getLatestPath();
  }
}

// Rainbow.ai's own tile color palette codes (https://doc.rainbow.ai/tile_colors/).
// `color` is a direct pass-through of these values for provider=rainbow - no translation
// layer. RainViewer ignores `color` entirely; it only renders Universal Blue as of 2025.
const RAINBOW_COLORS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'dbz_u8'];
const RAINBOW_COLOR_DEFAULT = '0'; // Rainbow's own default palette

// Rainbow.ai provider implementation
class RainbowProvider extends WeatherProvider {
  constructor() {
    super();
    this.apiKey = null;
    this.snapshotCache = new NodeCache({ stdTTL: SNAPSHOT_CACHE_TTL_S }); // latest snapshot per layer
    this.snapshotFlights = new Map(); // in-flight snapshot lookups per layer
  }
  
  async loadRainbowApiKey() {
    if (this.apiKey) return this.apiKey;
    
    const keys = await loadApiKeys();
    this.apiKey = keys.rainbow?.apiKey || process.env.RAINBOW_API_KEY;
    
    if (!this.apiKey) {
      throw new Error('Rainbow.ai API key not configured');
    }
    
    return this.apiKey;
  }
  
  // Latest snapshot of a layer as { snapshot, source }, where source is 'rainbow' or 'computed'.
  // Layers are published independently (clouds can lag precip), so each layer has its own snapshot.
  // Concurrent callers share one upstream lookup. Never throws: if Rainbow.ai cannot answer with
  // a believable value, the clock-based guess is used so an outage is no worse than before.
  async getLatestSnapshot(layer = 'precip') {
    const cached = this.snapshotCache.get(layer);
    if (cached) return cached;
    
    const inflight = this.snapshotFlights.get(layer);
    if (inflight) return inflight;
    
    const flight = this.lookupLatestSnapshot(layer).finally(() => this.snapshotFlights.delete(layer));
    this.snapshotFlights.set(layer, flight);
    return flight;
  }
  
  async lookupLatestSnapshot(layer) {
    const now = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SNAPSHOT_FETCH_TIMEOUT_MS);
    
    try {
      const apiKey = await this.loadRainbowApiKey();
      const response = await fetch(`${RAINBOW_TILES_BASE}/snapshot?layer=${encodeURIComponent(layer)}`, {
        signal: controller.signal,
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'User-Agent': 'weather-proxy/1.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Snapshot API error: ${response.status}`);
      }
      
      const data = await response.json();
      const snapshot = data && data.snapshot;
      if (!isSaneSnapshot(snapshot, now)) {
        throw new Error('Snapshot API returned an unusable value');
      }
      
      const result = { snapshot, source: 'rainbow' };
      this.snapshotCache.set(layer, result, SNAPSHOT_CACHE_TTL_S);
      return result;
    } catch (error) {
      console.warn(`Rainbow.ai snapshot lookup failed for layer ${layer}, using computed snapshot:`, error.message);
      const result = { snapshot: computedSnapshot(now), source: 'computed' };
      this.snapshotCache.set(layer, result, SNAPSHOT_FAILURE_CACHE_TTL_S);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  
  async getTile(z, x, y, options) {
    const { layer = 'precip' } = options;
    
    // clouds/radars are only natively available up to zoom 7; higher zooms are upscaled.
    // precip/precip-global support up to zoom 12 natively, well beyond our MAX_ZOOM_LEVEL, so no upscaling is needed.
    if ((layer === 'clouds' || layer === 'radars') && z > RAINBOW_LAYER_MAX_ZOOM) {
      return await this.getUpscaledTile(z, x, y, options);
    }
    
    return await this.fetchTile(z, x, y, options);
  }
  
  async getUpscaledTile(z, x, y, options) {
    const { size = 256 } = options;
    return await upscaleTile(
      (nativeZoom, ax, ay) => this.fetchTile(nativeZoom, ax, ay, { ...options, size: 256 }),
      RAINBOW_LAYER_MAX_ZOOM,
      z, x, y, size
    );
  }
  
  // Build the Rainbow.ai tile URL for a given layer. Each layer has a distinct path shape
  // and its own subset of supported query parameters.
  buildUrl(layer, timestamp, z, x, y, options) {
    const { color = RAINBOW_COLOR_DEFAULT, forecast = 0, coverage = 0, usePrecipType = 0 } = options;
    const base = RAINBOW_TILES_BASE;
    
    switch (layer) {
      case 'precip':
      case 'precip-global': {
        const forecastSeconds = Math.min(14400, Math.max(0, forecast * 60));
        const params = new URLSearchParams({ color: String(color) });
        if (coverage) params.set('coverage', '1');
        return `${base}/${layer}/${timestamp}/${forecastSeconds}/${z}/${x}/${y}?${params}`;
      }
      case 'clouds':
        // No query parameters supported for clouds
        return `${base}/clouds/${timestamp}/${z}/${x}/${y}`;
      case 'radars': {
        const params = new URLSearchParams({ color: String(color) });
        if (coverage) params.set('coverage', '1');
        if (usePrecipType) params.set('use_precip_type', '1');
        return `${base}/radars/${timestamp}/${z}/${x}/${y}?${params}`;
      }
      default:
        throw new Error(`Unsupported Rainbow.ai layer: ${layer}`);
    }
  }
  
  // Fetch a tile for options.snapshot. When that snapshot was derived by the proxy (not explicitly
  // requested by the client) and the tile is not there yet, step back one 10-minute snapshot at a
  // time, up to SNAPSHOT_STEP_BACK_MAX times. Other errors are never stepped over.
  async fetchTile(z, x, y, options) {
    const { layer = 'precip' } = options;
    const apiKey = await this.loadRainbowApiKey();
    
    const hasSnapshot = options.snapshot !== undefined;
    const snapshot = hasSnapshot ? options.snapshot : (await this.getLatestSnapshot(layer)).snapshot;
    const derived = hasSnapshot ? !!options.snapshotDerived : true;
    const maxSteps = derived ? SNAPSHOT_STEP_BACK_MAX : 0;
    
    let lastError;
    for (let step = 0; step <= maxSteps; step++) {
      const candidate = snapshot - step * SNAPSHOT_STEP_S;
      try {
        const buffer = await this.fetchSnapshotTile(z, x, y, options, candidate, apiKey);
        if (options.trace) options.trace.snapshot = candidate;
        return buffer;
      } catch (error) {
        if (!error.tileNotFound) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  
  async fetchSnapshotTile(z, x, y, options, timestamp, apiKey) {
    const { size = 256, layer = 'precip' } = options;
    
    // A missing tile will not appear within the backoff window, so it is not retried here
    return await retryWithBackoff(async () => {
      const url = this.buildUrl(layer, timestamp, z, x, y, options);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'User-Agent': 'weather-proxy/1.0'
          }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Rainbow.ai subscription key invalid');
          } else if (response.status === 404 || response.status === 410) {
            throw tileNotFoundError();
          } else if (response.status === 429) {
            throw new Error('Rate limit exceeded');
          } else if (response.status >= 500) {
            throw new Error(`Server error: ${response.status}`);
          } else {
            throw new Error(`API error: ${response.status}`);
          }
        }
        
        const arrayBuffer = await response.arrayBuffer();
        let buffer = Buffer.from(arrayBuffer);
        
        // Rainbow.ai only returns 256x256 tiles
        // If 512x512 is requested, upscale the image
        if (size === 512) {
          buffer = await sharp(buffer)
            .resize(512, 512, { kernel: 'nearest' })
            .png()
            .toBuffer();
        }
        
        return buffer;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }, MAX_RETRIES, (error) => !error.tileNotFound);
  }
}

// Provider instances
const rainviewerProvider = new RainViewerProvider();
const rainbowProvider = new RainbowProvider();

// Get provider instance
function getProvider(providerName) {
  switch (providerName) {
    case 'rainbow':
      return rainbowProvider;
    case 'rainviewer':
    default:
      return rainviewerProvider;
  }
}

// Fetch tile with provider and failover
async function fetchTileWithProvider(z, x, y, options) {
  const { provider = 'rainviewer', api, layer = 'precip' } = options;
  
  // Rainbow.ai requires API key
  if (provider === 'rainbow' && !api) {
    throw new Error('API key required for Rainbow.ai provider');
  }
  
  try {
    const providerInstance = getProvider(provider);
    return { buffer: await providerInstance.getTile(z, x, y, options), fallback: false };
  } catch (error) {
    // Only fallback to RainViewer for precipitation layers, since RainViewer has no
    // equivalent for clouds/radars - falling back there would silently mislabel the data.
    if (provider === 'rainbow' && (layer === 'precip' || layer === 'precip-global')) {
      console.warn('Rainbow.ai failed, falling back to RainViewer:', error.message);
      return { buffer: await rainviewerProvider.getTile(z, x, y, options), fallback: true };
    }
    throw error;
  }
}

// Legacy function for backward compatibility
async function fetchRadarTile(z, x, y, smooth = 0, size = 256, snow = 0) {
  return await rainviewerProvider.getTile(z, x, y, { smooth, size, snow });
}

// Work out which Rainbow.ai snapshot to serve for a layer.
// `hintRaw` is the optional client `snapshot` query value; it is only a hint:
//  - absent: the layer's latest snapshot (derived by the proxy, so missing tiles may step back)
//  - valid: used as is (explicit, no step back)
//  - newer than the layer's latest (a lagging layer): clamped to the latest, not an error
//  - malformed, off the 10-minute grid, or older than the 2 hour window (counted back from the layer's
//    latest, or from the last fully elapsed step if that is older): error
async function resolveRainbowSnapshot(layer, hintRaw) {
  let hint;
  if (hintRaw !== undefined) {
    if (typeof hintRaw !== 'string' || !/^[0-9]{1,12}$/.test(hintRaw) || Number(hintRaw) % SNAPSHOT_STEP_S !== 0) {
      return { error: `snapshot parameter must be an epoch seconds value that is a multiple of ${SNAPSHOT_STEP_S}` };
    }
    hint = Number(hintRaw);
  }
  
  const latest = await rainbowProvider.getLatestSnapshot(layer);
  
  if (hint === undefined) {
    return { snapshot: latest.snapshot, derived: true, clamped: false };
  }
  // The window is anchored to the last fully elapsed step when Rainbow is already on the current one,
  // so clients that count their 2 hour range from the clock (the CloudTAK relay) are never rejected.
  const windowStart = Math.min(latest.snapshot, computedSnapshot(Math.floor(Date.now() / 1000))) - SNAPSHOT_WINDOW_S;
  if (hint < windowStart) {
    return { error: `snapshot parameter is older than the ${SNAPSHOT_WINDOW_S / 3600} hour window available for layer ${layer}` };
  }
  if (hint > latest.snapshot) {
    return { snapshot: latest.snapshot, derived: true, clamped: true };
  }
  return { snapshot: hint, derived: false, clamped: false };
}

// Generate radar tile with enhanced parameters and provider support
async function generateRadarTile(z, x, y, options = {}) {
    const { smooth = 0, size = 256, snow = 0, color = RAINBOW_COLOR_DEFAULT, provider = 'rainviewer', api, forecast = 0, layer = 'precip', coverage = 0, usePrecipType = 0 } = options;
    
    // The effective snapshot is part of the cache key so different snapshots never share bytes
    // and a new snapshot never serves old bytes. RainViewer has no snapshot concept.
    let snapshot = options.snapshot;
    let snapshotDerived = options.snapshotDerived;
    if (provider === 'rainbow' && snapshot === undefined) {
        snapshot = (await rainbowProvider.getLatestSnapshot(layer)).snapshot;
        snapshotDerived = true;
    }
    const snapshotKey = provider === 'rainbow' ? snapshot : '-';
    const cacheKey = `radar-${provider}-${layer}-${z}-${x}-${y}-${smooth}-${size}-${snow}-${color}-${forecast}-${coverage}-${usePrecipType}-${snapshotKey}`;
    const cached = cache.get(cacheKey);
    if (cached) return { buffer: cached.buffer, fallback: cached.fallback, error: false, snapshot: cached.snapshot, stale: cached.stale };

    try {
        const trace = { snapshot: null };
        const { buffer, fallback } = await fetchTileWithProvider(z, x, y, { ...options, snapshot, snapshotDerived, trace });
        const served = fallback ? null : trace.snapshot;
        // Served from an older snapshot than requested because the newest tile was missing
        const stale = served !== null && snapshot !== undefined && served !== snapshot;
        // A RainViewer fallback or an older-snapshot tile is cached briefly so recovery is picked up quickly
        cache.set(cacheKey, { buffer, fallback, snapshot: served, stale }, fallback ? 30 : (stale ? STALE_TILE_CACHE_TTL_S : 600));
        return { buffer, fallback, error: false, snapshot: served, stale };
        
    } catch (error) {
        console.error(`Error generating radar tile ${z}/${x}/${y} (provider: ${provider}):`, error.message);
        // Return empty transparent tile on error
        const buffer = await sharp({
            create: {
                width: size,
                height: size,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        }).png().toBuffer();
        return { buffer, fallback: false, error: true, snapshot: null, stale: false };
    }
}

// Routes with /weather-radar prefix
app.get('/weather-radar/health', async (req, res) => {
    try {
        const keys = await loadApiKeys();
        const rainviewerKeys = Object.values(keys.rainviewer || {}).filter(k => k.enabled).length;
        const apiKeys = Object.values(keys.apiKeys || {}).filter(k => k.enabled).length;
        const rainbowConfigured = !!(keys.rainbow?.apiKey || process.env.RAINBOW_API_KEY);
        
        res.json({ 
            status: 'ok', 
            cache_keys: cache.keys().length,
            timestamp_cache: pathCache.keys().length,
            api_keys_configured: rainviewerKeys + apiKeys,
            public_mode: !!keys._publicMode,
            config_bucket: !!CONFIG_BUCKET,
            providers: {
                rainviewer: {
                    enabled: true,
                    requires_api_key: false
                },
                rainbow: {
                    enabled: rainbowConfigured,
                    requires_api_key: true
                }
            },
            supported_parameters: {
                provider: ['rainviewer', 'rainbow'],
                provider_default: 'rainviewer',
                layer: RAINBOW_LAYERS,
                layer_default: 'precip',
                layer_provider: 'rainbow',
                layer_note: 'layer is only applicable to provider=rainbow; rainviewer always serves precipitation radar. clouds/radars max native zoom is 7 (upscaled to 9); precip/precip-global support native zoom up to 12.',
                size: [256, 512],
                smooth: [0, 1],
                smooth_note: 'rainviewer only',
                snow: [0, 1],
                snow_note: 'rainviewer only',
                color: RAINBOW_COLORS,
                color_note: 'Rainbow.ai only; see https://doc.rainbow.ai/tile_colors/ for a preview of each palette. Ignored by RainViewer, which only renders Universal Blue. Not applicable to layer=clouds.',
                color_default: RAINBOW_COLOR_DEFAULT,
                coverage: [0, 1],
                coverage_default: 0,
                coverage_note: 'Rainbow.ai only; applies to layer=precip, precip-global, radars. Not applicable to layer=clouds.',
                use_precip_type: [0, 1],
                use_precip_type_default: 0,
                use_precip_type_note: 'Rainbow.ai only; applies to layer=radars only',
                forecast: [0, 240],
                forecast_default: 0,
                forecast_note: 'Rainbow.ai only; applies to layer=precip, precip-global only',
                snapshot: 'epoch seconds, multiple of 600',
                snapshot_note: 'Rainbow.ai only; optional hint. Must be a multiple of 600 and not older than 2 hours before the layer\'s latest snapshot, otherwise 400. A value newer than the latest is clamped to the latest. Without it the layer\'s latest snapshot is used. The snapshot actually served is returned in the X-Weather-Snapshot header.',
                api_key_parameter: 'api'
            },
            endpoints: {
                snapshot: '/weather-radar/snapshot?layer=<layer>&api=<key>'
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Health check failed'
        });
    }
});



// Latest snapshot of a Rainbow.ai layer, for clients that want to line up their own time slider
app.get('/weather-radar/snapshot', rateLimit, async (req, res) => {
    const layer = req.query.layer || 'precip';
    const apiKey = req.query.api || req.query.key; // Same key parameters as tiles
    
    if (!apiKey) {
        return res.status(401).json({
            error: 'API key required for Rainbow.ai provider',
            message: 'Use ?api=your-key parameter'
        });
    }
    
    if (typeof layer !== 'string' || !RAINBOW_LAYERS.includes(layer)) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: `layer parameter must be one of: ${RAINBOW_LAYERS.join(', ')}`
        });
    }
    
    const keyValidation = await validateApiKey(apiKey);
    if (!keyValidation.valid) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: keyValidation.reason
        });
    }
    
    if (!keyValidation.providers.includes('rainbow')) {
        return res.status(403).json({
            error: 'Forbidden',
            message: 'API key does not have access to rainbow provider'
        });
    }
    
    const rateLimitCheck = checkApiKeyRateLimit(apiKey, keyValidation.rateLimit);
    if (!rateLimitCheck.allowed) {
        return res.status(429).json({
            error: 'Rate limit exceeded',
            message: rateLimitCheck.message
        });
    }
    
    const latest = await rainbowProvider.getLatestSnapshot(layer);
    res.set({
        'Cache-Control': 'public, max-age=30',
        'Access-Control-Allow-Origin': '*'
    });
    res.json({
        layer,
        snapshot: latest.snapshot,
        stepSeconds: SNAPSHOT_STEP_S,
        source: latest.source
    });
});

app.get('/weather-radar/:z/:x/:y.png', rateLimit, async (req, res) => {
    const { z, x, y } = req.params;
    const smooth = parseInt(req.query.smooth) || 0;
    const size = parseInt(req.query.size) || 256;
    const snow = parseInt(req.query.snow) || 0;
    const color = req.query.color !== undefined ? req.query.color : RAINBOW_COLOR_DEFAULT;
    const provider = req.query.provider || 'rainviewer';
    const apiKey = req.query.api || req.query.key; // Support both 'api' and 'key' parameters
    const forecast = parseInt(req.query.forecast) || 0;
    const layer = req.query.layer || 'precip';
    const coverage = parseInt(req.query.coverage) || 0;
    const usePrecipType = parseInt(req.query.use_precip_type) || 0;
    const snapshotHint = req.query.snapshot;
    
    console.log(`Request: ${z}/${x}/${y}.png?provider=${provider}&layer=${layer}&color=${color}&size=${size}&smooth=${smooth}&snow=${snow}&forecast=${forecast}&coverage=${coverage}&use_precip_type=${usePrecipType}`);
    
    // Rainbow.ai requires API key
    if (provider === 'rainbow' && !apiKey) {
        return res.status(401).json({
            error: 'API key required for Rainbow.ai provider',
            message: 'Use ?api=your-key parameter'
        });
    }
    
    // Validate provider
    if (!['rainviewer', 'rainbow'].includes(provider)) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'provider parameter must be "rainviewer" or "rainbow"'
        });
    }
    
    // Validate layer
    if (!RAINBOW_LAYERS.includes(layer)) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: `layer parameter must be one of: ${RAINBOW_LAYERS.join(', ')}`
        });
    }
    
    // layer is a Rainbow.ai-only concept; RainViewer has no clouds/radars equivalent
    if (layer !== 'precip' && provider !== 'rainbow') {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: `layer=${layer} is only supported with provider=rainbow`
        });
    }
    
    // Validate API key if provided
    let keyValidation = null;
    if (apiKey) {
        keyValidation = await validateApiKey(apiKey);
        if (!keyValidation.valid) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: keyValidation.reason
            });
        }
        
        // Check if API key has access to requested provider
        if (!keyValidation.providers.includes(provider)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: `API key does not have access to ${provider} provider`
            });
        }
        
        // Check API key-specific rate limit
        const rateLimitCheck = checkApiKeyRateLimit(apiKey, keyValidation.rateLimit);
        if (!rateLimitCheck.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: rateLimitCheck.message
            });
        }
    }
    
    // Validate tile coordinates
    const validation = validateTileCoordinates(z, x, y);
    if (!validation.valid) {
        return res.status(400).json({
            error: 'Invalid request',
            message: validation.error
        });
    }
    
    const { zoom, tileX, tileY } = validation;
    
    // Validate parameters
    if (smooth < 0 || smooth > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'smooth parameter must be 0 or 1'
        });
    }
    
    if (![256, 512].includes(size)) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'size parameter must be 256 or 512'
        });
    }
    
    if (snow < 0 || snow > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'snow parameter must be 0 or 1'
        });
    }
    
    if (!RAINBOW_COLORS.includes(String(color))) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: `color parameter must be one of: ${RAINBOW_COLORS.join(', ')} (Rainbow.ai palette codes, see https://doc.rainbow.ai/tile_colors/). Ignored by RainViewer.`
        });
    }
    
    // Validate forecast parameter (Rainbow.ai only)
    if (forecast < 0 || forecast > 240) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'forecast parameter must be 0-240 minutes (Rainbow.ai only)'
        });
    }
    
    // Forecast parameter only works with Rainbow.ai
    if (forecast > 0 && provider !== 'rainbow') {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'forecast parameter only supported with provider=rainbow'
        });
    }
    
    // Forecast is only meaningful for precip/precip-global; clouds/radars are current-observation only
    if (forecast > 0 && layer !== 'precip' && layer !== 'precip-global') {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'forecast parameter is only supported with layer=precip or layer=precip-global'
        });
    }
    
    // clouds has no color palette concept
    if (layer === 'clouds' && req.query.color !== undefined) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'color parameter is not supported with layer=clouds'
        });
    }
    
    if (coverage < 0 || coverage > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'coverage parameter must be 0 or 1'
        });
    }
    
    // coverage is not supported for clouds
    if (coverage > 0 && layer === 'clouds') {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'coverage parameter is not supported with layer=clouds'
        });
    }
    
    if (usePrecipType < 0 || usePrecipType > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'use_precip_type parameter must be 0 or 1'
        });
    }
    
    // use_precip_type only applies to radars
    if (usePrecipType > 0 && layer !== 'radars') {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'use_precip_type parameter is only supported with layer=radars'
        });
    }
    
    // Rainbow.ai snapshot: client value is only a hint (ignored for RainViewer, which has no snapshots)
    let snapshotInfo = null;
    if (provider === 'rainbow') {
        snapshotInfo = await resolveRainbowSnapshot(layer, snapshotHint);
        if (snapshotInfo.error) {
            return res.status(400).json({
                error: 'Invalid parameter',
                message: snapshotInfo.error
            });
        }
    }
    
    try {
        const options = { smooth, size, snow, color, provider, api: apiKey, forecast, layer, coverage, usePrecipType };
        if (snapshotInfo) {
            options.snapshot = snapshotInfo.snapshot;
            options.snapshotDerived = snapshotInfo.derived;
        }
        const { buffer: tileBuffer, fallback, error: tileError, snapshot: servedSnapshot, stale } = await generateRadarTile(zoom, tileX, tileY, options);
        
        const attribution = provider === 'rainbow' 
            ? 'Weather data provided by Rainbow.ai'
            : 'Weather data provided by RainViewer.com';
        
        // Degraded tiles are signalled with extra headers and a shorter (or no) cache lifetime
        let cacheControl = 'public, max-age=600';
        if (tileError) cacheControl = 'no-store';
        else if (fallback || stale || (snapshotInfo && snapshotInfo.clamped)) cacheControl = 'public, max-age=30';

        res.set({
            'Content-Type': sniffImageContentType(tileBuffer),
            'Cache-Control': cacheControl,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Weather-Snapshot, X-Weather-Fallback, X-Weather-Error',
            'Attribution': attribution,
            'X-Weather-Provider': provider,
            'X-Weather-Layer': layer
        });
        
        if (servedSnapshot) res.set('X-Weather-Snapshot', String(servedSnapshot));
        if (fallback) res.set('X-Weather-Fallback', 'rainviewer');
        if (tileError) res.set('X-Weather-Error', '1');

        res.send(tileBuffer);
    } catch (error) {
        console.error('Radar tile generation error:', error.message);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: 'Too many requests to weather service'
            });
        } else if (error.message.includes('not found')) {
            return res.status(404).json({
                error: 'Tile not found',
                message: 'Weather data not available for this location'
            });
        } else if (error.message.includes('API key required')) {
            return res.status(401).json({
                error: 'API key required',
                message: error.message
            });
        } else {
            return res.status(500).json({
                error: 'Service unavailable',
                message: 'Weather service temporarily unavailable'
            });
        }
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Weather radar proxy server running on port ${PORT}`);
        console.log(`Max zoom: ${MAX_ZOOM_LEVEL}, RainViewer max native zoom: ${RAINVIEWER_MAX_ZOOM} (z${RAINVIEWER_MAX_ZOOM+1}-${MAX_ZOOM_LEVEL} upscaled), Rainbow clouds/radars max native zoom: ${RAINBOW_LAYER_MAX_ZOOM}, Rate limit: ${RATE_LIMIT_PER_MINUTE}/min`);
        console.log(`Providers: RainViewer (public), Rainbow.ai (API key required)`);
        console.log(`Rainbow.ai layers: ${RAINBOW_LAYERS.join(', ')}`);
        console.log(`Supports: ?provider=rainviewer|rainbow, ?layer=precip|precip-global|clouds|radars, ?snapshot=<epoch seconds, multiple of 600>, ?size=256|512, ?smooth=0|1, ?snow=0|1, ?color=${RAINBOW_COLORS.join('|')}, ?forecast=0-240, ?coverage=0|1, ?use_precip_type=0|1`);
    });
}

// Test hook: forget all cached state so tests do not influence each other
function resetStateForTests() {
    cache.flushAll();
    pathCache.flushAll();
    rateLimitCache.flushAll();
    rainbowProvider.snapshotCache.flushAll();
    rainbowProvider.snapshotFlights.clear();
}

module.exports = { app, resetStateForTests };
