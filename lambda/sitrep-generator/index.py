"""
SitRep Lambda — scheduled AI Situational Report generator.

Runs on an EventBridge schedule (cron at :00/:15/:30/:45). Fetches
active/non-stale features from a fixed set of CloudTAK layers, builds a
compact JSON context, asks Bedrock (Claude) to summarise it into a
display-ticker line, a 3-4 line brief report, and a full multi-section
report, and writes the result to S3 as sitrep/latest.json.

Reuses the same S3 config file as display-proxy (Utils-Display-Proxy-Config.json)
for cloudtak_url, cloudtak_token, and layer -> connection mappings — this Lambda
has no dependency on Bedrock Agents / action groups, so it lives alongside the
display-proxy in utils-infra rather than in tak-infra.

See display-proxy/README.md ("SitRep" section) for the full design.

Config (via environment variables, set by CDK):
  CONFIG_BUCKET        S3 bucket holding the display-proxy config and where
                       sitrep/latest.json is written
  CONFIG_KEY           S3 key of the display-proxy config
                       (default: Utils-Display-Proxy-Config.json)
  SITREP_KEY           S3 key to write the SitRep result to
                       (default: sitrep/latest.json)
  MODEL_ID             Bedrock model id, without a region-profile prefix
                       (default: anthropic.claude-sonnet-5). The correct
                       us./au./eu. prefix is resolved at runtime from
                       BEDROCK_REGION/AWS_REGION — see resolve_model_id() —
                       so this Lambda deploys to any region unmodified.
  BEDROCK_REGION       Region for the Bedrock runtime call (default: current region)
"""

import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any

import boto3

CONFIG_BUCKET = os.environ.get("CONFIG_BUCKET", "")
CONFIG_KEY = os.environ.get("CONFIG_KEY", "Utils-Display-Proxy-Config.json")
SITREP_KEY = os.environ.get("SITREP_KEY", "sitrep/latest.json")
BEDROCK_REGION = os.environ.get("BEDROCK_REGION") or os.environ.get("AWS_REGION", "us-west-2")


def resolve_model_id(base_model_id: str, region: str) -> str:
    """
    Most current Claude models can't be invoked with a bare model ID — Bedrock
    requires a cross-region inference profile, and the correct profile prefix
    depends on which region we're actually running in. This mirrors the
    region -> prefix selection tak-infra uses for its Bedrock Agent setup
    (see tak-infra/scripts/bedrock/setup-bedrock-agent.py).

    If base_model_id already carries a profile prefix (e.g. "us.anthropic...",
    "global.anthropic..."), it's left as-is — an explicit override always wins.
    """
    if re.match(r"^(us|au|eu|apac|global|jp|kr)\.", base_model_id):
        return base_model_id
    if region.startswith("us-"):
        prefix = "us"
    elif region.startswith("ap-southeast-2") or region.startswith("ap-southeast-4"):
        prefix = "au"
    elif region.startswith("eu-"):
        prefix = "eu"
    elif region.startswith("ap-"):
        prefix = "apac"
    else:
        prefix = "us"
    return f"{prefix}.{base_model_id}"


# MODEL_ID env var holds the bare model name (e.g. "anthropic.claude-sonnet-5"),
# set via cdk.json's sitrep.modelId — no region prefix, so the same config
# value works no matter which region this Lambda gets deployed to.
MODEL_ID = resolve_model_id(os.environ.get("MODEL_ID", "anthropic.claude-sonnet-5"), BEDROCK_REGION)

# Layer IDs pulled from the display-proxy config's "layers" array for the
# SitRep context. Any of these missing from the config (or with no
# "connection") are silently skipped.
SITREP_LAYER_IDS = [
    "ema", "weather", "flooding", "quakes", "volcano", "nzta", "fires", "avalanche",
]

