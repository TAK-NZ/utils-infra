/**
 * Tests for weather-proxy degraded tile headers
 */
import type { AddressInfo } from 'net';
import type { Server } from 'http';

process.env.RAINBOW_API_KEY = 'test';
delete process.env.CONFIG_BUCKET;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app } = require('../weather-proxy/server.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let server: Server;
let base: string;
let rainbowOk = true;
let rainbowCalls = 0;
const realFetch = global.fetch;

function stubFetch() {
  global.fetch = jest.fn(async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input);
    if (url.includes('api.rainbow.ai')) {
      rainbowCalls++;
      if (!rainbowOk) return new Response('nope', { status: 404 });
      return new Response(PNG, { status: 200 });
    }
    if (url.includes('weather-maps.json')) {
      return new Response(JSON.stringify({ radar: { past: [{ path: '/v2/radar/1' }] } }), { status: 200 });
    }
    if (url.includes('tilecache.rainviewer.com')) return new Response(PNG, { status: 200 });
    return new Response('unexpected', { status: 500 });
  }) as any;
}

async function get(path: string) {
  const res = await realFetch(`${base}${path}`);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

beforeAll(async () => {
  stubFetch();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  rainbowOk = true;
  rainbowCalls = 0;
});

describe('weather-proxy degraded tile headers', () => {
  test('good Rainbow tile has no new headers', async () => {
    const { res, body } = await get('/weather-radar/3/4/5.png?provider=rainbow&layer=precip&api=k');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(res.headers.get('x-weather-provider')).toBe('rainbow');
    expect(res.headers.get('x-weather-fallback')).toBeNull();
    expect(res.headers.get('x-weather-error')).toBeNull();
    expect(body.equals(PNG)).toBe(true);
  });

  test('provider=rainviewer is unchanged', async () => {
    const { res } = await get('/weather-radar/3/4/6.png?provider=rainviewer');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(res.headers.get('x-weather-provider')).toBe('rainviewer');
    expect(res.headers.get('x-weather-fallback')).toBeNull();
    expect(res.headers.get('x-weather-error')).toBeNull();
  });

  test('precip forecast with Rainbow failing signals RainViewer fallback', async () => {
    rainbowOk = false;
    const { res } = await get('/weather-radar/3/4/7.png?provider=rainbow&layer=precip&forecast=40&api=k');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weather-fallback')).toBe('rainviewer');
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(res.headers.get('x-weather-error')).toBeNull();
  }, 20000);

  test('a cached RainViewer fallback is replayed with the fallback header and the short max-age', async () => {
    rainbowOk = false;
    const path = '/weather-radar/3/4/3.png?provider=rainbow&layer=precip&forecast=50&api=k';
    const first = await get(path);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('x-weather-fallback')).toBe('rainviewer');
    expect(first.res.headers.get('cache-control')).toBe('public, max-age=30');
    // Rainbow was tried (with retries) for the first request only
    const callsAfterFirst = rainbowCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await get(path);
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('x-weather-fallback')).toBe('rainviewer');
    expect(second.res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(second.res.headers.get('x-weather-error')).toBeNull();
    expect(second.body.equals(first.body)).toBe(true);
    expect(rainbowCalls).toBe(callsAfterFirst);
  }, 20000);

  test('clouds with Rainbow failing returns a transparent error tile that is not cached', async () => {
    rainbowOk = false;
    const first = await get('/weather-radar/3/4/2.png?provider=rainbow&layer=clouds&api=k');
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('x-weather-error')).toBe('1');
    expect(first.res.headers.get('cache-control')).toBe('no-store');
    expect(first.res.headers.get('x-weather-fallback')).toBeNull();
    expect(first.body.subarray(0, 4).toString('hex')).toBe('89504e47');
    const callsAfterFirst = rainbowCalls;

    const second = await get('/weather-radar/3/4/2.png?provider=rainbow&layer=clouds&api=k');
    expect(second.res.headers.get('x-weather-error')).toBe('1');
    expect(rainbowCalls).toBeGreaterThan(callsAfterFirst);
  }, 20000);

  test('health endpoint returns 200', async () => {
    const { res } = await get('/weather-radar/health');
    expect(res.status).toBe(200);
  });
});
