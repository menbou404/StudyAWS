# Phase 2 付録: 使わなかったサーバーの入り方・ネットワークの機能

> Phase 2 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase2-setup.md](phase2-setup.md) と知識まとめ [phase2-study.md](phase2-study.md) を読んだあとに。

この付録では次の6つをまとめる。

- **A. SSH とキーペア**：従来のサーバーへの入り方
- **B. Session Manager のポートフォワーディング**：80番を開けずにページを見る
- **C. Elastic IP**：パブリック IP アドレスを固定する
- **D. ネットワーク ACL**：サブネット単位のファイアウォール
- **E. ユーザーデータ**：起動時にセットアップを自動で行う
- **F. デフォルト VPC**：AWS が最初から用意している VPC

---

## A. SSH とキーペア

### 仕組み

インスタンスの起動時に **キーペア**（公開鍵と秘密鍵の組）を指定すると、公開鍵がインスタンスに置かれる。手元の秘密鍵（`.pem` ファイル）を使って SSH で接続する。

```bash
ssh -i statuspage-key.pem ec2-user@<パブリック IP>
```

| 必要なもの | 内容 |
|---|---|
| キーペア | 起動時に作成し、秘密鍵（`.pem`）を1回だけダウンロードできる |
| セキュリティグループ | 22番（SSH）を、接続元の IP アドレスから許可する |
| パブリック IP | 外から届くアドレス |

### 本編で使わなかった理由

| | SSH | Session Manager（本編） |
|---|---|---|
| 22番を開ける | 必要 | 不要 |
| 鍵の管理 | 秘密鍵を PC ごとにコピーし、なくさず、漏らさないよう管理する | 不要 |
| PC が2台ある場合 | 両方に秘密鍵を置き、両方の IP を許可する | AWS にログインできればよい |
| 誰が入ったかの記録 | 自分で仕組みを作る | CloudTrail に残る |

- 秘密鍵をなくすと、そのキーペアでは二度と入れない
- `.pem` は `.gitignore` で除外している。リポジトリに入れると、鍵が公開されてしまう

### EC2 Instance Connect

SSH の一種で、接続のたびに一時的な公開鍵を AWS がインスタンスに送り込む方式。秘密鍵を長く保管しなくてよい。22番は開ける必要がある（エンドポイント経由の方式を除く）。

---

## B. Session Manager のポートフォワーディング

Session Manager の接続を使って、**手元の PC のポートを、インスタンスのポートにつなぐ** 機能。セキュリティグループで 80番を開けなくても、ステータスページを見られる。

```bash
aws ssm start-session --profile study \
  --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["80"],"localPortNumber":["8080"]}'
```

実行している間、手元のブラウザで http://localhost:8080/ を開くと、インスタンスの 80番につながる。

| | セキュリティグループで 80番を開ける（本編） | ポートフォワーディング |
|---|---|---|
| 受信ポート | 80番を自分の IP から | **何も開けない** |
| IP アドレスが変わったとき | ルールを更新する | 何もしなくてよい |
| 準備 | なし | 各 PC に AWS CLI と **Session Manager プラグイン** を入れる |
| 見られる人 | 許可した IP の人 | コマンドを実行している本人だけ |

Session Manager プラグインのインストール：

```bash
brew install --cask session-manager-plugin     # macOS
```

Windows はインストーラ（MSI）を AWS のドキュメントからダウンロードする。

PostgreSQL（5432番）などにも同じ方法でつなげるので、Phase 3 でプライベートサブネットの RDS を手元から確認するときにも使える。

---

## C. Elastic IP

**固定のパブリック IPv4 アドレスを確保して、インスタンスに付ける機能。** 停止と開始をしてもアドレスが変わらない。

| | 自動割り当てのパブリック IP（本編） | Elastic IP |
|---|---|---|
| 停止 → 開始 | 変わる | **変わらない** |
| 料金 | インスタンスの起動中だけ | **確保している間ずっと**（停止中・どこにも付けていなくても） |
| 解放 | 停止・終了で自動 | 自分で「解放」する |

