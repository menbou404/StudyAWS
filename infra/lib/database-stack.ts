import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_rds as rds,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
}

export class DatabaseStack extends Stack {
  public readonly instance: rds.DatabaseInstanceFromSnapshot;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Phase 3 手順3：DB を外部から到達できないサブネットに限定する。
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      description: 'statuspage database subnets',
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    // Phase 3 手順4：最終スナップショットからアプリのデータと DB ユーザーを引き継ぐ。
    // マスター用の秘密は生成し、既存のアプリ用シークレットとは分離する。
    this.instance = new rds.DatabaseInstanceFromSnapshot(this, 'Instance', {
      snapshotIdentifier: 'statuspage-db-phase4-final',
      instanceIdentifier: 'statuspage-db',
      // Phase 3 手順4：復元元のバージョンを引き継ぎ、既定のマイナーへのダウングレード失敗を避ける。
      // CDK のバージョン未指定への注意は、新規作成時に意図しないバージョンになるリスクを指す。
      // スナップショット復元では元のバージョンが決まっているため、ここでは指定しない。
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      subnetGroup,
      securityGroups: [props.dbSecurityGroup],
      availabilityZone: 'ap-southeast-2a',
      credentials: rds.SnapshotCredentials.fromGeneratedSecret('postgres'),
      multiAz: false,
      publiclyAccessible: false,
      storageType: rds.StorageType.GP3,
      // Phase 3 手順4：既定の 100 GiB への拡張を避け、手動構築時の 20 GiB を維持する。
      // RDS のストレージは減らせないため容量を明示し、自動拡張用の maxAllocatedStorage も指定しない。
      allocatedStorage: 20,
      backupRetention: Duration.days(1),
      deletionProtection: false,
      autoMinorVersionUpgrade: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
  }
}
