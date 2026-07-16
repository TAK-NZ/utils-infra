/**
 * DisplayCloudFront Construct
 *
 * Replaces the Playwright/MJPEG display-proxy ECS container with a
 * serverless static web app + Lambda API architecture:
 *
 *   Browser (AbleSign / Fire TV / browser)
 *     │
 *     ├── Static assets (index.html)
 *     │     CloudFront → S3 bucket  (no auth — HTML/JS contains no secrets)
 *     │
 *     ├── CoT features  GET /api/cot/{acft|vessels|personnel}?key=<token>
 *     │     CloudFront (30s TTL) → tak-cot-proxy Lambda
 *     │
 *     └── Icons         GET /api/icons/{iconset-uid/icon-name}?key=<token>
 *           CloudFront (7d TTL)  → tak-icon-proxy Lambda
 *
 * Auth: validated by the Lambdas at runtime against access_keys in the S3
 * config file (Utils-Display-Proxy-Config.json) — no deploy-time key baking.
 * index.html itself is public; without a valid ?key= every API call returns
 * 401 and the map shows nothing.
 */

import { Construct } from 'constructs';
import {
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_certificatemanager as acm,
    aws_route53 as route53,
    aws_route53_targets as r53targets,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
    aws_lambda as lambda,
    aws_iam as iam,
    aws_logs as logs,
    Duration,
    RemovalPolicy,
} from 'aws-cdk-lib';
import * as path from 'path';

export interface DisplayCloudFrontProps {
    /** Wildcard SSL certificate (must cover *.{zoneName}), in us-east-1 */
    certificate: acm.ICertificate;

    /** Route53 hosted zone */
    hostedZone: route53.IHostedZone;

    /** Subdomain — e.g. "display" → display.demo.tak.nz */
    hostname: string;

    /** S3 config bucket name — passed to Lambdas as CONFIG_BUCKET env var */
    configBucketName: string;

    /** KMS key ARN for S3 config bucket decryption */
    kmsKeyArn: string;

    /** CDK removalPolicy — DESTROY for dev, RETAIN for prod */
    removalPolicy: RemovalPolicy;
}

export class DisplayCloudFront extends Construct {
    public readonly distribution: cloudfront.Distribution;
    public readonly domainName: string;

    constructor(scope: Construct, id: string, props: DisplayCloudFrontProps) {
        super(scope, id);

        const {
            certificate,
            hostedZone,
            hostname,
            configBucketName,
            kmsKeyArn,
            removalPolicy,
        } = props;

        const fqdn = `${hostname}.${hostedZone.zoneName}`;

        // ---------------------------------------------------------------------------
        // S3 bucket — static website assets (index.html)
        // ---------------------------------------------------------------------------
        const siteBucket = new s3.Bucket(this, 'SiteBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption:        s3.BucketEncryption.S3_MANAGED,
            removalPolicy,
            autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY,
        });

        // ---------------------------------------------------------------------------
        // Lambda: tak-cot-proxy
        // ---------------------------------------------------------------------------
        const cotProxyLog = new logs.LogGroup(this, 'CotProxyLogGroup', {
            retention:     logs.RetentionDays.ONE_WEEK,
            removalPolicy,
        });

        const cotProxy = new lambda.Function(this, 'CotProxy', {
            functionName:  `${id}-tak-cot-proxy`,
            description:   'Proxies CloudTAK CoT feature endpoints → GeoJSON for display webapp',
            runtime:       lambda.Runtime.NODEJS_20_X,
            handler:       'index.handler',
            code:          lambda.Code.fromAsset(
                path.join(__dirname, '../../display-proxy/lambdas/tak-cot-proxy')
            ),
            timeout:       Duration.seconds(15),
            memorySize:    256,
            logGroup:      cotProxyLog,
            environment: {
                CONFIG_BUCKET: configBucketName,
                CONFIG_KEY:    'Utils-Display-Proxy-Config.json',
            },
        });

        // ---------------------------------------------------------------------------
        // Lambda: tak-icon-proxy
        // ---------------------------------------------------------------------------
        const iconProxyLog = new logs.LogGroup(this, 'IconProxyLogGroup', {
            retention:     logs.RetentionDays.ONE_WEEK,
            removalPolicy,
        });

        const iconProxy = new lambda.Function(this, 'IconProxy', {
            functionName:  `${id}-tak-icon-proxy`,
            description:   'Proxies CloudTAK iconset icons → PNG for display webapp',
            runtime:       lambda.Runtime.NODEJS_20_X,
            handler:       'index.handler',
            code:          lambda.Code.fromAsset(
                path.join(__dirname, '../../display-proxy/lambdas/tak-icon-proxy')
            ),
            timeout:       Duration.seconds(10),
            memorySize:    128,
            logGroup:      iconProxyLog,
            environment: {
                CONFIG_BUCKET: configBucketName,
                CONFIG_KEY:    'Utils-Display-Proxy-Config.json',
            },
        });

