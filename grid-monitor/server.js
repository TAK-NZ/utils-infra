// grid-monitor service
// -----------------------------------------------------------------------------
// Collects two NZ electricity-grid feeds and serves them as situational-awareness
// layers, while persisting timestamped snapshots to S3 for multi-week analysis:
//
//   1. WITS transmission outages  (public, no key)  -> planned/extended/unplanned
//      grid-asset outages, ranked; joined to substation coordinates.
//   2. EMI real-time dispatch     (requires EMI key) -> 5-minute load/generation
//      per grid POC, aggregated to sites; surfaces silent generation/consumer
//      sites (candidate anomalies).
//
// A background recorder polls both feeds on an interval and writes each changed
// snapshot to the snapshot store (S3, with local-disk fallback). The snapshots
// are the real deliverable: they let us build the historical baseline that the
// anomaly detection needs.
//
// NOTE: These are grid/transmission-level signals, NOT confirmed customer
// outages. See the analysis libs for the caveats.
// -----------------------------------------------------------------------------

import express from 'express';

import { loadConfig, configMeta } from './lib/config.js';
import { writeSnapshot, readLatest, countSnapshots, storeMeta } from './lib/snapshot-store.js';

import { fetchOutagesFeed, feedItems, feedRunTime } from './tools/lib/wits-feed.js';
import { analyze } from './tools/lib/transmission-analyze.js';
import { loadSubstationLocations } from './tools/lib/nsp-locations.js';
import { loadPocClassifier } from './tools/lib/nsp-classify.js';
import { classifyDispatch, aggregateSites } from './tools/lib/dispatch-aggregate.js';
import { fetchDispatch, dispatchRunTime, dispatchInterval } from './tools/lib/emi-dispatch.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Feeds are refreshed on this cadence; EMI dispatch updates every 5 minutes.
const DEFAULT_INTERVAL_MS = 300000;

// ---------------------------------------------------------------------------
// Static reference data, loaded once at startup.
// ---------------------------------------------------------------------------
let substationLocations = new Map();
let pocClassifier = null;

// In-memory view of the latest computed results (served by the endpoints).
const state = {
  transmission: null,   // { generatedAt, stats, events }
  dispatchSites: null,   // { generatedAt, meta, summary, sites }
  lastPoll: { wits: null, dispatch: null },   // last successful fetch
  lastWrite: { wits: null, dispatch: null },  // last snapshot actually persisted
  errors: { wits: null, dispatch: null },
  // Staleness tracking (see isStale). observedKey = dedup key from the latest
  // poll; observedKeyAt = when this key was first seen; writtenKey = dedup key
  // of the last snapshot we persisted.
  feedKey: {
    wits: { observedKey: null, observedKeyAt: null, writtenKey: null },
    dispatch: { observedKey: null, observedKeyAt: null, writtenKey: null },
  },
};

// Grace window: a feed is only "stale" if its observed dedup key has been ahead
// of the written key for longer than this. Observe-and-write happen in the same
// poll, so any lag beyond one poll interval means a genuine write failure. This
// is feed-agnostic: a feed that simply hasn't republished (observed === written)
// is NEVER stale, no matter how long — which is the correct behaviour for WITS
// overnight quiet periods. Only a real "new data we failed to persist" trips it.
const STALE_GRACE_MS = 15 * 60 * 1000; // 15 min (3 poll cycles)

// ---------------------------------------------------------------------------
// Deduplication: decide whether a freshly fetched snapshot is new.
//
// We must NEVER dedup on a null/empty key. The EMI dispatch feed intermittently
// returns records with a null RunDateTime while the rest of the data is valid;
// keying dedup on that null froze the comparison (null === null) and suppressed
// every write for ~5 days. So: prefer run_time, fall back to the interval
// timestamp, and if neither is usable, always write.
// ---------------------------------------------------------------------------
function shouldWrite(last, key) {
  if (!key) return true;            // no usable key -> never skip
  if (!last) return true;           // nothing stored yet
  return last._dedupKey !== key;    // write only when the key advanced
}

// Record the dedup key seen on a successful poll. Tracks when THIS key first
// appeared so staleness can measure how long a new key has gone unpersisted.
function noteObserved(feed, key) {
  const fk = state.feedKey[feed];
  if (fk.observedKey !== key) {
    fk.observedKey = key;
    fk.observedKeyAt = Date.now();
  }
}

