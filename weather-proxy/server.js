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
const RATE_LIMIT_PER_MINUTE = 600; // RainViewer allows 600 requests per minute
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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
async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
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

// MetService dBZ color mapping based on actual MetService scale
const METSERVICE_DBZ_COLORS = [
    // 0-20 dBZ: Light rain - 3 shades of yellow
    [251, 255, 0],   // Bright yellow (0-7 dBZ)
    [253, 244, 0],   // Golden yellow (7-13 dBZ)
    [254, 224, 0],   // Orange-yellow (13-20 dBZ)
    
    // 20-40 dBZ: Moderate rain - blue to turquoise
    [79, 120, 255],  // Blue (20-30 dBZ)
    [0, 191, 255],   // Turquoise (30-40 dBZ)
    
    // 40-45 dBZ: Heavy rain - 2 shades of red
    [255, 72, 0],    // Bright red (40-42.5 dBZ)
    [229, 56, 0],    // Dark red (42.5-45 dBZ)
    
    // 45-50 dBZ: Very heavy rain - 2 shades of purple
    [194, 55, 227],  // Purple (45-47.5 dBZ)
    [111, 7, 158],   // Dark purple (47.5-50 dBZ)
    
    // 50-55 dBZ: Extreme - white
    [255, 255, 255], // White (50-55 dBZ)
    
    // 55-60 dBZ: Hail - 2 shades of green
    [105, 253, 0],   // Bright green (55-57.5 dBZ)
    [57, 178, 0],    // Dark green (57.5-60 dBZ)
    
    // >60 dBZ: Severe hail - purple
    [255, 63, 255]   // Bright magenta (>60 dBZ)
];

// Convert RainViewer pixel value to actual dBZ
// RainViewer spec: pixel 1 = -31 dBZ, pixel 127 = 95 dBZ
// Formula: dBZ = pixel_value - 32
function rainviewerToDbz(pixelValue) {
    // Handle snow mask if present (bit 7 set)
    const intensity = pixelValue & 127; // Remove snow bit
    return intensity - 32; // Convert to dBZ
}

// Get MetService color for dBZ value
function getMetServiceColor(dbz) {
    // Handle negative dBZ (no precipitation)
    if (dbz < 0) return [0, 0, 0, 0]; // Transparent
    
    if (dbz < 7) return METSERVICE_DBZ_COLORS[0];        // 0-7: Bright yellow
    if (dbz < 13) return METSERVICE_DBZ_COLORS[1];       // 7-13: Golden yellow
    if (dbz < 20) return METSERVICE_DBZ_COLORS[2];       // 13-20: Orange-yellow
    if (dbz < 30) return METSERVICE_DBZ_COLORS[3];       // 20-30: Blue
    if (dbz < 40) return METSERVICE_DBZ_COLORS[4];       // 30-40: Turquoise
    if (dbz < 42.5) return METSERVICE_DBZ_COLORS[5];     // 40-42.5: Bright red
    if (dbz < 45) return METSERVICE_DBZ_COLORS[6];       // 42.5-45: Dark red
    if (dbz < 47.5) return METSERVICE_DBZ_COLORS[7];     // 45-47.5: Purple
    if (dbz < 50) return METSERVICE_DBZ_COLORS[8];       // 47.5-50: Dark purple
    if (dbz < 55) return METSERVICE_DBZ_COLORS[9];       // 50-55: White
    if (dbz < 57.5) return METSERVICE_DBZ_COLORS[10];    // 55-57.5: Bright green
    if (dbz < 60) return METSERVICE_DBZ_COLORS[11];      // 57.5-60: Dark green
    return METSERVICE_DBZ_COLORS[12];                    // >60: Bright magenta
}

