import fetch from 'node-fetch';
import { getRegionCode } from './regions.js';

const MAINPOWER_API = 'https://outages.mainpower.co.nz/jobs?source=pcc&view=external';

function parseDateTime(dateStr) {
  if (!dateStr || dateStr === 'TBA' || dateStr === 'None') return null;
  // Parse "20/02/2026 17:24" format
  const match = dateStr.match(/(\d+)\/(\d+)\/(\d+) (\d+):(\d+)/);
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return new Date(year, month - 1, day, hour, minute).toISString();
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
  return null;
}

export async function scrapeMainPower() {
  const response = await fetch(MAINPOWER_API);
  const data = await response.json();
  const outages = [];

  // Process current outages (unplanned)
  for (const [jobId, job] of Object.entries(data.current_outages || {})) {
    const coords = extractCoordinates(job);
    if (!coords) continue;

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

  // Process planned jobs
  for (const [jobId, job] of Object.entries(data.planned_jobs || {})) {
    if (job.Status === 'Complete') continue;
    
    const coords = extractCoordinates(job);
    if (!coords) continue;

    outages.push({
      outageId: jobId,
      utility: { name: 'MainPower', id: 'MAINPOWER_NZ' },
      region: 'Canterbury',
      regionCode: getRegionCode('Canterbury'),
      outageStart: parseDateTime(job.ActualStartTime || job.PlannedStartTime),
      estimatedRestoration: parseDateTime(job.ActualEndTime || job.PlannedEndTime),
      cause: job.Reason || 'Planned Maintenance',
      status: job.Status?.toLowerCase() || 'active',
      outageType: 'planned',
      customersAffected: job.CustomersOff || 0,
      location: {
        coordinates: coords,
        areas: job.Area ? [job.Area] : []
      },
      metadata: {
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
