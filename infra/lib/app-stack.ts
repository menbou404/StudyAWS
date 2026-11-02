import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  CfnOutput,
  Duration,
  Lazy,
  Stack,
  StackProps,
  aws_autoscaling as autoscaling,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { parseAllowedCidrs } from './allowed-cidrs';
import { parseAppVersion } from './app-version';

export interface AppStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  readonly database: rds.IDatabaseInstance;
  readonly allowedCidrs: string[];
  readonly appVersion: string;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // Phase 4 手順2：許可 IP の変更は App に閉じ込める。直接のスタック利用でも /0 を拒否する。
    const allowedCidrs = parseAllowedCidrs(props.allowedCidrs.join(','));
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage alb',
    });
    for (const cidr of allowedCidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'allowed cidr');
    }

    // Phase 4 手順2：api の入口を ALB に絞る。外向き通信は起動時の導入と SSM に必要。
    const webSg = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage web',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(albSg, ec2.Port.tcp(80), 'from alb');

    // Phase 4 手順2：worker は受信不要だが、監視対象や SSM への送信は必要。
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage worker',
      allowAllOutbound: true,
    });

    // Phase 3 手順2・Phase 4 手順2：L1 のルールを App に所有させる。
    // DB の SG を変更する L2 API では Network → App の参照が生じるため、循環を避ける。
    for (const [name, source] of [['web', webSg], ['worker', workerSg]] as const) {
      new ec2.CfnSecurityGroupIngress(this, `DatabaseFrom${name}`, {
        groupId: props.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId: source.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        description: `from ${name}`,
      });
    }

    // Phase 2 手順2・Phase 3 手順6・Phase 4 手順3：鍵を配らず SSM で管理し、
    // 起動スクリプトが読むアプリ用シークレットと DB だけに権限を限定する。
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const appSecret = secretsmanager.Secret.fromSecretNameV2(this, 'AppSecret', 'statuspage/db-app');
    appSecret.grantRead(role);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['rds:DescribeDBInstances'],
      resources: [props.database.instanceArn],
    }));
    // Phase 6：起動結果の通知だけを自分のスタックに許可し、ほかのスタックへの通知を防ぐ。
    // ASG の signals も同じスタックの AWS::StackId を自動追加するが、通知先の範囲は広がらない。
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:SignalResource'],
      resources: [this.formatArn({
        service: 'cloudformation', resource: 'stack', resourceName: `${this.stackName}/*`,
      })],
    }));

    // Phase 4 手順4：Phase 2 の構築スクリプトを共有し、複製による修正漏れを避ける。
    const source = readFileSync(path.join(__dirname, '../../deploy/ec2/user-data.sh'), 'utf8');
    for (const marker of ['ROLE="api"', 'APP_VERSION="main"', 'CFN_STACK=""', 'CFN_RESOURCE=""']) {
      if (source.split(marker).length !== 2) {
        throw new Error(`user-data.sh の ${marker} はちょうど1か所必要です`);
      }
    }
    const appVersion = parseAppVersion(props.appVersion);
    const scriptFor = (roleName: 'api' | 'worker', asg: autoscaling.AutoScalingGroup): string => source
      .replace('ROLE="api"', `ROLE="${roleName}"`)
      .replace('APP_VERSION="main"', `APP_VERSION="${appVersion}"`)
      .replace('CFN_STACK=""', `CFN_STACK="${this.stackName}"`)
      // 論理 ID は単なる文字列にし、起動テンプレート → ASG の参照による循環を避ける。
      .replace('CFN_RESOURCE=""', `CFN_RESOURCE="${this.getLogicalId(asg.node.defaultChild as autoscaling.CfnAutoScalingGroup)}"`);

    // Phase 4 手順4：Arm の AMI とインスタンスを揃え、SSM 公開パラメータ参照で lookup を避ける。
    // latestAmazonLinux2023 は kernel を上書きするため、直接クラスを使って手動構築時の標準カーネルに揃える。
    const machineImage = new ec2.AmazonLinux2023ImageSsmParameter({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      kernel: ec2.AmazonLinux2023Kernel.DEFAULT,
      cachedInContext: false,
    });
    const apiTemplate = new ec2.LaunchTemplate(this, 'ApiLaunchTemplate', {
      machineImage,
      instanceType: new ec2.InstanceType('t4g.micro'),
      role,
      securityGroup: webSg,
      // ASG が起動テンプレートを必要とするため、ASG 作成後の synth 時にスクリプトを解決する。
      userData: ec2.UserData.custom(Lazy.string({ produce: () => scriptFor('api', apiAsg) })),
      requireImdsv2: true,
    });
    const workerTemplate = new ec2.LaunchTemplate(this, 'WorkerLaunchTemplate', {
      machineImage,
      instanceType: new ec2.InstanceType('t4g.micro'),
      role,
      securityGroup: workerSg,
      userData: ec2.UserData.custom(Lazy.string({ produce: () => scriptFor('worker', workerAsg) })),
      requireImdsv2: true,
    });

    // Phase 4 手順5：DB 障害で api を入れ替え続けないよう、浅い /healthz を確認する。
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc: props.vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 80,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/healthz',
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // Phase 4 手順6：公開サブネットで受けるが、リスナーの自動的な全世界公開は無効にする。
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });
    alb.addListener('HttpListener', {
      port: 80,
      open: false,
      defaultTargetGroups: [targetGroup],
    });

    // Phase 4 手順7：2 AZ に api を保ち、EC2 と ALB のどちらの異常でも交換する。
    // 起動スクリプトの導入時間を見込み、ヘルスチェックには5分の猶予を与える。
    const apiAsg = new autoscaling.AutoScalingGroup(this, 'ApiAutoScalingGroup', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate: apiTemplate,
      minCapacity: 2,
      maxCapacity: 4,
      desiredCapacity: 2,
      // Phase 6：初回も2台の起動完了を待ち、10分以内にそろわなければ失敗させる。
      signals: autoscaling.Signals.waitForMinCapacity({ timeout: Duration.minutes(10) }),
      // API を2台稼働させたまま1台ずつ交換し、起動通知が失敗ならロールバックさせる。
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 2,
        waitOnResourceSignals: true,
        pauseTime: Duration.minutes(10),
      }),
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: Duration.seconds(300),
      }),
    });
    apiAsg.attachToApplicationTargetGroup(targetGroup);

    // Phase 4 手順8：監視の二重実行を避けて1台を維持する。HTTP を受けないので ALB に登録しない。
    const workerAsg = new autoscaling.AutoScalingGroup(this, 'WorkerAutoScalingGroup', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      launchTemplate: workerTemplate,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      // Phase 6：監視ジョブも起動成功の通知を待ち、導入中の失敗を見逃さない。
      signals: autoscaling.Signals.waitForMinCapacity({ timeout: Duration.minutes(10) }),
      // MaxSize 1 より小さい0を指定し、二重実行を避けて古い1台を止めてから交換する。
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
        waitOnResourceSignals: true,
        pauseTime: Duration.minutes(10),
      }),
      healthChecks: autoscaling.HealthChecks.ec2(),
    });

    // Phase 4 手順9：作り直すたびに変わる入口を、固定名を付けずに確認できるようにする。
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
  }
}
