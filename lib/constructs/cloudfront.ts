/**
 * CloudFront Construct - CDN for tileserver-gl
 */
import { Construct } from 'constructs';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_lambda as lambda,
  aws_iam as iam,
  Duration,
} from 'aws-cdk-lib';

/**
 * Properties for the CloudFront construct
 */
export interface CloudFrontProps {
  /**
   * ALB domain name to use as origin
   */
  albDomainName: string;

  /**
   * SSL certificate for CloudFront
   */
  certificate: acm.ICertificate;

  /**
   * Route53 hosted zone
   */
  hostedZone: route53.IHostedZone;

  /**
   * Hostname for the tiles service
   */
  hostname: string;

  /**
   * Cache TTL configuration
   */
  cacheTtl?: {
    tiles?: string;
    metadata?: string;
    health?: string;
  };

  /**
   * API keys for authentication
   */
  apiKeys: string[];
}

/**
 * CDK construct for CloudFront distribution for tiles
 */
export class CloudFront extends Construct {
  /**
   * CloudFront distribution
   */
  public readonly distribution: cloudfront.Distribution;

  /**
   * Domain name of the distribution
   */
  public readonly domainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontProps) {
    super(scope, id);

    const { albDomainName, certificate, hostedZone, hostname, cacheTtl, apiKeys } = props;

    // Create origin for ALB
    const albOrigin = new origins.HttpOrigin(albDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    // Create origin request policy to forward Host header
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
      originRequestPolicyName: 'TileServerGL-OriginRequest',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('Host'),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    // Parse cache TTL values
    const parseTtl = (ttl: string): Duration => {
      const match = ttl.match(/^(\d+)([dhms])$/);
      if (!match) return Duration.hours(1);
      const [, value, unit] = match;
      const num = parseInt(value);
      switch (unit) {
        case 'd': return Duration.days(num);
        case 'h': return Duration.hours(num);
        case 'm': return Duration.minutes(num);
        case 's': return Duration.seconds(num);
        default: return Duration.hours(1);
      }
    };

    const tileTtl = cacheTtl?.tiles ? parseTtl(cacheTtl.tiles) : Duration.days(30);
    const metadataTtl = cacheTtl?.metadata ? parseTtl(cacheTtl.metadata) : Duration.hours(1);
    const healthTtl = cacheTtl?.health ? parseTtl(cacheTtl.health) : Duration.seconds(0);

    // Create cache policies
    const tileCachePolicy = new cloudfront.CachePolicy(this, 'TileCachePolicy', {
      cachePolicyName: 'TileServerGL-Tiles',
      defaultTtl: tileTtl,
      maxTtl: Duration.days(365),
      minTtl: tileTtl.toSeconds() < 86400 ? Duration.seconds(0) : Duration.days(1), // Adjust minTtl if defaultTtl is less than 1 day
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const metadataCachePolicy = new cloudfront.CachePolicy(this, 'MetadataCachePolicy', {
      cachePolicyName: 'TileServerGL-Metadata',
      defaultTtl: metadataTtl,
      maxTtl: metadataTtl.toSeconds() > 86400 ? metadataTtl : Duration.days(1), // Adjust maxTtl if defaultTtl is greater than 1 day
      minTtl: metadataTtl.toSeconds() < 60 ? Duration.seconds(0) : Duration.minutes(1), // Adjust minTtl if defaultTtl is less than 1 minute
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: 'TileServerGL-NoCache',
      defaultTtl: healthTtl,
      maxTtl: healthTtl.toSeconds() > 1 ? healthTtl : Duration.seconds(1),
      minTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Create CloudFront Function for API key validation (styles only)
    const apiKeyFunction = new cloudfront.Function(this, 'ApiKeyFunction', {
      functionName: `tileserver-api-auth-${Date.now()}`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var request = event.request;
    
    // Only validate /styles/* paths - allow everything else
    if (!request.uri.startsWith('/styles/')) {
        return request;
    }
    
    // Exclude specific files from authentication (preview tiles for web interface)
    var excludedFiles = [
        '/styles/topolite/12/4036/2564.png',
        '/styles/topolite/2/2/2.png',
        '/styles/linz-topo/12/4036/2564.png',
        '/styles/topographic/12/4036/2564.png',
        '/styles/topographic/2/2/2.png',
        '/styles/nationalmap/12/4036/2564.png',
        '/styles/linz-marine/12/4036/2564.png'
    ];
    
    if (excludedFiles.indexOf(request.uri) !== -1) {
        return request;
    }
    
    // Check for API key in query string
    var querystring = request.querystring;
    if (!querystring.api || !querystring.api.value) {
        return {
            statusCode: 401,
            statusDescription: 'Unauthorized',
            body: 'API key required for styles access'
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

    // Create distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [`${hostname}.${hostedZone.zoneName}`],
      certificate,
      defaultBehavior: {
        origin: albOrigin,
        cachePolicy: metadataCachePolicy,
        originRequestPolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        // All tile images - long cache (covers all image formats and path depths)
        '/styles/*': {
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
        // Health endpoint - no cache
        '/health': {
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