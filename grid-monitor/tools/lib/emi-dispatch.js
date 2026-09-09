// EMI real-time-dispatch feed client + normalisation.
// -----------------------------------------------------------------------------
// Fetches the EMI real-time-dispatch endpoint (requires a Wholesale-market-prices
// subscription key) and exposes small helpers shared by the server and CLIs.
// -----------------------------------------------------------------------------

import https from 'node:https';

export const DISPATCH_URL = 'https://emi.azure-api.net/real-time-dispatch/';

function httpGetJson(url, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`EMI dispatch API returned ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Failed to parse EMI response: ${err.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('EMI request timed out')));
  });
}

/**
 * Fetch the current real-time-dispatch record set.
 * @param {string} apiKey EMI subscription key
 * @returns {Promise<Array<object>>}
 */
export async function fetchDispatch(apiKey) {
  if (!apiKey) throw new Error('EMI API key not provided');
  const payload = await httpGetJson(DISPATCH_URL, {
    'Ocp-Apim-Subscription-Key': apiKey,
    Accept: 'application/json',
  });
  return Array.isArray(payload) ? payload : [];
}

/** The feed's own run time (UTC) or null. */
export function dispatchRunTime(records) {
  return records.length ? records[0].RunDateTime : null;
}

/** The feed's 5-minute interval time (NZ local) or null. */
export function dispatchInterval(records) {
  return records.length ? records[0].FiveMinuteIntervalDatetime : null;
}
