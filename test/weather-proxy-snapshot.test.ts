/**
 * Tests for weather-proxy per-layer snapshots, the client snapshot hint, the step-back
 * fallback, content type sniffing and the /weather-radar/snapshot endpoint.
 * Rainbow.ai, RainViewer and S3 are all mocked; nothing here touches the network.
 */
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const RAINBOW_SECRET = 'rainbow-secret-key-do-not-log';

// Key file served by the mocked S3 client
const mockKeyFile = {
  rainbow: { apiKey: RAINBOW_SECRET },
  apiKeys: {
    good: { key: 'good-key', enabled: true, providers: ['rainviewer', 'rainbow'] },
    viewer: { key: 'viewer-key', enabled: true, providers: ['rainviewer'] },
    limited: { key: 'limited-key', enabled: true, rateLimit: 2, providers: ['rainbow'] },
    off: { key: 'off-key', enabled: false, providers: ['rainbow'] }
  }
};

jest.mock('../weather-proxy/node_modules/@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send() {
      return { Body: { transformToString: async () => JSON.stringify(mockKeyFile) } };
    }
  },
  GetObjectCommand: class {}
}));

process.env.CONFIG_BUCKET = 'test-bucket';
delete process.env.RAINBOW_API_KEY;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { app, resetStateForTests } = require('../weather-proxy/server.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '../weather-proxy')] }));

// 10-minute aligned "now" (epoch seconds). The mocked clock sits 123 s into the step, so the
// clock-based fallback snapshot is NOW_S - 600.
const NOW_S = 1_800_000_000;
const COMPUTED = NOW_S - 600;
// The layers lag the clock: Rainbow reports a snapshot 20 minutes behind
const LATEST = NOW_S - 1200;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

type TileCall = { layer: string; snapshot: number; url: string; key: string | null };

let server: Server;
let base: string;
let nowMs = (NOW_S + 123) * 1000;
const realFetch = global.fetch;

let snapshotCalls: Array<{ layer: string | null; url: string; key: string | null }> = [];
let tileCalls: TileCall[] = [];
let rainviewerCalls = 0;
let snapshotReply: (layer: string) => Response | Promise<Response>;
let tileReply: (call: TileCall) => Response | Promise<Response>;

function defaultSnapshotReply() {
  return new Response(JSON.stringify({ snapshot: LATEST }), { status: 200 });
}
function defaultTileReply() {
  return new Response(PNG, { status: 200 });
}

function stubFetch() {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    const key = init?.headers?.['Ocp-Apim-Subscription-Key'] ?? null;
    if (url.startsWith('https://api.rainbow.ai/tiles/v1/snapshot')) {
      const layer = new URL(url).searchParams.get('layer');
      snapshotCalls.push({ layer, url, key });
      return snapshotReply(String(layer));
    }
    const tile = url.match(/^https:\/\/api\.rainbow\.ai\/tiles\/v1\/(precip-global|precip|clouds|radars)\/(\d+)\//);
    if (tile) {
      const call = { layer: tile[1], snapshot: Number(tile[2]), url, key };
      tileCalls.push(call);
      return tileReply(call);
    }
    if (url.includes('weather-maps.json')) {
      return new Response(JSON.stringify({ radar: { past: [{ path: '/v2/radar/1' }] } }), { status: 200 });
    }
    if (url.includes('tilecache.rainviewer.com')) {
      rainviewerCalls++;
      return new Response(PNG, { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  }) as any;
}

async function get(p: string) {
  const res = await realFetch(`${base}${p}`);
  return { res, body: Buffer.from(await res.arrayBuffer()) };
}

const AUTH = '&api=good-key';
function tile(layer: string, extra = '', coords = '3/4/5') {
  return get(`/weather-radar/${coords}.png?provider=rainbow&layer=${layer}${extra}${AUTH}`);
}
function snapshotOf(res: Response) {
  const v = res.headers.get('x-weather-snapshot');
  return v === null ? null : Number(v);
}
function missing() {
  return new Response('missing', { status: 404 });
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
  jest.restoreAllMocks();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  resetStateForTests();
  nowMs = (NOW_S + 123) * 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  snapshotCalls = [];
  tileCalls = [];
  rainviewerCalls = 0;
  snapshotReply = defaultSnapshotReply;
  tileReply = defaultTileReply;
  (console.warn as jest.Mock).mockClear?.();
});

afterEach(() => {
  (Date.now as unknown as jest.SpyInstance).mockRestore?.();
});

describe('latest snapshot per layer', () => {
  test('each layer gets its own lookup and is served at its own snapshot', async () => {
    snapshotReply = (layer) => new Response(JSON.stringify({ snapshot: layer === 'clouds' ? NOW_S - 1800 : NOW_S - 600 }), { status: 200 });

    const precip = await tile('precip');
    const clouds = await tile('clouds');

    expect(snapshotCalls.map((c) => c.layer).sort()).toEqual(['clouds', 'precip']);
    expect(snapshotOf(precip.res as any)).toBe(NOW_S - 600);
    expect(snapshotOf(clouds.res as any)).toBe(NOW_S - 1800);
    expect(tileCalls.find((c) => c.layer === 'precip')!.snapshot).toBe(NOW_S - 600);
    expect(tileCalls.find((c) => c.layer === 'clouds')!.snapshot).toBe(NOW_S - 1800);
  });

  test('the snapshot lookup authenticates with the header and never puts the key in the URL or logs', async () => {
    await tile('precip');
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0].key).toBe(RAINBOW_SECRET);
    expect(snapshotCalls[0].url).toBe('https://api.rainbow.ai/tiles/v1/snapshot?layer=precip');
    expect(snapshotCalls[0].url).not.toContain(RAINBOW_SECRET);

    // Failing lookups log a warning; it must not contain the key either
    resetStateForTests();
    snapshotReply = () => new Response('boom', { status: 500 });
    await tile('precip');
    const logged = JSON.stringify([
      ...(console.warn as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls
    ]);
    expect(logged).toContain('snapshot lookup failed');
    expect(logged).not.toContain(RAINBOW_SECRET);
  });

  test('the latest snapshot is cached for 60 s per layer', async () => {
    await tile('precip', '', '3/4/5');
    await tile('precip', '', '3/4/6');
    expect(snapshotCalls).toHaveLength(1);

    nowMs += 59_000;
    await tile('precip', '', '3/4/7');
    expect(snapshotCalls).toHaveLength(1);

    nowMs += 2_000; // 61 s after the first lookup
    await tile('precip', '', '3/4/0');
    expect(snapshotCalls).toHaveLength(2);
  });

  test('concurrent requests share one in-flight lookup', async () => {
    snapshotReply = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return defaultSnapshotReply();
    };
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => tile('clouds', '', `3/4/${i}`)));
    expect(results.every((r) => r.res.status === 200)).toBe(true);
    expect(snapshotCalls).toHaveLength(1);
  });

  test.each([
    ['HTTP error', () => new Response('boom', { status: 500 })],
    ['not JSON', () => new Response('nope', { status: 200 })],
    ['missing field', () => new Response(JSON.stringify({}), { status: 200 })],
    ['string value', () => new Response(JSON.stringify({ snapshot: String(LATEST) }), { status: 200 })],
    ['not an integer', () => new Response(JSON.stringify({ snapshot: LATEST + 0.5 }), { status: 200 })],
    ['not a multiple of 600', () => new Response(JSON.stringify({ snapshot: LATEST + 60 }), { status: 200 })],
    ['more than 10 min in the future', () => new Response(JSON.stringify({ snapshot: NOW_S + 1200 }), { status: 200 })],
    ['older than 2 h', () => new Response(JSON.stringify({ snapshot: NOW_S - 7800 }), { status: 200 })]
  ])('falls back to the computed snapshot when the lookup fails: %s', async (_name, reply) => {
    snapshotReply = reply as any;
    const { res } = await tile('precip');
    expect(res.status).toBe(200);
    expect(snapshotOf(res as any)).toBe(COMPUTED);
    expect(tileCalls[0].snapshot).toBe(COMPUTED);

    const info = await get(`/weather-radar/snapshot?layer=precip${AUTH}`);
    expect(JSON.parse(info.body.toString())).toEqual({ layer: 'precip', snapshot: COMPUTED, stepSeconds: 600, source: 'computed' });
  });

  test('a snapshot 10 minutes ahead of the clock is accepted', async () => {
    snapshotReply = () => new Response(JSON.stringify({ snapshot: NOW_S + 600 }), { status: 200 });
    const { res } = await tile('precip');
    expect(snapshotOf(res as any)).toBe(NOW_S + 600);
  });
});

