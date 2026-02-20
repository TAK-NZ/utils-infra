import fetch from 'node-fetch';
import { getRegionCode } from './regions.js';

const MAINPOWER_API = 'https://outages.mainpower.co.nz/jobs?source=pcc&view=external';

function parseDateTime(dateStr) {
  if (!dateStr || dateStr === 'TBA' || dateStr === 'None') return null;
  // Parse "20/02/2026 17:24" format
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+)/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function extractCoordinates(job) {
  const steps = job.steps || job.plans || {};
  const firstStep = Object.values(steps)[0];
  if (firstStep?.properties?.Lat && firstStep?.properties?.Lon) {
    return {
      latitude: firstStep.properties.Lat,
      longitude: firstStep.properties.Lon
    };
  }
  // Fallback: return null but don't skip the outage
  return { latitude: 0, longitude: 0 };
}

export async function scrapeMainPower() {
  const response = await fetch(MAINPOWER_API);
  const data = await response.json();
  const outages = [];

  // Process current outages (unplanned) ONLY
  for (const [jobId, job] of Object.entries(data.current_outages || {})) {
    const coords = extractCoordinates(job);

    outages.push({
      outageId: jobId,
      utility: { name: 'MainPower', id: 'MAINPOWER_NZ' },
      region: 'Canterbury',
      regionCode: getRegionCode('Canterbury'),
      outageStart: parseDateTime(job.StartTime),
      estimatedRestoration: parseDateTime(job.EndTime),
      cause: job.Reason || 'Unknown',
      status: 'active',
      outageType: 'unplanned',
      customersAffected: job.CustomersOff || 0,
      location: {
        coordinates: coords,
        areas: job.Area ? [job.Area] : []
      },
      metadata: {
        crewStatus: job.CrewState,
        updates: job.Updates
      }
    });
  }

  return {
    utility: { name: 'MainPower', id: 'MAINPOWER_NZ' },
    region: 'North Canterbury, New Zealand',
    outages
  };
}
