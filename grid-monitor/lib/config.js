// S3-backed configuration loader for grid-monitor.
// -----------------------------------------------------------------------------
// Mirrors the weather-proxy pattern: read a JSON config object from S3 using
// CONFIG_BUCKET / CONFIG_KEY, cache it for a TTL, and fall back gracefully when
// no bucket is configured (local dev) or the object is missing.
//
// Config shape (Utils-Grid-Monitor-Config.json):
//   {
//     "emi":      { "apiKey": "<EMI real-time-dispatch subscription key>" },
//     "recorder": { "enabled": true, "intervalMs": 300000 }
//   }
//
// For local development the EMI key may instead be provided via the EMI_API_KEY
// environment variable, which takes precedence when the S3 config has none.
// -----------------------------------------------------------------------------

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'Utils-Grid-Monitor-Config.json';
const CONFIG_TTL_MS = 5 * 60 * 1000; // re-read config from S3 at most every 5 min

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

let cached = null;
let cachedAt = 0;

function defaults() {
  return {
    emi: { apiKey: process.env.EMI_API_KEY || null },
    recorder: { enabled: true, intervalMs: 300000 },
    _source: process.env.EMI_API_KEY ? 'env' : 'defaults',
  };
}

// Merge S3 config over defaults, letting EMI_API_KEY env override a blank key.
function normalize(raw) {
  const base = defaults();
  const emiKey = (raw.emi && raw.emi.apiKey) || process.env.EMI_API_KEY || null;
  return {
    emi: { apiKey: emiKey },
    recorder: {
      enabled: raw.recorder?.enabled ?? base.recorder.enabled,
      intervalMs: raw.recorder?.intervalMs ?? base.recorder.intervalMs,
    },
    _source: 's3',
  };
}

/**
 * Load configuration, cached for CONFIG_TTL_MS.
 * @param {boolean} [force] bypass the cache
 * @returns {Promise<object>}
 */
export async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CONFIG_TTL_MS) return cached;

  if (!CONFIG_BUCKET) {
    cached = defaults();
    cachedAt = now;
    console.warn('[config] CONFIG_BUCKET not set — using env/defaults');
    return cached;
  }

  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: CONFIG_BUCKET, Key: CONFIG_KEY }));
    const body = await res.Body.transformToString();
    cached = normalize(JSON.parse(body));
    cachedAt = now;
    return cached;
  } catch (err) {
    console.error(`[config] Failed to load ${CONFIG_KEY} from S3: ${err.message} — using env/defaults`);
    cached = defaults();
    cachedAt = now;
    return cached;
  }
}

export function configMeta() {
  return {
    bucket: CONFIG_BUCKET || null,
    key: CONFIG_KEY,
    source: cached?._source ?? null,
    hasEmiKey: !!cached?.emi?.apiKey,
  };
}
