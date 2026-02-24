import fetch from 'node-fetch';
import proj4 from 'proj4';
import { getRegionCode } from './regions.js';
import { getRegionFromCoordinates } from '../region-mapper.js';

// PowerCo region mapping (town -> official CSV region)
const TOWN_TO_REGION = {
  // Tauranga (Powerco) - Region ID 10
  'Tauranga': 'Tauranga (Powerco)',
  'Mount Maunganui': 'Tauranga (Powerco)',
  'Pauanui': 'Thames Valley (Powerco)',
  'Whangamata': 'Thames Valley (Powerco)',
  'Waihi': 'Thames Valley (Powerco)',
  'Katikati': 'Tauranga (Powerco)',
  'Te Puke': 'Tauranga (Powerco)',
  
  // Taranaki (Powerco) - Region ID 19
  'New Plymouth': 'Taranaki (Powerco)',
  'Stratford': 'Taranaki (Powerco)',
  'Hawera': 'Taranaki (Powerco)',
  'Opunake': 'Taranaki (Powerco)',
  'Waitara': 'Taranaki (Powerco)',
  'Inglewood': 'Taranaki (Powerco)',
  'Eltham': 'Taranaki (Powerco)',
  'Patea': 'Taranaki (Powerco)',
  
  // Manawatu (Powerco) - Region ID 21 / Wanganui (Powerco) - Region ID 20
  'Palmerston North': 'Manawatu (Powerco)',
  'Whanganui': 'Wanganui (Powerco)',
  'Feilding': 'Manawatu (Powerco)',
  'Levin': 'Manawatu (Powerco)',
  'Bulls': 'Manawatu (Powerco)',
  'Marton': 'Wanganui (Powerco)',
  'Taihape': 'Wanganui (Powerco)',
  'Dannevirke': 'Manawatu (Powerco)',
  'Woodville': 'Manawatu (Powerco)',
  'Ohakune': 'Wanganui (Powerco)',
  'Raetihi': 'Wanganui (Powerco)',
  'Waiouru': 'Wanganui (Powerco)',
  'Mangaweka': 'Wanganui (Powerco)',
  
  // Wairarapa (Powerco) - Region ID 18
  'Masterton': 'Wairarapa (Powerco)',
  'Carterton': 'Wairarapa (Powerco)',
  'Greytown': 'Wairarapa (Powerco)',
  'Featherston': 'Wairarapa (Powerco)',
  'Martinborough': 'Wairarapa (Powerco)',
  'Eketahuna': 'Wairarapa (Powerco)'
};

function getRegion(town) {
  return TOWN_TO_REGION[town] || 'Manawatu (Powerco)';
}

// Define NZTM2000 (EPSG:2193) and WGS84 (EPSG:4326) projections
const nztm2000 = '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
const wgs84 = 'EPSG:4326';

// PowerCo coordinates are in NZTM2000 (EPSG:2193), convert to WGS84
function nztmToWgs84(x, y) {
  const [lng, lat] = proj4(nztm2000, wgs84, [x, y]);
  return { latitude: lat, longitude: lng };
}

export async function scrapePowerCo() {
  const url = 'https://outages.powerco.co.nz/server/rest/services/Hosted/Outages/FeatureServer/1/query';
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'json'
  });

  const response = await fetch(`${url}?${params}`);
  const data = await response.json();

  const outages = (data.features || []).map(feature => {
    const attr = feature.attributes;
    const coords = nztmToWgs84(feature.geometry.x, feature.geometry.y);
    
    // Use coordinates to determine actual region from GeoJSON boundaries
    const region = getRegionFromCoordinates(coords.longitude, coords.latitude) || 'Manawatu (Powerco)';
    
    return {
      outageId: attr.distributor_event_number,
      utility: { name: 'Powerco', id: region === 'Tauranga (Powerco)' ? '10' : region === 'Thames Valley (Powerco)' ? '6' : region === 'Taranaki (Powerco)' ? '19' : region === 'Wanganui (Powerco)' ? '20' : region === 'Wairarapa (Powerco)' ? '18' : '21' },
      region,
      regionCode: getRegionCode(region),
      outageStart: attr.interruption_start_date ? new Date(attr.interruption_start_date).toISOString() : null,
      estimatedRestoration: attr.interruption_restore_date ? new Date(attr.interruption_restore_date).toISOString() : null,
      cause: attr.interruption_reason?.replace(/"/g, '') || 'Unknown',
      status: attr.interruption_restore_date ? 'restored' : 'active',
      outageType: attr.planned_outage === 1 ? 'planned' : 'unplanned',
      customersAffected: attr.number_of_detail_records || 0,
      crewStatus: attr.crew_status,
      location: {
        coordinates: coords,
        areas: [attr.suburb, attr.town].filter(Boolean),
        streets: []
      },
      metadata: {
        feeder: attr.feeder,
        lastUpdate: attr.last_update_date ? new Date(attr.last_update_date).toISOString() : null
      }
    };
  });

  return {
    utility: { name: 'Powerco', id: 'POWERCO' },
    region: 'Powerco (Multiple Regions)',
    outages
  };
}


