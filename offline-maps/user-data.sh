#!/bin/bash
# EC2 user-data template. launch-build-instance.sh renders this, replacing
# __PLACEHOLDER__ vars with real CFN export values (and a code bundle
# uploaded to S3 at launch -- see BUNDLE_S3_URI, step 3). Update the sed
# substitution there too if marker names change.
#
# Runs as root via cloud-init. Output -> /var/log/cloud-init-output.log
# (SSM Session Manager) and CloudWatch Logs (see below).
#
# Resumable across a full reboot: this account's SSM patch-baseline
# association reboots instances shortly after launch, and user-data only
# runs ONCE per instance by cloud-init design -- confirmed needed (twice).
# Step 0 installs this as a systemd unit that reruns on every boot.

set -uo pipefail  # no -e: one failed region/step must not abort the whole
                   # multi-day job; each step below checks its own status.

MAP_DOWNLOADS_BUCKET="__MAP_DOWNLOADS_BUCKET__"
NOTIFICATIONS_TOPIC_ARN="__NOTIFICATIONS_TOPIC_ARN__"
ENV_CONFIG_BUCKET="__ENV_CONFIG_BUCKET__"
ARTIFACTS_BUCKET="__ARTIFACTS_BUCKET__"
ECS_CLUSTER_NAME="__ECS_CLUSTER_NAME__"
BUNDLE_S3_URI="__BUNDLE_S3_URI__"
# Skip flags: --skip-regional/-marine/-vector.
SKIP_REGIONAL="__SKIP_REGIONAL__"
SKIP_MARINE="__SKIP_MARINE__"
SKIP_VECTOR="__SKIP_VECTOR__"
ENV_CONFIG_KEY="Utils-Terrain-Proxy-Config.json"
# felt/tippecanoe fork; built from source (AL2023 dnf lacks it).
TIPPECANOE_VERSION="2.79.0"

WORKDIR="/mnt/build"
LOG_GROUP="/offline-maps/build"
TOKEN="$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')"
INSTANCE_ID="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"

FAILURES=()

notify() {
  aws sns publish --region "$REGION" --topic-arn "$NOTIFICATIONS_TOPIC_ARN" \
    --subject "$1" --message "$2" || true
}

# 0. Install self as a systemd unit so this reruns on EVERY boot. Copy from
# cloud-init's rendered user-data path, not $0.
SELF_PATH="/var/lib/offline-map-build/run.sh"
BOOT_COUNT_FILE="/var/lib/offline-map-build/boot-count"

if [[ ! -f "$SELF_PATH" ]]; then
  echo "First boot: installing systemd unit for auto-resume after reboot."
  mkdir -p "$(dirname "$SELF_PATH")"
  cp /var/lib/cloud/instance/user-data.txt "$SELF_PATH"
  chmod +x "$SELF_PATH"
  echo 0 > "$BOOT_COUNT_FILE"

  cat > /etc/systemd/system/offline-map-build.service <<'UNIT'
[Unit]
Description=Offline map build (resumes automatically after any reboot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash /var/lib/offline-map-build/run.sh

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable offline-map-build.service
fi

BOOT_COUNT="$(( $(cat "$BOOT_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))"
echo "$BOOT_COUNT" > "$BOOT_COUNT_FILE"
if [[ "$BOOT_COUNT" -gt 1 ]]; then
  notify "Offline map build RESUMED on $INSTANCE_ID" \
    "Boot #$BOOT_COUNT. Rebooted (likely SSM patch baseline). Resuming via systemd unit; already-uploaded work is skipped."
  echo "=== Resuming after reboot: boot #$BOOT_COUNT ==="
fi

