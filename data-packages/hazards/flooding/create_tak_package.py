#!/usr/bin/env python3
"""
create_tak_package.py
----------------------
Creates TAK Mission Package (Data Package) ZIPs from one or more files,
and optionally uploads them to a CloudTAK instance.

The package follows the ATAK Mission Package v2 format:
  - Each content file is placed inside a UUID-named folder in the ZIP.
  - A MANIFEST/manifest.xml is generated describing all contents.
  - The ZIP comment is set to "Created by ATAK. Mission Package version 2".

Package creation
----------------
    # One ZIP per file
    python3 create_tak_package.py --input-dir flooding/overlays --one-per-file --output-dir flooding/packages

    # Single combined ZIP
    python3 create_tak_package.py --input-dir flooding/overlays --name "Canterbury Floods" --output flooding/all.zip

    # From explicit files
    python3 create_tak_package.py file1.tif file2.tif --name "My Package"

Upload to CloudTAK
------------------
    # Create packages AND upload in one step
    python3 create_tak_package.py \\
        --input-dir flooding/overlays --one-per-file --output-dir flooding/packages \\
        --upload \\
        --url https://map.demo.tak.nz \\
        --token etl.<jwt> \\
        --channels "XtraTools - Data Packages"

    # Upload already-created ZIPs (skip package creation)
    python3 create_tak_package.py \\
        --input-dir flooding/packages --upload-only \\
        --url https://map.demo.tak.nz \\
        --token etl.<jwt> \\
        --channels "XtraTools - Data Packages"

Upload notes
------------
    - Due to a bug in CloudTAK (see CLOUDTAK_BUGS.md), keywords cannot be set
      during upload. This script works around that by patching each package with
      a second request immediately after upload.
    - Keywords and channels are sent as two separate PATCH requests. Combining
      them causes channels to trigger a TAK server re-upload, creating a duplicate
      package entry visible to all channels.
    - The token is an API token from POST /api/profile/token (etl.<jwt> format).

Arguments
---------
    positional              One or more input files (alternative to --input-dir).

    --input-dir DIR         Folder of files to package/upload (non-recursive).
    --name TEXT             Package display name. Defaults to filename stem.
    --output FILE           Explicit output ZIP path (single package mode).
    --output-dir DIR        Directory to write output ZIPs into.
    --one-per-file          Create one ZIP per input file.
    --uid TEXT              Override top-level package UID (auto-generated if omitted).

    --upload                Upload packages to CloudTAK after creating them.
    --upload-only           Skip creation, upload existing ZIPs from --input-dir or args.
    --url URL               CloudTAK base URL, e.g. https://map.demo.tak.nz
    --token TOKEN           API token (etl.<jwt>).
    --keywords KW [KW ...]  Tags to apply to each uploaded package.
    --channels CH [CH ...]  TAK channels/groups to assign (e.g. "XtraTools - Data Packages").
    --replace               Delete any existing package with the same exact name
                            before uploading (idempotent re-runs). Default off.

Requirements
------------
    Python 3.9+ standard library only for package creation.
    'requests' required for upload: pip install requests
"""

import argparse
import re
import sys
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.dom import minidom


# ---------------------------------------------------------------------------
# Package-name sanitisation
# ---------------------------------------------------------------------------

def sanitize_package_name(name: str) -> str:
    """
    Remove characters that TAK Server rejects in a Data Package name.

    TAK Server returns HTTP 400 ("resource unavailable or not allowed") when a
    package name contains an apostrophe — e.g. "Hawke's Bay" fails to upload.
    We strip ASCII (') and curly (’) apostrophes. The display name is applied
    both to the package manifest and the upload query parameter, so this is
    applied in one place used by both.
    """
    return name.replace("\u2019", "").replace("'", "")


# ---------------------------------------------------------------------------
# Manifest builder
# ---------------------------------------------------------------------------

