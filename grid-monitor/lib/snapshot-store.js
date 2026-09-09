// Snapshot storage for grid-monitor.
// -----------------------------------------------------------------------------
// Persists feed snapshots so a multi-week monitoring run survives Fargate task
// restarts (in-memory caching alone would lose all history on redeploy/restart).
//
// Primary backend: S3. Each snapshot is written as an immutable, timestamped
// object under a date-partitioned prefix, plus a rolling "latest" pointer:
//
//   <prefix>/<feed>/YYYY/MM/DD/<ISO-timestamp>.json   (immutable history)
//   <prefix>/<feed>/latest.json                        (most recent snapshot)
//
// Date partitioning keeps prefix listings small when analysing weeks of data.
//
// Fallback backend: local disk (append-only JSONL per feed), used when no
// SNAPSHOT_BUCKET is configured (local dev / CI). Mirrors the CLI monitor store.
// -----------------------------------------------------------------------------

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bucket + prefix for snapshots. Defaults to the shared config bucket so we do
// not require a second bucket, but can be pointed elsewhere via env.
const SNAPSHOT_BUCKET = process.env.SNAPSHOT_BUCKET || process.env.CONFIG_BUCKET || null;
const SNAPSHOT_PREFIX = (process.env.SNAPSHOT_PREFIX || 'grid-monitor/snapshots').replace(/\/+$/, '');

const LOCAL_DIR = process.env.SNAPSHOT_DIR || join(__dirname, '..', 'data', 'snapshots');

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

function pad(n) { return String(n).padStart(2, '0'); }

function historyKey(feed, capturedAt) {
  const d = new Date(capturedAt);
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const stamp = d.toISOString().replace(/[:.]/g, '-');
  return `${SNAPSHOT_PREFIX}/${feed}/${y}/${mo}/${da}/${stamp}.json`;
}

function latestKey(feed) {
  return `${SNAPSHOT_PREFIX}/${feed}/latest.json`;
}

/**
 * Persist a snapshot for a feed.
 * @param {string} feed  logical feed name, e.g. "wits-outages" or "emi-dispatch"
 * @param {object} snapshot  { captured_at, run_time, ... , items }
 * @returns {Promise<{backend:string, location:string}>}
 */
export async function writeSnapshot(feed, snapshot) {
  const capturedAt = snapshot.captured_at || new Date().toISOString();
  const body = JSON.stringify(snapshot);

  if (SNAPSHOT_BUCKET) {
    const hKey = historyKey(feed, capturedAt);
    await s3Client.send(new PutObjectCommand({
      Bucket: SNAPSHOT_BUCKET, Key: hKey, Body: body, ContentType: 'application/json',
    }));
    // Best-effort rolling pointer; failure here shouldn't lose the history object.
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: SNAPSHOT_BUCKET, Key: latestKey(feed), Body: body, ContentType: 'application/json',
      }));
    } catch (err) {
      console.error(`[snapshot] latest pointer write failed for ${feed}: ${err.message}`);
    }
    return { backend: 's3', location: `s3://${SNAPSHOT_BUCKET}/${hKey}` };
  }

  // Local fallback: append one JSON object per line.
  mkdirSync(LOCAL_DIR, { recursive: true });
  const file = join(LOCAL_DIR, `${feed}.jsonl`);
  appendFileSync(file, body + '\n', 'utf8');
  return { backend: 'local', location: file };
}

/**
 * Fetch the most recent snapshot for a feed (for diffing / serving).
 * @param {string} feed
 * @returns {Promise<object|null>}
 */
export async function readLatest(feed) {
  if (SNAPSHOT_BUCKET) {
    try {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: SNAPSHOT_BUCKET, Key: latestKey(feed) }));
      return JSON.parse(await res.Body.transformToString());
    } catch (err) {
      if (err.name === 'NoSuchKey') return null;
      console.error(`[snapshot] readLatest(${feed}) failed: ${err.message}`);
      return null;
    }
  }
  const file = join(LOCAL_DIR, `${feed}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

/**
 * Count stored history objects for a feed (rough progress indicator).
 * S3: counts objects under the feed prefix (excluding latest.json).
 * Local: counts JSONL lines.
 * @param {string} feed
 * @returns {Promise<number>}
 */
export async function countSnapshots(feed) {
  if (SNAPSHOT_BUCKET) {
    let count = 0;
    let token;
    do {
      const res = await s3Client.send(new ListObjectsV2Command({
        Bucket: SNAPSHOT_BUCKET, Prefix: `${SNAPSHOT_PREFIX}/${feed}/`, ContinuationToken: token,
      }));
      for (const o of res.Contents || []) {
        if (!o.Key.endsWith('/latest.json')) count++;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return count;
  }
  const file = join(LOCAL_DIR, `${feed}.jsonl`);
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length;
}

export function storeMeta() {
  return {
    backend: SNAPSHOT_BUCKET ? 's3' : 'local',
    bucket: SNAPSHOT_BUCKET,
    prefix: SNAPSHOT_PREFIX,
    localDir: SNAPSHOT_BUCKET ? null : LOCAL_DIR,
  };
}
