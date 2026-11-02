#!/bin/bash
set -euo pipefail

# ユーザーデータは、EC2 の起動時に環境を自動構築するためのスクリプト。
# cloud-init により初回起動時に一度だけ root として実行される。
# 実行ログは /var/log/cloud-init-output.log で確認できる。
# api と worker の起動テンプレートで共用し、役割と CloudFormation の知らせ先を変更する。
# IMDS 経由でインスタンス内から読めるため秘密は書かず、起動時に取得する。
set -x

# worker 用の起動テンプレートでは "worker" に変更する。
ROLE="api"
# RDS と Secrets Manager を同じリージョンで参照する。
REGION="ap-southeast-2"
# エンドポイントは固定せず、DB の名前から起動時に調べる。
DB_INSTANCE_ID="statuspage-db"
# パスワードの値を起動テンプレートに残さず、シークレットの名前だけを指定する。
SECRET_ID="statuspage/db-app"
# 自動起動したインスタンスにも同じリポジトリを配置する。
REPO_URL="https://github.com/menbou404/StudyAWS.git"
# 取ってくるコードのバージョン。ブランチ名か40文字のコミット SHA。CDK はデプロイのたびに SHA に置き換える。
APP_VERSION="main"
# app/Dockerfile と同じバージョンに固定してインストール結果をそろえる。更新するときは Dockerfile・手順書と一緒に変える。
UV_VERSION="0.13.5"

# Phase 6：CDK が知らせ先を埋める。Phase 4 の手貼りでは空のまま使えるようにする。
CFN_STACK=""
CFN_RESOURCE=""
if [[ -n "$CFN_STACK" && -n "$CFN_RESOURCE" ]]; then
    # set -e による途中終了も拾うため、パッケージ導入より先に EXIT を登録する。
    # 導入自体に失敗して送信できない場合も、CloudFormation の10分の待機で失敗になる。
    trap 'exit_code=$?; /opt/aws/bin/cfn-signal -e "$exit_code" --stack "$CFN_STACK" --resource "$CFN_RESOURCE" --region "$REGION"; exit "$exit_code"' EXIT
    dnf install -y aws-cfn-bootstrap
fi

case "$ROLE" in
    api|worker) ;;
    *)
        echo 'ROLE must be api or worker' >&2
        exit 1
        ;;
esac

# Phase 2 手順6-1を置き換え、入口が必要な api にだけ nginx を入れる。
if [[ "$ROLE" == "api" ]]; then
    dnf install -y git nginx
else
    dnf install -y git
fi

# Phase 2 手順6-2を置き換え、アプリを root で動かさないため専用ユーザーを用意する。
if ! id -u statuspage >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/statuspage --shell /sbin/nologin statuspage
fi
curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# Phase 2 手順8-1を置き換え、アプリの実行ユーザーが依存関係を配置できるようにする。
install -d -o statuspage -g statuspage /opt/statuspage
# Phase 6：SHA とブランチを同じ手順で取得し、所有者として git を動かして safe.directory の例外を避ける。
sudo -u statuspage -H git -C /opt/statuspage init
sudo -u statuspage -H git -C /opt/statuspage remote add origin "$REPO_URL"
sudo -u statuspage -H git -C /opt/statuspage fetch --depth 1 origin "$APP_VERSION"
sudo -u statuspage -H git -C /opt/statuspage checkout --detach FETCH_HEAD
RESOLVED_APP_VERSION=$(sudo -u statuspage -H git -C /opt/statuspage rev-parse HEAD)

# Phase 2 手順8-2を置き換え、ロック済みの実行用依存関係だけを入れる。
cd /opt/statuspage/app
sudo -u statuspage -H /usr/local/bin/uv sync --locked --no-dev

# Phase 2 手順8-3を置き換え、Phase 4 では接続先を RDS から取得して固定値を避ける。
DB_HOST=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$DB_INSTANCE_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
if [[ -z "$DB_HOST" || "$DB_HOST" == "None" ]]; then
    echo 'RDS endpoint is empty or None; cannot configure DATABASE_URL' >&2
    exit 1
fi

# Phase 2 手順8-3を置き換え、秘密をログに残さず root だけが読める設定に保存する。
set +x
DB_PASSWORD=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)
if [[ ! "$DB_PASSWORD" =~ ^[a-zA-Z0-9]+$ ]]; then
    echo 'DB password must be a non-empty alphanumeric string' >&2
    exit 1
fi
install -m 600 -o root -g root /opt/statuspage/deploy/ec2/statuspage.env.example /etc/statuspage.env
sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgresql+psycopg://statuspage:${DB_PASSWORD}@${DB_HOST}:5432/statuspage?sslmode=require#" /etc/statuspage.env
sed -i "s#^APP_VERSION=.*#APP_VERSION=${RESOLVED_APP_VERSION}#" /etc/statuspage.env
unset DB_PASSWORD
set -x

# Phase 2 手順9・10を置き換え、役割に必要なサービスだけを有効にする。RDS にローカル DB の依存は不要。
if [[ "$ROLE" == "api" ]]; then
    cp /opt/statuspage/deploy/ec2/statuspage-api.service /etc/systemd/system/
    cp /opt/statuspage/deploy/ec2/statuspage.nginx.conf /etc/nginx/conf.d/statuspage.conf
    nginx -t
    systemctl daemon-reload
    systemctl enable --now statuspage-api nginx
else
    cp /opt/statuspage/deploy/ec2/statuspage-worker.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now statuspage-worker
fi

# Phase 2 手順9・10の確認を置き換え、起動失敗を完了扱いにせずログに残す。
if [[ "$ROLE" == "api" ]]; then
    deadline=$((SECONDS + 60))
    until curl -sf --max-time 2 http://localhost/healthz; do
        if (( SECONDS >= deadline )); then
            echo 'API health check failed after approximately 60 seconds' >&2
            exit 1
        fi
        sleep 1
    done
else
    systemctl is-active statuspage-worker
fi

echo "statuspage user-data done: role=${ROLE}"
