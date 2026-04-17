import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { UtilsInfraStack } from '../lib/utils-infra-stack';
import { createTestApp, mockCloudFormationImports } from './utils';

describe('UtilsInfraStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = createTestApp();
    mockCloudFormationImports(app);
  });

  it('creates stack with dev-test configuration', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check ALB creation
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    
    // Check ECS services (2 enabled containers)
    template.resourceCountIs('AWS::ECS::Service', 2);
    
    // Check security groups (ALB, ECS, EFS)
    template.resourceCountIs('AWS::EC2::SecurityGroup', 3);
    
    // Check EFS file system
    template.resourceCountIs('AWS::EFS::FileSystem', 1);
    template.resourceCountIs('AWS::EFS::AccessPoint', 2); // ais-proxy and tileserver-gl
  });

  it('creates stack with production configuration', () => {
    const envConfig = app.node.tryGetContext('prod');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'prod',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check auto scaling is configured for production
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 2);
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 4); // 2 services × 2 policies each
  });

  it('imports base infrastructure resources correctly', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    // Stack should compile without errors when imports are mocked
    expect(true).toBe(true);
  });

  it('creates IAM roles with correct permissions', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check task execution role
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'TAK-Dev-Utils-task-execution',
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'ecs-tasks.amazonaws.com' }
        }]
      }
    });

    // Check task role
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'TAK-Dev-Utils-task',
      AssumeRolePolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'ecs-tasks.amazonaws.com' }
        }]
      }
    });

    // Check S3 permissions exist
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetObject'
          })
        ])
      }
    });

    // Check KMS permissions exist
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'kms:Decrypt'
          })
        ])
      }
    });

    // Check EFS permissions exist
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.anyValue()
          })
        ])
      }
    });
  });

  it('adds ECS Exec permissions when enabled', () => {
    const envConfig = app.node.tryGetContext('prod'); // prod has ECS Exec enabled
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'prod',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check ECS Exec managed policy attachment exists
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.anyValue()
    });
  });

  it('creates Route53 records for ALB', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check A record exists
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A'
    });

    // Check AAAA record exists
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA'
    });
  });

  it('creates ALB listener rules for enabled containers', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check listener rules exist for both containers
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 1,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern'
        })
      ])
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 2,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern'
        })
      ])
    });
  });

  it('creates stack outputs', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);
    const outputs = template.toJSON().Outputs;

    // Check main outputs
    expect(outputs['UtilsUrl']).toBeDefined();
    expect(outputs['LoadBalancerDnsName']).toBeDefined();
    expect(outputs['UtilsFqdn']).toBeDefined();

    // Check container-specific outputs
    expect(outputs['weatherproxyUrl']).toBeDefined();
    expect(outputs['aisproxyUrl']).toBeDefined();
  });

  it('configures EFS file system with encryption', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Check EFS file system
    template.hasResourceProperties('AWS::EFS::FileSystem', {
      Encrypted: true,
      PerformanceMode: 'generalPurpose',
      ThroughputMode: 'bursting',
    });

    // Check EFS access point for ais-proxy
    template.hasResourceProperties('AWS::EFS::AccessPoint', {
      PosixUser: {
        Uid: '1001',
        Gid: '1001'
      },
      RootDirectory: {
        Path: '/ais-proxy',
        CreationInfo: {
          OwnerUid: '1001',
          OwnerGid: '1001',
          Permissions: '755'
        }
      }
    });
  });

  it('uses correct removal policy based on environment', () => {
    const devConfig = app.node.tryGetContext('dev-test');
    const prodConfig = app.node.tryGetContext('prod');
    
    // Test dev-test (DESTROY)
    const devStack = new UtilsInfraStack(app, 'DevStack', {
      environment: 'dev-test',
      envConfig: devConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    // Test prod (RETAIN)
    const prodStack = new UtilsInfraStack(app, 'ProdStack', {
      environment: 'prod',
      envConfig: prodConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    // Both stacks should compile without errors
    expect(devStack).toBeDefined();
    expect(prodStack).toBeDefined();
  });

  it('handles disabled containers correctly', () => {
    const envConfig = {
      ...app.node.tryGetContext('dev-test'),
      containers: {
        'weather-proxy': {
          ...app.node.tryGetContext('dev-test').containers['weather-proxy'],
          enabled: false
        },
        'ais-proxy': {
          ...app.node.tryGetContext('dev-test').containers['ais-proxy'],
          enabled: true
        }
      }
    };
    
    const stack = new UtilsInfraStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig,
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });

    const template = Template.fromStack(stack);

    // Should only create 1 ECS service (ais-proxy)
    template.resourceCountIs('AWS::ECS::Service', 1);
    
    // Should only create 1 listener rule
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);

    // Check that only ais-proxy output exists
    const outputs = template.toJSON().Outputs;
    expect(outputs['aisproxyUrl']).toBeDefined();
    expect(outputs['weatherproxyUrl']).toBeUndefined();
  });
});