describe('client snapshot hint', () => {
  test('a valid older snapshot is honoured', async () => {
    const hint = LATEST - 1200;
    const { res } = await tile('precip', `&snapshot=${hint}`);
    expect(res.status).toBe(200);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([hint]);
    expect(snapshotOf(res as any)).toBe(hint);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  });

  test('a snapshot equal to the latest and one exactly 2 h older are valid', async () => {
    const newest = await tile('precip', `&snapshot=${LATEST}`, '3/4/1');
    expect(snapshotOf(newest.res as any)).toBe(LATEST);
    const oldest = await tile('precip', `&snapshot=${LATEST - 7200}`, '3/4/2');
    expect(oldest.res.status).toBe(200);
    expect(snapshotOf(oldest.res as any)).toBe(LATEST - 7200);
  });

  test('a snapshot newer than the layer latest is clamped, not rejected', async () => {
    const { res } = await tile('clouds', `&snapshot=${LATEST + 600}`);
    expect(res.status).toBe(200);
    expect(snapshotOf(res as any)).toBe(LATEST);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST]);
    expect(res.headers.get('x-weather-error')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
  });

  test.each([
    ['not a number', 'abc'],
    ['empty', ''],
    ['negative', '-600'],
    ['decimal', '1799998800.5'],
    ['not a multiple of 600', String(LATEST - 60)],
    ['older than 2 h before the latest', String(LATEST - 7800)],
    ['zero', '0'],
    ['repeated', `${LATEST}&snapshot=${LATEST}`]
  ])('an invalid snapshot is rejected with 400: %s', async (_name, value) => {
    const { res, body } = await tile('precip', `&snapshot=${value}`);
    expect(res.status).toBe(400);
    expect(JSON.parse(body.toString()).error).toBe('Invalid parameter');
    expect(JSON.parse(body.toString()).message).toMatch(/snapshot/);
    expect(tileCalls).toHaveLength(0);
  });

  test('RainViewer has no snapshots, so the parameter is ignored there', async () => {
    const { res } = await get('/weather-radar/3/4/5.png?provider=rainviewer&snapshot=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weather-snapshot')).toBeNull();
    expect(snapshotCalls).toHaveLength(0);
  });

  test('the cache key includes the effective snapshot', async () => {
    tileReply = (call) => new Response(Buffer.concat([PNG, Buffer.from(String(call.snapshot))]), { status: 200 });
    const a = LATEST - 600;
    const b = LATEST - 1200;

    const first = await tile('precip', `&snapshot=${a}`);
    const second = await tile('precip', `&snapshot=${b}`);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([a, b]);
    expect(first.body.equals(second.body)).toBe(false);
    expect(first.body.subarray(PNG.length).toString()).toBe(String(a));
    expect(second.body.subarray(PNG.length).toString()).toBe(String(b));

    // Repeats come from the cache without crosstalk
    const again = await tile('precip', `&snapshot=${a}`);
    expect(again.body.equals(first.body)).toBe(true);
    expect(tileCalls).toHaveLength(2);
  });

  test('a new latest snapshot never serves the bytes of the old one', async () => {
    tileReply = (call) => new Response(Buffer.concat([PNG, Buffer.from(String(call.snapshot))]), { status: 200 });
    const old = await tile('precip');
    expect(snapshotOf(old.res as any)).toBe(LATEST);

    snapshotReply = () => new Response(JSON.stringify({ snapshot: LATEST + 600 }), { status: 200 });
    nowMs += 61_000;
    const fresh = await tile('precip');
    expect(snapshotOf(fresh.res as any)).toBe(LATEST + 600);
    expect(fresh.body.subarray(PNG.length).toString()).toBe(String(LATEST + 600));
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST, LATEST + 600]);
  });

  test('a clamped hint and a plain request share one cache entry', async () => {
    await tile('clouds', `&snapshot=${LATEST + 600}`);
    const plain = await tile('clouds');
    expect(plain.res.status).toBe(200);
    expect(tileCalls).toHaveLength(1);
  });
});

