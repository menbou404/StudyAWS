# Phase 0: AWSアカウントの準備

## ゴール

- 事故（不正利用・高額請求）が起きにくいアカウントにする
- 普段使い用のユーザーで、ターミナルから `aws` コマンドを使えるようにする

## 全体像

```
rootユーザー（メールアドレスでログイン）
  └─ 最強の権限。請求・アカウント解約まで何でもできる
     → MFA をつけて金庫にしまう。普段は使わない

IAM Identity Center のユーザー（普段使い）
  └─ 「AdministratorAccess」の権限セットを割り当てる
     → コンソールも CLI もこのユーザーで使う
     → CLI は一時的な認証情報で動くので、キーが漏れる心配が少ない
```

**なぜ root を使わないのか：** root は権限を制限できない唯一のユーザー。乗っ取られるとアカウントごと失う。
**なぜアクセスキーを作らないのか：** アクセスキーは期限のない合鍵。GitHub に誤って push してしまい、数時間で仮想通貨マイニングに使われて高額請求、という事故が実際によく起きている。

---

## チェックリスト

### 1. root ユーザーに MFA を設定する

1. root ユーザーでコンソールにログイン
2. 右上のアカウント名 →「セキュリティ認証情報」
3. 「MFA を割り当てる」→ 認証アプリ（Google Authenticator、1Password など）またはパスキーを登録

- [ ] 完了

### 2. 請求情報を IAM ユーザーからも見られるようにする

root のまま、右上のアカウント名 →「アカウント」→「IAM ユーザーおよびロールによる請求情報へのアクセス」を **有効化**。
（これをしないと、普段使いユーザーで請求画面が見られない）

- [ ] 完了

### 3. 予算アラートを作る（Budgets）

1. コンソールで「Billing and Cost Management」→「予算 (Budgets)」→「予算を作成」
2. テンプレートで **「ゼロ支出予算」** を作成 → 1セントでも課金されたらメールが届く
3. もう1つ **「月次コスト予算」** を作成（例：$10）→ 想定以上の課金に気づける

あわせて「請求設定 (Billing preferences)」で **無料利用枠の使用アラート** を有効化しておく。

- [ ] ゼロ支出予算
- [ ] 月次コスト予算
- [ ] 無料利用枠アラート

> 💡 2025年7月以降に作成したアカウントは、無料利用枠がクレジット制（無料プラン/有料プラン）になっている。
> 「Billing and Cost Management」のホームで、自分がどちらのプランか・クレジット残高を確認しておく。

### 4. IAM Identity Center で普段使いユーザーを作る

1. **リージョンを「アジアパシフィック (東京) ap-northeast-1」にしてから** IAM Identity Center を開き「有効にする」
   （Identity Center は有効化したリージョンに固定されるので最初に注意）
2. 「ユーザー」→ ユーザーを追加（自分用。メールで招待が届くのでパスワードと MFA を設定）
3. 「許可セット」→ 事前定義済み →「AdministratorAccess」で作成
4. 「AWS アカウント」→ 自分のアカウントを選択 →「ユーザーまたはグループを割り当て」→ 作ったユーザー + AdministratorAccess
5. 「設定」→ **AWS アクセスポータルの URL**（`https://d-xxxxxxxxxx.awsapps.com/start`）をメモ

- [ ] 完了（アクセスポータル URL を控えた）

### 5. AWS CLI を SSO でログインできるようにする

ターミナルで：

```bash
aws configure sso
```

聞かれる項目：

| 項目 | 入力 |
|---|---|
| SSO session name | `study`（任意の名前） |
| SSO start URL | 手順4でメモしたアクセスポータル URL |
| SSO region | `ap-northeast-1` |
| SSO registration scopes | そのまま Enter |
| （ブラウザが開くので許可） | |
| CLI default client Region | `ap-northeast-1` |
| CLI default output format | `json` |
| Profile name | `study` |

動作確認：

```bash
aws sts get-caller-identity --profile study
```

自分のアカウントIDと `AWSReservedSSO_AdministratorAccess_...` が表示されれば成功。

翌日以降、セッションが切れたら：

```bash
aws sso login --profile study
```

- [ ] 完了

---

## 理解度チェック（SAA にも出る）

- root ユーザーでしかできない操作の例を1つ挙げられる？
- IAM ユーザー + アクセスキー と、IAM Identity Center (SSO) の違いは？
- 「認証 (Authentication)」と「認可 (Authorization)」の違いは？ 今回の設定ではそれぞれどれに当たる？
