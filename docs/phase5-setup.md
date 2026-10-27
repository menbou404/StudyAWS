# Phase 5 手順書: ここまでの構成を AWS CDK でコード化する

> Phase 2〜4 でコンソールから手で作った構成（VPC・セキュリティグループ・RDS・ALB・Auto Scaling など）を、AWS CDK（TypeScript）のコードで作り直す。手で作ったものは消し、DB のデータはスナップショットで引き継ぐ。
> アプリのコードと `deploy/ec2/user-data.sh` は変えない。CDK のコードはリポジトリの `infra/` にある。
> 仕組みの解説は [phase5-study.md](phase5-study.md)、CDK 以外の IaC などは [phase5-appendix.md](phase5-appendix.md)。

## ゴール

- CDK のコードを読んで、Phase 2〜4 のどの手作業に当たるかを説明できる
- `cdk synth`・`cdk diff`・`cdk deploy`・`cdk destroy` を使い分けられる
- スタックを分けた理由を説明し、アプリのスタックだけを消して作り直せる
- 手で作ったリソースを消し、データを引き継いで、全部をコードで作り直せる
- コードと実物がずれる（ドリフト）とどうなるかを説明できる

## 環境

| 項目 | 値 |
|---|---|
| リージョン | `ap-southeast-2`（シドニー） |
| IaC | AWS CDK v2（TypeScript）。`aws-cdk-lib` と CDK CLI は `infra/package.json` で固定 |
| Node.js | LTS（24 以上） |
| CDK のコード | `infra/` |
| 認証 | `aws login --profile study`（Phase 0） |

### 作るもの（CDK のスタック）

| スタック | 中身 | Phase 2〜4 の手作業 |
|---|---|---|
| `StatuspageNetwork` | VPC（`10.1.0.0/16`、2つの AZ）、パブリックサブネット 2、プライベートサブネット 2、IGW、ルートテーブル、DB 用のセキュリティグループ（受信ルールなし） | Phase 2 手順1、Phase 3 手順1・2、Phase 4 手順1 |
| `StatuspageDatabase` | DB サブネットグループ、RDS `statuspage-db`（スナップショット `statuspage-db-phase4-final` から作る。マスターのパスワードは新しいシークレットに保存）、削除ポリシー SNAPSHOT | Phase 3 手順3・4 |
| `StatuspageApp` | セキュリティグループ 3（alb・web・worker）と、DB への 5432番を許可するルール、EC2 用の IAM ロール、起動テンプレート 2（ユーザーデータは `deploy/ec2/user-data.sh`）、ターゲットグループ、ALB、Auto Scaling グループ 2 | Phase 2 手順2・3、Phase 3 手順6、Phase 4 手順2〜8 |

- アプリ用のシークレット `statuspage/db-app` は、Phase 3 で手で作ったものを **参照する**（CDK では作らない）
- ALB・web・worker のセキュリティグループと、DB への受信ルールは、アプリのスタックに置く。ALB のルールにはデプロイのたびに渡す IP が入るので、ネットワークのスタックをそのたびにデプロイし直さなくて済む。アプリのスタックを消すと DB への受信ルールも消え、アプリがない間は誰も DB に入れない
- VPC は、手で作った `10.0.0.0/16` と見分けるため `10.1.0.0/16` にする。サブネットの CIDR は CDK に割り当てさせる
- ALB に入れる自分の IP アドレスは、コードに書かず、デプロイのときに `-c allowedCidrs=...` で渡す。渡さなければ、ALB には誰も入れない

### 費用（目安）

作られるリソースは Phase 4 と同じなので、料金も同じ（全部動かすと 約 $0.12 / 時間）。CloudFormation と CDK は無料、ブートストラップで作る S3・ECR は置いた量の分だけ（ほぼ0）。
アプリのスタックを `cdk destroy` すれば、ALB と EC2 の料金は止まる（手順13）。

---

## 0. 始める前に

