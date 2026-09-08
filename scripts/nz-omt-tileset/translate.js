#!/usr/bin/env node
/**
 * Translates LINZ topographic vector tiles (Shortbread schema) into
 * OpenMapTiles layer/field names, optionally merging in the
 * nz-building-heights PMTiles archive as an OMT `building` layer carrying
 * `render_height`.
 *
 * Emits newline-delimited GeoJSON on stdout, one feature per line, each with a
 * `tippecanoe: { layer: ... }` member so a single tippecanoe run produces all
 * layers. Progress goes to stderr. See build.sh for the full pipeline.
 *
 * WHY TRANSLATE: ATAK recognises only two vector schemas -- `GLVectorTiles`
 * holds `styleSchemas = {"omt", "rbt"}`. Every Shortbread layer name counts as a
 * miss in `Schema.OMT.matches()`, which then returns false, `autostyle` flips to
 * true, no stylesheet is loaded, and with no stylesheet there are no extrude
 * attribute keys. The result is no styling AND no 3D. Every layer emitted here
 * must therefore be one of OMT's 16 recognised names.
 *
 * Usage:
 *   node translate.js --linz <linz.mbtiles> [options] > merged.geojsonl
 *
 *   --linz PATH        LINZ topographic MBTiles (Shortbread schema)   [required]
 *   --heights PATH     nz-building-heights.pmtiles; omit to build without 3D
 *   --addresses        also emit an OMT `housenumber` layer from LINZ's
 *                      `addresses` layer (off by default -- see build.sh)
 *   --bbox W,S,E,N     area of interest        [default: all of New Zealand]
 *   --linz-zoom N      source zoom to read from LINZ        [default: 15, its maxzoom]
 *   --bldg-zoom N      source zoom to read from heights     [default: 16, its maxzoom]
 *   --only linz|heights|addresses   run just one pass  [default: both/all requested]
 *   --progress N       log every N source tiles             [default: 5000]
 *
 * build.sh drives this once per zoom level so that each output zoom is built
 * from LINZ's own generalisation for that zoom, rather than re-simplifying z15
 * detail all the way down. See build.sh for why that matters.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createRequire } = require('module');

// Dependencies live alongside this script (scripts/nz-omt-tileset/node_modules),
// but also try the working directory so the script can be run from elsewhere.
const localRequire = createRequire(path.join(__dirname, 'package.json'));
const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'));
function load(name) {
  for (const r of [localRequire, cwdRequire]) {
    try { return r(name); } catch (e) { /* try next */ }
  }
  try { return require(name); } catch (e) { /* fall through */ }
  console.error(`Cannot resolve "${name}". Run:  npm install   in ${__dirname}`);
  process.exit(1);
}

const { VectorTile } = load('@mapbox/vector-tile');
const pbfMod = load('pbf');
const PbfReader = pbfMod.PbfReader || pbfMod; // pbf v5 renamed the default export
const turf = load('@turf/turf');
const { PMTiles } = load('pmtiles');
const { DatabaseSync } = require('node:sqlite');

/* ------------------------------------------------------------------ args */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}
function flag(name) { return process.argv.includes('--' + name); }
const LINZ_DB = arg('linz');
const HEIGHTS = arg('heights', null);
const WANT_ADDRESSES = flag('addresses'); // boolean flag, takes no value
// No bbox by default: process every tile the archive holds. A lon/lat bbox
// cannot express a region spanning the antimeridian (W < E fails), and the LINZ
// archive does span it -- its z15 tile columns run 89..32719, i.e. lon -179.02
// to 179.47. A hardcoded NZ bbox silently drops the Chatham Islands, the
// subantarctic islands and the Realm territories. Processing everything avoids
// the whole class of bug.
const BBOX_ARG = arg('bbox', null);
const HAS_BBOX = BBOX_ARG !== null;
const BBOX = HAS_BBOX ? BBOX_ARG.split(',').map(Number) : [-180, -85, 180, 85];
const LINZ_Z = Number(arg('linz-zoom', 15));
const BLDG_Z = Number(arg('bldg-zoom', 16));
const PROGRESS = Number(arg('progress', 5000));
const ONLY = arg('only', 'both');

