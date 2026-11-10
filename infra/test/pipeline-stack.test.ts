import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

const config = JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8'));

describe('CodePipeline と CodeBuild のデプロイ基盤', () => {
  const app = new App({ context: config.context });
  const stack = new PipelineStack(app, 'StatuspagePipeline', {
    env: { region: 'ap-southeast-2' },
    githubRepo: 'example/StudyAWS',
  });
  const template = Template.fromStack(stack);

  function pipeline(name: string) {
    const resources = Object.values(template.findResources('AWS::CodePipeline::Pipeline', { Properties: { Name: name } }));
    expect(resources).toHaveLength(1);
    return resources[0].Properties;
  }

  function project(file: string) {
    const resources = Object.values(template.findResources('AWS::CodeBuild::Project', {
      Properties: { Source: { BuildSpec: `deploy/codebuild/${file}.yml`, Type: 'CODEPIPELINE' } },
    }));
    expect(resources).toHaveLength(1);
    return resources[0].Properties;
  }

  function statements(file: string) {
    const roleId = project(file).ServiceRole['Fn::GetAtt'][0];
    const role = template.findResources('AWS::IAM::Role')[roleId].Properties;
    expect(role.ManagedPolicyArns).toBeUndefined();
    expect(role.Policies).toBeUndefined();
    expect(role.AssumeRolePolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'codebuild.amazonaws.com' },
    }]);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter(policy => policy.Properties.Roles?.some((ref: { Ref: string }) => ref.Ref === roleId));
    return policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
  }

  test('通常のパイプラインは V2・QUEUED で Source → Test → Deploy の順に進む', () => {
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 2);
    const props = pipeline('statuspage');
    expect(props).toMatchObject({
      PipelineType: 'V2', ExecutionMode: 'QUEUED', RestartExecutionOnUpdate: false,
      Variables: [{ Name: 'CREATE_APP', DefaultValue: 'false', Description: expect.any(String) }],
    });
    expect(props.Stages.map((stage: { Name: string }) => stage.Name)).toEqual(['Source', 'Test', 'Deploy']);
    const source = props.Stages[0].Actions[0];
    expect(source).toMatchObject({
      Namespace: 'SourceVariables',
      ActionTypeId: { Category: 'Source', Owner: 'AWS', Provider: 'CodeStarSourceConnection', Version: '1' },
      Configuration: { FullRepositoryId: 'example/StudyAWS', BranchName: 'main' },
    });
    expect(props.Triggers).toEqual([{
      ProviderType: 'CodeStarSourceConnection',
      GitConfiguration: {
        SourceActionName: source.Name,
        Push: [{ Branches: { Includes: ['main'] }, FilePaths: { Includes: ['app/**', 'infra/**', 'deploy/**'] } }],
      },
    }]);
    const deploy = props.Stages[2].Actions[0];
    expect(JSON.parse(deploy.Configuration.EnvironmentVariables)).toEqual([
      { name: 'APP_VERSION', value: '#{SourceVariables.CommitId}', type: 'PLAINTEXT' },
      { name: 'CREATE_APP', value: '#{variables.CREATE_APP}', type: 'PLAINTEXT' },
    ]);
    // どの段にも同じソースを渡し、テストしたコードとデプロイするコードをそろえる。
    for (const [index, file] of [[1, 'test'], [2, 'deploy']] as const) {
      const action = props.Stages[index].Actions[0];
      expect(action.ActionTypeId.Provider).toBe('CodeBuild');
      expect(action.InputArtifacts).toEqual(source.OutputArtifacts);
      const projectId = action.Configuration.ProjectName.Ref;
      expect(template.findResources('AWS::CodeBuild::Project')[projectId].Properties).toEqual(project(file));
    }
  });

  test('削除用は Source → Destroy で、作成時の自動実行では削除しないよう確認変数を渡す', () => {
    const props = pipeline('statuspage-destroy');
    expect(props).toMatchObject({ PipelineType: 'V2', ExecutionMode: 'QUEUED', RestartExecutionOnUpdate: false });
    expect(props.Stages.map((stage: { Name: string }) => stage.Name)).toEqual(['Source', 'Destroy']);
    expect(props.Triggers).toBeUndefined();
    expect(props.Variables).toEqual([{
      Name: 'CONFIRM_DESTROY', DefaultValue: 'false',
      Description: 'StatuspageApp を消すときだけ true を指定する',
    }]);
    const source = props.Stages[0].Actions[0];
    expect(source.Configuration).toMatchObject({ FullRepositoryId: 'example/StudyAWS', BranchName: 'main', DetectChanges: false });
    const action = props.Stages[1].Actions[0];
    expect(action.ActionTypeId.Provider).toBe('CodeBuild');
    expect(JSON.parse(action.Configuration.EnvironmentVariables)).toEqual([
      { name: 'CONFIRM_DESTROY', value: '#{variables.CONFIRM_DESTROY}', type: 'PLAINTEXT' },
    ]);
    expect(action.InputArtifacts).toEqual(source.OutputArtifacts);
    expect(template.findResources('AWS::CodeBuild::Project')[action.Configuration.ProjectName.Ref].Properties).toEqual(project('destroy'));
  });

  test('接続 ARN は SSM の CloudFormation パラメータから受け取り、接続や OIDC は作らない', () => {
    const parameters = Object.entries(template.toJSON().Parameters)
      .filter(([, value]) => (value as { Default?: string }).Default === '/statuspage/github-connection-arn');
    expect(parameters).toHaveLength(1);
    const [parameterId, parameter] = parameters[0];
    expect(parameter).toEqual({ Type: 'AWS::SSM::Parameter::Value<String>', Default: '/statuspage/github-connection-arn' });
    for (const name of ['statuspage', 'statuspage-destroy']) {
      expect(pipeline(name).Stages[0].Actions[0].Configuration.ConnectionArn).toEqual({ Ref: parameterId });
    }
    expect(JSON.stringify(template.toJSON())).not.toMatch(/arn:[^"\s]*:(?:codestar-connections|codeconnections):/);
    template.resourceCountIs('AWS::CodeStarConnections::Connection', 0);
    template.resourceCountIs('AWS::CodeConnections::Connection', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.resourceCountIs('AWS::SSM::Parameter', 0);
  });

  test('3つのビルドは ARM・SMALL を使い、ログは1週間で消す', () => {
    template.resourceCountIs('AWS::CodeBuild::Project', 3);
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    for (const file of ['test', 'deploy', 'destroy']) {
      const props = project(file);
      expect(props.Name).toBeUndefined();
      expect(props.Environment).toMatchObject({
        Type: 'ARM_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL',
        Image: 'aws/codebuild/amazonlinux-aarch64-standard:4.0', PrivilegedMode: false,
      });
      const logging = props.LogsConfig.CloudWatchLogs;
      expect(logging.Status).toBe('ENABLED');
      expect(template.findResources('AWS::Logs::LogGroup')[logging.GroupName.Ref]).toMatchObject({
        Properties: { RetentionInDays: 7 }, DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete',
      });
    }
    expect(project('deploy').TimeoutInMinutes).toBe(60);
    expect(project('destroy').TimeoutInMinutes).toBe(60);
  });

  test('ビルドの追加権限は deploy の3文と destroy のロール引き受けだけ', () => {
    const bootstrap = {
      Sid: 'UseCdkBootstrapRoles', Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession'],
      Resource: stack.resolve(stack.formatArn({
        service: 'iam', region: '', resource: 'role',
        resourceName: `cdk-hnb659fds-*-${stack.account}-ap-southeast-2`,
      })),
    };
    const expected = {
      test: [],
      deploy: [bootstrap, {
        Sid: 'CheckAppStack', Effect: 'Allow', Action: 'cloudformation:DescribeStacks',
        Resource: stack.resolve(stack.formatArn({
          service: 'cloudformation', region: 'ap-southeast-2', resource: 'stack', resourceName: 'StatuspageApp/*',
        })),
      }, {
        Sid: 'ReadAllowedCidrs', Effect: 'Allow', Action: 'ssm:GetParameters',
        Resource: stack.resolve(stack.formatArn({
          service: 'ssm', region: 'ap-southeast-2', resource: 'parameter', resourceName: 'statuspage/allowed-cidrs',
        })),
      }],
      destroy: [bootstrap],
    };
    for (const file of ['test', 'deploy', 'destroy'] as const) {
      // CDK が自動で付けるログと受け渡し用 S3 だけを除き、残りは完全一致で確かめる。
      const added = statements(file).filter(statement =>
        ![statement.Action].flat().every((action: string) => /^(logs|s3):/.test(action)));
      expect(added).toEqual(expected[file]);
    }
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  });

  test('共有バケットは非公開・SSL 強制・S3 暗号化・30日で削除し、スタック削除時に残さない', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    const [[bucketId, bucket]] = Object.entries(template.findResources('AWS::S3::Bucket'));
    expect(bucket).toMatchObject({
      DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
        },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        LifecycleConfiguration: { Rules: [{ Status: 'Enabled', ExpirationInDays: 30 }] },
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: bucketId },
      PolicyDocument: { Statement: Match.arrayWith([{
        Effect: 'Deny', Action: 's3:*', Principal: { AWS: '*' },
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        Resource: [
          { 'Fn::GetAtt': [bucketId, 'Arn'] },
          { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, '/*']] },
        ],
      }]) },
    });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    for (const name of ['statuspage', 'statuspage-destroy']) {
      expect(pipeline(name).ArtifactStore).toEqual({ Type: 'S3', Location: { Ref: bucketId } });
    }
  });

  test('ほかのスタックへの依存とテンプレートの ImportValue を持たない', () => {
    expect(stack.dependencies).toEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toContain('Fn::ImportValue');
  });
});

test.each(['', 'owner', '/repo', 'owner/', 'owner/repo/extra', 'owner name/repo', 'owner/repo name', 'owner/.', 'owner/..'])
  ('githubRepo の不正な形 %p を日本語で拒否する', githubRepo => {
    expect(() => new PipelineStack(new App(), 'Invalid', { githubRepo })).toThrow('githubRepo は owner/repo の形で指定してください');
  });