finish() {
  local exit_code=$?
  if [[ ${#FAILURES[@]} -gt 0 ]]; then
    notify "Offline map build FAILED on $INSTANCE_ID" \
      "One or more steps failed: ${FAILURES[*]}. Check /offline-maps/build in CloudWatch Logs (log stream $INSTANCE_ID) before this instance terminates. Terminating now."
  elif [[ $exit_code -ne 0 ]]; then
    notify "Offline map build FAILED on $INSTANCE_ID" \
      "Script exited with code $exit_code before completing. Check /offline-maps/build in CloudWatch Logs (log stream $INSTANCE_ID). Terminating now."
  else
    notify "Offline map build COMPLETE on $INSTANCE_ID" \
      "All requested mbtiles generated and uploaded to s3://${MAP_DOWNLOADS_BUCKET}/. Terminating now."
  fi
  shutdown -h now
}
trap finish EXIT

echo "=== Offline map build starting: $(date -u) on $INSTANCE_ID in $REGION ==="

# 1. Dependencies. node+tippecanoe are for step 6 (NZ OMT vector basemap).
# nodejs22 (not bare "nodejs"): translate.js needs built-in `node:sqlite`
# (Node >=22.5.0), and bare "nodejs" via AL2023 `alternatives` isn't
# guaranteed >=22 -- confirmed once: "No such built-in module: node:sqlite".
if ! dnf install -y git python3 python3-pip sqlite sqlite-devel awscli amazon-cloudwatch-agent \
    nodejs22 nodejs22-npm gcc-c++ make zlib-devel jq; then
  FAILURES+=("dependency-install")
fi

# Skip if already installed. rm -rf clone dir first -- a mid-build reboot
# can leave it stale/non-empty, which silently blocks `git clone` on retry.
if command -v tippecanoe >/dev/null 2>&1; then
  echo "tippecanoe already installed (previous boot), skipping build"
elif rm -rf /tmp/tippecanoe \
    && git clone --depth 1 --branch "$TIPPECANOE_VERSION" https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && make -C /tmp/tippecanoe -j"$(nproc)" \
    && make -C /tmp/tippecanoe install; then
  rm -rf /tmp/tippecanoe
else
  echo "FATAL: could not build tippecanoe"
  FAILURES+=("tippecanoe-build")
fi

# Stream cloud-init output to CloudWatch Logs so it survives termination.
mkdir -p /opt/aws/amazon-cloudwatch-agent/etc
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<EOF
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/cloud-init-output.log",
            "log_group_name": "${LOG_GROUP}",
            "log_stream_name": "${INSTANCE_ID}",
            "timestamp_format": "%b %d %H:%M:%S"
          }
        ]
      }
    }
  }
}
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json || \
  FAILURES+=("cloudwatch-agent-start")

# 2. Fetch the LINZ API key from S3 config (same object terrain-proxy reads)
mkdir -p "$WORKDIR"
cd "$WORKDIR" || { FAILURES+=("cd-workdir"); exit 1; }

if ! aws s3 cp "s3://${ENV_CONFIG_BUCKET}/${ENV_CONFIG_KEY}" ./config.json --region "$REGION"; then
  echo "FATAL: could not fetch LINZ API key config from s3://${ENV_CONFIG_BUCKET}/${ENV_CONFIG_KEY}"
  FAILURES+=("fetch-linz-api-key")
  exit 1
fi
LINZ_API_KEY="$(python3 -c "import json; print(json.load(open('config.json'))['apikey'])")"
if [[ -z "$LINZ_API_KEY" || "$LINZ_API_KEY" == "None" ]]; then
  echo "FATAL: config.json has no 'apikey' field"
  FAILURES+=("linz-api-key-missing")
  exit 1
fi
export LINZ_API_KEY
export TILESERVER_API_KEY="$LINZ_API_KEY"  # unused by default tileset, set for completeness

# 3. Fetch and extract the code bundle (not git clone; offline-maps/ isn't
# always pushed). Skip re-extracting if a previous boot already did.
if [[ -d "$WORKDIR/repo/offline-maps" ]]; then
  echo "Bundle already extracted (previous boot), skipping"
else
  mkdir -p repo
  if ! aws s3 cp "$BUNDLE_S3_URI" "$WORKDIR/bundle.tar.gz" --region "$REGION"; then
    echo "FATAL: could not fetch bundle from $BUNDLE_S3_URI"
    FAILURES+=("fetch-bundle")
    exit 1
  fi
  if ! tar xzf "$WORKDIR/bundle.tar.gz" -C repo; then
    echo "FATAL: could not extract bundle"
    FAILURES+=("extract-bundle")
    exit 1
  fi
  rm -f "$WORKDIR/bundle.tar.gz"
fi
cd repo/offline-maps || { FAILURES+=("cd-repo"); exit 1; }

# 4. Regional raster mbtiles, skipping regions already in S3. north/south
# island excluded: they overlap every smaller region, no benefit to building.
if [[ "$SKIP_REGIONAL" == "true" ]]; then
  echo "=== Skipping regional raster mbtiles (--skip-regional) ==="
else
REGIONS=$(python3 generate-regional-mbtiles.py --list-regions 2>/dev/null \
  | awk '/ tiles$/ && $1!="TOTAL" {print $1}' \
  | grep -v -E '^(north-island|south-island)$')

