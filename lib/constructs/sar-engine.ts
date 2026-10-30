/**
 * SarEngine construct: terrain-aware search-and-rescue travel-time analysis as AWS Lambda.
 *
 * Source and build: https://github.com/TAK-NZ/sar-engine (see docs/SAR_ENGINE.md in this repository).
 *
 *   - HTTP function   Container image, registered with the ALB behind a path rule. Reads its data (land cover raster,
 *                     OpenStreetMap snapshot) straight from S3 by range requests, and its API keys from a JSON file in
 *                     the config bucket, so no secret appears in CloudFormation.
 *   - Refresh function The same image with the command overridden (osm_refresh.lambda_handler). Run monthly by
 *                     EventBridge: downloads the Geofabrik NZ extract, rebuilds the snapshot, publishes it under a new
 *                     key and then switches a small pointer file. A failure raises an alarm.
 *
 * Data lives under one prefix of the existing artifacts bucket; both functions get access to that prefix only.
 */
import { Construct } from 'constructs';
import {
  aws_lambda as lambda,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbTargets,
  aws_logs as logs,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_sns as sns,
  Duration,
  RemovalPolicy,
  Size,
  Stack,
} from 'aws-cdk-lib';
import type { SarEngineConfig } from '../stack-config';

export interface SarEngineProps {
  config: SarEngineConfig;
  /** Name (not ARN) of the shared ECR repository. */
  ecrRepositoryName: string;
  /** Full image tag in that repository, e.g. "utils-sar-engine-v0.1.0". */
  imageTag: string;
  /** Artifacts bucket that holds the data, under config.dataPrefix. */
  dataBucketName: string;
  /** Config bucket that holds the API keys file (config.apiKeysConfigKey). */
  configBucketName: string;
  /** ARN of the KMS key that encrypts both buckets. */
  kmsKeyArn: string;
  removalPolicy: RemovalPolicy;
}

export class SarEngine extends Construct {
  public readonly httpFn: lambda.DockerImageFunction;
  public readonly refreshFn: lambda.DockerImageFunction;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly alertsTopic: sns.Topic;
  /** s3:// location of the data, for outputs and documentation. */
  public readonly dataLocation: string;