- 確保したまま忘れると、ずっと料金がかかる。使わなくなったら必ず解放する
- 本番では、IP アドレスを固定するより、ALB やドメイン名（Route 53）でアクセスさせるのが一般的（Phase 4）

---

## D. ネットワーク ACL

**サブネットの出入口に付ける、もう1つのファイアウォール。** VPC を作ると、すべて許可する既定のネットワーク ACL が各サブネットに付いている。

| | セキュリティグループ | ネットワーク ACL |
|---|---|---|
| 付ける場所 | インスタンス（ネットワークインターフェース） | サブネット |
| ルール | 許可だけ | 許可と **拒否** |
| 評価 | すべてのルールを見て、どれかで許可されれば通す | 番号の小さい順に見て、最初に当てはまったルールで決める |
| 返事の通信 | 自動で通す（ステートフル） | **自動では通さない**（ステートレス）。返事のポートも許可が必要 |

- ステートレスなので、返事の通信のために「エフェメラルポート」（`1024-65535` など、OS が一時的に使うポート）の許可を書く必要があり、設定を間違えやすい
- 通常は既定（すべて許可）のままにして、セキュリティグループで制御する
- 「特定の IP アドレスからの通信をサブネットごとまとめて拒否したい」ときに使う

---

## E. ユーザーデータ

**インスタンスの初回起動時に、root で自動実行されるスクリプト。** 起動の設定画面の「高度な詳細」→「ユーザーデータ」に書く。

```bash
#!/bin/bash
set -euxo pipefail
dnf install -y git nginx postgresql16-server
useradd --system --create-home --home-dir /var/lib/statuspage --shell /sbin/nologin statuspage
# ... 手順書の 6〜10 を並べる
```

- 実行のログは、インスタンスの中の `/var/log/cloud-init-output.log` に残る
- 手順書の手順6〜10を書いておけば、インスタンスを作るだけでアプリが動く状態になる
- パスワードなどの秘密情報は書かない（ユーザーデータはインスタンスの中から誰でも読める）

### なぜ大事か

| Phase | ユーザーデータの役割 |
|---|---|
| 4 | Auto Scaling は、サーバーを自動で増やすとき、**人の手を介さずに** セットアップする必要がある。起動テンプレートのユーザーデータでそれを行う |
| 5 | CDK でインスタンスを作るとき、ユーザーデータもコードとして管理する |

本編では、1つずつ手で実行して仕組みを理解するために使っていない。

---

## F. デフォルト VPC

新しいアカウントには、各リージョンに AWS が作った **デフォルト VPC** がある。

| 項目 | 内容 |
|---|---|
| CIDR | `172.31.0.0/16` |
| サブネット | AZ ごとに1つ（`/20`）。すべてパブリックサブネット |
| インターネットゲートウェイ | 付いている |
| パブリック IP | サブネットの設定で、自動で割り当てられる |

- インスタンスを起動するとき、VPC を指定しなければここに置かれる。すぐに試せて便利
- ただし、すべてのサブネットがパブリックなので、DB を外から隔離する構成（Phase 3）には向かない
- 本編で自分の VPC を作ったのは、サブネット・ルートテーブル・インターネットゲートウェイが「何のためにあるか」を1つずつ理解するため
- 削除すると、元に戻すには「デフォルト VPC を作成」の操作が必要。消さずに置いておいてよい（VPC 自体は無料）

---

## 参考

- [Amazon EC2 key pairs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-key-pairs.html)
- [EC2 Instance Connect](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-linux-inst-eic.html)
- [Session Manager: port forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-start-port-forwarding)
- [Install the Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- [Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html)
- [Network ACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html)
- [Run commands when you launch an EC2 instance with user data input](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html)
- [Default VPCs](https://docs.aws.amazon.com/vpc/latest/userguide/default-vpc.html)
