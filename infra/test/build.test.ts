import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const spec = readFileSync(path.join(__dirname, '../../deploy/codebuild/build.yml'), 'utf8');
// YAML の1つのコマンド項目を実行し、本物の AWS や Docker を呼ばずに分岐を確かめる。
const script = spec.slice(spec.indexOf('      - |\n') + '      - |\n'.length)
  .split('\n').map(line => line.replace(/^        /, '')).join('\n');
const appVersion = '0123456789abcdef0123456789abcdef01234567';

function runBuild(version = appVersion, describeError = '', loginCode = 0, describeCode = 0, buildCode = 0) {
  const directory = mkdtempSync(path.join(tmpdir(), 'statuspage-build-'));
  const log = path.join(directory, 'commands');
  try {
    writeFileSync(path.join(directory, 'aws'), `#!/bin/bash
printf 'aws %s\\n' "$*" >> "$COMMAND_LOG"
case "$1 $2" in
  'ecr get-login-password') exit "$LOGIN_CODE" ;;
  'ecr describe-images')
    printf '%s\\n' "$DESCRIBE_ERROR" >&2
    exit "$DESCRIBE_CODE" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    writeFileSync(path.join(directory, 'docker'), `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  login) cat > /dev/null ;;
  build) exit "$BUILD_CODE" ;;
  push) exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        COMMAND_LOG: log,
        APP_VERSION: version,
        AWS_REGION: 'ap-southeast-2',
        REPOSITORY_URI: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/statuspage',
        CODEBUILD_SRC_DIR: directory,
        LOGIN_CODE: String(loginCode),
        DESCRIBE_ERROR: describeError,
        DESCRIBE_CODE: String(describeCode),
        BUILD_CODE: String(buildCode),
      },
    });
    const commands = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { ...result, commands, directory };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('CodeBuild のイメージ作成手順', () => {
  test.each(['', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), `${appVersion}\n`])(
    '小文字40桁 SHA 以外は AWS や Docker を呼ぶ前に拒否する: %p', version => {
      const result = runBuild(version);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('APP_VERSION は40文字');
      expect(result.commands).toBe('');
    },
  );

  test('イメージがあればログインと確認だけで終了し、上書きしない', () => {
    const result = runBuild();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('既にあるのでビルドしない');
    expect(result.commands).toContain('aws ecr get-login-password --region ap-southeast-2');
    expect(result.commands).toContain('docker login --username AWS --password-stdin 123456789012.dkr.ecr.ap-southeast-2.amazonaws.com');
    expect(result.commands).toContain(`aws ecr describe-images --repository-name statuspage --image-ids imageTag=${appVersion}`);
    expect(result.commands).not.toMatch(/docker (build|push)/);
  });

  test('ImageNotFoundException のときだけ ARM の SHA タグを作って push する', () => {
    const result = runBuild(appVersion, 'An error occurred (ImageNotFoundException) when calling the DescribeImages operation', 0, 254);
    expect(result.status).toBe(0);
    const tag = `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/statuspage:${appVersion}`;
    expect(result.commands).toContain(`docker build --platform linux/arm64 --provenance=false -t ${tag} ${result.directory}/app\ndocker push ${tag}\n`);
  });

  test.each(['An error occurred (AccessDeniedException)', 'Could not connect to the endpoint URL', ''])
    ('確認の失敗を不在として扱わない: %p', error => {
      const result = runBuild(appVersion, error, 0, 254);
      expect(result.status).toBe(1);
      expect(result.commands).not.toMatch(/docker (build|push)/);
    });

  test('ログインのパイプで AWS が失敗したら確認へ進まない', () => {
    const result = runBuild(appVersion, '', 17);
    expect(result.status).not.toBe(0);
    expect(result.commands).not.toContain('aws ecr describe-images');
    expect(result.commands).not.toMatch(/docker (build|push)/);
  });

  test('ビルドが失敗したイメージを push しない', () => {
    const result = runBuild(appVersion, '(ImageNotFoundException)', 0, 254, 23);
    expect(result.status).toBe(23);
    expect(result.commands).toContain('docker build');
    expect(result.commands).not.toContain('docker push');
  });
});
