# Offline map generation

Generates large, downloadable offline map files for NZ:

- `generate-regional-mbtiles.py` — LINZ Topo50 raster tiles (with relief
  shading) per region, mbtiles format. Output → `MapDownloadsBucket`
  (user-facing downloads via TAK Team Manager).
- `generate-marine-mbtiles.py` — LINZ nautical charts, tiered coverage
  (full EEZ at low zoom, coastal/harbour detail at high zoom), mbtiles format.
  Output → `MapDownloadsBucket`.
- The NZ OMT vector basemap (`scripts/nz-omt-tileset/`, `nz-omt.mbtiles` +
  `nz-omt-buildings.mbtiles`) — the ATAK vector basemap tileserver-gl serves.
  This used to run monthly on GitHub Actions; it's now step 6 of
  `user-data.sh`, folded into this same annual instance. Output → **both**
  `AppImagesBucket` (internal, so tileserver-gl's tile-downloader init
  container can fetch it, followed by a forced ECS service reload so
  tileserver-gl picks up the refresh) **and** `MapDownloadsBucket` under
  `vector/` (so users can download the vector basemap directly, same as the
  regional/marine files). See "Where the refresh runs now" in
  `docs/ATAK_3D_BUILDINGS.md` for the reasoning and disk-space history behind the
  move to this instance.

All three are built manually, roughly once a year, and all three end up
available for download via the TAK Team Manager portal (users grab the
mbtiles for their region/area of interest, or the national vector basemap,
and sideload it into ATAK). The vector basemap additionally lands in the
artifacts bucket because that's what the live `tileserver-gl` service reads
from — it rides along on the same instance because it needs the same LINZ
API key and has no meaningful reason to be a separate build mechanism.

## Why this doesn't run in GitHub Actions

A full run (16 regions + marine charts, at the zoom ranges these scripts
default to) takes multiple days. GitHub Actions hosted runners have a hard
6-hour job timeout — not a disk-space problem to work around like
`update-linz-tiles.yml` does, a hard ceiling with no override. So this runs on
a manually-launched, self-terminating EC2 instance instead.

## Prerequisite: base-infra must be deployed with the map-downloads resources

This depends on CDK resources added to `base-infra` alongside this folder:
a dedicated `MapDownloadsBucket` (kept separate from the `AppImagesBucket`
build-staging bucket — see `base-infra/lib/constructs/services.ts`,
`createMapDownloadsBucket`), an EC2 instance role/profile scoped to exactly
what the build needs (`createMapBuildInstanceRole`), an SNS topic for
progress/completion notifications, and an IAM role for the stale-instance
safety net.

Deploy or update `base-infra` first:

```bash
cd base-infra
npx cdk deploy --context envType=dev-test   # or prod
```

`launch-build-instance.sh` resolves everything it needs from that stack's
CloudFormation exports at launch time — nothing is hardcoded.

## Running a build

```bash
cd offline-maps
./launch-build-instance.sh --base-stack TAK-Demo-BaseInfra --region us-west-2
```

This:

1. Resolves the map-downloads bucket, instance profile, SNS topic, and
   scheduler role from `base-infra`'s CloudFormation exports
2. Packages `offline-maps/` and `scripts/nz-omt-tileset/` from **your local
   working tree** into a tarball and uploads it to
   `s3://<ArtifactsBucket>/offline-maps-bundles/` -- the instance runs this
   exact bundle, not a `git clone` of whatever's pushed to GitHub. This is
   deliberate: the instance previously cloned from `origin`, which failed the
   first real run because this code wasn't pushed yet. A local bundle can't
   go stale like that and doesn't depend on GitHub being reachable for a
   multi-day build. **Commit and push your changes anyway if you want the
   history preserved** -- the bundle is just what actually runs.
3. Resolves the latest Amazon Linux 2023 AMI
4. Launches a `t4g.large` (Graviton/arm64) instance (no inbound ports, no SSH
   key — reached only via SSM Session Manager) with a 100GB gp3 root volume
5. Creates a one-time EventBridge Scheduler safety net that force-terminates
   the instance after 10 days if it's still running (see "Safety net" below)
6. The instance's user-data (`user-data.sh`) does the actual work: fetches
   and extracts the bundle, fetches the LINZ API key from the same S3 config
   object `terrain-proxy` already reads, runs both generator scripts (output
   → map-downloads bucket), then builds the NZ OMT vector basemap (output →
   both the artifacts bucket and map-downloads, plus a forced tileserver-gl
   reload), and self-terminates

Use `--dry-run` first to see the resolved command and rendered user-data
without launching anything:

```bash
./launch-build-instance.sh --base-stack TAK-Demo-BaseInfra --region us-west-2 --dry-run
```

Run `./launch-build-instance.sh --help` for all options (instance type,
volume size, max runtime, AMI override).

### Sizing the EBS volume

The default (`--volume-size 100`) is a starting point, not a measured value.
Before trusting it for a full national run, measure actual peak disk usage
locally for one region:

```bash
python3 generate-regional-mbtiles.py --region auckland --output-dir /tmp/test
du -sh /tmp/test
```

