# StudyAWS

死活監視ツール（ステータスページ）を題材に、同じアプリのインフラ構成を段階的に引っ越ししながらAWSを学ぶプロジェクト。

```
ローカル → EC2 1台 → ALB + 複数台 → コンテナ → サーバーレス
```

## ロードマップ

| Phase | 内容 | 学べること | 状態 |
|---|---|---|---|
| 0. 準備 | アカウントの安全設定、請求アラート、AWS CLI | IAM, MFA, Budgets, IAM Identity Center | 🚧 |
| 1. アプリ作成 | FastAPI で API + 監視ジョブ、Docker Compose で実行 | Docker | |
| 2. EC2に手で載せる | nginx + systemd で常駐 | VPC, サブネット, セキュリティグループ, Session Manager | |
| 3. DBを分離 | RDS (PostgreSQL) をプライベートサブネットへ | パブリック/プライベート設計 | |
| 4. 冗長化 | ALB + Auto Scaling, 独自ドメイン + HTTPS | ロードバランサー, マルチAZ, Route 53, ACM | |
| 5. コード化 | ここまでの構成を AWS CDK (TypeScript) で再現 | IaC | |
| 6. CI/CD | GitHub Actions でテスト・自動デプロイ | GitHub Actions, OIDC | |
| 7. コンテナ化 | ECR + ECS Fargate | コンテナオーケストレーション | |
| 8. サーバーレス化 | Lambda + EventBridge, S3 + CloudFront | サーバーレス, コスト比較 | |
| 9. 運用・監視 | ログ・メトリクス・アラーム | CloudWatch | |

- 手順書: `docs/phaseN-*.md`
- 学習ログ（日記）: [docs/log/](docs/log/)

## ルール

- 初めてのサービスは「コンソールで手作業 → CDK でコード化」の2段階で進める
- 使い終わったリソースは必ず削除する（RDS, ALB, NAT Gateway は放置すると課金される）
- アクセスキー（長期の認証情報）は作らない。CLI は IAM Identity Center (SSO) でログインする
- アカウントID・URL・鍵などはリポジトリに書かない（[docs/log/README.md](docs/log/README.md) 参照）
