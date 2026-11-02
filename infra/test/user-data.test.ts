import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const source = readFileSync(path.join(__dirname, '../../deploy/ec2/user-data.sh'), 'utf8');

describe('ユーザーデータの起動通知', () => {
  function runStartup(stack: string, resource: string, body: string, installCode = 0, signalCode = 0) {
    const directory = mkdtempSync(path.join(tmpdir(), 'statuspage-signal-'));
    try {
      // パッケージ導入や AWS 送信を差し替え、EXIT trap までの部分だけを実行する。
      writeFileSync(path.join(directory, 'dnf'), '#!/bin/bash\nprintf "install\\n"\nexit "$INSTALL_CODE"\n', { mode: 0o755 });
      writeFileSync(path.join(directory, 'signal'), '#!/bin/bash\nprintf "signal %s\\n" "$*"\nexit "$SIGNAL_CODE"\n', { mode: 0o755 });
      const prefix = source.slice(0, source.indexOf('case "$ROLE" in'))
        .replace('CFN_STACK=""', `CFN_STACK="${stack}"`)
        .replace('CFN_RESOURCE=""', `CFN_RESOURCE="${resource}"`)
        .replace('/opt/aws/bin/cfn-signal', '"$SIGNAL_COMMAND"');
      return spawnSync('bash', ['-c', `${prefix}\n${body}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          SIGNAL_COMMAND: path.join(directory, 'signal'),
          INSTALL_CODE: String(installCode),
          SIGNAL_CODE: String(signalCode),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('正常終了時は0を通知し、成功として終了する', () => {
    const result = runStartup('StatuspageApp', 'ApiAsg', 'true');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('install\nsignal -e 0 --stack StatuspageApp --resource ApiAsg --region ap-southeast-2\n');
  });

  test.each(['exit 23', '(exit 23)'])('明示的な終了も set -e の途中終了も元のコードで通知する: %s', body => {
    const result = runStartup('StatuspageApp', 'WorkerAsg', body);
    expect(result.status).toBe(23);
    expect(result.stdout).toContain('signal -e 23 --stack StatuspageApp --resource WorkerAsg');
    expect(result.stdout.match(/signal /g)).toHaveLength(1);
  });

  test('導入失敗時も trap が登録済みであり、元の失敗コードを通知しようとする', () => {
    const result = runStartup('StatuspageApp', 'ApiAsg', 'printf "unreachable\\n"', 17);
    expect(result.status).toBe(17);
    expect(result.stdout).toContain('signal -e 17');
    expect(result.stdout).not.toContain('unreachable');
  });

  test.each([['', ''], ['StatuspageApp', ''], ['', 'ApiAsg']])('知らせ先がそろわなければ導入も通知もしない: %p / %p', (stack, resource) => {
    const result = runStartup(stack, resource, 'true');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('通知コマンド自体の失敗も正常終了として扱わない', () => {
    const result = runStartup('StatuspageApp', 'ApiAsg', 'true', 0, 19);
    expect(result.status).toBe(19);
  });
});
