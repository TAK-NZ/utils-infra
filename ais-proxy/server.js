import express from 'express';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const app = express();
app.use(express.json({ 
  limit: '50mb',
  verify: (req, res, buf, encoding) => {
    // Store raw body for debugging truncated requests
    req.rawBody = buf;
  }
}));

// Add request timeout middleware
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 second timeout
  res.setTimeout(30000);
  next();
});
const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-AIS-Proxy-Api-Keys.json';
const DEBUG = process.env.DEBUG === 'true';
const CACHE_FILE = '/data/vessel-cache.json';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

// In-memory caches with size limits
const vesselCache = new Map();
const apiKeyCache = new Map();
const rateLimitCache = new Map();
const clientStatusCache = new Map(); // Track AIS upload clients
const MAX_VESSEL_CACHE_SIZE = 50000;
const MAX_RATE_LIMIT_CACHE_SIZE = 10000;
const RATE_LIMIT_PER_MINUTE = 600;
const MARINESIA_POLL_INTERVAL = parseInt(process.env.MARINESIA_POLL_INTERVAL) || 30000; // Configurable, default 30s
const MARINESIA_BOUNDING_BOX = {
  lat_min: -48.0, lat_max: -34.0,
  long_min: 166.0, long_max: 179.0
};

// Sanitize log input to prevent log injection
function sanitizeLogInput(input) {
  if (typeof input !== 'string') return String(input);
  return input.replace(/[\r\n\t]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// Load API keys from S3
async function loadApiKeys() {
  const cached = apiKeyCache.get('keys');
  if (cached && Date.now() - cached.timestamp < 3600000) return cached.data;
  
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using public mode');
    const config = { aisstream: {}, users: {}, _publicMode: true };
    apiKeyCache.set('keys', { data: config, timestamp: Date.now() });
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
    
    apiKeyCache.set('keys', { data: keys, timestamp: Date.now() });
    return keys;
  } catch (error) {
    console.error('Failed to load API keys from S3:', sanitizeLogInput(error.message || ''));
    const config = { aisstream: {}, users: {}, _publicMode: true };
    apiKeyCache.set('keys', { data: config, timestamp: Date.now() });
    return config;
  }
}

// Get AISStream API key
async function getAISStreamKey() {
  const keys = await loadApiKeys();
  return keys.aisstream?.primary?.key || keys.aisstream?.backup?.key;
}

// Get Marinesia API key
async function getMarinesiaKey() {
  const keys = await loadApiKeys();
  return keys.marinesia?.apiKey || process.env.MARINESIA_API_KEY;
}







// Validate user API key
async function validateUserApiKey(providedKey) {
  if (!providedKey) return { valid: false, reason: 'No API key provided' };
  
  const keys = await loadApiKeys();
  
  if (keys._publicMode) {
    return { valid: true, keyName: 'public', rateLimit: null };
  }
  
  const userKeys = keys.users || {};
  
  for (const [keyName, keyConfig] of Object.entries(userKeys)) {
    if (keyConfig.enabled && keyConfig.key === providedKey) {
      return { valid: true, keyName, rateLimit: keyConfig.rateLimit };
    }
  }
  
  return { valid: false, reason: 'Invalid API key' };
}

// Cache cleanup to prevent memory issues
function cleanupCaches() {
  // Clean up rate limit cache
  if (rateLimitCache.size > MAX_RATE_LIMIT_CACHE_SIZE) {
    const entries = Array.from(rateLimitCache.entries());
    entries.sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]));
    rateLimitCache.clear();
    entries.slice(0, MAX_RATE_LIMIT_CACHE_SIZE / 2).forEach(([k, v]) => rateLimitCache.set(k, v));
  }
  
  // Clean up vessel cache if too large
  if (vesselCache.size > MAX_VESSEL_CACHE_SIZE) {
    const entries = Array.from(vesselCache.entries());
    entries.sort((a, b) => b[1].lastUpdate - a[1].lastUpdate);
    vesselCache.clear();
    entries.slice(0, MAX_VESSEL_CACHE_SIZE * 0.8).forEach(([k, v]) => vesselCache.set(k, v));
  }
}

// Rate limiting
function checkRateLimit(identifier, limit = RATE_LIMIT_PER_MINUTE) {
  const key = `rate_${identifier}`;
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window
  
  let requests = rateLimitCache.get(key) || [];
  requests = requests.filter(time => time > windowStart);
  
  if (requests.length >= limit) {
    return { allowed: false, message: `Rate limit exceeded (${limit}/min)` };
  }
  
  requests.push(now);
  rateLimitCache.set(key, requests);
  return { allowed: true };
}

// Load cache from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cached = JSON.parse(data);
      for (const [mmsi, vessel] of Object.entries(cached)) {
        vessel.lastUpdate = new Date(vessel.lastUpdate);
        vesselCache.set(parseInt(mmsi), vessel);
      }
      
      console.log(`Loaded ${vesselCache.size} vessels from cache`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.info('Cache file does not exist, starting with empty cache');
    } else if (error instanceof SyntaxError) {
      console.error('Cache file contains invalid JSON:', sanitizeLogInput(error.message));
    } else {
      console.error('Failed to load cache:', sanitizeLogInput(error.message));
    }
  }
}

// Save cache to disk
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const cacheObj = Object.fromEntries(vesselCache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj));
    if (DEBUG) console.log(`Saved ${vesselCache.size} vessels to cache`);
  } catch (error) {
    console.warn('Failed to save cache:', sanitizeLogInput(error.message || ''));
  }
}

// WebSocket connection state
let wsConnection = null;
let reconnectAttempts = 0;
let pingInterval = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;

