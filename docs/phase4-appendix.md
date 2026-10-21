# Phase 4 付録: 独自ドメインと HTTPS・使わなかった構成

> Phase 4 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase4-setup.md](phase4-setup.md) と知識まとめ [phase4-study.md](phase4-study.md) を読んだあとに。

この付録では次の6つをまとめる。

- **A. 独自ドメインと HTTPS**：Route 53 と ACM で、ALB を HTTPS にする
- **B. プライベートサブネットに EC2 を置く**：NAT ゲートウェイと VPC エンドポイント
- **C. 負荷に応じて自動で増減させる**：スケーリングポリシー
- **D. 起動テンプレートを更新して入れ替える**：インスタンスの更新
- **E. スティッキーセッション**：同じ利用者を同じサーバーに送る
- **F. ALB 以外のロードバランサー**：NLB と GWLB

---

## A. 独自ドメインと HTTPS

本編では、ALB の DNS 名に HTTP でアクセスした。自分のドメイン（例：`status.example.com`）で、HTTPS でアクセスできるようにする。

### 必要なもの

| 部品 | 役割 | 料金 |
|---|---|---|
| ドメイン | サイトの名前 | 年に数ドル〜（`.com` なら年 $15 前後）。**AWS のクレジットでは払えない** |
| Route 53 のホストゾーン | ドメインの DNS を管理する | 月 $0.50 |
| ACM の証明書 | HTTPS の暗号化に使う | 無料 |

> ⚠️ 新方式の無料プランのアカウントでは、ドメインの登録ができない、または有料プランへの切り替えが必要な場合がある。すでに他の登録業者（お名前.com など）で持っているドメインがあれば、そのドメインの一部（サブドメイン）を Route 53 に任せる方法もある。

### 手順の流れ

| # | やること | 画面 |
|---|---|---|
| 1 | ドメインを登録する（Route 53、または他の登録業者） | Route 53 →「ドメインの登録」 |
| 2 | ホストゾーンを用意する（Route 53 で登録すると自動で作られる） | Route 53 →「ホストゾーン」 |
| 3 | 証明書をリクエストする：ドメイン名 `status.example.com`、検証方法「DNS 検証」 | ACM →「証明書をリクエスト」（**ALB と同じリージョン** で） |
| 4 | 証明書の画面の「Route 53 でレコードを作成」で、検証用のレコードを置く → 状態が「発行済み」になるまで待つ | ACM |
| 5 | `statuspage-alb-sg` に、HTTPS 443 のルール（自分の IP から）を追加する | EC2 → セキュリティグループ |
| 6 | ALB にリスナー「HTTPS : 443」を追加：転送先 `statuspage-api-tg`、証明書は手順3のもの | EC2 → ロードバランサー →「リスナーとルール」 |
| 7 | HTTP 80 のリスナーのアクションを「URL にリダイレクト」（HTTPS、443、ステータスコード 301）に変える | 同上 |
| 8 | Route 53 のホストゾーンに、レコード `status.example.com`、タイプ A、**エイリアス** → 「Application Load Balancer」→ `statuspage-alb` を作る | Route 53 |
| 9 | ブラウザで `https://status.example.com/` を開く | — |

### ポイント

- **エイリアスレコード**：Route 53 だけの機能。ALB の DNS 名を指す A レコードを作れる。ALB の IP アドレスが変わっても、自動で追いかける。エイリアスで AWS のリソースを指す問い合わせは無料
- **DNS 検証**：ACM は「このドメインの DNS に、指定したレコードを置けるか」で持ち主かを確かめる。レコードを残しておけば、証明書は期限前に自動で更新される
- **CloudFront で使う証明書** は、us-east-1 で作る必要がある（Phase 8）。新方式のアカウントでは他のリージョンにリソースを作れないので、制限を受ける可能性がある
- ALB を削除して作り直したら、手順6〜8をやり直す（証明書とホストゾーンはそのまま使える）

---

## B. プライベートサブネットに EC2 を置く

本編では、api と worker の EC2 をパブリックサブネットに置き、受信はセキュリティグループで ALB からだけにした。より守りを固めるなら、EC2 もプライベートサブネットに置く。

```
Internet ── ALB (public subnets) ──▶ EC2 (private subnets) ──▶ RDS (private subnets)
                                        │
                                        └──▶ NAT gateway (public subnet) ──▶ Internet
```

| | パブリックサブネット（本編） | プライベートサブネット |
|---|---|---|
| EC2 のパブリック IP | あり | **なし**（インターネットから届く住所がない） |
| 外からの守り | セキュリティグループだけ | ルートとセキュリティグループの2重 |
| EC2 からインターネットへ出る方法 | パブリック IP + IGW | **NAT ゲートウェイ** が必要 |
| 料金 | パブリック IPv4 が 1台 $0.005 / 時間 | NAT ゲートウェイが 約 $0.06 / 時間（月 約 $43）+ 通ったデータ量 |

### NAT ゲートウェイ

プライベートサブネットのインスタンスが、**外へ出る通信だけ** をできるようにする中継役。外から内へは入れない。

