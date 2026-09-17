#!/usr/bin/env python3
"""
build_kmz.py
------------
Builds a KMZ of Automated External Defibrillator (AED) locations in New
Zealand, sourced from https://aedlocations.co.nz (via an unauthenticated
MapMySites API endpoint discovered by inspecting the site's JS bundle).

The KMZ contains one Placemark per AED with:
  - AED location (clamped to ground, no altitude data available)
  - AED icon (bundled inside the KMZ, from aed.png)
  - Popup description with address and 24/7 availability

STATUS: pending Abletech approval for redistribution
------------------------------------------------------
This pulls from an undocumented, reverse-engineered API with no published
terms of use. Do NOT wire this into a scheduled job until Abletech (the
site's operator) has agreed to this data being polled and redistributed via
TAK. See the README in this directory for the current approval status.

Because AED install locations rarely change, the intended cadence (once
approved and scheduled) would be weekly -- not real-time.

Usage:
    python3 build_kmz.py --out AED-Locations.kmz

Requires: Python 3.9+ standard library only (json, zipfile, urllib).
"""

import argparse
import json
import sys
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

# bounds = south_lat,west_lng,north_lat,east_lng -- covers mainland NZ + Stewart Island
VIEWPORT_URL = (
    "https://mapmysites.com/api/aed/locations/viewport.geojson"
    "?bounds=-47.5,166.0,-34.0,178.6"
)

ICON_FILE = "aed.png"  # name inside the KMZ
STYLE_ID = "aedIcon"  # shared Style id, referenced by every Placemark

USER_AGENT = "Mozilla/5.0 (TAK.NZ; contact chris@elsen.nz)"


def fetch_aeds(source_url: str) -> list[dict]:
    print(f"[1/3] Fetching AED locations from {source_url} ...")
    req = urllib.request.Request(source_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = json.load(resp)

    features = raw.get("features", [])
    print(f"  {len(features)} AEDs found")

    aeds = []
    for feat in features:
        props = feat.get("properties", {})
        lon, lat = feat["geometry"]["coordinates"]
        aeds.append({
            "id": props.get("id"),
            "name": (props.get("name") or "Unnamed AED").strip(),
            "address": (props.get("physical_address") or "").strip(),
            "available": bool(props.get("available_24_7")),
            "lat": lat,
            "lon": lon,
        })
    return aeds


def placemark(aed: dict) -> str:
    availability = "Available 24/7" if aed["available"] else "Limited or unknown hours"
    # NOTE: this text is embedded inside a CDATA section below, where XML
    # entities are NOT parsed. Do not run escape() on it, or literal
    # ampersands etc. will render as "&amp;" in the popup instead of "&".
    description = (
        f"<b>{aed['name']}</b><br/>"
        f"{aed['address']}<br/><br/>"
        f"<b>Availability:</b> {availability}<br/>"
        f"<i>Source: aedlocations.co.nz (AED id {aed['id']})</i>"
    )
    return f"""  <Placemark>
    <name>{escape(aed["name"])}</name>
    <description><![CDATA[{description}]]></description>
    <styleUrl>#{STYLE_ID}</styleUrl>
    <Point>
      <altitudeMode>clampToGround</altitudeMode>
      <coordinates>{aed["lon"]},{aed["lat"]},0</coordinates>
    </Point>
  </Placemark>"""


def build_kml(aeds: list[dict], doc_name: str) -> str:
    placemarks = "\n".join(placemark(a) for a in aeds)

    # A single shared Style, referenced by every Placemark via styleUrl.
    # Defining one inline <Style> per placemark (17,000+ of them) is what
    # broke rendering in Google Earth: it silently falls back to default
    # markers and the popup/balloon system once the unique-style count gets
    # too high. A shared style keeps the KML small and renders reliably.
    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{doc_name}</name>
    <description>Automated External Defibrillator (AED) locations in New Zealand.
Sourced from aedlocations.co.nz. Presence of a marker does not guarantee the
AED is present, working, or publicly accessible.
Source: https://aedlocations.co.nz</description>
    <visibility>1</visibility>
    <open>0</open>
    <Style id="{STYLE_ID}">
      <IconStyle>
        <Icon>
          <href>{ICON_FILE}</href>
        </Icon>
        <hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>
      </IconStyle>
      <LabelStyle>
        <scale>0.8</scale>
      </LabelStyle>
    </Style>
{placemarks}
  </Document>
</kml>"""
    ET.fromstring(kml)  # validate XML, raises if malformed
    return kml


def write_kmz(kml: str, icon_path: Path, out: Path) -> None:
    print("[3/3] Writing KMZ ...")
    icon_data = icon_path.read_bytes()
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("doc.kml", kml)
        zf.writestr(ICON_FILE, icon_data)
    print(f"  Wrote {out} ({out.stat().st_size:,} bytes)")


def main():
    ap = argparse.ArgumentParser(description="Build the NZ AED locations KMZ.")
    ap.add_argument("--source-url", default=VIEWPORT_URL, help="AED viewport API URL")
    ap.add_argument("--icon", default=None,
                    help="Path to the AED icon PNG (default: aed.png next to this script)")
    ap.add_argument("--out", required=True, help="Output KMZ path")
    ap.add_argument("--doc-name", default="AED Locations (NZ)", help="KML document name")
    args = ap.parse_args()

    icon_path = Path(args.icon) if args.icon else Path(__file__).parent / ICON_FILE
    if not icon_path.exists():
        print(f"ERROR: icon file not found: {icon_path}", file=sys.stderr)
        sys.exit(1)

    aeds = fetch_aeds(args.source_url)
    if not aeds:
        print("ERROR: no AEDs found in source feed.", file=sys.stderr)
        sys.exit(1)

    print("[2/3] Building KML ...")
    kml = build_kml(aeds, args.doc_name)

    write_kmz(kml, icon_path, Path(args.out))
    print(f"\nAEDs included: {len(aeds)}")


if __name__ == "__main__":
    main()
