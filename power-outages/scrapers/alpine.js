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
  const localities = Object.keys(ALPINE_LOCALITIES);
  const sampleSize = Math.min(20, localities.length);
  const samples = [];
  
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(Math.random() * localities.length);
    samples.push(localities[idx]);
  }

  for (const locality of samples) {
    try {
      const coords = getCoordinates(locality);
      const url = `https://outages.alpineenergy.co.nz/api/FaultsAPI/GetFaults?locality=${coords.latitude},${coords.longitude}&faultType=false&site_id=59`;
      const response = await fetch(url);
      const data = await response.json();

      if (data?.FaultList) {
        for (const fault of data.FaultList) {
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
              coordinates: {
                latitude: fault.Latitude || 0,
                longitude: fault.Longitude || 0
              },
              areas: [fault.Location || 'Unknown']
            }
          });
        }
      }
    } catch (error) {
      // Silent fail
    }
  }

  return { utility, outages };
}
