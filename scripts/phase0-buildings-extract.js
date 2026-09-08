#!/usr/bin/env node
/**
 * Phase 0 helper for docs/ATAK_3D_BUILDINGS.md §2.
 *
 * Pulls a small area out of the nz-building-heights PMTiles archive and emits
 * GeoJSON carrying ONLY the two attributes ATAK hardcodes for polygon
 * extrusion (MapBoxGLStyleSheet.cpp:215-216):
 *
 *   render_height      metres, absolute building height (from height_m)
 *   render_min_height  metres, base offset (always 0 here)
 *
 * Every other source attribute (height_max_m, roof_p90, flagged, ...) is
 * dropped on purpose: extra fields widen the schema that
 * Schema.OMT.matches() inspects, and a single non-OMT field or layer name
 * flips `autostyle` to true, which silently disables extrusion.
 *
 * Requires the `pmtiles` CLI on PATH, plus two npm packages that are NOT part
 * of this CDK project's dependencies. Run from a scratch directory:
 *
 *   mkdir -p /tmp/phase0 && cd /tmp/phase0
 *   npm init -y && npm install @mapbox/vector-tile pbf
 *   node <repo>/scripts/phase0-buildings-extract.js \
 *     ../CloudTAK/data/nz-building-heights.pmtiles \
 *     174.759 -36.854 174.771 -36.844 16 > block.geojson
 *
 * Then tile it (layer name MUST be singular `building` to match OMT):
 *
 *   tippecanoe -o buildings-test.mbtiles -Z14 -z16 -l building \
 *     --no-tile-compression block.geojson
 *
 * Usage: phase0-buildings-extract.js <archive> <west> <south> <east> <north> [zoom]
 */

const { execFileSync } = require('child_process');
const zlib = require('zlib');
const path = require('path');
const { createRequire } = require('module');

// These two packages are deliberately not dependencies of this CDK project, so
// resolve them from the working directory first and fall back to the script's
// own location. That lets the script be run straight out of the repo against a
// scratch directory that has them installed.
const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
function load(name) {
  try {
    return cwdRequire(name);
  } catch (e) {
    try {
      return require(name);
    } catch (e2) {
      console.error(`Cannot resolve "${name}". From a scratch directory run:`);
      console.error('  npm init -y && npm install @mapbox/vector-tile pbf');
      process.exit(1);
    }
  }
}

const { VectorTile } = load('@mapbox/vector-tile');
// pbf v5 renamed the default export; v4 and earlier exported the class directly
const pbf = load('pbf');
const PbfReader = pbf.PbfReader || pbf;

const SOURCE_LAYER = 'buildings'; // plural inside the archive
const argv = process.argv.slice(2);

if (argv.length < 5) {
  console.error('usage: phase0-buildings-extract.js <archive> <west> <south> <east> <north> [zoom]');
  process.exit(1);
}

const archive = argv[0];
const [west, south, east, north] = argv.slice(1, 5).map(Number);
const z = argv[5] === undefined ? 16 : Number(argv[5]);

/** Standard XYZ tile index (row 0 at the top) for a lon/lat pair. */
function lonLatToTile(lon, lat, zoom) {
  const n = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

const topLeft = lonLatToTile(west, north, z);
const bottomRight = lonLatToTile(east, south, z);

const xmin = Math.min(topLeft.x, bottomRight.x);
const xmax = Math.max(topLeft.x, bottomRight.x);
const ymin = Math.min(topLeft.y, bottomRight.y);
const ymax = Math.max(topLeft.y, bottomRight.y);

const tileCount = (xmax - xmin + 1) * (ymax - ymin + 1);
console.error(`z${z} tiles ${xmin}..${xmax} x ${ymin}..${ymax} (${tileCount} tiles)`);

const features = [];
let tilesRead = 0;
let skippedNoHeight = 0;

for (let x = xmin; x <= xmax; x++) {
  for (let y = ymin; y <= ymax; y++) {
    let raw;
    try {
      raw = execFileSync('pmtiles', ['tile', archive, String(z), String(x), String(y)], {
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.error(`  ${z}/${x}/${y}: absent`);
      continue;
    }
    if (!raw || !raw.length) {
      console.error(`  ${z}/${x}/${y}: empty`);
      continue;
    }

    // The `pmtiles` CLI exits 0 and prints a plain-text message on STDOUT when a
    // tile is absent from the archive, so the exit code cannot be relied on --
    // check the bytes. Archive header reports "tile compression: gzip".
    let buf;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      buf = zlib.gunzipSync(raw);
    } else if (raw.includes('Tile not found')) {
      console.error(`  ${z}/${x}/${y}: absent`);
      continue;
    } else {
      buf = raw; // already-uncompressed MVT
    }

    const layers = new VectorTile(new PbfReader(buf)).layers;
    const src = layers[SOURCE_LAYER];
    if (!src) {
      console.error(`  ${z}/${x}/${y}: no "${SOURCE_LAYER}" layer (found: ${Object.keys(layers).join(', ')})`);
      continue;
    }

    for (let i = 0; i < src.length; i++) {
      const f = src.feature(i).toGeoJSON(x, y, z);
      const p = f.properties || {};
      const h = p.height_m ?? p.height_max_m ?? p.roof_p90;
      if (h == null) {
        skippedNoHeight++;
        continue;
      }
      // if (p.flagged === 1) continue;  // optional: drop flagged geometry
      f.properties = {
        render_height: Math.round(Number(h) * 10) / 10,
        render_min_height: 0,
      };
      features.push(f);
    }

    tilesRead++;
    console.error(`  ${z}/${x}/${y}: ${src.length} features`);
  }
}

console.error(`\n${tilesRead} tiles read, ${features.length} polygons kept, ${skippedNoHeight} dropped (no height)`);
if (!features.length) {
  console.error('nothing to write');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'FeatureCollection', features }));
