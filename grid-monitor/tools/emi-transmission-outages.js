#!/usr/bin/env node
// WITS transmission-outage analysis (experiment tool #1)
// -----------------------------------------------------------------------------
// Pulls the public WITS "Outages" feed (OTOV = Outages/Overrides currently in
// effect + scheduled ahead) from electricityinfo.co.nz, then isolates the
// entries that are *plausibly impacting* the grid right now or imminently, and
// joins them to substation coordinates from the EA Network Supply Points table.
//
// This is Transpower's PLANNED transmission-asset outage register. Important
// caveats (see the notes printed at the end of the report):
//   * A scheduled asset outage does NOT mean customers lost power. Redundant
//     (N-1) substations stay supplied when one transformer/circuit is out.
//   * It is transmission-level only; distribution/feeder/street outages are
//     invisible here (use the lines-company scrapers for those).
// What it IS good for: near-real-time awareness of planned transmission work,
// especially COORDINATED multi-component jobs at one site that reduce redundancy.
//
// Heuristics used to surface the interesting subset:
//   1. Drop "background" entries that have been in effect > BACKGROUND_DAYS
//      (long-term derations / decommissioned assets — constant noise).
//   2. Group remaining entries by (substation, outage_block).
//   3. Classify each group's timing: current | imminent (<=IMMINENT_HOURS) | future.
//   4. Score: coordinated (multiple components) + current/imminent ranks highest.
//
// Usage:
//   node tools/emi-transmission-outages.js                 # live feed
//   node tools/emi-transmission-outages.js --sample        # bundled offline sample
//   node tools/emi-transmission-outages.js --json          # machine-readable
//   node tools/emi-transmission-outages.js --all           # include background/future
//   node tools/emi-transmission-outages.js --refresh-nsp   # refresh NSP CSV from blob
//   node tools/emi-transmission-outages.js --window 72     # imminent window (hours)
// -----------------------------------------------------------------------------

import { loadSubstationLocations } from './lib/nsp-locations.js';
import { fetchOutagesFeed } from './lib/wits-feed.js';
import { analyze, DEFAULT_IMMINENT_HOURS } from './lib/transmission-analyze.js';

