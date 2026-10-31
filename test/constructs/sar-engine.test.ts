import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SarEngine } from '../../lib/constructs/sar-engine';
import { SarEngineConfig } from '../../lib/stack-config';

const baseConfig: SarEngineConfig = {
  enabled: true,
  path: '/sar/',
  priority: 7,
  imageTag: 'v0.1.0',
  engineRepo: 'TAK-NZ/sar-engine',
  engineRef: '7029fe7c7a3c4ff2fe2cb0063a9ce48c05cefbd3',
  memorySize: 2048,
  timeoutSeconds: 55,
  dataPrefix: 'sar-engine',
  apiKeysConfigKey: 'Utils-SAR-Engine-Api-Keys.json',
  osmRefresh: { enabled: true, dayOfMonth: 3, hourUtc: 14 },
};

function build(overrides: Partial<SarEngineConfig> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test', { env: { account: '123456789012', region: 'ap-southeast-2' } });
  const sar = new SarEngine(stack, 'Sar', {
    config: { ...baseConfig, ...overrides },
    ecrRepositoryName: 'tak-dev-artifacts',
    imageTag: 'utils-sar-engine-v0.1.0-7029fe7',
    dataBucketName: 'tak-dev-artifacts-bucket',
    configBucketName: 'tak-dev-config-bucket',
    kmsKeyArn: 'arn:aws:kms:ap-southeast-2:123456789012:key/abc',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  return { stack, sar, template: Template.fromStack(stack) };
}

/** All statements of the IAM policies attached to the function whose logical id starts with `fnPrefix`. */
function statementsFor(template: Template, roleLogicalIdPrefix: string): any[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleLogicalIdPrefix))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

describe('SarEngine construct', () => {
  it('creates an HTTP function and a refresh function from the shared ECR repository', () => {
    const { template } = build();
    template.resourceCountIs('AWS::Lambda::Function', 2);
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    fns.forEach((fn) => {
      expect(fn.Properties.PackageType).toBe('Image');
      expect(fn.Properties.Architectures).toEqual(['x86_64']);
      expect(JSON.stringify(fn.Properties.Code.ImageUri)).toContain('utils-sar-engine-v0.1.0-7029fe7');
      expect(JSON.stringify(fn.Properties.Code.ImageUri)).toContain('tak-dev-artifacts');
    });
  });

  it('keeps the HTTP timeout below the 60 s ALB idle timeout, and rejects a config that does not', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('travel-time'),
      Timeout: 55,
      MemorySize: 2048,
    });
    expect(() => build({ timeoutSeconds: 60 })).toThrow(/ALB idle timeout/);
  });

  it('points the HTTP function at the data prefix and the API keys file, with no secret in its environment', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('travel-time'),
      Environment: {
        Variables: {
          SAR_DATA_DIR: '/vsis3/tak-dev-artifacts-bucket/sar-engine',
          SAR_CONFIG_BUCKET: 'tak-dev-config-bucket',
          SAR_CONFIG_KEY: 'Utils-SAR-Engine-Api-Keys.json',
        },
      },
    });
    const env = JSON.stringify(
      Object.values(template.findResources('AWS::Lambda::Function')).map((f: any) => f.Properties.Environment));
    expect(env).not.toMatch(/API_KEY|SECRET|TOKEN|PASSWORD/i);
  });

  it('runs the refresh from the same image with the command overridden, sized for the measured working set', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('refresh'),
      ImageConfig: { Command: ['osm_refresh.lambda_handler'] },
      MemorySize: 3072,
      Timeout: 600,
      EphemeralStorage: { Size: 2048 },
      Environment: { Variables: { SAR_DATA_BUCKET: 'tak-dev-artifacts-bucket', SAR_DATA_PREFIX: 'sar-engine' } },
    });
  });

  it('registers the HTTP function as a Lambda target group with health checks off', () => {
    const { template } = build();
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'lambda',
      Targets: Match.arrayWith([Match.objectLike({ Id: Match.anyValue() })]),
    });
    const tg = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))[0] as any;
    expect(tg.Properties.HealthCheckEnabled).not.toBe(true);
    // the load balancer may invoke the function
    template.hasResourceProperties('AWS::Lambda::Permission', { Principal: 'elasticloadbalancing.amazonaws.com' });
  });

  describe('IAM is limited to the data prefix', () => {
    it('HTTP function: read-only on the prefix, one config object, KMS only via S3', () => {
      const { template } = build();
      const stmts = statementsFor(template, 'HttpFn');
      const text = JSON.stringify(stmts);
      expect(text).toContain('arn:aws:s3:::tak-dev-artifacts-bucket/sar-engine/*');
      expect(text).toContain('arn:aws:s3:::tak-dev-config-bucket/Utils-SAR-Engine-Api-Keys.json');
      expect(text).not.toMatch(/s3:(Put|Delete)Object/);
      expect(text).not.toContain('tak-dev-config-bucket/*');
      const kms = stmts.find((s) => JSON.stringify(s.Action).includes('kms:Decrypt'));
      expect(kms.Condition).toEqual({ StringEquals: { 'kms:ViaService': 's3.ap-southeast-2.amazonaws.com' } });
      expect(JSON.stringify(kms.Action)).not.toContain('GenerateDataKey');
    });

    it('refresh function: writes only the OSM snapshots and the pointer, never the land cover raster', () => {
      const { template } = build();
      const stmts = statementsFor(template, 'RefreshFn');
      const writes = stmts.filter((s) => /Put|Delete/.test(JSON.stringify(s.Action)));
      expect(writes.length).toBeGreaterThan(0);
      const writeResources = JSON.stringify(writes.map((s) => s.Resource));
      expect(writeResources).toContain('sar-engine/osm/*');
      expect(writeResources).toContain('sar-engine/nz_osm_meta.geojson');
      expect(writeResources).not.toContain('sar-engine/*"');          // no blanket write on the prefix
      expect(writeResources).not.toMatch(/lcdb/);
      const del = stmts.find((s) => JSON.stringify(s.Action).includes('s3:DeleteObject'));
      expect(JSON.stringify(del.Resource)).toContain('sar-engine/osm/*');
      expect(JSON.stringify(del.Resource)).not.toContain('nz_osm_meta');
      const kms = stmts.find((s) => JSON.stringify(s.Action).includes('kms:GenerateDataKey'));
      expect(kms.Condition).toEqual({ StringEquals: { 'kms:ViaService': 's3.ap-southeast-2.amazonaws.com' } });
    });

    it('refuses an empty prefix, because access is granted by prefix', () => {
      expect(() => build({ dataPrefix: '/' })).toThrow(/dataPrefix/);
      expect(() => build({ dataPrefix: '' })).toThrow(/dataPrefix/);
    });

    it('normalises slashes around the prefix', () => {
      const { template } = build({ dataPrefix: '/sar-engine/' });
      expect(JSON.stringify(statementsFor(template, 'HttpFn'))).toContain('tak-dev-artifacts-bucket/sar-engine/*');
    });
  });

  describe('monthly refresh', () => {
    it('is scheduled for the configured day and hour (UTC)', () => {
      const { template } = build({ osmRefresh: { enabled: true, dayOfMonth: 9, hourUtc: 4 } });
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: 'cron(0 4 9 * ? *)',
        State: 'ENABLED',
      });
    });

    it('can be switched off without removing the function', () => {
      const { template } = build({ osmRefresh: { enabled: false, dayOfMonth: 3, hourUtc: 14 } });
      template.hasResourceProperties('AWS::Events::Rule', { State: 'DISABLED' });
      template.resourceCountIs('AWS::Lambda::Function', 2);
    });

    it('retries twice, and alarms (to an SNS topic) when a run fails', () => {
      const { template } = build();
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 2 } })]),
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Errors',
        Namespace: 'AWS/Lambda',
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: Match.anyValue(),
      });
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('the alerts topic requires TLS and has no subscribers by default', () => {
      const { template } = build();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
      });
    });
  });

  it('reserves concurrency only when asked', () => {
    const none = build().template.findResources('AWS::Lambda::Function');
    Object.values(none).forEach((f: any) => expect(f.Properties.ReservedConcurrentExecutions).toBeUndefined());
    const capped = build({ reservedConcurrency: 10 }).template.findResources('AWS::Lambda::Function');
    const http = Object.values(capped).find((f: any) => /travel-time/.test(f.Properties.Description)) as any;
    expect(http.Properties.ReservedConcurrentExecutions).toBe(10);
  });
});
