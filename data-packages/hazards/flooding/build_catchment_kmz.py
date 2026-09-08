#!/usr/bin/env python3
"""
build_catchment_kmz.py
----------------------
Merge per-catchment footprint GeoJSONs (each tagged with Region/Catchment/Label)
into one styled KML and zip it to a KMZ. Each catchment renders as:

  - a thin outline polygon (its data-coverage footprint), and
  - a labelled point at the centroid showing "<Region> - <Catchment>",

so the layer works as a name locator for flood-map catchments.

Usage:
    build_catchment_kmz.py --footprints-dir <dir> --out <out.kmz>
                           [--simplify-deg 0.0005] [--doc-name NAME]
"""
import argparse
import glob
import json
import os
import subprocess
import zipfile


OUTLINE_RGB = (255, 140, 0)   # orange outline
LABEL_RGB = (255, 255, 255)


def kml_color(rgb, alpha):
    r, g, b = rgb
    return f"{alpha:02x}{b:02x}{g:02x}{r:02x}"


def xml_escape(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _ring(coords):
    pts = " ".join(f"{c[0]},{c[1]}" for c in coords)
    return f"<LinearRing><coordinates>{pts}</coordinates></LinearRing>"


def _polygon(rings):
    parts = [f"<outerBoundaryIs>{_ring(rings[0])}</outerBoundaryIs>"]
    for hole in rings[1:]:
        parts.append(f"<innerBoundaryIs>{_ring(hole)}</innerBoundaryIs>")
    return "<Polygon>" + "".join(parts) + "</Polygon>"


def geom_to_kml(geom):
    t = geom.get("type"); c = geom.get("coordinates")
    if t == "Polygon":
        return _polygon(c)
    if t == "MultiPolygon":
        return "<MultiGeometry>" + "".join(_polygon(p) for p in c) + "</MultiGeometry>"
    return ""


def centroid(geom):
    """Rough centroid = average of all outer-ring vertices."""
    pts = []
    t = geom.get("type"); c = geom.get("coordinates")
    polys = c if t == "MultiPolygon" else [c] if t == "Polygon" else []
    for poly in polys:
        if poly and poly[0]:
            pts.extend(poly[0])
    if not pts:
        return None
    return [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]


def simplify_geojson(path, tol):
    """Simplify one footprint file in place via ogr2ogr."""
    if tol <= 0:
        return path
    out = path + ".simp.geojson"
    subprocess.run(["ogr2ogr", "-f", "GeoJSON", "-simplify", str(tol), out, path],
                   check=True, stderr=subprocess.DEVNULL)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--footprints-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--simplify-deg", type=float, default=0.0005)
    ap.add_argument("--doc-name", default="NZ Flood Map Catchments")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.footprints_dir, "*.geojson")))
    files = [f for f in files if not f.endswith(".simp.geojson")]

    out = []
    out.append('<?xml version="1.0" encoding="UTF-8"?>')
    out.append('<kml xmlns="http://www.opengis.net/kml/2.2">')
    out.append("<Document>")
    out.append(f"<name>{xml_escape(args.doc_name)}</name>")
    out.append(f'<Style id="catchment">'
               f"<LineStyle><color>{kml_color(OUTLINE_RGB, 0xCC)}</color><width>2</width></LineStyle>"
               f"<PolyStyle><color>{kml_color(OUTLINE_RGB, 0x22)}</color></PolyStyle>"
               f"<BalloonStyle><text>$[description]</text></BalloonStyle>"
               f"</Style>")
    out.append(f'<Style id="catchment_label">'
               f"<IconStyle><scale>0.6</scale></IconStyle>"
               f"<LabelStyle><color>{kml_color(LABEL_RGB, 0xFF)}</color></LabelStyle>"
               f"</Style>")

    count = 0
    for path in files:
        sp = simplify_geojson(path, args.simplify_deg)
        d = json.load(open(sp))
        for f in d.get("features", []):
            geom = f.get("geometry")
            props = f.get("properties") or {}
            label = props.get("Label") or props.get("Catchment") or "Catchment"
            if not geom:
                continue
            # Outline polygon
            out.append("<Placemark>")
            out.append(f"<name>{xml_escape(label)}</name>")
            out.append("<styleUrl>#catchment</styleUrl>")
            out.append(geom_to_kml(geom))
            out.append("</Placemark>")
            # Labelled centroid point
            ctr = centroid(geom)
            if ctr:
                out.append("<Placemark>")
                out.append(f"<name>{xml_escape(label)}</name>")
                out.append("<styleUrl>#catchment_label</styleUrl>")
                out.append(f"<Point><coordinates>{ctr[0]},{ctr[1]}</coordinates></Point>")
                out.append("</Placemark>")
            count += 1

    out.append("</Document></kml>")
    kml_path = args.out + ".doc.kml"
    with open(kml_path, "w") as fh:
        fh.write("\n".join(out))

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(kml_path, arcname="doc.kml")
    os.remove(kml_path)
    print(f"  Catchments: {count}")
    print(f"  Wrote {args.out} ({os.path.getsize(args.out):,} bytes)")


if __name__ == "__main__":
    main()
