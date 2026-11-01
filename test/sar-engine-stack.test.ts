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

const FIXTURE = path.join(__dirname, 'fixtures', 'sar-engine-src');

/** The SAR engine's docker image in the assets manifest (the other containers build assets too). */
function sarImage(outdir: string) {
  const assets = JSON.parse(fs.readFileSync(path.join(outdir, 'TestStack.assets.json'), 'utf8'));
  const found = Object.entries<any>(assets.dockerImages ?? {}).filter(([, v]) => v.source.dockerFile === 'Dockerfile.lambda');
  return found;
}

/** Synthesizes dev-test with the SAR engine on and returns the template plus the cloud assembly directory. */
function synthWithAssembly(extraContext: Record<string, unknown>) {
  const outdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sar-asm-'));
  const app = new cdk.App({ outdir, context: { ...extraContext } });
  const base = JSON.parse(JSON.stringify(cdkJson['dev-test']));
  base.sarEngine = { ...base.sarEngine, enabled: true };
  const stack = new UtilsInfraStack(app, 'TestStack', {
    environment: 'dev-test',
    envConfig: applyContextOverrides(app, base),
    env: { account: '123456789012', region: 'ap-southeast-2' },
  });
  const assembly = app.synth();
  return { template: Template.fromStack(stack), outdir, assembly, stack };
}

describe('SAR engine image built by the deploy (sarEngineSourcePath)', () => {
  const ctx = { sarEngineSourcePath: FIXTURE };

  it('builds the image from the checkout instead of pointing at ECR (dev-test ships usePreBuiltImages=false)', () => {
    expect(cdkJson['dev-test'].docker.usePreBuiltImages).toBe(false);
    const { template, outdir } = synthWithAssembly(ctx);
    const sarFns = Object.values<any>(template.findResources('AWS::Lambda::Function'))
      .filter((f) => /SAR engine/.test(f.Properties.Description ?? ''));
    expect(sarFns).toHaveLength(2);
    sarFns.forEach((f) => {
      const uri = JSON.stringify(f.Properties.Code.ImageUri);
      expect(uri).not.toContain('utils-sar-engine-');   // no ECR tag: the image is a CDK asset
      expect(uri).toContain('cdk-hnb659fds-container-assets');
    });
    // the refresh function still overrides the command
    template.hasResourceProperties('AWS::Lambda::Function', {
      ImageConfig: { Command: ['osm_refresh.lambda_handler'] },
    });
    const images = sarImage(outdir);
    expect(images).toHaveLength(1);                       // both functions share one image
    expect(images[0][1].source.platform).toBe('linux/amd64');
  });

  it('keeps local data, results and git history out of the build context', () => {
    const { outdir } = synthWithAssembly(ctx);
    const files = fs.readdirSync(path.join(outdir, sarImage(outdir)[0][1].source.directory));
    expect(files).toContain('Dockerfile.lambda');
    expect(files).toContain('nz');
    expect(files).not.toContain('results');
    expect(files).not.toContain('data');
  });

  it('gives an image that changes when the checkout changes (so a new engine commit redeploys the Lambda)', () => {
    const copy = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sar-src-'));
    fs.cpSync(FIXTURE, copy, { recursive: true });
    const hash = () => {
      const { outdir } = synthWithAssembly({ sarEngineSourcePath: copy });
      return sarImage(outdir)[0][0];
    };
    const before = hash();
    fs.appendFileSync(path.join(copy, 'nz', 'handler.py'), '# changed\n');
    expect(hash()).not.toEqual(before);
  });

  it('does not depend on the ECR tag when building from source', () => {
    const { template } = synthWithAssembly({ ...ctx, imageTagsJson: JSON.stringify({ 'sar-engine': 'utils-sar-engine-x' }) });
    expect(JSON.stringify(template.toJSON())).not.toContain('utils-sar-engine-x');
  });

  it('fails clearly when the path is not a sar-engine checkout', () => {
    expect(() => synthWithAssembly({ sarEngineSourcePath: path.join(__dirname, 'fixtures') })).toThrow(/Dockerfile\.lambda/);
  });

  it('refuses to build when usePreBuiltImages=true: CI and prod take the image from ECR', () => {
    expect(() => synthWithAssembly({ ...ctx, usePreBuiltImages: true })).toThrow(/usePreBuiltImages=false/);
  });

  it('builds from the vendored sar-engine/ folder of this repository when no source path is given', () => {
    const { template, outdir } = synthWithAssembly({});
    const images = sarImage(outdir);
    expect(images).toHaveLength(1);
    const files = fs.readdirSync(path.join(outdir, images[0][1].source.directory));
    expect(files).toContain('Dockerfile.lambda');
    expect(files).toContain('nz');
    expect(files).toContain('app');
    expect(files).not.toContain('data');
    expect(files).not.toContain('.git');
    expect(JSON.stringify(template.toJSON())).not.toContain('utils-sar-engine-');   // a CDK asset, not an ECR tag
  });
  it('ships a vendored folder the image build can use (Dockerfile.lambda and every file it copies exist)', () => {
    const root = path.join(__dirname, '..', 'sar-engine');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.lambda'), 'utf8').replace(/\\\n/g, ' ');
    const sources = dockerfile.split('\n').filter((l) => /^COPY /.test(l) && !l.includes('--from'))
      .flatMap((l) => l.replace(/^COPY /, '').trim().split(/\s+/).slice(0, -1))
      .filter((p) => !p.includes('${'));
    expect(sources.length).toBeGreaterThan(5);
    sources.forEach((p) => expect(fs.existsSync(path.join(root, p))).toBe(true));
  });
  it('sarEngineSourcePath still overrides the vendored folder', () => {
    const { outdir } = synthWithAssembly(ctx);
    const files = fs.readdirSync(path.join(outdir, sarImage(outdir)[0][1].source.directory));
    expect(files).not.toContain('app');                  // the fixture has no app/ folder; the vendored folder does
  });
  it('with usePreBuiltImages=true and no imageTagsJson: placeholder tag and a warning (the workflows always pass the tag)', () => {
    const { template, stack } = synthWithAssembly({ usePreBuiltImages: true });
    expect(JSON.stringify(template.toJSON())).toContain('utils-sar-engine-v');
    const { Annotations, Match: M } = require('aws-cdk-lib/assertions');
    Annotations.fromStack(stack).hasWarning('*', M.stringLikeRegexp('imageTagsJson does not name'));
  });
  it('with usePreBuiltImages=true and imageTagsJson naming the image: uses that tag and does not warn', () => {
    const tag = 'utils-sar-engine-v0.2.0-abc1234';
    const { template, stack } = synthWithAssembly({ usePreBuiltImages: true, imageTagsJson: JSON.stringify({ 'sar-engine': tag }) });
    expect(JSON.stringify(template.toJSON())).toContain(tag);
    const { Annotations, Match: M } = require('aws-cdk-lib/assertions');
    Annotations.fromStack(stack).hasNoWarning('*', M.stringLikeRegexp('imageTagsJson does not name'));
  });
});

