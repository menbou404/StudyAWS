# Phase 6 手順書: GitHub Actions でテスト、CodePipeline で自動デプロイ（CI/CD）

> プルリクエストや main への push のたびに、GitHub Actions がテストを動かす（CI）。main に変更が入ったら、AWS の CodePipeline と CodeBuild がテストとデプロイを行う（CD）。
> 動いているインスタンスは、新しいバージョンのインスタンスに1台ずつ入れ替える（ローリング更新）。失敗したら元に戻る（ロールバック）。
> 仕組みの解説は [phase6-study.md](phase6-study.md)、GitHub Actions から OIDC でデプロイする方法などは [phase6-appendix.md](phase6-appendix.md)。

## ゴール

- GitHub Actions のワークフローを読んで、いつ・何が・どの順番で動くかを説明できる
- CodePipeline のパイプラインと CodeBuild のプロジェクトを作り、main への push でデプロイが進むことを確かめる
- デプロイを動かすロールの権限を、最小限に絞れる
- テストが落ちたとき、起動に失敗したときに、何が止まり、何が残るかを説明できる
- 手で作ったパイプラインを CDK でコード化できる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| CI | GitHub Actions（`.github/workflows/ci.yml`）。GitHub が用意する Linux のマシンで動く |
| CD | CodePipeline（V2）+ CodeBuild。GitHub とは「接続」（CodeConnections）でつなぐ |
| CodeBuild のマシン | Amazon Linux 2023 の ARM（`aws/codebuild/amazonlinux-aarch64-standard:4.0`）、小さいサイズ |
| CodeBuild の手順 | `deploy/codebuild/test.yml`・`deploy.yml`・`destroy.yml`（buildspec） |
| IaC | Phase 5 の CDK（`infra/`）。パイプラインもスタック `StatuspagePipeline` にする |
| 手元からの認証 | `aws login --profile study`（Phase 0） |

### 作るもの

| 場所 | もの | 作り方 |
|---|---|---|
| AWS | 接続 `statuspage-github`（GitHub のリポジトリを読む） | 手順3で手作業（コード化しない） |
| AWS | パラメータストアの値 `/statuspage/allowed-cidrs`・`/statuspage/github-connection-arn` | 手順4で手作業（コード化しない） |
| AWS | パイプライン `statuspage-manual` と CodeBuild のプロジェクト `statuspage-deploy-manual` | 手順5で手作業 → 手順7で消す |
| AWS | パイプライン `statuspage`（ソース → テスト → デプロイ）と `statuspage-destroy`（変数 `CONFIRM_DESTROY` が `true` のときだけ、アプリのスタックを消す） | 手順7で CDK（`StatuspagePipeline`） |

### Phase 5 から変わるコード

| ファイル | 変わること |
|---|---|
| `.github/workflows/ci.yml` | 新規。app と infra のテスト |
| `deploy/codebuild/*.yml` | 新規。CodeBuild で動かす手順（テスト・デプロイ・削除） |
| `deploy/ec2/user-data.sh` | 取ってくるコードを `APP_VERSION`（コミット SHA）で固定する。最後に、起動の成功・失敗を CloudFormation に知らせる（cfn-signal） |
| `app/statuspage/api.py` ほか | `/healthz` が、動いているバージョンも返す |
| `infra/lib/app-stack.ts` | `-c appVersion=...` を受け取る。Auto Scaling グループをローリング更新にする |
| `infra/lib/pipeline-stack.ts` | 新規。パイプライン2つと CodeBuild のプロジェクト（手順7で使う） |

- パイプラインは、デプロイするとき `-c appVersion=<そのコミットの SHA>` を渡す。起動テンプレートのユーザーデータが変わるので、Auto Scaling グループのインスタンスが新しいものに入れ替わる
- アプリのスタックがないとき（学習していないとき）に main へ push しても、デプロイはしない（課金されるものを勝手に作らない）。作るのは、手で「変更をリリース」を押し、変数 `CREATE_APP` を `true` にしたときだけ

### 費用（目安）

