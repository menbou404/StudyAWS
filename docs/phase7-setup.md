# Phase 7 手順書: コンテナで動かす（ECR + ECS Fargate）

> api と worker を、EC2 ではなくコンテナ（ECS の Fargate）で動かす。イメージはパイプラインが1回だけ作って ECR に置き、デプロイではそのイメージを使う。
> 先にコンソールの手作業でタスクを1つ動かし、そのあと CDK とパイプラインに組み込む。
> 仕組みの解説は [phase7-study.md](phase7-study.md)、EC2 起動タイプやブルー/グリーンなどは [phase7-appendix.md](phase7-appendix.md)。

## ゴール

- コンテナイメージを ARM 用に作り、ECR に置ける
- タスク定義・タスク・サービスの違いを説明でき、コンソールでタスクを動かせる
- タスク実行ロールとタスクロールを区別し、パスワードを `secrets` で渡せる
- ECS のサービスのローリング更新とサーキットブレーカーで、何が止まり、何が残るかを説明できる
- パイプラインにイメージのビルドの段を足し、Phase 6 と同じ流れ（push → テスト → デプロイ）で ECS にデプロイできる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| 手元 | Docker（Phase 1）、AWS CLI（`aws login --profile study`）、Node.js（`infra/`） |
| イメージの置き場所 | ECR のリポジトリ（手作業は `statuspage-manual`、CDK は `statuspage`） |
| 動かす場所 | ECS の Fargate、Linux / ARM64、タスク1個あたり 0.25 vCPU・0.5 GB |
| ネットワーク | Phase 5 の VPC（`StatuspageNetwork`）のパブリックサブネット。タスクにパブリック IP を付ける（NAT ゲートウェイなし） |
| ログ | CloudWatch Logs（保存は1週間） |
| CI/CD | Phase 6 のパイプライン `statuspage` に、ビルドの段を足す |

### 作るもの

| 場所 | もの | 作り方 |
|---|---|---|
| AWS | ECR のリポジトリ `statuspage-manual`、ECS のクラスター `statuspage-manual`、タスク定義 `statuspage-manual`、タスク用の SG、タスク実行ロール | 手順2〜5で手作業 → 手順6で消す |
| AWS | ECR のリポジトリ `statuspage` | 手順7で CDK（新しいスタック `StatuspageRegistry`） |
| AWS | ALB、ECS のクラスター・サービス（api・worker）・タスク定義、ロググループ | 手順7で CDK（`StatuspageApp` の中身を EC2 から ECS に置き換える） |
| AWS | パイプライン `statuspage` のビルドの段 | 手順7で CDK（`StatuspagePipeline`） |

### Phase 6 から変わるコード

| ファイル | 変わること |
|---|---|
| `app/statuspage/config.py` | `DATABASE_URL` がないとき、`DB_HOST`・`DB_PASSWORD` などの部品から接続先を組み立てる（ECS の `secrets` でパスワードだけを渡すため） |
| `app/statuspage/api.py` | 応答に `X-Served-By`（ホスト名）を付ける。nginx がなくても、どのタスクが答えたかが分かる |
| `app/Dockerfile` | ベースイメージを ECR Public から取る。uvicorn の keep-alive を ALB より長くする |
| `deploy/ec2/statuspage.nginx.conf` | アプリの `X-Served-By` を隠し、nginx の値だけを返す（Phase 2〜6 の手順のため） |
| `.github/workflows/ci.yml` | イメージを作れるかを確かめるジョブを足す（ARM のランナー） |
| `deploy/codebuild/build.yml` | 新規。イメージを作り、コミット SHA のタグで ECR に push する |
| `infra/lib/registry-stack.ts` | 新規。ECR のリポジトリ（スタック `StatuspageRegistry`） |
| `infra/lib/app-stack.ts` | Auto Scaling グループ・起動テンプレートをやめ、ECS のサービス（Fargate）にする |
| `infra/lib/pipeline-stack.ts` | テストとデプロイの間に、ビルドの段を足す |

