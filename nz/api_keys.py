"""API keys for the HTTP routes.

Keys come from a JSON file in the environment's config bucket (the same pattern as the other utils-infra proxies),
so they never appear in CloudFormation or Lambda environment variables:

    s3://<SAR_CONFIG_BUCKET>/<SAR_CONFIG_KEY>
    {"apiKeys": {"cloudtak-relay": {"key": "<at least 16 characters>", "comment": "...", "enabled": true}}}

Rotation: add the new key, switch the caller, then disable or remove the old one. The file is cached for five minutes.
SAR_API_KEY (a single key in the environment) is accepted too, for local development.

Fail closed: no keys configured, an unreadable file, an empty or short key, or a disabled entry all mean "deny".
"""
import hmac
import json
import os
import time

MIN_KEY_LENGTH = 16
CACHE_SECONDS = 300
_cache = {'loaded_at': -CACHE_SECONDS, 'keys': []}


def _read_config_file(bucket, key):
    import boto3                        # preinstalled in the Lambda image; only needed when the file is configured
    body = boto3.client('s3').get_object(Bucket=bucket, Key=key)['Body'].read()
    return json.loads(body)


def parse_keys(config):
    """Extract usable keys from the parsed config file."""
    keys = []
    entries = config.get('apiKeys') if isinstance(config, dict) else None
    for entry in (entries or {}).values():
        if (isinstance(entry, dict) and entry.get('enabled', True) is True
                and isinstance(entry.get('key'), str) and len(entry['key']) >= MIN_KEY_LENGTH):
            keys.append(entry['key'])
    return keys


def valid_keys(now=None):
    """All currently valid keys (cached). A read failure yields no file keys and is retried on the next request."""
    now = time.time() if now is None else now
    if now - _cache['loaded_at'] >= CACHE_SECONDS:
        keys = []
        bucket, key = os.environ.get('SAR_CONFIG_BUCKET'), os.environ.get('SAR_CONFIG_KEY')
        if bucket and key:
            try:
                keys = parse_keys(_read_config_file(bucket, key))
                _cache.update(loaded_at=now, keys=keys)
            except Exception as e:      # noqa: BLE001 - fail closed; the error class is logged, never the content
                print(json.dumps({'event': 'api_key_file_unreadable', 'error': type(e).__name__}))
                _cache.update(loaded_at=-CACHE_SECONDS, keys=[])
        else:
            _cache.update(loaded_at=now, keys=[])
    keys = list(_cache['keys'])
    env_key = os.environ.get('SAR_API_KEY', '')
    if len(env_key) >= MIN_KEY_LENGTH:
        keys.append(env_key)
    return keys


def is_authorized(given):
    """Constant-time check of a presented key against every valid key (no early exit)."""
    if not isinstance(given, str) or not given:
        return False
    matches = [hmac.compare_digest(k.encode(), given.encode()) for k in valid_keys()]
    return any(matches)