for region in $REGIONS; do
  OUT_KEY="regional/${region}-topo.mbtiles"
  if aws s3api head-object --bucket "$MAP_DOWNLOADS_BUCKET" --key "$OUT_KEY" --region "$REGION" >/dev/null 2>&1; then
    echo "SKIP (already in S3): $region"
    continue
  fi

  echo "=== Building region: $region ($(date -u)) ==="
  if ! python3 generate-regional-mbtiles.py --region "$region" --output-dir "$WORKDIR/out"; then
    echo "FAILED: $region"
    FAILURES+=("region-${region}")
    continue
  fi

  OUT_FILE="$WORKDIR/out/${region}-topo.mbtiles"
  if [[ -f "$OUT_FILE" ]]; then
    if aws s3 cp "$OUT_FILE" "s3://${MAP_DOWNLOADS_BUCKET}/${OUT_KEY}" --region "$REGION"; then
      rm -f "$OUT_FILE"  # reclaim disk immediately
      notify "Offline map build progress on $INSTANCE_ID" "Uploaded $OUT_KEY"
    else
      FAILURES+=("upload-${region}")
    fi
  else
    echo "FAILED: $region produced no output file"
    FAILURES+=("region-${region}-no-output")
  fi
done
fi

# 5. Marine charts (single national file, no per-region resume).
if [[ "$SKIP_MARINE" == "true" ]]; then
  echo "=== Skipping marine charts (--skip-marine) ==="
else
MARINE_KEY="marine/nz-marine-charts.mbtiles"
if aws s3api head-object --bucket "$MAP_DOWNLOADS_BUCKET" --key "$MARINE_KEY" --region "$REGION" >/dev/null 2>&1; then
  echo "SKIP (already in S3): marine charts"
else
  echo "=== Building marine charts ($(date -u)) ==="
  if python3 generate-marine-mbtiles.py --output "$WORKDIR/nz-marine-charts.mbtiles" \
      && [[ -f "$WORKDIR/nz-marine-charts.mbtiles" ]]; then
    if aws s3 cp "$WORKDIR/nz-marine-charts.mbtiles" "s3://${MAP_DOWNLOADS_BUCKET}/${MARINE_KEY}" --region "$REGION"; then
      rm -f "$WORKDIR/nz-marine-charts.mbtiles"
      notify "Offline map build progress on $INSTANCE_ID" "Uploaded $MARINE_KEY"
    else
      FAILURES+=("upload-marine-charts")
    fi
  else
    echo "FAILED: marine charts"
    FAILURES+=("marine-charts")
  fi
fi
fi

# 6. NZ OMT vector basemap. Uploads both variants to BOTH buckets:
# artifacts (tile-downloader) and map-downloads/vector/ (user-facing).
if [[ "$SKIP_VECTOR" == "true" ]]; then
  echo "=== Skipping NZ OMT vector basemap (--skip-vector) ==="
else
echo "=== Building NZ OMT vector basemap ($(date -u)) ==="