> 📖 **先に読む**
> - [study §1 IaC とは](phase5-study.md#1-iac-とは)：全体
>
> 読んだら考える：Phase 2〜4 の手作業で、一番間違えやすかった・時間がかかったのはどこか。コードにすると、それはどう変わるか

1. リポジトリを `git pull` して、`infra/` があることを確認する
2. Budgets の月次コスト予算と、クレジットの残高を確認する
3. Phase 4 の構成が、手順15（毎回の終わり）の状態か確認する（Auto Scaling グループが0台、RDS が停止）

- [ ] 完了

## 1. 手で作った構成を片付ける（DB はスナップショットを残す）

> 📖 **先に読む**
> - [study §9 既存のリソースを使う](phase5-study.md#9-既存のリソースを使う)：全体
> - [phase3-study §10 バックアップと停止](phase3-study.md#10-バックアップと停止)：「手動スナップショット」（復習）
>
> 読んだら考える：DB を消す前にスナップショットを取るのはなぜか。アプリ用のユーザーのパスワードは、スナップショットのあとどうなるか

CDK で同じ名前のもの（RDS の `statuspage-db` など）を作るので、先に手で作ったものを消す。VPC・セキュリティグループ・起動テンプレート・IAM ロールは、CDK の構成が動くのを確かめてから消す（手順12）。

1. [phase4-setup.md](phase4-setup.md) の手順16の1〜4（Auto Scaling グループ・ALB・ターゲットグループを削除、ボリュームが残っていないか確認）
2. RDS：`statuspage-db` を選び、「アクション」→「削除」
   - **「最終スナップショットを作成」にチェック**、スナップショット名 `statuspage-db-phase4-final`
   - 「自動バックアップを保持」はチェックしなくてよい
3. 「スナップショット」に `statuspage-db-phase4-final` があり、状態が「利用可能」になるまで待つ

- RDS が停止中でも削除できる。削除と同時に、RDS が管理していたマスターのシークレット（`rds!db-xxxx`）も削除される
- シークレット `statuspage/db-app` は **消さない**

- [ ] Auto Scaling グループ・ALB・ターゲットグループを削除
- [ ] スナップショット `statuspage-db-phase4-final` が利用可能

## 2. Node.js と CDK を用意する

> 📖 **先に読む**
> - [study §3 AWS CDK](phase5-study.md#3-aws-cdk)：「CloudFormation を直接書く場合との違い」「バージョン」
>
> 読んだら考える：CDK の CLI をパソコン全体に入れず、`infra/` の中に入れて `npx` で動かすのはなぜか

Windows（PowerShell）：

```powershell
node --version                  # v24 以上。なければ winget install OpenJS.NodeJS.LTS
cd infra
npm ci
npx cdk --version
```

macOS：

```bash
node --version                  # v24 以上。なければ brew install node
cd infra
npm ci
npx cdk --version
```

- `npm ci` は、`package-lock.json` に書かれたとおりのバージョンでライブラリを入れる（Phase 1 の `uv sync --locked` に相当）
- `npx cdk` は、`infra/` に入れた CDK CLI を使う。PC ごと・人ごとにバージョンが違う、ということが起きない

- [ ] 完了

## 3. CDK から AWS につながるか確かめる

> 📖 **先に読む**
> - [study §4 CDK のコマンドと流れ](phase5-study.md#4-cdk-のコマンドと流れ)：全体
>
> 読んだら考える：`cdk ls` と `cdk deploy` の違いは何か。`cdk ls` を先に試すのはなぜか

```bash
aws login --profile study
npx cdk ls --profile study
```

`StatuspageNetwork`・`StatuspageDatabase`・`StatuspageApp` の3つが表示されれば OK。

認証のエラー（`Unable to resolve AWS account`、`credentials` を含むもの）が出たら、`aws login` の一時的な認証情報を環境変数に書き出してから、`--profile` を付けずに実行する。

Windows（PowerShell）：

```powershell
aws configure export-credentials --profile study --format powershell | Invoke-Expression
npx cdk ls
```

macOS：

```bash
eval "$(aws configure export-credentials --profile study --format env)"
npx cdk ls
```

- 書き出した認証情報は期限付き。エラーが出たら、`aws login` からやり直す
- 書き出した値は、その PowerShell・ターミナルの中だけで使われる。閉じれば消える。画面に表示したり、どこかに貼ったりしない

- [ ] 完了

## 4. ブートストラップする

> 📖 **先に読む**
> - [study §5 ブートストラップ](phase5-study.md#5-ブートストラップ)：全体
>
> 読んだら考える：ブートストラップは、なぜアカウントとリージョンごとに1回でよいのか

```bash
npx cdk bootstrap --profile study
```

- CloudFormation のコンソールに、`CDKToolkit` というスタックができる。中身（「リソース」タブ）を見て、S3 バケット・ECR リポジトリ・IAM ロールがあることを確認する

- [ ] 完了

## 5. コードを読む

> 📖 **先に読む**
> - [study §3 AWS CDK](phase5-study.md#3-aws-cdk)：「部品（コンストラクト）」「L2 の便利さと注意点」
> - [study §6 スタックの分け方](phase5-study.md#6-スタックの分け方)：全体
> - [study §7 論理 ID と物理名](phase5-study.md#7-論理-id-と物理名)：全体
>
> 読んだら考える：3つのスタックに分けたのはなぜか。物理名を付けているのはどのリソースで、なぜか

`infra/` の次のファイルを読む。各リソースの近くのコメントに、Phase 2〜4 のどの手順に当たるかが書いてある。

| ファイル | 中身 |
|---|---|
| `bin/statuspage.ts` | App。3つのスタックを作り、つなげる |
| `lib/network-stack.ts` | VPC と DB 用のセキュリティグループ |
| `lib/database-stack.ts` | RDS（スナップショットから） |
| `lib/app-stack.ts` | セキュリティグループ（alb・web・worker、DB への受信ルール）、IAM ロール、起動テンプレート、ALB、Auto Scaling グループ |
| `test/` | テンプレートを確かめるテスト |

確かめること：

- セキュリティグループのつながり（alb → web → db、worker → db）は、どの行で書かれているか
- Phase 3 手順6・Phase 4 手順3 で手で書いた IAM のインラインポリシーは、どう書かれているか
- ユーザーデータの `ROLE="api"` は、worker 用ではどうやって変えているか

- [ ] 完了

## 6. テンプレートを作って読む（synth）

> 📖 **先に読む**
> - [study §2 CloudFormation](phase5-study.md#2-cloudformation)：全体
>
> 読んだら考える：`cdk synth` を実行すると、AWS に何か変更が加わるか

```bash
npx cdk synth StatuspageNetwork --profile study > network.yaml
npm test
```

- `network.yaml` は CloudFormation のテンプレート。`Type: AWS::` で検索して、どんな種類のリソースがいくつ作られるか数える
- コードに書いていないのに作られているリソースはあるか。それは何のためか
- `network.yaml` は確認が終わったら消す（Git に入れない）

- [ ] 完了

## 7. デプロイする

> 📖 **先に読む**
> - [study §4 CDK のコマンドと流れ](phase5-study.md#4-cdk-のコマンドと流れ)：「ふだんの流れ」の段落
> - [study §10 公開リポジトリで IaC を扱う](phase5-study.md#10-公開リポジトリで-iac-を扱う)：全体
>
> 読んだら考える：自分の IP アドレスを、コードではなく `-c` で渡すのはなぜか

**ここから課金が始まる**（Phase 4 と同じ構成）。

### 7-1. ネットワークと DB

```bash
npx cdk diff StatuspageNetwork StatuspageDatabase --profile study
npx cdk deploy StatuspageNetwork StatuspageDatabase --profile study
```

- `diff` で、何が作られるかを読んでから `deploy` する。IAM やセキュリティグループに関わる変更があると、`deploy` の途中で確認を求められる
- DB はスナップショットから作るので、15分ほどかかる

### 7-2. アプリ

自分のグローバル IP アドレスを調べて、`-c` で渡す。

Windows（PowerShell）：

```powershell
$myip = (Invoke-RestMethod https://checkip.amazonaws.com).Trim()
npx cdk diff StatuspageApp --profile study -c allowedCidrs="$myip/32"
npx cdk deploy StatuspageApp --profile study -c allowedCidrs="$myip/32"
```

macOS：

```bash
MYIP=$(curl -s https://checkip.amazonaws.com)
npx cdk diff StatuspageApp --profile study -c allowedCidrs="$MYIP/32"
npx cdk deploy StatuspageApp --profile study -c allowedCidrs="$MYIP/32"
```

- 複数の場所から使うときは、`allowedCidrs="a.a.a.a/32,b.b.b.b/32"` のようにカンマでつなぐ
- `deploy` の最後に **Outputs** として ALB の DNS 名が表示される（チャットやリポジトリには貼らない）
- `diff` や `deploy` で `WARNING desiredCapacity has been configured` が Auto Scaling グループごとに出る。「コードに希望するキャパシティを書いているので、デプロイのたびにその台数に戻す」という注意で、このプロジェクトでは意図どおり（[study §11 ドリフト](phase5-study.md#11-ドリフト)）

- [ ] ネットワークと DB
- [ ] アプリ

## 8. 動いていることを確かめる

> 📖 **先に読む**
> - [phase4-setup.md](phase4-setup.md) の手順9（復習）
>
> 読んだら考える：Phase 4 の手順9と、確かめることは同じか違うか

1. ブラウザで `http://<ALB の DNS 名>/` を開き、Phase 3・4 の監視対象と記録が表示されることを確認する（スナップショットから引き継いだデータ）
2. 最終チェックの時刻が、1分ごとに新しくなることを確認する（worker が動いている）
3. CloudFormation のコンソールで、3つのスタックが `CREATE_COMPLETE` になっていることと、各スタックの「リソース」タブの数を見る

- [ ] 完了

## 9. 実験A：コードを変えて差分を見る

> 📖 **実験のあとに読む**
> - [study §2 CloudFormation](phase5-study.md#2-cloudformation)：「変更の種類」

予想してから実行する。

1. `infra/lib/app-stack.ts` の、api の Auto Scaling グループの **希望・最小を 2 → 3** に書き換える
2. `npx cdk diff StatuspageApp --profile study -c allowedCidrs=...` を実行して、差分を読む
3. `npx cdk deploy StatuspageApp --profile study -c allowedCidrs=...` を実行し、3台目が Healthy になるのを確かめる
4. `git restore infra/lib/app-stack.ts` で元に戻し、もう一度 `diff` → `deploy` する

考えること：

- 差分には、何が「変更」として表示されたか。「置き換え」になったものはあるか
- 同じ `deploy` を、何も変えずにもう一度実行するとどうなるか
- Phase 4 の実験D（コンソールで台数を変えた）と比べて、何がうれしいか

- [ ] 完了

## 10. 実験B：手で変えると、コードは気づくか

> 📖 **実験のあとに読む**
> - [study §11 ドリフト](phase5-study.md#11-ドリフト)：全体

予想してから実行する。

1. コンソールで、CDK が作った ALB のセキュリティグループ（名前に `StatuspageApp` と `Alb` を含むもの）に、インバウンドルールを1つ手で足す（タイプ「カスタム TCP」、ポート 8080、ソース「マイ IP」、説明 `drift test`）
2. `npx cdk diff StatuspageApp --profile study -c allowedCidrs=...` を実行する
3. CloudFormation のコンソールで `StatuspageApp` を選び、「スタックアクション」→「ドリフトの検出」→ 終わったら「ドリフト結果を表示」
4. 手で足したルールを、コンソールで消す

考えること：

- `cdk diff` は、手で足したルールに気づいたか。気づかなかったなら、なぜか
- ドリフトの検出では、どう表示されたか
- IaC で作ったリソースを手で変えてはいけないのは、なぜか

- [ ] 完了

## 11. 実験C：アプリのスタックを消して、作り直す

> 📖 **実験のあとに読む**
> - [study §6 スタックの分け方](phase5-study.md#6-スタックの分け方)：全体
> - [study §8 削除するときの扱い](phase5-study.md#8-削除するときの扱い)：全体

予想してから実行する。時間を計る。

```bash
npx cdk destroy StatuspageApp --profile study
npx cdk deploy StatuspageApp --profile study -c allowedCidrs=...
```

考えること：

- 消すのと作るのに、それぞれ何分かかったか。Phase 4 で同じものを手で作ったときと比べてどうか
- ALB の DNS 名は変わったか
- 監視の記録は残っていたか。それはなぜか
- `StatuspageDatabase` を `cdk destroy` したら、何が起きるか（実行はしない）

- [ ] 完了

## 12. 手で作った残りを消す

> 📖 **先に読む**
> - [study §13 ほかの Phase とのつながり](phase5-study.md#13-ほかの-phase-とのつながり)：「Phase 4 から何が置き換わったか」
>
> 読んだら考える：手で作ったものを消す前に、CDK の構成が動くのを確かめたのはなぜか

CDK の構成で、手順8が確かめられてから消す。

1. RDS →「サブネットグループ」→ `statuspage-db-subnets` を削除
2. EC2 →「起動テンプレート」→ `statuspage-api-lt`、`statuspage-worker-lt` を削除
3. VPC →「VPC」→ `statuspage-vpc`（`10.0.0.0/16`）を選び、「アクション」→「VPC を削除」。一緒に消えるもの（サブネット・ルートテーブル・IGW・セキュリティグループ）の一覧を確認してから削除する
4. IAM →「ロール」→ `statuspage-ec2-role` を削除（インラインポリシーも一緒に消える）

- **`10.1.0.0/16`（CDK の VPC）を消さないように**、CIDR を必ず確認する
- 消せないときは、エラーに出てくるリソース（ネットワークインターフェースなど）がまだ使われていないか確認する

- [ ] 完了

## 13. 毎回の終わりに

> 📖 **先に読む**
> - [study §12 費用](phase5-study.md#12-費用)：全体
>
> 読んだら考える：Phase 4 の「毎回の終わり」と比べて、何が楽になったか

### 学習を終えるとき

```bash
npx cdk destroy StatuspageApp --profile study
```

RDS：コンソールで `statuspage-db` を「アクション」→「一時的に停止」（最長7日）。

### 学習を始めるとき

1. RDS：「アクション」→「開始」→「利用可能」になるまで待つ
2. 手順7-2 のとおり、`StatuspageApp` を `deploy` する（ALB の DNS 名は毎回変わる）

- `StatuspageNetwork` と `StatuspageDatabase` は残しておく（ネットワークは無料、DB は停止できる）
- 1週間以上空けるときは、[phase3-setup.md](phase3-setup.md) の手順15と同じ考え方で、RDS を停止したままにしない（7日で自動で起動する）

- [ ] 理解した

## 14. Phase 5 の片付け

> 📖 **先に読む**
> - [study §13 ほかの Phase とのつながり](phase5-study.md#13-ほかの-phase-とのつながり)：「この構成の弱点と、解決する Phase」
>
> 読んだら考える：Phase 6 で、`cdk deploy` を手元の PC ではなく GitHub Actions から実行すると、何がうれしいか

Phase 6 でも、この3つのスタックを使う。手順13の「学習を終えるとき」の状態にしておく。

1. `StatuspageApp` を `cdk destroy` する
2. RDS を停止する

- スナップショット `statuspage-db-phase4-final` は **消さない**。`StatuspageDatabase` のテンプレートがこの名前を参照し続けるので、消すと、DB の置き換えが必要な変更のときにデプロイが失敗する。料金は、中のデータの量の分だけ（ごくわずか）

- [ ] `StatuspageApp` を削除
- [ ] RDS を停止
