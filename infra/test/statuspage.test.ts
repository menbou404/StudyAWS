import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App, ArnFormat, Environment } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { DatabaseStack } from '../lib/database-stack';
import { NetworkStack } from '../lib/network-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { RegistryStack } from '../lib/registry-stack';

const config = JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8'));
const allowedCidrs = ['203.0.113.10/32', '198.51.100.20/32'];
const appVersion = '0123456789abcdef0123456789abcdef01234567';

function createStacks(cidrs: string[] = [], env: Environment = { region: 'ap-southeast-2' }) {
  // 実行時と同じ feature flags を使い、アカウント情報や AWS lookup に依存させない。
  const app = new App({ context: config.context });
  const network = new NetworkStack(app, 'StatuspageNetwork', { env });
  const database = new DatabaseStack(app, 'StatuspageDatabase', {
    env,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
  });
  const application = new AppStack(app, 'StatuspageApp', {
    env,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    database: database.instance,
    allowedCidrs: cidrs,
    appVersion,
  });
  const registry = new RegistryStack(app, 'StatuspageRegistry', { env });
  const pipeline = new PipelineStack(app, 'StatuspagePipeline', { env, githubRepo: 'owner/repo' });
  return { app, network, database, application, registry, pipeline };
}

function singleResource(template: Template, type: string, properties: Record<string, unknown>) {
  const resources = Object.entries(template.findResources(type, { Properties: properties }));
  expect(resources).toHaveLength(1);
  const [id, resource] = resources[0];
  return { id, properties: resource.Properties };
}

function group(template: Template, description: string) {
  return singleResource(template, 'AWS::EC2::SecurityGroup', { GroupDescription: description });
}

function groupId(id: string) {
  return { 'Fn::GetAtt': [id, 'GroupId'] };
}

function ingressRules(template: Template) {
  const inline = Object.entries(template.findResources('AWS::EC2::SecurityGroup')).flatMap(
    ([id, resource]) => (resource.Properties.SecurityGroupIngress ?? []).map(
      (rule: Record<string, unknown>) => ({ GroupId: groupId(id), ...rule }),
    ),
  );
  const standalone = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress'))
    .map(resource => resource.Properties);
  return [...inline, ...standalone];
}

