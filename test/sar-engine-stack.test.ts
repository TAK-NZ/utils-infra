import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { UtilsInfraStack } from '../lib/utils-infra-stack';
import { applyContextOverrides } from '../lib/utils/context-overrides';

// The shipped configuration is the source of truth: these tests read cdk.json, not a hand-made fixture.
const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')).context;

function synth(environment: 'dev-test' | 'prod', sarOverrides?: Record<string, unknown>, extraContext: Record<string, unknown> = {}) {
  const app = new cdk.App({ context: { ...extraContext } });
  const base = JSON.parse(JSON.stringify(cdkJson[environment]));
  if (sarOverrides) base.sarEngine = { ...base.sarEngine, ...sarOverrides };
  const envConfig = applyContextOverrides(app, base);
  const stack = new UtilsInfraStack(app, 'TestStack', {
    environment,
    envConfig,
    env: { account: '123456789012', region: 'ap-southeast-2' },
  });
  return Template.fromStack(stack);
}

describe('SAR engine in the utils stack', () => {
  describe.each(['dev-test', 'prod'] as const)('%s', (environment) => {
    it('has a complete and valid configuration (whether or not it is switched on)', () => {
      const sar = cdkJson[environment].sarEngine;
      expect(typeof sar.enabled).toBe('boolean');
      expect(sar.path).toMatch(/^\/[a-z-]+\/$/);
      expect(sar.timeoutSeconds).toBeLessThan(60);
      expect(sar.engineRepo).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      // pinned to an exact commit, never a branch name
      expect(sar.engineRef).toMatch(/^[0-9a-f]{40}$/);
      expect(sar.osmRefresh.dayOfMonth).toBeGreaterThanOrEqual(1);
      expect(sar.osmRefresh.dayOfMonth).toBeLessThanOrEqual(28);
      expect(sar.osmRefresh.hourUtc).toBeGreaterThanOrEqual(0);
      expect(sar.osmRefresh.hourUtc).toBeLessThanOrEqual(23);
    });

    it('priority does not collide with any other listener rule', () => {
      const priorities = Object.values<any>(cdkJson[environment].containers)
        .filter((c) => c.enabled && c.priority)
        .map((c) => c.priority);
      expect(priorities).not.toContain(cdkJson[environment].sarEngine.priority);
    });

    it('adds nothing to the stack when switched off: identical to a stack with no sarEngine section at all', () => {
      const withoutSection = (() => {
        const app = new cdk.App();
        const base = JSON.parse(JSON.stringify(cdkJson[environment]));
        delete base.sarEngine;
        const stack = new UtilsInfraStack(app, 'TestStack', {
          environment, envConfig: applyContextOverrides(app, base), env: { account: '123456789012', region: 'ap-southeast-2' },
        });
        return Template.fromStack(stack).toJSON();
      })();
      const shipped = synth(environment, { enabled: false }).toJSON();      // forced off, whatever cdk.json ships
      // The existing CloudFront auth functions embed Date.now() in their names, so two synths never match exactly.
      const stable = (t: unknown) => JSON.parse(JSON.stringify(t).replace(/(api-auth-)\d{10,}/g, '$1<timestamp>'));
      expect(stable(shipped)).toEqual(stable(withoutSection));
      expect(JSON.stringify(shipped)).not.toMatch(/sar-engine|SarEngine|osm_refresh/i);
    });

    it('when enabled: wires two functions, an /sar/* ALB rule at the configured priority, and the outputs', () => {
      const template = synth(environment, { enabled: true });
      const fns = Object.values<any>(template.findResources('AWS::Lambda::Function'))
        .filter((f) => JSON.stringify(f.Properties.Code).includes('sar-engine') || /SAR engine/.test(f.Properties.Description ?? ''));
      expect(fns).toHaveLength(2);
      template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
        Priority: 7,
        Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/sar/*'] } }],
      });
      ['SarEngineUrl', 'SarEngineDataLocation', 'SarEngineRefreshFunction', 'SarEngineAlertsTopicArn'].forEach((o) =>
        expect(template.toJSON().Outputs[o]).toBeDefined());
    });

    it('when enabled: the /sar/* rule also covers /sar/tarr, /sar/travel-time and /sar/health, and nothing outside /sar/', () => {
      const template = synth(environment, { enabled: true });
      const rules = Object.values<any>(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
        .filter((r) => r.Properties.Priority === 7);
      expect(rules).toHaveLength(1);
      const pattern: string = rules[0].Properties.Conditions[0].PathPatternConfig.Values[0];
      // ALB wildcard: '*' matches any number of characters.
      const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      ['/sar/tarr', '/sar/travel-time', '/sar/health'].forEach((path) => expect(path).toMatch(regex));
      expect('/saru/tarr').not.toMatch(regex);
    });

    it('when enabled: the image tag defaults to <version>-<first 7 of the ref>, matching what CI pushes', () => {
      const sar = cdkJson[environment].sarEngine;
      const expected = `utils-sar-engine-${sar.imageTag}-${sar.engineRef.slice(0, 7)}`;
      const text = JSON.stringify(synth(environment, { enabled: true }).toJSON());
      expect(text).toContain(expected);
    });

    it('when enabled: CI can override the tag through imageTagsJson (the build workflows do)', () => {
      const text = JSON.stringify(synth(environment, { enabled: true },
        { imageTagsJson: JSON.stringify({ 'sar-engine': 'utils-sar-engine-20261030-120000' }) }).toJSON());
      expect(text).toContain('utils-sar-engine-20261030-120000');
    });

    it('when enabled: the data bucket grant is the artifacts bucket under the configured prefix only', () => {
      const template = synth(environment, { enabled: true });
      const statements = Object.values<any>(template.findResources('AWS::IAM::Policy'))
        .flatMap((p) => p.Properties.PolicyDocument.Statement)
        .filter((s) => JSON.stringify(s).includes('sar-engine/'));
      expect(statements.length).toBeGreaterThan(0);
      statements.forEach((s) => expect(JSON.stringify(s.Resource)).toMatch(/AppImagesBucket/));
    });
  });

  it('turning it on does not disturb the existing services', () => {
    const before = synth('dev-test', { enabled: false });
    const after = synth('dev-test', { enabled: true });
    expect(Object.keys(after.findResources('AWS::ECS::Service')).sort()).toEqual(
      Object.keys(before.findResources('AWS::ECS::Service')).sort());
    expect(Object.keys(after.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))).toHaveLength(1);
  });

  it('fails clearly when the timeout is not below the ALB idle timeout', () => {
    expect(() => synth('dev-test', { enabled: true, timeoutSeconds: 90 })).toThrow(/ALB idle timeout/);
  });
});
