#!/usr/bin/env python3
"""Proof of concept: Render LINZ vector tiles to raster using Playwright + MapLibre GL JS.

Serves vector tiles from a local mbtiles file, renders them in a headless browser
using MapLibre GL JS with the LINZ topographic style, and saves the output as
mbtiles and pmtiles.

Usage:
    python3 render-vector-tiles.py \
        --vector-mbtiles /tmp/topographic-v2.mbtiles \
        --api-key YOUR_LINZ_KEY \
        --bbox 174.5,-41.6,176.0,-40.7 \
        --min-zoom 12 --max-zoom 12 \
        --output /tmp/wellington-topographic-test.mbtiles

Prerequisites:
    pip install pmtiles
    npx playwright install chromium
"""

import argparse
import gzip
import http.server
import json
import math
import os
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RENDER_HTML = os.path.join(SCRIPT_DIR, "render-tile.html")
DEFAULT_TILE_SIZE = 256


class VectorTileServer(http.server.HTTPServer):
    """Local HTTP server that serves vector tiles from mbtiles + style JSON."""

    def __init__(self, mbtiles_path, style_json, port=9999):
        self.mbtiles_path = mbtiles_path
        self.style_json = style_json
        self.tile_db = sqlite3.connect(mbtiles_path, check_same_thread=False)
        super().__init__(("127.0.0.1", port), VectorTileHandler)


class VectorTileHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write(f"[server] {args[0]}\n")  # Log requests for debugging

    def do_GET(self):
        if self.path == "/style.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(self.server.style_json).encode())

        elif self.path.startswith("/tiles/"):
            # /tiles/{z}/{x}/{y}.pbf
            parts = self.path.replace("/tiles/", "").replace(".pbf", "").split("/")
            if len(parts) == 3:
                z, x, y = int(parts[0]), int(parts[1]), int(parts[2])
                tms_y = (2 ** z - 1) - y
                row = self.server.tile_db.execute(
                    "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                    (z, x, tms_y),
                ).fetchone()
                if row:
                    data = row[0]
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-protobuf")
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    # mbtiles stores gzipped PBF tiles
                    if data[:2] == b'\x1f\x8b':
                        self.wfile.write(data)
                    else:
                        self.wfile.write(gzip.compress(data))
                else:
                    self.send_response(204)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
            else:
                self.send_response(404)
                self.end_headers()

        elif self.path.startswith("/render-tile.html"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(RENDER_HTML, "rb") as f:
                self.wfile.write(f.read())

        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()


def build_local_style(api_key, vector_mbtiles=None):
    """Fetch the LINZ topographic-v2 style and optionally rewrite vector source to local server."""
    url = f"https://basemaps.linz.govt.nz/v1/styles/topographic-v2.json?api={api_key}"
    req = urllib.request.Request(url, headers={"User-Agent": "vector-renderer/1.0"})
    data = urllib.request.urlopen(req).read()
    style = json.loads(data)

    # If local mbtiles provided, rewrite vector source to local server
    if vector_mbtiles:
        for name, source in style.get("sources", {}).items():
            if source.get("type") == "vector":
                source.pop("url", None)
                source["tiles"] = ["http://localhost:9999/tiles/{z}/{x}/{y}.pbf"]
                source["minzoom"] = 0
                source["maxzoom"] = 15

    return style


def deg2num(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return (xtile, ytile)


def init_mbtiles(db_path, name, bbox, min_zoom, max_zoom, tile_size):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
    db.execute("CREATE UNIQUE INDEX tiles_idx ON tiles (zoom_level, tile_column, tile_row)")
    db.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
    db.execute("CREATE UNIQUE INDEX metadata_idx ON metadata (name)")
    for k, v in [
        ("name", name),
        ("format", "png"),
        ("bounds", ",".join(str(b) for b in bbox)),
        ("center", f"{(bbox[0]+bbox[2])/2},{(bbox[1]+bbox[3])/2},{min_zoom}"),
        ("minzoom", str(min_zoom)),
        ("maxzoom", str(max_zoom)),
        ("type", "baselayer"),
        ("description", f"{name} - LINZ Topographic rendered ({tile_size}px)"),
        ("attribution", "LINZ CC BY 4.0"),
        ("version", "1.3"),
    ]:
        db.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", (k, v))
    db.commit()
    return db


def render_tiles(mbtiles_path, api_key, bbox, min_zoom, max_zoom, output_path,
                 tile_size=256, name="NZ Topographic"):
    """Main rendering pipeline."""

    print("Fetching LINZ topographic style...")
    style = build_local_style(api_key, mbtiles_path)

    print("Starting local tile server...")
    server = VectorTileServer(mbtiles_path, style, port=9999)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    time.sleep(1)

    print("Initializing output mbtiles...")
    out_db = init_mbtiles(output_path, name, bbox, min_zoom, max_zoom, tile_size)

    # Count tiles
    total = 0
    for z in range(min_zoom, max_zoom + 1):
        x_min, y_min = deg2num(bbox[3], bbox[0], z)
        x_max, y_max = deg2num(bbox[1], bbox[2], z)
        total += (x_max - x_min + 1) * (y_max - y_min + 1)

    print(f"Rendering {total} tiles at z{min_zoom}-z{max_zoom}...")
    print("Launching headless browser...")

    # Use Playwright via subprocess to render tiles
    render_script = f"""
const {{ chromium }} = require('playwright');

(async () => {{
    const browser = await chromium.launch({{ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }});
    const context = await browser.newContext({{
        viewport: {{ width: 512, height: 512 }},
        deviceScaleFactor: 1,
    }});

    const page = await context.newPage();
    page.on('console', msg => process.stderr.write('BROWSER: ' + msg.type() + ' ' + msg.text() + String.fromCharCode(10)));
    page.on('pageerror', err => process.stderr.write('PAGE_ERR: ' + err.message + String.fromCharCode(10)));
    page.on('response', resp => {{ if (resp.status() >= 400) process.stderr.write('HTTP ' + resp.status() + ': ' + resp.url() + String.fromCharCode(10)); }});

    let rendered = 0;
    let failed = 0;
    const startTime = Date.now();

    const tiles = [];
    for (let z = {min_zoom}; z <= {max_zoom}; z++) {{
        const n = Math.pow(2, z);
        const xMin = Math.floor(({bbox[0]} + 180) / 360 * n);
        const xMax = Math.floor(({bbox[2]} + 180) / 360 * n);
        const yMinLat = {bbox[3]} * Math.PI / 180;
        const yMaxLat = {bbox[1]} * Math.PI / 180;
        const yMin = Math.floor((1 - Math.log(Math.tan(yMinLat) + 1/Math.cos(yMinLat)) / Math.PI) / 2 * n);
        const yMax = Math.floor((1 - Math.log(Math.tan(yMaxLat) + 1/Math.cos(yMaxLat)) / Math.PI) / 2 * n);
        for (let x = xMin; x <= xMax; x++) {{
            for (let y = yMin; y <= yMax; y++) {{
                tiles.push({{ z, x, y }});
            }}
        }}
    }}

    const total = tiles.length;

    for (const tile of tiles) {{
        const {{ z, x, y }} = tile;
        const url = `http://localhost:9999/render-tile.html?z=${{z}}&x=${{x}}&y=${{y}}&style=http://localhost:9999/style.json`;

        try {{
            await page.goto(url, {{ waitUntil: 'networkidle', timeout: 30000 }});

            // Wait for MapLibre to finish rendering, but capture anyway on timeout
            try {{
                await page.waitForFunction(() => window._tileRendered === true || window._tileError, {{ timeout: 15000 }});
            }} catch (waitErr) {{
                // Timeout - map may be partially rendered (e.g. missing elevation tiles)
                process.stderr.write(`\\nWarn z${{z}}/${{x}}/${{y}}: idle timeout, capturing anyway`);
            }}

            const error = await page.evaluate(() => window._tileError);
            if (error) {{
                process.stderr.write(`\\nWarn z${{z}}/${{x}}/${{y}}: ${{error}}`);
            }}

            // Screenshot the map container
            const screenshot = await page.screenshot({{ type: 'png' }});

            // Output tile as JSON line: z, x, y, base64 data
            const b64 = screenshot.toString('base64');
            process.stdout.write(JSON.stringify({{ z, x, y, data: b64 }}) + '\\n');
            rendered++;

            const elapsed = (Date.now() - startTime) / 1000;
            const rate = rendered / elapsed;
            const eta = (total - rendered - failed) / rate;
            process.stderr.write(`\\rz${{z}}: ${{rendered}}/${{total}} (${{failed}} failed, ${{rate.toFixed(1)}} t/s, ETA ${{(eta/60).toFixed(0)}}m)  `);
        }} catch (e) {{
            failed++;
            process.stderr.write(`\\nTimeout z${{z}}/${{x}}/${{y}}: ${{e.message}}`);
        }}
    }}

    process.stderr.write(`\\nDone: ${{rendered}} rendered, ${{failed}} failed\\n`);
    await browser.close();
}})();
"""

    # Write the render script
    script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_render.js")
    with open(script_path, "w") as f:
        f.write(render_script)

    # Run the render script and capture tile output
    import base64
    from PIL import Image
    import io

    proc = subprocess.Popen(
        ["node", script_path],
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        bufsize=1,
    )

    saved = 0
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            tile = json.loads(line)
            z, x, y = tile["z"], tile["x"], tile["y"]
            raw_data = base64.b64decode(tile["data"])

            # Downscale from 512px to tile_size (default 256px)
            if tile_size < 512:
                img = Image.open(io.BytesIO(raw_data))
                img = img.resize((tile_size, tile_size), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                data = buf.getvalue()
            else:
                data = raw_data

            tms_y = (2 ** z - 1) - y
            out_db.execute(
                "INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)",
                (z, x, tms_y, data),
            )
            saved += 1
            if saved % 100 == 0:
                out_db.commit()
        except (json.JSONDecodeError, KeyError) as e:
            print(f"\nFailed to parse tile output: {e}", file=sys.stderr)

    proc.wait()
    out_db.commit()
    out_db.close()

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nOutput: {output_path} ({size_mb:.1f} MB, {saved} tiles)")

    # Convert to pmtiles if requested
    pmtiles_path = output_path.replace(".mbtiles", ".pmtiles")
    print(f"\nConverting to pmtiles: {pmtiles_path}")
    try:
        subprocess.run(
            ["pmtiles", "convert", output_path, pmtiles_path],
            check=True, capture_output=True, text=True,
        )
        pm_size = os.path.getsize(pmtiles_path) / (1024 * 1024)
        print(f"Output: {pmtiles_path} ({pm_size:.1f} MB)")
    except FileNotFoundError:
        print("pmtiles CLI not found. Install with: pip install pmtiles")
        print("Or: go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest")
    except subprocess.CalledProcessError as e:
        print(f"pmtiles conversion failed: {e.stderr}")

    server.shutdown()


def main():
    parser = argparse.ArgumentParser(description="Render LINZ vector tiles to raster mbtiles + pmtiles")
    parser.add_argument("--vector-mbtiles", help="Path to LINZ vector tiles mbtiles (optional, fetches from LINZ if not provided)")
    parser.add_argument("--api-key", required=True, help="LINZ API key (for vector tiles, elevation, sprites, fonts)")
    parser.add_argument("--bbox", required=True, help="Bounding box: west,south,east,north")
    parser.add_argument("--min-zoom", type=int, default=12)
    parser.add_argument("--max-zoom", type=int, default=12)
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE, choices=[256, 512])
    parser.add_argument("--output", required=True, help="Output mbtiles path")
    parser.add_argument("--name", default="NZ Topographic", help="Map name")
    args = parser.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox) != 4:
        parser.error("--bbox must have 4 values: west,south,east,north")

    render_tiles(
        args.vector_mbtiles, args.api_key, bbox,
        args.min_zoom, args.max_zoom, args.output,
        args.tile_size, args.name,
    )


if __name__ == "__main__":
    main()
