# Phase 6 付録: 使わなかった CI/CD まわりの仕組み

> Phase 6 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase6-setup.md](phase6-setup.md) と知識まとめ [phase6-study.md](phase6-study.md) を読んだあとに。

この付録では次の6つをまとめる。

- **A. ブランチを保護する**：テストが通らないとマージできないようにする
- **B. 承認してからデプロイする**：手動承認のアクション
- **C. インスタンスの入れ替え方の比較**：ローリング更新以外の方法
- **D. アクションのバージョンを固定する**：他人のコードを安全に使う
- **E. GitHub Actions から OIDC でデプロイする**：デプロイも GitHub の中で行う構成
- **F. CDK Pipelines**：パイプライン自身も更新するパイプライン

---

## A. ブランチを保護する

本編では、テストが落ちてもマージボタンは押せる。GitHub の **ルールセット**（Settings →「Rules」→「Rulesets」）で、main に入る変更に条件を付けられる。

| ルール | 効果 |
|---|---|
| Require a pull request before merging | main に直接 push できなくなる。必ずプルリクエストを通す |
| Require status checks to pass | 指定したジョブ（`test-app`・`test-infra`）が成功しないとマージできない |
| Required approvals | ほかの人の承認がないとマージできない |
| Block force pushes | 履歴の書き換えを禁止する |

### 本編で採用しなかった理由

