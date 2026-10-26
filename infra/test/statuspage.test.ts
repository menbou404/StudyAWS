import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';
import { DatabaseStack } from '../lib/database-stack';
import { NetworkStack } from '../lib/network-stack';

const config = JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8'));
const allowedCidrs = ['203.0.113.10/32', '198.51.100.20/32'];

function createStacks(cidrs: string[] = []) {
  // 実行時と同じ feature flags を使い、アカウント情報や AWS lookup に依存させない。
  const app = new App({ context: config.context });
  const env = { region: 'ap-southeast-2' };
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
  });
  return { app, network, database, application };
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

function userDataScript(userData: { 'Fn::Base64': string }): string {
  // UserData.custom が元スクリプト以外の命令を暗黙に足していないことも確認する。
  expect(typeof userData['Fn::Base64']).toBe('string');
  return userData['Fn::Base64'];
}

describe('Phase 5 のスタック', () => {
  const stacks = createStacks(allowedCidrs);
  const assembly = stacks.app.synth();
  const network = Template.fromStack(stacks.network);
  const database = Template.fromStack(stacks.database);
  const application = Template.fromStack(stacks.application);

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

  test('web は ALB の SG からの TCP 80 だけ、web と worker の外向き通信は許可する', () => {
    const alb = group(application, 'statuspage alb');
    const web = group(application, 'statuspage web');
    expect(ingressRules(application).filter(rule => JSON.stringify(rule.GroupId) === JSON.stringify(groupId(web.id)))).toEqual([{
      GroupId: groupId(web.id),
      SourceSecurityGroupId: groupId(alb.id),
      IpProtocol: 'tcp',
      FromPort: 80,
      ToPort: 80,
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

  test('依存関係は App → Database・Network、Database → Network のみ', () => {
    expect(stacks.network.dependencies).toEqual([]);
    expect(stacks.database.dependencies).toEqual([stacks.network]);
    expect(stacks.application.dependencies).toEqual(expect.arrayContaining([stacks.network, stacks.database]));
    expect(stacks.application.dependencies).toHaveLength(2);
    for (const stack of assembly.stacks) {
      expect(stack.environment.region).toBe('ap-southeast-2');
    }
  });

  test('ターゲットグループは浅いヘルスチェックと30秒の登録解除遅延を使う', () => {
    application.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    application.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Protocol: 'HTTP',
      Port: 80,
      TargetType: 'instance',
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

  test('api は希望2・最小2・最大4で ELB チェック、worker は1台でターゲット登録なし', () => {
    application.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 2);
    const apiTemplate = singleResource(application, 'AWS::EC2::LaunchTemplate', { LaunchTemplateData: Match.objectLike({
      SecurityGroupIds: [groupId(group(application, 'statuspage web').id)],
    }) });
    const workerTemplate = singleResource(application, 'AWS::EC2::LaunchTemplate', { LaunchTemplateData: Match.objectLike({
      SecurityGroupIds: [groupId(group(application, 'statuspage worker').id)],
    }) });
    const target = singleResource(application, 'AWS::ElasticLoadBalancingV2::TargetGroup', {});
    const publicSubnets = stacks.network.vpc.publicSubnets.map(subnet => stacks.application.resolve(subnet.subnetId));
    application.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '2', MaxSize: '4', DesiredCapacity: '2',
      HealthCheckType: 'ELB', HealthCheckGracePeriod: 300,
      TargetGroupARNs: [{ Ref: target.id }],
      LaunchTemplate: Match.objectLike({ LaunchTemplateId: { Ref: apiTemplate.id } }),
      VPCZoneIdentifier: publicSubnets,
    });
    application.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '1', MaxSize: '1', DesiredCapacity: '1',
      HealthCheckType: 'EC2',
      TargetGroupARNs: Match.absent(),
      LoadBalancerNames: Match.absent(),
      LaunchTemplate: Match.objectLike({ LaunchTemplateId: { Ref: workerTemplate.id } }),
      VPCZoneIdentifier: publicSubnets,
    });
  });

  test('EC2 ロールは SSM と、既存のアプリ用シークレット・指定 DB への読み取りだけを持つ', () => {
    application.resourceCountIs('AWS::IAM::Role', 1);
    application.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({ Statement: [{
        Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' },
      }] }),
    });
    const role = singleResource(application, 'AWS::IAM::Role', {});
    expect(role.properties.ManagedPolicyArns).toHaveLength(1);
    expect(JSON.stringify(role.properties.ManagedPolicyArns)).toContain('policy/AmazonSSMManagedInstanceCore');
    application.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const policies = Object.values(application.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
    const secret = statements.find(statement => [statement.Action].flat().includes('secretsmanager:GetSecretValue'));
    expect(secret).toBeDefined();
    expect(JSON.stringify(secret.Resource)).toContain('statuspage/db-app');
    const rds = statements.find(statement => [statement.Action].flat().includes('rds:DescribeDBInstances'));
    expect(rds).toBeDefined();
    expect(rds.Resource).toEqual(stacks.application.resolve(stacks.database.instance.instanceArn));
    for (const statement of statements) {
      expect([statement.Resource].flat()).not.toContain('*');
      expect([statement.Action].flat()).not.toContain('*');
      expect(statement.Effect).toBe('Allow');
    }
    expect(statements).toHaveLength(2);
  });

  test('起動テンプレートは Arm の t4g.micro と IMDSv2 を使い、ROLE だけが異なる', () => {
    application.resourceCountIs('AWS::EC2::LaunchTemplate', 2);
    const source = readFileSync(path.join(__dirname, '../../deploy/ec2/user-data.sh'), 'utf8');
    for (const [role, description] of [['api', 'statuspage web'], ['worker', 'statuspage worker']] as const) {
      const template = singleResource(application, 'AWS::EC2::LaunchTemplate', { LaunchTemplateData: Match.objectLike({
        SecurityGroupIds: [groupId(group(application, description).id)],
      }) });
      expect(template.properties.LaunchTemplateData).toMatchObject({
        InstanceType: 't4g.micro', MetadataOptions: { HttpTokens: 'required' },
      });
      expect(template.properties.LaunchTemplateData.KeyName).toBeUndefined();
      const script = userDataScript(template.properties.LaunchTemplateData.UserData);
      expect(script).toContain(`ROLE="${role}"`);
      expect(script).not.toContain(`ROLE="${role === 'api' ? 'worker' : 'api'}"`);
      expect(script).toBe(role === 'api' ? source : source.replace('ROLE="api"', 'ROLE="worker"'));
    }
    const parameters = Object.values(application.toJSON().Parameters) as { Type: string; Default?: string }[];
    expect(parameters).toEqual(expect.arrayContaining([expect.objectContaining({
      Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
      Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
    })]));
  });
});