if (!LINZ_DB) {
  console.error('usage: translate.js --linz <linz.mbtiles> [--heights <heights.pmtiles>] [--bbox W,S,E,N]');
  process.exit(1);
}
if (!['both', 'linz', 'heights', 'addresses'].includes(ONLY)) {
  console.error(`--only must be one of: both, linz, heights, addresses (got "${ONLY}")`);
  process.exit(1);
}
const DO_LINZ = ONLY === 'both' || ONLY === 'linz';
const DO_HEIGHTS = (ONLY === 'both' || ONLY === 'heights') && !!HEIGHTS;
// `addresses` is its own pass (like heights), gated by an explicit --addresses
// flag rather than folded into DO_LINZ's per-zoom loop, because it must be
// read exactly once (at LINZ_Z, i.e. LINZ's own maxzoom for best positional
// detail) regardless of how many times build.sh invokes --only linz for
// different output zooms. See build.sh: like `building`, ATAK's bundled OMT
// style only draws `housenumber` above map zoom 18, evaluated against the
// camera's zoom rather than the tile pyramid's, so housenumber features must
// be STORED at the deepest tile zoom that carries the rest of the basemap
// (z16) and rely on the renderer's own overzoom scaling past z18 -- not tiled
// at a literal z17/z18, which would carry no roads or water underneath.
const DO_ADDRESSES = (ONLY === 'both' || ONLY === 'addresses') && WANT_ADDRESSES;
const [W, S, E, N] = BBOX;

const OMT_LAYERS = new Set(['water', 'waterway', 'landcover', 'landuse', 'mountain_peak', 'park',
  'boundary', 'aeroway', 'transportation', 'building', 'water_name', 'transportation_name',
  'place', 'housenumber', 'poi', 'aerodrome_label']);

/* ------------------------------------------------- Shortbread -> OMT map */
const LANDCOVER_KINDS = { forest: 'wood', scrub: 'wood', wood: 'wood', sand: 'sand', grass: 'grass' };
const LANDUSE_KINDS = {
  residential: 'residential', cemetery: 'cemetery', commercial: 'commercial',
  industrial: 'industrial', railway: 'railway', school: 'school', hospital: 'hospital',
};
// Shortbread `kind` values that are already valid OMT transportation classes
const TRANSPORT_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor',
  'service', 'track', 'path', 'rail', 'ferry', 'cable_car', 'transit']);
const WATERWAY_CLASSES = new Set(['river', 'stream', 'canal', 'ditch', 'drain']);