describe('step back when the newest tile is missing', () => {
  test('steps back one snapshot', async () => {
    tileReply = (call) => (call.snapshot === LATEST ? missing() : defaultTileReply());
    const { res, body } = await tile('clouds');
    expect(res.status).toBe(200);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST, LATEST - 600]);
    expect(snapshotOf(res as any)).toBe(LATEST - 600);
    expect(res.headers.get('x-weather-error')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(body.equals(PNG)).toBe(true);
  });

  test('steps back twice', async () => {
    tileReply = (call) => (call.snapshot > LATEST - 1200 ? missing() : defaultTileReply());
    const { res } = await tile('clouds');
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST, LATEST - 600, LATEST - 1200]);
    expect(snapshotOf(res as any)).toBe(LATEST - 1200);
    expect(res.status).toBe(200);
  });

  test('HTTP 410 counts as a missing tile', async () => {
    tileReply = (call) => (call.snapshot === LATEST ? new Response('gone', { status: 410 }) : defaultTileReply());
    const { res } = await tile('clouds');
    expect(snapshotOf(res as any)).toBe(LATEST - 600);
  });

  test('a tile still missing after two steps gives the transparent placeholder', async () => {
    tileReply = () => missing();
    const { res, body } = await tile('clouds');
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST, LATEST - 600, LATEST - 1200]);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weather-error')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-weather-snapshot')).toBeNull();
    expect(body.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  test('precip with no tile at any step still falls back to RainViewer', async () => {
    tileReply = () => missing();
    const { res } = await tile('precip');
    expect(tileCalls).toHaveLength(3);
    expect(rainviewerCalls).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-weather-fallback')).toBe('rainviewer');
    expect(res.headers.get('x-weather-snapshot')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
  });

  test('an explicitly requested snapshot is not stepped back', async () => {
    tileReply = () => missing();
    const { res } = await tile('clouds', `&snapshot=${LATEST - 600}`);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST - 600]);
    expect(res.headers.get('x-weather-error')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a clamped snapshot is proxy-derived, so it can step back', async () => {
    tileReply = (call) => (call.snapshot === LATEST ? missing() : defaultTileReply());
    const { res } = await tile('clouds', `&snapshot=${LATEST + 600}`);
    expect(tileCalls.map((c) => c.snapshot)).toEqual([LATEST, LATEST - 600]);
    expect(snapshotOf(res as any)).toBe(LATEST - 600);
  });

  test('the older tile is cached under the requested snapshot for a short time', async () => {
    tileReply = (call) => (call.snapshot === LATEST ? missing() : defaultTileReply());
    await tile('clouds');
    const calls = tileCalls.length;
    const again = await tile('clouds');
    expect(tileCalls).toHaveLength(calls);
    expect(snapshotOf(again.res as any)).toBe(LATEST - 600);
    expect(again.res.headers.get('cache-control')).toBe('public, max-age=30');

    // After the short cache lifetime the newest snapshot is tried again
    nowMs += 61_000;
    snapshotReply = defaultSnapshotReply;
    tileReply = defaultTileReply;
    const recovered = await tile('clouds');
    expect(snapshotOf(recovered.res as any)).toBe(LATEST);
    expect(recovered.res.headers.get('cache-control')).toBe('public, max-age=600');
  });

  test('401 does not step back (existing retry handling and placeholder are kept)', async () => {
    tileReply = () => new Response('no', { status: 401 });
    const { res } = await tile('clouds');
    expect(new Set(tileCalls.map((c) => c.snapshot))).toEqual(new Set([LATEST]));
    expect(tileCalls).toHaveLength(3);
    expect(res.headers.get('x-weather-error')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  }, 20000);

  test('403 does not step back', async () => {
    tileReply = () => new Response('no', { status: 403 });
    const { res } = await tile('radars');
    expect(new Set(tileCalls.map((c) => c.snapshot))).toEqual(new Set([LATEST]));
    expect(res.headers.get('x-weather-error')).toBe('1');
  }, 20000);

  test('429 does not step back', async () => {
    tileReply = () => new Response('slow down', { status: 429 });
    const { res } = await tile('clouds');
    expect(new Set(tileCalls.map((c) => c.snapshot))).toEqual(new Set([LATEST]));
    expect(tileCalls).toHaveLength(3);
    expect(res.headers.get('x-weather-error')).toBe('1');
  }, 20000);

  test('5xx does not step back, and precip still falls back to RainViewer', async () => {
    tileReply = () => new Response('bad gateway', { status: 502 });
    const clouds = await tile('clouds');
    expect(new Set(tileCalls.map((c) => c.snapshot))).toEqual(new Set([LATEST]));
    expect(tileCalls).toHaveLength(3);
    expect(clouds.res.headers.get('x-weather-error')).toBe('1');

    tileCalls = [];
    const precip = await tile('precip', '', '3/4/1');
    expect(new Set(tileCalls.map((c) => c.snapshot))).toEqual(new Set([LATEST]));
    expect(precip.res.headers.get('x-weather-fallback')).toBe('rainviewer');
  }, 30000);
});

