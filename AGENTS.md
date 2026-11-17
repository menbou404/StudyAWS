# StudyAWS（Codex 向けの指示）

死活監視ツールを題材に、同じアプリを EC2 → ALB → コンテナ → サーバーレスと引っ越ししながら AWS を学ぶプロジェクト。全体像は [README.md](README.md)。

## 役割分担

- **Codex**：実装（アプリのコード、IaC、テスト）
- **Claude**：設計、レビュー、文書（`docs/`）、コミット
- 指示に書かれたファイルだけを変更する。範囲外の修正が必要だと思ったら、変更せずに報告する
- **コミット・push はしない**（Claude がレビューしてから行う）
- `docs/`、`README.md`、`CLAUDE.md`、`AGENTS.md` は、指示がない限り変更しない

## 構成

| 場所 | 中身 |
|---|---|
| `app/statuspage/` | FastAPI の API（`api.py`）、監視ジョブ（`worker.py`）、URL チェック（`checker.py`）、DB（`db.py`）、設定（`config.py`） |
| `app/tests/` | pytest のテスト。`conftest.py` がテストごとに SQLite を作り直す |
| `app/Dockerfile` | api と worker が共有するイメージ |
| `compose.yaml` | db（PostgreSQL）/ api / worker |
| `deploy/ec2/` | EC2 用のユーザーデータ、systemd のユニット、nginx の設定（Phase 2〜6。Phase 7 以降も手順のために残す） |
| `infra/` | AWS CDK（TypeScript）のコード（Phase 5 以降） |
| `.github/workflows/` | GitHub Actions のワークフロー（Phase 6 以降。テストだけ） |
| `deploy/codebuild/` | CodeBuild の手順（buildspec）（Phase 6 以降。Phase 7 で `build.yml` を追加） |

## コマンド

```bash
cd app
uv sync                 # 依存ライブラリ
uv run pytest           # テスト（変更後は必ず実行し、全件通ることを確認する）
uv add <パッケージ>      # 依存の追加（pyproject.toml と uv.lock を両方更新する）
docker compose up --build   # リポジトリ直下で、3つのコンテナを起動
```

## コードの書き方

- Python 3.13。型ヒントを付ける（`int | None` の形）
- **コメントと docstring は日本語**。既存のファイルと同じくらいの密度で、「何をするか」より「なぜそうするか」を書く（学習用のリポジトリなので、後の Phase とのつながりがあれば一言添える）
- SQLAlchemy は 2.x の書き方（`Mapped`、`mapped_column`、`select()`）
- **設定はすべて環境変数から読む**（`config.py` に集める）。ローカル用の既定値を持たせ、パスワードなどの秘密情報を既定値やコードに書かない
- 責務の分け方を崩さない
  - `checker.py` は DB にも時間にも依存しない純粋な処理
  - `worker.run_once()` は「1回分」、`run_forever()` は「繰り返し」（Phase 8 で Lambda から `run_once()` だけを呼ぶため）
  - `/healthz` は DB を確認しない（浅いヘルスチェック）
- worker は SIGTERM で今の回を終えてから正常終了する。長い待機は `time.sleep` ではなく `stop.wait(timeout=...)` を使う
- Dockerfile は exec 形式の `CMD`、一般ユーザー（`appuser`）で実行、変わりにくいものを上に書く
- uv のバージョンは `app/Dockerfile` と `deploy/ec2/user-data.sh` でそろえる（脆弱性への対応のため、新しいバージョンに追従する。上げるときは両方と `docs/phase2-setup.md` を一緒に変える）

## テストの書き方

- 本物のネットワークに出ない。`monkeypatch` で `check_url` などを差し替える
- 本物のシグナルや `sleep` を使わない。テストは速く終わるようにする
- DB を使うテストは `conftest.py` の fixture（`client` など）を使う

## IaC（Phase 5 以降）

