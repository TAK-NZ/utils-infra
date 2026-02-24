import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let geojsonData = null;

function loadGeoJSON() {
  if (!geojsonData) {
    const geojsonPath = path.join(__dirname, 'data', 'nz-network-boundaries.geojson');
    geojsonData = JSON.parse(fs.readFileSync(geojsonPath, 'utf-8'));
  }
  return geojsonData;
}

function pointInPolygon(point, polygon) {
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

function pointInMultiPolygon(point, multiPolygon) {
  for (const polygon of multiPolygon) {
    if (pointInPolygon(point, polygon[0])) {
      return true;
    }
  }
  return false;
}

export function getRegionFromCoordinates(longitude, latitude) {
  const data = loadGeoJSON();
  const point = [longitude, latitude];
  
  for (const feature of data.features) {
    if (feature.geometry.type === 'MultiPolygon') {
      if (pointInMultiPolygon(point, feature.geometry.coordinates)) {
        return feature.properties.Region;
      }
    } else if (feature.geometry.type === 'Polygon') {
      if (pointInPolygon(point, feature.geometry.coordinates[0])) {
        return feature.properties.Region;
      }
    }
  }
  
  return null;
}
