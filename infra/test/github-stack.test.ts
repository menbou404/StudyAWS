import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GithubStack } from '../lib/github-stack';

const config = JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8'));

describe('GitHub Actions の認証基盤', () => {
  const app = new App({ context: config.context });
  const stack = new GithubStack(app, 'StatuspageGithub', {
    env: { region: 'ap-southeast-2' },
    githubRepo: 'example/StudyAWS',
  });
  const template = Template.fromStack(stack);

  test('OIDC はネイティブのプロバイダーだけを作り、サムプリントを固定しない', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
      ThumbprintList: Match.absent(),
    });
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });

  test('固定名のロールを、指定リポジトリの環境 aws に完全一致で限定する', () => {
    template.resourceCountIs('AWS::IAM::Role', 1);
    const providerId = Object.keys(template.findResources('AWS::IAM::OIDCProvider'))[0];
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'statuspage-github-deploy',
      ManagedPolicyArns: Match.absent(),
      Policies: Match.absent(),
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: providerId } },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': 'repo:example/StudyAWS:environment:aws',
            },
          },
        }],
      },
    });
  });

  test('許可はブートストラップロールの引き受けと App の存在確認の2文だけ', () => {
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(policy => policy.Properties.PolicyDocument.Statement);
    expect(statements).toEqual([
      {
        Sid: 'UseCdkBootstrapRoles', Effect: 'Allow',
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Resource: stack.resolve(stack.formatArn({
          service: 'iam', region: '', resource: 'role',
          resourceName: `cdk-hnb659fds-*-${stack.account}-ap-southeast-2`,
        })),
      },
      {
        Sid: 'CheckAppStack', Effect: 'Allow', Action: 'cloudformation:DescribeStacks',
        Resource: stack.resolve(stack.formatArn({
          service: 'cloudformation', region: 'ap-southeast-2',
          resource: 'stack', resourceName: 'StatuspageApp/*',
        })),
      },
    ]);
    const roleId = Object.keys(template.findResources('AWS::IAM::Role'))[0];
    expect(policies[0].Properties.Roles).toEqual([{ Ref: roleId }]);
    template.hasOutput('DeployRoleArn', { Value: { 'Fn::GetAtt': [roleId, 'Arn'] } });
  });
});
