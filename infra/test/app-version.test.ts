import { parseAppVersion } from '../lib/app-version';

describe('appVersion の入力検証', () => {
  test('未指定なら main を使う', () => {
    expect(parseAppVersion(undefined)).toBe('main');
  });

  test.each(['main', '0123456789abcdef0123456789abcdef01234567', '0'.repeat(40)])(
    'main と小文字の40桁 SHA はそのまま使う: %s', value => {
      expect(parseAppVersion(value)).toBe(value);
    },
  );

  test.each([
    '', 'abc1234', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40),
    'main; rm -rf /', '$(id)', 'main"; id; #', ' main', 'main\n', `${'a'.repeat(40)}\n`,
    null, 123, ['main'], {}, true,
  ])('シェルに渡せない値や文字列以外は拒否する: %p', value => {
    expect(() => parseAppVersion(value)).toThrow('appVersion は');
  });
});
