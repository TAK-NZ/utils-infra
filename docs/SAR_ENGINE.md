# SAR Engine

Terrain-aware search-and-rescue planning for New Zealand with two modes. **Travel time:** given an Initial Planning Point
(IPP), a walking speed and some time bands, it returns contours of where a person could physically have reached.
**TARR (Terrain-Aware Range Rings):** given an IPP and a subject profile (for example Hiker), it returns rings at the
Koester 25%, 50% and 75% distances, each adjusted for terrain, with a plain circle of the same distance beside it. It is the backend for the
[`cloudtak-plugin-sar`](https://github.com/TAK-NZ/cloudtak-plugin-sar) CloudTAK plugin.

- **Source, data pipeline and method:** [TAK-NZ/sar-engine](https://github.com/TAK-NZ/sar-engine) (a fork of WiSAR
  Terrain-Aware Range Rings, AGPL-3.0). Read its `NZ_PORT.md` for the data sources, measurements and known gaps.
- **This repository:** deploys it as two AWS Lambda functions from one container image, behind the existing ALB.

**Planning aid only.** Travel-time contours show reach, not likelihood, and the terrain model is not validated against
New Zealand search and rescue data. TARR rings are offered as **uncalibrated for New Zealand**: the distances are
Koester (2008) United States records, scaled by multipliers fitted to Coconino County, Arizona missions. The percentages
are not New Zealand containment probabilities, and every response says so. Each terrain-adjusted ring comes with a
plain Koester circle (no multiplier) so the effect of the terrain model and of the multiplier can be compared.

## What gets deployed

| Resource | Purpose |
|---|---|
| HTTP Lambda (`SarEngineHttpFn`) | `POST /sar/travel-time`, `POST /sar/tarr` and `GET /sar/health`, behind the ALB at `https://utils.<domain>/sar/*`. |
| Refresh Lambda (`SarEngineRefreshFn`) | Same image, command `osm_refresh.lambda_handler`. Rebuilds the OpenStreetMap snapshot monthly. |
| EventBridge rule | Runs the refresh on day 3 of each month at 14:00 UTC (configurable). Two automatic retries. |
| CloudWatch alarm + SNS topic | Alarms when a refresh run fails. The topic has **no subscribers** until you add one. |
| ALB target group + listener rule | Path `/sar/*`, priority 7; it covers all three routes. Health checks are off (they would invoke the function every 35 s). |

No new bucket: the data lives under the `sar-engine/` prefix of the environment's existing artifacts bucket, and both
functions are granted access to that prefix only (the HTTP function read-only, the refresh function write access to
`osm/` and the pointer file only, never the land cover raster).

The feature is **off by default** (`sarEngine.enabled: false` in `cdk.json`). With it off, the synthesized template is
identical to one without the section.

## Enabling it, step by step

Do these in order for each environment (dev-test and prod have separate buckets and need their own upload).

### 1. Put the API key in the config bucket

Create `Utils-SAR-Engine-Api-Keys.json` in the environment's config bucket (same pattern as the other proxies):

```json
{
  "apiKeys": {
    "cloudtak-relay": { "key": "<at least 16 random characters>", "comment": "CloudTAK /api/sar relay", "enabled": true }
  }
}
```

Keys shorter than 16 characters are ignored. To rotate, add the new key, switch the caller, then set the old one to
`"enabled": false`. The file is cached for five minutes. If the file is missing or unreadable, every request except
`/sar/health` is denied.

### 2. Upload the land cover raster

Build `lcdb_2023_30m.tif` once with `nz/build_lcdb_raster.py` in sar-engine (needs the LCDB v6.0 shapefile from
[LRIS](https://lris.scinfo.org.nz/), CC BY 4.0), then:

```
aws s3 cp data/lcdb_2023_30m.tif s3://<artifacts-bucket>/sar-engine/lcdb_2023_30m.tif
```

The bucket name is the `AppImagesBucket` export of the BaseInfra stack. After deployment the exact location is also the
`SarEngineDataLocation` stack output.

### 3. Deploy with the feature on

Set `sarEngine.enabled` to `true` for the environment in `cdk.json` and merge. The build workflow
(`demo-build.yml` / `production-build.yml`) then clones `sarEngine.engineRepo` at the pinned `sarEngine.engineRef`,
builds `Dockerfile.lambda`, pushes `utils-sar-engine-<imageTag>-<first 7 of the ref>` to the shared ECR repository, and
passes the tag to the deploy step as `imageTagsJson["sar-engine"]`.

### 4. Run the first OSM refresh by hand

Do not wait for the monthly schedule. Until a snapshot exists, trail data is missing. Invoke once, using the
`SarEngineRefreshFunction` output:

```
aws lambda invoke --function-name <SarEngineRefreshFunction> --payload '{"dry_run": true}' --cli-binary-format raw-in-base64-out out.json
aws lambda invoke --function-name <SarEngineRefreshFunction> --payload '{}' --cli-binary-format raw-in-base64-out out.json
```

The dry run downloads and builds but uploads nothing, and reports the feature count. The second call publishes. It took
73 seconds in testing. The same command is how you refresh outside the schedule, for example during an active search.

### 5. Subscribe to failure alarms

The alarm publishes to the `SarEngineAlertsTopicArn` output. Subscribe a team address (not stored in this repository):

```
aws sns subscribe --topic-arn <SarEngineAlertsTopicArn> --protocol email --notification-endpoint <address>
```

### 6. Check it

```
curl https://utils.<domain>/sar/health
curl -X POST https://utils.<domain>/sar/travel-time -H 'x-api-key: <key>' -H 'content-type: application/json' \
  -d '{"ipp":{"lat":-40.87,"lng":175.45},"speed_kmh":2,"intervals_hours":[1,2,4]}'
curl -X POST https://utils.<domain>/sar/tarr -H 'x-api-key: <key>' -H 'content-type: application/json' \
  -d '{"ipp":{"lat":-40.87,"lng":175.45},"profile":"Hiker"}'
```
The TARR answer has `"mode": "tarr"`, six features in `contours` and a `calibration` object. A 404 from `/sar/tarr` means
the deployed image predates the route (see "Upgrading the engine").

## API

`POST /sar/travel-time` with header `x-api-key`:

```json
{ "ipp": { "lat": -40.87, "lng": 175.45 }, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10 }
```

`radius_km` is optional. Limits: IPP on land in mainland NZ (a start in the sea or a lake returns 422), speed 0.1 to 10
km/h, 1 to 8 intervals of 0.25 to 24 h, radius at most 30 km. The response holds GeoJSON `contours`, `warnings`
(for example when elevation was filled from a coarser source), the data versions, the required attributions and a
disclaimer. Full details are in sar-engine's `NZ_PORT.md`.

A request that cannot finish in time is refused straight away with HTTP 422 and
`{"code": "area_too_dense", "message": "...", "suggested_radius_km": 17}`. When the longest time band is what holds the
radius up, the body carries `suggested_max_hours` instead (or as well). Callers should offer the suggestion to the user.

### `POST /sar/tarr`
Header `x-api-key`, same limits on body size (8 KB) and time as travel time:
```json
{ "ipp": { "lat": -40.87, "lng": 175.45 }, "profile": "Hiker", "ecoregion": "Temperate", "terrain": "Mountainous" }
```
`profile` is required and must be one of the 28 Koester subject profiles (case-sensitive). `ecoregion` (`Temperate`, `Dry`,
`Urban`) and `terrain` (`Mountainous`, `Flat`) are optional and only accepted when that profile lists them; otherwise the
engine answers 400. The Koester row is the exact match, else the ecoregion's row, else the profile's default row. There is no
radius, speed or interval input: the engine derives the radius as the calibrated 75% distance plus 2 km, clipped to the
30 km limit with a `limits` warning when clipped.

The response has `contours` with six polygon features, largest first: for each of 75%, 50% and 25% a plain Koester circle
(`kind: "plain"`, no multiplier) and the terrain-adjusted ring (`kind: "terrain"`) above it. Labels name distance and source,
for example `Koester 50%, terrain-adjusted` and `Koester 50%, plain circle`. A terrain ring that produced no contour is left
out with an `info` warning; the plain circle is always there. `parameters` holds the Koester row used (`koester_km`), the
multiplied distances (`calibrated_km`) and the radius. `calibration` reports what was applied:
```json
{ "region": "Coconino County, Arizona", "source": "built-in", "profile_specific": true,
  "multiplier": { "p25": 1.15, "p50": 1.15, "p75": 1.15 }, "calibrated_for_nz": false, "note": "..." }
```
`calibrated_for_nz` is always `false`. Every response also carries a `calibration` warning and a `disclaimer` stating that the
percentages are not New Zealand containment probabilities. A start point in water gives the same 422 as travel time. A dense
area gives 422 `area_too_dense` with a message but no suggestion fields (there is no radius or band to change): move the
start point or pick a profile with a shorter search distance. The contract is in sar-engine's `NZ_PORT.md` (section TARR) and
in the plugin's TARR contract.

### TARR multiplier configuration
The default is the Arizona set from upstream WiSAR: Hiker 1.15, Skier (Alpine) 2.15, Dementia 2.55, Mental Illness 4.05,
Despondent 1.65, Hunter 0.80, Child (10-12) 1.55, every other profile 1.40, one value for all three bands. To replace it
without a code change, first match wins:
1. Environment variable `SAR_TARR_MULTIPLIERS` (JSON, at most 4096 characters). For local runs only: this stack does not set it.
2. The key `tarrMultipliers` in `Utils-SAR-Engine-Api-Keys.json`, the file that already holds the API keys. The function can
   already read it, and the engine caches it for five minutes, so a change applies within about five minutes without a redeploy.
3. The built-in Arizona set.
```json
{
  "apiKeys": { "cloudtak-relay": { "key": "<at least 16 random characters>", "enabled": true } },
  "tarrMultipliers": {
    "label": "Coconino County, Arizona",
    "default": 1.40,
    "profiles": { "Hiker": 1.15, "Dementia": { "p25": 2.50, "p50": 2.55, "p75": 2.50 } }
  }
}
```
A value is a number (all three bands) or an object with `p25`, `p50` and `p75`, each between 0.1 and 10. `default` is
required, profile names must exist, and a configured set replaces the built-in set completely. `label` (optional) is
reported as `calibration.region`. **Invalid configuration fails closed:** every `/sar/tarr` request answers 500 and the log
gets `{"event": "tarr_calibration_invalid", "error": "ConfigError"}`; the engine never falls back to the Arizona set
silently. Travel time is not affected. No CDK change is needed for any of this.

## Operations

- **TARR timing:** TARR runs the same stages as travel time (elevation, land cover, OSM, cost surface, cost distance), so
  its timings, the dense-area guard and the 55 s timeout behave the same way. The radius follows the profile and
  the multiplier: a Hiker on the default row is about 5.7 km and Abduction is about 29 km (not clipped). Only a few rows
  exceed 30 km and are clipped with a `limits` warning (Snowmobiler Temperate/Flat, Mental Illness
  Temperate/Mountainous).
- **Cost:** Lambda bills per run. A run takes 2 to 50 s at 2 GB (see below), which is roughly a tenth of a cent at most,
  by my estimate from list prices. Nothing runs when idle.
- **Speed**, measured on real Lambda in Test through the public ALB: an 8 km radius in backcountry takes about 2 s warm
  and 12 s cold; 16 km about 7 s; the 30 km maximum about 14 s warm and 19 s cold. Wellington at 30 km takes 19 s.
  Peak memory was 0.6 to 1.6 GB of the 2 GB allocated.
- **Dense city cores are slower, and refused when they cannot finish.** The trail and road burn-in scales with the number
  of segments (about 237,000 in central Auckland at 30 km): central Auckland takes 23 s at 10 km, 43 s at 20 km, and would
  take 48 to 63 s at 30 km. The engine's dense-area guard (sar-engine `nz/density_guard.py`) counts the segments after
  the OSM read and, if the estimated total exceeds the time budget, answers 422 `area_too_dense` in about 10 to 12 s with
  the largest radius (or longest time band) that fits. On Test, Auckland at 30 km is refused with 17 km, and 17 km then
  runs in 38 to 40 s. Christchurch at 30 km (30 s), Wellington (19 s) and backcountry (10 s) are not affected. The budget
  is `SAR_TIME_BUDGET_S` (default 45 s: a 55 s function timeout minus up to about 10 s of container start). The time
  model rests on four measurements, so the threshold is a calibrated guess and slightly conservative. If you change the
  function timeout or the Lambda size, re-measure and set the variable (not set by this stack).
- **Timeouts:** the ALB's idle timeout is 60 s, so the HTTP function's timeout is 55 s and the configuration refuses 60 or
  more. A run that exceeds it fails and the caller sees a 5xx (an HTML body from the ALB); the plugin should handle
  that. The dense-area guard exists to make this rare, not impossible.
- **Cold starts** cost a few seconds to about 10 s for a backcountry request, so provisioned concurrency is not needed for
  rare use. The first request after deploying a new image can be much slower, because the image is fetched lazily.
- **Region:** Test runs in us-west-2 while the LINZ elevation bucket is in Sydney, so Test's elevation stage includes a
  trans-Pacific round trip on every request. A deployment in ap-southeast-2 should be faster on that stage (not measured).
- **Concurrency:** unrestricted by default. `sarEngine.reservedConcurrency` can cap parallel runs, but AWS keeps 100 units of the
  account limit unreserved, so the cap can be at most (account limit - 100) and deployment fails on accounts with a low
  limit (check yours with `aws lambda get-account-settings`).
- **Logs:** CloudWatch, one month. They contain timings, sizes and error classes only, never coordinates.
- **Data freshness:** the OSM snapshot is refreshed monthly. A snapshot older than 45 days adds a warning to every
  response. A refresh that fails leaves the live snapshot untouched. A refresh that never runs is not alarmed; the
  45-day warning is the backstop.
- **Versioned buckets (prod):** each refresh overwrites the small pointer and replaces one 350 MB snapshot. With
  versioning on, old versions stay. That is well under $1 a year, but it is unbounded unless a lifecycle rule for
  noncurrent versions under `sar-engine/` is added to the bucket in base-infra.
- **Upgrading the engine:** change `sarEngine.engineRef` (and `imageTag`) in `cdk.json`. The new ref gives a new image
  tag, so CI builds it instead of reusing the old one. To ship TARR, in this order:
  1. Merge the sar-engine branch `feat/nz-tarr` and push it, so the commit exists on GitHub (the build clones the pinned ref).
  2. Set `sarEngine.engineRef` to the merged commit and bump `imageTag` in both environments of `cdk.json`, and merge that.
  3. Let `demo-build.yml` / `production-build.yml` build and push the image, then deploy. The CDK stack itself is unchanged
     by TARR; only the image tag differs.
  4. Check with the `/sar/tarr` request from step 6.
  5. Then roll out the CloudTAK `/api/sar/tarr` relay and the plugin. They need the new engine first: an older engine
     answers 404 on `/tarr`, which the relay reports as "SAR service unavailable".
  `engineRef` stays at its current pin until step 1 is done; a local, unpushed commit would break the image build.
  Optionally add `tarrMultipliers` to the keys file in the config bucket at any time.
- **Turning it off:** set `enabled` to `false`. The functions, rule, alarm and topic are removed; the data in S3 stays.

## Changes needed outside this repository

- **base-infra ECR lifecycle:** its rules expire old images per tag prefix. `utils-sar-engine-` is not listed, so these
  images are never expired until a rule `{ tagPrefixList: ['utils-sar-engine-'], maxImageCount: ... }` is added.
- **TAK-NZ CloudTAK fork:** the `/api/sar/*` relay (like the weather one) holds the key and calls this endpoint. It
  exists on the CloudTAK branches `feat/sar-relay` (travel time) and `feat/sar-tarr-relay` (adds `/api/sar/tarr`). The
  `cloudtak-plugin-sar` plugin (branch `feat/side-pane-tarr-export` for TARR and the side pane) calls the relay. Neither
  is deployed from this repository.

## What has and has not been verified

Verified in the Test environment (account 453572736517, us-west-2), October 2026:

- Lambda pulls the image from the shared KMS-encrypted ECR repository (the repository policy is sufficient).
- The `kms:ViaService` condition works: the HTTP function reads the land cover raster, the OSM snapshot and the API key
  file, and the refresh function writes the snapshot, all through S3.
- The public ALB path (`/sar/*`), authentication (missing or wrong key gives 401), validation, the sea-start rejection
  and real analyses at radii up to the 30 km maximum.
- The first OSM refresh: dry run and publish, 971,529 features in about 100 s, KMS-encrypted, pointer updated.
- Request logs contain timings, sizes and status only; none of the coordinates used in testing appeared.

**Not verified:**

- The Demo environment (not deployed; its ECR holds only an older, broken image tag).
- The monthly schedule actually firing, and the failure alarm and SNS delivery (the topic has no subscribers).
- Production.
- TARR (`/sar/tarr`) on a deployed environment. It was checked locally against the engine's own check scripts only.
- Behaviour under concurrent requests.
- Reaching `download.geofabrik.de` worked from the refresh function (functions are not placed in a VPC), but a Geofabrik
  outage or rate limit has not been exercised.

## Lessons from the first deployment

Two defects reached Test because all local tests ran as root, which Lambda does not: an image whose files were readable
only by root (every request returned 502), and an OSM build that silently produced no features when run from Lambda's
read-only working directory. Both are fixed in sar-engine and guarded (the image build fails if the code cannot be
imported as an unprivileged user). Test engine changes with `--user 1000:1000 --read-only` and only `/tmp` writable.