Scale from there — outputs are uploaded and deleted immediately after each
region completes (see `user-data.sh`), so the volume only ever needs headroom
for the *largest single* region/marine-chart output plus some margin, not the
sum of everything.

## Monitoring a running build

```bash
aws ssm start-session --target <instance-id> --region us-west-2
# then, on the instance:
tail -f /var/log/cloud-init-output.log
```

Output is also streamed to CloudWatch Logs, log group `/offline-maps/build`,
log stream named after the instance ID — so progress is visible even after the
instance terminates.

### Notifications

The instance publishes to the `MapBuildNotifications` SNS topic on every
region/chart upload, and once more on final completion or failure. Nobody is
subscribed by default — subscribe once:

```bash
aws sns subscribe \
  --topic-arn <MapBuildNotificationsTopicArn from base-infra output> \
  --protocol email --notification-endpoint you@example.com \
  --region us-west-2
```

## Re-running after a partial failure

Both the launch script and `user-data.sh` are designed around resuming, not
restarting from scratch:

- **Regional builds**: each region's output is checked against S3
  (`head-object`) before that region is (re-)built. Just re-run
  `launch-build-instance.sh` the same way — completed regions are skipped
  automatically, only the regions that failed or never ran get rebuilt.
- **Marine charts**: `generate-marine-mbtiles.py` produces one national file
  with no internal per-region checkpointing. If it fails partway through, a
  re-run restarts that file from scratch — there's no cheaper way to resume it
  with the script's current design. Regional builds are unaffected by a
  marine-charts failure (or vice versa); they run in fully independent steps.
- **NZ OMT vector basemap**: no resume/skip check at all (unlike the other two
  steps) — it always rebuilds both variants. This is deliberate: the build
  takes roughly 83 minutes total, not multiple days, so re-running it in full
  on any retry is cheap enough that skip-logic would add complexity for no
  real benefit.

## Safety net: stale instance protection

If `user-data.sh` crashes before reaching its own `shutdown -h now`, the
instance would otherwise run (and bill) indefinitely with nobody watching a
multi-day job. `launch-build-instance.sh` creates a one-time EventBridge
Scheduler schedule at launch that force-terminates that specific instance ID
after `--max-runtime-days` (default: 10). If the build finishes normally
before then, the schedule still fires later but harmlessly no-ops against an
already-terminated instance ID (EC2 instance IDs are never reused), and
EventBridge Scheduler deletes the schedule resource itself after that one
firing.

## Cost

Real on-demand pricing, `t4g.large` (Graviton/arm64, current generation) in
`us-west-2` (checked via `aws pricing get-products`, not estimated):
**$0.0672/hour** — about 19% cheaper than the equivalent x86 `t3.large`
($0.0832/hour) at the identical 2 vCPU / 8GB spec, with nothing in this
workload requiring x86 (the Python scripts and tippecanoe, built from source,
are both architecture-portable). A rough 5-day run:

| Item | Cost |
|---|---|
| Compute (5 days) | ~$8.06 |
| EBS gp3, 100GB, 5 days | ~$1.33 |
| **Total per run** | **~$9.40** |

At roughly once a year, this is trivial — not worth trading for Spot pricing
given the risk of a mid-build interruption with no sophisticated
checkpoint/resume logic beyond the per-region granularity described above.

## Output layout in S3

```
s3://<MapDownloadsBucket>/
  regional/{region-key}-topo.mbtiles   # one per region, 16 files
  marine/nz-marine-charts.mbtiles      # one national file
  vector/nz-omt.mbtiles                # vector basemap, no buildings
  vector/nz-omt-buildings.mbtiles      # vector basemap, 3D buildings

s3://<AppImagesBucket>/
  nz-omt.mbtiles                       # same file, tileserver-gl's own copy
  nz-omt-buildings.mbtiles             # same file, tileserver-gl's own copy
```

`region-key` matches the keys in `REGIONS` in `generate-regional-mbtiles.py`
(e.g. `auckland`, `wellington`, `chatham-islands`). The whole-island
superset regions (`north-island`, `south-island`) are deliberately **not**
built by this pipeline — they geographically overlap almost every smaller
region and would roughly double download time/storage for no benefit given
the per-region downloads already cover the same ground.

The two vector basemap files are uploaded to **both** buckets — they're
independent uploads of the same local build output, not a copy-between-
buckets step, so a failure uploading to one doesn't silently skip the other
(see `user-data.sh` step 6). TAK Team Manager reads from `MapDownloadsBucket`
to mint presigned download URLs for authenticated users — that's the case
for all four file types now, regional, marine, and vector. `AppImagesBucket`
is a separate, internal bucket that `tileserver-gl` reads from directly (via
its EFS-mounted `tile-downloader` init container); nobody downloads from it
through the portal, it exists purely to keep the live service fed.

Also in `AppImagesBucket`, under `offline-maps-bundles/` — the code bundles
`launch-build-instance.sh` uploads at each launch (see "Running a build"
above). These aren't automatically cleaned up. Once a build has completed
(or you're confident an old one is no longer needed), delete them manually:

```bash
aws s3 rm "s3://<ArtifactsBucket>/offline-maps-bundles/" --recursive
```
