# Phase 6 知識まとめ: CI/CD・GitHub Actions・CodePipeline

> Phase 6 で出てきた知識を体系的にまとめたもの。手順は [phase6-setup.md](phase6-setup.md)。

## 目次

1. [CI/CD とは](#1-cicd-とは)
2. [GitHub Actions の基本](#2-github-actions-の基本)
3. [CI でテストを動かす](#3-ci-でテストを動かす)
4. [AWS の CI/CD サービス](#4-aws-の-cicd-サービス)
5. [CodePipeline の仕組み](#5-codepipeline-の仕組み)
6. [CodeBuild とデプロイの権限](#6-codebuild-とデプロイの権限)
7. [外から AWS に入る方法と OIDC](#7-外から-aws-に入る方法と-oidc)
8. [デプロイの流れ](#8-デプロイの流れ)
9. [ローリング更新とロールバック](#9-ローリング更新とロールバック)
10. [パイプラインをコード化する](#10-パイプラインをコード化する)
11. [公開リポジトリで CI/CD を扱う](#11-公開リポジトリで-cicd-を扱う)
12. [費用](#12-費用)
13. [ほかの Phase とのつながり](#13-ほかの-phase-とのつながり)
14. [理解度チェック](#14-理解度チェック)

---

## 1. CI/CD とは

**コードの変更を、テストして、本番に届けるまでを自動にすること。**

| 言葉 | 意味 |
|---|---|
| CI（Continuous Integration、継続的インテグレーション） | 変更を出すたびに、自動でビルドとテストをする。壊れた変更を、main に入る前に見つける |
| CD（Continuous Delivery、継続的デリバリー） | いつでもデプロイできる状態を自動で作る。本番に出すのは人がボタンを押す |
| CD（Continuous Deployment、継続的デプロイ） | テストが通ったら、人を通さずに本番まで自動で出す |
| パイプライン | 「テスト → ビルド → デプロイ」のような、決まった順番の流れ |

### 手でデプロイする場合との比較

| | 手元から手でデプロイ | CI/CD |
|---|---|---|
| テスト | 忘れることがある | 毎回必ず動く。落ちたら先に進まない |
| どの PC から | 認証情報と道具（Node.js など）がそろった PC だけ | どこからでも（画面のボタンだけでよい） |
| 何をデプロイしたか | 手元のファイル（コミットしていない変更が混ざることがある） | Git のコミット。記録が残る |
| 権限 | 自分の強い権限で実行する | デプロイに必要な分だけの権限で実行する |
| 手順の間違い | 起こりうる | 毎回同じ手順 |

### このプロジェクトの流れ

| きっかけ | GitHub Actions（CI） | CodePipeline（CD） |
|---|---|---|
| プルリクエストを作る・更新する | テスト | 動かない |
| main に push（マージ）する | テスト | テスト → デプロイ（アプリのスタックがあるときだけ） |
| `statuspage` で「変更をリリース」（`CREATE_APP=true`） | — | テスト → デプロイ（スタックがなければ作る） |
| `statuspage-destroy` で「変更をリリース」（`CONFIRM_DESTROY=true`） | — | アプリのスタックを消す |

テストが通れば人を通さずに出すので、main への push は「継続的デプロイ」にあたる。

---

## 2. GitHub Actions の基本

**GitHub Actions は、リポジトリの出来事（push、プルリクエストなど）をきっかけに、GitHub が用意したマシンでコマンドを動かす仕組み。**

| 言葉 | 意味 | 書く場所 |
|---|---|---|
| ワークフロー | 1つの自動化の単位。YAML ファイル1つ | `.github/workflows/*.yml` |
| イベント（トリガー） | ワークフローが動くきっかけ | `on:` |
| ジョブ | ワークフローの中の作業のまとまり。ジョブごとに別のマシンで動く | `jobs:` |
| ステップ | ジョブの中で順番に動くコマンドやアクション | `steps:` |
| ランナー | ジョブを動かすマシン。GitHub が毎回まっさらなものを用意する | `runs-on:` |
| アクション | よく使う処理の部品。他人が公開したものを `uses:` で使う | `uses: actions/checkout@...` |

### よく使う書き方

| 書き方 | 意味 |
|---|---|
| `on: push: branches: [main]` | main への push で動く |
| `on: pull_request` | プルリクエストの作成・更新で動く |
| `on: workflow_dispatch` | 画面の「Run workflow」ボタンで手で動かす |
| `paths:` | 指定したファイルが変わったときだけ動く（`docs/` だけの変更では動かさない、など） |
| `needs: [a, b]` | ジョブ a と b が成功してから動く。書かないジョブ同士は同時に動く |
| `if:` | 条件を満たすときだけ動く。満たさないと「skipped」になる |
| `permissions:` | このワークフローが使う GitHub のトークン（`GITHUB_TOKEN`）の権限。必要なものだけにする（`contents: read` ならコードを読むだけ） |
| `concurrency:` | 同じグループの実行を同時に動かさない |
| `${{ secrets.X }}`・`${{ vars.X }}` | シークレット・変数を読む |

### ランナーは毎回まっさら

- ジョブが終わるとマシンは捨てられる。前回インストールしたものも、ファイルも残らない
- だから、ワークフローには「コードを取ってくる → 道具を入れる → 依存を入れる → 実行する」を毎回すべて書く
- 毎回同じ状態から始まるので、「自分の PC では動く」が起きにくい

---

## 3. CI でテストを動かす

### 何を確かめるか

| 確かめるもの | コマンド | 内容 |
|---|---|---|
| アプリ | `uv run pytest` | API と監視ジョブが期待どおりに動くか |
| CDK のテスト | `npm test` | テンプレートが守りたいルール（DB に入れるのは web と worker だけ、など）を満たすか |
| CDK の synth | `cdk synth` | CDK のコードからテンプレートを作れるか |

### ロックファイルどおりに入れる

| コマンド | 意味 |
|---|---|
| `uv sync --locked` | `uv.lock` と `pyproject.toml` が食い違っていたら、勝手に直さずに失敗する |
| `npm ci` | `package-lock.json` どおりに入れる。ずれていたら失敗する |

CI で入れるライブラリが手元と違うと、「CI では通ったのに本番で壊れる」「昨日は通ったのに今日は落ちる」が起きる。ロックファイルどおりに入れれば、誰がいつ実行しても同じになる。

### テストが落ちたら

- プルリクエストの画面に ✕ が付き、どのテストが落ちたかをログで読める
- ただし、✕ が付いてもマージボタンは押せてしまう。「テストが通らないとマージできない」にするには、ブランチの保護（ルールセット）を設定する（[付録 A](phase6-appendix.md#a-ブランチを保護する)）
- マージしてしまっても、パイプラインのテストの段でもう一度テストして、落ちればデプロイの段に進まない。AWS で動いているものは何も変わらない

### テストで見つからない失敗

テストは「書いたこと」しか確かめない。次のようなものは、CI が通っても本番で起きうる。

- 本番の環境でだけ起きる失敗（パッケージが入らない、設定ファイルがない、DB につながらない）
- テストを書いていない動き

これに備えるのが、デプロイの途中で本物のインスタンスが動くかを確かめて、だめなら元に戻す仕組み（§9）。

---

## 4. AWS の CI/CD サービス

| サービス | 役割 | GitHub Actions でいうと |
|---|---|---|
| **CodePipeline** | 「ソース → テスト → デプロイ」の流れを管理する | ワークフロー |
| **CodeBuild** | コマンドを動かす使い捨てのマシン。手順は buildspec に書く | ランナーとジョブ |
| **CodeConnections**（接続） | AWS が GitHub などのリポジトリを読み、push を受け取れるようにする | （GitHub の中なので不要） |
| CodeDeploy | EC2・ECS・Lambda へのデプロイ（ブルー/グリーンなど）を行う。このプロジェクトでは使わない（[付録 C](phase6-appendix.md#c-インスタンスの入れ替え方の比較)） | — |

### 接続（CodeConnections）

- 接続を作ると、GitHub 側に「AWS Connector for GitHub」というアプリが入る。AWS はこのアプリの権限で、リポジトリの中身を読み、push の知らせを受け取る
- アプリに許可するリポジトリは、**必要なものだけ**（Only select repositories）にする。全部を許可すると、関係ないリポジトリ（非公開のものも）まで AWS から読めるようになる
- 接続は CloudFormation でも作れるが、作った直後は「保留中」で、GitHub での許可は人が画面で行う必要がある

### GitHub Actions と CodePipeline の比べ方

| | GitHub Actions | CodePipeline + CodeBuild |
|---|---|---|
| 動く場所 | GitHub のマシン | 自分の AWS アカウントの中 |
| AWS への入り方 | 外から入る（OIDC やアクセスキー） | 最初から中にいる（IAM ロール） |
| ログ | 公開リポジトリなら、GitHub にログインしている人が誰でも見られる | 自分の AWS アカウントの CloudWatch Logs。外からは見えない |
| 料金 | 公開リポジトリは無料 | 動いた時間の分だけ |
| 向いているとき | プルリクエストごとの確認、GitHub の画面で完結させたい | AWS の中で完結させたい、複数の AWS アカウントに順番に出す |

このプロジェクトでは、プルリクエストの確認（CI）は GitHub Actions、デプロイ（CD）は CodePipeline と分けている。

---

## 5. CodePipeline の仕組み

| 言葉 | 意味 | このプロジェクトでは |
|---|---|---|
| パイプライン | 流れ全体 | `statuspage`、`statuspage-destroy` |
| ステージ | 流れの1段。前のステージが成功したら次に進む | Source → Test → Deploy |
| アクション | ステージの中で行う1つの作業 | 「GitHub から取ってくる」「CodeBuild でテストする」など |
| アーティファクト | ステージの間で受け渡すファイル（S3 に置かれる） | ソースで取ってきたリポジトリの中身 |
| 変数 | 実行のたびに決まる値。`#{名前空間.変数名}` で参照する | `#{SourceVariables.CommitId}`（コミット SHA）、`#{variables.CREATE_APP}` |
| 実行 | パイプラインを1回動かすこと。「変更をリリース」で手でも始められる | — |

### トリガー

V2 のパイプラインは、**どんな push で動くか** を絞れる。

| 絞り方 | このプロジェクトでは |
|---|---|
| ブランチ | `main` だけ。ほかのブランチへの push では動かない |
| ファイルパス | `app/**`・`infra/**`・`deploy/**` が変わったときだけ。`docs/` だけの変更では動かない |
| プルリクエスト | 使わない（プルリクエストの確認は GitHub Actions） |

### 変数

パイプラインに変数を決めておくと、「変更をリリース」で手で動かすときに値を変えられる。push で動いたときはデフォルト値が使われる。

| 変数 | デフォルト | 意味 |
|---|---|---|
| `CREATE_APP`（`statuspage`） | `false` | アプリのスタックがないときに作るか。push のときは `false` なので、学習していない日に勝手に作られない |
| `CONFIRM_DESTROY`（`statuspage-destroy`） | `false` | 本当にアプリのスタックを消すか。押し間違いや、作成直後の自動の実行では消さない |

### 作成直後の実行

パイプラインは、**作られた直後に1回、自動で実行される**（トリガーを付けていなくても）。CloudFormation や CDK で作ったときも同じ。

- 「消す」「本番に出す」のような影響の大きいパイプラインは、最初の実行で何が起きるかを考えておく
- このプロジェクトでは、変数の既定値を安全な側（`false`）にして、最初の実行では何もしないで終わるようにしている

### 実行モード

| モード | 動き |
|---|---|
| SUPERSEDED（V1 の既定） | 新しい実行が来たら、待っている古い実行を追い越して捨てる |
| **QUEUED**（このプロジェクト） | 来た順に1つずつ実行する。デプロイが重ならない |
| PARALLEL | 同時に実行する |

CloudFormation のスタックは同時に2つの更新を受け付けないので、デプロイは QUEUED にして順番に流す。

---

## 6. CodeBuild とデプロイの権限

### buildspec

CodeBuild で動かす手順は、**buildspec**（YAML）に書く。このプロジェクトでは `deploy/codebuild/` に置いている。

| 項目 | 意味 |
|---|---|
| `env.variables` | 決まった値の環境変数 |
| `env.parameter-store` | パラメータストアから読む環境変数 |
| `phases.install` | 道具を入れる（`runtime-versions` で Node.js や Python のバージョンを選ぶ） |
| `phases.build` | 本番の作業（テスト、`cdk deploy` など） |

- CodeBuild のマシンも、GitHub Actions のランナーと同じく毎回まっさら
- イメージ（マシンの土台）は AWS が用意したものを選ぶ。このプロジェクトでは Amazon Linux 2023 の ARM 版（EC2 と同じ CPU の種類）

### ビルドのロール

CodeBuild のプロジェクトには、IAM ロール（サービスロール）を付ける。Phase 2 で EC2 にロールを付けたのと同じで、ビルドの中の AWS CLI や CDK は、そのロールの一時的な認証情報で動く。**アクセスキーはどこにもない**。

| プロジェクト | ロールに付ける権限 |
|---|---|
| テスト | ログを書く、アーティファクトを読むだけ（AWS のリソースには触らない） |
| デプロイ | CDK のロールを引き受ける、アプリのスタックがあるか調べる、IP アドレスのパラメータを読む |
| 削除 | CDK のロールを引き受ける |

### CDK のロールを引き受ける

`cdk deploy` は、実際の作業を Phase 5 のブートストラップで作ったロールに任せる。

| ロール（名前の一部） | 使われるとき |
|---|---|
| `deploy-role` | CloudFormation にテンプレートを渡して、スタックを作る・変える・消す |
| `file-publishing-role` | テンプレートやファイル（アセット）を S3 に置く |
| `lookup-role` | AZ の一覧など、AWS に問い合わせる |
| `cfn-exec-role` | CloudFormation が実際にリソースを作るときに使う（既定は AdministratorAccess） |

デプロイのロールには、EC2 や ALB を作る権限を直接付けない。`deploy-role` などを引き受ける権限だけを付ければ、`cdk deploy` ができる。ブートストラップのロールは、同じアカウントの中から引き受けられるように作られている。

### 気をつけること：実質は強い権限

| 順番 | 権限 |
|---|---|
| デプロイのロール | CDK のロールを引き受けるだけ |
| → `deploy-role` | CloudFormation のスタックを操作する |
| → `cfn-exec-role` | **AdministratorAccess**（何でも作れる） |

テンプレートに書けば何でも作れるので、**パイプラインでデプロイされるコード（main に入るもの）を変えられる人は、実質的にアカウントの管理者に近い**。

- main に入るものを、プルリクエストとレビューで絞る（[付録 A](phase6-appendix.md#a-ブランチを保護する)）
- 接続のアプリに許可するリポジトリを絞る
- GitHub のアカウントに2段階認証を設定する
- さらに絞るなら、ブートストラップで `cfn-exec-role` に付ける権限を必要な分だけにする

### パラメータストア

**Systems Manager パラメータストアは、設定の値を名前を付けて置いておける場所。**

| | パラメータストア（標準） | Secrets Manager（Phase 3） |
|---|---|---|
| 向いているもの | 設定の値（IP アドレス、接続の ARN など） | パスワードなどの秘密 |
| 暗号化 | 選べる（SecureString） | 必ず |
| 自動のローテーション | なし | あり |
| 料金 | 標準は無料 | 1つあたり月額 |

- リポジトリに書かずに済むので、公開リポジトリに IP アドレスやアカウントID（ARN に入る）が載らない
- 場所が変わって IP アドレスが変わっても、値を書き換えるだけでよい（コードは変えない）
- CodeBuild は buildspec の `parameter-store` で、CDK は `ssm.StringParameter.valueForStringParameter` で、名前から値を読む

---

## 7. 外から AWS に入る方法と OIDC

GitHub Actions のように AWS の**外**で動くものが AWS を操作するには、認証情報が必要になる。

| 方法 | 内容 | 問題 |
|---|---|---|
| IAM ユーザーのアクセスキー | 長く使える鍵を GitHub のシークレットに入れる | 消すまで有効。漏れたら、気づくまで使われ続ける。入れ替えが手間 |
| **OIDC** | GitHub が署名した「このジョブは、このリポジトリのものです」というトークンを AWS に見せて、一時的な認証情報をもらう | 長く使える秘密がどこにも保存されない |

### OIDC の仕組み

**OIDC（OpenID Connect）は、「ある人（やジョブ）が誰か」を、信頼できる発行元が署名したトークンで証明する仕組み。**

| 順番 | 誰が | 何をする |
|---|---|---|
| 1 | AWS（事前に1回） | IAM に「GitHub が署名したトークンを信用する」と登録しておく（ID プロバイダー） |
| 2 | GitHub Actions のジョブ | GitHub から ID トークンをもらう（ワークフローに `permissions: id-token: write` が必要） |
| 3 | ジョブ | トークンを AWS STS に渡して、「このロールを引き受けたい」と頼む |
| 4 | AWS STS | 署名と、トークンの中身（どのリポジトリの、どの環境のジョブか）がロールの信頼ポリシーの条件に合うかを確かめる |
| 5 | AWS STS | 合えば、一時的な認証情報（1時間など）を返す |

- 守る場所は AWS から GitHub に移る。main に push できる人、GitHub のアカウントを乗っ取った人は、AWS に入れる
- 信頼ポリシーの条件（`sub`）を `*` で広く書くと、他人のリポジトリからも入れてしまう

### 新方式のアカウントでは

新方式（Sign up for AWS (new)）のアカウントでは、AWS が管理する SCP（サービスコントロールポリシー：アカウントでできることの上限を決めるポリシー）が `iam:*Provider*` を禁止している。**ID プロバイダーを作れないので、OIDC は使えない**（「高度な機能」を有効にすると使える。有効化は元に戻せない）。

このプロジェクトでは、デプロイを AWS の中（CodeBuild）で動かすことで、外から入る必要そのものをなくしている。GitHub Actions から OIDC でデプロイする構成は、[付録 E](phase6-appendix.md#e-github-actions-から-oidc-でデプロイする) にまとめた。

---

## 8. デプロイの流れ

パイプライン `statuspage` は、次の順番で進む。

| 順番 | ステージ | すること | なぜ |
|---|---|---|---|
| 1 | Source | main のコミットを GitHub から取ってくる。コミット SHA を変数にする | — |
| 2 | Test | CodeBuild で pytest、`npm test`、`cdk synth` | GitHub Actions の結果は CodePipeline からは見えない。デプロイするコミットを、デプロイの直前にもう一度確かめる |
| 3 | Deploy | アプリのスタックがあるか調べる。なくて `CREATE_APP` が `true` でなければ、ここで終わる | 学習していないときに、課金されるものを勝手に作らない |
| 3 | Deploy | `cdk deploy StatuspageApp -c allowedCidrs=... -c appVersion=<コミット SHA>` | Phase 5 と同じコマンド |

### コミット SHA でバージョンを固定する

インスタンスは、起動するときに GitHub からコードを取ってくる（ユーザーデータ）。

| 取ってくるもの | 起きること |
|---|---|
| `main`（ブランチ名） | 起動した**時刻**によって中身が変わる。デプロイの途中で main に別の変更が入ると、インスタンスごとにバージョンが違うことがある。Auto Scaling が後から足したインスタンスにも、テストしていない新しいコードが入る |
| コミット SHA | どのインスタンスも、いつ起動しても、**テストしたものと同じコード**になる |

- SHA（40文字の16進数）はコミットごとに違うので、デプロイのたびにユーザーデータが変わる。起動テンプレートの新しいバージョンができ、インスタンスが入れ替わる（§9）
- アプリのコードだけを変えても、SHA が変わるので `cdk diff` に差分が出る。Phase 5 の構成では、アプリだけを変えても差分が出ず、動いているインスタンスは古いままだった
- 1度作ったものは変えず、変えるときは新しいものに入れ替える考え方を、**イミュータブル（不変）なインフラ** と言う
- `appVersion` はユーザーデータ（シェルスクリプト）に埋め込まれるので、CDK のコードで「40文字の16進数か `main`」以外を拒否している。好きな文字列を入れられると、スクリプトにコマンドを差し込めてしまう

### デプロイの確認はどこでするか

CodeBuild のマシンは、ALB に入れない（セキュリティグループが自分の IP だけを許可しているため）。だから「新しいインスタンスがちゃんと動いたか」は、インスタンス自身が確かめて CloudFormation に知らせる（§9 の cfn-signal）。

---

## 9. ローリング更新とロールバック

### 起動テンプレートを変えても、動いているインスタンスは変わらない

Auto Scaling グループは、**これから起動する** インスタンスに新しい起動テンプレートを使う。今動いているインスタンスは、そのまま残る（Phase 5 までの弱点）。動いているものを入れ替えるには、入れ替えの方法を決める必要がある。

### ローリング更新

CloudFormation の **UpdatePolicy**（`AutoScalingRollingUpdate`）を付けると、起動テンプレートが変わったときに、インスタンスを少しずつ入れ替える。

| 設定 | 意味 | api | worker |
|---|---|---|---|
| MaxBatchSize | 1回に入れ替える台数 | 1 | 1 |
| MinInstancesInService | 入れ替えの間も動かし続ける最低台数（MaxSize より小さくする） | 2 | 0 |
| WaitOnResourceSignals | 新しいインスタンスから「起動できた」の知らせが来るまで待つ | する | する |
| PauseTime | 知らせを待つ最長時間。過ぎたら失敗 | 10分 | 10分 |

api は「2台を下回らない」ので、新しい1台を足して3台にし、それが動いてから古い1台を消す、を繰り返す。worker は MaxSize が1なので、古い1台を消してから新しい1台を起動する（入れ替えの間、監視が止まる）。

| | 入れ替えの間 |
|---|---|
| 止まる時間 | api は、台数を減らさずに入れ替えるので、止まらない（ALB が動いているインスタンスにだけ送る） |
| バージョン | 古いバージョンと新しいバージョンが、しばらく **混ざる**。どちらで答えても困らないように作る必要がある（DB の形を変えるときなどに注意） |
| 古いインスタンスを消すとき | ALB から外し、登録解除の遅延（Phase 4）の間、処理中のリクエストを終わらせてから消す |

### cfn-signal

**cfn-signal は、インスタンスの中から CloudFormation に「成功した・失敗した」を知らせるコマンド。**

- ユーザーデータの最後で、アプリが起動して `/healthz` が答えたら「成功」を送る
- 途中のコマンドが失敗してスクリプトが止まったら、「失敗」を送る（`trap` で、どこで止まっても必ず送る）
- インスタンスの IAM ロールには、自分のスタックに知らせる権限（`cloudformation:SignalResource`）だけを付ける
- スタックを初めて作るときも、知らせが来るまで「作成完了」にならない（CreationPolicy）

### ロールバック

新しいインスタンスから「失敗」が来た、または PauseTime までに知らせが来なかったら、CloudFormation は更新を**失敗**にし、スタック全体を元に戻す（ロールバック）。

| | 起きること |
|---|---|
| 起動テンプレート | 前のバージョンに戻る |
| 新しく起動したインスタンス | 消される |
| 古いインスタンス | （まだ残っていれば）そのまま動き続ける |
| スタックの状態 | `UPDATE_ROLLBACK_COMPLETE`（更新に失敗し、元に戻した） |
| `cdk deploy` | 失敗として終わる。パイプラインならデプロイの段が失敗になる |

ロールバックは、「テストで見つからない失敗」から本番を守る最後の網になる。ただし、新しいインスタンスの起動スクリプトが「成功」と言ったものは、すべて成功として扱う。何を確かめてから「成功」を送るかが大事になる。

---

## 10. パイプラインをコード化する

手作業で作ったパイプラインを、CDK のスタック `StatuspagePipeline` にする。

| 手作業 | CDK |
|---|---|
| パイプラインを作る | `codepipeline.Pipeline`（`pipelineType: V2`、`executionMode: QUEUED`） |
| ソース（GitHub、接続） | `CodeStarConnectionsSourceAction` |
| トリガーの条件 | パイプラインの `triggers`（ブランチとファイルパス） |
| 変数 `CREATE_APP` | パイプラインの `variables` |
| CodeBuild のプロジェクト | `codebuild.PipelineProject` と `CodeBuildAction` |
| ロールのインラインポリシー | `project.addToRolePolicy(...)` |

手作業にはなかったものも足している。

- テストの段（デプロイの前に、もう一度テストする）
- `statuspage-destroy`（アプリのスタックを消すパイプライン。push では動かず、手で動かして `CONFIRM_DESTROY` を `true` にしたときだけ消す）
- パイプラインの受け渡し用の S3 バケットの、古いファイルを自動で消す設定

### コード化しないもの

| もの | 理由 | コードからの参照 |
|---|---|---|
| 接続 | GitHub での許可は画面で行う必要がある | パラメータストアの `/statuspage/github-connection-arn` から ARN を読む |
| 自分の IP アドレス | 場所によって変わる。公開リポジトリに載せない | パラメータストアの `/statuspage/allowed-cidrs` から読む |

### スタックを分ける理由

| 理由 | 内容 |
|---|---|
| 寿命が違う | 一度作ればずっと使う。アプリのスタックのように毎日消さない |
| 参照がない | ほかのスタックとは関係しない |
| デプロイする人が違う | パイプラインではなく、手元から管理者がデプロイする |

### 手元からデプロイする理由

| 理由 | 内容 |
|---|---|
| 最初の1回 | パイプラインがないうちは、パイプラインでパイプラインを作れない |
| 壊したら直せない | パイプラインを壊す変更（トリガー・ロール・接続の間違い）が入ると、それを直すコミットもパイプラインでは流れない。手元からなら直せる |
| 実行中に自分が変わる | デプロイの途中でパイプライン自身が更新されると、その実行は古い定義のまま止まったり、やり直しになったりする |
| 変更の重さが違う | アプリは頻繁に変わるが、パイプラインの権限や構成はたまにしか変わらず、間違えたときの影響が大きい。人が `cdk diff` を見てから入れる |

ただし、これは **IAM で禁止しているわけではない**。デプロイのロールは CDK のロールを引き受けられ、CDK の deploy-role はどのスタックでも CloudFormation に渡せる（実際に作るのは AdministratorAccess の cfn-exec-role）。main で `deploy.yml` を書き換えれば、`StatuspagePipeline` も変えられる。本当の守りは「main に入るものを絞ること」（[§6](#6-codebuild-とデプロイの権限)）で、IAM でも禁止したいときは、ブートストラップの `--cloudformation-execution-policies` で cfn-exec-role の権限を絞るなどの方法がある。

パイプライン自身も更新する仕組みは CDK Pipelines にある（[付録 F](phase6-appendix.md#f-cdk-pipelines)）。

### 物理名を付ける

パイプラインの名前は `statuspage`・`statuspage-destroy` に固定する。人がコンソールで名前を見て「変更をリリース」を押すので、Phase 5 の「外から名前で探されるものには物理名を付ける」に当たる。

---

## 11. 公開リポジトリで CI/CD を扱う

| 気をつけること | 内容 | 対策 |
|---|---|---|
| GitHub Actions のログは公開 | 公開リポジトリの Actions のログは、GitHub にログインしている人なら誰でも見られる | テストのジョブには秘密を渡さない。デプロイは AWS の中（ログは CloudWatch Logs で非公開） |
| フォークからのプルリクエスト | 他人がフォークして出したプルリクエストでも、GitHub Actions のテストが動く | `pull_request` では、シークレットは渡されない。パイプラインは main への push でしか動かない |
| `pull_request_target` | フォークのプルリクエストでも、シークレットが使える状態で動くイベント | 使わない |
| 他人のプルリクエストのマージ | マージした時点で main に入り、パイプラインでデプロイされる | 中身を読んでからマージする |
| 他人のアクション | `uses:` で使うアクションは他人のコード | 信頼できる発行元のものだけ使い、バージョンを固定する（[付録 D](phase6-appendix.md#d-アクションのバージョンを固定する)） |
| `GITHUB_TOKEN` の権限 | 既定のままだと、リポジトリに書き込めることがある | `permissions:` で必要な分（`contents: read`）だけにする |
| 接続のアプリの範囲 | すべてのリポジトリを許可すると、関係ないリポジトリまで AWS から読める | 使うリポジトリだけを許可する |

---

## 12. 費用

| もの | 料金 |
|---|---|
| GitHub Actions | 公開リポジトリで GitHub のランナー（標準のもの）を使う分は無料。非公開リポジトリは、無料の分（毎月の分数）を超えると有料 |
| CodePipeline（V2） | アクションが動いた時間（分）ごと。動いていない間は0。毎月の無料の分がある |
| CodeBuild | ビルドの時間（分）ごと。マシンの大きさと CPU の種類で単価が変わる（ARM の小さいものは安い） |
| 接続、パラメータストア（標準）、IAM、STS | 無料 |
| S3（アーティファクト）、CloudWatch Logs（ビルドのログ） | 置いた量の分だけ。古いものを自動で消す設定にしておく |
| デプロイ | CloudFormation は無料。入れ替えの間だけ api が1台多く動く（数分ぶん） |
| AWS のリソース | Phase 5 と同じ（[Phase 5 §12](phase5-study.md#12-費用)） |

- `cdk deploy` は、ローリング更新が終わるまで待つので、CodeBuild の時間はデプロイ1回で十数分になる。時間で課金されるので、入れ替えが速いほど安い
- 学習していないとき（アプリのスタックがないとき）に main へ push しても、デプロイは飛ばされる。CI/CD が勝手に課金されるものを作らないようにするのも、設計の一部
- 「毎回の終わり」と「始めるとき」がコンソールのボタンだけでできるので、手元に Node.js や AWS の認証情報がない PC でも続けられる

---

## 13. ほかの Phase とのつながり

### Phase 5 から何が置き換わったか

| Phase 5 | Phase 6 |
|---|---|
| 手元の PC から `cdk deploy` | CodePipeline と CodeBuild が `cdk deploy`（手元からもできる） |
| 自分の強い権限（`aws login`）でデプロイ | デプロイに必要な分だけのロールでデプロイ |
| テストは、思い出したら手元で実行 | プルリクエストで GitHub Actions、デプロイの前にパイプラインで、必ず実行 |
| インスタンスは起動したときの main を取ってくる | テストしたコミットの SHA を取ってくる |
| アプリを変えても、動いているインスタンスは古いまま | ローリング更新で1台ずつ入れ替える。失敗したらロールバック |

### この構成の弱点と、解決する Phase

| 弱点 | 解決 | Phase |
|---|---|---|
| インスタンスを起動するたびに、パッケージと依存を入れている。入れ替えに時間がかかり、外のサービス（GitHub、PyPI）が落ちていると起動できない | ビルド済みのコンテナイメージ（ECR）から起動する。イメージを作るのは CodeBuild の役目になる | 7 |
| デプロイのたびに、仮想マシンを丸ごと作り直している | コンテナだけを入れ替える（ECS のローリング更新） | 7 |
| 「成功」の判断は、起動直後の `/healthz` だけ | デプロイ後のエラー率などをアラームで見て、ロールバックする | 9 |

---

## 14. 理解度チェック

答えは自分で考えてから開く。

<details>
<summary>Q1. CI と CD（継続的デリバリー・継続的デプロイ）の違いは？ このプロジェクトの main への push はどれ？</summary>

CI は変更のたびに自動でテストすること。継続的デリバリーは、いつでもデプロイできる状態を自動で作り、本番に出すのは人が決めること。継続的デプロイは、テストが通ったら人を通さずに本番まで出すこと。main への push は、テストが通れば自動でデプロイするので継続的デプロイ。
</details>

<details>
<summary>Q2. ワークフロー・ジョブ・ステップの関係は？ needs を書かない2つのジョブは、どう動く？</summary>

ワークフローの中に複数のジョブがあり、ジョブの中に順番に動くステップがある。ジョブはそれぞれ別のまっさらなマシンで動く。`needs` を書かないジョブ同士は、同時に動く。
</details>

<details>
<summary>Q3. CI で uv sync --locked や npm ci を使うのはなぜ？</summary>

ロックファイルどおりのバージョンを入れ、ずれていたら失敗させるため。CI と手元と本番で同じライブラリになり、「CI では通ったのに本番で壊れる」「昨日は通ったのに今日は落ちる」を防ぐ。
</details>

<details>
<summary>Q4. CodePipeline・CodeBuild・接続（CodeConnections）は、それぞれ何をする？</summary>

CodePipeline は「ソース → テスト → デプロイ」の流れを管理する。CodeBuild は buildspec に書いた手順を、使い捨てのマシンで動かす。接続は、AWS が GitHub のリポジトリを読み、push を受け取れるようにする。
</details>

<details>
<summary>Q5. GitHub Actions でテストしているのに、パイプラインにもテストの段を置くのはなぜ？</summary>

CodePipeline からは GitHub Actions の結果が見えないので、テストが落ちた変更がマージされても止められない。デプロイするコミットを、デプロイの直前にパイプラインの中でもう一度確かめる。
</details>

<details>
<summary>Q6. デプロイのロールに EC2 や ALB を作る権限を付けていないのに、cdk deploy ができるのはなぜ？ それでも「強い権限」と言えるのはなぜ？</summary>

CDK のブートストラップで作ったロール（deploy-role など）を引き受け、実際の作業はそれらと CloudFormation が行うから。CloudFormation が使う cfn-exec-role は既定で AdministratorAccess なので、テンプレートに書けば何でも作れる。だから、main に入るものを変えられる人を絞る必要がある。
</details>

<details>
<summary>Q7. GitHub Actions から AWS にデプロイするとき、アクセスキーを使う方法と比べて OIDC は何がよい？ このプロジェクトで使わなかったのはなぜ？</summary>

アクセスキーのような長く使える秘密をどこにも保存せず、ジョブごとに一時的な認証情報をもらえる。新方式のアカウントでは、SCP が ID プロバイダーの作成を禁止しているので使えない。代わりに、デプロイを AWS の中の CodeBuild で動かし、IAM ロールを付けることで、外から入る必要をなくした。
</details>

<details>
<summary>Q8. パイプラインの変数 CREATE_APP は何のため？ push で動いたときはどうなる？</summary>

アプリのスタックがないときに作るかどうかを決めるため。push で動いたときはデフォルト値（`false`）なので、スタックがなければデプロイせずに終わる。学習していない日に、課金されるものが勝手に作られない。作るときは「変更をリリース」で `true` にする。
</details>

<details>
<summary>Q9. インスタンスが取ってくるコードを、main ではなくコミット SHA で指定するのはなぜ？</summary>

main は時刻によって中身が変わるので、インスタンスごとに違うバージョンになったり、テストしていないコードが入ったりする。SHA なら、いつ起動してもテストしたものと同じコードになる。SHA が変わるとユーザーデータが変わり、インスタンスの入れ替えのきっかけにもなる。
</details>

<details>
<summary>Q10. 起動テンプレートを変えたとき、UpdatePolicy がないと動いているインスタンスはどうなる？ ローリング更新で、api を2台より減らさずに入れ替えるには？</summary>

そのまま古いものが動き続ける（新しく起動するものだけが新しい起動テンプレートを使う）。MinInstancesInService を2にし、MaxBatchSize を1にする。新しい1台を足して動いてから古い1台を消す、を繰り返す（MaxSize は MinInstancesInService より大きくしておく）。
</details>

<details>
<summary>Q11. 新しいインスタンスの起動に失敗したとき、どうやって元に戻る？ 何が「失敗」の判断になる？</summary>

インスタンスのユーザーデータが cfn-signal で「失敗」を送る（または時間内に「成功」が来ない）と、CloudFormation が更新を失敗にしてロールバックする。起動テンプレートは前のバージョンに戻り、新しいインスタンスは消され、古いインスタンスは動き続ける。判断の材料は、ユーザーデータが何を確かめてから「成功」を送るか（このプロジェクトでは、アプリが起動して `/healthz` が答えること）。
</details>

<details>
<summary>Q12. StatuspagePipeline をパイプライン自身ではなく手元からデプロイするのはなぜ？ 接続と IP アドレスをコードに書かないのはなぜ？</summary>

パイプラインが自分自身をデプロイすると、main に入ったコードでパイプラインのロールの権限を広げられてしまうから。接続は GitHub での許可を画面で行う必要があり、IP アドレスは場所で変わるうえに公開リポジトリに載せたくない。どちらもパラメータストアに置き、コードは名前から値を読む。
</details>

---

## 参考

- [GitHub Docs: Understanding GitHub Actions](https://docs.github.com/en/actions/about-github-actions/understanding-github-actions)
- [GitHub Docs: Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
- [CodePipeline ユーザーガイド: パイプラインの構造](https://docs.aws.amazon.com/ja_jp/codepipeline/latest/userguide/concepts.html)
- [CodePipeline ユーザーガイド: トリガーとフィルター](https://docs.aws.amazon.com/ja_jp/codepipeline/latest/userguide/pipelines-filter.html)
- [CodePipeline ユーザーガイド: 変数](https://docs.aws.amazon.com/ja_jp/codepipeline/latest/userguide/reference-variables.html)
- [CodeBuild ユーザーガイド: buildspec のリファレンス](https://docs.aws.amazon.com/ja_jp/codebuild/latest/userguide/build-spec-ref.html)
- [CodeBuild ユーザーガイド: 使用できるランタイム](https://docs.aws.amazon.com/ja_jp/codebuild/latest/userguide/available-runtimes.html)
- [Developer Tools コンソール: GitHub への接続](https://docs.aws.amazon.com/ja_jp/dtconsole/latest/userguide/connections-create-github.html)
- [Systems Manager パラメータストア](https://docs.aws.amazon.com/ja_jp/systems-manager/latest/userguide/systems-manager-parameter-store.html)
- [新方式のアカウントの管理ポリシー（SCP）](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html)
- [CloudFormation: UpdatePolicy 属性](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatepolicy.html)
- [CloudFormation: cfn-signal](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/cfn-signal.html)
- [AWS CDK: Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)
