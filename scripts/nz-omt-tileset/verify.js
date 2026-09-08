#!/usr/bin/env node
/**
 * Verifies a built tileset against the constraints ATAK actually enforces.
 *
 * Checks, each tied to a specific piece of ATAK behaviour:
 *   1. metadata.format == "pbf"            -> MBTilesInfo infers content=vector
 *   2. every layer name is one of OMT's 16 -> Schema.OMT.matches() layerMiss == 0
 *   3. each layer shares >=1 field with OMT -> layerIntersect > 0
 *   4. `building` carries render_height     -> the only attribute ATAK extrudes
 *   5. tile compression state and max tile size
 *
 * Usage: node verify.js <tileset.mbtiles>
 */

const path = require('path');
const { createRequire } = require('module');
const { DatabaseSync } = require('node:sqlite');

const localRequire = createRequire(path.join(__dirname, 'package.json'));
function load(name) {
  try { return localRequire(name); } catch (e) { return require(name); }
}
const { VectorTile } = load('@mapbox/vector-tile');
const pbfMod = load('pbf');
const PbfReader = pbfMod.PbfReader || pbfMod;

const DB = process.argv[2];
if (!DB) { console.error('usage: verify.js <tileset.mbtiles>'); process.exit(1); }

// Schema.java:89-113 -- OMT layer names and the fields expected for each
const OMT_FIELDS = {
  water: ['brunnel', 'class', 'intermittent'],
  waterway: ['brunnel', 'intermittent', 'class', 'name'],
  landcover: ['class', 'subclass'],
  landuse: ['class'],
  mountain_peak: ['rank', 'ele', 'ele_ft', 'class', 'name'],
  park: ['rank', 'class', 'name'],
  boundary: ['admin_level', 'disputed_name', 'disputed', 'maritime', 'claimed_by'],
  aeroway: ['ref', 'class'],
  transportation: ['layer', 'bicycle', 'service', 'level', 'brunnel', 'indoor', 'ramp', 'horse',
    'subclass', 'surface', 'oneway', 'foot', 'mtb_scale', 'class'],
  building: ['render_min_height', 'hide_3d', 'colour', 'render_height'],
  water_name: ['intermittent', 'class', 'name'],
  transportation_name: ['layer', 'subclass', 'indoor', 'network', 'ref', 'level', 'ref_length', 'class', 'name'],
  place: ['rank', 'capital', 'iso_a2', 'class', 'name'],
  housenumber: ['housenumber'],
  poi: ['layer', 'rank', 'subclass', 'indoor', 'level', 'class', 'agg_stop', 'name'],
  aerodrome_label: ['ele', 'iata', 'ele_ft', 'icao', 'class', 'name'],
};

const db = new DatabaseSync(DB, { readOnly: true });
const meta = {};
for (const r of db.prepare('select name, value from metadata').all()) meta[r.name] = r.value;