- AWS CDK（TypeScript）で書く。場所は `infra/`（`bin/`、`lib/`、`test/`）。`aws-cdk-lib` と CDK CLI（`aws-cdk`）は `infra/package.json` で固定し、`package-lock.json` もコミットする
- リージョンは `ap-southeast-2`。アカウントID はコードに書かず、`CDK_DEFAULT_ACCOUNT` から取る
- スタックはライフサイクルで分ける：`StatuspageNetwork`（VPC・DB 用 SG）/ `StatuspageDatabase`（RDS）/ `StatuspageRegistry`（ECR、Phase 7 以降）/ `StatuspageApp`（alb・web・worker の SG と DB への受信ルール、ALB。Phase 6 までは IAM・起動テンプレート・ASG、Phase 7 以降は ECS のクラスター・タスク定義・サービス・ロググループ）/ `StatuspagePipeline`。App は毎日 `cdk destroy` されても、DB のデータが残るようにする。参照は App → Network・Database の一方向にする（循環させない）
- 物理名は、ほかの仕組みが名前で探すものにだけ付ける（RDS の識別子 `statuspage-db`、シークレット `statuspage/db-app`）。それ以外は CDK に任せる
- 秘密や環境ごとの値をコードに書かない。自分の IP アドレスは `-c allowedCidrs=a/32,b/32` で受け取り、未指定なら ALB に受信ルールを作らない。`cdk.context.json` は `.gitignore` 済み（アカウントID が入るため）
- （Phase 6 まで）ユーザーデータは `deploy/ec2/user-data.sh` を読み込んで使う（worker 用は `ROLE="api"` を置き換える）。スクリプトをコードの中に複製しない
- 既存のリソースを使う：シークレット `statuspage/db-app` は参照する（作らない）。RDS はスナップショット `statuspage-db-phase4-final` から作り、削除ポリシーは SNAPSHOT
- 各リソースの近くに、Phase 2〜4 のどの手作業に当たるかを日本語のコメントで書く（学習用）
- `infra/test/` に `aws-cdk-lib/assertions` のテストを書き、`npm test` で通ることを確認する（DB に受信できるのは web と worker の SG だけ、など守りたいルールを確かめる）
- `infra/tsconfig.json` は `noEmit`。`tsc` に `.js` を出力させない（`bin/`・`lib/`・`test/` に古い `.js` が残ると、jest は `.ts` より `.js` を優先して読み、直したはずのコードがテストされない）。依存は `infra/package.json` で exact 固定、テストは公式雛形どおり `@swc/jest`、実行は `tsx`
- `cdk synth` で AWS に問い合わせない（コンテキストの lookup を使わない。`fromLookup` を使わず、AZ はスタックの `availabilityZones` を上書きして固定する）。CodeBuild のテストの段は認証情報があるのに AWS の権限がなく、`cdk.context.json` もないので、問い合わせると失敗する。アカウントを決めて synth しても `manifest.missing` が空になることをテストで確かめる
- CDK の L2 の既定値や挙動はドキュメントと違うことがある（例：`DatabaseInstanceFromSnapshot` の容量の既定は 100GiB、`MachineImage.latestAmazonLinux2023` は `kernel` を上書きする）。守りたい値はテストで確かめる

## CI/CD（Phase 6 以降）

- CI は GitHub Actions（`.github/workflows/ci.yml`）：プルリクエストと main への push でテストだけを動かす。AWS には触らない（認証情報なしで `uv run pytest`、`npm test`、`cdk synth` が通るようにする）。ワークフローの `permissions` は `contents: read` だけ。`pull_request_target` を使わない。アクションは公式（`actions/`、`astral-sh/`）のものを、バージョンを固定して使う
- CD は CodePipeline（V2）+ CodeBuild：パイプライン `statuspage`（Source → Test → Deploy、main への push で動く。トリガーはブランチ `main` とファイルパス `app/**`・`infra/**`・`deploy/**` で絞る。実行モード QUEUED）と、`statuspage-destroy`（トリガーなし。パイプラインは作成直後に1回自動で実行されるので、変数 `CONFIRM_DESTROY`（既定 `false`）が `true` のときだけ `StatuspageApp` を消す）。スタック `StatuspagePipeline`（`infra/lib/pipeline-stack.ts`）に置き、ほかのスタックと参照しない。手元からだけデプロイする（パイプラインに自分自身を更新させない）
- CodeBuild の手順は `deploy/codebuild/`（`test.yml`・`deploy.yml`・`destroy.yml`）。イメージは `aws/codebuild/amazonlinux-aarch64-standard:4.0`（ARM、小さいサイズ）。Node.js 24・Python 3.13 を `runtime-versions` で指定し、uv は `app/Dockerfile` と同じバージョンを入れる。依存はロックファイルどおり（`uv sync --locked`、`npm ci`）
- デプロイは `-c appVersion=<コミット SHA>`（パイプラインの `#{SourceVariables.CommitId}`）と `-c allowedCidrs=<パラメータストア /statuspage/allowed-cidrs>` を渡す。`StatuspageApp` がなく、パイプラインの変数 `CREATE_APP`（既定 `false`）が `true` でなければ、デプロイせずに正常終了する（課金されるものを勝手に作らない）
- CodeBuild のロールの権限は最小にする。テスト：AWS のリソースに触る権限なし。デプロイ：CDK のブートストラップのロール（`cdk-hnb659fds-*`）を引き受ける・`StatuspageApp` の `cloudformation:DescribeStacks`・`/statuspage/allowed-cidrs` の `ssm:GetParameters`。削除：CDK のロールを引き受けるだけ。リソースを作る権限を直接付けない
- 接続（CodeConnections）は手で作ったものを使う。ARN はパラメータストア `/statuspage/github-connection-arn` から読む（コードにアカウントID を書かない）。リポジトリ名は `cdk.json` の context `githubRepo`
- パイプラインの名前（`statuspage`、`statuspage-destroy`）は、人がコンソールで探すので固定する
- パイプライン `statuspage` は Phase 7 から Source → Test → Build → Deploy。Build（`deploy/codebuild/build.yml`）は、そのコミット SHA のタグのイメージが ECR の `statuspage` にあれば作らず、なければ `docker build` して SHA のタグで push する（「ない」は `ImageNotFoundException` のときだけと判断し、権限不足などは失敗にする）。プロジェクトは特権モード、イメージは test・deploy と同じ ARM。ロールは `ecr:GetAuthorizationToken`（リソース `*`）と、リポジトリ `statuspage` へのイメージの確認・push だけ。リポジトリは名前で参照し、`StatuspageRegistry` と参照し合わない
- GitHub Actions の `ci.yml` は、`docker build`（push しない）で `app/Dockerfile` からイメージを作れることも確かめる（`ubuntu-24.04-arm` のランナー）
- アプリのバージョンはコミット SHA で固定する。CDK は `-c appVersion=<40文字の16進数 または main>` を受け取り、それ以外は拒否する（ユーザーデータに埋め込むため）。未指定は `main`
- （Phase 6 の EC2）ユーザーデータは起動の成功・失敗を cfn-signal で CloudFormation に知らせ、Auto Scaling グループはローリング更新（失敗したらロールバック）にする。手で起動テンプレートに貼ったとき（Phase 4 の手順）も動くよう、知らせ先が空なら知らせない