- `deploy/ec2/` のユーザーデータや systemd の設定は、Phase 2〜6 の手順で使うので残す
- デプロイで `-c appVersion=<コミット SHA>` を渡すのは Phase 6 と同じ。Phase 7 では、その SHA を **イメージのタグ** として使う
- `appVersion` を指定しないと `main` になる。`main` というタグのイメージは作らないので、手元から `cdk deploy StatuspageApp` するときは必ず SHA を渡す

### 費用（目安）

| 場面 | 動いているもの | 料金 |
|---|---|---|
| 手作業（手順2〜5） | タスク1個（パブリック IP 付き）、RDS | 約 $0.04 / 時間 |
| CDK（手順7〜10） | ALB、タスク3個（api 2・worker 1、パブリック IP 付き）、RDS | 約 $0.12 / 時間（Phase 5・6 とほぼ同じ） |
| ECR | 置いたイメージの量。1個 0.1〜0.2 GB ほど、古いものは自動で消す | 月に数十円以下 |
| CodeBuild | ビルドの段が増える分（イメージを作る数分） | デプロイ1回で数円〜十数円 |
| CloudWatch Logs | ログの量。1週間で消す | ほぼ0 |

- 課金されるものを作る手順（手順4・5・7）の前に、構成と費用をもう一度確かめる
- 手作業のものは、手順6で忘れずに消す。消し忘れると、ECS のサービスがタスクを動かし続ける

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 コンテナとオーケストレーション](phase7-study.md#1-コンテナとオーケストレーション)：全体
>
> 読んだら考える：Phase 6 の実験A で、EC2 の入れ替えに時間がかかったのはなぜか。Auto Scaling グループ・起動テンプレート・ユーザーデータ・systemd は、ECS ではそれぞれ何に代わるか

1. `git pull` して、`infra/lib/registry-stack.ts` と `deploy/codebuild/build.yml` があることを確認する
2. Docker が動いていることを確認する（`docker version`）
3. Budgets の月次コスト予算と、クレジットの残高を確認する
4. Phase 6 の手順13の状態か確認する（`StatuspageApp` がない、RDS が停止）
5. RDS：`statuspage-db` を「開始」し、「利用可能」になるまで待つ（手順4から使う）

- [ ] 完了

## 1. イメージを ARM 用に作る

> 📖 **先に読む**
> - [study §2 コンテナイメージと ECR](phase7-study.md#2-コンテナイメージと-ecr)：「プラットフォーム（CPU の種類）」「ベースイメージの取得元」
>
> 読んだら考える：Fargate の ARM で動かすイメージを、Intel の PC で作るとどうなるか

1. リポジトリ直下で、Phase 1 と同じように 3つのコンテナを動かし、`http://localhost:8000/healthz` に `X-Served-By` が付くことを確かめる。確かめたら止める

```bash
docker compose up --build -d
curl -i http://localhost:8000/healthz
docker compose down
```

（Windows の PowerShell では `curl` の代わりに `curl.exe` を使う）

2. ARM 用のイメージを作り、アーキテクチャを確かめる

```bash
docker build --platform linux/arm64 -t statuspage:local app
docker image inspect statuspage:local --format "{{.Architecture}}"
```

- `--platform linux/arm64` は「ARM の Linux で動くイメージを作る」という指定。Apple シリコンの Mac ではそのまま作れる。Intel・AMD の PC では Docker がエミュレーションで作るので、数分かかる
- イメージの大きさは `docker image ls statuspage` で見られる

- [ ] 完了

## 2. ECR にイメージを置く（手作業）

> 📖 **先に読む**
> - [study §2 コンテナイメージと ECR](phase7-study.md#2-コンテナイメージと-ecr)：「レジストリ」「タグ」「ECR の設定」
>
> 読んだら考える：タグに `latest` ではなくコミット SHA を使い、同じタグの上書きを禁止するのはなぜか

1. コンソールで「Elastic Container Registry」→「プライベートリポジトリ」→「リポジトリを作成」
   - リポジトリ名：`statuspage-manual`
   - イメージタグのミュータビリティ：**Immutable**（不変）
   - 暗号化：既定（AES-256）
2. 左メニューの「プライベートレジストリ」→「機能と設定」→「スキャン」で、基本スキャンの「プッシュ時にスキャン」が有効か確かめる
3. 手元から ECR にログインし、手順1のイメージにタグを付けて push する

macOS：

```bash
export AWS_PROFILE=study AWS_REGION=ap-southeast-2
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.ap-southeast-2.amazonaws.com"
TAG=$(git rev-parse HEAD)
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
docker tag statuspage:local "$REGISTRY/statuspage-manual:$TAG"
docker push "$REGISTRY/statuspage-manual:$TAG"
```

Windows（PowerShell）：

```powershell
$env:AWS_PROFILE = "study"; $env:AWS_REGION = "ap-southeast-2"
$account = aws sts get-caller-identity --query Account --output text
$registry = "$account.dkr.ecr.ap-southeast-2.amazonaws.com"
$tag = git rev-parse HEAD
aws ecr get-login-password | docker login --username AWS --password-stdin $registry
docker tag statuspage:local "$registry/statuspage-manual:$tag"
docker push "$registry/statuspage-manual:$tag"
```

4. コンソールでリポジトリを開き、タグがコミット SHA のイメージがあること、スキャンの結果を見る
5. もう一度同じ `docker push` をする。次に、別のイメージに同じタグを付けて push してみる（例：`docker build --platform linux/arm64 --no-cache -t statuspage:local app` で作り直してから、手順3の `docker tag` と `docker push`）

- イメージの URI（`<アカウントID>.dkr.ecr.ap-southeast-2.amazonaws.com/statuspage-manual:<SHA>`）は手順3で使う。アカウントID が入るので、チャットやリポジトリには貼らない
- `aws ecr get-login-password` は、12時間有効な一時的なパスワードを出す。それを `docker login` に渡している（画面には表示しない）

考えること：

- 手順5の2回の push は、それぞれどうなったか。それはなぜか

- [ ] 完了

## 3. タスク定義を作る（手作業）

> 📖 **先に読む**
> - [study §3 ECS の部品](phase7-study.md#3-ecs-の部品)：全体
> - [study §4 Fargate](phase7-study.md#4-fargate)：「CPU とメモリ」
> - [study §6 タスクの2つのロールと秘密](phase7-study.md#6-タスクの2つのロールと秘密)：全体
>
> 読んだら考える：DB のパスワードを読むのは、タスク実行ロールとタスクロールのどちらか。パスワードを「環境変数（値）」に直接書かないのはなぜか

1. 手元で、RDS のエンドポイントと、シークレットの ARN を調べる（次の画面に貼る。チャットやリポジトリには貼らない）

```bash
aws rds describe-db-instances --db-instance-identifier statuspage-db --profile study --query "DBInstances[0].Endpoint.Address" --output text
aws secretsmanager describe-secret --secret-id statuspage/db-app --profile study --query ARN --output text
```

2. コンソールで「Elastic Container Service」→「タスク定義」→「新しいタスク定義の作成」

| 項目 | 値 |
|---|---|
| タスク定義ファミリー | `statuspage-manual` |
| 起動タイプ | AWS Fargate |
| オペレーティングシステム/アーキテクチャ | Linux/ARM64 |
| CPU・メモリ | .25 vCPU・.5 GB |
| タスクロール | なし |
| タスク実行ロール | 新しいロールの作成（`ecsTaskExecutionRole` が作られる） |

3. 「コンテナ - 1」

| 項目 | 値 |
|---|---|
| 名前 | `api` |
| イメージ URI | 手順2のイメージの URI |
| 必須コンテナ | はい |
| ポートマッピング | 8000、TCP、HTTP |

4. 「環境変数」に3つ足す

| キー | 値のタイプ | 値 |
|---|---|---|
| `APP_VERSION` | Value | 手順2の `TAG`（コミット SHA） |
| `DB_HOST` | Value | 手順1の RDS のエンドポイント |
| `DB_PASSWORD` | **ValueFrom** | 手順1のシークレットの ARN |

5. 「ログ収集」が有効（Amazon CloudWatch）になっていることを確かめて、「作成」
6. IAM →「ロール」→ `ecsTaskExecutionRole` →「許可を追加」→「インラインポリシーを作成」→ JSON に次を貼り、名前 `read-statuspage-secret` で作成する（`<アカウントID>` は自分のものに置き換える）

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-southeast-2:<アカウントID>:secret:statuspage/db-app-*"
    }
  ]
}
```

- `ecsTaskExecutionRole` には、最初から AWS 管理ポリシー `AmazonECSTaskExecutionRolePolicy`（ECR からの取得とログの書き込み）が付いている。シークレットを読む許可はないので、自分で足す
- シークレットの ARN の最後には、AWS が付けたランダムな6文字が付く。ポリシーでは `-*` で受ける
- タスク定義の「JSON」タブを開き、`DB_PASSWORD` が `secrets` の中に ARN だけで入っていることを確かめる

- [ ] 完了

## 4. タスクを1つ動かす（手作業）

> 📖 **先に読む**
> - [study §5 タスクのネットワーク](phase7-study.md#5-タスクのネットワーク)：全体
> - [study §7 ログ](phase7-study.md#7-ログ)：全体
>
> 読んだら考える：NAT ゲートウェイがない VPC で、タスクが ECR からイメージを取れるのはなぜか。パブリック IP を付け忘れたらどうなるか

課金：タスク1個とパブリック IP（約 $0.02 / 時間）。

1. EC2 →「セキュリティグループ」→「セキュリティグループを作成」
   - 名前：`statuspage-manual-task`、VPC：`StatuspageNetwork/Vpc`
   - インバウンド：カスタム TCP、ポート 8000、ソース「マイ IP」
2. 説明が `statuspage db` のセキュリティグループを開き、インバウンドに「PostgreSQL（5432）、ソース `statuspage-manual-task`」を足す（手順6で必ず消す）
3. ECS →「クラスター」→「クラスターの作成」：名前 `statuspage-manual`、インフラストラクチャ「AWS Fargate（サーバーレス）」だけ
4. クラスターを開き、「タスク」タブ →「新しいタスクを実行」

| 項目 | 値 |
|---|---|
| コンピューティングオプション | 起動タイプ、Fargate、プラットフォームのバージョン LATEST |
| アプリケーションタイプ | タスク |
| タスク定義 | `statuspage-manual`（最新のリビジョン） |
| 必要なタスク | 1 |
| VPC | `StatuspageNetwork/Vpc` |
| サブネット | public の2つだけ |
| セキュリティグループ | 既存の `statuspage-manual-task` だけ（既定の SG は外す） |
| パブリック IP | **オン** |

5. タスクの「最後のステータス」が `PENDING` →（`ACTIVATING`）→ `RUNNING` になるのを見る
6. タスクを開き、「パブリック IP」を調べて、手元から確かめる

```bash
curl -i http://<タスクのパブリック IP>:8000/healthz
```

7. ブラウザで `http://<タスクのパブリック IP>:8000/` を開き、Phase 6 までの監視対象と記録が表示されることを確認する
8. タスクの「ログ」タブと、CloudWatch →「ロググループ」→ `/ecs/statuspage-manual` を見る

- タスクは、自分のプライベート IP とパブリック IP、セキュリティグループを持つ（EC2 のインスタンスと同じ扱い）
- うまく起動しないときは、止まったタスクの「停止理由」と「ログ」を見る（study §7 の表）

- [ ] 完了

## 5. 実験A：タスクとサービス

> 📖 **実験のあとに読む**
> - [study §3 ECS の部品](phase7-study.md#3-ecs-の部品)：「タスクとサービスの違い」

予想してから実行する。

1. 手順4のタスクを「停止」する。しばらくクラスターの「タスク」タブを見る
2. クラスターの「サービス」タブ →「作成」

| 項目 | 値 |
|---|---|
| コンピューティングオプション | 起動タイプ、Fargate |
| アプリケーションタイプ | サービス |
| タスク定義 | `statuspage-manual` |
| サービス名 | `statuspage-manual-api` |
| 必要なタスク | 1 |
| ネットワーキング | 手順4と同じ（public の2つ、`statuspage-manual-task`、パブリック IP オン） |
| ロードバランシング | なし |

3. タスクが `RUNNING` になったら、そのパブリック IP で `/healthz` を確かめる
4. そのタスクを「停止」する。サービスの「タスク」タブと「イベント」タブを見る
5. 新しいタスクがあれば、そのパブリック IP と `X-Served-By` を手順3と比べる

考えること：

- 手順1と手順4で、止めたあとに起きたことはどう違ったか。それはなぜか
- 新しいタスクの IP アドレスは、前と同じだったか。ALB がないと何が困るか（手順7で ALB の後ろに置く理由）
- Phase 4 の Auto Scaling グループで、インスタンスを止めたときと比べて、戻るまでの時間はどうだったか

- [ ] 完了

## 6. 手作業の片付け

> 📖 **先に読む**
> - [study §10 パイプラインでイメージを作る](phase7-study.md#10-パイプラインでイメージを作る)：「スタックの分け方」
>
> 読んだら考える：ECR のリポジトリを、`StatuspageApp` ではなく別のスタック `StatuspageRegistry` に置くのはなぜか

手作業で作ったものを、作ったのと逆の順で消す。

1. ECS → クラスター `statuspage-manual` → サービス `statuspage-manual-api` →「サービスを削除」（「強制削除」にチェック）。タスクがなくなるまで待つ
2. クラスター `statuspage-manual` →「クラスターの削除」
3. 「タスク定義」→ `statuspage-manual` → すべてのリビジョンを「登録解除」→「削除」
4. EC2 → 説明が `statuspage db` のセキュリティグループから、手順4-2で足したインバウンドルールを消す
5. セキュリティグループ `statuspage-manual-task` を削除
6. ECR → リポジトリ `statuspage-manual` を削除（中のイメージも消える）
7. CloudWatch →「ロググループ」→ `/ecs/statuspage-manual` を削除
8. IAM →「ロール」→ `ecsTaskExecutionRole` を削除（手順7からは CDK が自分のロールを作る）

- 4 を忘れると、CDK が管理している DB の SG に、手で足したルールが残る（CDK の知らない変更）
- RDS は手順7で使うので、止めない

- [ ] 完了

## 7. CDK とパイプラインに組み込む

> 📖 **先に読む**
> - [study §8 サービスのデプロイ](phase7-study.md#8-サービスのデプロイ)：「ローリング更新」「健康かどうかの判断」
> - [study §10 パイプラインでイメージを作る](phase7-study.md#10-パイプラインでイメージを作る)：全体
>
> 読んだら考える：ビルドの段で、同じコミット SHA のイメージが ECR にもうあるときは作らないのはなぜか

1. コードを読み、手順2〜5の手作業のどれに当たるかを対応させる

| ファイル | 読むところ |
|---|---|
| `infra/lib/registry-stack.ts` | 手順2のリポジトリの設定（タグの不変、スキャン、古いイメージの削除） |
| `infra/lib/app-stack.ts` | 手順3のタスク定義（api と worker の2つ）、手順4のネットワークと SG、手順5のサービス。手作業になかった ALB とデプロイの設定 |
| `infra/lib/pipeline-stack.ts`・`deploy/codebuild/build.yml` | ビルドの段。手順2の `docker login`・`build`・`push` |

2. `infra/` の中で、リポジトリとパイプラインを手元からデプロイする

```bash
npm ci
npx cdk diff StatuspageRegistry StatuspagePipeline --profile study
npx cdk deploy StatuspageRegistry StatuspagePipeline --profile study
```

3. パラメータストアの `/statuspage/allowed-cidrs` が、今の自分の IP アドレスか確かめる（Phase 6 手順4）
4. 「CodePipeline」→ `statuspage` →「変更をリリース」。変数 `CREATE_APP` を `true` にして実行する
5. ビルドの段の CodeBuild のログで、`docker build` と `docker push` を見る。終わったら、ECR の `statuspage` にコミット SHA のタグのイメージがあることを確かめる
6. デプロイが終わったら、Phase 6 と同じように ALB の DNS 名を調べて、`/healthz` を確かめる

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

7. ECS → クラスターを開き、サービス2つ（api・worker）、タスクの数、タスク定義のリビジョン、「デプロイ」タブを見る
8. EC2 →「ターゲットグループ」→ api のターゲットグループを開き、ターゲットが IP アドレスで登録されていることを確かめる

- `/healthz` を何回か叩くと、`X-Served-By` が2種類出る（api のタスク2個）
- パイプラインの更新のあとに `statuspage` が自動で動いても、`StatuspageApp` がなければデプロイはスキップされる（Phase 6 と同じ）

考えること：

- Phase 6 の初めてのデプロイ（EC2）と比べて、デプロイの段の時間はどう変わったか。ビルドの段の時間を足すとどうか

- [ ] 完了

## 8. 実験B：アプリを変えて、自動でデプロイする

> 📖 **実験のあとに読む**
> - [study §8 サービスのデプロイ](phase7-study.md#8-サービスのデプロイ)：「ローリング更新」「ALB との受け渡し」「keep-alive のタイムアウト」

予想してから実行する（Phase 6 の実験A と同じ流れ）。

1. 別のターミナルで、`/healthz` を2秒ごとに見続ける（Phase 6 手順8-1 と同じコマンド）

macOS：

```bash
while true; do r=$(curl -s -m 2 -i "http://$ALB/healthz" | grep -iE 'x-served-by|status' | tr -d '\r' | tr '\n' ' '); echo "$(date +%T) ${r:-ERROR（応答なし）}"; sleep 2; done
```

Windows（PowerShell）：

```powershell
while ($true) { try { $r = Invoke-WebRequest "http://$alb/healthz" -TimeoutSec 2; "$(Get-Date -Format T) $($r.Headers['X-Served-By']) $($r.Content)" } catch { "$(Get-Date -Format T) ERROR" }; Start-Sleep 2 }
```

2. ブランチを作り、`app/statuspage/templates/index.html` の `<h1>` の文字を変えて push し、プルリクエストを作る

```bash
git switch -c change-title-ecs
git commit -am "Phase 7: 実験B 見出しを変える"
git push -u origin change-title-ecs
```

3. GitHub Actions のテスト（イメージのビルドを含む）が通ったら、マージする
4. 手順1のターミナル、ECS のサービスの「デプロイ」「タスク」「イベント」タブ、CloudFormation の「イベント」タブを見る
5. 終わったらブラウザで見出しを確かめ、手元を main に戻してブランチを消す

```bash
git switch main
git pull
git push origin --delete change-title-ecs
git branch -D change-title-ecs
```

考えること：

- api のタスクは、何個ずつ、どの順番で入れ替わったか。一番多いとき、何個動いていたか。worker はどうか
- 入れ替えの途中で、`/healthz` が答えなくなった時間はあったか。古いバージョンと新しいバージョンが混ざった時間はあったか
- マージしてから入れ替えが終わるまで、何分かかったか。Phase 6 の実験A と比べて、どの段が速く・遅くなったか

- [ ] 完了

## 9. 実験C：存在しないイメージをデプロイする

> 📖 **実験のあとに読む**
> - [study §8 サービスのデプロイ](phase7-study.md#8-サービスのデプロイ)：「デプロイのサーキットブレーカー」
> - [study §7 ログ](phase7-study.md#7-ログ)：「止まったタスクの理由」

予想してから実行する（Phase 6 の実験C と同じ流れ）。ECR にないタグ（存在しないコミット SHA）を、手元から直接デプロイする。

1. 手順8-1 と同じように、`/healthz` を見続ける
2. `infra/` の中でデプロイする

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

3. ECS のサービス（api・worker）の「デプロイ」「イベント」タブ、止まったタスクの「停止理由」、CloudFormation の「イベント」タブを見る
4. スタックが最後にどの状態になったか、動いているタスクのバージョンを確かめる

考えること：

- 失敗はどこで、何によって分かったか。Phase 6 の実験C（cfn-signal）と比べて、誰が失敗を判断したか
- `/healthz` が答えなくなった時間はあったか。worker はどうなったか
- 失敗が分かるまで、どれくらいかかったか。そのあと、何が元に戻ったか
- 止まったタスクのログは読めたか。Phase 6 の実験C と比べてどうか

- [ ] 完了

## 10. 実験D：タスクを止める

> 📖 **実験のあとに読む**
> - [study §9 タスクの止まり方](phase7-study.md#9-タスクの止まり方)：全体

予想してから実行する。

1. 手順8-1 と同じように、`/healthz` を見続ける
2. ECS → api のサービスの「タスク」タブで、タスクを1個選んで「停止」する
3. worker のサービスのタスクも「停止」する
4. CloudWatch Logs で、止めた worker のタスクのログストリームを開き、最後の数行を読む。api のタスクのログも同じように読む

考えること：

- api のタスクを止めたとき、`/healthz` が答えなくなった時間はあったか。それはなぜか
- worker のログの最後には何が出ていたか。それは、アプリのどのコードが出したものか（`app/statuspage/worker.py`）
- もし worker が SIGTERM を無視するように作られていたら、何秒後に、どうやって止まるか

- [ ] 完了

## 11. 毎回の終わりに

> 📖 **先に読む**
> - [study §11 費用](phase7-study.md#11-費用)：全体
>
> 読んだら考える：学習を終えるとき、ECR のイメージは消さなくてよいか。何が課金され続けるか

### 学習を終えるとき

1. 「CodePipeline」→ `statuspage-destroy` →「変更をリリース」。変数 `CONFIRM_DESTROY` を `true` にする
2. RDS：`statuspage-db` を「アクション」→「一時的に停止」（最長7日）

### 学習を始めるとき

1. 場所が変わったら、パラメータストアの `/statuspage/allowed-cidrs` を更新する
2. RDS：「開始」→「利用可能」になるまで待つ
3. 「CodePipeline」→ `statuspage` →「変更をリリース」。変数 `CREATE_APP` を `true` にする

- 手元から `cdk deploy StatuspageApp` するときは、`-c appVersion=<SHA>` に、**ECR にイメージがある** コミットを指定する（イメージはパイプラインのビルドの段だけが作る）。手元のコミットを push してパイプラインを通すのが確実
- 1週間以上空けるときは、RDS を停止したままにしない（7日で自動で起動する）

- [ ] 理解した

## 12. Phase 7 の片付け

> 📖 **先に読む**
> - [study §12 ほかの Phase とのつながり](phase7-study.md#12-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：worker は、60秒のうち何秒くらい働いているか。働いていない間の料金を払わないようにするには、どうすればよいか

Phase 8 でも、ここまでのスタックとパイプラインを使う。手順11の「学習を終えるとき」の状態にしておく。

1. `statuspage-destroy` で `StatuspageApp` を消す（`CONFIRM_DESTROY` を `true`）
2. RDS を停止する
3. 手順6の手作業のものが残っていないことを確かめる（ECS のクラスター、ECR の `statuspage-manual`、SG `statuspage-manual-task`、`ecsTaskExecutionRole`）

- `StatuspageRegistry`（ECR の `statuspage`）、`StatuspagePipeline`、接続、パラメータストアの値は残す

- [ ] `StatuspageApp` を削除
- [ ] RDS を停止
- [ ] 手作業のものが残っていない
