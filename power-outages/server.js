import express from 'express';
import { scrapeOrion } from './scrapers/orion.js';
import { scrapePowerCo } from './scrapers/powerco.js';
import { scrapeWellington } from './scrapers/wellington.js';
import { scrapeEANetworks } from './scrapers/eanetworks.js';
import { scrapeAurora } from './scrapers/aurora.js';
import { scrapeTLC } from './scrapers/tlc.js';
import { scrapeMainPower } from './scrapers/mainpower.js';
import { scrapeAlpineEnergy } from './scrapers/alpine.js';
import { getICPData } from './icp-data.js';
import { POWERCO_REGIONS, AURORA_REGIONS } from './powerco-regions.js';
import { NOT_FEASIBLE_REGIONS } from './not-feasible-regions.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL) || 300000; // 5 minutes

const scrapers = {
  orion: scrapeOrion,
  powerco: scrapePowerCo,
  wellington: scrapeWellington,
  eanetworks: scrapeEANetworks,
  aurora: scrapeAurora,
  tlc: scrapeTLC,
  mainpower: scrapeMainPower,
  alpine: scrapeAlpineEnergy
};

const outageCache = new Map();
let lastScrapeTime = null;
let isScraping = false;

// Background scraper function
async function runScrapers() {
  if (isScraping) {
    console.log('Scrape already in progress, skipping...');
    return;
  }
  
  isScraping = true;
  console.log(`[${new Date().toISOString()}] Starting scheduled scrape...`);
  
  const results = await Promise.allSettled(
    Object.entries(scrapers).map(async ([name, fn]) => {
      try {
        const data = await fn();
        outageCache.set(name, { data, timestamp: Date.now() });
        console.log(`  ✓ ${name}: ${data.outages.length} outages`);
        return data;
      } catch (err) {
        console.error(`  ✗ ${name}: ${err.message}`);
        throw err;
      }
    })
  );
  
  lastScrapeTime = Date.now();
  isScraping = false;
  
  const successful = results.filter(r => r.status === 'fulfilled').length;
  console.log(`[${new Date().toISOString()}] Scrape complete: ${successful}/${results.length} successful\n`);
}

// Start background scraper
setInterval(runScrapers, SCRAPE_INTERVAL);
runScrapers(); // Run immediately on startup



