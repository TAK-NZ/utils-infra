#!/usr/bin/env node
// EMI real-time dispatch — POC role classification & coverage (step 1)
// -----------------------------------------------------------------------------
// Fetches the EMI real-time-dispatch feed, joins every PointOfConnectionCode to
// the NSP table, and reports how many nodes we can classify by role
// (generation / consumer / both / grid-bus). This is the foundation for the two
// target cases (generation producing nothing; consumers using nothing) and the
// later historical anomaly detection.
//
// Requires an API key for the EMI "Wholesale market prices" product:
//   EMI_API_KEY=xxxx node tools/emi-dispatch-classify.js
//
// Offline: pass --file <path-to-saved-json> to classify a saved snapshot.
//   node tools/emi-dispatch-classify.js --file /tmp/rtd.json
//
// Output: human-readable coverage report, or --json for the classified records.
// -----------------------------------------------------------------------------

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { loadPocClassifier } from './lib/nsp-classify.js';

const DISPATCH_URL = 'https://emi.azure-api.net/real-time-dispatch/';
const ZERO_MW = 0.05; // treat |MW| below this as zero

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`EMI dispatch API returned ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Failed to parse EMI response: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('EMI request timed out')));
  });
}

async function fetchDispatch() {
  const apiKey = process.env.EMI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'EMI_API_KEY is not set. Export your Wholesale-market-prices key:\n' +
      '  EMI_API_KEY=your-key node tools/emi-dispatch-classify.js'
    );
  }
  return httpGetJson(DISPATCH_URL, {
    'Ocp-Apim-Subscription-Key': apiKey,
    Accept: 'application/json',
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function classifyAll(records, classifier) {
  return records.map((r) => {
    const c = classifier.classify(r.PointOfConnectionCode);
    const load = num(r.SPDLoadMegawatt);
    const gen = num(r.SPDGenerationMegawatt);
    const active = Math.abs(load) > ZERO_MW || gen > ZERO_MW;
    return {
      poc: r.PointOfConnectionCode,
      matchedPoc: c.matchedPoc,
      matched: c.matched,
      substation: c.substation,
      role: c.role,
      reconciliationType: c.reconciliationType,
      description: c.description,
      island: c.island,
      xFlow: c.xFlow,
      iFlow: c.iFlow,
      load,
      generation: gen,
      price: num(r.DollarsPerMegawattHour),
      active,
    };
  });
}

function summarize(classified) {
  const total = classified.length;
  const matched = classified.filter((c) => c.matched).length;
  const active = classified.filter((c) => c.active);
  const activeMatched = active.filter((c) => c.matched).length;

  const byRole = {};
  for (const c of classified) {
    byRole[c.role] = byRole[c.role] || { total: 0, active: 0 };
    byRole[c.role].total++;
    if (c.active) byRole[c.role].active++;
  }

  // The key validation number: any ACTIVE node we could not classify.
  const activeUnmatched = active.filter((c) => !c.matched);

  return { total, matched, activeCount: active.length, activeMatched, byRole, activeUnmatched };
}

function printReport(classified, summary, meta) {
  console.log('\nEMI dispatch POC classification & coverage');
  console.log('='.repeat(64));
  if (meta.runTime) console.log(`Run time (UTC): ${meta.runTime}`);
  if (meta.interval) console.log(`Interval (NZ):  ${meta.interval}`);
  console.log(`Records: ${summary.total}  |  matched to NSP: ${summary.matched}` +
    `  (${((summary.matched / summary.total) * 100).toFixed(0)}%)`);
  console.log(`Active (load or gen > ${ZERO_MW} MW): ${summary.activeCount}  |  ` +
    `active & classified: ${summary.activeMatched}`);
  console.log('');

  console.log('By role (total / active):');
  for (const [role, n] of Object.entries(summary.byRole).sort()) {
    console.log(`  ${role.padEnd(12)} ${String(n.total).padStart(4)}  /  ${n.active} active`);
  }

  console.log('');
  if (summary.activeUnmatched.length === 0) {
    console.log('COVERAGE OK: every active node (carrying load or generation) was');
    console.log('classified. Unmatched records are all inert grid buses.');
  } else {
    console.log(`WARNING: ${summary.activeUnmatched.length} ACTIVE node(s) could not be classified:`);
    summary.activeUnmatched.forEach((c) => {
      console.log(`  ${c.poc.padEnd(16)} load=${c.load} gen=${c.generation}`);
    });
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx !== -1 ? args[fileIdx + 1] : null;

  const payload = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : await fetchDispatch();

  const records = Array.isArray(payload) ? payload : [];
  if (!records.length) {
    console.error('No dispatch records in response.');
    process.exit(1);
  }

  const classifier = loadPocClassifier();
  const classified = classifyAll(records, classifier);
  const summary = summarize(classified);
  const meta = {
    runTime: records[0].RunDateTime,
    interval: records[0].FiveMinuteIntervalDatetime,
  };

  if (asJson) {
    console.log(JSON.stringify({ meta, summary: {
      total: summary.total, matched: summary.matched,
      activeCount: summary.activeCount, activeMatched: summary.activeMatched,
      byRole: summary.byRole,
      activeUnmatchedCount: summary.activeUnmatched.length,
    }, records: classified }, null, 2));
  } else {
    printReport(classified, summary, meta);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
