# Phase 0 付録: 従来方式のアカウント・高度な機能

> Phase 0 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase0-setup.md](phase0-setup.md) と知識まとめ [phase0-study.md](phase0-study.md) は、新方式（Sign up for AWS (new)）のアカウントが前提。

この付録では次の2つをまとめる。

- **A. 従来方式（Sign up for AWS (advanced)）** のアカウントを作る・守る手順
- **B. 新方式から「高度な機能」を有効化** するとどうなるか

SAA 試験や実務の記事は、ほとんどが従来方式を前提にしている。今は使わなくても、仕組みとして理解しておく価値がある。

## どんなときに従来方式が必要か

- 東京リージョン (`ap-northeast-1`) など、リージョンを自分で選びたい
- 複数リージョンを使う構成（例：CloudFront 用の証明書を us-east-1 に作る）
- IAM Identity Center や AWS Organizations を自分で設定して学びたい
- 新方式の対応リストにないサービスを使いたい

> ⚠️ 無料プランやクレジットは「新規の AWS 顧客」が対象。過去にアカウントを持っていると対象外になる場合がある。2つ目のアカウントを作る前に条件を確認する。

---

## A. 従来方式のアカウント

### 全体像

```
rootユーザー（メールアドレス + パスワードでログイン）
  └─ 最強の権限。請求・アカウント解約まで何でもできる
     → MFA をつけて金庫にしまう。普段は使わない

IAM Identity Center のユーザー（普段使い）
  └─ 「AdministratorAccess」の権限セットを割り当てる
     → コンソールも CLI もこのユーザーで使う
     → CLI は一時的な認証情報で動くので、キーが漏れる心配が少ない
```

**なぜ root を使わないのか：** root は権限を制限できない唯一のユーザー。乗っ取られるとアカウントごと失う。

### A-0. アカウントを作る

1. https://aws.amazon.com/ →「アカウントを作成」→ メールアドレスで登録する方式（advanced）を選ぶ
2. メールアドレス（= root ユーザー）とアカウント名を入力 → 届いた確認コードを入力
3. root ユーザーのパスワードを設定（長くランダムに。パスワードマネージャー推奨）
4. 連絡先情報：「個人」を選び、住所などを**英語表記**で入力
5. クレジットカードを登録（本人確認のため、少額の仮請求が出ることがある）
6. 電話番号の SMS / 音声で本人確認
7. **プランを選ぶ：「無料プラン」**（クレジットの範囲内でしか使えないので、意図しない請求が起きない）
8. サポートプラン：「ベーシック（無料）」

メールアドレスは **長く使い続けられるもの** にする。使えなくなるアドレスだと、root のパスワードを再設定できなくなる。

### A-1. root ユーザーに MFA を設定する

1. root ユーザーでコンソールにログイン
2. 右上のアカウント名 →「セキュリティ認証情報」
3. 「多要素認証 (MFA)」→「MFA デバイスの割り当て」→ 認証アプリまたはパスキー / セキュリティキーを登録
4. 予備としてもう1つ登録しておく（root には MFA デバイスを複数登録できる）

### A-2. 請求情報を IAM ユーザーからも見られるようにする

root のまま、右上のアカウント名 →「アカウント」→「IAM ユーザーおよびロールによる請求情報へのアクセス」を **有効化**。
（これをしないと、普段使いのユーザーで請求画面が見られない）

### A-3. 予算アラートを作る（Budgets）

1. 「Billing and Cost Management」→「予算 (Budgets)」→「予算を作成」
2. テンプレートで **「ゼロ支出予算」** を作成 → 1セントでも課金されたらメールが届く
3. **「月次コスト予算」** を作成（例：$10）

あわせて「請求設定 (Billing preferences)」で **無料利用枠の使用アラート** を有効化する。

### A-4. IAM Identity Center で普段使いユーザーを作る

1. **先にリージョンを選んでから** IAM Identity Center を開き「有効にする」
   （Identity Center は有効化したリージョンに固定されるので注意）
2. 「ユーザー」→ ユーザーを追加（招待メールが届くので、パスワードと MFA を設定する）
3. 「許可セット」→ 事前定義済み →「AdministratorAccess」で作成
4. 「AWS アカウント」→ 自分のアカウントを選択 →「ユーザーまたはグループを割り当て」→ 作ったユーザー + AdministratorAccess
5. 「設定」→ **AWS アクセスポータルの URL**（`https://d-xxxxxxxxxx.awsapps.com/start`）をメモ（リポジトリには書かない）

### A-5. AWS CLI を SSO でログインできるようにする

```bash
aws configure sso
```

| 項目 | 入力 |
|---|---|
| SSO session name | `study`（任意の名前） |
| SSO start URL | A-4 でメモしたアクセスポータル URL |
| SSO region | Identity Center を有効化したリージョン |
| SSO registration scopes | そのまま Enter |
| （ブラウザが開くので許可） | |
| CLI default client Region | 使うリージョン（例：`ap-northeast-1`） |
| CLI default output format | `json` |
| Profile name | `study` |

動作確認：

```bash
aws sts get-caller-identity --profile study
```

`AWSReservedSSO_AdministratorAccess_...` が表示されれば成功。セッションが切れたら `aws sso login --profile study` でログインし直す。

> 💡 新しめの AWS CLI では、従来方式のアカウントでも `aws login` でコンソールのログイン情報を使ってログインできる。

---

## B. 新方式で「高度な機能」を有効化する

新方式のアカウントは、AWS Settings →「Projects」→「Actions」→「Explore advanced features」から、従来方式とほぼ同じ自由度に切り替えられる。

### 前提

- **有料プランへのアップグレードが必要**（クレジットカードを登録する）
- **元に戻せない**

### 有効化すると変わること

| 項目 | 変化 |
|---|---|
| 組織 (AWS Organizations) | 自分が管理者になる。SCP / RCP（組織のルール）を自分で編集できる |
| root ユーザー | 管理アカウント用の root メールアドレスとパスワードを設定する → **A-1 と同じく MFA で封印する** |
| リージョン | 他のリージョン（東京など）やマルチリージョン構成が使える。使うリージョンは SCP で制限する |
| サービス | すべてのサービスが使える |
| ユーザー管理 | IAM Identity Center で管理できる（Builder ID のままでもよい） |
| 費用管理 | 支出上限 (spend limit) は **なくなる** → 代わりに Budgets や Cost Anomaly Detection で監視する |
| コンソール | リージョンを選ぶメニューなどが表示されるようになる |

### 有効化する前にやること

- 不要なリソースを削除しておく（支出上限がなくなり、使った分だけ請求される）
- 使う予定のリージョンを決めて、リージョン制限の SCP（`RegionFloor`）を見直す計画を立てる
- AI コーディングツールに新方式用のルールファイルを入れている場合は、それを削除する

## 参考

- [Sign up for AWS (advanced)](https://docs.aws.amazon.com/accounts/latest/reference/getting-started.html)
- [Compare sign-up options](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
- [Activate advanced AWS features](https://docs.aws.amazon.com/accounts/latest/reference/activate-advanced-features.html)
- [IAM Identity Center とは](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html)