  constructor(scope: Construct, id: string, props: SarEngineProps) {
    super(scope, id);
    const { config } = props;
    const prefix = config.dataPrefix.replace(/^\/+|\/+$/g, '');
    if (!prefix) {
      throw new Error('sarEngine.dataPrefix must not be empty: access is granted by prefix');
    }
    if (config.timeoutSeconds >= 60) {
      throw new Error('sarEngine.timeoutSeconds must be below the 60 s ALB idle timeout');
    }
    const region = Stack.of(this).region;
    const bucketArn = `arn:aws:s3:::${props.dataBucketName}`;
    const dataObjects = `${bucketArn}/${prefix}`;
    this.dataLocation = `s3://${props.dataBucketName}/${prefix}/`;

    const repository = ecr.Repository.fromRepositoryName(this, 'Repository', props.ecrRepositoryName);
    // The shared repository's resource policy already lets lambda.amazonaws.com pull images.
    const image = (cmd?: string[]) =>
      lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: props.imageTag, ...(cmd ? { cmd } : {}) });

    const logGroup = (name: string) => new logs.LogGroup(this, name, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: props.removalPolicy,
    });

    // --------------------------------------------------------------------------------------------------------
    // HTTP function
    // --------------------------------------------------------------------------------------------------------
    this.httpFn = new lambda.DockerImageFunction(this, 'HttpFn', {
      description: 'SAR engine: terrain-aware travel-time contours (POST /sar/travel-time)',
      code: image(),
      architecture: lambda.Architecture.X86_64,
      memorySize: config.memorySize,
      timeout: Duration.seconds(config.timeoutSeconds),
      reservedConcurrentExecutions: config.reservedConcurrency,
      logGroup: logGroup('HttpLogGroup'),
      environment: {
        SAR_DATA_DIR: `/vsis3/${props.dataBucketName}/${prefix}`,
        SAR_CONFIG_BUCKET: props.configBucketName,
        SAR_CONFIG_KEY: config.apiKeysConfigKey,
      },
    });

    // Read the data. ListBucket (limited to the prefix) turns a missing object into a clear 404 instead of a 403.
    this.httpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${dataObjects}/*`],
    }));
    this.httpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
    }));
    // Read the API keys file, and nothing else in the config bucket.
    this.httpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.configBucketName}/${config.apiKeysConfigKey}`],
    }));
    this.httpFn.addToRolePolicy(this.kmsStatement(props.kmsKeyArn, region, ['kms:Decrypt']));

    // --------------------------------------------------------------------------------------------------------
    // ALB target
    // --------------------------------------------------------------------------------------------------------
    // Health checks stay off (the default for Lambda targets): they would invoke the function every 35 seconds.
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbTargets.LambdaTarget(this.httpFn)],
    });

    // --------------------------------------------------------------------------------------------------------
    // Monthly OSM refresh
    // --------------------------------------------------------------------------------------------------------
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      displayName: 'SAR engine alerts',
      enforceSSL: true,
    });

    this.refreshFn = new lambda.DockerImageFunction(this, 'RefreshFn', {
      description: 'SAR engine: monthly OpenStreetMap snapshot refresh',
      code: image(['osm_refresh.lambda_handler']),
      architecture: lambda.Architecture.X86_64,
      memorySize: 3072,                       // measured working set about 1.6 GB while building
      timeout: Duration.minutes(10),          // measured 73 s including the 405 MB download
      ephemeralStorageSize: Size.mebibytes(2048),    // 405 MB download + 355 MB output, with headroom
      logGroup: logGroup('RefreshLogGroup'),
      environment: {
        SAR_DATA_BUCKET: props.dataBucketName,
        SAR_DATA_PREFIX: prefix,
      },
    });
    // Least privilege within the prefix: it may write only the OSM snapshots and the pointer file, never the land
    // cover raster. GetObject on the pointer lets it read the current snapshot name and feature count.
    this.refreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
      resources: [`${dataObjects}/osm/*`, `${dataObjects}/nz_osm_meta.geojson`],
    }));
    this.refreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [`${dataObjects}/osm/*`],
    }));
    this.refreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`${dataObjects}/nz_osm_meta.geojson`],
    }));
    this.refreshFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${prefix}/osm/*`, `${prefix}/nz_osm_meta.geojson`] } },
    }));
    this.refreshFn.addToRolePolicy(this.kmsStatement(props.kmsKeyArn, region, ['kms:Decrypt', 'kms:GenerateDataKey']));

    const schedule = new events.Rule(this, 'RefreshSchedule', {
      description: `Monthly SAR engine OSM refresh (day ${config.osmRefresh.dayOfMonth}, ${config.osmRefresh.hourUtc}:00 UTC)`,
      enabled: config.osmRefresh.enabled,
      schedule: events.Schedule.cron({
        minute: '0',
        hour: String(config.osmRefresh.hourUtc),
        day: String(config.osmRefresh.dayOfMonth),
        month: '*',
        year: '*',
      }),
    });
    schedule.addTarget(new eventTargets.LambdaFunction(this.refreshFn, { retryAttempts: 2 }));

    // Any failed run (each failed attempt counts) alarms. A run that never starts is not detected here: the
    // snapshot's age is reported to every caller as a warning once it passes 45 days.
    new cloudwatch.Alarm(this, 'RefreshFailedAlarm', {
      alarmDescription: 'The monthly SAR engine OpenStreetMap refresh failed. The live snapshot is unchanged; see the ' +
        'function logs. Maps stay usable and warn callers once the snapshot is older than 45 days.',
      metric: this.refreshFn.metricErrors({ period: Duration.days(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(this.alertsTopic));
  }

  /** KMS access for objects in the encrypted buckets, usable only through S3 in this region. */
  private kmsStatement(kmsKeyArn: string, region: string, actions: string[]): iam.PolicyStatement {
    return new iam.PolicyStatement({
      actions,
      resources: [kmsKeyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${region}.amazonaws.com` } },
    });
  }
}
