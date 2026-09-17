#!/usr/bin/env python3
"""
build_kmz.py
------------
Builds a KMZ of GeoNet volcano camera locations from the GeoNet cameras API.

The KMZ contains one Placemark per volcano camera with:
  - Camera location at actual altitude (absolute altitude mode)
  - NZEM CCTV camera icon (bundled inside the KMZ)
  - Popup description with inline live image, metadata, and GeoNet link

The camera images are referenced by URL -- ATAK and Google Earth fetch the
current image from GeoNet at display time, so the KMZ only needs to be
regenerated when cameras are added, moved, or removed.

Usage:
    python3 build_kmz.py --out GeoNet-Volcano-Cameras.kmz

Requires: Python 3.9+ standard library only (json, zipfile, urllib).
"""

import argparse
import json
import sys
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

CAMERAS_URL = "https://images.geonet.org.nz/volcano/cameras/all.json"
IMAGE_BASE = "https://images.geonet.org.nz/volcano/cameras/"
GEONET_BASE = "https://www.geonet.org.nz/volcano/cameras/"

ICON_URL = (
    "https://raw.githubusercontent.com/TAK-NZ/iconset-nzem-symbology"
    "/main/source/Infrastructure/INF.21.CameraCCTV.png"
)
ICON_FILE = "INF.21.CameraCCTV.png"  # name inside the KMZ


def fetch_cameras(source_url: str) -> list[dict]:
    """Fetch + flatten the GeoNet camera list.

    The API returns a list of FeatureCollections grouped by volcano.
    Deduplicate by camera id (some cameras appear under multiple volcanoes).
    """
    print(f"[1/3] Fetching camera list from {source_url} ...")
    with urllib.request.urlopen(source_url) as resp:
        raw = json.load(resp)

    seen = set()
    cameras = []
    for group in raw:
        for feat in group["features"]:
            cid = feat["id"]
            if cid in seen:
                continue
            seen.add(cid)

            # Coordinates are [lat, lon] -- swap to KML order [lon, lat]
            lat, lon = feat["geometry"]["coordinates"]
            p = feat["properties"]

            cameras.append({
                "id": cid,
                "title": p["title"].replace("&", "&amp;"),
                "volcano": ", ".join(feat.get("volcano-title", [])).replace("&", "&amp;"),
                "lat": lat,
                "lon": lon,
                "height": p.get("height", 0),
                "azimuth": p.get("azimuth", 0),
                "thumb": IMAGE_BASE + p["latest-image-thumb"],
                "medium": IMAGE_BASE + p["latest-image-medium"],
                "large": IMAGE_BASE + p["latest-image-large"],
                "link": GEONET_BASE + cid,
            })

    print(f"  {len(cameras)} cameras found")
    return cameras


def placemark(cam: dict) -> str:
    return f"""  <Placemark>
    <name>{cam["title"]}</name>
    <description><![CDATA[
<b>{cam["title"]}</b><br/>
<img src="{cam["medium"]}" width="320" height="240"/><br/><br/>
<b>Volcano:</b> {cam["volcano"]}<br/>
<b>Azimuth:</b> {cam["azimuth"]}&deg;<br/>
<b>Height:</b> {cam["height"]} m<br/><br/>
<a href="{cam["link"]}">View on GeoNet &rarr;</a>
    ]]></description>
    <Style>
      <IconStyle>
        <color>FFD3B5D1</color>
        <Icon>
          <href>{ICON_FILE}</href>
        </Icon>
        <hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>
      </IconStyle>
      <LabelStyle>
        <color>ffffffff</color>
        <scale>0.8</scale>
      </LabelStyle>
    </Style>
    <Point>
      <altitudeMode>absolute</altitudeMode>
      <coordinates>{cam["lon"]},{cam["lat"]},{cam["height"]}</coordinates>
    </Point>
  </Placemark>"""


def build_kml(cameras: list[dict], doc_name: str) -> str:
    placemarks = "\n".join(placemark(c) for c in cameras)
    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{doc_name}</name>
    <description>Live volcano camera locations from GeoNet New Zealand.
Tap a marker to see the latest camera image and link to the full feed.
Source: https://www.geonet.org.nz/volcano/cameras</description>
    <visibility>1</visibility>
    <open>1</open>
{placemarks}
  </Document>
</kml>"""
    ET.fromstring(kml)  # validate XML, raises if malformed
    return kml


def fetch_icon(icon_url: str) -> bytes:
    print(f"[2/3] Fetching icon from {icon_url} ...")
    with urllib.request.urlopen(icon_url) as resp:
        data = resp.read()
    print(f"  Icon: {len(data):,} bytes")
    return data


def write_kmz(kml: str, icon_data: bytes, out: Path) -> None:
    print("[3/3] Writing KMZ ...")
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("doc.kml", kml)
        zf.writestr(ICON_FILE, icon_data)
    print(f"  Wrote {out} ({out.stat().st_size:,} bytes)")


def main():
    ap = argparse.ArgumentParser(description="Build the GeoNet volcano cameras KMZ.")
    ap.add_argument("--source-url", default=CAMERAS_URL, help="GeoNet cameras API URL")
    ap.add_argument("--icon-url", default=ICON_URL, help="CCTV camera icon URL")
    ap.add_argument("--out", required=True, help="Output KMZ path")
    ap.add_argument("--doc-name", default="GeoNet Volcano Cameras", help="KML document name")
    args = ap.parse_args()

    cameras = fetch_cameras(args.source_url)
    if not cameras:
        print("ERROR: no cameras found in source feed.", file=sys.stderr)
        sys.exit(1)

    kml = build_kml(cameras, args.doc_name)
    icon_data = fetch_icon(args.icon_url)
    write_kmz(kml, icon_data, Path(args.out))

    print("\nCameras:")
    for c in cameras:
        print(f"  {c['id']:40}  {c['title']}")


if __name__ == "__main__":
    main()
