# Phase 6 手順書: GitHub Actions でテストと自動デプロイ（CI/CD）

> main ブランチにアプリの変更が入ったら、GitHub Actions がテストを動かし、通ったら AWS にデプロイする仕組みを作る。AWS には、アクセスキーではなく OIDC で入る。
> 動いているインスタンスは、新しいバージョンのインスタンスに1台ずつ入れ替える（ローリング更新）。失敗したら元に戻る（ロールバック）。
> 仕組みの解説は [phase6-study.md](phase6-study.md)、ブランチ保護や別のデプロイ方式などは [phase6-appendix.md](phase6-appendix.md)。

## ゴール

- GitHub Actions のワークフローを読んで、いつ・何が・どの順番で動くかを説明できる
- アクセスキーを作らずに、OIDC で GitHub Actions から AWS に入れる
- GitHub Actions 用の IAM ロールの「誰が引き受けられるか」と「何ができるか」を、最小限に絞れる
- アプリを変えて main に入れると、テスト → デプロイ → インスタンスの入れ替えが自動で進むことを確かめる
- テストが落ちたとき、起動に失敗したときに、何が止まり、何が残るかを説明できる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| CI/CD | GitHub Actions（GitHub が用意する Linux のマシンで動く） |
| ワークフロー | `.github/workflows/ci-cd.yml`（テストとデプロイ）、`.github/workflows/destroy.yml`（アプリのスタックを消す） |
| AWS への入り方 | OIDC（IAM の ID プロバイダー + GitHub Actions 用の IAM ロール） |
| IaC | Phase 5 の CDK（`infra/`）。GitHub Actions も同じ `cdk deploy` を実行する |
| 手元からの認証 | `aws login --profile study`（Phase 0） |

### 作るもの

| 場所 | もの | 作り方 |
|---|---|---|
| AWS | IAM の ID プロバイダー（`token.actions.githubusercontent.com`） | 手順3で手作業 → 手順11で CDK（`StatuspageGithub`） |
| AWS | IAM ロール `statuspage-github-deploy`（GitHub Actions が引き受ける） | 手順4で手作業 → 手順11で CDK（`StatuspageGithub`） |
| GitHub | 環境 `aws`（main ブランチだけがデプロイできる） | 手順5 |
| GitHub | 環境のシークレット `AWS_ROLE_ARN`・`ALLOWED_CIDRS`、リポジトリの変数 `DEPLOY_ENABLED` | 手順5 |

### Phase 5 から変わるコード

| ファイル | 変わること |
|---|---|
| `.github/workflows/ci-cd.yml` | 新規。app と infra のテスト、通ったら main だけデプロイ |
| `.github/workflows/destroy.yml` | 新規。アプリのスタックを消す（手で実行する） |
| `deploy/ec2/user-data.sh` | 取ってくるコードを `APP_VERSION`（コミット SHA）で固定する。最後に、起動の成功・失敗を CloudFormation に知らせる（cfn-signal） |
| `app/statuspage/api.py` ほか | `/healthz` が、動いているバージョンも返す |
| `infra/lib/app-stack.ts` | `-c appVersion=...` を受け取る。Auto Scaling グループをローリング更新にする |
| `infra/lib/github-stack.ts` | 新規。ID プロバイダーと GitHub Actions 用のロール（手順11で使う） |

- GitHub Actions は、デプロイするとき `-c appVersion=<そのコミットの SHA>` を渡す。起動テンプレートのユーザーデータが変わるので、Auto Scaling グループのインスタンスが新しいものに入れ替わる
- アプリのスタックがないとき（学習していないとき）に main へ push しても、デプロイはしない（課金されるものを勝手に作らない）。作るのは、手で「Run workflow」を押したときだけ

### 費用（目安）

