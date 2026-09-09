// NSP (Network Supply Point) role classifier.
// -----------------------------------------------------------------------------
// Builds a lookup from a real-time-dispatch PointOfConnectionCode to the node's
// role, using the EA Network Supply Points table.
//
// Join strategy (validated against a live dispatch snapshot):
//   * Dispatch codes are sometimes compound, e.g. "ARA2201 ARA0" or "BEN2202 BEN0".
//     Matching on the FIRST token resolves every node that carries real load or
//     generation.
//   * The remaining unmatched dispatch codes (e.g. bare bus codes like "BEN2201")
//     were ALL zero-load and zero-generation in the snapshot — inert grid buses.
//     They are classified as 'grid-bus' and are not expected to carry activity.
//
// Role is derived from the NSP flow columns, which are more reliable than the
// reconciliation-type letter:
//   * I flow = 1  -> injection capable (generation)
//   * X flow = 1  -> offtake capable (consumption)
//   both set     -> 'both' (a station bus that imports and exports)
//
// Reconciliation types seen in the table (for reference / annotation):
//   GG = grid generation (power stations)      EN = embedded network (consumers)
//   GN = grid network / GXP offtake            GD = distribution offtake
//   NP = non-conforming / embedded generation
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = join(__dirname, '..', '..', 'data', 'network-supply-points.csv');

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function firstToken(code) {
  return (code || '').trim().split(/\s+/)[0];
}

function substationPrefix(code) {
  const m = /^([A-Z]+)/.exec(firstToken(code));
  return m ? m[1] : firstToken(code).slice(0, 3);
}

function roleFromFlows(xFlow, iFlow) {
  const x = xFlow === '1';
  const i = iFlow === '1';
  if (x && i) return 'both';
  if (i) return 'generation';
  if (x) return 'consumer';
  return 'unknown';
}

/**
 * Load the NSP table and return a POC classifier.
 * @param {string} [csvPath]
 * @returns {{
 *   byPoc: Map<string, object>,
 *   classify: (dispatchCode: string) => {
 *     poc: string, matched: boolean, matchedPoc: string|null, substation: string,
 *     role: 'generation'|'consumer'|'both'|'grid-bus'|'unknown',
 *     reconciliationType: string|null, description: string|null,
 *     island: string|null, xFlow: boolean, iFlow: boolean
 *   }
 * }}
 */
export function loadPocClassifier(csvPath = DEFAULT_CSV) {
  const text = readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith('Current flag,'));
  if (headerIdx === -1) throw new Error(`Could not find header row in NSP CSV: ${csvPath}`);

  const header = splitCsvLine(lines[headerIdx]);
  const col = (name) => header.indexOf(name);
  const iCurrent = col('Current flag');
  const iPoc = col('POC code');
  const iRecon = col('Reconciliation type');
  const iX = col('X flow');
  const iI = col('I flow');
  const iDesc = col('Description');
  const iIsland = col('Island');
  if ([iPoc, iX, iI].some((c) => c === -1)) {
    throw new Error('NSP CSV missing expected columns (POC code / X flow / I flow)');
  }

  // Index every POC. Prefer current-flag rows when a POC appears more than once.
  const byPoc = new Map();
  for (let li = headerIdx + 1; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (f.length <= iI) continue;
    const poc = (f[iPoc] || '').trim();
    if (!poc) continue;

    const entry = {
      poc,
      current: (f[iCurrent] || '').trim() === '1',
      reconciliationType: (f[iRecon] || '').trim() || null,
      xFlow: (f[iX] || '').trim() === '1',
      iFlow: (f[iI] || '').trim() === '1',
      role: roleFromFlows((f[iX] || '').trim(), (f[iI] || '').trim()),
      description: (f[iDesc] || '').trim() || null,
      island: (iIsland !== -1 ? f[iIsland] : '').trim() || null,
      substation: substationPrefix(poc),
    };
    const prev = byPoc.get(poc);
    if (!prev || (!prev.current && entry.current)) byPoc.set(poc, entry);
  }

  function classify(dispatchCode) {
    const token = firstToken(dispatchCode);
    const hit = byPoc.get(token);
    if (hit) {
      return {
        poc: dispatchCode,
        matched: true,
        matchedPoc: hit.poc,
        substation: hit.substation,
        role: hit.role,
        reconciliationType: hit.reconciliationType,
        description: hit.description,
        island: hit.island,
        xFlow: hit.xFlow,
        iFlow: hit.iFlow,
      };
    }
    // No NSP record: an inert grid bus (validated: these carry no activity).
    return {
      poc: dispatchCode,
      matched: false,
      matchedPoc: null,
      substation: substationPrefix(dispatchCode),
      role: 'grid-bus',
      reconciliationType: null,
      description: null,
      island: null,
      xFlow: false,
      iFlow: false,
    };
  }

  return { byPoc, classify };
}
