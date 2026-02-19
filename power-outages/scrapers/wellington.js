import fetch from 'node-fetch';
import { getRegionCode } from './regions.js';

export async function scrapeWellington() {
  const url = 'https://www.welectricity.co.nz/api/outages';
  
  const response = await fetch(url);
  const data = await response.json();

  const region = 'Wellington';
  const outages = data.map(outage => ({
    outageId: `WE-${outage.id}`,
    utility: { name: 'Wellington Electricity', id: 'WELLINGTON_NZ' },
    region,
    regionCode: getRegionCode(region),
    outageStart: outage.fault_time,
    estimatedRestoration: outage.estimated_recovery_time,
    cause: outage.description,
    status: 'active',
    customersAffected: outage.customers_affected,
    location: {
      coordinates: { 
        latitude: outage.latitude, 
        longitude: outage.longitude 
      },
      areas: [outage.suburb, outage.city].filter(Boolean),
      streets: outage.streets_affected?.map(s => s.name) || []
    }
  }));

  return {
    utility: { name: 'Wellington Electricity', id: 'WELLINGTON_NZ' },
    region: 'Wellington, New Zealand',
    outages
  };
}