describe('response headers and content types', () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const UNKNOWN = Buffer.from('definitely not an image');

  test.each([
    ['PNG', PNG, 'image/png'],
    ['WebP', WEBP, 'image/webp'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['unknown bytes', UNKNOWN, 'image/png']
  ])('Content-Type follows the body bytes: %s', async (_name, bytes, expected) => {
    tileReply = () => new Response(bytes, { status: 200 });
    const { res, body } = await tile('clouds');
    expect(res.headers.get('content-type')).toBe(expected);
    expect(body.equals(bytes as Buffer)).toBe(true); // never transcoded
  });

  test('a RainViewer tile is still image/png', async () => {
    const { res } = await get('/weather-radar/3/4/5.png?provider=rainviewer');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('the transparent placeholder is image/png', async () => {
    tileReply = () => missing();
    const { res } = await tile('clouds');
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  test('an upscaled clouds tile from a WebP source is labelled by its real PNG bytes', async () => {
    const webp256 = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).webp().toBuffer();
    tileReply = () => new Response(webp256, { status: 200 });
    const { res, body } = await tile('clouds', '', '8/10/10');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(body.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(tileCalls[0].url).toContain('/clouds/');
    expect(snapshotOf(res as any)).toBe(LATEST);
  });

  test('tiles keep provider/layer headers and expose the weather headers to browsers', async () => {
    const { res } = await tile('radars');
    expect(res.headers.get('x-weather-provider')).toBe('rainbow');
    expect(res.headers.get('x-weather-layer')).toBe('radars');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toBe('X-Weather-Snapshot, X-Weather-Fallback, X-Weather-Error');
    expect(res.headers.get('x-content-type-options')).toBeNull();
  });
});

describe('GET /weather-radar/snapshot', () => {
  test('requires an API key', async () => {
    const { res } = await get('/weather-radar/snapshot?layer=precip');
    expect(res.status).toBe(401);
    expect(snapshotCalls).toHaveLength(0);
  });

  test('rejects unknown, disabled and wrong-provider keys', async () => {
    expect((await get('/weather-radar/snapshot?api=nope')).res.status).toBe(401);
    expect((await get('/weather-radar/snapshot?api=off-key')).res.status).toBe(401);
    expect((await get('/weather-radar/snapshot?api=viewer-key')).res.status).toBe(403);
    expect(snapshotCalls).toHaveLength(0);
  });

  test('accepts the key parameter as well as api', async () => {
    const { res } = await get('/weather-radar/snapshot?key=good-key');
    expect(res.status).toBe(200);
  });

  test('rejects an unknown layer', async () => {
    const { res } = await get('/weather-radar/snapshot?layer=snow&api=good-key');
    expect(res.status).toBe(400);
  });

  test('returns the layer snapshot from Rainbow.ai', async () => {
    const { res, body } = await get('/weather-radar/snapshot?layer=clouds&api=good-key');
    expect(res.status).toBe(200);
    expect(JSON.parse(body.toString())).toEqual({ layer: 'clouds', snapshot: LATEST, stepSeconds: 600, source: 'rainbow' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('defaults to the precip layer', async () => {
    const { body } = await get('/weather-radar/snapshot?api=good-key');
    expect(JSON.parse(body.toString()).layer).toBe('precip');
    expect(snapshotCalls[0].layer).toBe('precip');
  });

  test('shares the snapshot cache with tiles', async () => {
    await get('/weather-radar/snapshot?layer=precip&api=good-key');
    await tile('precip');
    expect(snapshotCalls).toHaveLength(1);
  });

  test('applies the per-key rate limit', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await get('/weather-radar/snapshot?api=limited-key')).res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('is documented in the health output', async () => {
    const { body } = await get('/weather-radar/health');
    const health = JSON.parse(body.toString());
    expect(health.supported_parameters.snapshot).toBeDefined();
    expect(health.endpoints.snapshot).toContain('/weather-radar/snapshot');
  });
});