// Record that we persisted a snapshot with this key.
function noteWritten(feed, key) {
  state.feedKey[feed].writtenKey = key;
}

// A feed is stale only when its latest observed key is genuinely ahead of what
// we last wrote, and has been for longer than the grace window. If the feed
// simply hasn't republished (observedKey === writtenKey) it is never stale.
function isStale(feed) {
  const fk = state.feedKey[feed];
  if (!fk.observedKey) return false;                 // never polled successfully
  if (fk.observedKey === fk.writtenKey) return false; // nothing new to persist
  if (!fk.observedKeyAt) return false;
  return Date.now() - fk.observedKeyAt > STALE_GRACE_MS;
}


async function collectWits() {
  try {
    const payload = await fetchOutagesFeed();
    const runTime = feedRunTime(payload);
    const items = feedItems(payload);

    // Persist only when the dedup key advanced (run_time; never dedup on null).
    const dedupKey = runTime || null;
    noteObserved('wits', dedupKey);
    const last = await readLatest('wits-outages');
    if (shouldWrite(last, dedupKey)) {
      await writeSnapshot('wits-outages', {
        captured_at: new Date().toISOString(),
        run_time: runTime,
        _dedupKey: dedupKey,
        items,
      });
      state.lastWrite.wits = new Date().toISOString();
      noteWritten('wits', dedupKey);
    } else if (last) {
      // Already persisted (this or a prior run wrote this key); keep the
      // written-key marker in sync so we don't falsely appear stale after
      // a restart where the latest snapshot already matches the feed.
      noteWritten('wits', last._dedupKey ?? dedupKey);
    }

    const result = analyze(payload, {}, substationLocations);
    state.transmission = { generatedAt: new Date().toISOString(), ...result };
    state.lastPoll.wits = new Date().toISOString();
    state.errors.wits = null;
    console.log(`[wits] ${items.length} records, ${result.stats.eventGroups} event groups`);
  } catch (err) {
    state.errors.wits = err.message;
    console.error(`[wits] collect failed: ${err.message}`);
  }
}

async function collectDispatch() {
  try {
    const cfg = await loadConfig();
    const apiKey = cfg.emi?.apiKey;
    if (!apiKey) {
      state.errors.dispatch = 'no EMI API key configured';
      console.warn('[dispatch] skipped: no EMI API key');
      return;
    }

    const records = await fetchDispatch(apiKey);
    const runTime = dispatchRunTime(records);
    const interval = dispatchInterval(records);

    // Dedup key: prefer RunDateTime, fall back to the 5-minute interval
    // timestamp. RunDateTime is intermittently null from the feed; interval is
    // the reliable "new interval" signal. Never dedup on a null key.
    const dedupKey = runTime || interval || null;
    noteObserved('dispatch', dedupKey);
    const last = await readLatest('emi-dispatch');
    if (shouldWrite(last, dedupKey)) {
      await writeSnapshot('emi-dispatch', {
        captured_at: new Date().toISOString(),
        run_time: runTime,
        interval,
        _dedupKey: dedupKey,
        items: records,
      });
      state.lastWrite.dispatch = new Date().toISOString();
      noteWritten('dispatch', dedupKey);
    } else if (last) {
      noteWritten('dispatch', last._dedupKey ?? dedupKey);
    }

    const classified = classifyDispatch(records, pocClassifier);
    const { sites, summary } = aggregateSites(classified);
    // Attach coordinates to each site for map use.
    const enriched = sites.map((s) => {
      const loc = substationLocations.get(s.substation);
      return { ...s, location: loc ? { latitude: loc.latitude, longitude: loc.longitude } : null };
    });
    state.dispatchSites = {
      generatedAt: new Date().toISOString(),
      meta: { runTime, interval: dispatchInterval(records) },
      summary,
      sites: enriched,
    };
    state.lastPoll.dispatch = new Date().toISOString();
    state.errors.dispatch = null;
    console.log(`[dispatch] ${records.length} records, ${summary.totalSites} sites, ` +
      `genSilent ${summary.genSilent}, loadSilent ${summary.loadSilent}`);
  } catch (err) {
    state.errors.dispatch = err.message;
    console.error(`[dispatch] collect failed: ${err.message}`);
  }
}

