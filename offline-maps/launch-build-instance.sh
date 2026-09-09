#!/bin/bash
# Launch a one-off EC2 instance to generate large offline map mbtiles files
# (regional raster tilesets, marine charts), upload results to the
# map-downloads S3 bucket, and self-terminate when done.
#
# This exists because the underlying builds take multiple days -- far past
# GitHub Actions' 6-hour hard job timeout -- so they run on a real EC2
# instance with real disk, launched and torn down manually, roughly once a
# year (LINZ topo-raster/aerial imagery and marine chart corrections don't
# refresh often enough to justify more).
#
# What this script does NOT do: run the build itself. It only launches the
# instance with a user-data script (see user-data.sh) that does the actual
# work. This script's job is entirely about getting the instance up with the
# right role, tags, and volume size, then getting out of the way.
#
# Usage:
#   ./launch-build-instance.sh --base-stack TAK-Demo-BaseInfra \
#       --linz-api-key-secret Utils-Terrain-Proxy-Config.json \
#       [--instance-type t4g.large] [--volume-size 100] [--region us-west-2] \
#       [--dry-run]
#
# Requires: AWS CLI v2, credentials with permission to run/tag EC2 instances
# and read the base-infra stack's CloudFormation exports.
#
# The instance:
#   - has NO inbound ports open (not even SSH) -- use SSM Session Manager
#     (`aws ssm start-session --target <instance-id>`) for interactive access
#   - assumes the MapBuildInstance role/instance profile created in
#     base-infra (see base-infra/lib/constructs/services.ts,
#     createMapBuildInstanceRole)
#   - is tagged Purpose=offline-map-build, which is what scopes its own
#     self-termination permission (see the role's IAM policy) and what the
#     safety-net stale-instance alarm (see setup-stale-instance-alarm.sh)
#     matches on
#   - sets InstanceInitiatedShutdownBehavior=terminate, so the user-data
#     script's final `shutdown -h now` on success -- or any unexpected OS-level
#     shutdown -- results in actual termination, not a stopped-but-billing
#     instance
#
# Safety net: if the build script crashes before reaching its own shutdown
# call, the instance would otherwise run unattended indefinitely. Run
# setup-stale-instance-alarm.sh once (separately, it's idempotent) to install
# an EventBridge rule that force-terminates anything tagged
# Purpose=offline-map-build past a generous max age. That alarm is
# independent of this script and does not need to be re-run per build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
INSTANCE_TYPE="t4g.large"
VOLUME_SIZE_GB=100
MAX_RUNTIME_DAYS=10
REGION=""
BASE_STACK=""
DRY_RUN=false
AMI_ID=""  # resolved at runtime unless overridden
SKIP_REGIONAL=false
SKIP_MARINE=false
SKIP_VECTOR=false

usage() {
  cat <<'EOF'
Usage: launch-build-instance.sh --base-stack <name> [options]

Required:
  --base-stack NAME       CloudFormation stack name of the base-infra stack,
                          e.g. TAK-Demo-BaseInfra. Used to resolve the
                          MapDownloadsBucket, MapBuildInstanceProfileName, and
                          MapBuildNotificationsTopicArn exports.

Options:
  --region REGION         AWS region to launch in (default: current CLI
                          configured region)
  --instance-type TYPE    EC2 instance type (default: t4g.large -- Graviton
                          (arm64), current generation, ~19% cheaper than the
                          x86 t3.large equivalent at identical 2 vCPU/8GB
                          spec, confirmed via `aws pricing get-products`.
                          This workload is network/disk-bound, not
                          CPU-heavy, and nothing here needs x86: the Python
                          scripts and the tippecanoe build from source
                          (see user-data.sh) are both portable. The AMI is
                          resolved to match whatever architecture this type
                          implies -- overriding to an x86 type (e.g. t3.large)
                          is fine and will resolve the x86_64 AMI instead)
  --volume-size GB        Root EBS volume size in GB (default: 100 -- measure
                          actual peak disk usage locally for one region/chart
                          run before trusting this for a full national build;
                          see offline-maps/README.md)
  --ami-id ID             Override the auto-resolved Amazon Linux 2023 AMI
  --max-runtime-days N    Safety-net max runtime before force-termination via
                          a one-time EventBridge Scheduler schedule, in case
                          the build script crashes before its own
                          self-termination call (default: 10 -- comfortably
                          above the "multiple days" this is expected to take;
                          raise it if a build genuinely needs longer, don't
                          disable it)
  --skip-regional         Skip the regional raster mbtiles step
  --skip-marine           Skip the marine charts step (this is by far the
                          slowest step -- multiple days at the tile rates
                          observed so far -- so this is the one worth
                          skipping when you just need a faster turnaround
                          on the other two, e.g. re-running the vector
                          basemap alone a few months after LINZ updates its
                          topographic source data)
  --skip-vector           Skip the NZ OMT vector basemap step
  --dry-run               Print the resolved run-instances command without
                          executing it
  -h, --help              Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-stack) BASE_STACK="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --volume-size) VOLUME_SIZE_GB="$2"; shift 2 ;;
    --max-runtime-days) MAX_RUNTIME_DAYS="$2"; shift 2 ;;
    --ami-id) AMI_ID="$2"; shift 2 ;;
    --skip-regional) SKIP_REGIONAL=true; shift ;;
    --skip-marine) SKIP_MARINE=true; shift ;;
    --skip-vector) SKIP_VECTOR=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$BASE_STACK" ]]; then
  echo "ERROR: --base-stack is required" >&2
  usage
  exit 1