SYSTEM_PROMPT = """You are a New Zealand emergency management situational awareness analyst
generating a periodic Situational Report (SitRep) for the TAK.NZ Common
Operational Picture.

First, decide the overall ASSESSMENT — stable, improving, deteriorating, or
escalating — based on the full context provided. Decide this once, before
writing anything else, then use that same word consistently everywhere it
appears below (the assessment field, and the start of both summary_line and
brief_report). All four must agree — never write "deteriorating" in the
prose while assessment says "stable", or vice versa.

Then generate three outputs, all covering the same underlying situation at
different levels of detail and all reflecting the same assessment decided
above:

1. A single-line SUMMARY (max 200 characters) for a display ticker.
   Format: Assessment | Key event 1 | Key event 2 | ...

2. A BRIEF report, 3-4 lines total (STRICT — do not exceed 4 lines), for a
   non-interactive display panel with no scrolling, so it must fit without
   being cut off:
   - Line 1: Assessment word (Stable/Improving/Deteriorating/Escalating)
     and a one-sentence overview of the national situation.
   - Up to 2-3 further lines, each covering ONE of the most significant
     active items across all categories (highest severity/impact first —
     e.g. a High avalanche danger or an emergency road closure outranks a
     Level 1 volcano or planned roadworks). Keep each line to a single
     short sentence or fragment — no sub-bullets, no multi-part entries.
   - If nothing significant is happening, say so in 1 line and stop —
     do not pad with minor/routine items to fill space.

3. A full REPORT in the following structure:

SITUATIONAL REPORT — {date}, {time} NZST

OVERVIEW:
1-2 sentences summarising the national situation.

[Include only sections with active events:]

SEISMIC:
- Bullet points for earthquakes (magnitude, location, time, MMI)
- State only these fields — do not add damage/injury/impact commentary,
  since that information is not provided in the context

VOLCANIC:
- Only volcanoes at Level 1+ (skip Level 0)
- Include aviation colour code

AVALANCHE:
- Group by danger level, list regions
- Only include Moderate (2) and above

WEATHER:
- Active severe weather warnings (severity, area, type)

FLOODING:
- Active flood forecasts above normal

ROAD:
- Emergency road closures (crash, slip, flooding — not planned works)
- Some road closure entries include start_coords/end_coords (the first and
  last point of the closed road section). When present, use your knowledge
  of New Zealand geography to name the nearest towns/localities at each end
  and describe the closure as "closed between <place A> and <place B>",
  in addition to any LocationArea metadata already provided. If you cannot
  confidently name a nearby locality from the coordinates, fall back to the
  metadata fields alone.

FIRE:
- Active satellite fire detections with high confidence

ASSESSMENT: <same assessment word decided above, capitalised> — brief reasoning

Rules:
- Use 24-hour time, NZ timezone
- Use "as the kea flies" for distances
- Omit empty sections entirely
- Be concise — this is for operational awareness, not detailed analysis
- If nothing significant is happening, say so clearly
- For relative time use: "Xh ago", "Xd ago"
- The context below is the ONLY source of truth. Every field you state as
  fact must come directly from a field in the context — never add details,
  outcomes, or status information that are not present in the data, no
  matter how plausible or conventional they sound. This applies to ANY
  claim beyond what a field literally states, including but not limited to:
  - Outcomes or follow-up not in the data (e.g. do not add "no damage
    reported", "no injuries", "under control", "resolved", or similar,
    unless a field in the context actually says so)
  - Status changes, corrections, retractions (e.g. do not claim an
    earthquake was "later revised", "flagged deleted", or "downgraded"
    unless a field in the context actually says so)
  - If two features look unusual together (near-duplicate times/locations,
    etc.), report both as given rather than speculating about why
  - If you have nothing to add beyond a feature's given fields, simply
    state those fields and stop — do not pad the sentence with a
    plausible-sounding but unsupported detail

Respond with a JSON object, with "assessment" first so it's decided before
the text fields that must agree with it:
{
  "assessment": "stable|improving|deteriorating|escalating",
  "summary_line": "...",
  "brief_report": "...",
  "full_report": "..."
}"""

# ---------------------------------------------------------------------------
# Config / auth — mirrors display-proxy/lambdas/tak-cot-proxy/index.mjs
# ---------------------------------------------------------------------------
_cache: dict[str, Any] = {}


def get_config() -> dict:
    if "config" in _cache:
        return _cache["config"]
    s3 = boto3.client("s3")
    obj = s3.get_object(Bucket=CONFIG_BUCKET, Key=CONFIG_KEY)
    config = json.loads(obj["Body"].read(), strict=False)
    _cache["config"] = config
    return config


# ---------------------------------------------------------------------------
# CloudTAK feature fetching
# ---------------------------------------------------------------------------
def is_stale(feature: dict) -> bool:
    stale = (feature.get("properties") or {}).get("stale")
    if not stale:
        return False
    try:
        stale_dt = datetime.fromisoformat(stale.replace("Z", "+00:00"))
        return stale_dt < datetime.now(timezone.utc)
    except Exception:
        return False