const translate = {
  streets(p) {
    if (!TRANSPORT_CLASSES.has(p.kind)) return null;
    const out = { class: p.kind };
    if (p.bridge === 'true' || p.bridge === true) out.brunnel = 'bridge';
    else if (p.tunnel === 'true' || p.tunnel === true) out.brunnel = 'tunnel';
    if (p.surface) out.surface = p.surface;
    return { layer: 'transportation', props: out };
  },
  ferries() {
    return { layer: 'transportation', props: { class: 'ferry' } };
  },
  street_labels(p) {
    if (!p.name) return null;
    const out = { class: TRANSPORT_CLASSES.has(p.kind) ? p.kind : 'minor', name: p.name };
    if (p.ref) out.ref = String(p.ref);
    return { layer: 'transportation_name', props: out };
  },
  water_polygons(p) {
    return { layer: 'water', props: { class: p.kind === 'ocean' ? 'ocean' : (p.kind || 'lake') } };
  },
  water_lines(p) {
    if (!WATERWAY_CLASSES.has(p.kind)) return null; // wharf / wharf_edge are not waterways
    const out = { class: p.kind };
    if (p.name) out.name = p.name;
    return { layer: 'waterway', props: out };
  },
  land(p, geomType) {
    if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') return null;
    if (LANDCOVER_KINDS[p.kind]) return { layer: 'landcover', props: { class: LANDCOVER_KINDS[p.kind], subclass: p.kind } };
    if (LANDUSE_KINDS[p.kind]) return { layer: 'landuse', props: { class: LANDUSE_KINDS[p.kind] } };
    return null; // powerline, embankment, ...
  },
  sites(p) {
    if (p.kind !== 'sports_field' && p.kind !== 'park') return null;
    return { layer: 'park', props: { class: 'public_park', name: p.name } };
  },
  // `place_labels` mixes three unrelated concepts under one Shortbread layer:
  // administrative/settlement places (`place`), sea/bay features (`water`), and
  // summits (`natural=peak`). Each needs a different OMT destination -- or none.
  //
  // IMPORTANT: do not fall through to `class: p.place || 'suburb'` for rows that
  // have no `p.place` (i.e. the water/natural rows). That was the previous
  // behaviour here and it is a real bug, not just a missed opportunity: every
  // bay and mountain-peak label in the country was being mislabelled as an OMT
  // `place` with `class=suburb`.
  place_labels(p) {
    if (p.place && p.label) {
      const rank = p.admin_level ? Number(p.admin_level) : 10;
      return { layer: 'place', props: { class: p.place, name: p.label, rank } };
    }
    if (p.water && p.label) {
      // renders via water-name-ocean / water-name-other in every bundled style
      // variant. LINZ's water values (bay, sea, seachannel, ...) aren't OMT's
      // `ocean`, so anything other than the literal ocean class falls to
      // water-name-other, which is exactly what we want for bays etc.
      return { layer: 'water_name', props: { class: p.water === 'sea' ? 'ocean' : p.water, name: p.label } };
    }
    // p.natural === 'peak' falls through to here and is dropped deliberately:
    // none of the three bundled OMT style variants (bright/dark/overlay) carry
    // ANY paint rule for the `mountain_peak` source-layer -- it is not merely
    // hidden, it is absent from the layers array entirely. Populating it would
    // be silently invisible, so there's no OMT layer worth routing peaks to.
    return null;
  },
  pois(p) {
    const cls = p.building || p.amenity || p.historic || p.man_made;
    if (!cls || !p.name) return null;
    return { layer: 'poi', props: { class: cls, name: p.name, rank: 1 } };
  },
  // NOTE: `addresses` is deliberately NOT a key in this table. This table is
  // invoked once per output zoom (build.sh calls --only linz separately for
  // each of z0..z16), so a normal entry here would re-emit all 2.59M national
  // address points 17 times, once into every base-zNN.mbtiles. Housenumbers
  // are read and emitted exactly once, in their own pass below -- see
  // DO_ADDRESSES and the "Pass 3" section.
  // Runway/taxiway footprints. Confirmed rendering: `aeroway-area` (fill) and
  // `aeroway-runway`/`aeroway-taxiway` (line) all filter on
  // `class in [runway, taxiway]` from minzoom 4 in every bundled style variant.
  // `kind=aerodrome` (the airfield boundary polygon, not a runway) has no
  // matching OMT aeroway paint rule -- see public_transport() below for how
  // aerodromes are actually surfaced.
  street_polygons(p) {
    if (p.kind === 'runway' || p.kind === 'taxiway') {
      return { layer: 'aeroway', props: { class: p.kind } };
    }
    if (TRANSPORT_CLASSES.has(p.kind)) return { layer: 'transportation', props: { class: p.kind } };
    return { layer: 'transportation', props: { class: 'service' } };
  },
  // Aerodrome/helipad points, surfaced as `poi` rather than `aerodrome_label`:
  // OMT's `aerodrome_label` layer requires `has iata` in every bundled style
  // (airport-label-major), and LINZ carries no IATA codes, so anything routed
  // there would parse fine and render nothing. `poi` with class=airfield /
  // class=heliport has real icons in the bundled sprite sheet (airfield_11/15,
  // heliport_11/15) and actually draws.
  public_transport(p) {
    if (!p.name) return null;
    if (p.kind === 'aerodrome') return { layer: 'poi', props: { class: 'airfield', name: p.name, rank: 1 } };
    if (p.kind === 'helipad') return { layer: 'poi', props: { class: 'heliport', name: p.name, rank: 1 } };
    return null; // `station` is ambiguous (rail/bus) and already covered via other layers
  },
};

// Layers with no OMT home, or handled but with some values still dropped (see
// the per-layer functions above for the partial cases). `boundaries` is
// consumed to derive `water`.
const DROP_REASON = {
  addresses: 'opt-in via --addresses (adds ~60MB uncompressed nationally); off by default',
  parcel_boundaries: 'cadastral, no OMT equivalent',
  contours: 'no OMT contour layer exists; ATAK could not style it even if carried',
  pier_lines: 'no OMT equivalent',
  aerialways: 'no OMT equivalent (cable cars/ski tows, not airport aeroways)',
  dam_lines: 'no OMT equivalent',
  buildings: 'replaced by nz-building-heights footprints carrying render_height',
};