describe('SAR engine in the utils stack', () => {
  describe.each(['dev-test', 'prod'] as const)('%s', (environment) => {
    it('has a complete and valid configuration (whether or not it is switched on)', () => {
      const sar = cdkJson[environment].sarEngine;
      expect(typeof sar.enabled).toBe('boolean');
      expect(sar.path).toMatch(/^\/[a-z-]+\/$/);
      expect(sar.timeoutSeconds).toBeLessThan(60);
      // the engine lives in this repository's sar-engine/ folder: there is no separate repository or commit to pin
      expect(sar.engineRepo).toBeUndefined();
      expect(sar.engineRef).toBeUndefined();
      expect(sar.imageTag).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(sar.osmRefresh.dayOfMonth).toBeGreaterThanOrEqual(1);
      expect(sar.osmRefresh.dayOfMonth).toBeLessThanOrEqual(28);
      expect(sar.osmRefresh.hourUtc).toBeGreaterThanOrEqual(0);
      expect(sar.osmRefresh.hourUtc).toBeLessThanOrEqual(23);
    });

    it('priority does not collide with any other listener rule', () => {
      const priorities = Object.values<any>(cdkJson[environment].containers)
        .filter((c) => c.enabled && c.priority)
        .map((c) => c.priority);
      // terrain-proxy is a Lambda function with its own section, but it shares the listener
      if (cdkJson[environment].terrainProxy?.enabled) priorities.push(cdkJson[environment].terrainProxy.priority);
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

    it('when enabled and pre-built: CI names the image through imageTagsJson (the build workflows do)', () => {
      const text = JSON.stringify(synth(environment, { enabled: true },
        { usePreBuiltImages: true, imageTagsJson: JSON.stringify({ 'sar-engine': 'utils-sar-engine-20261030-120000' }) }).toJSON());
      expect(text).toContain('utils-sar-engine-20261030-120000');
    });
    it('when enabled and pre-built without imageTagsJson: the placeholder tag is <version> alone', () => {
      const sar = cdkJson[environment].sarEngine;
      const text = JSON.stringify(synth(environment, { enabled: true }, { usePreBuiltImages: true }).toJSON());
      expect(text).toContain(`utils-sar-engine-${sar.imageTag}"`);
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
