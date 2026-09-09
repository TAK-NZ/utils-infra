#!/usr/bin/env node
// WITS outage monitor — snapshot recorder + diff/replay (experiment tool #2)
// -----------------------------------------------------------------------------
// A single snapshot of the WITS outages feed can only *guess* whether an outage
// is unplanned (via short lead time). To actually validate that heuristic we
// need to watch the feed over time and catch a real event as it appears.
//
// This tool does that:
//   --record   fetch the feed once and append a timestamped snapshot to a local
//              JSONL store. Designed to be run on a schedule (cron / CI). Skips
//              writing if the feed's run_time hasn't changed since the last one.
//   --diff     (default) compare the two most recent snapshots and report what
//              APPEARED, DISAPPEARED, and was EXTENDED between them. Each newly
//              appeared outage is classified by its lead time at first sighting:
//              a start at/near/behind "now" with no history => likely unplanned.
//   --replay   walk the entire snapshot history and list every outage that
//              looked unplanned the moment it first appeared. This is the
//              after-the-fact log for tuning the heuristic against real events.
//
// Store format: one JSON object per line (JSONL):
//   { "captured_at": "<ISO>", "run_time": "<feed NZ time>", "items": [ ... ] }
// where items are trimmed to the fields we need.
//
// Usage:
//   node tools/emi-outage-monitor.js --record
//   node tools/emi-outage-monitor.js --diff
//   node tools/emi-outage-monitor.js --replay
//   node tools/emi-outage-monitor.js --diff --json
//   node tools/emi-outage-monitor.js --record --store /path/to/snapshots.jsonl
//
// Schedule the recorder (example, every 10 min):
//   */10 * * * * cd .../power-outages && node tools/emi-outage-monitor.js --record
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchOutagesFeed, feedItems, feedRunTime } from './lib/wits-feed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE = join(__dirname, '..', 'data', 'wits-outage-snapshots.jsonl');

// A newly-appeared outage whose start is within this window of the snapshot
// time (past or near-future) and has no prior revision is treated as a
// likely-unplanned / short-notice event.
const SHORT_NOTICE_HOURS = 6;

// Only the fields we need, to keep the store compact.
const KEEP_FIELDS = [
  'outage_id', 'component_id', 'outage_block', 'component_type',
  'start_time', 'end_time', 'status', 'run_time', 'last_run_time',
  'last_end_time', 'last_start_time', 'cancelled', 'event_id',
];

function parseNz(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, se);
}

function trimItem(i) {
  const out = {};
  for (const f of KEEP_FIELDS) out[f] = i[f] ?? null;
  return out;
}