async function pollAll() {
  await Promise.allSettled([collectWits(), collectDispatch()]);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

app.get('/grid-monitor/health', async (req, res) => {
  // A feed is write-stale only when the latest observed feed run has NOT been
  // persisted for longer than the grace window (see isStale). A feed that has
  // simply not republished is never stale, so this no longer false-alarms on
  // WITS overnight quiet periods — it flags only genuine "new data we failed
  // to write" situations.
  const writeStale = { wits: isStale('wits'), dispatch: isStale('dispatch') };
  const anyStale = writeStale.wits || writeStale.dispatch;
  const anyError = !!(state.errors.wits || state.errors.dispatch);

  res.json({
    status: anyError || anyStale ? 'degraded' : 'ok',
    uptime: process.uptime(),
    config: configMeta(),
    store: storeMeta(),
    lastPoll: state.lastPoll,
    lastWrite: state.lastWrite,
    writeStale,
    feedKey: state.feedKey,
    errors: state.errors,
    snapshotCounts: {
      wits: await countSnapshots('wits-outages').catch(() => null),
      dispatch: await countSnapshots('emi-dispatch').catch(() => null),
    },
  });
});

app.get('/grid-monitor/transmission', (req, res) => {
  if (!state.transmission) return res.status(503).json({ error: 'no data yet' });
  res.json({ version: '1.0', ...state.transmission });
});

app.get('/grid-monitor/dispatch/sites', (req, res) => {
  if (!state.dispatchSites) {
    return res.status(503).json({ error: 'no data yet (EMI key may be missing)' });
  }
  const { onlyCandidates } = req.query;
  const d = state.dispatchSites;
  if (onlyCandidates) {
    return res.json({
      version: '1.0',
      generatedAt: d.generatedAt,
      meta: d.meta,
      summary: d.summary,
      caseA_genSilent: d.sites.filter((s) => s.genSilent),
      caseB_loadSilent: d.sites.filter((s) => s.loadSilent),
    });
  }
  res.json({ version: '1.0', ...d });
});

// GeoJSON of the transmission event groups + dispatch silent-site candidates,
// for direct display on a map (e.g. CloudTAK).
app.get('/grid-monitor/geojson', (req, res) => {
  const features = [];

  for (const g of state.transmission?.events || []) {
    if (!g.location) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [g.location.longitude, g.location.latitude] },
      properties: {
        layer: 'transmission-outage',
        substation: g.substation,
        name: g.description,
        island: g.island,
        kind: g.kind,
        phase: g.phase,
        coordinated: g.coordinated,
        componentCount: g.componentCount,
        score: g.score,
        window: `${g.earliestStart} -> ${g.latestEnd}`,
      },
    });
  }

  for (const s of state.dispatchSites?.sites || []) {
    if (!(s.genSilent || s.loadSilent) || !s.location) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.location.longitude, s.location.latitude] },
      properties: {
        layer: s.genSilent ? 'generation-silent' : 'load-silent',
        substation: s.substation,
        name: s.description,
        island: s.island,
        totalLoad: s.totalLoad,
        totalGeneration: s.totalGeneration,
        avgPrice: s.avgPrice,
      },
    });
  }

  res.json({
    type: 'FeatureCollection',
    generatedAt: new Date().toISOString(),
    features,
  });
});

app.get('/grid-monitor', (req, res) => {
  res.json({
    service: 'grid-monitor',
    version: '1.0',
    description: 'NZ grid transmission-outage & real-time-dispatch monitor',
    endpoints: {
      transmission: '/grid-monitor/transmission',
      dispatchSites: '/grid-monitor/dispatch/sites',
      dispatchCandidates: '/grid-monitor/dispatch/sites?onlyCandidates=1',
      geojson: '/grid-monitor/geojson',
      health: '/grid-monitor/health',
    },
    caveat: 'Grid/transmission-level signals, not confirmed customer outages.',
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Load static reference data once.
  substationLocations = await loadSubstationLocations();
  pocClassifier = loadPocClassifier();
  console.log(`[startup] ${substationLocations.size} substation locations loaded`);

  const cfg = await loadConfig();
  const intervalMs = cfg.recorder?.intervalMs || DEFAULT_INTERVAL_MS;
  const enabled = cfg.recorder?.enabled !== false;

  app.listen(PORT, () => console.log(`grid-monitor listening on port ${PORT}`));

  if (enabled) {
    await pollAll();
    setInterval(pollAll, intervalMs);
    console.log(`[recorder] polling every ${intervalMs / 1000}s`);
  } else {
    console.log('[recorder] disabled by config');
  }
}

start().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