// -----------------------------------------------------------------------------
// Small bundled sample so the tool runs offline. Trimmed real-shaped records.
// -----------------------------------------------------------------------------
const SAMPLE = {
  content: {
    items: [
      { outage_id: '1', component_id: 'DOB_T11.T11', outage_block: 'DOB_T11', component_type: 'XF', start_time: '2026-08-23 09:18:15', end_time: '2026-08-24 18:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '2', component_id: 'DOB_T11.L11', outage_block: 'DOB_T11', component_type: 'XF', start_time: '2026-08-23 09:18:15', end_time: '2026-08-24 18:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '3', component_id: 'DOB_RFN_IGH2.1', outage_block: 'DOB_RFN_IGH_2', component_type: 'LN', start_time: '2026-08-23 08:59:14', end_time: '2026-08-24 18:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '4', component_id: 'HAM_T8.T8', outage_block: 'HAM_T8', component_type: 'XF', start_time: '2026-08-17 07:30:00', end_time: '2026-08-24 18:30:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '5', component_id: 'ISL_T8.T8', outage_block: 'ISL_T8', component_type: 'XF', start_time: '2026-08-24 06:30:00', end_time: '2026-08-28 18:30:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '6', component_id: 'ISL_KIK2.1', outage_block: 'ISL_KIK2', component_type: 'LN', start_time: '2026-08-24 06:30:00', end_time: '2026-08-28 18:30:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      { outage_id: '7', component_id: 'ALB_C1', outage_block: 'ALB_C_1', component_type: 'CP', start_time: '2021-02-26 07:30:00', end_time: '2027-05-05 16:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0, last_end_time: '2026-05-05 16:00:00' },
      // Short-notice: appeared ~9 min after it started (unplanned profile).
      { outage_id: '8', component_id: 'GYM_KUM.1', outage_block: 'GYM_KUM_1', component_type: 'LN', start_time: '2026-08-23 15:20:00', end_time: '2026-08-23 19:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0 },
      // Currently in effect and long-running, but just extended by weeks — a
      // real ongoing outage being pushed out, must NOT be filtered as background.
      { outage_id: '9', component_id: 'HAY_T9.T9', outage_block: 'HAY_SC_9_T9', component_type: 'XF', start_time: '2025-06-03 07:30:00', end_time: '2026-09-30 18:00:00', status: 'Remove', run_time: '2026-08-23 15:29:09', cancelled: 0, last_end_time: '2026-07-31 18:00:00' },
    ],
  },
};

async function fetchOutages({ sample }) {
  if (sample) return SAMPLE;
  return fetchOutagesFeed();
}

function fmtWindow(g) {
  return `${g.earliestStart || '?'}  ->  ${g.latestEnd || '?'}`;
}

function printReport({ stats, events }, { source, includeAll }) {
  console.log(`\nWITS transmission outages  (source: ${source})`);
  console.log('='.repeat(72));
  console.log(`Feed run time (NZ): ${stats.runTime}`);
  console.log(
    `Records: ${stats.totalItems} total | current ${stats.current}, ` +
    `imminent ${stats.imminent}, future ${stats.future}, ` +
    `long-term background ${stats.background}`
  );
  console.log(
    `Flags: short-notice (unplanned?) ${stats.shortNotice}, ` +
    `extended past planned end ${stats.extended}`
  );
  console.log(
    `Shortlist: ${stats.shortlistItems} components in ${stats.eventGroups} event groups` +
    (includeAll
      ? '  (--all: nothing filtered)'
      : '  (current + imminent + short-notice + extended; background excluded)')
  );
  if (stats.unmappedSubstations.length) {
    console.log(`Unmapped substations (no coords): ${stats.unmappedSubstations.join(', ')}`);
  }
  console.log('');

  if (!events.length) {
    console.log('No plausibly-impacting current/imminent transmission outages right now.');
    console.log('');
    return;
  }

  console.log('Ranked event groups (most likely to matter first):');
  console.log('-'.repeat(72));
  events.forEach((g, idx) => {
    const geo = g.location
      ? `${g.description} (${g.location.latitude}, ${g.location.longitude})`
      : `${g.substation} — NO COORDS`;
    const kindTag =
      g.kind === 'unplanned?' ? 'UNPLANNED?' : g.kind === 'extended' ? 'EXTENDED' : null;
    const tags = [
      kindTag,
      g.phase.toUpperCase(),
      g.coordinated ? `COORDINATED x${g.componentCount}` : 'single',
      g.extended && g.kind !== 'extended' ? `+${Math.round(g.maxExtendedHours / 24)}d` : null,
      g.isGenerationSite ? 'GENERATION-SITE' : null,
    ].filter(Boolean).join('  ');
    console.log(`\n${idx + 1}. ${g.substation} / ${g.outageBlock}   [${tags}]  score=${g.score}`);
    console.log(`   location: ${geo}${g.island ? '  [' + g.island + ']' : ''}`);
    console.log(`   window:   ${fmtWindow(g)}`);
    g.components.forEach((c) => {
      console.log(`     - ${c.componentId.padEnd(16)} ${c.typeLabel.padEnd(15)} ${c.timing.padEnd(9)} ${c.status}`);
    });
  });

  console.log('\n' + '-'.repeat(72));
  console.log('Interpretation notes:');
  console.log('  * Most entries are PLANNED transmission outages, not confirmed customer outages.');
  console.log('  * UNPLANNED? = appeared in the feed within a few hours of its own start with no');
  console.log('    prior revision — the profile of a short-notice / emergency outage. Heuristic,');
  console.log('    not a guarantee; worth a closer look.');
  console.log('  * EXTENDED = end time pushed past the previously published end (an outage running');
  console.log('    longer than planned). Kept even if long-running, so genuine dragging events show.');
  console.log('  * COORDINATED groups (multiple components at one site, same window) reduce');
  console.log('    redundancy and matter most; a single component at an N-1 site usually impacts nobody.');
  console.log('  * Distribution/feeder/street outages are NOT visible here.');
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  const sample = args.includes('--sample');
  const asJson = args.includes('--json');
  const includeAll = args.includes('--all');
  const refreshNsp = args.includes('--refresh-nsp');
  const winIdx = args.indexOf('--window');
  const imminentHours = winIdx !== -1 ? Number(args[winIdx + 1]) : DEFAULT_IMMINENT_HOURS;

  const [payload, locations] = await Promise.all([
    fetchOutages({ sample }),
    loadSubstationLocations({ refresh: refreshNsp }),
  ]);

  const result = analyze(payload, { imminentHours, includeAll }, locations);
  const source = sample ? 'bundled sample' : 'live WITS feed';

  if (asJson) {
    console.log(JSON.stringify({ source, ...result }, null, 2));
  } else {
    printReport(result, { source, includeAll });
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
