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

    /**
     * Bedrock model id, without a region-profile prefix (e.g. "anthropic.claude-opus-5",
     * not "au.anthropic.claude-opus-5"). Most current Claude models require a
     * cross-region inference profile rather than direct on-demand invocation,
     * and the correct profile prefix (us./au./eu./etc.) depends on which
     * region the stack deploys to. The Lambda resolves the right prefix at
     * runtime from its own region — see lambda/sitrep-generator/index.py.
     */
    modelId?: string;

    /** CDK removalPolicy — DESTROY for dev, RETAIN for prod */
    removalPolicy: RemovalPolicy;
}

export class SitRepLambda extends Construct {
    public readonly fn: lambda.Function;

    constructor(scope: Construct, id: string, props: SitRepLambdaProps) {
        super(scope, id);

        const modelId = props.modelId ?? 'anthropic.claude-opus-5';
        const sitrepKey = props.sitrepKey ?? 'sitrep/latest.json';

        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.removalPolicy,
        });

        this.fn = new lambda.Function(this, 'Fn', {
            description: 'Scheduled AI SitRep generator — fetches CloudTAK layers, calls Bedrock, writes sitrep/latest.json to S3',
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/sitrep-generator')),
            timeout: Duration.seconds(60),
            memorySize: 256,
            logGroup,
            environment: {
                CONFIG_BUCKET: props.configBucket.bucketName,
                CONFIG_KEY: props.configKey,
                SITREP_KEY: sitrepKey,
                MODEL_ID: modelId,
            },
        });

        // Read the display-proxy config (cloudtak_url, cloudtak_token, layers)
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:GetObject'],
            resources: [`arn:aws:s3:::${props.configBucket.bucketName}/${props.configKey}`],
        }));

        // Write the SitRep result to the same bucket
        this.fn.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject'],
            resources: [`arn:aws:s3:::${props.configBucket.bucketName}/${sitrepKey}`],
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

        // EventBridge schedule — fires at :00, :15, :30, :45 every hour
        // (UTC). rate(15 minutes) would instead fire relative to whenever
        // this rule happened to be created/enabled, never landing on a
        // clean quarter-hour boundary — cron() ties it to the clock.
        const rule = new events.Rule(this, 'Schedule', {
            description: 'Triggers the SitRep Lambda at :00, :15, :30, :45 every hour',
            schedule: events.Schedule.cron({ minute: '0/15' }),
        });
        rule.addTarget(new targets.LambdaFunction(this.fn));
    }
}
