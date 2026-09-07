#!/usr/bin/env python3
"""
build_kmz.py
------------
Fetch the NEMA "Aotearoa Tsunami Evacuation Zones" ArcGIS feature layer, simplify
the geometry, style each feature by its evacuation zone class using the official
NEMA colours, and write a single styled KMZ suitable for import into ATAK/CloudTAK.

The source is a national dataset (one layer, ~3,500 polygon features) with a
`Zones` attribute (Red / Orange / Yellow / Purple / Blue Inundation, plus a few
region-specific classes). Geometry is high resolution, so it is simplified to a
tolerance that keeps map-scale fidelity while shrinking the file by ~an order of
magnitude.

Pipeline:
  1. Page through the layer as ESRI JSON (returnGeometry, outSR=4326).
  2. Convert + merge to one GeoJSON via ogr2ogr, simplifying in the same step.
  3. Emit a styled KML (one shared Style per zone class) and zip it to KMZ.

Usage:
    python3 build_kmz.py --source-url <FeatureServer/layer> --out <out.kmz>
                         [--simplify-deg 0.0001] [--work <dir>] [--keep-work]

Requires: requests, GDAL/ogr2ogr, zip (via Python zipfile).
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import zipfile


# ---------------------------------------------------------------------------
# Official NEMA zone colours (from the ArcGIS layer's uniqueValue renderer),
# as (R, G, B). Fill is drawn semi-transparent; outline is a darker opaque line.
# KML colours are aabbggrr (alpha, blue, green, red) hex.
# ---------------------------------------------------------------------------
ZONE_RGB = {
    "Red":                       (255,   0,   0),
    "Orange":                    (255, 170,   0),
    "Yellow":                    (255, 255,   0),
    "Purple":                    (169,   0, 230),
    "Blue Inundation":           (115, 223, 255),
    # Region-specific / non-standard classes seen in the data — reasonable
    # fallbacks so every feature still renders meaningfully.
    "Marine":                    ( 20, 120, 220),
    "Blue":                      (115, 223, 255),
    "Inland":                    (255, 235,  60),
    "Outside Inland":            (200, 200, 200),
    "Between Inundation and Safe": (255, 210,  90),
    "Safe":                      (120, 200, 120),
    "Undetermined":              (160, 160, 160),
}
DEFAULT_RGB = (150, 150, 150)
FILL_ALPHA = 0x66      # ~40% opaque fill
LINE_ALPHA = 0xCC      # mostly opaque outline


def kml_color(rgb, alpha):
    r, g, b = rgb
    return f"{alpha:02x}{b:02x}{g:02x}{r:02x}"


def fetch_count(source_url: str, where: str = "1=1") -> int:
    import requests
    r = requests.get(f"{source_url}/query",
                     params={"where": where, "returnCountOnly": "true", "f": "json"},
                     timeout=60)
    r.raise_for_status()
    return int(r.json()["count"])


def fetch_pages(source_url: str, fields: str, work: str, where: str = "1=1",
                page: int = 250) -> int:
    """Page through the layer as ESRI JSON, writing one file per page."""
    import requests
    total = fetch_count(source_url, where)
    print(f"  Source features (where {where}): {total}")
    off = 0
    while off < total:
        params = {
            "where": where,
            "outFields": fields,
            "outSR": "4326",
            "resultOffset": off,
            "resultRecordCount": page,
            "f": "json",
        }
        r = requests.get(f"{source_url}/query", params=params, timeout=300)
        r.raise_for_status()
        data = r.json()
        n = len(data.get("features", []))
        with open(os.path.join(work, f"p_{off:06d}.json"), "w") as fh:
            json.dump(data, fh)
        print(f"    offset {off}: {n} features")
        off += page
    return total


def pages_to_geojson(work: str, simplify_deg: float) -> str:
    """Convert each ESRI JSON page to (simplified) GeoJSON and merge into one."""
    merged = os.path.join(work, "merged.geojson")
    feats = []
    for p in sorted(glob.glob(os.path.join(work, "p_*.json"))):
        g = p[:-5] + ".geojson"
        cmd = ["ogr2ogr", "-f", "GeoJSON"]
        if simplify_deg > 0:
            cmd += ["-simplify", str(simplify_deg)]
        cmd += [g, f"ESRIJSON:{p}"]
        subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL)
        with open(g) as fh:
            feats += json.load(fh).get("features", [])
    with open(merged, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)
    print(f"  Merged + simplified features: {len(feats)}")
    return merged


def write_styled_kml(geojson_path: str, kml_path: str, doc_name: str) -> int:
    """Emit a KML with one shared Style per zone class, keyed on `Zones`."""
    with open(geojson_path) as fh:
        fc = json.load(fh)
    features = fc.get("features", [])

    # Collect the zone classes actually present, so we only emit needed styles.
    zones_present = sorted({(f.get("properties") or {}).get("Zones") or "Undetermined"
                            for f in features})

    def style_id(zone: str) -> str:
        return "z_" + "".join(ch if ch.isalnum() else "_" for ch in zone)

    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<kml xmlns="http://www.opengis.net/kml/2.2">')
    out.append("<Document>")
    out.append(f"<name>{xml_escape(doc_name)}</name>")

    # Styles
    for zone in zones_present:
        rgb = ZONE_RGB.get(zone, DEFAULT_RGB)
        sid = style_id(zone)
        out.append(f'<Style id="{sid}">')
        out.append(f"<LineStyle><color>{kml_color(rgb, LINE_ALPHA)}</color><width>1</width></LineStyle>")
        out.append(f"<PolyStyle><color>{kml_color(rgb, FILL_ALPHA)}</color></PolyStyle>")
        out.append("</Style>")

    # Placemarks
    for f in features:
        props = f.get("properties") or {}
        geom = f.get("geometry")
        if not geom:
            continue
        zone = props.get("Zones") or "Undetermined"
        region = props.get("Region") or ""
        name = f"{region} — {zone}".strip(" —")
        desc_bits = []
        for k in ("E_Action", "Message1", "Message2", "Source", "URLPrepare"):
            v = props.get(k)
            if v:
                desc_bits.append(f"{k}: {v}")
        out.append("<Placemark>")
        out.append(f"<name>{xml_escape(name)}</name>")
        if desc_bits:
            out.append(f"<description>{xml_escape(chr(10).join(desc_bits))}</description>")
        out.append(f"<styleUrl>#{style_id(zone)}</styleUrl>")
        out.append(geojson_geom_to_kml(geom))
        out.append("</Placemark>")

    out.append("</Document></kml>")
    with open(kml_path, "w") as fh:
        fh.write("\n".join(out))
    return len(features)


def xml_escape(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _ring(coords) -> str:
    pts = " ".join(f"{c[0]},{c[1]}" for c in coords)
    return ("<LinearRing><coordinates>" + pts + "</coordinates></LinearRing>")


def _polygon(rings) -> str:
    parts = [f"<outerBoundaryIs>{_ring(rings[0])}</outerBoundaryIs>"]
    for hole in rings[1:]:
        parts.append(f"<innerBoundaryIs>{_ring(hole)}</innerBoundaryIs>")
    return "<Polygon>" + "".join(parts) + "</Polygon>"


def geojson_geom_to_kml(geom: dict) -> str:
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Polygon":
        return _polygon(c)
    if t == "MultiPolygon":
        return "<MultiGeometry>" + "".join(_polygon(poly) for poly in c) + "</MultiGeometry>"
    if t == "Point":
        return f"<Point><coordinates>{c[0]},{c[1]}</coordinates></Point>"
    # Fallback: skip unsupported geometry types quietly.
    return ""


def zip_kmz(kml_path: str, kmz_path: str) -> None:
    # KMZ = zip containing doc.kml
    with zipfile.ZipFile(kmz_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(kml_path, arcname="doc.kml")


def main():
    ap = argparse.ArgumentParser(description="Build a styled tsunami evacuation-zone KMZ from the NEMA layer.")
    ap.add_argument("--source-url", required=True, help="ArcGIS FeatureServer layer URL")
    ap.add_argument("--out", required=True, help="Output KMZ path")
    ap.add_argument("--simplify-deg", type=float, default=0.0001,
                    help="Geometry simplify tolerance in degrees (~11m at 0.0001). 0 to disable.")
    ap.add_argument("--where", default="Zones IN ('Red','Orange','Yellow','Purple','Blue Inundation')",
                    help="ArcGIS where clause. Defaults to the real evacuation-zone classes only, "
                         "excluding the large non-evacuation background polygons (Inland, Marine, "
                         "Undetermined, Outside Inland, Safe, etc.). Use \"1=1\" for everything.")
    ap.add_argument("--work", default=None, help="Work dir (default: <out>.work)")
    ap.add_argument("--keep-work", action="store_true", help="Keep intermediate files")
    ap.add_argument("--doc-name", default="NZ Tsunami Evacuation Zones")
    args = ap.parse_args()

    work = args.work or (args.out + ".work")
    os.makedirs(work, exist_ok=True)

    fields = "Region,Zones,Source,E_Action,Message1,Message2,URLPrepare"
    print("[1/4] Fetching source features …")
    fetch_pages(args.source_url, fields, work, where=args.where)

    print("[2/4] Converting + simplifying …")
    merged = pages_to_geojson(work, args.simplify_deg)

    print("[3/4] Writing styled KML …")
    kml = os.path.join(work, "doc.kml")
    n = write_styled_kml(merged, kml, args.doc_name)
    print(f"  Placemarks: {n}")

    print("[4/4] Zipping KMZ …")
    zip_kmz(kml, args.out)
    print(f"  Wrote {args.out} ({os.path.getsize(args.out):,} bytes)")

    if not args.keep_work:
        for p in glob.glob(os.path.join(work, "*")):
            os.remove(p)
        os.rmdir(work)
        print("  Cleaned work dir.")


if __name__ == "__main__":
    main()
