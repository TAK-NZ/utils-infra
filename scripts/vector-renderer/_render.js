
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({
        viewport: { width: 512, height: 512 },
        deviceScaleFactor: 1,
    });

    const page = await context.newPage();
    page.on('console', msg => process.stderr.write('BROWSER: ' + msg.type() + ' ' + msg.text() + String.fromCharCode(10)));
    page.on('pageerror', err => process.stderr.write('PAGE_ERR: ' + err.message + String.fromCharCode(10)));
    page.on('response', resp => { if (resp.status() >= 400) process.stderr.write('HTTP ' + resp.status() + ': ' + resp.url() + String.fromCharCode(10)); });

    let rendered = 0;
    let failed = 0;
    const startTime = Date.now();

    const tiles = [];
    for (let z = 4; z <= 14; z++) {
        const n = Math.pow(2, z);
        const xMin = Math.floor((-177.5 + 180) / 360 * n);
        const xMax = Math.floor((-175.4 + 180) / 360 * n);
        const yMinLat = -43.2 * Math.PI / 180;
        const yMaxLat = -44.8 * Math.PI / 180;
        const yMin = Math.floor((1 - Math.log(Math.tan(yMinLat) + 1/Math.cos(yMinLat)) / Math.PI) / 2 * n);
        const yMax = Math.floor((1 - Math.log(Math.tan(yMaxLat) + 1/Math.cos(yMaxLat)) / Math.PI) / 2 * n);
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                tiles.push({ z, x, y });
            }
        }
    }

    const total = tiles.length;

    for (const tile of tiles) {
        const { z, x, y } = tile;
        const url = `http://localhost:9999/render-tile.html?z=${z}&x=${x}&y=${y}&style=http://localhost:9999/style.json`;

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

            // Wait for MapLibre to finish rendering, but capture anyway on timeout
            try {
                await page.waitForFunction(() => window._tileRendered === true || window._tileError, { timeout: 15000 });
            } catch (waitErr) {
                // Timeout - map may be partially rendered (e.g. missing elevation tiles)
                process.stderr.write(`\nWarn z${z}/${x}/${y}: idle timeout, capturing anyway`);
            }

            const error = await page.evaluate(() => window._tileError);
            if (error) {
                process.stderr.write(`\nWarn z${z}/${x}/${y}: ${error}`);
            }

            // Screenshot the map container
            const screenshot = await page.screenshot({ type: 'png' });

            // Output tile as JSON line: z, x, y, base64 data
            const b64 = screenshot.toString('base64');
            process.stdout.write(JSON.stringify({ z, x, y, data: b64 }) + '\n');
            rendered++;

            const elapsed = (Date.now() - startTime) / 1000;
            const rate = rendered / elapsed;
            const eta = (total - rendered - failed) / rate;
            process.stderr.write(`\rz${z}: ${rendered}/${total} (${failed} failed, ${rate.toFixed(1)} t/s, ETA ${(eta/60).toFixed(0)}m)  `);
        } catch (e) {
            failed++;
            process.stderr.write(`\nTimeout z${z}/${x}/${y}: ${e.message}`);
        }
    }

    process.stderr.write(`\nDone: ${rendered} rendered, ${failed} failed\n`);
    await browser.close();
})();
