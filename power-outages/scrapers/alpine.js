import fetch from 'node-fetch';
import { ALPINE_LOCALITIES, getCoordinates } from './alpine-localities.js';

export async function scrapeAlpineEnergy() {
  const utility = {
    id: 'ALPINE_NZ',
    name: 'Alpine Energy',
    region: 'South Canterbury',
    website: 'https://www.alpineenergy.co.nz'
  };

  const outages = [];

  try {
    const url = 'https://outages.alpineenergy.co.nz/api/FaultsAPI/GetFaults?locality=&faultType=false&site_id=59';
    const response = await fetch(url);
    const data = await response.json();

    if (data?.FaultList) {
      for (const fault of data.FaultList) {
        const locality = fault.Location || 'Unknown';
        const coords = getCoordinates(locality) || { latitude: 0, longitude: 0 };

        outages.push({
          outageId: `ALPINE-${fault.FaultId || Date.now()}`,
          utility,
          region: 'South Canterbury',
          regionCode: 'SC',
          outageStart: fault.StartTime || null,
          estimatedRestoration: fault.EstimatedRestoration || null,
          cause: fault.Cause || 'Unknown',
          status: 'active',
          outageType: 'unplanned',
          customersAffected: fault.AffectedCustomers || 0,
          location: {
            coordinates: coords,
            areas: [locality]
          }
        });
      }
    }
  } catch (error) {
    console.error('Alpine Energy scrape error:', error.message);
  }

  return { utility, outages };
}