/* ------------------------------------------------------------- emit */
const counts = {};
const dropped = {};
let pending = [];
function emit(layer, geometry, props) {
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  pending.push(JSON.stringify({ type: 'Feature', properties: clean, geometry, tippecanoe: { layer } }));
  counts[layer] = (counts[layer] || 0) + 1;
  if (pending.length >= 2000) flush();
}
function flush() {
  if (!pending.length) return;
  fs.writeSync(1, pending.join('\n') + '\n');
  pending = [];
}

function tileRangeFor(z, w, s, e, n_) {
  const n = 2 ** z;
  const idx = (lon, lat) => {
    const r = lat * Math.PI / 180;
    return [Math.floor((lon + 180) / 360 * n),
      Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
  };
  const [x0, y0] = idx(w, n_);
  const [x1, y1] = idx(e, s);
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}
function tileRange(z) { return tileRangeFor(z, W, S, E, N); }

/** WGS84 bounds of an XYZ tile. */
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lon = (i) => i / n * 360 - 180;
  const lat = (j) => {
    const t = Math.PI - 2 * Math.PI * j / n;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/* ==================================================================
 * Pass 1 -- LINZ basemap
 * ================================================================== */
let linzTiles = 0;
let waterTiles = 0;
let waterFailed = 0;
const t0 = Date.now();

const db = DO_LINZ ? new DatabaseSync(LINZ_DB, { readOnly: true }) : null;
let total = 0;
let rows = [];
if (DO_LINZ) {
  if (HAS_BBOX) {
    const r = tileRange(LINZ_Z);
    const yTmsMin = 2 ** LINZ_Z - 1 - r.y1;
    const yTmsMax = 2 ** LINZ_Z - 1 - r.y0;
    total = db.prepare(
      `select count(*) c from tiles where zoom_level=? and tile_column between ? and ? and tile_row between ? and ?`
    ).get(LINZ_Z, r.x0, r.x1, yTmsMin, yTmsMax).c;
    console.error(`LINZ z${LINZ_Z}: x ${r.x0}..${r.x1}  y ${r.y0}..${r.y1}  -> ${total} tiles in bbox`);
    rows = db.prepare(
      `select tile_column x, tile_row y, tile_data d from tiles
        where zoom_level=? and tile_column between ? and ? and tile_row between ? and ?`
    ).iterate(LINZ_Z, r.x0, r.x1, yTmsMin, yTmsMax);
  } else {
    total = db.prepare('select count(*) c from tiles where zoom_level=?').get(LINZ_Z).c;
    console.error(`LINZ z${LINZ_Z}: whole archive -> ${total} tiles`);
    rows = db.prepare(
      'select tile_column x, tile_row y, tile_data d from tiles where zoom_level=?'
    ).iterate(LINZ_Z);
  }
} else {
  console.error('LINZ pass: skipped (--only heights)');
}

for (const row of rows) {
  const x = row.x;
  const yXyz = 2 ** LINZ_Z - 1 - row.y;
  let buf = Buffer.from(row.d);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);

  let tile;
  try { tile = new VectorTile(new PbfReader(buf)); } catch (e) { continue; }
  linzTiles++;

  const landmass = [];
  for (const name of Object.keys(tile.layers)) {
    const L = tile.layers[name];

    // LINZ ships the landmass as a polygon and leaves the sea as empty space.
    // OMT is the inverse: the style background is land and `water` polygons are
    // drawn over it. So collect the landmass and subtract it from the tile below.
    if (name === 'boundaries') {
      for (let i = 0; i < L.length; i++) {
        const gj = L.feature(i).toGeoJSON(x, yXyz, LINZ_Z);
        if (gj.geometry.type === 'Polygon' || gj.geometry.type === 'MultiPolygon') landmass.push(gj);
      }
      dropped[name] = (dropped[name] || 0) + L.length;
      continue;
    }

    const fn = translate[name];
    if (!fn) { dropped[name] = (dropped[name] || 0) + L.length; continue; }
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      let gj;
      try { gj = f.toGeoJSON(x, yXyz, LINZ_Z); } catch (e) { continue; }
      const r = fn(gj.properties || {}, gj.geometry.type);
      if (!r) { dropped[name] = (dropped[name] || 0) + 1; continue; }
      emit(r.layer, gj.geometry, r.props);
    }
  }

  // derive `water` for this tile = tile extent minus landmass
  if (landmass.length) {
    try {
      let land = landmass[0];
      for (let i = 1; i < landmass.length; i++) {
        const u = turf.union(turf.featureCollection([land, landmass[i]]));
        if (u) land = u;
      }
      const water = turf.difference(turf.featureCollection([turf.bboxPolygon(tileBounds(LINZ_Z, x, yXyz)), land]));
      if (water) { emit('water', water.geometry, { class: 'ocean' }); waterTiles++; }
    } catch (e) {
      waterFailed++;
    }
  }

  if (linzTiles % PROGRESS === 0) {
    const pct = (linzTiles / total * 100).toFixed(1);
    const rate = linzTiles / ((Date.now() - t0) / 1000);
    const eta = ((total - linzTiles) / rate / 60).toFixed(1);
    console.error(`  ${linzTiles}/${total} tiles (${pct}%)  ${rate.toFixed(0)} tiles/s  ETA ${eta} min`);
  }
}
if (db) db.close();
flush();
if (DO_LINZ) {
  console.error(`LINZ done: ${linzTiles} tiles, water derived for ${waterTiles}${waterFailed ? `, ${waterFailed} water failures` : ''}`);
}