## コンテナ（Phase 7 以降）

- イメージは `app/Dockerfile` の1つだけ。api と worker は同じイメージを使い、worker はコマンドを `python -m statuspage.worker` に上書きする（`compose.yaml` と同じ）
- ベースイメージは ECR Public（`public.ecr.aws/docker/library/python`）から取る（Docker Hub の取得回数の制限を避ける）。`CMD` は exec 形式のまま、uvicorn に `--timeout-keep-alive 65` を付ける（ALB のアイドルタイムアウト60秒より長くし、502 を避ける）
- アプリは応答に `X-Served-By`（ホスト名）を付ける。EC2 の nginx は `proxy_hide_header` でアプリの値を隠し、自分の `$hostname` だけを返す
- DB の接続先は、`DATABASE_URL` があればそれを使う。なければ `DB_HOST`・`DB_PORT`（既定 5432）・`DB_NAME`（既定 statuspage）・`DB_USER`（既定 statuspage）・`DB_PASSWORD`・`DB_SSLMODE`（既定 require）から SQLAlchemy の `URL.create` で組み立てる（パスワードを文字列の連結で URL に入れない）。`DB_HOST` もなければ SQLite
- ECR のリポジトリ `statuspage` は `StatuspageRegistry` に置く（物理名を付ける：パイプラインと App が名前で探す）。タグは不変（IMMUTABLE）、ライフサイクルで新しい10個だけ残す。プッシュ時スキャンはリポジトリごとに設定しない（非推奨）。レジストリ全体のルール（フィルター `statuspage*`、手作業で設定済み）に任せる。スタックを消したらイメージも消す（`emptyOnDelete`）
- イメージのタグはコミット SHA（`appVersion`）。`main` は synth とテストのためだけに受け付ける（そのタグのイメージは作らない）
- Fargate の Linux / ARM64、タスクは 0.25 vCPU・512 MiB。パブリックサブネットに置き、パブリック IP を付ける（NAT ゲートウェイを作らない）。ALB のターゲットは IP、ポート 8000、ヘルスチェックは `/healthz`
- api：希望数 2、minimumHealthyPercent 100・maximumPercent 200。worker：希望数 1、0・100（二重実行を避ける）。どちらもデプロイのサーキットブレーカー（rollback あり）。api のヘルスチェックの猶予は60秒、登録解除の遅延は30秒
- パスワードはタスク定義の `secrets`（シークレット `statuspage/db-app` を参照）で渡し、`environment` に値を書かない。読むのはタスク実行ロールだけ。タスクロールには許可を付けない（アプリは AWS の API を呼ばない）
- ログは `awslogs` で CloudWatch Logs へ。ロググループは App が持ち、保存1週間、スタックを消したら消す。Container Insights と ECS Exec は使わない（費用・権限を増やさない）

## 禁止事項

- AWS のリソースを作成・変更・削除するコマンド（`aws ... create/delete`、`cdk deploy` など）を実行しない。必要なら手順として報告する
- 公開リポジトリなので、AWS アカウントID・メールアドレス・アクセスキー・パスワード・鍵・IP アドレス・リソースID を書かない（例は `xxxx` で伏せ字）
- `.env`、`*.pem`、`docs/log/` をコミット対象に含めない
