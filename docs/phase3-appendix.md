# Phase 3 付録: 使わなかった DB の機能・つなぎ方

> Phase 3 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase3-setup.md](phase3-setup.md) と知識まとめ [phase3-study.md](phase3-study.md) を読んだあとに。

この付録では次の7つをまとめる。

- **A. Multi-AZ 配置とリードレプリカ**：DB を止めない・読み込みを分散する
- **B. Aurora**：AWS が作り直した、PostgreSQL・MySQL 互換の DB
- **C. IAM データベース認証**：パスワードの代わりに IAM で DB にログインする
- **D. RDS Proxy**：DB への接続をまとめる中継役
- **E. シークレットを自動で変える**：ローテーションとアプリの読み方
- **F. 証明書まで確かめる接続**：`sslmode=verify-full`
- **G. 手元の PC から RDS につなぐ**：Session Manager のポートフォワーディング

---

## A. Multi-AZ 配置とリードレプリカ

### Multi-AZ 配置

**別の AZ に、常に同じ内容の予備（スタンバイ）を置いておく配置。**

| | Single-AZ（本編） | Multi-AZ |
|---|---|---|
| DB インスタンス | 1台 | 本番用 + 予備（別の AZ） |
| 予備への書き込み | — | 本番への書き込みが、予備にも同時に書かれる（同期レプリケーション） |
| AZ の障害、本番の故障 | 復旧するまで止まる | 自動で予備に切り替わる（フェイルオーバー、通常1〜2分） |
| エンドポイント | — | 切り替わっても **同じ名前のまま**。名前の指す先を AWS が書き換える |
| 予備に読み込みを流せるか | — | 流せない（あくまで予備） |
| 料金 | 1倍 | おおよそ2倍 |

本番のサービスでは、まず Multi-AZ にするのが基本。アプリが IP アドレスではなくエンドポイントでつなぐ理由の1つが、このフェイルオーバー。

### リードレプリカ

**読み込み専用のコピー。** 本番への書き込みが、少し遅れてコピーにも反映される（非同期レプリケーション）。

| | Multi-AZ のスタンバイ | リードレプリカ |
|---|---|---|
| 目的 | **止まらない**（可用性） | **読み込みを分散する**（性能） |
| 読み込みを流せるか | 流せない | 流せる（別のエンドポイント） |
| 遅れ | なし（同期） | 少しある（非同期） |

このアプリなら、ステータスページの表示（読み込み）をリードレプリカに、worker の記録（書き込み）を本番に流す、という分け方ができる。

---

## B. Aurora

**AWS が PostgreSQL・MySQL と互換になるように作り直した DB。** 使い方（SQL、ドライバ）はほぼ同じ。

| | RDS for PostgreSQL（本編） | Aurora PostgreSQL |
|---|---|---|
| ストレージ | DB インスタンスごとの EBS | 3つの AZ にまたがる、Aurora 専用のストレージ（6つのコピー） |
| 容量 | 自分で決める | 使った分だけ自動で増える |
| フェイルオーバー | Multi-AZ で1〜2分 | 通常 30秒程度 |
| リードレプリカ | 最大15台 | 最大15台。ストレージを共有するので遅れが小さい |
| 料金 | 安い（小さな構成なら） | 高め。大きな構成や、高い可用性が必要なときに向く |
| Aurora Serverless v2 | — | 負荷に合わせて大きさが自動で変わる。使わない間は最小まで縮む |

---

## C. IAM データベース認証

**DB のパスワードの代わりに、IAM の一時的な認証トークンで DB にログインする方式。**

| 順番 | 内容 |
|---|---|
| ① | EC2 のロールに `rds-db:connect` の権限を付ける |
| ② | アプリが、IAM の認証情報から **15分だけ有効なトークン** を作る（AWS の SDK の関数で作る） |
| ③ | トークンをパスワードの代わりに使って、DB にログインする |

| 利点 | 注意点 |
|---|---|
| DB のパスワードを保管・配布しなくてよい | アプリのコードで、接続のたびにトークンを作る必要がある |
| Phase 0 から使っている「IAM で認証する」考え方を DB にも使える | 1秒あたりの新しい接続の数に上限がある。接続を使い回す（接続プール）か RDS Proxy と組み合わせる |

---

## D. RDS Proxy

**アプリと DB の間に置く、AWS が管理する中継役。** DB への接続をまとめて使い回す（接続プール）。

| 向いている場面 | 理由 |
|---|---|
| Lambda から DB を使う（Phase 8） | Lambda は一度に何百も起動することがあり、それぞれが DB に接続すると DB の接続の上限を超える。RDS Proxy が接続を少数にまとめる |
| フェイルオーバーを速くしたい | RDS Proxy が切り替えを吸収し、アプリから見た中断が短くなる |
| IAM 認証やシークレットを中継役に任せたい | アプリは RDS Proxy に IAM でつなぎ、RDS Proxy が Secrets Manager のパスワードで DB につなぐ |

