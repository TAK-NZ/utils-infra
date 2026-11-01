# SAR Engine

Terrain-aware search-and-rescue planning for New Zealand with two modes. **Travel time:** given an Initial Planning Point
(IPP), a walking speed and some time bands, it returns contours of where a person could physically have reached.
**TARR (Terrain-Aware Range Rings):** given an IPP and a subject profile (for example Hiker), it returns rings at the
Koester 25%, 50% and 75% distances, each adjusted for terrain, with a plain circle of the same distance beside it. It is the backend for the
[`cloudtak-plugin-sar`](https://github.com/TAK-NZ/cloudtak-plugin-sar) CloudTAK plugin.

- **Source, data pipeline and method:** the [`sar-engine/`](../sar-engine) folder of this repository (a fork of WiSAR
  Terrain-Aware Range Rings, AGPL-3.0, vendored with its history; see "Where the engine code comes from"). Read its
  `NZ_PORT.md` for the data sources, measurements and known gaps.
- **This repository:** builds it into one container image and deploys it as two AWS Lambda functions behind the existing ALB.

**Planning aid only.** Travel-time contours show reach, not likelihood, and the terrain model is not validated against
New Zealand search and rescue data. TARR rings are offered as **uncalibrated for New Zealand**: the distances are
Koester (2008) United States records, scaled by multipliers fitted to Coconino County, Arizona missions. The percentages
are not New Zealand containment probabilities, and every response says so. Each terrain-adjusted ring comes with a
plain Koester circle (no multiplier) so the effect of the terrain model and of the multiplier can be compared. What
calibrating it would take is in "Calibrating for New Zealand".

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

Build `lcdb_2023_30m.tif` once with `sar-engine/nz/build_lcdb_raster.py` (needs the LCDB v6.0 shapefile from
[LRIS](https://lris.scinfo.org.nz/), CC BY 4.0), then:

```
aws s3 cp data/lcdb_2023_30m.tif s3://<artifacts-bucket>/sar-engine/lcdb_2023_30m.tif
```

The bucket name is the `AppImagesBucket` export of the BaseInfra stack. After deployment the exact location is also the
`SarEngineDataLocation` stack output.

### 3. Deploy with the feature on

Set `sarEngine.enabled` to `true` for the environment in `cdk.json` and merge. The build workflow
(`demo-build.yml` / `production-build.yml`) then builds `sar-engine/Dockerfile.lambda`, pushes
`utils-sar-engine-<imageTag>-<hash>` to the shared ECR repository, and passes the tag to the deploy step as
`imageTagsJson["sar-engine"]`. The hash covers only the files the image copies (`Dockerfile.lambda`, `.dockerignore`,
`nz/` and `app/pipeline/`), so any change to the engine code gives a new tag and a change to its docs does not. Bump
`sarEngine.imageTag` when you want the label to say something. `demo-build.yml` starts on a push to `main` that touches
`sar-engine/**`.

A manual deploy (no workflow) builds the image itself from the same folder, like the other containers:
```
BUILDX_NO_DEFAULT_ATTESTATIONS=1 npm run cdk deploy -- --context envType=dev-test ...
```
This needs `usePreBuiltImages` to be `false` (the `dev-test` default in `cdk.json`) and Docker running. The deploy builds
`sar-engine/Dockerfile.lambda` from whatever is in the working tree, so commit what you intend to ship first. The folder
is hashed without `.git`, `data`, `results`, `docs` and virtualenvs, so the image only changes when the engine code does.
`--context sarEngineSourcePath=<dir>` builds from another checkout instead. `BUILDX_NO_DEFAULT_ATTESTATIONS=1` is needed
with Docker 29 or later, which otherwise adds provenance attestations that Lambda rejects ("image manifest ... is not
supported"). With `usePreBuiltImages=true` and no `imageTagsJson["sar-engine"]` the deploy prints a warning and points the
functions at `utils-sar-engine-<imageTag>`, which CI does not push; the deploy workflows always pass the real tag.
`sarEngineSourcePath` together with `usePreBuiltImages=true` (CI, prod) is refused.

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

## Optional: LINZ stream data

OSM maps far fewer streams than LINZ in the backcountry (Westland: 539 OSM waterways in a 30 km request against 11,002 with
LINZ added). The engine can add the LINZ streams and river areas to its OSM waterways. It is **off until you publish two
files**, needs **no CDK change** (the HTTP function already reads everything under `sar-engine/`), and the monthly OSM
refresh never touches it. It needs an engine image that contains the feature (any build of `sar-engine/` since the LINZ
streams were added); an older image ignores the files.

The source is the LINZ vector tile file this repository already keeps in the same bucket
(`linz-vector-tiles.mbtiles`, refreshed monthly by `update-linz-tiles.yml`). Build once from the `sar-engine/` folder, with
the engine's Python environment (about a minute, 1 GB of memory):

```
aws s3 cp s3://<artifacts-bucket>/linz-vector-tiles.mbtiles .
python sar-engine/nz/build_linz_water.py linz-vector-tiles.mbtiles          # writes data/linz_water.fgb and data/linz_water_meta.geojson
aws s3 cp data/linz_water.fgb           s3://<artifacts-bucket>/sar-engine/linz_water.fgb
aws s3 cp data/linz_water_meta.geojson  s3://<artifacts-bucket>/sar-engine/linz_water_meta.geojson
```

Upload the `.fgb` first and the sidecar last: the sidecar is the switch. To turn it off, delete
`sar-engine/linz_water_meta.geojson`. Stream data changes slowly, so there is no schedule; rebuild by hand when you want newer
tiles. When it is in use, responses carry `data.linz_waterways_built_at` and a LINZ attribution line (CC BY 4.0). If the file
cannot be read, a request still succeeds from OSM alone and carries a `linz-water` warning.

Measured effect: ring and contour areas moved by 0.5 % or less at six test sites, cost-surface time rose 0.02 to 1.3 s and
memory 4 to 65 MB (engine run locally on the same data). Build the files from the environment's own copy of the tile file.
See `sar-engine/NZ_PORT.md` ("LINZ waterways").

## API

`POST /sar/travel-time` with header `x-api-key`:

```json
{ "ipp": { "lat": -40.87, "lng": 175.45 }, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10 }
```

`radius_km` is optional. Limits: IPP on land in mainland NZ (a start in the sea or a lake returns 422), speed 0.1 to 10
km/h, 1 to 8 intervals of 0.25 to 24 h, radius at most 30 km. The response holds GeoJSON `contours`, `warnings`
(for example when elevation was filled from a coarser source), the data versions, the required attributions and a
disclaimer. Full details are in `sar-engine/NZ_PORT.md`.

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
start point or pick a profile with a shorter search distance. The contract is in `sar-engine/NZ_PORT.md` (section TARR) and
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

## Calibrating for New Zealand

Nothing in the engine is calibrated against New Zealand search and rescue outcomes. This section says what is assumed,
what data would replace the assumptions, and where that data might exist. It is a plan, not something that has been done.

### What is assumed today

| Part | Assumption | Origin | Where it changes |
|---|---|---|---|
| TARR distances | Koester p25 / p50 / p75 per subject profile, ecoregion and terrain | United States search records (Koester 2008) | `sar-engine/nz/tarr_profiles.py`, generated from `sar-engine/app/static/app.js`; `sar-engine/nz/check_tarr.py` fails if the two differ |
| TARR multipliers | Hiker 1.15, Dementia 2.55, ..., all others 1.40 | Fitted to Coconino County, Arizona missions | `tarrMultipliers` in the keys file, no redeploy (see above) |
| Walking speed against slope | Tobler's hiking function (peak 6 km/h), cross-slope penalty `1 + 0.3 x slope` (slope capped at 1) | Published literature | `sar-engine/nz/fast_cost_distance.py` and `sar-engine/app/pipeline/cost_distance.py` (keep the two in step) |
| Ground friction | One value per LCDB land cover class | Expert judgement, not measured | `sar-engine/nz/lcdb_friction.toml` |
| Barriers and corridors | Stream 1.6x, river area 3.0x, trails and roads 1.0x | Judgement | `sar-engine/nz/fast_cost_surface.py` and `sar-engine/nz/nz_sources.py` |

The upstream multipliers are the single value per profile that minimises total absolute error across the 25 %, 50 % and 75 %
containment rates, fitted to 360 subjects from 253 missions. A profile gets its own multiplier only with at least 20 cases
(Hiker has 183, six other profiles have 20 to 36); every other profile falls back to one global value of 1.40.

### What matters most

Measured on this engine, so effort can go where it changes the answer:

- Slope dominates. Swapping the land cover dataset moved ring areas by 0 to 4 %, so the friction table is the least valuable
  part to calibrate.
- The terrain model changes the rings a lot. At two North Island backcountry sites (the Tararua Range, and 39.0 S 176.0 E) the
  terrain-adjusted rings covered about 10 % and 15 % of the area of the plain Koester circles, so the multipliers and the
  slope function decide the answer.
- The inputs already limit precision. On ten LiDAR-covered sites, replacing the LiDAR elevation with either fallback
  (Copernicus GLO-30, or the contour-interpolated 8 m DEM) changed the travel-time contour areas by 8 to 10 % on average, and
  made them too large (by 7 % and 10 % on average). A calibrated model cannot be more exact than that. The two fallbacks
  performed alike: contour overlap with the LiDAR result was 0.885 and 0.886.

### Data needed

**1. Incident outcomes (TARR distances and multipliers).** For each past lost-person case:

- subject category and profile (age, activity, dementia, child, ...), and group size;
- the initial planning point, last known position or point last seen, with a timestamp, and which of those it is. The
  engine's input must mean the same thing as the recorded point;
- the find location with a timestamp, the subject's condition (well, injured, deceased) and how they were found;
- the route taken, if a GPS track exists, and whether the subject was on a track;
- coordinates accurate to about 100 m. The terrain model resolves 30 to 60 m cells, so coarser positions add noise.

Volume: to match what the upstream fit rests on, aim for several hundred cases overall and at least 20 per profile that is to
get its own multiplier. Expect most of the 28 profiles to be pooled with similar ones, and report the uncertainty of every
fitted value (for example by bootstrap). With few cases the p75 estimate is the least stable.

Method: run each case through the engine, take the position of the find, and choose for each profile and band the multiplier
for which the fraction of finds inside the ring matches 25 %, 50 % and 75 % (or minimise the absolute error across the three, as
upstream does). Apply the result through `tarrMultipliers`. If a profile has enough New Zealand cases, replacing the Koester
distances themselves is better than only rescaling them.

**2. Movement data (the slope function, cross-slope penalty and any friction changes).** Timestamped GPS tracks sampled every
few seconds, labelled by land cover class, on or off a track, and ideally by subject profile. A lost child or a person with
dementia does not move like a fit tramper, so speeds from recreational tracks apply to able-bodied walkers only. River
crossings (the delay, and whether the crossing was attempted at all) are worth recording separately.

**3. Held-out cases for validation.** Keep a share of the incidents out of the fitting and judge the calibrated model on those,
for example leave-one-out as the published work on the International Search and Rescue Incident Database does. Without it a
fit only shows that the model matches the data it was fitted to.

### Where the data might be

Access and field contents below are not confirmed. They need a request to the data holder.

- **Incident data.** The NZ Search and Rescue Council runs a [national SAR data project](https://nzsar.govt.nz/assets/Downloadable-Files/NZSAR-Link-30.pdf)
  and a data standard for reporting incidents. Public pages do not say which fields are held, whether positions are precise
  enough, or what access is granted. Police and LandSAR hold the operational records. Incidents involve deaths and medical
  detail, so expect ethics and privacy conditions.
- **Search team GPS logs** from operations and training exercises. These match New Zealand terrain and real search conditions
  best, and need the data holder's agreement.
- **DOC track times are not measured speeds.** DOC says walking times on its tracks are
  [set locally by ranger staff](https://www.doc.govt.nz/globalassets/documents/about-doc/oia/2024/february/oiad-3717-response.pdf)
  from the expected users and the track category. They can sanity-check a pace but not fit one.
- **Public GPS data** (OpenStreetMap traces, rogaine and orienteering routes, hunter and tramping logs) could give off-track
  speeds. These skew towards fit, experienced walkers, and each source has its own licence and consent terms.
- **Track geometry** to pair with those tracks: the [NZ Walking and Biking Tracks](https://koordinates.com/from/data.linz.govt.nz/layer/52100/)
  dataset.
- **Comparison baseline.** The International Search and Rescue Incident Database is the source of Koester's figures and is
  already used in [published modelling](https://www.nature.com/articles/s41598-026-54411-5). It is the right comparison, but it
  is not New Zealand.

### Limits to expect

- Incident data only contains cases where a search happened and someone was found, and track data comes from people who were
  not lost. Neither is a clean sample of "a lost person".
- New Zealand will not have enough cases for most of the 28 profiles.
- Where there is no LiDAR the engine uses a smoother elevation model. On LiDAR-covered terrain that costs about 7 to 10 % in
  contour area (too large, because slopes look gentler); the actual areas without LiDAR have no reference to test against, so
  their error is unmeasured.

### Suggested order

1. Ask the NZSAR Secretariat, Police and LandSAR for the fields above and for the access conditions. Everything else depends
   on the answer.
2. Run a sensitivity analysis on the existing engine, to confirm which parameters move the rings most, so collection targets
   those.
3. Fit the slope function and cross-slope penalty from tracks, if they can be had. This is the most transferable part and needs
   the least sensitive data.
4. Fit the TARR multipliers and, if the volume allows, the distances once incident data is available. Validate on held-out
   cases before changing any default.

Keep incident data and tracks out of this repository and out of the logs. Only the fitted parameters and aggregate statistics
belong here. When a New Zealand set is adopted, `calibrated_for_nz` is currently hard-coded to `false` (`sar-engine/nz/handler.py`) and the
disclaimers say the model is not validated; both need a reviewed code change, not just a new `tarrMultipliers`.

## Operations

- **TARR timing:** TARR runs the same stages as travel time (elevation, land cover, OSM, cost surface, cost distance), so
  its timings, the dense-area guard and the 55 s timeout behave the same way. The radius follows the profile and
  the multiplier: a Hiker on the default row is about 5.7 km and Abduction is about 29 km (not clipped). Only a few rows
  exceed 30 km and are clipped with a `limits` warning (Snowmobiler Temperate/Flat, Mental Illness
  Temperate/Mountainous).
- **Cost:** Lambda bills per run. A run takes 2 to 50 s at 2 GB (see below), which is roughly a tenth of a cent at most,
  by my estimate from list prices. Nothing runs when idle.
- **Speed**, measured on real Lambda in a non-production deployment through the public ALB: an 8 km radius in backcountry takes about 2 s warm
  and 12 s cold; 16 km about 7 s; the 30 km maximum about 14 s warm and 19 s cold. Wellington at 30 km takes 19 s.
  Peak memory was 0.6 to 1.6 GB of the 2 GB allocated.
- **Dense city cores are slower, and refused when they cannot finish.** The trail and road burn-in scales with the number
  of segments (about 237,000 in central Auckland at 30 km): central Auckland takes 23 s at 10 km, 43 s at 20 km, and would
  take 48 to 63 s at 30 km. The engine's dense-area guard (`sar-engine/nz/density_guard.py`) counts the segments after
  the OSM read and, if the estimated total exceeds the time budget, answers 422 `area_too_dense` in about 10 to 12 s with
  the largest radius (or longest time band) that fits. In testing, Auckland at 30 km is refused with 17 km, and 17 km then
  runs in 38 to 40 s. Christchurch at 30 km (30 s), Wellington (19 s) and backcountry (10 s) are not affected. The budget
  is `SAR_TIME_BUDGET_S` (default 45 s: a 55 s function timeout minus up to about 10 s of container start). The time
  model rests on four measurements, so the threshold is a calibrated guess and slightly conservative. If you change the
  function timeout or the Lambda size, re-measure and set the variable (not set by this stack).
- **Timeouts:** the ALB's idle timeout is 60 s, so the HTTP function's timeout is 55 s and the configuration refuses 60 or
  more. A run that exceeds it fails and the caller sees a 5xx (an HTML body from the ALB); the plugin should handle
  that. The dense-area guard exists to make this rare, not impossible.
- **Cold starts** cost a few seconds to about 10 s for a backcountry request, so provisioned concurrency is not needed for
  rare use. The first request after deploying a new image can be much slower, because the image is fetched lazily.
- **Region:** the LINZ elevation bucket is in Sydney (ap-southeast-2). An environment in another region pays a
  trans-ocean round trip on every request for the elevation stage; a deployment in the same region should be faster on that
  stage (not measured).
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
- **Upgrading the engine by hand (dev-test):** change the code in `sar-engine/`, commit it, and deploy with
  `usePreBuiltImages=false` (step 3). Nothing needs pushing or pinning.
- **Upgrading the engine through the workflows:** merge a change under `sar-engine/`. `demo-build.yml` builds a new image
  whenever the hash of the files the image copies changes (bump `sarEngine.imageTag` as well, to keep the label meaningful),
  then `demo-deploy.yml` deploys it. Production builds on a `v*` tag. An engine change reaches production with the next
  release, because the engine is part of this repository. To ship a new engine version, in this order:
  1. Merge the change, and let `demo-build.yml` / `demo-deploy.yml` build, push and deploy the image.
  2. Check with the `/sar/tarr` and `/sar/travel-time` requests from step 6.
  3. Then roll out the CloudTAK relay and the plugin. They need the new engine first: an older engine answers 404 on
     `/tarr`, which the relay reports as "SAR service unavailable".
  Optionally add `tarrMultipliers` to the keys file in the config bucket at any time.
- **Turning it off:** set `enabled` to `false`. The functions, rule, alarm and topic are removed; the data in S3 stays.

## Where the engine code comes from

`sar-engine/` is the TAK-NZ fork of [WiSAR Terrain-Aware Range Rings](https://github.com/clptak/WiSAR-Terrain-Aware-Range-Rings)
(AGPL-3.0, like this repository). It was vendored from `TAK-NZ/sar-engine` (commit `925f562`, branch `feat/linz-waterways`)
with `git subtree add`, without squashing, so its 75 commits and authors are kept: `git log --graph -- sar-engine` and
`git blame sar-engine/nz/tarr.py` still work. Before that the engine lived in its own repository and this repository built it
from a pinned commit (`sarEngine.engineRepo` / `engineRef`); those settings are gone. The separate repository is no longer
where changes are made. The upstream `app/pipeline/` package is deliberately not modified, so upstream changes can still be
merged with `git subtree pull --prefix=sar-engine <upstream-url> main` (not tried here). The engine's own deploy workflow
(it rsynced the Flask app to the original WiSAR server) was removed: it does not apply to the Lambda deployment.

## Changes needed outside this repository

- **base-infra ECR lifecycle:** its rules expire old images per tag prefix. `utils-sar-engine-` is not listed, so these
  images are never expired until a rule `{ tagPrefixList: ['utils-sar-engine-'], maxImageCount: ... }` is added.
- **TAK-NZ CloudTAK fork:** the `/api/sar/*` relay (like the weather one) holds the key and calls this endpoint. It
  exists on the CloudTAK branches `feat/sar-relay` (travel time) and `feat/sar-tarr-relay` (adds `/api/sar/tarr`). The
  `cloudtak-plugin-sar` plugin (branch `feat/side-pane-tarr-export` for TARR and the side pane) calls the relay. Neither
  is deployed from this repository.

## What has and has not been verified

Verified in a non-production deployment, October 2026:

- Lambda pulls the image from the shared KMS-encrypted ECR repository (the repository policy is sufficient).
- The `kms:ViaService` condition works: the HTTP function reads the land cover raster, the OSM snapshot and the API key
  file, and the refresh function writes the snapshot, all through S3.
- The public ALB path (`/sar/*`), authentication (missing or wrong key gives 401), validation, the sea-start rejection
  and real analyses at radii up to the 30 km maximum.
- The first OSM refresh: dry run and publish, 971,529 features in about 100 s, KMS-encrypted, pointer updated.
- Request logs contain timings, sizes and status only; none of the coordinates used in testing appeared.
- Travel time and TARR, invoked directly, answer `ok` (three and six contours respectively), with the LINZ data version and
  the LINZ attribution line present and no `linz-water` warning.

**Not verified:**

- Other environments with the current engine. Each needs the image built from `sar-engine/` deployed and its data files
  uploaded (the land cover raster, an OSM snapshot and, optionally, the LINZ files). An image that predates the TARR route
  answers 404 on `/sar/tarr`.
- The monthly schedule actually firing, and the failure alarm and SNS delivery (the topic has no subscribers).
- Production.
- Behaviour under concurrent requests.
- Reaching `download.geofabrik.de` worked from the refresh function (functions are not placed in a VPC), but a Geofabrik
  outage or rate limit has not been exercised.

## Lessons from the first deployment

Two defects reached the first deployment because all local tests ran as root, which Lambda does not: an image whose files were readable
only by root (every request returned 502), and an OSM build that silently produced no features when run from Lambda's
read-only working directory. Both are fixed in `sar-engine/` and guarded (the image build fails if the code cannot be
imported as an unprivileged user). Test engine changes locally with `--user 1000:1000 --read-only` and only `/tmp` writable.
