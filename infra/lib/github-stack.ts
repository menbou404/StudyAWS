import { CfnOutput, Stack, StackProps, aws_iam as iam } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface GithubStackProps extends StackProps {
  readonly githubRepo: string;
}

export class GithubStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubStackProps) {
    super(scope, id, props);

    // Phase 6 手順3：ネイティブのプロバイダーで GitHub のトークンを信頼し、サムプリントの取得は IAM に任せる。
    const provider = new iam.OidcProviderNative(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // Phase 6 手順4-1・4-2：環境 aws のジョブだけに絞り、ブランチの制限は GitHub の環境設定に任せる。
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'statuspage-github-deploy',
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:environment:aws`,
        },
      }),
    });

    // Phase 6 手順4-3：直接リソースを操作せず、Phase 5 のブートストラップロールに作業を任せる。
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'UseCdkBootstrapRoles',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.formatArn({
        service: 'iam', region: '', resource: 'role',
        resourceName: `cdk-hnb659fds-*-${this.account}-ap-southeast-2`,
      })],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CheckAppStack',
      actions: ['cloudformation:DescribeStacks'],
      resources: [this.formatArn({
        service: 'cloudformation', region: 'ap-southeast-2',
        resource: 'stack', resourceName: 'StatuspageApp/*',
      })],
    }));

    // Phase 6 手順4-3：環境のシークレット AWS_ROLE_ARN に登録する値を確認できるようにする。
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
