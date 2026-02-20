#!/usr/bin/env node
import fs from 'fs/promises';

async function getTLCBoundary() {
  console.log('📥 Reading TLC boundary from GeoJSON...');
  const geojson = JSON.parse(await fs.readFile('../data/nz-network-boundaries.geojson', 'utf8'));
  const tlc = geojson.features.find(f => f.properties.Region.includes('Lines Company'));
  if (!tlc) throw new Error('TLC not found');
  const boundary = tlc.geometry.coordinates[0];
  console.log(`✅ Extracted TLC boundary: ${boundary.length} points`);
  return boundary;
}

function isPointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointNearPolygon(point, polygon, bufferDegrees = 0.05) {
  // Check if point is inside polygon
  if (isPointInPolygon(point, polygon)) return true;
  
  // Check if point is within buffer distance of polygon (for edge cases)
  const [x, y] = point;
  for (const [px, py] of polygon) {
    const distance = Math.sqrt(Math.pow(x - px, 2) + Math.pow(y - py, 2));
    if (distance <= bufferDegrees) return true;
  }
  return false;
}



async function getLocalitiesFromLINZ(boundary) {
  console.log('📥 Reading LINZ Gazetteer...');
  const csv = await fs.readFile('../data/gaz_csv.csv', 'utf8');
  const lines = csv.split('\n');
  const header = lines[0].replace(/^\uFEFF/, '');
  
  // Parse CSV properly handling quoted fields
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }
  
  const headers = parseCSVLine(header);
  const nameIdx = headers.indexOf('name');
  const latIdx = headers.indexOf('crd_latitude');
  const lngIdx = headers.indexOf('crd_longitude');
  const featTypeIdx = headers.indexOf('feat_type');
  const settlementTypes = ['Town', 'Locality', 'Populated Place', 'Settlement', 'Village', 'Suburb'];
  
  const localities = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    if (cols.length < Math.max(nameIdx, latIdx, lngIdx, featTypeIdx)) continue;
    
    const name = cols[nameIdx]?.trim();
    const lat = parseFloat(cols[latIdx]);
    const lng = parseFloat(cols[lngIdx]);
    const featType = cols[featTypeIdx]?.trim();
    
    if (name && !isNaN(lat) && !isNaN(lng) && settlementTypes.includes(featType) && isPointNearPolygon([lng, lat], boundary)) {
      localities[name] = { lat, lng };
    }
  }
  
  console.log(`✅ Found ${Object.keys(localities).length} localities from LINZ`);
  return localities;
}

async function getLocalitiesInBoundary(boundary) {
  return await getLocalitiesFromLINZ(boundary);
}

function getNZRegion(lat, lng) {
  if (lat > -38.8 && lng > 175.5) return 'Waikato';
  if (lat < -39.0 && lng < 175.5) return 'Manawatu-Whanganui';
  if (lat > -38.8) return 'Waikato';
  return 'Manawatu-Whanganui';
}

async function generateLocalitiesFile(localities) {
  console.log('📝 Generating tlc-localities.js...');
  
  const entries = Object.entries(localities)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, {lat, lng}]) => {
      const region = getNZRegion(lat, lng);
      return `  '${name}': { lat: ${lat.toFixed(4)}, lng: ${lng.toFixed(4)}, region: '${region}' }`;
    });
  
  const fileContent = `// The Lines Company locality coordinates and region mapping
// Auto-generated from ENA network boundaries + OpenStreetMap data
// Generated: ${new Date().toISOString()}
// Source: https://www.ena.org.nz/assets/Maps/networkboundaries-2.kml
// OSM Query: Overpass API for places within TLC boundary
// Total localities: ${Object.keys(localities).length}
// Sources: OpenStreetMap Overpass API + LINZ Gazetteer

export const TLC_LOCALITIES = {
${entries.join(',\n')}
};

// Default coordinates (Taumarunui - TLC headquarters area)
const DEFAULT_COORDS = { latitude: -38.8833, longitude: 175.2667 };
const DEFAULT_REGION = 'Central North Island';

export function getLocalityInfo(locality) {
  return TLC_LOCALITIES[locality] || null;
}

export function getCoordinates(locality) {
  // Try exact match first
  let info = TLC_LOCALITIES[locality];
  
  // If not found, try case-insensitive and macron-insensitive match
  if (!info) {
    const normalizedLocality = locality.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
    const match = Object.keys(TLC_LOCALITIES).find(key => {
      const normalizedKey = key.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
      return normalizedKey === normalizedLocality;
    });
    if (match) {
      info = TLC_LOCALITIES[match];
    }
  }
  
  if (info) {
    return { latitude: info.lat, longitude: info.lng };
  }
  console.warn(\`Unknown TLC locality: \${locality}, using default coordinates\`);
  return DEFAULT_COORDS;
}

export function getRegion(locality) {
  // Try exact match first
  let info = TLC_LOCALITIES[locality];
  
  // If not found, try case-insensitive and macron-insensitive match
  if (!info) {
    const normalizedLocality = locality.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
    const match = Object.keys(TLC_LOCALITIES).find(key => {
      const normalizedKey = key.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
      return normalizedKey === normalizedLocality;
    });
    if (match) {
      info = TLC_LOCALITIES[match];
    }
  }
  
  return info ? info.region : DEFAULT_REGION;
}

export function getAllLocalities() {
  return Object.keys(TLC_LOCALITIES);
}
`;
  
  await fs.writeFile('../scrapers/tlc-localities.js', fileContent);
  console.log(`✅ Generated tlc-localities.js with ${Object.keys(localities).length} localities`);
}

async function main() {
  try {
    const boundary = await getTLCBoundary();
    const localities = await getLocalitiesInBoundary(boundary);
    await generateLocalitiesFile(localities);
    console.log('\n✨ Complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
