# Phase 0 手順書: AWSアカウントの準備

> **新方式（Sign up for AWS (new)、2026年9月〜）** のアカウント向けの手順。
> 仕組みの解説は [phase0-study.md](phase0-study.md)、従来方式の手順は [phase0-appendix.md](phase0-appendix.md)。

## ゴール

- 事故（不正利用・高額請求）が起きにくい状態にする
- ターミナルから `aws` コマンドを使えるようにする

## 環境

| 項目 | 値 |
|---|---|
| アカウント | 新方式・無料プラン（$100 クレジット、2027-04-11 頃まで） |
| ログイン | Google → AWS Builder ID（MFA あり） |
| リージョン | `ap-southeast-2`（シドニー）固定 |
| CLI プロファイル | `study` |

---

## 0. AWS アカウントを作る

1. https://aws.amazon.com/ →「アカウントを作成」
2. 「Google で続行」などを選び、既存のログインで認証する
3. 名前を入力 → メールに届いた確認コードを入力 → パスワードと連絡先を入力
4. 最初のプロジェクトが自動で作られ、コンソールが開く（名前は自動。例：Idea Launchpad）

- [x] 完了

## 1. 入り口を守る（MFA）

> 解説：[study §2 アカウントを守る](phase0-study.md#2-アカウントを守る)

1. **Google アカウントの2段階認証** を有効にする
2. **Builder ID に MFA を登録する**
   - https://settings.aws.com →「Manage security and sign-in」→ Builder ID の「Security」→「Register device」
   - 認証アプリ（QR コードを読み取り、6桁のコードを入力）またはパスキー / セキュリティキー
3. サインアウト → もう一度ログインして、MFA を求められることを確認する

- [x] Google の2段階認証
- [x] Builder ID に MFA を登録
- [ ] 予備の MFA を登録（Windows Hello の PIN、または Google 以外にバックアップした認証アプリ）

## 2. アカウントの状態を確認する

https://settings.aws.com →「Project」→「Overview」→「Additional Info」

- **リージョン**：`ap-southeast-2` になっているか
- **アカウントID**：12桁の数字（リポジトリには書かない）

- [x] 完了

## 3. プランとクレジットを確認する

> 解説：[study §6 お金の管理](phase0-study.md#6-お金の管理)

AWS Settings の請求（Billing）画面で次の3つを確認する。

- 今のプラン（無料 / 有料）
- クレジット残高
- 残り日数

- [x] 完了（2026-10-12：無料プラン、残り181日、残高 $100.00）

## 4. 予算アラートを作る（Budgets）

> 解説：[study §6 お金の管理](phase0-study.md#6-お金の管理)

1. コンソール上部の検索バーで「Budgets」と入力 →「予算を作成」
2. 「テンプレートを使用（シンプル）」→ **「月次コスト予算」**
3. 予算名（例：`monthly-10usd`）、予算額 `10`（USD）、通知先のメールアドレスを入力する
4. テンプレートが自動で設定するしきい値：予測 > 100%、実績 > 85%、実績 > 100%

「ゼロ支出予算」は作らない（クレジット制では、少し使っただけで毎回通知が来てしまう）。

- [x] 完了（月次コスト予算 $10）
- [ ] Phase 2 で EC2 を動かしたあと、Budgets の実績が $0 より大きくなるか確認する

## 5. AWS CLI を使えるようにする

> 解説：[study §5 認証情報](phase0-study.md#5-認証情報アクセスキーと一時的な認証情報)

### 5-1. インストール（Windows）

```powershell
winget install Amazon.AWSCLI
```

ターミナルを開き直して確認：

```powershell
aws --version
```

`aws-cli/2.x.x` と表示されれば OK（2.37.12 で動作確認済み）。`aws login` は新しいコマンドなので、古い CLI の場合は更新する。

### 5-2. ログイン

```powershell
aws login --profile study --region ap-southeast-2
```

1. ブラウザが開く → Google → MFA でログイン
2. 「Choose AWS sessions」でプロジェクトを選ぶ
3. `Configure AWS skills and the AWS MCP server for your AI coding agent(s)? [y/n/never]` と出たら `n`
   （AI エージェントに AWS を直接操作させる設定。仕組みを理解するまで入れない。あとから AWS Settings でも設定できる）

`--region` はそのコマンドだけに効く。プロファイルの既定リージョンとして保存する：

```powershell
aws configure set region ap-southeast-2 --profile study
Get-Content $HOME\.aws\config
```

`[profile study]` の下に `login_session` と `region = ap-southeast-2` があれば OK。

### 5-3. 動作確認

```powershell
aws sts get-caller-identity --profile study
```

```json
{
    "UserId": "AROAxxxxxxxxxxxxxxxxx:<セッション名>",
    "Account": "xxxxxxxxxxxx",
    "Arn": "arn:aws:sts::xxxxxxxxxxxx:assumed-role/AccountFullAccessRole/<セッション名>"
}
```

`assumed-role/AccountFullAccessRole` と表示されれば成功。読み方は [study §4](phase0-study.md#4-iam)。

### 5-4. ログインが切れたら

`Your session has expired` と出たら、もう一度ログインする。

```powershell
aws login --profile study
```

- [x] CLI インストール
- [x] `aws login` → `get-caller-identity` 成功
- [x] プロファイルに既定リージョンを保存

## 6. IAM をのぞいてみる（見るだけ。何も変更しない）

> 解説：[study §4 IAM](phase0-study.md#4-iam)

1. コンソールで「IAM」→「ロール」→ `AccountFullAccessRole` を開く
2. 「許可」タブ：付いている許可ポリシーを確認する
3. 「信頼関係」タブ：信頼ポリシーの JSON を読む
4. AWS が自動で作った他のロールも眺める（**削除や編集はしない**。壊すと自分が操作できなくなる可能性がある）

確認結果：

| | 中身 |
|---|---|
| 許可ポリシー | `AdministratorAccess` |
| 信頼ポリシー | `Principal: { "Service": "account-access.amazonaws.com" }`、`Action: sts:AssumeRole, sts:SetContext` |

- [x] 完了
