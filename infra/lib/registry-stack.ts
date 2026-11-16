import { RemovalPolicy, Stack, StackProps, aws_ecr as ecr } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class RegistryStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Phase 7 手順2：同じ SHA の中身を上書きさせず、App の片付けでもイメージを残す。
    // 名前は App と Pipeline が参照するため固定し、古いイメージで費用が増え続けるのを防ぐ。
    new ecr.Repository(this, 'Repository', {
      repositoryName: 'statuspage',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