        // Grant both Lambdas read access to the S3 config file + KMS decrypt
        for (const fn of [cotProxy, iconProxy]) {
            fn.addToRolePolicy(new iam.PolicyStatement({
                effect:    iam.Effect.ALLOW,
                actions:   ['s3:GetObject'],
                resources: [`arn:aws:s3:::${configBucketName}/Utils-Display-Proxy-Config.json`],
            }));
            fn.addToRolePolicy(new iam.PolicyStatement({
                effect:    iam.Effect.ALLOW,
                actions:   ['kms:Decrypt'],
                resources: [kmsKeyArn],
            }));
        }

        // Lambda Function URLs — public, auth handled inside the Lambda
        const cotProxyUrl  = cotProxy.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.NONE,
            cors:     { allowedOrigins: ['*'] },
        });
        const iconProxyUrl = iconProxy.addFunctionUrl({
            authType: lambda.FunctionUrlAuthType.NONE,
            cors:     { allowedOrigins: ['*'] },
        });

        // ---------------------------------------------------------------------------
        // CloudFront origins
        // ---------------------------------------------------------------------------
        const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

        // Lambda Function URL hostnames (strip https:// and trailing slash)
        const cotOriginDomain  = cotProxyUrl.url.replace('https://', '').replace(/\/$/, '');
        const iconOriginDomain = iconProxyUrl.url.replace('https://', '').replace(/\/$/, '');

        const cotOrigin  = new origins.HttpOrigin(cotOriginDomain,  { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY });
        const iconOrigin = new origins.HttpOrigin(iconOriginDomain, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY });

        // ---------------------------------------------------------------------------
        // Cache policies
        // ---------------------------------------------------------------------------

        // Static assets — 1-day default; cache-busted on each BucketDeployment
        const staticCachePolicy = new cloudfront.CachePolicy(this, 'StaticCachePolicy', {
            cachePolicyName:     `Display-Static-${hostname}`,
            defaultTtl:          Duration.days(1),
            maxTtl:              Duration.days(365),
            minTtl:              Duration.seconds(0),
            headerBehavior:      cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
            cookieBehavior:      cloudfront.CacheCookieBehavior.none(),
        });

        // CoT features — 30s (live tracking); cache key includes ?key= so each
        // display token gets its own cache partition
        const cotCachePolicy = new cloudfront.CachePolicy(this, 'CotCachePolicy', {
            cachePolicyName:     `Display-CoT-${hostname}`,
            defaultTtl:          Duration.seconds(30),
            maxTtl:              Duration.seconds(60),
            minTtl:              Duration.seconds(0),
            headerBehavior:      cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('key'),
            cookieBehavior:      cloudfront.CacheCookieBehavior.none(),
        });

        // Icons — 7-day immutable cache; partitioned by ?key=
        const iconCachePolicy = new cloudfront.CachePolicy(this, 'IconCachePolicy', {
            cachePolicyName:     `Display-Icons-${hostname}`,
            defaultTtl:          Duration.days(7),
            maxTtl:              Duration.days(365),
            minTtl:              Duration.days(1),
            headerBehavior:      cloudfront.CacheHeaderBehavior.none(),
            queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('key'),
            cookieBehavior:      cloudfront.CacheCookieBehavior.none(),
        });

        // ---------------------------------------------------------------------------
        // CloudFront distribution
        // No CloudFront Function needed — auth is handled by the Lambdas at runtime
        // against access_keys in the S3 config file.
        // ---------------------------------------------------------------------------
        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            domainNames:       [fqdn],
            certificate,
            defaultRootObject: 'index.html',
            defaultBehavior: {
                origin:               s3Origin,
                cachePolicy:          staticCachePolicy,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods:       cloudfront.AllowedMethods.ALLOW_GET_HEAD,
            },
            additionalBehaviors: {
                // CoT feature endpoints — 30s cache, keyed on ?key=
                '/api/cot/*': {
                    origin:               cotOrigin,
                    cachePolicy:          cotCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods:       cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                },
                // Icon proxy — 7-day cache, keyed on ?key=
                '/api/icons/*': {
                    origin:               iconOrigin,
                    cachePolicy:          iconCachePolicy,
                    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods:       cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                },
            },
        });

        this.domainName = this.distribution.distributionDomainName;

        // ---------------------------------------------------------------------------
        // Deploy index.html to S3, invalidate CloudFront on each deploy
        // ---------------------------------------------------------------------------
        new s3deploy.BucketDeployment(this, 'SiteDeployment', {
            sources: [s3deploy.Source.asset(path.join(__dirname, '../../display-proxy'), {
                exclude: ['lambdas/**', 'node_modules/**', 'Dockerfile', '*.json', '*.js', '*.md', 'server.js'],
            })],
            destinationBucket: siteBucket,
            distribution:      this.distribution,
            distributionPaths: ['/*'],
            prune:             true,
        });

        // ---------------------------------------------------------------------------
        // Route53 A + AAAA records → CloudFront
        // ---------------------------------------------------------------------------
        const cfTarget = route53.RecordTarget.fromAlias(
            new r53targets.CloudFrontTarget(this.distribution)
        );

        new route53.ARecord(this, 'ARecord', {
            zone:       hostedZone,
            recordName: hostname,
            target:     cfTarget,
        });

        new route53.AaaaRecord(this, 'AaaaRecord', {
            zone:       hostedZone,
            recordName: hostname,
            target:     cfTarget,
        });
    }
}