app.get('/power-outages/aggregate', async (req, res) => {
  const { utility, outageType } = req.query;
  
  // Get utilities info from cache
  const icpData = getICPData();
  const utilities = [];
  const now = Date.now();
  
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      const { id, name: utilityName } = cache.data.utility;
      
      // Filter out future outages (same logic as /outages endpoint)
      const activeOutages = cache.data.outages.filter(o => {
        if (!o.outageStart) return true;
        const startTime = new Date(o.outageStart).getTime();
        return isNaN(startTime) || startTime <= now;
      });
      
      if (utilityName === 'Powerco') {
        for (const { region: powercoRegion, id: regionId } of POWERCO_REGIONS) {
          const totalCustomers = icpData[powercoRegion] || 0;
          const regionOutages = activeOutages.filter(o => o.region === powercoRegion);
          const affectedCustomers = regionOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          utilities.push({
            id: regionId,
            name: utilityName,
            region: powercoRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
            status: 'ok',
            outageCount: regionOutages.length,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else if (utilityName === 'Aurora Energy') {
        for (const { region: auroraRegion, id: regionId } of AURORA_REGIONS) {
          const totalCustomers = icpData[auroraRegion] || 0;
          const regionOutages = activeOutages.filter(o => o.region === auroraRegion);
          const affectedCustomers = regionOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          utilities.push({
            id: regionId,
            name: utilityName,
            region: auroraRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
            status: 'ok',
            outageCount: regionOutages.length,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else {
        const totalCustomers = icpData[cache.data.region] || 0;
        const affectedCustomers = activeOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
        utilities.push({
          id,
          name: utilityName,
          region: cache.data.region,
          totalCustomers,
          affectedCustomers,
          affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
          status: 'ok',
          outageCount: activeOutages.length,
          lastUpdate: new Date(cache.timestamp).toISOString()
        });
      }
    }
  }
  
  utilities.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  
  // Get all outages from cache
  const allOutages = Array.from(outageCache.values())
    .filter(cache => cache.data && cache.data.outages)
    .flatMap(cache => cache.data.outages);
  
  // Apply filters (reuse now from above)
  let filtered = allOutages.filter(o => {
    if (!o.outageStart) return true;
    const startTime = new Date(o.outageStart).getTime();
    return isNaN(startTime) || startTime <= now;
  });
  if (utility) {
    filtered = filtered.filter(o => o.utility.id === utility.toUpperCase());
  }
  if (outageType) {
    filtered = filtered.filter(o => o.outageType === outageType);
  }
  
  // Group by city/area and aggregate
  const byCity = {};
  filtered.forEach(outage => {
    const city = outage.location?.areas?.[0] || 'Unknown';
    const key = `${outage.utility.id}-${city}`;
    
    if (!byCity[key]) {
      byCity[key] = {
        utility: outage.utility,
        region: outage.region,
        regionCode: outage.regionCode,
        city,
        customersAffected: 0,
        outageIds: [],
        coordinates: [],
        causes: new Set(),
        outageTypes: new Set(),
        earliestStart: null,
        latestRestoration: null
      };
    }
    
    byCity[key].customersAffected += outage.customersAffected || 0;
    byCity[key].outageIds.push(outage.outageId);
    byCity[key].coordinates.push({
      lat: outage.location.coordinates.latitude,
      lng: outage.location.coordinates.longitude
    });
    if (outage.cause) byCity[key].causes.add(outage.cause);
    if (outage.outageType) byCity[key].outageTypes.add(outage.outageType);
    
    // Track earliest start and latest restoration
    if (outage.outageStart) {
      const start = new Date(outage.outageStart);
      if (!isNaN(start.getTime())) {
        if (!byCity[key].earliestStart || start < byCity[key].earliestStart) {
          byCity[key].earliestStart = start;
        }
      }
    }
    if (outage.estimatedRestoration) {
      const restore = new Date(outage.estimatedRestoration);
      if (!isNaN(restore.getTime())) {
        if (!byCity[key].latestRestoration || restore > byCity[key].latestRestoration) {
          byCity[key].latestRestoration = restore;
        }
      }
    }
  });
  
  // Calculate centroids and format as outages
  const aggregated = Object.values(byCity).map(agg => {
    const avgLat = agg.coordinates.reduce((sum, c) => sum + c.lat, 0) / agg.coordinates.length;
    const avgLng = agg.coordinates.reduce((sum, c) => sum + c.lng, 0) / agg.coordinates.length;
    
    return {
      outageId: `AGG-${agg.utility.id}-${agg.city}`,
      utility: agg.utility,
      region: agg.region,
      regionCode: agg.regionCode,
      outageStart: agg.earliestStart ? agg.earliestStart.toISOString() : null,
      estimatedRestoration: agg.latestRestoration ? agg.latestRestoration.toISOString() : null,
      cause: Array.from(agg.causes).join(', '),
      status: 'active',
      outageType: Array.from(agg.outageTypes).join(', '),
      customersAffected: agg.customersAffected,
      location: {
        coordinates: {
          latitude: avgLat,
          longitude: avgLng
        },
        areas: [agg.city]
      },
      metadata: {
        aggregationType: 'by-city',
        outageCount: agg.outageIds.length,
        outageIds: agg.outageIds
      }
    };
  }).sort((a, b) => b.customersAffected - a.customersAffected);
  
  res.json({
    version: '1.0',
    timestamp: new Date().toISOString(),
    lastScrape: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
    summary: {
      totalUtilities: utilities.length,
      totalOutages: aggregated.length,
      totalCustomersAffected: aggregated.reduce((sum, a) => sum + a.customersAffected, 0)
    },
    utilities,
    outages: aggregated
  });
});

app.get('/power-outages/geojson', async (req, res) => {
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  // Load GeoJSON boundaries
  const geojsonPath = path.join(__dirname, 'data', 'nz-network-boundaries.geojson');
  const geojsonData = JSON.parse(fs.readFileSync(geojsonPath, 'utf-8'));
  
  // Get utilities data
  const icpData = getICPData();
  const utilitiesMap = new Map();
  const now = Date.now();
  
  // PowerCo regions that should be aggregated
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      const { id, name: utilityName } = cache.data.utility;
      const region = cache.data.region;
      
      // Filter out future outages (same logic as /outages endpoint)
      const activeOutages = cache.data.outages.filter(o => {
        if (!o.outageStart) return true;
        const startTime = new Date(o.outageStart).getTime();
        return isNaN(startTime) || startTime <= now;
      });
      
      // For PowerCo, aggregate data for each of its regions
      if (utilityName === 'Powerco') {
        for (const { region: powercoRegion, id: regionId } of POWERCO_REGIONS) {
          const totalCustomers = icpData[powercoRegion] || 0;
          const affectedCustomers = activeOutages
            .filter(o => o.region === powercoRegion)
            .reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          const outageCount = activeOutages.filter(o => o.region === powercoRegion).length;
          
          utilitiesMap.set(powercoRegion, {
            id: regionId,
            name: utilityName,
            region: powercoRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? parseFloat(((affectedCustomers / totalCustomers) * 100).toFixed(4)) : 0,
            outageCount,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else if (utilityName === 'Aurora Energy') {
        for (const { region: auroraRegion, id: regionId } of AURORA_REGIONS) {
          const totalCustomers = icpData[auroraRegion] || 0;
          const regionOutages = activeOutages.filter(o => o.region === auroraRegion);
          const affectedCustomers = regionOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          const outageCount = regionOutages.length;
          
          utilitiesMap.set(auroraRegion, {
            id: regionId,
            name: utilityName,
            region: auroraRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? parseFloat(((affectedCustomers / totalCustomers) * 100).toFixed(4)) : 0,
            outageCount,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else {
        // For other utilities, use region directly
        const totalCustomers = icpData[region] || 0;
        const affectedCustomers = activeOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
        utilitiesMap.set(region, {
          id,
          name: utilityName,
          region,
          totalCustomers,
          affectedCustomers,
          affectedPercentage: totalCustomers > 0 ? parseFloat(((affectedCustomers / totalCustomers) * 100).toFixed(4)) : 0,
          outageCount: activeOutages.length,
          lastUpdate: new Date(cache.timestamp).toISOString()
        });
      }
    }
  }
  
  // Merge utility data into GeoJSON features
  const features = [];
  
  geojsonData.features.forEach(feature => {
    const region = feature.properties.Region;
    const utilityData = utilitiesMap.get(region);
    
    let featureData;
    if (utilityData) {
      featureData = {
        ...feature.properties,
        ...utilityData,
        status: 'ok'
      };
    } else if (NOT_FEASIBLE_REGIONS.has(region)) {
      const totalCustomers = icpData[region] || 0;
      featureData = {
        ...feature.properties,
        id: feature.properties.ID,
        name: region.split('(')[1]?.replace(')', '') || 'Unknown',
        region,
        totalCustomers,
        affectedCustomers: null,
        affectedPercentage: null,
        outageCount: null,
        status: 'not-feasible',
        lastUpdate: null
      };
    } else {
      return; // Skip unimplemented regions
    }
    
    // Split MultiPolygon into separate Polygon features for CloudTAK compatibility
    if (feature.geometry.type === 'MultiPolygon') {
      feature.geometry.coordinates.forEach((polygonCoords, index) => {
        features.push({
          type: 'Feature',
          properties: {
            ...featureData,
            ID: `${feature.properties.ID}-${index}`,
            id: `${featureData.id}-${index}`
          },
          geometry: {
            type: 'Polygon',
            coordinates: polygonCoords
          }
        });
      });
    } else {
      features.push({
        ...feature,
        properties: featureData
      });
    }
  });
  
  res.json({
    type: 'FeatureCollection',
    crs: geojsonData.crs,
    timestamp: new Date().toISOString(),
    lastScrape: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
    colorScheme: {
      description: 'Recommended color scheme based on percentage of customers affected',
      ranges: [
        { min: 0, max: 0.1, color: '#22c55e', label: 'Normal (< 0.1%)' },
        { min: 0.1, max: 1.0, color: '#84cc16', label: 'Minor (0.1-1%)' },
        { min: 1.0, max: 5.0, color: '#eab308', label: 'Moderate (1-5%)' },
        { min: 5.0, max: 10.0, color: '#f97316', label: 'Significant (5-10%)' },
        { min: 10.0, max: 25.0, color: '#ef4444', label: 'Major (10-25%)' },
        { min: 25.0, max: 100, color: '#991b1b', label: 'Critical (> 25%)' }
      ],
      notFeasible: { color: '#9ca3af', label: 'Data Collection Not Feasible' }
    },
    features
  });
});

app.get('/power-outages/summary', async (req, res) => {
  // Get utilities info from cache
  const icpData = getICPData();
  const utilities = [];
  const now = Date.now();
  
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      const { id, name: utilityName } = cache.data.utility;
      
      // Filter out future outages (same logic as /outages endpoint)
      const activeOutages = cache.data.outages.filter(o => {
        if (!o.outageStart) return true;
        const startTime = new Date(o.outageStart).getTime();
        return isNaN(startTime) || startTime <= now;
      });
      
      if (utilityName === 'Powerco') {
        for (const { region: powercoRegion, id: regionId } of POWERCO_REGIONS) {
          const totalCustomers = icpData[powercoRegion] || 0;
          const regionOutages = activeOutages.filter(o => o.region === powercoRegion);
          const affectedCustomers = regionOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          utilities.push({
            id: regionId,
            name: utilityName,
            region: powercoRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
            status: 'ok',
            outageCount: regionOutages.length,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else if (utilityName === 'Aurora Energy') {
        for (const { region: auroraRegion, id: regionId } of AURORA_REGIONS) {
          const totalCustomers = icpData[auroraRegion] || 0;
          const regionOutages = activeOutages.filter(o => o.region === auroraRegion);
          const affectedCustomers = regionOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
          utilities.push({
            id: regionId,
            name: utilityName,
            region: auroraRegion,
            totalCustomers,
            affectedCustomers,
            affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
            status: 'ok',
            outageCount: regionOutages.length,
            lastUpdate: new Date(cache.timestamp).toISOString()
          });
        }
      } else {
        const totalCustomers = icpData[cache.data.region] || 0;
        const affectedCustomers = activeOutages.reduce((sum, o) => sum + (o.customersAffected || 0), 0);
        utilities.push({
          id,
          name: utilityName,
          region: cache.data.region,
          totalCustomers,
          affectedCustomers,
          affectedPercentage: totalCustomers > 0 ? ((affectedCustomers / totalCustomers) * 100).toFixed(4) : '0.0000',
          status: 'ok',
          outageCount: activeOutages.length,
          lastUpdate: new Date(cache.timestamp).toISOString()
        });
      }
    }
  }
  
  utilities.sort((a, b) => parseInt(a.id) - parseInt(b.id));

  res.json({
    version: '1.0',
    timestamp: new Date().toISOString(),
    lastScrape: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
    utilities
  });
});

app.get('/power-outages/outages', async (req, res) => {
  const { utility, minCustomers, region, regionCode, outageType } = req.query;
  
  // Serve from cache only
  const allOutages = [];
  
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      allOutages.push(...cache.data.outages);
    }
  }
  
  // Apply filters
  const now = Date.now();
  let filtered = allOutages.filter(o => {
    if (!o.outageStart) return true;
    const startTime = new Date(o.outageStart).getTime();
    return isNaN(startTime) || startTime <= now;
  });
  if (utility) {
    filtered = filtered.filter(o => o.utility.id === utility.toUpperCase());
  }
  if (minCustomers) {
    const min = parseInt(minCustomers);
    filtered = filtered.filter(o => (o.customersAffected || 0) >= min);
  }
  if (region) {
    const regionLower = region.toLowerCase();
    filtered = filtered.filter(o => 
      o.region?.toLowerCase().includes(regionLower) ||
      o.location?.areas?.some(a => a.toLowerCase().includes(regionLower))
    );
  }
  if (regionCode) {
    filtered = filtered.filter(o => o.regionCode === regionCode.toUpperCase());
  }
  if (outageType) {
    filtered = filtered.filter(o => o.outageType === outageType);
  }
  
  const response = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    lastScrape: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
    summary: {
      totalOutages: filtered.length,
      totalCustomersAffected: filtered.reduce((sum, o) => sum + (o.customersAffected || 0), 0)
    },
    outages: filtered
  };
  
  res.json(response);
});

app.get('/power-outages', (req, res) => {
  res.json({
    service: 'Power Outages',
    version: '1.0',
    description: 'NZ Power Outage Data Aggregator',
    utilities: Object.keys(scrapers),
    endpoints: {
      outages: '/power-outages/outages',
      outagesByUtility: '/power-outages/outages?utility=ORION_NZ',
      outagesByType: '/power-outages/outages?outageType=unplanned',
      majorOutages: '/power-outages/outages?minCustomers=10',
      aggregate: '/power-outages/aggregate',
      summary: '/power-outages/summary',
      geojson: '/power-outages/geojson',
      health: '/power-outages/health'
    }
  });
});

app.get('/power-outages/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    lastScrape: lastScrapeTime ? new Date(lastScrapeTime).toISOString() : null,
    nextScrape: lastScrapeTime ? new Date(lastScrapeTime + SCRAPE_INTERVAL).toISOString() : null,
    scrapeInterval: `${SCRAPE_INTERVAL / 1000}s`,
    isScraping
  });
});



app.listen(PORT, () => {
  console.log(`Power Outages service running on port ${PORT}`);
});
