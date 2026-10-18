# StudyAWS

死活監視ツール（ステータスページ）を題材に、同じアプリのインフラ構成を段階的に引っ越ししながらAWSを学ぶプロジェクト。

```
ローカル → EC2 1台 → ALB + 複数台 → コンテナ → サーバーレス
```

## ロードマップ

| Phase | 内容 | 学べること | 状態 |
|---|---|---|---|
| 0. 準備 | アカウントの安全設定、請求アラート、AWS CLI | Builder ID, MFA, IAM（ロールとポリシーの基本）, Budgets, AWS CLI (`aws login`) | ✅ |
| 1. アプリ作成 | FastAPI で API + 監視ジョブ、Docker Compose で実行 | Docker | ✅ |
| 2. EC2に手で載せる | nginx + systemd で常駐 | VPC, サブネット, セキュリティグループ, IAM ロール, Session Manager | ✅ |
| 3. DBを分離 | RDS (PostgreSQL) をプライベートサブネットへ | パブリック/プライベート設計, RDS, Secrets Manager | 🚧 |
| 4. 冗長化 | ALB + Auto Scaling, 独自ドメイン + HTTPS | ロードバランサー, マルチAZ, Route 53, ACM | |
| 5. コード化 | ここまでの構成を AWS CDK (TypeScript) で再現 | IaC | |
| 6. CI/CD | GitHub Actions でテスト・自動デプロイ | GitHub Actions, OIDC | |
| 7. コンテナ化 | ECR + ECS Fargate | コンテナオーケストレーション | |
| 8. サーバーレス化 | Lambda + EventBridge, S3 + CloudFront | サーバーレス, コスト比較 | |
| 9. 運用・監視 | ログ・メトリクス・アラーム | CloudWatch | |

## ドキュメント

書き方のルールは [docs/README.md](docs/README.md)。

| ファイル | 内容 |
|---|---|
| `docs/phaseN-setup.md` | 手順書：AWS や手元で行う操作の手順と、その大まかな解説 |
| `docs/phaseN-study.md` | 知識まとめ：その Phase で使う AWS の知識を体系的にまとめたもの |
| `docs/phaseN-appendix.md` | 付録：その Phase では使っていないが、知っておくとよいもの（ない Phase もある） |
| `docs/log/phaseN-result.md` | 各手順の確認結果・実測値（Git 管理外） |
| `docs/log/` | 個人の学習ログ（Git 管理外） |

- Phase 0: [手順書](docs/phase0-setup.md) / [知識まとめ](docs/phase0-study.md) / [付録](docs/phase0-appendix.md)
- Phase 1: [手順書](docs/phase1-setup.md) / [知識まとめ](docs/phase1-study.md) / [付録](docs/phase1-appendix.md)
- Phase 2: [手順書](docs/phase2-setup.md) / [知識まとめ](docs/phase2-study.md) / [付録](docs/phase2-appendix.md)
- Phase 3: [手順書](docs/phase3-setup.md) / [知識まとめ](docs/phase3-study.md) / [付録](docs/phase3-appendix.md)

## 環境

- アカウント：新方式（Sign up for AWS (new)）・無料プラン
- リージョン：`ap-southeast-2`（シドニー）に固定
- CLI：`aws login --profile study`

## ルール

- 初めてのサービスは「コンソールで手作業 → CDK でコード化」の2段階で進める
- 使い終わったリソースは必ず削除する（RDS, ALB, NAT Gateway は放置すると課金される）
- アクセスキー（長期の認証情報）は作らない。CLI は `aws login` の一時的な認証情報でログインする
- リポジトリに書かないもの：
  - AWS アカウントID、メールアドレス
  - アクセスキー、パスワード、`.pem` などの鍵
  - IPアドレスやリソースID（`i-0abc...` など）は伏せ字にする（`i-xxxx`）