| もの | 料金 |
|---|---|
| GitHub Actions | 公開リポジトリで GitHub のマシンを使う分は無料 |
| IAM（ID プロバイダー・ロール） | 無料 |
| AWS のリソース | Phase 5 と同じ（全部動かすと 約 $0.12 / 時間）。入れ替えの間だけ api が1台増える |

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 CI/CD とは](phase6-study.md#1-cicd-とは)：全体
>
> 読んだら考える：Phase 5 で、アプリのコードを変えて AWS に反映するには、何をすればよかったか。どこで間違えそうか

1. `git pull` して、`.github/workflows/` に `ci-cd.yml` と `destroy.yml` があることを確認する
2. Budgets の月次コスト予算と、クレジットの残高を確認する
3. Phase 5 の手順14の状態か確認する（`StatuspageApp` がない、RDS が停止）

- [ ] 完了

## 1. ワークフローを読む

> 📖 **先に読む**
> - [study §2 GitHub Actions の基本](phase6-study.md#2-github-actions-の基本)：全体
>
> 読んだら考える：`ci-cd.yml` の3つのジョブは、どの順番で動くか。プルリクエストのときと、main への push のときで、何が違うか

`.github/workflows/ci-cd.yml` と `destroy.yml` を読み、次の表を自分で埋める（`docs/log/phase6-result.md` に書く）。

| 読むところ | 調べること |
|---|---|
| `on:` | どんなとき動くか。`paths:` に入っていないファイル（`docs/` など）だけを変えたときはどうなるか |
| `jobs:` の `test-app`・`test-infra` | それぞれ、どのフォルダで何のコマンドを実行するか |
| `deploy` の `needs:`・`if:` | 何が終わったら、どんな条件のときに動くか |
| `deploy` の `environment:`・`permissions:` | どの環境を使い、どんな権限をもらうか |
| `deploy` の手順 | アプリのスタックがないときに、どこで止まるか |
| `concurrency:` | デプロイが2つ同時に始まりそうなとき、どうなるか |

- [ ] 完了

## 2. CI の結果を見る

> 📖 **先に読む**
> - [study §3 CI でテストを動かす](phase6-study.md#3-ci-でテストを動かす)：全体
>
> 読んだら考える：CI で `uv sync --locked` や `npm ci` を使うのはなぜか

1. GitHub のリポジトリの「Actions」タブを開く
2. 左の一覧から「CI/CD」を選び、一番新しい実行（ワークフローを追加したときの push で動いたもの）を開く
3. `test-app`・`test-infra` のログを開き、テストの件数と結果、かかった時間を見る
4. `deploy` が「skipped」になっていることを確認する

考えること：

- `deploy` が動かなかったのは、`if:` のどの条件のためか
- 手元で `uv run pytest` を実行するのと比べて、何がうれしいか

- [ ] 完了

## 3. GitHub を ID プロバイダーとして登録する

> 📖 **先に読む**
> - [study §4 OIDC で AWS に入る](phase6-study.md#4-oidc-で-aws-に入る)：全体
>
> 読んだら考える：GitHub Actions にアクセスキーを渡す方法と比べて、OIDC では何が漏れにくくなるか

1. コンソールで「IAM」→ 左メニュー「ID プロバイダ」→「プロバイダを追加」
2. 次のように入力して追加する

| 項目 | 値 |
|---|---|
| プロバイダのタイプ | OpenID Connect |
| プロバイダの URL | `https://token.actions.githubusercontent.com` |
| 対象者 | `sts.amazonaws.com` |

- これは「GitHub が発行するトークンを信用する」という登録。まだ誰も AWS に入れない（入れる条件は、次の手順のロールで決める）
- 同じ URL のプロバイダは、1つのアカウントに1つしか作れない

- [ ] 完了

## 4. GitHub Actions 用の IAM ロールを作る

> 📖 **先に読む**
> - [study §5 GitHub Actions 用の IAM ロール](phase6-study.md#5-github-actions-用の-iam-ロール)：全体
> - [phase2-study §6 IAM ロールと EC2](phase2-study.md#6-iam-ロールと-ec2)：「仕組み」（復習）
>
> 読んだら考える：このロールに、EC2 や ALB を作る権限を直接付けないのはなぜか。それでも `cdk deploy` ができるのはなぜか

### 4-1. ロールを作る

1. 「IAM」→「ロール」→「ロールを作成」
2. 信頼されたエンティティタイプ：「ウェブアイデンティティ」
3. アイデンティティプロバイダー：`token.actions.githubusercontent.com`、Audience：`sts.amazonaws.com`
4. GitHub organization：自分の GitHub のユーザー名、GitHub repository：`StudyAWS`、GitHub branch：空欄 →「次へ」
5. 許可ポリシーは何も選ばずに「次へ」
6. ロール名 `statuspage-github-deploy` →「ロールを作成」

### 4-2. 信頼ポリシーを「環境 aws」に絞る

作ったロールの「信頼関係」タブ →「信頼ポリシーを編集」で、次の形にする。`<アカウントID>` はコンソール右上からコピーする（Phase 3 で、手で打って1文字間違えると AccessDenied になった）。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<アカウントID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:<GitHubのユーザー名>/StudyAWS:environment:aws"
        }
      }
    }
  ]
}
```

- `sub` が「どのリポジトリの、どの環境のジョブか」を表す。`StringLike` と `*` は使わない（ほかのリポジトリやブランチからも入れてしまう）

### 4-3. 許可ポリシーを付ける

「許可」タブ →「許可を追加」→「インラインポリシーを作成」→ JSON で次を貼り、名前 `statuspage-github-deploy-policy` で作る。

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
    }
  ]
}
```

- 1つ目：Phase 5 のブートストラップで作った CDK 用のロール（デプロイ用・ファイル置き場用・調べもの用）を引き受ける権限だけ
- 2つ目：アプリのスタックがあるか（学習中か）を調べる権限だけ
- ロールの ARN（「概要」にある）を、次の手順で使う。チャットやリポジトリには貼らない

- [ ] 完了

## 5. GitHub の環境とシークレットを設定する

> 📖 **先に読む**
> - [study §6 環境とシークレット](phase6-study.md#6-環境とシークレット)：全体
> - [study §10 公開リポジトリで CI/CD を扱う](phase6-study.md#10-公開リポジトリで-cicd-を扱う)：全体
>
> 読んだら考える：ロールの ARN と自分の IP アドレスを、ワークフローのファイルに直接書かないのはなぜか。シークレットに入れれば、ログに出ても大丈夫か

GitHub のリポジトリの「Settings」で設定する。

1. 「Environments」→「New environment」→ 名前 `aws` →「Configure environment」
2. 「Deployment branches and tags」で「Selected branches and tags」を選び、「Add deployment branch or tag rule」で `main` を追加する
3. 同じ画面の「Environment secrets」→「Add environment secret」で2つ追加する

| 名前 | 値 |
|---|---|
| `AWS_ROLE_ARN` | 手順4のロールの ARN |
| `ALLOWED_CIDRS` | ALB に入れる IP アドレス。`a.a.a.a/32`、複数なら `a.a.a.a/32,b.b.b.b/32`（Phase 5 の `-c allowedCidrs` と同じ形） |

4. 「Secrets and variables」→「Actions」→「Variables」タブ →「New repository variable」で、`DEPLOY_ENABLED` = `true` を追加する

- `DEPLOY_ENABLED` は、デプロイのジョブを動かすかどうかのスイッチ。フォークした人のリポジトリでは設定されていないので、デプロイが失敗せずに飛ばされる
- 自分の IP アドレスは、場所（家・大学）や PC によって変わる。変わったら `ALLOWED_CIDRS` を更新する

- [ ] 完了

## 6. 初めてのデプロイ

> 📖 **先に読む**
> - [study §7 デプロイの流れ](phase6-study.md#7-デプロイの流れ)：全体
>
> 読んだら考える：GitHub Actions は、取ってくるコードを `main` ではなくコミットの SHA で指定する。それはなぜか

1. RDS：`statuspage-db` を「開始」し、「利用可能」になるまで待つ
2. GitHub の「Actions」→「CI/CD」→「Run workflow」→ Branch `main` →「Run workflow」
3. 実行を開き、`deploy` のログを見る（アカウントID は `***` に、ALB の DNS 名は伏せ字になっている）
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

- `/healthz` の `version` と、`git rev-parse HEAD` が同じことを確かめる
- `X-Served-By` に、どのインスタンスが答えたかが出る（Phase 4 と同じ）
- GitHub Actions のマシンからは、ALB に入れない（セキュリティグループが自分の IP だけを許可している）。だから、動作の確認はインスタンスの起動スクリプトの中（cfn-signal）と、手元からの `curl` で行う

- [ ] 完了

## 7. 実験A：アプリを変えて、自動でデプロイする

> 📖 **実験のあとに読む**
> - [study §8 ローリング更新とロールバック](phase6-study.md#8-ローリング更新とロールバック)：「ローリング更新」「cfn-signal」

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

3. GitHub で、このブランチからプルリクエストを作る。動いたジョブと、飛ばされたジョブを見る
4. テストが通ったら「Merge pull request」でマージする。「Actions」で、main への push で動いた実行を開く
5. 手順1のターミナルと、EC2 の「インスタンス」画面と、CloudFormation の「イベント」タブを見る
6. 終わったらブラウザでページを開き、見出しが変わっていることを確認する。手元を main に戻す

```bash
git switch main
git pull
```

考えること：

- プルリクエストのときと、マージしたときで、動いたジョブはどう違ったか
- 入れ替えの途中で、`/healthz` が答えなくなった時間はあったか。古いバージョンと新しいバージョンが混ざった時間はあったか
- api のインスタンスは、何台ずつ、どの順番で入れ替わったか。worker はどうか
- push してから入れ替えが終わるまで、何分かかったか。どこに一番時間がかかったか

- [ ] 完了

## 8. 実験B：テストが落ちる変更を出す

> 📖 **実験のあとに読む**
> - [study §3 CI でテストを動かす](phase6-study.md#3-ci-でテストを動かす)：全体

予想してから実行する。

1. ブランチを作り、`app/statuspage/api.py` の `/healthz` が返す `"ok"` を `"OK"` に変えて、push する

```bash
git switch -c break-healthz
git commit -am "Phase 6: 実験B テストを落とす"
git push -u origin break-healthz
```

2. プルリクエストを作り、どのジョブが失敗し、どのジョブが動かなかったかを見る。失敗したテストのログを読む
3. **マージせずに**、プルリクエストを「Close pull request」で閉じる。手元を main に戻す

```bash
git switch main
```

- ブランチ `break-healthz` は、手順10で使うのでまだ消さない

考えること：

- テストが落ちたとき、AWS で動いているアプリには何が起きたか
- このプルリクエストをマージしていたら、どうなったか。マージできないようにするには、どうすればよいか（[付録 A](phase6-appendix.md#a-ブランチを保護する)）

- [ ] 完了

## 9. 実験C：起動に失敗するバージョンをデプロイする

> 📖 **実験のあとに読む**
> - [study §8 ローリング更新とロールバック](phase6-study.md#8-ローリング更新とロールバック)：「ロールバック」

予想してから実行する。テストでは見つからない失敗（存在しないコミット）を、手元から直接デプロイする。

1. 手順7-1 と同じように、`/healthz` を見続ける
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
4. 終わったら、GitHub の「Actions」→「CI/CD」→「Run workflow」（main）で、正しいバージョンに戻す

考えること：

- `cdk deploy` は成功したか、失敗したか。スタックは最後にどの状態になったか
- 途中で、`/healthz` が答えなくなった時間はあったか。それはなぜか
- worker は、入れ替えの間どうなったか
- 手順4で Run workflow するのは、なぜか（手元から `appVersion` なしで `deploy` すると、どうなるか）

- [ ] 完了

## 10. 実験D：main 以外のブランチからデプロイしようとする

> 📖 **実験のあとに読む**
> - [study §6 環境とシークレット](phase6-study.md#6-環境とシークレット)：「環境」
> - [study §4 OIDC で AWS に入る](phase6-study.md#4-oidc-で-aws-に入る)：「トークンの中身」

予想してから実行する。

1. 手順8のブランチ `break-healthz` を、`api.py` を元に戻したうえで push し直す（テストは通る状態にする）

```bash
git switch break-healthz
git restore --source main app/statuspage/api.py
git commit -am "Phase 6: 実験D テストを通す"
git push
git switch main
```

2. 「Actions」→「CI/CD」→「Run workflow」で、Branch に `break-healthz` を選んで実行する
3. `deploy` のジョブの表示とエラーを読む
4. 終わったら、ブランチを消す

```bash
git push origin --delete break-healthz
git branch -D break-healthz
```

考えること：

- `deploy` は、どこで止められたか。AWS まで届いたか
- もし環境 `aws` の「Deployment branches」の設定がなかったら、このジョブは AWS に入れたか。信頼ポリシーの `sub` は、ブランチを区別しているか

- [ ] 完了

## 11. OIDC の設定を CDK でコード化する

> 📖 **先に読む**
> - [study §9 OIDC の設定をコード化する](phase6-study.md#9-oidc-の設定をコード化する)：全体
>
> 読んだら考える：`StatuspageGithub` スタックを、GitHub Actions からではなく手元からデプロイするのはなぜか

1. `infra/lib/github-stack.ts` を読み、手順3・4で手作業でしたことのどれに当たるかを対応させる
2. 手で作ったものを消す（同じ名前・同じ URL のものは2つ作れないため）
   - IAM →「ロール」→ `statuspage-github-deploy` を削除
   - IAM →「ID プロバイダ」→ `token.actions.githubusercontent.com` を削除
3. `infra/` の中でデプロイする

```bash
npx cdk diff StatuspageGithub --profile study
npx cdk deploy StatuspageGithub --profile study
```

4. GitHub の「Actions」→「CI/CD」→「Run workflow」（main）で、デプロイが通ることを確かめる

- ロールの名前が同じなので、ARN も同じ。GitHub のシークレット `AWS_ROLE_ARN` は変えなくてよい
- `StatuspageGithub` は、ほかのスタックと参照し合わない。学習を終えるときも消さない（無料）

- [ ] 完了

## 12. 毎回の終わりに

> 📖 **先に読む**
> - [study §11 費用](phase6-study.md#11-費用)：全体
>
> 読んだら考える：Phase 5 の「毎回の終わり」と比べて、手元の PC に必要なものはどう変わったか

### 学習を終えるとき

1. GitHub の「Actions」→「Destroy app」→「Run workflow」（main）
2. RDS：`statuspage-db` を「アクション」→「一時的に停止」（最長7日）

### 学習を始めるとき

1. 場所が変わったら、GitHub の環境 `aws` のシークレット `ALLOWED_CIDRS` を更新する
2. RDS：「開始」→「利用可能」になるまで待つ
3. GitHub の「Actions」→「CI/CD」→「Run workflow」（main）

- 手元から `cdk deploy` するときは、`-c appVersion=$(git rev-parse HEAD)` を付ける（付けないと `main` になり、GitHub Actions が入れたバージョンと違うので、インスタンスが入れ替わる）。手元のコミットは、先に push しておく（インスタンスは GitHub からコードを取ってくる）
- 1週間以上空けるときは、RDS を停止したままにしない（7日で自動で起動する）

- [ ] 理解した

## 13. Phase 6 の片付け

> 📖 **先に読む**
> - [study §12 ほかの Phase とのつながり](phase6-study.md#12-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：実験Aで、入れ替えに一番時間がかかったのはどこか。Phase 7 でコンテナにすると、そこはどう変わるか

Phase 7 でも、ここまでのスタックと GitHub の設定を使う。手順12の「学習を終えるとき」の状態にしておく。

1. 「Destroy app」で `StatuspageApp` を消す
2. RDS を停止する

- `StatuspageGithub`、GitHub の環境・シークレット・変数は残す

- [ ] `StatuspageApp` を削除
- [ ] RDS を停止