// Apply MetService color mapping to dBZ tile
async function applyMetServiceColors(buffer) {
    try {
        const image = sharp(buffer);
        const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        
        // Create new buffer for RGBA output
        const newData = Buffer.alloc(info.width * info.height * 4);
        
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            
            // If pixel is transparent, keep it transparent
            if (a === 0 || r === 0) {
                newData[i] = 0;
                newData[i + 1] = 0;
                newData[i + 2] = 0;
                newData[i + 3] = 0;
            } else {
                // Convert RainViewer intensity to dBZ and get MetService color
                const dbz = rainviewerToDbz(r);
                const color = getMetServiceColor(dbz);
                
                newData[i] = color[0];     // R
                newData[i + 1] = color[1]; // G
                newData[i + 2] = color[2]; // B
                newData[i + 3] = a;        // A (preserve alpha)
            }
        }
        
        return await sharp(newData, {
            raw: {
                width: info.width,
                height: info.height,
                channels: 4
            }
        }).png().toBuffer();
    } catch (error) {
        console.error('Error applying MetService colors:', error.message);
        return buffer; // Return original on error
    }
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
    const { smooth = 0, size = 256, snow = 0, color = 2 } = options;
    
    // Upscale from z=7 ancestor for zoom levels 8-9
    if (z > RAINVIEWER_MAX_ZOOM) {
      return await this.getUpscaledTile(z, x, y, options);
    }
    
    return await this.fetchTile(z, x, y, options);
  }
  
  async getUpscaledTile(z, x, y, options) {
    const { size = 256 } = options;
    const zoomDiff = z - RAINVIEWER_MAX_ZOOM;
    const scale = Math.pow(2, zoomDiff);
    const ancestorX = Math.floor(x / scale);
    const ancestorY = Math.floor(y / scale);
    
    // Fetch ancestor tile at native 256 to crop precisely
    const ancestorBuffer = await this.fetchTile(RAINVIEWER_MAX_ZOOM, ancestorX, ancestorY, { ...options, size: 256 });
    
    const cropSize = Math.floor(256 / scale);
    const offsetX = (x % scale) * cropSize;
    const offsetY = (y % scale) * cropSize;
    
    return await sharp(ancestorBuffer)
      .extract({ left: offsetX, top: offsetY, width: cropSize, height: cropSize })
      .resize(size, size, { kernel: 'nearest' })
      .png()
      .toBuffer();
  }
  
  async fetchTile(z, x, y, options) {
    const { smooth = 0, size = 256, snow = 0, color = 2 } = options;
    
    return await retryWithBackoff(async () => {
      // Fetch the new path hash instead of the timestamp
      const path = await this.getLatestPath();
      const rainviewerColor = mapColorToProvider(color, 'rainviewer');
      
      // The path variable already includes '/v2/radar/[hash]'
      const url = `https://tilecache.rainviewer.com${path}/${size}/${z}/${x}/${y}/${rainviewerColor}/${smooth}_${snow}.png`;
      
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

// Provider-aware color mapping
// Maps our unified color scheme to provider-specific values
function mapColorToProvider(color, provider) {
  if (provider === 'rainbow') {
    // Rainbow.ai color mapping
    const rainbowMap = {
      0: 'dbz_u8',    // MetService colors (raw dBZ)
      1: '5',         // Original -> RainViewer (closest match)
      2: '8',         // Universal Blue -> RainViewer Universal Blue
      3: '7',         // TITAN -> Titan
      4: '1',         // TWC -> TWC (Rainbow's primary TWC)
      5: '3',         // Meteored -> Meteored
      6: '4',         // NEXRAD -> Nexrad
      7: '6',         // RAINBOW @ SELEX-SI -> Selex
      8: '2',         // Dark Sky -> Dark Sky
      10: '0'         // Rainbow.ai native -> Rainbow
    };
    return rainbowMap[color] || '8'; // Default to Universal Blue
  } else {
    // RainViewer color mapping (original)
    return color === 10 ? '2' : color.toString(); // color=10 -> Universal Blue for RainViewer
  }
}

// Rainbow.ai provider implementation
class RainbowProvider extends WeatherProvider {
  constructor() {
    super();
    this.apiKey = null;
    this.timestampCache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache for timestamps
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
  
  async getLatestTimestamp() {
    const cached = this.timestampCache.get('latest');
    if (cached) return cached;
    
    // Rainbow.ai requires 10-minute aligned timestamps (epoch UTC seconds)
    // and tiles are accessible up to 2 hours before latest snapshot
    const now = Math.floor(Date.now() / 1000);
    
    // Align to 10-minute intervals (600 seconds)
    const aligned = Math.floor(now / 600) * 600;
    
    // Use a timestamp from 10-20 minutes ago to ensure data availability
    const timestamp = aligned - 600; // 10 minutes ago
    
    this.timestampCache.set('latest', timestamp);
    return timestamp;
  }
  
  async getTile(z, x, y, options) {
    const { color = 2, size = 256, forecast = 0 } = options;
    const apiKey = await this.loadRainbowApiKey();
    
    return await retryWithBackoff(async () => {
      const rainbowColor = mapColorToProvider(color, 'rainbow');
      
      // Get a valid timestamp from Rainbow.ai
      const timestamp = await this.getLatestTimestamp();
      
      // Convert forecast minutes to seconds and validate range
      const forecastSeconds = Math.min(14400, Math.max(0, forecast * 60));
      
      const url = `https://api.rainbow.ai/tiles/v1/precip/${timestamp}/${forecastSeconds}/${z}/${x}/${y}?color=${rainbowColor}`;
      
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
          } else if (response.status === 404) {
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
    });
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
  const { provider = 'rainviewer', api } = options;
  
  // Rainbow.ai requires API key
  if (provider === 'rainbow' && !api) {
    throw new Error('API key required for Rainbow.ai provider');
  }
  
  try {
    const providerInstance = getProvider(provider);
    return await providerInstance.getTile(z, x, y, options);
  } catch (error) {
    // Only fallback to RainViewer if Rainbow.ai fails
    if (provider === 'rainbow') {
      console.warn('Rainbow.ai failed, falling back to RainViewer:', error.message);
      return await rainviewerProvider.getTile(z, x, y, options);
    }
    throw error;
  }
}

// Legacy function for backward compatibility
async function fetchRadarTile(z, x, y, smooth = 0, size = 256, snow = 0, color = 2) {
  return await rainviewerProvider.getTile(z, x, y, { smooth, size, snow, color });
}

// Generate radar tile with enhanced parameters and provider support
async function generateRadarTile(z, x, y, options = {}) {
    const { smooth = 0, size = 256, snow = 0, color = 2, provider = 'rainviewer', api, forecast = 0 } = options;
    const cacheKey = `radar-${provider}-${z}-${x}-${y}-${smooth}-${size}-${snow}-${color}-${forecast}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        let buffer = await fetchTileWithProvider(z, x, y, options);
        
        // Apply MetService color mapping if using dBZ color scheme (0)
        if (color === 0) {
            console.log(`Applying MetService color mapping for tile ${z}/${x}/${y} (provider: ${provider})`);
            buffer = await applyMetServiceColors(buffer);
        }
        
        cache.set(cacheKey, buffer);
        return buffer;
        
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
        return buffer;
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
                size: [256, 512],
                smooth: [0, 1],
                snow: [0, 1],
                color: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10],
                color_default: 2,
                forecast: [0, 240],
                forecast_default: 0,
                forecast_provider: 'rainbow',
                metservice_mapping: 'Applied automatically for color=0',
                rainbow_native: 'Use color=10 for Rainbow.ai native color=0 scheme',
                api_key_parameter: 'api'
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Health check failed'
        });
    }
});



app.get('/weather-radar/:z/:x/:y.png', rateLimit, async (req, res) => {
    const { z, x, y } = req.params;
    const smooth = parseInt(req.query.smooth) || 0;
    const size = parseInt(req.query.size) || 256;
    const snow = parseInt(req.query.snow) || 0;
    const color = req.query.color !== undefined ? parseInt(req.query.color) : 2;
    const provider = req.query.provider || 'rainviewer';
    const apiKey = req.query.api || req.query.key; // Support both 'api' and 'key' parameters
    const forecast = parseInt(req.query.forecast) || 0;
    
    console.log(`Request: ${z}/${x}/${y}.png?provider=${provider}&color=${color}&size=${size}&smooth=${smooth}&snow=${snow}&forecast=${forecast}`);
    
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
    
    if (color < 0 || color > 10) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'color parameter must be 0-8, 10 (0=MetService, 1-8=RainViewer schemes, 10=Rainbow.ai native)'
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
    
    try {
        const options = { smooth, size, snow, color, provider, api: apiKey, forecast };
        const tileBuffer = await generateRadarTile(zoom, tileX, tileY, options);
        
        const attribution = provider === 'rainbow' 
            ? 'Weather data provided by Rainbow.ai'
            : 'Weather data provided by RainViewer.com';
        
        res.set({
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=600',
            'Access-Control-Allow-Origin': '*',
            'Attribution': attribution,
            'X-Weather-Provider': provider
        });
        
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

app.listen(PORT, () => {
    console.log(`Weather radar proxy server running on port ${PORT}`);
    console.log(`Max zoom: ${MAX_ZOOM_LEVEL}, RainViewer max native zoom: ${RAINVIEWER_MAX_ZOOM} (z${RAINVIEWER_MAX_ZOOM+1}-${MAX_ZOOM_LEVEL} upscaled), Rate limit: ${RATE_LIMIT_PER_MINUTE}/min`);
    console.log(`Providers: RainViewer (public), Rainbow.ai (API key required)`);
    console.log(`Supports: ?provider=rainviewer|rainbow, ?size=256|512, ?smooth=0|1, ?snow=0|1, ?color=0-8, ?forecast=0-240`);
});