let fail = 0;
const ok = (c, msg) => { console.log(`   ${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fail++; };

console.log('\nmetadata');
ok(meta.format === 'pbf', `format = "${meta.format}" (must be "pbf")`);
console.log(`   info  zooms ${meta.minzoom}-${meta.maxzoom}, bounds ${meta.bounds}`);

console.log('\nschema (Schema.OMT.matches, matchOnIntersect=true)');
let layers = [];
try { layers = JSON.parse(meta.json || '{}').vector_layers || []; } catch (e) { /* ignore */ }
let miss = 0;
let intersect = 0;
for (const l of layers) {
  const known = Object.prototype.hasOwnProperty.call(OMT_FIELDS, l.id);
  const fields = Object.keys(l.fields || {});
  const shared = known ? fields.filter((f) => OMT_FIELDS[l.id].includes(f)) : [];
  if (!known) miss++; else if (shared.length) intersect++;
  console.log(`   ${known ? (shared.length ? 'OMT ' : 'omt?') : 'MISS'}  ${l.id.padEnd(21)} z${l.minzoom}-${l.maxzoom}  shared=[${shared.join(',')}]`);
}
ok(miss === 0, `layerMiss = ${miss} (must be 0, else autostyle disables extrusion)`);
ok(intersect > 0, `layerIntersect = ${intersect} (must be > 0)`);

const bldg = layers.find((l) => l.id === 'building');
console.log('\n3D buildings');
if (!bldg) {
  console.log('   n/a   no `building` layer -- basemap-only variant');
} else {
  ok(Object.prototype.hasOwnProperty.call(bldg.fields || {}, 'render_height'),
    'building.render_height present (the attribute ATAK extrudes)');
  ok(Number(bldg.maxzoom) >= 16, `building maxzoom ${bldg.maxzoom} >= 16 (style hides it below 16)`);
}

const addr = layers.find((l) => l.id === 'housenumber');
console.log('\nhousenumbers');
if (!addr) {
  console.log('   n/a   no `housenumber` layer -- built without --addresses');
} else {
  ok(Object.prototype.hasOwnProperty.call(addr.fields || {}, 'housenumber'),
    'housenumber.housenumber present (the field the bundled style renders)');
  // Stored at MAXZOOM (16), same as `building` -- the style's minzoom:18 is
  // evaluated against camera zoom, not tile zoom, so this only needs to be
  // present at the deepest STORED tile zoom, not literally z18.
  ok(Number(addr.maxzoom) >= 16, `housenumber maxzoom ${addr.maxzoom} >= 16 (stored at base maxzoom, drawn via overzoom above map zoom 18)`);
}

console.log('\ntiles');
const perZoom = db.prepare(
  'select zoom_level z, count(*) n, max(length(tile_data)) mx, sum(length(tile_data)) tot from tiles group by zoom_level order by zoom_level'
).all();
let gz = 0;
for (const r of db.prepare('select tile_data d from tiles limit 200').all()) {
  const b = Buffer.from(r.d);
  if (b[0] === 0x1f && b[1] === 0x8b) gz++;
}
let grand = 0;
for (const r of perZoom) {
  grand += Number(r.tot);
  console.log(`   z${String(r.z).padStart(2)}  ${String(r.n).padStart(8)} tiles  max ${(r.mx / 1024).toFixed(1).padStart(8)} KB  total ${(Number(r.tot) / 1e6).toFixed(1).padStart(8)} MB`);
}
console.log(`   total payload ${(grand / 1e6).toFixed(1)} MB`);
console.log(`   gzipped tiles in sample of 200: ${gz}`);

// spot-check the deepest zoom for real layer content
const deepest = perZoom.length ? perZoom[perZoom.length - 1].z : null;
if (deepest !== null) {
  const row = db.prepare(
    'select tile_column x, tile_row y, tile_data d from tiles where zoom_level=? order by length(tile_data) desc limit 1'
  ).get(deepest);
  let b = Buffer.from(row.d);
  if (b[0] === 0x1f && b[1] === 0x8b) b = require('zlib').gunzipSync(b);
  const t = new VectorTile(new PbfReader(b));
  console.log(`\nlargest z${deepest} tile (${row.x}/${row.y} tms): layers = ${Object.keys(t.layers).join(', ')}`);
  const B = t.layers.building;
  if (B) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < B.length; i++) {
      const h = B.feature(i).properties.render_height;
      if (typeof h === 'number') { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    }
    console.log(`   building: ${B.length} features, render_height ${lo}..${hi} m`);
  }
  const H = t.layers.housenumber;
  if (H) {
    const sample = [];
    for (let i = 0; i < Math.min(H.length, 5); i++) sample.push(H.feature(i).properties.housenumber);
    console.log(`   housenumber: ${H.length} features, sample = [${sample.join(', ')}]`);
  }
}

db.close();
console.log(fail === 0 ? '\nAll structural checks passed.\n' : `\n${fail} check(s) FAILED.\n`);
process.exit(fail === 0 ? 0 : 1);