fi

AWS_REGION_ARGS=()
if [[ -n "$REGION" ]]; then
  AWS_REGION_ARGS=(--region "$REGION")
fi

echo "Resolving exports from base-infra stack: $BASE_STACK"

get_export() {
  local export_name="$1"
  aws cloudformation list-exports "${AWS_REGION_ARGS[@]}" \
    --query "Exports[?Name=='${BASE_STACK}-${export_name}'].Value" \
    --output text
}

MAP_DOWNLOADS_BUCKET="$(get_export MapDownloadsBucket)"
INSTANCE_PROFILE_NAME="$(get_export MapBuildInstanceProfileName)"
NOTIFICATIONS_TOPIC_ARN="$(get_export MapBuildNotificationsTopicArn)"
SCHEDULER_ROLE_ARN="$(get_export MapBuildSchedulerRoleArn)"
ENV_CONFIG_BUCKET="$(get_export S3EnvConfigArn | sed -E 's#^arn:[^:]+:s3:::##')"
ARTIFACTS_BUCKET="$(get_export AppImagesBucket)"
ECS_CLUSTER_NAME="$(get_export EcsClusterName)"

for name_val in \
  "MapDownloadsBucket:$MAP_DOWNLOADS_BUCKET" \
  "MapBuildInstanceProfileName:$INSTANCE_PROFILE_NAME" \
  "MapBuildNotificationsTopicArn:$NOTIFICATIONS_TOPIC_ARN" \
  "MapBuildSchedulerRoleArn:$SCHEDULER_ROLE_ARN" \
  "S3EnvConfigArn:$ENV_CONFIG_BUCKET" \
  "AppImagesBucket:$ARTIFACTS_BUCKET" \
  "EcsClusterName:$ECS_CLUSTER_NAME"
do
  name="${name_val%%:*}"
  val="${name_val#*:}"
  if [[ -z "$val" ]]; then
    echo "ERROR: could not resolve export ${BASE_STACK}-${name}. Is --base-stack correct, and has base-infra been deployed with the map-downloads changes?" >&2
    exit 1
  fi
done

echo "  Steps:                         regional=$([[ $SKIP_REGIONAL == true ]] && echo skip || echo run), marine=$([[ $SKIP_MARINE == true ]] && echo skip || echo run), vector=$([[ $SKIP_VECTOR == true ]] && echo skip || echo run)"
echo "  MapDownloadsBucket:            $MAP_DOWNLOADS_BUCKET"
echo "  MapBuildInstanceProfileName:   $INSTANCE_PROFILE_NAME"
echo "  MapBuildNotificationsTopicArn: $NOTIFICATIONS_TOPIC_ARN"
echo "  MapBuildSchedulerRoleArn:      $SCHEDULER_ROLE_ARN"
echo "  EnvConfigBucket:               $ENV_CONFIG_BUCKET"
echo "  ArtifactsBucket:               $ARTIFACTS_BUCKET"
echo "  EcsClusterName:                $ECS_CLUSTER_NAME"