def build_manifest(package_uid: str, package_name: str,
                   contents: list[dict]) -> str:
    root = ET.Element("MissionPackageManifest", version="2")

    config = ET.SubElement(root, "Configuration")
    ET.SubElement(config, "Parameter", name="uid", value=package_uid)
    ET.SubElement(config, "Parameter", name="name", value=sanitize_package_name(package_name))

    contents_el = ET.SubElement(root, "Contents")
    for item in contents:
        content = ET.SubElement(contents_el, "Content",
                                ignore="false",
                                zipEntry=item["zip_entry"])
        ET.SubElement(content, "Parameter", name="uid", value=item["uid"])
        if item.get("name"):
            ET.SubElement(content, "Parameter", name="name", value=item["name"])

    raw = ET.tostring(root, encoding="unicode")
    pretty = minidom.parseString(raw).toprettyxml(indent="   ", encoding=None)
    lines = [l for l in pretty.splitlines() if l.strip()]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Package writer
# ---------------------------------------------------------------------------

def create_package(files: list[Path], output_zip: Path,
                   package_name: str, package_uid: str | None = None) -> None:
    """Write a single TAK Mission Package ZIP."""
    if package_uid is None:
        package_uid = str(uuid.uuid4())

    contents = []
    for f in files:
        item_uid = str(uuid.uuid4())
        zip_entry = f"{item_uid}/{f.name}"
        contents.append({"uid": item_uid, "zip_entry": zip_entry,
                          "name": f.name, "path": f})

    manifest_xml = build_manifest(package_uid, package_name, contents)
    output_zip.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_zip, "w",
                         compression=zipfile.ZIP_DEFLATED,
                         compresslevel=6) as zf:
        # No ZIP comment — real ATAK packages don't set one

        # MANIFEST must come first — ATAK parses the ZIP sequentially
        zf.writestr(zipfile.ZipInfo("MANIFEST/"), "")
        zf.writestr("MANIFEST/manifest.xml", manifest_xml)

        # Content files — write explicit directory entry after MANIFEST, then file
        for item in contents:
            print(f"    Adding : {item['path'].name}")
            dir_info = zipfile.ZipInfo(item["uid"] + "/")
            zf.writestr(dir_info, "")
            zf.write(item["path"], arcname=item["zip_entry"])

    size_kb = output_zip.stat().st_size / 1024
    print(f"    Written: {output_zip}  ({size_kb:.0f} KB, {len(files)} file(s))")


# ---------------------------------------------------------------------------
# CloudTAK uploader
# ---------------------------------------------------------------------------

def delete_existing_by_name(base_url: str, token: str, package_name: str) -> int:
    """
    Delete every existing package whose display name EXACTLY equals
    `package_name`. Used by --replace to make re-runs idempotent (CloudTAK does
    not de-duplicate by name, and package names are immutable, so replacing a
    package means delete + re-upload).

    Matches on the exact name only — never a prefix — so it can't remove
    unrelated packages. Returns the number deleted.
    """
    import requests

    base_url = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}
    try:
        resp = requests.get(f"{base_url}/api/marti/package",
                            headers=headers, params={"limit": 1000}, timeout=30)
        resp.ok or resp.raise_for_status()
        items = resp.json().get("items", [])
    except Exception as e:
        print(f"    WARNING: could not list packages for --replace ({e}); skipping delete.",
              file=sys.stderr)
        return 0

    victims = [it for it in items if it.get("name") == package_name]
    deleted = 0
    for it in victims:
        uid = it.get("uid") or it.get("hash")
        if not uid:
            continue
        try:
            d = requests.delete(f"{base_url}/api/marti/package/{uid}",
                                headers=headers, timeout=30)
            if d.ok:
                print(f"    Replaced: deleted existing '{package_name}' ({uid[:12]}…)")
                deleted += 1
            else:
                print(f"    WARNING: delete failed for {uid[:12]}… HTTP {d.status_code}",
                      file=sys.stderr)
        except Exception as e:
            print(f"    WARNING: delete errored for {uid[:12]}… ({e})", file=sys.stderr)
    return deleted