/* ==================================================================
 * Pass 1b -- addresses -> housenumber (opt-in, own pass, own DB handle)
 *
 * Read separately from the main per-zoom loop above rather than as an entry in
 * `translate`, because build.sh invokes --only linz once per output zoom
 * (z0..z16); folding addresses into that table would re-emit all national
 * address points into every one of those 17 invocations. This runs exactly
 * once regardless of --only, at LINZ's own source maxzoom for best positional
 * accuracy; build.sh then tiles the result at z16 only, same reasoning as
 * `building` -- see the DO_ADDRESSES comment above.
 * ================================================================== */
let addrFeatures = 0;
let addrNoNumber = 0;
if (DO_ADDRESSES) {
  const adb = new DatabaseSync(LINZ_DB, { readOnly: true });
  const addrZ = LINZ_Z; // read at LINZ's own source zoom (default: archive maxzoom) for best positional accuracy
  let addrTotal;
  let addrRows;
  if (HAS_BBOX) {
    const r = tileRange(addrZ);
    const yTmsMin = 2 ** addrZ - 1 - r.y1;
    const yTmsMax = 2 ** addrZ - 1 - r.y0;
    addrTotal = adb.prepare(
      `select count(*) c from tiles where zoom_level=? and tile_column between ? and ? and tile_row between ? and ?`
    ).get(addrZ, r.x0, r.x1, yTmsMin, yTmsMax).c;
    addrRows = adb.prepare(
      `select tile_column x, tile_row y, tile_data d from tiles
        where zoom_level=? and tile_column between ? and ? and tile_row between ? and ?`
    ).iterate(addrZ, r.x0, r.x1, yTmsMin, yTmsMax);
  } else {
    addrTotal = adb.prepare('select count(*) c from tiles where zoom_level=?').get(addrZ).c;
    addrRows = adb.prepare('select tile_column x, tile_row y, tile_data d from tiles where zoom_level=?').iterate(addrZ);
  }
  console.error(`\naddresses z${addrZ}: ${addrTotal} tiles`);
  let addrTiles = 0;
  for (const row of addrRows) {
    const yXyz = 2 ** addrZ - 1 - row.y;
    let buf = Buffer.from(row.d);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    let tile;
    try { tile = new VectorTile(new PbfReader(buf)); } catch (e) { continue; }
    addrTiles++;
    const L = tile.layers.addresses;
    if (!L) continue;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i);
      const hn = f.properties.housenumber;
      if (hn == null) { addrNoNumber++; continue; }
      let gj;
      try { gj = f.toGeoJSON(row.x, yXyz, addrZ); } catch (e) { continue; }
      emit('housenumber', gj.geometry, { housenumber: String(hn) });
      addrFeatures++;
    }
    if (addrTiles % PROGRESS === 0) console.error(`  ${addrTiles}/${addrTotal} tiles, ${addrFeatures} addresses so far`);
  }
  adb.close();
  flush();
  console.error(`addresses done: ${addrFeatures} housenumbers${addrNoNumber ? `, ${addrNoNumber} features without a housenumber` : ''}`);
} else if (ONLY === 'both' && !WANT_ADDRESSES) {
  console.error('\naddresses: skipped (pass --addresses to include the housenumber layer)');
}

/* ==================================================================
 * Pass 2 -- building heights (optional)
 * ================================================================== */
