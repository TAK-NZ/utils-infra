// NSP (Network Supply Point) location loader.
// -----------------------------------------------------------------------------
// Parses the Electricity Authority "Network supply points table" CSV and builds
// a lookup from a 3-letter substation prefix (e.g. "HAY", "ISL") to a WGS84
// coordinate, using the POC code and NZTM2000 easting/northing columns.
//
// WITS transmission-outage component IDs (e.g. "HAY_T9.T9") share the same
// 3-letter substation prefix as the EA POC codes (e.g. "HAY0111"), which is
// what lets us join the two datasets.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fetch from 'node-fetch';
import proj4 from 'proj4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = join(__dirname, '..', '..', 'data', 'network-supply-points.csv');

// Canonical published source (EA public blob storage). Files are dated:
//   .../NetworkSupplyPointsTable/YYYYMMDD_NetworkSupplyPointsTable.csv
// This is the same R_NSPL_DR dataset the EMI UI exports, but at a stable,
// machine-fetchable URL. The committed data/network-supply-points.csv is a
// local snapshot used as the default (offline / CI) source.
const BLOB_BASE =
  'https://emidatasets.blob.core.windows.net/publicdata/Datasets/Wholesale/' +
  'MappingsAndGeospatial/NetworkSupplyPointsTable';

function blobUrlForDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${BLOB_BASE}/${y}${m}${d}_NetworkSupplyPointsTable.csv`;
}

/**
 * Download the latest published NSP table from the EA blob and write it to the
 * local CSV path. Tries the last few days, since the newest dated file lags the
 * current date. Returns the URL that succeeded.
 * @param {string} [csvPath] destination file
 * @param {number} [lookbackDays] how many days back to try
 * @returns {Promise<string>} the source URL used
 */
export async function refreshNspCsv(csvPath = DEFAULT_CSV, lookbackDays = 7) {
  let lastErr;
  for (let offset = 0; offset <= lookbackDays; offset++) {
    const date = new Date(Date.now() - offset * 86400000);
    const url = blobUrlForDate(date);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/120.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) { lastErr = new Error(`${res.status} ${res.statusText}`); continue; }
      const text = await res.text();
      if (!text.includes('Current flag,')) {
        lastErr = new Error('unexpected content (no NSP header)');
        continue;
      }
      writeFileSync(csvPath, text, 'utf8');
      return url;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not refresh NSP CSV from blob (tried ${lookbackDays + 1} days): ${lastErr?.message}`
  );
}

// NZTM2000 (EPSG:2193) -> WGS84 (EPSG:4326). Same definition used by the
// PowerCo scraper elsewhere in this service.
const NZTM2000 =
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ' +
  '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const WGS84 = 'EPSG:4326';

function nztmToWgs84(easting, northing) {
  const [longitude, latitude] = proj4(NZTM2000, WGS84, [easting, northing]);
  return { latitude, longitude };
}

// Minimal CSV line splitter. The EA file is simple (no quoted commas in the
// columns we use), but we handle basic double-quoted fields defensively.
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

/**
 * Parse NSP CSV text into a substation-prefix -> location map.
 * @param {string} text raw CSV content
 * @returns {Map<string, {substation:string, description:string, latitude:number, longitude:number, island:string, poc:string}>}
 */
export function parseSubstationLocations(text) {
  const lines = text.split(/\r?\n/);

  // Find the header row (starts with "Current flag").
  const headerIdx = lines.findIndex((l) => l.startsWith('Current flag,'));
  if (headerIdx === -1) {
    throw new Error(`Could not find header row in NSP CSV: ${csvPath}`);
  }
  const header = splitCsvLine(lines[headerIdx]);
  const col = (name) => header.indexOf(name);

  const iPoc = col('POC code');
  const iDesc = col('Description');
  const iEast = col('NZTM easting');
  const iNorth = col('NZTM northing');
  const iIsland = col('Island');
  if ([iPoc, iEast, iNorth].some((i) => i === -1)) {
    throw new Error('NSP CSV missing expected columns (POC code / NZTM easting / NZTM northing)');
  }

  const byPrefix = new Map();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (f.length <= iNorth) continue;

    const poc = (f[iPoc] || '').trim();
    if (poc.length < 3) continue;
    const prefix = poc.slice(0, 3);

    const east = parseFloat(f[iEast]);
    const north = parseFloat(f[iNorth]);
    if (!Number.isFinite(east) || !Number.isFinite(north)) continue;

    // First row wins per prefix; all POCs at a substation share its location.
    if (byPrefix.has(prefix)) continue;

    const { latitude, longitude } = nztmToWgs84(east, north);
    byPrefix.set(prefix, {
      substation: prefix,
      description: (f[iDesc] || '').trim(),
      island: (iIsland !== -1 ? f[iIsland] : '').trim(),
      poc,
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
    });
  }
  return byPrefix;
}

/**
 * Load substation coordinates keyed by 3-letter prefix from a local CSV file.
 * Optionally refresh the local file from the EA blob first.
 * @param {object} [opts]
 * @param {string} [opts.csvPath] path to the local NSP CSV
 * @param {boolean} [opts.refresh] download the latest published table first
 * @returns {Promise<Map<string, object>>}
 */
export async function loadSubstationLocations({ csvPath = DEFAULT_CSV, refresh = false } = {}) {
  if (refresh) {
    await refreshNspCsv(csvPath);
  }
  return parseSubstationLocations(readFileSync(csvPath, 'utf8'));
}