- 1人で学習しているので、承認してくれる人がいない
- 文書（`docs/`）の更新を main に直接 push しているので、プルリクエスト必須にすると手間が増える
- チームで開発するときは、まず設定するもの。[study §6](phase6-study.md#6-codebuild-とデプロイの権限) のとおり、main に入ったものは AWS の管理者に近い権限でデプロイされるので、main に入る道を絞ることがそのまま AWS の守りになる

---

## B. 承認してからデプロイする

CodePipeline には **手動承認（Manual approval）** のアクションがある。テストの段とデプロイの段の間に置くと、パイプラインはそこで止まり、人がコンソールで「承認」を押すまで待つ（最長7日）。

| | 本編（承認なし） | 承認あり |
|---|---|---|
| main に入ってからデプロイまで | 自動 | 人が押したとき |
| 呼び方 | 継続的デプロイ | 継続的デリバリー |
| 向いているとき | テストと自動のロールバックを信頼できる | 本番に出す時刻を選びたい、ほかの人の目を通したい |

- SNS のトピックを指定すると、承認待ちになったことをメールなどで知らせられる
- 承認できる人は、IAM の権限（`codepipeline:PutApprovalResult`）で絞る
- GitHub Actions では、環境（Environment）の「Required reviewers」が同じ役目をする

---

## C. インスタンスの入れ替え方の比較

| 方法 | 動き | よいところ | 気をつけること |
|---|---|---|---|
| AutoScalingRollingUpdate（本編） | 同じ Auto Scaling グループの中で、数台ずつ入れ替える | 設定が簡単。cfn-signal で待てる | 古いものと新しいものが混ざる。戻すときも1台ずつ |
| AutoScalingReplacingUpdate | Auto Scaling グループごと新しく作り、全部動いたら古いグループを消す | 戻すのが速い（古いグループに戻すだけ） | 一時的に倍の台数になる |
| AutoScalingInstanceRefresh | Auto Scaling の「インスタンスの更新」機能を CloudFormation から使う | 新しいものを先に起動する、CloudWatch アラームで自動で戻す、など細かく決められる | 比較的新しい機能。設定の項目が多い |
| CodeDeploy（インプレース・ブルー/グリーン） | CodeDeploy のエージェントがインスタンスにアプリを配る、または新しい Auto Scaling グループを作って ALB の向き先を切り替える | デプロイの進み方を細かく決められる。切り替えも戻しも速い | エージェントや設定ファイル（appspec）が要る |
| カナリア | 新しいバージョンに、まず一部（10% など）だけ流して様子を見る | 問題があっても影響が小さい | 重み付けの仕組みと、様子を見る指標が要る |

Phase 7 の ECS では、サービスのローリング更新や、CodeDeploy を使ったブルー/グリーンが使える。

---

## D. アクションのバージョンを固定する

`uses: actions/checkout@v7` の `v7` はタグで、**持ち主があとから別のコミットに付け替えられる**。アクションの持ち主のアカウントが乗っ取られると、同じ `@v7` のまま中身を書き換えられ、ジョブの中のシークレットを盗まれることがある。

| 書き方 | 固定の強さ |
|---|---|
| `@main` | 弱い。いつでも変わる |
| `@v7`、`@v7.0.1` | 中くらい。付け替えられる |
| `@<40文字のコミット SHA>  # v7.0.1` | 強い。中身が変わらない |

- SHA で固定すると、更新は自分でする必要がある。**Dependabot**（`.github/dependabot.yml`）を設定すると、新しいバージョンが出たときに更新のプルリクエストを自動で作ってくれる
- `actions/`（GitHub 公式）や `aws-actions/`（AWS 公式）など、発行元が確かなものを選ぶ

---

## E. GitHub Actions から OIDC でデプロイする

デプロイも GitHub Actions で行う構成。GitHub をよく使う現場では、この形がよく使われる。ただし、**新方式のアカウントでは ID プロバイダーを作れない**ので、使うには「高度な機能」を有効にする必要がある（元に戻せない）。

### 構成

| 場所 | もの |
|---|---|
| AWS | IAM の ID プロバイダー（`https://token.actions.githubusercontent.com`、対象者 `sts.amazonaws.com`） |
| AWS | GitHub Actions 用の IAM ロール。許可は本編のデプロイのロールと同じ（CDK のロールを引き受ける、スタックを調べる） |
| GitHub | 環境（Environment）`aws`。デプロイできるブランチを main に絞り、ロールの ARN などを環境のシークレットに入れる |
| GitHub | ワークフローのデプロイのジョブ（`environment: aws`、`permissions: id-token: write`、`aws-actions/configure-aws-credentials` でロールを引き受ける） |

### ロールの信頼ポリシー

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<アカウントID>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:environment:aws"
    }
  }
}
```

- `sub` は「どのリポジトリの、どのジョブか」。環境を使うジョブでは `repo:<owner>/<repo>:environment:<環境名>`、ブランチへの push なら `repo:<owner>/<repo>:ref:refs/heads/<ブランチ名>`、プルリクエストなら `repo:<owner>/<repo>:pull_request` になる
- `sub` を書き忘れたり `*` で広く書いたりすると、他人のリポジトリのジョブからも入れてしまう
- 環境を使うジョブの `sub` にはブランチ名が入らないので、「main だけ」を守るのは GitHub 側の環境の設定（Deployment branches）

### 公開リポジトリで気をつけること

- Actions のログは公開されるので、アカウントID（`mask-aws-account-id`）、IP アドレス（`::add-mask::`）、ALB の DNS 名（出力の書き換え）を自分でマスクする
- シークレットは、値と完全に同じ文字列だけが `***` になる。一部分や加工した値は隠れない

### 本編（CodePipeline）との比較

| | GitHub Actions + OIDC | CodePipeline（本編） |
|---|---|---|
| 新方式のアカウント | 使えない（高度な機能が必要） | 使える |
| AWS への入り方 | 外から OIDC | 中で IAM ロール |
| ログ | 公開（マスクが必要） | 非公開 |
| 料金 | 公開リポジトリは無料 | 動いた時間の分だけ |
| プルリクエストとのつながり | 同じ画面で、テストからデプロイまで見られる | デプロイは AWS のコンソールで見る |

---

## F. CDK Pipelines

**CDK Pipelines**（`aws-cdk-lib/pipelines`）は、CDK のアプリをデプロイするパイプラインを、CDK のコードで少ない行数で作るためのライブラリ。

| | 本編（`aws_codepipeline` で組む） | CDK Pipelines |
|---|---|---|
| 書く量 | ステージやアクションを1つずつ書く | 「ソース」「synth のコマンド」「デプロイするスタック」を書くだけ |
| パイプライン自身の変更 | 手元から `cdk deploy` する | パイプラインが自分自身を更新する（セルフミューテーション） |
| デプロイのやり方 | CodeBuild の中で `cdk deploy` | CloudFormation のアクションで、テンプレートを直接デプロイする |
| 複数のアカウント・リージョン | 自分で組む | ステージを足すだけで、順番にデプロイできる |

- セルフミューテーションは便利な反面、「main に入ったコードがパイプラインの権限を変えられる」ことになる。本編で手元からデプロイしている理由（[study §10](phase6-study.md#10-パイプラインをコード化する)）と裏表の関係
- 本編では、CodePipeline のステージ・アクション・変数を1つずつ理解するために、部品から組んでいる

---

## 参考

- [GitHub Docs: About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [CodePipeline ユーザーガイド: 承認アクションを管理する](https://docs.aws.amazon.com/ja_jp/codepipeline/latest/userguide/approvals.html)
- [CloudFormation: UpdatePolicy 属性](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatepolicy.html)
- [GitHub Docs: Security hardening for GitHub Actions（サードパーティのアクション）](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub Docs: Keeping your actions up to date with Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
- [GitHub Docs: Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
- [AWS CDK: CDK Pipelines](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html)
