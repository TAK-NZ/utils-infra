/**
 * TerrainProxy construct: the LINZ elevation to TAK terrain tile proxy, as an AWS Lambda function behind the ALB.
 *
 * It replaces the ECS Fargate service. CloudFront caches the tiles (see terrain-cloudfront.ts), so the origin only
 * sees cache misses: bursty and mostly idle, which suits Lambda better than a task that runs all day.
 *
 * The function is a container image, built from the terrain-proxy/ folder. It runs the same Express app as before
 * (terrain-proxy/server.js) through terrain-proxy/lambda.js, and is registered with the ALB through a Lambda target
 * group, so the host header rule, CloudFront and DNS in front of it are unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_lambda as lambda,
  aws_ecr as ecr,
  aws_ecr_assets as ecrAssets,
  aws_iam as iam,
  aws_elasticloadbalancingv2 as elbv2,
  aws_elasticloadbalancingv2_targets as elbTargets,
  aws_logs as logs,
  Duration,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import type { TerrainProxyConfig } from '../stack-config';

export interface TerrainProxyProps {
  /** Environment type ('prod' | 'dev-test'). */
  environment: 'prod' | 'dev-test';
  config: TerrainProxyConfig;
  /** Name (not ARN) of the shared ECR repository. Needed when `sourcePath` is not set. */
  ecrRepositoryName?: string;
  /** Full image tag in that repository, e.g. "utils-terrain-proxy-v2.0.0". Needed when `sourcePath` is not set. */
  imageTag?: string;
  /**
   * Directory that holds the Dockerfile (the terrain-proxy/ folder). When set, `cdk deploy` builds the image from it.
   * When not set, the image must already be in the shared ECR repository (built by the build workflows).
   */
  sourcePath?: string;
  /** Config bucket that holds the LINZ API key file. */
  configBucketName: string;
  /** Object in the config bucket that holds the LINZ API key, e.g. "Utils-Terrain-Proxy-Config.json". */
  configKey: string;
  /** ARN of the KMS key that encrypts the config bucket. */
  kmsKeyArn: string;
  removalPolicy: RemovalPolicy;
}

export class TerrainProxy extends Construct {
  public readonly fn: lambda.DockerImageFunction;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: TerrainProxyProps) {
    super(scope, id);
    const { config, environment } = props;

    // The ALB gives up on a Lambda target after its idle timeout (60 s), and so does CloudFront after 30 s.
    if (config.timeoutSeconds >= 60) {
      throw new Error('terrainProxy.timeoutSeconds must be below the 60 s ALB idle timeout');
    }
    const region = Stack.of(this).region;

    this.fn = new lambda.DockerImageFunction(this, 'Fn', {
      description: 'Terrain proxy: LINZ elevation to TAK terrain tiles (GET /terrain/{z}/{x}/{y}.png)',
      code: this.imageCode(props),
      // The build workflows and the deploy build for linux/amd64.
      architecture: lambda.Architecture.X86_64,
      memorySize: config.memorySize,
      timeout: Duration.seconds(config.timeoutSeconds),
      reservedConcurrentExecutions: config.reservedConcurrency,
      logGroup: new logs.LogGroup(this, 'LogGroup', {
        retention: environment === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        removalPolicy: props.removalPolicy,
      }),
      environment: {
        NODE_ENV: environment === 'prod' ? 'production' : 'development',
        CONFIG_BUCKET: props.configBucketName,
        CONFIG_KEY: props.configKey,
        // Every execution environment has its own in-memory tile cache. Keep it small enough for the function's
        // memory, and let entries expire so a long-lived environment does not fill up and stop caching.
        TILE_CACHE_MAX_KEYS: '1000',
        TILE_CACHE_TTL_SECONDS: '3600',
      },
    });

    // Read the LINZ API key file, and nothing else in the config bucket.
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.configBucketName}/${props.configKey}`],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [props.kmsKeyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${region}.amazonaws.com` } },
    }));

    // Health checks stay off (the default for Lambda targets): they would invoke the function every 35 seconds.
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbTargets.LambdaTarget(this.fn)],
    });
  }

  /** Builds the image from a local checkout, or points at an image that is already in ECR. */
  private imageCode(props: TerrainProxyProps): lambda.DockerImageCode {
    if (props.sourcePath) {
      const dir = path.resolve(props.sourcePath);
      if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
        throw new Error(`terrain-proxy source path "${dir}" does not hold a Dockerfile`);
      }
      // Lambda needs x86_64 (the function is x86_64) and a plain Docker v2 manifest. Docker 29 and later add
      // provenance attestations by default, which Lambda rejects: deploy with BUILDX_NO_DEFAULT_ATTESTATIONS=1.
      // The folder's .dockerignore keeps node_modules out of the build context.
      return lambda.DockerImageCode.fromImageAsset(dir, { platform: ecrAssets.Platform.LINUX_AMD64 });
    }
    if (!props.ecrRepositoryName || !props.imageTag) {
      throw new Error('TerrainProxy needs either sourcePath, or ecrRepositoryName and imageTag');
    }
    const repository = ecr.Repository.fromRepositoryName(this, 'Repository', props.ecrRepositoryName);
    // The shared repository's resource policy already lets lambda.amazonaws.com pull images.
    return lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: props.imageTag });
  }
}
