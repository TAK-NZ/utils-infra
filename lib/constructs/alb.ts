/**
 * ALB Construct - Application Load Balancer for Utils services
 */
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  Duration,
  Fn
} from 'aws-cdk-lib';
import type { ContextEnvironmentConfig } from '../stack-config';
import { createBaseImportValue, BASE_EXPORT_NAMES } from '../cloudformation-imports';

/**
 * Properties for the ALB construct
 */
export interface AlbProps {
  /**
   * Environment type ('prod' | 'dev-test')
   */
  environment: 'prod' | 'dev-test';

  /**
   * Context-based environment configuration
   */
  contextConfig: ContextEnvironmentConfig;

  /**
   * VPC for deployment
   */
  vpc: ec2.IVpc;

  /**
   * SSL certificate
   */
  certificate: acm.ICertificate;

  /**
   * Route53 hosted zone
   */
  hostedZone: route53.IHostedZone;

  /**
   * ALB security group
   */
  albSecurityGroup: ec2.ISecurityGroup;
}

/**
 * CDK construct for the Application Load Balancer for Utils
 */
export class Alb extends Construct {
  /**
   * The application load balancer
   */
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;

  /**
   * Default target group for health checks
   */
  public readonly defaultTargetGroup: elbv2.ApplicationTargetGroup;

  /**
   * HTTPS listener for routing
   */
  public readonly httpsListener: elbv2.ApplicationListener;

  /**
   * DNS name of the load balancer
   */
  public readonly dnsName: string;

  /**
   * Utils FQDN (utils.domain)
   */
  public readonly utilsFqdn: string;

  /**
   * Route53 hosted zone
   */
  private readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: AlbProps) {
    super(scope, id);

    const { contextConfig, vpc, certificate, hostedZone, albSecurityGroup } = props;

    // Store hostedZone reference
    this.hostedZone = hostedZone;

    // Create the utils FQDN using imported hosted zone name
    this.utilsFqdn = `${contextConfig.utilsHostname}.${hostedZone.zoneName}`;

    // Create application load balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      loadBalancerName: `utils-infra-${contextConfig.stackName.toLowerCase()}`,
      vpc,
      internetFacing: true,
      ipAddressType: elbv2.IpAddressType.DUAL_STACK,
      securityGroup: albSecurityGroup,
    });

    // Create default target group for health checks
    this.defaultTargetGroup = new elbv2.ApplicationTargetGroup(this, 'DefaultTargetGroup', {
      targetGroupName: `utils-infra-${contextConfig.stackName.toLowerCase()}-default`,
      vpc,
      targetType: elbv2.TargetType.IP,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        enabled: true,
        path: '/weather-radar/health',
        protocol: elbv2.Protocol.HTTP,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Create HTTPS listener
    this.httpsListener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultTargetGroups: [this.defaultTargetGroup],
    });

    // Redirect HTTP to HTTPS
    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Import S3 logs bucket from BaseInfra
    const logsBucket = s3.Bucket.fromBucketArn(this, 'ImportedLogsBucket',
      Fn.importValue(createBaseImportValue(contextConfig.stackName, BASE_EXPORT_NAMES.S3_ELB_LOGS))
    );

    // Enable ALB access logging
    this.loadBalancer.setAttribute('access_logs.s3.enabled', 'true');
    this.loadBalancer.setAttribute('access_logs.s3.bucket', logsBucket.bucketName);
    this.loadBalancer.setAttribute('access_logs.s3.prefix', `TAK-${contextConfig.stackName}-UtilsInfra`);
    
    // Configure ALB for larger request bodies (AIS uploads)
    this.loadBalancer.setAttribute('routing.http2.enabled', 'true');
    this.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '60');
    this.loadBalancer.setAttribute('connection_logs.s3.enabled', 'false');

    // Create Route53 record
    new route53.ARecord(this, 'UtilsARecord', {
      zone: hostedZone,
      recordName: contextConfig.utilsHostname,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });

    // Create IPv6 record
    new route53.AaaaRecord(this, 'UtilsAaaaRecord', {
      zone: hostedZone,
      recordName: contextConfig.utilsHostname,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.loadBalancer)
      ),
    });

    // Store the DNS name
    this.dnsName = this.loadBalancer.loadBalancerDnsName;
  }

  /**
   * Add a listener rule for a container service
   */
  public addContainerRule(
    id: string,
    path: string,
    targetGroup: elbv2.ApplicationTargetGroup,
    priority: number
  ): elbv2.ApplicationListenerRule {
    return new elbv2.ApplicationListenerRule(this, `${id}Rule`, {
      listener: this.httpsListener,
      priority,
      conditions: [
        elbv2.ListenerCondition.pathPatterns([`${path}*`]),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
  }

  /**
   * Add a hostname-based listener rule for a container service
   */
  public addHostnameRule(
    id: string,
    hostname: string,
    targetGroup: elbv2.ApplicationTargetGroup,
    priority: number
  ): elbv2.ApplicationListenerRule {
    const fqdn = `${hostname}.${this.hostedZone.zoneName}`;
    return new elbv2.ApplicationListenerRule(this, `${id}Rule`, {
      listener: this.httpsListener,
      priority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([fqdn]),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
  }


}