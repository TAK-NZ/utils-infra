import fetch from 'node-fetch';
import proj4 from 'proj4';
import { getRegionCode } from './regions.js';

// PowerCo region mapping (town -> region)
const TOWN_TO_REGION = {
  // Bay of Plenty
  'Tauranga': 'Bay of Plenty',
  'Mount Maunganui': 'Bay of Plenty',
  'Pauanui': 'Bay of Plenty',
  'Whangamata': 'Bay of Plenty',
  'Waihi': 'Bay of Plenty',
  'Katikati': 'Bay of Plenty',
  'Te Puke': 'Bay of Plenty',
  
  // Taranaki
  'New Plymouth': 'Taranaki',
  'Stratford': 'Taranaki',
  'Hawera': 'Taranaki',
  'Opunake': 'Taranaki',
  'Waitara': 'Taranaki',
  'Inglewood': 'Taranaki',
  'Eltham': 'Taranaki',
  'Patea': 'Taranaki',
  
  // Manawatu-Whanganui
  'Palmerston North': 'Manawatu-Whanganui',
  'Whanganui': 'Manawatu-Whanganui',
  'Feilding': 'Manawatu-Whanganui',
  'Levin': 'Manawatu-Whanganui',
  'Bulls': 'Manawatu-Whanganui',
  'Marton': 'Manawatu-Whanganui',
  'Taihape': 'Manawatu-Whanganui',
  'Dannevirke': 'Manawatu-Whanganui',
  'Woodville': 'Manawatu-Whanganui',
  'Ohakune': 'Manawatu-Whanganui',
  'Raetihi': 'Manawatu-Whanganui',
  'Waiouru': 'Manawatu-Whanganui',
  'Mangaweka': 'Manawatu-Whanganui',
  
  // Wellington
  'Masterton': 'Wellington',
  'Carterton': 'Wellington',
  'Greytown': 'Wellington',
  'Featherston': 'Wellington',
  'Martinborough': 'Wellington',
  'Eketahuna': 'Wellington'
};

function getRegion(town) {
  return TOWN_TO_REGION[town] || 'Central North Island';
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
    
    const region = getRegion(attr.town);
    
    return {
      outageId: attr.distributor_event_number,
      utility: { name: 'PowerCo', id: 'POWERCO_NZ' },
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
    utility: { name: 'PowerCo', id: 'POWERCO_NZ' },
    region: 'Central North Island, New Zealand',
    outages
  };
}