// Connect to AISStream WebSocket
async function connectToAISStream() {
  const apiKey = await getAISStreamKey();
  if (!apiKey) {
    console.error('No AISStream API key available');
    setTimeout(connectToAISStream, 30000); // Retry in 30 seconds
    return;
  }
  
  // Close existing connection if any
  if (wsConnection) {
    wsConnection.removeAllListeners();
    wsConnection.close();
    wsConnection = null;
  }
  
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  
  const boundingBox = [[-48.0, 166.0], [-34.0, 179.0]]; // NZ region
  
  const subscriptionMessage = {
    APIKey: apiKey,
    BoundingBoxes: [boundingBox],
    FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "StaticDataReport", "AidsToNavigationReport"]
  };

  wsConnection = new WebSocket('wss://stream.aisstream.io/v0/stream');
  
  wsConnection.on('open', () => {
    console.log('Connected to AISStream');
    reconnectAttempts = 0;
    wsConnection.send(JSON.stringify(subscriptionMessage));
    
    // Set up ping interval to keep connection alive
    pingInterval = setInterval(() => {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.ping();
      }
    }, 30000); // Ping every 30 seconds
  });

  wsConnection.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      processAISMessage(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn('Invalid JSON in AIS message:', sanitizeLogInput(error.message || ''));
      } else {
        console.warn('Failed to process AIS message:', sanitizeLogInput(error.message || ''));
      }
      if (DEBUG) console.warn('Raw data:', sanitizeLogInput(data.toString().substring(0, 200)));
    }
  });
  
  wsConnection.on('ping', () => {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.pong();
    }
  });
  
  wsConnection.on('pong', () => {
    if (DEBUG) console.log('Received pong from AISStream');
  });

  wsConnection.on('error', (error) => {
    console.error('WebSocket error:', sanitizeLogInput(String(error.message || error)));
    scheduleReconnect();
  });

  wsConnection.on('close', (code, reason) => {
    console.log(`WebSocket connection closed (code: ${code}, reason: ${sanitizeLogInput(String(reason || 'unknown'))})`);
    
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Don't reconnect if it was a normal closure or authentication error
    if (code === 1000 || code === 1008) {
      console.log('Connection closed normally or due to auth error, not reconnecting');
      return;
    }
    
    scheduleReconnect();
  });
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping reconnection.`);
    return;
  }
  
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 60000); // Max 1 minute
  reconnectAttempts++;
  
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(connectToAISStream, delay);
}





function processAISMessage(message) {
  try {
    // Validate message structure
    if (!message.MetaData?.MMSI || !message.MessageType || !message.Message) {
      if (DEBUG) console.warn('Invalid message structure:', message);
      return;
    }
    
    const mmsi = message.MetaData.MMSI;
    const messageType = message.MessageType;
    
    // Validate coordinates
    const lat = message.MetaData.latitude;
    const lon = message.MetaData.longitude;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      if (DEBUG) console.warn(`Invalid coordinates for MMSI ${mmsi}: ${lat}, ${lon}`);
      return;
    }
    
    let vessel = vesselCache.get(mmsi) || {
      MMSI: mmsi,
      NAME: '',
      CALLSIGN: '',
      DEST: '',
      TYPE: null,
      IMO: null,
      DRAUGHT: null,
      A: null,
      B: null,
      C: null,
      D: null,
      ETA: null,
      // Internal fields (not exposed in AISHub API)
      _rateOfTurn: null,
      _positionAccuracy: null,
      _timestamp: null,
      _aisVersion: null,
      _fixType: null,
      _valid: null,
      _messageType: null,
      _nameSource: null // 'ais' | 'marinesia' | null
    };
    
    // Update common fields
    vessel.MMSI = mmsi;
    vessel.TIME = new Date(message.MetaData.time_utc).toISOString().replace('T', ' ').replace('Z', ' UTC');
    vessel.LONGITUDE = lon;
    vessel.LATITUDE = lat;
    vessel.lastUpdate = new Date();
    // Only update _messageType for position/nav reports (used for vessel classification)
    // Static data messages should not change the vessel's class category
    if (['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'AidsToNavigationReport'].includes(messageType)) {
      vessel._messageType = messageType;
    } else if (!vessel._messageType) {
      vessel._messageType = messageType;
    }
    
    // Process position reports (Class A)
    if (message.Message.PositionReport) {
      const pos = message.Message.PositionReport;
      
      // Validate message if Valid field exists
      if (pos.Valid !== undefined && !pos.Valid) {
        if (DEBUG) console.warn(`Invalid position report for MMSI ${mmsi}`);
        return;
      }
      
      vessel.COG = pos.Cog;
      vessel.SOG = pos.Sog;
      vessel.HEADING = pos.TrueHeading;
      vessel.NAVSTAT = pos.NavigationalStatus;
      
      // Store additional internal fields
      vessel._rateOfTurn = pos.RateOfTurn;
      vessel._positionAccuracy = pos.PositionAccuracy;
      vessel._timestamp = pos.Timestamp;
      vessel._valid = pos.Valid;
    }
    
    // Process Class B position reports
    if (message.Message.StandardClassBPositionReport || message.Message.ExtendedClassBPositionReport) {
      const pos = message.Message.StandardClassBPositionReport || message.Message.ExtendedClassBPositionReport;
      
      // Validate message if Valid field exists
      if (pos.Valid !== undefined && !pos.Valid) {
        if (DEBUG) console.warn(`Invalid Class B position report for MMSI ${mmsi}`);
        return;
      }
      
      vessel.COG = pos.Cog;
      vessel.SOG = pos.Sog;
      vessel.HEADING = pos.TrueHeading;
      // Class B vessels don't have NavigationalStatus, set to null
      vessel.NAVSTAT = null;
      
      // Store additional internal fields
      vessel._positionAccuracy = pos.PositionAccuracy;
      vessel._timestamp = pos.Timestamp;
      vessel._valid = pos.Valid;
    }
    
    // Process static data
    if (message.Message.ShipStaticData) {
      const static_data = message.Message.ShipStaticData;
      
      // Validate message if Valid field exists
      if (static_data.Valid !== undefined && !static_data.Valid) {
        if (DEBUG) console.warn(`Invalid static data for MMSI ${mmsi}`);
        return;
      }
      
      if (static_data.CallSign) vessel.CALLSIGN = static_data.CallSign.trim();
      if (static_data.Destination) vessel.DEST = static_data.Destination.trim();
      if (static_data.Type !== undefined) vessel.TYPE = static_data.Type;
      if (static_data.ImoNumber !== undefined) vessel.IMO = static_data.ImoNumber;
      if (static_data.MaximumStaticDraught !== undefined) vessel.DRAUGHT = static_data.MaximumStaticDraught;
      
      if (static_data.Name) {
        vessel.NAME = static_data.Name.trim();
        vessel._nameSource = 'ais';
        console.log(`📡 Received Class A name from AIS for MMSI ${mmsi}: "${sanitizeLogInput(String(static_data.Name.trim()))}"`);
      }
      
      if (static_data.Dimension) {
        if (static_data.Dimension.A !== undefined) vessel.A = static_data.Dimension.A;
        if (static_data.Dimension.B !== undefined) vessel.B = static_data.Dimension.B;
        if (static_data.Dimension.C !== undefined) vessel.C = static_data.Dimension.C;
        if (static_data.Dimension.D !== undefined) vessel.D = static_data.Dimension.D;
      }
      
      if (static_data.Eta) {
        const eta = static_data.Eta;
        const month = eta.Month?.toString().padStart(2, '0') || '00';
        const day = eta.Day?.toString().padStart(2, '0') || '00';
        const hour = eta.Hour?.toString().padStart(2, '0') || '00';
        const minute = eta.Minute?.toString().padStart(2, '0') || '00';
        vessel.ETA = `${month}/${day} ${hour}:${minute}`;
      }
      
      // Store additional internal fields
      vessel._aisVersion = static_data.AisVersion;
      vessel._fixType = static_data.FixType;
      vessel._valid = static_data.Valid;
    }
    
    // Process Class B static data (Message Type 24)
    if (message.Message.StaticDataReport) {
      const static_data = message.Message.StaticDataReport;
      
      // Validate message if Valid field exists
      if (static_data.Valid !== undefined && !static_data.Valid) {
        if (DEBUG) console.warn(`Invalid Class B static data for MMSI ${mmsi}`);
        return;
      }
      
      // Message Type 24A contains name and call sign
      if (static_data.PartNumber === 0) {
        if (static_data.Name) {
          vessel.NAME = static_data.Name.trim();
          vessel._nameSource = 'ais';
          console.log(`📡 Received Class B name from AIS for MMSI ${mmsi}: "${sanitizeLogInput(String(static_data.Name.trim()))}"`);
        }
        if (static_data.CallSign) {
          vessel.CALLSIGN = static_data.CallSign.trim();
        }
      }
      
      // Message Type 24B contains type and dimensions
      if (static_data.PartNumber === 1) {
        if (static_data.Type !== undefined) {
          vessel.TYPE = static_data.Type;
          console.log(`📡 Received Class B type from AIS for MMSI ${mmsi}: ${static_data.Type}`);
        }
        
        if (static_data.Dimension) {
          if (static_data.Dimension.A !== undefined) vessel.A = static_data.Dimension.A;
          if (static_data.Dimension.B !== undefined) vessel.B = static_data.Dimension.B;
          if (static_data.Dimension.C !== undefined) vessel.C = static_data.Dimension.C;
          if (static_data.Dimension.D !== undefined) vessel.D = static_data.Dimension.D;
        }
      }
      
      // Store additional internal fields
      vessel._valid = static_data.Valid;
    }
    
    // Process navigation aids
    if (message.Message.AidsToNavigationReport) {
      const nav_aid = message.Message.AidsToNavigationReport;
      
      // Validate message if Valid field exists
      if (nav_aid.Valid !== undefined && !nav_aid.Valid) {
        if (DEBUG) console.warn(`Invalid navigation aid for MMSI ${mmsi}`);
        return;
      }
      
      if (nav_aid.Name) {
        vessel.NAME = nav_aid.Name.trim();
        vessel._nameSource = 'ais';
      }
      if (nav_aid.Type !== undefined) vessel.TYPE = nav_aid.Type;
      
      // Navigation aids don't move, so set movement fields to null/zero
      vessel.COG = null;
      vessel.SOG = 0;
      vessel.HEADING = null;
      vessel.NAVSTAT = null;
      
      if (nav_aid.Dimension) {
        if (nav_aid.Dimension.A !== undefined) vessel.A = nav_aid.Dimension.A;
        if (nav_aid.Dimension.B !== undefined) vessel.B = nav_aid.Dimension.B;
        if (nav_aid.Dimension.C !== undefined) vessel.C = nav_aid.Dimension.C;
        if (nav_aid.Dimension.D !== undefined) vessel.D = nav_aid.Dimension.D;
      }
      
      // Store additional internal fields
      vessel._positionAccuracy = nav_aid.PositionAccuracy;
      vessel._timestamp = nav_aid.Timestamp;
      vessel._valid = nav_aid.Valid;
    }
    
    vesselCache.set(mmsi, vessel);
    
    // Enrich from Marinesia data if available
    const marinesiaVessel = marinesiaCache.get(mmsi);
    if (marinesiaVessel) {
      if (!vessel.NAME && marinesiaVessel.name) {
        vessel.NAME = marinesiaVessel.name;
        vessel._nameSource = 'marinesia';
      }
      if ((vessel.TYPE === null || vessel.TYPE === 0) && marinesiaVessel.type !== null) {
        vessel.TYPE = marinesiaVessel.type;
      }
      if (!vessel.IMO && marinesiaVessel.imo) vessel.IMO = marinesiaVessel.imo;
      if (!vessel.CALLSIGN && marinesiaVessel.callsign) vessel.CALLSIGN = marinesiaVessel.callsign;
      if (!vessel.DEST && marinesiaVessel.dest) vessel.DEST = marinesiaVessel.dest;
      if (!vessel.DRAUGHT && marinesiaVessel.draught) vessel.DRAUGHT = marinesiaVessel.draught;
      if ((vessel.A === null || vessel.A === 0) && marinesiaVessel.a) { vessel.A = marinesiaVessel.a; vessel.B = marinesiaVessel.b; }
      if ((vessel.C === null || vessel.C === 0) && marinesiaVessel.c) { vessel.C = marinesiaVessel.c; vessel.D = marinesiaVessel.d; }
    }
    
    // Save cache occasionally
    if (Math.random() < 0.01) saveCache();
    
  } catch (error) {
    console.warn('Error processing AIS message:', sanitizeLogInput(String(error.message)));
    if (DEBUG) console.warn('Message:', sanitizeLogInput(JSON.stringify(message).substring(0, 200)));
  }
}

// Clean up old vessels every 5 minutes
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 3600000);
  let removed = 0;
  let classA = 0, classB = 0, navigationAids = 0, unknown = 0;
  
  for (const [mmsi, vessel] of vesselCache.entries()) {
    if (vessel.lastUpdate < oneHourAgo) {
      vesselCache.delete(mmsi);
      removed++;
    } else {
      // Count vessel types for statistics
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else unknown++;
    }
  }
  
  // Clean up caches to prevent memory issues
  cleanupCaches();
  
  if (removed > 0) {
    console.log(`Cleaned up ${removed} old vessels. Active: ${classA} Class A, ${classB} Class B, ${navigationAids} nav aids, ${unknown} other`);
    saveCache();
  } else if (DEBUG) {
    console.log(`Vessel count: ${classA} Class A, ${classB} Class B, ${navigationAids} nav aids, ${unknown} other`);
  }
}, 300000);

setInterval(saveCache, 600000);



// AISHub-compatible REST endpoint
app.get('/ais-proxy/ws.php', async (req, res) => {
  const { username, latmin, latmax, lonmin, lonmax } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ ERROR: true, MESSAGE: 'Unauthorized' });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username || 'anonymous', keyValidation.rateLimit);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ ERROR: true, MESSAGE: rateLimitCheck.message });
  }
  
  // Use provided bounding box or default to NZ region
  const minLat = latmin ? parseFloat(latmin) : -48.0;
  const maxLat = latmax ? parseFloat(latmax) : -34.0;
  const minLon = lonmin ? parseFloat(lonmin) : 166.0;
  const maxLon = lonmax ? parseFloat(lonmax) : 179.0;

  const vessels = [];
  for (const vessel of vesselCache.values()) {
    if (vessel.LATITUDE >= minLat && vessel.LATITUDE <= maxLat &&
        vessel.LONGITUDE >= minLon && vessel.LONGITUDE <= maxLon) {
      
      // Filter out navigation aids from v1 API (AISHub compatibility)
      if (vessel._messageType === 'AidsToNavigationReport') {
        continue;
      }
      
      vessels.push({
        MMSI: vessel.MMSI,
        TIME: vessel.TIME,
        LONGITUDE: vessel.LONGITUDE,
        LATITUDE: vessel.LATITUDE,
        COG: vessel.COG,
        SOG: vessel.SOG,
        HEADING: vessel.HEADING,
        NAVSTAT: vessel.NAVSTAT,
        IMO: vessel.IMO,
        NAME: vessel.NAME || '',
        CALLSIGN: vessel.CALLSIGN || '',
        TYPE: vessel.TYPE,
        A: vessel.A,
        B: vessel.B,
        C: vessel.C,
        D: vessel.D,
        DRAUGHT: vessel.DRAUGHT,
        DEST: vessel.DEST || '',
        ETA: vessel.ETA
      });
    }
  }

  res.json({ VESSELS: vessels });
});



// Enhanced v2 API endpoint
app.get('/ais-proxy/v2/vessels', async (req, res) => {
  const { username, latmin, latmax, lonmin, lonmax, include } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized', message: keyValidation.reason });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username || 'anonymous', keyValidation.rateLimit);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: rateLimitCheck.message });
  }
  
  // Parse include filter (default: vessels only)
  const includeTypes = include ? include.split(',') : ['vessels'];
  const includeVessels = includeTypes.includes('vessels') || includeTypes.includes('all');
  const includeNavAids = includeTypes.includes('navigation-aids') || includeTypes.includes('all');
  
  // Use provided bounding box or default to NZ region
  const minLat = latmin ? parseFloat(latmin) : -48.0;
  const maxLat = latmax ? parseFloat(latmax) : -34.0;
  const minLon = lonmin ? parseFloat(lonmin) : 166.0;
  const maxLon = lonmax ? parseFloat(lonmax) : 179.0;

  const vessels = [];
  let classA = 0, classB = 0, navigationAids = 0, other = 0;
  let oldestUpdate = new Date();
  let newestUpdate = new Date(0);
  
  for (const vessel of vesselCache.values()) {
    if (vessel.LATITUDE >= minLat && vessel.LATITUDE <= maxLat &&
        vessel.LONGITUDE >= minLon && vessel.LONGITUDE <= maxLon) {
      
      const isNavigationAid = vessel._messageType === 'AidsToNavigationReport';
      const isVessel = !isNavigationAid;
      
      // Apply filtering
      if ((isVessel && !includeVessels) || (isNavigationAid && !includeNavAids)) {
        continue;
      }
      
      // Count vessel types
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else other++;
      
      // Track update times
      if (vessel.lastUpdate < oldestUpdate) oldestUpdate = vessel.lastUpdate;
      if (vessel.lastUpdate > newestUpdate) newestUpdate = vessel.lastUpdate;
      
      vessels.push({
        mmsi: vessel.MMSI,
        time: vessel.TIME,
        longitude: vessel.LONGITUDE,
        latitude: vessel.LATITUDE,
        cog: vessel.COG,
        sog: vessel.SOG,
        heading: vessel.HEADING,
        navstat: vessel.NAVSTAT,
        imo: vessel.IMO,
        name: vessel.NAME || '',
        callsign: vessel.CALLSIGN || '',
        type: vessel.TYPE,
        dimensions: {
          a: vessel.A,
          b: vessel.B,
          c: vessel.C,
          d: vessel.D
        },
        draught: vessel.DRAUGHT,
        destination: vessel.DEST || '',
        eta: vessel.ETA,
        // Enhanced fields
        rateOfTurn: vessel._rateOfTurn,
        positionAccuracy: vessel._positionAccuracy,
        timestamp: vessel._timestamp,
        messageType: vessel._messageType,
        valid: vessel._valid,
        lastUpdate: vessel.lastUpdate.toISOString(),
        // Easy identification
        category: isNavigationAid ? 'navigation-aid' : 'vessel',
        nameSource: vessel._nameSource
      });
    }
  }

  res.json({
    vessels,
    metadata: {
      totalCount: vessels.length,
      categories: {
        vessels: classA + classB,
        navigationAids
      },
      vesselTypes: {
        classA,
        classB,
        navigationAids,
        other
      },
      filters: {
        applied: include || 'vessels',
        available: ['vessels', 'navigation-aids', 'all']
      },
      boundingBox: {
        minLatitude: minLat,
        maxLatitude: maxLat,
        minLongitude: minLon,
        maxLongitude: maxLon
      },
      dataFreshness: {
        oldestUpdate: vessels.length > 0 ? oldestUpdate.toISOString() : null,
        newestUpdate: vessels.length > 0 ? newestUpdate.toISOString() : null
      },
      generatedAt: new Date().toISOString(),
      apiVersion: '2.0'
    }
  });
});

app.get('/ais-proxy/health', async (req, res) => {
  try {
    const keys = await loadApiKeys();
    const enabledUserKeys = Object.values(keys.users || {}).filter(k => k.enabled).length;
    const hasAISStreamKey = !!(keys.aisstream?.primary?.key || keys.aisstream?.backup?.key);
    
    res.json({ 
      status: 'ok', 
      vessels: vesselCache.size,
      uptime: process.uptime(),
      user_keys_configured: enabledUserKeys,
      aisstream_key_configured: hasAISStreamKey,
      public_mode: !!keys._publicMode,
      config_bucket: !!CONFIG_BUCKET,
      upload_clients_24h: Array.from(clientStatusCache.values())
        .filter(status => status.lastSeen > new Date(Date.now() - 24 * 60 * 60 * 1000)).length
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});



// AIS data upload endpoint (jsonais format)
app.post('/ais-proxy/jsonais/:apiKey', async (req, res) => {
  const apiKey = req.params.apiKey;
  const clientId = apiKey.slice(-4); // Last 4 characters for identification
  
  if (!apiKey || apiKey.length < 8) {
    return res.status(400).json({ error: 'Invalid API key format' });
  }
  
  // Validate API key (use existing user validation)
  const keyValidation = await validateUserApiKey(apiKey);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
  }
  
  // Rate limiting for uploads
  const rateLimitCheck = checkRateLimit(`upload_${apiKey}`, 100); // 100 uploads per minute
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: rateLimitCheck.message });
  }
  
  try {
    const data = req.body;
    
    // Validate request body exists and is not empty
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      console.warn(`❌ Empty or invalid request body from client ${clientId}`);
      return res.status(400).json({ error: 'Empty request body' });
    }
    

    
    // Only accept JSONAIS protocol format (single object)
    if (Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid format', message: 'Expected JSONAIS protocol object, not array' });
    }
    
    const messages = [data];
    
    let processed = 0;
    let errors = 0;
    
    // Update client status
    clientStatusCache.set(clientId, {
      lastSeen: new Date(),
      totalMessages: (clientStatusCache.get(clientId)?.totalMessages || 0) + messages.length,
      lastMessageCount: messages.length,
      apiKey: apiKey
    });
    
    for (const message of messages) {
      try {
        // Diagnostic: log message structure
        const msgStr = JSON.stringify(message);
        console.log(`🔍 Message from ${clientId}: size=${msgStr.length}, hasProtocol=${!!message.protocol}, hasMsgs=${!!message.msgs}, msgsLength=${message.msgs?.length || 0}`);
        
        // Convert jsonais format to AISStream-like format
        const aisMessage = convertJsonaisToAIS(message);
        if (aisMessage) {
          console.log(`📡 JSONAIS upload from ${clientId}: MMSI ${aisMessage.MetaData.MMSI}, pos ${aisMessage.MetaData.latitude},${aisMessage.MetaData.longitude}`);
          processAISMessage(aisMessage);
          processed++;
        }
      } catch (error) {
        console.warn(`❌ Error processing uploaded AIS message from ${clientId}:`, sanitizeLogInput(String(error.message)));
        errors++;
      }
    }
    
    res.json({
      success: true,
      processed,
      errors,
      total: messages.length,
      clientId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    // Check if error is due to malformed JSON
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
      console.error(`❌ JSON parsing error from client ${clientId}:`, sanitizeLogInput(String(error.message)));
      if (req.rawBody) {
        console.error(`Raw body length: ${req.rawBody.length}, first 200 chars:`, sanitizeLogInput(req.rawBody.toString().substring(0, 200)));
        
        // Attempt to recover data from truncated JSON
        const recoveredData = attemptJsonRecovery(req.rawBody);
        if (recoveredData) {
          console.log(`🔄 Attempting to recover data from truncated JSON for client ${clientId}`);
          try {
            let processed = 0;
            for (const message of recoveredData.msgs || []) {
              const aisMessage = convertJsonaisToAIS({ msgs: [message] });
              if (aisMessage) {
                console.log(`📡 Recovered JSONAIS upload from ${clientId}: MMSI ${aisMessage.MetaData.MMSI}`);
                processAISMessage(aisMessage);
                processed++;
              }
            }
            if (processed > 0) {
              return res.json({
                success: true,
                processed,
                recovered: true,
                message: 'Recovered data from truncated JSON',
                timestamp: new Date().toISOString()
              });
            }
          } catch (recoveryError) {
            console.warn(`Failed to recover from truncated JSON: ${sanitizeLogInput(String(recoveryError.message))}`);
          }
        }
      }
      return res.status(400).json({
        error: 'Invalid JSON',
        message: 'Request body contains malformed JSON - possibly truncated',
        timestamp: new Date().toISOString()
      });
    }
    
    console.error('AIS upload error:', sanitizeLogInput(String(error.message)));
    res.status(500).json({
      error: 'Processing failed',
      message: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Convert JSONAIS protocol format to AISStream-compatible format
function convertJsonaisToAIS(jsonaisMessage) {
  try {
    // Handle truncated AIS-catcher messages (common pattern: cut off at "setting":"N/A)
    if (typeof jsonaisMessage === 'string') {
      // Try to parse truncated JSON string
      try {
        jsonaisMessage = JSON.parse(jsonaisMessage);
      } catch (e) {
        // If parsing fails, try to extract msgs from the string
        const msgsMatch = jsonaisMessage.match(/"msgs":\s*\[(.*?)\]/s);
        if (msgsMatch) {
          try {
            const msgs = JSON.parse(`[${msgsMatch[1]}]`);
            jsonaisMessage = { msgs };
          } catch (e2) {
            return null;
          }
        } else {
          return null;
        }
      }
    }
    
    // Handle AIS-catcher format with top-level msgs array
    if (jsonaisMessage.msgs && Array.isArray(jsonaisMessage.msgs)) {
      if (jsonaisMessage.msgs.length === 0) {
        // Empty msgs array - this is normal for AIS-catcher when no messages received
        return null;
      }
      
      for (const msg of jsonaisMessage.msgs) {
        if (!msg.mmsi || msg.lat === undefined || msg.lon === undefined) {
          continue;
        }
        
        const mmsi = parseInt(msg.mmsi);
        if (mmsi < 100000000 || mmsi > 999999999) {
          continue;
        }
        
        const timestamp = msg.rxtime ? 
          parseJsonaisTime(msg.rxtime) : 
          Math.floor(Date.now() / 1000);
        
        return {
          MetaData: {
            MMSI: mmsi,
            latitude: parseFloat(msg.lat),
            longitude: parseFloat(msg.lon),
            time_utc: new Date(timestamp * 1000).toISOString()
          },
          MessageType: 'PositionReport',
          Message: {
            PositionReport: {
              Cog: msg.course !== undefined ? parseFloat(msg.course) : null,
              Sog: msg.speed !== undefined ? parseFloat(msg.speed) : null,
              TrueHeading: msg.heading !== undefined ? parseInt(msg.heading) : null,
              NavigationalStatus: msg.status !== undefined ? parseInt(msg.status) : null,
              Valid: true
            }
          }
        };
      }
    }
    
    // Handle AIS-catcher format that might be missing msgs array due to truncation
    if (jsonaisMessage.protocol === 'jsonaiscatcher' && !jsonaisMessage.msgs) {
      // This is likely a truncated message or one with no AIS data
      return null;
    }
    
    // Handle AIS-catcher Minimal format (direct message object)
    if (jsonaisMessage.mmsi && jsonaisMessage.lat !== undefined && jsonaisMessage.lon !== undefined) {
      const mmsi = parseInt(jsonaisMessage.mmsi);
      if (mmsi >= 100000000 && mmsi <= 999999999) {
        const timestamp = jsonaisMessage.rxtime ? 
          parseJsonaisTime(jsonaisMessage.rxtime) : 
          Math.floor(Date.now() / 1000);
        
        return {
          MetaData: {
            MMSI: mmsi,
            latitude: parseFloat(jsonaisMessage.lat),
            longitude: parseFloat(jsonaisMessage.lon),
            time_utc: new Date(timestamp * 1000).toISOString()
          },
          MessageType: 'PositionReport',
          Message: {
            PositionReport: {
              Cog: jsonaisMessage.course !== undefined ? parseFloat(jsonaisMessage.course) : null,
              Sog: jsonaisMessage.speed !== undefined ? parseFloat(jsonaisMessage.speed) : null,
              TrueHeading: jsonaisMessage.heading !== undefined ? parseInt(jsonaisMessage.heading) : null,
              NavigationalStatus: jsonaisMessage.status !== undefined ? parseInt(jsonaisMessage.status) : null,
              Valid: true
            }
          }
        };
      }
    }
    
    // Handle full JSONAIS protocol format with groups/msgs structure
    if (jsonaisMessage.groups && Array.isArray(jsonaisMessage.groups)) {
      for (const group of jsonaisMessage.groups) {
        if (group.msgs && Array.isArray(group.msgs)) {
          for (const msg of group.msgs) {
            if (!msg.mmsi || msg.lat === undefined || msg.lon === undefined) {
              continue;
            }
            
            const mmsi = parseInt(msg.mmsi);
            if (mmsi < 100000000 || mmsi > 999999999) {
              continue;
            }
            
            const timestamp = msg.rxtime ? 
              parseJsonaisTime(msg.rxtime) : 
              Math.floor(Date.now() / 1000);
            
            return {
              MetaData: {
                MMSI: mmsi,
                latitude: parseFloat(msg.lat),
                longitude: parseFloat(msg.lon),
                time_utc: new Date(timestamp * 1000).toISOString()
              },
              MessageType: 'PositionReport',
              Message: {
                PositionReport: {
                  Cog: msg.course !== undefined ? parseFloat(msg.course) : null,
                  Sog: msg.speed !== undefined ? parseFloat(msg.speed) : null,
                  TrueHeading: msg.heading !== undefined ? parseInt(msg.heading) : null,
                  NavigationalStatus: msg.status !== undefined ? parseInt(msg.status) : null,
                  Valid: true
                }
              }
            };
          }
        }
      }
    }
    
    // Handle AIS-catcher APRS format
    if (jsonaisMessage.call && jsonaisMessage.lat !== undefined && jsonaisMessage.lng !== undefined) {
      // Extract MMSI from call sign if it follows APRS format (e.g., "123456789")
      const mmsi = parseInt(jsonaisMessage.call);
      if (mmsi >= 100000000 && mmsi <= 999999999) {
        const timestamp = jsonaisMessage.time ? 
          Math.floor(new Date(jsonaisMessage.time).getTime() / 1000) : 
          Math.floor(Date.now() / 1000);
        
        return {
          MetaData: {
            MMSI: mmsi,
            latitude: parseFloat(jsonaisMessage.lat),
            longitude: parseFloat(jsonaisMessage.lng),
            time_utc: new Date(timestamp * 1000).toISOString()
          },
          MessageType: 'PositionReport',
          Message: {
            PositionReport: {
              Cog: jsonaisMessage.course !== undefined ? parseFloat(jsonaisMessage.course) : null,
              Sog: jsonaisMessage.speed !== undefined ? parseFloat(jsonaisMessage.speed) : null,
              TrueHeading: jsonaisMessage.heading !== undefined ? parseInt(jsonaisMessage.heading) : null,
              NavigationalStatus: jsonaisMessage.status !== undefined ? parseInt(jsonaisMessage.status) : null,
              Valid: true
            }
          }
        };
      }
    }
    
    // Handle direct message format (like aprs.fi might accept)
    if (jsonaisMessage.mmsi || jsonaisMessage.MMSI) {
      const mmsi = parseInt(jsonaisMessage.mmsi || jsonaisMessage.MMSI);
      const lat = parseFloat(jsonaisMessage.lat || jsonaisMessage.latitude);
      const lon = parseFloat(jsonaisMessage.lon || jsonaisMessage.lng || jsonaisMessage.longitude);
      
      if (mmsi >= 100000000 && mmsi <= 999999999 && 
          lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        
        const timestamp = jsonaisMessage.rxtime ? 
          parseJsonaisTime(jsonaisMessage.rxtime) : 
          Math.floor(Date.now() / 1000);
        
        return {
          MetaData: {
            MMSI: mmsi,
            latitude: lat,
            longitude: lon,
            time_utc: new Date(timestamp * 1000).toISOString()
          },
          MessageType: 'PositionReport',
          Message: {
            PositionReport: {
              Cog: jsonaisMessage.course !== undefined ? parseFloat(jsonaisMessage.course) : null,
              Sog: jsonaisMessage.speed !== undefined ? parseFloat(jsonaisMessage.speed) : null,
              TrueHeading: jsonaisMessage.heading !== undefined ? parseInt(jsonaisMessage.heading) : null,
              NavigationalStatus: jsonaisMessage.status !== undefined ? parseInt(jsonaisMessage.status) : null,
              Valid: true
            }
          }
        };
      }
    }
    
    // Handle array of messages
    if (Array.isArray(jsonaisMessage)) {
      for (const msg of jsonaisMessage) {
        const result = convertJsonaisToAIS(msg);
        if (result) return result; // Return first valid message
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Error converting JSONAIS message:', sanitizeLogInput(String(error.message)));
    return null;
  }
}

// Parse JSONAIS time format (YYYYMMDDHHMMSS)
function parseJsonaisTime(timeStr) {
  if (!timeStr || timeStr.length !== 14) return undefined;
  const year = timeStr.substr(0, 4);
  const month = timeStr.substr(4, 2);
  const day = timeStr.substr(6, 2);
  const hour = timeStr.substr(8, 2);
  const minute = timeStr.substr(10, 2);
  const second = timeStr.substr(12, 2);
  return Math.floor(new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).getTime() / 1000);
}

// Validate JSONAIS structure - be permissive like aprs.fi
function validateJsonaisStructure(data) {
  if (!data || typeof data !== 'object') return false;
  
  // Accept any object that has potential AIS data
  // Don't validate structure completeness - let convertJsonaisToAIS handle it
  return true;
}

// Attempt to recover from truncated JSON by trying to parse what we have
function attemptJsonRecovery(rawBody) {
  if (!rawBody) return null;
  
  const bodyStr = rawBody.toString();
  
  // Look for the msgs array in truncated JSON
  const msgsMatch = bodyStr.match(/"msgs":\s*\[(.*?)\]/s);
  if (msgsMatch) {
    try {
      const msgsStr = `[${msgsMatch[1]}]`;
      const msgs = JSON.parse(msgsStr);
      if (Array.isArray(msgs) && msgs.length > 0) {
        return { msgs };
      }
    } catch (e) {
      // Failed to parse msgs array
    }
  }
  
  return null;
}

// Client status endpoint
app.get('/ais-proxy/status', async (req, res) => {
  const { username } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  const activeClients = [];
  
  for (const [clientId, status] of clientStatusCache.entries()) {
    if (status.lastSeen > last24h) {
      activeClients.push({
        clientId,
        lastSeen: status.lastSeen.toISOString(),
        totalMessages: status.totalMessages,
        lastMessageCount: status.lastMessageCount,
        hoursAgo: Math.round((now - status.lastSeen) / (1000 * 60 * 60) * 10) / 10
      });
    }
  }
  
  // Sort by most recent
  activeClients.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  
  res.json({
    activeClients,
    totalActiveClients: activeClients.length,
    timeWindow: '24 hours',
    timestamp: now.toISOString()
  });
});

// Clean up old client status entries
setInterval(() => {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours
  let removed = 0;
  
  for (const [clientId, status] of clientStatusCache.entries()) {
    if (status.lastSeen < cutoff) {
      clientStatusCache.delete(clientId);
      removed++;
    }
  }
  
  if (removed > 0 && DEBUG) {
    console.log(`Cleaned up ${removed} old client status entries`);
  }
}, 3600000); // Every hour

// Enhanced v2 health endpoint
app.get('/ais-proxy/v2/health', async (req, res) => {
  try {
    const keys = await loadApiKeys();
    const enabledUserKeys = Object.values(keys.users || {}).filter(k => k.enabled).length;
    const hasAISStreamKey = !!(keys.aisstream?.primary?.key || keys.aisstream?.backup?.key);
    
    // Calculate vessel statistics
    let classA = 0, classB = 0, navigationAids = 0, other = 0;
    let oldestUpdate = new Date();
    let newestUpdate = new Date(0);
    
    for (const vessel of vesselCache.values()) {
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else other++;
      
      if (vessel.lastUpdate < oldestUpdate) oldestUpdate = vessel.lastUpdate;
      if (vessel.lastUpdate > newestUpdate) newestUpdate = vessel.lastUpdate;
    }
    
    res.json({
      status: 'ok',
      apiVersion: '2.0',
      uptime: process.uptime(),
      vessels: {
        total: vesselCache.size,
        classA,
        classB,
        navigationAids,
        other
      },

      dataFreshness: {
        oldestUpdate: vesselCache.size > 0 ? oldestUpdate.toISOString() : null,
        newestUpdate: vesselCache.size > 0 ? newestUpdate.toISOString() : null
      },
      configuration: {
        userKeysConfigured: enabledUserKeys,
        aisstreamKeyConfigured: hasAISStreamKey,
        publicMode: !!keys._publicMode,
        configBucket: !!CONFIG_BUCKET,
        debugMode: DEBUG
      },
      websocket: {
        connected: wsConnection?.readyState === 1,
        reconnectAttempts
      },
      marinesia: {
        enabled: marinesiaEnabled,
        cachedVessels: marinesiaCache.size,
        lastPoll: marinesiaLastPoll ? marinesiaLastPoll.toISOString() : null,
        pollInterval: MARINESIA_POLL_INTERVAL
      },
      uploadClients: {
        totalClients: clientStatusCache.size,
        activeClients24h: Array.from(clientStatusCache.values())
          .filter(status => status.lastSeen > new Date(Date.now() - 24 * 60 * 60 * 1000)).length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  if (wsConnection) {
    wsConnection.close(1000, 'Server shutdown');
  }
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  saveCache();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  if (wsConnection) {
    wsConnection.close(1000, 'Server shutdown');
  }
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  saveCache();
  process.exit(0);
});

// Marinesia vessel enrichment
const marinesiaCache = new Map(); // MMSI -> vessel data from Marinesia
let marinesiaEnabled = false;
let marinesiaLastPoll = null;
let marinesiaInterval = null;

// Map Marinesia type text to AIS type codes
const MARINESIA_TYPE_MAP = {
  'tanker': 80, 'cargo': 70, 'passenger': 60, 'fishing': 30,
  'tug': 52, 'towing': 52, 'pilot': 50, 'pleasure craft': 37,
  'sailing': 36, 'military': 35, 'high speed craft': 40,
  'search and rescue': 51, 'law enforcement': 55,
  'dredging': 33, 'diving': 33, 'supply ship': 79,
  'wing in ground (wig)': 20, 'port tender': 53, 'anti-pollution': 54,
  'medical': 58
};

async function pollMarinesia() {
  const apiKey = await getMarinesiaKey();
  if (!apiKey) {
    if (marinesiaEnabled) {
      console.warn('Marinesia API key removed, disabling enrichment');
      marinesiaEnabled = false;
    }
    return;
  }

  const { lat_min, lat_max, long_min, long_max } = MARINESIA_BOUNDING_BOX;
  const url = `https://api.marinesia.com/api/v2/vessel/area?lat_min=${lat_min}&lat_max=${lat_max}&long_min=${long_min}&long_max=${long_max}&key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'ais-proxy/1.0' }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Marinesia API returned ${response.status}`);
      return;
    }

    const body = await response.json();
    const vessels = body.data || [];

    let enriched = 0;
    for (const v of vessels) {
      if (!v.mmsi) continue;
      const typeKey = (v.type || '').toLowerCase();
      marinesiaCache.set(v.mmsi, {
        name: v.name || '',
        imo: v.imo || null,
        type: MARINESIA_TYPE_MAP[typeKey] ?? null,
        typeText: v.type || null,
        flag: v.flag || null,
        dest: v.dest || '',
        draught: v.draught || null,
        callsign: '', // Marinesia doesn't provide callsign
        a: v.a || null, b: v.b || null, c: v.c || null, d: v.d || null
      });

      // Immediately enrich any cached vessel missing data
      const cached = vesselCache.get(v.mmsi);
      if (cached) {
        if (!cached.NAME && v.name) {
          cached.NAME = v.name;
          cached._nameSource = 'marinesia';
          enriched++;
        }
        if ((cached.TYPE === null || cached.TYPE === 0) && MARINESIA_TYPE_MAP[typeKey] !== undefined) {
          cached.TYPE = MARINESIA_TYPE_MAP[typeKey];
        }
        if (!cached.IMO && v.imo) cached.IMO = v.imo;
        if (!cached.DEST && v.dest) cached.DEST = v.dest;
        if (!cached.DRAUGHT && v.draught) cached.DRAUGHT = v.draught;
        if ((cached.A === null || cached.A === 0) && v.a) { cached.A = v.a; cached.B = v.b; }
        if ((cached.C === null || cached.C === 0) && v.c) { cached.C = v.c; cached.D = v.d; }
      }
    }

    marinesiaLastPoll = new Date();
    if (!marinesiaEnabled) {
      marinesiaEnabled = true;
      console.log(`Marinesia enrichment enabled (${MARINESIA_POLL_INTERVAL/1000}s interval)`);
    }
    console.log(`Marinesia: ${vessels.length} vessels fetched, ${enriched} names enriched, ${marinesiaCache.size} cached`);
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.warn('Marinesia poll timed out');
    } else {
      console.warn('Marinesia poll failed:', sanitizeLogInput(String(error.message)));
    }
  }
}

async function startMarinesiaEnrichment() {
  const apiKey = await getMarinesiaKey();
  if (!apiKey) {
    console.log('Marinesia API key not configured, enrichment disabled');
    return;
  }
  console.log(`Starting Marinesia enrichment (interval: ${MARINESIA_POLL_INTERVAL/1000}s)`);
  await pollMarinesia();
  marinesiaInterval = setInterval(pollMarinesia, MARINESIA_POLL_INTERVAL);
}

app.listen(PORT, () => {
  console.log(`AIS Proxy server running on port ${PORT}`);
  loadCache();
  connectToAISStream();
  startMarinesiaEnrichment();
});