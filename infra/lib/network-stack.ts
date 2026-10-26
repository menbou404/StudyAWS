import { Stack, StackProps, aws_ec2 as ec2 } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Phase 2 手順1・Phase 3 手順1・Phase 4 手順1：手動 VPC と区別し、
    // DB は外部通信不要のサブネットに置く。AZ を固定して認証なしで synth できるようにする。
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.1.0.0/16'),
      availabilityZones: ['ap-southeast-2a', 'ap-southeast-2b'],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });

    // Phase 3 手順2：App がない間は DB に入れない。受信ルールの寿命は App 側で管理する。
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc: this.vpc,
      description: 'statuspage db',
      allowAllOutbound: false,
    });
  }
}
