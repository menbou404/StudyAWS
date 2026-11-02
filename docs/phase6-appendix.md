# Phase 6 付録: 使わなかった CI/CD まわりの仕組み

> Phase 6 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase6-setup.md](phase6-setup.md) と知識まとめ [phase6-study.md](phase6-study.md) を読んだあとに。

この付録では次の5つをまとめる。

- **A. ブランチを保護する**：テストが通らないとマージできないようにする
- **B. 承認してからデプロイする**：環境の Required reviewers
- **C. インスタンスの入れ替え方の比較**：ローリング更新以外の方法
- **D. アクションのバージョンを固定する**：他人のコードを安全に使う
- **E. AWS の中で CI/CD を組む**：CodePipeline と CDK Pipelines

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
- チームで開発するときは、まず設定するもの。[study §5](phase6-study.md#5-github-actions-用の-iam-ロール) のとおり、main に入ったものは AWS の管理者に近い権限でデプロイされるので、main に入る道を絞ることがそのまま AWS の守りになる

---

## B. 承認してからデプロイする

環境 `aws` の「Required reviewers」に人を指定すると、`deploy` のジョブは始まる前に止まり、その人が「Approve and deploy」を押すまで待つ。

| | 本編（承認なし） | 承認あり |
|---|---|---|
| main に入ってからデプロイまで | 自動 | 人が押したとき |
| 呼び方 | 継続的デプロイ | 継続的デリバリー |
| 向いているとき | テストと自動のロールバックを信頼できる | 本番に出す時刻を選びたい、ほかの人の目を通したい |

- 「Prevent self-review」を付けると、自分で起こしたデプロイを自分で承認できなくなる
- 公開リポジトリなら無料のプランでも使える

---

## C. インスタンスの入れ替え方の比較

| 方法 | 動き | よいところ | 気をつけること |
|---|---|---|---|
| AutoScalingRollingUpdate（本編） | 同じ Auto Scaling グループの中で、数台ずつ入れ替える | 設定が簡単。cfn-signal で待てる | 古いものと新しいものが混ざる。戻すときも1台ずつ |
| AutoScalingReplacingUpdate | Auto Scaling グループごと新しく作り、全部動いたら古いグループを消す | 戻すのが速い（古いグループに戻すだけ） | 一時的に倍の台数になる |
| AutoScalingInstanceRefresh | Auto Scaling の「インスタンスの更新」機能を CloudFormation から使う | 新しいものを先に起動する、CloudWatch アラームで自動で戻す、など細かく決められる | 比較的新しい機能。設定の項目が多い |
| ブルー/グリーン | 新しい環境（グリーン）を丸ごと作り、ALB の向き先を一気に切り替える | 切り替えも戻しも一瞬。混ざらない | 一時的に倍の費用。DB のように共有するものは切り替えられない |
| カナリア | 新しいバージョンに、まず一部（10% など）だけ流して様子を見る | 問題があっても影響が小さい | 重み付けの仕組みと、様子を見る指標が要る |

Phase 7 の ECS では、サービスのローリング更新や、CodeDeploy を使ったブルー/グリーンが使える。

---

## D. アクションのバージョンを固定する

`uses: actions/checkout@v5` の `v5` はタグで、**持ち主があとから別のコミットに付け替えられる**。アクションの持ち主のアカウントが乗っ取られると、同じ `@v5` のまま中身を書き換えられ、シークレットや OIDC のトークンを盗まれることがある。

| 書き方 | 固定の強さ |
|---|---|
| `@main` | 弱い。いつでも変わる |
| `@v5` | 中くらい。付け替えられる |
| `@<40文字のコミット SHA>  # v5.0.0` | 強い。中身が変わらない |

- SHA で固定すると、更新は自分でする必要がある。**Dependabot**（`.github/dependabot.yml`）を設定すると、新しいバージョンが出たときに更新のプルリクエストを自動で作ってくれる
- `actions/`（GitHub 公式）や `aws-actions/`（AWS 公式）など、発行元が確かなものを選ぶ

---

## E. AWS の中で CI/CD を組む

GitHub Actions の代わりに、AWS のサービスでパイプラインを組むこともできる。

| サービス | 役割 |
|---|---|
| CodePipeline | パイプライン全体（ソース → ビルド → デプロイ）の流れを管理する |
| CodeBuild | テストやビルドを動かす（GitHub Actions のランナーに当たる） |
| CodeDeploy | EC2・ECS・Lambda へのデプロイ（ブルー/グリーンなど）を行う |
| CDK Pipelines | CDK のアプリをデプロイするパイプラインを、CDK のコードで作る。パイプライン自身の変更も自分でデプロイする（セルフミューテーション） |

| | GitHub Actions（本編） | CodePipeline など |
|---|---|---|
| 動く場所 | GitHub | 自分の AWS アカウント |
| AWS への入り方 | OIDC | 最初から AWS の中（IAM ロール） |
| 料金 | 公開リポジトリは無料 | パイプラインやビルドの時間ごとに課金 |
| 向いているとき | コードが GitHub にあり、プルリクエストと一緒に見たい | 複数の AWS アカウントへ順番に出す、AWS の中で完結させたい |

---

## 参考

- [GitHub Docs: About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [GitHub Docs: Deployments and environments（Required reviewers）](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub Docs: Security hardening for GitHub Actions（サードパーティのアクション）](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- [GitHub Docs: Keeping your actions up to date with Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
- [CloudFormation: UpdatePolicy 属性](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatepolicy.html)
- [AWS CDK: CDK Pipelines](https://docs.aws.amazon.com/cdk/v2/guide/cdk_pipeline.html)
