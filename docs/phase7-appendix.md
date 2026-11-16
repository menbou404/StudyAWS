# Phase 7 付録: 使わなかったコンテナまわりの仕組み

> Phase 7 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase7-setup.md](phase7-setup.md) と知識まとめ [phase7-study.md](phase7-study.md) を読んだあとに。

この付録では次の6つをまとめる。

- **A. EC2 起動タイプと容量プロバイダー**：自分の EC2 の上でタスクを動かす
- **B. ブルー/グリーンデプロイ**：新しい組を丸ごと用意してから切り替える
- **C. プライベートサブネットに置く**：タスクにパブリック IP を付けない構成
- **D. ECS Exec**：動いているコンテナの中に入る
- **E. ECS 以外の選択肢**：EKS、App Runner
- **F. Fargate Spot**：安いが、途中で止められることがある

---

## A. EC2 起動タイプと容量プロバイダー

本編の Fargate では、タスクを動かすマシンを AWS が用意する。**EC2 起動タイプ** では、自分の EC2（ECS 用の AMI）をクラスターに登録し、その上でタスクを動かす。

| | Fargate（本編） | EC2 起動タイプ |
|---|---|---|
| マシンの管理 | いらない | Auto Scaling グループで EC2 を用意し、OS を更新する |
| 1台のマシンに | 1タスク（見えない） | 複数のタスクを詰め込める |
| 料金 | タスクの大きさ × 時間 | EC2 の料金（詰め込むほど安くなる） |
| 使えるもの | 決まった CPU・メモリの組み合わせ | GPU、大きなメモリなど、EC2 の種類を選べる |

**容量プロバイダー**（Capacity Provider）は、「タスクをどこで動かすか」を決める仕組み。EC2 の Auto Scaling グループを容量プロバイダーにすると、タスクが増えたときに EC2 も自動で増やしてくれる（マネージドスケーリング）。Fargate と Fargate Spot（F）も容量プロバイダーとして指定できる。

最近は、EC2 の管理も AWS に任せる **ECS マネージドインスタンス** もある。

---

## B. ブルー/グリーンデプロイ

本編のローリング更新は、同じサービスの中で古いタスクを少しずつ新しいものに入れ替える。**ブルー/グリーン** は、新しいバージョンの組（グリーン）を丸ごと用意し、ALB の向き先を一度に切り替える。

| | ローリング更新（本編） | ブルー/グリーン |
|---|---|---|
| 切り替え | 少しずつ。古いものと新しいものが混ざる | 一度に（または段階的に） |
| 戻すとき | もう一度入れ替える | 向き先を古い組に戻すだけ。速い |
| 切り替える前の確認 | できない | テスト用のリスナーで、新しい組だけに送って確かめられる |
| 必要なもの | サービスの設定だけ | ターゲットグループ2つ、リスナーのルール |

ECS では、サービスのデプロイの設定でブルー/グリーンを選べる（以前は CodeDeploy が必要だった）。少しずつ流す量を増やすカナリアやリニアも選べる。

---

## C. プライベートサブネットに置く

本編では、NAT ゲートウェイの費用を避けるため、タスクをパブリックサブネットに置いてパブリック IP を付けた。実務では、タスクをプライベートサブネットに置くことが多い。

| 方法 | タスクが外に出る道 | 費用（目安） | 監視先の URL へ |
|---|---|---|---|
| パブリックサブネット + パブリック IP（本編） | インターネットゲートウェイ | タスクごとのパブリック IPv4 | 届く |
| プライベートサブネット + NAT ゲートウェイ | NAT ゲートウェイ | NAT ゲートウェイの時間の料金（AZ ごと）+ 通信量 | 届く |
| プライベートサブネット + VPC エンドポイント | AWS の中だけ | エンドポイントの種類 × AZ ごとの時間の料金 | **届かない** |

VPC エンドポイントだけで動かすには、次のものが要る。

