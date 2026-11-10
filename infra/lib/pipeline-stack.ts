import {
  Duration, RemovalPolicy, Stack, StackProps,
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as actions,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface PipelineStackProps extends StackProps {
  readonly githubRepo: string;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    if (typeof props.githubRepo !== 'string'
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(props.githubRepo)
      || ['.', '..'].includes(props.githubRepo.split('/')[1])) {
      throw new Error('githubRepo は owner/repo の形で指定してください');
    }
    const [owner, repo] = props.githubRepo.split('/');

    // Phase 6 手順5-1：接続は手順3のものを使う。GitHub での許可は画面で行う必要があるためコード化しない。
    const connectionArn = ssm.StringParameter.valueForStringParameter(this, '/statuspage/github-connection-arn');

    // Phase 6 手順5-1：ステージ間の受け渡し用。古いファイルや片付け後のバケットを残さない。
    const artifactBucket = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Phase 6 手順5-2：EC2 と同じ ARM で実行し、ビルドのログは1週間だけ保管する。
    const environment: codebuild.BuildEnvironment = {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_4_0,
      computeType: codebuild.ComputeType.SMALL,
    };
    const createProject = (projectId: string, file: string, timeout?: Duration): codebuild.PipelineProject => {
      const logGroup = new logs.LogGroup(this, `${projectId}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new codebuild.PipelineProject(this, projectId, {
        environment,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`deploy/codebuild/${file}.yml`),
        timeout,
        logging: { cloudWatch: { logGroup } },
        // レポート機能は使わないため、その自動付与の権限も不要。
        grantReportGroupPermissions: false,
      });
    };
    const test = createProject('Test', 'test');
    const deploy = createProject('Deploy', 'deploy', Duration.minutes(60));
    const destroy = createProject('Destroy', 'destroy', Duration.minutes(60));

    // Phase 6 手順5-3：AWS のリソースを直接操作せず、Phase 5 の CDK ロールに作業を任せる。
    const bootstrapRoleArn = this.formatArn({
      service: 'iam', region: '', resource: 'role',
      resourceName: `cdk-hnb659fds-*-${this.account}-ap-southeast-2`,
    });
    for (const project of [deploy, destroy]) {
      project.addToRolePolicy(new iam.PolicyStatement({
        sid: 'UseCdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [bootstrapRoleArn],
      }));
    }
    deploy.addToRolePolicy(new iam.PolicyStatement({
      sid: 'CheckAppStack',
      actions: ['cloudformation:DescribeStacks'],
      resources: [this.formatArn({
        service: 'cloudformation', region: 'ap-southeast-2',
        resource: 'stack', resourceName: 'StatuspageApp/*',
      })],
    }));
    deploy.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadAllowedCidrs',
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({
        service: 'ssm', region: 'ap-southeast-2',
        resource: 'parameter', resourceName: 'statuspage/allowed-cidrs',
      })],
    }));

    // Phase 6 手順5-1：main のコミットを1回だけ取得し、テストとデプロイに同じソースを渡す。
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const source = new actions.CodeStarConnectionsSourceAction({
      actionName: 'Source', connectionArn, owner, repo, branch: 'main',
      output: sourceOutput, variablesNamespace: 'SourceVariables',
    });
    const createApp = new codepipeline.Variable({
      variableName: 'CREATE_APP', defaultValue: 'false',
      description: 'StatuspageApp がないときに作成する場合だけ true を指定する',
    });
    // Phase 6 手順5-1：人がコンソールで探す名前だけ固定し、更新を来た順に処理する。
    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'statuspage',
      artifactBucket,
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
      restartExecutionOnUpdate: false,
      variables: [createApp],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: {
          sourceAction: source,
          pushFilter: [{ branchesIncludes: ['main'], filePathsIncludes: ['app/**', 'infra/**', 'deploy/**'] }],
        },
      }],
      stages: [
        { stageName: 'Source', actions: [source] },
        // 手順5の手作業にテストの段を足し、失敗したコミットがデプロイへ進むのを防ぐ。
        { stageName: 'Test', actions: [new actions.CodeBuildAction({ actionName: 'Test', project: test, input: sourceOutput })] },
        { stageName: 'Deploy', actions: [new actions.CodeBuildAction({
          actionName: 'Deploy', project: deploy, input: sourceOutput,
          environmentVariables: {
            APP_VERSION: { value: source.variables.commitId },
            CREATE_APP: { value: createApp.reference() },
          },
        })] },
      ],
    });

    // Phase 6 手順5を片付け用にも使う。作成時にも自動実行されるため、削除には明示的な確認を求める。
    const destroyOutput = new codepipeline.Artifact('DestroySourceOutput');
    const confirmDestroy = new codepipeline.Variable({
      variableName: 'CONFIRM_DESTROY', defaultValue: 'false',
      description: 'StatuspageApp を消すときだけ true を指定する',
    });
    new codepipeline.Pipeline(this, 'DestroyPipeline', {
      pipelineName: 'statuspage-destroy',
      artifactBucket,
      pipelineType: codepipeline.PipelineType.V2,
      executionMode: codepipeline.ExecutionMode.QUEUED,
      restartExecutionOnUpdate: false,
      variables: [confirmDestroy],
      stages: [
        { stageName: 'Source', actions: [new actions.CodeStarConnectionsSourceAction({
          actionName: 'Source', connectionArn, owner, repo, branch: 'main',
          output: destroyOutput, triggerOnPush: false,
        })] },
        { stageName: 'Destroy', actions: [new actions.CodeBuildAction({
          actionName: 'Destroy', project: destroy, input: destroyOutput,
          environmentVariables: {
            CONFIRM_DESTROY: { value: confirmDestroy.reference() },
          },
        })] },
      ],
    });
  }
}
