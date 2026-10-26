# Phase 5 付録: CDK 以外の IaC・使わなかった CDK の機能

> Phase 5 では使っていないが、知っておくとよいもの。
> 本編の手順 [phase5-setup.md](phase5-setup.md) と知識まとめ [phase5-study.md](phase5-study.md) を読んだあとに。

この付録では次の5つをまとめる。

- **A. Terraform**：AWS 以外も扱える、もう1つの代表的な IaC
- **B. CloudFormation を直接書く**：CDK を使わない書き方
- **C. 既存のリソースを取り込む**：`cdk import` と `cdk migrate`
- **D. CDK のテスト**：テンプレートを確かめるテスト
- **E. cdk watch と hotswap**：開発中に速くデプロイする

---

## A. Terraform

HashiCorp 社の IaC ツール。AWS 以外（Google Cloud、Azure、GitHub、Cloudflare など）も同じ書き方で扱える。

| | AWS CDK（本編） | Terraform |
|---|---|---|
| 書き方 | プログラミング言語（TypeScript など） | HCL という専用の設定言語 |
| 実際に作るもの | CloudFormation（AWS のサービス）が作る | Terraform 自身が AWS の API を呼んで作る |
| 「今どうなっているか」の記録 | CloudFormation のスタック（AWS が持つ） | **state ファイル**（自分で置き場所を用意する。S3 などに置くことが多い） |
| 失敗したとき | CloudFormation が自動でロールバック | ロールバックはない。途中までできた状態から、もう一度実行して直す |
| 使える範囲 | AWS | AWS 以外も |

```hcl
resource "aws_security_group_rule" "db_from_web" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.db.id
  source_security_group_id = aws_security_group.web.id
}
```

- state ファイルには、パスワードなどの秘密が入ることがある。公開リポジトリには入れない
- Terraform をプログラミング言語で書く方法（CDK for Terraform）や、同じ考え方のツール（OpenTofu、Pulumi）もある

---

## B. CloudFormation を直接書く

CDK を使わずに、CloudFormation のテンプレートを YAML で書く方法。

```yaml
Resources:
  DbFromWeb:
    Type: AWS::EC2::SecurityGroupIngress
    Properties:
      GroupId: !Ref DbSecurityGroup
      IpProtocol: tcp
      FromPort: 5432
      ToPort: 5432
      SourceSecurityGroupId: !Ref WebSecurityGroup
```

| 向いているとき | 理由 |
|---|---|
| 小さな構成、変更が少ない | 余計な道具（Node.js、CDK）がいらない |
| 何が作られるかを正確に読みたい | テンプレートがそのまま実物になる |
| CDK が出力したテンプレートを読む | `cdk synth` の結果はこの形。読めると、CDK が何をしているか分かる |

本編の手順でも、`cdk synth` の結果を読むことで、この書き方に触れる。

---

## C. 既存のリソースを取り込む

本編では、手で作ったものは消して、CDK で作り直した（DB のデータはスナップショットで引き継いだ）。消せない・作り直したくないリソースは、取り込む方法がある。

| 方法 | 内容 |
|---|---|
| `cdk import` | 既存のリソース（RDS、S3 バケットなど）を、コードに書いた定義と結び付けて、**スタックの管理下に入れる**。リソースは作り直さない |
| `cdk migrate` | 既存のリソースや CloudFormation のスタックから、**CDK のコードを自動で書き出す**。手で作った構成を IaC にする出発点として使う |
| `fromXxx` で参照する | 管理下には入れず、名前や ARN で使うだけ（本編のシークレット） |

| 注意点 | 内容 |
|---|---|
| 取り込めないリソースがある | 種類によっては `cdk import` に対応していない |
| コードと実物の設定を一致させる | 取り込むときにコードの定義と実物が違うと、次のデプロイで実物が書き換わる |
| 削除ポリシー | 取り込むリソースは `RETAIN` にしておくのが安全（取り込みに失敗しても消えない） |

---

## D. CDK のテスト

CDK のコードは、`cdk synth` で作るテンプレートを確かめるテストが書ける（`aws-cdk-lib/assertions`）。AWS にデプロイせずに、数秒で確かめられる。

```typescript
const template = Template.fromStack(stack);

// DB のセキュリティグループは、web のセキュリティグループからの 5432番だけを許可している
template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
  IpProtocol: 'tcp',
  FromPort: 5432,
  ToPort: 5432,
});

// ALB 以外に、80番をインターネットに開けていない
```

| テストの種類 | 内容 |
|---|---|
| 細かいアサーション | 「このリソースに、この設定がある」を1つずつ確かめる。守りたいルール（DB をインターネットに開けない、など）に向く |
| スナップショットテスト | テンプレート全体を保存しておき、変わったら知らせる。意図しない変更に気づける |

Phase 6 で、GitHub Actions でアプリのテストと一緒に実行する。

---

## E. cdk watch と hotswap

| コマンド | 内容 |
|---|---|
| `cdk deploy --hotswap` | CloudFormation を通さずに、Lambda のコードなど一部のリソースを直接書き換える。数秒で反映される |
| `cdk watch` | ファイルを保存するたびに、自動で `cdk deploy --hotswap` する |

- CloudFormation を通さないので、**スタックの記録と実物がずれる**（[study §11 ドリフト](phase5-study.md#11-ドリフト)）
- 開発中の試行錯誤だけに使い、本番には使わない
- Lambda（Phase 8）で効果が大きい。EC2 や ALB の変更には効かない

---

## 参考

- [Terraform AWS Provider](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [AWS CloudFormation template reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/introduction.html)
- [Import existing resources into a CDK stack（cdk import）](https://docs.aws.amazon.com/cdk/v2/guide/resources.html#resources-importing)
- [cdk migrate](https://docs.aws.amazon.com/cdk/v2/guide/migrate.html)
- [Test AWS CDK applications](https://docs.aws.amazon.com/cdk/v2/guide/testing.html)
- [cdk watch と hotswap](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-watch.html)