- パブリックサブネットに置き、プライベートサブネットのルートテーブルに `0.0.0.0/0` → NAT ゲートウェイ を書く
- 置いておくだけで時間の料金がかかる。学習で一番の落とし穴（[phase0-study §6](phase0-study.md#6-お金の管理)）
- AZ ごとに置かないと、NAT ゲートウェイの AZ が止まったときに、ほかの AZ のインスタンスも外へ出られなくなる

### VPC エンドポイント

インターネットを通らずに、VPC の中から AWS のサービス（Secrets Manager、Systems Manager、S3 など）に届く入口。

| 種類 | 対象 | 料金 |
|---|---|---|
| ゲートウェイ型 | S3、DynamoDB | 無料 |
| インターフェイス型 | ほとんどのサービス | 1つ・1つの AZ ごとに 約 $0.01 / 時間 + データ量 |

Session Manager をプライベートサブネットで使うには、`ssm`、`ssmmessages`、`ec2messages` の3つのインターフェイス型エンドポイントが必要になる。

このアプリの worker は、**外部のサイトを監視する** ので、インターネットへ出る経路（NAT ゲートウェイ）がどちらにしても必要になる。

---

## C. 負荷に応じて自動で増減させる

本編では台数を手で変えた。スケーリングポリシーを付けると、Auto Scaling が希望するキャパシティを自動で変える。

| ポリシー | 動き | 例 |
|---|---|---|
| ターゲット追跡 | 指標を目標値に保つように増減する | 平均 CPU 使用率を 50% に保つ |
| ステップ | アラームの段階ごとに、決めた台数を増減する | CPU が 70% を超えたら +1、90% なら +2 |
| スケジュール | 決めた時刻に台数を変える | 平日の 9時に 4台、20時に 2台 |
| 予測 | 過去の傾向から、先回りして増やす | 毎朝の増加に備える |

### ターゲット追跡を試すなら

1. `statuspage-api-asg` →「自動スケーリング」→「動的スケーリングポリシーを作成」→ ターゲット追跡、指標「平均 CPU 使用率」、ターゲット値 50
2. 負荷をかける（例：手元から大量にアクセスする、または Session Manager で `yes > /dev/null &` を実行して CPU を使い切る）
3. 「アクティビティ」タブで、台数が増え、負荷を止めると数分〜十数分かけて減ることを確かめる

- 増やすのは早く、減らすのはゆっくり（行ったり来たりを防ぐため）
- `t4g` はバースト可能なインスタンスなので、CPU を使い続けると追加料金がかかることがある（[phase2-study §1](phase2-study.md#1-ec2)）。試したら負荷はすぐ止める
- 増える台数の上限は、グループの「最大」で決まる。最大を大きくしすぎない

---

## D. 起動テンプレートを更新して入れ替える

起動テンプレートを変えても（新しいバージョンを作っても）、動いているインスタンスはそのまま。全台を新しい設定に入れ替えるには、**インスタンスの更新**（Instance refresh）を使う。

1. 起動テンプレートの新しいバージョンを作る（例：インスタンスタイプを変える）
2. `statuspage-api-asg` →「インスタンスの更新」→「インスタンスの更新を開始」
3. 「最小正常率」（例：50%）を決める。Auto Scaling は、正常なインスタンスがこの割合を下回らないように、少しずつ入れ替える

| 設定 | 意味 |
|---|---|
| 最小正常率 | 入れ替え中も、これだけの割合は正常なインスタンスを保つ。100% にすると、先に新しいものを作ってから古いものを消す |
| ウォームアップ | 新しいインスタンスが使えるようになるまで待つ時間 |
| スキップマッチング | すでに新しい設定のインスタンスは入れ替えない |

- コードを更新したいだけの場合も、このプロジェクトでは起動時に `git clone` しているので、インスタンスを入れ替えれば最新のコードになる。ただし、これは「起動するたびに、そのときの `main` を使う」ということでもあり、意図しない変更が入るおそれがある。Phase 6 で、デプロイの仕組みとして整える
- 台数1の worker のグループで、最小正常率を 100% にすると、一時的に新旧2台の worker が動き、監視が二重になる（[study §8](phase4-study.md#8-複数台で動かすときの注意)）。0% にすると、入れ替えの間は監視が止まる

---

## E. スティッキーセッション

**同じ利用者のリクエストを、しばらく同じターゲットに送り続ける** 機能。ALB が Cookie を発行して、利用者を見分ける。

- ログインの状態などをサーバーのメモリに持つアプリを、複数台で動かすときの応急処置
- そのターゲットが止まると、利用者の状態は失われる。負荷も偏りやすい
- 本来は、状態を DB やキャッシュ（ElastiCache など）に置き、どのサーバーでも同じように処理できるようにする（ステートレス）。このアプリは状態を持たないので不要

ターゲットグループの「属性」→「スティッキーネス」で設定できる。

---

## F. ALB 以外のロードバランサー

| | ALB（本編） | NLB | GWLB |
|---|---|---|---|
| 正式名 | Application Load Balancer | Network Load Balancer | Gateway Load Balancer |
| 見るもの | HTTP の中身（パス、ホスト名、ヘッダー） | TCP / UDP の接続（中身は見ない） | すべての通信 |
| 向いているもの | Web アプリ、API | ゲーム、IoT、固定 IP が必要なもの、とても多い接続 | ファイアウォールなど、通信を検査する機器に通す |
| 固定の IP アドレス | 持てない（DNS 名を使う） | AZ ごとに持てる（Elastic IP も付けられる） | — |
| HTTPS の終端 | できる | TLS の終端はできる | — |

- 以前は Classic Load Balancer（CLB）もあったが、新しく使うものではない
- HTTP のアプリなら、まず ALB を選ぶ

---

## 参考

- [Registering a new domain（Route 53）](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/domain-register.html)
- [Routing traffic to an ELB load balancer（エイリアスレコード）](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-elb-load-balancer.html)
- [DNS validation（ACM）](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [HTTPS listeners for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [Access an AWS service using an interface VPC endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html)
- [Dynamic scaling for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html)
- [Use an instance refresh to update instances in an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-instance-refresh.html)
- [Sticky sessions for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/sticky-sessions.html)
- [Elastic Load Balancing features（ALB / NLB / GWLB の比較）](https://aws.amazon.com/elasticloadbalancing/features/)