DB インスタンスの大きさに応じた時間単位の料金がかかる。

---

## E. シークレットを自動で変える

### ローテーション

Secrets Manager は、決めた間隔でパスワードを自動で変えられる。RDS が管理するマスターパスワード（本編で使用）は、最初から自動で変わる設定になっている。

### アプリがシークレットを読む方法

自動で変わるパスワードを使うには、アプリが **新しい値を取り直せる** 必要がある。

| 方法 | 内容 | 変わったとき |
|---|---|---|
| 設定ファイルに書き写す（本編） | サーバーで1回取り出し、`/etc/statuspage.env` に書く | ファイルを書き直してアプリを再起動するまで、古いまま。**ローテーションと相性が悪い** |
| アプリが起動のたびに読む | アプリのコードで、起動時に Secrets Manager の API を呼ぶ | アプリを再起動すれば新しい値になる |
| アプリが接続エラーのたびに読み直す | 認証に失敗したら、シークレットを読み直して接続し直す | 自動で追従する |
| ECS がシークレットを環境変数として渡す（Phase 7） | タスク定義に「この環境変数はこのシークレットから」と書く | 新しいタスクを起動すれば新しい値になる |

ECS の方法なら、アプリのコードは「環境変数から読む」のままでよい。このプロジェクトが「設定はすべて環境変数から読む」と決めている理由の1つ。

### ローテーションの2つの方式

| 方式 | 内容 |
|---|---|
| シングルユーザー | 1つのユーザーのパスワードを変える。変わる瞬間に、古いパスワードでの接続が失敗しうる |
| 交互ユーザー | ユーザーを2つ用意し、交互に使う。片方を変えている間も、もう片方で接続できる |

---

## F. 証明書まで確かめる接続

`sslmode=require` は暗号化するが、**相手が本物の RDS か** は確かめない。理論上、通信の途中に割り込んだ偽の DB にもつながってしまう（中間者攻撃）。

`sslmode=verify-full` にすると、次の2つを確かめる。

| 確かめること | 方法 |
|---|---|
| 相手の証明書が、信頼できる発行元（認証局）のものか | RDS の CA 証明書（AWS が公開している、リージョンごとのバンドル）をサーバーに置き、`sslrootcert` で指定する |
| 証明書の名前が、つなぎに行ったエンドポイントと一致するか | 自動（`verify-full` の `full` の部分） |

```
postgresql+psycopg://statuspage:<パスワード>@<エンドポイント>:5432/statuspage?sslmode=verify-full&sslrootcert=/etc/pki/rds/global-bundle.pem
```

RDS の証明書は数年ごとに切り替わる。切り替えの時期には、置いた CA 証明書も新しいものにする。

---

## G. 手元の PC から RDS につなぐ

本編では、RDS に手元の PC から直接つなげないことを確かめる。それでも、手元の DB クライアント（psql や GUI のツール）で中を見たいときがある。

**Session Manager のポートフォワーディング** を使うと、EC2 を中継役にして、手元の PC から RDS につなげる。22番も 5432番もインターネットに開けなくてよい。

```bash
aws ssm start-session --profile study \
  --target <インスタンスID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<RDS のエンドポイント>"],"portNumber":["5432"],"localPortNumber":["15432"]}'
```

| 部分 | 意味 |
|---|---|
| `--target` | 中継役の EC2（`statuspage-web-sg` が付いていて、RDS に届くもの） |
| `AWS-StartPortForwardingSessionToRemoteHost` | 「EC2 の先にある別のホストへ転送する」方式 |
| `localPortNumber` | 手元の PC で待ち受けるポート。手元の PostgreSQL とぶつからない番号にする |

実行したまま、別のターミナルで `psql -h localhost -p 15432 -U statuspage -d statuspage` とつなぐ。

| 必要なもの | 理由 |
|---|---|
| 手元の PC に Session Manager プラグイン | AWS CLI がポートフォワーディングに使う |
| 自分の IAM 権限（`ssm:StartSession`） | 新方式の管理者ロールなら持っている |

通信は「手元の PC → AWS（Systems Manager）→ EC2 の SSM エージェント → RDS」と流れる。Phase 2 の §7 の、エージェントが外へ張っている接続を使う。

---

## 参考

- [Multi-AZ DB instance deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [Working with read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [What is Amazon Aurora?](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html)
- [IAM database authentication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html)
- [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- [Rotate AWS Secrets Manager secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [Using SSL/TLS to encrypt a connection to a DB instance（CA 証明書）](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)
- [Session Manager のポートフォワーディング](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding)
