export function parseAppVersion(value: unknown): string {
  if (value === undefined) {
    return 'main';
  }
  // ユーザーデータのシェルに埋め込むので、コマンドの差し込みを防ぐ。
  if (typeof value !== 'string' || (value !== 'main' && (value.length !== 40 || !/^[0-9a-f]{40}$/.test(value)))) {
    throw new Error('appVersion は main または小文字の40文字の16進数で指定してください');
  }
  return value;
}
