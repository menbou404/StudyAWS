# Phase 6 知識まとめ: CI/CD・GitHub Actions・OIDC

> Phase 6 で出てきた知識を体系的にまとめたもの。手順は [phase6-setup.md](phase6-setup.md)。

## 目次

1. [CI/CD とは](#1-cicd-とは)
2. [GitHub Actions の基本](#2-github-actions-の基本)
3. [CI でテストを動かす](#3-ci-でテストを動かす)
4. [OIDC で AWS に入る](#4-oidc-で-aws-に入る)
5. [GitHub Actions 用の IAM ロール](#5-github-actions-用の-iam-ロール)
6. [環境とシークレット](#6-環境とシークレット)
7. [デプロイの流れ](#7-デプロイの流れ)
8. [ローリング更新とロールバック](#8-ローリング更新とロールバック)
9. [OIDC の設定をコード化する](#9-oidc-の設定をコード化する)
10. [公開リポジトリで CI/CD を扱う](#10-公開リポジトリで-cicd-を扱う)
11. [費用](#11-費用)
12. [ほかの Phase とのつながり](#12-ほかの-phase-とのつながり)
13. [理解度チェック](#13-理解度チェック)

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
| どの PC から | 認証情報と道具（Node.js など）がそろった PC だけ | どこからでも（GitHub の画面だけでよい） |
| 何をデプロイしたか | 手元のファイル（コミットしていない変更が混ざることがある） | Git のコミット。記録が残る |
| 権限 | 自分の強い権限で実行する | デプロイに必要な分だけの権限で実行する |
| 手順の間違い | 起こりうる | 毎回同じ手順 |

### このプロジェクトの流れ

| きっかけ | 動くもの |
|---|---|
| プルリクエストを作る・更新する | テスト（app・infra）だけ |
| main に push（マージ）する | テスト → 通ったらデプロイ（アプリのスタックがあるときだけ） |
| 「Run workflow」を押す | テスト → デプロイ（スタックがなければ作る） |
| 「Destroy app」を押す | アプリのスタックを消す |

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
| `permissions:` | このワークフローが使う GitHub のトークン（`GITHUB_TOKEN`）の権限。必要なものだけにする |
| `concurrency:` | 同じグループの実行を同時に動かさない。デプロイが重ならないようにする |
| `${{ secrets.X }}`・`${{ vars.X }}` | シークレット・変数を読む（§6） |

### ランナーは毎回まっさら

- ジョブが終わるとマシンは捨てられる。前回インストールしたものも、ファイルも残らない
- だから、ワークフローには「コードを取ってくる → 道具を入れる → 依存を入れる → 実行する」を毎回すべて書く
- 毎回同じ状態から始まるので、「自分の PC では動く」が起きにくい

---

## 3. CI でテストを動かす

### 何を確かめるか

| ジョブ | 確かめること |
|---|---|
| app のテスト | `uv run pytest`：API と監視ジョブが期待どおりに動くか |
| infra のテスト | `npm test`：CDK のテンプレートが守りたいルール（DB に入れるのは web と worker だけ、など）を満たすか |
| infra の synth | `cdk synth`：CDK のコードからテンプレートを作れるか（AWS には触らない） |

### ロックファイルどおりに入れる

| コマンド | 意味 |
|---|---|
| `uv sync --locked` | `uv.lock` とずれていたら失敗する。勝手に新しいバージョンを入れない |
| `npm ci` | `package-lock.json` どおりに入れる。ずれていたら失敗する |

CI で入れるライブラリが手元と違うと、「CI では通ったのに本番で壊れる」「昨日は通ったのに今日は落ちる」が起きる。ロックファイルどおりに入れれば、誰がいつ実行しても同じになる。

### テストが落ちたら

- `needs:` でつながった後ろのジョブ（デプロイ）は動かない。AWS で動いているものは何も変わらない
- プルリクエストの画面に ✕ が付き、どのテストが落ちたかをログで読める
- ただし、✕ が付いてもマージボタンは押せてしまう。「テストが通らないとマージできない」にするには、ブランチの保護（ルールセット）を設定する（[付録 A](phase6-appendix.md#a-ブランチを保護する)）

### テストで見つからない失敗

テストは「書いたこと」しか確かめない。次のようなものは、CI が通っても本番で起きうる。

- 本番の環境でだけ起きる失敗（パッケージが入らない、設定ファイルがない、DB につながらない）
- テストを書いていない動き

これに備えるのが、デプロイの途中で本物のインスタンスが動くかを確かめて、だめなら元に戻す仕組み（§8）。

---

## 4. OIDC で AWS に入る

### アクセスキーを渡す方法の問題

GitHub Actions から AWS を操作するには、AWS の認証情報が必要になる。昔は、IAM ユーザーのアクセスキーを GitHub のシークレットに入れていた。

| 問題 | 内容 |
|---|---|
| 長く使える | アクセスキーは消すまで有効。漏れたら、気づくまで使われ続ける |
| 漏れる場所が多い | GitHub のシークレット、ログ、手元の PC など |
| 入れ替えが手間 | 定期的に作り直して、シークレットを更新する必要がある |

### OIDC の仕組み

**OIDC（OpenID Connect）は、「ある人（やジョブ）が誰か」を、信頼できる発行元が署名したトークンで証明する仕組み。** GitHub Actions のジョブは、GitHub が署名した「このジョブは、このリポジトリの、この環境のものです」というトークンをもらえる。

| 順番 | 誰が | 何をする |
|---|---|---|
| 1 | AWS（事前に1回） | IAM に「GitHub が署名したトークンを信用する」と登録しておく（ID プロバイダー） |
| 2 | GitHub Actions のジョブ | GitHub から ID トークンをもらう（ワークフローに `permissions: id-token: write` が必要） |
| 3 | ジョブ | トークンを AWS STS に渡して、「このロールを引き受けたい」と頼む（`AssumeRoleWithWebIdentity`） |
| 4 | AWS STS | 署名が GitHub のものか、トークンの中身がロールの信頼ポリシーの条件に合うかを確かめる |
| 5 | AWS STS | 合えば、一時的な認証情報（1時間など）を返す |

- アクセスキーをどこにも保存しない。漏れて困るものが GitHub に置かれない
- 認証情報は一時的で、ジョブが終わればすぐ使えなくなる
- Phase 0 の `aws login` や、Phase 2 の EC2 の IAM ロールと同じく、「一時的な認証情報をもらう」考え方

### トークンの中身

ID トークン（JWT という形式）には、次のような項目（クレーム）が入っている。

| クレーム | 意味 | 例 |
|---|---|---|
| `iss` | 発行元 | `https://token.actions.githubusercontent.com` |
| `aud` | 誰に向けたトークンか | `sts.amazonaws.com` |
| `sub` | 誰か（どのリポジトリの、どのジョブか） | `repo:<owner>/<repo>:environment:aws` |
| `ref` | どのブランチか | `refs/heads/main` |
| `environment` | どの環境か | `aws` |

`sub` の形は、ジョブによって変わる。

| ジョブ | `sub` |
|---|---|
| 環境（`environment:`）を使うジョブ | `repo:<owner>/<repo>:environment:<環境名>` |
| 環境を使わず、ブランチへの push で動いたジョブ | `repo:<owner>/<repo>:ref:refs/heads/<ブランチ名>` |
| プルリクエストで動いたジョブ | `repo:<owner>/<repo>:pull_request` |

環境を使うジョブの `sub` には、ブランチ名が入らない。ブランチを絞るのは GitHub 側の環境の設定（§6）の役目になる。

---

## 5. GitHub Actions 用の IAM ロール

IAM ロールには、2つのポリシーがある（[Phase 2 §6](phase2-study.md#6-iam-ロールと-ec2)）。

| ポリシー | 決めること | GitHub Actions 用のロールでは |
|---|---|---|
| 信頼ポリシー | **誰が**このロールを引き受けられるか | GitHub の ID プロバイダー経由で、`aud` が `sts.amazonaws.com`、`sub` が自分のリポジトリの環境 `aws` のジョブだけ |
| 許可ポリシー | 引き受けた人が**何をできるか** | CDK 用のロールを引き受けること、アプリのスタックがあるか調べることだけ |

### 信頼ポリシーの条件

| 条件 | 書かなかったら |
|---|---|
| `aud` = `sts.amazonaws.com` | AWS 以外に向けたトークンでも通ってしまう |
| `sub` = 自分のリポジトリの環境 `aws` | **GitHub のどのリポジトリのジョブでも**、このロールを引き受けられてしまう |

`sub` に `StringLike` と `*` を使う（`repo:<owner>/*` など）と、絞ったつもりで広く開けてしまうことがある。完全一致（`StringEquals`）にする。

### CDK のロールを引き受ける

`cdk deploy` は、実際の作業を Phase 5 のブートストラップで作ったロールに任せる。

| ロール（名前の一部） | 使われるとき |
|---|---|
| `deploy-role` | CloudFormation にテンプレートを渡して、スタックを作る・変える・消す |
| `file-publishing-role` | テンプレートやファイル（アセット）を S3 に置く |
| `lookup-role` | AZ の一覧など、AWS に問い合わせる（`cdk.context.json` がないとき） |
| `cfn-exec-role` | CloudFormation が実際にリソースを作るときに使う（既定は AdministratorAccess） |

GitHub Actions 用のロールには、EC2 や ALB を作る権限を直接付けない。`deploy-role` などを引き受ける権限だけを付ければ、`cdk deploy` ができる。ブートストラップのロールは、同じアカウントの中から引き受けられるように作られている。

### 気をつけること：実質は強い権限

| 順番 | 権限 |
|---|---|
| GitHub Actions 用のロール | CDK のロールを引き受けるだけ |
| → `deploy-role` | CloudFormation のスタックを操作する |
| → `cfn-exec-role` | **AdministratorAccess**（何でも作れる） |

テンプレートに書けば何でも作れるので、**GitHub Actions からデプロイできる人は、実質的にアカウントの管理者に近い**。だから「誰がデプロイのジョブを動かせるか」を絞ることが大事になる。

- 信頼ポリシーの `sub` で、リポジトリと環境を絞る
- 環境で、デプロイできるブランチを main に絞る（§6）
- main に入るものを、プルリクエストとレビューで絞る（[付録 A](phase6-appendix.md#a-ブランチを保護する)）
- さらに絞るなら、ブートストラップで `cfn-exec-role` に付ける権限を必要な分だけにする

---

## 6. 環境とシークレット

### 値の置き場所

| 置き場所 | 見える範囲 | ログに出ると | 使うもの |
|---|---|---|---|
| ワークフローのファイル | 誰でも（公開リポジトリ） | そのまま出る | 秘密でない設定（リージョンなど） |
| 変数（`vars`） | 設定画面を見られる人 | そのまま出る | 秘密でない値（`DEPLOY_ENABLED` など） |
| リポジトリのシークレット | 誰も値を読めない。リポジトリのすべてのワークフローが使える | `***` に置き換わる | 秘密の値 |
| 環境のシークレット | 誰も値を読めない。**その環境を使うジョブだけ**が使える | `***` に置き換わる | デプロイにだけ使う秘密の値（`AWS_ROLE_ARN`、`ALLOWED_CIDRS`） |

- シークレットの値は、一度保存すると画面からも読めない（上書きだけできる）
- ロールの ARN にはアカウントID が入る。IP アドレスとあわせて、公開リポジトリのファイルやログに出さないためにシークレットに入れる

### 環境

**環境（Environment）は、デプロイ先ごとに「誰が・どのブランチから・どの秘密を使って」デプロイできるかを決める仕組み。** ジョブに `environment: aws` と書くと、その環境のルールが適用される。

| 設定 | 意味 |
|---|---|
| Deployment branches and tags | その環境を使えるブランチ。それ以外のブランチのジョブは、始まる前に止められる |
| Environment secrets | その環境を使うジョブだけが読めるシークレット |
| Required reviewers | 指定した人が承認するまで、ジョブが待つ（[付録 B](phase6-appendix.md#b-承認してからデプロイする)） |

守りは2段になっている。

| 段 | どこで | 何を確かめるか |
|---|---|---|
| 1 | GitHub（環境） | このブランチのジョブが、環境 `aws` を使ってよいか |
| 2 | AWS（信頼ポリシー） | トークンの `sub` が、自分のリポジトリの環境 `aws` か |

AWS 側の `sub` にはブランチ名が入らないので、「main だけ」を守っているのは GitHub 側の環境の設定。環境の設定を消すと、どのブランチからでも AWS に入れてしまう。

### ログでのマスク

- シークレットの値と**完全に同じ文字列**は、ログで `***` に置き換わる。一部分だけ（`a.a.a.a/32,b.b.b.b/32` のうちの `a.a.a.a/32`）は置き換わらない
- ワークフローの中で `echo "::add-mask::値"` を実行すると、その値もマスクの対象にできる。IP アドレスを1つずつマスクするのはこのため
- AWS の認証情報を設定するアクションには、アカウントID をマスクする設定（`mask-aws-account-id`）がある
- 実行してから分かる値（ALB の DNS 名など）は、ログに出る前にマスクできないので、出力を書き換える（`sed` で伏せ字にする）

---

## 7. デプロイの流れ

`deploy` のジョブは、次の順番で進む。

| 順番 | すること | なぜ |
|---|---|---|
| 1 | テストのジョブが両方成功するのを待つ（`needs:`） | 壊れた変更を出さない |
| 2 | 環境 `aws` のルールを確かめる（GitHub） | main 以外からデプロイさせない |
| 3 | コードを取ってくる、Node.js と依存を入れる | ランナーはまっさら |
| 4 | IP アドレスをマスクする | 公開ログに出さない |
| 5 | OIDC で AWS のロールを引き受ける | アクセスキーを使わない |
| 6 | アプリのスタックがあるか調べる。push で動いていてスタックがなければ、ここで終わる | 学習していないときに、課金されるものを勝手に作らない |
| 7 | `cdk deploy StatuspageApp -c allowedCidrs=... -c appVersion=<コミット SHA>` | Phase 5 と同じコマンド |

### コミット SHA でバージョンを固定する

インスタンスは、起動するときに GitHub からコードを取ってくる（ユーザーデータ）。

| 取ってくるもの | 起きること |
|---|---|
| `main`（ブランチ名） | 起動した**時刻**によって中身が変わる。デプロイの途中で main に別の変更が入ると、インスタンスごとにバージョンが違うことがある。Auto Scaling が後から足したインスタンスにも、テストしていない新しいコードが入る |
| コミット SHA | どのインスタンスも、いつ起動しても、**テストしたものと同じコード**になる |

- SHA（40文字の16進数）はコミットごとに違うので、デプロイのたびにユーザーデータが変わる。起動テンプレートの新しいバージョンができ、インスタンスが入れ替わる（§8）
- 1度作ったものは変えず、変えるときは新しいものに入れ替える考え方を、**イミュータブル（不変）なインフラ** と言う
- `appVersion` はユーザーデータ（シェルスクリプト）に埋め込まれるので、CDK のコードで「40文字の16進数か `main`」以外を拒否している。好きな文字列を入れられると、スクリプトにコマンドを差し込めてしまう

### デプロイの確認はどこでするか

GitHub Actions のマシンは、ALB に入れない（セキュリティグループが自分の IP だけを許可しているため）。だから「新しいインスタンスがちゃんと動いたか」は、インスタンス自身が確かめて CloudFormation に知らせる（§8 の cfn-signal）。

---

## 8. ローリング更新とロールバック

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
| `cdk deploy` | 失敗として終わる |

ロールバックは、「テストで見つからない失敗」から本番を守る最後の網になる。ただし、新しいインスタンスの起動スクリプトが「成功」と言ったものは、すべて成功として扱う。何を確かめてから「成功」を送るかが大事になる。

---

## 9. OIDC の設定をコード化する

手作業で作った ID プロバイダーとロールを、CDK のスタック `StatuspageGithub` にする。

| 手作業 | CDK |
|---|---|
| ID プロバイダーを追加 | `iam.OidcProviderNative`（CloudFormation の `AWS::IAM::OIDCProvider` をそのまま使う L2） |
| ロールの信頼ポリシー | `iam.WebIdentityPrincipal` と、`aud`・`sub` の条件 |
| インラインポリシー | `role.addToPolicy(...)` |

### スタックを分ける理由

| 理由 | 内容 |
|---|---|
| 寿命が違う | 一度作ればずっと使う。アプリのスタックのように毎日消さない |
| 参照がない | ほかのスタックとは関係しない |
| デプロイする人が違う | GitHub Actions ではなく、手元から管理者がデプロイする |

### 手元からデプロイする理由

GitHub Actions に `StatuspageGithub` をデプロイさせると、ワークフローを書き換えれば「GitHub Actions 用のロールの権限を、GitHub Actions 自身が広げる」ことができてしまう。自分の権限を決めるものは、自分では変えられないようにしておく。

### 物理名を付ける

ロールの名前は `statuspage-github-deploy` に固定する。GitHub のシークレット `AWS_ROLE_ARN` が名前（ARN）で探すので、Phase 5 の「外から名前で探されるものには物理名を付ける」に当たる。作り直しても ARN が変わらず、シークレットを更新しなくてよい。

---

## 10. 公開リポジトリで CI/CD を扱う

| 気をつけること | 内容 | 対策 |
|---|---|---|
| ログは誰でも見られる | 公開リポジトリの Actions のログは、GitHub にログインしている人なら誰でも見られる | 秘密はシークレットに。シークレットの一部や、実行後に分かる値は自分でマスクする |
| フォークからのプルリクエスト | 他人がフォークして出したプルリクエストでもワークフローが動く | `pull_request` では、シークレットと OIDC のトークンは渡されない。デプロイは環境 `aws` で main に絞る |
| `pull_request_target` | フォークのプルリクエストでも、シークレットが使える状態で動くイベント | 使わない。使うなら、プルリクエストのコードを取ってきて実行しない |
| 他人のアクション | `uses:` で使うアクションは他人のコード。中身が変わると、シークレットを盗まれることがある | 信頼できる発行元のものだけ使う。バージョンを固定する（[付録 D](phase6-appendix.md#d-アクションのバージョンを固定する)） |
| `GITHUB_TOKEN` の権限 | 既定のままだと、リポジトリに書き込めることがある | `permissions:` で必要な分（`contents: read` など）だけにする |

---

## 11. 費用

| もの | 料金 |
|---|---|
| GitHub Actions | 公開リポジトリで GitHub のランナー（標準のもの）を使う分は無料。非公開リポジトリは、無料の分（毎月の分数）を超えると有料 |
| IAM の ID プロバイダー・ロール、STS | 無料 |
| デプロイ | CloudFormation は無料。入れ替えの間だけ api が1台多く動く（数分ぶん） |
| AWS のリソース | Phase 5 と同じ（[Phase 5 §12](phase5-study.md#12-費用)） |

- 学習していないとき（アプリのスタックがないとき）に main へ push しても、デプロイは飛ばされる。CI/CD が勝手に課金されるものを作らないようにするのも、設計の一部
- 「毎回の終わり」と「始めるとき」が GitHub の画面だけでできるので、手元に Node.js や AWS の認証情報がない PC でも続けられる（RDS の開始・停止はコンソール）

---

## 12. ほかの Phase とのつながり

### Phase 5 から何が置き換わったか

| Phase 5 | Phase 6 |
|---|---|
| 手元の PC から `cdk deploy` | GitHub Actions が `cdk deploy`（手元からもできる） |
| 自分の強い権限（`aws login`）でデプロイ | OIDC で、デプロイに必要な分だけのロールでデプロイ |
| テストは、思い出したら手元で実行 | プルリクエストと main への push で、必ず実行 |
| インスタンスは起動したときの main を取ってくる | テストしたコミットの SHA を取ってくる |
| アプリを変えても、動いているインスタンスは古いまま | ローリング更新で1台ずつ入れ替える。失敗したらロールバック |

### この構成の弱点と、解決する Phase

| 弱点 | 解決 | Phase |
|---|---|---|
| インスタンスを起動するたびに、パッケージと依存を入れている。入れ替えに時間がかかり、外のサービス（GitHub、PyPI）が落ちていると起動できない | ビルド済みのコンテナイメージ（ECR）から起動する | 7 |
| デプロイのたびに、仮想マシンを丸ごと作り直している | コンテナだけを入れ替える（ECS のローリング更新） | 7 |
| 「成功」の判断は、起動直後の `/healthz` だけ | デプロイ後のエラー率などをアラームで見て、ロールバックする | 9 |

---

## 13. 理解度チェック

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
<summary>Q4. GitHub Actions にアクセスキーを渡す方法と比べて、OIDC は何がよい？</summary>

アクセスキーのような長く使える秘密をどこにも保存しないので、漏れて困るものがない。ジョブごとに一時的な認証情報をもらい、ジョブが終われば使えなくなる。入れ替えの手間もない。
</details>

<details>
<summary>Q5. 信頼ポリシーの sub の条件を書き忘れると、何が起きる？</summary>

GitHub の、ほかの人のリポジトリのジョブでも、このロールを引き受けられてしまう。`aud` は GitHub Actions 全体で同じなので、`aud` だけでは絞れない。
</details>

<details>
<summary>Q6. GitHub Actions 用のロールに EC2 や ALB を作る権限を付けていないのに、cdk deploy ができるのはなぜ？ それでも「強い権限」と言えるのはなぜ？</summary>

CDK のブートストラップで作ったロール（deploy-role など）を引き受け、実際の作業はそれらと CloudFormation が行うから。CloudFormation が使う cfn-exec-role は既定で AdministratorAccess なので、テンプレートに書けば何でも作れる。だから、デプロイのジョブを動かせる人を絞る必要がある。
</details>

<details>
<summary>Q7. 環境（Environment）の「Deployment branches」の設定がないと、何が起きる？</summary>

main 以外のブランチのジョブも環境 `aws` を使えるので、環境のシークレットを読め、OIDC で AWS に入れる。信頼ポリシーの `sub`（`environment:aws`）にはブランチ名が入らないので、AWS 側では止められない。
</details>

<details>
<summary>Q8. シークレットに入れた値は、ログに出ても必ず隠される？</summary>

値と完全に同じ文字列だけが `***` に置き換わる。一部分だけ（カンマ区切りの1つ目など）や、加工した値は隠されない。必要なら `::add-mask::` で自分でマスクする。実行してから分かる値も、自分で伏せ字にする。
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
<summary>Q12. 公開リポジトリで、フォークからのプルリクエストがデプロイできないのはなぜ？</summary>

`pull_request` のイベントでは、フォークからのジョブにシークレットと OIDC のトークンが渡されない。さらに、デプロイのジョブはプルリクエストでは動かず、環境 `aws` は main ブランチだけが使える。
</details>

---

## 参考

- [GitHub Docs: Understanding GitHub Actions](https://docs.github.com/en/actions/about-github-actions/understanding-github-actions)
- [GitHub Docs: Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)
- [GitHub Docs: About security hardening with OpenID Connect](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [GitHub Docs: Configuring OpenID Connect in Amazon Web Services](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [GitHub Docs: Managing environments for deployment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment)
- [GitHub Docs: Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
- [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
- [IAM ユーザーガイド: OpenID Connect（OIDC）フェデレーション](https://docs.aws.amazon.com/ja_jp/IAM/latest/UserGuide/id_roles_providers_create_oidc.html)
- [CloudFormation: UpdatePolicy 属性](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatepolicy.html)
- [CloudFormation: cfn-signal](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/cfn-signal.html)
- [AWS CDK: Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)