def is_deleted_quake(feature: dict) -> bool:
    """
    GeoNet occasionally flags an auto-detected earthquake as deleted after
    further review (e.g. reclassified as a quarry blast, or a duplicate
    detection) — CloudTAK's earthquake feed passes this through as
    metadata.quality == "deleted" but does not remove the feature itself.
    Filter these out before they reach the model; a retracted event should
    not be reported as an active one. See metadata.quality values: "best",
    "deleted", etc. (GeoNet's own quality field, not TAK-specific).
    """
    quality = ((feature.get("properties") or {}).get("metadata") or {}).get("quality")
    return quality == "deleted"


def fetch_layer_features(base_url: str, token: str, connection: int, layer: int | None = None) -> list[dict]:
    upstream = f"{base_url}/api/connection/{connection}/feature"
    if layer is not None:
        upstream += f"?layer={layer}"

    all_features: list[dict] = []
    page = 0
    total = float("inf")
    limit = 1000

    while len(all_features) < total:
        sep = "&" if "?" in upstream else "?"
        url = f"{upstream}{sep}limit={limit}&page={page}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                # strict=False: CloudTAK feature text fields (weather warning
                # headlines, NZTA closure remarks, etc.) are sourced from
                # upstream feeds we don't control and occasionally carry raw
                # embedded control characters. Same rationale as
                # extract_json() below — this was still using the strict-mode
                # default and is exactly as likely to hit "Invalid control
                # character" as the model-output parser was before that fix.
                data = json.loads(resp.read(), strict=False)
        except urllib.error.HTTPError as e:
            print(f"CloudTAK error {e.code} for {url}")
            break
        except Exception as e:
            print(f"CloudTAK fetch failed for {url}: {e}")
            break

        items = data.get("items") if isinstance(data.get("items"), list) else data.get("features", [])
        total = data.get("total", len(items))
        all_features.extend(items)
        if not items:
            break
        page += 1

    return [f for f in all_features if not is_stale(f)]


def feature_to_context(feature: dict) -> dict:
    props = feature.get("properties") or {}
    return {
        "callsign": props.get("callsign"),
        "time": props.get("time"),
        "metadata": props.get("metadata", {}),
    }


def line_endpoints(coordinates: list) -> dict | None:
    """
    First and last vertex of a LineString/MultiLineString, as [lon, lat].
    Used for road closures (NZTA), where the line itself represents the
    closed section of highway — the model can turn endpoint coordinates
    into a locality reference (e.g. "closed between Te Anau and Manapouri")
    without needing the full geometry.
    """
    if not coordinates:
        return None
    # MultiLineString: use the first segment's start and the last segment's end
    if coordinates and isinstance(coordinates[0][0], (list, tuple)):
        first_line = coordinates[0]
        last_line = coordinates[-1]
        if not first_line or not last_line:
            return None
        return {"start": first_line[0][:2], "end": last_line[-1][:2]}
    # LineString: simple first/last vertex
    return {"start": coordinates[0][:2], "end": coordinates[-1][:2]}


def feature_to_line_context(feature: dict) -> dict:
    ctx = feature_to_context(feature)
    endpoints = line_endpoints(feature.get("geometry", {}).get("coordinates"))
    if endpoints:
        ctx["start_coords"] = endpoints["start"]
        ctx["end_coords"] = endpoints["end"]
    return ctx