class NodeFileSource {
  constructor(p) { this.p = p; this.fd = fs.openSync(p, 'r'); }
  getKey() { return this.p; }
  async getBytes(offset, length) {
    const b = Buffer.allocUnsafe(length);
    fs.readSync(this.fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
}

(async () => {
  let bldgTiles = 0;
  let bldgNoHeight = 0;
  if (DO_HEIGHTS) {
    const pm = new PMTiles(new NodeFileSource(HEIGHTS));
    const hdr = await pm.getHeader(); // also primes the directory cache
    // Without an explicit bbox, scan exactly what the heights archive covers
    // rather than a guessed national box. This is both correct and much cheaper:
    // the archive spans only lon 167.4..178.5, lat -46.9..-34.4.
    let rb;
    if (HAS_BBOX) {
      rb = tileRange(BLDG_Z);
    } else {
      console.error(`heights archive bounds: lon ${hdr.minLon.toFixed(3)}..${hdr.maxLon.toFixed(3)}  lat ${hdr.minLat.toFixed(3)}..${hdr.maxLat.toFixed(3)}`);
      rb = tileRangeFor(BLDG_Z, hdr.minLon, hdr.minLat, hdr.maxLon, hdr.maxLat);
    }
    const cols = rb.x1 - rb.x0 + 1;
    const rowsN = rb.y1 - rb.y0 + 1;
    console.error(`heights z${BLDG_Z}: x ${rb.x0}..${rb.x1}  y ${rb.y0}..${rb.y1}  -> ${cols * rowsN} lookups`);
    const t1 = Date.now();
    let looked = 0;
    for (let x = rb.x0; x <= rb.x1; x++) {
      for (let y = rb.y0; y <= rb.y1; y++) {
        looked++;
        let res;
        try { res = await pm.getZxy(BLDG_Z, x, y); } catch (e) { continue; }
        if (!res || !res.data || !res.data.byteLength) continue;
        // the pmtiles library decompresses according to the archive header
        let buf = Buffer.from(res.data);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        let src;
        try { src = new VectorTile(new PbfReader(buf)).layers['buildings']; } catch (e) { continue; }
        if (!src) continue;
        bldgTiles++;
        for (let i = 0; i < src.length; i++) {
          let gj;
          try { gj = src.feature(i).toGeoJSON(x, y, BLDG_Z); } catch (e) { continue; }
          const p = gj.properties || {};
          const h = p.height_m ?? p.height_max_m ?? p.roof_p90;
          if (h == null) { bldgNoHeight++; continue; }
          // Only these two attributes. Extras widen the schema ATAK's matcher
          // inspects, and render_height is the sole field it extrudes from.
          emit('building', gj.geometry, {
            render_height: Math.round(Number(h) * 10) / 10,
            render_min_height: 0,
          });
        }
        if (bldgTiles && bldgTiles % PROGRESS === 0) {
          const rate = looked / ((Date.now() - t1) / 1000);
          const eta = ((cols * rowsN - looked) / rate / 60).toFixed(1);
          console.error(`  ${looked}/${cols * rowsN} lookups, ${bldgTiles} tiles with buildings, ETA ${eta} min`);
        }
      }
    }
    flush();
    console.error(`heights done: ${bldgTiles} tiles with buildings${bldgNoHeight ? `, ${bldgNoHeight} features without height` : ''}`);
  } else if (ONLY === 'linz') {
    console.error('\nheights pass: skipped (--only linz)');
  } else {
    console.error('\nheights: skipped (no --heights given) -- building layer will be absent');
  }

  /* ------------------------------------------------------------ report */
  flush();
  console.error('\n--- emitted OMT layers ---');
  let sum = 0;
  for (const k of Object.keys(counts).sort()) {
    sum += counts[k];
    console.error(`  ${OMT_LAYERS.has(k) ? 'OMT ' : '!!!!'} ${k.padEnd(22)} ${counts[k]}`);
  }
  console.error(`  total features: ${sum}`);
  const bad = Object.keys(counts).filter((k) => !OMT_LAYERS.has(k));
  console.error(`  non-OMT layer names: ${bad.length ? bad.join(', ') + '  <-- WILL BREAK SCHEMA MATCH' : 'none (layerMiss will be 0)'}`);
  console.error('\n--- dropped source layers ---');
  for (const k of Object.keys(dropped).sort()) {
    console.error(`  ${k.padEnd(22)} ${String(dropped[k]).padStart(9)}   ${DROP_REASON[k] || 'unmapped kind/values'}`);
  }
  console.error(`\nelapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
})();