if [[ -d "$WORKDIR/repo/scripts/nz-omt-tileset" ]] && cd "$WORKDIR/repo/scripts/nz-omt-tileset"; then
  if ! npm install; then
    FAILURES+=("nz-omt-npm-install")
  else
    if ! aws s3 cp "s3://${ARTIFACTS_BUCKET}/linz-vector-tiles.mbtiles" "$WORKDIR/linz-vector-tiles.mbtiles" --region "$REGION"; then
      FAILURES+=("nz-omt-fetch-linz-source")
    elif ! aws s3 cp "s3://${ARTIFACTS_BUCKET}/nz-building-heights.pmtiles" "$WORKDIR/nz-building-heights.pmtiles" --region "$REGION"; then
      FAILURES+=("nz-omt-fetch-heights-source")
    else
      NZ_OMT_OK=1
      # --workdir on EBS, not build.sh's tmpfs /tmp default (AL2023 caps
      # /tmp at 50% RAM, ~4GB here; per-zoom intermediates accumulate).
      if ! ./build.sh --linz "$WORKDIR/linz-vector-tiles.mbtiles" \
          --heights "$WORKDIR/nz-building-heights.pmtiles" \
          --workdir "$WORKDIR/omt-work-buildings" \
          --out "$WORKDIR/nz-omt-buildings.mbtiles"; then
        FAILURES+=("nz-omt-build-buildings-variant")
        NZ_OMT_OK=0
      else
        if ! aws s3 cp "$WORKDIR/nz-omt-buildings.mbtiles" "s3://${ARTIFACTS_BUCKET}/nz-omt-buildings.mbtiles" --region "$REGION"; then
          FAILURES+=("nz-omt-upload-buildings-variant-artifacts")
          NZ_OMT_OK=0
        fi
        if ! aws s3 cp "$WORKDIR/nz-omt-buildings.mbtiles" "s3://${MAP_DOWNLOADS_BUCKET}/vector/nz-omt-buildings.mbtiles" --region "$REGION"; then
          FAILURES+=("nz-omt-upload-buildings-variant-downloads")
          NZ_OMT_OK=0
        fi
      fi
      rm -f "$WORKDIR/nz-omt-buildings.mbtiles"
      rm -rf "$WORKDIR/omt-work-buildings"

      if ! ./build.sh --linz "$WORKDIR/linz-vector-tiles.mbtiles" \
          --workdir "$WORKDIR/omt-work-base" \
          --out "$WORKDIR/nz-omt.mbtiles"; then
        FAILURES+=("nz-omt-build-base-variant")
        NZ_OMT_OK=0
      else
        if ! aws s3 cp "$WORKDIR/nz-omt.mbtiles" "s3://${ARTIFACTS_BUCKET}/nz-omt.mbtiles" --region "$REGION"; then
          FAILURES+=("nz-omt-upload-base-variant-artifacts")
          NZ_OMT_OK=0
        fi
        if ! aws s3 cp "$WORKDIR/nz-omt.mbtiles" "s3://${MAP_DOWNLOADS_BUCKET}/vector/nz-omt.mbtiles" --region "$REGION"; then
          FAILURES+=("nz-omt-upload-base-variant-downloads")
          NZ_OMT_OK=0
        fi
      fi
      rm -f "$WORKDIR/nz-omt.mbtiles" "$WORKDIR/linz-vector-tiles.mbtiles" "$WORKDIR/nz-building-heights.pmtiles"
      rm -rf "$WORKDIR/omt-work-base"

      if [[ "${NZ_OMT_OK:-0}" == "1" ]]; then
        notify "Offline map build progress on $INSTANCE_ID" "Uploaded nz-omt-buildings.mbtiles and nz-omt.mbtiles to both artifacts and map-downloads buckets"

        # shellcheck disable=SC2016  # JMESPath, not meant to expand
        SERVICE_NAME="$(aws ecs list-services --cluster "$ECS_CLUSTER_NAME" --region "$REGION" \
          --query 'serviceArns[?contains(@,`tileserver-gl`)]' --output text | xargs -n1 basename 2>/dev/null || true)"
        if [[ -z "$SERVICE_NAME" ]]; then
          echo "tileserver-gl service not found in cluster $ECS_CLUSTER_NAME, skipping reload"
        else
          TASK_DEF_ARN="$(aws ecs describe-services --cluster "$ECS_CLUSTER_NAME" --services "$SERVICE_NAME" --region "$REGION" \
            --query 'services[0].taskDefinition' --output text)"
          aws ecs describe-task-definition --task-definition "$TASK_DEF_ARN" --region "$REGION" \
            --query 'taskDefinition' > "$WORKDIR/task-def.json"
          jq '.containerDefinitions |= map(
            if .name == "tile-downloader" then
              .environment |= (map(if .name == "FORCE_DOWNLOAD" then .value = "true" else . end) |
              if (map(.name) | contains(["FORCE_DOWNLOAD"]) | not) then
                . + [{"name": "FORCE_DOWNLOAD", "value": "true"}]
              else . end)
            else . end
          ) | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions,
             volumes, placementConstraints, requiresCompatibilities, cpu, memory}' \
            "$WORKDIR/task-def.json" > "$WORKDIR/new-task-def.json"
          NEW_TASK_DEF_ARN="$(aws ecs register-task-definition --region "$REGION" \
            --cli-input-json "file://$WORKDIR/new-task-def.json" \
            --query 'taskDefinition.taskDefinitionArn' --output text)"
          aws ecs update-service --cluster "$ECS_CLUSTER_NAME" --service "$SERVICE_NAME" --region "$REGION" \
            --task-definition "$NEW_TASK_DEF_ARN" --force-new-deployment >/dev/null
          echo "tileserver-gl service updated to $NEW_TASK_DEF_ARN -- will re-download refreshed NZ OMT tilesets"
        fi
      fi
    fi
  fi
else
  echo "FAILED: repo checkout does not contain scripts/nz-omt-tileset, or could not cd into it"
  FAILURES+=("nz-omt-missing-source")
fi
fi

echo "=== Offline map build finished: $(date -u). Failures: ${FAILURES[*]:-none} ==="
# `finish` (trap on EXIT) handles the final notify+shutdown regardless.