describe('Phase 5〜7 のスタック', () => {
  const stacks = createStacks(allowedCidrs);
  const assembly = stacks.app.synth();
  const network = Template.fromStack(stacks.network);
  const database = Template.fromStack(stacks.database);
  const application = Template.fromStack(stacks.application);

  test('アカウントが決まった5スタックもキャッシュなしでコンテキストを問い合わせない', () => {
    // App は cdk.context.json を直接読まないが、CLI 経由のキャッシュでも不具合を隠さない。
    const environment = jest.replaceProperty(process, 'env', {
      ...process.env,
      CDK_CONTEXT_JSON: '{}',
      CONTEXT_OVERFLOW_LOCATION_ENV: '',
    });
    try {
      const concreteStacks = createStacks([], {
        // 実在のアカウントではなく、CodeBuild と同じ環境確定時の挙動を再現するダミー。
        account: '123456789012',
        region: 'ap-southeast-2',
      });
      const concreteAssembly = concreteStacks.app.synth();
      expect(concreteAssembly.stacks).toHaveLength(5);
      expect(concreteAssembly.manifest.missing ?? []).toEqual([]);
    } finally {
      environment.restore();
    }
  });

  test('NetworkStack の AZ は Phase 5 で決めた2つに固定する', () => {
    expect(stacks.network.availabilityZones).toEqual(['ap-southeast-2a', 'ap-southeast-2b']);
  });

  test('VPC は2 AZ の public と isolated に分け、NAT を作らない', () => {
    network.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.1.0.0/16' });
    network.resourceCountIs('AWS::EC2::NatGateway', 0);
    network.resourceCountIs('AWS::EC2::Subnet', 4);
    const subnets = Object.values(network.findResources('AWS::EC2::Subnet'));
    expect(subnets.map(subnet => subnet.Properties.AvailabilityZone).sort()).toEqual([
      'ap-southeast-2a', 'ap-southeast-2a', 'ap-southeast-2b', 'ap-southeast-2b',
    ]);
    expect(subnets.every(subnet => subnet.Properties.CidrBlock.endsWith('/24'))).toBe(true);
    const publicSubnets = subnets.filter(subnet => subnet.Properties.MapPublicIpOnLaunch);
    expect(publicSubnets).toHaveLength(2);
    network.resourceCountIs('AWS::EC2::Route', 2);
    network.hasResourceProperties('Custom::VpcRestrictDefaultSG', {});
  });

  test('DB の SG は Network が所有し、受信も通常の送信も許可しない', () => {
    network.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    const dbSg = group(network, 'statuspage db');
    expect(ingressRules(network)).toEqual([]);
    expect(dbSg.properties.SecurityGroupEgress).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }),
    ]));
  });

  test('RDS は非公開の単一 AZ で PostgreSQL の復元元バージョンを引き継ぎ、削除時に保存する', () => {
    database.resourceCountIs('AWS::RDS::DBInstance', 1);
    database.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
      Properties: Match.objectLike({
        DBInstanceIdentifier: 'statuspage-db',
        DBSnapshotIdentifier: 'statuspage-db-phase4-final',
        DBInstanceClass: 'db.t4g.micro',
        Engine: 'postgres',
        EngineVersion: Match.absent(),
        AvailabilityZone: 'ap-southeast-2a',
        PubliclyAccessible: false,
        MultiAZ: false,
        StorageType: 'gp3',
        AllocatedStorage: '20',
        MaxAllocatedStorage: Match.absent(),
        BackupRetentionPeriod: 1,
        DeletionProtection: false,
        AutoMinorVersionUpgrade: true,
        VPCSecurityGroups: [stacks.database.resolve(stacks.network.dbSecurityGroup.securityGroupId)],
      }),
    });
    const subnetGroup = singleResource(database, 'AWS::RDS::DBSubnetGroup', {});
    expect(subnetGroup.properties.SubnetIds).toEqual(stacks.network.vpc.isolatedSubnets.map(
      subnet => stacks.database.resolve(subnet.subnetId),
    ));
    database.resourceCountIs('AWS::SecretsManager::Secret', 1);
    database.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: Match.absent(),
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: '{"username":"postgres"}' }),
    });
  });

  test('全スタックの SG は全世界からの受信を許可しない', () => {
    for (const template of [network, database, application]) {
      for (const rule of ingressRules(template)) {
        expect(rule.CidrIp).not.toBe('0.0.0.0/0');
        expect(rule.CidrIpv6).not.toBe('::/0');
      }
    }
  });

  test('ALB の SG は指定した CIDR の TCP 80 だけを許可する', () => {
    application.resourceCountIs('AWS::EC2::SecurityGroup', 3);
    const alb = group(application, 'statuspage alb');
    const rules = ingressRules(application).filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(groupId(alb.id)));
    expect(rules).toEqual(allowedCidrs.map(cidr => ({
      GroupId: groupId(alb.id),
      CidrIp: cidr,
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
      Description: 'allowed cidr',
    })));
  });

  test('CIDR を渡さない ALB と worker の SG は受信ルールがない', () => {
    const closedStacks = createStacks();
    const closed = Template.fromStack(closedStacks.application);
    for (const description of ['statuspage alb', 'statuspage worker']) {
      const sg = group(closed, description);
      expect(ingressRules(closed).filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(groupId(sg.id)))).toEqual([]);
    }
  });

  test('web は ALB の SG からの TCP 8000 だけ、web と worker の外向き通信は許可する', () => {
    const alb = group(application, 'statuspage alb');
    const web = group(application, 'statuspage web');
    expect(ingressRules(application).filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(groupId(web.id)))).toEqual([{
      GroupId: groupId(web.id),
      SourceSecurityGroupId: groupId(alb.id),
      IpProtocol: 'tcp',
      FromPort: 8000,
      ToPort: 8000,
      Description: 'from alb',
    }]);
    for (const description of ['statuspage web', 'statuspage worker']) {
      expect(group(application, description).properties.SecurityGroupEgress).toEqual([
        expect.objectContaining({ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }),
      ]);
    }
  });

  test('DB の受信は App 所有の web と worker からの TCP 5432 の2ルールだけ', () => {
    const dbId = stacks.application.resolve(stacks.network.dbSecurityGroup.securityGroupId);
    const rules = ingressRules(application).filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(dbId));
    expect(rules).toHaveLength(2);
    expect(rules).toEqual(expect.arrayContaining(['web', 'worker'].map(name => ({
      GroupId: dbId,
      SourceSecurityGroupId: groupId(group(application, `statuspage ${name}`).id),
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      Description: `from ${name}`,
    }))));
    expect(Object.keys(application.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: { FromPort: 5432 },
    }))).toHaveLength(2);
    database.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    expect(ingressRules(application).filter(rule => rule.FromPort === 5432)).toEqual(rules);
  });

  test('依存関係は App → Database・Network、Database → Network のみで Registry と Pipeline は独立する', () => {
    expect(stacks.network.dependencies).toEqual([]);
    expect(stacks.database.dependencies).toEqual([stacks.network]);
    expect(stacks.application.dependencies).toEqual(expect.arrayContaining([stacks.network, stacks.database]));
    expect(stacks.application.dependencies).toHaveLength(2);
    expect(stacks.registry.dependencies).toEqual([]);
    expect(stacks.pipeline.dependencies).toEqual([]);
    for (const stack of [stacks.registry, stacks.pipeline]) {
      expect(JSON.stringify(Template.fromStack(stack).toJSON())).not.toContain('Fn::ImportValue');
    }
    const pipelineArtifact = assembly.getStackArtifact(stacks.pipeline.artifactId);
    expect(pipelineArtifact.dependencies.filter(dependency => dependency.manifest.type === 'aws:cloudformation:stack')).toEqual([]);
    for (const stack of assembly.stacks) {
      expect(stack.environment.region).toBe('ap-southeast-2');
      if (stack.id !== stacks.pipeline.artifactId) {
        expect(stack.dependencies.map(dependency => dependency.id)).not.toContain(stacks.pipeline.artifactId);
      }
    }
  });

  test('ターゲットグループは浅いヘルスチェックと30秒の登録解除遅延を使う', () => {
    application.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    application.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Protocol: 'HTTP',
      Port: 8000,
      TargetType: 'ip',
      HealthCheckPath: '/healthz',
      HealthCheckIntervalSeconds: 10,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 2,
      Matcher: { HttpCode: '200' },
      TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }]),
    });
  });

  test('ALB は public サブネットを使い、HTTP 80 を api のターゲットへ転送する', () => {
    const alb = singleResource(application, 'AWS::ElasticLoadBalancingV2::LoadBalancer', {});
    expect(alb.properties).toMatchObject({
      Scheme: 'internet-facing',
      Type: 'application',
      SecurityGroups: [groupId(group(application, 'statuspage alb').id)],
      Subnets: stacks.network.vpc.publicSubnets.map(subnet => stacks.application.resolve(subnet.subnetId)),
    });
    const target = singleResource(application, 'AWS::ElasticLoadBalancingV2::TargetGroup', {});
    application.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    application.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      LoadBalancerArn: { Ref: alb.id },
      DefaultActions: [{ Type: 'forward', TargetGroupArn: { Ref: target.id } }],
    });
    application.hasOutput('AlbDnsName', { Value: { 'Fn::GetAtt': [alb.id, 'DNSName'] } });
  });

  test('App は ASG・起動テンプレート・NAT を作らず、Container Insights を無効にする', () => {
    for (const type of ['AWS::AutoScaling::AutoScalingGroup', 'AWS::EC2::LaunchTemplate', 'AWS::EC2::NatGateway']) {
      application.resourceCountIs(type, 0);
    }
    application.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
    });
  });

  test('タスク2つは小さい ARM Fargate で、秘密を値としてテンプレートへ残さない', () => {
    application.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    for (const name of ['api', 'worker']) {
      const task = singleResource(application, 'AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: name })]),
      }).properties;
      expect(task).toMatchObject({
        RequiresCompatibilities: ['FARGATE'], NetworkMode: 'awsvpc', Cpu: '256', Memory: '512',
        RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      });
      expect(task.ContainerDefinitions).toHaveLength(1);
      const container = task.ContainerDefinitions[0];
      expect(container.Name).toBe(name);
      const imageParts = container.Image['Fn::Join'];
      expect(imageParts[1].at(-1)).toBe(`/statuspage:${appVersion}`);
      expect(container.Environment).toEqual([
        { Name: 'APP_VERSION', Value: appVersion },
        { Name: 'DB_HOST', Value: stacks.application.resolve(stacks.database.instance.dbInstanceEndpointAddress) },
      ]);
      for (const forbidden of ['DB_PASSWORD', 'DATABASE_URL']) {
        expect(container.Environment.map((entry: { Name: string }) => entry.Name)).not.toContain(forbidden);
      }
      expect(container.Secrets).toEqual([{
        Name: 'DB_PASSWORD', ValueFrom: { 'Fn::GetAtt': [expect.any(String), 'ARN'] },
      }]);
      const lookupId = container.Secrets[0].ValueFrom['Fn::GetAtt'][0];
      const lookup = application.findResources('Custom::AWS')[lookupId];
      expect(JSON.parse(lookup.Properties.Create)).toMatchObject({
        service: 'SecretsManager', action: 'describeSecret', parameters: { SecretId: 'statuspage/db-app' },
        outputPaths: ['ARN'],
      });
      expect(JSON.parse(lookup.Properties.Update)).toMatchObject({ action: 'describeSecret' });
      expect(lookup.Properties.Delete).toBeUndefined();
      expect(container.LogConfiguration).toMatchObject({ LogDriver: 'awslogs' });
      const logId = container.LogConfiguration.Options['awslogs-group'].Ref;
      expect(application.findResources('AWS::Logs::LogGroup')[logId]).toBeDefined();
      if (name === 'api') {
        expect(container.PortMappings).toEqual([{ ContainerPort: 8000, Protocol: 'tcp' }]);
        expect(container.Command).toBeUndefined();
      } else {
        expect(container.Command).toEqual(['python', '-m', 'statuspage.worker']);
        expect(container.PortMappings).toBeUndefined();
      }
    }
  });

  test('api は2個を保って更新し、worker は古い1個を止めてから更新する', () => {
    application.resourceCountIs('AWS::ECS::Service', 2);
    const target = singleResource(application, 'AWS::ElasticLoadBalancingV2::TargetGroup', {});
    for (const [name, desired, minimum, maximum, sg] of [
      ['api', 2, 100, 200, 'web'], ['worker', 1, 0, 100, 'worker'],
    ] as const) {
      const task = singleResource(application, 'AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: name })]),
      });
      const service = singleResource(application, 'AWS::ECS::Service', { TaskDefinition: { Ref: task.id } }).properties;
      expect(service).toMatchObject({
        LaunchType: 'FARGATE', DesiredCount: desired,
        EnableExecuteCommand: false,
        DeploymentConfiguration: {
          MinimumHealthyPercent: minimum, MaximumPercent: maximum,
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        },
        NetworkConfiguration: { AwsvpcConfiguration: {
          AssignPublicIp: 'ENABLED',
          Subnets: stacks.network.vpc.publicSubnets.map(subnet => stacks.application.resolve(subnet.subnetId)),
          SecurityGroups: [groupId(group(application, `statuspage ${sg}`).id)],
        } },
      });
      if (name === 'api') {
        expect(service.HealthCheckGracePeriodSeconds).toBe(60);
        expect(service.LoadBalancers).toEqual([{
          ContainerName: 'api', ContainerPort: 8000, TargetGroupArn: { Ref: target.id },
        }]);
      } else {
        expect(service.LoadBalancers ?? []).toEqual([]);
        expect(service.HealthCheckGracePeriodSeconds).toBeUndefined();
      }
    }
  });

  test('秘密を読むのは実行ロールだけで、タスクロールは無権限に保つ', () => {
    application.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const roles = application.findResources('AWS::IAM::Role');
    const policies = Object.values(application.findResources('AWS::IAM::Policy'));
    const policiesFor = (id: string) => policies.filter(policy =>
      policy.Properties.Roles?.some((role: { Ref: string }) => role.Ref === id));
    const secretArn = stacks.application.resolve(stacks.application.formatArn({
      service: 'secretsmanager', resource: 'secret', resourceName: 'statuspage/db-app-??????',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    }));
    const executionIds: string[] = [];
    for (const task of Object.values(application.findResources('AWS::ECS::TaskDefinition'))) {
      const taskRoleId = task.Properties.TaskRoleArn['Fn::GetAtt'][0];
      expect(roles[taskRoleId].Properties.ManagedPolicyArns).toBeUndefined();
      expect(roles[taskRoleId].Properties.Policies).toBeUndefined();
      expect(policiesFor(taskRoleId)).toEqual([]);
      const executionId = task.Properties.ExecutionRoleArn['Fn::GetAtt'][0];
      executionIds.push(executionId);
      const secretStatements = policiesFor(executionId).flatMap(policy => policy.Properties.PolicyDocument.Statement)
        .filter(statement => [statement.Action].flat().some((action: string) => action.startsWith('secretsmanager:')));
      expect(secretStatements).toEqual([{
        Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn,
      }]);
    }
    expect(new Set(executionIds).size).toBe(2);
    for (const policy of policies) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        if ([statement.Action].flat().includes('secretsmanager:GetSecretValue')) {
          expect(policy.Properties.Roles.every((role: { Ref: string }) => executionIds.includes(role.Ref))).toBe(true);
        }
        if ([statement.Action].flat().includes('secretsmanager:DescribeSecret')) {
          expect(statement.Resource).toEqual(secretArn);
        }
      }
    }
  });

  test('ロググループ2つは1週間保存し、App と一緒に消す', () => {
    application.resourceCountIs('AWS::Logs::LogGroup', 2);
    for (const log of Object.values(application.findResources('AWS::Logs::LogGroup'))) {
      expect(log).toMatchObject({
        Properties: { RetentionInDays: 7 }, DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete',
      });
    }
  });

  test('Registry は不変タグとスキャンを使い、最新10個だけ残して削除時には空にする', () => {
    const registry = Template.fromStack(stacks.registry);
    registry.resourceCountIs('AWS::ECR::Repository', 1);
    const repository = Object.values(registry.findResources('AWS::ECR::Repository'))[0];
    expect(repository).toMatchObject({
      Properties: {
        RepositoryName: 'statuspage', ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true }, EmptyOnDelete: true,
      },
      DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete',
    });
    expect(JSON.parse(repository.Properties.LifecyclePolicy.LifecyclePolicyText)).toEqual({
      rules: [{
        rulePriority: 1,
        selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 },
        action: { type: 'expire' },
      }],
    });
  });
});
