/**
 * SitRepLambda Construct
 *
 * Scheduled AI Situational Report generator — see display-proxy/README.md ("SitRep" section).
 *
 * Calls Bedrock InvokeModel directly — no Bedrock Agent or action group is
 * involved, so this has no dependency on the tak-infra Bedrock Agents Classic
 * -> AgentCore migration. It reuses the same S3 config file as display-proxy
 * (cloudtak_url, cloudtak_token, layer -> connection mappings) and writes its
 * result to the same config bucket, which display-proxy (Component 2) then
 * serves via GET /api/sitrep.
 */
import { Construct } from 'constructs';
import {
    aws_lambda as lambda,
    aws_iam as iam,
    aws_events as events,
    aws_events_targets as targets,
    aws_s3 as s3,
    aws_logs as logs,
    Duration,
    RemovalPolicy,
    Stack,
} from 'aws-cdk-lib';
import * as path from 'path';

export interface SitRepLambdaProps {
    /** S3 bucket holding the display-proxy config, and where sitrep/latest.json is written */
    configBucket: s3.IBucket;

    /** KMS key ARN used to encrypt the config bucket */
    kmsKeyArn: string;

    /** S3 key of the display-proxy config (source of cloudtak_url/token/layers) */
    configKey: string;

    /** S3 key to write the SitRep result to */
    sitrepKey?: string;

    /** S3 key for the persisted volcano alert-level history (read + written each run) */
    volcanoStateKey?: string;

    /**
     * Bedrock model id, without a region-profile prefix (e.g. "anthropic.claude-sonnet-5-5",
     * not "au.anthropic.claude-sonnet-5-5"). Most current Claude models require a
     * cross-region inference profile rather than direct on-demand invocation,
     * and the correct profile prefix (us./au./eu./etc.) depends on which
     * region the stack deploys to. The Lambda resolves the right prefix at
     * runtime from its own region — see lambda/sitrep-generator/index.py.
     */
    modelId?: string;

    /**
     * Minutes between runs. Must divide 60 evenly (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60),
     * so that runs land on the clock. Defaults to 30.
     */
    scheduleIntervalMinutes?: number;

    /** CDK removalPolicy — DESTROY for dev, RETAIN for prod */
    removalPolicy: RemovalPolicy;
}

/** Default minutes between SitRep runs; see SitRepLambdaProps.scheduleIntervalMinutes. */
export const DEFAULT_SITREP_INTERVAL_MINUTES = 30;

/**
 * EventBridge cron minute field for a run every `intervalMinutes` minutes, anchored to the
 * top of the hour. Throws unless the interval is a whole number of minutes that divides 60,
 * since any other value would fire unevenly across the hour boundary.
 */
export function sitrepCronMinute(intervalMinutes: number): string {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60 || 60 % intervalMinutes !== 0) {
        throw new Error(
            `sitrep.scheduleIntervalMinutes must be a whole number of minutes that divides 60 ` +
            `(1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60), got ${intervalMinutes}`,
        );
    }
    return intervalMinutes === 60 ? '0' : `0/${intervalMinutes}`;
}

export class SitRepLambda extends Construct {
    public readonly fn: lambda.Function;

    constructor(scope: Construct, id: string, props: SitRepLambdaProps) {
        super(scope, id);

        const modelId = props.modelId ?? 'anthropic.claude-sonnet-5-5';
        const sitrepKey = props.sitrepKey ?? 'sitrep/latest.json';
        const volcanoStateKey = props.volcanoStateKey ?? 'volcano/state.json';

        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.removalPolicy,
        });

        this.fn = new lambda.Function(this, 'Fn', {
            description: 'Scheduled AI SitRep generator — fetches CloudTAK layers, calls Bedrock, writes sitrep/latest.json to S3',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/sitrep-generator')),
            // Generous on purpose: most of a run is waiting on CloudTAK and Bedrock, and in
            // some deployments the CloudTAK reads alone have taken 40+ seconds. A run that
            // times out leaves the report stale for a whole schedule interval.
            timeout: Duration.seconds(120),
            // The layers are fetched in parallel, so all of them are held in memory at once. A run
            // peaked at 235 MB of 256 MB, which leaves no room for a day with many more features.
            memorySize: 512,
            logGroup,
            environment: {
                CONFIG_BUCKET: props.configBucket.bucketName,
                CONFIG_KEY: props.configKey,
                SITREP_KEY: sitrepKey,
                VOLCANO_STATE_KEY: volcanoStateKey,
                MODEL_ID: modelId,
            },
        });

        // Read the display-proxy config (cloudtak_url, cloudtak_token, layers)
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject'],
            resources: [
                `arn:aws:s3:::${props.configBucket.bucketName}/${props.configKey}`,
                // Volcano alert-level history — read at the start of each run to
                // detect changes, rewritten at the end. See index.py.
                `arn:aws:s3:::${props.configBucket.bucketName}/${volcanoStateKey}`,
            ],
        }));

        // Write the SitRep result and the reconciled volcano state to the
        // same bucket.
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject'],
            resources: [
                `arn:aws:s3:::${props.configBucket.bucketName}/${sitrepKey}`,
                `arn:aws:s3:::${props.configBucket.bucketName}/${volcanoStateKey}`,
            ],
        }));

        // KMS for the config bucket — Decrypt to read the config object,
        // GenerateDataKey to write the SitRep object (writing to an SSE-KMS
        // bucket requires GenerateDataKey even though it never decrypts
        // anything itself).
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [props.kmsKeyArn],
        }));

        // Invoke Bedrock (Claude) directly — no Agent involved.
        //
        // Most current Claude models can only be invoked through a
        // cross-region inference profile, not the bare foundation-model ID —
        // and the correct profile prefix (us./au./eu./etc.) depends on which
        // region this stack deploys to, which isn't known until deploy time.
        // Rather than hardcoding one region's ARN, grant both resource types
        // as wildcards, matching the same pattern tak-infra uses for its
        // TAK-GPT plugin (see tak-infra/lib/constructs/tak-server.ts).
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['bedrock:InvokeModel'],
            resources: [
                'arn:aws:bedrock:*::foundation-model/*',
                `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
            ],
        }));

        // EventBridge schedule — fires every N minutes on the clock (UTC), at
        // :00 and :30 for the default of 30. rate(N minutes) would instead fire
        // relative to whenever this rule happened to be created/enabled, never
        // landing on a clean boundary — cron() ties it to the clock.
        const intervalMinutes = props.scheduleIntervalMinutes ?? DEFAULT_SITREP_INTERVAL_MINUTES;
        const rule = new events.Rule(this, 'Schedule', {
            description: `Triggers the SitRep Lambda every ${intervalMinutes} minutes, on the clock`,
            schedule: events.Schedule.cron({ minute: sitrepCronMinute(intervalMinutes) }),
        });
        rule.addTarget(new targets.LambdaFunction(this.fn));
    }
}
