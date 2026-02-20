#!/usr/bin/env node
import fs from 'fs/promises';

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

async function main() {
  console.log('📥 Reading Alpine Energy boundary...');
  const geojson = JSON.parse(await fs.readFile('../data/nz-network-boundaries.geojson', 'utf8'));
  const alpine = geojson.features.find(f => f.properties.Region.includes('Alpine'));
  const boundary = alpine.geometry.coordinates[0];
  
  console.log('📥 Reading NZ Gazetteer...');
  const csv = await fs.readFile('../data/gaz_csv.csv', 'utf8');
  const lines = csv.split('\n');
  const header = lines[0].replace(/^\uFEFF/, '');
  
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
    
    if (name && !isNaN(lat) && !isNaN(lng) && settlementTypes.includes(featType) && isPointInPolygon([lng, lat], boundary)) {
      localities[name] = { lat, lng };
    }
  }
  
  console.log(`✅ Found ${Object.keys(localities).length} localities`);
  
  const entries = Object.entries(localities)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, {lat, lng}]) => 
      `  '${name.replace(/'/g, "\\'")}': { lat: ${lat.toFixed(4)}, lng: ${lng.toFixed(4)} }`
    );
  
  const content = `// Alpine Energy localities from NZ Gazetteer
// Generated: ${new Date().toISOString()}

export const ALPINE_LOCALITIES = {
${entries.join(',\n')}
};

export function getCoordinates(locality) {
  const info = ALPINE_LOCALITIES[locality];
  if (info) return { latitude: info.lat, longitude: info.lng };
  console.warn(\`Unknown locality: \${locality}\`);
  return { latitude: -44.3904, longitude: 171.2373 }; // Timaru
}
`;
  
  await fs.writeFile('../scrapers/alpine-localities.js', content);
  console.log(`✅ Generated alpine-localities.js with ${Object.keys(localities).length} localities`);
}

main();