# ---------------------------------------------------------------------------
# Package the local offline-maps/ and scripts/nz-omt-tileset/ directories and
# upload to S3, rather than having the instance `git clone` the repo. Two
# real reasons, not just preference: (1) this exact working tree may not be
# pushed to origin yet -- git-clone-from-origin silently ran a stale or
# missing version once already; the instance must run what you're actually
# looking at right now, not whatever happens to be on GitHub, and (2) it
# removes a runtime dependency on GitHub being reachable/unchanged for the
# multi-day duration of the build. The bundle key is timestamped so it never
# collides with a previous run's. There is currently no automatic cleanup of
# old bundles in S3 -- delete s3://<artifacts-bucket>/offline-maps-bundles/
# manually after a build completes if you want to reclaim the (small, ~240KB
# each) space. See the README for the manual cleanup command.
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUNDLE_KEY="offline-maps-bundles/bundle-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
BUNDLE_FILE="$(mktemp)"

echo ""
echo "Packaging offline-maps/ and scripts/nz-omt-tileset/ from $REPO_ROOT..."
tar czf "$BUNDLE_FILE" -C "$REPO_ROOT" \
  --exclude='scripts/nz-omt-tileset/node_modules' \
  --exclude='scripts/nz-omt-tileset/*.mbtiles' \
  --exclude='scripts/nz-omt-tileset/*.pmtiles' \
  offline-maps scripts/nz-omt-tileset
BUNDLE_SIZE="$(du -h "$BUNDLE_FILE" | cut -f1)"
echo "  Bundle: $BUNDLE_SIZE"

if [[ "$DRY_RUN" != true ]]; then
  aws s3 cp "$BUNDLE_FILE" "s3://${ARTIFACTS_BUCKET}/${BUNDLE_KEY}" "${AWS_REGION_ARGS[@]}" --no-progress
  echo "  Uploaded to s3://${ARTIFACTS_BUCKET}/${BUNDLE_KEY}"
fi

if [[ -z "$AMI_ID" ]]; then
  # Resolve the AMI architecture to match INSTANCE_TYPE rather than
  # hardcoding x86_64 -- t4g/m6g/c6g/r6g/etc are all arm64 (Graviton);
  # everything else here is treated as x86_64. Covers the default
  # (t4g.large) and any --instance-type override without the two silently
  # mismatching (an arm64 AMI on an x86 instance type, or vice versa,
  # fails to boot).
  case "$INSTANCE_TYPE" in
    t4g.*|m6g.*|c6g.*|r6g.*|t4gd.*|m6gd.*|c6gd.*|r6gd.*|a1.*)
      AMI_ARCH="arm64" ;;
    *)
      AMI_ARCH="x86_64" ;;
  esac
  echo "Resolving latest Amazon Linux 2023 AMI ($AMI_ARCH, matching --instance-type $INSTANCE_TYPE)..."
  AMI_ID="$(aws ssm get-parameters "${AWS_REGION_ARGS[@]}" \
    --names "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${AMI_ARCH}" \
    --query 'Parameters[0].Value' --output text)"
fi
echo "  AMI: $AMI_ID"

USER_DATA_TEMPLATE="$SCRIPT_DIR/user-data.sh"
if [[ ! -f "$USER_DATA_TEMPLATE" ]]; then
  echo "ERROR: $USER_DATA_TEMPLATE not found" >&2
  exit 1
fi

# Substitute the resolved values into the user-data script. Using a plain
# marker-replace rather than passing env vars through EC2 user-data metadata,
# so the running instance's own copy of the script (visible via
# /var/log/cloud-init-output.log) is self-contained and shows exactly what
# ran -- no separate metadata lookup needed to understand a log.
RENDERED_USER_DATA="$(mktemp)"
trap 'rm -f "$RENDERED_USER_DATA" "$BUNDLE_FILE"' EXIT

sed \
  -e "s|__MAP_DOWNLOADS_BUCKET__|${MAP_DOWNLOADS_BUCKET}|g" \
  -e "s|__NOTIFICATIONS_TOPIC_ARN__|${NOTIFICATIONS_TOPIC_ARN}|g" \
  -e "s|__ENV_CONFIG_BUCKET__|${ENV_CONFIG_BUCKET}|g" \
  -e "s|__ARTIFACTS_BUCKET__|${ARTIFACTS_BUCKET}|g" \
  -e "s|__ECS_CLUSTER_NAME__|${ECS_CLUSTER_NAME}|g" \
  -e "s|__BUNDLE_S3_URI__|s3://${ARTIFACTS_BUCKET}/${BUNDLE_KEY}|g" \
  -e "s|__SKIP_REGIONAL__|${SKIP_REGIONAL}|g" \
  -e "s|__SKIP_MARINE__|${SKIP_MARINE}|g" \
  -e "s|__SKIP_VECTOR__|${SKIP_VECTOR}|g" \
  "$USER_DATA_TEMPLATE" > "$RENDERED_USER_DATA"