function readSnapshots(store) {
  if (!existsSync(store)) return [];
  return readFileSync(store, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// -------------------------------- record -----------------------------------
async function record(store) {
  const payload = await fetchOutagesFeed();
  const runTime = feedRunTime(payload);
  const items = feedItems(payload).map(trimItem);

  const existing = readSnapshots(store);
  const last = existing[existing.length - 1];
  if (last && last.run_time === runTime) {
    console.log(`No change: feed run_time still ${runTime} (${items.length} items). Not recorded.`);
    return;
  }

  const snapshot = {
    captured_at: new Date().toISOString(),
    run_time: runTime,
    items,
  };
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, JSON.stringify(snapshot) + '\n', 'utf8');
  console.log(
    `Recorded snapshot: run_time=${runTime}, ${items.length} items ` +
    `(total snapshots: ${existing.length + 1}) -> ${store}`
  );
}

// Classify a newly-appeared outage by its lead time at the moment it was seen.
function classifyNew(item, snapshotTime) {
  const start = parseNz(item.start_time);
  if (!start) return { kind: 'unknown', leadHours: null };
  const leadHours = (start - snapshotTime) / 36e5;
  const hasHistory = !!item.last_run_time;
  // Started already, or about to, and no prior scheduling revision -> unplanned.
  if (!hasHistory && leadHours <= SHORT_NOTICE_HOURS) {
    return { kind: 'unplanned?', leadHours };
  }
  if (leadHours < 0) return { kind: 'already-started', leadHours };
  return { kind: 'planned', leadHours };
}

function indexByComponent(items) {
  const m = new Map();
  for (const i of items) m.set(i.component_id, i);
  return m;
}

// --------------------------------- diff ------------------------------------
function diffSnapshots(prev, curr) {
  const prevIdx = indexByComponent(prev.items);
  const currIdx = indexByComponent(curr.items);
  const snapTime = parseNz(curr.run_time) || new Date(curr.captured_at);

  const appeared = [];
  const disappeared = [];
  const extended = [];

  for (const [cid, it] of currIdx) {
    if (!prevIdx.has(cid)) {
      const cls = classifyNew(it, snapTime);
      appeared.push({ ...it, ...cls });
    } else {
      const before = prevIdx.get(cid);
      const oldEnd = parseNz(before.end_time);
      const newEnd = parseNz(it.end_time);
      if (oldEnd && newEnd && newEnd - oldEnd >= 36e5) {
        extended.push({
          component_id: cid,
          outage_block: it.outage_block,
          from_end: before.end_time,
          to_end: it.end_time,
          extendedHours: Math.round((newEnd - oldEnd) / 36e5),
        });
      }
    }
  }
  for (const [cid, it] of prevIdx) {
    if (!currIdx.has(cid)) {
      disappeared.push({ component_id: cid, outage_block: it.outage_block, end_time: it.end_time });
    }
  }

  appeared.sort((a, b) => (a.leadHours ?? 1e9) - (b.leadHours ?? 1e9));
  extended.sort((a, b) => b.extendedHours - a.extendedHours);

  return {
    from: { captured_at: prev.captured_at, run_time: prev.run_time },
    to: { captured_at: curr.captured_at, run_time: curr.run_time },
    appeared,
    disappeared,
    extended,
  };
}

function printDiff(diff) {
  console.log('\nWITS outage feed diff');
  console.log('='.repeat(72));
  console.log(`from run_time ${diff.from.run_time}  (captured ${diff.from.captured_at})`);
  console.log(`to   run_time ${diff.to.run_time}  (captured ${diff.to.captured_at})`);
  console.log('');

  const unplanned = diff.appeared.filter((a) => a.kind === 'unplanned?' || a.kind === 'already-started');
  console.log(`APPEARED: ${diff.appeared.length}  (of which short-notice/started: ${unplanned.length})`);
  diff.appeared.forEach((a) => {
    const flag = a.kind === 'unplanned?' ? ' <-- UNPLANNED?' : a.kind === 'already-started' ? ' <-- already started' : '';
    const lead = a.leadHours == null ? '?' : `${a.leadHours >= 0 ? '+' : ''}${a.leadHours.toFixed(1)}h`;
    console.log(`  ${a.component_id.padEnd(16)} start=${a.start_time} lead=${lead.padEnd(8)} ${a.kind}${flag}`);
  });

  console.log(`\nEXTENDED: ${diff.extended.length}`);
  diff.extended.forEach((e) => {
    console.log(`  ${e.component_id.padEnd(16)} ${e.from_end} -> ${e.to_end}  (+${e.extendedHours}h)`);
  });

  console.log(`\nDISAPPEARED (ended/removed): ${diff.disappeared.length}`);
  diff.disappeared.forEach((d) => {
    console.log(`  ${d.component_id.padEnd(16)} block=${d.outage_block} last end=${d.end_time}`);
  });

  console.log('\n' + '-'.repeat(72));
  console.log('Note: "UNPLANNED?" = appeared with start within ' + SHORT_NOTICE_HOURS +
    'h of the snapshot and no prior');
  console.log('revision. This is the signal to validate against a real event. Keep recording.');
  console.log('');
}

// -------------------------------- replay -----------------------------------
function replay(snapshots) {
  // Everything present in the FIRST snapshot is our baseline — we have no
  // "before" for those, so we can't tell if they were planned or unplanned when
  // they started. Only components that first appear in a LATER snapshot are
  // genuine arrivals during the monitoring period and can be classified.
  const seen = new Set();
  if (snapshots.length) {
    for (const it of snapshots[0].items) seen.add(it.component_id);
  }
  const baselineComponents = seen.size;

  const flagged = [];
  let newArrivals = 0;
  for (let s = 1; s < snapshots.length; s++) {
    const snap = snapshots[s];
    const snapTime = parseNz(snap.run_time) || new Date(snap.captured_at);
    for (const it of snap.items) {
      if (seen.has(it.component_id)) continue;
      seen.add(it.component_id);
      newArrivals++;
      const cls = classifyNew(it, snapTime);
      if (cls.kind === 'unplanned?' || cls.kind === 'already-started') {
        flagged.push({
          component_id: it.component_id,
          outage_block: it.outage_block,
          start_time: it.start_time,
          end_time: it.end_time,
          first_seen_snapshot: snap.captured_at,
          feed_run_time: snap.run_time,
          leadHours: cls.leadHours,
          kind: cls.kind,
        });
      }
    }
  }
  return {
    snapshots: snapshots.length,
    baselineComponents,
    newArrivals,
    componentsSeen: seen.size,
    flagged,
  };
}

function printReplay(result) {
  console.log('\nWITS outage history replay (candidate unplanned events)');
  console.log('='.repeat(72));
  console.log(
    `Snapshots: ${result.snapshots} | baseline components (snapshot 1, excluded): ` +
    `${result.baselineComponents} | new arrivals since: ${result.newArrivals}`
  );
  console.log(`Candidate short-notice/unplanned events (new arrivals only): ${result.flagged.length}`);
  console.log('');
  if (!result.flagged.length) {
    console.log('None yet. Keep the recorder running; unplanned events are intermittent,');
    console.log('and only outages that arrive AFTER the first snapshot can be classified.');
    console.log('');
    return;
  }
  result.flagged.forEach((f) => {
    const lead = f.leadHours == null ? '?' : `${f.leadHours >= 0 ? '+' : ''}${f.leadHours.toFixed(1)}h`;
    console.log(`  ${f.component_id.padEnd(16)} start=${f.start_time} lead=${lead.padEnd(8)} ${f.kind}`);
    console.log(`      first seen ${f.first_seen_snapshot} (feed ${f.feed_run_time}), block=${f.outage_block}`);
  });
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const storeIdx = args.indexOf('--store');
  const store = storeIdx !== -1 ? args[storeIdx + 1] : DEFAULT_STORE;

  if (args.includes('--record')) {
    await record(store);
    return;
  }

  if (args.includes('--replay')) {
    const snaps = readSnapshots(store);
    const result = replay(snaps);
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printReplay(result);
    return;
  }

  // Default: diff the two most recent snapshots.
  const snaps = readSnapshots(store);
  if (snaps.length < 2) {
    console.log(
      `Need at least 2 snapshots to diff (have ${snaps.length}).\n` +
      `Run "--record" a few times (ideally on a schedule) first.\n` +
      `Store: ${store}`
    );
    return;
  }
  const diff = diffSnapshots(snaps[snaps.length - 2], snaps[snaps.length - 1]);
  if (asJson) console.log(JSON.stringify(diff, null, 2));
  else printDiff(diff);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
