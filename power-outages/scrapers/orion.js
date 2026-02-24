import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { getRegionCode } from './regions.js';

export async function scrapeOrion() {
  const mainUrl = 'https://www.oriongroup.co.nz/outages-and-support/outages';
  const response = await fetch(mainUrl);
  const html = await response.text();
  
  // Extract outage data from window.allOutages in the page
  const match = html.match(/window\.allOutages\s*=\s*({[\s\S]*?});\s*(?:\/\/|<\/script>)/);
  if (!match) {
    console.error('Orion: No window.allOutages found in page');
    return { utility: { name: 'Orion New Zealand', id: '30' }, region: 'Central Canterbury (Orion New Zealand)', outages: [] };
  }
  
  const allOutages = JSON.parse(match[1]);
  const currentOutages = allOutages.CurrentOutages || [];
  
  const region = 'Canterbury';
  const outages = currentOutages
    .filter(data => data.State === 'OPEN')
    .map(data => ({
      outageId: data.IncidentRef,
      utility: { name: 'Orion New Zealand', id: '30' },
      region,
      regionCode: getRegionCode(region),
      outageStart: data.TimeDown,
      estimatedRestoration: data.EstTimeUp,
      cause: data.OutageCause,
      status: 'active',
      customersAffected: data.TotalNumberOff,
      location: {
        coordinates: { latitude: data.Latitude, longitude: data.Longitude },
        areas: data.Areas ? data.Areas.split(', ') : [],
        streets: data.Streets ? data.Streets.split(', ') : []
      }
    }));

  return {
    utility: { name: 'Orion New Zealand', id: '30' },
    region: 'Central Canterbury (Orion New Zealand)',
    outages
  };
}