RUN_ARGS=(
  ec2 run-instances
  "${AWS_REGION_ARGS[@]}"
  --image-id "$AMI_ID"
  --instance-type "$INSTANCE_TYPE"
  --iam-instance-profile "Name=${INSTANCE_PROFILE_NAME}"
  --instance-initiated-shutdown-behavior terminate
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${VOLUME_SIZE_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]"
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled"
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=offline-map-build},{Key=Purpose,Value=offline-map-build},{Key=LaunchedAt,Value=$(date -u +%Y-%m-%dT%H:%M:%SZ)}]"
  --user-data "file://${RENDERED_USER_DATA}"
  # No --key-name, no --security-group-ids with inbound rules: this instance
  # is reached only via SSM Session Manager, never SSH. Launched into the
  # default VPC's default subnet; if that's not desired, add
  # --subnet-id/--security-group-ids explicitly.
)

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "--- DRY RUN: would execute ---"
  printf 'aws'
  printf ' %q' "${RUN_ARGS[@]}"
  echo ""
  echo ""
  echo "--- Rendered user-data ---"
  cat "$RENDERED_USER_DATA"
  exit 0
fi

echo ""
echo "Launching instance..."
INSTANCE_ID="$(aws "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId' --output text)"
echo "Launched: $INSTANCE_ID"

# ---------------------------------------------------------------------------
# Stale-instance safety net: a one-time EventBridge Scheduler schedule that
# force-terminates this specific instance after MAX_RUNTIME_DAYS, in case the
# build script never reaches its own shutdown call. Scoped to this one
# instance ID (via the target input), not just the Purpose tag, so it can't
# ever accidentally terminate a different, legitimate build running
# concurrently.
# ---------------------------------------------------------------------------
SCHEDULE_NAME="offline-map-build-timeout-${INSTANCE_ID}"
RUN_AT="$(date -u -d "+${MAX_RUNTIME_DAYS} days" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
  || date -u -v "+${MAX_RUNTIME_DAYS}d" +%Y-%m-%dT%H:%M:%S)"  # BSD date fallback (macOS)

aws scheduler create-schedule "${AWS_REGION_ARGS[@]}" \
  --name "$SCHEDULE_NAME" \
  --schedule-expression "at(${RUN_AT})" \
  --flexible-time-window '{"Mode":"OFF"}' \
  --action-after-completion DELETE \
  --target "{
    \"Arn\": \"arn:aws:scheduler:::aws-sdk:ec2:terminateInstances\",
    \"RoleArn\": \"${SCHEDULER_ROLE_ARN}\",
    \"Input\": \"{\\\"InstanceIds\\\":[\\\"${INSTANCE_ID}\\\"]}\"
  }" >/dev/null

echo "Safety net: instance will be force-terminated at ${RUN_AT}Z if still running (schedule: $SCHEDULE_NAME)"
echo ""
echo "Monitor with:"
echo "  aws ssm start-session --target $INSTANCE_ID ${REGION:+--region $REGION}"
echo "  (then: tail -f /var/log/cloud-init-output.log)"
echo ""
echo "The instance self-terminates on completion or failure, and will publish"
echo "a notification to $NOTIFICATIONS_TOPIC_ARN either way. If it finishes"
echo "before the timeout, the safety-net schedule harmlessly no-ops against an"
echo "already-terminated instance ID when it eventually fires (EC2 instance"
echo "IDs are never reused), and EventBridge Scheduler auto-deletes the"
echo "schedule resource after that one firing regardless of outcome."
echo ""
echo "If nobody is subscribed to that topic yet:"
echo "  aws sns subscribe --topic-arn $NOTIFICATIONS_TOPIC_ARN --protocol email --notification-endpoint you@example.com ${AWS_REGION_ARGS[*]}"
