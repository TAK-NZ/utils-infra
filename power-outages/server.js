import express from 'express';
import { scrapeOrion } from './scrapers/orion.js';
import { scrapePowerCo } from './scrapers/powerco.js';
import { scrapeWellington } from './scrapers/wellington.js';
import { scrapeEANetworks } from './scrapers/eanetworks.js';
import { scrapeAurora } from './scrapers/aurora.js';

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL = parseInt(process.env.SCRAPE_INTERVAL) || 300000; // 5 minutes

const scrapers = {
  orion: scrapeOrion,
  powerco: scrapePowerCo,
  wellington: scrapeWellington,
  eanetworks: scrapeEANetworks,
  aurora: scrapeAurora
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
  const utilities = [];
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      utilities.push({
        ...cache.data.utility,
        status: 'ok',
        outageCount: cache.data.outages.length,
        lastUpdate: new Date(cache.timestamp).toISOString()
      });
    }
  }
  
  // Get all outages from cache
  const allOutages = Array.from(outageCache.values())
    .filter(cache => cache.data && cache.data.outages)
    .flatMap(cache => cache.data.outages);
  
  // Apply filters
  let filtered = allOutages;
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
      if (!byCity[key].earliestStart || start < byCity[key].earliestStart) {
        byCity[key].earliestStart = start;
      }
    }
    if (outage.estimatedRestoration) {
      const restore = new Date(outage.estimatedRestoration);
      if (!byCity[key].latestRestoration || restore > byCity[key].latestRestoration) {
        byCity[key].latestRestoration = restore;
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

app.get('/power-outages/summary', async (req, res) => {
  const { utility, outageType } = req.query;
  
  // Get all outages from cache
  const allOutages = Array.from(outageCache.values())
    .filter(cache => cache.data && cache.data.outages)
    .flatMap(cache => cache.data.outages);
  
  // Apply filters
  let filtered = allOutages;
  if (utility) {
    filtered = filtered.filter(o => o.utility.id === utility.toUpperCase());
  }
  if (outageType) {
    filtered = filtered.filter(o => o.outageType === outageType);
  }
  
  // Group by region/town
  const byRegion = {};
  filtered.forEach(outage => {
    const region = outage.location?.areas?.[0] || outage.region || 'Unknown';
    if (!byRegion[region]) {
      byRegion[region] = {
        region,
        outageCount: 0,
        customersAffected: 0,
        utilities: new Set()
      };
    }
    byRegion[region].outageCount++;
    byRegion[region].customersAffected += outage.customersAffected || 0;
    byRegion[region].utilities.add(outage.utility.name);
  });
  
  const summary = Object.values(byRegion).map(r => ({
    ...r,
    utilities: Array.from(r.utilities)
  })).sort((a, b) => b.customersAffected - a.customersAffected);
  
  res.json({
    version: '1.0',
    timestamp: new Date().toISOString(),
    totalOutages: filtered.length,
    totalCustomersAffected: filtered.reduce((sum, o) => sum + (o.customersAffected || 0), 0),
    byRegion: summary
  });
});

app.get('/power-outages/outages', async (req, res) => {
  const { utility, minCustomers, region, regionCode, outageType } = req.query;
  
  // Serve from cache only
  const utilities = [];
  const allOutages = [];
  
  for (const [name, cache] of outageCache.entries()) {
    if (cache.data) {
      utilities.push({
        ...cache.data.utility,
        status: 'ok',
        outageCount: cache.data.outages.length,
        lastUpdate: new Date(cache.timestamp).toISOString()
      });
      allOutages.push(...cache.data.outages);
    }
  }
  
  // Apply filters
  let filtered = allOutages;
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
      totalUtilities: utilities.length,
      totalOutages: filtered.length,
      totalCustomersAffected: filtered.reduce((sum, o) => sum + (o.customersAffected || 0), 0)
    },
    utilities,
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
