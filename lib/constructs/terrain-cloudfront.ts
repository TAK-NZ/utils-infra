/**
 * CloudFront Construct - CDN for terrain-proxy
 */
import { Construct } from 'constructs';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  Duration,
} from 'aws-cdk-lib';

export interface TerrainCloudFrontProps {
  albDomainName: string;
  certificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  hostname: string;
  apiKeys: string[];
}

export class TerrainCloudFront extends Construct {
  public readonly distribution: cloudfront.Distribution;
  public readonly domainName: string;

  constructor(scope: Construct, id: string, props: TerrainCloudFrontProps) {
    super(scope, id);

    const { albDomainName, certificate, hostedZone, hostname, apiKeys } = props;

    const albOrigin = new origins.HttpOrigin(albDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // Forward Host header so ALB routes correctly
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
      originRequestPolicyName: `Terrain-OriginRequest-${hostname}`,
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Host'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // Terrain tiles are immutable — cache for 1 year
    const tileCachePolicy = new cloudfront.CachePolicy(this, 'TileCachePolicy', {
      cachePolicyName: `Terrain-Tiles-${hostname}`,
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Manifest — cache for 1 hour
    const manifestCachePolicy = new cloudfront.CachePolicy(this, 'ManifestCachePolicy', {
      cachePolicyName: `Terrain-Manifest-${hostname}`,
      defaultTtl: Duration.minutes(5),
      maxTtl: Duration.hours(1),
      minTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Health — no cache
    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: `Terrain-NoCache-${hostname}`,
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      minTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // API key validation for terrain tile requests
    const apiKeyFunction = new cloudfront.Function(this, 'ApiKeyFunction', {
      functionName: `terrain-api-auth-${Date.now()}`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var request = event.request;

    // Allow health without auth
    if (request.uri === '/terrain/health') {
        return request;
    }

    // Check for API key in query string
    var querystring = request.querystring;
    if (!querystring.api || !querystring.api.value) {
        return {
            statusCode: 401,
            statusDescription: 'Unauthorized',
            body: 'API key required'
        };
    }

    var providedKey = querystring.api.value;
    var validKeys = ${JSON.stringify(apiKeys)};

    if (validKeys.indexOf(providedKey) === -1) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden',
            body: 'Invalid API key'
        };
    }

    return request;
}
      `),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [`${hostname}.${hostedZone.zoneName}`],
      certificate,
      defaultBehavior: {
        origin: albOrigin,
        cachePolicy: manifestCachePolicy,
        originRequestPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        functionAssociations: [{
          function: apiKeyFunction,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      additionalBehaviors: {
        // Terrain tiles — cache aggressively
        '/terrain/*.png': {
          origin: albOrigin,
          cachePolicy: tileCachePolicy,
          originRequestPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          functionAssociations: [{
            function: apiKeyFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
        // Health — no cache, no auth
        '/terrain/health': {
          origin: albOrigin,
          cachePolicy: noCachePolicy,
          originRequestPolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
    });

    this.domainName = this.distribution.distributionDomainName;
  }
}