| エンドポイント | 使い道 |
|---|---|
| `com.amazonaws.<リージョン>.ecr.api`・`ecr.dkr`（インターフェイス型） | イメージの取得 |
| `com.amazonaws.<リージョン>.s3`（ゲートウェイ型、無料） | イメージの中身（レイヤー）は S3 に置かれている |
| `com.amazonaws.<リージョン>.logs` | CloudWatch Logs へのログ |
| `com.amazonaws.<リージョン>.secretsmanager` | 秘密の読み取り |

このプロジェクトの worker は、インターネット上の URL を監視するので、エンドポイントだけでは足りない（NAT ゲートウェイが要る）。

---

## D. ECS Exec

EC2 では Session Manager でインスタンスに入れた。**ECS Exec** を使うと、動いているコンテナの中でコマンドを実行できる。

```bash
aws ecs execute-command --cluster <クラスター> --task <タスクID> --container api --interactive --command "/bin/sh"
```

| 必要なもの | 内容 |
|---|---|
| サービスの設定 | `enableExecuteCommand: true` |
| タスクロール | Session Manager のチャンネルを開く権限（`ssmmessages:*` の一部） |
| 手元 | AWS CLI と Session Manager プラグイン |

- 本番のコンテナに入って直すのは、入れ替えたら消える変更になるので避ける。調べるために使う
- 誰がいつ入ったかを CloudTrail に残せる。入れる人を IAM で絞る

---

## E. ECS 以外の選択肢

| サービス | 特徴 | 向いているとき |
|---|---|---|
| **ECS**（本編） | AWS 独自。部品が少なく、AWS の他のサービスとつなぎやすい | AWS だけで動かす |
| **EKS** | Kubernetes。部品が多く、設定の自由度が高い。他のクラウドや手元とも同じ書き方 | 既に Kubernetes を使っている、複数のクラウドで動かす |
| **App Runner** | イメージを渡すだけで、ロードバランサー・HTTPS・台数の増減まで自動 | 設定をほとんどしたくない、小さな Web アプリ |
| **Lambda**（Phase 8） | リクエストやイベントのたびに関数を動かす。動いていない間は無料 | 処理が短く、来るときと来ないときの差が大きい |

EKS は、コントロールプレーン（Kubernetes の頭脳）だけで1時間ごとの料金がかかるので、学習で試すときは注意する。

---

## F. Fargate Spot

AWS の余っている容量を使う Fargate。通常の Fargate より大幅に安いが、AWS が容量を必要としたら、**2分前の知らせ（SIGTERM）の後に止められる**。

| | Fargate | Fargate Spot |
|---|---|---|
| 料金 | 通常 | 大幅に安い |
| 止められること | ない | ある（2分前に知らせ） |
| 向いているもの | api のように止まると困るもの | バッチ処理、止まってもやり直せるもの |

容量プロバイダーの戦略で、「最低1個は Fargate、残りは Fargate Spot」のように混ぜられる。SIGTERM を受けたら今の処理を終える作り（study §9）が、ここでも役に立つ。

---

## 参考

- [Amazon ECS: 容量プロバイダー](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/cluster-capacity-providers.html)
- [Amazon ECS: ブルー/グリーンデプロイ](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/deployment-type-blue-green.html)
- [Amazon ECS: インターフェイス VPC エンドポイント](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/vpc-endpoints.html)
- [Amazon ECR: インターフェイス VPC エンドポイント](https://docs.aws.amazon.com/ja_jp/AmazonECR/latest/userguide/vpc-endpoints.html)
- [Amazon ECS: ECS Exec でデバッグする](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/ecs-exec.html)
- [AWS App Runner とは](https://docs.aws.amazon.com/ja_jp/apprunner/latest/dg/what-is-apprunner.html)
- [Amazon EKS とは](https://docs.aws.amazon.com/ja_jp/eks/latest/userguide/what-is-eks.html)
- [Amazon ECS: Fargate Spot](https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/fargate-capacity-providers.html)
