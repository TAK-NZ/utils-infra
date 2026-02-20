import fetch from 'node-fetch';
import { getCoordinates, getRegion, getAllLocalities } from './tlc-localities.js';
import { getRegionCode } from './regions.js';

const TLC_API_BASE = 'https://ifstlc.tvd.co.nz/api/FaultsAPI/GetFaults';
const SITE_ID = '121';

function parseDateTime(dateStr) {
  if (!dateStr) return null;
  // Parse "Friday, February 20, 2026 at 08:30" format
  const match = dateStr.match(/(\w+), (\w+) (\d+), (\d+) at (\d+):(\d+)/);
  if (!match) return null;
  
  const [, , month, day, year, hour, minute] = match;
  const months = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
                   July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
  
  const date = new Date(year, months[month], day, hour, minute);
  return date.toISOString();
}

function extractCustomerCount(text) {
  if (!text) return 0;
  const match = text.match(/(\d+)\s+customers?/i);
  return match ? parseInt(match[1]) : 0;
}

async function fetchOutagesForLocality(locality, faultType) {
  const url = `${TLC_API_BASE}?locality=${encodeURIComponent(locality)}&faultType=${faultType}&site_id=${SITE_ID}`;
  const response = await fetch(url);
  return await response.json();
}

export async function scrapeTLC() {
  const localities = getAllLocalities();
  const outages = [];
  const seenIds = new Set();

  // Query a sample of localities for both current and planned outages
  // TLC API requires locality parameter, so we check key localities
  const sampleLocalities = ['Taumarunui', 'Turangi', 'Mangakino', 'Ohakune', 'National Park', 
                            'Matapara', 'Panetapu', 'Waihaha', 'Waipa Valley', 'Wharepapa South'];
  
  for (const locality of sampleLocalities) {
    for (const faultType of ['false', 'true']) {
      try {
        const data = await fetchOutagesForLocality(locality, faultType);
        
        for (const fault of data.FaultList || []) {
          if (seenIds.has(fault.OutagesID)) continue;
          seenIds.add(fault.OutagesID);

          const faultLocality = fault.Locality;
          const coords = getCoordinates(faultLocality);
          const region = getRegion(faultLocality);
          
          outages.push({
            outageId: `TLC-${fault.OutagesID}`,
            utility: { name: 'The Lines Company', id: 'TLC_NZ' },
            region,
            regionCode: getRegionCode(region),
            outageStart: parseDateTime(fault.ReportedAt),
            estimatedRestoration: parseDateTime(fault.EstimatedRestoration),
            cause: fault.CausedBy || 'Unknown',
            status: 'active',
            outageType: fault.FaultType ? 'planned' : 'unplanned',
            customersAffected: extractCustomerCount(fault.AdditionalContent),
            location: {
              coordinates: coords,
              areas: [faultLocality]
            },
            metadata: {
              feeder: fault.FeederAffected,
              description: fault.AdditionalContent,
              region: fault.Region
            }
          });
        }
      } catch (err) {
        // Continue on error for individual localities
      }
    }
  }

  return {
    utility: { name: 'The Lines Company', id: 'TLC_NZ' },
    region: 'Central North Island, New Zealand',
    outages
  };
}