def build_context(config: dict) -> tuple[dict, dict[str, int]]:
    base_url = config.get("cloudtak_url", "").rstrip("/")
    # CloudTAK accepts the profile-scoped etl.<jwt> API token directly as a
    # Bearer token on every protected route (see api/lib/auth.ts tokenParser)
    # — no session exchange needed. The old /api/login/token session-JWT
    # exchange this Lambda used to do was removed upstream and now 404s;
    # this mirrors display-proxy/lambdas/tak-cot-proxy/index.mjs, which
    # already uses the token directly.
    token = config.get("cloudtak_token")

    layer_defs = {l["id"]: l for l in config.get("layers", []) if l.get("connection") is not None}

    layers_context: dict[str, list[dict]] = {}
    feature_counts: dict[str, int] = {}

    for layer_id in SITREP_LAYER_IDS:
        layer_def = layer_defs.get(layer_id)
        if not layer_def:
            continue
        features = fetch_layer_features(base_url, token, layer_def["connection"], layer_def.get("layer"))

        # Earthquakes: drop any GeoNet has flagged as deleted/retracted —
        # see is_deleted_quake(). Note this filtering does not exist in the
        # display-proxy map config either (no filters.quakes entry), so a
        # deleted quake may still show on the live map even after this fix.
        if layer_id == "quakes":
            features = [f for f in features if not is_deleted_quake(f)]

        # Points always included — they carry the same metadata as the
        # polygon/line shapes they're paired with, keeping the prompt compact.
        points = [f for f in features if (f.get("geometry") or {}).get("type") == "Point"]
        layer_items = [feature_to_context(f) for f in points]

        # NZTA road closures are LineStrings with no paired point feature —
        # include their first/last coordinate so the model can describe the
        # closed section (e.g. "closed between Te Anau and Manapouri")
        # without needing full polygon/line geometry in the prompt.
        if layer_id == "nzta":
            lines = [f for f in features if (f.get("geometry") or {}).get("type") in ("LineString", "MultiLineString")]
            layer_items += [feature_to_line_context(f) for f in lines]
            layers_context[layer_id] = layer_items
            feature_counts[layer_id] = len(points) + len(lines)
        else:
            layers_context[layer_id] = layer_items
            feature_counts[layer_id] = len(points)

    context = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "layers": layers_context,
    }
    return context, feature_counts


# ---------------------------------------------------------------------------
# Bedrock invocation
# ---------------------------------------------------------------------------
def extract_json(text: str) -> dict:
    """Pull the first {...} JSON object out of the model's response text.

    Claude's full_report field is multi-line prose, and the model frequently
    emits literal control characters (raw newlines/tabs) inside that JSON
    string value instead of the escaped \\n / \\t — technically invalid per
    strict JSON, but extremely common LLM output behaviour. json.loads()
    defaults to strict=True and rejects these with "Invalid control
    character at: ...", which was the dominant SitRep failure mode in
    practice. strict=False permits control characters inside strings while
    still enforcing the rest of the JSON grammar.
    """
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON object found in model response: {text[:200]}")
    return json.loads(match.group(0), strict=False)


def call_bedrock(context: dict) -> dict:
    client = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
    user_content = f"{SYSTEM_PROMPT}\n\nContext:\n{json.dumps(context)}"

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        # 1500 was too low for models like Opus that tend to produce longer,
        # more detailed full_report text — the response was getting cut off
        # mid-JSON before the closing brace, causing extract_json() to fail.
        # Bumped again to cover the added brief_report field.
        "max_tokens": 3500,
        # Some models (e.g. Sonnet 5) default to emitting an extended
        # "thinking" block, which counts against max_tokens — observed
        # 3210 of 3500 output tokens spent on thinking, cutting the actual
        # JSON answer off mid-field. We don't need visible reasoning here,
        # just the structured output, so disable it explicitly.
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": user_content}],
    }

    response = client.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(response["body"].read(), strict=False)
    text = "".join(block.get("text", "") for block in payload.get("content", []))
    return extract_json(text)


# ---------------------------------------------------------------------------
# S3 write
# ---------------------------------------------------------------------------
def write_result(result: dict) -> None:
    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=CONFIG_BUCKET,
        Key=SITREP_KEY,
        Body=json.dumps(result).encode("utf-8"),
        ContentType="application/json",
    )


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------
def handler(event: dict, context: Any) -> dict:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        config = get_config()
        ctx, feature_counts = build_context(config)
        model_output = call_bedrock(ctx)
    except Exception as e:
        print(f"SitRep generation failed: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

    result = {
        "generated_at": generated_at,
        "model": MODEL_ID,
        "summary_line": model_output.get("summary_line", ""),
        "brief_report": model_output.get("brief_report", ""),
        "full_report": model_output.get("full_report", ""),
        "feature_counts": feature_counts,
        "assessment": model_output.get("assessment", "stable"),
    }

    write_result(result)
    print(f"SitRep written to s3://{CONFIG_BUCKET}/{SITREP_KEY}: {result['summary_line']}")
    return {"statusCode": 200, "body": json.dumps({"summary_line": result["summary_line"]})}
