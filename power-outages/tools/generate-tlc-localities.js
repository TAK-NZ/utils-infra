#!/usr/bin/env node
import fetch from 'node-fetch';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import fs from 'fs/promises';

const parseXML = promisify(parseString);

async function getTLCBoundary() {
  console.log('📥 Fetching ENA network boundaries KML...');
  const response = await fetch('https://www.ena.org.nz/assets/Maps/networkboundaries-2.kml');
  const kmlText = await response.text();
  
  console.log('🔍 Parsing KML and extracting TLC boundary...');
  const parsed = await parseXML(kmlText);
  
  const placemark = parsed.kml.Document[0].Placemark.find(
    p => p.name[0] === 'The Lines Company'
  );
  
  if (!placemark) throw new Error('TLC not found in KML');
  
  const coordsText = placemark.Polygon[0].outerBoundaryIs[0].LinearRing[0].coordinates[0].trim();
  const coordinates = coordsText.split(/\s+/).map(coord => {
    const [lng, lat] = coord.split(',').map(Number);
    return [lng, lat];
  });
  
  console.log(`✅ Extracted TLC boundary: ${coordinates.length} points`);
  return coordinates;
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

async function getLocalitiesFromOSM(boundary) {
  console.log('🌍 Querying OpenStreetMap for localities...');
  
  const polyString = boundary.map(([lng, lat]) => `${lat} ${lng}`).join(' ');
  
  const query = `[out:json][timeout:60];
(
  node["place"~"city|town|village|suburb|hamlet|locality"]["name"](poly:"${polyString}");
  way["place"~"city|town|village|suburb|hamlet|locality"]["name"](poly:"${polyString}");
  relation["place"~"city|town|village|suburb|hamlet|locality"]["name"](poly:"${polyString}");
);
out center;`;
  
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' }
  });
  
  const data = await response.json();
  
  const localities = {};
  for (const element of data.elements) {
    const name = element.tags.name;
    const lat = element.lat || element.center?.lat;
    const lon = element.lon || element.center?.lon;
    
    if (name && lat && lon) {
      localities[name] = { lat, lng: lon };
    }
  }
  
  console.log(`✅ Found ${Object.keys(localities).length} localities from OSM`);
  return localities;
}

async function getLocalitiesFromLINZ(boundary, apiKey) {
  if (!apiKey) {
    console.log('ℹ️  Skipping LINZ query...');
    return {};
  }
  
  console.log('🏛️  Downloading LINZ Gazetteer CSV...');
  
  try {
    const response = await fetch('https://gazetteer.linz.govt.nz/gaz.csv');
    if (!response.ok) {
      console.log(`⚠️  LINZ CSV download failed: ${response.status}, skipping...`);
      return {};
    }
    
    const csvText = await response.text();
    const lines = csvText.split('\n');
    
    // Parse header (remove BOM if present)
    const header = lines[0].replace(/^\uFEFF/, '');
    const headers = header.split(',');
    
    // Find column indices
    const nameIdx = headers.indexOf('name');
    const latIdx = headers.indexOf('crd_latitude');
    const lngIdx = headers.indexOf('crd_longitude');
    const featTypeIdx = headers.indexOf('feat_type');
    
    const localities = {};
    let checkedCount = 0;
    
    // Feature types that represent settlements
    const settlementTypes = ['Town', 'Locality', 'Populated Place', 'Settlement', 'Village', 'Suburb'];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const cols = line.split(',');
      if (cols.length < Math.max(nameIdx, latIdx, lngIdx, featTypeIdx)) continue;
      
      const name = cols[nameIdx]?.trim();
      const lat = parseFloat(cols[latIdx]);
      const lng = parseFloat(cols[lngIdx]);
      const featType = cols[featTypeIdx]?.trim();
      
      // Only include settlements
      if (name && !isNaN(lat) && !isNaN(lng) && settlementTypes.includes(featType)) {
        checkedCount++;
        // Check if point is within or near TLC boundary (with buffer for edge cases)
        if (isPointNearPolygon([lng, lat], boundary)) {
          localities[name] = { lat, lng };
        }
      }
    }
    
    console.log(`✅ Found ${Object.keys(localities).length} localities from LINZ (checked ${checkedCount} settlements)`);
    return localities;
  } catch (error) {
    console.log(`⚠️  LINZ query failed: ${error.message}, skipping...`);
    return {};
  }
}

async function getLocalitiesInBoundary(boundary, linzApiKey) {
  const [osmLocalities, linzLocalities] = await Promise.all([
    getLocalitiesFromOSM(boundary),
    getLocalitiesFromLINZ(boundary, linzApiKey)
  ]);
  
  // Merge, preferring LINZ data (more authoritative)
  const merged = { ...osmLocalities, ...linzLocalities };
  
  console.log(`📊 Total unique localities: ${Object.keys(merged).length}`);
  return merged;
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
  
  await fs.writeFile('scrapers/tlc-localities.js', fileContent);
  console.log(`✅ Generated tlc-localities.js with ${Object.keys(localities).length} localities`);
}

async function main() {
  try {
    // LINZ CSV is public, no API key needed
    const useLINZ = process.argv[2] !== '--osm-only';
    
    if (!useLINZ) {
      console.log('ℹ️  Using OpenStreetMap data only (--osm-only flag set)\n');
    }
    
    const boundary = await getTLCBoundary();
    const localities = await getLocalitiesInBoundary(boundary, useLINZ ? 'enabled' : null);
    await generateLocalitiesFile(localities);
    
    console.log('\n✨ Complete! TLC localities mapping generated.');
    console.log(`📍 Total localities mapped: ${Object.keys(localities).length}`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