def upload_package(zip_path: Path, package_name: str, base_url: str,
                   token: str, keywords: list[str],
                   channels: list[str], replace: bool = False) -> str | None:
    """
    Upload a ZIP to CloudTAK via POST /api/marti/package.
    Keywords and channels are both set as query parameters on the POST,
    matching exactly what the CloudTAK UI does.

    If `replace` is True, any existing package with the same exact name is
    deleted first (delete-first semantics), so re-running is idempotent.

    Returns the package UID/hash on success, or None on failure.
    """
    try:
        import requests
    except ImportError:
        print("ERROR: 'requests' library required for upload. Run: pip install requests",
              file=sys.stderr)
        sys.exit(1)

    base_url = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}

    # TAK Server rejects apostrophes anywhere in the package metadata — in the
    # name AND in keywords (e.g. "Hawke's Bay" fails as either). Sanitise both,
    # keeping the display name / manifest name / delete-by-name lookup consistent.
    package_name = sanitize_package_name(package_name)
    keywords = [sanitize_package_name(k) for k in keywords]

    if replace:
        delete_existing_by_name(base_url, token, package_name)

    # --- Upload with channels and keywords set as repeated query params ---
    # This matches exactly what the CloudTAK UI sends:
    #   ?name=...&groups=UTL+-+Utilities&keywords=Canterbury&keywords=Kaikoura&...
    params: dict = {"name": package_name}
    if channels:
        params["groups"] = channels
    if keywords:
        params["keywords"] = keywords

    print(f"    Uploading: {zip_path.name} …")
    with open(zip_path, "rb") as fh:
        resp = requests.post(
            f"{base_url}/api/marti/package",
            headers=headers,
            params=params,
            files={"file": (zip_path.name, fh, "application/zip")},
            timeout=120,
        )

    if not resp.ok:
        print(f"    ERROR: Upload failed — HTTP {resp.status_code}: {resp.text}",
              file=sys.stderr)
        return None

    pkg_uid = resp.json().get("UID") or resp.json().get("Hash")
    print(f"    Uploaded   UID: {pkg_uid}")

    # Confirm what was actually set
    meta = requests.get(
        f"{base_url}/api/marti/package/{pkg_uid}",
        headers=headers,
        timeout=15,
    ).json()
    print(f"    Keywords   set: {meta.get('keywords', [])}")
    print(f"    Channels   set: {meta.get('channels', [])}")

    return pkg_uid


# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------

def collect_files(args) -> list[Path]:
    files = []
    if args.input_dir:
        d = Path(args.input_dir)
        if not d.is_dir():
            print(f"ERROR: --input-dir '{d}' is not a directory.", file=sys.stderr)
            sys.exit(1)
        files = sorted(p for p in d.iterdir() if p.is_file())
    if args.files:
        files += [Path(f) for f in args.files]
    if not files:
        print("ERROR: No input files specified.", file=sys.stderr)
        sys.exit(1)
    missing = [f for f in files if not f.exists()]
    if missing:
        for m in missing:
            print(f"ERROR: file not found: {m}", file=sys.stderr)
        sys.exit(1)
    return files


def upload_required(args) -> bool:
    return bool(getattr(args, "upload", False) or getattr(args, "upload_only", False))


