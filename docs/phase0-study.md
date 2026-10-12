# Phase 0 知識まとめ: アカウント・IAM・認証情報・お金

> Phase 0 で出てきた AWS の知識を体系的にまとめたもの。手順は [phase0-setup.md](phase0-setup.md)。

## 目次

1. [AWS アカウントの構造](#1-aws-アカウントの構造)
2. [アカウントを守る](#2-アカウントを守る)
3. [認証と認可](#3-認証と認可)
4. [IAM](#4-iam)
5. [認証情報（アクセスキーと一時的な認証情報）](#5-認証情報アクセスキーと一時的な認証情報)
6. [お金の管理](#6-お金の管理)
7. [このアカウントの制約](#7-このアカウントの制約)
8. [理解度チェック](#8-理解度チェック)

---

## 1. AWS アカウントの構造

### 新方式（Sign up for AWS (new)、2026年9月〜）

```
Googleアカウント（ログインの入り口）
  └─ AWS Builder ID（自分個人を表すID。MFA はここにつける）
       └─ 組織（AWS Organizations。AWS が代わりに管理してくれる）
            └─ プロジェクト（= AWSアカウント1つ。12桁のアカウントID）
                 └─ EC2 や S3 などのリソースはここに作られる
```

| 用語 | 意味 |
|---|---|
| AWS Builder ID | 自分個人のプロフィール。ログインと MFA を管理する。従来方式では AWS アカウントとは別物（学習サイトなどで使う）だが、新方式ではこれがログインの入り口になる |
| AWS アカウント | リソースを作り、料金を払う「契約の単位」。12桁のアカウントIDを持つ |
| プロジェクト | AWS アカウント1つ + 共有設定。最初のプロジェクトは自動で作られ、名前も自動で付く |
| 組織 | 自分のプロジェクト全体。中身は AWS Organizations だが、AWS が管理する |
| AWS Settings | プロジェクト・請求・メンバー招待などを管理する画面（https://settings.aws.com） |

### 従来方式との比較

| | 従来方式（advanced） | 新方式（new） |
|---|---|---|
| ログイン | root（メール + パスワード）/ IAM Identity Center | Google 等 → Builder ID |
| root ユーザー | ある | **作られない** |
| 守るべき入り口 | root と Identity Center のユーザー | **Google アカウントと Builder ID** |
| クレジットカード | 必須 | 多くの場合不要 |
| リージョン | 自由に選べる | 1つに固定 |
| 使えるサービス | すべて | 対応リストのもののみ |
| 使いすぎ対策 | Budgets（通知のみ） | 無料プランはクレジットが尽きたら停止。有料プランは支出上限 (spend limit) |
| CLI のログイン | `aws configure sso` / `aws sso login`（`aws login` も可） | `aws login` |

SAA 試験や実務の記事は、ほとんどが従来方式を前提にしている → [phase0-appendix.md](phase0-appendix.md)

### リージョン

- AWS のデータセンター群がある地域。東京 = `ap-northeast-1`、シドニー = `ap-southeast-2`
- 新方式では、住所の国で自動的に決まり **変更できない**（日本 → シドニー）
- VPC・EC2・RDS などの操作は、どのリージョンでも同じ。違うのは遅延と料金単価くらい
- ネット上の記事の `ap-northeast-1` は `ap-southeast-2` に読み替える

---

## 2. アカウントを守る

### root ユーザー（従来方式）

- アカウント作成に使ったメールアドレスでログインするユーザー
- **AWS アカウント全体** に対して全権限を持つ（サーバーだけでなく、請求やアカウントの解約まで）
- **権限を制限できない唯一のユーザー** → 乗っ取られるとアカウントごと失う
- 対策：MFA をつけて封印し、普段は使わない

### 新方式では

- root ユーザーが **そもそも作られない**。存在しないものは乗っ取られない
- そのかわり **Google アカウントと Builder ID が、実質的に root と同じ重み** を持つ → ここを MFA で守る

### MFA（多要素認証）

本人確認の手段を、**性質の違う2種類以上** で組み合わせる仕組み。

| 要素 | 例 |
|---|---|
| 知っているもの（知識） | パスワード |
| 持っているもの（所持） | スマホの認証アプリ、セキュリティキー |
| 本人の身体（生体） | 指紋、顔 |

パスワードが漏れても、「所持」がそろわなければログインできない。

| MFA の種類 | 特徴 |
|---|---|
| パスキー / セキュリティキー（FIDO2） | フィッシングに最も強い。Windows Hello（PIN でも可）も使える |
| 認証アプリ（TOTP） | 30秒ごとに変わる6桁のコード。手軽 |

注意点：

- **MFA デバイスをすべて失うと、アカウントを復旧できない** → 予備を登録する
- ログインに使う Google アカウントと同じ場所に、MFA のパスキーやバックアップを置かない（Google が破られたら両方まとめて突破される）

---

## 3. 認証と認可

| | 問い | 空港でいうと | 英語 |
|---|---|---|---|
| **認証** | **あなたは誰？** | パスポートで本人確認 | Authentication（AuthN） |
| **認可** | **何をしてよい？** | 搭乗券で乗れる便が決まる | Authorization（AuthZ） |

- 順番は必ず **認証 → 認可**（誰か分からない相手に、何をしてよいかは決められない）
- **ポリシーは丸ごと「認可」の道具**。ポリシーが認証をすることはない
  - `Principal`（誰に）+ `Action`（何を）+ `Effect`（許可 / 拒否）で、1つの認可ルールになる
  - 搭乗券に名前が書いてあっても、それは本人確認ではない
- **すべてのリクエストが認証される**。IAM ユーザーだけではない
  - AWS への API リクエストは、秘密鍵による署名で「本物か」を毎回確認される

| 誰が | どうやって認証されるか |
|---|---|
| 人間（新方式） | Google + MFA（Builder ID） |
| IAM ユーザー | パスワード、または長期のキー（`AKIA`）による署名 |
| ロールを借りたセッション | 一時的なキー（`ASIA`）+ sessionToken による署名 |
| AWS のサービス | AWS 内部の仕組み |

ログインから操作までの流れでは、認証と認可が **交互に何度も** 行われる：

```
【認証】Google + MFA でログイン ─→ 本人だと確認
【認可】信頼ポリシー            ─→ account access manager がロールを借りてよいか
【認証】ASIA の鍵で署名         ─→ リクエストが本物のセッションから来たか
【認可】許可ポリシー            ─→ その操作をしてよいか
```

### エラーの見分け方

| エラー | 種類 | 対処 |
|---|---|---|
| `ExpiredToken`、`Your session has expired` | 認証 | `aws login` し直す |
| `AccessDenied` | 認可 | ポリシーを確認する |

---

## 4. IAM

IAM（Identity and Access Management）は **「誰が、何に対して、何をしてよいか」** を管理するサービス。全 Phase で使う。

### 新方式での IAM

| | 内容 | 新方式では |
|---|---|---|
| ① 人のログイン | 誰がコンソールや CLI に入れるか | Builder ID と AWS が管理。IAM ユーザーでコンソールにはログインできない（IAM ユーザーはプログラムからのアクセス専用） |
| ② 権限の仕組み | 誰（何）が、何をしてよいか | **従来方式と同じ**。IAM ロールとポリシーで管理する |

### IAM ユーザーと IAM ロール

| | IAM ユーザー | IAM ロール |
|---|---|---|
| たとえ | 名前入りの社員証 | 受付で貸し出す入館証 |
| 誰のものか | 特定の1人（1つのプログラム） | 役割（誰のものでもない） |
| 資格情報 | **長期**（パスワード、アクセスキー） | **持っていない**。借りたときに一時的なものが発行される |
| 使う人・もの | 人、プログラム | 人（SSO・Builder ID 経由）、EC2、Lambda、GitHub Actions など |
| 今のおすすめ | なるべく使わない | **基本はこっち** |

- **assume（引き受ける）**：ロールを一時的に借りること。STS の `AssumeRole` API で行う
- **セッション**：ロールを借りている間のこと
- 自分は **Builder ID という「人」** で、**IAM ロール（AccountFullAccessRole）を借りて** 操作している。IAM ユーザーは使っていない

### 2種類のポリシー

ロールは「**何をできるか**」と「**誰がなれるか**」の2つのポリシーでできている。

| | 答える問い | 入館証のたとえ |
|---|---|---|
| **許可ポリシー** | このロールを借りた人は **何ができるか** | 入館証で開けられる扉 |
| **信頼ポリシー** | このロールを **誰が借りられるか** | 入館証を貸し出してよい相手 |

許可ポリシーが「何でもできる」でも、信頼ポリシーが許した相手以外は、そもそもロールを借りられない。

### ポリシー JSON の読み方

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": { "Service": "account-access.amazonaws.com" },
            "Action": ["sts:AssumeRole", "sts:SetContext"]
        }
    ]
}
```

| 要素 | 意味 |
|---|---|
| `Version` | ポリシーの文法のバージョン。作成日ではない。常に `2012-10-17` |
| `Statement` | ルールのリスト |
| `Effect` | `Allow`（許可）/ `Deny`（拒否） |
| `Principal` | **誰に**（信頼ポリシーなど、リソース側のポリシーで使う） |
| `Action` | **何を**（`サービス名:API名`） |
| `Resource` | **何に対して**（許可ポリシーで使う。上の例にはない） |
| `Condition` | 追加の条件（例：自分のアカウントから来た場合だけ） |

`Principal` の種類：

| 書き方 | 意味 | 例 |
|---|---|---|
| `"Service": "xxx.amazonaws.com"` | AWS のサービス（サービスプリンシパル） | `ec2.amazonaws.com`（Phase 2）、`lambda.amazonaws.com` |
| `"AWS": "arn:aws:iam::..."` | AWS アカウント、IAM ユーザー、ロール | |
| `"Federated": "..."` | 外部の ID プロバイダー | GitHub Actions の OIDC（Phase 6） |

### get-caller-identity の読み方

```json
{
    "UserId": "AROAxxxxxxxxxxxxxxxxx:<セッション名>",
    "Account": "xxxxxxxxxxxx",
    "Arn": "arn:aws:sts::xxxxxxxxxxxx:assumed-role/AccountFullAccessRole/<セッション名>"
}
```

ロールそのものと、借りている最中のセッションで ARN が違う：

```
ロールそのもの:  arn:aws:iam::xxxx:role/AccountFullAccessRole
借りている最中:  arn:aws:sts::xxxx:assumed-role/AccountFullAccessRole/<セッション名>
```

### ユニークIDの接頭辞

IAM の各要素には 21文字のユニークIDが付き、**先頭4文字で種類が分かる**。

| 先頭 | 種類 |
|---|---|
| `AROA` | IAM ロール |
| `AIDA` | IAM ユーザー |
| `AGPA` | IAM グループ |
| `ANPA` | 管理ポリシー |
| `AKIA` | 長期のアクセスキー |
| `ASIA` | 一時的なアクセスキー（STS が発行） |

### 新方式のログインの仕組み（AccountFullAccessRole）

| | 中身 |
|---|---|
| 許可ポリシー | `AdministratorAccess`（プロジェクト内でほぼ何でもできる） |
| 信頼ポリシー | `account-access.amazonaws.com`（account access manager）だけが借りられる |

```
自分 → Google + MFA → Builder ID
  → account access manager（このプロジェクトのメンバーか確認する受付）
  → sts:AssumeRole で AccountFullAccessRole を借りる
  → sts:SetContext で「誰が使っているか」の情報をセッションに付ける
  → 一時的な認証情報がコンソール / CLI に渡される
```

- 人間（自分）は `Principal` に直接書かれていない。**受付役のサービスが本人確認をして、代わりにロールを借りてくる**
- 従来方式の IAM Identity Center もほぼ同じ構造
- AWS 公式の例では、この信頼ポリシーに `Condition`（自分のアカウント・自分の受付アプリから来た場合だけ、という条件）が付いている。自分のロールには付いていなかった（理由は未確認）

### IAM role manager（新方式）

サービス間の権限（例：Lambda から DynamoDB を読む権限）を AWS が自動で設定する仕組み。便利だが、中身が見えなくなる。
→ このプロジェクトでは、ロールとポリシーを自分で作り、中身を読んで理解する。

### ロードマップで IAM を使う場面

| Phase | 内容 |
|---|---|
| 2 | EC2 に IAM ロールを付けて Session Manager で接続する（信頼ポリシーの Principal は `ec2.amazonaws.com`） |
| 6 | GitHub Actions が OIDC で IAM ロールを借りてデプロイする |
| 7〜8 | ECS のタスクや Lambda に実行ロールを付ける |

---

## 5. 認証情報（アクセスキーと一時的な認証情報）

### 長期と一時的

| | アクセスキー（長期） | 一時的な認証情報 |
|---|---|---|
| 誰のものか | IAM ユーザー | ロールを借りたセッション |
| IDの先頭 | `AKIA` | `ASIA` |
| 構成 | accessKeyId + secretAccessKey | accessKeyId + secretAccessKey + **sessionToken** |
| 有効期限 | **なし**（削除・無効化するまで使える） | あり（数分〜数時間） |
| 漏れたら | 気づいて無効化するまで使われ放題 | 期限が来れば使えなくなる |

- GitHub に誤って push した `AKIA` のキーが数時間で悪用され、高額請求される事故が実際によく起きている
- 漏れたら、すぐに **キーを無効化・削除** する
- **このプロジェクトでは長期のアクセスキーを作らない**

### STS（Security Token Service）

一時的な認証情報を発行するサービス。ロールを借りる（`AssumeRole`）と、STS が期限付きの鍵を発行する。
`aws sts get-caller-identity` は「今の自分は誰か」を聞くコマンドで、権限がなくても必ず使えるため、動作確認の定番。

### aws login の仕組み

```
ターミナルで aws login を実行
   ↓ ブラウザが開く
Google → MFA でログインし、プロジェクトを選ぶ
   ↓
STS が一時的な鍵を発行し、PC に保存する
   ↓
以降の aws コマンドはこの鍵で署名して送られる
```

鍵は Builder ID に紐づいて保存されているわけではなく、**ログインのたびに発行されて PC に保存される**。

```
~\.aws\
 ├─ config                  ← プロファイル設定（login_session, region）
 └─ login\cache\xxxx.json   ← 一時的な鍵一式（accessKeyId / secretAccessKey / sessionToken / expiresAt）
                              + refreshToken（新しい鍵の引換券）
```

> ⚠️ キャッシュには秘密鍵が入っている。中身を人に見せたり、コミットしたりしない。

| ID | 何のID | 変わるか |
|---|---|---|
| `AROA...` | **ロール** のID（誰として操作しているか） | ロールが同じならずっと同じ |
| `ASIA...` | **鍵** のID（どの鍵で操作しているか） | 発行のたびに変わる |

期限は3段構え（2026-10-12 の実測を含む）：

| 期限 | 長さ | 切れたら |
|---|---|---|
| 鍵そのもの | 約15分（実測） | CLI が refreshToken で自動更新する |
| セッション | 12時間 | `aws login` し直す |
| 自動更新の許可 | 90日 | ブラウザでもう一度許可する |

> 実測では、ログインから約1時間後に `Your session has expired` と出て、自動更新されなかった（コンソールからのサインアウトが原因かもしれないが、未確認）。

### CLI のリージョンの決まり方

次の順に探し、最初に見つかったものを使う。

1. コマンドの `--region`（そのコマンドだけに効く）
2. 環境変数 `AWS_REGION` / `AWS_DEFAULT_REGION`
3. プロファイルの設定（`~\.aws\config` の `region`）

### AI エージェント向けの設定（AWS MCP サーバー）

`aws login` の途中で、AI コーディングエージェントに AWS skills と AWS MCP サーバーを入れるかを聞かれる。

- MCP は、AI にツールを渡すための共通規格。入れると AI が AWS を直接操作できるようになる
- このプロジェクトでは、仕組みを自分で理解することを優先して入れていない（あとから AWS Settings で設定できる）

---

## 6. お金の管理

### 従量課金とクレジット

- AWS は **使った分だけ払う**（従量課金）
- 無料プランでは、その支払いがクレジットから引かれる（プリペイドの残高のようなもの）

### 無料プラン（新方式）

- 作成時に $100。特定の操作（EC2 の起動と終了、Budgets の作成など）で追加クレジットがもらえることがある
- **最長6か月**。クレジットを使い切った時点でも終わる
- クレジットを超えても **請求されない**。そのかわりアカウントが止まり、有料プランに切り替えないと使えなくなる
  （従来方式の無料プランでは、一定期間内に切り替えないとリソースやデータが削除されると説明されている。新方式の細部は未確認）

### 何がクレジットを減らすか

| リソース | 注意点 | Phase |
|---|---|---|
| EC2 インスタンス | 起動中ずっと課金（停止中もディスク代はかかる） | 2 |
| パブリック IPv4 アドレス | 1つにつき1時間ごとに課金 | 2〜 |
| RDS | 起動中ずっと課金。EC2 より高め | 3 |
| ALB | 置いておくだけで時間課金 | 4 |
| NAT Gateway | 置いておくだけで高い。**一番の落とし穴** | 3〜4 |

→ **作ったら消す**。その日の学習が終わったらリソースを削除する。

### Budgets（予算）

「今月はこの金額まで」と決めておき、超えそう・超えたら **メールで知らせる** 機能。**止めはしない**。

| 言葉 | 意味 |
|---|---|
| 実績（Actual） | 今月すでに使った金額 |
| 予測（Forecasted） | このペースだと月末にいくらになるか |
| しきい値（Threshold） | 予算の何%で通知するか |

予測で通知を受け取れば、使いすぎる **前に** 気づける。

Budgets はデフォルトでクレジットを差し引く **前** の金額で計算するはず（未確認。Phase 2 で確かめる）。そうであれば、請求額が $0 でも「実際に使った量」で見張れる。

### 支出上限（spend limit）

- **新方式の有料プランだけ** の機能。AWS Settings でプロジェクトごとに設定する（$20以上）
- 上限に達すると **プロジェクトを一時停止** する（請求が上限を超えない）
- 有料プランへの切り替え時に AWS が金額を提案する。採用するかは自分で決める
- 「高度な機能」を有効化すると使えなくなる

### 3つの守りの比較

| | Budgets | 支出上限 | 無料プランのクレジット |
|---|---|---|---|
| スマホでいうと | 「80%使いました」のお知らせ | 上限で通信を止める設定 | プリペイドの残高 |
| 何をするか | **知らせるだけ** | 上限でプロジェクトを一時停止 | 0になったらアカウントが止まる |
| 金額を決めるのは | 自分 | 自分（$20以上） | AWS（$100） |
| 使える場面 | 新方式・従来方式のどちらでも | 新方式の有料プラン | 無料プラン |
| 今の状態 | $10 で設定済み | 使えない（無料プランのため） | **これが実質的な上限** |

---

## 7. このアカウントの制約

| 項目 | 状況 |
|---|---|
| Phase 2〜7, 9 の主なサービス（EC2, VPC, RDS, ELB, Route 53, ACM, CloudFormation/CDK, ECR, ECS, Lambda, EventBridge, S3, CloudFront, CloudWatch, Systems Manager） | 無料プランの対応リストにある |
| Phase 4 の EC2 Auto Scaling | リストに明記がない（「Application Auto Scaling」は別物）→ Phase 4 で確認 |
| Phase 8 の CloudFront + 独自ドメイン | 通常は us-east-1 に証明書が必要。他リージョンにリソースを作れないので、制限を受ける可能性あり |
| IAM Identity Center / Organizations を自分で設定する | できない（AWS が管理） |
| 制約をすべて外したい | 「高度な機能を有効化」→ 有料プランが前提で **元に戻せない**（[appendix](phase0-appendix.md)） |

---

## 8. 理解度チェック

答えは自分で考えてから開く。

<details>
<summary>Q1. 従来方式で root に MFA をつけて封印するのはなぜ？ 新方式でそれが不要なのはなぜ？</summary>

root は AWS アカウント全体に全権限を持ち、権限を制限できない唯一のユーザーだから。新方式では root がそもそも作られないので、封印する対象がない。
</details>

<details>
<summary>Q2. 新方式で一番守るべき入り口はどこ？</summary>

Google アカウントと Builder ID。ここが破られると、root を乗っ取られるのと同じことになる。
</details>

<details>
<summary>Q3. GitHub に AKIA で始まるキーと秘密鍵を公開してしまった。何が危ない？ ASIA だったらどう変わる？</summary>

AKIA は期限のない長期のキーなので、無効化・削除するまで誰でも使い続けられる。ASIA は一時的なキーなので、期限（数分〜数時間）が来れば使えなくなり、被害の時間が限られる。どちらにしても漏らさないのが前提。
</details>

<details>
<summary>Q4. IAM ユーザーと IAM ロールの違いは？ 自分は今どちらとして操作している？</summary>

IAM ユーザーは特定の人に紐づき、長期の資格情報を持つ。IAM ロールは役割に紐づき、資格情報を持たず、借りたときだけ一時的な資格情報が発行される。自分は Builder ID という「人」として認証され、IAM ロール（AccountFullAccessRole）を借りて操作している。
</details>

<details>
<summary>Q5. EC2 上のアプリが S3 にファイルを置けるようにしたい。IAM ユーザーとロールのどちらを使う？ 信頼ポリシーの Principal は？</summary>

ロール。IAM ユーザーだと、長期のアクセスキーを EC2 のディスクに置く必要があり、漏れたときの危険が大きく、キーの入れ替えも手間。ロールなら、EC2 が自動で一時的な認証情報を受け取れる。Principal は `"Service": "ec2.amazonaws.com"`（サービスプリンシパル）。
</details>

<details>
<summary>Q6. 認証と認可の違いは？ AccessDenied と Your session has expired はそれぞれどちら？</summary>

認証は「あなたは誰か」の確認、認可は「何をしてよいか」の判断。AccessDenied は認可の問題（ポリシーを確認する）、Your session has expired は認証の問題（ログインし直す）。
</details>

<details>
<summary>Q7. 信頼ポリシーの Principal は認証、Action は認可？</summary>

いいえ。ポリシーは丸ごと認可の道具。Principal は「（認証が済んだ相手のうち）誰に」、Action は「何を」を表し、合わせて1つの認可ルールになる。認証はポリシーを見る前に、署名やログインで済んでいる。
</details>

<details>
<summary>Q8. AROA と ASIA の違いは？</summary>

AROA はロールのID（誰として操作しているか）で、ロールが同じなら変わらない。ASIA は一時的な鍵のID（どの鍵で操作しているか）で、発行のたびに変わる。
</details>

<details>
<summary>Q9. 無料プランの今、Budgets の $10 を超えたら？ クレジットが $0 になったら？</summary>

Budgets を超えたら、設定したメールアドレスに通知が来るだけ（何も止まらない）。クレジットが $0 になったら、無料プランが終わってアカウントが止まり、有料プランに切り替えないと使えなくなる。
</details>

<details>
<summary>Q10. Budgets と支出上限 (spend limit) の違いは？</summary>

Budgets は知らせるだけで、新方式・従来方式のどちらでも使える。支出上限は上限に達したらプロジェクトを一時停止する機能で、新方式の有料プランだけで使える。
</details>

---

## 参考

- [Sign up for AWS (new)](https://docs.aws.amazon.com/accounts/latest/reference/sign-in-new.html)
- [Compare sign-up options（新方式と従来方式の比較）](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
- [Supported AWS services for Sign up for AWS (new)](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html)
- [AWS Regions for your projects](https://docs.aws.amazon.com/accounts/latest/reference/project-regions.html)
- [Manage MFA in AWS Settings](https://docs.aws.amazon.com/accounts/latest/reference/register-mfa-devices.html)
- [Connect an AI coding tool（aws login の説明あり）](https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html)
- [IAM identifiers（ユニークIDの接頭辞）](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html)
- [Account access manager: Prepare your IAM roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/aam-prepare-roles.html)
- [Activate advanced AWS features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)
