import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import {
  DEFAULT_SITREP_INTERVAL_MINUTES,
  SitRepLambda,
  SitRepLambdaProps,
  sitrepCronMinute,
} from '../../lib/constructs/sitrep-lambda';

function build(overrides: Partial<SitRepLambdaProps> = {}): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test', { env: { account: '123456789012', region: 'ap-southeast-2' } });
  new SitRepLambda(stack, 'SitRep', {
    configBucket: s3.Bucket.fromBucketName(stack, 'Bucket', 'test-config-bucket'),
    kmsKeyArn: 'arn:aws:kms:ap-southeast-2:123456789012:key/abc',
    configKey: 'Utils-Display-Proxy-Config.json',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    ...overrides,
  });
  return Template.fromStack(stack);
}

function scheduleOf(template: Template): { expression: string; description: string } {
  const rules = Object.values(template.findResources('AWS::Events::Rule')) as any[];
  expect(rules).toHaveLength(1);
  return { expression: rules[0].Properties.ScheduleExpression, description: rules[0].Properties.Description };
}

describe('SitRepLambda schedule', () => {
  test('defaults to every 30 minutes on the clock', () => {
    expect(DEFAULT_SITREP_INTERVAL_MINUTES).toBe(30);
    const { expression, description } = scheduleOf(build());
    expect(expression).toBe('cron(0/30 * * * ? *)');
    expect(description).toContain('30 minutes');
  });

  test.each([
    [15, 'cron(0/15 * * * ? *)'],
    [20, 'cron(0/20 * * * ? *)'],
    [30, 'cron(0/30 * * * ? *)'],
    [60, 'cron(0 * * * ? *)'],
  ])('interval %i produces %s', (interval, expected) => {
    expect(scheduleOf(build({ scheduleIntervalMinutes: interval })).expression).toBe(expected);
  });

  test.each([0, -5, 7, 45, 90, 2.5, Number.NaN])('rejects interval %p, which does not divide 60', (interval) => {
    expect(() => build({ scheduleIntervalMinutes: interval })).toThrow(/divides 60/);
  });
});

describe('SitRepLambda function', () => {
  test('has a 120 second timeout, enough for slow CloudTAK reads plus the model call', () => {
    const template = build();
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const sitrep = fns.find((f) => f.Properties.Environment?.Variables?.MODEL_ID);
    expect(sitrep.Properties.Timeout).toBe(120);
  });
});

describe('sitrepCronMinute', () => {
  test('anchors to the top of the hour', () => {
    expect(sitrepCronMinute(1)).toBe('0/1');
    expect(sitrepCronMinute(30)).toBe('0/30');
    expect(sitrepCronMinute(60)).toBe('0');
  });
});
