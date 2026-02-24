import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let icpCache = null;
let lastLoadTime = 0;
const CACHE_DURATION = 3600000; // 1 hour

export function getICPData() {
  const now = Date.now();
  if (icpCache && (now - lastLoadTime) < CACHE_DURATION) {
    return icpCache;
  }

  const csvPath = path.join(__dirname, 'data', 'MarketShareByMEPandTrader.csv');
  
  if (!fs.existsSync(csvPath)) {
    console.warn('ICP data file not found:', csvPath);
    return {};
  }

  const csvData = fs.readFileSync(csvPath, 'utf-8');
  
  const regionTotals = {};
  const lines = csvData.split('\n').slice(1);
  
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    
    const region = parts[1];
    const icpTotal = parseInt(parts[4]) || 0;
    
    if (region) {
      regionTotals[region] = (regionTotals[region] || 0) + icpTotal;
    }
  }

  icpCache = regionTotals;
  lastLoadTime = now;
  return regionTotals;
}
