# SAR Engine

Terrain-aware search-and-rescue planning for New Zealand: given an Initial Planning Point (IPP), a walking speed and some
time bands, it returns contours of where a person could physically have reached. It is the backend for the
[`cloudtak-plugin-sar`](https://github.com/TAK-NZ/cloudtak-plugin-sar) CloudTAK plugin.

- **Source, data pipeline and method:** [TAK-NZ/sar-engine](https://github.com/TAK-NZ/sar-engine) (a fork of WiSAR
  Terrain-Aware Range Rings, AGPL-3.0). Read its `NZ_PORT.md` for the data sources, measurements and known gaps.
- **This repository:** deploys it as two AWS Lambda functions from one container image, behind the existing ALB.

**Planning aid only.** The contours show reach, not likelihood, and the terrain model is not validated against New
Zealand search and rescue data. There is no NZ calibration, so percentile "probability" rings are deliberately not
offered.

## What gets deployed

| Resource | Purpose |
|---|---|
| HTTP Lambda (`SarEngineHttpFn`) | `POST /sar/travel-time` and `GET /sar/health`, behind the ALB at `https://utils.<domain>/sar/*`. |
| Refresh Lambda (`SarEngineRefreshFn`) | Same image, command `osm_refresh.lambda_handler`. Rebuilds the OpenStreetMap snapshot monthly. |
| EventBridge rule | Runs the refresh on day 3 of each month at 14:00 UTC (configurable). Two automatic retries. |
| CloudWatch alarm + SNS topic | Alarms when a refresh run fails. The topic has **no subscribers** until you add one. |
| ALB target group + listener rule | Path `/sar/*`, priority 7. Health checks are off (they would invoke the function every 35 s). |

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
```

## API

`POST /sar/travel-time` with header `x-api-key`:

```json
{ "ipp": { "lat": -40.87, "lng": 175.45 }, "speed_kmh": 2.0, "intervals_hours": [1, 2, 4], "radius_km": 10 }
```

`radius_km` is optional. Limits: IPP on land in mainland NZ (a start in the sea or a lake returns 422), speed 0.1 to 10
km/h, 1 to 8 intervals of 0.25 to 24 h, radius at most 30 km. The response holds GeoJSON `contours`, `warnings`
(for example when elevation was filled from a coarser source), the data versions, the required attributions and a
disclaimer. Full details are in sar-engine's `NZ_PORT.md`.

## Operations

- **Cost:** Lambda bills per run. A run takes 2 to 50 s at 2 GB (see below), which is roughly a tenth of a cent at most,
  by my estimate from list prices. Nothing runs when idle.
- **Speed**, measured on real Lambda in Test through the public ALB: an 8 km radius in backcountry takes about 2 s warm
  and 12 s cold; 16 km about 7 s; the 30 km maximum about 14 s warm and 19 s cold. Wellington at 30 km takes 19 s.
  Peak memory was 0.6 to 1.6 GB of the 2 GB allocated.
- **Dense city cores are slower.** The trail and road burn-in scales with the number of segments (about 250,000 in central
  Auckland at 30 km): central Auckland takes 26 s at 10 km and 50 s at 30 km warm, and 63 s cold, which exceeds the ALB's
  60 s and would fail for a client. Central Christchurch is the next worst. Backcountry starts (every location surveyed has
  under 6,000 segments within 20 km) are unaffected. See sar-engine's `NZ_PORT.md` for the cause.
- **Timeouts:** the ALB's idle timeout is 60 s, so the HTTP function's timeout is 55 s and the configuration refuses 60 or
  more. A run that exceeds it fails and the caller sees a 5xx; the plugin should handle that.
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
  tag, so CI builds it instead of reusing the old one.
- **Turning it off:** set `enabled` to `false`. The functions, rule, alarm and topic are removed; the data in S3 stays.

## Changes needed outside this repository

- **base-infra ECR lifecycle:** its rules expire old images per tag prefix. `utils-sar-engine-` is not listed, so these
  images are never expired until a rule `{ tagPrefixList: ['utils-sar-engine-'], maxImageCount: ... }` is added.
- **TAK-NZ CloudTAK fork:** a `/api/sar/*` relay (like the weather one) that holds the key and calls this endpoint, and
  the `cloudtak-plugin-sar` plugin itself. Neither exists yet.

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
- Behaviour under concurrent requests.
- Reaching `download.geofabrik.de` worked from the refresh function (functions are not placed in a VPC), but a Geofabrik
  outage or rate limit has not been exercised.

## Lessons from the first deployment

Two defects reached Test because all local tests ran as root, which Lambda does not: an image whose files were readable
only by root (every request returned 502), and an OSM build that silently produced no features when run from Lambda's
read-only working directory. Both are fixed in sar-engine and guarded (the image build fails if the code cannot be
imported as an unprivileged user). Test engine changes with `--user 1000:1000 --read-only` and only `/tmp` writable.
