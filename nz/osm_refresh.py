"""Scheduled OSM refresh (AWS Lambda, run monthly by EventBridge; can also be invoked by hand).

1. Stream the Geofabrik NZ extract to /tmp.
2. Build the FlatGeobuf with the same code the command-line builder uses.
3. Upload it under a NEW dated key, then overwrite the small pointer sidecar (nz_osm_meta.geojson) to name it.
4. Delete snapshots older than the previous one (the previous stays, for requests still reading it).

A request that is already reading the old snapshot keeps reading it; new requests pick up the new pointer. A run that
fails at any step leaves the live snapshot and pointer untouched.

Environment:
    SAR_DATA_BUCKET  bucket holding the data (the environment's artifacts bucket)
    SAR_DATA_PREFIX  key prefix, e.g. "sar-engine"  (keys: <prefix>/nz_osm_meta.geojson, <prefix>/osm/<date>.fgb)
    OSM_SOURCE_URL   optional; defaults to the Geofabrik New Zealand extract
Direct-invoke event (all optional): {"dry_run": true} builds and validates but uploads nothing.
"""
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone

import osm_build

DEFAULT_URL = 'https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf'
MIN_PBF_BYTES = 200 * 1024 * 1024        # the NZ extract is about 400 MB; far less means a truncated download
MIN_FEATURES = 800_000                   # the filtered file holds about 970,000 ways
MAX_SHRINK = 0.15                        # refuse to publish if the feature count drops by more than this
KEEP_SNAPSHOTS = 2                       # newest snapshots kept: the live one and the one before it
USER_AGENT = 'TAK-NZ-sar-engine/1 (+https://github.com/TAK-NZ/sar-engine)'
_SNAPSHOT = re.compile(r'^osm/\d{4}-\d{2}-\d{2}T\d{6}Z\.fgb$')


class RefreshError(Exception):
    pass


def download(url, dest):
    """Stream url to dest and return the byte count. Raises RefreshError for a short download."""
    if not url.startswith('https://'):
        raise RefreshError('OSM_SOURCE_URL must be https')
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    size = 0
    with urllib.request.urlopen(request, timeout=60) as response, open(dest, 'wb') as out:
        expected = int(response.headers.get('Content-Length') or 0)
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            size += len(chunk)
    if size < MIN_PBF_BYTES or (expected and size != expected):
        raise RefreshError(f'download incomplete: {size} bytes (expected {expected or "unknown"})')
    return size


def current_pointer(s3, bucket, prefix):
    """The snapshot key the pointer names right now, and its feature count (None, None if there is no pointer)."""
    try:
        body = s3.get_object(Bucket=bucket, Key=f'{prefix}/nz_osm_meta.geojson')['Body'].read()
    except s3.exceptions.NoSuchKey:
        return None, None
    props = json.loads(body)['features'][0]['properties']
    return props.get('file'), props.get('features')


def prune(s3, bucket, prefix, keep=KEEP_SNAPSHOTS):
    """Delete all but the newest `keep` snapshots under <prefix>/osm/. Names sort by build time. Returns the deleted keys."""
    keys = []
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=f'{prefix}/osm/'):
        keys += [o['Key'] for o in page.get('Contents', []) if _SNAPSHOT.match(o['Key'][len(prefix) + 1:])]
    stale = sorted(keys)[:-keep] if keep else sorted(keys)
    for key in stale:
        s3.delete_object(Bucket=bucket, Key=key)
    return stale


def refresh(s3, bucket, prefix, url=DEFAULT_URL, dry_run=False, workdir='/tmp'):
    t0 = time.time()
    pbf, fgb = os.path.join(workdir, 'osm.pbf'), os.path.join(workdir, 'osm.fgb')
    try:
        size = download(url, pbf)
        count = osm_build.build_fgb(pbf, fgb)
    finally:
        if os.path.exists(pbf):
            os.remove(pbf)                                  # free /tmp before the upload

    try:
        old_file, old_count = current_pointer(s3, bucket, prefix)
        if count < MIN_FEATURES:
            raise RefreshError(f'only {count} features built (minimum {MIN_FEATURES}); not publishing')
        if old_count and count < old_count * (1 - MAX_SHRINK):
            raise RefreshError(f'feature count fell from {old_count} to {count}; not publishing')
        built_at = datetime.now(timezone.utc)
        new_file = f"osm/{built_at.strftime('%Y-%m-%dT%H%M%SZ')}.fgb"
        result = {'status': 'dry-run' if dry_run else 'ok', 'features': count, 'download_bytes': size,
                  'fgb_bytes': os.path.getsize(fgb), 'previous_file': old_file, 'previous_features': old_count}
        if dry_run:
            result['duration_s'] = round(time.time() - t0, 1)
            return result

        s3.upload_file(fgb, bucket, f'{prefix}/{new_file}')                           # 1. data first
        meta = osm_build.metadata_geojson(os.path.basename(url), count, built_at)
        meta['features'][0]['properties']['file'] = new_file
        s3.put_object(Bucket=bucket, Key=f'{prefix}/nz_osm_meta.geojson',             # 2. then the pointer
                      Body=json.dumps(meta).encode(), ContentType='application/geo+json')
        result['deleted'] = prune(s3, bucket, prefix)                                 # 3. tidy up
        result.update(file=new_file, duration_s=round(time.time() - t0, 1))
        return result
    finally:
        if os.path.exists(fgb):
            os.remove(fgb)


def lambda_handler(event, context):
    import boto3                                                    # preinstalled in the Lambda image
    event = event if isinstance(event, dict) else {}
    bucket, prefix = os.environ['SAR_DATA_BUCKET'], os.environ['SAR_DATA_PREFIX'].strip('/')
    try:
        result = refresh(boto3.client('s3'), bucket, prefix, os.environ.get('OSM_SOURCE_URL', DEFAULT_URL),
                         dry_run=bool(event.get('dry_run')))
    except RefreshError as e:
        print(json.dumps({'event': 'osm_refresh_rejected', 'reason': str(e)}))
        raise                                                       # a failed invocation raises the alarm
    print(json.dumps({'event': 'osm_refresh', **result}))
    return result
