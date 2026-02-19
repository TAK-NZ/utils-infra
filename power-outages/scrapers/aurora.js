import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

export async function scrapeAurora() {
  try {
    const response = await fetch('https://www.auroraenergy.co.nz/power-outages', {
      headers: { 'User-Agent': 'TAK-NZ-PowerOutages/1.0' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const outages = [];
    const seen = new Set();

    $('.outage-item').each((_, elem) => {
      const $elem = $(elem);
      const incidentId = $elem.attr('data-event-number');
      
      // Skip duplicates
      if (seen.has(incidentId)) return;
      seen.add(incidentId);
      
      const lat = parseFloat($elem.attr('data-latitude'));
      const lng = parseFloat($elem.attr('data-longitude'));
      
      const statusElem = $elem.find('.status-unplanned, .status-planned, .status-restored, .status-cancelled');
      const statusClass = statusElem.attr('class') || '';
      
      // Only include unplanned (current) outages - skip planned, restored, and cancelled
      if (!statusClass.includes('status-unplanned')) {
        return;
      }
      
      const town = $elem.find('.outage-town').text().trim();
      const suburbs = $elem.find('.outage-suburbs p').text().trim();
      const statusText = statusElem.text().trim();
      const timeOff = $elem.find('.time-off-offset').next('span').text().trim();
      const timeOn = $elem.find('.outage-datetime').last().next('span').text().trim();
      
      // Customer count is in the accordion content (sibling element)
      const accordionContent = $elem.parent().find('.outage-details-customers').first();
      const customersText = accordionContent.text().trim();
      const customers = customersText === '< 5' ? 5 : parseInt(customersText) || 0;

      outages.push({
        outageId: incidentId,
        utility: { name: 'Aurora Energy', id: 'AURORA_NZ' },
        region: 'Otago',
        regionCode: 'NZ-OTA',
        outageStart: timeOff || null,
        estimatedRestoration: timeOn || null,
        cause: 'Unknown',
        status: 'active',
        outageType: statusClass.includes('status-planned') ? 'planned' : 'unplanned',
        customersAffected: customers,
        location: {
          coordinates: { latitude: lat, longitude: lng },
          areas: [town, ...suburbs.split(',').map(s => s.trim())].filter(Boolean),
          streets: []
        },
        metadata: {
          lastUpdate: new Date().toISOString()
        }
      });
    });

    return { utility: { name: 'Aurora Energy', id: 'AURORA_NZ' }, outages };
  } catch (error) {
    console.error('Aurora scrape error:', error.message);
    return { utility: { name: 'Aurora Energy', id: 'AURORA_NZ' }, outages: [] };
  }
}