| もの | 料金 |
|---|---|
| GitHub Actions | 公開リポジトリで GitHub のマシンを使う分は無料 |
| 接続、パラメータストア（標準）、IAM | 無料 |
| CodePipeline（V2） | 動いたアクションの時間（分）だけ。止まっている間は0 |
| CodeBuild | ビルドの時間（分）だけ。デプロイ1回で十数分、数円〜十数円ほど |
| S3（パイプラインの受け渡し用）、CloudWatch Logs（ビルドのログ） | 置いた量の分だけ。ほぼ0 |
| AWS のリソース | Phase 5 と同じ（全部動かすと 約 $0.12 / 時間）。入れ替えの間だけ api が1台増える |

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 CI/CD とは](phase6-study.md#1-cicd-とは)：全体
>
> 読んだら考える：Phase 5 で、アプリのコードを変えて AWS に反映するには、何をすればよかったか。どこで間違えそうか

1. `git pull` して、`.github/workflows/ci.yml` と `deploy/codebuild/` があることを確認する
2. Budgets の月次コスト予算と、クレジットの残高を確認する
3. Phase 5 の手順14の状態か確認する（`StatuspageApp` がない、RDS が停止）

- [x] 完了

## 1. ワークフローを読む

> 📖 **先に読む**
> - [study §2 GitHub Actions の基本](phase6-study.md#2-github-actions-の基本)：全体
>
> 読んだら考える：`ci.yml` の2つのジョブは、どの順番で動くか。プルリクエストのときと、main への push のときで、何が違うか

`.github/workflows/ci.yml` を読み、次の表を自分で埋める（`docs/log/phase6-result.md` に書く）。

| 読むところ | 調べること |
|---|---|
| `on:` | どんなとき動くか。`paths:` に入っていないファイル（`docs/` など）だけを変えたときはどうなるか |
| `jobs:` の `test-app`・`test-infra` | それぞれ、どのフォルダで何のコマンドを実行するか |
| `permissions:` | どんな権限をもらうか |

- [x] 完了

## 2. CI の結果を見る

> 📖 **先に読む**
> - [study §3 CI でテストを動かす](phase6-study.md#3-ci-でテストを動かす)：全体
>
> 読んだら考える：CI で `uv sync --locked` や `npm ci` を使うのはなぜか

1. GitHub のリポジトリの「Actions」タブを開く
2. 左の一覧からワークフローを選び、一番新しい実行を開く
3. `test-app`・`test-infra` のログを開き、テストの件数と結果、かかった時間を見る

考えること：

- 手元で `uv run pytest` を実行するのと比べて、何がうれしいか

- [x] 完了

## 3. GitHub と AWS をつなぐ（接続）

> 📖 **先に読む**
> - [study §4 AWS の CI/CD サービス](phase6-study.md#4-aws-の-cicd-サービス)：全体
>
> 読んだら考える：接続を作るとき、GitHub 側にどんな許可を与えるか。すべてのリポジトリを許可しないのはなぜか

1. コンソールで「CodePipeline」→ 左メニュー「設定」→「接続」→「接続を作成」
2. プロバイダー「GitHub」、接続名 `statuspage-github` →「GitHub に接続する」
3. 「新しいアプリをインストールする」を押す。GitHub の画面で、**「Only select repositories」で `StudyAWS` だけ**を選び、「Install」
4. AWS の画面に戻り、「接続」を押す。状態が「利用可能」になることを確認する
5. 接続の ARN をコピーしておく（次の手順で使う。チャットやリポジトリには貼らない）

- GitHub 側には「AWS Connector for GitHub」というアプリが入る。GitHub の「Settings」→「Applications」で、許可したリポジトリを後から確認・変更できる
- 接続は、CloudFormation で作っても「GitHub での許可」だけは画面で行う必要がある。だから、コード化せずに手で作ったものを使い続ける

- [x] 完了

## 4. パラメータストアに値を置く

> 📖 **先に読む**
> - [study §6 CodeBuild とデプロイの権限](phase6-study.md#6-codebuild-とデプロイの権限)：「パラメータストア」
>
> 読んだら考える：自分の IP アドレスや接続の ARN を、リポジトリのファイルに書かずにパラメータストアに置くのはなぜか

コンソールで「Systems Manager」→ 左メニュー「パラメータストア」→「パラメータの作成」で、2つ作る。どちらも「標準」、タイプ「文字列」。

| 名前 | 値 |
|---|---|
| `/statuspage/allowed-cidrs` | ALB に入れる IP アドレス。`a.a.a.a/32`、複数なら `a.a.a.a/32,b.b.b.b/32`（Phase 5 の `-c allowedCidrs` と同じ形） |
| `/statuspage/github-connection-arn` | 手順3の接続の ARN |

自分の IP アドレスは、macOS なら `curl -s https://checkip.amazonaws.com`、Windows（PowerShell）なら `(Invoke-RestMethod https://checkip.amazonaws.com).Trim()` で調べる。

- IP アドレスは、場所（家・大学）や PC によって変わる。変わったら `/statuspage/allowed-cidrs` を更新する

- [x] 完了

## 5. パイプラインを手で作る

> 📖 **先に読む**
> - [study §5 CodePipeline の仕組み](phase6-study.md#5-codepipeline-の仕組み)：全体
> - [study §6 CodeBuild とデプロイの権限](phase6-study.md#6-codebuild-とデプロイの権限)：「buildspec」「ビルドのロール」
> - [phase2-study §6 IAM ロールと EC2](phase2-study.md#6-iam-ロールと-ec2)：「仕組み」（復習）
>
> 読んだら考える：デプロイのプロジェクトのロールに、EC2 や ALB を作る権限を直接付けないのはなぜか。それでも `cdk deploy` ができるのはなぜか

まずは「ソース → デプロイ」の2段だけのパイプラインを手で作る（テストの段は、手順7で CDK にしたときに足す）。

### 5-1. パイプラインを作る

「CodePipeline」→「パイプラインを作成する」で、次のように進める。

| 画面 | 設定 |
|---|---|
| 作成オプション | カスタムパイプラインを構築する |
| パイプラインの設定 | 名前 `statuspage-manual`、実行モード「キュー」（QUEUED）、サービスロール「新しいサービスロール」 |
| 変数（パイプラインの設定の中） | 名前 `CREATE_APP`、デフォルト値 `false` |
| ソース | プロバイダー「GitHub（GitHub アプリ経由）」、接続 `statuspage-github`、リポジトリ `StudyAWS`、デフォルトブランチ `main` |
| トリガー | 「フィルターを指定」、イベント「プッシュ」、ブランチ `main`、ファイルパスに `app/**`・`infra/**`・`deploy/**` |
| ビルド | プロバイダー「AWS CodeBuild」→「プロジェクトを作成する」（下の 5-2）。作ったら、このステージは「スキップ」せずにそのまま次へ |
| テスト・デプロイ | スキップ |

- ステージの名前は「Build」のままだが、中身は `cdk deploy`（手で作るパイプラインでは、ビルドの段でデプロイする）
- 画面の表記や項目の場所が違うときは、近いものを選び、どこが違ったかを記録しておく

### 5-2. CodeBuild のプロジェクトを作る（5-1 のビルドの画面から開く）

| 項目 | 設定 |
|---|---|
| プロジェクト名 | `statuspage-deploy-manual` |
| 環境 | マネージドイメージ、コンピューティング「EC2」、OS「Amazon Linux」、ランタイム「Standard」、イメージ `aws/codebuild/amazonlinux-aarch64-standard:4.0` |
| サービスロール | 新しいサービスロール（名前を控えておく） |
| Buildspec | 「buildspec ファイルを使用する」、名前 `deploy/codebuild/deploy.yml` |

プロジェクトを作ったら、5-1 の画面に戻り、**環境変数** を2つ足す。

| 名前 | 値 | タイプ |
|---|---|---|
| `APP_VERSION` | `#{SourceVariables.CommitId}` | プレーンテキスト |
| `CREATE_APP` | `#{variables.CREATE_APP}` | プレーンテキスト |

- `#{...}` は、パイプラインが実行のたびに値を入れてくれる変数。`SourceVariables.CommitId` は、ソースで取ってきたコミットの SHA
- パイプラインを作ると、すぐに1回実行される。ロールの権限がまだないので、デプロイの段は失敗してよい（次の 5-3 のあとで、もう一度動かす）

### 5-3. ビルドのロールに権限を足す

「IAM」→「ロール」→ 5-2 で作られたロール →「許可を追加」→「インラインポリシーを作成」→ JSON で次を貼り、名前 `statuspage-deploy-policy` で作る。`<アカウントID>` は、CLI の `aws sts get-caller-identity --profile study --query Account --output text` で調べてコピーする（Phase 3 で、手で打って1文字間違えると AccessDenied になった）。

- 新方式のアカウントでは、コンソール右上に `AWSManagedAccountManagementAccessRole` と並んで出る「アカウント」の番号は、**自分のアカウントではなく、アカウントを管理している AWS 側の組織のもの**。これを書くと、よそのアカウントのリソースを許可したことになり、自分のリソースには何の許可もないまま AccessDenied になる

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UseCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Resource": "arn:aws:iam::<アカウントID>:role/cdk-hnb659fds-*-<アカウントID>-ap-southeast-2"
    },
    {
      "Sid": "CheckAppStack",
      "Effect": "Allow",
      "Action": "cloudformation:DescribeStacks",
      "Resource": "arn:aws:cloudformation:ap-southeast-2:<アカウントID>:stack/StatuspageApp/*"
    },
    {
      "Sid": "ReadAllowedCidrs",
      "Effect": "Allow",
      "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:ap-southeast-2:<アカウントID>:parameter/statuspage/allowed-cidrs"
    }
  ]
}
```

- 1つ目：Phase 5 のブートストラップで作った CDK 用のロール（デプロイ用・ファイル置き場用・調べもの用）を引き受ける権限だけ
- 2つ目：アプリのスタックがあるか（学習中か）を調べる権限だけ
- 3つ目：ALB に入れる IP アドレスを読む権限だけ
- ログの書き込みや、パイプラインとのファイルの受け渡しの権限は、ロールを作ったときに CodeBuild が付けてくれている

- [x] 完了

## 6. 初めてのデプロイ

> 📖 **先に読む**
> - [study §8 デプロイの流れ](phase6-study.md#8-デプロイの流れ)：全体
>
> 読んだら考える：インスタンスが取ってくるコードを、`main` ではなくコミットの SHA で指定するのはなぜか

1. RDS：`statuspage-db` を「開始」し、「利用可能」になるまで待つ
2. 「CodePipeline」→ `statuspage-manual` →「変更をリリース」。変数 `CREATE_APP` を `true` にして実行する
3. デプロイの段の「詳細」から CodeBuild のログを開き、`cdk deploy` の進み方を見る
4. 終わったら、手元で ALB の DNS 名を調べて、動いているバージョンを確かめる

macOS：

```bash
ALB=$(aws cloudformation describe-stacks --stack-name StatuspageApp --profile study --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
curl -i "http://$ALB/healthz"
git rev-parse HEAD
```

Windows（PowerShell）：

```powershell
$alb = aws cloudformation describe-stacks --stack-name StatuspageApp --profile study --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text
curl.exe -i "http://$alb/healthz"
git rev-parse HEAD
```

5. ブラウザで `http://<ALB の DNS 名>/` を開き、Phase 5 までの監視対象と記録が表示されることを確認する

- `/healthz` の `version` と、`git rev-parse HEAD` が同じことを確かめる（違うときは、手元が最新か `git pull` で確かめる）
- `X-Served-By` に、どのインスタンスが答えたかが出る（Phase 4 と同じ）
- CodeBuild のマシンからは、ALB に入れない（セキュリティグループが自分の IP だけを許可している）。だから、動作の確認はインスタンスの起動スクリプトの中（cfn-signal）と、手元からの `curl` で行う

- [ ] 完了

## 7. パイプラインを CDK でコード化する

> 📖 **先に読む**
> - [study §10 パイプラインをコード化する](phase6-study.md#10-パイプラインをコード化する)：全体
>
> 読んだら考える：`StatuspagePipeline` スタックを、パイプライン自身からではなく手元からデプロイするのはなぜか

1. `infra/lib/pipeline-stack.ts` と `deploy/codebuild/*.yml` を読み、手順5で手作業でしたことのどれに当たるかを対応させる。手作業になかったもの（テストの段、`statuspage-destroy`）も確かめる
2. `infra/` の中でデプロイする

```bash
npx cdk diff StatuspagePipeline --profile study
npx cdk deploy StatuspagePipeline --profile study
```

3. 「CodePipeline」を開く。パイプラインは**作られた直後に1回、自動で実行される**
   - `statuspage`：テストの段 → デプロイの段と進む（アプリのスタックがあるので、`CREATE_APP` が `false` のままでもデプロイされる）
   - `statuspage-destroy`：Destroy の段のログで、`CONFIRM_DESTROY` が `true` ではないので消さずに終わったことを確かめる
4. 手で作ったものを消す
   - CodePipeline → `statuspage-manual` を削除
   - CodeBuild →「ビルドプロジェクト」→ `statuspage-deploy-manual` を削除
   - IAM →「ロール」→ 手順5で作られた2つのロール（パイプライン用と CodeBuild 用）を削除
   - 接続 `statuspage-github` と、パラメータストアの2つの値は **消さない**（CDK のパイプラインが使う）

- `StatuspagePipeline` は、ほかのスタックと参照し合わない。学習を終えるときも消さない（止まっている間は無料）
- パイプラインの設定を変えたいときは、`pipeline-stack.ts` を直して、手元から `cdk deploy StatuspagePipeline` する

- [ ] 完了

## 8. 実験A：アプリを変えて、自動でデプロイする

> 📖 **実験のあとに読む**
> - [study §9 ローリング更新とロールバック](phase6-study.md#9-ローリング更新とロールバック)：「ローリング更新」「cfn-signal」

予想してから実行する。

1. 別のターミナルで、`/healthz` を2秒ごとに見続ける（止めるときは Ctrl+C）

macOS：

```bash
while true; do printf '%s ' "$(date +%T)"; curl -s -m 2 -i "http://$ALB/healthz" | grep -iE 'x-served-by|status' | tr -d '\r' | tr '\n' ' '; echo; sleep 2; done
```

Windows（PowerShell）：

```powershell
while ($true) { try { $r = Invoke-WebRequest "http://$alb/healthz" -TimeoutSec 2; "$(Get-Date -Format T) $($r.Headers['X-Served-By']) $($r.Content)" } catch { "$(Get-Date -Format T) ERROR" }; Start-Sleep 2 }
```

2. ブランチを作り、`app/statuspage/templates/index.html` の `<h1>StatusPage</h1>` の文字を好きなものに変えて、push する

```bash
git switch -c change-title
git commit -am "Phase 6: 実験A 見出しを変える"
git push -u origin change-title
```

3. GitHub で、このブランチからプルリクエストを作る。GitHub Actions のテストが動くことと、CodePipeline が動かないことを確かめる
4. テストが通ったら「Merge pull request」でマージする。CodePipeline の `statuspage` が動き出すのを見る
5. 手順1のターミナルと、EC2 の「インスタンス」画面と、CloudFormation の「イベント」タブを見る
6. 終わったらブラウザでページを開き、見出しが変わっていることを確認する。手元を main に戻す

```bash
git switch main
git pull
```

考えること：

- プルリクエストのときと、マージしたときで、動いたもの（GitHub Actions、CodePipeline）はどう違ったか
- 入れ替えの途中で、`/healthz` が答えなくなった時間はあったか。古いバージョンと新しいバージョンが混ざった時間はあったか
- api のインスタンスは、何台ずつ、どの順番で入れ替わったか。worker はどうか
- マージしてから入れ替えが終わるまで、何分かかったか。どこに一番時間がかかったか

- [ ] 完了

## 9. 実験B：テストが落ちる変更を出す

> 📖 **実験のあとに読む**
> - [study §3 CI でテストを動かす](phase6-study.md#3-ci-でテストを動かす)：全体

予想してから実行する。

1. ブランチを作り、`app/statuspage/api.py` の `/healthz` が返す `"ok"` を `"OK"` に変えて、push する

```bash
git switch -c break-healthz
git commit -am "Phase 6: 実験B テストを落とす"
git push -u origin break-healthz
```

2. プルリクエストを作り、どのジョブが失敗したかを見る。失敗したテストのログを読む
3. **マージせずに**、プルリクエストを「Close pull request」で閉じ、ブランチを消す

```bash
git switch main
git push origin --delete break-healthz
git branch -D break-healthz
```

考えること：

- テストが落ちたとき、AWS で動いているアプリには何が起きたか
- このプルリクエストをマージしていたら、どうなったか。パイプラインのどこで止まったか
- マージできないようにするには、どうすればよいか（[付録 A](phase6-appendix.md#a-ブランチを保護する)）

- [ ] 完了

## 10. 実験C：起動に失敗するバージョンをデプロイする

> 📖 **実験のあとに読む**
> - [study §9 ローリング更新とロールバック](phase6-study.md#9-ローリング更新とロールバック)：「ロールバック」

予想してから実行する。テストでは見つからない失敗（存在しないコミット）を、手元から直接デプロイする。

1. 手順8-1 と同じように、`/healthz` を見続ける
2. `infra/` の中で、存在しないコミット SHA を渡してデプロイする

macOS：

```bash
MYIP=$(curl -s https://checkip.amazonaws.com)
npx cdk deploy StatuspageApp --profile study -c allowedCidrs="$MYIP/32" -c appVersion=0000000000000000000000000000000000000000
```

Windows（PowerShell）：

```powershell
$myip = (Invoke-RestMethod https://checkip.amazonaws.com).Trim()
npx cdk deploy StatuspageApp --profile study -c allowedCidrs="$myip/32" -c appVersion=0000000000000000000000000000000000000000
```

3. CloudFormation の「イベント」タブで、何が起きたかを追う。新しく起動したインスタンスの「システムログ」（EC2 →「アクション」→「モニタリングとトラブルシューティング」→「システムログを取得」）で、ユーザーデータがどこで止まったかを見る
4. 終わったら、CodePipeline の `statuspage` で「変更をリリース」し、正しいバージョンに戻す

考えること：

- `cdk deploy` は成功したか、失敗したか。スタックは最後にどの状態になったか
- 途中で、`/healthz` が答えなくなった時間はあったか。それはなぜか
- worker は、入れ替えの間どうなったか
- 手順4で「変更をリリース」するのは、なぜか（手元から `appVersion` なしで `deploy` すると、どうなるか）

- [ ] 完了

## 11. 実験D：パイプラインが動かない変更

> 📖 **実験のあとに読む**
> - [study §5 CodePipeline の仕組み](phase6-study.md#5-codepipeline-の仕組み)：「トリガー」

予想してから実行する。

1. main 以外のブランチに、アプリの変更を push する（プルリクエストは作らない）

```bash
git switch -c try-branch
echo "# try" >> app/README-try.md
git add app/README-try.md
git commit -m "Phase 6: 実験D ブランチに push"
git push -u origin try-branch
```

2. CodePipeline の `statuspage` の実行履歴を見る
3. main に戻り、`docs/` だけを変えて push する（例：`docs/log/` 以外の文書の誤字を直す）。もう一度、実行履歴と GitHub Actions を見る
4. ブランチを消す

```bash
git switch main
git push origin --delete try-branch
git branch -D try-branch
```

考えること：

- 1 と 3 で、パイプラインは動いたか。それは、パイプラインのどの設定のためか
- GitHub Actions はどうだったか。パイプラインとで、動く条件はどう違うか

- [ ] 完了

## 12. 毎回の終わりに

> 📖 **先に読む**
> - [study §12 費用](phase6-study.md#12-費用)：全体
>
> 読んだら考える：Phase 5 の「毎回の終わり」と比べて、手元の PC に必要なものはどう変わったか

### 学習を終えるとき

1. 「CodePipeline」→ `statuspage-destroy` →「変更をリリース」。変数 `CONFIRM_DESTROY` を `true` にする
2. RDS：`statuspage-db` を「アクション」→「一時的に停止」（最長7日）

### 学習を始めるとき

1. 場所が変わったら、パラメータストアの `/statuspage/allowed-cidrs` を更新する
2. RDS：「開始」→「利用可能」になるまで待つ
3. 「CodePipeline」→ `statuspage` →「変更をリリース」。変数 `CREATE_APP` を `true` にする

- 手元から `cdk deploy` するときは、`-c appVersion=$(git rev-parse HEAD)` を付ける（付けないと `main` になり、パイプラインが入れたバージョンと違うので、インスタンスが入れ替わる）。手元のコミットは、先に push しておく（インスタンスは GitHub からコードを取ってくる）
- 1週間以上空けるときは、RDS を停止したままにしない（7日で自動で起動する）

- [ ] 理解した

## 13. Phase 6 の片付け

> 📖 **先に読む**
> - [study §13 ほかの Phase とのつながり](phase6-study.md#13-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：実験Aで、入れ替えに一番時間がかかったのはどこか。Phase 7 でコンテナにすると、そこはどう変わるか

Phase 7 でも、ここまでのスタックとパイプラインを使う。手順12の「学習を終えるとき」の状態にしておく。

1. `statuspage-destroy` で `StatuspageApp` を消す（`CONFIRM_DESTROY` を `true`）
2. RDS を停止する

- `StatuspagePipeline`、接続、パラメータストアの値は残す

- [ ] `StatuspageApp` を削除
- [ ] RDS を停止
