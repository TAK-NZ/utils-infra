import fetch from 'node-fetch';

export async function scrapeEANetworks() {
  try {
    const response = await fetch('https://outages-eanetworks-co-nz.vercel.app/api/get-outages?tab=current', {
      headers: { 'User-Agent': 'TAK-NZ-PowerOutages/1.0' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const outages = (data.outages || []).map(outage => {
      const isPlanned = outage.outage_type === 'PLANNED_OUTAGE';
      
      return {
        outageId: outage.incident_id,
        utility: { name: 'Electricity Ashburton', id: '31' },
        region: 'Ashburton (Electricity Ashburton)',
        regionCode: 'NZ-CAN',
        outageStart: outage.start_time,
        estimatedRestoration: outage.estimated_end_time,
        cause: outage.reason || 'Unknown',
        status: outage.status === 'SCHEDULED' ? 'scheduled' : 'active',
        outageType: isPlanned ? 'planned' : 'unplanned',
        customersAffected: outage.current_affected_customers || outage.total_affected_customers || 0,
        location: {
          coordinates: {
            latitude: outage.latitude,
            longitude: outage.longitude
          },
          areas: [outage.name],
          streets: outage.streets_affected ? outage.streets_affected.split(',').map(s => s.trim()) : []
        },
        metadata: {
          outageId: outage.outage_id,
          totalAffected: outage.total_affected_customers,
          energizationStatus: outage.energization_status,
          lastUpdate: outage.updated_at
        }
      };
    });
    
    return { utility: { name: 'Electricity Ashburton', id: '31' }, region: 'Ashburton (Electricity Ashburton)', outages };
  } catch (error) {
    console.error('EA Networks scrape error:', error.message);
    return { utility: { name: 'Electricity Ashburton', id: '31' }, region: 'Ashburton (Electricity Ashburton)', outages: [] };
  }
}
