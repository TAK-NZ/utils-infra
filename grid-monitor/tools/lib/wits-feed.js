// Shared client for the public WITS "Outages" dashboard feed.
// -----------------------------------------------------------------------------
// Two quirks of this endpoint are handled here so callers don't have to:
//   1. The host returns 403 for the default node-fetch User-Agent, so we send a
//      browser-like UA + referer.
//   2. The server emits a slightly non-RFC-compliant response header that Node's
//      strict HTTP parser rejects ("Missing expected CR after header value"),
//      so we use the native https client with insecureHTTPParser (node-fetch /
//      undici do not expose that option).
// -----------------------------------------------------------------------------

import https from 'node:https';

export const OUTAGES_URL = 'https://www1.electricityinfo.co.nz/api/v1/dashboard/outages';

const BROWSER_HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www1.electricityinfo.co.nz/',
};

export function httpGetJson(url, headers = BROWSER_HEADERS, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, insecureHTTPParser: true }, (res) => {
      const { statusCode } = res;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`WITS feed returned ${statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse WITS response as JSON: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('WITS request timed out')));
  });
}

/**
 * Fetch the current WITS outages feed.
 * @returns {Promise<{content?:{items?:object[]}}>}
 */
export async function fetchOutagesFeed() {
  return httpGetJson(OUTAGES_URL);
}

/** Extract the items array from a feed payload. */
export function feedItems(payload) {
  return (payload && payload.content && payload.content.items) || [];
}

/** The feed's own run time (NZ local, "YYYY-MM-DD HH:MM:SS") or null. */
export function feedRunTime(payload) {
  const items = feedItems(payload);
  return items.length ? items[0].run_time : null;
}
