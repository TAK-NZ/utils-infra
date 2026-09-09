#!/usr/bin/env node
// EMI dispatch — site-level aggregation & silent-site detection (step 2a)
// -----------------------------------------------------------------------------
// Aggregates real-time-dispatch POC records up to the substation level, then
// surfaces the two target cases:
//   * genSilent  — a generation-capable site producing nothing across ALL buses
//   * loadSilent — a consumption-capable site drawing nothing across ALL buses
//
// Only sites with a real NSP role are considered; inert grid-bus-only sites are
// excluded (their zero is structural, not an anomaly).
//
// IMPORTANT: a single snapshot cannot tell a genuine outage from normal quiet
// behaviour (a hydro station not dispatched, a tiny rural GXP below threshold).
// This tool produces the candidate shortlist; confirming an anomaly needs the
// per-site historical baseline (the planned step 2b).
//
// Usage:
//   EMI_API_KEY=xxxx node tools/emi-dispatch-sites.js
//   node tools/emi-dispatch-sites.js --file /tmp/rtd.json
//   node tools/emi-dispatch-sites.js --file /tmp/rtd.json --json
//   node tools/emi-dispatch-sites.js --file /tmp/rtd.json --all   # list every site
// -----------------------------------------------------------------------------

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { loadPocClassifier } from './lib/nsp-classify.js';
import { aggregateSites } from './lib/dispatch-aggregate.js';
import { loadSubstationLocations } from './lib/nsp-locations.js';

const DISPATCH_URL = 'https://emi.azure-api.net/real-time-dispatch/';
const ZERO_MW = 0.05;

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
    throw new Error('EMI_API_KEY is not set. Export your Wholesale-market-prices key.');
  }
  return httpGetJson(DISPATCH_URL, {
    'Ocp-Apim-Subscription-Key': apiKey,
    Accept: 'application/json',
  });
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function classifyAll(records, classifier) {
  return records.map((r) => {
    const c = classifier.classify(r.PointOfConnectionCode);
    const load = num(r.SPDLoadMegawatt);
    const gen = num(r.SPDGenerationMegawatt);
    return {
      poc: r.PointOfConnectionCode,
      matched: c.matched,
      substation: c.substation,
      role: c.role,
      description: c.description,
      island: c.island,
      load,
      generation: gen,
      price: num(r.DollarsPerMegawattHour),
      active: Math.abs(load) > ZERO_MW || gen > ZERO_MW,
    };
  });
}

function withLocation(site, locations) {
  const loc = locations.get(site.substation);
  return loc ? { latitude: loc.latitude, longitude: loc.longitude } : null;
}

function printReport(sites, summary, locations, meta, showAll) {
  console.log('\nEMI dispatch — site-level aggregation');
  console.log('='.repeat(68));
  if (meta.runTime) console.log(`Run time (UTC): ${meta.runTime}   Interval (NZ): ${meta.interval}`);
  console.log(
    `Sites: ${summary.totalSites}  |  generation ${summary.generation}, ` +
    `load ${summary.load}, mixed ${summary.mixed}, inactive ${summary.inactive} ` +
    `(of which ${summary.inactiveWithRealRole} have a real NSP role)`
  );
  console.log('');

  const genSilent = sites.filter((s) => s.genSilent);
  const loadSilent = sites.filter((s) => s.loadSilent);

  console.log(`CASE A — generation-capable sites producing nothing: ${genSilent.length}`);
  genSilent.forEach((s) => printCandidate(s, locations));
  if (!genSilent.length) console.log('  (none right now)');

  console.log(`\nCASE B — consumption-capable sites drawing nothing: ${loadSilent.length}`);
  loadSilent.forEach((s) => printCandidate(s, locations));
  if (!loadSilent.length) console.log('  (none right now)');

  if (showAll) {
    console.log('\n' + '-'.repeat(68));
    console.log('All sites (behavior | load MW | gen MW):');
    sites
      .sort((a, b) => (b.totalGeneration + Math.abs(b.totalLoad)) - (a.totalGeneration + Math.abs(a.totalLoad)))
      .forEach((s) => {
        console.log(
          `  ${s.substation.padEnd(5)} ${String(s.description || '').padEnd(16)} ` +
          `${s.behavior.padEnd(11)} load=${s.totalLoad.toFixed(1).padStart(8)} ` +
          `gen=${s.totalGeneration.toFixed(1).padStart(8)}`
        );
      });
  }

  console.log('\n' + '-'.repeat(68));
  console.log('Note: candidates are NOT confirmed outages. A generator may simply be');
  console.log('un-dispatched (check price), and a small GXP may be below the 0.05 MW');
  console.log('threshold normally. Validate against each site\'s historical baseline.');
  console.log('');
}

function printCandidate(s, locations) {
  const loc = withLocation(s, locations);
  const geo = loc ? `(${loc.latitude}, ${loc.longitude})` : 'no coords';
  console.log(
    `  ${s.substation.padEnd(5)} ${String(s.description || '?').padEnd(16)} ` +
    `[${(s.island || '?')}] roles=${JSON.stringify(s.nspRoles)} ` +
    `avgPrice=${s.avgPrice ?? '?'}  ${geo}`
  );
  s.pocs.forEach((p) => {
    console.log(`       ${p.poc.padEnd(16)} role=${p.role.padEnd(10)} load=${p.load} gen=${p.generation}`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const showAll = args.includes('--all');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx !== -1 ? args[fileIdx + 1] : null;

  const [payload, classifier, locations] = await Promise.all([
    file ? Promise.resolve(JSON.parse(readFileSync(file, 'utf8'))) : fetchDispatch(),
    Promise.resolve(loadPocClassifier()),
    loadSubstationLocations(),
  ]);

  const records = Array.isArray(payload) ? payload : [];
  if (!records.length) { console.error('No dispatch records.'); process.exit(1); }

  const classified = classifyAll(records, classifier);
  const { sites, summary } = aggregateSites(classified);
  const meta = { runTime: records[0].RunDateTime, interval: records[0].FiveMinuteIntervalDatetime };

  if (asJson) {
    const enrich = (s) => ({ ...s, location: withLocation(s, locations) });
    console.log(JSON.stringify({
      meta,
      summary,
      caseA_genSilent: sites.filter((s) => s.genSilent).map(enrich),
      caseB_loadSilent: sites.filter((s) => s.loadSilent).map(enrich),
      sites: showAll ? sites.map(enrich) : undefined,
    }, null, 2));
  } else {
    printReport(sites, summary, locations, meta, showAll);
  }
}

main().catch((err) => { console.error('Error:', err.message); process.exit(1); });
