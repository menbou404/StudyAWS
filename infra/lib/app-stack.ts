import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  custom_resources as cr,
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

    // Phase 4 手順2・Phase 7 手順4：入口の制限を App に閉じ込め、直接の利用でも /0 を拒否する。
    const allowedCidrs = parseAllowedCidrs(props.allowedCidrs.join(','));
    const appVersion = parseAppVersion(props.appVersion);
    const albSg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage alb',
    });
    for (const cidr of allowedCidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), 'allowed cidr');
    }

    // Phase 7 手順4：手動タスクの入口を ALB に絞り、nginx を通さず api の8000番へ送る。
    const webSg = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage web',
      allowAllOutbound: true,
    });
    webSg.addIngressRule(albSg, ec2.Port.tcp(8000), 'from alb');

    // Phase 7 手順4：worker は受信不要だが、ECR・ログ・監視対象への送信は必要。
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: props.vpc,
      description: 'statuspage worker',
      allowAllOutbound: true,
    });

    // Phase 7 手順4-2：L1 のルールを App に所有させ、片付けで DB の受信も閉じる。
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

    // Phase 7 手順4-3：EC2 の管理をせず、Fargate にタスクの配置を任せる。
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    // Phase 7 手順3-5・手順4-8：タスクを止めても調査できるよう、ログは1週間残す。
    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const workerLogs = new logs.LogGroup(this, 'WorkerLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Phase 7 手順3-1：名前参照の部分 ARN を ECS に渡さず、デプロイ時に完全 ARN を調べる。
    // synth の lookup や秘密の値の取得は不要。参照用 Lambda のログも api と同じ寿命で片付ける。
    const secretArn = this.formatArn({
      service: 'secretsmanager', resource: 'secret', resourceName: 'statuspage/db-app-??????',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const secretLookup = new cr.AwsCustomResource(this, 'AppSecretArn', {
      onUpdate: {
        service: 'SecretsManager',
        action: 'describeSecret',
        parameters: { SecretId: 'statuspage/db-app' },
        physicalResourceId: cr.PhysicalResourceId.of('statuspage/db-app'),
        outputPaths: ['ARN'],
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret'],
        resources: [secretArn],
      })]),
      installLatestAwsSdk: false,
      logGroup: apiLogs,
    });
    // Phase 7 手順3-6：値を読むのは ECS の実行ロールだけ。アプリのタスクロールは無権限にする。
    const dbPassword: ecs.Secret = {
      arn: secretLookup.getResponseField('ARN'),
      grantRead: grantee => iam.Grant.addToPrincipal({
        grantee,
        actions: ['secretsmanager:GetSecretValue'],
        resourceArns: [secretArn],
      }),
    };

    // Phase 7 手順2・3：Registry とは名前で参照し、毎日の App 削除と ECR の寿命を分ける。
    const repository = ecr.Repository.fromRepositoryName(this, 'Repository', 'statuspage');
    // main は synth・テスト専用であり、実際のビルドはコミット SHA のタグだけを作る。
    const image = ecs.ContainerImage.fromEcrRepository(repository, appVersion);
    const createTask = (name: 'api' | 'worker', logGroup: logs.ILogGroup): ecs.FargateTaskDefinition => {
      // Phase 7 手順3-2：手元と CodeBuild と同じ ARM64 にそろえ、小さいタスクで学習費用を抑える。
      const task = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      // Phase 7 手順3-3〜5：同じイメージを使い、秘密だけを起動時に ECS から渡す。
      task.addContainer(name, {
        containerName: name,
        image,
        environment: { APP_VERSION: appVersion, DB_HOST: props.database.dbInstanceEndpointAddress },
        secrets: { DB_PASSWORD: dbPassword },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name }),
        ...(name === 'api'
          ? { portMappings: [{ containerPort: 8000 }] }
          : { command: ['python', '-m', 'statuspage.worker'] }),
      });
      return task;
    };
    const apiTask = createTask('api', apiLogs);
    const workerTask = createTask('worker', workerLogs);

    // Phase 7 手順5：api は2個を維持してから入れ替え、起動失敗が続いたら前の版へ戻す。
    // 手順4と同じ public IP で ECR へ出るため、NAT は増やさない。
    const api = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 2,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [webSg],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
      enableExecuteCommand: false,
    });

    // Phase 4 手順5・Phase 7 手順5：DB 障害で交換し続けないよう浅いチェックを使い、IP で登録する。
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc: props.vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: 8000,
      targetType: elbv2.TargetType.IP,
      targets: [api.loadBalancerTarget({ containerName: 'api', containerPort: 8000 })],
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

    // Phase 4 手順6・Phase 7 手順5：タスクの IP が変わっても、利用者の入口は ALB に保つ。
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });
    alb.addListener('HttpListener', { port: 80, open: false, defaultTargetGroups: [targetGroup] });

    // Phase 7 手順5：監視の二重実行を避け、古い1個を止めてから新しい1個を起動する。
    new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [workerSg],
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: false,
    });

    // Phase 4 手順9・Phase 7 手順5：作り直すたびに変わる入口を、物理名を固定せずに確認する。
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
  }
}