def check_upload_args(args) -> None:
    if not args.url:
        print("ERROR: --url is required for upload.", file=sys.stderr)
        sys.exit(1)
    if not args.token:
        print("ERROR: --token is required for upload.", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Create and/or upload TAK Mission Package ZIPs to CloudTAK.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # --- Input ---
    parser.add_argument("files", nargs="*", metavar="FILE",
                        help="Input files.")
    parser.add_argument("--input-dir", metavar="DIR",
                        help="Folder of files to package/upload.")

    # --- Package creation ---
    parser.add_argument("--name", metavar="TEXT",
                        help="Package display name.")
    parser.add_argument("--output", metavar="FILE",
                        help="Output ZIP path (single-package mode).")
    parser.add_argument("--output-dir", metavar="DIR",
                        help="Directory to write output ZIPs into.")
    parser.add_argument("--one-per-file", action="store_true",
                        help="Create one ZIP per input file.")
    parser.add_argument("--uid", metavar="UUID",
                        help="Override top-level package UID.")

    # --- Upload ---
    parser.add_argument("--upload", action="store_true",
                        help="Upload packages to CloudTAK after creating them.")
    parser.add_argument("--upload-only", action="store_true",
                        help="Skip creation; upload existing ZIPs directly.")
    parser.add_argument("--url", metavar="URL",
                        help="CloudTAK base URL (e.g. https://map.demo.tak.nz).")
    parser.add_argument("--token", metavar="TOKEN",
                        help="CloudTAK API token (etl.<jwt>).")
    parser.add_argument("--keywords", metavar="KW", nargs="+",
                        help="Tags to apply to each uploaded package.")
    parser.add_argument("--channels", metavar="CH", nargs="+",
                        help='TAK channels to assign (e.g. "XtraTools - Data Packages").')
    parser.add_argument("--replace", action="store_true",
                        help="Before uploading, delete any existing package with the "
                             "same exact name (makes re-runs idempotent). Default off.")

    args = parser.parse_args()

    if upload_required(args):
        check_upload_args(args)

    files = collect_files(args)
    out_dir = Path(args.output_dir) if args.output_dir else Path(".")
    keywords = args.keywords or []
    channels = args.channels or []

    # Track upload failures so the process exits non-zero — callers (e.g. the
    # flood orchestrator) can then treat a region as failed instead of silently
    # succeeding when its packages didn't upload.
    upload_failures = 0

    # -----------------------------------------------------------------------
    # Upload-only mode: treat input files as ZIPs to upload directly
    # -----------------------------------------------------------------------
    if args.upload_only:
        for zip_path in files:
            pkg_name = args.name or zip_path.stem.replace("_", " ")
            print(f"\n  Package: {pkg_name}")
            if upload_package(zip_path, pkg_name, args.url, args.token,
                              keywords, channels, replace=args.replace) is None:
                upload_failures += 1
        print("\nDone.")
        if upload_failures:
            print(f"ERROR: {upload_failures} upload(s) failed.", file=sys.stderr)
            sys.exit(1)
        return

    # -----------------------------------------------------------------------
    # Create (and optionally upload) packages
    # -----------------------------------------------------------------------
    if args.one_per_file:
        for f in files:
            stem = f.stem
            # Extract location name: everything before the first _<digits>y token
            # e.g. "North_Banks_Peninsula_100y_12h_0c_..." → "North Banks Peninsula"
            location_match = re.match(r'^(.*?)_\d+y', stem)
            location = location_match.group(1).replace("_", " ") if location_match else stem.replace("_", " ")

            # Build per-file package name: swap location into the template if --name
            # contains the placeholder "{location}", otherwise derive from stem
            if args.name and "{location}" in args.name:
                pkg_name = args.name.format(location=location)
            elif args.name:
                pkg_name = args.name
            else:
                pkg_name = stem.replace("_", " ")

            out_zip = (Path(args.output).parent / f"{stem}.zip"
                       if args.output else out_dir / f"{stem}.zip")

            # Substitute {location} placeholder in keywords too
            per_file_keywords = [
                kw.replace("{location}", location) if "{location}" in kw else kw
                for kw in keywords
            ]

            print(f"\n  Package: {pkg_name}")
            create_package([f], out_zip, pkg_name)

            if upload_required(args):
                if upload_package(out_zip, pkg_name, args.url, args.token,
                                  per_file_keywords, channels, replace=args.replace) is None:
                    upload_failures += 1
    else:
        if args.output:
            out_zip = Path(args.output)
        else:
            stem = Path(args.input_dir).name if args.input_dir else files[0].stem
            out_zip = out_dir / f"{stem}.zip"

        pkg_name = args.name or out_zip.stem.replace("_", " ")
        print(f"\n  Packaging {len(files)} file(s) into: {out_zip}")
        create_package(files, out_zip, pkg_name, package_uid=args.uid)

        if upload_required(args):
            if upload_package(out_zip, pkg_name, args.url, args.token,
                              keywords, channels, replace=args.replace) is None:
                upload_failures += 1

    print("\nDone.")
    if upload_failures:
        print(f"ERROR: {upload_failures} upload(s) failed.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
