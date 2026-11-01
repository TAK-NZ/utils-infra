/**
 * AWS Lambda entry point for terrain-proxy, invoked by the Application Load Balancer.
 *
 * The Express app in server.js is unchanged: serverless-http turns the ALB event into a request and the response back
 * into an ALB response. PNG tiles are returned base64 encoded, as the ALB requires for binary bodies.
 */
'use strict';

const serverless = require('serverless-http');
const app = require('./server');

const handleRequest = serverless(app, { binary: ['image/*'] });

// The LINZ API key and the geoid model are loaded once per execution environment, on the first request. A failure is
// not remembered: the next request tries again, instead of serving sea-level tiles for the rest of the environment's life.
let ready = null;
function ensureReady() {
  if (!ready) {
    ready = app.prepare().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

exports.handler = async (event, context) => {
  try {
    await ensureReady();
  } catch (error) {
    console.error('Not ready to serve:', error.message);
    return {
      statusCode: 503,
      isBase64Encoded: false,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Service temporarily unavailable' }),
    };
  }
  return handleRequest(event, context);
};
